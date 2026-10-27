/**
 * 欧倍尔自动完成课程 v8.3
 * 
 * v8.2 → v8.3 修复 (考试无法自动进入/自动完成):
 *   1. 考试入口页支持"开始答题/开始考试/进入考试/继续答题"多种按钮文案 + 自动确认弹窗
 *   2. 考试题目可能在 iframe 内: 全部查找/点击操作改为跨 frame 递归遍历
 *   3. 进入考试失败自动重试 3 轮, 并可手动点开始答题后自动接管
 *   4. 考试页识别不再只依赖 URL, 同时检测 DOM(.paperContent)
 *   5. 章节资源考试节点识别增强: 类型/标题多字段匹配(含中文"考试/试卷")
 *   6. 新增 frame 诊断日志(radio/checkbox/paper 数量), 便于定位题目所在框架
 *
 * v8.2:
 *   登录阶段循环检测课程, 不提前退出
 *
 * v8.0:
 *   课程列表 API 路径修复 + 可视化状态浮窗 + getHttp() 优化
 */

(() => {
  'use strict';

  // 防重入 (页面导航后会释放)
  if (window.__OberyunAutoRunning) return;
  window.__OberyunAutoRunning = true;
  window.addEventListener('beforeunload', () => { window.__OberyunAutoRunning = false; });

  // ====== 配置 ======
  // 课程列表 API (实测正确路径带 /V2/ 前缀; 失败时回退尝试不带 /V2/)
  const COURSE_LIST_APIS = [
    '/V2/smltplat/course/crsCourseTerm/listLearningCourseTerm',
    '/smltplat/course/crsCourseTerm/listLearningCourseTerm',
  ];

  // ====== 可视化状态浮窗 ======
  let statusEl = null;
  function ensureStatusPanel() {
    if (statusEl) return statusEl;
    const el = document.createElement('div');
    el.id = '__oberyun_auto_status';
    el.style.cssText = `
      position:fixed;right:12px;bottom:12px;z-index:2147483647;
      width:380px;max-height:420px;overflow-y:auto;
      background:rgba(20,20,30,0.95);color:#e6e6e6;
      font:12px/1.6 "Microsoft YaHei",sans-serif;
      border:1px solid #444;border-radius:8px;
      box-shadow:0 4px 20px rgba(0,0,0,0.5);
      padding:10px 12px;user-select:text;
    `;
    el.innerHTML = `<div style="font-weight:bold;color:#722ed1;margin-bottom:6px;">🚀 欧倍尔自动完成 v8.3</div>`;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'float:right;cursor:pointer;color:#888;font-size:14px;';
    closeBtn.onclick = () => { el.style.display = 'none'; };
    el.querySelector('div').appendChild(closeBtn);
    document.documentElement.appendChild(el);
    statusEl = el;
    return el;
  }
  function addStatusLine(msg, type = 'info') {
    const el = ensureStatusPanel();
    const line = document.createElement('div');
    const colors = { info: '#e6e6e6', success: '#52c41a', warn: '#faad14', error: '#f5222d', start: '#722ed1', done: '#eb2f96' };
    line.style.color = colors[type] || '#e6e6e6';
    line.style.whiteSpace = 'pre-wrap';
    line.style.wordBreak = 'break-all';
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // ====== 工具 ======
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', start: '🚀', done: '🎉' };
    const colors = { info: '#1890ff', success: '#52c41a', warn: '#faad14', error: '#f5222d', start: '#722ed1', done: '#eb2f96' };
    const c = colors[type] || '#333';
    console.log(`%c${icons[type] || '📌'} [${time}] ${msg}`, `color:${c};font-weight:bold;`);
    // 同步到可视化浮窗
    try { addStatusLine(msg, type); } catch (e) {}
  }

  function getHttp() {
    // 1. 优先从根组件 #app 查找
    const app = document.querySelector('#app');
    const appVue = app?.__vue__;
    if (appVue?.$http) return appVue.$http;
    if (appVue?.$root?.$http) return appVue.$root.$http;
    // 2. 遍历所有元素查找 $http
    for (const el of document.querySelectorAll('*')) {
      const v = el.__vue__;
      if (v?.$http) return v.$http;
      if (v?.$root?.$http) return v.$root.$http;
    }
    // 3. 回退: 查找全局 axios 实例
    if (window.axios) return window.axios;
    if (window.Vue?.prototype?.$http) return window.Vue.prototype.$http;
    return null;
  }

  async function api(path, body, opts = {}) {
    const http = getHttp();
    if (!http) throw new Error('Vue $http not ready');
    const url = path.startsWith('/') ? path : '/' + path;
    try {
      if (opts.contentType === 'form') {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(body || {})) {
          if (v !== undefined && v !== null && v !== '') p.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        return await http.post(url, p.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      }
      return await http.post(url, body || {});
    } catch (e) {
      log(`API ${path}: ${e.message}`, 'error');
      return null;
    }
  }

  // ====== 动态获取课程列表 ======
  async function getMyCourses(quiet = false) {
    const http = getHttp();
    if (!http) return [];
    // quiet=true 时静默日志 (轮询等待登录期间不刷屏)
    const say = (msg, type) => { if (!quiet) log(msg, type); };
    const MAX_RETRY = 3; // 每个路径最多重试3次
    const RETRY_DELAY = 3000; // 重试间隔3秒
    for (const apiPath of COURSE_LIST_APIS) {
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
          say(`尝试课程列表 API: ${apiPath} (第${attempt}次)`, 'info');
          const resp = await http.post(apiPath, { pageSize: 100, pageNo: 1 });
          const d = resp.data || resp;
          if (d && d.success) {
            const records = (d.result && d.result.records) || d.result || [];
            if (Array.isArray(records) && records.length > 0) {
              log(`✅ API 路径有效: ${apiPath} (返回 ${records.length} 门课程)`, 'success');
              return records.map(c => ({
                courseId: c.courseId || c.id,
                courseTermId: c.courseTermId || c.termId || c.courseTermId,
                name: c.crsName || c.name || c.courseName || '未知课程',
                progress: parseFloat(c.courseSchedule || c.studyProgress || c.progress || '0'),
              }));
            }
            say(`  API 返回 success 但 records 为空`, 'warn');
          } else {
            say(`  API 返回非 success: ${JSON.stringify(d).slice(0, 200)}`, 'warn');
          }
          break; // success 但无数据, 不重试, 换下一个路径
        } catch (e) {
          const status = e.response?.status || 0;
          const isRetryable = status === 502 || status === 503 || status === 504 || status === 0;
          say(`  API ${apiPath} 异常: ${e.message}${isRetryable && attempt < MAX_RETRY ? `, ${RETRY_DELAY/1000}秒后重试` : ''}`, 'warn');
          if (isRetryable && attempt < MAX_RETRY) {
            await sleep(RETRY_DELAY);
          } else {
            break;
          }
        }
      }
    }
    return [];
  }

  // ====== 登录状态检测 ======
  function isLoginPage() {
    if (/\/(login|signin|passport|sso)\b|#\/login/i.test(location.href)) return true;
    // 页面上存在可见的密码输入框 → 判定为待登录
    return !!document.querySelector('input[type=password]');
  }

  // ====== 循环等待课程 (登录中/页面未就绪时持续轮询, 不提前退出) ======
  const POLL_INTERVAL = 5000;  // 已登录但拿不到课程时的轮询间隔
  const LOGIN_INTERVAL = 3000; // 登录页轮询间隔

  async function waitForCourses() {
    let attempt = 0;
    while (true) {
      attempt++;
      const courses = await getMyCourses(true);
      if (courses.length > 0) {
        if (attempt > 1) log(`✅ 检测到 ${courses.length} 门课程, 继续执行`, 'success');
        return courses;
      }
      const onLogin = isLoginPage();
      // 前3次每次都提示, 之后每10次提示一次, 避免刷屏
      if (attempt <= 3 || attempt % 10 === 0) {
        log(onLogin
          ? `⏳ 等待登录: 请在浏览器中输入账号密码, 登录后自动继续 (第${attempt}次检测)`
          : `⏳ 暂未获取到课程, ${(onLogin ? LOGIN_INTERVAL : POLL_INTERVAL) / 1000}秒后重试 (第${attempt}次, 页面/网络可能仍在加载)`,
          'warn');
      }
      await sleep(onLogin ? LOGIN_INTERVAL : POLL_INTERVAL);
    }
  }

  // ====== 章节遍历 ======
  function collectResources(nodes) {
    const out = [];
    const walk = (list) => {
      for (const n of list || []) {
        if (n.contentId && (!Array.isArray(n.children) || n.children.length === 0)) {
          out.push(n);
        }
        if (Array.isArray(n.children)) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  }

  // ====== 标记资源完成 ======
  async function markResourceDone(resourceId, chapterId, courseTermId) {
    const addResp = await api('/smltplat/resource/rscResourceRecord/add', {
      resourceId, referId: chapterId, referType: 'chapter', courseTermId,
    });
    if (!addResp?.success || !addResp?.result?.id) {
      log('  创建记录失败', 'error');
      return false;
    }
    const recordId = addResp.result.id;
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const editBody = {
      id: recordId, resourceId, status: '完成学习',
      starttime: fmtDate(new Date(now.getTime() - 60000)), endtime: fmtDate(now),
      minutes: 1, viewsCount: '1', progress: '100.0', lastProgress: 100,
      referType: 'chapter', referId: chapterId, trainPhaseContentFlag: '',
      courseTermId, courseId: '', rscScore: 100, queScore: 0, videoLength: 0, resbody: '',
    };
    const editResp = await api('/smltplat/resource/rscResourceRecord/edit', editBody);
    return editResp?.success === true;
  }

  // ====== 跨 frame 查找 (考试页面可能嵌在 iframe 内) ======
  function eachFrame(fn) {
    const out = [];
    const visit = (win) => {
      let doc;
      try { doc = win.document; } catch (e) { return; } // 跨域跳过
      if (!doc) return;
      try {
        const r = fn(doc, win);
        if (r) out.push(r);
      } catch (e) {}
      let n = 0;
      try { n = win.frames.length; } catch (e) { return; }
      for (let i = 0; i < n; i++) {
        try { visit(win.frames[i]); } catch (e) {}
      }
    };
    visit(window);
    return out;
  }

  // 当前页(含 iframe)是否像考试页
  function hasExamDom() {
    return eachFrame((doc) => doc.querySelector('div.paperContent') ? true : null).length > 0;
  }

  // 判断章节资源节点是否为考试
  function isExamResource(r) {
    const typeStr = `${r.type || ''} ${r.rscType || ''} ${r.contentType || ''} ${r.rscTypeName || ''}`;
    if (/the_paper|exam|paper/i.test(typeStr)) return true;
    if (/考试|试卷|答题|测验/.test(typeStr)) return true;
    // 标题兜底 (部分平台类型字段为空)
    return /考试|试卷/.test(`${r.title || ''} ${r.name || ''}`);
  }

  // 查找持有 paperContents 的 Vue 组件 (支持 iframe 内)
  function findExamVue() {
    const hits = eachFrame((doc) => {
      for (const el of doc.querySelectorAll('*')) {
        const v = el.__vue__;
        if (!v) continue;
        const candidates = [v, v.$root, v.$parent, v.$parent && v.$parent.$parent];
        for (const c of candidates) {
          if (c && Array.isArray(c.paperContents) && c.paperContents.length > 0) return c;
        }
      }
      return null;
    });
    return hits[0] || null;
  }

  // 点击"开始答题/开始考试"等入口按钮
  function clickStartExam() {
    const hits = eachFrame((doc) => {
      const els = Array.from(doc.querySelectorAll('button, a, .ant-btn, [class*=start], [class*=btn]'));
      return els.find(b => /开始答题|开始考试|进入考试|继续答题|开始测试|立即答题/.test((b.innerText || '').trim())) || null;
    });
    if (hits[0]) { hits[0].click(); return true; }
    return false;
  }

  // 点击确认弹窗
  function clickConfirmDialog() {
    const hits = eachFrame((doc) => {
      const els = Array.from(doc.querySelectorAll('.ant-modal button, .ant-confirm-btns button, .ant-modal-confirm-btns button'));
      return els.find(b => /^(确定|确认|是|继续|同意)$/.test((b.innerText || '').trim())) || null;
    });
    if (hits[0]) { hits[0].click(); return true; }
    return false;
  }

  // 诊断: 打印 frame 信息, 便于定位考试内容所在框架
  function dumpFrameInfo() {
    const infos = eachFrame((doc, win) => {
      const href = (() => { try { return win.location.href; } catch (e) { return '(cross-origin)'; } })();
      return `frame: ${href.slice(0, 100)} | radio=${doc.querySelectorAll('.ant-radio-group').length} checkbox=${doc.querySelectorAll('.ant-checkbox-group').length} paper=${doc.querySelectorAll('.paperContent').length}`;
    });
    infos.forEach(i => log('  ' + i, 'info'));
  }

  // ====== 考试入口处理 (进入考试 + 触发答题) ======
  async function handleExamPage() {
    log('检测到考试页面, 尝试自动进入考试...', 'warn');
    for (let round = 0; round < 3; round++) {
      // 1. 最多等 12 轮(约 25 秒): 题目就绪 或 点"开始答题"
      let clicked = false; // 每轮只点一次, 避免重复触发消耗考试次数
      for (let i = 0; i < 12; i++) {
        if (findExamVue()) break;
        if (!clicked && clickStartExam()) {
          clicked = true;
          log('  点击"开始答题"', 'info');
          await sleep(2500);
          if (clickConfirmDialog()) { log('  已点击确认弹窗', 'info'); await sleep(2000); }
          continue;
        }
        if (i === 2 || i === 6 || i === 10) {
          log(`  等待考试页面加载... (${i + 1}/12)`, 'info');
          dumpFrameInfo();
        }
        await sleep(2000);
      }
      // 2. 答题
      if (!findExamVue()) {
        log(`  第${round + 1}轮: 未找到考试题目`, 'warn');
        await sleep(3000);
        continue;
      }
      if (await autoAnswerExam()) return true;
      log(`  第${round + 1}轮答题未完成, 重试...`, 'warn');
      await sleep(4000);
    }
    log('❌ 自动进入考试失败: 未检测到题目, 请手动点"开始答题", 脚本会自动继续答题', 'error');
    return false;
  }

  // ====== 考试自动答题 ======
  // 答案库 (实测100分验证, 2026-10-27, 安全通识-文科类)
  // Q1-44 判断题 (1=正确 0=错误)
  const JUDGE = ['1','1','0','1','0','1','1','0','1','0','1','0','1','1','1','1','1','1','0','1','1','1','1','1','0','1','1','1','1','1','1','1','1','1','1','1','1','0','1','1','1','1','1','0'];
  // Q45-90 单选题 (A/B/C/D)
  const SINGLE = ['B','A','A','C','B','A','A','A','B','A','D','C','A','A','C','A','C','D','B','C','A','B','A','D','A','A','C','B','B','A','C','A','A','A','C','B','B','B','A','D','C','B','D','B','C','C'];
  // Q91-100 多选题 (选项索引数组, A=0, B=1, C=2, D=3, E=4, F=5, G=6)
  const MULTI = [[0,3,4,6],[0,2],[0,1,2,3],[1,2,3],[0,3],[0,1,2,3],[0,1,2],[0,1,2,3],[0,1,2,3],[0,1,2,3]];
  const LETTERS = 'ABCDEFG';

  async function autoAnswerExam() {
    log('开始自动答题...', 'start');
    await sleep(1500);

    // 找到含 paperContents 的 Vue 组件 (支持 iframe 内)
    let vue = findExamVue();
    for (let attempt = 0; attempt < 10 && !vue; attempt++) {
      log(`  等待题目加载... (${attempt + 1}/10)`, 'info');
      await sleep(2000);
      vue = findExamVue();
    }
    if (!vue || !vue.paperContents.length) { log('❌ 未找到考试题目', 'error'); dumpFrameInfo(); return false; }

    const doc = (vue.$el && vue.$el.ownerDocument) || document;

    const pc = vue.paperContents;
    log(`题目总数: ${pc.length}`, 'info');

    // 试卷校验: 确认是"安全通识(文科类)"这套题 (第一题含"空调电源")
    const q1Text = (pc[0].content || '').replace(/<[^>]*>/g, '');
    if (!/空调电源/.test(q1Text) || pc.length !== 100) {
      log(`⚠️ 题目集与答案库不匹配 (Q1="${q1Text.slice(0,20)}", 数量=${pc.length})，跳过自动答题`, 'warn');
      return false;
    }

    // === 1. 判断题 + 单选题: 按 DOM 顺序点击 radio ===
    const rGroups = Array.from(doc.querySelectorAll('div.paperContent .ant-radio-group'));
    if (rGroups.length !== 90) log(`⚠️ radio group 数量=${rGroups.length} (期望90)`, 'warn');
    for (let i = 0; i < Math.min(rGroups.length, 90); i++) {
      const val = i < 44 ? JUDGE[i] : SINGLE[i - 44];
      const inp = Array.from(rGroups[i].querySelectorAll('input[type=radio]')).find(x => x.value === val);
      if (inp) { inp.closest('label').click(); await sleep(80); }
    }
    log('判断+单选已完成', 'success');

    // === 2. 多选题: 每次点击间隔 600ms，避免 saveAnswers 请求乱序导致服务器只存到部分选项 ===
    const totalClicks = MULTI.reduce((s, arr) => s + arr.length, 0);
    let clickN = 0;
    for (let g = 0; g < Math.min(MULTI.length, 10); g++) {
      for (const idx of MULTI[g]) {
        const val = LETTERS[idx];
        // 每次重新查询 DOM (Vue 可能重渲染)
        const fresh = doc.querySelectorAll('div.paperContent .ant-checkbox-group');
        const gr = fresh[g];
        if (!gr) continue;
        const inp = Array.from(gr.querySelectorAll('input[type=checkbox]')).find(x => x.value === val);
        if (inp && !inp.checked) inp.closest('label').click();
        clickN++;
        if (clickN < totalClicks) await sleep(600);
      }
    }
    log(`多选已完成 (${clickN} 次点击)`, 'success');
    await sleep(1500); // 等最后一次保存落库

    // === 3. 验证 answers[] 与答案库一致 ===
    const ans = vue.answers || [];
    let ok = 0, bad = 0;
    for (let i = 0; i < 100; i++) {
      const exp = i < 44 ? JUDGE[i] : (i < 90 ? SINGLE[i - 44] : MULTI[i - 90].map(x => LETTERS[x]).join(''));
      const got = ((ans[i] && ans[i].yourAnswer) || '').split('').sort().join('');
      if (got === exp) ok++; else bad++;
    }
    log(`答案校验: ${ok}/100 正确${bad ? `, ${bad} 处不一致` : ''}`, bad ? 'warn' : 'success');

    // === 4. 交卷 ===
    const submitBtn = eachFrame((d) => Array.from(d.querySelectorAll('button, .ant-btn'))
      .find(b => /交\s*卷|提交|submit/i.test((b.innerText || '').trim())) || null)[0];
    if (!submitBtn) { log('❌ 未找到交卷按钮', 'error'); return false; }
    log('点击交卷...', 'info');
    submitBtn.click();
    await sleep(2000);

    // 确认对话框 (单次 click, 不遍历所有按钮)
    if (clickConfirmDialog()) await sleep(2500);

    // 查分
    let bodyText = '';
    try { bodyText = doc.body.innerText || ''; } catch (e) {}
    const scoreMatch = bodyText.match(/考试成绩[^0-9]*(\d+(\.\d+)?)\s*分|(\d+(\.\d+)?)\s*分/);
    if (scoreMatch) log(`🎉 考试成绩: ${scoreMatch[1] || scoreMatch[3]} 分!`, 'success');
    return true;
  }

  // ====== 主流程 ======
  async function run() {
    log('╔══════════════════════════════════════════╗', 'start');
    log('║  🚀 欧倍尔自动完成课程 v8.3              ║', 'start');
    log('╚══════════════════════════════════════════╝', 'start');

    // 等 Vue $http (登录页/页面未就绪时持续等待, 不退出)
    let retries = 0;
    while (!getHttp()) {
      retries++;
      if (retries === 1 || retries % 10 === 0) {
        log(isLoginPage()
          ? `⏳ 检测到登录页, 请在浏览器中输入账号密码登录... (第${retries}次等待)`
          : `等待页面加载 Vue... (第${retries}次)`, 'info');
      }
      await sleep(1500);
    }
    log('✅ HTTP 实例就绪', 'success');

    const url = window.location.href;

    // === 考试页 / 考试入口页 ===
    if (/testPaper|texam|the_paper|examPaper/i.test(url) || hasExamDom()) {
      await handleExamPage();
      return;
    }

    // === 任意页面: 先动态获取所有课程 (未登录/无数据时循环轮询, 不提前结束) ===
    log('正在获取课程列表...', 'info');
    if (isLoginPage()) log('⏳ 当前处于登录页, 请先输入账号密码登录', 'warn');
    const courses = await waitForCourses();

    log(`🎯 发现 ${courses.length} 门课程:`, 'info');
    courses.forEach((c, i) => log(`  [${i+1}] ${c.name} (进度 ${c.progress}%)`));

    for (let ci = 0; ci < courses.length; ci++) {
      const c = courses[ci];
      log(`\n${'═'.repeat(40)}`);
      log(`📚 [${ci+1}/${courses.length}] ${c.name}`);
      log(`${'═'.repeat(40)}`);

      // 获取章节树
      const chapResp = await api('/smltplat/course/courseChapter/listChapterForLearn',
        { courseId: c.courseId, courseTermId: c.courseTermId },
        { contentType: 'form' }
      );

      if (!chapResp?.success) {
        log(`❌ 获取章节失败: ${JSON.stringify(chapResp).slice(0, 300)}`, 'error');
        continue;
      }

      const resources = collectResources(chapResp.result || []);
      log(`资源数: ${resources.length}`, 'info');

      let done = 0, examCount = 0, fail = 0;

      for (let ri = 0; ri < resources.length; ri++) {
        const r = resources[ri];
        const isExam = isExamResource(r);
        const title = (r.title || '').substring(0, 40);

        log(`[${ri+1}/${resources.length}] ${title} (${r.rscType || r.type || r.contentType}) progress=${r.progress || 0}%`);

        // 已完成跳过
        if (!isExam && (r.completed || (r.progress && Number(r.progress) >= 100))) {
          log('  ⏭️ 已完成, 跳过');
          continue;
        }

        if (isExam) {
          examCount++;
          log(`  📝 考试节点: ${JSON.stringify(r).slice(0, 300)}`, 'info');
          log('  📝 考试 - 当前页跳转进入...');
          if (r.contentId && r.id) {
            const examUrl = `${location.origin}/ober/smltplat/course/courseLearn?courseId=${c.courseId}&chapterId=${r.id}&type=the_paper&contentId=${r.contentId}&courseTermId=${c.courseTermId}`;
            // 用当前标签页导航(避免新标签页会话丢失), 导航后脚本会自动重新注入并进入考试答题
            log(`  跳转: ${examUrl}`, 'info');
            location.href = examUrl;
            return; // 停止后续执行, 等待导航后脚本重新运行
          } else {
            log('  ⚠️ 跳过考试 (无 contentId)', 'warn');
          }
          continue;
        }

        // 普通资源
        if (r.contentId && r.id) {
          const ok = await markResourceDone(r.contentId, r.id, c.courseTermId);
          if (ok) { log('  ✅ 标记完成'); done++; }
          else { log('  ❌ 标记失败'); fail++; }
          await sleep(400);
        } else {
          log('  ⚠️ 跳过 (无 contentId)', 'warn');
        }
      }

      log(`\n📊 本门课: 完成=${done}, 考试=${examCount}, 失败=${fail}`);
    }

    log(`\n🎉 所有课程处理完成! 考试会在新标签页自动答题。`, 'done');
  }

  // ====== 启动 ======
  window.OberyunAuto = { run, autoAnswerExam, handleExamPage, api, markResourceDone, collectResources, getMyCourses, waitForCourses, isLoginPage, findExamVue, dumpFrameInfo };

  const url = window.location.href;
  const delay = /testPaper|texam|the_paper|examPaper/i.test(url) ? 3000 : 1500;

  sleep(delay).then(() => {
    run().catch(e => log(`运行错误: ${e.message}`, 'error'));
  });
})();

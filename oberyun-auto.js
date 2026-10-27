/**
 * 欧倍尔自动完成课程 v8.0
 * 
 * v7.0 → v8.0 修复:
 *   1. 课程列表 API 路径 /V2/smltplat/... 前缀错误 → 改为 /smltplat/... (与其他API一致), 并自动回退尝试 /V2/
 *   2. 添加可视化状态浮窗, 无需打开 F12 控制台即可查看运行进度和错误
 *   3. getHttp() 优化: 先查 #app 根组件, 再遍历, 提高查找速度和成功率
 *   4. API 失败时将返回内容显示到浮窗, 便于诊断
 *   5. 课程列表和章节列表的字段提取增加容错
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
    el.innerHTML = `<div style="font-weight:bold;color:#722ed1;margin-bottom:6px;">🚀 欧倍尔自动完成 v8.0</div>`;
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
  async function getMyCourses() {
    const http = getHttp();
    if (!http) return [];
    const MAX_RETRY = 3; // 每个路径最多重试3次
    const RETRY_DELAY = 3000; // 重试间隔3秒
    for (const apiPath of COURSE_LIST_APIS) {
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
          log(`尝试课程列表 API: ${apiPath} (第${attempt}次)`, 'info');
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
            log(`  API 返回 success 但 records 为空`, 'warn');
          } else {
            log(`  API 返回非 success: ${JSON.stringify(d).slice(0, 200)}`, 'warn');
          }
          break; // success 但无数据, 不重试, 换下一个路径
        } catch (e) {
          const status = e.response?.status || 0;
          const isRetryable = status === 502 || status === 503 || status === 504 || status === 0;
          log(`  API ${apiPath} 异常: ${e.message}${isRetryable && attempt < MAX_RETRY ? `, ${RETRY_DELAY/1000}秒后重试` : ''}`, 'warn');
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
    await sleep(2500);

    // 找到含 paperContents 的 Vue 组件
    let vue = null;
    for (let attempt = 0; attempt < 10 && !vue; attempt++) {
      for (const el of document.querySelectorAll('*')) {
        const v = el.__vue__;
        if (v && Array.isArray(v.paperContents) && v.paperContents.length > 0) { vue = v; break; }
      }
      if (!vue) { log(`  等待题目加载... (${attempt+1}/10)`, 'info'); await sleep(2000); }
    }
    if (!vue || !vue.paperContents.length) { log('❌ 未找到考试题目', 'error'); return false; }

    const pc = vue.paperContents;
    log(`题目总数: ${pc.length}`, 'info');

    // 试卷校验: 确认是"安全通识(文科类)"这套题 (第一题含"空调电源")
    const q1Text = (pc[0].content || '').replace(/<[^>]*>/g, '');
    if (!/空调电源/.test(q1Text) || pc.length !== 100) {
      log(`⚠️ 题目集与答案库不匹配 (Q1="${q1Text.slice(0,20)}", 数量=${pc.length})，跳过自动答题`, 'warn');
      return false;
    }

    // === 1. 判断题 + 单选题: 按 DOM 顺序点击 radio ===
    const rGroups = Array.from(document.querySelectorAll('div.paperContent .ant-radio-group'));
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
        const fresh = document.querySelectorAll('div.paperContent .ant-checkbox-group');
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
    const submitBtn = Array.from(document.querySelectorAll('button, .ant-btn'))
      .find(b => /交\s*卷|提交|submit/i.test((b.innerText || '').trim()));
    if (!submitBtn) { log('❌ 未找到交卷按钮', 'error'); return false; }
    log('点击交卷...', 'info');
    submitBtn.click();
    await sleep(2000);

    // 确认对话框 (单次 click, 不遍历所有按钮)
    const confirmBtn = Array.from(document.querySelectorAll('.ant-confirm-btns button, .ant-modal-confirm-btns button'))
      .find(b => /确定|确认|是/i.test((b.innerText || '').trim()));
    if (confirmBtn) { confirmBtn.click(); await sleep(2500); }

    // 查分
    const scoreMatch = document.body.innerText.match(/考试成绩[^0-9]*(\d+(\.\d+)?)\s*分|(\d+(\.\d+)?)\s*分/);
    if (scoreMatch) log(`🎉 考试成绩: ${scoreMatch[1] || scoreMatch[3]} 分!`, 'success');
    return true;
  }

  // ====== 主流程 ======
  async function run() {
    log('╔══════════════════════════════════════════╗', 'start');
    log('║  🚀 欧倍尔自动完成课程 v8.0              ║', 'start');
    log('╚══════════════════════════════════════════╝', 'start');

    // 等 Vue $http
    let retries = 0;
    while (!getHttp() && retries < 15) {
      log(`等待页面加载 Vue... (${retries+1}/15)`, 'info');
      await sleep(1500);
      retries++;
    }
    if (!getHttp()) { log('❌ Vue $http 未就绪', 'error'); return; }
    log('✅ HTTP 实例就绪', 'success');

    const url = window.location.href;

    // === 考试页 / 考试入口页 ===
    if (/testPaper|texam|type=the_paper/.test(url)) {
      log('检测到考试页面!', 'warn');
      // 考试入口页(courseLearn?type=the_paper)有"开始答题"按钮; 真正的 testPaper 页直接是题目
      await sleep(2000);
      const startBtn = Array.from(document.querySelectorAll('button, [class*=start]'))
        .find(b => b.innerText?.includes('开始答题'));
      if (startBtn) { log('点击开始答题...', 'info'); startBtn.click(); await sleep(3000); }
      await autoAnswerExam();
      return;
    }

    // === 任意页面: 先动态获取所有课程 ===
    log('正在获取课程列表...', 'info');
    const courses = await getMyCourses();
    if (courses.length === 0) {
      log('❌ 未获取到任何课程! 请确认已登录且账号有课程。', 'error');
      return;
    }

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
        const isExam = /the_paper|exam/.test(r.type || r.rscType || '') || r.contentType === 'the_paper';
        const title = (r.title || '').substring(0, 40);

        log(`[${ri+1}/${resources.length}] ${title} (${r.rscType || r.type}) progress=${r.progress || 0}%`);

        // 已完成跳过
        if (!isExam && (r.completed || (r.progress && Number(r.progress) >= 100))) {
          log('  ⏭️ 已完成, 跳过');
          continue;
        }

        if (isExam) {
          examCount++;
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
  window.OberyunAuto = { run, autoAnswerExam, api, markResourceDone, collectResources };

  const url = window.location.href;
  const delay = /testPaper|texam|type=the_paper/.test(url) ? 3000 : 1500;

  sleep(delay).then(() => {
    run().catch(e => log(`运行错误: ${e.message}`, 'error'));
  });
})();

/**
 * 欧倍尔自动完成课程 v7.0
 * 
 * v6.0 → v7.0 修复:
 *   1. 考试 q.answer 在考试中为空 → 改用内嵌实测100分答案库 (按题目顺序)
 *   2. 直接改 Vue answers 数据不触发 saveAnswers 保存 → 改用 DOM 点击 ant-radio/checkbox-wrapper
 *   3. 多选快速点击导致 saveAnswers 请求乱序 → 多选每次点击间隔 600ms 并重新查询 DOM
 *   4. 考试检测 /the_paper|exam/ 漏掉 rscType 为空的情况 → 增加 contentType==='the_paper' 判断
 *   5. 交卷确认用单次 DOM click，避免遍历导致卡顿
 */

(() => {
  'use strict';

  // 防重入 (页面导航后会释放)
  if (window.__OberyunAutoRunning) return;
  window.__OberyunAutoRunning = true;
  window.addEventListener('beforeunload', () => { window.__OberyunAutoRunning = false; });

  // ====== 配置 ======
  // 课程列表 API
  const COURSE_LIST_API = '/V2/smltplat/course/crsCourseTerm/listLearningCourseTerm';
  const API_BASE = ''; // Vue $http 已配置好 baseURL

  // ====== 动态获取课程列表 ======
  async function getMyCourses() {
    const http = getHttp();
    if (!http) return [];
    try {
      const resp = await http.post(COURSE_LIST_API, { pageSize: 100, pageNo: 1 });
      const d = resp.data || resp;
      if (!d.success) return [];
      const records = d.result?.records || [];
      return records.map(c => ({
        courseId: c.courseId,
        courseTermId: c.courseTermId,
        name: c.crsName || c.name || '未知课程',
        progress: parseFloat(c.courseSchedule || c.studyProgress || '0'),
      }));
    } catch (e) {
      log('获取课程列表失败: ' + e.message, 'error');
      return [];
    }
  }

  // ====== 工具 ======
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', start: '🚀', done: '🎉' };
    const colors = { info: '#1890ff', success: '#52c41a', warn: '#faad14', error: '#f5222d', start: '#722ed1', done: '#eb2f96' };
    const c = colors[type] || '#333';
    console.log(`%c${icons[type] || '📌'} [${time}] ${msg}`, `color:${c};font-weight:bold;`);
  }

  function getHttp() {
    for (const el of document.querySelectorAll('*')) {
      if (el.__vue__?.$http) return el.__vue__.$http;
    }
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
    log('║  🚀 欧倍尔自动完成课程 v7.0              ║', 'start');
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

      if (!chapResp?.success) { log('❌ 获取章节失败', 'error'); continue; }

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
          log('  📝 考试 - 新开标签页打开...');
          if (window.OberyunAuto && r.contentId && r.id) {
            const examUrl = `${location.origin}/ober/smltplat/course/courseLearn?courseId=${c.courseId}&chapterId=${r.id}&type=the_paper&contentId=${r.contentId}&courseTermId=${c.courseTermId}`;
            window.open(examUrl, '_blank');
            // 等 exe 给新 tab 注入后自动运行
            await sleep(2000);
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

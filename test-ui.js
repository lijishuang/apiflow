const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3300';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await sleep(800);

  // ── 界面1：流程列表 ──
  await page.click('.tab[data-s="list"]');
  await sleep(600);
  await page.screenshot({ path: '/tmp/ui-1-list.png' });
  const rows = await page.locator('#flowRows tr').count();
  console.log('列表行数:', rows);

  // ── 界面2：搭建器（NL 生成）──
  await page.click('.tab[data-s="build"]');
  await sleep(400);
  await page.fill('#chatText', '供应商准入流程：查供应商 S-8891 状态，如果是状态是 ACTIVE 就把分数同步给 ERP，否则标记拒绝');
  await page.click('#btnSend');
  await sleep(1200);
  const nodesBuild = await page.locator('#buildCanvas .node').count();
  console.log('画布节点数:', nodesBuild);
  await page.screenshot({ path: '/tmp/ui-2-build.png' });

  // 三道闸：校验 → dry-run → 发布
  await page.click('#btnValidate'); await sleep(500);
  await page.click('#btnDryrun'); await sleep(1500);
  await page.click('#btnPublish'); await sleep(800);
  await page.screenshot({ path: '/tmp/ui-2b-gates.png' });
  const gates = await page.locator('#gateChips').innerText();
  console.log('三道闸状态:', gates.replace(/\n/g, ' | '));

  // ── 界面3：运行观测（SSE 实时）──
  await page.click('.tab[data-s="run"]');
  await sleep(800);
  // 选择种子流程并运行
  const flowVal = await page.locator('#runFlowSel option', { hasText: '供应商准入检查' }).first().getAttribute('value').catch(() => null);
  if (flowVal) await page.selectOption('#runFlowSel', flowVal);
  await sleep(600);
  await page.click('#btnRun');
  await sleep(2500);   // 等待 SSE 事件推动节点状态
  await page.screenshot({ path: '/tmp/ui-3-run.png' });
  const pill = await page.locator('#runPill').innerText();
  console.log('运行状态:', pill);
  const logLines = await page.locator('#eventLog div').count();
  console.log('事件日志行数:', logLines);

  // 点击运行中/已完成节点 → 抽屉
  await page.locator('#runCanvas .node[data-node="fetch_supplier"]').click();
  await sleep(500);
  const drawerText = await page.locator('#runDrawer').innerText();
  console.log('抽屉含重试记录:', drawerText.includes('重试记录'), '| 含API版本:', drawerText.includes('API 版本'));
  await page.screenshot({ path: '/tmp/ui-3b-drawer.png' });

  // 重放
  await page.click('#btnReplay');
  await sleep(2000);
  await page.screenshot({ path: '/tmp/ui-3c-replay.png' });

  // 运行对比
  const opts = await page.locator('#cmpA option').count();
  console.log('历史 run 选项数:', opts);
  if (opts >= 3) {
    await page.selectOption('#cmpA', { index: 1 });
    await page.selectOption('#cmpB', { index: 2 });
    await page.click('#btnCmp');
    await sleep(600);
    await page.screenshot({ path: '/tmp/ui-3d-diff.png' });
    const diffRows = await page.locator('#diffBody tbody tr').count();
    console.log('diff 行数:', diffRows);
    await page.click('.modal-head .btn');
  }

  // 画布拖拽（搭建器）
  await page.click('.tab[data-s="build"]'); await sleep(300);
  const node = page.locator('#buildCanvas .node[data-node="start"]');
  const bb = await node.boundingBox();
  if (bb) {
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + 60, bb.y - 40, { steps: 5 });
    await page.mouse.up();
    console.log('拖拽: 完成');
  }

  console.log('JS 错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log(' ', e));
  await browser.close();
})();

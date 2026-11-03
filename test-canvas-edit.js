/* 画布手动编辑验证：新建空白 → 添加接口 ×2（自动连线）→ 手动连线 → 删边 → 删节点 → 属性面板 body 编辑 */
/* 画布手动编辑 UI 回归：新建空白 → 添加接口（自动连线）→ 连线/删线 → 删节点 → body 编辑 → 自动保存
   运行：NODE_PATH=<playwright-core 所在> node test-canvas-edit.js （需本机 Chrome）*/
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:3300';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = t => { pass++; console.log('  ✓', t); };
const bad = t => { fail++; console.log('  ✗', t); };
const eq = (t, want, got) => (want === got ? ok(`${t}`) : bad(`${t}（期望 ${want}，实得 ${got}）`));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // SSE 长连接下 networkidle 永不达成，用 domcontentloaded
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  await page.click('.tab[data-s="build"]');
  await sleep(400);

  console.log('── E1 新建空白流程 ──');
  await page.click('#btnNewBlank');
  await sleep(700);
  eq('开始节点出现', 1, await page.locator('#buildCanvas .node').count());
  eq('工具栏可见', true, await page.locator('#canvasTools').isVisible());

  console.log('── E2 添加接口（选择器 + 自动连线）──');
  await page.click('#btnAddNode');
  await sleep(400);
  const pickCount = await page.locator('#opPickList .srccard').count();
  (pickCount > 5 ? ok : bad)(`接口选择器列出 ${pickCount} 个接口`);
  await page.fill('#opPickSearch', '查询供应商');
  await sleep(300);
  await page.locator('#opPickList .srccard').first().click();
  await sleep(700);
  eq('添加后画布 2 节点', 2, await page.locator('#buildCanvas .node').count());
  let edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('start→节点 自动连线', 1, edges);
  // 第二个接口
  await page.click('#btnAddNode'); await sleep(300);
  await page.fill('#opPickSearch', '同步分数');
  await sleep(300);
  const pick2 = await page.locator('#opPickList .srccard').count();
  if (pick2 > 0) {
    await page.locator('#opPickList .srccard').first().click();
    await sleep(700);
  } else {
    await page.fill('#opPickSearch', '通知'); await sleep(300);
    await page.locator('#opPickList .srccard').first().click(); await sleep(700);
  }
  eq('添加第二个接口后 3 节点', 3, await page.locator('#buildCanvas .node').count());
  edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('链尾自动接上新节点（2 条边）', 2, edges);

  console.log('── E3 手动连线模式 ──');
  // 先删掉最后一条边，再手动连回来，验证连线交互
  const dels = await page.locator('.edge-del').count();
  (dels >= 2 ? ok : bad)(`每条边有删除按钮（${dels} 个）`);
  await page.locator('.edge-del').last().click();
  await sleep(500);
  edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('删边后剩 1 条', 1, edges);
  // 连线：点节点1 → 点节点2
  await page.click('#btnLinkMode');
  await sleep(200);
  const hint1 = await page.locator('#canvasHint').innerText();
  (hint1.includes('起点') ? ok : bad)('提示选起点: ' + hint1);
  await page.locator('#buildCanvas .node').nth(1).click();
  await sleep(300);
  const hint2 = await page.locator('#canvasHint').innerText();
  (hint2.includes('目标') ? ok : bad)('提示选目标: ' + hint2);
  await page.locator('#buildCanvas .node').nth(2).click();
  await sleep(500);
  edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('手动连线成功（回到 2 条边）', 2, edges);

  console.log('── E4 节点属性面板（body 编辑）──');
  await page.locator('#buildCanvas .node').nth(2).click();
  await sleep(400);
  eq('Body 编辑框存在', true, await page.locator('#f-body').isVisible());
  await page.fill('#f-body', '{"score": "{{nodes.' + (await page.locator('#buildCanvas .node').nth(1).getAttribute('data-node')) + '.output.score}}"}');
  await sleep(300);

  console.log('── E4b Query 参数编辑 ──');
  eq('Query 编辑区存在', true, await page.locator('#f-query').isVisible());
  eq('默认一行参数', 1, await page.locator('#f-query .qrow').count());
  await page.click('#f-query-add');
  eq('点「添加参数」多一行', 2, await page.locator('#f-query .qrow').count());
  const qnode = await page.evaluate(() => state.selNode.id);
  await page.locator('#f-query .qrow').first().locator('.qk').fill('poolId');
  await page.locator('#f-query .qrow').first().locator('.qv').fill('pool-9');
  await page.locator('#f-query .qrow').nth(1).locator('.qk').fill('pageNo');
  await page.locator('#f-query .qrow').nth(1).locator('.qv').fill('{{input.page}}');
  await sleep(1000);   // 等防抖保存
  const qSaved = await page.evaluate(async id => {
    const r = await (await fetch('/api/flows/' + state.draftFlowId + '/def')).json();
    const n = (r.def.nodes || []).find(x => x.id === id);
    return n && n.config ? n.config.query : null;
  }, qnode);
  eq('Query 落盘 poolId', 'pool-9', qSaved && qSaved.poolId);
  eq('Query 落盘模板值', '{{input.page}}', qSaved && qSaved.pageNo);
  // 删掉第二行，应只剩一条
  await page.locator('#f-query .qrow').nth(1).locator('.qdel').click();
  await sleep(900);
  eq('删除行后剩 1 行', 1, await page.locator('#f-query .qrow').count());
  // 重新点开同一个节点，值应回显
  await page.locator('#buildCanvas .node[data-node="' + qnode + '"]').click();
  await sleep(400);
  eq('重新打开回显 poolId', 'poolId', await page.locator('#f-query .qrow').first().locator('.qk').inputValue());

  console.log('── E5 删除节点 ──');
  const delBtns = await page.locator('.node-del').count();
  eq('非 start 节点都有删除按钮', 2, delBtns);
  page.once('dialog', d => d.accept());
  await page.locator('.node-del').last().click();
  await sleep(700);
  eq('删除后 2 节点', 2, await page.locator('#buildCanvas .node').count());
  edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('相关边一并移除（剩 1 条）', 1, edges);

  console.log('── E6 自动保存 ──');
  const note = await page.locator('#buildNote').innerText();
  (note.includes('自动保存') || note.includes('Schema 有问题') ? ok : bad)('自动保存提示: ' + note);
  // 从后端确认草稿真的落了
  const flowId = await page.evaluate(() => state.draftFlowId);
  const saved = await page.evaluate(async id => (await (await fetch('/api/flows/' + id + '/def')).json()), flowId);
  const svNodes = saved.def ? saved.def.nodes.length : -1;
  eq('后端草稿节点数 = 画布节点数', 2, svNodes);

  await page.screenshot({ path: '/tmp/canvas-edit.png' });
  const fatal = errors.filter(e => !e.includes('favicon') && !e.includes('Failed to load resource'));   // favicon 404 无害
  if (fatal.length) { bad('页面报错: ' + fatal[0]); } else ok('无页面错误');
  // 收尾：删掉测试建的流程，不在用户数据里留垃圾
  try {
    await page.evaluate(async id => (await fetch('/api/flows/' + id, { method: 'DELETE' })).json(), flowId);
    ok('测试流程已清理');
  } catch { bad('测试流程清理失败'); }
  console.log(`\n画布手动编辑：通过 ${pass} / 失败 ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(1); });

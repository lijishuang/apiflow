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
  // 从当前目录动态挑接口 —— 不写死接口名（目录内容随接入来源变化）
  const pick1 = await page.evaluate(() => { const o = state.catalog.operations[0]; return { name: o.name, id: o.id }; });
  await page.fill('#opPickSearch', pick1.name);
  await sleep(300);
  if (await page.locator('#opPickList .srccard').count() > 0) await page.locator('#opPickList .srccard').first().click();
  else await page.evaluate(id => pickOperation(id), pick1.id);   // 名字搜不到时直接点选
  await sleep(700);
  eq('添加后画布 3 节点（2 真实 + 1 自动结束）', 3, await page.locator('#buildCanvas .node').count());
  eq('「结束」终点自动出现', 1, await page.locator('#buildCanvas .end-node').count());
  let endEdges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-end').length);
  eq('出口→结束 虚线汇聚（1 条）', 1, endEdges);
  let edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('start→节点 自动连线', 1, edges);
  // 第二个接口（换一个不同的 op）
  const pick2 = await page.evaluate(() => {
    const ops = state.catalog.operations;
    const used = state.draft.nodes.map(x => x.operationId).filter(Boolean);
    const o = ops.find(x => !used.includes(x.id)) || ops[1] || ops[0];
    return { name: o.name, id: o.id };
  });
  await page.click('#btnAddNode'); await sleep(300);
  await page.fill('#opPickSearch', pick2.name);
  await sleep(300);
  if (await page.locator('#opPickList .srccard').count() > 0) await page.locator('#opPickList .srccard').first().click();
  else await page.evaluate(id => pickOperation(id), pick2.id);
  await sleep(700);
  eq('添加第二个接口后 4 节点（3 真实 + 1 结束）', 4, await page.locator('#buildCanvas .node').count());
  endEdges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-end').length);
  eq('出口仍只有链尾一个（1 条虚线）', 1, endEdges);
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
  eq('删除后 3 节点（2 真实 + 1 结束）', 3, await page.locator('#buildCanvas .node').count());
  eq('「结束」仍在（剩余真实节点是出口）', 1, await page.locator('#buildCanvas .end-node').count());
  edges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-path, #buildCanvas svg path.edge-else').length);
  eq('相关边一并移除（剩 1 条）', 1, edges);
  endEdges = await page.evaluate(() => document.querySelectorAll('#buildCanvas svg path.edge-end').length);
  eq('终点虚线重新汇聚（剩 1 条）', 1, endEdges);

  console.log('── E5b 结束终点跟随拖拽 ──');
  const endBefore = await page.locator('#buildCanvas .end-node').boundingBox();
  const exitBb = await page.locator('#buildCanvas .node').nth(1).boundingBox();   // 剩下的真实节点 = 出口
  await page.mouse.move(exitBb.x + exitBb.width / 2, exitBb.y + 12);
  await page.mouse.down();
  await page.mouse.move(exitBb.x + exitBb.width / 2, exitBb.y + 130, { steps: 6 });
  await page.mouse.up();
  await sleep(400);
  const endAfter = await page.locator('#buildCanvas .end-node').boundingBox();
  const dy = Math.round(endAfter.y - endBefore.y);
  (Math.abs(dy) > 30 ? ok : bad)(`拖出口节点后终点跟随（Δy=${dy}）`);

  console.log('── E5c END 终点：本体拖动 + 结束断言 ──');
  const eb = await page.locator('#buildCanvas .end-node').boundingBox();
  await page.mouse.move(eb.x + eb.width / 2, eb.y + 12);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width / 2 - 100, eb.y + 90, { steps: 6 });
  await page.mouse.up();
  await sleep(400);
  const ea2 = await page.locator('#buildCanvas .end-node').boundingBox();
  (Math.abs(ea2.x - eb.x) > 60 && Math.abs(ea2.y - eb.y) > 40 ? ok : bad)(`END 本体可拖动（Δx=${Math.round(ea2.x - eb.x)}, Δy=${Math.round(ea2.y - eb.y)}）`);
  const lay = await page.evaluate(() => (state.draft.layout || {}).__end__ || null);
  (lay && typeof lay.x === 'number' ? ok : bad)('拖动位置记入 layout.__end__');
  const noteEnd = await page.locator('#buildNote').innerText();
  (noteEnd.includes('终点位置已调整') ? ok : bad)('拖动提示: ' + noteEnd);
  // 点击 END（第一次 click 被拖拽抑制）→ 属性面板
  await page.locator('#buildCanvas .end-node').click();
  await sleep(200);
  await page.locator('#buildCanvas .end-node').click();
  await sleep(400);
  eq('END 属性面板出现', true, await page.locator('#f-end-exprs').isVisible());
  eq('重置位置按钮存在', 1, await page.locator('#f-end-reset').count());
  const exitId = await page.locator('#buildCanvas .node').nth(1).getAttribute('data-node');
  await page.locator('#f-end-exprs .qrow .qv').first().fill('nodes.' + exitId + '.output != null');
  await sleep(900);
  const endSaved = await page.evaluate(async id => (await (await fetch('/api/flows/' + id + '/def')).json()), await page.evaluate(() => state.draftFlowId));
  eq('结束断言落盘 def.end', JSON.stringify(['nodes.' + exitId + '.output != null']),
    JSON.stringify(endSaved.def && endSaved.def.end && endSaved.def.end.assert && endSaved.def.end.assert.expr));
  eq('✓A 徽标出现', 1, await page.locator('#buildCanvas .end-node .atag').count());
  // 多行增删
  await page.click('#f-end-add');
  await page.locator('#f-end-exprs .qrow').nth(1).locator('.qv').fill('run.num >= 1');
  await sleep(600);
  eq('添加后两条断言', 2, await page.evaluate(() => state.draft.end.assert.expr.length));
  await page.locator('#f-end-exprs .qrow').first().locator('.qdel').click();
  await sleep(800);
  eq('删一行后剩 run.num 断言', JSON.stringify(['run.num >= 1']),
    await page.evaluate(() => JSON.stringify(state.draft.end.assert.expr)));
  // 重置位置
  await page.click('#f-end-reset');
  await sleep(400);
  eq('重置后 layout.__end__ 清空', null, await page.evaluate(() => (state.draft.layout || {}).__end__ || null));

  console.log('── E6 自动保存 ──');
  const note = await page.locator('#buildNote').innerText();
  (note.includes('自动保存') || note.includes('Schema 有问题') || note.includes('布局已更新') ? ok : bad)('保存提示: ' + note);
  // 从后端确认草稿真的落了
  const flowId = await page.evaluate(() => state.draftFlowId);
  const saved = await page.evaluate(async id => (await (await fetch('/api/flows/' + id + '/def')).json()), flowId);
  const svNodes = saved.def ? saved.def.nodes.length : -1;
  eq('后端草稿只存真实节点（结束标记不进 DSL）', 2, svNodes);

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

/* 运行观测左栏「运行记录」UI 回归：渲染 / 自动选中 / 点选切换 / 筛选 / 运行后实时出现 / 删除 / 清空
   运行：NODE_PATH=<playwright-core 所在> node test-runlist-ui.js （需本机 Chrome，服务先起在 3300）*/
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:3300';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = t => { pass++; console.log('  ✓', t); };
const bad = t => { fail++; console.log('  ✗', t); };
const eq = (t, want, got) => (want === got ? ok(`${t}`) : bad(`${t}（期望 ${want}，实得 ${got}）`));

async function call(m, p, body) {
  const res = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

(async () => {
  /* ── 种子：一个必成功的流程 + 2 次历史运行 ── */
  const FA = 'flow_runlist_ui';
  await call('DELETE', '/api/flows/' + FA);
  await call('DELETE', '/api/runs?flowId=' + FA);
  await call('POST', `/api/flows/${FA}/draft`, { def: { id: FA, name: '运行列表-UI回归', version: 0, input: { sample: {} },
    nodes: [{ id: 'start', type: 'start', name: '开始', config: {} }, { id: 'ping', type: 'http', name: 'ping', config: { method: 'GET', url: BASE + '/upstream/_sandbox' } }],
    edges: [{ from: 'start', to: 'ping' }], layout: {} } });
  await call('POST', `/api/flows/${FA}/dry-run`, {});
  await call('POST', `/api/flows/${FA}/publish`, { confirm: true });
  await call('POST', `/api/flows/${FA}/run`, {}); await sleep(600);
  await call('POST', `/api/flows/${FA}/run`, {}); await sleep(900);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());           // 删除 / 清空确认一律接受

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.click('.tab[data-s="run"]');
  await sleep(600);
  await page.selectOption('#runFlowSel', FA);
  await sleep(1100);

  console.log('── L1 列表渲染与自动选中 ──');
  eq('列出 2 条运行记录', 2, await page.locator('#rlList .rl-item').count());
  eq('最近一条自动选中（高亮 1 条）', 1, await page.locator('#rlList .rl-item.on').count());
  eq('头部 pill 显示该 run', true, (await page.locator('#runPill').textContent()).includes('成功'));
  eq('事件流已载入（非等待中）', false, (await page.locator('#eventLog').innerText()).includes('等待中'));
  eq('计数显示 2/2 条', '2/2 条', (await page.locator('#rlCount').textContent()).trim());

  console.log('── L2 点选切换 ──');
  await page.locator('#rlList .rl-item').nth(1).click();
  await sleep(800);
  eq('点第 2 条后高亮移动到 index 1', 1, await page.evaluate(() => [...document.querySelectorAll('#rlList .rl-item')].findIndex(x => x.classList.contains('on'))));
  eq('事件流跟随切换', true, (await page.locator('#eventLog').innerText()).includes('run_start'));

  console.log('── L3 状态筛选 ──');
  await page.click('#rlFilter .rfchip[data-f="failed"]');
  await sleep(300);
  eq('无失败记录时空态', 0, await page.locator('#rlList .rl-item').count());
  eq('空态文案出现', true, (await page.locator('#rlList').innerText()).includes('没有「失败」'));
  await page.click('#rlFilter .rfchip[data-f="success"]');
  await sleep(300);
  eq('成功筛选回到 2 条', 2, await page.locator('#rlList .rl-item').count());
  await page.click('#rlFilter .rfchip[data-f=""]');
  await sleep(300);

  console.log('── L4 触发运行 → 列表实时刷新 ──');
  await page.click('#btnRun');
  await sleep(2600);
  const n4 = await page.locator('#rlList .rl-item').count();
  eq('新 run 出现在列表（3 条）', 3, n4);
  eq('新 run 自动选中高亮', 1, await page.locator('#rlList .rl-item.on').count());
  const firstTxt = await page.locator('#rlList .rl-item').first().innerText();
  eq('首条为运行中或成功', true, ['成功', '运行中'].some(s => firstTxt.includes(s)));

  console.log('── L5 单条删除 ──');
  const beforeDel = await page.locator('#rlList .rl-item').count();
  await page.locator('#rlList .rl-item').nth(beforeDel - 1).hover();
  await page.locator('#rlList .rl-item').nth(beforeDel - 1).locator('.rl-del').click();
  await sleep(900);
  eq('删除后列表减一', beforeDel - 1, await page.locator('#rlList .rl-item').count());

  console.log('── L6 清空 ──');
  await page.click('#rlClear');
  await sleep(900);
  eq('清空后为空态', 0, await page.locator('#rlList .rl-item').count());
  eq('空态引导出现', true, (await page.locator('#rlList').innerText()).includes('还没有运行记录'));
  eq('清空按钮变灰', true, await page.locator('#rlClear').isDisabled());

  eq('无页面报错', 0, errors.length);
  if (errors.length) console.log(errors.join('\n'));

  await browser.close();
  await call('DELETE', '/api/flows/' + FA);
  await call('DELETE', '/api/runs?flowId=' + FA);
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

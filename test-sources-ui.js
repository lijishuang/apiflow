// 前端「接口接入」链路 UI 测试：空态 → 接入弹窗 → 接入成功 → 搭建器可用
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3300';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // 幂等清理：删掉历史「订单中心」来源，保证每次都从空态开始走完整接入链路
  const pre = await (await fetch(BASE + '/api/sources')).json();
  for (const s of pre.items) {
    if (s.name === '订单中心') await fetch(BASE + '/api/sources/' + s.id, { method: 'DELETE' });
  }

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await sleep(600);

  await page.click('.tab[data-s="api"]');
  await sleep(700);
  console.log('空态提示:', (await page.locator('#srcList').innerText()).slice(0, 30).replace(/\n/g, ' '));
  console.log('接口总数(空态):', await page.locator('#opCount').innerText());
  await page.screenshot({ path: 'screenshots/api-1-empty.png' });

  // 接入弹窗
  await page.click('#btnAddUrl');
  await sleep(400);
  await page.screenshot({ path: 'screenshots/api-2-modal.png' });
  await page.click('#srcBody .note a');                    // 填入示例文档地址
  await page.fill('#f-name', '订单中心');
  await page.click('#srcSubmit');
  await sleep(1500);
  const msg = await page.locator('#srcMsg').innerText().catch(() => '(弹窗已关闭)');
  console.log('接入结果提示:', msg.replace(/\n/g, ' '));

  await sleep(800);
  console.log('统计:', (await page.locator('#apiStats').innerText()).replace(/\n/g, ' '));
  console.log('来源卡片:', (await page.locator('#srcList').innerText()).replace(/\n/g, ' '));
  console.log('接口表行数:', await page.locator('#opRows tr').count());
  await page.screenshot({ path: 'screenshots/api-3-registry.png' });

  // 手工添加弹窗（仅截图，不提交）
  await page.click('#btnAddManual');
  await sleep(300);
  await page.screenshot({ path: 'screenshots/api-4-manual.png' });
  await page.click('#srcCancel');

  // 过滤
  await page.fill('#opFilter', '退款');
  await sleep(300);
  console.log('过滤「退款」命中行数:', await page.locator('#opRows tr').count());
  await page.fill('#opFilter', '');

  // 搭建器：用新接入的接口生成流程
  await page.click('.tab[data-s="build"]');
  await sleep(400);
  console.log('搭建器接口数提示:', await page.locator('.chat-hint').innerText());
  await page.fill('#chatText', '订单售后处理：查询订单详情 O-20261101-001，然后订单退款申请');
  await page.click('#btnSend');
  await sleep(1200);
  const nodes = await page.locator('#buildCanvas .node').count();
  const names = await page.locator('#buildCanvas .node .name').allInnerTexts();
  console.log('画布节点:', nodes, '→', names.join(' → '));
  await page.screenshot({ path: 'screenshots/api-5-build.png' });

  console.log('JS 错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log(' ', e));
  await browser.close();
})();

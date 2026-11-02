// APIFlow 插件后台：只做三件事 —— 打开侧边栏、保活连接状态徽标、把配置变化同步给徽标
importScripts('client.js');

async function refreshBadge() {
  const r = await APF.ping();
  let text = '', color = '#5B6478', title = 'APIFlow';
  if (!r.ok && r.status === 0) {
    text = '';
    title = 'APIFlow：连不上服务（' + (r.data.error || '') + '）';
  } else if (r.data.requireAuth && !r.data.authenticated) {
    text = '!'; color = '#E0A93E';
    title = 'APIFlow：需要认证（在侧边栏设置里填 AK/SK 或用令牌）';
  } else {
    text = 'ON'; color = '#2FBF8F';
    title = `APIFlow：已连接 · ${r.data.counts ? r.data.counts.flows + ' 个流程 / ' + r.data.counts.operations + ' 个接口' : r.data.name || ''}`;
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
  await chrome.storage.local.set({
    'apiflow.status': { at: Date.now(), ok: r.ok, status: r.status, requireAuth: !!r.data.requireAuth, error: r.data.error || null, counts: r.data.counts || null },
  });
  return r;
}

function boot() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('apiflow.ping', { periodInMinutes: 1 });
  refreshBadge();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'apiflow.ping') refreshBadge(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch[APF.CFG_KEY]) refreshBadge();
});
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.type === 'apiflow.refresh') { refreshBadge().then(respond); return true; }
});

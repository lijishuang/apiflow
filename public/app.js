/* APIFlow 平台前端 —— 三界面：流程列表 / 搭建器 / 运行观测 */
const $ = s => document.querySelector(s);
const state = {
  flows: [], flow: null,        // 当前流程（published def）
  draft: null, draftFlowId: null, selNode: null,
  run: null,                    // 运行观测当前 run
  sse: null, canvasMode: null,
  catalog: null, sources: [],   // 工具注册表 + 外部接口来源
  docs: [], docStats: { docs: 0, chunks: 0, chars: 0 },   // 帮助手册（搭建器的解析依据）
  selFlow: null,                // 流程列表页当前选中的流程
  batch: new Set(),             // 列表页勾选待批量处理的流程
  srcSel: new Set(),            // 接口页勾选待批量卸载的来源
  opSel: new Set(),             // 注册表里勾选待批量删除的接口
  opVisible: [],                // 注册表当前可见（过滤后）的接口 id，供全选使用
  hiddenOps: [],                // 已删除（隐藏）的内置接口 id
  alerts: [],                   // 接口变更告警（右侧操作面板显示）
  creds: [], opBindings: {},    // AK/SK 凭证 + 单接口级绑定
  debugRun: null,               // 搭建器调试运行（{id, nodes, status}），SSE 事件实时喂给调试面板
  batchJob: null,               // 并行批跑（{id,total,done,items[]}），轮询 /api/batches/:id 刷新
  batchTimer: null, batchHideBar: false,
};

/* ── 访问令牌：插件接入开启「强制认证」后，控制台也需要令牌 ──
   令牌用平台 AK/SK 换取，存在 localStorage；任何请求都带上，401 时弹登录框 */
const AUTH_KEY = 'apiflow-auth';
const authToken = () => { try { return (JSON.parse(localStorage.getItem(AUTH_KEY) || '{}').token) || ''; } catch { return ''; } };
const authHeaders = () => { const t = authToken(); return t ? { authorization: 'Bearer ' + t } : {}; };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json', ...authHeaders() }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) openLogin(data.error || '需要登录');
    const err = new Error(data.error || res.status);
    err.data = data; err.status = res.status;      // 后端在错误里也会带 references 之类的附加信息
    throw err;
  }
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
const fmtBytes = n => {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
};
const trigLabel = t => ({ manual: '手动', schedule: '定时', webhook: 'Webhook', replay: '重放', batch: '并行', 'dry-run': '调试', agent: '插件', 'api-debug': '接口调试' }[t] || t || '');

/* ───────── 主题切换（浅色 / 深色，localStorage 持久化）───────── */
const THEME_KEY = 'apiflow-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('themeToggle');
  if (btn) { btn.textContent = t === 'light' ? '🌙' : '☀️'; btn.title = t === 'light' ? '切换到深色主题' : '切换到浅色主题'; }
  try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式忽略 */ }
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } })());
document.getElementById('themeToggle').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

/* ───────── Tab 切换 ───────── */
const _tabs = document.querySelectorAll('.tab');
const _slider = document.getElementById('tabSlider');
function moveSlider() {   // 选中指示用一块滑块移动，而非旧的熄灭、新的点亮
  if (!_slider) return;
  const on = document.querySelector('.tab.on');
  if (!on) return;
  _slider.style.width = on.offsetWidth + 'px';
  _slider.style.left = on.offsetLeft + 'px';   // offsetParent 是 .tabs（relative），left 即最终位置
}
_tabs.forEach(t => t.addEventListener('click', () => {
  _tabs.forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  $('#s-' + t.dataset.s).classList.add('on');
  moveSlider();
  if (t.dataset.s === 'home') loadHome();
  if (t.dataset.s === 'list') loadFlows();
  if (t.dataset.s === 'api') loadApi();
  if (t.dataset.s === 'run') refreshRunFlows();
  if (t.dataset.s === 'build') { ensureCreds().then(syncDraftAuth); }   // 搭建器：认证下拉需要凭证列表
}));
window.addEventListener('resize', moveSlider);
window.addEventListener('load', moveSlider);
setTimeout(moveSlider, 60);   // 字体加载完成后放到位

/* ───────── 界面 0：首页概览 ───────── */
const _fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts), diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
async function loadHome() {
  const h = new Date().getHours();
  $('#homeHeroTitle').textContent = `${h < 6 ? '凌晨好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'}，这里是 APIFlow 控制台`;
  const [flows, runs, alerts, sources, credData] = await Promise.all([
    api('/api/flows'), api('/api/runs'), api('/api/alerts').catch(() => []),
    api('/api/sources').catch(() => ({ items: [], total: 0 })), api('/api/creds').catch(() => null),
  ]);
  if (!state.catalog) {   // 启动时注册表可能尚未就绪，这里兜底拉取
    try {
      const c = await api('/api/catalog');
      state.catalog = c;
      $('#catalogBadge').textContent = `注册表 · ${c.version} · ${c.operations.length} 个接口`;
      if ($('#chatApiCount')) $('#chatApiCount').textContent = c.operations.length;
      _catalogVersion = c.version;
    } catch {}
  }
  if (state.catalog) $('#homeCatalog').textContent = `注册表 · ${state.catalog.version} · ${state.catalog.operations.length} 个接口`;

  /* 统计卡 */
  const published = flows.filter(f => f.version > 0).length;
  const okRuns = runs.filter(r => r.status === 'success').length;
  const failRuns = runs.filter(r => r.status !== 'success' && r.status !== 'running').length;
  const doneRuns = okRuns + failRuns;
  const rate = doneRuns ? Math.round(okRuns / doneRuns * 100) : null;
  const stats = [
    { b: flows.length, s: `流程（${published} 已发布）`, c: 'var(--ink)' },
    { b: runs.length, s: '累计运行', c: 'var(--blue)' },
    { b: rate === null ? '—' : rate + '%', s: `成功率（近 ${doneRuns} 次完成）`, c: rate === null ? 'var(--muted)' : rate >= 90 ? 'var(--ok)' : rate >= 60 ? 'var(--amber)' : 'var(--bad)' },
    { b: (state.catalog || { operations: [] }).operations.length, s: '智能体可用接口', c: 'var(--teal)' },
    { b: sources.total ?? sources.items.length, s: '已接入接口来源', c: 'var(--purple)' },
    { b: alerts.length, s: '未处理告警', c: alerts.length ? 'var(--amber)' : 'var(--muted)' },
  ];
  $('#homeStats').innerHTML = stats.map(x => `<div class="stat"><b style="color:${x.c}">${x.b}</b><span>${x.s}</span></div>`).join('');

  /* 最近运行（取最近 10 条，含耗时） */
  const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  const stPill = s => s === 'success' ? '<span class="pill" style="background:var(--ok-bg);color:var(--ok)">成功</span>'
    : s === 'running' ? '<span class="pill" style="background:var(--blue-bg);color:var(--blue)">运行中</span>'
    : `<span class="pill" style="background:var(--bad-bg);color:var(--bad)">${esc(s)}</span>`;
  const trigTxt = trigLabel;
  $('#homeRuns').innerHTML = runs.slice(0, 10).map(r => `
    <tr>
      <td><b>${esc(r.flowName || r.flowId)}</b><div class="note">#${r.num} · v${r.version ?? '—'}</div></td>
      <td>${stPill(r.status)}</td>
      <td><span class="note">${esc(trigTxt(r.trigger))}</span></td>
      <td><span class="num" style="font-size:12px">${fmtMs(r.durationMs)}</span></td>
      <td><span class="note">${_fmtTime(r.startedAt)}</span></td>
    </tr>`).join('') || '<tr><td colspan="5" class="note">还没有运行记录 —— 去搭建器创建流程并运行</td></tr>';

  /* 告警摘要 */
  $('#homeAlertCount').textContent = alerts.length ? `共 ${alerts.length} 条` : '';
  $('#homeAlerts').innerHTML = alerts.length
    ? alerts.slice(0, 3).map(a => `
      <div class="alertcard">
        <div class="ac-head"><span class="ac-ico">⚠</span><span>${esc(a.flowName)} · ${esc(a.operationId)}</span></div>
        <p class="ac-body">接口 <b class="num">${esc(a.operationId)}</b> 已从 <span class="num">${esc(a.fromVersion)}</span> 升级到 <span class="num">${esc(a.toVersion)}</span>。</p>
      </div>`).join('') + (alerts.length > 3 ? '<p class="note">仅显示最近 3 条 —— 完整列表见流程列表页右侧面板。</p>' : '')
    : '<div class="empty">暂无告警 —— 接口版本变更时会自动出现在这里</div>';

  /* 快捷入口 */
  const quicks = [
    { icon: '✦', t: '新建流程', d: '自然语言描述，智能体生成草稿', go: 'build', cls: 'q-teal' },
    { icon: '⧉', t: '接入接口', d: 'OpenAPI 地址 / 粘贴文档 / 手工添加', go: 'api', cls: 'q-purple' },
    { icon: '▷', t: '运行流程', d: '手动 / Webhook / 定时触发', go: 'list', cls: 'q-blue' },
    { icon: '◎', t: '运行观测', d: '事件流 · 数据溯源 · 运行对比', go: 'run', cls: 'q-amber' },
  ];
  $('#homeQuick').innerHTML = quicks.map(q => `
    <button class="quick ${q.cls}" onclick="switchTab('${q.go}')">
      <span class="q-ico">${q.icon}</span>
      <span><b>${q.t}</b><div class="note">${q.d}</div></span>
    </button>`).join('');

  /* 24 小时运行趋势（按小时分桶，成功/失败堆叠柱） */
  $('#insTrendSub').textContent = runs.length ? `按近 ${runs.length} 次运行` : '';
  if (runs.length) {
    const HOUR = 3600e3;
    const nowH = Math.floor(Date.now() / HOUR);
    const buckets = Array.from({ length: 24 }, (_, i) => ({ ok: 0, fail: 0, h: new Date(nowH * HOUR + (i - 23) * HOUR).getHours() }));   // 本地小时
    const nowMs = Date.now();
    runs.forEach(r => {
      const idx = 23 - Math.floor((nowMs - r.startedAt) / HOUR);   // 0=当前小时；勿用 nowH*HOUR 作被减数（当前小时内为负，floor 会多减 1 导致越界）
      if (idx < 0 || idx > 23) return;
      if (r.status === 'success') buckets[idx].ok++; else if (r.status !== 'running') buckets[idx].fail++;
    });
    const maxB = Math.max(1, ...buckets.map(b => b.ok + b.fail));
    $('#insTrend').innerHTML = `
      <div class="trend" role="img" aria-label="24 小时运行趋势柱状图">
        ${buckets.map((b, i) => {
          const tot = b.ok + b.fail;
          const hPct = Math.max(tot ? 8 : 3, tot / maxB * 100);
          const tip = `${String(b.h).padStart(2, '0')}:00 — ${tot ? `成功 ${b.ok}${b.fail ? ` · 失败 ${b.fail}` : ''}` : '无运行'}`;
          return `<div class="tcol" title="${tip}">
            <div class="tbar" style="height:${hPct}%">
              ${b.fail ? `<div class="tbar-fail" style="flex:${b.fail}"></div>` : ''}
              ${b.ok ? `<div class="tbar-ok" style="flex:${b.ok}"></div>` : ''}
            </div>
            ${i % 6 === 5 ? `<span class="thl">${String(b.h).padStart(2, '0')}时</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div class="ib-head" style="margin-top:22px">
        <span class="tl-dot" style="background:var(--ok)"></span><span class="note">成功</span>
        <span class="tl-dot" style="background:var(--bad);margin-left:10px"></span><span class="note">失败</span>
        <span class="note" style="margin-left:auto">每根柱 = 1 小时</span>
      </div>`;
  } else {
    $('#insTrend').innerHTML = '<div class="empty">暂无运行数据</div>';
  }

  /* ── 洞察行：流程活跃度 / 运行表现 / 集成与安全 ── */
  const byFlow = {};
  runs.forEach(r => {
    const k = r.flowName || r.flowId;
    (byFlow[k] = byFlow[k] || { n: 0, ok: 0, last: 0 });
    byFlow[k].n++; if (r.status === 'success') byFlow[k].ok++;
    byFlow[k].last = Math.max(byFlow[k].last, r.startedAt || 0);
  });
  const top = Object.entries(byFlow).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  const maxN = top.length ? top[0][1].n : 1;
  $('#insFlowSub').textContent = runs.length ? `按近 ${runs.length} 次运行` : '';
  $('#insFlow').innerHTML = top.map(([name, v]) => `
    <div class="insbar">
      <div class="ib-head"><b>${esc(name)}</b><span class="note">${v.n} 次 · 成功率 ${Math.round(v.ok / v.n * 100)}%</span></div>
      <div class="ib-track"><div class="ib-fill" style="width:${Math.max(6, Math.round(v.n / maxN * 100))}%"></div></div>
    </div>`).join('') || '<div class="empty">还没有运行数据 —— 运行一次流程后这里会出现活跃度排行</div>';

  const done = runs.filter(r => r.status !== 'running' && r.durationMs != null);
  const durs = done.map(r => r.durationMs).sort((a, b) => a - b);
  const pick = q => durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * q))] : null;
  const p50 = pick(.5), p95 = pick(.95);
  const avg = durs.length ? Math.round(durs.reduce((s, x) => s + x, 0) / durs.length) : null;
  $('#insPerfSub').textContent = done.length ? `近 ${done.length} 次完成运行` : '';
  const okN = done.filter(r => r.status === 'success').length;
  const okPct = done.length ? Math.round(okN / done.length * 100) : 0;
  $('#insPerf').innerHTML = done.length ? `
    <div class="perfrow">
      <div><b>${fmtMs(avg)}</b><span>平均耗时</span></div>
      <div><b>${fmtMs(p50)}</b><span>P50</span></div>
      <div><b>${fmtMs(p95)}</b><span>P95</span></div>
    </div>
    <div class="okbar" title="成功 ${okN} · 失败 ${done.length - okN}">
      <div class="okbar-ok" style="width:${okPct}%"></div>
    </div>
    <div class="ib-head" style="margin-top:6px"><span class="note">成功 ${okN}</span><span class="note">失败 ${done.length - okN}</span></div>`
    : '<div class="empty">暂无完成的运行</div>';

  const credItems = credData ? credData.items : [];
  const bindN = credData ? Object.values(credData.opBindings || {}).filter(Boolean).length : 0;
  const srcRows = (sources.items || []).slice(0, 3).map(s => `
    <div class="introw"><b>${esc(s.name)}</b><span class="note">${s.type === 'url' ? 'OpenAPI' : s.type === 'text' ? '文档粘贴' : '手工'} · ${s.count ?? '—'} 接口 · v${esc(s.specVersion || '—')}</span></div>`).join('');
  $('#insInteg').innerHTML = `
    ${srcRows || '<div class="introw"><span class="note">尚未接入外部接口来源</span></div>'}
    <div class="intdiv"></div>
    <div class="introw"><b>AK/SK 凭证</b><span class="note">${credItems.length ? `${credItems.length} 个凭证 · ${bindN} 个单接口绑定` : '未配置 —— 接口页可创建'}</span></div>
    <div class="introw"><b>接口注册表</b><span class="note">${state.catalog ? `${state.catalog.version} · ${(state.catalog.operations || []).length} 个操作可被智能体调用` : '加载中'}</span></div>`;
}

/* ───────── 界面 1：流程列表（左列表 / 右操作面板，接口变更告警在右侧栏显示） ───────── */
async function loadFlows() {
  const [flows, alerts, credData] = await Promise.all([
    api('/api/flows'), api('/api/alerts'), api('/api/creds').catch(() => null),
  ]);
  state.flows = flows;
  state.alerts = alerts;
  if (credData) { state.creds = credData.items; state.opBindings = credData.opBindings || {}; }
  $('#alertBox').innerHTML = '';               // 告警不再用顶部横幅，改在右侧操作面板显示
  if (state.selFlow && !state.flows.some(f => f.id === state.selFlow)) state.selFlow = null;
  $('#flowRows').innerHTML = state.flows.map(f => {
    const lr = f.lastRun;
    const trig = f.trigger ? (f.trigger.type === 'interval' ? `定时 · 每 ${f.trigger.minutes} 分钟` : f.trigger.type === 'webhook' ? 'Webhook' : f.trigger.type) : '手动';
    const last = lr ? `<span class="pill" style="background:${lr.status === 'success' ? 'var(--ok-bg);color:var(--ok)' : lr.status === 'running' ? 'var(--blue-bg);color:var(--blue)' : 'var(--bad-bg);color:var(--bad)'}">#${lr.num} ${lr.status === 'success' ? '成功' : lr.status === 'running' ? '运行中' : lr.status}</span>` : '<span class="note">—</span>';
    const checked = state.batch.has(f.id);
    return `<tr class="${state.selFlow === f.id ? 'sel' : ''}${f.version > 0 ? '' : ' unpublished'}" data-flow="${f.id}">
      <td class="ck"><input type="checkbox" data-ck="${f.id}" ${checked ? 'checked' : ''} aria-label="选择 ${esc(f.name)}"></td>
      <td><b>${esc(f.name)}</b><div class="note">${f.nodeCount} 节点 · ${f.id}${f.version > 0 ? '' : ' · 未发布'}</div></td>
      <td><span class="vtag">v${f.version}</span></td>
      <td>${esc(trig)}</td>
      <td>${last}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="note">还没有流程，点击右上角「新建流程」用自然语言创建</td></tr>';
  syncBatchBar();
  renderFlowPanel();
}
/* 行点击选中 → 右侧操作面板；复选框 → 批量处理 */
document.getElementById('flowRows').addEventListener('click', e => {  const ck = e.target.closest('input[data-ck]');
  if (ck) {
    const id = ck.dataset.ck;
    if (ck.checked) state.batch.add(id); else state.batch.delete(id);
    syncBatchBar();
    return;                                    // 复选框点击不改变选中
  }
  const tr = e.target.closest('tr[data-flow]');
  if (!tr) return;
  state.selFlow = tr.dataset.flow;
  document.querySelectorAll('#flowRows tr').forEach(x => x.classList.toggle('sel', x === tr));
  renderFlowPanel();
});
/* 表头全选：勾选/取消全部流程，与单行复选框联动 */
const _flowAll = document.getElementById('flowAll');
if (_flowAll) _flowAll.onchange = () => {
  state.batch.clear();
  if (_flowAll.checked) state.flows.forEach(f => state.batch.add(f.id));
  document.querySelectorAll('#flowRows input[data-ck]').forEach(ck => { ck.checked = _flowAll.checked; });
  syncBatchBar();
};
function currentFlow() { return state.flows.find(f => f.id === state.selFlow) || null; }function selectFlow(flowId) {                // 右栏「受影响的流程」入口 → 选中并渲染面板
  state.selFlow = flowId;
  document.querySelectorAll('#flowRows tr').forEach(x => x.classList.toggle('sel', x.dataset.flow === flowId));
  renderFlowPanel();
}
function syncBatchBar() {
  const ids = [...state.batch].filter(id => state.flows.some(f => f.id === id && f.version > 0));
  $('#btnBatchRun').disabled = !ids.length;
  $('#btnBatchCmp').disabled = ids.length !== 1;   // 对比需要恰好一个流程（跑它的最近两次）
  $('#btnBatchCmp').textContent = ids.length === 1 ? '⇄ 对比定位差异' : '⇄ 批量对比';
  const n = state.batch.size;
  $('#btnBatchDel').disabled = !n;
  $('#btnBatchDel').textContent = n ? `✕ 删除 ${n} 个` : '✕ 批量删除';
  $('#selInfo').textContent = n ? `已勾选 ${n} 个流程` : currentFlow() ? `已选择「${currentFlow().name}」` : '未选择流程';
  const all = document.getElementById('flowAll');
  if (all) { all.checked = n > 0 && n === state.flows.length; all.indeterminate = n > 0 && n < state.flows.length; }
}
function renderFlowPanel() {
  const f = currentFlow();
  const panel = $('#flowPanel');
  const alertsFor = fid => (state.alerts || []).filter(a => a.flowId === fid);
  const alertCard = a => `
    <div class="alertcard" role="alert">
      <div class="ac-head"><span class="ac-ico">⚠</span><span>接口变更 · ${esc(a.operationId)}</span>
        <span style="flex:1"></span><button class="ac-dismiss" title="知道了" onclick="clearAlert('${esc(a.id)}')">知道了</button></div>
      <p class="ac-body">依赖的接口 <b class="num">${esc(a.operationId)}</b> 已从 <span class="num">${esc(a.fromVersion)}</span> 升级到 <span class="num">${esc(a.toVersion)}</span>，建议运行对比定位差异。</p>
      <button class="btn wide" onclick="compareLast('${a.flowId}', document.getElementById('fpCmpResult'))">⇄ 运行对比定位差异</button>
    </div>`;
  if (!f) {
    const all = state.alerts || [];
    // 有告警的流程入口置顶（可点击直达该流程），接口变更记录排在流程入口下面
    const byFlow = new Map();
    for (const a of all) {
      if (!byFlow.has(a.flowId)) byFlow.set(a.flowId, { flowId: a.flowId, flowName: a.flowName, count: 0, latest: a });
      byFlow.get(a.flowId).count++;
    }
    const flowsWithAlerts = [...byFlow.values()].sort((x, y) => y.count - x.count);
    panel.innerHTML = `
      ${flowsWithAlerts.length ? `<div class="panel-sec" style="border-top:none;padding-top:0;margin-top:0">
        <p class="ph-label">受影响的流程 · ${flowsWithAlerts.length}</p>
        ${flowsWithAlerts.map(x => `
          <button class="runrow" onclick="selectFlow('${x.flowId}')">
            <span class="pill" style="background:var(--amber-bg);color:var(--amber)">${x.count} 条变更</span>
            <span class="note">${esc(x.flowName)} · ${esc(x.flowId)}</span>
          </button>`).join('')}
      </div>` : ''}
      <div class="panel-empty" ${flowsWithAlerts.length ? 'style="margin-top:16px"' : ''}>
        <p class="ph-title">流程操作</p>
        <p class="note">在左侧选择一个流程，这里会显示它可执行的操作：<br>运行 · 查看最近运行 · 编辑画布 · 运行对比定位差异。</p>
      </div>
      ${all.length ? `<div class="panel-sec"><p class="ph-label">接口变更告警 · 共 ${all.length} 条</p>${all.slice(0, 3).map(alertCard).join('')}
        ${all.length > 3 ? `<p class="note">仅显示最近 3 条 —— 选择对应流程查看它的全部告警。</p>` : ''}</div>` : ''}`;
    return;
  }
  const lr = f.lastRun;
  const fa = alertsFor(f.id);
  panel.innerHTML = `
    ${fa.length ? `<div class="panel-sec" style="border-top:none;padding-top:0;margin-top:0">${fa.map(alertCard).join('')}</div>` : ''}
    <div class="panel-head" ${fa.length ? 'style="margin-top:16px"' : ''}>
      <p class="ph-title">${esc(f.name)}</p>
      <p class="note">v${f.version} · ${f.nodeCount} 节点 · ${f.id}${f.version > 0 ? '' : ' · 未发布（先到搭建器完成三道闸）'}</p>
    </div>
    <div class="panel-sec">
      <p class="ph-label">执行</p>
      ${f.version > 0
        ? `<button class="btn primary wide" id="fpRun">▶ 运行此流程</button>
           <button class="btn wide" id="fpOpen">查看运行观测</button>`
        : `<button class="btn primary wide" id="fpRun" title="未发布流程不能直接运行 —— 点击载入搭建器完成三道闸">⚠ 未发布 · 去搭建器完成发布</button>
           <p class="note" style="margin-top:8px">未发布流程不能运行 —— 先到搭建器完成三道闸（① Schema 校验 → ② Dry-run → ③ 画布确认发布），发布后即可在此运行。</p>`}
      <button class="btn wide" id="fpEdit">编辑画布</button>
    </div>
    <div class="panel-sec">
      <p class="ph-label">对比定位差异</p>
      <button class="btn wide" id="fpCmp" ${f.version > 0 ? '' : 'disabled'}>⇄ 运行对比定位差异</button>
      <p class="note">取该流程最近两次运行做逐节点 diff，输出变化会高亮 —— 接口升级后的典型信号。</p>
      <div id="fpCmpResult"></div>
    </div>
    <div class="panel-sec">
      <p class="ph-label">接口认证（流程级）</p>
      <select class="sel" id="fpAuth" style="width:100%" onchange="setFlowAuth('${f.id}', this.value)">
        <option value="">无认证</option>
        ${(state.creds || []).map(c => `<option value="${c.id}" ${f.authId === c.id ? 'selected' : ''}>${esc(c.name)}（${esc(c.ak)}）</option>`).join('')}
      </select>
      <p class="note">对该流程内所有接口生效；单接口绑定的凭证优先于此配置。</p>
    </div>
    <div class="panel-sec">
      <p class="ph-label">最近运行</p>
      <div id="fpRuns"><span class="note">加载中…</span></div>
    </div>`;
  if (f.version > 0) {
    $('#fpRun').onclick = () => runFlow(f.id);
    $('#fpOpen').onclick = () => openRun(f.id);
  } else {
    $('#fpRun').onclick = () => editFlow(f.id);   // 未发布：点击进搭建器完成三道闸，而非禁用无反馈
  }
  $('#fpEdit').onclick = () => editFlow(f.id);
  $('#fpCmp').onclick = () => compareLast(f.id, $('#fpCmpResult'));
  loadRunsMini(f.id);
}
async function loadRunsMini(flowId) {
  const runs = await api('/api/runs?flowId=' + flowId);
  const box = $('#fpRuns');
  if (!box) return;
  box.innerHTML = runs.slice(0, 4).map(r => `
    <button class="runrow" onclick="loadRun('${r.id}')">
      <span class="pill" style="background:${r.status === 'success' ? 'var(--ok-bg);color:var(--ok)' : r.status === 'running' ? 'var(--blue-bg);color:var(--blue)' : 'var(--bad-bg);color:var(--bad)'}">#${r.num}</span>
      <span class="note">${esc(trigLabel(r.trigger))} · ${esc(r.status)} · ${new Date(r.startedAt).toLocaleTimeString()}</span>
    </button>`).join('') || '<span class="note">还没有运行记录 —— 点上方「运行此流程」跑一次</span>';
}
async function runFlow(flowId) {
  try {
    await api(`/api/flows/${flowId}/run`, { method: 'POST' });
    await loadFlows();
    renderFlowPanel();
    const f = currentFlow();
    const box = $('#fpCmpResult');
    if (box && f && f.lastRun) box.innerHTML = `<div class="msg-ok">已触发运行 #${f.lastRun.num}，事件流见「运行观测」。</div>`;
  } catch (e) { alert('运行失败：' + e.message); }
}
async function clearAlert(id) { await api(`/api/alerts/${encodeURIComponent(id)}/clear`, { method: 'POST' }); loadFlows(); }
async function setFlowAuth(flowId, authId) {
  try {
    await api(`/api/flows/${flowId}/auth`, { method: 'POST', body: JSON.stringify({ authId: authId || null }) });
    const f = state.flows.find(x => x.id === flowId);
    if (f) f.authId = authId || null;
    const box = $('#fpCmpResult');
    if (box) box.innerHTML = `<div class="msg-ok">已${authId ? '设置流程级认证' : '清除流程级认证'}，下次运行即生效。</div>`;
  } catch (e) { alert('设置失败：' + e.message); loadFlows(); }
}
async function compareLast(flowId, box) {
  const runs = await api('/api/runs?flowId=' + flowId);
  if (runs.length < 2) {
    const msg = '该流程成功运行不足 2 次，暂无法对比 —— 先运行一次再回来。';
    if (box) box.innerHTML = `<div class="msg-bad">${esc(msg)}</div>`; else alert(msg);
    return;
  }
  const a = runs[1].id, b = runs[0].id;
  const r = await api(`/api/runs/${a}/diff/${b}`);
  const html = `
    <p class="note">对比 run #${r.a.num}（v${r.a.version}） ←→ run #${r.b.num}（v${r.b.version}）</p>
    <table class="difftable"><thead><tr><th>节点</th><th>A 状态</th><th>B 状态</th><th>输出变化</th><th>耗时 A/B</th></tr></thead>
    <tbody>${r.diff.map(d => `<tr class="${d.statusChanged || d.outputChanged ? 'diff-changed' : ''}">
      <td><b>${esc(d.node)}</b></td><td>${esc(d.statusA)}</td><td>${esc(d.statusB)}</td>
      <td>${d.outputChanged ? '⚠ 有变化' : '一致'}</td><td>${d.msA ?? '-'} / ${d.msB ?? '-'} ms</td></tr>`).join('')}</tbody></table>
    <p class="note" style="margin-top:8px">黄色行表示状态或输出存在差异（接口升级后的典型信号）。</p>`;
  if (box) { box.innerHTML = html; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  else { $('#diffBody').innerHTML = html; $('#diffModal').classList.remove('hidden'); }
}
/* ───────── 并行执行：多个流程同时跑（服务端并发池） ───────── */
const BATCH_CONC = [2, 3, 4, 6, 8];
function batchCandidates() {   // 只有已发布的流程能跑
  return [...state.batch].filter(id => state.flows.some(f => f.id === id && f.version > 0));
}
$('#btnBatchRun').onclick = () => {
  const ids = batchCandidates();
  if (!ids.length) return alert('请先勾选已发布的流程');
  const flows = ids.map(id => state.flows.find(f => f.id === id));
  state.batchHideBar = false;
  $('#batchTitle').textContent = `并行执行 ${ids.length} 个流程`;
  $('#batchBody').innerHTML = `
    <div class="form-tip">勾选的流程会<b>同时</b>开跑：并发度决定同一时刻最多跑几个，其余排队等待。
      单流程内部的分支并行仍由引擎按边推进。这批运行在记录里标记为「并行」触发。</div>
    <div class="batchpick">
      ${flows.map(f => `<div class="batchpick-row"><b>${esc(f.name)}</b><span class="note">${f.nodeCount} 节点 · v${f.version} · ${esc(f.id)}</span></div>`).join('')}
    </div>
    <div class="batchset">
      <label class="note">并发度</label>
      <select class="sel" id="batchConc">${BATCH_CONC.map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} 个流程同时跑</option>`).join('')}</select>
      <span class="note">上限 8 —— 上游限流较严时建议 2，避免同时打满</span>
    </div>
    <div id="batchMsg"></div>
    <div class="modal-foot">
      <button class="btn" id="batchCancelSetup">取消</button>
      <button class="btn primary" id="batchStart">▶▶ 开始并行执行</button>
    </div>`;
  $('#batchCancelSetup').onclick = () => $('#batchModal').classList.add('hidden');
  $('#batchStart').onclick = startBatch;
  $('#batchModal').classList.remove('hidden');
};
async function startBatch() {
  const ids = batchCandidates();
  const btn = $('#batchStart');
  btn.disabled = true; btn.textContent = '启动中…';
  state.batchHideBar = false;
  try {
    const b = await api('/api/flows/batch-run', {
      method: 'POST',
      body: JSON.stringify({ ids, concurrency: +$('#batchConc').value || 3 }),
    });
    state.batchJob = b;
    renderBatch(b);
    renderBatchBar(b);
    watchBatch(b.id);
  } catch (e) {
    $('#batchMsg').innerHTML = `<div class="msg-bad">启动失败：${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = '▶▶ 开始并行执行';
  }
}
function watchBatch(id) {
  if (state.batchTimer) { clearTimeout(state.batchTimer); state.batchTimer = null; }
  const tick = async () => {
    try {
      const b = await api('/api/batches/' + id);
      state.batchJob = b;
      renderBatch(b);
      renderBatchBar(b);
      if (batchLive(b)) { state.batchTimer = setTimeout(tick, 450); return; }
      state.batchTimer = null;
      await loadFlows();      // 批跑结束：刷新列表里的「最近运行」
      renderBatchBar(state.batchJob);
    } catch {
      state.batchTimer = setTimeout(tick, 1500);   // 网络抖动不终止观测
    }
  };
  state.batchTimer = setTimeout(tick, 250);
}
const BATCH_ST = {
  queued: ['排队', 'var(--muted)', 'var(--bg2)'],
  running: ['运行中', 'var(--blue)', 'var(--blue-bg)'],
  success: ['成功', 'var(--ok)', 'var(--ok-bg)'],
  failed: ['失败', 'var(--bad)', 'var(--bad-bg)'],
  cancelled: ['已取消', 'var(--muted)', 'var(--bg2)'],
  skipped: ['未执行', 'var(--muted)', 'var(--bg2)'],
};
const batchLive = b => b.status === 'running' || b.status === 'cancelling';
const batchPill = st => {
  const [t, c, bg] = BATCH_ST[st] || [st, 'var(--muted)', 'var(--bg2)'];
  return `<span class="pill" style="background:${bg};color:${c}">${t}</span>`;
};
function renderBatch(b) {
  const body = $('#batchBody');
  if (!body || !b) return;
  const pct = b.total ? Math.round(b.done / b.total * 100) : 0;
  body.innerHTML = `
    <div class="batchsum">
      <div><b>${b.done}/${b.total}</b><span>已完成</span></div>
      <div><b style="color:var(--ok)">${b.success}</b><span>成功</span></div>
      <div><b style="color:${b.failed ? 'var(--bad)' : 'var(--muted)'}">${b.failed}</b><span>失败</span></div>
      <div><b>${b.concurrency}</b><span>并发度</span></div>
      <div><b>${fmtDur(b.durationMs)}</b><span>墙钟耗时</span></div>
      <div><b style="color:var(--purple)">${b.speedup ? b.speedup + '×' : '—'}</b><span>并行加速</span></div>
    </div>
    <div class="prog"><div class="prog-fill${batchLive(b) ? ' live' : ''}" style="width:${pct}%"></div></div>
    <div class="batchlist">
      ${b.items.map(it => `
        <div class="batchrow">
          ${batchPill(it.status)}
          <b>${esc(it.flowName)}</b>
          <span class="note">v${it.version}${it.num ? ` · run #${it.num}` : ''}</span>
          <span style="flex:1"></span>
          ${it.error ? `<span class="note" style="color:var(--bad)" title="${esc(it.error)}">${esc(it.error.slice(0, 42))}</span>` : ''}
          <span class="note num">${it.durationMs != null ? fmtDur(it.durationMs) : it.status === 'running' ? '…' : ''}</span>
          ${it.runId ? `<button class="btn" onclick="openBatchRun('${esc(it.flowId)}','${esc(it.runId)}')">查看</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="modal-foot">
      ${batchLive(b)
        ? `<button class="btn danger" id="batchAbort">停止未开始的</button>`
        : `<span class="note">批次 ${esc(b.id)} · 峰值 ${b.peakConcurrency} 个流程同时在跑${b.cancelled ? ` · 取消 ${b.cancelled} 个` : ''}</span>`}
      <span style="flex:1"></span>
      <button class="btn" id="batchAgain" ${batchLive(b) ? 'disabled' : ''}>↻ 再跑一次</button>
      <button class="btn primary" onclick="document.getElementById('batchModal').classList.add('hidden')">关闭</button>
    </div>`;
  if ($('#batchAbort')) $('#batchAbort').onclick = () => cancelBatch(b.id);
  if ($('#batchAgain')) $('#batchAgain').onclick = () => { $('#batchModal').classList.add('hidden'); $('#btnBatchRun').onclick(); };
}
function renderBatchBar(b) {
  const bar = $('#batchBar');
  if (!bar) return;
  b = b || state.batchJob;
  if (!b) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  if (state.batchHideBar) return;
  const live = batchLive(b);
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="dot" style="background:${live ? 'var(--blue)' : b.failed ? 'var(--bad)' : 'var(--ok)'}"></span>
    <b>并行批跑 ${b.done}/${b.total}</b>
    <span class="note">${live ? `并发 ${b.concurrency} · 运行中 ${b.running} · 排队 ${b.queued}` : `成功 ${b.success} · 失败 ${b.failed}${b.cancelled ? ` · 取消 ${b.cancelled}` : ''}`}</span>
    <span class="note" style="margin-left:auto">${fmtDur(b.durationMs)}</span>
    ${live ? '<button class="btn" id="batchBarAbort">停止</button>' : ''}
    <button class="btn" id="batchBarOpen">查看进度</button>
    <button class="btn" id="batchBarClose" title="收起到后台继续跑">✕</button>`;
  if ($('#batchBarAbort')) $('#batchBarAbort').onclick = () => cancelBatch(b.id);
  $('#batchBarOpen').onclick = () => { $('#batchModal').classList.remove('hidden'); renderBatch(state.batchJob); };
  $('#batchBarClose').onclick = () => { state.batchHideBar = true; bar.classList.add('hidden'); };
}
async function cancelBatch(id) {
  try {
    const b = await api(`/api/batches/${id}/cancel`, { method: 'POST' });
    state.batchJob = b;
    renderBatch(b); renderBatchBar(b);
  } catch (e) { alert('取消失败：' + e.message); }
}
async function openBatchRun(flowId, runId) {
  $('#batchModal').classList.add('hidden');
  state.flow = flowId;
  switchTab('run');
  try { await refreshRunFlows(); await loadRun(runId); }
  catch (e) { console.error('openBatchRun:', e); alert('打开运行详情失败：' + e.message); }
}
$('#batchClose').onclick = () => $('#batchModal').classList.add('hidden');
$('#batchModal').addEventListener('click', e => { if (e.target.id === 'batchModal') $('#batchModal').classList.add('hidden'); });
$('#btnBatchDel').onclick = async () => {
  const ids = [...state.batch].filter(id => state.flows.some(f => f.id === id));
  if (!ids.length) return;
  const names = ids.map(id => (state.flows.find(f => f.id === id) || {}).name || id);
  const preview = names.slice(0, 5).map(n => `「${n}」`).join('、') + (names.length > 5 ? ` 等 ${names.length} 个` : '');
  if (!confirm(`确认删除 ${ids.length} 个流程？\n\n${preview}\n\n流程定义、草稿与全部运行历史都会一并删除，不可恢复。`)) return;
  const btn = $('#btnBatchDel');
  btn.disabled = true; btn.textContent = '删除中…';
  try {
    const r = await api('/api/flows/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    state.batch.clear();
    if (r.missing && r.missing.length) alert(`已删除 ${r.deletedCount} 个，${r.missing.length} 个不存在（可能已被其他操作删除）`);
    if (r.deleted.includes(state.selFlow)) state.selFlow = null;
    await loadFlows();
    renderFlowPanel();
  } catch (e) {
    alert('批量删除失败：' + e.message);
  } finally {
    btn.textContent = '✕ 批量删除';
    syncBatchBar();
  }
};
$('#btnBatchCmp').onclick = () => {
  const ids = [...state.batch].filter(id => state.flows.some(f => f.id === id && f.version > 0));
  if (ids.length !== 1) return;
  state.selFlow = ids[0];
  document.querySelectorAll('#flowRows tr').forEach(x => x.classList.toggle('sel', x.dataset.flow === ids[0]));
  renderFlowPanel();
  const box = $('#fpCmpResult');
  if (box) compareLast(ids[0], box);
};
function openRun(flowId) {                  // 跳到运行观测并选中该流程（此前未定义，点击无反应）
  state.flow = flowId;
  switchTab('run');
  refreshRunFlows();
}
$('#btnNew').onclick = () => { state.draft = null; state.draftFlowId = null; switchTab('build'); $('#chatMsgs').innerHTML = '<div class="msg agent">描述你想自动化的接口流程，例如：<br>「供应商准入检查：查供应商 S-8891 状态，如果是 ACTIVE 就把分数同步给 ERP，否则标记拒绝」</div>'; };
async function editFlow(id) {
  // 以已发布定义作为草稿底稿载入画布
  const pub = await api(`/api/flows/${id}/def`);
  state.draftFlowId = id;
  state.draft = pub.def ? { ...pub.def, gates: { schema: { ok: true, errors: [], warnings: [] }, dryRun: { ok: null }, confirm: { ok: null } } } : null;
  switchTab('build');
  renderBuildCanvas();
  renderGates();
  $('#dbgInput').value = '';
  syncDbgInput();
  addChat('agent', '已载入流程「' + (state.draft.name || id) + '」当前版本到画布，可拖拽调整后重新发布。');
}

/* ───────── 画布渲染（搭建 / 运行共用） ───────── */
const NODE_W = { start: 120, condition: 170, transform: 200, http: 210, loop: 210 };
function nodeWidth(n) { return NODE_W[n.type] || 190; }
function nodeBadge(n) {
  if (n.type === 'start') return ['START', 'background:var(--bg-soft);color:var(--ink-2)'];
  if (n.type === 'condition') return ['IF', 'background:var(--amber-bg);color:var(--amber)'];
  if (n.type === 'transform') return ['JQ', 'background:var(--purple-bg);color:var(--purple)'];
  if (n.type === 'loop') return ['LOOP', 'background:var(--purple-bg);color:var(--purple)'];
  return [n.config.method.toUpperCase(), /^GET$/i.test(n.config.method) ? 'background:var(--teal-bg);color:var(--teal)' : 'background:var(--blue-bg);color:var(--blue)'];
}
function renderCanvas(el, def, mode, runState) {
  el.innerHTML = '';
  const layout = def.layout || {};
  const pos = {};
  for (const n of def.nodes) {
    const p = layout[n.id] || { x: 40, y: 260 };
    pos[n.id] = { x: p.x, y: p.y, w: nodeWidth(n), h: 66 };
  }
  // 边（SVG）
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'edges');
  svg.innerHTML = `<defs><marker id="ah-${mode}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" class="edge-marker" stroke-width="1.5" stroke-linecap="round"/></marker></defs>`;

  const canvas = { el, def, mode, pos, edges: [], edgeEls: {} };

  for (const e of def.edges || []) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', e.label === 'else' ? 'edge-else' : 'edge-path');   // 颜色由主题 CSS 变量驱动
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('marker-end', `url(#ah-${mode})`);
    svg.appendChild(path);
    let label = null;
    if (e.label) {
      label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.textContent = e.label;
      label.setAttribute('class', 'edge-label');
      label.setAttribute('font-size', '10');
      label.setAttribute('text-anchor', 'middle');
      svg.appendChild(label);
    }
    // 数据 chip（边中点）：显示上游→下游的流动数据，点击看完整数据与依赖关系
    const chip = document.createElement('div');
    chip.className = 'chip dflow'; chip.style.display = 'none';
    chip.dataset.edge = e.from + '->' + e.to;
    chip.title = '上游输出的流动数据 —— 点击查看完整数据与字段依赖';
    chip.onclick = () => { if (chip.dataset.full) showDataFlow(e.from, e.to, chip.dataset.full); };
    el.appendChild(chip);

    rec = { from: e.from, to: e.to, path, label, chip };
    // 编辑模式下，边中点放一个小 ✕：点一下就删掉这条连线
    if (mode === 'edit') {
      const del = document.createElement('div');
      del.className = 'edge-del'; del.textContent = '✕';
      del.title = '删除这条连线';
      del.onclick = ev => { ev.stopPropagation(); removeEdge(e.from, e.to); };
      el.appendChild(del);
      rec.del = del;
    }
    canvas.edges.push(rec);
    canvas.edgeEls[e.from + '->' + e.to] = path;
    updateEdge(canvas, rec);
  }
  el.appendChild(svg);

  // 节点
  for (const n of def.nodes) {
    const p = pos[n.id];
    const div = document.createElement('div');
    div.className = 'node ' + (mode === 'edit' ? 'st-edit' : 'st-queue');
    div.style.left = p.x + 'px'; div.style.top = p.y + 'px'; div.style.width = p.w + 'px';
    div.dataset.node = n.id;
    const [bt, bs] = nodeBadge(n);
    const sub = n.type === 'http' ? n.config.url.replace(/^https?:\/\/[^/]+/, '') : n.type === 'condition' ? n.config.expr : n.type === 'loop' ? (n.config.over || '') : (n.type === 'transform' ? '转换' : 'input');
    div.innerHTML = `<div class="row1"><span class="badge" style="${bs}">${bt}</span><span class="name">${esc(n.name)}</span><span style="flex:1"></span>${n.assert ? '<span class="atag" title="已配置断言检查">✓A</span>' : ''}${mode === 'edit' && n.type !== 'start' ? `<button class="node-del" title="删除此节点（相关连线一并移除）">✕</button>` : ''}<span class="dot"></span></div>
      <div class="sub">${esc(sub)}</div>
      <div class="meta"></div>`;
    const delBtn = div.querySelector('.node-del');
    if (delBtn) delBtn.onclick = ev => { ev.stopPropagation(); removeNode(n.id); };
    div.onclick = () => {
      if (div.__justDragged) { div.__justDragged = false; return; }   // 拖拽结束不当作点击
      if (mode === 'edit' && handleLinkClick(n.id)) return;           // 连线模式：点击 = 选端点
      el.querySelectorAll('.node').forEach(x => x.classList.remove('st-sel'));
      div.classList.add('st-sel');
      onNodeClick(n, mode);
    };
    if (mode === 'edit') enableDrag(div, canvas, n.id);
    el.appendChild(div);
  }
  fitCanvas(el, pos);
  el.__canvas = canvas;
  return canvas;
}

/* ── 边的几何与重算（拖动时只更新受影响的边，不整图重绘） ── */
function edgeGeometry(a, b) {
  const x1 = a.x + a.w, y1 = a.y + 26, x2 = b.x - 6, y2 = b.y + 26;
  const d = Math.abs(y1 - y2) > 40
    ? `M${x1} ${y1} C ${x1 + 32} ${y1} ${x2 - 32} ${y2} ${x2} ${y2}`
    : `M${x1} ${y1} L ${x2} ${y2}`;
  return { d, x1, y1, x2, y2 };
}
function updateEdge(canvas, rec) {
  const a = canvas.pos[rec.from], b = canvas.pos[rec.to];
  if (!a || !b) return;
  const g = edgeGeometry(a, b);
  rec.path.setAttribute('d', g.d);
  if (rec.label) {
    rec.label.setAttribute('x', (g.x1 + g.x2) / 2);
    rec.label.setAttribute('y', (g.y1 + g.y2) / 2 - 6);
  }
  rec.chip.style.left = ((g.x1 + g.x2) / 2 - 60) + 'px';
  rec.chip.style.top = ((g.y1 + g.y2) / 2 - 12) + 'px';
  if (rec.del) { rec.del.style.left = ((g.x1 + g.x2) / 2 - 8) + 'px'; rec.del.style.top = ((g.y1 + g.y2) / 2 + 12) + 'px'; }
}
function updateEdgesFor(canvas, id) {
  for (const rec of canvas.edges) if (rec.from === id || rec.to === id) updateEdge(canvas, rec);
}
/* 画布随节点位置自动扩展，保证拖到边界外也能看到 */
function fitCanvas(el, pos) {
  let mw = 1200, mh = 620;
  for (const k in pos) { const p = pos[k]; mw = Math.max(mw, p.x + p.w + 140); mh = Math.max(mh, p.y + 140); }
  el.style.width = mw + 'px'; el.style.height = mh + 'px';
}

/* ── 节点拖拽：指针捕获 + 实时移动 + 松手落库 ── */
function enableDrag(div, canvas, id) {
  let drag = null;
  div.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (ev.target.closest('input,select,textarea,button,a')) return;   // 表单控件不拦
    const p = canvas.pos[id];
    drag = { pid: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: p.x, oy: p.y, moved: false };
    try { div.setPointerCapture(ev.pointerId); } catch {}
    div.classList.add('dragging');
    canvas.el.classList.add('is-dragging');
    ev.preventDefault();
  });
  div.addEventListener('pointermove', ev => {
    if (!drag || ev.pointerId !== drag.pid) return;
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;         // 3px 内视为点击
    drag.moved = true;
    setNodePos(canvas, id, drag.ox + dx, drag.oy + dy);
  });
  const finish = () => {
    if (!drag) return;
    const moved = drag.moved;
    try { if (div.hasPointerCapture(drag.pid)) div.releasePointerCapture(drag.pid); } catch {}
    div.classList.remove('dragging');
    canvas.el.classList.remove('is-dragging');
    drag = null;
    if (moved) {
      div.__justDragged = true;                    // 抑制随后的 click
      commitLayout(canvas, id);
    }
  };
  div.addEventListener('pointerup', finish);
  div.addEventListener('pointercancel', finish);
  div.addEventListener('lostpointercapture', finish);
}
function setNodePos(canvas, id, x, y) {
  const p = canvas.pos[id];
  p.x = Math.max(0, Math.round(x)); p.y = Math.max(0, Math.round(y));
  const div = canvas.el.querySelector(`[data-node="${id}"]`);
  if (div) { div.style.left = p.x + 'px'; div.style.top = p.y + 'px'; }
  updateEdgesFor(canvas, id);
  fitCanvas(canvas.el, canvas.pos);
}
function commitLayout(canvas, id) {
  const p = canvas.pos[id];
  canvas.def.layout = canvas.def.layout || {};
  canvas.def.layout[id] = { x: p.x, y: p.y };
  if (state.draft && canvas.def === state.draft) {
    const note = $('#buildNote');
    if (note) note.textContent = `布局已更新（${id} → ${p.x}, ${p.y}）· 发布时一并保存`;
  }
}
function showProvenance(fromNode, dataJson) {
  alert('字段级来源溯源\n\n来源节点：' + fromNode + '\n\n输出数据：\n' + dataJson);
}

/* ───────── 运行结果与数据流动：结果卡 · JSON 高亮 · 依赖扫描 ───────── */
/* JSON 语法高亮（key 蓝 / 字符串绿 / 数字琥珀 / 布尔紫，跟随主题变量）——
   先按词法切分再逐段 esc：直接 esc 整体会把引号变 &quot; 导致字符串匹配失效 */
function hlJson(v) {
  const json = JSON.stringify(v, null, 2) ?? 'null';
  const re = /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g;
  let out = '', last = 0, m;
  while ((m = re.exec(json))) {
    out += esc(json.slice(last, m.index));
    let cls = 'j-num';
    if (m[0].startsWith('"')) cls = m[0].endsWith(':') ? 'j-key' : 'j-str';
    else if (m[0] === 'true' || m[0] === 'false') cls = 'j-bool';
    else if (m[0] === 'null') cls = 'j-null';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(json.slice(last));
}
/* 流程汇点：没有出边的节点（多分支可有多个终点，全部视为结果出口） */
function resultEndpoints(def) {
  const hasOut = new Set((def.edges || []).map(e => e.from));
  const ends = (def.nodes || []).filter(n => n.type !== 'start' && !hasOut.has(n.id));
  return ends.length ? ends : (def.nodes || []).filter(n => n.type !== 'start');
}
/* 按点路径取值（'entity.0.productName'），不存在的路径返回 undefined */
function lookupPath(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
}
/* 扫描节点间模板引用 {{nodes.X.output...}}：upstream=本节点引用了谁，downstream=谁引用了本节点 */
const REF_RE = /\{\{\s*nodes\.([a-zA-Z0-9_]+)\.(output[^}]*)\}\}/g;
function scanRefs(def, nodeId) {
  const cfgText = n => { try { return JSON.stringify(n.config || {}); } catch { return ''; } };
  const byId = Object.fromEntries((def.nodes || []).map(n => [n.id, n]));
  const me = byId[nodeId];
  const upstream = [], downstream = [];
  if (me) {
    for (const m of (JSON.stringify(me.config || {})).matchAll(REF_RE)) if (m[1] !== nodeId) upstream.push({ from: m[1], expr: `{{nodes.${m[1]}.${m[2]}}}`, path: m[2] });
  }
  for (const n of def.nodes || []) {
    if (n.id === nodeId) continue;
    for (const m of (JSON.stringify(n.config || {})).matchAll(REF_RE)) if (m[1] === nodeId) downstream.push({ node: n.id, nodeName: n.name, expr: `{{nodes.${m[1]}.${m[2]}}}`, path: m[2] });
  }
  return { upstream, downstream };
}
/* 结果卡：突出显示流程最终输出（汇点节点的完整响应），失败时红卡显示错误 */
function renderResultCard(def, runNodes, meta = {}) {
  const nodesById = Object.fromEntries((def.nodes || []).map(n => [n.id, n]));
  const ok = meta.status === 'success';
  const failedNode = Object.entries(runNodes || {}).find(([, r]) => r.status === 'failed');
  const ends = resultEndpoints(def).map(n => ({ n, rec: (runNodes || {})[n.id] || {} }));
  const withOut = ends.filter(x => x.rec.output != null);
  const head = `
    <div class="result-head">
      <span class="pill" style="background:${ok ? 'var(--ok-bg);color:var(--ok)' : 'var(--bad-bg);color:var(--bad)'}">${ok ? '✓ 运行成功' : '✗ 运行' + (meta.status === 'running' ? '中' : '失败')}</span>
      <b>流程返回结果</b>
      ${meta.durationMs != null ? `<span class="note">${fmtDur(meta.durationMs)}</span>` : ''}
      <span style="flex:1"></span>
      ${withOut.length ? `<button class="btn" data-copy-result>⧉ 复制 JSON</button>` : ''}
    </div>`;
  let body;
  if (failedNode) {
    const [nid, rec] = failedNode;
    body = `<div class="result-node"><span class="badge" style="background:var(--bad-bg);color:var(--bad)">✗</span><b>${esc((nodesById[nid] || {}).name || nid)}</b><span class="note">${nid}</span></div>
      <div class="code" style="border-color:var(--red-line);color:var(--bad)">${esc(rec.error || '节点失败')}</div>
      ${ends.filter(x => x.rec.output != null).length ? '<p class="note" style="margin:8px 0 0">失败前的已完成节点输出仍可在画布上点击节点查看。</p>' : ''}`;
  } else if (withOut.length) {
    body = withOut.map(x => `
      <div class="result-node"><span class="badge" style="background:var(--ok-bg);color:var(--ok)">OUT</span><b>${esc(x.n.name)}</b><span class="note">${x.n.id}${x.rec.ms != null ? ' · ' + x.rec.ms + 'ms' : ''}</span></div>
      <div class="code result-json">${hlJson(x.rec.output)}</div>`).join('')
      + `<p class="note" style="margin:8px 0 0">以上为流程终点节点的完整返回 —— 中间节点的输出可点击画布节点或边上的数据 chip 查看。</p>`;
  } else {
    body = '<p class="note">终点节点尚无输出。</p>';
  }
  return `<div class="result-card ${ok ? '' : 'bad'}">${head}${body}</div>`;
}

/* 数据流动弹窗：边上传递的数据 + 下游对上游字段的引用关系 */
function showDataFlow(from, to, dataJson, def) {
  def = def || state.draft || state.def || { nodes: [], edges: [] };
  const byId = Object.fromEntries((def.nodes || []).map(n => [n.id, n]));
  $('#flowTitle').textContent = `数据流动：${(byId[from] || {}).name || from} → ${(byId[to] || {}).name || to}`;
  const refs = scanRefs(def, to).upstream.filter(u => u.from === from);
  $('#flowBody').innerHTML = `
    <p class="note">边上的数据是上游节点 <b>${esc(byId[from] ? byId[from].name : from)}</b> 的输出，执行时会作为下游节点 <b>${esc(byId[to] ? byId[to].name : to)}</b> 的默认输入 —— 下游可用 <code>{{nodes.${esc(from)}.output…}}</code> 精确引用其中的字段。</p>
    <b style="font-size:12px;color:var(--muted)">传递的数据（完整）</b>
    <div class="code result-json">${hlJson(tryParse(dataJson))}</div>
    <b style="font-size:12px;color:var(--muted);display:block;margin-top:12px">依赖关系</b>
    ${refs.length ? `<table class="dep-table"><thead><tr><th>下游节点引用的上游字段</th><th>实际值</th></tr></thead>
      <tbody>${refs.map(r => `<tr><td><code>${esc(r.expr)}</code></td><td class="num">${esc(JSON.stringify(lookupPath(tryParse(dataJson), r.path.replace(/^output\.?/, ''))) ?? '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="note">下游节点没有直接引用本节点输出的具体字段（当前是把上游输出整包作为默认输入）。</p>'}`;
  $('#flowModal').classList.remove('hidden');
}
/* 结果卡「复制 JSON」：事件委托（结果卡在搭建器与运行观测两处出现） */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-copy-result]');
  if (!b) return;
  const box = b.closest('.result-card') && b.closest('.result-card').querySelector('.result-json');
  if (!box) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    b.textContent = '✓ 已复制';
    setTimeout(() => { b.textContent = '⧉ 复制 JSON'; }, 1500);
  }).catch(() => {});
});

/* ───────── 界面 2：搭建器 ───────── */
function switchTab(s) { document.querySelector(`.tab[data-s="${s}"]`).click(); }

/* 左右面板拖宽：手柄压在分隔线上，宽度记在 localStorage，双击 / 回车复位 */
(function initBuildSplitters() {
  const CFG = {
    chat:   { sel: '#buildChat',   key: 'apiflow.chatW',   def: 350, min: 240, side: 'left' },
    drawer: { sel: '#buildDrawer', key: 'apiflow.drawerW', def: 330, min: 240, side: 'right' },
  };
  const clampW = (c, w) => Math.max(c.min, Math.min(Math.round(window.innerWidth * 0.62), Math.round(w)));
  const setW = (c, w, save) => {
    const v = clampW(c, w);
    c.el.style.width = v + 'px';
    if (save) { try { localStorage.setItem(c.key, String(v)); } catch { /* 隐私模式忽略 */ } }
    return v;
  };
  for (const [name, c] of Object.entries(CFG)) {
    const handle = document.querySelector(`.vsplit[data-split="${name}"]`);
    const el = document.querySelector(c.sel);
    if (!handle || !el) continue;
    c.el = el;
    const saved = Number(localStorage.getItem(c.key) || 0);
    setW(c, saved > 0 ? saved : c.def, false);

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.classList.add('on');
      document.body.classList.add('col-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* 老版本忽略 */ }
      const move = ev => {
        const rect = el.getBoundingClientRect();
        setW(c, c.side === 'left' ? ev.clientX - rect.left : window.innerWidth - ev.clientX, false);
      };
      const end = () => {
        handle.classList.remove('on');
        document.body.classList.remove('col-resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        try { localStorage.setItem(c.key, String(parseInt(el.style.width, 10) || c.def)); } catch { /* ignore */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', () => setW(c, c.def, true));
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = el.getBoundingClientRect().width;
      const step = (e.key === 'ArrowRight' ? 1 : -1) * (c.side === 'left' ? 1 : -1) * 24;
      setW(c, cur + step, true);
    });
  }
})();

function addChat(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role; d.innerHTML = esc(text).replace(/\n/g, '<br>');
  $('#chatMsgs').appendChild(d);
  $('#chatMsgs').scrollTop = 1e6;
}
// 智能体回复附带的「相关 SDK 资料」：不是可调接口，但常常是理解参数 / 字段的关键
function addRefs(refs) {
  if (!refs || !refs.length) return;
  const d = document.createElement('div');
  d.className = 'msg agent';
  d.innerHTML = `<div class="refs-h">📚 相关 SDK 资料 · ${refs.length} 条</div>` + refs.map(r => `
    <div class="refrow">
      <span class="fmtchip matk-${esc(r.kind)}">${esc(MAT_KIND[r.kind] || r.kind)}</span>
      <b>${esc(r.parent ? r.parent + '.' : '')}${esc(r.name)}</b>
      <div class="mono">${esc(r.sig || '')}</div>
      ${r.summary ? `<div class="note">${esc(r.summary)}</div>` : ''}
      <div class="note">${esc(r.sourceName || '')} · ${esc(String(r.file || '').split('/').pop())}:${r.line}</div>
    </div>`).join('') +
    `<button class="btn" style="margin-top:6px" onclick="openMaterials('')">检索全部资料</button>`;
  $('#chatMsgs').appendChild(d);
  $('#chatMsgs').scrollTop = 1e6;
}
// 帮助手册依据：说明这次解析「凭什么这么理解」，点开就能看原文章节
function addDocRefs(refs) {
  if (!refs || !refs.length) return;
  const d = document.createElement('div');
  d.className = 'msg agent';
  d.innerHTML = `<div class="refs-h">📖 帮助手册依据 · ${refs.length} 条</div>` + refs.map(r => `
    <div class="refrow docref">
      <b>${esc(r.title)}</b>${r.ops && r.ops.length ? `<span class="note"> → 可能对应 ${r.ops.map(x => esc(x)).join('、')}</span>` : ''}
      <div class="note">${esc(r.snippet)}</div>
      <div class="note">${esc(r.docName)}${r.path && r.path !== r.title ? ' › ' + esc(r.path) : ''}${
        r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noreferrer" style="color:var(--purple)">原文</a>` : ''}</div>
    </div>`).join('');
  $('#chatMsgs').appendChild(d);
  $('#chatMsgs').scrollTop = 1e6;
}
function renderBuildCanvas() {
  state.canvasMode = 'edit';
  if (state.draft) renderCanvas($('#buildCanvas'), state.draft, 'edit');
}

/* ── 搭建器：画布手动编辑（添加接口 / 删除节点 / 连线 / 删线）──
   所有结构性改动直接改 state.draft，防抖后自动保存草稿；
   结构变了旧 dry-run 结果不再可信，保存时把 ② 重置为未执行。 */
function blankDraft() {
  const id = 'flow_manual_' + Math.random().toString(36).slice(2, 8);
  return {
    id, name: '手动新建流程', version: 0,
    input: { schema: { type: 'object' }, sample: {} },
    nodes: [{ id: 'start', type: 'start', name: '开始', config: {} }],
    edges: [], layout: { start: { x: 40, y: 260 } },
    gates: { schema: { ok: null, errors: [], warnings: [] }, dryRun: { ok: null }, confirm: { ok: null } },
  };
}
function saveCanvasDraft() {
  if (!state.draftFlowId || !state.draft) return;
  clearTimeout(saveCanvasDraft._t);
  saveCanvasDraft._t = setTimeout(async () => {
    state.draft.gates = state.draft.gates || {};
    state.draft.gates.dryRun = { ok: null };    // 结构变了，② 必须重跑
    try {
      const r = await api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) });
      if (r.gates) state.draft.gates.schema = r.gates.schema;
      renderGates();
      const errs = r.gates && r.gates.schema && r.gates.schema.errors;
      $('#buildNote').textContent = errs && errs.length ? '已保存，但 Schema 有问题：' + errs.join('；') : '✓ 画布改动已自动保存';
    } catch (e) { $('#buildNote').textContent = '⚠ 自动保存失败：' + e.message; }
  }, 600);
}
$('#btnNewBlank').onclick = async () => {
  state.draft = blankDraft();
  state.draftFlowId = state.draft.id;
  try { await api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) }); } catch {}
  switchTab('build');
  renderBuildCanvas(); renderGates();
  $('#nodeForm').innerHTML = '<span class="note">点击画布节点进行编辑</span>';
  addChat('agent', '已创建空白流程。点「＋ 添加接口」加第一步，节点之间用「⇄ 连线」或直接拖不动时点节点右侧按钮连接。');
};
function nodeName(id) {
  const n = state.draft && state.draft.nodes.find(x => x.id === id);
  return n ? n.name : id;
}

/* ── 添加接口节点 ── */
$('#btnAddNode').onclick = () => {
  if (!state.catalog) return alert('接口目录还没加载好，稍等一下再试');
  $('#opPickModal').classList.remove('hidden');
  $('#opPickSearch').value = '';
  renderOpPick('');
  $('#opPickSearch').focus();
};
$('#opPickSearch').addEventListener('input', e => renderOpPick(e.target.value));
function renderOpPick(q) {
  const kw = (q || '').trim().toLowerCase();
  const ops = (state.catalog.operations || []).filter(o =>
    !kw || [o.name, o.path, o.id, ...(o.keywords || [])].join(' ').toLowerCase().includes(kw));
  $('#opPickList').innerHTML = ops.length ? ops.map(o => `
    <div class="srccard" style="cursor:pointer;margin-bottom:8px" onclick="pickOperation('${o.id}')">
      <div class="h"><span class="vtag">${esc(o.method || 'GET')}</span>${esc(o.name)}<span style="flex:1"></span><span class="m">${esc((o.baseUrl || '') + (o.path || ''))}</span></div>
      <div class="m">${esc(o.description || '')}${o.readOnly === false ? ' · <b style="color:var(--amber)">写操作（已预置幂等键）</b>' : ''} · 参数：${esc((o.params || []).join(', ') || '无')}</div>
    </div>`).join('')
    : '<div class="empty">没有匹配的接口。可以先到「接口」页接入 OpenAPI / 导入 SDK，再回来添加。</div>';
}
function pickOperation(opId) {
  const op = (state.catalog.operations || []).find(o => o.id === opId);
  if (!op) return;
  $('#opPickModal').classList.add('hidden');
  if (!state.draft) {          // 还没有草稿：先给一个带开始节点的骨架，让「手搭」有起点
    state.draft = blankDraft();
    state.draftFlowId = state.draft.id;
    api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) }).catch(() => {});
  }
  const d = state.draft;
  let nid = 'n_' + String(op.id).replace(/[^\w]/g, '_');
  let i = 2;
  const ids = new Set(d.nodes.map(x => x.id));
  while (ids.has(nid)) nid = `n_${String(op.id).replace(/[^\w]/g, '_')}_${i++}`;
  const node = {
    id: nid, type: 'http', name: op.name, operationId: op.id, apiVersion: op.version,
    config: { method: (op.method || 'GET').toUpperCase(), url: (op.baseUrl || '') + (op.path || '') },
    retry: { maxAttempts: 1, backoffMs: 300 },
  };
  if (op.readOnly === false) node.idempotencyKey = '{{run.num}}-' + nid;   // 与自然语言生成的写操作保持一致
  d.nodes.push(node);
  // 布局：接在当前链尾（出度为 0 的节点）右边；条件节点有分支语义，不当链尾
  const outDeg = {};
  for (const e of d.edges || []) outDeg[e.from] = (outDeg[e.from] || 0) + 1;
  const tail = d.nodes.filter(x => x.id !== nid && x.type !== 'condition' && !(outDeg[x.id] > 0)).pop();
  const start = d.nodes.find(x => x.id === 'start');
  const anchor = tail || start;
  const ax = anchor ? ((d.layout && d.layout[anchor.id]) || { x: 40, y: 260 }).x : 40;
  const ay = anchor ? ((d.layout && d.layout[anchor.id]) || { x: 40, y: 260 }).y : 260;
  d.layout = d.layout || {};
  d.layout[nid] = { x: ax + (anchor ? nodeWidth(anchor) + 90 : 440), y: ay };
  // 自动把新节点接到链尾；没有链尾（如空流程只有 start）就从 start 连出
  if (tail) addEdge(tail.id, nid, true);
  else if (start) addEdge('start', nid, true);
  renderBuildCanvas();
  saveCanvasDraft();
  if (op.params && op.params.length) {
    const miss = op.params.filter(p => !d.nodes.find(x => x.id === nid).config.url.includes('{' + p + '}'));
    if (miss.length) toast(`接口「${op.name}」需要参数：${miss.join(', ')} —— 点开节点在 URL 里填值或写 {{input.x}}`, 'bad');
    else toast(`已添加「${op.name}」，URL 里的 {${op.params.join('}/{')}} 占位符要替换成实际值`);
  } else {
    toast(`已添加「${op.name}」${tail ? '，并接到 ' + tail.name : ''}`);
  }
  onNodeClick(node, 'edit');   // 直接打开属性面板，引导补参数
  const el = $('#buildCanvas').querySelector(`[data-node="${nid}"]`);
  if (el) el.classList.add('st-sel');
}

/* ── 删除节点 / 连线 ── */
function removeNode(id) {
  const d = state.draft;
  if (!d) return;
  const n = d.nodes.find(x => x.id === id);
  if (!n) return;
  if (n.type === 'start') return toast('开始节点不能删除', 'bad');
  let refs = 0;
  const re = new RegExp('nodes\\.' + id + '\\.', 'g');
  for (const x of d.nodes) refs += (JSON.stringify(x.config || {}).match(re) || []).length;
  const msg = refs
    ? `删除「${n.name}」？\n\n注意：${refs} 处下游配置引用了它的输出（{{nodes.${id}…}}），删除后这些引用会失效，需要手动调整。`
    : `删除节点「${n.name}」及其相关连线？`;
  if (!confirm(msg)) return;
  d.nodes = d.nodes.filter(x => x.id !== id);
  d.edges = (d.edges || []).filter(e => e.from !== id && e.to !== id);
  if (d.layout) delete d.layout[id];
  if (state.selNode && state.selNode.id === id) {
    state.selNode = null;
    $('#nodeForm').innerHTML = '<span class="note">点击画布节点进行编辑</span>';
  }
  renderBuildCanvas();
  saveCanvasDraft();
  toast(`已删除「${n.name}」`);
}
function removeEdge(from, to) {
  const d = state.draft;
  if (!d) return;
  d.edges = (d.edges || []).filter(e => !(e.from === from && e.to === to));
  renderBuildCanvas();
  saveCanvasDraft();
  toast(`已移除连线 ${nodeName(from)} → ${nodeName(to)}`);
}

/* ── 连线模式：点起点 → 点终点 ── */
function addEdge(from, to, silent) {
  const d = state.draft;
  if (from === to) { if (!silent) toast('不能把节点连到自己', 'bad'); return false; }
  if ((d.edges || []).some(e => e.from === from && e.to === to)) { if (!silent) toast('这条连线已经存在', 'bad'); return false; }
  const src = d.nodes.find(x => x.id === from);
  const edge = { from, to };
  if (src && src.type === 'condition') {          // 条件节点的出边带分支标记，最多两条
    const outs = (d.edges || []).filter(e => e.from === from);
    if (outs.length >= 2) { if (!silent) toast('条件节点最多两个分支（then / else 都已占用）', 'bad'); return false; }
    edge.label = outs.length === 0 ? 'then' : 'else';
    if (!silent) toast(`条件分支自动标记为 ${edge.label}`);
  }
  (d.edges = d.edges || []).push(edge);
  if (!silent) { saveCanvasDraft(); toast(`已连接 ${nodeName(from)} → ${nodeName(to)}`); }
  return true;
}
$('#btnLinkMode').onclick = () => setLinkMode(state.linkMode ? null : { from: null });
function setLinkMode(v) {
  state.linkMode = v;
  $('#btnLinkMode').classList.toggle('primary', !!v);
  $('#buildCanvas').classList.toggle('linking', !!v);
  const h = $('#canvasHint');
  if (!v) { h.textContent = ''; return; }
  h.textContent = v.from ? `从「${nodeName(v.from)}」出发 —— 点击目标节点完成连线（Esc 取消）` : '连线模式：点击起点节点（Esc 取消）';
}
function handleLinkClick(nodeId) {
  if (!state.linkMode) return false;
  if (!state.linkMode.from) {
    state.linkMode.from = nodeId;
    const el = $('#buildCanvas').querySelector(`[data-node="${nodeId}"]`);
    if (el) el.classList.add('link-from');
    setLinkMode({ from: nodeId });
    return true;
  }
  const from = state.linkMode.from;
  setLinkMode(null);
  const ok = addEdge(from, nodeId);
  renderBuildCanvas();
  return true;    // 连线模式下点击不再打开属性面板
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.linkMode) setLinkMode(null);
});
/* ── 搭建器：流程级认证（调试 / 运行共用同一 authId 解析） ── */
const credModeLabel = m => m === 'ecloud' ? '移动云 V2.0 签名' : m === 'header' ? '头直传' : 'HMAC 签名';
async function ensureCreds() {           // 搭建器页也需要凭证列表（流程列表页之外进入时兜底加载）
  if (state.creds && state.creds.length) return;
  try {
    const d = await api('/api/creds');
    state.creds = d.items; state.opBindings = d.opBindings || {};
  } catch { /* 无凭证时下拉仅剩「无认证」 */ }
}
function syncDraftAuth() {               // 把草稿的 authId 反映到下拉框
  const sel = $('#draftAuth');
  if (!sel) return;
  if (!sel.options.length || sel.options.length !== (state.creds || []).length + 1) {
    sel.innerHTML = '<option value="">无认证</option>' +
      (state.creds || []).map(c => `<option value="${c.id}">${esc(c.name)}（${credModeLabel(c.mode)}）</option>`).join('');
  }
  sel.value = (state.draft && state.draft.authId) || '';
}
$('#draftAuth').onchange = async e => {
  if (!state.draft) { e.target.value = ''; return alert('请先生成或载入草稿'); }
  const authId = e.target.value || null;
  state.draft.authId = authId;
  try {
    await api(`/api/flows/${state.draftFlowId}/auth`, { method: 'POST', body: JSON.stringify({ authId }) });
    $('#buildNote').textContent = authId ? '✓ 已设置流程级认证，调试 / Dry-run / 正式运行均会注入' : '已清除流程级认证';
  } catch (err) {
    $('#buildNote').textContent = '认证设置失败：' + err.message;
  }
};

function renderGates() {
  const g = state.draft && state.draft.gates || {};
  const chip = (label, gk, okTxt) => {
    const st = g[gk];
    if (!st || st.ok === null && gk !== 'schema') return `<span class="gate">${label}：未完成</span>`;
    if (st.ok === true) return `<span class="gate ok">✓ ${label}（${okTxt}）</span>`;
    if (st.ok === false) return `<span class="gate bad">✗ ${label}${st.errors && st.errors.length ? '：' + esc(st.errors[0]) : ''}</span>`;
    return `<span class="gate">${label}：未执行</span>`;
  };
  $('#gateChips').innerHTML =
    chip('① Schema 校验', 'schema', g.schema && g.schema.ok ? '通过' + (g.schema.warnings.length ? '，' + g.schema.warnings.length + ' 警告' : '') : '') +
    chip('② Dry-run', 'dryRun', '通过') +
    (g.confirm && g.confirm.ok ? '<span class="gate ok">✓ ③ 人工画布确认</span>' : '<span class="gate wait">● ③ 等待人工画布确认</span>');
  syncDraftAuth();                         // 草稿变化（生成 / 载入 / 修复）后同步认证下拉
}
// 认不出接口时给几个「也许你想说」，点一下填回输入框，不用重打
function addSuggestions(list) {
  if (!list || !list.length) return;
  const d = document.createElement('div');
  d.className = 'msg agent';
  d.innerHTML = '<div class="note" style="margin-bottom:6px">点一下填进输入框：</div>' +
    list.map(n => `<button class="btn sug" data-sug="${esc(n)}">${esc(n)}</button>`).join('');
  d.querySelectorAll('.sug').forEach(b => {
    b.onclick = () => { $('#chatText').value = b.dataset.sug; $('#chatText').focus(); };
  });
  $('#chatMsgs').appendChild(d);
  $('#chatMsgs').scrollTop = 1e6;
}
async function sendBuildText() {
  const text = $('#chatText').value.trim();
  if (!text) return;
  $('#chatText').value = '';
  addChat('user', text);
  const btn = $('#btnSend');
  btn.disabled = true;
  try {
    const res = await api('/api/agent/draft', { method: 'POST', body: JSON.stringify({ text, flowId: state.draftFlowId, history: [] }) });
    state.draftFlowId = res.flow.id;
    state.draft = res.draft;
    addChat('agent', res.explanation);
    addRefs(res.references);
    addDocRefs(res.docRefs);
    $('#dbgInput').value = '';
    syncDbgInput();
    renderBuildCanvas(); renderGates();
  } catch (e) {
    addChat('agent', '⚠ ' + e.message);
    if (e.data && e.data.suggestions) addSuggestions(e.data.suggestions);   // 先给「可能想说的」，比干瞪眼有用
    if (e.data && e.data.references) addRefs(e.data.references);            // 顺便把相关资料给出来
    if (e.data && e.data.docRefs) addDocRefs(e.data.docRefs);              // 手册里的相关章节
  } finally {
    btn.disabled = false;
  }
}
$('#btnSend').onclick = sendBuildText;
$('#chatText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBuildText(); }
});
function onNodeClick(n, mode) {
  state.selNode = n;
  if (mode !== 'edit') { showRunDrawer(n.id); return; }   // 运行观测：打开节点详情抽屉
  const f = $('#nodeForm');
  if (n.type === 'http') {
    f.innerHTML = `
      <span class="kv-sec">请求</span>
      <b>名称</b><input id="f-name" value="${esc(n.name)}">
      <b>方法</b><select id="f-method">${['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map(m => `<option ${m === n.config.method.toUpperCase() ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <b>URL</b><input id="f-url" value="${esc(n.config.url)}">
      <b>Body</b><textarea id="f-body" rows="4" placeholder='{"id": "{{input.orderId}}"}'>${esc(n.config.body != null ? JSON.stringify(n.config.body, null, 1) : '')}</textarea>
      <span class="kv-sec">执行策略</span>
      <b>重试次数</b><input id="f-retry" type="number" min="1" max="10" value="${n.retry ? n.retry.maxAttempts : 1}">
      <b>退避(ms)</b><input id="f-backoff" type="number" value="${n.retry ? n.retry.backoffMs : 300}">
      <b>幂等键</b><input id="f-idem" value="${esc(n.idempotencyKey || '')}" placeholder="写操作建议配置">
      <b>超时(ms)</b><input id="f-timeout" type="number" value="${n.timeout || 10000}">
      <span class="kv-sec">断言</span>
      <b>状态码</b><input id="f-ast-status" value="${esc(((n.assert && n.assert.status) || []).join(','))}" placeholder="如 200,201（可空，默认校验 2xx）">
      <b>输出字段</b><input id="f-ast-fields" value="${esc(((n.assert && n.assert.outputHas) || []).join(','))}" placeholder="输出必须包含的顶层字段，逗号分隔">
      <b>表达式</b><input id="f-ast-expr" value="${esc((n.assert && n.assert.expr) || '')}" placeholder="如 score >= 60（可空）">
      <span class="note">URL 与 Body 里可写 {{input.x}}（流程输入）或 {{nodes.节点id.output.字段}}（上游输出）；query 参数直接拼在 URL 上（如 ?poolId=1&amp;pageNo=1）。断言在运行期对真实响应校验，失败则节点标红并中断流程；「自动加断言」会按注册表字段一键生成。</span>`;
  } else if (n.type === 'condition') {
    f.innerHTML = `<span class="kv-sec">条件</span><b>名称</b><input id="f-name" value="${esc(n.name)}"><b>表达式</b><input id="f-expr" value="${esc(n.config.expr)}"><span class="note">支持 == != &gt; &lt; &gt;= &lt;= includes，左值为上游输出字段</span>`;
  } else { f.innerHTML = `<span class="kv-sec">节点</span><b>名称</b><input id="f-name" value="${esc(n.name)}"><span class="note">${n.type} 节点暂无更多可编辑属性</span>`; }
  // 调试产物：该节点最近一次调试运行的输出 / 断言失败详情
  const dbg = state.debugRun && state.debugRun.nodes && state.debugRun.nodes[n.id];
  if (dbg && (dbg.output != null || dbg.error)) {
    f.innerHTML += `<span class="kv-sec">调试输出</span><div class="code">${esc(JSON.stringify(dbg.output, null, 1))}</div>` +
      (dbg.error ? `<div class="code" style="background:var(--bad-bg);color:var(--bad)">${esc(dbg.error)}</div>` : '') +
      `<span class="note">来自调试 run ${esc(state.debugRun.id)}</span>`;
  }
  f.oninput = () => {
    if ($('#f-name')) n.name = $('#f-name').value;
    if ($('#f-method')) { n.config.method = $('#f-method').value; n.retry = { maxAttempts: +$('#f-retry').value || 1, backoffMs: +$('#f-backoff').value || 300 }; n.idempotencyKey = $('#f-idem').value || undefined; n.timeout = +$('#f-timeout').value || 10000; }
    if ($('#f-body')) {   // Body 必须是合法 JSON 才写入；清空即移除（非法输入保留旧值，不打断输入）
      const raw = $('#f-body').value.trim();
      if (!raw) delete n.config.body;
      else { try { n.config.body = JSON.parse(raw); } catch { /* 等输入合法再写入 */ } }
    }
    if ($('#f-expr')) n.config.expr = $('#f-expr').value;
    if ($('#f-ast-status')) {   // 断言编辑：三项全空 = 移除断言
      const st = $('#f-ast-status').value.split(',').map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x));
      const fields = $('#f-ast-fields').value.split(',').map(x => x.trim()).filter(Boolean);
      const expr = $('#f-ast-expr').value.trim();
      delete n.assert;
      if (st.length || fields.length || expr) {
        n.assert = {};
        if (st.length) n.assert.status = st; else n.assert.ok = true;
        if (fields.length) n.assert.outputHas = fields;
        if (expr) n.assert.expr = expr;
      }
    }
    renderBuildCanvas();
    const el = $('#buildCanvas').querySelector(`[data-node="${n.id}"]`); if (el) el.classList.add('st-sel');
  };
}
$('#btnValidate').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  const r = await api(`/api/flows/${state.draftFlowId}/validate`, { method: 'POST', body: JSON.stringify({ def: state.draft }) });
  state.draft.gates.schema = { ok: r.ok, errors: r.errors, warnings: r.warnings };
  renderGates();
  $('#buildNote').textContent = r.ok ? 'Schema 校验通过' + (r.warnings.length ? '；警告：' + r.warnings.join('；') : '') : '错误：' + r.errors.join('；');
};
$('#btnDryrun').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  await api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) });
  try {
    const r = await api(`/api/flows/${state.draftFlowId}/dry-run`, { method: 'POST' });
    state.draft.gates.dryRun = { ok: r.status === 'success', runId: r.runId };
    renderGates();
    $('#buildNote').textContent = `Dry-run 完成（run #${r.runId}）：${r.status === 'success' ? '只读接口全部通过，写操作已跳过' : '存在失败节点，请检查画布'}`;
  } catch (e) {
    state.draft.gates.dryRun = { ok: false };
    renderGates();
    $('#buildNote').textContent = 'Dry-run 失败：' + e.message;
  }
};
$('#btnPublish').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  await api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) });
  try {
    const r = await api(`/api/flows/${state.draftFlowId}/publish`, { method: 'POST', body: JSON.stringify({ def: state.draft, confirm: true }) });
    state.draft.gates.confirm = { ok: true };
    renderGates();
    $('#buildNote').textContent = `✓ 已发布 v${r.version}，接口版本绑定：` + r.bindings.map(b => `${b.node}@${b.apiVersion}`).join('、');
    addChat('agent', `流程已发布 v${r.version}，可在「运行观测」中执行。`);
  } catch (e) { $('#buildNote').textContent = '发布失败：' + e.message; }
};

/* ── 搭建器：自动修复 / 自动断言 / 调试运行 ── */
function dbgAppend(lines) {
  const box = $('#dbgLog');
  if (!box) return;
  box.insertAdjacentHTML('afterbegin', lines.map(l => `<div>${esc(l)}</div>`).join(''));
}
function syncDbgInput() {   // 生成/载入草稿后，把输入示例预填进调试输入框
  const sample = state.draft && state.draft.input && state.draft.input.sample;
  if ($('#dbgInput') && sample && Object.keys(sample).length && !$('#dbgInput').value.trim()) {
    $('#dbgInput').value = JSON.stringify(sample);
  }
}
$('#btnAutofix').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  try {
    const r = await api(`/api/flows/${state.draftFlowId}/autofix`, { method: 'POST', body: JSON.stringify({ def: state.draft, mode: 'fix' }) });
    state.draft = r.def;
    if (r.schema) state.draft.gates = { ...(state.draft.gates || {}), schema: { ok: r.schema.ok, errors: r.schema.errors, warnings: r.schema.warnings } };
    renderBuildCanvas(); renderGates(); syncDbgInput();
    const lines = [...r.fixes.map(x => '🛠 ' + x), ...r.unfixable.map(x => '⚠ 需人工处理：' + x)];
    dbgAppend(lines);
    $('#buildNote').textContent = r.fixes.length
      ? `自动修复 ${r.fixes.length} 处` + (r.unfixable.length ? `；另有 ${r.unfixable.length} 处需人工处理` : '，Schema 校验已通过')
      : (r.unfixable.length ? '没有可自动修复项，但存在需人工处理的问题' : '未发现结构问题');
    if (lines.length) addChat('agent', `自动修复完成：\n${lines.join('\n')}`);
  } catch (e) { alert('自动修复失败：' + e.message); }
};
$('#btnAutoAssert').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  try {
    const r = await api(`/api/flows/${state.draftFlowId}/autofix`, { method: 'POST', body: JSON.stringify({ def: state.draft, mode: 'assert' }) });
    state.draft = r.def;
    renderBuildCanvas(); renderGates();
    dbgAppend(r.asserts.map(x => '✓A 断言已加：' + x));
    $('#buildNote').textContent = r.asserts.length
      ? `已给 ${r.asserts.length} 个接口节点加断言（节点上有 ✓A 徽标，可在节点属性里调整）`
      : '所有 HTTP 节点都已有断言配置';
  } catch (e) { alert('自动断言失败：' + e.message); }
};
$('#btnDebug').onclick = async () => {
  if (!state.draft) return alert('请先生成或载入草稿');
  let input = {};
  const raw = $('#dbgInput').value.trim();
  if (raw) {
    try { input = JSON.parse(raw); } catch { return alert('调试输入不是合法 JSON'); }
  }
  // 预指定 runId：SSE 事件在请求返回前就开始流，调试面板能实时接住
  const runId = 'run_dbg_' + Date.now().toString(36);
  state.debugRun = { id: runId, nodes: {}, status: 'running' };
  $('#dbgLog').innerHTML = '';
  $('#dbgResult').innerHTML = '';
  $('#dbgStatus').innerHTML = '<span style="color:var(--blue)">调试运行中…（事件实时显示在下方）</span>';
  renderBuildCanvas();
  try {
    await api(`/api/flows/${state.draftFlowId}/draft`, { method: 'POST', body: JSON.stringify({ def: state.draft }) });
    const r = await api(`/api/flows/${state.draftFlowId}/dry-run`, { method: 'POST', body: JSON.stringify({ input, runId }) });
    state.debugRun.status = r.status;
    paintRunState($('#buildCanvas'), state.draft, state.debugRun);
    const nFail = Object.values(r.nodes || {}).filter(x => x.status === 'failed').length;
    $('#dbgStatus').innerHTML = r.status === 'success'
      ? `<span style="color:var(--ok)">✓ 调试通过（run ${esc(r.runId)}）—— 结果见下方，点击节点 / 边可查看中间数据</span>`
      : `<span style="color:var(--bad)">✗ 调试完成，${nFail} 个节点失败 —— 详情见结果卡与日志</span>`;
    // 结果卡：流程终点节点的完整返回（dry-run 响应带全量输出）
    $('#dbgResult').innerHTML = renderResultCard(state.draft, r.nodes, { status: r.status, runId: r.runId });
    if (r.status === 'success') { state.draft.gates = { ...(state.draft.gates || {}), dryRun: { ok: true, runId: r.runId } }; renderGates(); }
  } catch (e) {
    state.debugRun = null;
    $('#dbgStatus').innerHTML = `<span style="color:var(--bad)">调试失败：${esc(e.message)}</span>`;
    dbgAppend(['⚠ ' + e.message]);
  }
};

/* ───────── 界面 3：运行观测 ───────── */
async function refreshRunFlows() {
  if (!state.flows.length) await loadFlows();
  $('#runFlowSel').innerHTML = state.flows.filter(f => f.version > 0).map(f => `<option value="${f.id}">${esc(f.name)} v${f.version}</option>`).join('');
  if (state.flow) $('#runFlowSel').value = state.flow;
  $('#runFlowSel').onchange = () => selectRunFlow($('#runFlowSel').value);
  if ($('#runFlowSel').value) await selectRunFlow($('#runFlowSel').value);   // await：调用方（如并行批跑「查看」）依赖 state.def 就绪
}
async function selectRunFlow(flowId) {
  state.flow = flowId;
  const runs = await api('/api/runs?flowId=' + flowId);
  const opts = runs.map(r => `<option value="${r.id}">#${r.num} ${r.status} ${trigLabel(r.trigger)} ${new Date(r.startedAt).toLocaleTimeString()}</option>`).join('');
  $('#runHist').innerHTML = '<option value="">— 选择历史 run —</option>' + opts;
  $('#cmpA').innerHTML = '<option value="">A</option>' + opts;
  $('#cmpB').innerHTML = '<option value="">B</option>' + opts;
  $('#runHist').onchange = () => { if ($('#runHist').value) loadRun($('#runHist').value); };
  // 画布渲染已发布定义
  const runsFull = await api('/api/runs?flowId=' + flowId);
  const def = await getDef(flowId);
  state.def = def;
  state.liveRun = null;
  state.canvasMode = 'live';
  const rendered = renderCanvas($('#runCanvas'), def, 'live');
  state.edgeEls = rendered.edgeEls;
  $('#runDrawer').innerHTML = '<span class="note">点击节点查看请求 / 响应 / 重试记录</span>';
}
async function getDef(flowId) {
  const f = state.flows.find(x => x.id === flowId);
  if (!f) return null;
  // 从运行记录或重新载入：这里直接通过 publish 接口不可读，改从 run 恢复；最简单：dry-run 会存 draft —— 直接保存 def 副本在 flows API
  const res = await api('/api/flows/' + flowId + '/def');
  return res.def;
}
async function loadRun(runId) {
  const run = await api('/api/runs/' + runId);
  run.pinned = true;              // 用户显式打开的 run：不被其他流程（定时/并行批跑）的 run_start 顶掉
  state.liveRun = run;
  state.run = run;
  paintRunState($('#runCanvas'), state.def, run);
  renderRunHead(run);
  $('#eventLog').innerHTML = (run.events || []).map(fmtEvent).join('') || '<div class="t">（该 run 无事件记录）</div>';
  if (run.nodes && Object.keys(run.nodes).length) showRunResult(run);   // 默认先看流程返回结果，节点详情点画布节点
}
/* 运行观测右栏：流程返回结果卡（终点节点的完整输出） */
function showRunResult(run) {
  if (!state.def || !run) return;
  const anyOut = Object.values(run.nodes || {}).some(r => r.output != null);
  $('#runDrawer').innerHTML = `
    ${renderResultCard(state.def, run.nodes, { status: run.status, durationMs: run.durationMs, num: run.num })}
    <p class="note" style="margin-top:10px">点击画布上的<b>节点</b>查看该节点的请求 / 响应与数据依赖；点击<b>边上的数据 chip</b> 查看节点间流动的数据。</p>
    ${run.input && Object.keys(run.input).length ? `<b style="font-size:12px;color:var(--muted)">本次运行输入</b><div class="code" style="max-height:140px">${hlJson(run.input)}</div>` : ''}`;
}
function renderRunHead(run) {
  $('#runPill').textContent = `#${run.num} · ${run.status === 'running' ? '运行中' : run.status === 'success' ? '成功' : run.status}`;
  $('#runPill').style.cssText = `background:${run.status === 'success' ? 'var(--ok-bg);color:var(--ok)' : run.status === 'running' ? 'var(--blue-bg);color:var(--blue)' : 'var(--bad-bg);color:var(--bad)'}`;
  $('#runMeta').textContent = `输入 ${JSON.stringify(run.input || {})} ｜ 触发：${trigLabel(run.trigger)}${run.actor ? '（' + run.actor + '）' : ''}${run.meta && run.meta.dryRun ? ' ｜ 只读试跑' : ''} ｜ DSL v${run.version}${run.replayFrom ? ` ｜ 重放自 ${run.replayFrom}（复用 run #${(run.replayOf || '').slice(-4)}）` : ''}`;
}
const EDGE_FLOW = '#2FBF8F';   // 数据流动画用品牌 teal，暗色画布上清晰可见
function paintRunState(el, def, run) {
  if (!def || !run) return;
  for (const n of def.nodes) {
    const div = el.querySelector(`[data-node="${n.id}"]`);
    if (!div) continue;
    const rec = run.nodes[n.id] || {};
    const st = rec.status || 'queue';
    const cls = { done: 'st-ok', reused: 'st-ok', running: 'st-run', failed: 'st-fail', skipped: 'st-skip', queue: 'st-queue' }[st] || 'st-queue';
    div.className = 'node ' + cls;
    const meta = div.querySelector('.meta');
    if (st === 'done' || st === 'reused') {
      const prev = rec.output != null ? String(typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output)) : '';
      meta.innerHTML = `<span style="color:var(--ok)">✓ ${rec.httpStatus || ''}</span><span class="note">${rec.ms != null ? rec.ms + 'ms' : ''} ${rec.reused ? '· 复用产物' : ''}</span>`
        + (prev ? `<span class="oprev" title="${esc(prev)}">${esc(prev.slice(0, 64))}</span>` : '');
    }
    else if (st === 'running') meta.innerHTML = '<span style="color:var(--blue)">运行中…</span>';
    else if (st === 'failed') meta.innerHTML = `<span style="color:var(--bad)">✗ ${esc((rec.error || '').slice(0, 40))}</span>`;
    else if (st === 'skipped') meta.innerHTML = '<span class="note">分支未命中</span>';
    else meta.innerHTML = '<span class="note">排队</span>';
  }
}
function fmtEvent(p) {
  const t = new Date(p.ts).toISOString().slice(11, 23);
  const d = p.data || {};
  if (p.event === 'run_start') return `<div><span class="t">${t}</span>  <span class="ev">run_start</span>   <b>#${d.num}</b> ${esc(d.flowName)} v${d.version} <span class="warn">${esc(d.trigger)}</span></div>`;
  if (p.event === 'node_start') return `<div><span class="t">${t}</span>  <span class="ev">node_start</span>  ${esc(d.node)} <span class="warn">${esc(d.type)}</span></div>`;
  if (p.event === 'node_end') return `<div><span class="t">${t}</span>  <span class="ev">node_end</span>    ${esc(d.node)}   <span class="${d.status === 'done' ? 'ok' : 'bad'}">${esc(d.status)} ${d.ms ? d.ms + 'ms' : ''}</span> ${d.error ? '<span class="bad">' + esc(d.error) + '</span>' : ''}</div>`;
  if (p.event === 'node_retry') return `<div><span class="t">${t}</span>  <span class="ev">node_retry</span>  ${esc(d.node)} <span class="warn">第 ${d.attempt}/${d.of} 次</span></div>`;
  if (p.event === 'edge_data') return `<div><span class="t">${t}</span>  <span class="ev">edge_data</span>   ${esc(d.from)} → ${esc(d.to)}   <span class="data">${esc(d.data)}</span></div>`;
  if (p.event === 'edge_skip') return `<div><span class="t">${t}</span>  <span class="t">edge_skip</span>   ${esc(d.from)} → ${esc(d.to)} (${esc(d.label || '')} 未命中)</div>`;
  if (p.event === 'error') return `<div><span class="t">${t}</span>  <span class="bad">error</span>        ${esc(d.node)} ${esc(d.error)}</div>`;
  if (p.event === 'assert_fail') return `<div><span class="t">${t}</span>  <span class="bad">assert_fail</span> ${esc(d.node)} <span class="bad">${esc((d.fails || []).join('；'))}</span></div>`;
  if (p.event === 'run_end') return `<div><span class="t">${t}</span>  <span class="ev">run_end</span>     <b class="${d.status === 'success' ? 'ok' : 'bad'}">#${d.num} ${esc(d.status)}</b> ${d.durationMs}ms</div>`;
  return `<div><span class="t">${t}</span>  ${esc(p.event)}</div>`;
}

/* SSE 订阅 */
function connectSSE() {
  // 强制认证开启后，EventSource 不能带请求头 —— 用 ?token= 兜底（服务端两条路都认）
  const t = authToken();
  state.sse = new EventSource('/api/events' + (t ? '?token=' + encodeURIComponent(t) : ''));
  ['run_start', 'node_start', 'node_end', 'node_retry', 'edge_data', 'edge_skip', 'error', 'assert_fail', 'run_end'].forEach(ev =>    state.sse.addEventListener(ev, e => {
      if (e.data == null) return;   // EventSource 原生 error（断连/重连）无 data，与业务 error 事件同名，须跳过
      const p = JSON.parse(e.data);
      /* 搭建器调试运行：同一条事件流实时喂给调试面板（画布着色 + 中间数据 chip + 日志） */
      if (state.debugRun && p.data && p.data.runId === state.debugRun.id) {
        const bLog = $('#dbgLog');
        if (bLog) {
          bLog.insertAdjacentHTML('afterbegin', fmtEvent(p));
          while (bLog.children.length > 120) bLog.lastChild.remove();
        }
        if (state.draft) {
          if (p.event === 'node_start') state.debugRun.nodes[p.data.node] = { status: 'running' };
          if (p.event === 'node_end') state.debugRun.nodes[p.data.node] = { status: p.data.status === 'done' ? 'done' : p.data.status, httpStatus: p.data.httpStatus, ms: p.data.ms, error: p.data.error, output: tryParse(p.data.output), branch: p.data.branch };
          if (p.event === 'run_end') { state.debugRun.status = p.data.status; state.debugRun.durationMs = p.data.durationMs; }
          paintRunState($('#buildCanvas'), state.draft, state.debugRun);
          if (p.event === 'edge_data') {   // 中间数据流：边 chip 显示流动数据，点击可看字段溯源
            const chip = $('#buildCanvas').querySelector(`[data-edge="${p.data.from}->${p.data.to}"]`);
            if (chip) { chip.style.display = 'block'; chip.textContent = p.data.data; chip.dataset.full = p.data.data; }
          }
        }
        return;   // 调试 run 不进运行观测画布
      }
      const log = $('#eventLog');
      if (log.firstChild && log.firstChild.textContent && log.firstChild.textContent.includes('等待中')) log.innerHTML = '';
      log.insertAdjacentHTML('afterbegin', fmtEvent(p));
      while (log.children.length > 200) log.lastChild.remove();

      if (!state.def || !state.run || p.data.runId !== state.run.id) {
        // 只在「未钉住」时跟随最新 run（显式打开的运行详情不被定时/并行批跑的新 run 抢走头部）
        if (p.event === 'run_start' && !(state.run && state.run.pinned)) { state.run = { id: p.data.runId, num: p.data.num, input: p.data.input, trigger: p.data.trigger, version: p.data.version, replayFrom: p.data.replayFrom, nodes: {}, events: [] }; state.liveRun = state.run; renderRunHead(state.run); }
        else if (!state.run || p.data.runId !== state.run.id) return;
      }
      const run = state.run, def = state.def;
      if (!def) return;
      if (p.event === 'node_start') { run.nodes[p.data.node] = { status: 'running' }; }
      if (p.event === 'node_end') { run.nodes[p.data.node] = { status: p.data.status === 'done' ? 'done' : p.data.status, httpStatus: p.data.httpStatus, ms: p.data.ms, error: p.data.error, attempts: p.data.attempts, output: tryParse(p.data.output) }; }
      if (p.event === 'run_end') {
        run.status = p.data.status; run.durationMs = p.data.durationMs;
        // run_end 时 SSE 里的节点输出是 160 字摘要 —— 拉一次完整 run 记录，刷新结果卡
        api('/api/runs/' + run.id).then(full => {
          run.nodes = full.nodes || run.nodes;
          paintRunState($('#runCanvas'), def, run);
          showRunResult(run);
        }).catch(() => showRunResult(run));
      }
      paintRunState($('#runCanvas'), def, run);
      // 边流动动画 + chip
      if (p.event === 'edge_data') {
        const chip = $('#runCanvas').querySelector(`[data-edge="${p.data.from}->${p.data.to}"]`);
        const edge = state.edgeEls && state.edgeEls[p.data.from + '->' + p.data.to];
        if (chip) { chip.style.display = 'block'; chip.textContent = p.data.data; chip.dataset.full = p.data.data; }
        if (edge) { edge.classList.add('eflow'); edge.style.stroke = EDGE_FLOW; setTimeout(() => { edge.classList.remove('eflow'); edge.style.stroke = ''; }, 4000); }
      }
      if (p.event === 'node_end' && (p.data.status === 'done' || p.data.status === 'reused')) showRunDrawer(p.data.node, run);
    }));
  // 现网自动更新：来源定时同步完成 → 刷新接口页并提示差异
  state.sse.addEventListener('source_sync', e => {
    if (e.data == null) return;
    const p = JSON.parse(e.data);
    const d = p.data || p;
    const n = (d.added || []).length + (d.changed || []).length + (d.removed || []).length;
    if ($('#s-api').classList.contains('on')) loadApi();
    toast(`「${d.sourceName || d.sourceId}」自动同步${n ? `：新增 ${d.added.length} · 变更 ${d.changed.length} · 移除 ${d.removed.length}` : '：无变化'}`);
  });
}
function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

/* 节点详情抽屉（运行侧） */
async function showRunDrawer(nodeId, run) {
  run = run || state.run;
  if (!run) return;
  const rec = run.nodes[nodeId] || {};
  const n = (state.def.nodes.find(x => x.id === nodeId)) || {};
  const attempts = rec.attempts && rec.attempts.length ? rec.attempts : [];
  const catOk = n.apiVersion ? await catalogOk(n.apiVersion) : '';
  // 节点间数据依赖：本节点引用了哪些上游输出、本节点输出被哪些下游引用
  const { upstream, downstream } = scanRefs(state.def, nodeId);
  const outVal = path => lookupPath(rec.output, String(path || '').replace(/^output\.?/, ''));
  $('#runDrawer').innerHTML = `
    <h4>${esc(n.name || nodeId)}<span style="flex:1"></span><span class="dot" style="background:${rec.status === 'done' || rec.status === 'reused' ? 'var(--ok)' : rec.status === 'running' ? 'var(--blue)' : rec.status === 'failed' ? 'var(--bad)' : 'var(--queue)'}"></span></h4>
    <div class="note">节点 ${nodeId} ｜ run #${run.num} ｜ ${rec.reused ? '复用产物（重放）' : rec.status || ''}　<button class="btn" id="btnBackResult" style="padding:1px 9px;font-size:12px">◀ 运行结果</button></div>
    <div class="kv">
      ${rec.httpStatus ? `<b>状态</b><span style="color:${rec.httpStatus === 200 || rec.status === 'done' ? 'var(--ok)' : 'var(--bad)'}">${rec.httpStatus === 200 ? '200 OK' : rec.httpStatus}</span>` : ''}
      ${rec.ms != null ? `<b>耗时</b><span>${rec.ms} ms</span>` : ''}
      ${n.config && n.config.url ? `<b>URL</b><span style="font-family:Menlo,monospace;font-size:11px">${esc(n.config.url.replace(/^https?:\/\/[^/]+/, ''))}</span>` : ''}
      ${n.apiVersion ? `<b>API 版本</b><span>${esc(n.apiVersion)} ${catOk}</span>` : ''}
      ${n.idempotencyKey ? `<b>幂等键</b><span style="font-family:Menlo,monospace;font-size:11px">${esc(n.idempotencyKey)}</span>` : ''}
    </div>
    ${(upstream.length || downstream.length) ? `<b style="font-size:12px;color:var(--muted);display:block;margin-top:10px">数据流动 · 依赖关系</b>
    <div class="deps">
      ${upstream.map(u => { const v = lookupPath((run.nodes[u.from] || {}).output, u.path.replace(/^output\.?/, '')); return `<div class="dep-row" title="点击查看来源节点"><b>← ${esc(u.from)}</b><span><code>${esc(u.expr)}</code>${v !== undefined ? ` = <span class="num">${esc(JSON.stringify(v)).slice(0, 60)}</span>` : ' <span class="note">（运行时取值）</span>'}</span></div>`; }).join('')}
      ${downstream.map(d => `<div class="dep-row" title="本节点输出被下游引用"><b>→ ${esc(d.node)}</b><span><code>${esc(d.expr)}</code></span></div>`).join('')}
    </div>
    <p class="note" style="margin:5px 0 0">← 表示本节点引用的上游输出；→ 表示本节点输出被下游引用的字段。</p>` : ''}
    ${attempts.length ? `<b style="font-size:12px;color:var(--muted)">重试记录（${attempts.length} 次）</b>
      <table style="font-size:11px;margin:6px 0"><thead><tr><th>#</th><th>状态</th><th>耗时</th><th>结果</th></tr></thead>
      <tbody>${attempts.map(a => `<tr><td>${a.n}</td><td>${a.status || '-'}</td><td>${a.ms}ms</td><td style="color:${a.ok ? 'var(--ok)' : 'var(--bad)'}">${a.ok ? '成功' : esc(a.error || 'HTTP ' + a.status)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${rec.output ? `<b style="font-size:12px;color:var(--muted)">本节点输出（完整响应）</b><div class="code result-json" style="max-height:320px">${hlJson(rec.output)}</div>` : rec.error ? `<b style="font-size:12px;color:var(--muted)">错误</b><div class="code" style="background:var(--bad-bg);color:var(--bad)">${esc(rec.error)}</div>` : ''}
    <div class="btns">
      <button class="btn primary" id="btnReplay">↻ 从此节点重放</button>
      ${rec.output ? '<button class="btn" id="btnRaw">原始 payload</button>' : ''}
    </div>
    <p class="note" style="margin-top:10px">重放将复用上游已存产物，仅重新执行本节点及下游。</p>`;
  $('#btnBackResult').onclick = () => showRunResult(run);
  $('#btnReplay').onclick = async () => {
    try {
      const r = await api(`/api/runs/${run.id}/replay`, { method: 'POST', body: JSON.stringify({ fromNode: nodeId }) });
      $('#runHist').value = '';
      $('#runPill').textContent = `重放已启动 → ${r.runId}`;
      setTimeout(() => loadRun(r.runId).then(() => {}), 300);
    } catch (e) { alert('重放失败：' + e.message); }
  };
  if ($('#btnRaw')) $('#btnRaw').onclick = () => alert(JSON.stringify(rec.output, null, 1));
}
let _catalogVersion = null;
async function catalogOk(bound) {
  if (!_catalogVersion) { try { _catalogVersion = (await api('/api/catalog')).version; } catch { return ''; } }
  return _catalogVersion === bound ? '✓ 未变更' : `⚠ 目录已升级到 ${_catalogVersion}`;
}

/* 运行对比 */
async function showDiff(aId, bId) {
  const r = await api(`/api/runs/${aId}/diff/${bId}`);
  $('#diffBody').innerHTML = `
    <p class="note">对比 run #${r.a.num}（v${r.a.version}） ←→ run #${r.b.num}（v${r.b.version}）</p>
    <table><thead><tr><th>节点</th><th>A 状态</th><th>B 状态</th><th>输出变化</th><th>耗时 A/B</th></tr></thead>
    <tbody>${r.diff.map(d => `<tr class="${d.statusChanged || d.outputChanged ? 'diff-changed' : ''}">
      <td><b>${esc(d.node)}</b></td><td>${esc(d.statusA)}</td><td>${esc(d.statusB)}</td>
      <td>${d.outputChanged ? '⚠ 有变化' : '一致'}</td><td>${d.msA ?? '-'} / ${d.msB ?? '-'} ms</td></tr>`).join('')}</tbody></table>
    <p class="note" style="margin-top:8px">黄色行表示状态或输出存在差异（接口升级后的典型信号）。</p>`;
  $('#diffModal').classList.remove('hidden');
}
$('#btnCmp').onclick = () => {
  const a = $('#cmpA').value, b = $('#cmpB').value;
  if (!a || !b) return alert('请先在工具栏选择两个要对比的 run');
  showDiff(a, b);
};
$('#btnRun').onclick = async () => {
  const flowId = $('#runFlowSel').value;
  if (!flowId) return alert('请选择流程');
  try {
    const r = await api(`/api/flows/${flowId}/run`, { method: 'POST', body: '{}' });
    state.run = { id: r.runId, num: '?', nodes: {}, events: [] };
    state.liveRun = state.run;
    $('#runPill').textContent = '已触发 · 等待事件流…';
    setTimeout(() => loadRun(r.runId), 1200);
  } catch (e) { alert('运行失败：' + e.message); }
};

/* ───────── 界面 2：接口注册表（把 API 接入智能体） ───────── */
let _srcMode = 'url';
const SRC_TITLE = { url: '接入 OpenAPI 地址', text: '粘贴接口文档', manual: '手工添加接口' };
const SRC_TYPE = { url: 'OpenAPI 地址', text: '粘贴文档', manual: '手工添加', sdk: 'SDK 源码' };
const fmtClock = ts => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtAgo = ts => {
  if (!ts) return '未同步';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return fmtClock(ts);
};

async function loadApi() {
  try {
    const [src, cat, credData] = await Promise.all([
      api('/api/sources'), api('/api/catalog'), api('/api/creds').catch(() => null),
    ]);
    state.sources = src.items; state.catalog = cat;
    state.hiddenOps = src.hidden || [];
    if (credData) { state.creds = credData.items; state.opBindings = credData.opBindings || {}; }
    renderApi(src, cat);
    renderCreds();
    loadDocs();                       // 手册列表与「搭建器」里的篇数一起刷新
  } catch (e) {
    $('#srcList').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}
function renderApi(src, cat) {
  state.srcSel = new Set([...state.srcSel].filter(id => src.items.some(s => s.id === id)));   // 清掉已不存在的勾选
  const builtin = cat.operations.filter(o => o.sourceId === 'builtin').length;
  $('#apiStats').innerHTML = [
    [cat.operations.length, '智能体可用接口'],
    [src.items.length, '外部来源'],
    [builtin, '内置示例接口'],
    [cat.version, '目录版本'],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('');

  $('#srcList').innerHTML = src.items.length ? src.items.map(s => {
    const meta = s.sdk || null;
    const pip = (meta && meta.pip) || null;
    const arc = (meta && meta.archive) || null;
    const mat = s.materials || null;
    const as = s.autoSync || null;
    const remote = pip ? `pip install ${pip.spec}` : ((as && as.remote) || s.url || null);
    const diff = as && as.lastDiff;
    const syncLine = as && as.enabled
      ? `<span class="dot-on"></span>自动同步 · 每 ${Math.round((as.intervalMs || 300000) / 60000)} 分钟 · 上次 ${fmtAgo(as.lastAt)}`
        + (as.lastStatus === 'error' ? ` · <span class="bad">失败：${esc(as.lastError || '')}</span>`
          : diff ? ` · ${diff.added + diff.changed + diff.removed ? `+${diff.added} ~${diff.changed} -${diff.removed}` : '无变化'}` : '')
      : `<span class="dot-off"></span>手动同步 · 上次 ${fmtAgo(s.updatedAt)}`;
    return `
    <div class="srccard${state.srcSel.has(s.id) ? ' sel' : ''}" data-src-card="${s.id}">
      <div class="h">
        <input type="checkbox" data-src="${s.id}" ${state.srcSel.has(s.id) ? 'checked' : ''} title="勾选后可批量卸载" aria-label="选择 ${esc(s.name)}">
        ${esc(s.name)}<span style="flex:1"></span><span class="vtag">${esc(s.specVersion)}</span>
      </div>
      <div class="m">
        ${pip ? `<span class="fmtchip pip">pip</span>` : arc ? `<span class="fmtchip arc">压缩包</span>` : meta ? `<span class="fmtchip">SDK · ${esc(meta.formatName || '')}</span>` : ''}${esc(pip ? 'PyPI 安装' : arc ? '本地包导入' : (SRC_TYPE[s.type] || s.type))}
        · ${s.count ? `${s.count} 个接口` : `<span title="基础库 / 框架包没有业务接口，只收录类与函数供智能体引用">仅资料（无业务接口）</span>`}${meta ? ` · ${(pip && pip.stats ? pip.stats.selected : meta.files.length)} 个源码文件` : ''}
      </div>
      ${arc ? `<div class="m" style="color:var(--muted)" title="${esc(arc.name)}">${esc(arc.name)} · ${fmtBytes(arc.bytes)} · 解压 ${arc.entries || 0} 个文件，取 ${arc.selected || 0} 个源码</div>` : ''}
      ${remote ? `<div class="m" title="${esc(remote)}"><span class="${pip ? 'srccmd' : ''}">${esc(remote.length > 52 ? remote.slice(0, 52) + '…' : remote)}</span></div>` : ''}
      ${pip && pip.pkg && pip.pkg.summary ? `<div class="m" style="color:var(--muted)">${esc(pip.pkg.summary.slice(0, 90))}</div>` : ''}
      ${meta ? `<div class="m">源码指纹 <span class="hashchip" title="${esc(meta.digest || '')}">${esc(String(meta.digest || '').slice(0, 8))}</span></div>` : ''}
      ${mat ? `<div class="m">资料 <b>${mat.count}</b> 条 · ${mat.classes} 个类 · ${mat.methods + mat.functions} 个函数/方法${mat.documented ? ` · ${mat.documented} 条带说明` : ''}</div>` : ''}
      <div class="m syncrow">${syncLine}</div>
      <div class="acts">
        <button class="btn" onclick="refreshSource('${s.id}')">${remote ? '立即同步' : '重新解析'}</button>
        ${remote ? `<button class="btn" onclick="toggleAutoSync('${s.id}', ${as && as.enabled ? 'false' : 'true'})">${as && as.enabled ? '关闭自动同步' : '开启自动同步'}</button>` : ''}
        ${mat ? `<button class="btn" onclick="openMaterials('${s.id}')">📚 资料</button>` : ''}
        <button class="btn danger" onclick="removeSource('${s.id}')">卸载</button>
      </div>
    </div>`;
  }).join('')
    : '<div class="empty">还没有接入外部接口。点右上角「接入 OpenAPI 地址」或「⇱ 导入 SDK」，把接口接进来 —— 智能体下一轮对话就能用这些接口生成流程。</div>';
  syncSrcBar();

  renderOps(cat.operations, src.items);
  $('#opCount').textContent = `共 ${cat.operations.length} 个`;
  $('#catalogBadge').textContent = `注册表 · ${cat.version} · ${cat.operations.length} 个接口`;
  _catalogVersion = cat.version;
  if ($('#chatApiCount')) $('#chatApiCount').textContent = cat.operations.length;
}
function renderOps(ops, sources) {
  const kw = (($('#opFilter') && $('#opFilter').value) || '').trim().toLowerCase();
  const srcName = new Map((sources || []).map(s => [s.id, s.name]));
  const list = ops.filter(o => !kw || [o.id, o.name, o.path, o.description || '', ...(o.keywords || [])].join(' ').toLowerCase().includes(kw));
  state.opVisible = list.map(o => o.id);
  state.opSel = new Set([...state.opSel].filter(id => ops.some(o => o.id === id)));   // 清掉已被删掉的勾选
  const authSel = o => {
    const bound = (state.opBindings || {})[o.id];
    return `<td><select class="sel" style="max-width:140px;padding:2px 6px;font-size:11px" title="绑定后运行该接口时自动注入 AK/SK 认证头" onchange="bindOpAuth('${esc(o.id)}', this.value)">
      <option value="" ${!bound ? 'selected' : ''}>无认证</option>
      ${(state.creds || []).map(c => `<option value="${c.id}" ${bound === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select></td>`;
  };
  $('#opRows').innerHTML = list.map(o => `<tr class="${state.opSel.has(o.id) ? 'sel' : ''}">
    <td class="ck"><input type="checkbox" data-op="${esc(o.id)}" ${state.opSel.has(o.id) ? 'checked' : ''} title="勾选后可批量删除" aria-label="选择 ${esc(o.name)}"></td>
    <td><b>${esc(o.name)}</b><div class="note">${esc(o.id)}</div></td>
    <td><span class="mtag m-${o.method.toLowerCase()}">${o.method}</span></td>
    <td class="mono">${esc(o.path)}</td>
    <td><span class="vtag">${esc(o.version)}</span></td>
    <td>${o.hash ? `<span class="hashchip" title="${o.hash}">${o.hash.slice(0, 8)}</span>` : '<span class="note">—</span>'}</td>
    <td>${o.readOnly ? '<span class="srctag">只读</span>' : '<span class="gate wait">写操作</span>'}</td>
    ${authSel(o)}
    <td class="note">${o.sourceId === 'builtin' ? '内置' : esc(srcName.get(o.sourceId) || o.sourceId)}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="note">没有匹配的接口</td></tr>';
  syncOpBar();
}
async function bindOpAuth(operationId, credId) {
  try {
    await api('/api/creds/bind-op', { method: 'POST', body: JSON.stringify({ operationId, credId: credId || null }) });
    if (credId) state.opBindings[operationId] = credId; else delete state.opBindings[operationId];
    renderCreds();
  } catch (e) { alert('绑定失败：' + e.message); }
}
function openSrcModal(mode) {
  _srcMode = mode;
  $('#srcTitle').textContent = SRC_TITLE[mode];
  const tip = `<div class="form-tip">接入后立即写入工具注册表，智能体下一轮对话即可用；已发布流程不受影响（运行期按发布时绑定的版本执行）。</div>`;
  let body = '';
  if (mode === 'url') {
    body = tip + `
      <div class="form-row"><label>接口文档地址（返回 JSON）</label><input id="f-url" placeholder="https://api.example.com/openapi.json"></div>
      <div class="form-row"><label>来源名称（可选）</label><input id="f-name" placeholder="例如：订单中心"></div>
      <div class="note">没有现成文档？点这里填入示例：
        <a style="color:var(--purple);cursor:pointer" onclick="document.getElementById('f-url').value='http://127.0.0.1:3300/upstream/_specs/order-center.json'">order-center.json（3 个接口）</a></div>`;
  } else if (mode === 'text') {
    body = tip + `
      <div class="form-row"><label>OpenAPI / Swagger JSON 全文</label><textarea id="f-text" placeholder='{"openapi":"3.0.3","info":{"title":"我的服务","version":"1.0.0"},"paths":{...}}'></textarea></div>
      <div class="form-row"><label>来源名称（可选）</label><input id="f-name" placeholder="例如：订单中心"></div>`;
  } else {
    body = tip + `
      <div class="form-row"><label>接口名称</label><input id="f-name" placeholder="例如：查询客户档案"></div>
      <div style="display:flex;gap:10px">
        <div class="form-row" style="flex:0 0 120px"><label>方法</label><select id="f-method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></div>
        <div class="form-row" style="flex:1"><label>路径（可用 {orderNo} 占位）</label><input id="f-path" placeholder="/orders/{orderNo}"></div>
      </div>
      <div class="form-row"><label>服务地址（可选，默认沙箱上游）</label><input id="f-base" placeholder="http://127.0.0.1:3300/upstream/_sandbox"></div>
      <div class="form-row"><label>自然语言关键词（逗号分隔，供智能体匹配）</label><input id="f-kw" placeholder="客户,档案,查询"></div>
      <div class="form-row"><label>说明</label><input id="f-desc" placeholder="按客户号查询档案"></div>
      <div class="form-row"><label>请求体示例（JSON，可选）</label><textarea id="f-body" style="height:70px" placeholder='{"customerId":"C-001"}'></textarea></div>`;
  }
  $('#srcBody').innerHTML = body + `<div id="srcMsg"></div>
    <div class="modal-foot"><button class="btn" id="srcCancel">取消</button><button class="btn primary purple" id="srcSubmit">接入</button></div>`;
  $('#srcCancel').onclick = closeSrcModal;
  $('#srcSubmit').onclick = submitSource;
  $('#srcModal').classList.remove('hidden');
  const first = $('#srcBody').querySelector('input,textarea');
  if (first) first.focus();
}
function closeSrcModal() { $('#srcModal').classList.add('hidden'); }
function srcMsg(ok, text) { $('#srcMsg').innerHTML = `<div class="${ok ? 'msg-ok' : 'msg-bad'}">${esc(text)}</div>`; }
async function submitSource() {
  const btn = $('#srcSubmit');
  btn.disabled = true;
  try {
    let payload;
    if (_srcMode === 'manual') {
      payload = {
        mode: 'manual', name: $('#f-name').value.trim(), method: $('#f-method').value,
        path: $('#f-path').value.trim(), baseUrl: $('#f-base').value.trim(),
        keywords: $('#f-kw').value, description: $('#f-desc').value, bodyExample: $('#f-body').value.trim(),
      };
      if (!payload.path) throw new Error('请填写接口路径');
    } else if (_srcMode === 'text') {
      payload = { mode: 'text', text: $('#f-text').value, name: $('#f-name').value.trim() };
      if (!payload.text.trim()) throw new Error('请粘贴文档内容');
    } else {
      payload = { mode: 'url', url: $('#f-url').value.trim(), name: $('#f-name').value.trim() };
      if (!payload.url) throw new Error('请填写文档地址');
    }
    const r = await api('/api/sources', { method: 'POST', body: JSON.stringify(payload) });
    const brief = r.operations.slice(0, 3).map(o => `${o.method} ${o.path}`).join('、') + (r.added > 3 ? ` 等 ${r.added} 个` : '');
    srcMsg(true, `已接入 ${r.added} 个接口：${brief} ｜ 目录 ${r.catalogVersion} —— 切到「搭建器」即可用自然语言调用`);
    await loadApi();
    setTimeout(closeSrcModal, 1200);
  } catch (e) {
    srcMsg(false, e.message);
  } finally { btn.disabled = false; }
}
async function refreshSource(id) {
  try {
    const r = await api(`/api/sources/${id}/refresh`, { method: 'POST' });
    const parts = [r.added.length ? `新增 ${r.added.length}` : '', r.changed.length ? `变更 ${r.changed.length}` : '', r.removed.length ? `移除 ${r.removed.length}` : ''].filter(Boolean);
    await loadApi();
    const name = (state.sources.find(s => s.id === id) || {}).name || '来源';
    toast(parts.length ? `「${name}」已更新：${parts.join('，')} 个接口（目录 ${r.catalogVersion}）` : `「${name}」无变化，注册表未改动`);
  } catch (e) {
    if (/不存在/.test(e.message)) { await loadApi(); toast('该来源已不存在（可能已被删除），列表已刷新'); }
    else alert('同步失败：' + e.message);
  }
}
// 现网自动更新开关
async function toggleAutoSync(id, enabled) {
  try {
    await api(`/api/sources/${id}/autosync`, { method: 'POST', body: JSON.stringify({ enabled, intervalMs: 300000 }) });
    await loadApi();
    toast(enabled ? '已开启自动同步：每 5 分钟重新拉取并解析' : '已关闭自动同步');
  } catch (e) {
    if (/不存在/.test(e.message)) { await loadApi(); toast('该来源已不存在（可能已被删除），列表已刷新'); }
    else alert('切换自动同步失败：' + e.message);
  }
}
function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4200);
}
async function removeSource(id) {
  const s = state.sources.find(x => x.id === id);
  // 页面停留太久 / 另一处已删掉时，卡片还在但服务端已经没有了：不弹「卸载失败」，直接刷新列表
  if (!s) { await loadApi(); return toast('该来源已不存在（可能已被删除），列表已刷新'); }
  if (!confirm(`卸载「${s.name}」？\n\n该来源下的 ${s.count} 个接口将从智能体可用工具集中移除。已发布流程不受影响，但再次运行会失败。`)) return;
  const btn = document.querySelector(`[data-src-card="${id}"] .btn.danger`);
  if (btn) { btn.disabled = true; btn.textContent = '卸载中…'; }
  try {
    const r = await api(`/api/sources/${id}`, { method: 'DELETE' });
    state.srcSel.delete(id);
    await loadApi();
    if (r && r.alreadyGone) toast('该来源已不存在（可能已被删除），列表已刷新');
    else toast(`已卸载「${s.name}」：${s.count} 个接口已移出工具集`);
  } catch (e) {
    if (/不存在/.test(e.message)) { await loadApi(); toast('该来源已不存在（可能已被删除），列表已刷新'); }
    else {
      if (btn) { btn.disabled = false; btn.textContent = '卸载'; }
      alert('卸载失败：' + e.message);
    }
  }
}
/* ───────── 帮助手册：公网文档 / 本地文件 → 搭建器的解析依据 ───────── */
const DOC_KIND = { url: 'URL 抓取', file: '导入文件', text: '粘贴正文' };
const DOC_FMT = { html: 'HTML', markdown: 'Markdown', pdf: 'PDF', docx: 'Word', doc: 'Word', text: '文本', txt: '文本', json: 'JSON' };

async function loadDocs() {
  try {
    const r = await api('/api/docs');
    state.docs = r.items || [];
    state.docStats = r.stats || { docs: 0, chunks: 0, chars: 0 };
    renderDocs();
    if ($('#chatDocCount')) $('#chatDocCount').textContent = state.docStats.docs;
  } catch (e) {
    if ($('#docList')) $('#docList').innerHTML = `<div class="empty">手册加载失败：${esc(e.message)}</div>`;
  }
}
function renderDocs() {
  const el = $('#docList');
  if (!el) return;
  const docs = state.docs || [];
  if ($('#docCount')) {
    $('#docCount').textContent = docs.length
      ? `共 ${docs.length} 篇 · ${state.docStats.chunks} 个章节 · ${(state.docStats.chars / 1000).toFixed(1)}k 字`
      : '';
  }
  if (!docs.length) {
    el.innerHTML = '<div class="empty">还没有接入手册。帮助手册不会变成可调接口，它只在搭建器里当「依据」：'
      + '把你常看的 API 文档（公网页面 / PDF / Word / Markdown）接进来，描述需求时智能体能对上手册里的说法，并给出引用。</div>';
    return;
  }
  el.innerHTML = docs.map(d => `
    <div class="srccard doccard" data-doc-card="${d.id}">
      <div class="h"><span class="fmtchip ${d.kind === 'url' ? 'pip' : 'arc'}">${DOC_KIND[d.kind] || d.kind}</span>${esc(d.name)}</div>
      <div class="m">${esc(DOC_FMT[d.format] || d.format || '')} · ${d.chunks} 个章节 · ${d.sections} 节 · ${(d.chars / 1000).toFixed(1)}k 字</div>
      ${d.url ? `<div class="m" title="${esc(d.url)}"><span class="srccmd">${esc(d.url.length > 46 ? d.url.slice(0, 46) + '…' : d.url)}</span></div>` : ''}
      ${d.filename ? `<div class="m">${esc(d.filename)}</div>` : ''}
      ${d.note ? `<div class="m" style="color:var(--muted)">${esc(d.note)}</div>` : ''}
      <div class="m" style="color:var(--muted)">更新于 ${fmtAgo(d.updatedAt)}</div>
      <div class="acts">
        <button class="btn" onclick="openDocPreview('${d.id}')">📖 章节</button>
        ${d.url ? `<button class="btn" onclick="refreshDoc('${d.id}')">立即重抓</button>` : ''}
        <button class="btn danger" onclick="removeDoc('${d.id}')">删除</button>
      </div>
    </div>`).join('');
}

let _docMode = 'url';
function openDocModal(mode) {
  _docMode = mode || 'url';
  $('#docTitle').textContent = _docMode === 'url' ? '通过 URL 抓取手册' : '导入手册';
  const tip = `<div class="form-tip">手册不会注册成可调接口 —— 它只是搭建器的「依据」：解析描述时用来对上接口说法、补全没说全的接口名，并在对话里给出引用。</div>`;
  const body = _docMode === 'url' ? `
      <div class="form-row"><label>帮助手册地址</label><input id="f-doc-url" placeholder="https://ecloud.10086.cn/op-help-center/api/..."></div>
      <div class="form-row"><label>手册名称（可选，默认取页面标题）</label><input id="f-doc-name" placeholder="例如：云监控 API 帮助手册"></div>
      <div class="form-row" style="flex-direction:row;align-items:center;gap:8px">
        <label style="margin:0">同时抓取目录里同站点的子页面</label>
        <input id="f-doc-pages" type="number" min="1" max="40" value="12" style="width:88px">
        <span class="note">页（手册一般按章节分页，只抓首页会缺内容）</span>
      </div>
      <div class="note">抓取需要 5～20 秒。前端渲染的页面（正文靠 JS 生成）抓不到，可改用「导入文档 → 粘贴正文」。</div>`
    : `
      <div class="form-row"><label>选择文件（.md / .txt / .html / .pdf / .docx / .doc / .json）</label>
        <input id="f-doc-file" type="file" accept=".md,.markdown,.txt,.html,.htm,.pdf,.docx,.doc,.rtf,.json,.yaml,.yml" style="padding:6px"></div>
      <div class="form-row"><label>手册名称（可选，默认用文件名）</label><input id="f-doc-name" placeholder="例如：云监控 API 帮助手册"></div>
      <div class="form-row"><label>或者直接粘贴正文（前端渲染的页面用这个）</label>
        <textarea id="f-doc-text" style="height:130px" placeholder="把帮助页面里「接口说明 / 参数表」那段正文复制过来即可"></textarea></div>`;
  $('#docBody').innerHTML = tip + body + `<div id="docMsg"></div>
    <div class="modal-foot"><button class="btn" id="docCancel">取消</button><button class="btn primary purple" id="docSubmit">${_docMode === 'url' ? '开始抓取' : '导 入'}</button></div>`;
  $('#docCancel').onclick = closeDocModal;
  $('#docSubmit').onclick = submitDoc;
  $('#docModal').classList.remove('hidden');
  const first = $('#docBody').querySelector('input:not([type=number]),textarea');
  if (first) first.focus();
}
function closeDocModal() { $('#docModal').classList.add('hidden'); }
function docMsg(ok, text) { $('#docMsg').innerHTML = `<div class="${ok ? 'msg-ok' : 'msg-bad'}">${esc(text)}</div>`; }

async function submitDoc() {
  const btn = $('#docSubmit');
  btn.disabled = true;
  const busy = _docMode === 'url' ? '抓取中…（多页手册需要十几秒）' : '导入中…';
  btn.textContent = busy;
  try {
    let r;
    if (_docMode === 'url') {
      const url = $('#f-doc-url').value.trim();
      if (!url) throw new Error('请填写手册地址');
      r = await api('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ mode: 'url', url, name: $('#f-doc-name').value.trim(), maxPages: Number($('#f-doc-pages').value) || 12 }),
      });
    } else {
      const file = $('#f-doc-file') && $('#f-doc-file').files[0];
      const text = ($('#f-doc-text') && $('#f-doc-text').value || '').trim();
      const name = $('#f-doc-name').value.trim();
      if (file) {
        const res = await fetch(`/api/docs/upload?name=${encodeURIComponent(file.name)}&title=${encodeURIComponent(name)}`, {
          method: 'POST', headers: { ...authHeaders() }, body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `上传失败（${res.status}）`);
        r = data;
      } else if (text) {
        r = await api('/api/docs', { method: 'POST', body: JSON.stringify({ mode: 'text', text, name }) });
      } else {
        throw new Error('请选择文件，或把正文粘贴进来');
      }
    }
    docMsg(true, `已收录《${r.doc.name}》：${r.doc.chunks} 个章节、${(r.doc.chars / 1000).toFixed(1)}k 字 —— 切到「搭建器」描述需求时就会用上它`);
    if ($('#docSubmit')) $('#docSubmit').textContent = '完成';
    await loadDocs();
    setTimeout(closeDocModal, 1400);
  } catch (e) {
    docMsg(false, e.message);
    if (btn.isConnected) { btn.disabled = false; btn.textContent = _docMode === 'url' ? '开始抓取' : '导 入'; }
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

async function refreshDoc(id) {
  const d = (state.docs || []).find(x => x.id === id);
  try {
    const r = await api(`/api/docs/${id}/refresh`, { method: 'POST' });
    await loadDocs();
    toast(`《${r.doc.name}》已重新抓取：${r.doc.chunks} 个章节`);
  } catch (e) {
    toast(`重抓失败：${e.message}`, 'bad');
    if (d) await loadDocs();
  }
}
async function removeDoc(id) {
  const d = (state.docs || []).find(x => x.id === id);
  if (!d) { await loadDocs(); return; }
  if (!confirm(`删除手册「${d.name}」？\n\n只影响搭建器里的引用依据，不影响任何接口与流程。`)) return;
  try {
    await api(`/api/docs/${id}`, { method: 'DELETE' });
    await loadDocs();
    toast(`已删除手册「${d.name}」`);
  } catch (e) { alert('删除失败：' + e.message); }
}

async function openDocPreview(id, q = '') {
  try {
    const r = await api(`/api/docs/${id}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const d = r.doc;
    $('#docViewTitle').textContent = d.name;
    $('#docViewBody').innerHTML = `
      <div class="note" style="margin-bottom:8px">${esc(DOC_KIND[d.kind] || '')} · ${d.chunks} 个章节 · ${(d.chars / 1000).toFixed(1)}k 字
        ${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noreferrer" style="color:var(--purple)">打开原始页面</a>` : ''}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input id="docViewQ" placeholder="在这篇手册里检索（如：告警趋势 / 参数）" value="${esc(q)}" style="flex:1">
        <button class="btn" id="docViewGo">检索</button>
      </div>
      <div id="docViewList">${(r.items || []).map(c => `
        <div class="docsec">
          <div class="docsec-h">${esc(c.title)}<span class="note" style="margin-left:8px">${esc(c.path)}</span></div>
          <div class="docsec-t">${esc(c.text)}</div>
        </div>`).join('') || '<div class="empty">没有匹配的章节</div>'}</div>
      <div class="note" style="margin-top:8px">共 ${r.total} 条${q ? `（检索「${esc(q)}」）` : ''}</div>`;
    $('#docView').classList.remove('hidden');
    const go = async () => { const v = $('#docViewQ').value.trim(); await openDocPreview(id, v); };
    $('#docViewGo').onclick = go;
    $('#docViewQ').onkeydown = e => { if (e.key === 'Enter') go(); };
  } catch (e) { alert('读取失败：' + e.message); }
}

/* ── 接口来源：批量勾选 / 批量卸载 ── */
function syncSrcBar() {
  const n = state.srcSel.size;
  const total = (state.sources || []).length;
  const btn = $('#btnSrcBatchDel');
  if (btn) { btn.disabled = !n; btn.textContent = n ? `✕ 卸载 ${n} 个来源` : '✕ 批量卸载'; }
  if ($('#srcSelInfo')) $('#srcSelInfo').textContent = n ? `已选 ${n} / ${total}` : '';
  const all = $('#srcAll');
  if (all) { all.checked = n > 0 && n === total; all.indeterminate = n > 0 && n < total; }
}
document.getElementById('srcList').addEventListener('change', e => {
  const ck = e.target.closest('input[data-src]');
  if (!ck) return;
  const id = ck.dataset.src;
  if (ck.checked) state.srcSel.add(id); else state.srcSel.delete(id);
  const card = ck.closest('.srccard');
  if (card) card.classList.toggle('sel', ck.checked);
  syncSrcBar();
});
$('#srcAll').onchange = () => {
  const on = $('#srcAll').checked;
  state.srcSel.clear();
  if (on) (state.sources || []).forEach(s => state.srcSel.add(s.id));
  document.querySelectorAll('#srcList input[data-src]').forEach(ck => { ck.checked = on; ck.closest('.srccard').classList.toggle('sel', on); });
  syncSrcBar();
};
$('#btnSrcBatchDel').onclick = async () => {
  const ids = [...state.srcSel];
  if (!ids.length) return;
  const picked = (state.sources || []).filter(s => ids.includes(s.id));
  const opTotal = picked.reduce((a, s) => a + (s.count || 0), 0);
  const names = picked.slice(0, 5).map(s => `「${s.name}」`).join('、') + (picked.length > 5 ? ` 等 ${picked.length} 个` : '');
  if (!confirm(`确认卸载 ${ids.length} 个接口来源？\n\n${names}\n\n其下共 ${opTotal} 个接口将从智能体可用工具集中移除。已发布流程不受影响，但再次运行依赖这些接口的流程会失败。`)) return;
  const btn = $('#btnSrcBatchDel');
  btn.disabled = true; btn.textContent = '卸载中…';
  try {
    const r = await api('/api/sources/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    state.srcSel.clear();
    if (r.missing && r.missing.length) alert(`已卸载 ${r.deletedCount} 个，${r.missing.length} 个不存在（可能已被删除）`);
    await loadApi();
  } catch (e) {
    alert('批量卸载失败：' + e.message);
    syncSrcBar();
  }
};
const _opFilter = document.getElementById('opFilter');
if (_opFilter) _opFilter.oninput = () => { if (state.catalog) renderOps(state.catalog.operations, state.sources); };

/* ── 接口注册表：批量勾选 / 批量删除 / 恢复隐藏 ── */
function syncOpBar() {
  const n = state.opSel.size, vis = state.opVisible.length;
  const btn = $('#btnOpBatchDel');
  if (btn) { btn.disabled = !n; btn.textContent = n ? `✕ 删除 ${n} 个接口` : '✕ 批量删除'; }
  const info = $('#opSelInfo');
  if (info && !info.dataset.keep) info.textContent = n ? `已选 ${n} / ${vis}` : '';
  const all = $('#opAll');
  if (all) {
    const picked = state.opVisible.filter(id => state.opSel.has(id)).length;
    all.checked = vis > 0 && picked === vis;
    all.indeterminate = picked > 0 && picked < vis;
  }
  const hb = state.hiddenOps || [];
  const rb = $('#btnOpsRestore');
  if (rb) {
    rb.style.display = hb.length ? '' : 'none';
    rb.textContent = `↺ 恢复隐藏接口（${hb.length}）`;
    rb.title = `已删除的内置接口：${hb.join('、')}`;
  }
}
function opFlash(html) {          // 删除/恢复后的轻量反馈（下次勾选时自动清空）
  const info = $('#opSelInfo');
  if (!info) return;
  info.innerHTML = html;
  info.dataset.keep = '1';
  setTimeout(() => { delete info.dataset.keep; syncOpBar(); }, 6000);
}
$('#opRows').addEventListener('change', e => {
  const ck = e.target.closest('input[data-op]');
  if (!ck) return;
  const id = ck.dataset.op;
  if (ck.checked) state.opSel.add(id); else state.opSel.delete(id);
  const row = ck.closest('tr');
  if (row) row.classList.toggle('sel', ck.checked);
  const info = $('#opSelInfo'); if (info) delete info.dataset.keep;
  syncOpBar();
});
$('#opAll').onchange = () => {
  const on = $('#opAll').checked;
  state.opVisible.forEach(id => { if (on) state.opSel.add(id); else state.opSel.delete(id); });
  document.querySelectorAll('#opRows input[data-op]').forEach(ck => {
    ck.checked = on;
    const row = ck.closest('tr');
    if (row) row.classList.toggle('sel', on);
  });
  const info = $('#opSelInfo'); if (info) delete info.dataset.keep;
  syncOpBar();
};
$('#btnOpBatchDel').onclick = async () => {
  const ids = [...state.opSel];
  if (!ids.length) return;
  const btn = $('#btnOpBatchDel');
  let pv;
  try {
    pv = await api('/api/ops/batch-delete', { method: 'POST', body: JSON.stringify({ ids, preview: true }) });
  } catch (e) { return alert('删除前检查失败：' + e.message); }

  const lines = [];
  if (pv.builtin.length) lines.push(`· 内置接口 ${pv.builtin.length} 个（删除后从注册表隐藏，可用「恢复隐藏接口」找回）`);
  if (pv.fromSources.length) lines.push(`· 来源接口 ${pv.fromSources.length} 个（从所属来源中移除）`);
  if (pv.sourcesEmptied.length) lines.push(`· ${pv.sourcesEmptied.length} 个来源会被删空，一并移除`);
  if (pv.missing.length) lines.push(`· ${pv.missing.length} 个接口已不存在，将跳过`);
  let msg = `确认删除 ${pv.total} 个接口？\n\n${lines.join('\n')}`;
  if (pv.affected.length) {
    // 同名流程（反复搭草稿留下的）按「名称 + 状态」合并，避免确认文案被同类条目刷屏
    const groups = new Map();
    for (const f of pv.affected) {
      const k = `${f.name}|${f.published ? 'pub' : 'draft'}`;
      const g = groups.get(k) || { name: f.name, published: f.published, version: f.version, count: 0, nodes: new Set() };
      g.count++; f.nodes.forEach(n => g.nodes.add(n));
      groups.set(k, g);
    }
    const list = [...groups.values()];
    msg += `\n\n⚠ 以下 ${pv.affected.length} 个流程引用了这些接口，删除后再运行会失败：\n`;
    msg += list.slice(0, 5).map(g =>
      `· ${g.name}${g.published ? ` v${g.version}` : '（草稿）'}${g.count > 1 ? ` ×${g.count}` : ''}：${[...g.nodes].slice(0, 3).join('、')}`).join('\n');
    if (list.length > 5) msg += `\n… 共 ${pv.affected.length} 个流程`;
  }
  msg += '\n\n历史运行记录与已发布版本的接口绑定不受影响。';
  if (!confirm(msg)) return;

  btn.disabled = true; btn.textContent = '删除中…';
  try {
    const r = await api('/api/ops/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    state.opSel.clear();
    await loadApi();
    const parts = [`已删除 ${r.deleted.length} 个接口`];
    if (r.hidden) parts.push(`${r.hidden} 个内置接口已隐藏`);
    if (r.removedSources.length) parts.push(`移除 ${r.removedSources.length} 个空来源`);
    if (r.unboundCreds) parts.push(`解绑 ${r.unboundCreds} 个凭证`);
    if (r.missing.length) parts.push(`${r.missing.length} 个已不存在`);
    opFlash(`<span style="color:var(--ok)">✓ ${esc(parts.join('，'))}</span>`);
  } catch (e) {
    alert('批量删除失败：' + e.message);
    syncOpBar();
  }
};
$('#btnOpsRestore').onclick = async () => {
  const hb = state.hiddenOps || [];
  if (!hb.length) return;
  if (!confirm(`恢复 ${hb.length} 个被删除的内置接口？\n\n${hb.join('、')}\n\n恢复后它们立即回到智能体可用工具集。`)) return;
  const btn = $('#btnOpsRestore');
  btn.disabled = true;
  try {
    const r = await api('/api/ops/restore', { method: 'POST', body: '{}' });
    await loadApi();
    opFlash(`<span style="color:var(--ok)">✓ 已恢复 ${r.restored} 个接口</span>`);
  } catch (e) { alert('恢复失败：' + e.message); }
  finally { btn.disabled = false; }
};

/* ───────── 认证凭证（AK / SK）───────── */
async function loadCreds() {
  const d = await api('/api/creds');
  state.creds = d.items; state.opBindings = d.opBindings || {};
  renderCreds();
}
function renderCreds() {
  if (!$('#credList')) return;
  $('#credCount').textContent = state.creds.length ? `共 ${state.creds.length} 个` : '';
  const boundCount = cid => Object.values(state.opBindings || {}).filter(id => id === cid).length;
  $('#credList').innerHTML = state.creds.length ? state.creds.map(c => `
    <div class="srccard">
      <div class="h">${esc(c.name)}<span style="flex:1"></span><span class="vtag">${credModeLabel(c.mode)}</span></div>
      <div class="m">AK：${esc(c.ak)}</div>
      <div class="m">SK：${esc(c.sk)}（已掩码）</div>
      <div class="m">已绑定 ${boundCount(c.id)} 个接口 · 创建于 ${new Date(c.createdAt).toLocaleString('zh-CN')}</div>
      <div class="acts">
        <select class="sel mode-sel" title="切换签名模式：调用移动云接口须选「移动云 V2.0 签名」（认证参数放 query），选错会报 AccessKey missing"
          onchange="updateCredMode('${c.id}', this.value)">
          <option value="hmac" ${c.mode === 'hmac' ? 'selected' : ''}>HMAC 签名</option>
          <option value="header" ${c.mode === 'header' ? 'selected' : ''}>头直传</option>
          <option value="ecloud" ${c.mode === 'ecloud' ? 'selected' : ''}>移动云 V2.0 签名</option>
        </select>
        <button class="btn" onclick="removeCred('${c.id}')">删除</button>
      </div>
    </div>`).join('')
    : '<div class="empty">还没有凭证。新建后可绑定到单个接口，或设为某个流程的流程级认证 —— 受保护接口（如「受保护数据」）未认证时返回 401。</div>';
}
function openCredModal() {
  $('#credBody').innerHTML = `
    <div class="form-tip">三种模式：<b>HMAC 签名</b>——请求头带 AK + 时间戳 + HMAC-SHA256 签名（SK 不出网，推荐，适合平台自有受保护接口）；<b>头直传</b>——AK/SK 直接放请求头（简单但 SK 暴露在头里，仅限内网）；<b>移动云 V2.0 签名</b>——与移动云 OpenAPI 官方网关对齐的 AK/SK 签名（认证参数放 query），调用 ecloud 接口选这个。</div>
    <div class="form-row"><label>凭证名称</label><input id="c-name" placeholder="例如：生产网关凭证"></div>
    <div class="form-row"><label>AK（留空自动生成）</label><input id="c-ak" placeholder="AKxxxxxxxx"></div>
    <div class="form-row"><label>SK（留空自动生成，至少 16 位）</label><input id="c-sk" type="password" placeholder="留空自动生成"></div>
    <div class="form-row"><label>模式</label><select id="c-mode"><option value="hmac">HMAC 签名（推荐）</option><option value="header">头直传</option><option value="ecloud">移动云 V2.0 签名</option></select></div>
    <div id="credMsg"></div>
    <div class="modal-foot"><button class="btn" id="credCancel">取消</button><button class="btn primary" id="credSubmit">创建凭证</button></div>`;
  $('#credCancel').onclick = () => $('#credModal').classList.add('hidden');
  $('#credSubmit').onclick = submitCred;
  $('#credModal').classList.remove('hidden');
  $('#c-name').focus();
}
async function submitCred() {
  const btn = $('#credSubmit');
  btn.disabled = true;
  try {
    const r = await api('/api/creds', {
      method: 'POST',
      body: JSON.stringify({ name: $('#c-name').value.trim(), ak: $('#c-ak').value.trim(), sk: $('#c-sk').value, mode: $('#c-mode').value }),
    });
    $('#credMsg').innerHTML = `<div class="msg-ok">凭证「${esc(r.cred.name)}」已创建。SK 仅此一次完整显示，请立即保存：<br><b style="font-family:Menlo,monospace;word-break:break-all">${esc(r.skOnce)}</b></div>`;
    $('#credSubmit').textContent = '已创建';
    await loadCreds();
    setTimeout(() => $('#credModal').classList.add('hidden'), 2600);
  } catch (e) {
    $('#credMsg').innerHTML = `<div class="msg-bad">${esc(e.message)}</div>`;
    btn.disabled = false;
  }
}
async function updateCredMode(id, mode) {
  try {
    const r = await api('/api/creds/' + id, { method: 'PUT', body: JSON.stringify({ mode }) });
    await loadCreds();
    toast(`凭证「${r.cred.name}」已切换为${credModeLabel(mode)}——引用它的流程下次运行立即生效`);
  } catch (e) { alert('切换失败：' + e.message); await loadCreds(); }
}
async function removeCred(id) {
  const c = state.creds.find(x => x.id === id);
  const bound = Object.values(state.opBindings || {}).filter(v => v === id).length;
  if (!confirm(`删除凭证「${c ? c.name : id}」？\n\n${bound ? `它绑定的 ${bound} 个接口将恢复为无认证，` : ''}使用流程级认证的流程会自动解除。已发布流程不受其它影响。`)) return;
  try { await api('/api/creds/' + id, { method: 'DELETE' }); await loadCreds(); }
  catch (e) { alert('删除失败：' + e.message); }
}
$('#btnAddCred').onclick = openCredModal;

$('#btnAddUrl').onclick = () => openSrcModal('url');
$('#btnAddText').onclick = () => openSrcModal('text');
$('#btnAddManual').onclick = () => openSrcModal('manual');
$('#srcClose').onclick = closeSrcModal;
$('#srcModal').addEventListener('click', e => { if (e.target.id === 'srcModal') closeSrcModal(); });

/* ── 帮助手册入口 ── */
$('#btnDocUrl').onclick = () => openDocModal('url');
$('#btnDocImport').onclick = () => openDocModal('file');
$('#docClose').onclick = closeDocModal;
$('#docViewClose').onclick = () => $('#docView').classList.add('hidden');
$('#docModal').addEventListener('click', e => { if (e.target.id === 'docModal') closeDocModal(); });
$('#docView').addEventListener('click', e => { if (e.target.id === 'docView') $('#docView').classList.add('hidden'); });

/* ───────── 导入 SDK（文件 / 文件夹 / 压缩包 / 地址 / 粘贴代码，自动分析接口） ───────── */
let _sdkMode = 'file', _sdkKind = 'files', _sdkFiles = [], _sdkArchive = null, _arcToken = null;
let _pipToken = null, _pipEnvAt = 0;   // pip 两步导入：第一步装包分析拿到 token，第二步确认导入
const SDK_EXT = { ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', java: 'Java', kt: 'Java', kts: 'Java', go: 'Go', json: '配置 JSON', yaml: '配置 YAML', yml: '配置 YAML' };
const sdkFmt = name => SDK_EXT[String(name).split('.').pop().toLowerCase()] || '未知';
// 本地导入的三种形态：单文件 / 文件夹 / 压缩包
const SDK_PICK = {
  files: { input: '#sdkFiles', title: '点击选择，或把 SDK 文件拖到这里', note: '支持 .ts / .js / .py / .java / .go / 配置 .json，可多选（单文件 ≤2MB）' },
  dir: { input: '#sdkDirInput', title: '点击选择 SDK 文件夹，或把整个文件夹拖到这里', note: '自动跳过 node_modules / 测试 / 构建产物，取最相关的 80 个源码文件参与解析' },
  archive: { input: '#sdkArcInput', title: '点击选择压缩包（.zip / .tar / .tar.gz / .tgz）', note: '上传后服务端解压分析，先看识别结果再确认导入（包 ≤40MB）' },
};
const SDK_SRC_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|kt|kts|go|json|txt|ya?ml)$/i;
const SDK_ARC_RE = /\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;
const SDK_NOISE_RE = /(^|\/)(?:node_modules|\.git|\.svn|dist|build|out|output|target|vendor|Pods|coverage|__pycache__|\.venv|venv|docs?|examples?|samples?|demo|tests?|testing|__tests__|\.next|\.nuxt)(\/|$)/i;
const SDK_SKIP_FILE_RE = /(?:^\.|\.min\.(?:js|css)$|\.d\.ts$|\.map$|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum))$/i;
const SDK_PAIR_RE = /["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*[fFrRbBuU]{0,2}["'`]/;
const SDK_CALL_RE = /(?:\.(?:get|post|put|patch|delete|head|options|request|fetch|send)\s*[(`]|urlopen\s*\(|http\.NewRequest|@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b)/;
const SDK_CFG_RE = /["'](?:operations|paths|openapi|baseUrl)["']\s*:/;
// 生成式 Python SDK：method="POST" 与 uri="/v4/..." 是同一参数块里的两个关键字参数
const SDK_PY_KV_RE = /["']?\bmethod["']?\s*[=:]\s*["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/i;
const SDK_PY_PATH_RE = /["']?\b(?:gateway_uri|uri|path|url|api_path)\b["']?\s*[=:]\s*["'][/]/i;
const SDK_BASE_RE = /(?:BASE_URL|BASEURL|baseURL|baseUrl|API_BASE|api_base|base_url|DEFAULT_HOST|API_HOST|SERVER_URL|DEFAULT_API_BASE|API_URL)\s*(?::\s*[\w[\]. ]{1,40})?[:=]\s*["'][^"']{6,200}["']/;
const SDK_MAX_PICK = 80, SDK_MAX_ONE = 2 * 1024 * 1024, SDK_MAX_TOTAL = 5.5 * 1024 * 1024;
const sdkPathScore = rel => {
  let s = 0;
  if (/(client|api|service|sdk|resource|endpoint|http|request|gateway)/i.test(rel)) s += 3;
  if (/src\//i.test(rel)) s += 1;
  return s;
};
const sdkTextScore = (rel, text) => {
  let s = 0;
  if (SDK_PAIR_RE.test(text) || (SDK_PY_KV_RE.test(text) && SDK_PY_PATH_RE.test(text))) s += 10;
  else if (SDK_CALL_RE.test(text)) s += 8;          // 语言特有的调用 / 注解写法
  if (/\.json$/i.test(rel) && SDK_CFG_RE.test(text)) s += 20;
  if (/["'`]\//.test(text)) s += 1;
  if (SDK_BASE_RE.test(text)) s += 2;               // 服务地址线索，保留下来才能识别 baseUrl
  if (/(?:^|[\/_.-])(?:index|mod|__init__|types?|package|constants?|errors?)\.[a-z]+$/i.test(rel)) s -= 2;
  return s;
};

function openSdkModal() {
  _sdkMode = 'file'; _sdkKind = 'files'; _sdkFiles = []; _sdkArchive = null; _arcToken = null;
  $('#sdkBody').innerHTML = `
    <div class="form-tip">直接读源码里的 HTTP 调用（method + path）生成接口清单，同时抽取注释里的中文说明当作接口名与关键词 —— 已经写好的客户端 SDK 不用再维护一份 OpenAPI。</div>
    <div class="sdk-tabs">
      <button class="sdk-tab on" data-m="file">本地导入</button>
      <button class="sdk-tab" data-m="url">SDK 地址</button>
      <button class="sdk-tab" data-m="text">粘贴代码 / 配置</button>
      <button class="sdk-tab" data-m="pip">pip 安装</button>
    </div>
    <div class="sdk-pane" id="sdkPaneFile">
      <div class="sdk-seg" id="sdkSeg">
        <button class="sdk-segbtn on" data-k="files">选择文件</button>
        <button class="sdk-segbtn" data-k="dir">选择文件夹</button>
        <button class="sdk-segbtn" data-k="archive">压缩包</button>
      </div>
      <div class="dropzone" id="sdkDrop" role="button" tabindex="0">
        <b id="sdkDropTitle">${SDK_PICK.files.title}</b>
        <span class="note" id="sdkDropNote">${SDK_PICK.files.note}</span>
      </div>
      <input type="file" id="sdkFiles" multiple accept=".ts,.tsx,.js,.mjs,.cjs,.py,.java,.kt,.go,.json,.txt,.yaml,.yml" style="display:none">
      <input type="file" id="sdkDirInput" webkitdirectory directory multiple style="display:none">
      <input type="file" id="sdkArcInput" accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz" style="display:none">
      <div class="sdk-files" id="sdkFileList"><span class="note">还没有选择文件</span></div>
      <div id="sdkArcPreview"></div>
    </div>
    <div class="sdk-pane hidden" id="sdkPaneUrl">
      <div class="form-row"><label>SDK 源码 / 清单地址（http、https）</label><input id="sdkUrl" placeholder="https://example.com/sdk/order-client.ts 或 …/sdk-manifest.json"></div>
      <div class="note">清单格式：<code>{"sdk":"order","files":["a.ts","https://…/b.py"]}</code>，也接受配置 JSON（<code>{"operations":[…]}</code>）。只有给了地址才能开启「现网自动更新」。</div>
    </div>
    <div class="sdk-pane hidden" id="sdkPaneText">
      <div class="form-row"><label>文件名（决定按哪种语言解析）</label><input id="sdkName" placeholder="order-client.ts"></div>
      <div class="form-row"><label>源码 / 配置 JSON</label><textarea id="sdkText" style="height:150px" placeholder="class OrderClient {
  /** 查询订单详情 */
  async getOrder(orderNo: string) { return this.request('GET', ` + '`/orders/${orderNo}`' + `) }
        }"></textarea></div>
    </div>
    <div class="sdk-pane hidden" id="sdkPanePip">
      <div class="form-row"><label>Python 包名（走一次真实的 pip install）</label>
        <input id="sdkPkg" placeholder="例如 stripe==11.4.1、python-telegram-bot、包名[extra]>=2.0" autocomplete="off" spellcheck="false"></div>
      <div class="pip-chips" id="sdkPkgTips">
        <span class="note">试试：</span>
        <button class="chipbtn" data-pkg="stripe==11.4.1">stripe</button>
        <button class="chipbtn" data-pkg="python-telegram-bot">python-telegram-bot</button>
        <button class="chipbtn" data-pkg="slack-sdk">slack-sdk</button>
      </div>
      <div class="form-row"><label>私有源（可选，默认官方 PyPI）</label>
        <input id="sdkIndex" placeholder="https://mirrors.example.com/simple" autocomplete="off" spellcheck="false"></div>
      <label class="ck-all" style="margin:6px 0 2px"><input type="checkbox" id="sdkDeps"> 连同依赖一起安装（接口写在依赖包里时才需要，体积和耗时会明显变大）</label>
      <div class="pip-env" id="sdkEnv"><span class="note">正在检测 pip 环境…</span></div>
      <div id="sdkPipResult"></div>
    </div>
    <div class="sdk-opts">
      <div class="form-row"><label>来源名称（可选）</label><input id="sdkSrcName" placeholder="例如：订单中心 SDK"></div>
      <div class="form-row"><label>服务地址（可选，识别不到时填写）</label><input id="sdkBase" placeholder="https://api.example.com"></div>
    </div>
    <label class="ck-all" style="margin:2px 0 4px"><input type="checkbox" id="sdkAuto" disabled> 开启现网自动更新（定时重拉 / 重新 pip 安装，SDK 地址与 pip 模式可用）</label>
    <div class="form-row hidden" id="sdkAutoRow" style="flex-direction:row;align-items:center;gap:9px;margin-bottom:4px">
      <label style="margin:0">同步间隔</label>
      <select id="sdkInterval" class="sel"><option value="60000">每 1 分钟</option><option value="300000" selected>每 5 分钟</option><option value="900000">每 15 分钟</option><option value="3600000">每 1 小时</option></select>
      <span class="note">到点自动重新解析，接口变更会按版本漂移规则告警</span>
    </div>
    <div id="sdkMsg"></div>
    <div class="modal-foot"><button class="btn" id="sdkCancel">取消</button><button class="btn primary purple" id="sdkSubmit">分析并导入</button></div>`;

  const setMode = m => {
    _sdkMode = m;
    document.querySelectorAll('#sdkBody .sdk-tab').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    $('#sdkPaneFile').classList.toggle('hidden', m !== 'file');
    $('#sdkPaneUrl').classList.toggle('hidden', m !== 'url');
    $('#sdkPaneText').classList.toggle('hidden', m !== 'text');
    $('#sdkPanePip').classList.toggle('hidden', m !== 'pip');
    const auto = $('#sdkAuto');
    auto.disabled = !(m === 'url' || m === 'pip');
    if (auto.disabled) { auto.checked = false; $('#sdkAutoRow').classList.add('hidden'); }
    $('#sdkSubmit').textContent = m === 'pip' ? '安装并分析' : '分析并导入';
    resetPip();
    if (m !== 'pip') resetSdkPick();
    if (m === 'pip') loadPipEnv();
  };
  document.querySelectorAll('#sdkBody .sdk-tab').forEach(b => b.onclick = () => setMode(b.dataset.m));
  $('#sdkAuto').onchange = () => $('#sdkAutoRow').classList.toggle('hidden', !$('#sdkAuto').checked);
  // pip：包名 / 私有源改了，上一次的分析结果就作废，避免导入了别的包
  ['#sdkPkg', '#sdkIndex'].forEach(sel => { $(sel).oninput = () => resetPip(); });
  $('#sdkDeps').onchange = () => resetPip();
  document.querySelectorAll('#sdkBody .chipbtn').forEach(b => b.onclick = () => {
    $('#sdkPkg').value = b.dataset.pkg; resetPip(); $('#sdkPkg').focus();
  });

  /* ── 本地导入：文件 / 文件夹 / 压缩包 ── */
  const clearPick = () => {
    _sdkFiles = []; _sdkArchive = null; _arcToken = null;
    ['#sdkFiles', '#sdkDirInput', '#sdkArcInput'].forEach(s => { const el = $(s); if (el) el.value = ''; });
    if ($('#sdkArcPreview')) $('#sdkArcPreview').innerHTML = '';
  };
  const resetSdkPick = () => {
    clearPick();
    renderPicked();
    const btn = $('#sdkSubmit'); if (btn && _sdkMode === 'file') btn.textContent = '分析并导入';
    const msg = $('#sdkMsg'); if (msg) msg.innerHTML = '';
  };
  const renderPicked = (hits, scanned) => {
    const box = $('#sdkFileList');
    if (!box) return;
    if (_sdkKind === 'archive') {
      box.innerHTML = _sdkArchive
        ? `<div class="sdk-file"><span class="fmtchip">${esc(String(_sdkArchive.name).split('.').pop().toUpperCase().slice(0, 4))}</span>
             <b title="${esc(_sdkArchive.name)}">${esc(_sdkArchive.name)}</b>
             <span class="note">${fmtBytes(_sdkArchive.size)} · 点「分析并导入」后先解压预览</span></div>`
        : '<span class="note">还没有选择压缩包</span>';
      return;
    }
    if (!_sdkFiles.length) { box.innerHTML = '<span class="note">还没有选择文件</span>'; return; }
    const totalKB = _sdkFiles.reduce((n, f) => n + (f.size || 0), 0) / 1024;
    const head = `<div class="sdk-sum">已选 <b>${_sdkFiles.length}</b> 个文件 · ${totalKB >= 1024 ? (totalKB / 1024).toFixed(1) + ' MB' : totalKB.toFixed(0) + ' KB'}${
      _sdkKind === 'dir' && scanned ? ` · 从 ${scanned} 个源码文件中挑选` : ''}${
      hits === 0 ? ' · <span class="bad">没发现 HTTP 调用痕迹，仍可尝试导入</span>' : ''}</div>`;
    const rows = _sdkFiles.slice(0, 24).map(f => `<div class="sdk-file"><span class="fmtchip">${esc(sdkFmt(f.name))}</span>
        <b title="${esc(f.path || f.name)}">${esc(String(f.path || f.name).split('/').slice(-2).join('/'))}</b>
        <span class="note">${((f.size || 0) / 1024).toFixed(1)} KB</span></div>`).join('');
    box.innerHTML = head + rows + (_sdkFiles.length > 24 ? `<div class="note">还有 ${_sdkFiles.length - 24} 个未显示</div>` : '');
  };
  const setKind = k => {
    _sdkKind = k;
    document.querySelectorAll('#sdkBody .sdk-segbtn').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    const meta = SDK_PICK[k];
    if ($('#sdkDropTitle')) $('#sdkDropTitle').textContent = meta.title;
    if ($('#sdkDropNote')) $('#sdkDropNote').textContent = meta.note;
    resetSdkPick();
  };
  document.querySelectorAll('#sdkBody .sdk-segbtn').forEach(b => b.onclick = () => setKind(b.dataset.k));

  // 单文件：直接读文本（与旧版行为一致，最多 40 个）
  const readFileList = async list => {
    const out = [];
    for (const f of [...list].slice(0, 40)) {
      if (f.size > SDK_MAX_ONE) continue;
      let text = '';
      try { text = await f.text(); } catch { continue; }
      if (!text.trim()) continue;
      out.push({ name: f.name, path: f.webkitRelativePath || f.name, text, size: text.length });
    }
    if (!out.length) throw new Error('选中的文件都是空的或超过 2MB，请重新选择');
    _sdkFiles = out.slice(0, SDK_MAX_PICK); _sdkArchive = null; _arcToken = null;
    renderPicked();
  };
  // 文件夹：先按路径挑候选，再读内容按「调用痕迹」排序取前 80 个（与服务端压缩包同一套思路）
  const readDirList = async entries => {
    const cand = entries
      .filter(e => SDK_SRC_RE.test(e.file.name) && !SDK_NOISE_RE.test('/' + e.rel) && !SDK_SKIP_FILE_RE.test(e.file.name))
      .sort((a, b) => sdkPathScore(b.rel) - sdkPathScore(a.rel) || a.file.size - b.file.size)
      .slice(0, 200);
    if (!cand.length) throw new Error('文件夹里没有可解析的源码文件（支持 .ts / .js / .py / .java / .kt / .go / .json）');
    const box = $('#sdkFileList');
    const picked = [];
    let total = 0, read = 0;
    for (const c of cand) {
      read++;
      if (read % 6 === 1 && box) box.innerHTML = `<div class="sdk-run"><span class="dot-on"></span>正在读取文件夹 … ${read}/${cand.length}</div>`;
      if (c.file.size > SDK_MAX_ONE) continue;
      let text = '';
      try { text = await c.file.text(); } catch { continue; }
      if (!text.trim() || text.includes('\u0000')) continue;
      const bytes = text.length;
      if (total + bytes > 8 * 1024 * 1024) continue;
      total += bytes;
      picked.push({ name: c.file.name, path: c.rel, text, size: bytes, score: sdkTextScore(c.rel, text) });
    }
    if (!picked.length) throw new Error('文件夹里没有读到可用的源码文件');
    picked.sort((a, b) => b.score - a.score || a.size - b.size);
    const sel = [];
    let bytes = 0;
    for (const f of picked) {
      if (sel.length >= SDK_MAX_PICK) break;
      if (bytes + f.size > SDK_MAX_TOTAL) continue;
      sel.push(f); bytes += f.size;
    }
    _sdkFiles = sel; _sdkArchive = null; _arcToken = null;
    renderPicked(picked.filter(f => f.score >= 8).length, picked.length);
    if (!$('#sdkSrcName').value) {
      const root = String(sel[0].path || '').split('/')[0];
      if (root && root !== sel[0].name) $('#sdkSrcName').value = root.slice(0, 40);
    }
  };
  const pickArchive = f => {
    if (!SDK_ARC_RE.test(f.name)) throw new Error('只支持 .zip / .tar / .tar.gz / .tgz 压缩包');
    if (f.size > 40 * 1024 * 1024) throw new Error(`压缩包 ${(f.size / 1048576).toFixed(1)}MB 超过 40MB 上限，请只打包 SDK 客户端目录`);
    _sdkArchive = f; _sdkFiles = []; _arcToken = null;
    if ($('#sdkArcPreview')) $('#sdkArcPreview').innerHTML = '';
    renderPicked();
    if (!$('#sdkSrcName').value) {
      $('#sdkSrcName').value = f.name.replace(SDK_ARC_RE, '').replace(/[-_.]v?\d+(?:\.\d+)+$/, '').replace(/[-_.]+/g, ' ').slice(0, 40);
    }
  };
  // 拖文件夹：webpack/浏览器只给 entry，得递归取 File
  const entriesToFiles = (entries, out = [], prefix = '') => Promise.all(entries.map(en => new Promise(resolve => {
    try {
      if (en.isFile) en.file(f => { out.push({ file: f, rel: prefix + f.name }); resolve(); }, () => resolve());
      else if (en.isDirectory) {
        const rd = en.createReader();
        const readAll = () => rd.readEntries(async batch => {
          if (!batch.length) return resolve();
          if (out.length < 6000) await entriesToFiles(batch, out, prefix + en.name + '/');
          readAll();
        }, () => resolve());
        readAll();
      } else resolve();
    } catch { resolve(); }
  })));

  const drop = $('#sdkDrop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('click', () => { const el = $(SDK_PICK[_sdkKind].input); if (el) el.click(); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('over');
    const dt = e.dataTransfer;
    if (!dt) return;
    const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const dirs = entries.filter(en => en.isDirectory);
    const files = [...(dt.files || [])];
    try {
      if (dirs.length) {
        setKind('dir');
        const out = [];
        await entriesToFiles(dirs, out);
        await readDirList(out);
        return;
      }
      if (!files.length) return;
      if (files.length === 1 && SDK_ARC_RE.test(files[0].name)) { setKind('archive'); pickArchive(files[0]); return; }
      if (_sdkKind === 'dir') { setKind('dir'); await readDirList(files.map(f => ({ file: f, rel: f.name }))); return; }
      setKind('files');
      await readFileList(files);
    } catch (err) { sdkMsg(false, err.message); }
  });
  $('#sdkFiles').onchange = e => { readFileList(e.target.files).catch(err => sdkMsg(false, err.message)); };
  $('#sdkDirInput').onchange = e => {
    readDirList([...e.target.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name })))
      .catch(err => sdkMsg(false, err.message));
  };
  $('#sdkArcInput').onchange = e => {
    try { if (e.target.files[0]) pickArchive(e.target.files[0]); } catch (err) { sdkMsg(false, err.message); }
  };
  $('#sdkCancel').onclick = closeSdkModal;
  $('#sdkSubmit').onclick = submitSdk;
  resetPip();
  renderPicked();
  $('#sdkModal').classList.remove('hidden');
  setTimeout(() => { const el = $('#sdkBody').querySelector('input:not([type=file]),textarea'); if (el) el.focus(); }, 60);
}
function closeSdkModal() { $('#sdkModal').classList.add('hidden'); }
function sdkMsg(ok, text) { $('#sdkMsg').innerHTML = `<div class="${ok ? 'msg-ok' : 'msg-bad'}">${esc(text)}</div>`; }

/* ───────── SDK 资料库：接口之外的函数 / 方法 / 类 / 类型，可按能力检索 ───────── */
let _mat = { sourceId: '', q: '', kind: '', offset: 0, total: 0, items: [], busy: false, timer: null };
const MAT_KIND = { function: '函数', method: '方法', class: '类', type: '类型', const: '常量' };

function openMaterials(sourceId = '') {
  const src = sourceId ? (state.sources || []).find(s => s.id === sourceId) : null;
  _mat = { sourceId, q: '', kind: '', offset: 0, total: 0, items: [], busy: false, timer: null };
  $('#matTitle').textContent = src ? `SDK 资料 · ${src.name}` : 'SDK 资料（全部来源）';
  const st = src && src.materials;
  $('#matBody').innerHTML = `
    <div class="form-tip">这些是 SDK 里的函数、方法、类和类型定义（含注释与参数签名）。接口清单只覆盖「能直接调的 URL」，
    而读写字段、分页参数、重试封装、枚举值往往只存在于这些资料里 —— 智能体搭流程时会先在这里查。</div>
    <div class="mat-head">
      <input id="matQ" class="mat-q" placeholder="搜能力：分页 / 密钥对 / endpoint / describe_instances …" autocomplete="off" spellcheck="false">
      <select id="matKind" class="sel">
        <option value="">全部类型</option>
        ${Object.entries(MAT_KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
    </div>
    <div class="note" id="matStat">${st ? `共 ${st.count} 条资料 · ${st.languages.join(' / ') || '—'}` : '正在读取…'}</div>
    <div class="mat-list" id="matList"></div>
    <div class="mat-more"><button class="btn" id="matMore" style="display:none">加载更多</button></div>`;
  $('#matQ').oninput = () => {
    clearTimeout(_mat.timer);
    _mat.timer = setTimeout(() => { _mat.q = $('#matQ').value.trim(); fetchMaterials(true); }, 220);
  };
  $('#matKind').onchange = () => { _mat.kind = $('#matKind').value; fetchMaterials(true); };
  $('#matMore').onclick = () => fetchMaterials(false);
  $('#matClose').onclick = () => $('#matModal').classList.add('hidden');
  $('#matModal').classList.remove('hidden');
  fetchMaterials(true);
  setTimeout(() => $('#matQ') && $('#matQ').focus(), 60);
}
function matRow(s) {
  const params = (s.params || []).filter(p => p.name && p.name !== 'self' && p.name !== 'this' && p.name !== 'ctx');
  return `<div class="matrow">
    <div class="mh">
      <span class="fmtchip matk-${esc(s.kind)}">${esc(MAT_KIND[s.kind] || s.kind)}</span>
      <b>${esc(s.parent ? s.parent + '.' : '')}${esc(s.name)}</b>
      <span style="flex:1"></span>
      <span class="note" title="${esc(s.file)}:${s.line}">${esc(String(s.file || '').split('/').pop())}:${s.line}</span>
    </div>
    <div class="mono msig">${esc(s.sig || s.name)}</div>
    ${params.length ? `<div class="mparams">${params.slice(0, 8).map(p => `<span class="pchip" title="${esc(p.type || '')}">${esc(p.name)}${p.optional ? '?' : ''}${p.type ? `: ${esc(p.type)}` : ''}</span>`).join('')}${params.length > 8 ? `<span class="note">+${params.length - 8}</span>` : ''}</div>` : ''}
    ${s.summary ? `<div class="msum">${esc(s.summary)}</div>` : ''}
    ${s.sourceName ? `<div class="note">来自「${esc(s.sourceName)}」</div>` : ''}
  </div>`;
}
async function fetchMaterials(reset) {
  if (_mat.busy) return;
  _mat.busy = true;
  if (reset) { _mat.offset = 0; _mat.items = []; }
  const qs = new URLSearchParams({ q: _mat.q, kind: _mat.kind, limit: '40', offset: String(_mat.offset) });
  const url = _mat.sourceId ? `/api/sources/${_mat.sourceId}/materials?` + qs : '/api/materials?' + qs;
  try {
    const r = await api(url);
    if (r.alreadyGone) { $('#matStat').innerHTML = '<span class="bad">该来源已不存在，可能已被卸载</span>'; $('#matList').innerHTML = ''; return; }
    _mat.items = _mat.items.concat(r.items || []);
    _mat.total = r.total || 0;
    _mat.offset = _mat.items.length;
    const st = r.stats || null;
    const head = st
      ? `共 ${st.count} 条 · ${st.classes} 个类 · ${st.methods + st.functions} 个函数/方法${st.documented ? ` · ${st.documented} 条带说明` : ''}`
      : `共 ${_mat.total} 条`;
    const where = _mat.sourceId ? '' : ` · <b>${(r.sources || []).length}</b> 个来源`;
    $('#matStat').innerHTML = head + where + (_mat.q ? ` · 匹配「${esc(_mat.q)}」${_mat.total} 条` : '');
    $('#matList').innerHTML = _mat.items.length
      ? _mat.items.map(matRow).join('')
      : `<div class="empty">没有匹配的资料。换个关键词试试 —— 英文函数名（describe_instances）、中文注释（分页）、字段名（max_results）都能搜。</div>`;
    $('#matMore').style.display = _mat.items.length < _mat.total ? '' : 'none';
    $('#matMore').textContent = `加载更多（已显示 ${_mat.items.length} / ${_mat.total}）`;
  } catch (e) {
    $('#matList').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
  } finally { _mat.busy = false; }
}

/* pip 安装导入：装一次包 → 看识别结果 → 确认导入 */
function resetPip() {
  _pipToken = null;
  const btn = $('#sdkSubmit'); if (btn) btn.textContent = _sdkMode === 'pip' ? '安装并分析' : '分析并导入';
  const box = $('#sdkPipResult'); if (box) box.innerHTML = '';
  const msg = $('#sdkMsg'); if (msg) msg.innerHTML = '';
}
async function loadPipEnv(force) {
  const box = $('#sdkEnv');
  if (!box) return;
  if (!force && _pipEnvAt && Date.now() - _pipEnvAt < 60000) return;
  try {
    const e = await api('/api/sdk/pip/env' + (force ? '?force=1' : ''));
    _pipEnvAt = Date.now();
    box.innerHTML = e.ok
      ? `<span class="dot-on"></span>Python ${esc(e.pythonVersion)} · pip ${esc(e.pip)} · 解释器 <code>${esc(e.python)}</code>`
      : `<span class="dot-off"></span><span class="bad">${esc(e.error || '未检测到 pip')}</span>`;
  } catch (err) {
    box.innerHTML = `<span class="bad">检测 pip 环境失败：${esc(err.message)}</span>`;
  }
}
function renderPipResult(r) {
  const s = r.stats || {};
  const ops = r.operations || [];
  const rows = ops.slice(0, 12).map(o => `<div class="pip-op">
      <span class="mtag m-${esc(String(o.method).toLowerCase())}">${esc(o.method)}</span>
      <span class="mono">${esc(o.path)}</span><span class="note">${esc(o.name || '')}</span></div>`).join('');
  $('#sdkPipResult').innerHTML = `
    <div class="pipres">
      <div class="pipres-h"><b>${esc(r.pkg.name || r.spec)}</b><span class="vtag">${esc(r.pkg.version || '—')}</span>
        <span class="fmtchip">${esc(r.formatName)}</span><span style="flex:1"></span>
        <span class="note">${s.selected || 0}/${s.pyFiles || 0} 个源码文件 · ${((s.totalBytes || 0) / 1048576).toFixed(1)}MB · ${((s.installMs || 0) / 1000).toFixed(1)}s</span></div>
      ${r.pkg.summary ? `<div class="note">${esc(r.pkg.summary)}</div>` : ''}
      <div class="pipres-kv">
        ${r.count
          ? `<span>识别到 <b>${r.count}</b> 个接口</span>`
          : `<span class="bad">未发现业务接口</span><span>这是基础库 / 框架包（通常只有 client 封装、鉴权、序列化），可直接导入为「资料」</span>`}
        ${r.materials ? `<span>同时收录 <b>${r.materials.count}</b> 条 SDK 资料（${r.materials.classes} 个类 · ${r.materials.methods + r.materials.functions} 个函数/方法）</span>` : ''}
        ${r.baseUrl ? `<span>服务地址 <code>${esc(r.baseUrl)}</code></span>` : '<span class="bad">没识别到服务地址，请在下方「服务地址」补一个</span>'}
        ${r.pkg.license ? `<span>License ${esc(r.pkg.license)}</span>` : ''}
      </div>
      ${(r.notes || []).map(n => `<div class="note">· ${esc(n)}</div>`).join('')}
      <div class="pip-ops">${rows}</div>
      ${ops.length > 12 ? `<div class="note">仅显示前 12 个，共 ${r.count} 个</div>` : ''}
    </div>`;
}
async function submitPip() {
  // 第二步：已经分析过，直接导入（复用服务端缓存，不再装一次）
  if (_pipToken) {
    const btn = $('#sdkSubmit'); btn.disabled = true;
    try {
      const payload = { mode: 'pip', token: _pipToken, name: $('#sdkSrcName').value.trim(), baseUrl: $('#sdkBase').value.trim() };
      if ($('#sdkAuto').checked) payload.autoSync = { enabled: true, intervalMs: Number($('#sdkInterval').value) };
      const r = await api('/api/sources', { method: 'POST', body: JSON.stringify(payload) });
      sdkMsg(true, (r.added
        ? `已导入「${esc(r.source.name)}」的 ${r.added} 个接口`
        : `已导入「${esc(r.source.name)}」：没有业务接口，已收录 ${(r.materials || {}).count || 0} 条资料（类 / 函数 / 方法）`)
        + `${r.source.autoSync && r.source.autoSync.enabled ? '，并开启自动重新安装' : ''}`);
      await loadApi();
      setTimeout(closeSdkModal, 1500);
    } finally { btn.disabled = false; }
    return;
  }
  // 第一步：pip install + 扫描源码
  const pkg = $('#sdkPkg').value.trim();
  if (!pkg) throw new Error('请填写要安装的 Python 包名，例如 stripe==11.4.1');
  const btn = $('#sdkSubmit'), box = $('#sdkPipResult');
  btn.disabled = true;
  const t0 = Date.now();
  const tick = () => {
    box.innerHTML = `<div class="pip-run"><span class="dot-on"></span>正在 <code>pip install ${esc(pkg)}</code> …
      <b>${((Date.now() - t0) / 1000).toFixed(1)}s</b>
      <div class="note">下载 → 解压到临时目录 → 扫描源码里的 HTTP 调用，通常 5 ~ 20 秒</div></div>`;
  };
  tick();
  const timer = setInterval(tick, 200);
  try {
    const r = await api('/api/sdk/pip/analyze', {
      method: 'POST',
      body: JSON.stringify({ package: pkg, indexUrl: $('#sdkIndex').value.trim(), withDeps: $('#sdkDeps').checked }),
    });
    _pipToken = r.token;
    renderPipResult(r);
    btn.textContent = r.count ? `✓ 导入 ${r.count} 个接口` : `✓ 仅导入资料（${(r.materials || {}).count || 0} 条）`;
    if (!$('#sdkSrcName').value) $('#sdkSrcName').value = r.pkg.name || pkg;
    if (!$('#sdkBase').value && r.baseUrl) $('#sdkBase').value = r.baseUrl;
  } finally { clearInterval(timer); btn.disabled = false; }
}
/* 压缩包导入：上传 → 服务端解压预览 → 再点一次确认导入 */
function renderArcResult(r) {
  const s = r.archive || {};
  const ops = r.operations || [];
  const rows = ops.slice(0, 12).map(o => `<div class="pip-op">
      <span class="mtag m-${esc(String(o.method).toLowerCase())}">${esc(o.method)}</span>
      <span class="mono">${esc(o.path)}</span><span class="note">${esc(o.name || '')}</span></div>`).join('');
  $('#sdkArcPreview').innerHTML = `
    <div class="pipres">
      <div class="pipres-h"><b>${esc(s.name || '压缩包')}</b>${r.version ? `<span class="vtag">${esc(r.version)}</span>` : ''}
        <span class="fmtchip">${esc(r.formatName)}</span><span style="flex:1"></span>
        <span class="note">${s.entries || 0} 个文件 · 取 ${s.selected || 0} 个源码 · ${fmtBytes(s.bytes)}</span></div>
      <div class="pipres-kv">
        ${r.count
          ? `<span>识别到 <b>${r.count}</b> 个接口</span>`
          : `<span class="bad">未发现业务接口</span><span>这是基础库 / 框架包（通常只有 client 封装、鉴权、序列化），可直接导入为「资料」</span>`}
        ${r.materials ? `<span>同时收录 <b>${r.materials.count}</b> 条 SDK 资料（${r.materials.classes} 个类 · ${r.materials.methods + r.materials.functions} 个函数/方法）</span>` : ''}
        ${r.baseUrl ? `<span>服务地址 <code>${esc(r.baseUrl)}</code></span>` : '<span class="bad">没识别到服务地址，请在下方「服务地址」补一个</span>'}
        ${s.skipped ? `<span>跳过 ${s.skipped} 个无 HTTP 调用的文件</span>` : ''}
      </div>
      ${(r.notes || []).map(n => `<div class="note">· ${esc(n)}</div>`).join('')}
      <div class="pip-ops">${rows}</div>
      ${ops.length > 12 ? `<div class="note">仅显示前 12 个，共 ${r.count} 个</div>` : ''}
    </div>`;
}
async function submitArchive() {
  const btn = $('#sdkSubmit');
  // 第二步：已经解压分析过，直接导入（服务端缓存 10 分钟，不会重复解压）
  if (_arcToken) {
    const r = await api('/api/sources', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'archive', token: _arcToken,
        name: $('#sdkSrcName').value.trim(), baseUrl: $('#sdkBase').value.trim(),
      }),
    });
    sdkMsg(true, r.added
      ? `已从压缩包导入「${esc(r.source.name)}」的 ${r.added} 个接口`
      : `已导入「${esc(r.source.name)}」：没有业务接口，已收录 ${(r.materials || {}).count || 0} 条资料（类 / 函数 / 方法），可在「📚 资料」检索`);
    await loadApi();
    setTimeout(closeSdkModal, 1500);
    return;
  }
  const f = _sdkArchive;
  if (!f) throw new Error('请选择要导入的 SDK 压缩包');
  const box = $('#sdkArcPreview');
  const t0 = Date.now();
  const tick = () => {
    box.innerHTML = `<div class="pip-run"><span class="dot-on"></span>正在上传并解压 <code>${esc(f.name)}</code> … <b>${((Date.now() - t0) / 1000).toFixed(1)}s</b>
      <div class="note">解压 → 跳过 node_modules / 测试 / 构建产物 → 扫描源码里的 HTTP 调用</div></div>`;
  };
  tick();
  const timer = setInterval(tick, 300);
  try {
    const buf = await f.arrayBuffer();
    const r = await api('/api/sdk/archive?name=' + encodeURIComponent(f.name), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf,
    });
    _arcToken = r.token;
    renderArcResult(r);
    btn.textContent = r.count ? `✓ 导入 ${r.count} 个接口` : `✓ 仅导入资料（${(r.materials || {}).count || 0} 条）`;
    if (!$('#sdkSrcName').value && r.suggestedName) $('#sdkSrcName').value = r.suggestedName;
    if (!$('#sdkBase').value && r.baseUrl) $('#sdkBase').value = r.baseUrl;
  } finally { clearInterval(timer); }
}
async function submitSdk() {
  if (_sdkMode === 'pip') {
    try { await submitPip(); } catch (e) { sdkMsg(false, e.message); }
    return;
  }
  const btn = $('#sdkSubmit');
  btn.disabled = true;
  try {
    const payload = { mode: 'sdk', name: $('#sdkSrcName').value.trim(), baseUrl: $('#sdkBase').value.trim() };
    if (_sdkMode === 'file') {
      if (_sdkKind === 'archive') { await submitArchive(); return; }
      if (!_sdkFiles.length) throw new Error(_sdkKind === 'dir' ? '请选择要导入的 SDK 文件夹' : '请选择要导入的 SDK 文件');
      payload.files = _sdkFiles.map(f => ({ name: f.name, path: f.path, text: f.text }));
    } else if (_sdkMode === 'url') {
      payload.url = $('#sdkUrl').value.trim();
      if (!payload.url) throw new Error('请填写 SDK / 清单地址');
      if ($('#sdkAuto').checked) payload.autoSync = { enabled: true, intervalMs: Number($('#sdkInterval').value) };
    } else {
      payload.text = $('#sdkText').value;
      payload.filename = $('#sdkName').value.trim() || 'pasted-sdk.ts';
      if (!payload.text.trim()) throw new Error('请粘贴 SDK 源码或配置 JSON');
    }
    const r = await api('/api/sources', { method: 'POST', body: JSON.stringify(payload) });
    const brief = r.operations.slice(0, 3).map(o => `${o.method} ${o.path}`).join('、') + (r.added > 3 ? ` 等 ${r.added} 个` : '');
    sdkMsg(true, r.added
      ? `已从 ${r.sdk.formatName} 识别 ${r.added} 个接口：${brief}${r.source.autoSync && r.source.autoSync.enabled ? '｜已开启自动同步' : ''}`
      : `已从 ${r.sdk.formatName} 收录 ${(r.materials || {}).count || 0} 条资料（未发现业务接口）${r.source.autoSync && r.source.autoSync.enabled ? '｜已开启自动同步' : ''}`);
    await loadApi();
    setTimeout(closeSdkModal, 1600);
  } catch (e) {
    sdkMsg(false, e.message);
  } finally { btn.disabled = false; }
}
$('#btnImportSdk').onclick = openSdkModal;
$('#sdkClose').onclick = closeSdkModal;
$('#sdkModal').addEventListener('click', e => { if (e.target.id === 'sdkModal') closeSdkModal(); });
$('#matModal').addEventListener('click', e => { if (e.target.id === 'matModal') $('#matModal').classList.add('hidden'); });

/* ───────── Chrome 插件接入：令牌 / 认证开关 / 连接配置 / 调用活动 ───────── */
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || '已复制'); }
  catch { toast('复制失败，请手动选中复制', 'bad'); }
}
async function openPlugin() {
  $('#pluginModal').classList.remove('hidden');
  await renderPlugin();
}
function closePlugin() { $('#pluginModal').classList.add('hidden'); }

async function renderPlugin() {
  const body = $('#pluginBody');
  let s;
  try { s = await api('/api/access/settings'); }
  catch (e) { body.innerHTML = `<div class="msg-bad">加载失败：${esc(e.message)}</div>`; return; }
  const origin = location.origin;
  const credOpts = s.creds.map(c => `<option value="${esc(c.id)}">${esc(c.name)}（${esc(c.ak)}）</option>`).join('');
  const tokenRows = s.tokens.length ? s.tokens.map(t => `
    <div class="tokrow">
      <b>${esc(t.name)}</b>
      <code>${esc(t.prefix)}…</code>
      <span class="note">${t.uses || 0} 次 · ${t.lastUsedAt ? fmtAgo(t.lastUsedAt) : '未使用'}</span>
      <span class="note">${t.expired ? '<span style="color:var(--bad)">已过期</span>' : '至 ' + new Date(t.expiresAt).toLocaleDateString('zh-CN')}</span>
      <span style="flex:1"></span>
      <button class="btn danger" onclick="revokeToken('${esc(t.id)}')">撤销</button>
    </div>`).join('') : '<div class="note">还没有令牌。用上面的 AK/SK 换一张，插件才能以你的身份调用平台。</div>';
  const acts = (s.activity || []).length ? s.activity.map(a => `
    <div class="actrow"><span class="note">${new Date(a.at).toLocaleTimeString('zh-CN')}</span>
      <b>${esc(a.actor || '—')}</b><code>${esc(a.method)} ${esc(a.path)}</code></div>`).join('')
    : '<div class="note">还没有外部调用记录。</div>';

  body.innerHTML = `
    <div class="form-tip">插件通过平台 API 读取<b>同一份流程、接口与运行记录</b> —— 在插件里说「运行供应商准入检查」和在 Web 端点运行是同一次执行，两边都能实时看到节点、请求与响应。默认跟随平台：平台没开认证时插件直接连接。</div>

    <div class="plugrow"><span class="k">服务地址</span><code>${esc(origin)}</code><span style="flex:1"></span><button class="btn" id="plCopySrv">复制</button></div>
    <div class="plugrow"><span class="k">访问认证</span>
      <label class="ck-all"><input type="checkbox" id="plRequire" ${s.requireAuth ? 'checked' : ''}> 要求插件 / 外部调用携带令牌或 AK-SK 签名</label>
      <span class="note">${s.requireAuth ? '已开启：控制台也需要登录' : '未开启：本机控制台与插件直接可用'}</span>
    </div>

    <h4 class="plugsec">① 用 AK/SK 换取令牌 <span class="note">SK 只在本地换令牌，不写进插件</span></h4>
    ${s.creds.length ? `
      <div class="plugform">
        <select id="plCred" class="sel">${credOpts}</select>
        <input id="plName" placeholder="令牌名称，如 Chrome 插件">
        <select id="plTtl" class="sel">
          <option value="3600000">1 小时</option>
          <option value="86400000">1 天</option>
          <option value="604800000" selected>7 天</option>
          <option value="2592000000">30 天</option>
        </select>
        <button class="btn primary" id="plIssue">生成令牌</button>
      </div>` : `
      <div class="msg-bad" style="margin-bottom:10px">还没有 AK/SK 凭证 —— <a onclick="closePlugin(); switchTab('api'); openCredModal()">去「接口」页创建</a>。插件与流程级认证共用平台凭证。</div>`}
    <div id="plTokenBox"></div>

    <h4 class="plugsec">② 已签发令牌</h4>
    <div class="toklist">${tokenRows}</div>

    <h4 class="plugsec">③ 安装插件</h4>
    <div class="plughint">Chrome 打开 <code>chrome://extensions</code> → 开启「开发者模式」→「加载已解压的扩展程序」→ 选项目根目录下的 <code>extension/</code>。
      侧边栏里填上面的服务地址；认证方式默认「跟随平台」，也可以贴入刚生成的令牌，或用 AK/SK 直签（每个请求带 <code>x-api-key</code> / <code>x-sign-ts</code> / <code>x-signature</code>）。</div>
    <div class="plugrow"><button class="btn" id="plCopyCfg">复制插件连接配置</button><span class="note">仅含服务地址与认证方式，不含 SK</span></div>

    <h4 class="plugsec">最近调用（插件 / 外部脚本）</h4>
    <div class="actlist">${acts}</div>

    <div class="modal-foot" style="margin-top:14px">
      ${authToken() ? '<button class="btn" id="plLogout">退出当前登录</button><span style="flex:1"></span>' : ''}
      <button class="btn" id="plRefresh">刷新</button>
      <button class="btn primary" id="pluginDone">完成</button>
    </div>`;

  $('#plCopySrv').onclick = () => copyText(origin, '服务地址已复制');
  $('#plRequire').onchange = async e => {
    try { await api('/api/access/settings', { method: 'POST', body: JSON.stringify({ requireAuth: e.target.checked }) }); toast(e.target.checked ? '已开启强制认证：外部调用必须带令牌或签名' : '已关闭强制认证：本机直接可用'); await renderPlugin(); }
    catch (err) { toast('设置失败：' + err.message, 'bad'); }
  };
  const issue = $('#plIssue');
  if (issue) issue.onclick = async () => {
    issue.disabled = true;
    try {
      const r = await api('/api/access/tokens', {
        method: 'POST',
        body: JSON.stringify({ credId: $('#plCred').value, name: $('#plName').value.trim(), ttlMs: Number($('#plTtl').value) }),
      });
      $('#plTokenBox').innerHTML = `
        <div class="tokonce">
          <div class="note" style="margin-bottom:6px">令牌只显示这一次，复制后填进插件设置：</div>
          <code id="plTokenVal">${esc(r.token)}</code>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn primary" id="plCopyTok">复制令牌</button>
            <button class="btn" id="plUseSelf">本机控制台也用这个令牌登录</button>
          </div>
        </div>`;
      $('#plCopyTok').onclick = () => copyText(r.token, '令牌已复制，粘贴到插件「设置 → 令牌」');
      $('#plUseSelf').onclick = () => { localStorage.setItem(AUTH_KEY, JSON.stringify({ token: r.token, name: r.name })); toast('已用该令牌登录本机控制台'); setTimeout(() => location.reload(), 600); };
    } catch (e) { toast('生成失败：' + e.message, 'bad'); }
    finally { issue.disabled = false; }
  };
  $('#plCopyCfg').onclick = () => copyText(JSON.stringify({ server: origin, authMode: 'auto', token: authToken() || '' }, null, 2), '连接配置已复制');
  $('#plRefresh').onclick = renderPlugin;
  $('#pluginDone').onclick = closePlugin;
  const lo = $('#plLogout');
  if (lo) lo.onclick = () => { localStorage.removeItem(AUTH_KEY); toast('已退出登录'); setTimeout(() => location.reload(), 500); };
}

async function revokeToken(id) {
  if (!confirm('撤销这个令牌？插件用它连接会立即失效。')) return;
  try { await api('/api/access/tokens/' + id, { method: 'DELETE' }); toast('已撤销'); renderPlugin(); }
  catch (e) { toast('撤销失败：' + e.message, 'bad'); }
}

/* 强制认证开启后：控制台也需要令牌（AK/SK 换令牌，存本地） */
let _loginShown = false;
function openLogin(msg) {
  if (_loginShown) return;
  _loginShown = true;
  $('#loginBody').innerHTML = `
    <div class="form-tip">${esc(msg || '平台已开启访问认证')}。用平台「接口 → 认证凭证」里的 AK/SK 登录，凭证只用于换一张短期令牌。</div>
    <div class="form-row"><label>AK</label><input id="lgAk" placeholder="AKxxxxxxxx" autocomplete="off" spellcheck="false"></div>
    <div class="form-row"><label>SK</label><input id="lgSk" type="password" placeholder="至少 16 位" autocomplete="off"></div>
    <div id="lgMsg"></div>
    <div class="modal-foot"><button class="btn" id="lgGuest">只读浏览（不登录）</button><span style="flex:1"></span><button class="btn primary" id="lgGo">登录</button></div>`;
  $('#loginModal').classList.remove('hidden');
  $('#lgGo').onclick = async () => {
    const ak = $('#lgAk').value.trim(), sk = $('#lgSk').value;
    if (!ak || !sk) return ($('#lgMsg').innerHTML = '<div class="msg-bad">AK / SK 都要填</div>');
    try {
      const r = await api('/api/auth/token', { method: 'POST', body: JSON.stringify({ ak, sk, name: 'Web 控制台' }) });
      localStorage.setItem(AUTH_KEY, JSON.stringify({ token: r.token, name: r.actor.name }));
      toast('登录成功');
      setTimeout(() => location.reload(), 400);
    } catch (e) { $('#lgMsg').innerHTML = `<div class="msg-bad">${esc(e.message)}</div>`; }
  };
  $('#lgGuest').onclick = () => $('#loginModal').classList.add('hidden');
  $('#loginClose').onclick = () => $('#loginModal').classList.add('hidden');
}

$('#btnPlugin').onclick = openPlugin;
$('#pluginClose').onclick = closePlugin;
$('#pluginModal').addEventListener('click', e => { if (e.target.id === 'pluginModal') closePlugin(); });
$('#loginModal').addEventListener('click', e => { if (e.target.id === 'loginModal') $('#loginModal').classList.add('hidden'); });

/* 启动 */
(async () => {
  await Promise.all([loadFlows(), loadHome()]);   // 首页为默认页，同时预热流程列表数据
  loadDocs();                                     // 手册篇数在搭建器顶部也要显示
  try {
    const c = await api('/api/catalog');
    state.catalog = c;
    $('#catalogBadge').textContent = `注册表 · ${c.version} · ${c.operations.length} 个接口`;
    if ($('#chatApiCount')) $('#chatApiCount').textContent = c.operations.length;
    _catalogVersion = c.version;
  } catch {}
  connectSSE();
})();

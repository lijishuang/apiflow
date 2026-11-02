// APIFlow 智能助手 —— 侧边栏逻辑
// 数据全部来自 APIFlow 平台 API（与 Web 控制台同一份），SSE 实时事件驱动运行轨迹
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  cfg: null, tab: 'chat',
  server: null,            // /api/ext/ping 结果
  boot: null,              // /api/ext/bootstrap
  msgs: [],                // 对话消息 {id, role, text, plan, runId, traceId, el}
  traces: {},              // traceId -> {runId, flowName, status, nodes, events, input, durationMs, meta}
  obsSel: null,            // 观测页当前展开的 runId
  sseCtl: null, sseTimer: null,
};
let _seq = 0;
const uid = p => p + '_' + (++_seq) + '_' + Date.now().toString(36);

const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
const fmtAgo = ts => {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return new Date(ts).toLocaleDateString('zh-CN');
};
const TRIG = { manual: '手动', schedule: '定时', webhook: 'Webhook', replay: '重放', batch: '并行', 'dry-run': '调试', agent: '插件', 'api-debug': '接口调试' };
const KIND = { 'run-flow': '运行流程', 'debug-op': '调试接口', 'draft-flow': '生成新流程', query: '查询平台', error: '没听懂' };

/* ── 对话持久化：侧边栏关闭再打开不丢轨迹 ── */
const CHAT_KEY = 'apiflow.chat';
function persistChat() {
  try {
    const msgs = S.msgs.slice(-40).map(m => ({ id: m.id, role: m.role, text: m.text || '', plan: m.plan || null, runId: m.runId || null }));
    localStorage.setItem(CHAT_KEY, JSON.stringify({ ts: Date.now(), msgs }));
  } catch { /* 存不下就算了 */ }
}
async function restoreChat() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CHAT_KEY) || 'null'); } catch { return; }
  if (!saved || !(saved.msgs || []).length) return;
  for (const m of saved.msgs) {
    if (m.role === 'user') { pushMsg({ role: 'user', text: m.text }); continue; }
    const nm = pushMsg({ role: 'agent', text: m.text, plan: m.plan, runId: m.runId });
    if (m.plan) { nm.el.innerHTML = planHTML(m.plan, nm); attachPlanHandlers(nm); }
    else if (m.text) nm.el.innerHTML = `<div class="agent-text">${esc(m.text)}</div>`;
    if (m.runId) attachTrace(nm, m.runId);
  }
  scrollBottom();
}

function toast(text, bad) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}
async function openWeb(path) {
  const url = (S.cfg ? APF.base(S.cfg) : '') + (path || '/');
  if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url });
  else window.open(url, '_blank');
}

/* ───────── 启动 / 连接 ───────── */
async function init() {
  S.cfg = await APF.getCfg();
  fillSettings();
  bind();
  await connect();
  await restoreChat();     // 恢复上次对话与执行轨迹（侧边栏重开不丢）
}
async function connect() {
  const r = await APF.ping();
  S.server = r.data || {};
  paintBadge(r);
  $('#srvChip').textContent = APF.base(S.cfg).replace(/^https?:\/\//, '');
  if (r.ok) await loadBootstrap();
  openSSE();
}
function paintBadge(r) {
  const b = $('#authBadge');
  const d = r.data || {};
  if (!r.ok && r.status === 0) { b.textContent = '离线'; b.className = 'badge bad'; b.title = d.error || '连不上 APIFlow 服务'; return; }
  if (d.requireAuth && !d.authenticated) {
    b.textContent = '需要认证'; b.className = 'badge warn';
    b.title = d.credInvalid ? '本地凭证已失效：点 ⚙ 用 AK/SK 重新获取令牌' : '平台已开启强制认证：点 ⚙ 填 AK/SK 或换取令牌';
    return;
  }
  // 开了认证且过了闸门，就把「用什么身份」说清楚，方便对照运行记录里的 actor
  if (d.requireAuth && d.authenticated) {
    b.textContent = '已认证'; b.className = 'badge ok';
    b.title = S.cfg.authMode === 'aksk' ? '以 AK/SK 直签身份访问' : '以令牌身份访问';
    return;
  }
  b.textContent = '已连接'; b.className = 'badge ok';
  b.title = '平台未开启强制认证，与本机控制台同权限';
}
async function loadBootstrap() {
  const r = await APF.request('/api/ext/bootstrap');
  if (!r.ok) { if (r.status !== 401) toast(r.data.error || '加载失败', true); return; }
  S.boot = r.data;
  renderFlows();
  renderObs();
}

/* ───────── SSE ───────── */
async function openSSE() {
  if (S.sseCtl) S.sseCtl.abort();
  S.sseCtl = new AbortController();
  const signal = S.sseCtl.signal;
  await APF.openStream(S.cfg, {
    signal,
    onEvent: (event, p) => handleEvent(event, p && p.data),
    onStatus: st => {
      paintSSE(st);
      if (st === 'closed' || st === 'error') {
        clearTimeout(S.sseTimer);
        S.sseTimer = setTimeout(() => { if (S.sseCtl) openSSE(); }, 4000);
      }
    },
  });
}
// SSE 连接状态落在服务地址小徽标上：断线时变灰点提示，重连成功自动恢复
function paintSSE(st) {
  const chip = $('#srvChip');
  if (!chip) return;
  chip.classList.toggle('sse-off', st === 'closed' || st === 'error');
  chip.title = st === 'closed' || st === 'error'
    ? '实时事件流已断开，正在自动重连…（轨迹会用轮询兜底补全）'
    : '点击修改服务地址';
  if ((st === 'closed' || st === 'error') && !S.sseWarned) { S.sseWarned = true; toast('实时连接断开，正在重连…', true); }
  if (st === 'open') S.sseWarned = false;
}
function handleEvent(event, d) {
  if (!d || !d.runId) return;
  // 同一次运行可能同时显示在对话轨迹和观测详情里 —— 都要喂到
  for (const t of Object.values(S.traces)) {
    if (t.runId !== d.runId) continue;
    applyEvent(t, event, d);
    if (event === 'run_end') { hydrateTrace(t); clearTimeout(t.fbTimer); }
    paintTrace(t);
  }
  // run_end 后无论在哪个页签都刷新流程/观测列表 —— Web 端执行的运行也要在这里出现
  if (event === 'run_end') loadBootstrap();
  else if (S.tab === 'obs' && event === 'run_start') loadBootstrap();
}
function applyEvent(t, event, d) {
  t.events = t.events || [];
  t.events.push({ event, data: d, ts: Date.now() });
  if (t.events.length > 200) t.events.splice(0, t.events.length - 200);
  if (event === 'run_start') { t.input = d.input; t.num = d.num; t.actor = d.actor; t.meta = d.meta; }
  if (event === 'node_start' && d.node) {
    t.nodes[d.node] = { ...(t.nodes[d.node] || {}), id: d.node, name: d.name, type: d.type, status: 'running' };
    if (!t.order.includes(d.node)) t.order.push(d.node);
  }
  if (event === 'node_end' && d.node) {
    t.nodes[d.node] = { ...(t.nodes[d.node] || {}), status: d.status, ms: d.ms, httpStatus: d.httpStatus, output: d.output, error: d.error, branch: d.branch, attempts: d.attempts, auth: d.auth };
  }
  if (event === 'node_retry' && d.node) {
    const n = t.nodes[d.node] = t.nodes[d.node] || { id: d.node, status: 'running' };
    n.retry = `第 ${d.attempt}/${d.of} 次重试`;
  }
  if (event === 'assert_fail' && d.node) t.nodes[d.node].assertFails = d.fails;
  if (event === 'error') t.error = d.error;
  if (event === 'run_end') { t.status = d.status; t.durationMs = d.durationMs; }
  if (event === 'edge_data') { t.edges = t.edges || []; t.edges.push({ from: d.from, to: d.to, data: d.data }); }
}

// run 结束后拉完整运行记录：SSE 里的 output 是截断摘要，请求/响应细节要看全量
async function hydrateTrace(t) {
  const r = await APF.request('/api/runs/' + t.runId);
  if (!r.ok) return;
  const run = r.data;
  t.full = true;
  t.status = run.status; t.durationMs = run.durationMs; t.input = run.input; t.actor = run.actor; t.meta = run.meta; t.error = run.error;
  for (const [id, n] of Object.entries(run.nodes || {})) {
    t.nodes[id] = { ...(t.nodes[id] || {}), ...n, id };
  }
  t.order = Object.keys(run.nodes || {});
  t.events = run.events || [];
  paintTrace(t);
  if (S.obsSel === t.runId) renderObsDetail(t.runId);
}

// 兜底：SSE 断线时轨迹会一直卡在「等待节点事件」—— 定时直接拉运行记录补全，直到跑完为止
function armTraceFallback(t) {
  clearTimeout(t.fbTimer);
  const tick = async () => {
    if (!t.host || !t.host.isConnected) return;
    if (t.status === 'running') {
      await hydrateTrace(t);
      if (t.status === 'running') t.fbTimer = setTimeout(tick, 3000);
    }
  };
  t.fbTimer = setTimeout(tick, 3500);
}

// 把某次运行绑定到一条消息下面（恢复历史对话 / 重新打开详情都用它）
function attachTrace(m, runId) {
  const host = document.createElement('div');
  m.el.appendChild(host);
  host.innerHTML = '<div class="trace"><div class="listnote">恢复执行记录…</div></div>';
  const t = { id: uid('t'), runId, status: 'running', nodes: {}, order: [], events: [] };
  S.traces[t.id] = t;
  t.host = host;
  hydrateTrace(t);          // 已结束的运行直接拿全量；还在跑的由 SSE + 兜底轮询继续更新
  armTraceFallback(t);
  return t;
}

/* ───────── 轨迹渲染 ───────── */
const stIcon = s => ({ running: '<span class="st run">◐</span>', done: '<span class="st ok">✓</span>', reused: '<span class="st ok">✓</span>', failed: '<span class="st fail">✕</span>', skipped: '<span class="st skip">–</span>' }[s] || '<span class="st skip">·</span>');
const dotCls = s => ({ running: 'running', success: 'success', failed: 'failed' }[s] || '');

function traceHTML(t) {
  const status = t.status || 'running';
  const rows = (t.order || []).map(id => {
    const n = t.nodes[id] || {};
    const info = n.status === 'failed'
      ? `<span class="info"><span class="bad">${esc((n.error || '失败').slice(0, 40))}</span></span>`
      : `<span class="info">${n.httpStatus ? 'HTTP ' + n.httpStatus + ' · ' : ''}${n.ms != null ? fmtMs(n.ms) : ''}</span>`;
    const mth = n.request ? `<span class="mth">${esc(n.request.method || '')}</span>` : (n.type ? `<span class="mth">${esc(n.type)}</span>` : '');
    return `<div class="nrow" data-node="${esc(id)}">${stIcon(n.status)}${mth}<span class="nm">${esc(n.name || id)}</span>${info}</div>`;
  }).join('');
  const errLine = t.error ? `<div class="ndetail"><div class="errline">✕ ${esc(t.error)}</div></div>` : '';
  const evs = (t.events || []).slice(-40).map(e => {
    const cls = e.event === 'error' || e.event === 'assert_fail' ? 'bad' : e.event === 'run_end' && e.data.status === 'success' ? 'ok' : '';
    return `<div class="${cls}">${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}  ${esc(e.event)}  ${esc(JSON.stringify(e.data).slice(0, 110))}</div>`;
  }).join('');
  return `
    <div class="trace" data-trace="${esc(t.id)}">
      <div class="thead">
        <span class="dot ${dotCls(status)}"></span>
        <span class="st">${status === 'running' ? '运行中' : status === 'success' ? '成功' : status === 'failed' ? '失败' : esc(status)}</span>
        <span class="ms">${t.durationMs != null ? fmtMs(t.durationMs) : ''}${t.meta && t.meta.dryRun ? ' · 只读试跑' : ''}${t.actor ? ' · ' + esc(t.actor) : ''}</span>
        <span class="sp"></span>
        <a data-web="${esc(t.runId)}">Web 查看</a>
      </div>
      <div class="nodes">${rows || '<div class="listnote">等待节点事件…</div>'}</div>
      ${errLine}
      ${evs ? `<div class="evlog">${evs}</div>` : ''}
    </div>`;
}

function paintTrace(t) {
  const host = t.host;
  if (!host || !host.isConnected) return;
  const openNode = host.dataset.openNode;
  host.innerHTML = traceHTML(t);
  if (openNode && t.nodes[openNode]) {
    const row = host.querySelector(`.nrow[data-node="${openNode}"]`);
    if (row) row.insertAdjacentHTML('afterend', nodeDetailHTML(t, openNode));
    host.dataset.openNode = openNode;
  }
  host.querySelectorAll('.nrow').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.node;
      const existed = host.querySelector('.ndetail');
      host.querySelectorAll('.ndetail').forEach(x => x.remove());
      if (existed && existed.dataset.node === id) { delete host.dataset.openNode; return; }
      row.insertAdjacentHTML('afterend', nodeDetailHTML(t, id));
      host.dataset.openNode = id;
    };
  });
  const web = host.querySelector('[data-web]');
  if (web) web.onclick = () => openWeb('/');
}

function nodeDetailHTML(t, id) {
  const n = t.nodes[id] || {};
  const out = n.output != null ? (() => { try { return JSON.stringify(typeof n.output === 'string' ? JSON.parse(n.output) : n.output, null, 1); } catch { return String(n.output); } })() : '—';
  const tries = (n.attempts || []).map(a => `  第${a.n}次 · ${a.status || '—'} · ${a.ms}ms${a.error ? ' · ' + a.error : ''}`).join('\n');
  return `<div class="ndetail" data-node="${esc(id)}">
    ${n.error ? `<div class="errline">✕ ${esc(n.error)}</div>` : ''}
    ${n.assertFails ? `<div class="errline">断言失败：${esc(n.assertFails.join('；'))}</div>` : ''}
    ${n.retry ? `<div class="errline">↻ ${esc(n.retry)}</div>` : ''}
    ${n.auth ? `<h5>认证</h5><pre>${esc(n.auth)}</pre>` : ''}
    ${n.request ? `<h5>请求 / 响应</h5><pre>${esc(JSON.stringify(n.request, null, 1))}</pre>` : ''}
    ${tries ? `<h5>重试记录</h5><pre>${esc(tries)}</pre>` : ''}
    <h5>输出</h5><pre>${esc(out)}</pre>
  </div>`;
}

/* ───────── 对话 ───────── */
function pushMsg(m) {
  m.id = m.id || uid('m');
  S.msgs.push(m);
  const list = $('#chatList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = m.role === 'user' ? 'msg-user' : 'msg-agent';
  if (m.role === 'user') el.textContent = m.text;
  el.dataset.mid = m.id;
  list.appendChild(el);
  m.el = el;
  list.scrollTop = list.scrollHeight;
  persistChat();
  return m;
}
function scrollBottom() { const l = $('#chatList'); l.scrollTop = l.scrollHeight; }

function planHTML(plan, m) {
  const kindCls = plan.kind === 'error' ? 'error' : plan.kind;
  let target = '', extra = '';
  if (plan.kind === 'run-flow' && plan.flow) target = `${esc(plan.flow.name)} <code>${plan.flow.published ? 'v' + plan.flow.version : '未发布 · 试跑'} · ${plan.flow.nodeCount || ''} 节点</code>`;
  if (plan.kind === 'debug-op' && plan.op) target = `${esc(plan.op.name)} <code>${esc(plan.op.method)} ${esc(plan.op.path)}</code>`;
  if (plan.kind === 'draft-flow' && plan.draft) target = `${esc(plan.draft.name)} <code>${(plan.draft.nodes || []).length} 个接口 · ${plan.draft.writeCount || 0} 个写操作</code>`;
  if (plan.kind === 'query') target = esc((plan.query || {}).kind || '');
  const args = Object.entries(plan.args || {}).map(([k, v]) => `<span class="argchip">${esc(k)}=${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`);
  for (const p of plan.missingParams || []) args.push(`<span class="argchip miss">${esc(p)} 缺值</span>`);
  if (plan.kind !== 'query' && (plan.args && Object.keys(plan.args).length || (plan.missingParams || []).length)) extra = `<div class="args">${args.join('')}</div>`;
  const refs = (plan.refs || []).map(r => `<span class="refchip" title="${esc((r.sig || '') + ' ' + (r.summary || ''))}">${esc((r.parent ? r.parent + '.' : '') + r.name)}</span>`).join('');
  const btns = plan.kind === 'error' ? '' : `
    <div class="acts">
      <button class="primary" data-act="exec">${plan.needsConfirm ? '确认执行' : '执行'}</button>
      ${plan.kind === 'query' ? '' : '<button data-act="web">Web 打开</button>'}
    </div>`;
  return `
    <div class="plan" data-mid="${m.id}">
      <span class="kind ${kindCls}">${KIND[plan.kind] || esc(plan.kind)}</span>
      ${target ? `<div class="target">${target}</div>` : ''}
      <div class="reason">${esc(plan.reason || plan.error || '')}</div>
      ${extra}
      ${refs ? `<div class="refs" style="margin-top:6px">${refs}</div>` : ''}
      ${btns}
    </div>`;
}

function attachPlanHandlers(m) {
  const plan = m.el.querySelector('.plan');
  if (!plan) return;
  const exec = plan.querySelector('[data-act="exec"]');
  if (exec) exec.onclick = () => executePlan(m, { confirm: m.plan.needsConfirm === true });
  const web = plan.querySelector('[data-act="web"]');
  if (web) web.onclick = () => openWeb('/');
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; input.style.height = 'auto';
  $('#btnSend').disabled = true;
  try {
    const um = pushMsg({ role: 'user', text });
    const am = pushMsg({ role: 'agent', text: '理解中…' });
    am.el.innerHTML = '<div class="agent-text">理解中…</div>';
    const r = await APF.request('/api/agent/plan', { method: 'POST', body: { text } });
    if (!r.ok) { am.el.innerHTML = `<div class="agent-text">⚠ ${esc(r.data.error || '解析失败')}</div>`; return; }
    am.plan = r.data.plan || { kind: 'error', error: r.data.error };
    am.text = text;
    am.el.innerHTML = planHTML(am.plan, am);
    attachPlanHandlers(am);
    scrollBottom();
    // 不需要确认的动作直接执行；查询类也直接跑
    if (am.plan.kind !== 'error' && !am.plan.needsConfirm) await executePlan(am, {});
  } catch (e) {
    pushMsg({ role: 'agent', text: '⚠ ' + (e.message || e) }).el;
  } finally { $('#btnSend').disabled = false; input.focus(); }
}

async function executePlan(m, { confirm }) {
  const planEl = m.el.querySelector('.plan');
  const btn = planEl && planEl.querySelector('[data-act="exec"]');
  if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
  try {
    const r = await APF.request('/api/agent/execute', { method: 'POST', body: { text: m.text, confirm: !!confirm }, timeout: 30000 });
    if (r.status === 428 || r.data.confirmRequired) {
      const p = r.data.preview || {};
      m.el.insertAdjacentHTML('beforeend', `
        <div class="trace"><div class="confirmbar">
          <span style="font-size:12px;color:var(--amber)">「${esc(p.name || '')}」是写操作，确认执行？</span>
          <span style="flex:1"></span>
          <button data-c="yes" class="primary">确认执行</button>
          <button data-c="no">取消</button>
        </div></div>`);
      m.el.querySelector('[data-c="yes"]').onclick = () => { m.el.querySelector('.confirmbar').parentElement.remove(); executePlan(m, { confirm: true }); };
      m.el.querySelector('[data-c="no"]').onclick = e => e.target.closest('.trace').remove();
      scrollBottom();
      return;
    }
    if (!r.ok) {
      const reason = r.data.plan && r.data.plan.reason;
      if (planEl) planEl.insertAdjacentHTML('beforeend', `<div class="reason" style="color:var(--bad)">✕ ${esc(r.data.error || '执行失败')}${reason ? '' : ''}</div>`);
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
      scrollBottom();
      return;
    }
    if (r.data.kind === 'query') {
      const q = r.data.query || {};
      m.el.insertAdjacentHTML('beforeend', `<div class="qres">${esc(q.text || '')}</div>`);
      scrollBottom();
      return;
    }
    const runId = r.data.runId;
    const plan = r.data.plan || m.plan;
    if (btn) { btn.textContent = '✓ 已执行'; }
    m.runId = runId;
    persistChat();
    const t = {
      id: uid('t'), runId, flowId: r.data.flowId, status: 'running',
      nodes: {}, order: [], events: [], input: r.data.input,
      dryRun: r.data.dryRun,
    };
    S.traces[t.id] = t;
    // 预填节点名（plan 里有目标信息时，运行开始前就能看到要跑什么）
    if (plan.kind === 'debug-op' && plan.op) t.order = [];
    const host = document.createElement('div');
    m.el.appendChild(host);
    t.host = host;
    paintTrace(t);
    armTraceFallback(t);   // SSE 万一断线，用轮询兜底把轨迹补出来
    scrollBottom();
    if (S.tab !== 'chat') switchTab('chat');
  } catch (e) {
    toast(e.message || String(e), true);
    if (btn) { btn.disabled = false; btn.textContent = '重试'; }
  }
}

/* ───────── 流程列表 ───────── */
function renderFlows() {
  const host = $('#flowList');
  if (!S.boot) { host.innerHTML = '<div class="loading">加载中…</div>'; return; }
  const kw = ($('#flowFilter').value || '').toLowerCase();
  const flows = S.boot.flows.filter(f => !kw || f.name.toLowerCase().includes(kw));
  if (!flows.length) { host.innerHTML = `<div class="listnote">${kw ? '没有匹配的流程' : '还没有流程 —— 在 Web 控制台用一句话创建'}</div>`; return; }
  host.innerHTML = flows.map(f => {
    const lr = f.lastRun;
    const pill = lr ? `<span class="stpill ${esc(lr.status)}">${lr.status === 'success' ? '成功' : lr.status === 'failed' ? '失败' : lr.status === 'running' ? '运行中' : esc(lr.status)}</span>` : '<span class="note" style="font-size:11px">未运行</span>';
    return `<div class="fcard" data-fid="${esc(f.id)}">
      <div class="r1"><b>${esc(f.name)}</b><span class="v ${f.published ? '' : 'draft'}">${f.published ? 'v' + f.version : '未发布'}</span><span style="flex:1"></span>${pill}</div>
      <div class="meta">${f.httpCount || f.nodeCount || 0} 个接口 · ${lr ? `最近 ${fmtAgo(lr.startedAt)}${lr.durationMs != null ? ' · ' + fmtMs(lr.durationMs) : ''}${lr.trigger ? ' · ' + (TRIG[lr.trigger] || lr.trigger) : ''}` : '还没有运行记录'}</div>
      <div class="r2">
        <button class="primary" data-a="run">${f.published ? '▶ 运行' : '▶ 试跑草稿'}</button>
        <button data-a="web">Web 打开</button>
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('.fcard').forEach(card => {
    const fid = card.dataset.fid;
    card.querySelector('[data-a="run"]').onclick = () => runFlow(fid);
    card.querySelector('[data-a="web"]').onclick = () => openWeb('/');
  });
}

async function runFlow(fid) {
  const f = (S.boot.flows.find(x => x.id === fid)) || {};
  const r = await APF.request('/api/agent/execute', { method: 'POST', body: { flowId: fid, text: '运行 ' + f.name } });
  if (!r.ok) { toast(r.data.error || '触发失败', true); return; }
  toast(`已触发「${f.name}」 · #${(r.data.runId || '').slice(-4)}`);
  switchTab('obs');
  openObsDetail(r.data.runId);   // 观测详情自带全量轨迹 + SSE 实时更新
}

/* ───────── 运行观测 ───────── */
async function renderObs() {
  const host = $('#obsList');
  if (!S.boot) { host.innerHTML = '<div class="loading">加载中…</div>'; return; }
  const runs = S.boot.runs || [];
  const ok = runs.filter(r => r.status === 'success').length;
  $('#obsSummary').textContent = `${S.boot.stats.flows} 流程 · ${runs.length} 次运行 · 成功率 ${S.boot.stats.successRate == null ? '—' : S.boot.stats.successRate + '%'}`;
  if (!runs.length) { host.innerHTML = '<div class="listnote">还没有运行记录</div>'; return; }
  host.innerHTML = runs.map(r => `
    <div class="fcard" data-rid="${esc(r.id)}">
      <div class="r1"><span class="stpill ${esc(r.status)}">${r.status === 'success' ? '成功' : r.status === 'failed' ? '失败' : r.status === 'running' ? '运行中' : esc(r.status)}</span>
        <b>${esc(r.flowName || r.flowId)}</b><span style="flex:1"></span><span class="note">#${r.num}</span></div>
      <div class="meta">${(TRIG[r.trigger] || r.trigger)}${r.actor ? ' · ' + esc(r.actor) : ''}${r.meta && r.meta.dryRun ? ' · 只读试跑' : ''} · ${fmtAgo(r.startedAt)}${r.durationMs != null ? ' · ' + fmtMs(r.durationMs) : ''}</div>
    </div>`).join('');
  host.querySelectorAll('.fcard').forEach(card => { card.onclick = () => openObsDetail(card.dataset.rid); });
}

async function openObsDetail(runId) {
  S.obsSel = runId;
  const d = $('#obsDetail');
  d.classList.remove('hidden');
  d.innerHTML = `<div class="dhead"><button class="iconbtn" id="obsBack">←</button><b>运行详情</b><span class="note">${runId.slice(-6)}</span></div><div class="dbody"><div class="loading">加载中…</div></div>`;
  $('#obsBack').onclick = () => { d.classList.add('hidden'); S.obsSel = null; };
  const r = await APF.request('/api/runs/' + runId);
  if (!r.ok) { d.querySelector('.dbody').innerHTML = `<div class="listnote">${esc(r.data.error || '加载失败')}</div>`; return; }
  const run = r.data;
  let t = S.traces['obs_' + runId];
  if (!t) {
    t = { id: 'obs_' + runId, runId, status: run.status, nodes: run.nodes || {}, order: Object.keys(run.nodes || {}), events: run.events || [], durationMs: run.durationMs, input: run.input, actor: run.actor, meta: run.meta, error: run.error, full: true };
    S.traces[t.id] = t;
  }
  const body = d.querySelector('.dbody');
  const loading = body.querySelector('.loading');
  if (loading) loading.remove();
  const host = document.createElement('div');
  body.appendChild(host);
  t.host = host;
  paintTrace(t);
  armTraceFallback(t);   // 还在跑的运行：SSE 断线也有轮询兜底
}

function renderObsDetail() { /* 由 openObsDetail / hydrateTrace 驱动 */ }

/* ───────── 设置 ───────── */
function fillSettings() {
  const c = S.cfg;
  $('#cfgServer').value = c.server || APF.DEFAULT_SERVER;
  $('#cfgToken').value = c.token || '';
  $('#cfgAk').value = c.ak || '';
  $('#cfgSk').value = c.sk || '';
  $$('#cfgMode button').forEach(b => b.classList.toggle('on', b.dataset.m === (c.authMode || 'auto')));
  paintModeRows();
}
function paintModeRows() {
  const mode = S.cfg.authMode || 'auto';
  $('#rowToken').classList.toggle('hidden', mode !== 'token');
  $('#rowAk').classList.toggle('hidden', mode === 'token');
  $('#rowSk').classList.toggle('hidden', mode === 'token');
}
function bind() {
  $$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.t));
  $('#btnSend').onclick = send;
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#input').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(110, e.target.scrollHeight) + 'px'; });
  $$('#tab-chat .exs button').forEach(b => b.onclick = () => { $('#input').value = b.dataset.q; send(); });
  $('#btnSettings').onclick = () => { $('#settings').classList.toggle('hidden'); };
  $('#btnReload').onclick = async () => { await connect(); toast('已刷新'); };
  $('#btnOpenWeb').onclick = () => openWeb('/');
  $('#srvChip').onclick = () => $('#settings').classList.remove('hidden');
  $$('#cfgMode button').forEach(b => b.onclick = () => {
    S.cfg.authMode = b.dataset.m;
    $$('#cfgMode button').forEach(x => x.classList.toggle('on', x === b));
    paintModeRows();
  });
  $('#btnSaveCfg').onclick = async () => {
    const patch = {
      server: $('#cfgServer').value.trim() || APF.DEFAULT_SERVER,
      token: $('#cfgToken').value.trim(),
      ak: $('#cfgAk').value.trim(),
      sk: $('#cfgSk').value,
      authMode: S.cfg.authMode || 'auto',
    };
    S.cfg = await APF.saveCfg(patch);
    const msg = $('#cfgMsg');
    msg.textContent = '连接中…'; msg.className = 'cfgmsg';
    const r = await APF.ping();
    if (r.ok) { msg.textContent = '✓ 已连接' + (r.data.requireAuth && !r.data.authenticated ? '（但平台要求认证 —— 检查令牌 / AK-SK）' : ''); msg.className = 'cfgmsg' + (r.data.requireAuth && !r.data.authenticated ? ' bad' : ' ok'); }
    else { msg.textContent = '✕ ' + (r.data.error || '连不上'); msg.className = 'cfgmsg bad'; }
    try { chrome.runtime.sendMessage({ type: 'apiflow.refresh' }); } catch { /* 非 extension 环境 */ }
    await connect();
  };
  $('#btnLogin').onclick = async () => {
    const ak = $('#cfgAk').value.trim(), sk = $('#cfgSk').value;
    if (!ak || !sk) return toast('先填 AK 和 SK', true);
    try {
      S.cfg = await APF.saveCfg({ ak, sk });
      await APF.login(S.cfg);
      S.cfg = await APF.getCfg();
      $('#cfgToken').value = S.cfg.token || '';
      $('#cfgMsg').textContent = '✓ 令牌已获取并保存'; $('#cfgMsg').className = 'cfgmsg ok';
      await connect();
    } catch (e) { $('#cfgMsg').textContent = '✕ ' + e.message; $('#cfgMsg').className = 'cfgmsg bad'; }
  };
  $('#flowFilter').addEventListener('input', renderFlows);
  $('#btnFlowsRefresh').onclick = loadBootstrap;
  $('#btnObsRefresh').onclick = loadBootstrap;
}

function switchTab(t) {
  S.tab = t;
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $$('.tabpane').forEach(p => p.classList.toggle('on', p.id === 'tab-' + t));
  if (t === 'flows' || t === 'obs') loadBootstrap();
  if (t === 'obs') { $('#obsDetail').classList.add('hidden'); S.obsSel = null; }
}

init();

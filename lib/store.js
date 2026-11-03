// ── 存储层：设计图中的 PostgreSQL / 对象存储 以 JSON 文件实现 ──
// flows:    流程定义 + 版本历史（对应 PG「流程 DSL 版本」）
// runs:     运行历史（每次 run = DSL 版本 + 节点输入输出，可重放/可 diff/可审计）
// catalog:  工具注册表缓存（ETag + 版本）
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 克隆下来就能跑：首次启动时数据目录还不存在，save() 会直接 ENOENT
fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch { return fallback; }
}
function save(name, data) {
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

class Store {
  constructor() {
    this.flows = load('flows.json', {});      // id -> { id, name, createdAt, published:{def,version,publishedAt}, draft:{def,status,gates,chat}, runs:[] }
    this.runs  = load('runs.json', []);       // [{...run}]  最新在前，上限 500
    this.alerts = load('alerts.json', []);    // 接口变更告警
    this.sources = load('sources.json', { rev: 0, items: [] });   // 外部接入的接口来源（OpenAPI / 手工）
    if (!Array.isArray(this.sources.items)) this.sources = { rev: 0, items: [] };
    this.creds = load('creds.json', { items: [], opBindings: {} });  // AK/SK 凭证 + 单接口级绑定
    if (!Array.isArray(this.creds.items) || typeof this.creds.opBindings !== 'object') this.creds = { items: [], opBindings: {} };
    this.ops = load('ops.json', { hidden: [], rev: 0 });   // 内置接口的「删除」= 隐藏（可恢复），来源接口不在此列
    if (!Array.isArray(this.ops.hidden)) this.ops = { hidden: [], rev: 0 };
    // 接口参数提示：运行期从真实网关的报错里学到的「必填参数 / 可用取值」
    // { <operationId>: { required:[], sample:{}, rejected:{}, lastError, updatedAt } }
    this.paramHints = load('paramhints.json', {});
    if (!this.paramHints || typeof this.paramHints !== 'object' || Array.isArray(this.paramHints)) this.paramHints = {};
    this._runSeq = this.runs.length ? Math.max(...this.runs.map(r => r.num || 0)) : 1000;
    this._runsDirty = false;
    this._runsTimer = null;
  }

  // ── 认证凭证（AK/SK）──
  listCreds() { return this.creds.items; }
  getCred(id) { return this.creds.items.find(c => c.id === id) || null; }
  opBindings() { return this.creds.opBindings; }
  saveCred(cred) { this.creds.items.unshift(cred); this.persistCreds(); return cred; }
  removeCred(id) {
    const before = this.creds.items.length;
    this.creds.items = this.creds.items.filter(c => c.id !== id);
    if (this.creds.items.length === before) return false;
    for (const [opId, cid] of Object.entries(this.creds.opBindings)) if (cid === id) delete this.creds.opBindings[opId];
    this.persistCreds();
    return true;
  }
  setOpBinding(operationId, credId) {
    if (credId) this.creds.opBindings[operationId] = credId; else delete this.creds.opBindings[operationId];
    this.persistCreds();
  }
  persistCreds() { save('creds.json', this.creds); }

  // ── 接口参数提示（运行期学习）──
  // 网关的校验是「一个参数一个参数地报」：先 poolId，补了再报 productType。
  // 报一次记一次，下次搭流程就能自动带上，不用再撞一遍。
  getParamHint(opId) { return opId ? (this.paramHints[opId] || null) : null; }
  allParamHints() { return this.paramHints; }
  learnParamHint(opId, { required = [], sample = {}, rejected = {}, lastError } = {}) {
    if (!opId) return null;
    const h = this.paramHints[opId] || (this.paramHints[opId] = { required: [], sample: {}, rejected: {} });
    h.required = Array.isArray(h.required) ? h.required : [];
    h.sample = h.sample && typeof h.sample === 'object' ? h.sample : {};
    h.rejected = h.rejected && typeof h.rejected === 'object' ? h.rejected : {};
    let dirty = false;
    for (const n of required) {
      if (!n || h.required.includes(n)) continue;
      h.required.push(n); dirty = true;
    }
    for (const [n, v] of Object.entries(sample || {})) {
      if (!n || v == null || String(v) === '') continue;
      const s = String(v);
      if (h.sample[n] === s) continue;
      h.sample[n] = s; dirty = true;
      if (Array.isArray(h.rejected[n])) h.rejected[n] = h.rejected[n].filter(x => x !== s);
    }
    for (const [n, v] of Object.entries(rejected || {})) {
      if (!n || v == null || String(v) === '') continue;
      const arr = Array.isArray(h.rejected[n]) ? h.rejected[n] : (h.rejected[n] = []);
      if (arr.includes(String(v))) continue;
      arr.push(String(v)); dirty = true;
    }
    if (lastError === null) {                       // 跑通了：清掉上次的报错
      if (h.lastError) { delete h.lastError; dirty = true; }
    } else if (lastError && h.lastError !== lastError) {
      h.lastError = String(lastError).slice(0, 300); dirty = true;
    }
    if (!dirty) return h;
    h.updatedAt = Date.now();
    save('paramhints.json', this.paramHints);
    return h;
  }
  dropParamHint(opId) {
    if (!this.paramHints[opId]) return false;
    delete this.paramHints[opId];
    save('paramhints.json', this.paramHints);
    return true;
  }
  persistParamHints() { save('paramhints.json', this.paramHints); }

  // ── 接口来源 ──
  listSources() { return this.sources.items; }
  getSource(id) { return this.sources.items.find(s => s.id === id) || null; }
  sourcesRev() { return this.sources.rev || 0; }
  saveSource(src) {
    const i = this.sources.items.findIndex(s => s.id === src.id);
    if (i >= 0) this.sources.items[i] = src; else this.sources.items.unshift(src);
    this.sources.rev = (this.sources.rev || 0) + 1;
    save('sources.json', this.sources);
    return src;
  }
  removeSource(id) {
    const before = this.sources.items.length;
    this.sources.items = this.sources.items.filter(s => s.id !== id);
    if (this.sources.items.length === before) return false;
    this.sources.rev = (this.sources.rev || 0) + 1;
    save('sources.json', this.sources);
    return true;
  }
  // 单独删掉来源下的某个接口（来源被删空时一并移除来源）
  removeSourceOp(sourceId, opId) {
    const src = this.getSource(sourceId);
    if (!src) return { ok: false, emptied: false };
    const i = (src.operations || []).findIndex(o => o.id === opId);
    if (i < 0) return { ok: false, emptied: false };
    src.operations.splice(i, 1);
    src.updatedAt = Date.now();
    if (!src.operations.length) { this.removeSource(sourceId); return { ok: true, emptied: true }; }
    this.saveSource(src);
    return { ok: true, emptied: false };
  }

  // ── 注册表接口的「删除」：内置接口隐藏（可恢复），来源接口移除 ──
  hiddenOps() { return this.ops.hidden; }
  opsRev() { return this.ops.rev || 0; }
  hideOps(ids) {
    let n = 0;
    for (const id of ids) if (!this.ops.hidden.includes(id)) { this.ops.hidden.push(id); n++; }
    if (n) { this.ops.rev = (this.ops.rev || 0) + 1; save('ops.json', this.ops); }
    return n;
  }
  restoreOps(ids) {                     // 不传 ids → 全部恢复
    const before = this.ops.hidden.length;
    this.ops.hidden = Array.isArray(ids) && ids.length ? this.ops.hidden.filter(id => !ids.includes(id)) : [];
    const n = before - this.ops.hidden.length;
    if (n) { this.ops.rev = (this.ops.rev || 0) + 1; save('ops.json', this.ops); }
    return n;
  }
  dropAlertsForOps(ids) {               // 接口删了，指向它的变更告警也就没意义了
    const set = new Set(ids), before = this.alerts.length;
    this.alerts = this.alerts.filter(a => !set.has(a.operationId));
    if (this.alerts.length !== before) save('alerts.json', this.alerts);
    return before - this.alerts.length;
  }

  // ── 流程 ──
  listFlows() { return Object.values(this.flows); }
  getFlow(id) { return this.flows[id] || null; }

  saveDraft(flowId, name, draft, chat) {
    let f = this.flows[flowId];
    if (!f) { f = this.flows[flowId] = { id: flowId, name, createdAt: Date.now(), versions: [] }; }
    f.name = name || f.name;
    f.draft = { def: draft, chat: chat || [], updatedAt: Date.now() };
    save('flows.json', this.flows);
    return f;
  }

  deleteFlow(flowId) {
    delete this.flows[flowId];
    this.runs = this.runs.filter(r => r.flowId !== flowId);
    save('flows.json', this.flows); save('runs.json', this.runs);
  }

  publish(flowId, def) {
    const f = this.flows[flowId];
    if (!f) throw new Error('flow not found: ' + flowId);
    const version = (f.published ? f.published.version : 0) + 1;
    const rec = {
      version,
      def,
      publishedAt: Date.now(),
      // 保存时绑定每个节点引用的接口版本 + 内容指纹（设计图：版本绑定）
      bindings: (def.nodes || []).filter(n => n.operationId).map(n => ({ node: n.id, operationId: n.operationId, apiVersion: n.apiVersion || null, apiHash: n.apiHash || null })),
    };
    f.published = rec;
    f.versions = f.versions || [];
    f.versions.push({ version: rec.version, publishedAt: rec.publishedAt });
    f.draft = null;
    save('flows.json', this.flows);
    return f;
  }

  // ── 运行 ──
  // 运行记录写盘做了合并：并行跑多个流程时每个节点都会更新 run，
  // 若每次都全量落盘（runs.json 已 2MB）会阻塞事件循环，反而拖慢并发。
  nextRunNum() { return ++this._runSeq; }
  addRun(run) {
    this.runs.unshift(run);
    if (this.runs.length > 500) this.runs.length = 500;
    this._touchRuns();
  }
  updateRun(run) { this._touchRuns(); }
  _touchRuns() {
    this._runsDirty = true;
    if (this._runsTimer) return;
    this._runsTimer = setTimeout(() => this.flushRuns(), 150);
    if (this._runsTimer.unref) this._runsTimer.unref();
  }
  flushRuns() {
    if (this._runsTimer) { clearTimeout(this._runsTimer); this._runsTimer = null; }
    if (!this._runsDirty) return;
    this._runsDirty = false;
    save('runs.json', this.runs);
  }
  getRun(id) { return this.runs.find(r => r.id === id) || null; }
  listRuns(flowId) { return this.runs.filter(r => !flowId || r.flowId === flowId).slice(0, 100); }
  // 删除单条运行记录：运行中的不删（引擎还在往这个对象里写节点状态，删了也白删）
  removeRun(id) {
    const i = this.runs.findIndex(r => r.id === id);
    if (i < 0) return { ok: false, reason: 'notfound' };
    if (this.runs[i].status === 'running') return { ok: false, reason: 'running' };
    this.runs.splice(i, 1);
    this._runsDirty = true;
    this.flushRuns();                     // 删除是用户显式动作，立刻落盘，不等 150ms 合并窗口
    return { ok: true };
  }
  // 清空运行记录（可按流程清）；运行中的记录一律保留
  clearRuns(flowId) {
    const before = this.runs.length;
    this.runs = this.runs.filter(r => r.status === 'running' || (flowId && r.flowId !== flowId));
    const n = before - this.runs.length;
    if (n) { this._runsDirty = true; this.flushRuns(); }
    return n;
  }

  // ── 告警（接口变更）──
  persistFlows() { save('flows.json', this.flows); }
  addAlert(a) { this.alerts.unshift({ ...a, at: Date.now() }); this.alerts = this.alerts.slice(0, 50); save('alerts.json', this.alerts); }
  listAlerts() { return this.alerts; }
  clearAlert(id) { this.alerts = this.alerts.filter(x => x.id !== id); save('alerts.json', this.alerts); }
  clearAllAlerts() { this.alerts = []; save('alerts.json', this.alerts); }
}

module.exports = { store: new Store() };

// ── 工具注册表（复用前轮设计）：API 目录 · ETag 热更新 · 接口版本绑定与失效告警 ──
const { renderStr } = require('./engine');

class Registry {
  constructor(catalogUrl, store) {
    this.catalogUrl = catalogUrl;
    this.store = store;
    this.etag = null;
    this.catalog = { version: null, operations: [] };
    this.listeners = [];
  }

  async start(pollMs = 5000) {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), pollMs);
  }

  // ETag 变更检测 —— 未变更时开销接近 0（If-None-Match → 304）
  async refresh() {
    const headers = this.etag ? { 'if-none-match': this.etag } : {};
    const res = await fetch(this.catalogUrl, { headers });
    if (res.status === 304) return false;
    if (!res.ok) throw new Error('catalog fetch ' + res.status);
    this.etag = res.headers.get('etag');
    const cat = await res.json();
    const changed = cat.version !== this.catalog.version;
    this.catalog = cat;
    if (changed) {
      this.checkBindings();          // 版本变更 → 扫描受影响流程 → 告警
      for (const l of this.listeners) try { l(cat); } catch {}
    }
    return changed;
  }

  get(opId) { return this.catalog.operations.find(o => o.id === opId) || null; }
  list() { return this.catalog.operations; }
  version() { return this.catalog.version; }

  // 流程节点保存时绑定的 apiVersion / apiHash 与目录当前值比对
  checkBindings() {
    const cur = this.catalog.version;
    for (const f of this.store.listFlows()) {
      const pub = f.published;
      if (!pub) continue;
      for (const b of pub.bindings || []) {
        const op = this.get(b.operationId);
        if (!op) continue;
        if (op.version && b.apiVersion && op.version !== b.apiVersion) {
          const id = `${f.id}:${b.operationId}:${b.apiVersion}->${op.version}`;
          if (!this.store.listAlerts().some(a => a.id === id)) {
            this.store.addAlert({
              id, type: 'api_changed', flowId: f.id, flowName: f.name,
              operationId: b.operationId, fromVersion: b.apiVersion, toVersion: op.version,
              message: `流程「${f.name}」依赖的接口 ${b.operationId} 已从 ${b.apiVersion} 升级到 ${op.version} —— 建议运行对比定位差异`,
            });
          }
        }
        // 版本号没变但内容变了（字段/参数被改）—— 只比版本号会漏，指纹才算数
        if (op.hash && b.apiHash && op.hash !== b.apiHash) {
          const id = `${f.id}:${b.operationId}:hash:${b.apiHash.slice(0, 6)}->${op.hash.slice(0, 6)}`;
          if (!this.store.listAlerts().some(a => a.id === id)) {
            this.store.addAlert({
              id, type: 'api_spec_drift', flowId: f.id, flowName: f.name,
              operationId: b.operationId, fromHash: b.apiHash, toHash: op.hash,
              message: `流程「${f.name}」依赖的接口 ${b.operationId} 内容已变更（版本号未变，指纹 ${b.apiHash.slice(0, 6)}→${op.hash.slice(0, 6)}）—— 请核对字段后重新发布`,
            });
          }
        }
      }
    }
  }

  // 操作 → HTTP 节点（工具注册表与执行器的关联点：operationId 渲染为可执行请求）
  toNode(op, paramValues = {}) {
    const url = renderStr(op.path, paramValues);
    const node = {
      id: op.id.replace(/[^a-zA-Z0-9_]/g, '_'),
      type: 'http', name: op.name || op.id,
      operationId: op.id, apiVersion: op.version,
      config: { method: op.method, url: (op.baseUrl || this.catalog.baseUrl || '') + url },
      retry: op.readOnly !== false && /^GET$/i.test(op.method)
        ? { maxAttempts: 3, backoffMs: 300 }
        : { maxAttempts: 1, backoffMs: 300 },
    };
    if (op.hash) node.apiHash = op.hash;        // 发布时随绑定一起存，用于指纹漂移检测
    if (op.bodySchema && !/^GET$/i.test(op.method)) node.config.body = op.bodyExample || {};
    if (!/^GET$/i.test(op.method)) node.idempotencyKey = '{{run.num}}-' + node.id;  // 写操作默认幂等键
    return node;
  }
}

module.exports = { Registry };

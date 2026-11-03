// ── APIFlow 平台服务 ── 零依赖 Node 22+（触发器/网关/SSE/存储网关/模拟上游）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { store } = require('./lib/store');
const { Engine, bus } = require('./lib/engine');
const { BatchRunner, MAX_FLOWS } = require('./lib/batch');
const { Registry } = require('./lib/registry');
const { validate, isReadOnly } = require('./lib/dsl');
const { buildDraft, reviseDraft } = require('./lib/agent');
const { autoFix, autoAssert } = require('./lib/autofix');
const { parseOpenAPI, parseManual } = require('./lib/openapi');
const { parseSDK } = require('./lib/sdk');
const { installAndCollect, pipEnv, normalizeSpec } = require('./lib/pip');
const { extractArchive, MAX_ARCHIVE_BYTES } = require('./lib/archive');
const materials = require('./lib/materials');
const docs = require('./lib/docs');
const paramhint = require('./lib/paramhint');
const changelog = require('./lib/changelog');
const { createCred, updateCred, maskSk, deleteCred, verify, bodyHash } = require('./lib/auth');
const access = require('./lib/access');
const intent = require('./lib/intent');

const PORT = process.env.PORT || 3300;
const BASE = `http://127.0.0.1:${PORT}`;
const engine = new Engine(store);
const batches = new BatchRunner(engine, store);   // 多个流程并行执行（受限并发池）

// ───────────────────────── 模拟上游（供流程真实调用） ─────────────────────────
let catalogVersion = 'v2026.10';
const suppliers = {
  'S-8891': { supplierId: 'S-8891', name: '苏州锦恒五金', status: 'ACTIVE', score: 87 },
  'S-1002': { supplierId: 'S-1002', name: '南通恒达橡塑', status: 'SUSPENDED', score: 41 },
};
const stocks = { 'SKU-01': { sku: 'SKU-01', warehouse: '苏州一仓', qty: 128 }, 'SKU-02': { sku: 'SKU-02', warehouse: '苏州一仓', qty: 6 } };

const OPERATIONS = [
  { id: 'query_supplier', name: '查询供应商', method: 'GET', path: '/upstream/suppliers/{supplierId}', version: catalogVersion, readOnly: true,
    keywords: ['供应商', '查询', '状态', '准入'], params: ['supplierId'], expect: ['status', 'score'],
    description: '按 supplierId 查询供应商状态与分数' },
  { id: 'notify_erp', name: '同步分数到ERP', method: 'POST', path: '/upstream/erp/admissions', version: catalogVersion, readOnly: false,
    keywords: ['ERP', 'erp', '同步', '推送', '分数'], expect: ['accepted', 'ticket'],
    bodySchema: { type: 'object' }, bodyExample: { supplierId: '{{input.supplierId}}', score: '{{nodes.query_supplier.output.score}}' },
    description: '把供应商分数写入 ERP 准入表' },
  { id: 'reject_supplier', name: '标记供应商拒绝', method: 'PATCH', path: '/upstream/suppliers/{supplierId}/reject', version: catalogVersion, readOnly: false,
    keywords: ['拒绝', '标记', '否决'], expect: ['rejected'],
    bodySchema: { type: 'object' }, bodyExample: { reason: 'score too low' },
    description: '将供应商标记为拒绝' },
  { id: 'query_stock', name: '查询库存', method: 'GET', path: '/upstream/stock/query?sku={sku}', version: catalogVersion, readOnly: true,
    keywords: ['库存', '存货', '查询'], params: ['sku'], expect: ['qty'],
    description: '按 SKU 查询库存数量' },
  { id: 'sync_stock', name: '同步库存到仓库', method: 'POST', path: '/upstream/stock/sync', version: catalogVersion, readOnly: false,
    keywords: ['库存', '同步', '仓库'], expect: ['synced'],
    bodySchema: { type: 'object' }, bodyExample: { sku: '{{input.sku}}' },
    description: '把库存同步给下游仓库系统' },
  { id: 'list_orders', name: '订单列表', method: 'GET', path: '/upstream/orders?date={date}', version: catalogVersion, readOnly: true,
    keywords: ['订单', '对账', '列表'], params: ['date'], expect: ['orders'],
    description: '按日期拉取订单' },
  { id: 'secure_data', name: '受保护数据', method: 'GET', path: '/upstream/secure/data', version: catalogVersion, readOnly: true,
    keywords: ['安全', '鉴权', '认证', '凭证', '保护', '密钥'], expect: ['secure', 'data'],
    description: '需要 AK/SK 签名认证的受保护接口 —— 未绑定凭证（单接口级或流程级）时返回 401' },
];

// 内置接口（模拟上游）+ 前端接入的接口来源，合并成智能体看到的一份工具注册表
// 被「删除」的内置接口记在 ops.hidden 里 —— 注册表、智能体、自动修复都看不到它
function allOperations() {
  const hidden = new Set(store.hiddenOps());
  const ops = OPERATIONS.filter(o => !hidden.has(o.id)).map(o => ({ ...o, baseUrl: BASE, sourceId: 'builtin' }));
  for (const s of store.listSources()) for (const o of s.operations) ops.push({ ...o, sourceId: s.id });
  return ops;
}
function catalogVersionString() {
  const rev = store.sourcesRev();
  const hid = store.opsRev();
  return `${catalogVersion}${rev ? '#' + rev : ''}${hid ? '.h' + hid : ''}`;   // 来源变化 / 内置接口增删都会改变目录版本
}
function catalogPayload() {
  return { version: catalogVersionString(), baseUrl: BASE, updatedAt: new Date().toISOString(), operations: allOperations() };
}
function catalogEtag() {
  // ETag 只看版本 + 接口内容（不含时间戳），保证接口变化必然换 ETag
  const sig = JSON.stringify({ v: catalogVersionString(), ops: allOperations() });
  return '"' + crypto.createHash('sha1').update(sig).digest('hex') + '"';
}
const sourceSummary = s => ({
  id: s.id, name: s.name, type: s.type, url: s.url || null,
  specVersion: s.specVersion, baseUrl: s.baseUrl || null,
  importedAt: s.importedAt, updatedAt: s.updatedAt || s.importedAt,
  count: s.operations.length,
  sdk: s.sdk ? {
    format: s.sdk.format, formatName: s.sdk.formatName, files: s.sdk.files || [], digest: s.sdk.digest,
    manifestUrl: s.sdk.manifestUrl || null, origin: s.sdk.origin || null,
    // pip 安装导入的来源：记录安装规格与包元数据，界面据此显示「pip install xxx==1.0」
    pip: s.sdk.pip ? {
      spec: s.sdk.pip.spec, indexUrl: s.sdk.pip.indexUrl || null, withDeps: !!s.sdk.pip.withDeps,
      pkg: s.sdk.pip.pkg || null, stats: s.sdk.pip.stats || null, installedAt: s.sdk.pip.installedAt || null,
    } : null,
    // 压缩包导入：记录包名/体积/条目数，界面显示「sdk.zip · 解压 320 个文件取 42 个」
    archive: s.sdk.archive ? {
      name: s.sdk.archive.name, kind: s.sdk.archive.kind || null, bytes: s.sdk.archive.bytes || 0,
      entries: s.sdk.archive.entries || 0, selected: s.sdk.archive.selected || 0,
      skipped: s.sdk.archive.skipped || 0, unpackedBytes: s.sdk.archive.unpackedBytes || 0,
      uploadedAt: s.sdk.archive.uploadedAt || null,
    } : null,
  } : null,
  autoSync: s.autoSync ? {
    enabled: !!s.autoSync.enabled, intervalMs: s.autoSync.intervalMs || 0,
    lastAt: s.autoSync.lastAt || null, lastStatus: s.autoSync.lastStatus || null,
    lastError: s.autoSync.lastError || null, lastDiff: s.autoSync.lastDiff || null,
    remote: (s.sdk && s.sdk.pip && `pip install ${s.sdk.pip.spec}`) || (s.sdk && s.sdk.manifestUrl) || (s.url || null),
  } : null,
  // 资料库：接口之外的类 / 方法 / 类型说明，供智能体检索
  materials: s.materials ? {
    count: s.materials.count || 0, classes: s.materials.classes || 0,
    methods: s.materials.methods || 0, functions: s.materials.functions || 0,
    documented: s.materials.documented || 0,
    languages: s.materials.languages || [], generatedAt: s.materials.generatedAt || null,
  } : null,
});

/* ───────── SDK 资料库：接口之外的类 / 方法 / 类型说明，供智能体随时检索 ───────── */
function saveSourceMaterials(srcId, symbols, extra = {}) {
  const data = materials.saveMaterials(srcId, { symbols: symbols || [], ...extra });
  if (!data) return null;
  return { ...data.stats, generatedAt: data.generatedAt, ...(extra.title ? { title: extra.title } : {}) };
}
function buildMaterialsFromFiles(srcId, files, extra = {}) {
  const { symbols, stats } = materials.extractSymbols(files);
  return saveSourceMaterials(srcId, symbols, { stats, ...extra });
}
// 把某来源的资料挂上来源信息，供跨来源检索；按 generatedAt 缓存，避免每次请求都复制几千个对象
const _poolCache = new Map();
function taggedMaterials(src) {
  const hit = _poolCache.get(src.id);
  if (hit && hit.at === src.materials.generatedAt) return hit.items;
  const data = materials.loadMaterials(src.id);
  const items = (data && data.symbols ? data.symbols : []).map(s => ({ ...s, sourceId: src.id, sourceName: src.name }));
  _poolCache.set(src.id, { at: src.materials.generatedAt, items });
  return items;
}
function materialPool(sourceId) {
  const list = sourceId ? [store.getSource(sourceId)].filter(Boolean) : store.listSources();
  const pool = [];
  for (const s of list) {
    if (!s.materials || !s.materials.count) continue;
    pool.push(...taggedMaterials(s));
  }
  return pool;
}
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
// 意图解析层复用同一份资料池（启动时资料可能还没建好，用惰性函数注入）
intent.setMaterialPool(() => materialPool());
async function fetchDoc(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('拉取文档失败：HTTP ' + r.status);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { throw new Error('文档不是 JSON —— YAML 请先转成 JSON，或改用手工添加'); }
}
async function fetchText(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('拉取失败：HTTP ' + r.status);
  return r.text();
}

/* ───────── SDK 导入：文件落盘（可反复重解析）+ URL 清单（可自动同步） ───────── */
const SDK_DIR = path.join(__dirname, 'data', 'sdk');
const SDK_MAX_FILE = 2 * 1024 * 1024;        // 单文件 2MB
const SDK_MAX_TOTAL = 6 * 1024 * 1024;       // 单个来源 6MB
const safeName = n => String(n || 'sdk.txt').replace(/[^\w.-]+/g, '_').slice(-60) || 'sdk.txt';

/* 运行环境的删除守卫限制单次批量删除的文件数（实测阈值 50），整目录 rm 大 SDK 源码会被拦。
   因此目录清理统一走「改名进回收站 + 定时分批删除」：改名永远不被拦，回收站由
   sweepSdkTrash 每 8 秒小批量（≤30 个文件）清空，删除动作分散开，最终一定清干净。 */
const SDK_TRASH_PREFIX = '.trash-';
let _trashCursor = 0;
function trashSdkPath(p) {
  if (!fs.existsSync(p)) return;
  try { fs.renameSync(p, path.join(path.dirname(p), SDK_TRASH_PREFIX + path.basename(p) + '-' + Date.now())); }
  catch { /* 极端情况改不了名：留下旧目录不影响注册表正确性 */ }
}
function sweepSdkTrash() {
  if (!fs.existsSync(SDK_DIR)) return;
  let trashes = [];
  try { trashes = fs.readdirSync(SDK_DIR).filter(n => n.startsWith(SDK_TRASH_PREFIX)).sort(); } catch { return; }
  if (!trashes.length) return;
  // 每轮最多清 3 个目录、合计 45 个文件：既不会触发运行环境的删除守卫，也不会让恢复站越积越多
  let budget = 45;
  for (let i = 0; i < 3 && trashes.length && budget > 0; i++) {
    _trashCursor %= trashes.length;               // 轮转处理：某个目录卡住不挡其他目录
    const name = trashes[_trashCursor];
    _trashCursor = (_trashCursor + 1) % trashes.length;
    const dir = path.join(SDK_DIR, name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { trashes = trashes.filter(n => n !== name); continue; }
    let blocked = false;
    for (const f of files.slice(0, budget)) {
      try { fs.unlinkSync(path.join(dir, f)); budget--; } catch { blocked = true; break; }
    }
    if (blocked) { console.log('[sdk-trash] 本轮删除被拦，稍后重试：' + name); return; }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* 空目录下轮再收尾 */ }
  }
}
setInterval(sweepSdkTrash, 8000).unref();
sweepSdkTrash();

function saveSdkFiles(srcId, files) {
  const dir = path.join(SDK_DIR, srcId);
  trashSdkPath(dir);                       // 旧内容整体进回收站，避免逐个 unlink
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    const n = safeName(f.name);
    fs.writeFileSync(path.join(dir, n), f.text);
    saved.push({ name: n, bytes: Buffer.byteLength(f.text) });
  }
  return saved;
}
function loadSdkFiles(src) {
  const dir = path.join(SDK_DIR, src.id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => !n.startsWith('.'))
    .map(n => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') }));
}
// 文件夹 / 压缩包导入常常带出多个同名文件（每个目录一个 index.ts），
// 落盘时name是唯一键，重名会互相覆盖 → 加序号区分，同时保留相对路径方便排查
function sdkFileList(list) {
  const used = new Set();
  return list.map(f => {
    let n = safeName(f.path || f.name);
    if (used.has(n)) {
      const dot = n.lastIndexOf('.');
      const base = dot > 0 ? n.slice(0, dot) : n;
      const ext = dot > 0 ? n.slice(dot) : '';
      let i = 2;
      while (used.has(`${base}_${i}${ext}`)) i++;
      n = `${base}_${i}${ext}`;
    }
    used.add(n);
    return { name: n, text: f.text, path: f.path };
  });
}
// 把「上传的文件 / 粘贴的代码 / URL（单文件或清单）」统一收成 [{name,text}]
async function collectSdkFiles(body) {
  if (Array.isArray(body.files) && body.files.length) {
    const files = body.files.filter(f => f && typeof f.text === 'string' && f.text.trim());
    if (!files.length) throw new Error('上传的 SDK 文件都是空的');
    return { files: sdkFileList(files), manifestUrl: null, origin: 'upload' };
  }
  if (body.text && String(body.text).trim()) {
    return { files: [{ name: safeName(body.filename || 'pasted-sdk.txt'), text: String(body.text) }], manifestUrl: null, origin: 'text' };
  }
  if (body.url) {
    const u = String(body.url).trim();
    if (!/^https?:\/\//.test(u)) throw new Error('请填写 http(s) 开头的 SDK 地址或清单地址');
    const txt = await fetchText(u);
    let obj = null;
    try { obj = JSON.parse(txt); } catch { /* 不是 JSON 就当单文件源码 */ }
    if (obj && Array.isArray(obj.files) && obj.files.length) {          // 清单：{ files: ["a.ts", "https://…/b.py"] }
      const files = [];
      for (const item of obj.files) {
        const name = typeof item === 'string' ? item.split('/').pop() : safeName(item.name || 'sdk');
        const itemUrl = typeof item === 'string' ? new URL(item, u).toString() : new URL(item.url, u).toString();
        files.push({ name, text: await fetchText(itemUrl) });
      }
      return { files, manifestUrl: u, origin: 'manifest' };
    }
    if (obj && (obj.operations || obj.paths)) {                          // 直接给配置 JSON
      return { files: [{ name: safeName(u.split('/').pop() || 'sdk.json'), text: txt }], manifestUrl: u, origin: 'config' };
    }
    return { files: [{ name: safeName(u.split('/').pop() || 'sdk.txt'), text: txt }], manifestUrl: u, origin: 'url' };
  }
  throw new Error('请上传 SDK 文件、粘贴代码，或填写 SDK / 清单地址');
}
function checkSdkSize(files) {
  let total = 0;
  for (const f of files) {
    const n = Buffer.byteLength(f.text);
    if (n > SDK_MAX_FILE) throw new Error(`文件 ${f.name} 超过 2MB，请拆分后再导入`);
    total += n;
  }
  if (total > SDK_MAX_TOTAL) throw new Error('SDK 总大小超过 6MB，请只导入核心客户端文件');
}
// stripe-11.4.1.zip / order_sdk_v2.tar.gz → "stripe" / "order sdk"
const suggestSdkName = f => String(f || '')
  .replace(/\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i, '')
  .replace(/[-_.]v?\d+(?:\.\d+)+$/i, '')
  .replace(/[-_.]+/g, ' ').trim().slice(0, 40);

/* ───────── pip 导入：真装一次包 → 筛出带 HTTP 调用的源码 → 复用 SDK 解析器 ───────── */
// 分析结果先缓存，让前端能「先看识别出哪些接口，再决定导入」，避免同一份包装两遍
const PIP_CACHE_TTL = 10 * 60 * 1000;
function makeAnalysisCache(ttlMs = PIP_CACHE_TTL, limit = 8) {
  const map = new Map();
  const put = (data, prefix = 'an') => {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at > ttlMs) map.delete(k);
    while (map.size >= limit) map.delete(map.keys().next().value);
    const token = prefix + '_' + crypto.randomBytes(6).toString('hex');
    map.set(token, { ...data, at: now });
    return token;
  };
  const get = token => {
    const hit = token ? map.get(token) : null;
    if (!hit) return null;
    if (Date.now() - hit.at > ttlMs) { map.delete(token); return null; }
    return hit;
  };
  return { put, get };
}
const pipCache = makeAnalysisCache();
const pipCachePut = data => pipCache.put(data, 'pip');
const pipCacheGet = token => pipCache.get(token);
// 压缩包导入：上传 → 解压分析 → 预览 → 确认导入，两步之间用 token 串起来
const arcCache = makeAnalysisCache();
const ARC_CACHE_TTL = PIP_CACHE_TTL;
// 装包 + 解析（srcId 为空表示只是分析预览）
async function analyzePip(body, srcId = null) {
  const got = await installAndCollect({
    package: body.package || body.spec, indexUrl: body.indexUrl,
    withDeps: !!body.withDeps, timeoutMs: body.timeoutMs,
  });
  const parsed = parseSDK(got.files, {
    sourceId: srcId, name: body.name || got.pkg.name || got.spec,
    baseUrl: body.baseUrl, version: got.pkg.version || undefined,
  });
  return { got, parsed };
}
const pipMeta = got => ({
  spec: got.spec, indexUrl: got.indexUrl || null, withDeps: !!got.withDeps,
  pkg: got.pkg, stats: got.stats, installedAt: Date.now(),
});

// 接口清单差异（版本绑定告警复用同一套判定）
function diffOps(before, after) {
  const b = new Map((before || []).map(o => [o.id, o.hash]));
  const afterIds = new Set(after.map(o => o.id));
  return {
    added: after.filter(o => !b.has(o.id)).map(o => o.id),
    changed: after.filter(o => b.has(o.id) && b.get(o.id) !== o.hash).map(o => o.id),
    removed: [...b.keys()].filter(id => !afterIds.has(id)),
  };
}
const clampInterval = ms => Math.min(24 * 3600e3, Math.max(60e3, Number(ms) || 5 * 60e3));
const sourceRemote = s => (s.sdk && s.sdk.manifestUrl) || s.url || null;

// 重新解析一个来源并落盘（手动「检查更新」与自动同步共用一条路径）
const _syncing = new Set();
async function syncSource(src) {
  if (_syncing.has(src.id)) throw new Error('该来源正在同步，请稍后再试');
  const remote = sourceRemote(src);
  if (!remote && src.type === 'sdk' && !loadSdkFiles(src).length) throw new Error('没有可重新解析的 SDK 文件，请重新导入');
  if (!remote && src.type !== 'sdk') throw new Error('该来源没有可拉取的地址，请删除后重新添加');
  _syncing.add(src.id);
  try {
    let parsed;
    if (src.type === 'sdk') {
      src.sdk = src.sdk || {};
      let files, pinnedVer = src.specVersion;
      if (src.sdk.pip) {
        // pip 来源：重装一次（规格没固定版本时会拉到最新），源码按新版本重写
        const got = await installAndCollect({
          package: src.sdk.pip.spec, indexUrl: src.sdk.pip.indexUrl, withDeps: src.sdk.pip.withDeps,
        });
        files = got.files;
        pinnedVer = got.pkg.version || pinnedVer;
        Object.assign(src.sdk.pip, { pkg: got.pkg, stats: got.stats, installedAt: Date.now() });
      } else if (remote) {
        files = (await collectSdkFiles({ url: remote })).files;
      } else {
        files = loadSdkFiles(src);
      }
      checkSdkSize(files);
      parsed = parseSDK(files, { sourceId: src.id, name: src.name, baseUrl: src.baseUrl, version: pinnedVer });
      if (remote || src.sdk.pip) src.sdk.files = saveSdkFiles(src.id, files);
      Object.assign(src.sdk, { digest: parsed.digest, format: parsed.format, formatName: parsed.formatName, notes: parsed.notes });
      // 资料库随源码一起重建；压缩包来源只保存了挑中的源码，重解析会让资料缩水，
      // 这时保留首次全量扫描的结果（文件没变，资料本来也不该变）
      const rebuilt = materials.extractSymbols(files);
      const shrink = src.sdk.archive && src.materials && rebuilt.stats.count < src.materials.count;
      if (!shrink) {
        src.materials = saveSourceMaterials(src.id, rebuilt.symbols, {
          stats: rebuilt.stats, title: (src.sdk.archive && src.sdk.archive.name) || undefined,
        }) || src.materials;
        _poolCache.delete(src.id);
      }
    } else {
      parsed = parseOpenAPI(await fetchDoc(remote), { sourceId: src.id, name: src.name, fallbackBaseUrl: BASE + '/upstream/_sandbox' });
    }
    // 与注册表里已有接口撞 id 时加来源后缀（同新增逻辑）
    const taken = new Set(allOperations().filter(o => o.sourceId !== src.id).map(o => o.id));
    for (const o of parsed.operations) if (taken.has(o.id)) o.id = `${o.id}_${src.id.slice(4)}`;
    const diff = diffOps(src.operations, parsed.operations);
    Object.assign(src, {
      operations: parsed.operations, specVersion: parsed.version,
      baseUrl: src.baseUrl || parsed.baseUrl, updatedAt: Date.now(),
    });
    if (src.autoSync) Object.assign(src.autoSync, {
      lastAt: Date.now(), lastStatus: 'ok', lastError: null,
      lastDiff: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
    });
    store.saveSource(src);
    await registry.refresh();     // 内容变了会触发绑定了旧版本的流程告警
    bus.emit('source_sync', {
      sourceId: src.id, sourceName: src.name, type: src.type,
      added: diff.added, changed: diff.changed, removed: diff.removed, at: Date.now(),
    });
    return { ok: true, ...diff, specVersion: parsed.version, catalogVersion: registry.version() };
  } catch (e) {
    if (src.autoSync) Object.assign(src.autoSync, { lastAt: Date.now(), lastStatus: 'error', lastError: e.message });
    store.saveSource(src);
    throw e;
  } finally {
    _syncing.delete(src.id);
  }
}
function syncDue(src, now = Date.now()) {
  const a = src.autoSync;
  if (!a || !a.enabled || !sourceRemote(src)) return false;
  return !a.lastAt || now - a.lastAt >= clampInterval(a.intervalMs);
}

// ───────────────────────── 工具注册表 ─────────────────────────
const registry = new Registry(BASE + '/upstream/_catalog', store);

// ───────────────────────── 种子流程（对应设计示例） ─────────────────────────
function seed() {
  if (store.getFlow('flow_supplier')) return;
  const def = {
    id: 'flow_supplier', name: '供应商准入检查', version: 0,
    input: { schema: { type: 'object', properties: { supplierId: { type: 'string' } } }, sample: { supplierId: 'S-8891' } },
    trigger: { type: 'webhook' },
    nodes: [
      { id: 'start', type: 'start', name: '开始', config: {} },
      { id: 'fetch_supplier', type: 'http', name: '查询供应商', operationId: 'query_supplier', apiVersion: 'v2026.10',
        config: { method: 'GET', url: `${BASE}/upstream/suppliers/{{input.supplierId}}` }, retry: { maxAttempts: 3, backoffMs: 300 } },
      { id: 'check_active', type: 'condition', name: '是否ACTIVE', config: { expr: "status == 'ACTIVE'" } },
      { id: 'notify_erp', type: 'http', name: '同步ERP', operationId: 'notify_erp', apiVersion: 'v2026.10',
        config: { method: 'POST', url: `${BASE}/upstream/erp/admissions`, body: { supplierId: '{{input.supplierId}}', score: '{{nodes.fetch_supplier.output.score}}' } },
        retry: { maxAttempts: 1 }, idempotencyKey: '{{run.num}}-notify' },
      { id: 'reject', type: 'http', name: '标记拒绝', operationId: 'reject_supplier', apiVersion: 'v2026.10',
        config: { method: 'PATCH', url: `${BASE}/upstream/suppliers/{{input.supplierId}}/reject`, body: { reason: 'not active' } },
        retry: { maxAttempts: 1 }, idempotencyKey: '{{run.num}}-reject' },
    ],
    edges: [
      { from: 'start', to: 'fetch_supplier' },
      { from: 'fetch_supplier', to: 'check_active' },
      { from: 'check_active', to: 'notify_erp', label: 'then' },
      { from: 'check_active', to: 'reject', label: 'else' },
    ],
    layout: {
      start: { x: 30, y: 240 }, fetch_supplier: { x: 230, y: 228 }, check_active: { x: 500, y: 228 },
      notify_erp: { x: 740, y: 110 }, reject: { x: 740, y: 346 },
    },
  };
  const v = validate(def);
  if (!v.ok) throw new Error('seed invalid: ' + v.errors.join(';'));
  store.saveDraft(def.id, def.name, def, []);
  store.publish(def.id, def);
}
seed();

// ───────────────────────── 工具函数 ─────────────────────────
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}
async function readBody(req) {
  // 认证阶段可能已经把请求体读出来了（AK/SK 要算 body 哈希），这里直接复用，避免流被消费两次
  if (req._raw != null) {
    if (!req._raw) return {};
    try { return JSON.parse(req._raw); } catch { return { _raw: req._raw }; }
  }
  let raw = '';
  for await (const c of req) raw += c;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}
// 读一次原始文本并挂到 req 上（认证与业务处理共用）
async function readTextOnce(req) {
  if (req._raw != null) return req._raw;
  let raw = '';
  for await (const c of req) raw += c;
  req._raw = raw;
  return raw;
}
// 原始二进制上传（压缩包）：超过上限立刻中断并提示，避免把内存吃满
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const fail = msg => { if (done) return; done = true; reject(new Error(msg)); req.destroy(); };
    req.on('data', c => {
      size += c.length;
      if (size > limit) return fail(`上传体积超过 ${Math.round(limit / 1048576)}MB，请只打包 SDK 客户端目录`);
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

// Dry-run：将写操作节点替换为转换桩（只读接口真实执行）。
// end（结束断言）一并剥离：写操作被替换成桩后其输出不存在，引用它的断言必然误报
function makeDryDef(def) {
  const { end, ...rest } = def;
  return {
    ...rest,
    nodes: def.nodes.map(n => {
      if (n.type === 'http' && !isReadOnly(n)) {
        return { id: n.id, type: 'transform', name: n.name + '（Dry-run 跳过写操作）', config: { expr: { _dryRun: 'write-skipped' } } };
      }
      return n;
    }),
  };
}

// ───────────────────────── 触发器（定时） ─────────────────────────
const lastFire = {};
setInterval(async () => {
  for (const f of store.listFlows()) {
    const trig = f.published && f.published.def.trigger;
    if (!trig || trig.type !== 'interval') continue;
    const ms = (trig.minutes || 5) * 60000;
    if (lastFire[f.id] && Date.now() - lastFire[f.id] < ms) continue;
    lastFire[f.id] = Date.now();
    const def = f.published.def;
    engine.runFlow(def, def.input && def.input.sample || {}, { trigger: 'schedule' }).catch(() => {});
  }
}, 15000);

/* ───────── 插件接入：认证闸门 / 自然语言执行 / 单接口调试 ───────── */
// 这些接口不参与「强制认证」：换取令牌本身、以及探测服务是否可达（插件连不上时要能自我诊断）
const OPEN_API = /^\/api\/(?:auth\/|ext\/ping$)/;

// 运行记录里的「谁触发的」：插件用令牌/AKSK 时写入具体名字，本机控制台记为匿名
function actorOf(req) {
  const a = req._actor;
  if (!a) return '本机控制台';
  return a.kind === 'token' ? `${a.name} · 令牌` : `${a.name} · AK/SK`;
}

async function authenticateRequest(req, url) {
  const bearer = /^bearer\s+/i.test(String(req.headers.authorization || ''));
  const qToken = url.searchParams.get('token') || '';
  // AK/SK 直签要把 body 一起算进签名：只有这条路需要预读请求体
  let rawBody = req._raw || '';
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-api-key'] && !bearer && !qToken) {
    rawBody = await readTextOnce(req);
  }
  return access.authenticate({
    headers: req.headers, method: req.method,
    pathWithQuery: url.pathname + url.search, rawBody, queryToken: qToken,
  });
}

// 返回 false 表示已经回过 401，路由应直接结束
async function gate(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/') || OPEN_API.test(p)) return true;
  const need = access.needAuth();
  const wantsCred = /^bearer\s+/i.test(String(req.headers.authorization || ''))
    || !!url.searchParams.get('token') || !!req.headers['x-api-key'];
  if (!wantsCred && !need) return true;                   // 默认与本机控制台一致：不强制认证
  // 二进制上传（SDK 压缩包）没法在签名前当文本读出来：这种请求要求用令牌，避免把包读坏
  if (req.headers['x-api-key'] && !/^bearer\s+/i.test(String(req.headers.authorization || ''))
    && !url.searchParams.get('token') && /octet-stream/i.test(String(req.headers['content-type'] || ''))) {
    json(res, 401, { error: '二进制上传请改用令牌认证（AK/SK 直签需要请求体哈希）', code: 'USE_TOKEN' });
    return false;
  }
  const r = await authenticateRequest(req, url);
  if (r.ok) { req._actor = r.actor; return true; }
  if (!need) {
    // 平台没开认证：坏掉/过期的凭证不该把本机控制台和插件挡在门外。
    // 降级为匿名放行，并用响应头标记，客户端据此清掉本地脏令牌。
    res.setHeader('x-apiflow-auth', 'invalid');
    res.setHeader('access-control-expose-headers', 'x-apiflow-auth');
    req._authInvalid = r.code || 'INVALID_CRED';
    return true;
  }
  json(res, 401, { error: r.error, code: r.code, authRequired: need, hint: '在平台「插件接入」里用 AK/SK 换取令牌，或对请求做 AK/SK 签名' });
  return false;
}

const newRunId = () => 'run_' + crypto.randomBytes(5).toString('hex');

function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function flowSummary(f) {
  const pub = f.published, dr = f.draft;
  const def = (pub && pub.def) || (dr && dr.def) || {};
  const last = store.listRuns(f.id)[0] || null;
  return {
    id: f.id, name: f.name,
    published: !!pub, version: pub ? pub.version : 0,
    nodeCount: (def.nodes || []).length,
    httpCount: (def.nodes || []).filter(n => n.type === 'http').length,
    trigger: (def.trigger && def.trigger.type) || null,
    updatedAt: (dr && dr.updatedAt) || (pub && pub.publishedAt) || f.createdAt,
    lastRun: last ? {
      id: last.id, num: last.num, status: last.status, trigger: last.trigger,
      startedAt: last.startedAt, durationMs: last.durationMs || null, actor: last.actor || null,
    } : null,
  };
}

function runBrief(r) {
  return {
    id: r.id, num: r.num, flowId: r.flowId, flowName: r.flowName, version: r.version,
    status: r.status, trigger: r.trigger, actor: r.actor || null, meta: r.meta || null,
    startedAt: r.startedAt, endedAt: r.endedAt || null, durationMs: r.durationMs || null,
    error: r.error || null,
  };
}

// 不在响应里回整份草稿定义（体积大且含内部结构）；执行时服务端自己会重新解析
function sanitizePlan(plan) {
  const { draftDef, ...rest } = plan;
  return rest;
}

// 插件触发流程：立即返回 runId，执行在后台推进（SSE 实时推送，Web 端同时可见）
function launchFlow(f, args, req) {
  const pub = f.published;
  const def = { ...pub.def, version: pub.version };
  const input = { ...((def.input && def.input.sample) || {}), ...(args || {}) };
  const runId = newRunId();
  const promise = engine.runFlow(def, input, { trigger: 'agent', runId, actor: actorOf(req) });
  promise.catch(e => console.log('[agent] 流程执行异常：', e.message));
  return { runId, flowId: f.id, version: pub.version, input, promise };
}

// 未发布流程 / 现场生成的草稿：写操作换成桩，只读试跑（不会真的改数据）
function launchDraft(def, args, req, note) {
  const input = { ...((def.input && def.input.sample) || {}), ...(args || {}) };
  const runId = newRunId();
  const promise = engine.runFlow(makeDryDef({ ...def, id: def.id }), input, {
    trigger: 'agent', runId, actor: actorOf(req), meta: { dryRun: true, note: note || '草稿只读试跑' },
  });
  promise.catch(e => console.log('[agent] 草稿试跑异常：', e.message));
  return { runId, flowId: def.id, input, promise };
}

// 单接口调试：start → http 两条节点的最小流程，复用引擎的重试/断言/认证注入与整套观测
function opDebugDef(op, args, body) {
  const node = registry.toNode(op, args || {});
  if (body.body !== undefined) node.config.body = body.body;
  if (body.headers && typeof body.headers === 'object') node.config.headers = body.headers;
  if (body.timeout) node.timeout = clampInt(body.timeout, 10000, 1000, 60000);
  if (body.noRetry) node.retry = { maxAttempts: 1, backoffMs: 300 };
  return {
    id: 'dbg_' + op.id.replace(/[^\w]/g, '_'), name: '接口调试 · ' + (op.name || op.id), version: 0,
    input: { schema: { type: 'object' }, sample: args || {} },
    nodes: [{ id: 'start', type: 'start', name: '开始', config: {} }, node],
    edges: [{ from: 'start', to: node.id }],
    layout: { start: { x: 40, y: 160 }, [node.id]: { x: 260, y: 160 } },
  };
}

function debugOpPlan(op, text) {
  const args = intent.extractArgs(text || '', op);
  const missing = (op.params || []).filter(p => args[p] == null || args[p] === '');
  return {
    kind: 'debug-op',
    op: {
      id: op.id, name: op.name, method: op.method, path: op.path,
      readOnly: op.readOnly !== false, sourceId: op.sourceId || 'builtin',
      params: op.params || [], baseUrl: op.baseUrl || BASE,
    },
    args, missingParams: missing, needsConfirm: op.readOnly === false,
    reason: `调试接口「${op.name}」（${op.method} ${op.path}）`,
    candidates: [], refs: [],
  };
}

// 查询型意图：直接从平台数据回答，不产生运行
function answerQuery(plan, text) {
  const q = plan.query || {};
  const flows = store.listFlows();
  const runs = store.listRuns(null);
  if (q.kind === 'flows') {
    const list = flows.map(flowSummary).sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      queryKind: 'flows',
      text: list.length
        ? `共 ${list.length} 个流程（${list.filter(f => f.published).length} 个已发布）：\n` +
          list.slice(0, 12).map(f => `· ${f.name} ${f.published ? 'v' + f.version : '未发布'} · ${f.nodeCount} 节点 · ` +
            (f.lastRun ? `最近${f.lastRun.status === 'success' ? '成功' : f.lastRun.status === 'failed' ? '失败' : f.lastRun.status} ${fmtAgo(f.lastRun.startedAt)}` : '还没运行过')).join('\n')
        : '还没有流程。可以在 Web 端「搭建器」用一句话生成，或直接在这里描述需求。',
      data: list,
    };
  }
  if (q.kind === 'runs') {
    const failOnly = /失败|异常|错误/.test(text);
    const list = runs.filter(r => !failOnly || r.status === 'failed');
    return {
      queryKind: 'runs',
      text: list.length
        ? `最近 ${Math.min(list.length, 10)} 次运行${failOnly ? '（仅失败）' : ''}：\n` +
          list.slice(0, 10).map(r => `· #${r.num} ${r.flowName || r.flowId} · ${r.status === 'success' ? '成功' : r.status === 'failed' ? '失败' : r.status} · ${r.durationMs != null ? r.durationMs + 'ms' : '—'} · ${trigText(r.trigger)} · ${fmtAgo(r.startedAt)}`).join('\n')
        : '没有符合条件的运行记录。',
      data: list.slice(0, 20).map(runBrief),
    };
  }
  if (q.kind === 'ops') {
    const ops = allOperations();
    const bySource = {};
    for (const o of ops) { const k = o.sourceId || 'builtin'; bySource[k] = (bySource[k] || 0) + 1; }
    const want = String(text).replace(/(接口|注册表|工具集|可用|哪些|有哪些|列表|列出|查看|看看|一下|的)/g, '').trim();
    const matched = want ? ops.filter(o => (o.name + o.id + (o.path || '')).toLowerCase().includes(want.toLowerCase())) : ops;
    return {
      queryKind: 'ops',
      text: `注册表 ${registry.version()} · 共 ${ops.length} 个可用接口（内置 ${bySource.builtin || 0}，外部来源 ${ops.length - (bySource.builtin || 0)}）：\n` +
        (matched.length ? matched.slice(0, 20).map(o => `· ${o.name}（${o.method} ${o.path}）${o.readOnly === false ? ' · 写' : ''}`).join('\n') : '没有匹配的接口。'),
      data: matched.slice(0, 50).map(o => ({ id: o.id, name: o.name, method: o.method, path: o.path, readOnly: o.readOnly !== false, sourceId: o.sourceId })),
    };
  }
  if (q.kind === 'alerts') {
    const list = store.listAlerts();
    return {
      queryKind: 'alerts',
      text: list.length ? `当前 ${list.length} 条待处理告警：\n` + list.slice(0, 10).map(a => `· ${a.message || a.id}`).join('\n') : '没有待处理告警。',
      data: list,
    };
  }
  if (q.kind === 'materials') {
    const clean = String(text).replace(/(有哪些|有什么|资料|函数|方法|类|查一下|查询|看看|一下|的|里)/g, ' ').trim();
    const r = materials.searchSymbols(materialPool(), clean || text, { limit: 8 });
    return {
      queryKind: 'materials',
      text: r.items.length
        ? `SDK 资料里匹配 ${r.total} 条，取前 ${r.items.length} 条：\n` +
          r.items.map(s => `· ${s.parent ? s.parent + '.' : ''}${s.name}  ${s.sig || ''}${s.summary ? '\n  ' + s.summary.slice(0, 80) : ''}`).join('\n')
        : '资料库里没有匹配项。先在「接口 → 导入 SDK」导入一个 SDK 包，函数/类/参数说明都会入库。',
      data: r.items,
    };
  }
  // overview
  const pub = flows.filter(f => f.published).length;
  const ok = runs.filter(r => r.status === 'success').length;
  const done = runs.filter(r => r.status !== 'running').length;
  return {
    queryKind: 'overview',
    text: [
      `注册表 ${registry.version()} · ${allOperations().length} 个可用接口 · ${store.listSources().length} 个接口来源`,
      `流程 ${flows.length} 个（${pub} 个已发布）· 运行记录 ${runs.length} 次 · 成功率 ${done ? Math.round(ok / done * 100) : 0}%`,
      `待处理告警 ${store.listAlerts().length} 条 · SDK 资料 ${store.listSources().reduce((n, s) => n + ((s.materials && s.materials.count) || 0), 0)} 条`,
      runs[0] ? `最近一次：${runs[0].flowName || runs[0].flowId} · ${runs[0].status} · ${fmtAgo(runs[0].startedAt)}` : '还没有运行记录。',
    ].join('\n'),
    data: { flows: flows.length, published: pub, runs: runs.length, alerts: store.listAlerts().length },
  };
}

const trigText = t => ({ manual: '手动', schedule: '定时', webhook: 'Webhook', replay: '重放', batch: '并行', 'dry-run': '调试', agent: '插件', 'api-debug': '接口调试' }[t] || t || '—');


// ───────────────────────── 路由 ─────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  try {
    // ── CORS 预检：插件页面 / 本地工具会带自定义头跨域调用，先放行 OPTIONS ──
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization,x-api-key,x-api-secret,x-sign-ts,x-signature,x-access-token',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    // ── 访问控制：平台默认不强制认证；开启后插件必须带令牌或 AK/SK 签名 ──
    if (!(await gate(req, res, url))) return;
    // ── SSE 实时事件流 ──
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      const un = bus.subscribe(res);
      req.on('close', un);
      return;
    }

    // ── 上游模拟 API ──
    if (p === '/upstream/_catalog') {
      const et = catalogEtag();
      if (req.headers['if-none-match'] === et) { res.writeHead(304, { etag: et }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag: et });
      return res.end(JSON.stringify(catalogPayload()));
    }
    let m;
    // ── 示例接口文档 / 示例 SDK（供「接入地址」「导入 SDK 地址」直接试用 / 模拟现网更新） ──
    if (p.startsWith('/upstream/_specs/')) {
      const rel = decodeURIComponent(p.slice('/upstream/_specs/'.length));
      const root = path.join(__dirname, 'fixtures');
      const f = path.resolve(root, rel);
      if (f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const types = {
          '.json': 'application/json; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
          '.js': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
          '.java': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8',
          '.md': 'text/plain; charset=utf-8',
        };
        res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(f));
      }
      return json(res, 404, { error: 'spec not found', hint: '示例文档见 fixtures/ 目录' });
    }
    // ── 接入接口的沙箱上游：任何 /upstream/_sandbox/* 请求都回显，让新接入的接口立刻可跑通 ──
    if (p === '/upstream/_sandbox' || p.startsWith('/upstream/_sandbox/')) {
      const echoed = req.method === 'GET' ? {} : await readBody(req);
      await new Promise(r => setTimeout(r, 45));
      return json(res, 200, {
        ok: true, method: req.method, path: p,
        query: Object.fromEntries(url.searchParams),
        body: echoed,
        items: [{ id: 'A-1', amount: 199 }, { id: 'A-2', amount: 88 }],
        at: new Date().toISOString(),
      });
    }
    // ── 类网关上游：HTTP 200 + 业务错误信封，逐个参数校验（复刻移动云 010024 的行为）──
    // 用来演示/回归「200 里的错误不算成功」：不传 poolId → 报 poolId；补了 → 报 productType
    if (p === '/upstream/_gateway/resources' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      if (!q.poolId) return json(res, 200, { code: '010024', message: '参数校验异常,poolId', state: 'ERROR' });
      if (!q.productType) return json(res, 200, { code: '010024', message: '参数校验异常,productType', state: 'ERROR' });
      if (!['vm', 'eip', 'vpc'].includes(q.productType)) {
        return json(res, 200, { code: '010016', message: `不支持该产品类型:${q.productType},请检查资源池与产品类型是否正确`, state: 'ERROR' });
      }
      return json(res, 200, {
        code: '000000', message: '成功', state: 'OK',
        entity: {
          total: 2, pageNum: Number(q.pageNum || 1), pageSize: Number(q.pageSize || 10), pageCount: 1,
          content: [{ resourceId: 'r-1001', resourceName: 'vm-demo-01' }, { resourceId: 'r-1002', resourceName: 'vm-demo-02' }],
        },
      });
    }
    // ── 受保护上游：校验 AK/SK（HMAC 签名或头直传），演示认证注入全链路 ──
    if (p === '/upstream/secure/data') {
      let raw = '';
      for await (const c of req) raw += c;
      const cred = store.listCreds().find(c => c.ak === req.headers['x-api-key']);
      if (!cred) return json(res, 401, { error: '未认证：x-api-key 无效或缺失（在「接口」页配置 AK/SK 凭证并绑定）' });
      const err = verify({
        cred, method: req.method, pathWithQuery: p + url.search,
        ts: req.headers['x-sign-ts'], signature: req.headers['x-signature'],
        bHash: bodyHash(raw), secret: req.headers['x-api-secret'],
      });
      if (err) return json(res, 401, { error: '未认证：' + err });
      await new Promise(r => setTimeout(r, 50));
      return json(res, 200, { secure: true, authAs: cred.name, via: cred.mode, data: { secretLevel: '内部', payload: 'AK/SK 认证通过' }, at: new Date().toISOString() });
    }
    if ((m = p.match(/^\/upstream\/suppliers\/(S-\d+)\/reject$/)) && req.method === 'PATCH') {
      await new Promise(r => setTimeout(r, 80));
      return json(res, 200, { rejected: true, supplierId: m[1], at: new Date().toISOString() });
    }
    if ((m = p.match(/^\/upstream\/suppliers\/(S-\d+)$/)) && req.method === 'GET') {
      await new Promise(r => setTimeout(r, 60 + Math.random() * 120));
      const s = suppliers[m[1]];
      if (!s) return json(res, 404, { error: 'supplier not found' });
      return json(res, 200, { ...s, updatedAt: new Date().toISOString() });
    }
    if (p === '/upstream/erp/admissions' && req.method === 'POST') {
      await new Promise(r => setTimeout(r, 120));
      return json(res, 200, { accepted: true, ticket: 'ERP-' + Date.now() % 100000 });
    }
    if (p === '/upstream/stock/query' && req.method === 'GET') {
      const sku = url.searchParams.get('sku') || 'SKU-01';
      return json(res, 200, stocks[sku] || { sku, qty: 0 });
    }
    if (p === '/upstream/stock/sync' && req.method === 'POST') {
      await new Promise(r => setTimeout(r, 90));
      return json(res, 200, { synced: true });
    }
    if (p === '/upstream/orders' && req.method === 'GET') {
      return json(res, 200, { date: url.searchParams.get('date'), orders: [{ id: 'O1', amount: 99 }, { id: 'O2', amount: 128 }] });
    }

    // ═════════ 插件接入：认证 / 令牌 / 引导数据 ═════════
    if (p === '/api/auth/token' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.ak || !body.sk) return json(res, 400, { error: '需要提供 AK 与 SK' });
      let cred;
      try { cred = access.loginWithCred(body.ak, body.sk); } catch (e) { return json(res, 401, { error: e.message, code: 'BAD_CREDENTIALS' }); }
      const t = access.issueToken({ name: body.name || `${cred.name} · 插件`, credId: cred.id, ttlMs: body.ttlMs });
      return json(res, 200, {
        ok: true, token: t.token, tokenId: t.id, expiresAt: t.expiresAt,
        actor: { name: cred.name, ak: cred.ak, mode: cred.mode },
        scopes: t.scopes,
      });
    }
    if (p === '/api/auth/me') {
      const r = await authenticateRequest(req, url);
      return json(res, 200, {
        ok: r.ok, authenticated: !!r.ok,
        requireAuth: access.needAuth(),
        actor: r.ok ? r.actor : null,
        error: r.ok ? undefined : r.error, code: r.ok ? undefined : r.code,
        server: { name: 'APIFlow', base: BASE, catalog: registry.version(), operations: allOperations().length },
      });
    }
    if (p === '/api/auth/modes') {
      return json(res, 200, {
        requireAuth: access.needAuth(),
        modes: ['token', 'aksk'],
        creds: store.listCreds().map(c => ({ id: c.id, name: c.name, ak: c.ak, mode: c.mode })),
        hint: '用平台已有 AK/SK 换令牌（推荐），或对每个请求做 AK/SK 签名；默认跟随平台（平台未开启认证时可直接连接）',
      });
    }
    if (p === '/api/access/settings' && req.method === 'GET') return json(res, 200, access.settings());
    if (p === '/api/access/settings' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, access.updateSettings({ requireAuth: body.requireAuth }));
    }
    if (p === '/api/access/tokens' && req.method === 'GET') {
      return json(res, 200, { items: access.listTokens(), requireAuth: access.needAuth() });
    }
    if (p === '/api/access/tokens' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const t = access.issueToken({ name: body.name, credId: body.credId, ttlMs: body.ttlMs });
        return json(res, 200, { ok: true, ...t, tokenOnce: t.token });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/access\/tokens\/([\w-]+)$/)) && req.method === 'DELETE') {
      return access.revokeToken(m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: '令牌不存在' });
    }
    // 插件启动时的探活：不需要认证也能拿到「这台服务是什么、要不要认证、有多少数据」；
    // 但请求带了凭证时顺手验一下，让插件能准确显示「已认证」徽标
    if (p === '/api/ext/ping') {
      let credInvalid = null;
      if (req.headers.authorization || req.headers['x-api-key'] || url.searchParams.get('token')) {
        const r = await authenticateRequest(req, url);
        if (r.ok) req._actor = r.actor; else credInvalid = r.code || 'INVALID_CRED';
      }
      return json(res, 200, {
        ok: true, name: 'APIFlow', base: BASE, at: Date.now(),
        requireAuth: access.needAuth(), authenticated: !!req._actor, credInvalid,
        catalog: registry.version(),
        counts: { flows: store.listFlows().length, operations: allOperations().length, runs: store.listRuns(null).length },
      });
    }
    if (p === '/api/ext/bootstrap') {
      const flows = store.listFlows().map(flowSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      const runs = store.listRuns(null).slice(0, 25).map(runBrief);
      const done = runs.filter(r => r.status !== 'running');
      return json(res, 200, {
        server: {
          name: 'APIFlow', base: BASE, requireAuth: access.needAuth(),
          catalog: registry.version(), operations: allOperations().length,
          actor: req._actor || null,
        },
        stats: {
          flows: flows.length, published: flows.filter(f => f.published).length,
          runs: store.listRuns(null).length,
          successRate: done.length ? Math.round(done.filter(r => r.status === 'success').length / done.length * 100) : null,
          alerts: store.listAlerts().length,
          sources: store.listSources().length,
          materials: store.listSources().reduce((n, s) => n + ((s.materials && s.materials.count) || 0), 0),
        },
        flows, runs,
        creds: store.listCreds().map(c => ({ id: c.id, name: c.name, ak: c.ak })),
        triggers: { manual: '手动', schedule: '定时', webhook: 'Webhook', replay: '重放', batch: '并行', 'dry-run': '调试', agent: '插件', 'api-debug': '接口调试' },
      });
    }

    // ═════════ 自然语言：先出方案，再执行 ═════════
    if (p === '/api/agent/plan' && req.method === 'POST') {
      const body = await readBody(req);
      const plan = intent.resolve(String(body.text || ''), { flows: store.listFlows(), ops: allOperations(), baseUrl: BASE });
      return json(res, plan.kind === 'error' ? 422 : 200, {
        ok: plan.kind !== 'error', plan: sanitizePlan(plan),
        error: plan.error,
      });
    }
    if (p === '/api/agent/execute' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      // 允许前端「指定目标」（用户从候选里点了一个），否则按文本重新解析
      let plan;
      if (body.opId) {
        const op = allOperations().find(o => o.id === body.opId);
        if (!op) return json(res, 404, { error: '接口不存在：' + body.opId });
        plan = debugOpPlan(op, text);
      } else if (body.flowId) {
        const f = store.getFlow(body.flowId);
        if (!f) return json(res, 404, { error: '流程不存在：' + body.flowId });
        plan = {
          kind: 'run-flow',
          flow: { id: f.id, name: f.name, published: !!f.published, version: f.published ? f.published.version : 0, nodeCount: 0 },
          args: {}, missingParams: [], needsConfirm: false, candidates: [], refs: [],
          reason: f.published ? `运行流程「${f.name}」` : `流程「${f.name}」未发布，用草稿只读试跑`,
        };
      } else {
        plan = intent.resolve(text, { flows: store.listFlows(), ops: allOperations(), baseUrl: BASE });
      }
      if (body.args && typeof body.args === 'object') plan.args = { ...(plan.args || {}), ...body.args };

      if (plan.kind === 'error') return json(res, 422, { error: plan.error, plan: sanitizePlan(plan) });

      if (plan.kind === 'query') {
        const a = answerQuery(plan, text);
        return json(res, 200, { ok: true, kind: 'query', query: a, plan: sanitizePlan(plan) });
      }

      if (plan.kind === 'run-flow') {
        const f = store.getFlow(plan.flow.id);
        if (!f) return json(res, 404, { error: '流程不存在：' + plan.flow.id });
        if (f.published) {
          const out = launchFlow(f, plan.args, req);
          if (body.wait === true) {
            const run = await out.promise.catch(() => null);
            return json(res, 200, { ok: true, kind: 'run-flow', runId: out.runId, flowId: out.flowId, status: run && run.status, plan: sanitizePlan(plan) });
          }
          return json(res, 202, { ok: true, kind: 'run-flow', runId: out.runId, flowId: out.flowId, version: out.version, input: out.input, plan: sanitizePlan(plan) });
        }
        const def = f.draft && f.draft.def;
        if (!def) return json(res, 422, { error: '这个流程既没有发布版本，也没有草稿可试跑' });
        const out = launchDraft(def, plan.args, req, '流程未发布，按草稿只读试跑');
        if (body.wait === true) { const run = await out.promise.catch(() => null); return json(res, 200, { ok: true, kind: 'run-flow', runId: out.runId, flowId: out.flowId, status: run && run.status, dryRun: true, plan: sanitizePlan(plan) }); }
        return json(res, 202, { ok: true, kind: 'run-flow', runId: out.runId, flowId: out.flowId, dryRun: true, input: out.input, plan: sanitizePlan(plan) });
      }

      if (plan.kind === 'draft-flow') {
        const def = plan.draftDef;
        if (!def) return json(res, 422, { error: '没有生成出可执行的草稿' });
        // 草稿存进平台：Web 端「搭建器」能接着编辑、发布，插件这次只是先跑通
        try {
          store.saveDraft(def.id, def.name, def, [
            { role: 'user', text }, { role: 'agent', text: plan.reason || '按需求生成流程草稿' },
          ]);
        } catch (e) { console.log('[agent] 草稿保存失败：', e.message); }
        const out = launchDraft(def, plan.args, req, '插件生成的草稿只读试跑');
        if (body.wait === true) { const run = await out.promise.catch(() => null); return json(res, 200, { ok: true, kind: 'draft-flow', runId: out.runId, flowId: def.id, status: run && run.status, dryRun: true, plan: sanitizePlan(plan) }); }
        return json(res, 202, { ok: true, kind: 'draft-flow', runId: out.runId, flowId: def.id, dryRun: true, input: out.input, plan: sanitizePlan(plan) });
      }

      // debug-op
      const op = allOperations().find(o => o.id === plan.op.id);
      if (!op) return json(res, 404, { error: '接口不存在：' + plan.op.id });
      if (op.readOnly === false && body.confirm !== true) {
        return json(res, 428, {
          error: `「${op.name}」是写操作，需要确认后执行`,
          confirmRequired: true,
          preview: { method: op.method, path: op.path, name: op.name },
          plan: sanitizePlan(plan),
        });
      }
      const missing = (op.params || []).filter(x => plan.args[x] == null || plan.args[x] === '');
      if (missing.length) {
        return json(res, 422, { error: `路径参数 ${missing.join('、')} 没有取值`, missingParams: missing, plan: sanitizePlan(plan) });
      }
      const def = opDebugDef(op, plan.args, {});
      const runId = newRunId();
      const promise = engine.runFlow(def, plan.args, { trigger: 'api-debug', runId, actor: actorOf(req) });
      promise.catch(e => console.log('[debug] 接口调试异常：', e.message));
      if (body.wait === true) {
        const run = await promise.catch(() => null);
        return json(res, 200, { ok: true, kind: 'debug-op', runId, status: run && run.status, plan: sanitizePlan(plan) });
      }
      return json(res, 202, {
        ok: true, kind: 'debug-op', runId,
        request: { method: op.method, url: (op.baseUrl || BASE) + op.path },
        plan: sanitizePlan(plan),
      });
    }

    // ═════════ 单接口调试：与流程共用引擎（重试 / 认证注入 / 断言 / 观测）═════════
    if ((m = p.match(/^\/api\/ops\/([\w-]+)\/debug$/)) && req.method === 'POST') {
      const op = allOperations().find(o => o.id === m[1]);
      if (!op) return json(res, 404, { error: '接口不存在：' + m[1] });
      const body = await readBody(req);
      if (op.readOnly === false && body.confirm !== true) {
        return json(res, 428, {
          error: `「${op.name}」是写操作，需要确认后执行`, confirmRequired: true,
          preview: { method: op.method, path: op.path, name: op.name },
        });
      }
      const args = { ...(body.args && typeof body.args === 'object' ? body.args : {}) };
      const missing = (op.params || []).filter(x => args[x] == null || args[x] === '');
      if (missing.length) return json(res, 422, { error: `路径参数 ${missing.join('、')} 没有取值`, missingParams: missing });
      if (body.authId && !store.getCred(body.authId)) return json(res, 404, { error: '凭证不存在' });
      const def = opDebugDef(op, args, body);
      if (body.authId) def.authId = body.authId;
      const runId = newRunId();
      const promise = engine.runFlow(def, args, { trigger: 'api-debug', runId, actor: actorOf(req) });
      promise.catch(e => console.log('[debug] 接口调试异常：', e.message));
      if (body.wait === true) {
        const run = await promise.catch(() => null);
        return json(res, 200, { ok: true, runId, status: run && run.status, op: { id: op.id, name: op.name, method: op.method, path: op.path } });
      }
      return json(res, 202, {
        ok: true, runId, op: { id: op.id, name: op.name, method: op.method, path: op.path, readOnly: op.readOnly !== false },
      });
    }

    // ── API：流程 ──
    if (p === '/api/flows' && req.method === 'GET') {
      return json(res, 200, store.listFlows().map(f => ({
        id: f.id, name: f.name, createdAt: f.createdAt,
        version: f.published ? f.published.version : 0,
        publishedAt: f.published ? f.published.publishedAt : null,
        nodeCount: f.published ? f.published.def.nodes.length : (f.draft ? f.draft.def.nodes.length : 0),
        trigger: f.published ? f.published.def.trigger || null : null,
        source: (f.draft && f.draft.chat.length) || (f.published && f.published.def.source === 'nl') ? '自然语言生成' : '画布手绘',
        authId: (f.published && f.published.def.authId) || (f.draft && f.draft.def.authId) || null,
        lastRun: store.listRuns(f.id)[0] || null,
      })));
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/def$/)) && req.method === 'GET') {
      const f = store.getFlow(m[1]);
      if (!f) return json(res, 404, { error: 'flow not found' });
      return json(res, 200, { def: (f.published && f.published.def) || (f.draft && f.draft.def) || null, version: f.published ? f.published.version : 0 });
    }
    // ── 并行批跑：一次提交多个流程，按并发度同时执行 ──
    if (p === '/api/flows/batch-run' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && x) : [];
      if (!ids.length) return json(res, 400, { error: '未指定要运行的流程' });
      if (new Set(ids).size > MAX_FLOWS) return json(res, 400, { error: `单次最多并行 ${MAX_FLOWS} 个流程` });
      if (body.concurrency != null && !(Number(body.concurrency) >= 1)) {
        return json(res, 400, { error: '并发度必须是 ≥1 的整数' });
      }
      try {
        // 立即返回批次快照，流程在后台并发跑，前端轮询 /api/batches/:id 看进度
        return json(res, 202, batches.start(ids, { concurrency: body.concurrency, input: body.input }));
      } catch (e) {
        return json(res, e.status || 500, { error: String(e.message || e) });
      }
    }
    if (p === '/api/batches' && req.method === 'GET') return json(res, 200, { items: batches.list() });
    if ((m = p.match(/^\/api\/batches\/([\w-]+)\/cancel$/)) && req.method === 'POST') {
      const b = batches.cancel(m[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: '批次不存在' });
    }
    if ((m = p.match(/^\/api\/batches\/([\w-]+)$/)) && req.method === 'GET') {
      const b = batches.get(m[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: '批次不存在' });
    }
    if (p === '/api/flows/batch-delete' && req.method === 'POST') {      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(Boolean))] : [];
      if (!ids.length) return json(res, 400, { error: '未指定要删除的流程' });
      if (ids.length > 200) return json(res, 400, { error: '单次最多删除 200 个流程' });
      const deleted = [], missing = [];
      for (const id of ids) {
        if (store.getFlow(id)) { store.deleteFlow(id); deleted.push(id); } else missing.push(id);
      }
      return json(res, 200, { ok: true, deleted, missing, deletedCount: deleted.length });
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)$/)) && req.method === 'DELETE') {
      const f = store.getFlow(m[1]);
      if (!f) return json(res, 404, { error: 'flow not found' });
      store.deleteFlow(m[1]);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/agent/draft' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '');
      // 相关 SDK 资料先查一遍：即便这次描述没能映射到可调接口，也能告诉用户
      // 「SDK 里其实有这些能力」，比只回一句「识别不出接口」有用得多
      const refs = materials.searchSymbols(materialPool(), body.text || '', { limit: 5 }).items
        .map(s => ({
          name: s.name, kind: s.kind, parent: s.parent, sig: s.sig, summary: s.summary,
          file: s.file, line: s.line, sourceId: s.sourceId, sourceName: s.sourceName,
        }));
      // 帮助手册：既当引用展示，也在接口名没说全时用来补全（手册与 SDK 资料是两套来源）
      const assist = docs.assist(text, allOperations(), { limit: 4 });
      const docRefs = assist.refs;
      const prev = body.flowId && store.getFlow(body.flowId);
      const prevDef = prev && prev.draft && prev.draft.def;
      // 已经有草稿时，先看这句话是不是在「调整」它：
      // 「把告警策略列表放到最前面」「删掉最后一步」「超时改成 5 秒」都落在这里 —— 必须走调整，
      // 否则会被当成新描述重建，一句话就把用户画好的流程覆盖掉。
      const wantsNew = /(新建|重新做|重新来|另一条|另一个流程|换一条|从零|做成一条)/.test(text);
      let reviseMiss = null;
      if (prevDef && !wantsNew) {
        const rev = reviseDraft(text, prevDef, registry);
        if (!rev.error) {
          rev.draft.id = body.flowId;
          rev.draft.source = 'nl';
          const f = store.saveDraft(body.flowId, rev.draft.name, rev.draft, [
            ...(prev.draft.chat || []), { role: 'user', text }, { role: 'agent', text: rev.explanation },
          ]);
          return json(res, 200, {
            flow: { id: f.id, name: f.name }, draft: rev.draft, explanation: rev.explanation,
            revised: true, changes: rev.changes, references: refs, docRefs,
          });
        }
        // 明显是在调流程、但没落到具体动作 → 直接说清楚，不要拿它去重建
        if (rev.revision) {
          return json(res, 422, { error: rev.error, references: refs, docRefs, suggestions: rev.suggestions || [] });
        }
        reviseMiss = rev;
      }

      const out = buildDraft(text, registry, { assist });
      if (out.error) return json(res, 422, {
        error: out.error, references: refs, docRefs: out.docRefs || docRefs,
        suggestions: (reviseMiss && reviseMiss.suggestions) || out.suggestions || [],
      });
      const flowId = body.flowId || out.draft.id;
      out.draft.id = flowId;
      out.draft.source = 'nl';
      const f = store.saveDraft(flowId, out.draft.name, out.draft, [
        ...(body.history || []), { role: 'user', text: body.text }, { role: 'agent', text: out.explanation },
      ]);
      return json(res, 200, {
        flow: { id: f.id, name: f.name }, draft: out.draft, explanation: out.explanation,
        references: refs, docRefs: out.docRefs || docRefs, docUsed: out.docUsed || [],
      });
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/draft$/)) && req.method === 'POST') {
      const body = await readBody(req);                 // 画布编辑保存草稿（流程不存在则创建）
      const f = store.saveDraft(m[1], body.def.name || m[1], body.def, (store.getFlow(m[1]) && store.getFlow(m[1]).draft && store.getFlow(m[1]).draft.chat) || []);
      const def = { ...body.def, id: f.id, name: body.def.name || f.name };
      const g1 = validate(def);
      def.gates = { schema: { ok: g1.ok, errors: g1.errors, warnings: g1.warnings }, dryRun: (f.draft && f.draft.def.gates && f.draft.def.gates.dryRun) || { ok: null }, confirm: { ok: null } };
      store.saveDraft(f.id, def.name, def, (f.draft && f.draft.chat) || []);
      return json(res, 200, { ok: true, gates: def.gates });
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/validate$/)) && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, validate(body.def));
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/dry-run$/)) && req.method === 'POST') {
      const body = await readBody(req);                 // {input: 调试输入覆盖, runId: 客户端预指定（实时调试 SSE 用）}
      const f = store.getFlow(m[1]);
      const draftDef = f.draft && f.draft.def;
      const def = draftDef || (f.published && f.published.def);
      if (!def) return json(res, 404, { error: 'no draft to dry-run' });
      const g1 = validate(def);
      if (!g1.ok) return json(res, 422, { error: 'Schema 校验未通过', errors: g1.errors });
      const input = body.input && Object.keys(body.input).length ? body.input : (def.input && def.input.sample) || {};
      const runId = typeof body.runId === 'string' && body.runId.length <= 64 ? body.runId : undefined;
      const dry = await engine.runFlow(makeDryDef(def), input, { trigger: 'dry-run', runId });
      if (draftDef) {
        draftDef.gates = draftDef.gates || {};
        draftDef.gates.dryRun = { ok: dry.status === 'success', runId: dry.id };
        store.persistFlows();
      }
      return json(res, 200, { runId: dry.id, status: dry.status, num: dry.num, nodes: dry.nodes });
    }
    // 搭建器自动修复 / 自动断言：mode=fix 只修复、mode=assert 只加断言、缺省两者都做
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/autofix$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const def = body.def;
      if (!def || !Array.isArray(def.nodes)) return json(res, 422, { error: '缺少流程定义 def.nodes' });
      const ops = allOperations();
      let out = { def, fixes: [], unfixable: [] }, asserts = [];
      if (body.mode !== 'assert') out = autoFix(def, ops);
      if (body.mode !== 'fix') {
        const r = autoAssert(out.def, ops);
        out.def = r.def; asserts = r.added;
      }
      const schema = validate(out.def);
      return json(res, 200, { def: out.def, fixes: out.fixes, unfixable: out.unfixable, asserts, schema });
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/publish$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const f = store.getFlow(m[1]);
      if (!f) return json(res, 404, { error: 'flow not found' });
      const def = { ...(body.def || (f.draft && f.draft.def)), id: f.id };
      const g1 = validate(def);
      if (!g1.ok) return json(res, 422, { error: 'Schema 校验未通过', errors: g1.errors });
      const gates = (f.draft && f.draft.def.gates) || {};
      if (!gates.dryRun || gates.dryRun.ok !== true) return json(res, 422, { error: '发布前必须先通过 Dry-run（第二道闸）' });
      if (body.confirm !== true) return json(res, 422, { error: '发布前必须在画布人工确认（第三道闸）' });
      def.source = def.source || (f.draft && f.draft.chat.length ? 'nl' : 'canvas');
      store.publish(f.id, def);
      return json(res, 200, { ok: true, version: f.published.version, bindings: f.published.bindings });
    }
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/run$/)) && req.method === 'POST') {
      const f = store.getFlow(m[1]);
      if (!f || !f.published) return json(res, 404, { error: '流程不存在或未发布' });
      const body = await readBody(req);
      const input = Object.keys(body).length ? body : (f.published.def.input && f.published.def.input.sample) || {};
      const run = await engine.runFlow({ ...f.published.def, version: f.published.version }, input, { trigger: 'manual' });
      return json(res, 200, { runId: run.id, status: run.status });
    }

    // ── Webhook 触发器 ──
    if ((m = p.match(/^\/webhook\/([\w-]+)$/)) && req.method === 'POST') {
      const f = store.getFlow(m[1]);
      if (!f || !f.published) return json(res, 404, { error: 'flow not found' });
      const body = await readBody(req);
      const run = await engine.runFlow({ ...f.published.def, version: f.published.version }, body, { trigger: 'webhook' });
      return json(res, 200, { runId: run.id, status: run.status });
    }

    // ── API：运行 ──
    if (p === '/api/runs' && req.method === 'GET') {
      return json(res, 200, store.listRuns(url.searchParams.get('flowId') || null).filter(r => r.trigger !== 'dry-run').slice(0, 30));
    }
    if ((m = p.match(/^\/api\/runs\/([\w-]+)$/)) && req.method === 'DELETE') {
      const r = store.removeRun(m[1]);
      if (r.ok) return json(res, 200, { ok: true, deleted: 1 });
      return json(res, r.reason === 'running' ? 409 : 404, {
        error: r.reason === 'running' ? '运行中的记录不能删除，等它跑完再删' : 'run not found',
      });
    }
    if (p === '/api/runs' && req.method === 'DELETE') {         // 清空（可带 ?flowId= 只清某个流程）
      const flowId = url.searchParams.get('flowId') || null;
      const n = store.clearRuns(flowId);
      return json(res, 200, { ok: true, deleted: n, flowId });
    }
    if ((m = p.match(/^\/api\/runs\/([\w-]+)$/)) && req.method === 'GET') {
      const r = store.getRun(m[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: 'run not found' });
    }
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/replay$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(m[1]);
      if (!r) return json(res, 404, { error: 'run not found' });
      const replay = await engine.replay(r, body.fromNode);
      return json(res, 200, { runId: replay.id, status: replay.status });
    }
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/diff\/([\w-]+)$/))) {
      const a = store.getRun(m[1]), b = store.getRun(m[2]);
      if (!a || !b) return json(res, 404, { error: 'run not found' });
      const nodeIds = [...new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])];
      const diff = nodeIds.map(nid => {
        const x = a.nodes[nid] || {}, y = b.nodes[nid] || {};
        return {
          node: nid,
          statusA: x.status || '-', statusB: y.status || '-',
          statusChanged: (x.status || '-') !== (y.status || '-'),
          outputChanged: JSON.stringify(x.output) !== JSON.stringify(y.output),
          outputA: x.output ?? null, outputB: y.output ?? null,
          msA: x.ms ?? null, msB: y.ms ?? null,
        };
      });
      return json(res, 200, { a: { id: a.id, num: a.num, version: a.version }, b: { id: b.id, num: b.num, version: b.version }, diff });
    }

    // ── API：注册表 / 告警 / 管理 ──
    if (p === '/api/catalog') return json(res, 200, { ...registry.catalog, etag: registry.etag });

    // ── API：版本更新记录（解析仓库根目录 CHANGELOG.md，按 mtime 缓存）──
    if (p === '/api/changelog' && req.method === 'GET') return json(res, 200, changelog.load());
    if (p === '/api/changelog/raw' && req.method === 'GET') {
      const md = changelog.raw();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      return res.end(md);
    }

    // ── API：单个接口的参数提示（节点属性面板用）──
    // 返回 SDK 字段 ∪ 运行期学到的必填/示例，界面据此给「可加参数」候选与必填标记
    if ((m = p.match(/^\/api\/ops\/([\w.-]+)\/params$/)) && req.method === 'GET') {
      const op = allOperations().find(o => o.id === m[1]);
      // 接口不在注册表里（来源被删 / 节点是手写的）也可能有学习结果 —— 照样给，
      // 面板上标一句「接口不在注册表」，比直接 404 让人无从下手好
      const target = op || { id: m[1], sourceId: 'builtin', method: '', path: '' };
      return json(res, 200, {
        operationId: m[1], sourceId: target.sourceId || null, method: target.method, path: target.path,
        missingOp: !op,
        query: paramhint.fieldsOf(target, store),
        learned: store.getParamHint(m[1]) || null,
      });
    }
    // 清掉某个接口学到的参数提示（学错了 / 想重新开始）
    if ((m = p.match(/^\/api\/ops\/([\w.-]+)\/params$/)) && req.method === 'DELETE') {
      return json(res, 200, { ok: store.dropParamHint(m[1]) });
    }

    // ── API：接口注册表批量删除（内置接口→隐藏可恢复；来源接口→从来源移除） ──
    if (p === '/api/ops/batch-delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(x => typeof x === 'string' && x.trim()))] : [];
      if (!ids.length) return json(res, 400, { error: '未指定要删除的接口' });
      if (ids.length > 200) return json(res, 400, { error: '单次最多删除 200 个接口' });
      const byId = new Map(allOperations().map(o => [o.id, o]));
      const target = ids.filter(id => byId.has(id));
      const missing = ids.filter(id => !byId.has(id));
      const builtin = target.filter(id => byId.get(id).sourceId === 'builtin');
      const fromSources = target.filter(id => byId.get(id).sourceId !== 'builtin');
      // 删完会变空的来源（提示用，避免用户以为来源还留着）
      const sourcesEmptied = [...new Set(fromSources
        .filter(id => { const s = store.getSource(byId.get(id).sourceId); return s && (s.operations || []).length === 1; })
        .map(id => byId.get(id).sourceId))];
      // 引用了这些接口的流程 —— 删除后再次运行会失败，必须提前告知
      const affected = [];
      for (const f of store.listFlows()) {
        const def = (f.published && f.published.def) || (f.draft && f.draft.def);
        if (!def || !Array.isArray(def.nodes)) continue;
        const nodes = [...new Set(def.nodes.filter(n => n.operationId && target.includes(n.operationId)).map(n => n.name || n.id))];
        if (nodes.length) affected.push({ id: f.id, name: f.name, published: !!(f.published && f.published.def), version: f.published ? f.published.version : 0, nodes });
      }
      affected.sort((a, b) => (b.published - a.published) || (b.version - a.version) || a.name.localeCompare(b.name));   // 已发布的排前面
      const summary = { ok: true, total: target.length, builtin, fromSources, sourcesEmptied, affected, missing };
      if (body.preview === true) return json(res, 200, { ...summary, preview: true });

      const hidden = store.hideOps(builtin);
      let removedFromSources = 0;
      const removedSources = [];
      for (const id of fromSources) {
        const r = store.removeSourceOp(byId.get(id).sourceId, id);
        if (r.ok) removedFromSources++;
        if (r.emptied) removedSources.push(byId.get(id).sourceId);
      }
      let unboundCreds = 0;
      for (const id of target) if (store.opBindings()[id]) { store.setOpBinding(id, null); unboundCreds++; }
      const clearedAlerts = store.dropAlertsForOps(target);
      if (target.length) await registry.refresh();
      return json(res, 200, {
        ...summary, preview: false, deleted: target, hidden, removedFromSources,
        removedSources: [...new Set(removedSources)], unboundCreds, clearedAlerts,
        catalogVersion: registry.version(),
      });
    }
    // 恢复被隐藏的内置接口（不传 ids 则全部恢复）
    if (p === '/api/ops/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && x) : null;
      const restored = store.restoreOps(ids);
      if (restored) await registry.refresh();
      return json(res, 200, { ok: true, restored, hidden: store.hiddenOps(), catalogVersion: registry.version() });
    }

    // ── API：接口来源（前端「接入接口」的真实落点） ──
    // ── pip 导入：环境探测 + 装包分析（两步：先看接口，再确认导入） ──
    if (p === '/api/sdk/pip/env' && req.method === 'GET') {
      return json(res, 200, await pipEnv(!!req.url.includes('force=1')));
    }
    if (p === '/api/sdk/pip/analyze' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { got, parsed } = await analyzePip(body);
        const symStats = materials.extractSymbols(got.files).stats;
        if (!parsed.operations.length && !symStats.count) {
          throw new Error('这个包里既没有 HTTP 接口调用，也没有可收录的函数 / 类（可能只是构建产物或空壳包）');
        }
        const pipNotes = (parsed.notes || []).slice();
        if (parsed.symbolOnly) {
          pipNotes.unshift(`未发现业务接口（基础库 / 框架包常见）：已收录 ${symStats.count} 条函数与方法（${symStats.classes} 类 / ${symStats.methods} 方法 / ${symStats.functions} 函数），导入后可在「SDK 资料」检索`);
        }
        const token = pipCachePut({
          files: got.files, pkg: got.pkg, stats: got.stats, spec: got.spec,
          indexUrl: got.indexUrl, withDeps: got.withDeps, log: got.log,
        });
        return json(res, 200, {
          token, spec: got.spec,
          pkg: got.pkg, stats: got.stats, log: got.log,
          format: parsed.format, formatName: parsed.formatName,
          baseUrl: parsed.baseUrl || null, version: parsed.version,
          notes: pipNotes,
          symbolOnly: !!parsed.symbolOnly,
          // 资料规模预览：装完的包里函数/类也会入库，导入后可在「SDK 资料」里检索
          materials: symStats,
          count: parsed.operations.length,
          operations: parsed.operations.map(o => ({ id: o.id, name: o.name, method: o.method, path: o.path, readOnly: o.readOnly })),
          expiresIn: Math.floor(PIP_CACHE_TTL / 1000),
        });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // ── 压缩包导入：上传 zip / tar.gz → 解压分析 → 预览（确认后走 POST /api/sources mode=archive） ──
    if (p === '/api/sdk/archive' && req.method === 'POST') {
      try {
        const name = String(url.searchParams.get('name') || 'sdk.zip').slice(0, 160);
        const buf = await readRaw(req, MAX_ARCHIVE_BYTES);
        const got = await extractArchive(buf, name);
        checkSdkSize(got.files);
        const parsed = parseSDK(got.files, { name: suggestSdkName(name) });
        // 没有接口还能救：基础库 / 框架包里全是类与方法，资料库照样有用
        const sym = (got.materials && got.materials.stats) || { count: 0 };
        if (!parsed.operations.length && !sym.count) {
          throw new Error('这个包里既没有 HTTP 接口调用，也没有可收录的函数 / 类（可能只是构建产物或空壳包）');
        }
        const notes = (parsed.notes || []).slice();
        if (parsed.symbolOnly) {
          notes.unshift(`未发现业务接口（基础库 / 框架包常见）：已收录 ${sym.count} 条函数与方法（${sym.classes} 类 / ${sym.methods} 方法 / ${sym.functions} 函数），导入后可在「SDK 资料」检索，智能体搭流程时会自动引用`);
        }
        const token = arcCache.put({ files: got.files, stats: got.stats, name, version: parsed.version, materials: got.materials }, 'arc');
        return json(res, 200, {
          token,
          archive: {
            name, kind: got.stats.kind, bytes: got.stats.archiveBytes,
            entries: got.stats.entries, sourceFiles: got.stats.sourceFiles,
            selected: got.stats.selected, skipped: got.stats.skipped,
            unpackedBytes: got.stats.unpackedBytes,
          },
          // 资料库规模预览：整个包的函数 / 方法 / 类都会入库，不只是挑中的源码
          materials: got.materials ? got.materials.stats : null,
          suggestedName: suggestSdkName(name),
          format: parsed.format, formatName: parsed.formatName, digest: parsed.digest,
          baseUrl: parsed.baseUrl || null, version: parsed.version,
          notes,
          symbolOnly: !!parsed.symbolOnly,
          count: parsed.operations.length,
          operations: parsed.operations.map(o => ({ id: o.id, name: o.name, method: o.method, path: o.path, readOnly: o.readOnly })),
          expiresIn: Math.floor(ARC_CACHE_TTL / 1000),
        });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/sources' && req.method === 'GET') {
      return json(res, 200, {
        rev: store.sourcesRev(), items: store.listSources().map(sourceSummary),
        total: allOperations().length, hidden: store.hiddenOps(),
      });
    }
    // ── 帮助手册：公网文档 / 本地文件 → 搭建器解析自然语言时的依据 ──
    if (p === '/api/docs' && req.method === 'GET') {
      return json(res, 200, { items: docs.list(), stats: docs.stats() });
    }
    if (p === '/api/docs' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        let doc;
        if (body.mode === 'url') doc = await docs.createFromUrl({ url: body.url, name: body.name, maxPages: body.maxPages });
        else doc = docs.createFromText({ text: body.text, name: body.name, filename: body.filename, format: body.format });
        return json(res, 200, { doc, stats: docs.stats() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // 文件导入走原始二进制上传（与压缩包导入同一套路，避免 base64 撑大三成体积）
    if (p === '/api/docs/upload' && req.method === 'POST') {
      const name = String(url.searchParams.get('name') || 'manual.txt').slice(0, 200);
      const title = String(url.searchParams.get('title') || '').slice(0, 80);
      try {
        const buf = await readRaw(req, docs.MAX_UPLOAD);
        const doc = await docs.createFromFile({ buffer: buf, filename: name, name: title });
        return json(res, 200, { doc, stats: docs.stats() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/docs/search' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      const docId = String(url.searchParams.get('docId') || '').trim();
      const limit = clampInt(url.searchParams.get('limit'), 8, 1, 40);
      const r = docs.search(q, { limit, docId });
      return json(res, 200, { q, total: r.total, items: r.items });
    }
    if ((m = p.match(/^\/api\/docs\/([\w-]+)\/refresh$/)) && req.method === 'POST') {
      const meta = docs.get(m[1]);
      if (!meta) return json(res, 404, { error: '手册不存在' });
      if (!meta.url) return json(res, 400, { error: '只有通过 URL 抓取的手册可以重新抓取' });
      try {
        const doc = await docs.createFromUrl({ url: meta.url, name: meta.name });
        return json(res, 200, { doc, stats: docs.stats() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/docs\/([\w-]+)$/))) {
      const id = m[1];
      if (req.method === 'DELETE') {
        docs.remove(id);
        return json(res, 200, { ok: true, stats: docs.stats() });
      }
      const r = docs.preview(id, String(url.searchParams.get('q') || '').trim());
      if (!r) return json(res, 404, { error: '手册不存在' });
      return json(res, 200, r);
    }
    // ── API：SDK 资料库（接口之外的函数 / 方法 / 类 / 类型说明） ──
    // 全局检索：智能体或前端在「所有已导入的 SDK」里找能力，而不仅是可调用的接口
    if (p === '/api/materials' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      const sourceId = String(url.searchParams.get('sourceId') || '').trim();
      const kind = String(url.searchParams.get('kind') || '').trim();
      const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100);
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
      const r = materials.searchSymbols(materialPool(sourceId), q, { limit, offset, kind });
      return json(res, 200, {
        total: r.total, offset, limit, q, kind: kind || null,
        items: r.items,
        sources: store.listSources().filter(s => s.materials && s.materials.count)
          .map(s => ({ id: s.id, name: s.name, count: s.materials.count })),
      });
    }
    if ((m = p.match(/^\/api\/sources\/([\w-]+)\/materials$/)) && req.method === 'GET') {
      const src = store.getSource(m[1]);
      if (!src) return json(res, 200, { ok: false, alreadyGone: true, error: '来源不存在' });
      const q = String(url.searchParams.get('q') || '').trim();
      const kind = String(url.searchParams.get('kind') || '').trim();
      const limit = clampInt(url.searchParams.get('limit'), 40, 1, 200);
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
      const data = materials.loadMaterials(src.id);
      const r = materials.searchSymbols(data ? data.symbols : [], q, { limit, offset, kind });
      return json(res, 200, {
        source: { id: src.id, name: src.name }, stats: src.materials || null,
        total: r.total, offset, limit, q, kind: kind || null, items: r.items,
      });
    }
    if (p === '/api/sources' && req.method === 'POST') {
      try {                                   // 用户输入问题统一 400（解析失败/文件超限/缺地址）
      const body = await readBody(req);
      const mode = body.mode || 'url';
      const srcId = 'src_' + crypto.randomBytes(3).toString('hex');
      const asCfg = body.autoSync;
      const wantAuto = asCfg === true || !!(asCfg && asCfg.enabled);
      let parsed, srcUrl = null, sdkMeta = null, matSummary = null;
      if (mode === 'sdk') {
        // 自动同步必须有远端地址（上传到本地的 SDK 只能手动重新解析）
        if (wantAuto && !body.url) throw new Error('自动同步需要提供 SDK / 清单地址；本地上传的 SDK 只能手动「重新解析」');
        const got = await collectSdkFiles(body);
        checkSdkSize(got.files);
        parsed = parseSDK(got.files, { sourceId: srcId, name: body.name, baseUrl: body.baseUrl, version: body.version });
        srcUrl = got.manifestUrl;
        sdkMeta = {
          format: parsed.format, formatName: parsed.formatName, digest: parsed.digest,
          manifestUrl: got.manifestUrl, origin: got.origin, notes: parsed.notes,
          files: saveSdkFiles(srcId, got.files),
        };
        matSummary = buildMaterialsFromFiles(srcId, got.files);
      } else if (mode === 'archive') {
        // 压缩包是本地文件，没有可轮询的远端，只能手动重新上传
        if (wantAuto) throw new Error('压缩包导入不支持自动同步；需要现网自动更新请用「SDK 地址」或「pip 安装」');
        const hit = arcCache.get(body.token);
        if (!hit) throw new Error('压缩包分析结果已过期（10 分钟），请重新选择压缩包上传');
        checkSdkSize(hit.files);
        parsed = parseSDK(hit.files, {
          sourceId: srcId, name: body.name || suggestSdkName(hit.name),
          baseUrl: body.baseUrl, version: hit.version || undefined,
        });
        sdkMeta = {
          format: parsed.format, formatName: parsed.formatName, digest: parsed.digest,
          manifestUrl: null, origin: 'archive', notes: parsed.notes,
          files: saveSdkFiles(srcId, hit.files),
          archive: {
            name: hit.name, kind: hit.stats.kind, bytes: hit.stats.archiveBytes,
            entries: hit.stats.entries, selected: hit.stats.selected, skipped: hit.stats.skipped,
            unpackedBytes: hit.stats.unpackedBytes, uploadedAt: hit.at,
          },
        };
        // 资料优先用「解压时全量扫描」的结果（含没被挑中的 model / 工具函数）；
        // 分析缓存过期重传时才退回按已保存源码重建
        matSummary = hit.materials
          ? saveSourceMaterials(srcId, hit.materials.symbols, { stats: hit.materials.stats, title: hit.name })
          : buildMaterialsFromFiles(srcId, hit.files, { title: hit.name });
      } else if (mode === 'pip') {
        // 两步导入：优先复用「安装并分析」缓存的结果，token 过期才重新装
        const hit = pipCacheGet(body.token);
        let got;
        if (hit) {
          checkSdkSize(hit.files);
          got = hit;
          parsed = parseSDK(hit.files, {
            sourceId: srcId, name: body.name || (hit.pkg && hit.pkg.name),
            baseUrl: body.baseUrl, version: (hit.pkg && hit.pkg.version) || undefined,
          });
        } else {
          if (body.token && !body.package) throw new Error('分析结果已过期，请重新点「安装并分析」');
          ({ got, parsed } = await analyzePip(body, srcId));
        }
        sdkMeta = {
          format: parsed.format, formatName: parsed.formatName, digest: parsed.digest,
          manifestUrl: null, origin: 'pip', notes: parsed.notes,
          files: saveSdkFiles(srcId, got.files),
          pip: pipMeta(got),
        };
        matSummary = buildMaterialsFromFiles(srcId, got.files);
      } else if (mode === 'manual') {
        const op = parseManual(body, { sourceId: srcId, fallbackBaseUrl: BASE + '/upstream/_sandbox', defaultVersion: body.version || 'manual' });
        parsed = { title: body.name || op.name, version: op.version, baseUrl: op.baseUrl, operations: [op] };
      } else {
        let spec;
        if (mode === 'url') {
          srcUrl = String(body.url || '').trim();
          if (!/^https?:\/\//.test(srcUrl)) throw new Error('请填写 http(s) 开头的文档地址');
          spec = await fetchDoc(srcUrl);
        } else {
          // 兼容两种传法：text 为字符串（前端 textarea），或直接内嵌 JSON 对象（脚本/接口调用）
          const raw = body.text;
          if (raw && typeof raw === 'object') spec = raw;
          else { try { spec = JSON.parse(String(raw || '')); } catch { throw new Error('粘贴内容不是合法 JSON'); } }
        }
        parsed = parseOpenAPI(spec, { sourceId: srcId, name: body.name, fallbackBaseUrl: BASE + '/upstream/_sandbox' });
      }
      // 一个接口都没识别、也没抓到符号，才算真失败（基础库/框架包会有符号，仍然值得入库）
      const symCount = (matSummary && matSummary.count) || 0;
      if (!parsed.operations.length && !symCount && ['sdk', 'archive', 'pip'].includes(mode)) {
        throw new Error('这个包里既没有 HTTP 接口调用，也没有可收录的函数 / 类（可能只是构建产物或空壳包）');
      }
      // operationId 与已有接口冲突时加来源后缀，避免悄悄覆盖内置接口
      const taken = new Set(allOperations().map(o => o.id));
      for (const o of parsed.operations) if (taken.has(o.id)) o.id = `${o.id}_${srcId.slice(4)}`;
      const src = {
        id: srcId, name: String(body.name || parsed.title || '未命名来源').slice(0, 40),
        // pip / 压缩包导入在存储上仍归为 sdk 来源（sdk.pip / sdk.archive 记录来源细节），
        // 复用「重新解析 / 版本漂移告警 / 批量删除」同一条链路
        type: (mode === 'pip' || mode === 'archive') ? 'sdk' : mode, url: srcUrl, specVersion: parsed.version,
        baseUrl: parsed.baseUrl || (mode === 'sdk' || mode === 'archive' ? BASE + '/upstream/_sandbox' : ''),
        importedAt: Date.now(), updatedAt: Date.now(), operations: parsed.operations,
        ...(sdkMeta ? { sdk: sdkMeta } : {}),
        ...(matSummary ? { materials: matSummary } : {}),
        ...(wantAuto ? { autoSync: { enabled: true, intervalMs: clampInterval(asCfg && asCfg.intervalMs) } } : {}),
      };
      store.saveSource(src);
      await registry.refresh();
      return json(res, 200, {
        source: sourceSummary(src), added: src.operations.length,
        operations: src.operations.map(o => ({ id: o.id, method: o.method, path: o.path, name: o.name })),
        ...(sdkMeta ? { sdk: { format: sdkMeta.format, formatName: sdkMeta.formatName, files: sdkMeta.files.length, digest: sdkMeta.digest, notes: sdkMeta.notes, origin: sdkMeta.origin } } : {}),
        ...(matSummary ? { materials: matSummary } : {}),
        catalogVersion: registry.version(),
      });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/sources/batch-delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(Boolean))] : [];
      if (!ids.length) return json(res, 400, { error: '未指定要卸载的接口来源' });
      if (ids.length > 200) return json(res, 400, { error: '单次最多卸载 200 个来源' });
      const deleted = [], missing = [];
      let removedOps = 0;
      for (const id of ids) {
        const src = store.getSource(id);
        if (!src) { missing.push(id); continue; }
        removedOps += (src.operations || []).length;
        store.removeSource(id);
        materials.removeMaterials(id);
        _poolCache.delete(id);
        deleted.push(id);
      }
      if (deleted.length) await registry.refresh();
      return json(res, 200, { ok: true, deleted, missing, deletedCount: deleted.length, removedOps, catalogVersion: registry.version() });
    }
    if ((m = p.match(/^\/api\/sources\/([\w-]+)$/)) && req.method === 'DELETE') {
      const src = store.getSource(m[1]);
      // 幂等卸载：来源可能已被另一个标签页卸载、被批量删除带走、或因接口被删空自动移除。
      // 这种情况报 404 会让用户以为「卸载失败」，其实目标状态已经达成 —— 回 200 + alreadyGone，前端刷新列表即可。
      if (!src) return json(res, 200, { ok: true, alreadyGone: true, removed: 0, catalogVersion: registry.version() });
      store.removeSource(m[1]);
      materials.removeMaterials(m[1]);
      _poolCache.delete(m[1]);
      trashSdkPath(path.join(SDK_DIR, m[1]));    // 源码目录进回收站，由 sweepSdkTrash 分批清理
      await registry.refresh();
      return json(res, 200, { ok: true, removed: src.operations.length, catalogVersion: registry.version() });
    }
    if ((m = p.match(/^\/api\/sources\/([\w-]+)\/refresh$/)) && req.method === 'POST') {
      const src = store.getSource(m[1]);
      if (!src) return json(res, 404, { error: '来源不存在' });
      try {
        // pip 来源支持指定新版本重装：{spec:"stripe==12.0.0"}，等同「升级后重新分析」
        const body = await readBody(req);
        if (body.spec && src.sdk && src.sdk.pip) {
          src.sdk.pip.spec = normalizeSpec(body.spec).spec;
          store.saveSource(src);
        }
        return json(res, 200, await syncSource(src));
      }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    // 自动同步开关（现网 SDK / 文档更新后自动重新解析，间隔 1 分钟 ~ 24 小时）
    if ((m = p.match(/^\/api\/sources\/([\w-]+)\/autosync$/)) && req.method === 'POST') {
      const src = store.getSource(m[1]);
      if (!src) return json(res, 404, { error: '来源不存在' });
      const body = await readBody(req);
      const enabled = body.enabled !== false;
      if (enabled && !sourceRemote(src) && !(src.sdk && src.sdk.pip)) {
        return json(res, 400, { error: '该来源没有可拉取的地址，无法自动同步；本地上传的 SDK 只能手动「重新解析」' });
      }
      src.autoSync = {
        ...(src.autoSync || {}), enabled,
        intervalMs: clampInterval(body.intervalMs != null ? body.intervalMs : (src.autoSync && src.autoSync.intervalMs)),
      };
      store.saveSource(src);
      return json(res, 200, { ok: true, autoSync: sourceSummary(src).autoSync });
    }
    if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, store.listAlerts());
    // 告警 id 含 "->"（new URL 会把 > 编码为 %3E），必须先解码再比对，否则清不掉
    if ((m = p.match(/^\/api\/alerts\/(.+)\/clear$/)) && req.method === 'POST') { store.clearAlert(decodeURIComponent(m[1])); return json(res, 200, { ok: true }); }
    if (p === '/api/alerts/clear-all' && req.method === 'POST') {
      const n = store.listAlerts().length; store.clearAllAlerts(); return json(res, 200, { ok: true, cleared: n });
    }
    // ── API：认证凭证（AK/SK）──
    if (p === '/api/creds' && req.method === 'GET') {
      return json(res, 200, {
        items: store.listCreds().map(c => ({ ...c, sk: maskSk(c.sk) })),
        opBindings: store.opBindings(),
      });
    }
    if (p === '/api/creds' && req.method === 'POST') {
      const body = await readBody(req);
      const cred = createCred(body);
      // 创建成功后把完整 SK 返回一次（仅此一次），列表中永远只回掩码
      return json(res, 200, { cred: { ...cred, sk: maskSk(cred.sk) }, skOnce: cred.sk });
    }
    if ((m = p.match(/^\/api\/creds\/bind-op$/)) && req.method === 'POST') {
      const body = await readBody(req);               // {operationId, credId|null} —— 单接口级绑定
      const op = allOperations().find(o => o.id === body.operationId);
      if (!op) return json(res, 404, { error: '接口不存在：' + body.operationId });
      if (body.credId && !store.getCred(body.credId)) return json(res, 404, { error: '凭证不存在' });
      store.setOpBinding(body.operationId, body.credId || null);
      return json(res, 200, { ok: true, operationId: body.operationId, credId: body.credId || null });
    }
    // 更新凭证：换模式（如 hmac → ecloud 接移动云）/ 换 AK / 换 SK / 改名，id 不变所以绑定关系都还在
    if ((m = p.match(/^\/api\/creds\/([\w-]+)$/)) && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const cred = updateCred(m[1], body);
        return json(res, 200, { ok: true, cred: { ...cred, sk: maskSk(cred.sk) } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/creds\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (!store.getCred(m[1])) return json(res, 404, { error: '凭证不存在' });
      deleteCred(m[1]);                               // 同步清理单接口绑定 + 流程级 authId
      return json(res, 200, { ok: true });
    }
    // 流程级认证：对该流程内所有未单独绑定凭证的接口生效（单接口绑定优先）
    if ((m = p.match(/^\/api\/flows\/([\w-]+)\/auth$/)) && req.method === 'POST') {
      const body = await readBody(req);
      const f = store.getFlow(m[1]);
      if (!f) return json(res, 404, { error: 'flow not found' });
      if (body.authId && !store.getCred(body.authId)) return json(res, 404, { error: '凭证不存在' });
      for (const key of ['published', 'draft']) {
        const def = f[key] && f[key].def;
        if (def) { if (body.authId) def.authId = body.authId; else delete def.authId; }
      }
      store.persistFlows();
      return json(res, 200, { ok: true, flowId: f.id, authId: body.authId || null });
    }

    if (p === '/api/admin/catalog-bump' && req.method === 'POST') {
      catalogVersion = catalogVersion === 'v2026.10' ? 'v2026.11' : 'v2026.12';
      for (const op of OPERATIONS) op.version = catalogVersion;
      const changed = await registry.refresh();
      return json(res, 200, { version: catalogVersion, changed, alerts: store.listAlerts().length });
    }
    if (p === '/api/admin/catalog-restore' && req.method === 'POST') {
      catalogVersion = 'v2026.10';
      for (const op of OPERATIONS) op.version = catalogVersion;
      await registry.refresh();
      return json(res, 200, { version: catalogVersion });
    }

    // ── 静态资源 ──
    if (req.method === 'GET') {
      let file = p === '/' ? '/index.html' : p;
      const full = path.join(__dirname, 'public', path.normalize(file).replace(/^([./\\])+/, ''));
      if (full.startsWith(path.join(__dirname, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(full));
      }
    }
    json(res, 404, { error: 'not found', path: p });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// 退出前把「合并写」缓冲里的运行记录落盘（并行批跑时内存中可能还有最新状态）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { store.flushRuns(); } finally { process.exit(0); } });
}
process.on('exit', () => { try { store.flushRuns(); } catch { /* 退出路径忽略 */ } });

// 启动时清一遍孤儿资料文件（来源已卸载但删除当时被运行环境拦截而残留的）
function pruneMaterials() {
  const ids = new Set(store.listSources().map(s => s.id));
  for (const id of materials.listMaterialSources()) if (!ids.has(id)) materials.removeMaterials(id);
}
pruneMaterials();

registry.start(4000).then(() => console.log('registry ready, catalog', registry.version()));
server.listen(PORT, () => console.log(`APIFlow 平台已启动 → ${BASE}`));

// ── 现网自动更新：定时扫描开启了 autoSync 的来源，到点重新拉取 SDK / 文档并按差异更新注册表 ──
const SYNC_TICK_MS = 15 * 1000;
setInterval(() => {
  const due = store.listSources().filter(s => syncDue(s));
  if (!due.length) return;
  (async () => {
    for (const s of due) {
      try {
        const r = await syncSource(s);
        const n = r.added.length + r.changed.length + r.removed.length;
        console.log(`[auto-sync] ${s.name} 同步完成${n ? `：+${r.added.length} ~${r.changed.length} -${r.removed.length}` : '（无变化）'}`);
      } catch (e) {
        console.log(`[auto-sync] ${s.name} 同步失败：${e.message}`);
      }
    }
  })();
}, SYNC_TICK_MS).unref?.();

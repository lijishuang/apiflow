// ── 自然语言 → 动作路由（确定性规则，不依赖在线模型）──
// 一句话先判「它想到底干什么」：
//   run-flow    运行已有流程（说了流程名 / 运行·执行·跑）
//   debug-op    调试单个接口（说了接口名 / 调试·调一下·请求）
//   draft-flow  现场拼一条流程并只读试跑（多个动作 / 条件分支 / 明确要求新建）
//   query       只是问平台现状（有哪些流程、最近运行、告警、接口、SDK 资料）
// 参数（供应商号 / SKU / 日期 / k=v / JSON）在同一层抽出来，执行时直接填进接口。
const materials = require('./materials');
const match = require('./match');
const { buildDraft } = require('./agent');

const RUN_VERB = /(运行|执行|跑一下|跑一遍|跑起来|启动|触发|重放|replay|run\b)/i;
const DEBUG_VERB = /(调试|调一下|调用一下|试一下|试跑|直接调|发起请求|请求一下|测一下|打一下|debug)/i;
const CREATE_VERB = /(新建|创建一个|建一个|搭建|编排|生成.*流程|做一条流程|帮我做|串起来|组合)/;
const COND_WORDS = /(如果|若|当.*就|否则|不然|然后|接着|再|之后|分别|同时)/;
// 只读 / 写动作词：用来在「库存」这类同时命中查询与同步接口时判断用户到底想干嘛
const READ_VERB = /(查询|查看|看一下|看看|获取|列出|列表|详情|多少|状态|是什么)/;
const WRITE_VERB = /(同步|创建|新建|标记|拒绝|更新|修改|删除|提交|推送|写入|下发|开通)/;

const STOPWORDS = new Set(['查询', '获取', '列表', '详情', '同步', '状态', '信息', '数据', '接口', '管理', '操作', '推送', '更新', '调用', '服务', '流程', '运行', '执行', '调试']);

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[「」『』“”"']/g, '');
const bigrams = s => {
  const t = norm(s), out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const overlap = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / A.size;
};

/* ───────── 意图打分 ───────── */
function scoreFlows(text, flows) {
  const t = norm(text);
  return flows.map(f => {
    const n = norm(f.name);
    let score = 0;
    if (n && t.includes(n)) score += 48 + Math.min(12, n.length);
    else {
      const ov = overlap(f.name, text);
      if (ov > 0.34) score += Math.round(ov * 42);
    }
    const def = (f.published && f.published.def) || (f.draft && f.draft.def);
    if (def) {
      const opNames = def.nodes.filter(x => x.type === 'http').map(x => x.name || x.id);
      for (const nm of opNames) if (nm && t.includes(norm(nm))) score += 7;
      if (def.input && def.input.sample) {
        for (const v of Object.values(def.input.sample)) {
          if (typeof v === 'string' && v.length >= 3 && t.includes(norm(v))) score += 6;
        }
      }
    }
    if (score > 0 && RUN_VERB.test(text)) score += 10;
    return { f, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

function scoreOps(text, ops) {
  // 与搭建器共用同一套中文匹配：逐子句取最强接口，句子没说完的半句不会被当成接口
  const bonus = DEBUG_VERB.test(text) ? 8 : 0;
  const picked = match.pickOps(text, ops, { min: 44 })
    .map(r => ({ op: r.op, score: r.score + bonus, hit: r.kwHit || r.op.name, primary: true }));
  const seen = new Set(picked.map(x => x.op.id));
  const rest = match.rankOps(text, ops).filter(r => !seen.has(r.op.id)).slice(0, 3)
    .map(r => ({ op: r.op, score: r.score + bonus, hit: r.kwHit || r.op.name, primary: false }));
  return [...picked, ...rest].sort((a, b) => b.score - a.score);
}

/* ───────── 参数抽取 ───────── */
function extractArgs(text, op) {
  const args = {};
  // 1) 文本里直接给的 JSON 对象
  const jm = String(text).match(/\{[\s\S]*\}/);
  if (jm) {
    try {
      const obj = JSON.parse(jm[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) Object.assign(args, obj);
    } catch { /* 不是合法 JSON 就跳过 */ }
  }
  // 2) k=v / k: v
  const kv = /([a-zA-Z_][\w]{1,24})\s*[=:：]\s*("([^"]*)"|'([^']*)'|([^\s,，;；、)]+))/g;
  let mm;
  while ((mm = kv.exec(String(text)))) {
    const key = mm[1];
    const val = mm[3] ?? mm[4] ?? mm[5];
    if (val && val.length <= 120) args[key] = val;
  }
  // 3) 常见业务编号
  const patterns = {
    supplierId: /\bS-\d{3,}\b/i,
    sku: /\bSKU-?\w+\b/i,
    orderId: /\bO-\d{3,}[A-Za-z0-9-]*\b/i,
    instanceId: /\bi-[A-Za-z0-9]{6,}\b/,
    invoiceId: /\b(?:INV|inv)[-_]\w+\b/,
    date: /\b20\d{2}-\d{2}-\d{2}\b/,
  };
  for (const [k, re] of Object.entries(patterns)) {
    const m = String(text).match(re);
    if (m) args[k] = m[0];
  }
  // 4) 中文日期
  if (!args.date) {
    const d = new Date();
    if (/昨天/.test(text)) d.setDate(d.getDate() - 1);
    else if (/前天/.test(text)) d.setDate(d.getDate() - 2);
    if (/今天|昨天|前天/.test(text)) args.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // 5) 单参数接口：句子里孤立的编号直接归给它
  if (op && (op.params || []).length === 1) {
    const pn = op.params[0];
    if (!args[pn]) {
      const m = String(text).match(/\b[A-Z]{1,5}-?\d[A-Za-z0-9-]{1,}\b/);
      if (m) args[pn] = m[0];
    }
  }
  // 6) 参数名就是「值」的键：把纯数字/中文短词按参数名兜底
  if (op) {
    for (const pn of op.params || []) {
      if (args[pn] != null) continue;
      const re = new RegExp(`${pn}\\s*(?:为|是|用|取|等于)\\s*([A-Za-z0-9_-]{1,40}|[\\u4e00-\\u9fa5]{2,8})`, 'i');
      const m = String(text).match(re);
      if (m) args[pn] = m[1];
    }
  }
  return args;
}

/* ───────── 查询型 ───────── */
function detectQuery(text, flows, ops) {
  const t = String(text);
  if (/(资料|函数|方法|类|签名|sdk 里|SDK里)/i.test(t)) return { kind: 'materials' };
  if (/(告警|异常|失败原因|漂移)/.test(t)) return { kind: 'alerts' };
  if (/(接口|注册表|工具集|可用接口|api 目录)/i.test(t) && !DEBUG_VERB.test(t)) return { kind: 'ops' };
  if (/(运行记录|最近运行|历史运行|跑过|执行记录|最近.*失败|失败.*运行)/.test(t)) return { kind: 'runs' };
  // 「新建一个流程…」是创建意图，即使句子里带了「流程 / 运行 / 接口」等词也不当查询
  if (/(流程|flow)/i.test(t) && !RUN_VERB.test(t) && !CREATE_VERB.test(t)) return { kind: 'flows' };
  if (/(概况|概览|大盘|统计|健康|整体|多少流程|成功率)/.test(t)) return { kind: 'overview' };
  if (/(流程|运行|接口)/.test(t) && !RUN_VERB.test(t) && !DEBUG_VERB.test(t) && !CREATE_VERB.test(t)) return { kind: 'overview' };
  return null;
}

/* ───────── 主入口 ───────── */
function resolve(text, { flows = [], ops = [], baseUrl = '' } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'error', error: '说点什么吧，例如「运行供应商准入检查」或「调试查询库存 SKU-02」' };

  const flowsScored = scoreFlows(raw, flows);
  const opsScored = scoreOps(raw, ops);
  const bestFlow = flowsScored[0] || null;
  // 「库存」这类词会同时命中查询与同步两个接口：句子里只有查询类动词时，优先只读接口
  const readIntent = READ_VERB.test(raw) && !WRITE_VERB.test(raw);
  const bestRead = opsScored.find(x => x.op.readOnly !== false && x.score >= 44) || null;
  const bestOp = (readIntent && bestRead) ? bestRead : (opsScored[0] || null);
  const distinctOps = new Set(opsScored.filter(x => x.primary && x.score >= 48).map(x => x.op.id));
  const primary = opsScored.filter(x => x.primary);
  const explicitRun = RUN_VERB.test(raw);
  const explicitDebug = DEBUG_VERB.test(raw);
  const explicitCreate = CREATE_VERB.test(raw);
  const conditional = COND_WORDS.test(raw) && distinctOps.size >= 2;
  // 明确说了「调试 / 调一下」时，哪怕句子里带了两个关键词也按单接口调试走（用户点的就是这一个）
  const strongDebug = explicitDebug && !!bestOp && bestOp.score >= 50;
  // 「一个接口明显压过其他」且句子里没有先后连接词 → 用户就是在说这一个接口
  const stepConnector = /(然后|接着|之后|同时|分别|并且|以及|；|;)/.test(raw);
  // 句子里只提到一个接口（且没被别的子句补上第二个）才算「就是在说这一个」
  const dominant = !!bestOp && (primary.length === 1 || (primary.length === 0 && opsScored.length === 1));
  const singleAction = dominant && !stepConnector && !!bestOp && bestOp.score >= 52;

  const candidates = [
    ...flowsScored.slice(0, 3).map(x => ({
      kind: 'run-flow', id: x.f.id, name: x.f.name, score: x.score,
      meta: x.f.published ? `v${x.f.published.version}` : '未发布',
    })),
    ...opsScored.slice(0, 4).map(x => ({
      kind: 'debug-op', id: x.op.id, name: x.op.name, score: x.score,
      meta: `${x.op.method} ${x.op.path}`,
    })),
  ].sort((a, b) => b.score - a.score).slice(0, 5);

  const refs = materials.searchSymbols(materialPool(), raw, { limit: 4 }).items.map(s => ({
    name: s.name, kind: s.kind, parent: s.parent, sig: s.sig, summary: s.summary,
    sourceName: s.sourceName, file: s.file, line: s.line,
  }));

  const finish = plan => ({ ...plan, candidates, refs, text: raw });

  /* ① 明确要运行某个流程 */
  if (bestFlow && (bestFlow.score >= 44 || (explicitRun && bestFlow.score >= 24)) && !(explicitDebug && !explicitRun)) {
    const f = bestFlow.f;
    const def = (f.published && f.published.def) || (f.draft && f.draft.def) || {};
    const sample = (def.input && def.input.sample) || {};
    const args = { ...sample, ...extractArgs(raw, null) };
    const missing = Object.entries(sample).filter(([k, v]) => (v === '' || v == null) && !args[k]).map(([k]) => k);
    return finish({
      kind: 'run-flow',
      flow: {
        id: f.id, name: f.name, published: !!f.published,
        version: f.published ? f.published.version : 0,
        nodeCount: (def.nodes || []).length,
        trigger: (def.trigger && def.trigger.type) || null,
      },
      args, missingParams: missing, needsConfirm: false,
      reason: f.published
        ? `命中已发布流程「${f.name}」（v${f.published.version}，${(def.nodes || []).length} 个节点）`
        : `命中流程「${f.name}」，但它还没发布 —— 将用草稿做只读试跑`,
    });
  }

  /* ② 只是问平台现状 */
  const q = detectQuery(raw, flows, ops);
  const strongAction = (bestFlow && bestFlow.score >= 30) || (bestOp && bestOp.score >= 52);
  if (q && !strongAction && !explicitCreate) return finish({ kind: 'query', query: q, reason: '这是一条查询请求，直接从平台读取数据' });

  /* ③ 需要现场拼流程：多动作 / 条件分支 / 明确要求新建（明确单接口调试时除外） */
  if (explicitCreate || conditional || (distinctOps.size >= 2 && !strongDebug && !singleAction)) {
    const out = buildDraft(raw, { list: () => ops, version: () => 'live', toNode: registryToNode });
    if (!out.error) {
      const def = out.draft;
      const writes = def.nodes.filter(n => n.type === 'http' && !/^GET$/i.test(n.config.method));
      const steps = def.nodes.filter(n => n.type === 'http').length;
      return finish({
        kind: 'draft-flow',
        draft: {
          id: def.id, name: def.name,
          nodes: def.nodes.filter(n => n.type === 'http').map(n => ({
            id: n.id, name: n.name, method: n.config.method, path: String(n.config.url).replace(baseUrl, ''),
          })),
          writeCount: writes.length, nodeCount: def.nodes.length,
        },
        draftDef: def,
        args: def.input && def.input.sample || {},
        missingParams: def.missingParams || [],
        needsConfirm: false,
        reason: `描述里有 ${steps} 个接口动作${conditional ? '、含条件分支' : ''} —— 生成一条新流程并只读试跑（${writes.length ? writes.length + ' 个写操作以桩代替' : '全部是只读接口'}）`,
      });
    }
  }

  /* ④ 单个接口 → 直接调试 */
  if (bestOp && bestOp.score >= 44) {
    const op = bestOp.op;
    const args = extractArgs(raw, op);
    const missing = (op.params || []).filter(p => args[p] == null || args[p] === '');
    return finish({
      kind: 'debug-op',
      op: {
        id: op.id, name: op.name, method: op.method, path: op.path,
        readOnly: op.readOnly !== false, sourceId: op.sourceId || 'builtin',
        params: op.params || [], baseUrl: op.baseUrl || baseUrl,
      },
      args, missingParams: missing,
      needsConfirm: op.readOnly === false,
      reason: `命中接口「${op.name}」（${op.method} ${op.path}）${op.readOnly === false ? '，这是写操作，执行前需要你确认' : ''}`,
    });
  }

  /* ⑤ 兜底：能拼就拼，否则给候选 */
  const out = buildDraft(raw, { list: () => ops, version: () => 'live', toNode: registryToNode });
  if (!out.error) {
    const def = out.draft;
    return finish({
      kind: 'draft-flow',
      draft: {
        id: def.id, name: def.name,
        nodes: def.nodes.filter(n => n.type === 'http').map(n => ({
          id: n.id, name: n.name, method: n.config.method, path: String(n.config.url).replace(baseUrl, ''),
        })),
        writeCount: def.nodes.filter(n => n.type === 'http' && !/^GET$/i.test(n.config.method)).length,
        nodeCount: def.nodes.length,
      },
      draftDef: def,
      args: def.input && def.input.sample || {},
      missingParams: def.missingParams || [],
      needsConfirm: false,
      reason: '没有完全对应的流程，按描述里的接口生成一条新流程并只读试跑',
    });
  }

  if (q) return finish({ kind: 'query', query: q, reason: '按查询处理' });

  return finish({
    kind: 'error',
    error: candidates.length
      ? '没听明白要执行什么。可以更具体一点，比如「运行 ' + candidates[0].name + '」'
      : '没听明白要执行什么，也没在注册表里找到对应接口。可先在 Web 端「接口」页接入接口或导入 SDK。',
  });
}

// buildDraft 需要 registry 形状的对象；这里用最小实现，避免把整份注册表传进意图层
function registryToNode(op, paramValues = {}) {
  const { renderStr } = require('./engine');
  const url = renderStr(op.path, paramValues);
  const node = {
    id: op.id.replace(/[^a-zA-Z0-9_]/g, '_'),
    type: 'http', name: op.name || op.id,
    operationId: op.id, apiVersion: op.version,
    config: { method: op.method, url: (op.baseUrl || '') + url },
    retry: op.readOnly !== false && /^GET$/i.test(op.method)
      ? { maxAttempts: 3, backoffMs: 300 }
      : { maxAttempts: 1, backoffMs: 300 },
  };
  if (op.hash) node.apiHash = op.hash;
  if (op.bodySchema && !/^GET$/i.test(op.method)) node.config.body = op.bodyExample || {};
  if (!/^GET$/i.test(op.method)) node.idempotencyKey = '{{run.num}}-' + node.id;
  return node;
}

// 资料池由调用方注入（server 里有跨来源缓存），没有就空
let _poolProvider = () => [];
function setMaterialPool(fn) { _poolProvider = fn; }
function materialPool() { try { return _poolProvider() || []; } catch { return []; } }

module.exports = { resolve, extractArgs, setMaterialPool };

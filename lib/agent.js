// ── 搭建阶段：Agent 编排器（LLM 只在此处参与）──
// 自然语言需求 → 依据工具注册表生成 DSL 草稿 → 三道闸：
//   ① JSON Schema 校验  ② 试运行 Dry-run（只读接口）  ③ 人工画布确认
const crypto = require('crypto');
const { validate } = require('./dsl');
const match = require('./match');
const docs = require('./docs');
const paramhint = require('./paramhint');
const settings = require('./settings');
const llm = require('./llm');

// —— 轻量 NL 意图解析（确定性规则，替代在线 LLM；接入真实 LLM 时仅替换本模块）——
// 逐子句打分：最长公共子串 + 2-gram 覆盖率 + 动作词一致性 + 关键词，
// 每个子句只留最强的一个（「查一下告警策略列表」不会顺手把「删除告警策略」带进来）。
const MIN_SCORE = 44;

function parseIntent(text, operations) {
  return match.pickOps(text, operations, { min: MIN_SCORE });
}

function buildDraft(nlText, registry, opts = {}) {
  const t = String(nlText);
  const ops = registry.list();
  // 帮助手册：既作为「引用」展示给用户，也在主匹配落空时用来补全接口
  const assist = opts.assist !== undefined ? opts.assist : docs.assist(t, ops, { limit: 4 });

  // 流程名 = 第一个冒号前的前缀；意图解析只看冒号后的正文
  const ci = t.search(/[：:]/);
  let name = (ci > 0 ? t.slice(0, ci) : (t.split(/[，。；]/)[0])).slice(0, 16);
  const body = ci >= 0 ? t.slice(ci + 1) : t;

  // —— 条件子句切分：pre(如果前) cond(条件) then(就/则…否则前) else(否则后，可无) ——
  const fieldMap = { 状态: 'status', 数量: 'qty', 库存: 'qty', 分数: 'score', 评分: 'score', 金额: 'amount' };
  const cmpMap = [['大于等于', '>='], ['小于等于', '<='], ['大于', '>'], ['超过', '>'], ['小于', '<'], ['低于', '<'], ['等于', '=='], ['包含', 'includes'], ['是', '=='], ['为', '==']];
  const condM = body.match(/(如果|若|当)([^，。；]*?)(就|则)(.*?)(?:否则|不然)(.*)/)      // 带 else
    || body.match(/(如果|若|当)([^，。；]*?)(就|则)(.*)/);                              // 不带 else
  let preText = body, thenText = '', elseText = '', condExpr = null;
  if (condM) {
    preText = body.slice(0, condM.index);
    thenText = condM[4] || '';
    elseText = condM[5] || '';
    const condRaw = condM[2];
    const fieldKw = Object.keys(fieldMap).find(k => condRaw.includes(k));
    const cmp = cmpMap.find(([kw]) => condRaw.includes(kw));
    const valM = condRaw.match(/(\d+(?:\.\d+)?|['"][^'"]+['"]|[A-Za-z_]{2,})\s*$/);
    if (fieldKw && cmp) {
      let val = valM ? valM[1] : "''";
      if (/^[A-Za-z_]+$/.test(val) && !/^['"]/.test(val)) val = `'${val}'`;
      condExpr = `${fieldMap[fieldKw]} ${cmp[1]} ${val}`;
    }
  }

  const scored = (text) => parseIntent(text || '', ops);
  const preOps = scored(preText);
  const thenOps = scored(thenText);
  const elseOps = scored(elseText);
  let allOps = condM ? [...preOps, ...thenOps, ...elseOps] : parseIntent(t, ops);
  // 主匹配全军覆没时，退回手册：手册里那一节（或那句话）明确指向某接口，且与描述足够接近。
  // 门槛不能太低 —— 猜错接口会直接生成一条错的流程；也不能太高，否则等同没有兜底。
  let docUsed = [];
  if (!allOps.length && assist && assist.candidates && assist.candidates.length) {
    let cands = assist.candidates;
    let top = cands[0], second = cands[1];
    let margin = !second || top.conf - second.conf >= 0.08;
    let pool = cands;
    // 平分时看「手册里是否原文点名」：整名出现的接口压过沾边就蹭到分的同名前缀接口
    if (!margin && top.conf >= 0.7) {
      const tie = cands.filter(c => c.conf >= top.conf - 0.02);
      const verbatim = tie.filter(c => c.strength === 1);
      if (verbatim.length === 1) { margin = true; pool = verbatim; top = verbatim[0]; }
    }
    if (top.conf >= 0.5 && margin) {
      docUsed = pool.filter(c => c.conf >= Math.max(0.45, top.conf - 0.12));
      allOps = docUsed.map(c => ({ op: c.op, score: c.score, doc: c }));
    }
  }
  if (!allOps.length) {
    const docSug = (assist && assist.candidates || []).map(c => c.op.name);
    const sug = [...new Set([...docSug, ...match.suggest(t, ops, 5)])].slice(0, 5);
    const hint = assist && assist.refs && assist.refs.length
      ? `手册里有相关章节（${assist.refs.slice(0, 2).map(r => `「${r.title}」`).join('、')}），但还不足以确定要调哪个接口。`
      : '';
    return {
      error: `没能把「${t.slice(0, 48)}」对到具体接口上。` + hint +
        (sug.length ? `可以直接说接口名（如「${sug[0]}」），或者说「先查…再…」这样分步描述。` : '可以先在「接口」页接入接口或导入 SDK。'),
      suggestions: sug,
      docRefs: (assist && assist.refs) || [],
    };
  }

  // 没有「名字：」前缀时，别把整句口语当流程名 —— 用首个命中的接口名兜底
  if (ci < 0 && allOps[0] && allOps[0].op) {
    const uniq = [...new Set(allOps.map(h => h.op.name))];
    name = (uniq.length > 1 ? `${uniq[0]} 等 ${uniq.length} 步` : uniq[0]).slice(0, 24);
  }

  // 参数识别
  const input = { schema: { type: 'object' }, sample: {} };
  const supplierId = t.match(/S-\d{3,}/);
  if (supplierId) { input.schema.properties = { supplierId: { type: 'string', example: supplierId[0] } }; input.sample.supplierId = supplierId[0]; }
  const sku = t.match(/SKU-?\w+/i);
  if (sku) { input.schema.properties = { ...(input.schema.properties || {}), sku: { type: 'string', example: sku[0] } }; input.sample.sku = sku[0]; }
  // 通用编号：O-20261101-001 / C-001 / A-12 等，用于填充任意接口的路径参数
  const genericId = t.match(/\b[A-Z]{1,4}-\d[A-Za-z0-9-]{2,}/);

  const nodes = [], edges = [];
  const missingParams = new Set();
  const missingQuery = [];                 // [{node, name, label}]：接口声明/学到是必填，但描述里没给值
  const store = registry.store || null;
  const add = (op) => {
    const vals = { ...input.sample };
    for (const pn of op.params || []) {
      if (vals[pn]) continue;
      const v = genericId ? genericId[0] : '';
      if (!v) missingParams.add(pn);
      vals[pn] = v;
      input.sample[pn] = v;
      input.schema.properties = { ...(input.schema.properties || {}), [pn]: { type: 'string', example: v } };
    }
    const n = registry.toNode(op, vals);
    // query 参数：描述里点名的取值优先，其次是运行期学到的可用取值；
    // 必填但两样都没有 → 记下来，在说明里点名让用户补（而不是发一个必然 400 的请求）
    try {
      const q = paramhint.slots(op, t, { store });
      if (Object.keys(q.values).length) n.config.query = q.values;
      for (const miss of q.missing) missingQuery.push({ node: n.id, name: miss.name, label: miss.label });
    } catch { /* 参数提示失败不影响主流程生成 */ }
    nodes.push(n);
    return n;
  };

  const draft = { id: 'flow_' + crypto.randomBytes(3).toString('hex'), name, version: 0, input };
  nodes.push({ id: 'start', type: 'start', name: '开始', config: {} });

  let prev = 'start';
  // 前置链只在有条件分支时需要（条件前的查询步骤）；无条件时整条链按提及顺序串行
  if (condM) {
    const preList0 = preOps.filter(h => h.op.readOnly !== false);
    const preList = preList0.length ? preList0 : preOps;
    for (const h of preList.slice(0, 3)) {
      if (nodes.some(n => n.operationId === h.op.id)) { prev = nodes.find(n => n.operationId === h.op.id).id; continue; }
      const n = add(h.op); edges.push({ from: prev, to: n.id }); prev = n.id;
    }
  }

  if (condM) {
    const condNode = { id: 'check_cond', type: 'condition', name: '条件判断', config: { expr: condExpr || "status == 'ACTIVE'" } };
    nodes.push(condNode);
    edges.push({ from: prev, to: 'check_cond' });
    const usedOpIds = new Set(nodes.map(n => n.operationId).filter(Boolean));
    const branch = (list, label, fallbackId) => {
      const fresh = list.filter(h => !usedOpIds.has(h.op.id));
      if (fresh.length) {
        let bp = 'check_cond';
        for (const h of fresh.slice(0, 1)) {
          usedOpIds.add(h.op.id);
          const n = add(h.op); edges.push({ from: bp, to: n.id, label }); bp = n.id;
        }
      } else {
        nodes.push({ id: fallbackId, type: 'transform', name: '（未指定动作）', config: { expr: { skipped: true } } });
        edges.push({ from: 'check_cond', to: fallbackId, label });
      }
    };
    branch(thenOps, 'then', 'noop_then');
    branch(elseOps, 'else', 'noop_else');
  } else {
    // 无条件：按提及顺序串行，文本里提到的接口全部保留（不再截断）
    let last = prev === 'start' ? null : prev;
    const used = new Set();
    for (const h of allOps) {
      if (used.has(h.op.id)) continue;
      used.add(h.op.id);
      const n = add(h.op);
      if (last) edges.push({ from: last, to: n.id });
      else edges.push({ from: 'start', to: n.id });
      last = n.id;
    }
  }

  // 画布布局：通用分列算法（start 在左，节点按距 start 的步数分列，同列纵向居中）
  draft.nodes = nodes; draft.edges = edges;
  draft.layout = computeLayout(draft);

  // 三道闸 ①：Schema 校验
  const gate1 = validate(draft);
  draft.missingParams = [...missingParams];
  draft.missingQuery = missingQuery;
  draft.gates = {
    schema: { ok: gate1.ok, errors: gate1.errors, warnings: gate1.warnings },
    dryRun: { ok: null },          // ② 待执行
    confirm: { ok: null },         // ③ 待人工画布确认
  };
  return {
    draft,
    explanation: buildExplanation(draft, registry, docUsed),
    docRefs: (assist && assist.refs) || [],
    docUsed: docUsed.map(d => ({ operationId: d.op.id, name: d.op.name, docName: d.docName, evidence: d.evidence })),
  };
}

function buildExplanation(def, registry, docUsed) {
  const parts = [];
  const httpNodes = def.nodes.filter(n => n.type === 'http');
  parts.push(`已生成流程草稿「${def.name}」，共 ${def.nodes.length} 个节点（${httpNodes.length} 个接口调用）。`);
  if (docUsed && docUsed.length) {
    const d0 = docUsed[0];
    parts.push(`这段描述接口名没写全，是按帮助手册《${d0.docName}》里的说法对上的：`
      + `${docUsed.map(x => `「${x.evidence ? x.evidence.slice(0, 26) : x.op.name}」→ ${x.op.name}`).join('；')}。`);
  }
  parts.push('目标接口均来自工具注册表，已绑定 API 版本 ' + registry.version() + '。');
  const writes = httpNodes.filter(n => !/^GET$/i.test(n.config.method));
  if (writes.length) parts.push(`提示：${writes.map(w => w.id).join('、')} 是写操作，已默认加上幂等键；未配置重试。`);
  if (def.missingParams && def.missingParams.length) parts.push(`路径参数 ${def.missingParams.join('、')} 在描述里没有给出取值，请在画布节点里补全后再试运行。`);
  const qNodes = httpNodes.filter(n => n.config.query && Object.keys(n.config.query).length);
  if (qNodes.length) {
    const pick = qNodes.map(n => Object.entries(n.config.query).map(([k, v]) => `${k}=${v}`).join('、'));
    parts.push(`已带上 Query 参数：${pick.join('；')}。`);
  }
  if (def.missingQuery && def.missingQuery.length) {
    const txt = [...new Set(def.missingQuery.map(x => `${x.name}${x.label && x.label !== x.name ? `（${x.label}）` : ''}`))];
    parts.push(`该接口还要求必填参数 ${txt.join('、')}，描述里没有给出取值 —— 在节点属性的 Query 里补上再试运行，否则网关会返回「参数校验异常」。`);
  }
  parts.push('请在画布确认后保存发布。');
  return parts.join('');
}

/* ───────── 自然语言「调整」已有草稿 ───────── */
// 「把告警策略列表放到最前面」「删掉最后一步」「超时改成 5 秒」「再加一个删除告警策略」
// 这类话里没有完整接口名，重建整条流程是错的 —— 应该在现有草稿上打补丁。
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  let m = s.match(/^十([一二三四五六七八九])$/); if (m) return 10 + CN_NUM[m[1]];
  m = s.match(/^([一二三四五六七八九])十$/);      if (m) return CN_NUM[m[1]] * 10;
  m = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/); if (m) return CN_NUM[m[1]] * 10 + CN_NUM[m[2]];
  return CN_NUM[s] || 0;
}

// 直线链：只有 start + http 的流程才谈得上「调顺序」；带条件分支的请回画布
function httpChain(def) {
  const nodes = def.nodes || [], edges = def.edges || [];
  if (!nodes.every(n => n.type === 'http' || n.type === 'start')) return null;
  const http = nodes.filter(n => n.type === 'http');
  if (!http.length) return null;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const next = new Map(edges.filter(e => !e.label).map(e => [e.from, e.to]));
  const out = [];
  let cur = 'start';
  const guard = new Set();
  while (next.has(cur)) {
    cur = next.get(cur);
    if (guard.has(cur)) return null;
    guard.add(cur);
    const n = byId.get(cur);
    if (!n) return null;
    if (n.type === 'http') out.push(n);
  }
  return out.length === http.length ? out : null;
}

function relink(draft, chain) {
  const start = (draft.nodes || []).find(n => n.type === 'start') || { id: 'start', type: 'start', name: '开始', config: {} };
  draft.nodes = [start, ...chain];          // 节点表顺序跟执行顺序一致，界面读起来才不拧巴
  const edges = [];
  let prev = 'start';
  for (const n of chain) { edges.push({ from: prev, to: n.id }); prev = n.id; }
  draft.edges = edges;
  draft.layout = computeLayout(draft);
}

// ── 通用画布布局：节点按「距 start 的最长步数」分列（列距 230），同列纵向居中（间距 260）──
// 修掉旧版首节点 x=470 离 start 空一截的 off-by-one；分支/多列图也适用。
function computeLayout(def) {
  const nodes = def.nodes || [], edges = def.edges || [];
  const start = nodes.find(n => n.type === 'start');
  const layout = {};
  if (!start) return layout;
  layout[start.id] = { x: 40, y: 240 };
  const outMap = new Map(nodes.map(n => [n.id, edges.filter(e => e.from === n.id).map(e => e.to)]));
  const depth = new Map([[start.id, 0]]);
  const queue = [start.id];
  const settled = new Set();
  while (queue.length) {                    // settled 防环：深度只增不减，最多 V*V 次松弛
    const id = queue.shift();
    const d = depth.get(id) || 0;
    for (const to of outMap.get(id) || []) {
      if ((depth.get(to) || 0) < d + 1) {
        depth.set(to, d + 1);
        if (!settled.has(to)) queue.push(to);
      }
    }
    settled.add(id);
  }
  const byDepth = new Map();
  for (const n of nodes) {
    if (n.id === start.id || n.type === 'start') continue;
    if (!depth.has(n.id)) continue;          // 不可达节点交给末尾统一摆放
    const d = depth.get(n.id);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(n.id);
  }
  let maxDepth = 0;
  for (const [d, ids] of byDepth) {
    maxDepth = Math.max(maxDepth, d);
    ids.forEach((id, i) => {
      layout[id] = { x: 240 + (d - 1) * 230, y: Math.max(40, Math.round(240 + (i - (ids.length - 1) / 2) * 260)) };
    });
  }
  // start 自身或不可达节点：放在第一列之后、画布下方，肉眼可见地「待接线」
  nodes.forEach(n => {
    if (layout[n.id] || n.type === 'start') return;
    layout[n.id] = { x: 240, y: 640 };
  });
  return layout;
}

// 句子里指的是哪一步：第 N 步 / 最后一步 / 接口名（模糊）/ 节点名原文
function locateNode(chain, phrase) {
  if (!chain.length) return null;
  const p = match.normalize(phrase);
  const step = p.match(/第([一二三四五六七八九十\d]+)(?:步|个|节|项|条|环节)/);
  if (step) return chain[cnNum(step[1]) - 1] || null;
  if (/(最后一步|最后|末尾|结尾|最后一个)/.test(p)) return chain[chain.length - 1];
  if (/(第一步|最前|开头|起始|第一个)/.test(p)) return chain[0];
  const pseudo = chain.map(n => ({ id: n.id, name: n.name, keywords: [], path: '' }));
  const hit = match.bestOp(phrase, pseudo, { min: 40 });
  if (hit) return chain.find(n => n.id === hit.op.id) || null;
  return chain.find(n => n.name && p.includes(match.normalize(n.name))) || null;
}

function isMoveClause(s) {
  return /(前面|后面|之前|之后|最前|最后|末尾|开头|换个位置|换一下位置|对调|交换|互换|顺序)/.test(String(s || ''))
    && /(放|移|调|拖|排|换|前|后|顺序)/.test(String(s || ''));
}

function reviseDraft(text, defInput, registry) {
  const t = String(text || '');
  const draft = JSON.parse(JSON.stringify(defInput));
  let chain = httpChain(draft);
  const changes = [], notes = [];
  let rest = t;          // 被「调顺序」吃掉的那一段要摘掉，否则后面的「新增/删除」会把句子重新解读一遍

  // ⓐ 换位置 / 排到谁前面：先在整句上处理 —— 「把 A 和 B 换个位置」一按「和」切句就断了
  if (chain && isMoveClause(t)) {
    const swap = t.match(/(?:把|将)?\s*([^，。；,;:：]+?)\s*(?:和|与)\s*([^，。；,;:：]+?)\s*(?:换个位置|换一下位置|对调|交换|互换)/);
    const mv = !swap && t.match(/(?:把|将)\s*([^，。；,;:：]+?)\s*(?:放|移|调|拖|排)(?:到|至)?\s*([^，。；,;:：]*?)\s*(前面|之前|前边|后面|之后|后边|最前|最后|末尾|开头)/);
    if (swap) {
      rest = t.replace(swap[0], ' ');
      const a = locateNode(chain, swap[1]), b = locateNode(chain, swap[2]);
      if (a && b && a !== b) {
        const ia = chain.indexOf(a), ib = chain.indexOf(b);
        chain[ia] = b; chain[ib] = a;
        changes.push(`交换「${a.name}」和「${b.name}」的位置`);
      } else notes.push(`没认出要交换的两步：「${t}」`);
    } else if (mv) {
      rest = t.replace(mv[0], ' ');
      const src = locateNode(chain, mv[1]);
      const dst = mv[2] ? locateNode(chain, mv[2]) : null;
      const toFront = /(前面|之前|前边|最前|开头)/.test(mv[3]);
      const toBack = /(后面|之后|后边|最后|末尾)/.test(mv[3]);
      if (src && dst && src !== dst) {
        chain = chain.filter(n => n.id !== src.id);
        const at = chain.indexOf(dst);
        chain.splice(toFront ? at : at + 1, 0, src);
        changes.push(`把「${src.name}」调到「${dst.name}」${toFront ? '前面' : '后面'}`);
      } else if (src && (toFront || toBack)) {
        chain = chain.filter(n => n.id !== src.id);
        if (toFront) chain.unshift(src); else chain.push(src);
        changes.push(`把「${src.name}」放到${toFront ? '最前' : '最后'}`);
      } else {
        notes.push(`没认出要把哪一步移到哪：「${t}」`);
      }
    } else {
      notes.push('没听出要调哪两步，可以说「把 A 放到 B 前面」或「把 A 和 B 换个位置」');
    }
  } else if (!chain && isMoveClause(t)) {
    notes.push('这条流程含条件分支，顺序请直接在画布上调整');
  }

  for (const clause of match.splitClauses(rest)) {
    if (!chain && /(删除|删掉|去掉|移除|加一个|添加|插入|放|移到|调到)/.test(clause)) {
      notes.push('这条流程含条件分支，结构和顺序请直接在画布上调整');
      continue;
    }

    // ① 新增一步
    if (/(再加|加一个|加个|添加|新增|插入|加上|追加)/.test(clause)) {
      const sub = clause.replace(/.*?(?:再加|加一个|加个|添加|新增|插入|加上|追加)(?:一个|个|一步|一条|上)?/, '');
      const hit = match.bestOp(sub || clause, registry.list(), { min: 40 });
      if (hit) {
        let id = String(hit.op.id).replace(/[^a-zA-Z0-9_]/g, '_');
        if (chain.some(n => n.id === id)) id = id + '_' + (chain.length + 1);
        const node = { ...registry.toNode(hit.op, {}), id };
        try {
          const q = paramhint.slots(hit.op, sub || clause, { store: registry.store });
          if (Object.keys(q.values).length) node.config.query = q.values;
        } catch { /* 参数提示失败不影响结构调整 */ }
        draft.nodes.push(node);
        chain.push(node);
        changes.push(`新增「${hit.op.name}」`);
        continue;
      }
      notes.push(`没认出要加哪个接口：「${clause}」`);
      continue;
    }

    // ② 删除一步
    if (/(删除|删掉|去掉|移除|不要了?|删了)/.test(clause)) {
      const node = locateNode(chain, clause);
      if (!node) { notes.push(`没认出要删哪一步：「${clause}」`); continue; }
      chain = chain.filter(n => n.id !== node.id);
      draft.nodes = draft.nodes.filter(n => n.id !== node.id);
      if (draft.layout) delete draft.layout[node.id];
      changes.push(`删除「${node.name}」`);
      continue;
    }

    // ③ 调顺序在切句之前就处理掉了（「把 A 和 B 换个位置」被「和」切开就断了），这里只跳过
    if (isMoveClause(clause)) continue;

    // ④ 超时 / 重试 / 退避：整体改，或只改句子里点名的那个接口
    const tm = clause.match(/超时(?:时间)?[^0-9]{0,10}(\d+)\s*(毫秒|ms|秒钟|秒|s)?/i);
    const rm = clause.match(/(?:重试|最多)[^0-9]{0,8}(\d+)\s*(?:次)?/);
    const bm = clause.match(/退避[^0-9]{0,8}(\d+)\s*(毫秒|ms|秒钟|秒|s)?/i);
    if (tm || rm || bm) {
      const target = locateNode(chain, clause);
      const targets = target ? [target] : chain;
      for (const n of targets) {
        if (tm) {
          const unit = String(tm[2] || '').toLowerCase();
          n.timeout = Number(tm[1]) * (unit === '秒' || unit === '秒钟' || unit === 's' ? 1000 : 1);
        }
        if (rm) {
          if (!(Number(rm[1]) >= 1)) notes.push('重试次数至少是 1');
          else n.retry = { maxAttempts: Number(rm[1]), backoffMs: (n.retry && n.retry.backoffMs) || 300 };
        }
        if (bm) {
          const unit = String(bm[2] || '').toLowerCase();
          n.retry = { maxAttempts: (n.retry && n.retry.maxAttempts) || 1, backoffMs: Number(bm[1]) * (unit === '秒' || unit === '秒钟' || unit === 's' ? 1000 : 1) };
        }
      }
      const who = target ? `「${target.name}」` : '全部接口节点';
      if (tm) changes.push(`${who}超时 ${targets[0].timeout}ms`);
      if (rm) changes.push(`${who}最多重试 ${rm[1]} 次`);
      if (bm) changes.push(`${who}退避 ${targets[0].retry.backoffMs}ms`);
      continue;
    }

    // ⑤ 改名
    const nm = clause.match(/(?:名字?|名称|标题|流程名)(?:改成|改为|叫|换成)\s*[「“"]?([^」”"，。；,;]{1,20})/);
    if (nm) { draft.name = nm[1].trim(); changes.push(`流程改名为「${draft.name}」`); continue; }
  }

  if (!changes.length) {
    return {
      revision: notes.length > 0,
      error: notes.length
        ? `这条我按「调整」理解，但没落到具体动作上：${notes.join('；')}。`
        : '这不像是在调整现有流程。要改结构可以直接说「把 X 放到最前面」「删掉最后一步」「超时改成 5 秒」，或者描述一条新流程。',
      suggestions: match.suggest(t, registry.list(), 5),
    };
  }

  if (chain) relink(draft, chain);
  const g = validate(draft);
  draft.missingParams = draft.missingParams || [];
  draft.gates = {
    schema: { ok: g.ok, errors: g.errors, warnings: g.warnings },
    dryRun: { ok: null }, confirm: { ok: null },
  };
  return { draft, changes, notes, explanation: buildRevisionNote(draft, changes) };
}

function buildRevisionNote(def, changes) {
  const steps = def.nodes.filter(n => n.type === 'http').length;
  return `已按你的描述调整草稿「${def.name}」（${steps} 个接口步骤）：${changes.join('；')}。`
    + '画布已同步更新，确认后可继续调试或发布。';
}

/* ───────── LLM 搭建（OpenAI 兼容网关；设置页配置，失败回退规则引擎）───────── */
// 与规则引擎同一条出口：产出 DSL 草稿 → 三道闸。LLM 只负责「看懂人话、挑对接口、
// 连对结构」，参数渲染/幂等键/重试默认值仍由 registry.toNode 物化，不确定性被关在搭建期。

// 目录给 LLM 的紧凑投影：去掉 baseUrl/hash/keywords 等无关字段，description 截短 —— 省一半 token，首响快很多
function catalogForLLM(ops) {
  return ops.map(o => ({
    id: o.id, name: o.name, method: o.method, path: o.path,
    params: o.params || [], readOnly: o.readOnly !== false,
    expect: o.expect || [],
    description: (o.description || '').slice(0, 40),
  }));
}

const LLM_SYSTEM = `你是 APIFlow 平台的流程搭建器：把用户的自然语言需求转成流程 DSL（JSON），只输出一个 JSON 对象，不要解释、不要代码围栏。

DSL 结构：
{
  "name": "流程名（不超过16个字）",
  "input": {"schema": {"type": "object", "properties": {"参数名": {"type": "string"}}}, "sample": {"参数名": "示例值"}},
  "nodes": [
    {"id": "start", "type": "start", "name": "开始"},
    {"id": "step_id", "type": "http", "operationId": "目录中的接口id", "name": "步骤名",
     "params": {"路径参数名": "取值"}, "query": {"query参数名": "取值"}, "body": {"字段": "值"},
     "assert": {"expr": "code == 0"}},
    {"id": "check1", "type": "condition", "name": "条件判断", "config": {"expr": "score < 60"}},
    {"id": "t1", "type": "transform", "name": "整理数据", "config": {"expr": {"字段": "值"}}}
  ],
  "edges": [{"from": "start", "to": "step_id"}, {"from": "check1", "to": "a", "label": "then"}, {"from": "check1", "to": "b", "label": "else"}]
}

硬性规则：
1. http 节点的 operationId 必须逐字取自下方接口目录，禁止编造；描述里没有可靠对应的接口就不要硬造节点。
2. start 节点恰好一条出边；整个流程不能有环；每个节点都要能从 start 到达。
3. condition 节点必须恰好两条出边，label 分别为 then 和 else；expr 左值是上游输出的字段名，比较符只用 == != > < >= <= includes。
4. 目录 params 列出的路径参数必须给值：描述里有就用描述里的（同时写进 input.sample），没有就给空字符串并写进 input.schema.properties。
5. body 只在该接口是 POST/PUT/PATCH 且描述给出了字段时输出；query 取值描述里没提就不要编。
6. 节点 id 用小写英文和下划线；不要输出 layout、gates 或注释。
7. assert 断言（可选，加在关键 http 节点上做确定性校验）：{"expr": "输出字段表达式"} 校验业务码，{"outputHas": ["字段"]} 校验返回结构，{"status": [200]} 校验状态码（必须是数组）。目录 expect 里的字段是接口承诺会返回的，适合做 outputHas；用户描述了成功标准才加 expr，没提就不要编。
8. 下游要引用上游输出字段时，用 {{nodes.上游节点id.output.字段路径}}；两个接口之间的字段映射不确定时优先问（见下方提问协议），不要猜字段名。

提问协议：当关键决策真的拿不准、猜错会搭出错误流程时，不要硬猜，改为输出：
{"ask": {"question": "一句话问清歧义点", "options": [{"label": "选项短标题", "detail": "选它的含义/后果"}]}}
- 选项 2~4 个，label 一行以内，detail 说清差别；再加一个 "freeHint": "也可以直接打字描述其他想法"（可选）。
- 只在这三类情况提问：① 需求能对上目录里多个接口、选错就不是用户想要的；② 跨接口传参不确定该提取上游哪个字段；③ 断言/判断条件该用哪个标准（业务码、状态码还是某字段阈值）。
- 目录、近期对话或常识里能确定的不要问；一次只问最关键的一个问题。
- 用户回答后（在近期对话里能看到你的提问和用户的选择），直接输出完整 DSL，不要再次提问。`;

// 组装消息：新建 = 需求→DSL；调整 = 现有草稿+指令→完整新 DSL
function llmMessages({ text, ops, prevDef, wantsNew, history = [] }) {
  const catalog = JSON.stringify(catalogForLLM(ops));
  const turns = (history || []).slice(-6).map(h => `${h.role === 'user' ? '用户' : '助手'}：${String(h.text || '').slice(0, 300)}`).join('\n');
  const parts = [`# 接口目录（operationId 必须逐字取自这里）\n${catalog}`];
  if (turns) parts.push(`# 近期对话\n${turns}`);
  if (prevDef && !wantsNew) {
    const cur = { name: prevDef.name, input: prevDef.input, nodes: prevDef.nodes, edges: prevDef.edges };
    parts.push(`# 当前草稿（用户在它基础上调整；输出调整后的完整 DSL，不是 diff）\n${JSON.stringify(cur)}`);
    parts.push(`# 用户的调整要求\n${text}`);
  } else {
    parts.push(`# 用户需求\n${text}`);
  }
  return [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: parts.join('\n\n') }];
}

function uniqNodeId(used, base) {
  let id = String(base).replace(/[^a-zA-Z0-9_]/g, '_') || 'node';
  if (!/^[a-zA-Z]/.test(id)) id = 'n_' + id;
  while (used.has(id)) id = id + '_' + used.size;
  used.add(id);
  return id;
}

// LLM 输出 → 合法 DSL：物化 http 节点（参数渲染/幂等键/重试默认）、补 start 出边与条件分支、
// 兜不住就抛错（调用方回退规则引擎），绝不让半成品进三道闸
function normalizeLLMDraft(raw, registry, { text = '', store = null } = {}) {
  if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('LLM 输出缺少 nodes');
  const byId = new Map(registry.list().map(o => [o.id, o]));
  const used = new Set();
  const nodes = [], edges = [];
  const input = { schema: { type: 'object', properties: {} }, sample: {} };
  if (raw.input && raw.input.sample && typeof raw.input.sample === 'object') Object.assign(input.sample, raw.input.sample);

  if (!raw.nodes.some(n => n && n.type === 'start')) raw.nodes.unshift({ id: 'start', type: 'start', name: '开始' });
  for (const rn of raw.nodes) {
    if (!rn || typeof rn !== 'object') continue;
    const type = ['start', 'http', 'condition', 'transform', 'loop'].includes(rn.type) ? rn.type : null;
    if (!type) continue;
    const id = uniqNodeId(used, rn.id || type);
    if (type === 'start') { nodes.push({ id, type: 'start', name: '开始', config: {} }); continue; }
    if (type === 'http') {
      const op = byId.get(rn.operationId || rn.opId);
      if (!op) throw new Error(`LLM 引用了目录中不存在的接口：${rn.operationId || rn.opId}`);
      const params = {};
      for (const pn of op.params || []) {
        const v = rn.params && rn.params[pn] != null && rn.params[pn] !== '' ? String(rn.params[pn]) : (input.sample[pn] || '');
        params[pn] = v;
        if (v) { input.sample[pn] = v; input.schema.properties[pn] = { type: 'string', example: v }; }
      }
      const n = registry.toNode(op, params);
      n.id = id;                       // 用 LLM 给的节点 id（去重后），否则它输出的 edges 会引用不上
      if (rn.name) n.name = String(rn.name).slice(0, 40);
      if (rn.query && typeof rn.query === 'object' && !Array.isArray(rn.query))
        n.config.query = Object.fromEntries(Object.entries(rn.query).map(([k, v]) => [String(k), String(v)]));
      if (rn.body !== undefined && rn.body !== null && typeof rn.body === 'object') n.config.body = rn.body;
      if (Number(rn.timeout) >= 100) n.timeout = Math.min(120000, Math.round(Number(rn.timeout)));
      if (rn.retry && Number(rn.retry.maxAttempts) >= 1)
        n.retry = { maxAttempts: Math.min(10, Math.round(Number(rn.retry.maxAttempts))), backoffMs: Number(rn.retry.backoffMs) >= 0 ? Number(rn.retry.backoffMs) : 300 };
      if (rn.assert && typeof rn.assert === 'object' && !Array.isArray(rn.assert)) {
        const a = {};
        if (typeof rn.assert.expr === 'string' && rn.assert.expr.trim()) a.expr = rn.assert.expr.trim().slice(0, 200);
        if (Array.isArray(rn.assert.outputHas) && rn.assert.outputHas.length) a.outputHas = rn.assert.outputHas.map(String).slice(0, 8);
        // Schema 要求 status 是数组（如 [200]）；模型给单个数字时包成数组
        const st = Array.isArray(rn.assert.status) ? rn.assert.status : (Number(rn.assert.status) >= 100 ? [rn.assert.status] : null);
        if (st && st.length) a.status = st.map(Number).filter(x => x >= 100 && x < 600).slice(0, 6);
        if (a.expr || a.outputHas || (a.status && a.status.length)) n.assert = a;
      }
      // 手册/运行期学到的 query 取值：LLM 没给的槽位补上（与规则引擎同一套 paramhint）
      try {
        const q = paramhint.slots(op, text, { store });
        n.config.query = { ...(q.values || {}), ...(n.config.query || {}) };
      } catch { /* 参数提示失败不影响生成 */ }
      nodes.push(n);
      continue;
    }
    const n = { id, type, name: String(rn.name || (type === 'condition' ? '条件判断' : type === 'loop' ? '循环' : '转换')).slice(0, 40), config: (rn.config && typeof rn.config === 'object' && !Array.isArray(rn.config)) ? rn.config : {} };
    if (typeof rn.expr === 'string' && rn.expr) n.config.expr = rn.expr;
    if (rn.over) n.config.over = rn.over;
    if (rn.assert && typeof rn.assert === 'object' && !Array.isArray(rn.assert)) {
      const a = {};
      if (typeof rn.assert.expr === 'string' && rn.assert.expr.trim()) a.expr = rn.assert.expr.trim().slice(0, 200);
      if (Array.isArray(rn.assert.outputHas) && rn.assert.outputHas.length) a.outputHas = rn.assert.outputHas.map(String).slice(0, 8);
      if (a.expr || a.outputHas) n.assert = a;
    }
    nodes.push(n);
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  for (const re of raw.edges || []) {
    if (!re || !nodeIds.has(re.from) || !nodeIds.has(re.to) || re.from === re.to) continue;
    const e = { from: re.from, to: re.to };
    if (re.label === 'then' || re.label === 'else') e.label = re.label;
    if (re.map && typeof re.map === 'object' && !Array.isArray(re.map)) e.map = re.map;
    edges.push(e);
  }

  const start = nodes.find(n => n.type === 'start');
  let fromStart = edges.filter(e => e.from === start.id);
  if (!fromStart.length) {
    const first = nodes.find(n => n.type !== 'start');
    if (!first) throw new Error('LLM 生成的流程没有任何执行节点');
    edges.unshift({ from: start.id, to: first.id });
  } else if (fromStart.length > 1) {
    for (const e of fromStart.slice(1)) edges.splice(edges.indexOf(e), 1);
  }
  // 条件分支补齐：两条无标签出边按顺序贴 then/else；缺分支补「未指定动作」桩（与规则引擎一致）
  for (const n of nodes.filter(n => n.type === 'condition')) {
    const outs = edges.filter(e => e.from === n.id);
    if (outs.length === 2 && !outs.some(e => e.label)) { outs[0].label = 'then'; outs[1].label = 'else'; continue; }
    if (!outs.some(e => e.label === 'then') || !outs.some(e => e.label === 'else')) {
      for (const lab of ['then', 'else']) {
        if (outs.some(e => e.label === lab)) continue;
        const tid = uniqNodeId(used, 'noop_' + lab);
        nodes.push({ id: tid, type: 'transform', name: '（未指定动作）', config: { expr: { skipped: true } } });
        edges.push({ from: n.id, to: tid, label: lab });
      }
    }
  }

  const draft = {
    id: 'flow_' + crypto.randomBytes(3).toString('hex'),
    name: String(raw.name || '').trim().slice(0, 24) || '未命名流程',
    version: 0, input, nodes, edges,
    layout: computeLayout({ nodes, edges }),
  };
  // 路径参数没填上的点名出来，让用户在画布补
  const missingParams = [];
  for (const n of nodes.filter(n => n.type === 'http')) {
    for (const seg of (n.config.url || '').match(/\{(\w+)\}/g) || []) {
      const pn = seg.slice(1, -1);
      if (!missingParams.includes(pn)) missingParams.push(pn);
    }
  }
  draft.missingParams = missingParams;
  draft.missingQuery = [];
  const g = validate(draft);
  if (!g.ok) throw new Error('LLM 草稿未过 Schema 校验：' + g.errors[0]);
  draft.gates = { schema: { ok: true, errors: [], warnings: g.warnings }, dryRun: { ok: null }, confirm: { ok: null } };
  return draft;
}

// LLM 搭建入口。任何失败都抛错，由 server 端回退规则引擎 —— 本函数不做静默降级。
async function buildWithLLM({ text, registry, prevDef = null, wantsNew = false, history = [], store = null }) {
  const s = settings.load();
  if (!settings.isLLMOn()) throw new Error('LLM 未启用');
  const msgs = llmMessages({ text, ops: registry.list(), prevDef, wantsNew, history });
  const r = await llm.chat(msgs, {});
  const raw = llm.extractJson(r.content);
  // 反问模式：模型拿不准关键决策时选择向用户确认，而不是硬猜 —— 原样透传给前端渲染选项卡片
  if (raw && raw.ask && !Array.isArray(raw.nodes)) {
    const ask = raw.ask;
    const q = String(ask.question || '').trim();
    if (!q) throw new Error('LLM 输出了空提问');
    const options = (Array.isArray(ask.options) ? ask.options : [])
      .map(o => ({ label: String((o && o.label) || '').trim().slice(0, 60), detail: String((o && o.detail) || '').trim().slice(0, 120) }))
      .filter(o => o.label).slice(0, 4);
    if (options.length < 2) throw new Error('LLM 提问的选项不足两个');
    return { ask: { question: q.slice(0, 200), options, ...(ask.freeHint ? { freeHint: String(ask.freeHint).slice(0, 80) } : {}) }, engine: 'llm', usage: r.usage, ms: r.ms };
  }
  const draft = normalizeLLMDraft(raw, registry, { text, store });
  draft.source = 'nl';
  const explanation = `已由 LLM（${s.model}）生成草稿「${draft.name}」，共 ${draft.nodes.length} 个节点（${draft.nodes.filter(n => n.type === 'http').length} 个接口调用），耗时 ${(r.ms / 1000).toFixed(1)}s。`
    + buildExplanation(draft, registry, []);
  return { draft, explanation, usage: r.usage, ms: r.ms };
}

module.exports = { buildDraft, reviseDraft, buildWithLLM };

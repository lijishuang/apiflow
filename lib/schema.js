// ── 节点数据结构推断：为「数据映射」面板提供字段树与目标字段候选 ──
// 背景：原来配置传递数据要手写 {{nodes.X.output.entity.0.productName}}，节点 id 英文、
// 数组用数字下标、字段看不见、写错也不报错。这里把上游节点最近一次真实输出压成
// 可展开的字段树（带实际取值预览），再从下游节点配置与接口定义里推出目标字段候选，
// 让前端能「点选 / 拖拽 / 同名自动匹配」而不是手抄路径。
const MAX_NODES = 400;    // 单棵树最多展开多少个字段节点（防止大响应把弹窗撑爆）
const MAX_DEPTH = 6;      // 递归深度上限
const MAX_KEYS = 60;      // 单层最多展开多少个 key

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

// 取值预览：字符串截断，对象/数组只给结构提示，避免把整包响应塞进一行
function preview(v) {
  const t = typeOf(v);
  if (t === 'null') return 'null';
  if (t === 'object') return '{' + Object.keys(v).slice(0, 4).join(', ') + (Object.keys(v).length > 4 ? ', …' : '') + '}';
  if (t === 'array') return '[' + v.length + ' 项]';
  if (t === 'string') {
    const s = v.replace(/\s+/g, ' ');
    return s.length > 48 ? s.slice(0, 48) + '…' : s;
  }
  return String(v);
}

// 把「一次真实输出」压成字段树：数组取首元素展开（路径里保留 .0 下标）
function buildTree(value, max = MAX_NODES) {
  const budget = { n: 0, cut: false };
  const walk = (label, val, path, depth) => {
    if (budget.n >= max) { budget.cut = true; return null; }
    budget.n++;
    const t = typeOf(val);
    const node = { label, path, type: t };
    if (t === 'object') {
      const keys = Object.keys(val);
      node.count = keys.length;
      if (!keys.length) { node.sample = '{}'; return node; }
      if (depth >= MAX_DEPTH) { node.truncated = true; return node; }
      node.children = [];
      for (const k of keys.slice(0, MAX_KEYS)) {
        const c = walk(k, val[k], path ? `${path}.${k}` : k, depth + 1);
        if (c) node.children.push(c);
      }
      if (keys.length > MAX_KEYS) node.truncated = true;
    } else if (t === 'array') {
      node.count = val.length;
      if (!val.length) { node.sample = '[]'; return node; }
      if (depth >= MAX_DEPTH) { node.truncated = true; return node; }
      const c = walk('[0]', val[0], `${path}.0`, depth + 1);
      if (c) node.children = [c];
    } else {
      node.sample = preview(val);
    }
    return node;
  };

  const t = typeOf(value);
  let root;
  if (t === 'object') {
    const keys = Object.keys(value);
    root = keys.slice(0, MAX_KEYS).map(k => walk(k, value[k], k, 0)).filter(Boolean);
    if (keys.length > MAX_KEYS) budget.cut = true;
  } else if (t === 'array') {
    root = value.length ? [walk('[0]', value[0], '0', 0)].filter(Boolean) : [];
  } else {
    root = [walk('value', value, '', 0)].filter(Boolean);
  }
  return { root, truncated: budget.cut };
}

// 叶子字段（含空对象/空数组——它们可以作为整体映射）
function leavesOf(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.children && n.children.length) leavesOf(n.children, out);
    else out.push({ path: n.path, name: n.label, type: n.type, sample: n.sample });
  }
  return out;
}

// ── 目标字段候选：下游节点「要什么字段」 ──
// 来源：config.body / query / params / headers / form 里已写的 key，接口定义的参数名，
// 以及开始节点的流程输入示例（下游如果是 start 说明连反了，不提供）。
function targetsOf(def, nodeId, ops = []) {
  const node = (def.nodes || []).find(n => n.id === nodeId);
  if (!node) return [];
  const out = new Map();
  const add = (name, hint, required) => {
    const key = String(name || '').trim();
    if (!key || key.length > 64) return;
    const prev = out.get(key);
    if (prev) {
      if (required) prev.required = true;
      if (hint && !prev.hints.includes(hint)) prev.hints.push(hint);
      return;
    }
    out.set(key, { name: key, hints: hint ? [hint] : [], required: !!required });
  };

  const cfg = node.config || {};
  for (const part of ['params', 'query', 'body', 'form', 'headers']) {
    const v = cfg[part];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) add(k, part, false);
    }
  }
  // 接口定义里的参数（必填优先展示）
  const op = node.operationId ? ops.find(o => o.id === node.operationId) : null;
  if (op) for (const p of op.params || []) add(typeof p === 'string' ? p : p.name, '接口参数', p && p.required);
  // 转换节点：输出字段由 mapping 的 key 决定
  if (node.type === 'transform' && cfg.fields && typeof cfg.fields === 'object') {
    for (const k of Object.keys(cfg.fields)) add(k, '转换输出', false);
  }

  return [...out.values()].map(x => ({ name: x.name, hint: x.hints.join(' · '), required: x.required }));
}

// 取「最近一次有内容的输出」：失败/空的运行会把字段树清空，往前找最近一次有效结果
function pickOutput(runs, nodeId) {
  const hasContent = v => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return String(v).length > 0;
  };
  for (const r of runs || []) {
    if (!r || !r.nodes || !r.nodes[nodeId]) continue;
    const out = r.nodes[nodeId].output;
    if (hasContent(out)) return { output: out, runId: r.id, num: r.num, at: r.endedAt || r.startedAt, status: r.status };
  }
  return null;
}

function nodeSchema({ def, nodeId, toId = '', runs = [], ops = [] }) {
  const node = (def.nodes || []).find(n => n.id === nodeId);
  if (!node) return { error: '节点不存在：' + nodeId };
  const picked = pickOutput(runs, nodeId);

  let output = null, source = 'none', meta = null;
  if (picked) {
    output = picked.output;
    source = 'run';
    meta = { runId: picked.runId, num: picked.num, at: picked.at, status: picked.status };
  } else if (node.type === 'start') {
    // 开始节点没跑过时，退回流程输入示例
    const sample = (def.input && def.input.sample) || {};
    if (Object.keys(sample).length) { output = sample; source = 'sample'; }
  } else if (node.outputSample && typeof node.outputSample === 'object') {
    output = node.outputSample;
    source = 'sample';
  }

  const tree = output == null ? { root: [], truncated: false } : buildTree(output);
  const leaves = leavesOf(tree.root);
  const targets = toId ? targetsOf(def, toId, ops) : [];
  return {
    node: nodeId, to: toId || null,
    source, ...(meta || {}),
    fields: tree.root,
    leaves,
    truncated: tree.truncated,
    targets,
    // 只在有真实输出时给整包样本，前端用于「整体预览」
    sample: source === 'run' && output && JSON.stringify(output).length <= 4000 ? output : undefined,
  };
}

module.exports = { buildTree, leavesOf, targetsOf, nodeSchema, preview };

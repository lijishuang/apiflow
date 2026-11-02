// ── 搭建器自动修复：静态扫描草稿 DSL，能修的直接修，修不了的说明原因 ──
// 修复范围：非法/重复节点 id、悬空边、缺 start、start 出边数、条件缺 then/else 分支、
//           不可达节点、HTTP 节点缺 method/url（按注册表补全）、写操作缺幂等键、
//           路径参数未填充、布局缺失
const crypto = require('crypto');

function clone(def) { return JSON.parse(JSON.stringify(def)); }

function autoFix(def, ops) {
  const fixes = [], unfixable = [];
  const d = clone(def);
  d.nodes = d.nodes || []; d.edges = d.edges || [];
  const opById = new Map((ops || []).map(o => [o.id, o]));

  // 1) 节点 id 非法 / 重复 → 重命名并联动改边与布局
  const seen = new Set();
  for (const n of d.nodes) {
    if (!n.id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n.id) || seen.has(n.id)) {
      const old = n.id;
      let nid = (old && /^[a-zA-Z]/.test(String(old)) ? String(old).replace(/[^a-zA-Z0-9_]/g, '_') : 'node_' + crypto.randomBytes(2).toString('hex'));
      while (seen.has(nid)) nid += '_2';
      n.id = nid; seen.add(nid);
      for (const e of d.edges) { if (e.from === old) e.from = nid; if (e.to === old) e.to = nid; }
      if (d.layout && d.layout[old]) { d.layout[nid] = d.layout[old]; delete d.layout[old]; }
      fixes.push(`节点 id「${old || '(空)'}」非法或重复 → 重命名为 ${nid}`);
    } else seen.add(n.id);
  }
  const byId = new Map(d.nodes.map(n => [n.id, n]));

  // 2) 悬空边（引用不存在的节点）→ 删除
  d.edges = d.edges.filter(e => {
    if (!byId.has(e.from) || !byId.has(e.to)) { fixes.push(`删除悬空边 ${e.from} → ${e.to}（节点不存在）`); return false; }
    return true;
  });

  // 3) start 节点：缺失补上；出边必须恰好一条
  let start = d.nodes.find(n => n.type === 'start');
  if (!start) {
    start = { id: 'start', type: 'start', name: '开始', config: {} };
    d.nodes.unshift(start); byId.set('start', start);
    fixes.push('缺少 start 节点 → 自动补上');
  }
  const startOuts = d.edges.filter(e => e.from === start.id);
  if (startOuts.length === 0) {
    const first = d.nodes.find(n => n.id !== start.id);
    if (first) { d.edges.push({ from: start.id, to: first.id }); fixes.push(`start 无出边 → 连接到 ${first.id}`); }
  } else if (startOuts.length > 1) {
    for (const e of startOuts.slice(1)) {
      d.edges.splice(d.edges.indexOf(e), 1);
      fixes.push(`start 只允许一条出边 → 删除 ${e.from}→${e.to}`);
    }
  }

  // 4) 条件节点缺 then / else 分支 → 补桩节点
  for (const n of d.nodes.filter(x => x.type === 'condition')) {
    for (const label of ['then', 'else']) {
      if (!d.edges.some(e => e.from === n.id && e.label === label)) {
        const stubId = 'noop_' + label + '_' + crypto.randomBytes(2).toString('hex');
        d.nodes.push({ id: stubId, type: 'transform', name: `（${label} 未指定动作）`, config: { expr: { skipped: true } } });
        d.edges.push({ from: n.id, to: stubId, label });
        fixes.push(`条件节点 ${n.id} 缺少 ${label} 分支 → 补桩节点 ${stubId}`);
      }
    }
  }

  // 5) 不可达节点 → 沿主链末端接入
  const reach = new Set(); const stack = [start.id];
  while (stack.length) {
    const cur = stack.pop();
    if (reach.has(cur)) continue;
    reach.add(cur);
    for (const e of d.edges) if (e.from === cur) stack.push(e.to);
  }
  const unreach = d.nodes.filter(n => !reach.has(n.id));
  if (unreach.length) {
    let tail = start.id; const walked = new Set([tail]);
    while (true) {
      const e = d.edges.find(x => x.from === tail);
      if (!e || walked.has(e.to)) break;
      tail = e.to; walked.add(e.to);
    }
    for (const n of unreach) {
      d.edges.push({ from: tail, to: n.id });
      fixes.push(`节点 ${n.id} 从 start 不可达 → 接入主链末端`);
      tail = n.id;
    }
  }

  // 6) HTTP 节点：按注册表补 method/url；写操作补幂等键；路径参数未填尝试补
  for (const n of d.nodes.filter(x => x.type === 'http')) {
    const op = n.operationId && opById.get(n.operationId);
    if (op) {
      n.config = n.config || {};
      if (!n.config.method) { n.config.method = op.method; fixes.push(`节点 ${n.id} 缺少 method → 按注册表补为 ${op.method}`); }
      if (!n.config.url) { n.config.url = (op.baseUrl || '') + op.path; fixes.push(`节点 ${n.id} 缺少 url → 按注册表补全`); }
    }
    if (!n.config || !n.config.url) {
      unfixable.push(`节点 ${n.id} 缺少 url，且无法从注册表推断 —— 请在节点属性里填写`);
      continue;
    }
    const isWrite = n.config.method && !/^GET$/i.test(n.config.method);
    if (isWrite && n.retry && n.retry.maxAttempts > 1 && !n.idempotencyKey) {
      n.idempotencyKey = '{{run.num}}-' + n.id;
      fixes.push(`节点 ${n.id} 是写操作且重试 >1 → 自动加幂等键`);
    }
    if (!n.timeout) n.timeout = 10000;
    // URL 里残留 {param} 未渲染 → 尝试用流程输入示例填充
    for (const raw of String(n.config.url).match(/\{([a-zA-Z_]\w*)\}/g) || []) {
      const pn = raw.slice(1, -1);
      const sample = d.input && d.input.sample && d.input.sample[pn];
      if (sample) {
        n.config.url = n.config.url.split(raw).join(sample);
        fixes.push(`节点 ${n.id} 路径参数 ${pn} 未填 → 用示例值 ${sample} 填充`);
      } else {
        unfixable.push(`节点 ${n.id} 路径参数 {${pn}} 没有取值 —— 请补全 URL 或在流程输入示例里提供 ${pn}`);
      }
    }
  }

  // 7) 布局缺失 → 底部顺序排布
  const missing = d.nodes.filter(n => !(d.layout && d.layout[n.id]));
  if (missing.length) {
    d.layout = d.layout || {};
    missing.forEach((n, i) => { d.layout[n.id] = { x: 240 + i * 230, y: 500 }; });
    fixes.push(`补齐 ${missing.length} 个节点的画布布局`);
  }

  return { def: d, fixes, unfixable };
}

// ── 自动断言：按注册表 expect 给所有 HTTP 节点加断言（已有断言的节点不动）──
function autoAssert(def, ops) {
  const d = clone(def);
  const opById = new Map((ops || []).map(o => [o.id, o]));
  const added = [];
  for (const n of d.nodes.filter(x => x.type === 'http')) {
    if (n.assert) continue;
    const op = n.operationId && opById.get(n.operationId);
    const a = { ok: true };
    if (op && Array.isArray(op.expect) && op.expect.length) a.outputHas = op.expect;
    n.assert = a;
    added.push(a.outputHas ? `${n.id}（2xx + 校验字段 ${a.outputHas.join('/')}）` : `${n.id}（校验 2xx）`);
  }
  return { def: d, added };
}

module.exports = { autoFix, autoAssert };

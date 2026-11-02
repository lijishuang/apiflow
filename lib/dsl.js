// ── 流程 DSL 契约：唯一契约（人能读 · Agent 能生成 · 引擎能执行 · UI 能渲染）──
// 设计图：JSON + JSON Schema ｜ version 版本化 ｜ input 参数化 ｜ 幂等键 ｜ 重试策略
const NODE_TYPES = ['start', 'http', 'condition', 'transform', 'loop'];

function validate(def) {
  const errors = [];
  const warn = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['DSL 必须是对象'], warnings: warn };
  if (!def.name || typeof def.name !== 'string') errors.push('缺少流程名称 name');
  if (!Array.isArray(def.nodes) || !def.nodes.length) errors.push('缺少节点 nodes');

  const ids = new Set((def.nodes || []).map(n => n.id));
  if (ids.size !== (def.nodes || []).length) errors.push('节点 id 存在重复');
  for (const n of def.nodes || []) {
    if (!n.id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n.id)) errors.push(`节点 id 非法：${JSON.stringify(n.id)}`);
    if (!NODE_TYPES.includes(n.type)) errors.push(`节点 ${n.id} 类型非法：${n.type}（允许：${NODE_TYPES.join('/')}）`);
    if (n.type === 'http') {
      if (!n.config || !n.config.method || !n.config.url) errors.push(`HTTP 节点 ${n.id} 缺少 method/url`);
      if (n.config && n.config.method && !/^GET$|^(POST|PUT|PATCH|DELETE)$/.test(n.config.method.toUpperCase()))
        errors.push(`HTTP 节点 ${n.id} method 非法：${n.config.method}`);
    }
    if (n.type === 'condition' && !(n.config && n.config.expr)) errors.push(`条件节点 ${n.id} 缺少 expr`);
    if (n.type === 'loop' && !(n.config && n.config.over)) errors.push(`循环节点 ${n.id} 缺少 over（遍历表达式）`);
    if (n.retry) {
      if (n.retry.maxAttempts < 1 || n.retry.maxAttempts > 10) errors.push(`节点 ${n.id} 重试次数须在 1~10`);
      if (n.type === 'http' && n.config && /^POST|PUT|PATCH|DELETE$/i.test(n.config.method) && n.retry.maxAttempts > 1 && !n.idempotencyKey)
        warn.push(`节点 ${n.id} 是写操作且重试 >1 次但未配置幂等键，可能产生重复写入`);
    }
    if (n.timeout && (n.timeout < 100 || n.timeout > 120000)) errors.push(`节点 ${n.id} 超时须在 100~120000ms`);
    if (n.assert != null) {   // 断言配置（仅 HTTP 节点生效）
      if (n.type !== 'http') warn.push(`节点 ${n.id} 配置了 assert，但断言仅对 HTTP 节点生效`);
      else if (typeof n.assert !== 'object' || Array.isArray(n.assert)) errors.push(`节点 ${n.id} assert 必须是对象`);
      else {
        if (n.assert.status != null && !Array.isArray(n.assert.status)) errors.push(`节点 ${n.id} assert.status 必须是数组，如 [200,201]`);
        if (n.assert.outputHas != null && !Array.isArray(n.assert.outputHas)) errors.push(`节点 ${n.id} assert.outputHas 必须是字符串数组`);
        if (n.assert.expr != null && typeof n.assert.expr !== 'string') errors.push(`节点 ${n.id} assert.expr 必须是字符串`);
      }
    }
  }

  const edges = def.edges || [];
  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`边引用了不存在的起点：${e.from}`);
    if (!ids.has(e.to)) errors.push(`边引用了不存在的终点：${e.to}`);
  }
  const start = (def.nodes || []).find(n => n.type === 'start');
  if (!start) errors.push('缺少 start 节点');
  else {
    const fromStart = edges.filter(e => e.from === start.id);
    if (fromStart.length !== 1) errors.push('start 节点必须恰好有一条出边');
  }
  for (const n of def.nodes || []) {
    if (n.type === 'condition') {
      const out = edges.filter(e => e.from === n.id);
      const labels = out.map(e => e.label);
      for (const need of ['then', 'else']) if (!labels.includes(need)) errors.push(`条件节点 ${n.id} 缺少 ${need} 分支边`);
    }
  }
  // 入度检查（除 start 外，节点应可达）— 只警告
  const reach = new Set();
  if (start) {
    const stack = [start.id];
    while (stack.length) {
      const cur = stack.pop();
      if (reach.has(cur)) continue;
      reach.add(cur);
      for (const e of edges) if (e.from === cur) stack.push(e.to);
    }
    for (const n of def.nodes || []) if (!reach.has(n.id)) warn.push(`节点 ${n.id} 从 start 不可达（运行时将被跳过）`);
  }
  // input 参数化 schema
  if (def.input && def.input.schema && typeof def.input.schema !== 'object') errors.push('input.schema 必须是对象');

  return { ok: errors.length === 0, errors, warnings: warn };
}

// 只读操作判定（Dry-run 仅执行只读节点）
function isReadOnly(node) {
  if (node.type !== 'http') return true;
  return /^GET$/i.test(node.config.method);
}

module.exports = { validate, NODE_TYPES, isReadOnly };

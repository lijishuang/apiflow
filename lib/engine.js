// ── 运行阶段：确定性引擎（无 LLM）──
// 设计图：触发器 → 调度器（拓扑排序·分支并发·运行状态机）
//         → 节点执行器（HTTP·条件·转换·循环 ｜ 重试退避·超时·幂等键·从节点重放）
//         → 运行历史；实时事件流 SSE（node_start/node_end/edge_data/error）
const crypto = require('crypto');
const { isReadOnly } = require('./dsl');
const { authHeaders, ecloudSignedUrl } = require('./auth');
const { checkAssert, checkEndAssert } = require('./assert');
const { detectBusinessError, describe, AUTH_PARAM } = require('./bizerr');
const { labelOf } = require('./paramhint');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 模板渲染：{{input.x}} / {{nodes.id.output.y}} / {{run.id}} ──
function lookup(ctx, path) {
  const val = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
  return val;
}
function renderStr(tpl, ctx) {
  if (typeof tpl !== 'string') return tpl;
  let out = tpl.replace(/\{\{([^}]+)\}\}/g, (_, p) => {
    const v = lookup(ctx, p.trim());
    return v === undefined || v === null ? '' : String(v);
  });
  // 兼容 OpenAPI 风格单花括号 {param}：先查上下文，再回退到流程输入 input.<param>
  out = out.replace(/\{([a-zA-Z_][\w]*)\}/g, (_, p) => {
    let v = lookup(ctx, p);
    if (v === undefined || v === null) v = lookup(ctx, 'input.' + p);
    return v === undefined || v === null ? `{${p}}` : String(v);
  });
  return out;
}
function renderDeep(obj, ctx) {
  if (typeof obj === 'string') {
    const m = obj.match(/^\{\{([^}]+)\}\}$/);           // 整体引用保留类型
    if (m) { const v = lookup(ctx, m[1].trim()); return v === undefined ? null : v; }
    return renderStr(obj, ctx);
  }
  if (Array.isArray(obj)) return obj.map(x => renderDeep(x, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = renderDeep(v, ctx);
    return out;
  }
  return obj;
}

/**
 * 把节点上的 query 参数合并进 URL。
 * 规则：值已渲染（支持 {{输入}} / {{nodes.x.output.y}}）；空值、空名直接跳过；
 * URL 里手写过的同名参数优先（手写能精确控制编码与顺序，不被覆盖）；
 * 相对地址或模板没渲染完的地址原样返回，不猜。
 */
function withQuery(url, query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return url;
  const pairs = Object.entries(query).filter(([k, v]) => k && v !== undefined && v !== null && String(v) !== '');
  if (!pairs.length) return url;
  if (/\{\{/.test(url)) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  for (const [k, v] of pairs) {
    if (u.searchParams.has(k)) continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, String(x)));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ── SSE 事件总线 ──
class Bus {
  constructor() { this.clients = new Set(); this.recent = []; }
  subscribe(res) {
    this.clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    return () => this.clients.delete(res);
  }
  emit(event, data) {
    const payload = { event, data, ts: Date.now() };
    this.recent.push(payload); if (this.recent.length > 500) this.recent.shift();
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) { try { c.write(msg); } catch { this.clients.delete(c); } }
  }
}
const bus = new Bus();

// ── 条件表达式：仅支持 "左值 op 字面量"（== != > < >= <= includes）──
function evalExpr(expr, ctx) {
  const m = String(expr).trim().match(/^(.+?)\s*(==|!=|>=|<=|>|<|includes)\s*(.+)$/);
  if (!m) return Boolean(lookup(ctx, expr.trim()));
  const [, lp, op, rpRaw] = m;
  let left = lookup(ctx, lp.trim());
  let rp = rpRaw.trim();
  let right;
  if (/^['"].*['"]$/.test(rp)) right = rp.slice(1, -1);
  else if (/^\d+(\.\d+)?$/.test(rp)) right = Number(rp);
  else { right = lookup(ctx, rp); }
  if (left === undefined) left = null;
  switch (op) {
    case '==': return left == right;         // eslint-disable-line eqeqeq
    case '!=': return left != right;         // eslint-disable-line eqeqeq
    case '>': return Number(left) > Number(right);
    case '<': return Number(left) < Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<=': return Number(left) <= Number(right);
    case 'includes': return String(left).includes(String(right));
    default: return false;
  }
}

function summarize(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 160 ? s.slice(0, 157) + '…' : s;
  } catch { return String(v); }
}

// ── HTTP 执行（含重试退避 / 超时 / 幂等键 / 重试记录 / AK-SK 认证注入）──
// cred 由调用方按「单接口绑定 > 流程级绑定」解析；每次尝试重新签名（时间戳新鲜）
async function execHttp(node, ctx, run, cred, store) {
  const cfg = node.config;
  const method = (cfg.method || 'GET').toUpperCase();
  const renderedQuery = renderDeep(cfg.query || {}, ctx);
  const url = withQuery(renderStr(cfg.url, ctx), renderedQuery);
  const body = cfg.body != null ? renderDeep(cfg.body, ctx) : undefined;
  const bodyText = body != null && method !== 'GET' ? JSON.stringify(body) : '';
  const headers = { ...(cfg.headers || {}) };
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') headers[k] = renderStr(v, ctx);
  if (body != null) headers['content-type'] = headers['content-type'] || 'application/json';
  if (node.idempotencyKey) headers['idempotency-key'] = renderStr(node.idempotencyKey, ctx);

  const maxAttempts = node.retry && node.retry.maxAttempts > 1 ? node.retry.maxAttempts : 1;
  const backoff = (node.retry && node.retry.backoffMs) || 300;
  const timeout = node.timeout || 10000;
  const attempts = [];

  for (let i = 1; i <= maxAttempts; i++) {
    let reqUrl = url;
    if (cred && cred.mode === 'ecloud') reqUrl = ecloudSignedUrl(cred, method, url);   // 移动云 V2.0：签名进 query，每次尝试重新签名（时间戳/随机数新鲜）
    else if (cred) Object.assign(headers, authHeaders(cred, method, url, bodyText));
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(reqUrl, {
        method,
        headers,
        body: body != null && method !== 'GET' ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let parsed = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* 保留文本 */ }
      const rec = { n: i, status: res.status, ms: Date.now() - t0, ok: res.ok };
      attempts.push(rec);
      if (res.ok) {
        const reqInfo = { method, url: reqUrl, headers: recordedHeaders(headers), body };
        // HTTP 200 里也可能包着错误信封（{"code":"010024","state":"ERROR"}）——
        // 不识别就会把失败当成功：流程绿灯、下游拿到一坨错误 JSON。
        const biz = detectBusinessError(parsed);
        if (biz) {
          rec.ok = false;
          rec.bizCode = biz.code;
          // 认证参数不记成 query 参数（那是凭证/签名模式的问题，不是业务参数）
          const miss = biz.missing.filter(n => !AUTH_PARAM.test(n));
          if (store && node.operationId) {
            const rejected = {};
            for (const x of biz.invalid) if (x.param) rejected[x.param] = x.value;
            store.learnParamHint(node.operationId, { required: miss, rejected, lastError: biz.message });
          }
          const labels = {};
          for (const n of biz.missing) labels[n] = labelOf(n);
          return { output: parsed, status: res.status, attempts, request: reqInfo, error: describe(biz, labels), bizError: biz };
        }
        // 成功的取值记下来当示例：同一接口下次搭流程可以直接带上
        if (store && node.operationId) {
          const used = Object.entries(renderedQuery || {}).filter(([, v]) => v != null && String(v) !== '');
          if (used.length) store.learnParamHint(node.operationId, { sample: Object.fromEntries(used), lastError: null });
        }
        return { output: parsed, status: res.status, attempts, request: reqInfo };
      }
      if (i === maxAttempts) {
        // 4xx/5xx 也走同一套信封解析：网关的 {"errorMessage":"Input parameter AccessKey missing"}
        // 光看 JSON 得自己猜，「缺少 AccessKey —— 检查凭证绑定/签名模式」才是能照做的话
        const biz = detectBusinessError(parsed);
        const labels = {};
        if (biz) for (const n of biz.missing) labels[n] = labelOf(n);
        const detail = biz ? `｜${describe(biz, labels)}` : '';
        return {
          output: parsed == null ? null : parsed, status: res.status, attempts,
          request: { method, url: reqUrl, headers: recordedHeaders(headers), body },
          error: `HTTP ${res.status}: ${String(text).slice(0, 200)}${detail}`,
          bizError: biz || undefined,
        };
      }
    } catch (e) {
      attempts.push({ n: i, status: 0, ms: Date.now() - t0, ok: false, error: e.name === 'AbortError' ? `超时 ${timeout}ms` : String(e.message || e) });
      if (i === maxAttempts) {
        return { output: null, status: 0, attempts, request: { method, url: reqUrl, headers: recordedHeaders(headers), body }, error: attempts[attempts.length - 1].error };
      }
    } finally { clearTimeout(timer); }
    await sleep(backoff * Math.pow(2, i - 1));   // 指数退避
    run.events.push({ event: 'node_retry', data: { runId: run.id, node: node.id, attempt: i + 1, of: maxAttempts }, ts: Date.now() });
        bus.emit('node_retry', { runId: run.id, node: node.id, attempt: i + 1, of: maxAttempts });
  }
}

// 运行记录落库前脱敏：SK 不落盘（AK / 签名可留作审计）
function recordedHeaders(headers) {
  const out = { ...headers };
  if (out['x-api-secret']) out['x-api-secret'] = '***';
  return out;
}

// ── 调度器 ──
class Engine {
  constructor(store) { this.store = store; this.running = new Map(); }

  // 解析节点认证凭证：单接口绑定（operationId → opBindings）优先，其次流程级 def.authId
  resolveCred(def, node) {
    const c = this.store.creds || { items: [], opBindings: {} };
    const bid = (node.operationId && c.opBindings[node.operationId]) || def.authId || null;
    if (!bid) return null;
    const cred = c.items.find(x => x.id === bid);
    if (!cred) return null;
    if (node.operationId && c.opBindings[node.operationId] === bid) cred._via = 'operation';
    else cred._via = 'flow';
    return cred;
  }

  // 触发一次运行。fromNode 支持从指定节点重放（复用上游已存产物）
  async runFlow(def, input, opts = {}) {
    const run = {
      id: opts.runId || 'run_' + crypto.randomBytes(5).toString('hex'),
      num: this.store.nextRunNum(),
      flowId: def.id, flowName: def.name, version: def.version,
      trigger: opts.trigger || 'manual',
      // 谁触发的：手动 / 定时 / 插件令牌 / AK-SK 调用 —— Web 端与插件端都按这个字段展示
      actor: opts.actor || null,
      // 附加说明（如「插件生成的草稿只读试跑」），不影响执行
      meta: opts.meta || null,
      input: input || {},
      status: 'running',
      startedAt: Date.now(),
      nodes: {},        // id -> { status, output, error, attempts, request, startedAt, ms }
      events: [],
      replayOf: opts.replayOf || null, replayFrom: opts.fromNode || null,
    };
    this.store.addRun(run);
    // 事件记录：入 run.events（供运行历史回放审计）+ 实时推送 SSE
    const emit = (event, data) => { run.events.push({ event, data, ts: Date.now() }); bus.emit(event, data); };
    emit('run_start', { runId: run.id, num: run.num, flowId: def.id, flowName: def.name, version: def.version, trigger: run.trigger, actor: run.actor, meta: run.meta, input: run.input, replayFrom: run.replayFrom });
    this.running.set(run.id, run);

    // 上下文：重放时注入上游节点产物
    const ctx = { input: run.input, run: { id: run.id, num: run.num }, nodes: {} };
    if (opts.priorNodes) {
      for (const [nid, rec] of Object.entries(opts.priorNodes)) {
        ctx.nodes[nid] = { output: rec.output };
        run.nodes[nid] = { status: 'reused', output: rec.output, ms: rec.ms || null, attempts: rec.attempts || [], branch: rec.branch, httpStatus: rec.httpStatus, reused: true };
      }
    }

    const start = def.nodes.find(n => n.type === 'start');
    const byId = Object.fromEntries(def.nodes.map(n => [n.id, n]));
    const edgeKey = (e) => `${e.from}->${e.to}`;

    const runNode = async (node, inCtx) => {
      const rc = inCtx || ctx;   // 渲染上下文：边映射后 {{input.*}} 指向映射结果；nodes/run 等共享引用不变
      const existed = run.nodes[node.id];
      if (existed && (existed.status === 'done' || existed.status === 'reused')) {
        await advanceOut(node);   // 汇聚点/重放复用：不重复执行，但沿边继续推进下游
        return;
      }
      const rec = run.nodes[node.id] = { status: 'running', startedAt: Date.now(), attempts: [] };
      emit('node_start', { runId: run.id, node: node.id, type: node.type, name: node.name });
      const t0 = Date.now();
      let output = null, error = null, request = null, status = null;
      const cred = this.resolveCred(def, node);   // 节点级认证（单接口绑定 / 流程级）

      try {
        if (node.type === 'start') {
          output = run.input;
        } else if (node.type === 'http') {
          const r = await execHttp(node, rc, run, cred, this.store);
          output = r.output; attempts2rec(rec, r.attempts); request = r.request; status = r.status;
          if (r.bizError) rec.bizError = { code: r.bizError.code, message: r.bizError.message, missing: r.bizError.missing };
          if (r.error) { error = r.error; rec.status = 'failed'; }
          else if (node.assert) {   // 断言检查：HTTP 成功后校验状态码 / 输出字段 / 表达式
            const fails = checkAssert(node.assert, output, status);
            if (fails.length) { error = '断言失败：' + fails.join('；'); rec.status = 'failed'; rec.assertFails = fails; }
          }
        } else if (node.type === 'condition') {
          // 条件表达式以上游输出字段 + 全局上下文求值（如 status == 'ACTIVE'）
          const incoming = ctx.nodes[node.id].output || {};
          const scope = { ...rc, ...incoming, input: rc.input, run: rc.run, nodes: rc.nodes };
          const result = evalExpr(node.config.expr, scope);
          output = { expr: node.config.expr, result };
          rec.branch = result ? 'then' : 'else';
        } else if (node.type === 'transform') {
          output = renderDeep(node.config.expr, rc);   // 轻量转换：取值/组装/映射
        } else if (node.type === 'loop') {
          const items = lookup(rc, node.config.over.replace(/^\{\{|\}\}$/g, '').trim());
          if (!Array.isArray(items)) throw new Error(`loop.over 结果不是数组：${node.config.over}`);
          const results = [];
          for (const item of items) {
            rc[node.config.as || 'item'] = item;
            const r = await execHttp({ ...node, config: node.config.request, idempotencyKey: node.idempotencyKey ? renderStr(node.idempotencyKey, rc) : null }, rc, run, cred, this.store);
            results.push({ item, status: r.status, ok: !r.error, response: r.output });
            attempts2rec(rec, r.attempts);
            await sleep(30);
          }
          output = { count: items.length, results };
        }
      } catch (e) {
        error = String(e.message || e);
        rec.status = 'failed';
      }

      rec.endedAt = Date.now(); rec.ms = rec.endedAt - t0;
      rec.output = output; if (error) rec.error = error;
      if (request) rec.request = request;
      if (status != null) rec.httpStatus = status;
      if (rec.status !== 'failed') rec.status = 'done';
      // 将实际输出同步回上下文（供下游模板 {{nodes.X.output.Y}} 与 loop.over 引用）
      if (node.type === 'condition') { if (ctx.nodes[node.id]) ctx.nodes[node.id].cond = output; }
      else if (ctx.nodes[node.id]) ctx.nodes[node.id].output = output;
      else ctx.nodes[node.id] = { output };
      emit('node_end', {
        runId: run.id, node: node.id, type: node.type, name: node.name,
        status: rec.status, ms: rec.ms, branch: rec.branch,
        output: summarize(output), error: error || undefined,
        httpStatus: status || undefined, attempts: rec.attempts,
        auth: cred ? `${cred.name}（${cred._via === 'operation' ? '单接口绑定' : '流程级'}）` : undefined,
      });
      if (rec.assertFails) emit('assert_fail', { runId: run.id, node: node.id, fails: rec.assertFails });
      this.store.updateRun(run);

      if (rec.status === 'failed') {
        emit('error', { runId: run.id, node: node.id, error });
        run.status = 'failed'; run.error = `节点 ${node.name || node.id} 失败：${error}`;
        run.endedAt = Date.now();
        finish(run);
        return;
      }

      await advanceOut(node);
    };

    // 沿边推进（条件节点按分支；其余出边并发）
    const advanceOut = async (node) => {
      const rec = run.nodes[node.id];
      let outs = def.edges.filter(e => e.from === node.id);
      if (node.type === 'condition') {
        const pick = rec.branch || (rec.output && rec.output.result ? 'then' : 'else');
        outs = outs.filter(e => e.label === pick);
        for (const e of def.edges.filter(x => x.from === node.id && x.label !== pick)) {
          emit('edge_skip', { runId: run.id, from: e.from, to: e.to, label: e.label });
        }
      }
      await Promise.all(outs.map(e => advance(e)));
    };

    const advance = async (edge) => {
      const next = byId[edge.to];
      if (!next) return;
      const prevOut = run.nodes[edge.from] ? run.nodes[edge.from].output : null;
      // 边数据映射（edge.map：目标字段 ← 来源表达式）：只传映射后的字段，
      // 且下游节点的 {{input.*}} 指向映射结果；不配置则整包传递上游输出
      let payload = prevOut, inCtx = null;
      if (edge.map && typeof edge.map === 'object' && !Array.isArray(edge.map) && Object.keys(edge.map).length) {
        payload = renderDeep(edge.map, ctx);
        inCtx = { ...ctx, input: payload };
      }
      emit('edge_data', { runId: run.id, from: edge.from, to: edge.to, label: edge.label || null, data: summarize(payload), mapped: !!inCtx });
      ctx.nodes[next.id] = ctx.nodes[next.id] || { output: null };
      ctx.nodes[next.id].output = payload;   // 沿边传来的数据（映射后 / 整包）
      await runNode(next, inCtx);
    };

    const finish = (run) => {
      markUnvisited(def, run);   // 未访问节点标记 skipped（对应观测面板灰化排队态）
      if (run.status === 'running') {
        // 结束断言：节点全部成功后统一校验 def.end.assert（作用域 = 整条流程的输入/节点输出）
        const ea = def.end && def.end.assert;
        if (ea) {
          const fails = checkEndAssert(ea, { input: run.input, run: { id: run.id, num: run.num }, nodes: ctx.nodes });
          if (fails.length) {
            run.status = 'failed';
            run.error = '结束断言失败：' + fails.join('；');
            run.assertFails = fails;
            emit('assert_fail', { runId: run.id, node: '__end__', name: '结束', fails });
          }
        }
      }
      if (run.status === 'running') run.status = 'success';
      run.endedAt = Date.now(); run.durationMs = run.endedAt - run.startedAt;
      this.store.updateRun(run);
      this.store.flushRuns();   // 结束态立即落盘（中间更新已合并写，避免并行时全量写盘拖慢引擎）
      emit('run_end', { runId: run.id, num: run.num, status: run.status, durationMs: run.durationMs, error: run.error });
      this.running.delete(run.id);
    };

    await runNode(start);
    if (this.running.has(run.id)) finish(run);
    return run;
  }

  // 从指定节点重放：复用上游产物，仅重新执行该节点及下游
  async replay(run, fromNode) {
    const flow = this.store.getFlow(run.flowId);
    const def = flow && flow.published && flow.published.def;
    if (!def) throw new Error('流程定义不存在或未发布');
    const prior = {};
    for (const [nid, rec] of Object.entries(run.nodes)) {
      if (nid !== fromNode && (rec.status === 'done' || rec.status === 'reused')) prior[nid] = rec;
    }
    return this.runFlow({ ...def, version: flow.published.version }, run.input, {
      trigger: 'replay', replayOf: run.id, fromNode, priorNodes: prior,
    });
  }
}

function attempts2rec(rec, attempts) { if (attempts) rec.attempts = attempts; }

// 未访问到的节点标记 skipped（对应观测面板的灰化排队态）
function markUnvisited(def, run) {
  for (const n of def.nodes) {
    if (!run.nodes[n.id]) run.nodes[n.id] = { status: 'skipped', attempts: [] };
  }
}

module.exports = { Engine, bus, renderDeep, renderStr, evalExpr, summarize, withQuery };

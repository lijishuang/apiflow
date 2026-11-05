// ── 测试报告：从运行记录生成可读的测试报告（Markdown / HTML / Word(docx) / JSON），支持下载与在线打开 ──
// 单次报告：一次 run 的执行明细（节点表 / 每节点请求·响应·尝试·断言 / 数据传递 / 结论与建议）
// 汇总报告：一个流程最近多次运行的统计（通过率 / 耗时分布 / 常失败节点）
// 零 npm 依赖：Word 通过内置 zlib 打包最小 OOXML（docx）生成；PDF 由前端打印导出（报告内置打印样式）

const zlib = require('zlib');
const analysis = require('./analysis');

const TRIG = { manual: '手动', batch: '并行批跑', cron: '定时', replay: '重放', 'dry-run': '调试试跑', plugin: '插件' };
const ST = { success: '成功', failed: '失败', running: '运行中', done: '成功', reused: '复用', skipped: '分支未命中' };
const fmtTime = ts => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtDur = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
const cut = (s, n = 200) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…(已截断)' : s; };
const jcut = (v, n = 200) => { try { return cut(typeof v === 'string' ? v : JSON.stringify(v), n); } catch { return cut(v, n); } };
// 展示用美化：对象展开缩进，超长截断（报告里"看得全"但不会把 10MB 响应塞进文件）
const OUT_CAP = 8000, FLOW_CAP = 2000, MD_CAP = 2000;
function jpretty(v, cap = OUT_CAP) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
  return cut(s ?? '', cap);
}

/* 节点元信息（名称/类型）：优先用流程定义，运行事件兜底（流程定义可能已改） */
function nodeMeta(run, def) {
  const map = {};
  for (const n of (def && def.nodes) || []) map[n.id] = { id: n.id, name: n.name || n.id, type: n.type || '-' };
  for (const ev of run.events || []) {
    if (ev.event === 'node_start' && ev.data && !map[ev.data.node])
      map[ev.data.node] = { id: ev.data.node, name: ev.data.name || ev.data.node, type: ev.data.type || '-' };
  }
  // 输出顺序：流程定义顺序优先，运行中出现但定义里没有的排后面
  const order = ((def && def.nodes) || []).map(n => n.id).filter(id => map[id] || (run.nodes || {})[id]);
  for (const id of Object.keys(run.nodes || {})) if (!order.includes(id)) order.push(id);
  return order.map(id => map[id] || { id, name: id, type: '-' });
}

/* ── 单次运行报告 ── */
function buildRun(run, def) {
  const recs = run.nodes || {};
  const metas = nodeMeta(run, def);
  const nodes = metas.map(m => {
    const r = recs[m.id] || {};
    const att = (r.attempts || []).length;
    return {
      id: m.id, name: m.name, type: m.type,
      status: r.status || '未执行',
      statusLabel: ST[r.status] || r.status || '未执行',
      ms: r.ms ?? null, httpStatus: r.httpStatus ?? null,
      startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
      attempts: att, retries: att > 1 ? att - 1 : 0,
      attemptList: (r.attempts || []).map(a => ({ n: a.n, status: a.status ?? null, ms: a.ms ?? null, ok: !!a.ok, bizCode: a.bizCode || null, error: a.error || null })),
      branch: r.branch || null, reused: !!r.reused,
      error: r.error || null,
      bizError: r.bizError ? { code: r.bizError.code, message: r.bizError.message, missing: r.bizError.missing || [] } : null,
      assertFails: r.assertFails || null,
      // 请求内容（引擎已对 SK 脱敏）；body 美化便于阅读
      request: r.request ? {
        method: r.request.method, url: r.request.url,
        headers: r.request.headers || null,
        body: r.request.body != null ? jpretty(r.request.body, 4000) : null,
      } : null,
      output: r.output != null ? jpretty(r.output, OUT_CAP) : null,
    };
  });
  const endFails = (run.events || []).filter(e => e.event === 'assert_fail' && e.data && e.data.node === '__end__')
    .map(e => (e.data.fails || []).join('；'));
  const okN = nodes.filter(n => n.status === 'done' || n.status === 'reused').length;
  const failN = nodes.filter(n => n.status === 'failed').length;
  const skipN = nodes.filter(n => n.status === 'skipped').length;
  const assertN = nodes.reduce((a, n) => a + (n.assertFails ? n.assertFails.length : 0), 0);
  const passed = run.status === 'success' && !endFails.length;
  const flows = (run.events || []).filter(e => e.event === 'edge_data' && e.data).map(e => ({
    from: e.data.from, to: e.data.to, mapped: !!e.data.mapped, data: jpretty(e.data.data, FLOW_CAP),
  }));
  const verdicts = [];
  if (run.error) verdicts.push(`流程错误：${cut(run.error, 400)}`);
  for (const n of nodes) if (n.error) verdicts.push(`节点「${n.name}」失败：${cut(n.error, 300)}`);
  if (endFails.length) verdicts.push(`结束断言失败：${endFails.join('；')}`);
  const suggestions = [];
  if (failN) {
    if (nodes.some(n => n.retries > 0)) suggestions.push('有节点经过重试才成功或仍失败 —— 关注网络稳定性与接口可用性');
    suggestions.push('逐个排查失败节点的错误信息，可在运行观测页点击节点查看完整请求 / 响应');
  }
  if (skipN) suggestions.push('存在分支未命中的节点 —— 确认条件配置是否符合预期');
  if (assertN || endFails.length) suggestions.push('断言失败说明响应不符合预期 —— 检查断言表达式或接口返回内容');
  if (passed && nodes.some(n => n.retries > 0)) suggestions.push('本次有节点重试后成功 —— 建议关注接口稳定性');
  if (passed && !suggestions.length) suggestions.push('全部节点通过，无需处理');
  return {
    kind: 'run', generatedAt: Date.now(),
    flowId: run.flowId, flowName: run.flowName || (def && def.name) || run.flowId,
    num: run.num, version: run.version, runId: run.id,
    trigger: TRIG[run.trigger] || run.trigger || '—', actor: run.actor || null,
    status: run.status, statusLabel: ST[run.status] || run.status,
    startedAt: run.startedAt, endedAt: run.endedAt, durationMs: run.durationMs,
    input: run.input && Object.keys(run.input).length ? jpretty(run.input, 4000) : null,
    summary: { total: nodes.length, ok: okN, fail: failN, skip: skipN, asserts: assertN, endAsserts: endFails.length },
    passed, verdicts, suggestions, nodes, dataFlows: flows,
    // AI 初步分析：仅挂已缓存的结果（首次生成走 /api/runs/:id/analysis，异步不阻塞报告）
    aiAnalysis: analysis.getCached(run.id),
  };
}

/* ── 流程汇总报告（最近 N 次运行统计）── */
function buildFlow(flow, runs) {
  const list = runs.filter(r => r.trigger !== 'dry-run');
  const succ = list.filter(r => r.status === 'success');
  const fails = list.filter(r => r.status === 'failed');
  const durs = list.map(r => r.durationMs).filter(ms => ms != null);
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
  // 失败节点频率：从各次失败 run 的节点记录里统计
  const failNodeCnt = {};
  let lastError = null, lastFailRun = null;
  for (const r of fails) {
    for (const [nid, n] of Object.entries(r.nodes || {})) if (n.status === 'failed') failNodeCnt[nid] = (failNodeCnt[nid] || 0) + 1;
    if (!lastError) {
      lastFailRun = r;
      const bad = Object.values(r.nodes || {}).find(n => n.error);
      lastError = { num: r.num, error: cut((bad && bad.error) || r.error || '未知错误', 400) };
    }
  }
  // 节点名：从流程定义（优先 published，其次 draft）解析
  const def = (flow.published && flow.published.def) || (flow.draft && flow.draft.def) || null;
  const nameOf = {};
  for (const n of (def && def.nodes) || []) nameOf[n.id] = n.name || n.id;
  const failNodes = Object.entries(failNodeCnt).sort((a, b) => b[1] - a[1])
    .map(([id, c]) => ({ id, name: nameOf[id] || id, count: c }));
  // 最近一次运行（不论成功失败）的完整明细：请求 / 响应 / 断言 / 尝试，复用单次报告构建
  // —— 汇总报告也要能直接看到「接口请求了什么、返回了什么」，而不是只有统计数字
  let lastRun = null;
  const latest = list[0] || null;
  if (latest) {
    const lr = buildRun(latest, def);
    lastRun = {
      runId: lr.runId, num: lr.num, status: lr.status, statusLabel: lr.statusLabel, passed: lr.passed,
      startedAt: lr.startedAt, endedAt: lr.endedAt, durationMs: lr.durationMs, version: lr.version,
      trigger: lr.trigger, verdicts: lr.verdicts, summary: lr.summary,
      nodes: lr.nodes, dataFlows: lr.dataFlows,
    };
  }
  // 最近一次失败的完整明细（失败节点即可）；与最近一次运行相同则复用，避免重复
  let lastFail = null;
  if (lastFailRun) {
    if (lastRun && lastRun.runId === lastFailRun.id) {
      lastFail = {
        ...lastRun,
        nodes: lastRun.nodes.filter(n => n.status === 'failed' || (n.assertFails || []).length || n.bizError),
      };
    } else {
      const fr = buildRun(lastFailRun, def);
      lastFail = {
        runId: fr.runId, num: fr.num, startedAt: fr.startedAt, endedAt: fr.endedAt, durationMs: fr.durationMs,
        trigger: fr.trigger, verdicts: fr.verdicts,
        nodes: fr.nodes.filter(n => n.status === 'failed' || (n.assertFails || []).length || n.bizError),
      };
    }
  }
  return {
    kind: 'flow', generatedAt: Date.now(),
    flowId: flow.id, flowName: flow.name || flow.id,
    version: flow.version || (flow.published && flow.published.version) || 0,
    window: { total: list.length, success: succ.length, failed: fails.length, passRate: list.length ? Math.round(succ.length / list.length * 100) : 0 },
    duration: { avg, min: durs.length ? Math.min(...durs) : null, max: durs.length ? Math.max(...durs) : null },
    runs: list.slice(0, 20).map(r => ({
      num: r.num, status: r.status, statusLabel: ST[r.status] || r.status, trigger: TRIG[r.trigger] || r.trigger || '—',
      startedAt: r.startedAt, durationMs: r.durationMs ?? null, version: r.version,
      error: r.error || (Object.values(r.nodes || {}).find(n => n.error) || {}).error || null,
    })),
    failNodes, lastError, lastRun, lastFail,
    lastFailRunId: lastFailRun ? lastFailRun.id : null,
    // AI 初步分析：挂最近一次失败运行的缓存结果（首次生成走 /api/runs/:id/analysis）
    aiAnalysis: lastFailRun ? analysis.getCached(lastFailRun.id) : null,
    suggestions: buildFlowSuggestions(list, succ, fails, failNodes, avg, durs),
  };
}
function buildFlowSuggestions(all, succ, fails, failNodes, avg, durs) {
  const out = [];
  if (!all.length) return ['还没有真实运行记录 —— 先运行一次再生成报告'];
  out.push(`最近 ${all.length} 次运行通过率 ${Math.round(succ.length / all.length * 100)}%${fails.length ? `，${fails.length} 次失败需要关注` : '，全部通过'}`);
  if (failNodes.length) out.push(`「${failNodes[0].name}」是最高频失败节点（${failNodes[0].count} 次）—— 优先排查该节点的接口与参数`);
  if (fails.length && durs.length) {
    const fd = fails.map(r => r.durationMs).filter(ms => ms != null);
    if (fd.length && avg && Math.min(...fd) < avg * 0.5) out.push('失败运行明显快于平均耗时 —— 多为请求前置阶段报错（参数 / 认证），可检查输入');
  }
  if (durs.length > 3 && Math.max(...durs) > avg * 3) out.push('存在明显偏慢的运行 —— 可关注接口响应波动');
  if (all.length < 5) out.push('运行样本较少，结论仅供参考 —— 多跑几次（或用并行批跑）可获得更可靠的统计');
  return out;
}

/* ── AI 初步分析渲染（html 片段；md / docx 共用 aiAnalysis 数据） ── */
const hasAi = rep => !!(rep.aiAnalysis && rep.aiAnalysis.analysis);
function aiInnerHtml(a) {
  return `<div class="ai-ov">${escH(a.overview)}</div>` +
    (a.causes || []).map(c => `<div class="ai-c"><b>${escH(c.node || '—')}</b>　${escH(c.cause || '')}` +
      (c.evidence ? `<div class="ai-ev">依据：${escH(c.evidence)}</div>` : '') +
      (c.suggestion ? `<div class="ai-sg">建议：${escH(c.suggestion)}</div>` : '') + `</div>`).join('') +
    ((a.nextSteps || []).length ? `<div class="ai-ns"><b>下一步</b><ul>${a.nextSteps.map(x => `<li>${escH(x)}</li>`).join('')}</ul></div>` : '');
}

/* ── Markdown 渲染 ── */
function nodeErrText(n) {
  return [n.error, (n.assertFails || []).map(f => `断言: ${f}`).join('；')].filter(Boolean).join('；');
}
/* 单个节点的 MD 执行详情（单次报告与汇总报告的失败详情共用） */
function pushMdNodeDetail(L, n) {
  if (n.status === '未执行' || n.status === '分支未命中') return;
  const bad = n.status === 'failed';
  L.push('', `### ${bad ? '❌' : '✅'} ${n.name}（${n.type}）`, '');
  const info = [`状态：${n.statusLabel}`, `耗时：${n.ms != null ? fmtDur(n.ms) : '—'}`,
    `HTTP：${n.httpStatus ?? '—'}`, `尝试：${n.attempts} 次${n.retries ? `（重试 ${n.retries}）` : ''}`];
  if (n.branch) info.push(`分支：${n.branch}`);
  if (n.reused) info.push('复用上游运行产物');
  L.push(info.join(' ｜ '), '');
  if (n.error) L.push(`- **错误**：${n.error}`, '');
  for (const f of n.assertFails || []) L.push(`- **断言失败**：${f}`);
  if ((n.assertFails || []).length) L.push('');
  if (n.bizError) L.push(`- **业务错误**：code=${n.bizError.code} ${n.bizError.message}${(n.bizError.missing || []).length ? `（缺失：${n.bizError.missing.join('、')}）` : ''}`, '');
  if (n.request) {
    L.push(`- **请求内容**：\`${n.request.method} ${n.request.url}\``, '');
    if (n.request.headers && Object.keys(n.request.headers).length)
      L.push('```json', cut(JSON.stringify(n.request.headers), 600), '```', '');
    if (n.request.body) L.push('**请求体**：', '```json', cut(n.request.body, MD_CAP), '```', '');
  }
  if (n.output != null) L.push(`- **响应 / 输出**：`, '```json', cut(n.output, MD_CAP), '```', '');
  if (n.attemptList.length > 1 || n.attemptList.some(a => !a.ok)) {
    L.push(`- **尝试记录**：`, '', `| # | HTTP | 耗时 | 结果 |`, `| --- | --- | --- | --- |`);
    for (const a of n.attemptList) L.push(`| ${a.n} | ${a.status ?? '—'} | ${a.ms != null ? fmtDur(a.ms) : '—'} | ${a.ok ? '成功' : `失败${a.error ? `：${cut(a.error, 100).replace(/\|/g, '\\|')}` : ''}`} |`);
    L.push('');
  }
}
/* AI 初步分析的 MD 段 */
function pushMdAi(L, rep) {
  if (!hasAi(rep)) return;
  const a = rep.aiAnalysis.analysis;
  L.push('', `## AI 初步分析`, '');
  L.push(`**${a.overview}**`, '');
  L.push(`| 节点 | 根因判断 | 依据 | 建议 |`, `| --- | --- | --- | --- |`);
  for (const c of a.causes || [])
    L.push(`| ${c.node || '—'} | ${(c.cause || '—').replace(/\|/g, '\\|')} | ${cut(c.evidence || '—', 150).replace(/\|/g, '\\|')} | ${cut(c.suggestion || '—', 150).replace(/\|/g, '\\|')} |`);
  if ((a.nextSteps || []).length) { L.push('', '**下一步**：'); a.nextSteps.forEach(x => L.push(`- ${x}`)); }
  L.push('', `*分析模型：${rep.aiAnalysis.model} · ${fmtTime(rep.aiAnalysis.generatedAt)}（AI 结论仅供参考，以实际排查为准）*`);
}
function toMarkdown(rep) {
  const L = [];
  if (rep.kind === 'run') {
    L.push(`# APIFlow 测试报告`, '');
    L.push(`## 概要`, '');
    L.push(`| 项目 | 内容 |`, `| --- | --- |`);
    L.push(`| 流程 | ${rep.flowName}（\`${rep.flowId}\`） |`);
    L.push(`| 运行 | #${rep.num}（DSL v${rep.version}） |`);
    L.push(`| 结论 | **${rep.passed ? '✅ 通过' : '❌ 未通过'}**（${rep.statusLabel}） |`);
    L.push(`| 触发 | ${rep.trigger}${rep.actor ? `（${rep.actor}）` : ''} |`);
    L.push(`| 时间 | ${fmtTime(rep.startedAt)} → ${fmtTime(rep.endedAt)}（耗时 ${fmtDur(rep.durationMs)}） |`);
    if (rep.input) L.push(`| 输入 | \`${cut(rep.input, 300).replace(/\|/g, '\\|')}\` |`);
    L.push('', `## 执行总览`, '');
    L.push(`节点 **${rep.summary.total}** 个：成功 ${rep.summary.ok} · 失败 ${rep.summary.fail} · 分支未命中 ${rep.summary.skip}；断言失败 ${rep.summary.asserts + rep.summary.endAsserts} 项。`, '');
    L.push(`## 节点明细`, '');
    L.push(`| 节点 | 类型 | 状态 | 耗时 | HTTP | 重试 | 错误 / 断言 |`, `| --- | --- | --- | --- | --- | --- | --- |`);
    for (const n of rep.nodes) {
      const err = nodeErrText(n);
      L.push(`| ${n.name} | ${n.type} | ${n.statusLabel} | ${n.ms != null ? fmtDur(n.ms) : '—'} | ${n.httpStatus ?? '—'} | ${n.retries || '—'} | ${err ? cut(err, 120).replace(/\|/g, '\\|') : '—'} |`);
    }
    // 执行详情：每个节点完整请求 / 响应 / 尝试 / 断言（失败节点标 ❌）
    L.push('', `## 执行详情`, '');
    for (const n of rep.nodes) pushMdNodeDetail(L, n);
    if (rep.dataFlows.length) {
      L.push('', `## 数据传递（${rep.dataFlows.length} 条边）`, '');
      L.push(`| 从 → 到 | 映射 | 数据 |`, `| --- | --- | --- |`);
      for (const e of rep.dataFlows) L.push(`| ${e.from} → ${e.to} | ${e.mapped ? '⚡ 有' : '—'} | \`${cut(e.data, 400).replace(/\|/g, '\\|').replace(/\n/g, ' ')}\` |`);
    }
    if (rep.verdicts.length) {
      L.push('', `## 问题清单`, '');
      rep.verdicts.forEach((v, i) => L.push(`${i + 1}. ${v}`));
    }
    pushMdAi(L, rep);
    L.push('', `## 结论与建议`, '');
    rep.suggestions.forEach(s => L.push(`- ${s}`));
  } else {
    L.push(`# APIFlow 流程测试报告（汇总）`, '');
    L.push(`## 概要`, '');
    L.push(`| 项目 | 内容 |`, `| --- | --- |`);
    L.push(`| 流程 | ${rep.flowName}（\`${rep.flowId}\`） |`);
    L.push(`| 当前版本 | v${rep.version} |`);
    L.push(`| 报告时间 | ${fmtTime(rep.generatedAt)} |`);
    L.push('', `## 运行统计（最近 ${rep.window.total} 次）`, '');
    L.push(`通过 **${rep.window.success}** 次 · 失败 **${rep.window.failed}** 次 · **通过率 ${rep.window.passRate}%**`, '');
    if (rep.duration.avg != null) L.push(`耗时：平均 ${fmtDur(rep.duration.avg)}，最快 ${fmtDur(rep.duration.min)}，最慢 ${fmtDur(rep.duration.max)}`, '');
    if (rep.failNodes.length) {
      L.push(`## 高频失败节点`, '');
      L.push(`| 节点 | 失败次数 |`, `| --- | --- |`);
      rep.failNodes.forEach(n => L.push(`| ${n.name}（\`${n.id}\`） | ${n.count} |`));
      if (rep.lastError) L.push('', `最近一次失败（#${rep.lastError.num}）：${rep.lastError.error}`, '');
    }
    // 最近一次运行的完整执行明细（请求 / 响应 / 报错 / 断言 / 尝试），成功失败都展示
    if (rep.lastRun) {
      const lr = rep.lastRun;
      L.push(`## 最近一次运行详情（#${lr.num} · ${lr.passed ? '✅ 通过' : '❌ 未通过'}）`, '');
      L.push(`触发：${lr.trigger} ｜ 版本：DSL v${lr.version} ｜ 时间：${fmtTime(lr.startedAt)} ｜ 耗时：${fmtDur(lr.durationMs)}`, '');
      L.push(`节点：${lr.summary.total} 个（成功 ${lr.summary.ok} · 失败 ${lr.summary.fail} · 未执行 ${lr.summary.skip}）`, '');
      for (const v of lr.verdicts || []) L.push(`- ⛔ ${v}`);
      for (const n of lr.nodes) pushMdNodeDetail(L, n);
      if ((lr.dataFlows || []).length) {
        L.push('', `### 数据传递（${lr.dataFlows.length} 条边）`, '');
        for (const e of lr.dataFlows) {
          L.push(`**${e.from} → ${e.to}**${e.mapped ? '（⚡ 边映射）' : '（整包传递）'}`, '', '```json', cut(e.data, 1200), '```', '');
        }
      }
    }
    // 历史失败详情：最近一次运行已成功、但之前有失败记录时单独展示
    if (rep.lastFail && (!rep.lastRun || rep.lastFail.runId !== rep.lastRun.runId)) {
      L.push(`## 最近一次失败详情（#${rep.lastFail.num}）`, '');
      L.push(`触发：${rep.lastFail.trigger} ｜ 时间：${fmtTime(rep.lastFail.startedAt)} ｜ 耗时：${fmtDur(rep.lastFail.durationMs)}`, '');
      for (const v of rep.lastFail.verdicts || []) L.push(`- ${v}`);
      for (const n of rep.lastFail.nodes) pushMdNodeDetail(L, n);
      if (!rep.lastFail.nodes.length) L.push('（该次运行没有产生节点级失败记录）', '');
    }
    pushMdAi(L, rep);
    L.push(`## 运行明细（最近 ${Math.min(20, rep.runs.length)} 次）`, '');
    L.push(`| 运行 | 版本 | 状态 | 触发 | 耗时 | 时间 | 错误 |`, `| --- | --- | --- | --- | --- | --- | --- |`);
    for (const r of rep.runs) L.push(`| #${r.num} | v${r.version} | ${r.statusLabel} | ${r.trigger} | ${r.durationMs != null ? fmtDur(r.durationMs) : '—'} | ${fmtTime(r.startedAt)} | ${r.error ? cut(r.error, 120).replace(/\|/g, '\\|') : '—'} |`);
    L.push('', `## 结论与建议`, '');
    rep.suggestions.forEach(s => L.push(`- ${s}`));
  }
  L.push('', '---', `*由 APIFlow 自动生成 · ${fmtTime(rep.generatedAt)}*`);
  return L.join('\n');
}

/* ── HTML 渲染（独立文件，内联样式，可直接在线打开 / 归档 / 打印导出 PDF） ── */
const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REPORT_CSS = `
*{box-sizing:border-box}
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:900px;margin:28px auto;padding:0 24px 48px;color:#1c2430;background:#fff;line-height:1.65}
h1{font-size:22px;border-bottom:2px solid #2FBF8F;padding-bottom:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h2{font-size:17px;margin-top:30px;color:#0f6e51}
.badge{font-size:12px;font-weight:600;border-radius:999px;padding:3px 12px;white-space:nowrap}
.badge.pass{background:#e2f6ee;color:#0c7a52;border:1px solid #9fdcc4}
.badge.fail{background:#fdecec;color:#b42323;border:1px solid #f0b4b4}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 24px;margin:14px 0;font-size:13px}
.meta b{color:#4a564f;font-weight:600}
.meta code{background:#f2f5f4;padding:1px 6px;border-radius:4px;font-size:12px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.stat{min-width:96px;border:1px solid #e0e7e2;border-radius:10px;padding:10px 14px;text-align:center}
.stat .num{font-size:20px;font-weight:700}.stat .lbl{font-size:12px;color:#5a6660}
.stat.ok .num{color:#0c7a52}.stat.bad .num{color:#b42323}.stat.warn .num{color:#b0700c}
.node{border:1px solid #e0e7e2;border-radius:10px;margin:12px 0;overflow:hidden;break-inside:avoid}
.node.fail{border-color:#f0b4b4}
.node-h{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#f6f9f7;flex-wrap:wrap}
.node.fail .node-h{background:#fdf6f6}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.node.ok .dot{background:#2FBF8F}.node.fail .dot{background:#E5484D}.node.skip .dot{background:#9aa5a0}
.node-h b{font-size:14px}
.tag{font-size:11px;color:#5a6660;background:#eef3f0;border-radius:4px;padding:1px 7px}
.grow{flex:1}
.http{font-size:12px;font-weight:700;border-radius:4px;padding:1px 7px}
.http.s2{background:#e2f6ee;color:#0c7a52}.http.s4,.http.s5,.http.s0{background:#fdecec;color:#b42323}
.ms{font-size:12px;color:#5a6660}
.node-b{padding:10px 14px}
.err{background:#fdecec;border:1px solid #f0b4b4;color:#a32020;border-radius:8px;padding:8px 12px;margin:6px 0;font-size:13px;white-space:pre-wrap;word-break:break-all}
.assert{background:#fff7ec;border:1px solid #f0d9ac;color:#8a5a00;border-radius:8px;padding:6px 12px;margin:6px 0;font-size:13px}
details{margin:8px 0}
summary{cursor:pointer;font-size:13px;font-weight:600;color:#274156;user-select:none}
summary::marker{color:#2FBF8F}
pre{background:#f4f7f5;border:1px solid #e0e7e2;border-radius:8px;padding:10px 12px;font:12px/1.55 ui-monospace,Menlo,Consolas,'Courier New',monospace;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0;max-height:420px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
th{background:#eef4f1;text-align:left}
th,td{border:1px solid #d8e0dc;padding:6px 10px;vertical-align:top}
td code{background:#f2f5f4;padding:1px 5px;border-radius:4px;font-size:12px}
.t-fail td:nth-last-child(2){color:#b42323;font-weight:600}
.li{margin:4px 0}
.problems li{color:#a32020}
.ai{border:1px solid #d5cdf2;border-radius:10px;margin:14px 0;overflow:hidden;break-inside:avoid;background:#faf9ff}
.ai-h{display:flex;align-items:center;gap:8px;padding:9px 14px;background:#f1eefc;font-weight:600;font-size:14px;color:#4a3d8f;flex-wrap:wrap}
.ai-status{font-weight:400;font-size:12px;color:#7a6fb0}
.ai-b{padding:10px 14px;font-size:13px}
.ai-ov{margin:2px 0 8px;font-weight:600;color:#33296b}
.ai-c{border-left:3px solid #b9aef0;padding:6px 10px;margin:8px 0;background:#fff;border-radius:0 6px 6px 0}
.ai-ev,.ai-sg{color:#5c5578;font-size:12px;margin-top:3px}
.ai-ns ul{margin:6px 0 0;padding-left:18px}
.ai-note{color:#8a5a00}
hr{border:none;border-top:1px solid #dde;margin-top:28px}
.foot{color:#8a9490;font-size:12px;margin-top:16px}
.printbar{position:fixed;top:14px;right:18px;display:flex;gap:8px}
.printbar button{border:1px solid #cfd8d3;background:#fff;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}
.printbar button:hover{background:#eef4f1}
@media print{
  body{max-width:none;margin:0;padding:0 10mm;font-size:12px}
  .printbar{display:none}
  .node{break-inside:avoid;page-break-inside:avoid}
  pre{max-height:none;overflow:visible}
  h2{break-after:avoid}
  details>summary{display:none}
  details>*:not(summary){display:block!important}
}
`;
const REPORT_JS = `<script>
// 打印 / 导出 PDF 前自动展开全部 details，保证报告内容完整
window.addEventListener('beforeprint', function(){ document.querySelectorAll('details').forEach(function(d){ d.open = true; }); });
// AI 初步分析渲染：接收 /api/runs/:id/analysis 的响应并填充卡片
window.renderAiAnalysis = function(d){
  var box = document.getElementById('aiAnalysis'); if (!box || !d) return;
  var body = document.getElementById('aiBody'), st = document.getElementById('aiStatus');
  if (d.skipped) { box.remove(); return; }
  if (d.off) { body.textContent = '⚠ ' + (d.message || 'LLM 未启用'); body.className = 'ai-b ai-note'; st.textContent = '· 不可用'; return; }
  if (!d.ok) { body.textContent = '⚠ 分析生成失败：' + (d.llmError || d.error || '未知错误'); body.className = 'ai-b ai-note'; st.textContent = '· 失败'; return; }
  body.innerHTML = d.html;
  var ms = d.ms || 0;
  st.textContent = '· ' + (d.cached ? '缓存结果' : '本次生成') + (d.model ? ' · ' + d.model : '') + ' · ' + (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  var rf = document.getElementById('aiRefresh'); if (rf) rf.textContent = '↻ 重新分析';
};
// 在线打开（独立页面）时自动拉取；弹窗 iframe（about:srcdoc）由父页面负责注入
(function(){
  if (location.protocol === 'about:') return;
  var box = document.getElementById('aiAnalysis'); if (!box) return;
  var rid = box.getAttribute('data-run');
  var u = rid ? ('/api/runs/' + encodeURIComponent(rid) + '/analysis') : location.pathname.replace(/\\/report$/, '/analysis');
  fetch(u).then(function(r){ return r.json(); })
    .then(function(d){ if (window.renderAiAnalysis) window.renderAiAnalysis(d); })
    .catch(function(e){ var b = document.getElementById('aiBody'); if (b) { b.textContent = 'AI 分析加载失败：' + e; b.className = 'ai-b ai-note'; } });
})();
</script>`;
const PRINT_BAR = `<div class="printbar"><button onclick="window.print()">🖨 导出 PDF / 打印</button></div>`;

// AI 初步分析卡片（失败运行显示；data-run 供在线版脚本/弹窗父页定位分析端点）
function aiCardHtml(runId, cached) {
  const ai = cached;
  return `<div class="ai" id="aiAnalysis" data-run="${escH(runId || '')}"><div class="ai-h">🤖 AI 初步分析<span class="ai-status" id="aiStatus">${ai ? '· ' + escH(ai.model || '') + ' · ' + fmtDur(ai.ms) : '· 生成中…'}</span><span class="grow"></span><a href="javascript:void 0" id="aiRefresh" style="font-size:12px;color:#4a3d8f">↻ 重新分析</a></div><div class="ai-b" id="aiBody">${ai ? aiInnerHtml(ai.analysis) : '正在调用 LLM 分析失败原因，请稍候…'}</div></div>`;
}
// 单个节点卡片（单次报告全部节点 / 汇总报告的失败节点共用）
function nodeCardHtml(n) {
  const H = [];
  const cls = n.status === 'failed' ? 'fail' : (n.status === 'done' || n.status === 'reused') ? 'ok' : 'skip';
  const hs = n.httpStatus != null ? Number(n.httpStatus) : null;
  const hcls = hs == null ? '' : hs === 0 ? 's0' : hs < 300 ? 's2' : hs < 500 ? 's4' : 's5';
  const open = cls === 'fail' ? ' open' : '';
  H.push(`<div class="node ${cls}"><div class="node-h"><span class="dot"></span><b>${escH(n.name)}</b>
    <span class="tag">${escH(n.type)}</span>${n.branch ? `<span class="tag">分支 ${escH(n.branch)}</span>` : ''}${n.reused ? '<span class="tag">复用</span>' : ''}
    <span class="grow"></span>
    ${hs != null ? `<span class="http ${hcls}">HTTP ${hs}</span>` : ''}
    ${n.ms != null ? `<span class="ms">${fmtDur(n.ms)}</span>` : ''}</div>
    <div class="node-b">`);
  if (n.error) H.push(`<div class="err">⛔ ${escH(n.error)}</div>`);
  if (n.bizError) H.push(`<div class="err">🧾 业务错误 code=${escH(n.bizError.code)}：${escH(n.bizError.message)}${(n.bizError.missing || []).length ? `<br>缺失参数：${escH(n.bizError.missing.join('、'))}` : ''}</div>`);
  for (const f of n.assertFails || []) H.push(`<div class="assert">⚠ 断言失败：${escH(f)}</div>`);
  if (n.request) {
    const reqTxt = [`${n.request.method} ${n.request.url}`,
      n.request.headers && Object.keys(n.request.headers).length ? '\nheaders:\n' + JSON.stringify(n.request.headers, null, 2) : '',
      n.request.body ? '\nbody:\n' + n.request.body : ''].filter(Boolean).join('\n');
    H.push(`<details${open}><summary>请求内容</summary><pre>${escH(reqTxt)}</pre></details>`);
  }
  if (n.output != null) H.push(`<details${open}><summary>响应 / 输出</summary><pre>${escH(n.output)}</pre></details>`);
  if (n.attemptList.length > 1 || n.attemptList.some(a => !a.ok)) {
    H.push(`<details${open}><summary>尝试记录（${n.attemptList.length} 次）</summary><table><thead><tr><th>#</th><th>HTTP</th><th>耗时</th><th>结果</th></tr></thead><tbody>${
      n.attemptList.map(a => `<tr><td>${a.n}</td><td>${a.status ?? '—'}</td><td>${a.ms != null ? fmtDur(a.ms) : '—'}</td><td>${a.ok ? '✅ 成功' : `❌ 失败${a.error ? `：${escH(cut(a.error, 200))}` : ''}`}</td></tr>`).join('')
    }</tbody></table></details>`);
  }
  if (n.startedAt) H.push(`<div class="ms">起止：${fmtTime(n.startedAt)} → ${fmtTime(n.endedAt)}</div>`);
  H.push(`</div></div>`);
  return H.join('\n');
}

function runHtml(rep) {
  const H = [];
  H.push(`<h1>APIFlow 测试报告 <span class="badge ${rep.passed ? 'pass' : 'fail'}">${rep.passed ? '✅ 通过' : '❌ 未通过'}</span></h1>`);
  H.push(`<div class="meta">
    <span><b>流程</b>　${escH(rep.flowName)}（<code>${escH(rep.flowId)}</code>）</span>
    <span><b>运行</b>　#${rep.num}（DSL v${rep.version}）</span>
    <span><b>触发</b>　${escH(rep.trigger)}${rep.actor ? `（${escH(rep.actor)}）` : ''}</span>
    <span><b>时间</b>　${fmtTime(rep.startedAt)} → ${fmtTime(rep.endedAt)}（耗时 ${fmtDur(rep.durationMs)}）</span></div>`);
  if (rep.input) H.push(`<details><summary>流程输入</summary><pre>${escH(rep.input)}</pre></details>`);
  const s = rep.summary;
  H.push(`<h2>执行总览</h2><div class="stats">
    <div class="stat"><div class="num">${s.total}</div><div class="lbl">节点</div></div>
    <div class="stat ok"><div class="num">${s.ok}</div><div class="lbl">成功</div></div>
    <div class="stat ${s.fail ? 'bad' : ''}"><div class="num">${s.fail}</div><div class="lbl">失败</div></div>
    <div class="stat ${s.skip ? 'warn' : ''}"><div class="num">${s.skip}</div><div class="lbl">分支未命中</div></div>
    <div class="stat ${s.asserts + s.endAsserts ? 'bad' : ''}"><div class="num">${s.asserts + s.endAsserts}</div><div class="lbl">断言失败</div></div></div>`);
  // AI 初步分析卡片：失败运行显示（已有缓存直接渲染，否则占位待脚本异步拉取）
  if (!rep.passed) H.push(aiCardHtml(rep.runId, rep.aiAnalysis));
  H.push(`<h2>节点明细</h2>`);
  for (const n of rep.nodes) H.push(nodeCardHtml(n));
  if (rep.dataFlows.length) {
    H.push(`<h2>数据传递（${rep.dataFlows.length} 条边）</h2>`);
    for (const e of rep.dataFlows)
      H.push(`<div class="node ok" style="border-style:dashed"><div class="node-h"><b>${escH(e.from)} → ${escH(e.to)}</b><span class="grow"></span>${e.mapped ? '<span class="tag">⚡ 边映射</span>' : '<span class="tag">整包传递</span>'}</div><div class="node-b"><pre>${escH(e.data)}</pre></div></div>`);
  }
  if (rep.verdicts.length) H.push(`<h2>问题清单</h2><ul class="problems">${rep.verdicts.map(v => `<li>${escH(v)}</li>`).join('')}</ul>`);
  H.push(`<h2>结论与建议</h2><ul>${rep.suggestions.map(x => `<li>${escH(x)}</li>`).join('')}</ul>`);
  return wrapHtml(rep, H.join('\n'));
}
function flowHtml(rep) {
  const H = [];
  const rate = rep.window.passRate;
  H.push(`<h1>APIFlow 流程测试报告（汇总）<span class="badge ${rate >= 90 ? 'pass' : rate >= 60 ? '' : 'fail'}" ${rate >= 60 && rate < 90 ? 'style="background:#fff7ec;color:#8a5a00;border-color:#f0d9ac"' : ''}>通过率 ${rate}%</span></h1>`);
  H.push(`<div class="meta">
    <span><b>流程</b>　${escH(rep.flowName)}（<code>${escH(rep.flowId)}</code>）</span>
    <span><b>当前版本</b>　v${rep.version}</span>
    <span><b>报告时间</b>　${fmtTime(rep.generatedAt)}</span></div>`);
  H.push(`<h2>运行统计（最近 ${rep.window.total} 次）</h2><div class="stats">
    <div class="stat"><div class="num">${rep.window.total}</div><div class="lbl">总运行</div></div>
    <div class="stat ok"><div class="num">${rep.window.success}</div><div class="lbl">成功</div></div>
    <div class="stat ${rep.window.failed ? 'bad' : ''}"><div class="num">${rep.window.failed}</div><div class="lbl">失败</div></div>
    <div class="stat"><div class="num">${rate}%</div><div class="lbl">通过率</div></div>
    ${rep.duration.avg != null ? `<div class="stat"><div class="num">${fmtDur(rep.duration.avg)}</div><div class="lbl">平均耗时</div></div>
    <div class="stat"><div class="num">${fmtDur(rep.duration.min)}</div><div class="lbl">最快</div></div>
    <div class="stat"><div class="num">${fmtDur(rep.duration.max)}</div><div class="lbl">最慢</div></div>` : ''}</div>`);
  if (rep.failNodes.length) {
    H.push(`<h2>高频失败节点</h2><table><thead><tr><th>节点</th><th>失败次数</th></tr></thead><tbody>${
      rep.failNodes.map(n => `<tr><td>${escH(n.name)}（<code>${escH(n.id)}</code>）</td><td>${n.count}</td></tr>`).join('')}</tbody></table>`);
    if (rep.lastError) H.push(`<div class="err">最近一次失败（#${rep.lastError.num}）：${escH(rep.lastError.error)}</div>`);
  }
  // 最近一次运行详情：不论成功失败都展示完整节点明细（请求 / 响应 / 断言 / 尝试）
  if (rep.lastRun) {
    const lr = rep.lastRun;
    H.push(`<h2>最近一次运行详情（#${lr.num} · ${lr.passed ? '✅ 通过' : '❌ 未通过'}）</h2>`);
    H.push(`<div class="meta">
      <span><b>触发</b>　${escH(lr.trigger)}</span>
      <span><b>版本</b>　DSL v${lr.version}</span>
      <span><b>时间</b>　${fmtTime(lr.startedAt)}（耗时 ${fmtDur(lr.durationMs)}）</span>
      <span><b>节点</b>　${lr.summary.total} 个（成功 ${lr.summary.ok} · 失败 ${lr.summary.fail} · 未执行 ${lr.summary.skip}）</span></div>`);
    for (const v of lr.verdicts || []) H.push(`<div class="err">⛔ ${escH(v)}</div>`);
    if (!lr.passed && rep.lastFailRunId === lr.runId) H.push(aiCardHtml(lr.runId, rep.aiAnalysis));
    for (const n of lr.nodes) H.push(nodeCardHtml(n));
    if ((lr.dataFlows || []).length) {
      H.push(`<details><summary>数据传递（${lr.dataFlows.length} 条边）</summary>`);
      for (const e of lr.dataFlows)
        H.push(`<div class="node ok" style="border-style:dashed"><div class="node-h"><b>${escH(e.from)} → ${escH(e.to)}</b><span class="grow"></span>${e.mapped ? '<span class="tag">⚡ 边映射</span>' : '<span class="tag">整包传递</span>'}</div><div class="node-b"><pre>${escH(e.data)}</pre></div></div>`);
      H.push('</details>');
    }
  }
  // 历史失败详情：最近一次运行已成功、但之前有失败记录时单独展示（AI 分析针对该次失败）
  if (rep.lastFail && (!rep.lastRun || rep.lastFail.runId !== rep.lastRun.runId)) {
    H.push(`<h2>最近一次失败详情（#${rep.lastFail.num}）</h2>`);
    H.push(`<div class="meta">
      <span><b>触发</b>　${escH(rep.lastFail.trigger)}</span>
      <span><b>时间</b>　${fmtTime(rep.lastFail.startedAt)}（耗时 ${fmtDur(rep.lastFail.durationMs)}）</span></div>`);
    for (const v of rep.lastFail.verdicts || []) H.push(`<div class="err">⛔ ${escH(v)}</div>`);
    H.push(aiCardHtml(rep.lastFail.runId, rep.aiAnalysis));
    if (rep.lastFail.nodes.length) for (const n of rep.lastFail.nodes) H.push(nodeCardHtml(n));
    else H.push('<p class="ms">该次运行没有产生节点级失败记录。</p>');
  }
  H.push(`<h2>运行明细（最近 ${Math.min(20, rep.runs.length)} 次）</h2>
    <table><thead><tr><th>运行</th><th>版本</th><th>状态</th><th>触发</th><th>耗时</th><th>时间</th><th>错误</th></tr></thead><tbody>${
    rep.runs.map(r => `<tr class="${r.status === 'failed' ? 't-fail' : ''}"><td>#${r.num}</td><td>v${r.version}</td><td>${r.status === 'failed' ? '❌' : '✅'} ${escH(r.statusLabel)}</td><td>${escH(r.trigger)}</td><td>${r.durationMs != null ? fmtDur(r.durationMs) : '—'}</td><td>${fmtTime(r.startedAt)}</td><td>${r.error ? escH(cut(r.error, 160)) : '—'}</td></tr>`).join('')
  }</tbody></table>`);
  H.push(`<h2>结论与建议</h2><ul>${rep.suggestions.map(x => `<li>${escH(x)}</li>`).join('')}</ul>`);
  return wrapHtml(rep, H.join('\n'));
}
function wrapHtml(rep, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(rep.flowName)} · APIFlow 测试报告</title><style>${REPORT_CSS}</style>${REPORT_JS}</head>
<body>${PRINT_BAR}${body}
<div class="foot">由 APIFlow 自动生成 · ${fmtTime(rep.generatedAt)}</div></body></html>`;
}
const toHtml = rep => rep.kind === 'flow' ? flowHtml(rep) : runHtml(rep);

/* ── Word(docx) 生成：零依赖最小 OOXML（zip 内置 zlib 打包） ──
   三件套：[Content_Types].xml + _rels/.rels + word/document.xml，Word/WPS 均可打开 */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zipFiles(files) {
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
const escX = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 文本运行属性：默认微软雅黑；mono 用等宽西文
function xRpr(o = {}) {
  const p = [];
  p.push(o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>'
    : '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/>');
  if (o.b) p.push('<w:b/>');
  if (o.color) p.push(`<w:color w:val="${o.color}"/>`);
  if (o.sz) p.push(`<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`);
  return p.join('');
}
// 段落：\n 转 <w:br/>
function xP(text, o = {}) {
  const runs = [];
  const lines = String(text ?? '').split('\n');
  if (!lines.some(l => l !== '')) lines[0] = '';
  lines.forEach((ln, i) => {
    if (i) runs.push('<w:r><w:br/></w:r>');
    if (ln !== '') runs.push(`<w:r><w:rPr>${xRpr(o)}</w:rPr><w:t xml:space="preserve">${escX(ln)}</w:t></w:r>`);
  });
  const sp = o.before || o.after ? `<w:spacing${o.before ? ` w:before="${o.before}"` : ''}${o.after ? ` w:after="${o.after}"` : ''}/>` : '';
  return `<w:p>${sp ? `<w:pPr>${sp}</w:pPr>` : ''}${runs.join('') || '<w:r><w:rPr/></w:r>'}</w:p>`;
}
// 代码块：逐行灰底等宽段落
function xCode(text, cap = 3000) {
  const lines = cut(String(text ?? ''), cap).split('\n');
  return lines.map(ln => `<w:p><w:pPr><w:shd w:val="clear" w:fill="F2F5F4"/><w:spacing w:after="0" w:line="260" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${xRpr({ mono: true, sz: 16 })}</w:rPr><w:t xml:space="preserve">${escX(ln)}</w:t></w:r></w:p>`).join('');
}
function xHead(text, lvl = 1) {
  const sz = lvl === 0 ? 40 : lvl === 1 ? 30 : 24;
  return `<w:p><w:pPr><w:spacing w:before="${lvl === 0 ? 0 : 240}" w:after="120"/></w:pPr><w:r><w:rPr>${xRpr({ b: true, sz, color: lvl <= 1 ? '0F6E51' : '274156' })}</w:rPr><w:t xml:space="preserve">${escX(text)}</w:t></w:r></w:p>`;
}
function xTable(headers, rows) {
  const pct = Math.floor(5000 / headers.length);
  const border = '<w:top w:val="single" w:sz="4" w:color="D8E0DC"/><w:left w:val="single" w:sz="4" w:color="D8E0DC"/><w:bottom w:val="single" w:sz="4" w:color="D8E0DC"/><w:right w:val="single" w:sz="4" w:color="D8E0DC"/>';
  const cell = (v, head) => `<w:tc><w:tcPr><w:tcW w:w="${pct}" w:type="pct"/>${head ? '<w:shd w:val="clear" w:fill="EEF4F1"/>' : ''}<w:tcBorders>${border}</w:tcBorders></w:tcPr>${
    String(v ?? '—').split('\n').map(ln => `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr>${xRpr({ b: head, sz: 18 })}</w:rPr><w:t xml:space="preserve">${escX(ln)}</w:t></w:r></w:p>`).join('')}</w:tc>`;
  const tr = cells => `<w:tr>${cells.map(c => cell(c.v ?? c, c.h)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${tr(headers.map(h => ({ v: h, h: 1 })))}${rows.map(r => tr(r.map(v => ({ v })))).join('')}</w:tbl>`;
}
/* 单个节点的 Word 执行详情（单次报告与汇总报告的失败详情共用） */
function pushDocxNode(B, n) {
  if (n.status === '未执行' || n.status === '分支未命中') return;
  B.push(xHead(`${n.status === 'failed' ? '❌' : '✅'} ${n.name}（${n.type}）`, 2));
  B.push(xP([`状态：${n.statusLabel}`, `耗时：${n.ms != null ? fmtDur(n.ms) : '—'}`, `HTTP：${n.httpStatus ?? '—'}`,
    `尝试：${n.attempts} 次${n.retries ? `（重试 ${n.retries}）` : ''}`, n.branch ? `分支：${n.branch}` : '', n.reused ? '复用上游产物' : ''].filter(Boolean).join(' ｜ ')));
  if (n.error) B.push(xP(`⛔ 错误：${n.error}`, { color: 'A32020' }));
  for (const f of n.assertFails || []) B.push(xP(`⚠ 断言失败：${f}`, { color: '8A5A00' }));
  if (n.bizError) B.push(xP(`🧾 业务错误 code=${n.bizError.code}：${n.bizError.message}${(n.bizError.missing || []).length ? `（缺失：${n.bizError.missing.join('、')}）` : ''}`, { color: 'A32020' }));
  if (n.request) {
    const reqTxt = [`${n.request.method} ${n.request.url}`,
      n.request.headers && Object.keys(n.request.headers).length ? '\nheaders:\n' + JSON.stringify(n.request.headers, null, 2) : '',
      n.request.body ? '\nbody:\n' + n.request.body : ''].filter(Boolean).join('\n');
    B.push(xP('请求内容', { b: true }), xCode(reqTxt, 2000));
  }
  if (n.output != null) B.push(xP('响应 / 输出', { b: true }), xCode(n.output, 4000));
  if (n.attemptList.length > 1 || n.attemptList.some(a => !a.ok))
    B.push(xTable(['#', 'HTTP', '耗时', '结果'], n.attemptList.map(a => [a.n, a.status ?? '—', a.ms != null ? fmtDur(a.ms) : '—', a.ok ? '成功' : `失败${a.error ? `：${cut(a.error, 150)}` : ''}`])));
}
/* AI 初步分析的 Word 段 */
function pushDocxAi(B, rep) {
  if (!hasAi(rep)) return;
  const a = rep.aiAnalysis.analysis;
  B.push(xHead('AI 初步分析'));
  B.push(xP(a.overview, { b: true }));
  if ((a.causes || []).length)
    B.push(xTable(['节点', '根因判断', '依据', '建议'], (a.causes || []).map(c =>
      [c.node || '—', c.cause || '—', cut(c.evidence || '—', 200), cut(c.suggestion || '—', 200)])));
  if ((a.nextSteps || []).length) {
    B.push(xP('下一步', { b: true }));
    a.nextSteps.forEach(x => B.push(xP(`• ${x}`)));
  }
  B.push(xP(`分析模型：${rep.aiAnalysis.model} · ${fmtTime(rep.aiAnalysis.generatedAt)}（AI 结论仅供参考）`, { color: '8A9490', sz: 16 }));
}
function toDocx(rep) {
  const B = [];
  if (rep.kind === 'run') {
    B.push(xHead('APIFlow 测试报告', 0), xP(`${rep.passed ? '✅ 通过' : '❌ 未通过'}（${rep.statusLabel}）`, { b: true, sz: 24, color: rep.passed ? '0C7A52' : 'B42323', after: 120 }));
    B.push(xTable(['项目', '内容'], [
      ['流程', `${rep.flowName}（${rep.flowId}）`],
      ['运行', `#${rep.num}（DSL v${rep.version}）`],
      ['触发', `${rep.trigger}${rep.actor ? `（${rep.actor}）` : ''}`],
      ['时间', `${fmtTime(rep.startedAt)} → ${fmtTime(rep.endedAt)}（耗时 ${fmtDur(rep.durationMs)}）`],
      ...(rep.input ? [['输入', cut(rep.input, 800)]] : []),
    ]));
    const s = rep.summary;
    B.push(xHead('执行总览'), xP(`节点 ${s.total} 个：成功 ${s.ok} · 失败 ${s.fail} · 分支未命中 ${s.skip}；断言失败 ${s.asserts + s.endAsserts} 项。`));
    B.push(xHead('节点明细'), xTable(['节点', '类型', '状态', '耗时', 'HTTP', '重试', '错误 / 断言'],
      rep.nodes.map(n => [n.name, n.type, n.statusLabel, n.ms != null ? fmtDur(n.ms) : '—', n.httpStatus ?? '—', n.retries || '—', cut(nodeErrText(n), 160) || '—'])));
    B.push(xHead('执行详情'));
    for (const n of rep.nodes) pushDocxNode(B, n);
    if (rep.dataFlows.length) {
      B.push(xHead(`数据传递（${rep.dataFlows.length} 条边）`));
      for (const e of rep.dataFlows) B.push(xP(`${e.from} → ${e.to}${e.mapped ? '（⚡ 边映射）' : ''}`, { b: true }), xCode(e.data, 1200));
    }
    if (rep.verdicts.length) {
      B.push(xHead('问题清单'));
      rep.verdicts.forEach((v, i) => B.push(xP(`${i + 1}. ${v}`, { color: 'A32020' })));
    }
    if (hasAi(rep)) pushDocxAi(B, rep);
    B.push(xHead('结论与建议'));
    rep.suggestions.forEach(x => B.push(xP(`• ${x}`)));
  } else {
    B.push(xHead('APIFlow 流程测试报告（汇总）', 0), xP(`通过率 ${rep.window.passRate}%`, { b: true, sz: 24, color: rep.window.passRate >= 90 ? '0C7A52' : 'B42323', after: 120 }));
    B.push(xTable(['项目', '内容'], [
      ['流程', `${rep.flowName}（${rep.flowId}）`],
      ['当前版本', `v${rep.version}`],
      ['报告时间', fmtTime(rep.generatedAt)],
    ]));
    B.push(xHead(`运行统计（最近 ${rep.window.total} 次）`),
      xP(`通过 ${rep.window.success} 次 · 失败 ${rep.window.failed} 次 · 通过率 ${rep.window.passRate}%${rep.duration.avg != null ? `；耗时：平均 ${fmtDur(rep.duration.avg)}，最快 ${fmtDur(rep.duration.min)}，最慢 ${fmtDur(rep.duration.max)}` : ''}`));
    if (rep.failNodes.length) {
      B.push(xHead('高频失败节点'), xTable(['节点', '失败次数'], rep.failNodes.map(n => [`${n.name}（${n.id}）`, n.count])));
      if (rep.lastError) B.push(xP(`最近一次失败（#${rep.lastError.num}）：${rep.lastError.error}`, { color: 'A32020' }));
    }
    // 最近一次运行的完整明细（成功失败都展示）+ 历史失败详情 + AI 初步分析
    if (rep.lastRun) {
      const lr = rep.lastRun;
      B.push(xHead(`最近一次运行详情（#${lr.num} · ${lr.passed ? '通过' : '未通过'}）`));
      B.push(xP(`触发：${lr.trigger} ｜ 版本：DSL v${lr.version} ｜ 时间：${fmtTime(lr.startedAt)} ｜ 耗时：${fmtDur(lr.durationMs)}`));
      B.push(xP(`节点：${lr.summary.total} 个（成功 ${lr.summary.ok} · 失败 ${lr.summary.fail} · 未执行 ${lr.summary.skip}）`));
      for (const v of lr.verdicts || []) B.push(xP(`⛔ ${v}`, { color: 'A32020' }));
      if (!lr.passed && rep.lastFailRunId === lr.runId) pushDocxAi(B, rep);
      for (const n of lr.nodes) pushDocxNode(B, n);
    }
    if (rep.lastFail && (!rep.lastRun || rep.lastFail.runId !== rep.lastRun.runId)) {
      B.push(xHead(`最近一次失败详情（#${rep.lastFail.num}）`));
      B.push(xP(`触发：${rep.lastFail.trigger} ｜ 时间：${fmtTime(rep.lastFail.startedAt)} ｜ 耗时：${fmtDur(rep.lastFail.durationMs)}`));
      for (const v of rep.lastFail.verdicts || []) B.push(xP(`⛔ ${v}`, { color: 'A32020' }));
      pushDocxAi(B, rep);
      for (const n of rep.lastFail.nodes) pushDocxNode(B, n);
    }
    B.push(xHead(`运行明细（最近 ${Math.min(20, rep.runs.length)} 次）`), xTable(['运行', '版本', '状态', '触发', '耗时', '时间', '错误'],
      rep.runs.map(r => [`#${r.num}`, `v${r.version}`, r.statusLabel, r.trigger, r.durationMs != null ? fmtDur(r.durationMs) : '—', fmtTime(r.startedAt), cut(r.error, 160) || '—'])));
    B.push(xHead('结论与建议'));
    rep.suggestions.forEach(x => B.push(xP(`• ${x}`)));
  }
  B.push(xP(`由 APIFlow 自动生成 · ${fmtTime(rep.generatedAt)}`, { color: '8A9490', sz: 16, before: 240 }));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${B.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: doc },
  ]);
}

/* ── HTTP 响应：format = md | html | docx | json；download=1 时带附件头 ── */
function fileName(rep, ext) {
  const tag = rep.kind === 'run' ? `运行#${rep.num}` : '汇总';
  return `APIFlow测试报告-${rep.flowName}-${tag}.${ext}`.replace(/[\\/:*?"<>| ]/g, '_');
}
const DOCX_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function respond(res, rep, format, download) {
  const cd = name => ({ 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
  if (format === 'json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...(download ? cd(fileName(rep, 'json')) : {}) });
    return res.end(JSON.stringify(rep, null, 1));
  }
  if (format === 'html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(download ? cd(fileName(rep, 'html')) : {}) });
    return res.end(toHtml(rep));
  }
  if (format === 'docx' || format === 'word') {
    res.writeHead(200, { 'content-type': DOCX_CT, ...(cd(fileName(rep, 'docx'))) });
    return res.end(toDocx(rep));
  }
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...(download ? cd(fileName(rep, 'md')) : {}) });
  res.end(toMarkdown(rep));
}

module.exports = { buildRun, buildFlow, toMarkdown, toHtml, toDocx, respond, fileName, aiInnerHtml };

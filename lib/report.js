// ── 测试报告：从运行记录生成可读的测试报告（Markdown / HTML / JSON），支持下载 ──
// 单次报告：一次 run 的执行明细（节点表 / 断言 / 数据传递 / 结论与建议）
// 汇总报告：一个流程最近多次运行的统计（通过率 / 耗时分布 / 常失败节点）

const TRIG = { manual: '手动', batch: '并行批跑', cron: '定时', replay: '重放', 'dry-run': '调试试跑', plugin: '插件' };
const ST = { success: '成功', failed: '失败', running: '运行中', done: '成功', reused: '复用', skipped: '分支未命中' };
const fmtTime = ts => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtDur = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
const cut = (s, n = 200) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const jcut = (v, n = 200) => { try { return cut(typeof v === 'string' ? v : JSON.stringify(v), n); } catch { return cut(v, n); } };

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
      attempts: att, retries: att > 1 ? att - 1 : 0,
      error: r.error || null,
      assertFails: r.assertFails || null,
      output: r.output != null ? jcut(r.output, 300) : null,
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
    from: e.data.from, to: e.data.to, mapped: !!e.data.mapped, data: cut(e.data.data, 160),
  }));
  const verdicts = [];
  if (run.error) verdicts.push(`流程错误：${cut(run.error, 200)}`);
  for (const n of nodes) if (n.error) verdicts.push(`节点「${n.name}」失败：${cut(n.error, 160)}`);
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
    input: run.input && Object.keys(run.input).length ? jcut(run.input, 400) : null,
    summary: { total: nodes.length, ok: okN, fail: failN, skip: skipN, asserts: assertN, endAsserts: endFails.length },
    passed, verdicts, suggestions, nodes, dataFlows: flows,
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
  let lastError = null;
  for (const r of fails) {
    for (const [nid, n] of Object.entries(r.nodes || {})) if (n.status === 'failed') failNodeCnt[nid] = (failNodeCnt[nid] || 0) + 1;
    if (!lastError) {
      const bad = Object.values(r.nodes || {}).find(n => n.error);
      lastError = { num: r.num, error: cut((bad && bad.error) || r.error || '未知错误', 160) };
    }
  }
  // 节点名：从流程定义（优先 published，其次 draft）解析
  const def = (flow.published && flow.published.def) || (flow.draft && flow.draft.def) || null;
  const nameOf = {};
  for (const n of (def && def.nodes) || []) nameOf[n.id] = n.name || n.id;
  const failNodes = Object.entries(failNodeCnt).sort((a, b) => b[1] - a[1])
    .map(([id, c]) => ({ id, name: nameOf[id] || id, count: c }));
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
    failNodes, lastError,
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

/* ── Markdown 渲染 ── */
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
    if (rep.input) L.push(`| 输入 | \`${rep.input}\` |`);
    L.push('', `## 执行总览`, '');
    L.push(`节点 **${rep.summary.total}** 个：成功 ${rep.summary.ok} · 失败 ${rep.summary.fail} · 分支未命中 ${rep.summary.skip}；断言失败 ${rep.summary.asserts + rep.summary.endAsserts} 项。`, '');
    L.push(`## 节点明细`, '');
    L.push(`| 节点 | 类型 | 状态 | 耗时 | HTTP | 重试 | 错误 / 断言 |`, `| --- | --- | --- | --- | --- | --- | --- |`);
    for (const n of rep.nodes) {
      const err = [n.error, (n.assertFails || []).map(f => `断言: ${f}`).join('；')].filter(Boolean).join('；');
      L.push(`| ${n.name} | ${n.type} | ${n.statusLabel} | ${n.ms != null ? fmtDur(n.ms) : '—'} | ${n.httpStatus ?? '—'} | ${n.retries || '—'} | ${err ? cut(err, 120).replace(/\|/g, '\\|') : '—'} |`);
    }
    if (rep.dataFlows.length) {
      L.push('', `## 数据传递（${rep.dataFlows.length} 条边）`, '');
      L.push(`| 从 → 到 | 映射 | 数据 |`, `| --- | --- | --- |`);
      for (const e of rep.dataFlows) L.push(`| ${e.from} → ${e.to} | ${e.mapped ? '⚡ 有' : '—'} | \`${e.data}\` |`);
    }
    if (rep.verdicts.length) {
      L.push('', `## 问题清单`, '');
      rep.verdicts.forEach((v, i) => L.push(`${i + 1}. ${v}`));
    }
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
    L.push(`## 运行明细（最近 ${Math.min(20, rep.runs.length)} 次）`, '');
    L.push(`| 运行 | 版本 | 状态 | 触发 | 耗时 | 时间 | 错误 |`, `| --- | --- | --- | --- | --- | --- | --- |`);
    for (const r of rep.runs) L.push(`| #${r.num} | v${r.version} | ${r.statusLabel} | ${r.trigger} | ${r.durationMs != null ? fmtDur(r.durationMs) : '—'} | ${fmtTime(r.startedAt)} | ${r.error ? cut(r.error, 80).replace(/\|/g, '\\|') : '—'} |`);
    L.push('', `## 结论与建议`, '');
    rep.suggestions.forEach(s => L.push(`- ${s}`));
  }
  L.push('', '---', `*由 APIFlow 自动生成 · ${fmtTime(rep.generatedAt)}*`);
  return L.join('\n');
}

/* ── HTML 渲染（独立文件，内联样式，可直接打开 / 归档） ── */
function toHtml(rep) {
  const md = toMarkdown(rep);
  // 报告不需要交互，直接复用 Markdown 渲染成带样式的静态页（表格 / 标题 / 强调都齐了）
  const body = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n').reduce((acc, line) => {
      if (/^\| /.test(line)) { acc.t.push(line); return acc; }
      if (acc.t.length) { acc.h.push(renderMdTable(acc.t)); acc.t = []; }
      if (/^# /.test(line)) acc.h.push(`<h1>${line.slice(2)}</h1>`);
      else if (/^## /.test(line)) acc.h.push(`<h2>${line.slice(3)}</h2>`);
      else if (/^---$/.test(line.trim())) acc.h.push('<hr>');
      else if (/^[-*] /.test(line)) acc.h.push(`<li>${inline(line.slice(2))}</li>`);
      else if (/^\d+\. /.test(line)) acc.h.push(`<li>${inline(line.replace(/^\d+\. /, ''))}</li>`);
      else if (line.trim() === '') ;
      else acc.h.push(`<p>${inline(line)}</p>`);
      return acc;
    }, { h: [], t: [] });
  if (body.t.length) body.h.push(renderMdTable(body.t));
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escH(rep.flowName)} · APIFlow 测试报告</title>
<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:860px;margin:32px auto;padding:0 24px;color:#1c2430;line-height:1.65}
h1{font-size:22px;border-bottom:2px solid #2FBF8F;padding-bottom:8px}h2{font-size:16px;margin-top:28px;color:#0f6e51}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th{background:#eef4f1;text-align:left}
th,td{border:1px solid #d8e0dc;padding:6px 10px}td code{background:#f2f5f4;padding:1px 5px;border-radius:4px;font-size:12px}
li{margin:4px 0}hr{border:none;border-top:1px solid #dde;margin-top:28px}
em,i{color:#667}p{margin:6px 0}</style></head><body>${body.h.join('\n')}</body></html>`;
}
function renderMdTable(rows) {
  const cells = r => r.split('|').slice(1, -1).map(c => c.trim());
  const head = cells(rows[0]), body = rows.slice(2);
  return `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
    body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function inline(s) {
  return escH(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}
const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── HTTP 响应：format = md | html | json；download=1 时带附件头 ── */
function fileName(rep, ext) {
  const tag = rep.kind === 'run' ? `运行#${rep.num}` : '汇总';
  const name = `APIFlow测试报告-${rep.flowName}-${tag}.${ext}`.replace(/[\\/:*?"<>| ]/g, '_');
  return name;
}
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
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...(download ? cd(fileName(rep, 'md')) : {}) });
  res.end(toMarkdown(rep));
}

module.exports = { buildRun, buildFlow, toMarkdown, toHtml, respond, fileName };

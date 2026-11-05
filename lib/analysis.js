// ── AI 失败分析：调用 LLM 对失败运行做初步根因分析，结果落盘缓存 ──
// 输入：报告对象（lib/report.buildRun 的产物，含节点请求/响应/断言/尝试明细）
// 输出：{ overview, causes:[{node,cause,evidence,suggestion}], nextSteps }
// 缓存：data/analysis/{runId}.json（运行记录不可变，分析结果可复用；?refresh=1 强制重算）
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const llm = require('./llm');

const DIR = path.join(__dirname, '..', 'data', 'analysis');
const cachePath = id => path.join(DIR, id + '.json');

function getCached(runId) {
  try { return JSON.parse(fs.readFileSync(cachePath(runId), 'utf8')); } catch { return null; }
}
function saveCache(runId, data) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(cachePath(runId), JSON.stringify(data, null, 1)); } catch { /* 缓存失败不影响主流程 */ }
}

const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…(截断)' : s; };

/* 从报告对象提炼失败上下文（紧凑投影，控制 token） */
function buildContext(rep) {
  const bad = rep.nodes.filter(n => n.status === 'failed' || (n.assertFails || []).length || n.bizError).slice(0, 6);
  return {
    flow: rep.flowName,
    input: rep.input ? cut(rep.input, 500) : null,
    failures: bad.map(n => ({
      node: n.name, type: n.type,
      http: n.httpStatus, attempts: n.attempts, retries: n.retries,
      error: n.error ? cut(n.error, 400) : null,
      bizError: n.bizError || null,
      asserts: n.assertFails || null,
      attemptList: n.attemptList.length ? n.attemptList : null,
      request: n.request ? `${n.request.method} ${n.request.url}` + (n.request.body ? '\nbody: ' + cut(n.request.body, 600) : '') : null,
      response: n.output != null ? cut(n.output, 1200) : null,
    })),
  };
}

const SYSTEM = `你是接口自动化测试的失败分析专家。根据失败节点的请求、响应、断言与重试记录，推断失败根因。
判断要具体、有依据：如连接拒绝/ECONNREFUSED→服务未启动或地址端口错误；404→路径错误；401/403→认证问题；422/400→参数缺失或格式错误；500→服务端异常（结合响应体定位）；断言失败→对比期望值与实际返回找差异；超时→网络或服务性能问题。
只输出一个 JSON 对象，不要多余文字：
{"overview":"一句话总述本次失败情况","causes":[{"node":"节点名","cause":"最可能的根因","evidence":"依据（引用具体错误信息或响应内容）","suggestion":"具体可操作的排查/修复建议"}],"nextSteps":["下一步动作1","下一步动作2"]}`;

/* 生成分析（带缓存）。返回：
   { ok:true, cached, analysis, generatedAt, model, ms } 成功
   { ok:true, skipped:true }                            通过的运行无需分析
   { ok:false, off:true, message }                      LLM 未启用
   { ok:false, llmError }                               LLM 调用/解析失败 */
async function analyzeRun(runId, rep, refresh) {
  if (rep.passed) return { ok: true, skipped: true };
  const cached = getCached(runId);
  if (cached && !refresh) return { ok: true, cached: true, ...cached };
  const s = settings.load();
  if (s.enabled === false || process.env.APIFLOW_LLM === 'off' || !s.baseUrl || !s.model)
    return { ok: false, off: true, message: 'LLM 未启用（可在设置页配置后使用 AI 分析）' };
  const started = Date.now();
  try {
    const ctx = JSON.stringify(buildContext(rep));
    const opts = { temperature: 0.2, maxTokens: Math.min(s.maxTokens || 4096, 3000), timeoutMs: Math.min(s.timeoutMs || 90000, 90000) };
    let a = null, lastErr = null;
    // 最多两次：首次解析失败时把错误回传给模型要求重新输出合法 JSON（模型偶尔会写出非法结构/截断）
    for (let attempt = 0; attempt < 2 && !a; attempt++) {
      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '运行失败记录：\n' + ctx },
      ];
      if (attempt) messages.push({ role: 'user', content: `上一次输出无法解析（${lastErr}）。请重新只输出一个合法的 JSON 对象：不要代码围栏、不要解释，字符串内引号必须转义，数组元素之间必须有逗号。` });
      const r = await llm.chat(messages, opts);
      try {
        const parsed = llm.extractJson(r.content);
        if (!parsed || typeof parsed.overview !== 'string' || !Array.isArray(parsed.causes)) throw new Error('LLM 返回的分析结构不符合预期');
        a = parsed;
      } catch (e) { lastErr = String(e.message || e); }
    }
    if (!a) throw new Error(lastErr || 'LLM 返回的分析无法解析');
    const analysis = {
      overview: String(a.overview).slice(0, 500),
      causes: (a.causes || []).slice(0, 6).map(c => ({
        node: String(c.node || '').slice(0, 80),
        cause: String(c.cause || '').slice(0, 500),
        evidence: String(c.evidence || '').slice(0, 500),
        suggestion: String(c.suggestion || '').slice(0, 500),
      })),
      nextSteps: (Array.isArray(a.nextSteps) ? a.nextSteps : []).slice(0, 6).map(x => String(x).slice(0, 300)),
    };
    const data = { analysis, generatedAt: Date.now(), model: s.model, ms: Date.now() - started };
    saveCache(runId, data);
    return { ok: true, cached: false, ...data };
  } catch (e) {
    return { ok: false, llmError: String(e.message || e).slice(0, 300) };
  }
}

module.exports = { analyzeRun, getCached };

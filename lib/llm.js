// ── LLM 客户端：OpenAI 兼容 /chat/completions（零依赖，Node 22 全局 fetch）──
// 兼容 reasoning 模型：content 为空时看 reasoning_content；<think> 块一律剥掉；
// 从任意回复文本里鲁棒地抠出第一个完整 JSON 对象（搭建 DSL 用）。
const settings = require('./settings');

function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?thinking\|?>[\s\S]*?(?:<\|?\/thinking\|?>|$)/gi, '')
    .trim();
}

async function chat(messages, opts = {}) {
  const s = settings.load();
  const baseUrl = (opts.baseUrl || s.baseUrl || '').replace(/\/+$/, '');
  const model = opts.model || s.model;
  if (!baseUrl || !model) throw new Error('LLM 未配置（需要 baseUrl 与 model）');
  const timeoutMs = opts.timeoutMs || s.timeoutMs || 90000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    const key = opts.apiKey || s.apiKey;
    if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature != null ? opts.temperature : s.temperature,
        max_tokens: opts.maxTokens || s.maxTokens || 4096,
        stream: false,
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 网关 ${res.status}（${ms}ms）：${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message || {};
    let content = stripThink(msg.content);
    // reasoning 模型 max_tokens 被思考吃光时 content 可能为空 —— 明确报错而不是静默降级
    if (!content && msg.reasoning_content) {
      throw new Error('LLM 只输出了思考没有输出内容（max_tokens 不足或模型异常），请调大 max_tokens');
    }
    const finish = data.choices && data.choices[0] && data.choices[0].finish_reason;
    if (finish === 'length') throw new Error('LLM 输出被 max_tokens 截断，请调大');
    return { content, usage: data.usage || {}, ms, finish };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM 请求超时（${timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 从回复文本中抠 JSON：剥代码围栏 → 首个 { 到与之配对的 }（容忍字符串内的花括号）
function extractJson(text) {
  let t = stripThink(text).replace(/```(?:json)?/gi, '```');
  const fence = t.indexOf('```');
  if (fence >= 0) {
    const end = t.indexOf('```', fence + 3);
    if (end > fence) t = t.slice(fence + 3, end);
  }
  const start = t.indexOf('{');
  if (start < 0) throw new Error('LLM 回复里没有 JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('LLM 回复里的 JSON 不完整');
}

// 连通性测试：发一条极短消息，返回模型自述与耗时
async function testConn(over = {}) {
  const r = await chat(
    [{ role: 'user', content: '收到请只回复两个字：正常' }],
    { maxTokens: over.maxTokens || 1024, timeoutMs: over.timeoutMs || 20000, ...over },
  );
  return { ok: true, reply: r.content.slice(0, 40), ms: r.ms, usage: r.usage };
}

module.exports = { chat, extractJson, testConn, stripThink };

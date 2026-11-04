// ── 平台设置（LLM 接入等）：落盘 data/settings.json，Key 不出服务端 ──
// 读取接口一律脱敏（publicView），只有写接口接受明文 Key；env APIFLOW_LLM=off 可一键强制关闭。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'settings.json');
const DEFAULTS = {
  enabled: false,          // 总开关：关 = 纯规则引擎（测试/离线场景）
  baseUrl: '',             // OpenAI 兼容网关，如 http://llm-gateway.example.com/v1
  apiKey: '',              // Bearer Token；空 = 网关不鉴权
  model: '',               // 如 moma/glm-5.3-flash
  temperature: 0.2,        // 搭建要稳，默认低温
  maxTokens: 8192,         // reasoning 模型思考也耗 token，给足防 finish_reason=length 空内容
  timeoutMs: 180000,       // 推理模型 + 大目录提示，慢网关给足时间（可在设置页调）
  updatedAt: null,
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 首次没有文件 */ }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

// 保留原有 Key：前端回传的是脱敏值（sk-****xxxx）或空 —— 空且原 Key 存在时不覆盖
function isMaskedKey(v) { return typeof v === 'string' && /^\*{4}/.test(v); }

function set(patch = {}) {
  const cur = load();
  const next = { ...cur };
  for (const k of ['enabled', 'baseUrl', 'apiKey', 'model']) {
    if (patch[k] !== undefined) {
      if (k === 'apiKey') {
        if (isMaskedKey(patch[k])) continue;                 // 脱敏回显，原样保留
        if (patch[k] === '' && cur.apiKey) continue;         // 留空 = 不改 Key
        next[k] = String(patch[k]).trim();
      } else if (k === 'enabled') {
        next[k] = !!patch[k];
      } else {
        next[k] = String(patch[k]).trim();
      }
    }
  }
  for (const k of ['temperature', 'maxTokens', 'timeoutMs']) {
    if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') {
      const n = Number(patch[k]);
      if (Number.isFinite(n)) next[k] = n;
    }
  }
  // 数值夹紧
  next.temperature = Math.min(2, Math.max(0, next.temperature));
  next.maxTokens = Math.min(32768, Math.max(256, Math.round(next.maxTokens)));
  next.timeoutMs = Math.min(300000, Math.max(3000, Math.round(next.timeoutMs)));
  next.updatedAt = new Date().toISOString();
  cache = next;
  persist();
  return next;
}

// 给前端的脱敏视图
function publicView() {
  const s = load();
  const tail = s.apiKey ? s.apiKey.slice(-4) : '';
  return {
    enabled: s.enabled, baseUrl: s.baseUrl, model: s.model,
    temperature: s.temperature, maxTokens: s.maxTokens, timeoutMs: s.timeoutMs,
    hasKey: !!s.apiKey,
    apiKey: s.apiKey ? '****' + tail : '',
    ready: isLLMOn(),
    updatedAt: s.updatedAt,
  };
}

// LLM 是否真的可用：总开关 + baseUrl + model 齐备；APIFLOW_LLM=off 一票否决（回归测试用）
function isLLMOn() {
  if (String(process.env.APIFLOW_LLM || '').toLowerCase() === 'off') return false;
  const s = load();
  return !!(s.enabled && s.baseUrl && s.model);
}

module.exports = { load, set, publicView, isLLMOn, FILE };

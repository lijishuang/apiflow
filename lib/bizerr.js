// ── 业务错误信封识别 ──
// 网关常见做法：HTTP 200 + 响应体里包一个错误信封
//   {"code":"010024","message":"参数校验异常,poolId","state":"ERROR"}
//   {"errorMessage":"Input parameter AccessKey missing","errorCode":"MISSING_PARAMETER","state":"ERROR"}
// 这类响应在 HTTP 层是「成功」的 —— 不看信封就会把错误当成正常返回，
// 流程「成功」结束、下游拿到一坨错误 JSON，排查全凭肉眼。
// 这里只做一件事：判断响应体是不是错误信封，并把「缺哪个参数 / 哪个取值不被接受」抠出来，
// 好让引擎把节点标红、把提示写成用户能直接照做的一句话。
const OK_CODE = /^(?:0+|0*0000+|200|OK|SUCCESS|SUCCEEDED|success|ok)$/i;
const ERR_STATE = /^(?:error|err|fail|failed|failure|exception|abnormal)$/i;
const OK_STATE = /^(?:ok|success|succeed|succeeded|done|normal)$/i;

const str = v => (v == null ? '' : String(v).trim());

function pickMessage(o) {
  for (const k of ['errorMessage', 'error_message', 'message', 'msg', 'error_description', 'error', 'errmsg']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}
function pickCode(o) {
  for (const k of ['errorCode', 'code', 'errno', 'errCode', 'error_code', 'retCode']) {
    const v = o[k];
    if (v !== undefined && v !== null && str(v)) return str(v);
  }
  return '';
}

// 「缺哪个参数」——各家措辞不同，尽量都接住
const MISSING_RULES = [
  /参数校验异常\s*[,，:：]\s*([A-Za-z_][\w.[\]]*)/,
  /(?:input\s+)?parameter\s+([A-Za-z_][\w.[\]]*)\s+(?:is\s+)?missing/i,
  /missing\s+(?:required\s+)?(?:input\s+)?param(?:eter)?\s*[:：]?\s*([A-Za-z_][\w.[\]]*)/i,
  /(?:required|missing)\s+param(?:eter)?\s*[:：]\s*([A-Za-z_][\w.[\]]*)/i,
  /(?:参数|字段)\s*([A-Za-z_][\w.[\]]*)\s*(?:不能为空|不可为空|缺失|必填|未传|未填写)/,
  /(?:缺少|缺失)(?:必填)?(?:参数|字段)\s*[:：]?\s*([A-Za-z_][\w.[\]]*)/,
];

// 「哪个取值不被接受」——消息里通常只有中文标签，映射回参数名
const LABEL_TO_PARAM = [
  [/产品类型|产品类别|product\s*type/i, 'productType'],
  [/资源池|pool/i, 'poolId'],
  [/区域|region/i, 'region'],
  [/页码|page\s*num/i, 'pageNum'],
  [/每页|分页大小|page\s*size/i, 'pageSize'],
];

function extractMissing(msg) {
  const out = [];
  for (const re of MISSING_RULES) {
    const m = msg.match(re);
    if (m && m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

function extractInvalid(msg) {
  const m = msg.match(/不支持(?:该)?([^:：,，]{1,12})\s*[:：]\s*([^,，。；;]{1,40})/);
  if (!m) return [];
  const label = m[1].trim();
  const hit = LABEL_TO_PARAM.find(([re]) => re.test(label));
  return [{ param: hit ? hit[1] : label, label, value: m[2].trim() }];
}

/**
 * 判断响应体是否为错误信封。
 * @returns {null | {code:string, message:string, missing:string[], invalid:Array<{param,label,value}>, payload:object}}
 */
function detectBusinessError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const code = pickCode(payload);
  const message = pickMessage(payload);
  const state = str(payload.state || payload.statusText || '');
  const fail = () => ({ code, message, missing: extractMissing(message), invalid: extractInvalid(message), payload });

  if (payload.success === false || payload.ok === false) return fail();
  if (state && ERR_STATE.test(state)) return fail();
  if (state && OK_STATE.test(state)) return null;          // 明确说了成功，别再多想
  // 没有状态位时才看 code：必须同时有说明文字，且 code 不像成功码
  if (code && message && !OK_CODE.test(code)) return fail();
  return null;
}

const AUTH_PARAM = /^(?:access_?key|accesskeyid|signature|signaturenonce|signaturemethod|signatureversion|timestamp|nonce|token|authorization)$/i;

/**
 * 把错误信封翻译成一句可执行的话。
 * @param {object} biz   detectBusinessError 的返回值
 * @param {object} labels 参数名 → 中文名（来自接口参数提示，可空）
 */
function describe(biz, labels = {}) {
  if (!biz) return '';
  const cn = n => (labels[n] ? `${n}（${labels[n]}）` : n);
  const head = biz.code ? `业务错误 ${biz.code}` : '业务错误';
  if (biz.missing.length) {
    // 认证参数缺失不是「业务参数没填」，指到 Query 里会把人带偏
    if (biz.missing.some(n => AUTH_PARAM.test(n))) {
      return `${head}：${biz.message}｜认证参数缺失（${biz.missing.join('、')}）—— 检查凭证是否绑定、签名模式是否为上游要求的模式`;
    }
    return `${head}：${biz.message}｜缺少必填参数 ${biz.missing.map(cn).join('、')} —— 在节点属性的 Query 里补上再重跑`;
  }
  if (biz.invalid.length) {
    const x = biz.invalid[0];
    return `${head}：${biz.message}｜参数 ${cn(x.param)} 不接受取值「${x.value}」`;
  }
  return `${head}：${biz.message || '上游返回错误状态'}`;
}

module.exports = { detectBusinessError, describe, extractMissing, extractInvalid, pickMessage, pickCode, AUTH_PARAM };

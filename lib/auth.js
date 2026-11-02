// ── 认证模块：AK/SK 凭证管理 + 请求签名 + 上游校验 ──
// 两级绑定：单接口级（opBindings[operationId]）> 流程级（def.authId）
// 两种模式：hmac（默认，HMAC-SHA256 签名）/ header（AK/SK 头直传，适合简单内网）
const crypto = require('crypto');
const { store } = require('./store');

const genKey = bytes => crypto.randomBytes(bytes).toString('hex');

// ── 凭证管理 ──
function createCred({ name, ak, sk, mode } = {}) {
  const cred = {
    id: 'cred_' + crypto.randomBytes(4).toString('hex'),
    name: String(name || '未命名凭证').slice(0, 40),
    ak: String(ak || '').trim() || 'AK' + genKey(8),
    sk: String(sk || '').trim() || genKey(24),
    mode: mode === 'header' ? 'header' : 'hmac',
    createdAt: Date.now(),
  };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(cred.ak)) throw new Error('AK 须为 8~64 位字母/数字/下划线/连字符');
  if (String(sk || '').trim() && String(sk).length < 16) throw new Error('SK 至少 16 位（留空则自动生成）');
  if (store.listCreds().some(c => c.ak === cred.ak)) throw new Error(`AK「${cred.ak}」已存在`);
  store.saveCred(cred);
  return cred;
}

function maskSk(sk) { return String(sk).slice(0, 4) + '****' + String(sk).slice(-4); }

function deleteCred(id) {
  const ok = store.removeCred(id);
  if (!ok) return false;
  // 清理流程级绑定（published + draft），避免悬空引用
  for (const f of store.listFlows()) {
    let dirty = false;
    for (const key of ['published', 'draft']) {
      const def = f[key] && f[key].def;
      if (def && def.authId === id) { delete def.authId; dirty = true; }
    }
    if (dirty) store.persistFlows();
  }
  return true;
}

// ── 签名（与上游校验共用同一规范串）──
// canonical = METHOD \n path[?query] \n timestamp \n sha256hex(body)
const bodyHash = text => crypto.createHash('sha256').update(text || '').digest('hex');

function sign(cred, method, pathWithQuery, timestamp, bHash) {
  const canonical = [method.toUpperCase(), pathWithQuery, String(timestamp), bHash].join('\n');
  return crypto.createHmac('sha256', cred.sk).update(canonical).digest('hex');
}

// 每次尝试重新取时间戳（防重放窗口 ±5 分钟）
function authHeaders(cred, method, url, bodyText) {
  const u = new URL(url);
  const pathWithQuery = u.pathname + u.search;
  const ts = String(Date.now());
  if (cred.mode === 'header') {
    return { 'x-api-key': cred.ak, 'x-api-secret': cred.sk, 'x-sign-ts': ts };
  }
  return { 'x-api-key': cred.ak, 'x-sign-ts': ts, 'x-signature': sign(cred, method, pathWithQuery, ts, bodyHash(bodyText)) };
}

// 上游校验：返回 null 表示通过，否则返回错误原因
function verify({ cred, method, pathWithQuery, ts, signature, bHash, secret }) {
  if (cred.mode === 'header') {
    return secret === cred.sk ? null : 'SK 校验失败';
  }
  const t = Number(ts);
  if (!t || Math.abs(Date.now() - t) > 300000) return '签名时间戳缺失或已过期（±5 分钟内有效）';
  const expect = sign(cred, method, pathWithQuery, t, bHash);
  if (expect !== String(signature || '')) return '签名不匹配';
  return null;
}

module.exports = { createCred, maskSk, deleteCred, authHeaders, verify, bodyHash };

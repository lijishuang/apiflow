// ── 平台访问层：外部客户端（Chrome 插件 / 脚本）如何证明「我是谁」──
// 两种方式，与平台内部的 AK/SK 凭证体系保持一致：
//   ① 令牌：用平台里已有的 AK/SK 换一张 Bearer 令牌（默认 7 天，可撤销）
//   ② 直签：每个请求带 x-api-key / x-sign-ts / x-signature（HMAC-SHA256，与上游接口同一套规范串）
// 默认 requireAuth=false —— 本机控制台照旧直接用，插件也能「跟随平台」自动判断是否需要认证。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { store } = require('./store');
const { verify, bodyHash } = require('./auth');

const FILE = path.join(__dirname, '..', 'data', 'access.json');
const DEFAULT_TTL = 7 * 24 * 3600 * 1000;
const MAX_TTL = 90 * 24 * 3600 * 1000;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      requireAuth: !!d.requireAuth,
      tokens: Array.isArray(d.tokens) ? d.tokens : [],
      activity: Array.isArray(d.activity) ? d.activity : [],
      updatedAt: d.updatedAt || Date.now(),
    };
  } catch {
    return { requireAuth: false, tokens: [], activity: [], updatedAt: Date.now() };
  }
}
let state = load();
let _dirty = false, _timer = null;
function persist(now = false) {
  _dirty = true;
  if (now) return flush();
  if (_timer) return;
  _timer = setTimeout(flush, 800);
  if (_timer.unref) _timer.unref();
}
function flush() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (!_dirty) return;
  _dirty = false;
  state.updatedAt = Date.now();
  const tmp = FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, FILE); } catch { /* 只读环境忽略 */ }
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const maskToken = t => `${t.prefix || 'apf_'}…${String(t.id).slice(-4)}`;

// ── 令牌 ──
function issueToken({ name, credId, ttlMs, scopes } = {}) {
  const cred = credId ? store.getCred(credId) : null;
  if (credId && !cred) throw new Error('凭证不存在：' + credId);
  const raw = 'apf_' + crypto.randomBytes(24).toString('hex');
  const ttl = clampTtl(ttlMs);
  const tk = {
    id: 'tok_' + crypto.randomBytes(4).toString('hex'),
    name: String(name || (cred ? `${cred.name} · 插件` : '插件令牌')).slice(0, 40),
    prefix: raw.slice(0, 12),
    hash: sha256(raw),
    ak: cred ? cred.ak : null,
    credId: cred ? cred.id : null,
    scopes: Array.isArray(scopes) && scopes.length ? scopes : ['read', 'run', 'debug'],
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    lastUsedAt: null,
    uses: 0,
  };
  state.tokens.unshift(tk);
  state.tokens = state.tokens.slice(0, 50);
  persist(true);
  return { token: raw, ...publicToken(tk) };
}

function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(10 * 60 * 1000, Math.round(n)));
}

function publicToken(t) {
  return {
    id: t.id, name: t.name, prefix: t.prefix, ak: t.ak || null, credId: t.credId || null,
    scopes: t.scopes || [], createdAt: t.createdAt, expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt || null, uses: t.uses || 0,
    expired: !!(t.expiresAt && t.expiresAt < Date.now()), masked: maskToken(t),
  };
}
function listTokens() { return state.tokens.map(publicToken); }
function revokeToken(id) {
  const before = state.tokens.length;
  state.tokens = state.tokens.filter(t => t.id !== id);
  if (state.tokens.length === before) return false;
  persist(true);
  return true;
}

function findToken(raw) {
  const h = sha256(raw);
  const t = state.tokens.find(x => x.hash === h);
  if (!t) return null;
  if (t.expiresAt && t.expiresAt < Date.now()) return { expired: true, token: t };
  return { token: t };
}

// ── 认证 ──
// 返回 { ok, actor } 或 { ok:false, code, error }
// actor 会被写进运行记录，Web 端「运行观测」能看到这次是插件以哪个身份触发的
function authenticate({ headers = {}, method = 'GET', pathWithQuery = '/', rawBody = '', queryToken = '' } = {}) {
  const auth = String(headers['authorization'] || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const token = bearer || queryToken || String(headers['x-access-token'] || '').trim();

  if (token) {
    const hit = findToken(token);
    if (!hit) return { ok: false, code: 'BAD_TOKEN', error: '令牌无效，请在插件设置里重新获取' };
    if (hit.expired) return { ok: false, code: 'TOKEN_EXPIRED', error: '令牌已过期，请重新获取' };
    touch(hit.token, { method, path: pathWithQuery });
    return {
      ok: true,
      actor: {
        kind: 'token', tokenId: hit.token.id, name: hit.token.name,
        ak: hit.token.ak || null, credId: hit.token.credId || null,
      },
    };
  }

  const ak = String(headers['x-api-key'] || '').trim();
  if (ak) {
    const cred = store.listCreds().find(c => c.ak === ak);
    if (!cred) return { ok: false, code: 'BAD_AK', error: 'AK 不存在，请先在平台「接口 → 认证凭证」里创建' };
    const err = verify({
      cred,
      method,
      pathWithQuery,
      ts: headers['x-sign-ts'],
      signature: headers['x-signature'],
      bHash: bodyHash(rawBody),
      secret: headers['x-api-secret'],
    });
    if (err) return { ok: false, code: 'BAD_SIGNATURE', error: 'AK/SK 校验失败：' + err };
    touch(null, { method, path: pathWithQuery, actor: cred.name });
    return { ok: true, actor: { kind: 'aksk', name: cred.name, ak: cred.ak, credId: cred.id } };
  }

  return { ok: false, code: 'AUTH_REQUIRED', error: '需要认证：请用平台 AK/SK 换取令牌，或直接对请求签名' };
}

function touch(token, { method, path: p, actor }) {
  const now = Date.now();
  if (token) {
    token.lastUsedAt = now;
    token.uses = (token.uses || 0) + 1;
  }
  state.activity.unshift({ at: now, actor: actor || (token ? token.name : '?'), method, path: String(p).slice(0, 120) });
  state.activity = state.activity.slice(0, 30);
  persist();   // 合并写：高频调用不会每个请求都落盘
}

// ── 设置 ──
function settings() {
  return {
    requireAuth: state.requireAuth,
    updatedAt: state.updatedAt,
    creds: store.listCreds().map(c => ({ id: c.id, name: c.name, ak: c.ak, mode: c.mode })),
    tokens: listTokens(),
    activity: state.activity.slice(0, 12),
  };
}
function updateSettings({ requireAuth } = {}) {
  if (requireAuth != null) state.requireAuth = !!requireAuth;
  persist(true);
  return settings();
}
function needAuth() { return state.requireAuth; }

// 用 AK/SK 换令牌（等价于「登录」）：SK 必须与平台凭证完全一致
function loginWithCred(ak, sk) {
  const cred = store.listCreds().find(c => c.ak === String(ak || '').trim());
  if (!cred) throw new Error('AK 不存在，请先在平台「接口 → 认证凭证」里创建');
  const same = String(cred.sk) === String(sk || '');
  const ok = same || (String(sk || '').length >= 16 && sha256(sk) === sha256(cred.sk));
  if (!ok) throw new Error('SK 校验失败');
  return cred;
}

module.exports = {
  issueToken, listTokens, revokeToken, findToken, authenticate,
  settings, updateSettings, needAuth, loginWithCred, publicToken, flush,
};

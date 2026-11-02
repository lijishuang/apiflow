// APIFlow 插件公共客户端：配置、认证（令牌 / AK-SK 直签）、请求、SSE
// 同时被 background.js（importScripts）与 sidepanel.html（script）复用，所以不能用 ES module。
(function () {
  const DEFAULT_SERVER = 'http://127.0.0.1:3300';
  const CFG_KEY = 'apiflow.cfg';
  const DEFAULT_CFG = {
    server: DEFAULT_SERVER,
    authMode: 'auto',     // auto = 跟随平台；token = 令牌；aksk = 每个请求签名
    ak: '', sk: '', token: '', tokenExp: 0, tokenName: '',
  };

  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get() {
      if (hasChrome) return (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || null;
      try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
    },
    async set(cfg) {
      if (hasChrome) return chrome.storage.local.set({ [CFG_KEY]: cfg });
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    },
  };

  async function getCfg() {
    return { ...DEFAULT_CFG, ...((await store.get()) || {}) };
  }
  async function saveCfg(patch) {
    const cfg = { ...(await getCfg()), ...patch };
    await store.set(cfg);
    return cfg;
  }
  const base = cfg => String(cfg.server || DEFAULT_SERVER).replace(/\/+$/, '');

  /* ── 加密原语（WebCrypto，与服务端 auth.js 的规范串保持一致）── */
  const enc = new TextEncoder();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const sha256Hex = async text => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  async function hmacHex(sk, msg) {
    const key = await crypto.subtle.importKey('raw', enc.encode(sk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  }

  // canonical = METHOD \n path?query \n timestamp \n sha256hex(body)
  async function signHeaders(cfg, method, pathWithQuery, bodyText) {
    const ts = String(Date.now());
    const canonical = [method.toUpperCase(), pathWithQuery, ts, await sha256Hex(bodyText || '')].join('\n');
    return { 'x-api-key': cfg.ak, 'x-sign-ts': ts, 'x-signature': await hmacHex(cfg.sk, canonical) };
  }

  async function authHeaders(cfg, method, pathWithQuery, bodyText) {
    const mode = cfg.authMode || 'auto';
    if (mode === 'aksk') {
      if (!cfg.ak || !cfg.sk) throw new Error('AK/SK 认证需要在设置里填 AK 与 SK');
      return signHeaders(cfg, method, pathWithQuery, bodyText);
    }
    if (cfg.token) return { authorization: 'Bearer ' + cfg.token };
    if (mode === 'auto' && cfg.ak && cfg.sk) return signHeaders(cfg, method, pathWithQuery, bodyText);
    return {};
  }

  /* ── 令牌换取 ── */
  async function login(cfg) {
    const body = { ak: cfg.ak, sk: cfg.sk, name: cfg.tokenName || 'Chrome 插件' };
    const res = await fetch(base(cfg) + '/api/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '换取令牌失败');
    await saveCfg({ token: data.token, tokenExp: data.expiresAt || 0 });
    return data.token;
  }
  // 401 时尝试补一张令牌：auto 模式用 AK/SK 换，token 模式提示重新贴令牌
  async function ensureToken(cfg, code) {
    if (cfg.authMode === 'aksk') return false;
    if (cfg.ak && cfg.sk) {
      try { await login(cfg); return true; } catch { return false; }
    }
    if (code === 'TOKEN_EXPIRED' || code === 'BAD_TOKEN') throw new Error('令牌已失效：请在设置里用 AK/SK 重新获取');
    if (code === 'AUTH_REQUIRED') throw new Error('平台已开启认证：请在设置里填 AK/SK（或用令牌）');
    return false;
  }

  /* ── 请求 ── */
  async function request(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const bodyText = opts.body != null ? JSON.stringify(opts.body) : '';
    let cfg = opts.cfg || await getCfg();
    for (let attempt = 0; attempt < 2; attempt++) {
      let headers;
      try { headers = await authHeaders(cfg, method, path, bodyText); }
      catch (e) { return { ok: false, status: 0, data: { error: e.message } }; }
      if (bodyText) headers['content-type'] = 'application/json';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);
      let res;
      try {
        res = await fetch(base(cfg) + path, {
          method, headers, body: bodyText || undefined, signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, status: 0, data: { error: e.name === 'AbortError' ? '请求超时' : '连不上 APIFlow：' + (e.message || e) } };
      }
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      // 平台没开认证、而本地这张令牌已失效时，服务端会降级放行并标记：顺手清掉脏令牌，避免每次白带
      if (res.headers.get('x-apiflow-auth') === 'invalid' && cfg.token) {
        cfg = await saveCfg({ token: '', tokenExp: 0 });
        data.authDropped = true;
      }
      if (res.status === 401 && attempt === 0) {
        try { if (await ensureToken(cfg, data.code)) { cfg = await getCfg(); continue; } }
        catch (e) { return { ok: false, status: 401, data: { ...data, error: e.message } }; }
      }
      return { ok: res.ok, status: res.status, data };
    }
    return { ok: false, status: 0, data: { error: '认证失败' } };
  }

  async function ping(cfg) {
    const c = cfg || await getCfg();
    const headers = await authHeaders(c, 'GET', '/api/ext/ping', '').catch(() => ({}));
    try {
      const res = await fetch(base(c) + '/api/ext/ping', { headers });
      const data = await res.json().catch(() => ({}));
      // 凭证已失效但平台开着认证 → 提示重新授权；平台没开认证 → 直接丢掉脏令牌
      if (data.credInvalid) {
        if (!data.requireAuth && c.token) {
          await saveCfg({ token: '', tokenExp: 0 });
          data.authDropped = true;
        }
        if (!data.requireAuth) data.credInvalid = null;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: '连不上服务：' + (e.message || e) } };
    }
  }

  /* ── SSE：EventSource 不能带请求头，用 fetch 流自己解 ── */
  async function openStream(cfg, { onEvent, onStatus, signal }) {
    const headers = await authHeaders(cfg, 'GET', '/api/events', '').catch(() => ({}));
    headers.accept = 'text/event-stream';
    let res;
    try {
      res = await fetch(base(cfg) + '/api/events', { headers, signal });
    } catch (e) {
      onStatus && onStatus('error', String(e.message || e));
      return;
    }
    if (!res.ok || !res.body) {
      onStatus && onStatus('error', 'SSE ' + res.status);
      return;
    }
    onStatus && onStatus('open');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message', data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { onEvent && onEvent(event, JSON.parse(data)); } catch { /* 单条坏数据不影响后续 */ }
        }
      }
      onStatus && onStatus('closed');
    } catch (e) {
      if (e.name !== 'AbortError') onStatus && onStatus('error', String(e.message || e));
    }
  }

  self.APF = {
    DEFAULT_SERVER, CFG_KEY, DEFAULT_CFG,
    getCfg, saveCfg, base, login, request, ping, openStream, authHeaders, sha256Hex, hmacHex,
  };
})();

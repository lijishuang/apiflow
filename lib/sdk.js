// ── SDK → 工具注册表 operation ──
// 用「源码扫描」把现成的客户端 SDK 变成可给智能体用的接口清单：
//   · TypeScript / JavaScript（this.request('GET', `/orders/${id}`) / axios.get(...)）
//   · Python（self._request("GET", f"/orders/{id}") / requests.get(...) / FastAPI 装饰器）
//   · Java（Retrofit @GET("orders/{id}") / Spring @GetMapping / @RequestMapping）
//   · Go（http.NewRequest("GET", "/orders/"+id) / c.do("POST", ...)）
//   · 配置 JSON（{ operations: [...] } 或 OpenAPI）
// 目标不是做完整编译器，而是把「方法 + 路径 + 说明」这三样能驱动流程的信息稳定抽出来。
const crypto = require('crypto');
const { stableHash } = require('./openapi');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const uniq = a => [...new Set(a.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];

/* ───────── 路径归一化：各种语言里的拼接写法 → /orders/{orderNo} ───────── */

// 表达式里的变量名：this.orderNo / req.orderNo / order_no → 取最后一段
const paramName = raw => String(raw || '').trim()
  .replace(/^[^.\w$]+|[^.\w$]+$/g, '')
  .split(/[.$]/).filter(Boolean).pop() || 'param';

function normalizePath(raw, args = []) {
  let s = String(raw || '').trim();
  s = s.replace(/^[fFrRbB]{1,2}(?=[`'"])/, '');                    // Python 字符串前缀 f""
  // 表达式里套着函数调用（fmt.Sprintf("/x/%s", a)）→ 先取其中第一个字面量
  if (!/^[`'"]/.test(s)) {
    const lit = s.match(/[`'"]([^`'"]*)[`'"]/);
    if (lit) s = lit[1];
  }
  // 拆掉外层引号 / 反引号
  s = s.replace(/^[`'"]([\s\S]*)[`'"]$/, '$1');

  // 形如 "/orders/" + orderNo + "/items" 的拼接
  if (s.includes('+')) {
    s = s.split('+').map(part => {
      const t = part.trim();
      if (/^[`'"].*[`'"]$/.test(t)) return t.slice(1, -1);       // 字面量
      if (/^[`'"]/.test(t) || /[`'"]$/.test(t)) return t.replace(/^[`'"]|[`'"]$/g, '');
      return '{' + paramName(t) + '}';                            // 变量
    }).join('');
  }
  // 模板字符串 / f-string / Sprintf
  s = s.replace(/\$\{([^}]*)\}/g, (_, e) => '{' + paramName(e) + '}');
  let ai = 0;
  s = s.replace(/%[svdq]/g, () => {
    const nm = args[ai] ? paramName(args[ai++]) : 'param' + (ai + 1);
    return '{' + nm + '}';
  });
  // Express / Flask 风格 :id
  s = s.replace(/\/:([A-Za-z_][\w]*)/g, '/{$1}');
  // 去掉写死的服务地址前缀（baseUrl 单独存）
  s = s.replace(/^(?:this\.|self\.|c\.|client\.)?(?:base_?url|baseURL|BASE_URL|apiBase)\s*\+?/i, '');
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.replace(/^\$\{[^}]*\}/, '');                              // 开头残留的 ${baseUrl}
  s = s.replace(/([^:])\/{2,}/g, '$1/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/[`'"]/g, '');
  return s;
}

// 过滤明显的非路径（Map.get('/key') 之类）——避免把 SDK 里普通字符串当接口
function isPathLike(raw) {
  let s = String(raw || '').trim();
  if (!s) return false;
  s = s.replace(/^[fFrRbB]{1,2}(?=[`'"])/, '');
  if (!/^[`'"]/.test(s)) { const lit = s.match(/[`'"]([^`'"]*)[`'"]/); if (lit) s = lit[1]; }
  const bare = s.replace(/\$\{[^}]*\}/g, 'X').replace(/\{[^{}]*\}/g, 'X').replace(/%[svdq]/g, 'X');
  if (/[();]/.test(bare)) return false;
  if (/\s{2,}/.test(s)) return false;
  return /\//.test(s);
}

/* ───────── 注释 → 中文名 ───────── */
function cleanDoc(txt) {
  if (!txt) return '';
  let t = String(txt).replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  t = t.split('\n').map(l => l.replace(/^\s*(?:\*|\/\/|#|\/\*)\s?/, '').trim()).filter(Boolean)
    .filter(l => !/^@\w+/.test(l)).join('\n');
  return t.trim();
}
function commentBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 900), idx);
  // 紧贴在上方的块注释（从最后一个 */ 往前找对应的 /*，不能用贪婪正则，否则会吞掉文件头注释）
  const end = before.lastIndexOf('*/');
  // 注释与目标之间允许隔着声明关键字（export async function / const 等），否则 TS SDK 的 JSDoc 全部失效
  const tail = before.slice(end + 2).trim();
  if (end >= 0 && (!tail || /^(?:export\s+|default\s+|async\s+|function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+)+$/.test(tail))) {
    const start = before.lastIndexOf('/*', end);
    if (start >= 0) return cleanDoc(before.slice(start, end + 2));
  }
  // 行注释（// 或 #），连续若干行
  const lines = before.split('\n'), buf = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^(\/\/|#)/.test(l)) { buf.unshift(l); continue; }
    if (!l) { if (buf.length) break; continue; }
    break;
  }
  return cleanDoc(buf.join('\n'));
}
function humanize(name) {
  return String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
}

/* ───────── Python docstring：只取首行摘要，丢掉生成器塞进去的英文样板 ───────── */
function cleanPyDoc(txt) {
  const lines = String(txt || '').split(/\r?\n/).map(l => l.trim());
  for (const l of lines) {
    if (!l) continue;
    if (/^(>>>|:param|:return|:rtype|:raises|:\w+:)/.test(l)) continue;
    if (/^(This method makes|NOTE:|NOTE :|If the method is called)/i.test(l)) return '';
    return cleanDoc(l);
  }
  return '';
}
function pyDoc(text, defIdx) {
  const rest = text.slice(defIdx, defIdx + 900);
  const dm = rest.match(/"""([\s\S]*?)"""/) || rest.match(/'''([\s\S]*?)'''/);
  if (dm) return cleanPyDoc(dm[1]);
  return cleanDoc(commentBefore(text, defIdx));
}

/* ───────── 参数对象式接口声明（生成式 Python SDK） ─────────
   天翼云 ecloud-sdk / 火山引擎等生成器的写法：方法和路径不是一个「相邻参数对」，
   而是同一次调用里的两个关键字参数 —— CALLS.py 的调用点正则抓不到：
     params = ApiParams(action="describeInstances",
                        uri="/v4/list/describe-instances",
                        gateway_uri="/api/openapi-instance/v4/list/describe-instances",
                        protocol="http", method="POST", request=...)
   这里按「一次调用的参数块」解析，method + uri/gateway_uri 同时出现才算接口。 */
const PY_METHOD_KV = /["']?\bmethod["']?\s*[=:]\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/i;
const PY_GATEWAY_KV = /\bgateway_uri\s*[=:]\s*["']([^"']{2,300})["']/i;
const PY_PATH_KV = /["']?\b(?:uri|path|url|endpoint|api_path|context_path)\b["']?\s*[=:]\s*["']([^"']{2,300})["']/i;

// 从 '(' 的下一个字符开始，返回配对的参数块内容（跳过字符串与三引号）
function callBodyAt(text, from) {
  let depth = 1, i = from, q = null;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      const three = text.slice(i, i + 3);
      if (three === '"""' || three === "'''") {
        const end = text.indexOf(three, i + 3);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      q = ch;
    } else if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (!depth) return text.slice(from, i); }
    i++;
  }
  return null;
}

function parsePyParamBlocks(text, ctx) {
  const ops = [];
  const re = /(?:=\s*|return\s+)([A-Za-z_][\w.]*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const body = callBodyAt(text, m.index + m[0].length);
    if (!body || body.length > 4000) continue;
    const mm = body.match(PY_METHOD_KV);
    if (!mm) continue;
    const gm = body.match(PY_GATEWAY_KV);
    const pm = body.match(PY_PATH_KV);
    const raw = (gm && gm[1]) || (pm && pm[1]);       // 有网关路径时用网关路径（真实调用路径）
    if (!raw || !isPathLike(raw)) continue;
    const method = mm[1].toUpperCase();
    if (!METHODS.includes(method)) continue;
    const sig = nearest(text, m.index, /def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    // 生成器的「带配置」包装方法：describe_instances_with_config → describe_instances
    const fname = sig ? sig[1].replace(/_(?:with_config|with_http_info|with_config_async|async)$/, '') : '';
    const doc = sig ? pyDoc(text, sig.index) : '';
    ops.push(makeOp({
      id: fname || `op_${method.toLowerCase()}_${raw.replace(/[^\w]+/g, '_')}`,
      method, path: normalizePath(raw), version: ctx.version, baseUrl: ctx.baseUrl,
      sourceId: ctx.sourceId, description: doc, name: doc.split(/[。；;\n]/)[0],
    }));
  }
  return ops;
}

/* ───────── 通用：由「方法 + 路径 + 说明」造一条 operation ───────── */
function makeOp({ id, method, path, version, baseUrl, sourceId, description, keywords, name, bodyExample }) {
  const M = String(method || 'GET').toUpperCase();
  const p = normalizePath(path);
  const params = uniq([...p.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const firstLine = desc.split(/[。；;\n]/)[0];
  const opName = String(name || firstLine || humanize(id) || `${M} ${p}`).slice(0, 40);
  // 中文名的 2 字滑窗进 keywords：自然语言常说「查库存」，而接口名是「查询库存」，子串匹配靠滑窗兜住
  const cjkGrams = [];
  for (const src of [opName, firstLine]) {
    const zh = String(src).replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i + 2 <= zh.length; i++) cjkGrams.push(zh.slice(i, i + 2));
  }
  const kw = uniq([
    ...String(desc).split(/[，。；、,.;:：\s]+/).filter(w => w.length >= 2 && w.length <= 8),
    ...p.split('/').filter(Boolean),
    ...params,
    ...humanize(id).split(/\s+/),
    opName,
    ...cjkGrams,
  ]).slice(0, 30);
  const op = {
    id, name: opName, method: M, path: p,
    version: String(version || 'sdk'),
    readOnly: /^(GET|HEAD)$/.test(M),
    keywords: kw, params, description: desc,
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    sourceId: sourceId || null,
  };
  if (bodyExample && typeof bodyExample === 'object') {
    op.bodySchema = { type: 'object' };
    op.bodyExample = bodyExample;
  }
  op.hash = stableHash({ method: M, path: p, params: op.params, body: bodyExample || null });
  return op;
}

/* ───────── 各语言：调用点 → {method, pathExpr, idx} ───────── */
const CALLS = {
  ts: [
    { re: /\.(get|post|put|patch|delete|del|head)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*"|(?:'[^']*'|"[^"]*")\s*\+[^,)]{0,120})/gi, m: x => x[1], raw: x => x[2] },
    { re: /(?:request|_request|execute|call|send|invoke|fetch)\s*\(\s*(['"])([A-Za-z]+)\1\s*,\s*(`[^`]*`|'[^']*'|"[^"]*"|(?:'[^']*'|"[^"]*")\s*\+[^,)]{0,120})/g, m: x => x[2], raw: x => x[3] },
    { re: /\{[^{}]{0,240}?method\s*:\s*['"](\w+)['"][^{}]{0,240}?\}/g, m: x => x[1], raw: x => (x[0].match(/(?:url|path|endpoint)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/) || [])[1] },
    { re: /\{[^{}]{0,240}?(?:url|path|endpoint)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")[^{}]{0,240}?method\s*:\s*['"](\w+)['"][^{}]{0,240}?\}/g, m: x => x[2], raw: x => x[1] },
  ],
  py: [
    { re: /(?:self\.)?_?request\s*\(\s*['"](\w+)['"]\s*,\s*(f?['"][^'"]*['"]|[^,)]{0,120})/g, m: x => x[1], raw: x => x[2] },
    { re: /(?:requests|httpx|session|client)\.(get|post|put|patch|delete|head)\s*\(\s*(f?['"][^'"]*['"])/gi, m: x => x[1], raw: x => x[2] },
    { re: /@\w+\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi, m: x => x[1], raw: x => `'${x[2]}'` },
  ],
};

function nearest(text, idx, re) {
  const before = text.slice(0, idx);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m, last = null;
  while ((m = g.exec(before))) last = m;
  return last;
}

/* TS / JS */
function parseTs(text, ctx) {
  const ops = [];
  for (const c of CALLS.ts) {
    const re = new RegExp(c.re.source, c.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const method = String(c.m(m) || '').toUpperCase().replace(/^DEL$/, 'DELETE');   // axios.delete / .del()
      const raw = c.raw(m);
      if (!raw || !METHODS.includes(method) || !isPathLike(raw)) continue;
      const sig = nearest(text, m.index, /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\{/);
      const fname = sig ? sig[1] : '';
      if (!fname || /^(if|for|while|switch|catch|constructor|then|map|filter)$/.test(fname)) continue;
      const doc = commentBefore(text, sig.index) || commentBefore(text, m.index);
      const args = sig ? sig[2].split(',').map(a => a.split(/[:=]/)[0].trim()).filter(Boolean) : [];
      ops.push({ ...makeOp({
        id: fname, method, path: normalizePath(raw, args), version: ctx.version,
        baseUrl: ctx.baseUrl, sourceId: ctx.sourceId, description: doc, name: doc.split(/[。；;\n]/)[0],
        keywords: uniq([doc, fname, ...args]),
      }), _at: m.index });
    }
  }
  return ops;
}

/* Python */
function parsePy(text, ctx) {
  const ops = [];
  const decorated = [];        // 装饰器风格（FastAPI / Flask）已在调用点里覆盖，这里补函数名与说明
  for (const c of CALLS.py) {
    const re = new RegExp(c.re.source, c.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const method = String(c.m(m) || '').toUpperCase();
      if (!METHODS.includes(method) || !isPathLike(c.raw(m))) continue;
      const sig = nearest(text, m.index, /def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
      const fname = sig ? sig[1] : '';
      // docstring：def 行下方三引号第一行
      const doc = sig ? pyDoc(text, sig.index) : '';
      const args = sig ? sig[2].split(',').map(a => a.split(/[:=]/)[0].trim()).filter(a => a && a !== 'self') : [];
      ops.push(makeOp({
        id: fname || `op_${method.toLowerCase()}`, method, path: normalizePath(c.raw(m), args),
        version: ctx.version, baseUrl: ctx.baseUrl, sourceId: ctx.sourceId,
        description: doc, name: doc.split(/[。；;\n]/)[0],
      }));
    }
  }
  ops.push(...parsePyParamBlocks(text, ctx));   // 生成式 SDK：method/uri 写在参数对象里
  return ops;
}

/* Java（Retrofit / Spring） */
function parseJava(text, ctx) {
  const ops = [];
  const re = /@(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)|@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text))) {
    let method = '', raw = '';
    if (m[1]) { method = m[1]; raw = m[2]; }
    else {
      const body = m[4] || '';
      const pm = body.match(/(?:value|path)\s*=\s*["']([^"']+)["']/);
      const mm = body.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/);
      raw = pm ? pm[1] : '';
      method = mm ? mm[1] : (/^Get/i.test(m[3]) ? 'GET' : /^Post/i.test(m[3]) ? 'POST' : /^Put/i.test(m[3]) ? 'PUT' : /^Patch/i.test(m[3]) ? 'PATCH' : /^Delete/i.test(m[3]) ? 'DELETE' : '');
      if (!method && /^Request/.test(m[3])) method = 'POST';
    }
    if (!raw || !METHODS.includes(String(method).toUpperCase())) continue;
    // 注解之后的方法签名
    const after = text.slice(m.index, m.index + 600);
    const fm = after.match(/\b([A-Za-z_]\w*)\s*\((?:\s*@[^)]*\)[^,)]*,?\s*)*\)?\s*;/) ||
      after.match(/\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*[;{]/);
    const fname = fm ? fm[1] : '';
    const doc = commentBefore(text, m.index);
    ops.push(makeOp({
      id: fname || `op_${String(method).toLowerCase()}_${raw.replace(/[^\w]+/g, '_')}`,
      method, path: normalizePath(raw), version: ctx.version, baseUrl: ctx.baseUrl,
      sourceId: ctx.sourceId, description: doc, name: doc.split(/[。；;\n]/)[0],
    }));
  }
  return ops;
}

/* Go */
function parseGo(text, ctx) {
  const ops = [];
  const re = /NewRequest(?:WithContext)?\s*\(\s*(?:ctx\s*,\s*)?["'](GET|POST|PUT|PATCH|DELETE|HEAD)["']\s*,\s*([^,]{0,160})|\.(?:do|request|call|send)\s*\(\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD)["']\s*,\s*([^,)]{0,160})/g;
  let m;
  while ((m = re.exec(text))) {
    const method = m[1] || m[4];
    const raw = (m[2] || m[5] || '').trim();
    if (!isPathLike(raw)) continue;
    const sig = nearest(text, m.index, /func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    const fname = sig ? sig[1] : '';
    if (!fname || /^(New|Must|Do|main)$/.test(fname)) continue;
    const doc = cleanDoc(commentBefore(text, sig.index))
      .replace(new RegExp('^' + fname + '\\b[:：\\s-]*'), '').trim();
    const args = sig ? sig[2].split(',').map(a => a.split(/\s+/)[0]).filter(a => a && a !== 'ctx') : [];
    ops.push(makeOp({
      id: fname, method, path: normalizePath(raw, args), version: ctx.version,
      baseUrl: ctx.baseUrl, sourceId: ctx.sourceId, description: doc,
      name: doc.split(/[。；;\n]/)[0],
    }));
  }
  return ops;
}

/* 配置 JSON：{ operations: [...] }（也接受 { paths: {} } 交给 OpenAPI 解析器） */
function parseConfig(obj, ctx) {
  const ops = (obj.operations || obj.apis || obj.endpoints || []).map((o, i) => {
    const method = String(o.method || o.httpMethod || 'GET').toUpperCase();
    const raw = o.path || o.url || o.endpoint || '';
    const op = makeOp({
      id: String(o.id || o.operationId || o.name || `op_${i}`).replace(/[^\w.-]+/g, '_'),
      name: o.name || o.summary, method, path: raw, version: o.version || ctx.version,
      baseUrl: o.baseUrl || ctx.baseUrl, sourceId: ctx.sourceId,
      description: o.description || o.summary || '', bodyExample: o.bodyExample || o.body,
    });
    if (Array.isArray(o.keywords) && o.keywords.length) op.keywords = uniq([...o.keywords, ...op.keywords]).slice(0, 14);
    if (o.readOnly !== undefined) op.readOnly = !!o.readOnly;
    return op;
  });
  return ops;
}

/* ───────── 入口 ───────── */
const FORMAT_BY_EXT = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', kt: 'java', go: 'go', json: 'config', yml: 'config', yaml: 'config',
};
const LANG_NAME = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', go: 'Go', config: '配置 JSON' };

function detectFormat(name, text) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (FORMAT_BY_EXT[ext]) return FORMAT_BY_EXT[ext];
  const t = String(text || '');
  if (/^\s*[\[{]/.test(t)) return 'config';
  if (/^\s*(?:package|import)\s+[\w.]+\s*;?/m.test(t) && /\bclass\b|\binterface\b/.test(t)) return 'java';
  if (/^\s*package\s+\w+/m.test(t) || /func\s+\(?\w*\s*\*?\w+\)?\s*\w+\(/.test(t)) return 'go';
  if (/^\s*(?:def|class)\s+\w+/m.test(t)) return 'python';
  return 'typescript';
}

function parseSDK(files, opts = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(f => f && typeof f.text === 'string' && f.text.trim());
  if (!list.length) throw new Error('没有可解析的 SDK 内容');
  const ctx = {
    sourceId: opts.sourceId || null,
    baseUrl: String(opts.baseUrl || '').replace(/\/+$/, ''),
    version: opts.version || null,
  };
  const notes = [];
  let ops = [];
  let format = null, version = ctx.version, baseUrl = ctx.baseUrl, title = opts.name || '';

  for (const f of list) {
    const fmt = f.format || detectFormat(f.name, f.text);
    if (!format) format = fmt; else if (format !== fmt) format = 'mixed';
    if (fmt === 'config') {
      let obj;
      try { obj = JSON.parse(f.text); } catch { notes.push(`${f.name}：不是合法 JSON，已跳过`); continue; }
      if (obj.paths) throw new Error(`${f.name} 是 OpenAPI 文档，请用「接入 OpenAPI 地址 / 粘贴文档」`);
      baseUrl = baseUrl || String(obj.baseUrl || obj.server || '').replace(/\/+$/, '');
      version = version || obj.version || obj.sdkVersion;
      title = title || obj.sdk || obj.title || obj.name || '';
      ops = ops.concat(parseConfig(obj, { ...ctx, baseUrl, version }));
    } else if (fmt === 'python') ops = ops.concat(parsePy(f.text, { ...ctx, baseUrl, version }));
    else if (fmt === 'java') ops = ops.concat(parseJava(f.text, { ...ctx, baseUrl, version }));
    else if (fmt === 'go') ops = ops.concat(parseGo(f.text, { ...ctx, baseUrl, version }));
    else ops = ops.concat(parseTs(f.text, { ...ctx, baseUrl, version }));

    // 从源码里找服务地址 / 版本号（配置 JSON 已给则优先）
    if (!baseUrl) {
      // 兼容带类型注解的常量：DEFAULT_API_BASE: str = "https://api.stripe.com"
      const bm = f.text.match(/(?:BASE_URL|BASEURL|baseURL|baseUrl|API_BASE|apiBaseUrl|base_url|DEFAULT_API_BASE|API_URL|DEFAULT_HOST|API_HOST|SERVER_URL|ENDPOINT)\s*(?::\s*[\w[\]. ]{1,40})?[:=]\s*['"]([^'"]{4,200})['"]/);
      if (bm) baseUrl = bm[1].replace(/\/+$/, '');
      else {
        // 区域化 endpoint（天翼云 Region(endpoint='https://api-xxx.cmecloud.cn:8443')）：多区域取第一个并提示改写
        const eps = [...new Set([...f.text.matchAll(/\bendpoint\s*[=:]\s*['"](https?:\/\/[^'"]{4,200})['"]/gi)].map(x => x[1]))];
        if (eps.length) {
          baseUrl = eps[0].replace(/\/+$/, '');
          if (eps.length > 1) notes.push(`源码里有 ${eps.length} 个区域 endpoint，默认取第一个（${baseUrl}），请按实际区域改写服务地址`);
        }
      }
    }
    if (!version) {
      // 优先取 SDK 自身版本（SDK_VERSION / __version__），否则 PRODUCT_VERSION="v1" 这类字段会先抢占
      const strong = f.text.match(/(?:__version__|SDK_VERSION|sdk_version|sdkVersion)\s*(?::\s*[\w[\]. ]{1,20})?[:=]\s*['"]v?([0-9][\w.-]*)['"]/)
        || f.text.match(/@version\s+v?([0-9][\w.-]*)/);
      const vm = strong || f.text.match(/(?:@version|VERSION|version)\s*(?::\s*[\w[\]. ]{1,20})?[:=]\s*['"]v?([0-9][\w.-]*)['"]/);
      if (vm) version = vm[1];
    }
  }

  // 按源码出现顺序还原（多组正则分别扫描会打乱顺序），并去掉内部排序标记
  ops = ops.map((o, i) => ({ o, i }))
    .sort((a, b) => ((a.o._at ?? 1e9) - (b.o._at ?? 1e9)) || (a.i - b.i))
    .map(x => { const { _at, ...rest } = x.o; return rest; });

  // 去重：同一 method+path 只留第一条（多语言 SDK 常重复描述同一接口）
  const seen = new Set(), kept = [];
  for (const o of ops) {
    const k = o.method + ' ' + o.path;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(o);
  }
  // id 冲突加后缀，避免覆盖来源内已有接口
  const ids = new Set();
  for (const o of kept) {
    let id = o.id, n = 2;
    while (ids.has(id)) id = `${o.id}_${n++}`;
    if (id !== o.id) o.id = id;
    ids.add(id);
  }
  // 没有业务接口不等于没价值：基础库 / 框架包（client 封装、鉴权、重试、序列化）本来就没有
  // 业务路径，但里面的类和方法正是智能体搭流程要查的资料。是否允许「仅资料导入」由上层按
  // 符号规模决定（见 /api/sdk/archive 与 POST /api/sources）。
  const digest = crypto.createHash('sha1')
    .update(list.map(f => f.name + ':' + f.text).join('\n')).digest('hex');
  return {
    format: format || 'config',
    formatName: format === 'mixed' ? '多语言混合' : (LANG_NAME[format] || 'SDK'),
    title: String(title || opts.name || 'SDK 导入').slice(0, 40),
    version: String(version || 'sdk').slice(0, 24),
    baseUrl,
    operations: kept,
    symbolOnly: kept.length === 0,
    digest,
    notes,
    files: list.map(f => ({ name: f.name, bytes: Buffer.byteLength(f.text) })),
  };
}

module.exports = { parseSDK, normalizePath, detectFormat, LANG_NAME };

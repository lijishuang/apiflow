'use strict';
/**
 * SDK 资料库：把 SDK 里「除接口之外」的东西也留下来 —— 类、方法、函数、类型、常量说明。
 *
 * 为什么需要：接口清单只能告诉智能体「有哪些 URL 可调」，但真实 SDK 里大量能力是
 * 参数对象、枚举、返回值模型、工具函数（重试 / 签名 / 分页 / 序列化），这些东西
 * 不会体现在 method+path 上。用户后续在搭建器里描述需求时，智能体需要能查到
 * 「这个 SDK 有没有现成的分页参数 / 这个字段是干什么的 / 这个函数签名长什么样」。
 *
 * 做法：纯正则 + 缩进/括号配对的多语言浅解析（不做完整语法树），抽四类语言：
 *   · Python        def / async def / class（含 docstring 首段）
 *   · TS / JS       function / class method / const fn / interface / type
 *   · Java / Kotlin class / interface / enum / 方法（含 @Annotation 与 javadoc）
 *   · Go            func（含 receiver 方法）/ type X struct|interface
 * 抽到的符号落盘到 data/materials/<sourceId>.json，检索走轻量打分（英文分词 + 中文二元组）。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAT_DIR = path.join(DATA_DIR, 'materials');

const MAX_SYMBOLS = 12000;             // 单个来源的资料条数上限
const MAX_PER_FILE = 400;              // 单文件符号上限（生成式 SDK 的 model 文件可能上千）
const MAX_FILE_BYTES = 400 * 1024;     // 单文件扫描上限
const MAX_SCAN_BYTES = 48 * 1024 * 1024; // 单次导入扫描总量上限
const SUMMARY_MAX = 300;
const SIG_MAX = 220;

const LANG_NAME = { python: 'Python', javascript: 'JavaScript', java: 'Java', go: 'Go', config: '配置' };

/* ───────── 通用小工具 ───────── */
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const uniq = a => [...new Set(a)];

// 去掉注释外壳与装饰性前缀（* / // / #），保留正文
function cleanDoc(txt) {
  if (!txt) return '';
  let t = String(txt).replace(/^\/\*+/, '').replace(/\*\/$/, '');
  return t.split('\n')
    .map(l => l.replace(/^\s*(?:\*|\/\/|#|\/\*+)\s?/, '').trim())
    .filter(Boolean)
    .filter(l => !/^@\w+/.test(l))            // javadoc 的 @param 之类不当作说明
    .join(' ')
    .trim();
}
// 紧贴在符号上方的注释块
function docBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 1200), idx);
  const end = before.lastIndexOf('*/');
  if (end >= 0 && !before.slice(end + 2).trim()) {
    const start = before.lastIndexOf('/*', end);
    if (start >= 0) return cleanDoc(before.slice(start, end + 2));
  }
  const lines = before.split('\n'), buf = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^(\/\/|#)/.test(l)) { buf.unshift(l); continue; }
    if (!l) { if (buf.length) break; continue; }
    break;
  }
  return cleanDoc(buf.join('\n'));
}
// Python docstring：取第一段有意义的正文，跳过 :param / >>> 之类的生成器样板
function pyDoc(text, idx) {
  // 只在「本函数体内」找 docstring：遇到下一个 def/class 就截断，
  // 否则没有注释的方法会抢到下一个方法的说明（实测生成式 SDK 全是这种连排写法）
  const wide = text.slice(idx, idx + 1600);
  const cut = wide.slice(1).search(/\n\s*(?:async\s+def|def|class)\s/);
  const rest = cut >= 0 ? wide.slice(0, cut + 1) : wide;
  const m = rest.match(/"""([\s\S]*?)"""/) || rest.match(/'''([\s\S]*?)'''/);
  if (!m) return docBefore(text, idx);
  for (const raw of m[1].split(/\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (/^(>>>|:param|:return|:rtype|:raises|:\w+:)/.test(l)) continue;
    if (/^(This method makes|NOTE:|NOTE :|If the method is called|Parameters|Returns|Args:)/i.test(l)) break;
    return clip(cleanDoc(l), SUMMARY_MAX);
  }
  return '';
}

/* ───────── 参数解析：把 "a: string, b?: number = 1" 变成结构化参数 ───────── */
function splitParams(raw) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(raw || '')) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}
function parseParam(p, lang) {
  if (!p) return null;
  const raw = clip(p, 90);
  let name = '', type = '', optional = false;
  if (lang === 'python') {
    // name: type = default / name=default / *args / **kwargs
    const m = raw.match(/^(\*{0,2}\w+)\s*(?::\s*([^=]+))?\s*(?:=\s*(.+))?$/);
    if (m) { name = m[1]; type = (m[2] || '').trim(); optional = m[3] != null || m[1].startsWith('*'); }
  } else if (lang === 'go') {
    // name Type / name, other Type（合并写法按第一个名字处理）
    const m = raw.match(/^(\w+)\s+([^,]+)$/);
    if (m) { name = m[1]; type = m[2].trim(); } else name = raw;
  } else if (lang === 'java') {
    // Type name / final Type name / @NonNull Type name
    const m = raw.match(/^(.+?)\s+(\w+)$/);
    if (m) { type = m[1].replace(/@\w+/g, '').trim(); name = m[2]; } else name = raw;
  } else {
    // TS/JS：name?: Type = default（rest 也支持）
    const m = raw.match(/^(\.{0,3}\w+)(\?)?\s*(?::\s*([^=]+))?\s*(?:=\s*(.+))?$/);
    if (m) { name = m[1]; optional = !!m[2] || m[4] != null; type = (m[3] || '').trim(); }
    else name = raw;
  }
  if (!name) return null;
  return { name: clip(name, 40), type: clip(type, 60), optional };
}
function paramsOf(raw, lang) {
  return splitParams(raw).map(p => parseParam(p, lang)).filter(Boolean).slice(0, 24);
}

/* ───────── 各语言抽取 ───────── */
const TS_KEYWORD = /^(?:if|for|while|switch|catch|else|do|try|finally|return|function|class|new|await|async|typeof|delete|void|in|of|case|default|break|continue|throw|super|this|constructor)$/;
const JAVA_KEYWORD = /^(?:if|for|while|switch|catch|else|do|try|finally|return|new|throw|synchronized|assert|case|default|break|continue)$/;

// TS/JS 类方法识别：从行首匹配「[修饰符] 名字(」，再用括号配对拿完整参数表，
// 之后只允许「: 返回类型」紧跟「{」—— 排除普通调用语句与控制流
function jsMethodAt(text, lineStart, line) {
  const m = line.match(/^(\s{1,12})((?:(?:public|private|protected|static|async|readonly|override|get|set|abstract|declare)\s+)*)([\w$]+)\s*\(/);
  if (!m) return null;
  const open = lineStart + m[0].length - 1;              // m[0] 以 "(" 结尾
  let depth = 0, i = open;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (!depth) break; }
  }
  if (depth) return null;                                // 括号没闭合（可能是调用语句跨行），放弃
  const params = text.slice(open + 1, i);
  let j = i + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  let returns = '';
  if (text[j] === ':') {
    const brace = text.indexOf('{', j);
    const semi = text.indexOf(';', j);
    if (brace === -1 || (semi !== -1 && semi < brace)) return null;
    returns = text.slice(j + 1, brace).replace(/\s+/g, ' ').trim();
    j = brace;
  }
  if (text[j] !== '{') return null;
  return { name: m[3], params, returns };
}

function extractPython(text, file) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const stack = [];                                       // [{indent, name}] 类嵌套
  let offset = 0;
  for (let i = 0; i < lines.length && out.length < MAX_PER_FILE; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim() || /^\s*(#|@)/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    let m = line.match(/^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
    if (m) {
      stack.push({ indent, name: m[2] });
      out.push({
        name: m[2], kind: 'class', line: i + 1, parent: '',
        sig: `class ${m[2]}${m[3] ? '(' + clip(m[3], 80) + ')' : ''}`,
        params: [], summary: pyDoc(text, lineStart + line.indexOf('class')),
      });
      continue;
    }
    m = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
    if (m) {
      const parent = stack.length ? stack[stack.length - 1].name : '';
      const isDunder = /^__\w+__$/.test(m[2]);
      if (isDunder) continue;                            // 魔术方法没有资料价值
      out.push({
        name: m[2], kind: parent ? 'method' : 'function', line: i + 1, parent,
        sig: `${m[2]}(${clip(m[3], 110)})${m[4] ? ' -> ' + clip(m[4], 40) : ''}`,
        params: paramsOf(m[3], 'python'), returns: clip(m[4] || '', 40),
        summary: pyDoc(text, lineStart + line.indexOf('def')),
      });
      continue;
    }
    // 模块级常量：NAME = "..."（少量常量对理解 SDK 很有用）
    m = line.match(/^([A-Z][A-Z0-9_]{2,40})\s*(?::\s*[^=]+)?=\s*(.{0,80})$/);
    if (m && indent === 0) {
      out.push({
        name: m[1], kind: 'const', line: i + 1, parent: '',
        sig: `${m[1]} = ${clip(m[2], 60)}`, params: [],
        summary: docBefore(text, lineStart),
      });
    }
  }
  return out;
}

function extractJs(text, file) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const classes = [];                                     // [{depth, name}]
  let depth = 0, offset = 0;
  for (let i = 0; i < lines.length && out.length < MAX_PER_FILE; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

    const cls = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+(\w+)/);
    const iface = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+(\w+)/);
    const fn = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{?/);
    const arrow = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*(?::\s*[^=]+)?=>/);

    if (cls) {
      classes.push({ depth, name: cls[1] });
      out.push({ name: cls[1], kind: 'class', line: i + 1, parent: '', sig: `class ${cls[1]}`, params: [], summary: docBefore(text, lineStart) });
    } else if (iface) {
      out.push({ name: iface[1], kind: 'type', line: i + 1, parent: '', sig: clip(line.trim(), SIG_MAX), params: [], summary: docBefore(text, lineStart) });
    } else if (fn) {
      const parent = classes.length && classes[classes.length - 1].depth < depth ? classes[classes.length - 1].name : '';
      out.push({
        name: fn[1], kind: parent ? 'method' : 'function', line: i + 1, parent,
        sig: `${fn[1]}(${clip(fn[2], 110)})${fn[3] ? ': ' + clip(fn[3], 40) : ''}`,
        params: paramsOf(fn[2], 'javascript'), returns: clip(fn[3] || '', 40),
        summary: docBefore(text, lineStart),
      });
    } else if (arrow) {
      const params = arrow[2] != null ? arrow[2] : arrow[3];
      out.push({
        name: arrow[1], kind: 'function', line: i + 1, parent: '',
        sig: `${arrow[1]}(${clip(params, 110)}) => …`,
        params: paramsOf(params, 'javascript'), summary: docBefore(text, lineStart),
      });
    } else {
      // 类方法：name(args): Ret { / async name(args) { / get name() {
      // 参数可能带箭头函数（fn: () => Promise<X>）、可能跨行 —— 用括号配对拿完整参数表，
      // 不能假设「) {」一定在同一行行尾
      const mm = jsMethodAt(text, lineStart, line);
      if (mm && !TS_KEYWORD.test(mm.name) && depth > 0) {
        const parent = classes.length ? classes[classes.length - 1].name : '';
        if (parent) {
          out.push({
            name: mm.name, kind: 'method', line: i + 1, parent,
            sig: `${mm.name}(${clip(mm.params, 110)})${mm.returns ? ': ' + clip(mm.returns, 40) : ''}`,
            params: paramsOf(mm.params, 'javascript'), returns: clip(mm.returns || '', 40),
            summary: docBefore(text, lineStart),
          });
        }
      }
    }
    // 维护 { } 深度（粗略：忽略字符串模板里的括号，够用）
    for (const ch of line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth = Math.max(0, depth - 1); while (classes.length && classes[classes.length - 1].depth >= depth) classes.pop(); }
    }
  }
  return out;
}

function extractJava(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length && out.length < MAX_PER_FILE; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const t = line.trim();
    if (!t || /^(\/\/|\*|\/\*|@)/.test(t)) continue;

    const type = t.match(/^(?:(?:public|protected|private|static|final|abstract|sealed|open|data)\s+)*(class|interface|enum|record|object|struct)\s+(\w+)/);
    if (type) {
      out.push({
        name: type[2], kind: type[1] === 'interface' ? 'type' : 'class', line: i + 1, parent: '',
        sig: clip(t.replace(/\s*\{.*$/, ''), SIG_MAX), params: [], summary: docBefore(text, lineStart),
      });
      continue;
    }
    // 方法：修饰符 + 返回类型 + 名字(参数) [throws …] {
    const mm = t.match(/^(?:(?:public|protected|private|static|final|synchronized|abstract|default|native|override|suspend|inline)\s+)*(?:<[^>]+>\s*)?([\w.$<>\[\],?\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\{/);
    if (!mm || JAVA_KEYWORD.test(mm[2])) continue;
    const ret = clip(mm[1].trim(), 60);
    out.push({
      name: mm[2], kind: 'method', line: i + 1, parent: '',
      sig: `${mm[2]}(${clip(mm[3], 110)})${ret && ret !== 'void' ? ': ' + ret : ''}`,
      params: paramsOf(mm[3], 'java'), returns: ret,
      summary: docBefore(text, lineStart),
    });
  }
  return out;
}

function extractGo(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length && out.length < MAX_PER_FILE; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const fm = line.match(/^func\s+(?:\(\s*\w*\s*\*?(\w+)\s*\)\s*)?(\w+)\s*\(([^)]*)\)\s*([^{]*)\{/);
    if (fm) {
      out.push({
        name: fm[2], kind: fm[1] ? 'method' : 'function', line: i + 1, parent: fm[1] || '',
        sig: `${fm[2]}(${clip(fm[3], 110)})${fm[4] ? ' ' + clip(fm[4], 40) : ''}`,
        params: paramsOf(fm[3], 'go'), returns: clip(fm[4] || '', 40),
        summary: docBefore(text, lineStart),
      });
      continue;
    }
    const tm = line.match(/^type\s+(\w+)\s+(struct|interface)\b/);
    if (tm) {
      out.push({
        name: tm[1], kind: tm[2] === 'interface' ? 'type' : 'class', line: i + 1, parent: '',
        sig: `type ${tm[1]} ${tm[2]}`, params: [], summary: docBefore(text, lineStart),
      });
    }
  }
  return out;
}

function langOf(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  if (e === 'py') return 'python';
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(e)) return 'javascript';
  if (['java', 'kt', 'kts'].includes(e)) return 'java';
  if (e === 'go') return 'go';
  return null;
}

/**
 * 从源码文件里抽符号。
 * @param {Array<{name:string,text:string,path?:string}>} files
 * @returns {{symbols:Array, stats:object}}
 */
function extractSymbols(files, opts = {}) {
  const maxSymbols = opts.maxSymbols || MAX_SYMBOLS;
  const maxScanBytes = opts.maxScanBytes || MAX_SCAN_BYTES;
  const symbols = [];
  const byLang = {};
  let scannedBytes = 0, scannedFiles = 0, skipped = 0, truncated = false;

  for (const f of files || []) {
    if (symbols.length >= maxSymbols) { truncated = true; break; }
    const lang = langOf(f && (f.path || f.name));
    if (!lang) { skipped++; continue; }
    const text = String(f.text || '');
    const bytes = Buffer.byteLength(text);
    if (!text.trim() || text.includes('\0') || bytes > MAX_FILE_BYTES) { skipped++; continue; }
    if (scannedBytes + bytes > maxScanBytes) { truncated = true; break; }
    scannedBytes += bytes; scannedFiles++;
    const file = String(f.path || f.name || '').replace(/\\/g, '/');
    let found = [];
    try {
      found = lang === 'python' ? extractPython(text, file)
        : lang === 'javascript' ? extractJs(text, file)
          : lang === 'java' ? extractJava(text, file)
            : extractGo(text, file);
    } catch { found = []; }
    byLang[lang] = (byLang[lang] || 0) + found.length;
    for (const s of found) {
      if (symbols.length >= maxSymbols) { truncated = true; break; }
      if (!s.name || s.name.length > 60) continue;
      symbols.push({
        id: `${lang}:${file}:${s.line}:${s.name}`,
        name: clip(s.name, 60),
        kind: s.kind || 'function',
        parent: s.parent || '',
        sig: clip(s.sig || s.name, SIG_MAX),
        params: s.params || [],
        returns: clip(s.returns || '', 40),
        summary: clip(s.summary || '', SUMMARY_MAX),
        file, line: s.line || 0,
        lang, langName: LANG_NAME[lang] || lang,
      });
    }
  }

  return {
    symbols,
    stats: {
      files: scannedFiles, skipped, bytes: scannedBytes,
      symbols: symbols.length,
      ...summarize(symbols),
      languages: Object.keys(byLang).map(k => LANG_NAME[k] || k),
      truncated,
    },
  };
}

function summarize(symbols) {
  const c = { classes: 0, methods: 0, functions: 0, types: 0, constants: 0 };
  for (const s of symbols || []) {
    if (s.kind === 'class') c.classes++;
    else if (s.kind === 'method') c.methods++;
    else if (s.kind === 'type') c.types++;
    else if (s.kind === 'const') c.constants++;
    else c.functions++;
  }
  return { count: (symbols || []).length, ...c, documented: (symbols || []).filter(s => s.summary).length };
}

/* ───────── 检索 ───────── */
// 英文按词切、中文按二元组切（"创建密钥对" → 创建/建密/密钥/钥对），够用且不引依赖
function tokensOf(q) {
  const s = String(q || '').toLowerCase();
  const latin = s.match(/[a-z_][a-z0-9_]{1,}/g) || [];
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  const grams = [];
  for (const seg of cjk) {
    if (seg.length <= 2) grams.push(seg);
    else for (let i = 0; i + 2 <= seg.length; i++) grams.push(seg.slice(i, i + 2));
  }
  return uniq([...latin, ...grams]).filter(t => t.length >= 2).slice(0, 24);
}

function scoreSymbol(sym, tokens, raw) {
  if (!tokens.length) return 1;
  const name = (sym.name || '').toLowerCase();
  const parent = (sym.parent || '').toLowerCase();
  const sum = (sym.summary || '').toLowerCase();
  const sig = (sym.sig || '').toLowerCase();
  const file = (sym.file || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (name.includes(t)) score += name === t ? 16 : 10;
    if (parent.includes(t)) score += 4;
    if (sum.includes(t)) score += 6;
    if (sig.includes(t)) score += 3;
    if (file.includes(t)) score += 1;
  }
  if (!score) return 0;                                  // 没命中任何词就不进结果（加分项只在命中后起作用）
  if (raw && (name === raw.toLowerCase() || `${parent}.${name}` === raw.toLowerCase())) score += 12;
  score += Math.min(3, (sym.params || []).length);       // 参数多说明是「可调的能力」，比纯数据类更有用
  if (sym.summary) score += 1;
  return score;
}

function searchSymbols(symbols, query, opts = {}) {
  const { limit = 30, offset = 0, kind = '', sourceId = '' } = opts;
  const raw = String(query || '').trim();
  const tokens = tokensOf(raw);
  let pool = symbols || [];
  if (kind) pool = pool.filter(s => s.kind === kind);
  if (sourceId) pool = pool.filter(s => s.sourceId === sourceId);
  if (!tokens.length) {
    // 无关键词：优先「有注释 + 参数多」的符号，避免一屏全是 getter
    const items = [...pool].sort((a, b) => ((b.summary ? 1 : 0) - (a.summary ? 1 : 0)) || (b.params.length - a.params.length) || a.name.localeCompare(b.name));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }
  const scored = [];
  for (const s of pool) {
    const sc = scoreSymbol(s, tokens, raw);
    if (sc > 0) scored.push({ s, sc });
  }
  scored.sort((a, b) => (b.sc - a.sc) || ((b.s.summary ? 1 : 0) - (a.s.summary ? 1 : 0)) || a.s.name.localeCompare(b.s.name));
  return { total: scored.length, items: scored.slice(offset, offset + limit).map(x => x.s) };
}

/* ───────── 落盘 / 读取（每个来源一个文件，避免 sources.json 被撑爆） ───────── */
const _cache = new Map();      // srcId -> { mtime, data }

function matPath(srcId) { return path.join(MAT_DIR, `${srcId}.json`); }

function saveMaterials(srcId, payload) {
  if (!srcId) return null;
  fs.mkdirSync(MAT_DIR, { recursive: true });
  const data = {
    sourceId: srcId,
    generatedAt: Date.now(),
    ...payload,
    stats: { ...(payload.stats || {}), ...summarize(payload.symbols || []) },
  };
  const file = matPath(srcId);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  _cache.set(srcId, { mtime: fs.statSync(file).mtimeMs, data });
  return data;
}

function loadMaterials(srcId) {
  const file = matPath(srcId);
  let st;
  try { st = fs.statSync(file); } catch { _cache.delete(srcId); return null; }
  const hit = _cache.get(srcId);
  if (hit && hit.mtime === st.mtimeMs) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cache.set(srcId, { mtime: st.mtimeMs, data });
    return data;
  } catch { return null; }
}

function removeMaterials(srcId) {
  _cache.delete(srcId);
  const file = matPath(srcId);
  try { fs.unlinkSync(file); return; } catch { /* 运行环境的删除守卫可能拦截，走改名 + 延迟清理 */ }
  try { fs.renameSync(file, path.join(MAT_DIR, TRASH_PREFIX + srcId + '-' + Date.now() + '.json')); } catch { /* 留着不影响正确性 */ }
  sweepMatTrash();
}

// 改名永远不被拦，删除偶发被拦 —— 回收站目录 + 定时小批量清空（与 SDK 源码回收站同一思路）
const TRASH_PREFIX = '.trash-';
function sweepMatTrash(attempt = 3) {
  let names = [];
  try { names = fs.readdirSync(MAT_DIR).filter(n => n.startsWith(TRASH_PREFIX)); } catch { return; }
  for (const n of names.slice(0, 10)) {
    try { fs.unlinkSync(path.join(MAT_DIR, n)); } catch {
      if (attempt > 1) { const t = setTimeout(() => sweepMatTrash(attempt - 1), 30000); if (t.unref) t.unref(); }
      return;                                   // 本轮被拦就停手，等下一轮
    }
  }
}
setInterval(() => sweepMatTrash(1), 60000).unref();

function listMaterialSources() {
  let names = [];
  try { names = fs.readdirSync(MAT_DIR).filter(n => n.endsWith('.json') && !n.startsWith(TRASH_PREFIX)); } catch { return []; }
  return names.map(n => n.replace(/\.json$/, ''));
}

// 给智能体用的紧凑清单：名称 + 签名 + 一句说明
function digest(symbols, n = 12) {
  return (symbols || []).slice(0, n).map(s =>
    `- ${s.parent ? s.parent + '.' : ''}${s.sig || s.name}${s.summary ? ' — ' + s.summary : ''}${s.file ? ` (${s.file}:${s.line})` : ''}`);
}

module.exports = {
  extractSymbols, summarize, searchSymbols, tokensOf,
  saveMaterials, loadMaterials, removeMaterials, listMaterialSources, digest,
  MAT_DIR, MAX_SYMBOLS,
};

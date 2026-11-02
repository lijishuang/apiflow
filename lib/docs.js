'use strict';
/**
 * 帮助手册库：把「公网帮助文档」接进来，给搭建器的自然语言解析当依据。
 *
 * 为什么需要：接口清单只说明「有哪些 URL 可调」，但用户描述需求时用的是业务话术
 * （「把这周的告警巡检一遍，异常的发我」）。公网帮助手册里通常写着：
 *   · 同一能力的另一种叫法（标准说法 / 控制台叫法 / 英文方法名）
 *   · 参数含义、取值范围
 *   · 接口之间的先后关系（「先调 A 拿到 ID，再调 B」）
 * 把手册切块入库后，搭建器每次解析都能：① 引用相关章节给用户看；② 依据手册补全
 * 一句话里没说全的接口（「查一下告警趋势」→ 手册里那句「查询近7天告警趋势」）。
 *
 * 输入方式（都在「接口」页）：
 *   · URL 抓取：同一手册站点会顺着目录链接抓取多页（默认 12 页，20s 预算）
 *   · 导入文档：.md / .txt / .html / .pdf / .docx / .doc(RTF) / .json
 *   · 粘贴正文：JS 渲染的页面抓不到正文时用这个
 *
 * 存储：data/docs.json（元数据索引）+ data/docs/<id>.json（分块正文），与 SDK 资料分开，
 * 检索走「中文二元组 + 英文分词」的轻量打分，不引第三方依赖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const match = require('./match');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOC_DIR = path.join(DATA_DIR, 'docs');
const INDEX = path.join(DATA_DIR, 'docs.json');
const TRASH_PREFIX = '.trash-';

const MAX_DOC_CHARS = 1_500_000;      // 单篇手册正文上限
const MAX_CHUNKS = 2500;              // 单篇分块上限
const CHUNK_TARGET = 700;             // 每块目标字数
const CHUNK_MAX = 1600;               // 每块硬上限
const MAX_UPLOAD = 24 * 1024 * 1024;  // 上传文件上限
const CRAWL_PAGES = 12;               // 单次 URL 抓取最多跟随的页数
const CRAWL_BUDGET = 20000;           // 抓取总预算（毫秒）

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/* ───────── 目录索引 ───────── */
function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch { /* 首次运行没有索引 */ }
  return { items: [] };
}
function saveIndex(idx) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
  fs.renameSync(tmp, INDEX);
}

function metaOf(it) {
  return {
    id: it.id, name: it.name, kind: it.kind, format: it.format,
    url: it.url || null, filename: it.filename || null,
    chunks: it.chunks || 0, chars: it.chars || 0, sections: it.sections || 0,
    createdAt: it.createdAt, updatedAt: it.updatedAt, status: it.status || 'ready',
    note: it.note || '',
  };
}
function list() {
  return loadIndex().items
    .map(metaOf)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function get(id) {
  const it = loadIndex().items.find(x => x.id === id);
  return it ? metaOf(it) : null;
}
function stats() {
  const items = loadIndex().items;
  return {
    docs: items.length,
    chunks: items.reduce((n, x) => n + (x.chunks || 0), 0),
    chars: items.reduce((n, x) => n + (x.chars || 0), 0),
  };
}

/* ───────── 正文 → 分块 ───────── */
// 标题行统一成 markdown 的 "# " 形式（HTML 的 h1~h4 也先转成这样），
// 这样「正文分块」只需要认一种标记，且能保住章节层级做引用标题。
function isHeading(line) {
  const m = String(line).match(/^(#{1,4})\s+(.{1,90})$/);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

function splitLong(text) {
  const out = [];
  let rest = text;
  while (rest.length > CHUNK_MAX) {
    // 优先在句子边界断开，其次在任意位置硬切
    const win = rest.slice(0, CHUNK_MAX);
    const cut = Math.max(win.lastIndexOf('。'), win.lastIndexOf('；'), win.lastIndexOf('\n'), win.lastIndexOf('. '));
    const at = cut > CHUNK_MAX * 0.5 ? cut + 1 : CHUNK_MAX;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// 没有标题层级（纯文本 / PDF / Word 正文）时按「行块」切：块首那行短、不带句末标点，
// 就当这一块的标题 —— 帮助手册里通常就是接口名
function chunkPlain(text, fallbackTitle) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const chunks = [];
  let buf = [], size = 0, title = fallbackTitle || '正文';
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n');
    for (const part of splitLong(body)) {
      if (part.length < 12) continue;
      chunks.push({ id: 'c' + chunks.length, title, path: title, text: part });
      if (chunks.length >= MAX_CHUNKS) return;
    }
    buf = []; size = 0;
  };
  for (const line of lines) {
    if (!buf.length) {
      const looksTitle = line.length <= 40 && !/[。；;，,、：:]$/.test(line);
      if (looksTitle) title = line;
    }
    buf.push(line);
    size += line.length;
    if (size >= CHUNK_TARGET) flush();
    if (chunks.length >= MAX_CHUNKS) break;
  }
  flush();
  return chunks;
}

function chunkText(text, fallbackTitle) {
  if (!/^#{1,4}\s+\S/m.test(String(text || ''))) return chunkPlain(text, fallbackTitle);
  const lines = String(text || '').split('\n');
  const chunks = [];
  let trail = [];           // 章节路径（h1 > h2 > h3）
  let title = fallbackTitle || '';
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    buf = [];
    if (body.length < 12) return;
    for (const part of splitLong(body)) {
      if (part.length < 12) continue;
      chunks.push({
        id: 'c' + chunks.length,
        title: title || fallbackTitle || '正文',
        path: trail.filter(Boolean).join(' › ') || (title || fallbackTitle || '正文'),
        text: part,
      });
      if (chunks.length >= MAX_CHUNKS) return;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '');
    const h = isHeading(line);
    if (h) {
      flush();
      trail = trail.slice(0, h.level - 1);
      trail[h.level - 1] = h.text;
      title = h.text;
      continue;
    }
    if (!line.trim()) { if (buf.length) buf.push(''); continue; }
    buf.push(line.trim());
    // 段落攒够就切一段，避免整章挤成一块
    if (buf.join('').length > CHUNK_TARGET * 2) flush();
    if (chunks.length >= MAX_CHUNKS) break;
  }
  flush();
  return chunks;
}

/* ───────── HTML → 文本 ───────── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&(\w+);/g, (m, n) => (ENT[n] != null ? ENT[n] : m));
}
function safeChar(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)
    || String(html).match(/<h1[^>]*>([\s\S]{1,120}?)<\/h1>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
}

// 从 HTML 里抽「正文」：先去噪声容器，再把结构标签映射成换行 / 标题，
// 保留表格的单元格分隔（参数表是手册里最有价值的部分）
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, inner) =>
    `\n\n${'#'.repeat(Number(lv))} ${decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<h([5-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, inner) =>
    `\n\n${decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ').replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|article|ul|ol|table|thead|tbody|tr|blockquote|pre|dd|dt|dl)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\| +\n/g, '\n')
    .trim();
}

// 正文里通常是「菜单 / 面包屑 / 版权」这类短行，砍掉能显著提升检索质量
function dropBoilerplate(text) {
  return String(text || '').split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (/^(首页|上一页|下一页|上一篇|下一篇|返回顶部|打印|收藏|分享|登录|注册|English|中文)/.test(t) && t.length <= 16) return false;
    if (/^(©|Copyright|版权所有|隐私政策|用户协议)/i.test(t)) return false;
    return true;
  }).join('\n');
}

/* ───────── 其他格式 → 文本 ───────── */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout || ''));
    });
  });
}

// docx 正文：按段落处理，把 Word 的「标题 1/2/3」样式还原成 markdown 标题，
// 否则整篇 Word 手册会挤成一块，检索命中后只能给出一大段
function xmlToText(xml) {
  const src = String(xml || '');
  const paras = src.match(/<w:p\b[\s\S]*?<\/w:p>/g);
  const one = p => decodeEntities(p
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  if (!paras) return one(src);
  const out = [];
  for (const p of paras) {
    const text = one(p);
    if (!text) continue;
    const h = p.match(/<w:pStyle[^>]*w:val="[^"]*?(?:[Hh]eading|标题)\s*(\d)/)
      || p.match(/<w:outlineLvl[^>]*w:val="(\d)"/);
    if (h) out.push(`${'#'.repeat(Math.min(4, Math.max(1, Number(h[1]))))} ${text}`);
    else out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── PDF：按字体对象解析 ToUnicode，还原中文 ──
   为什么不能「全局一份码表」：排版工具会把每个字交给子集字体，同一个字节码在不同
   字体里对应不同汉字。必须按页解析 /Resources /Font，靠 /Fx Tf 切换当前字体再映射。 */
function pdfInflate(slice) {
  try { return zlib.inflateSync(slice); } catch { /* 可能是 raw deflate */ }
  try { return zlib.inflateRawSync(slice.length > 2 ? slice.subarray(2) : slice); } catch { return null; }
}

function pdfObjects(raw) {
  const s = raw.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = s.indexOf('endobj', bodyStart);
    const body = s.slice(bodyStart, end < 0 ? s.length : end);
    const si = body.indexOf('stream');
    let dict = body, stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      let st = bodyStart + si + 6;
      if (s[st] === '\r') st++;
      if (s[st] === '\n') st++;
      const se = s.indexOf('endstream', st);
      if (se > st) stream = raw.subarray(st, se);
    }
    objs.set(num, { num, dict, stream });
    re.lastIndex = end < 0 ? s.length : end + 6;
  }
  return objs;
}

const pdfRef = (dict, key) => {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
};
// 取 << ... >> 子字典（内联，或 /Key N 0 R 指向的对象）
function pdfSubDict(dict, key, objs) {
  const r = pdfRef(dict, key);
  if (r && objs.get(r)) return objs.get(r).dict;
  const i = dict.indexOf('/' + key);
  if (i < 0) return '';
  const j = dict.indexOf('<<', i);
  if (j < 0 || j > i + 200) return '';
  let depth = 0;
  for (let k = j; k < dict.length - 1; k++) {
    if (dict[k] === '<' && dict[k + 1] === '<') { depth++; k++; continue; }
    if (dict[k] === '>' && dict[k + 1] === '>') { depth--; k++; if (!depth) return dict.slice(j, k + 1); }
  }
  return '';
}

function pdfParseCMap(txt) {
  const map = new Map();
  const uni = hex => (hex.match(/.{1,4}/g) || []).map(h => safeChar(parseInt(h, 16))).join('');
  const c1 = txt.indexOf('beginbfchar');
  if (c1 >= 0) {
    const seg = txt.slice(c1, txt.indexOf('endbfchar', c1));
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(seg))) map.set(parseInt(m[1], 16), uni(m[2]));
  }
  const r1 = txt.indexOf('beginbfrange');
  if (r1 >= 0) {
    const seg = txt.slice(r1, txt.indexOf('endbfrange', r1));
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    let m;
    while ((m = re.exec(seg))) {
      const from = parseInt(m[1], 16), to = parseInt(m[2], 16);
      if (to < from || to - from > 4096) continue;
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = from; c <= to; c++) map.set(c, safeChar(base + (c - from)));
      } else if (m[4]) {
        (m[4].match(/<([0-9a-fA-F]+)>/g) || []).forEach((h, k) => map.set(from + k, uni(h.slice(1, -1))));
      }
    }
  }
  return map;
}

function pdfCmapOf(fontNum, objs) {
  const ob = objs.get(fontNum);
  if (!ob) return null;
  const r = pdfRef(ob.dict, 'ToUnicode');
  const st = r && objs.get(r);
  if (!st || !st.stream) return null;
  const buf = pdfInflate(st.stream);
  if (!buf) return null;
  const map = pdfParseCMap(buf.toString('latin1'));
  if (!map.size) return null;
  const wide = /\/Subtype\s*\/Type0/.test(ob.dict) || /Identity-[HV]/.test(ob.dict);
  return { map, wide };
}

function pdfPageFonts(pageDict, objs) {
  const res = pdfSubDict(pageDict, 'Resources', objs);
  const fontDict = pdfSubDict(res, 'Font', objs) || (res.match(/\/Font\s*<<([\s\S]*?)>>/) || [])[1] || '';
  const out = new Map();
  const re = /\/([A-Za-z0-9#+.\-]+)\s+(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = re.exec(fontDict))) out.set(m[1], Number(m[2]));
  return out;
}

function pdfPageText(pageDict, objs) {
  const c = pageDict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
  if (!c) return [];
  let content = '';
  for (const m of c[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
    const ob = objs.get(Number(m[1]));
    if (!ob || !ob.stream) continue;
    const buf = pdfInflate(ob.stream);
    if (buf) content += buf.toString('latin1') + '\n';
  }
  if (!content) return [];
  const fonts = pdfPageFonts(pageDict, objs);
  const lines = [];
  let line = '';
  const brk = () => { if (line.trim()) lines.push(line.trim()); line = ''; };
  // 分组：1 字体名 / 2,3 Td 位移 / 4..9 Tm 矩阵 / 10 十六进制串 / 11 (…) 串 / 12 换行算子
  const tokenRe = /(\/[A-Za-z0-9#+.\-]+)\s+[-+\d.]+\s+Tf|([-+\d.]+)\s+([-+\d.]+)\s+(?:Td|TD)|([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s+Tm|\(((?:\\[\s\S]|[^\\)])*)\)|<([0-9a-fA-F\s]+)>|(T\*|ET|BT)/g;
  let m, cur = null, wide = true, lastY = null;
  while ((m = tokenRe.exec(content))) {
    if (m[1]) {
      const cm = fonts.has(m[1].slice(1)) ? pdfCmapOf(fonts.get(m[1].slice(1)), objs) : null;
      cur = cm ? cm.map : null; wide = cm ? cm.wide : true;
      continue;
    }
    if (m[2] != null) {                         // 同一行内的横移不换行，纵向位移才换行
      if (Math.abs(Number(m[3])) > 0.5) { brk(); lastY = null; }
      continue;
    }
    if (m[4] != null) {
      const y = Number(m[9]);
      if (lastY != null && Math.abs(y - lastY) > 1) brk();
      lastY = y;
      continue;
    }
    if (m[12] || m[0] === 'T*' || m[0] === 'ET') { brk(); continue; }
    const step = wide ? 4 : 2;
    const decodeHex = hex => {
      let out = '';
      if (cur && cur.size) for (let i = 0; i + step <= hex.length; i += step) out += cur.get(parseInt(hex.slice(i, i + step), 16)) || '';
      return out;
    };
    if (m[11] != null) line += decodeHex(m[11].replace(/\s+/g, ''));
    else if (m[10] != null) {
      if (cur && cur.size) {
        let hex = '';
        for (const ch of m[10]) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
        line += decodeHex(hex);
      } else {
        line += m[10].replace(/\\([nrt])/g, (x, ch) => ({ n: '\n', r: '\r', t: '\t' }[ch]));
      }
    }
  }
  brk();
  return lines;
}

/* PDF 里常见的「部首补充区」字符：NFKC 不管这一块，只能手工映射 */
const RADICAL_FIX = {
  '⻄': '西', '⻅': '见', '⻆': '角', '⻉': '贝', '⻋': '车', '⻓': '长',
  '⻔': '门', '⻘': '青', '⻚': '页', '⻛': '风', '⻜': '飞', '⻢': '马',
  '⻮': '齿', '⻰': '龙', '⻳': '龟', '⻨': '麦', '⻩': '黄', '⻬': '齐',
};

function pdfToText(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 200000)).toString('latin1');
  if (/\/Encrypt\b/.test(head) || /\/Encrypt\b/.test(buf.toString('latin1').slice(-4000))) {
    throw new Error('这个 PDF 有加密 / 权限保护，无法提取正文。可以先用阅读器取消密码保护，或另存为 HTML 后导入。');
  }
  const objs = pdfObjects(buf);
  const pages = [...objs.values()].filter(o => /\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages\b/.test(o.dict));
  const lines = [];
  for (const pg of pages) lines.push(...pdfPageText(pg.dict, objs));
  return lines
    .join('\n')
    // 排版工具常把汉字写成康熙部首（「手」→ ⼿）或 CJK 部首补充区（「页」→ ⻚）：
    // 只对这些区段做 NFKC，别把全角标点（，：）一起改成半角
    .replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, ch => RADICAL_FIX[ch] || ch.normalize('NFKC'))
    .replace(/\u0000/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function docxToText(buf) {
  const tmp = path.join(os.tmpdir(), `apiflow-doc-${process.pid}-${Date.now()}.docx`);
  fs.writeFileSync(tmp, buf);
  try {
    const xml = await run('unzip', ['-p', tmp, 'word/document.xml']);
    return xmlToText(xml);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结果 */ }
  }
}

async function wordToText(buf, ext) {
  const tmp = path.join(os.tmpdir(), `apiflow-doc-${process.pid}-${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    return await run('textutil', ['-convert', 'txt', '-stdout', tmp]);
  } catch (e) {
    throw new Error(`无法解析 .${ext} 文件（需要系统 textutil）：建议另存为 .docx 或 Markdown 后导入`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* ───────── 抓取 ───────── */
async function httpGet(u, timeout = 9000) {
  const res = await fetch(u, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  const type = String(res.headers.get('content-type') || '');
  const cs = (type.match(/charset=([\w-]+)/i) || [])[1]
    || (String(res.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1];
  const ab = await res.arrayBuffer();
  let text;
  try {
    text = new TextDecoder(cs || 'utf-8').decode(ab);
    if (/\ufffd{3,}/.test(text) && (!cs || /utf-?8/i.test(cs))) text = new TextDecoder('gbk').decode(ab);
  } catch {
    text = new TextDecoder('utf-8').decode(ab);
  }
  return { text, type, url: res.url || u, bytes: ab.byteLength };
}

const SKIP_LINK = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|zip|gz|tgz|rar|7z|exe|dmg|mp4|mp3|pdf|docx?|xlsx?|pptx?)$/i;
function linksOf(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const href = m[1].trim();
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    u.hash = '';
    if (SKIP_LINK.test(u.pathname)) continue;
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    out.push({ url: u.toString(), label });
  }
  return out;
}

// 同手册判定：同源 + 目录前缀一致（防止从 API 文档爬到公司官网页脚里的招聘信息）
function sameSection(root, u) {
  let a, b;
  try { a = new URL(root); b = new URL(u); } catch { return false; }
  if (a.host !== b.host) return false;
  if (b.search && b.search.length > 1) return false;
  const dir = a.pathname.replace(/[^/]*$/, '');
  const base = dir.split('/').filter(Boolean);
  const seg = b.pathname.split('/').filter(Boolean);
  if (!base.length) return true;
  const head = base.slice(0, Math.min(2, base.length));
  return head.every((x, i) => seg[i] === x);
}

async function crawl(rootUrl, { maxPages = CRAWL_PAGES, budget = CRAWL_BUDGET } = {}) {
  const t0 = Date.now();
  // 「/」和「/index.html」是同一页；带 #anchor 的也是同一页 —— 不去重会重复收录整章
  const key = u => String(u).replace(/#.*$/, '')
    .replace(/\/index\.(?:html?|php|aspx?)$/i, '/')
    .replace(/\/+$/, '') || '/';
  const queue = [{ url: rootUrl, label: '' }];
  const seen = new Set();
  const seenText = new Set();
  const pages = [];
  const errors = [];
  while (queue.length && pages.length < maxPages && Date.now() - t0 < budget) {
    const item = queue.shift();
    const k = key(item.url);
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      const got = await httpGet(item.url, Math.min(9000, Math.max(3000, budget - (Date.now() - t0))));
      const html = got.text;
      const title = htmlTitle(html);
      const body = htmlToText(html);
      const sig = require('crypto').createHash('md5').update(body.replace(/\s+/g, '')).digest('hex');
      if (body.replace(/\s/g, '').length >= 40 && !seenText.has(sig)) {
        seenText.add(sig);
        pages.push({ url: item.url, title: title || item.label, body });
      }
      for (const l of linksOf(html, got.url)) {
        if (queue.length > 120) break;
        if (!sameSection(rootUrl, l.url)) continue;
        // 目录里的链接文字太短的（「更多」「»」）多半不是章节
        if (!l.label || l.label.length < 2) continue;
        if (seen.has(key(l.url))) continue;
        queue.push(l);
      }
    } catch (e) {
      errors.push(`${item.url}：${e.message}`);
    }
  }
  return { pages, errors, truncated: queue.length > 0 };
}

/* ───────── 文档落盘 ───────── */
const _cache = new Map();       // id -> { mtime, chunks }
function chunkPath(id) { return path.join(DOC_DIR, `${id}.json`); }

function writeChunks(id, chunks) {
  fs.mkdirSync(DOC_DIR, { recursive: true });
  const file = chunkPath(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ id, chunks }));
  fs.renameSync(tmp, file);
  _cache.set(id, { mtime: fs.statSync(file).mtimeMs, chunks });
}

function readChunks(id) {
  const file = chunkPath(id);
  let st;
  try { st = fs.statSync(file); } catch { _cache.delete(id); return []; }
  const hit = _cache.get(id);
  if (hit && hit.mtime === st.mtimeMs) return hit.chunks;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const chunks = Array.isArray(j.chunks) ? j.chunks : [];
    _cache.set(id, { mtime: st.mtimeMs, chunks });
    return chunks;
  } catch { return []; }
}

function remove(id) {
  _cache.delete(id);
  const idx = loadIndex();
  idx.items = idx.items.filter(x => x.id !== id);
  saveIndex(idx);
  const file = chunkPath(id);
  try { fs.unlinkSync(file); return; } catch { /* 沙箱可能拦删除，退化为改名 */ }
  try { fs.renameSync(file, path.join(DOC_DIR, `${TRASH_PREFIX}${id}-${Date.now()}.json`)); } catch { /* 不影响正确性 */ }
}

function newId() {
  return 'doc_' + require('crypto').randomBytes(3).toString('hex');
}

function upsert({ name, kind, format, url, filename, chunks, note }) {
  const idx = loadIndex();
  const existing = url ? idx.items.find(x => x.url === url) : null;
  const now = Date.now();
  const id = existing ? existing.id : newId();
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  const meta = {
    id, name: clip(name, 80), kind, format,
    url: url || null, filename: filename || null,
    chunks: chunks.length, chars,
    sections: new Set(chunks.map(c => c.path)).size,
    createdAt: existing ? existing.createdAt : now, updatedAt: now,
    status: 'ready', note: note || '',
  };
  writeChunks(id, chunks);
  if (existing) Object.assign(existing, meta);
  else idx.items.push(meta);
  saveIndex(idx);
  return metaOf(meta);
}

function looksGarbled(text) {
  const t = String(text || '');
  if (t.length < 16) return true;
  const bad = (t.match(/[\ufffd\u0000-\u0008\u000e-\u001f]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const ascii = (t.match(/[a-zA-Z0-9 ,.：:；;（）()\-]/g) || []).length;
  return bad / t.length > 0.02 || (cjk + ascii) / t.length < 0.6;
}

/* ───────── 三个入口：URL / 文本 / 文件 ───────── */
async function createFromUrl({ url, name, maxPages }) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('请填写 http(s) 开头的帮助文档地址');
  const { pages, errors, truncated } = await crawl(u, { maxPages: maxPages ? Math.min(40, Math.max(1, Number(maxPages))) : CRAWL_PAGES });
  if (!pages.length) {
    throw new Error(`没能从 ${u} 抓到正文${errors.length ? `（${errors[0]}）` : ''}。`
      + '如果这个页面是前端渲染的（打开后正文才出现），可以在浏览器里全选复制，用「导入文档 → 粘贴正文」贴进来。');
  }
  // 合并多页：每页一个 h1（页标题），正文按原样保留
  const merged = pages.map(p => `# ${clip(p.title || '正文', 60)}\n\n${dropBoilerplate(p.body)}`).join('\n\n');
  const chunks = chunkText(merged, name || pages[0].title || u);
  if (!chunks.length) throw new Error('抓到的页面没有可用的正文内容');
  const note = [
    pages.length > 1 ? `已抓取 ${pages.length} 页` : '',
    truncated ? '达到页数 / 时间上限，可再抓一次补齐' : '',
    errors.length ? `${errors.length} 个链接抓取失败` : '',
  ].filter(Boolean).join('；');
  return upsert({
    name: name || clip(pages[0].title || new URL(u).hostname, 60),
    kind: 'url', format: 'html', url: u, chunks, note,
  });
}

function createFromText({ text, name, filename, format }) {
  const body = String(text || '');
  if (body.replace(/\s/g, '').length < 40) throw new Error('内容太短（少于 40 字），无法作为手册使用');
  const clean = body.length > MAX_DOC_CHARS ? body.slice(0, MAX_DOC_CHARS) : body;
  const chunks = chunkText(dropBoilerplate(clean), name || filename || '手册');
  if (!chunks.length) throw new Error('没有解析出可用章节，请确认文件里有正文');
  return upsert({
    name: name || filename || '粘贴的手册', kind: filename ? 'file' : 'text',
    format: format || 'text', filename: filename || null, chunks,
    note: body.length > MAX_DOC_CHARS ? `正文超过 ${Math.round(MAX_DOC_CHARS / 10000)} 万字，已截断` : '',
  });
}

async function createFromFile({ buffer, filename, name }) {
  const fn = String(filename || 'manual.txt');
  const ext = (fn.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || 'txt';
  if (buffer.length > MAX_UPLOAD) throw new Error(`文件太大了（${(buffer.length / 1048576).toFixed(1)}MB），上限 24MB`);
  let text = '', format = ext;
  if (ext === 'pdf') {
    text = pdfToText(buffer);
    if (looksGarbled(text)) {
      throw new Error('这个 PDF 的正文是图片或使用了特殊字体编码，提取不出可读文字。'
        + '可以在阅读器里「另存为文本 / 导出 HTML」，或用截图 OCR 后粘贴正文。');
    }
  } else if (ext === 'docx') {
    text = await docxToText(buffer);
  } else if (ext === 'doc' || ext === 'rtf' || ext === 'odt') {
    text = await wordToText(buffer, ext);
  } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    const html = buffer.toString('utf8');
    text = `# ${htmlTitle(html) || name || fn}\n\n` + htmlToText(html);
  } else if (['md', 'markdown', 'txt', 'text', 'csv', 'json', 'yaml', 'yml'].includes(ext)) {
    text = buffer.toString('utf8');
  } else {
    throw new Error(`暂不支持 .${ext} 文件，可导入 .md / .txt / .html / .pdf / .docx（或直接粘贴正文）`);
  }
  if (looksGarbled(text) && ext !== 'pdf') throw new Error('文件内容读起来像乱码，可能不是 UTF-8 编码的文本');
  return createFromText({ text, name, filename: fn, format });
}

/* ───────── 检索 ───────── */
const CJK_RE = /[\u4e00-\u9fa5]/;
function tokens(q) {
  const s = String(q || '').toLowerCase();
  const latin = (s.match(/[a-z_][a-z0-9_]{1,}/g) || []).filter(w => w.length >= 2);
  const out = new Set(latin);
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length <= 2) out.add(seg);
    else for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out].filter(t => t.length >= 2).slice(0, 40);
}

let _pool = null, _poolRev = -1;
function pool() {
  const idx = loadIndex();
  const rev = idx.items.reduce((n, x) => n + (x.updatedAt || 0), 0);
  if (_pool && _poolRev === rev) return _pool;
  const items = [];
  for (const it of idx.items) {
    for (const c of readChunks(it.id)) {
      items.push({
        docId: it.id, docName: it.name, url: it.url || null, format: it.format,
        id: c.id, title: c.title, path: c.path, text: c.text,
        norm: match.normalize(c.text), titleNorm: match.normalize(c.title + ' ' + c.path),
      });
    }
  }
  _pool = items; _poolRev = rev;
  return items;
}

function scoreChunk(item, qTokens, idf) {
  let s = 0, hit = 0;
  for (const t of qTokens) {
    if (item.norm.includes(t)) { s += idf.get(t) || 1; hit++; }
  }
  if (!hit) return null;
  const cover = hit / qTokens.length;
  s *= 0.55 + cover;
  let titleHit = 0;
  for (const t of qTokens) if (item.titleNorm.includes(t)) titleHit++;
  s += titleHit * 2.2;
  if (qTokens.length && cover >= 0.85) s += 3;
  return { item, score: s, cover };
}

function sentenceSplit(text) {
  return String(text || '').split(/(?<=[。！？!?；;])|\n+/).map(s => s.trim()).filter(s => s.length >= 4);
}

function bestSentence(text, qTokens) {
  const sents = sentenceSplit(text);
  let best = '', bestScore = -1;
  for (const s of sents) {
    const n = match.normalize(s);
    let hit = 0;
    for (const t of qTokens) if (n.includes(t)) hit++;
    const sc = hit / Math.max(1, qTokens.length) + Math.min(0.4, s.length / 400);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return clip(best || text, 190);
}

function search(q, { limit = 6, docId = '', minCover = 0 } = {}) {
  const qTokens = tokens(q);
  const items = pool().filter(x => !docId || x.docId === docId);
  if (!items.length) return { total: 0, items: [], raw: [] };
  if (!qTokens.length) {
    const head = items.slice(0, limit);
    return {
      total: items.length,
      raw: head,
      items: head.map(it => ({
        docId: it.docId, docName: it.docName, url: it.url, format: it.format,
        id: it.id, title: it.title, path: it.path, text: it.text, score: 1, cover: 0,
      })),
    };
  }
  const idf = new Map();
  for (const t of qTokens) {
    let df = 0;
    for (const it of items) if (it.norm.includes(t)) df++;
    idf.set(t, Math.log(1 + items.length / (1 + df)) + 0.4);
  }
  const scored = [];
  for (const it of items) {
    const r = scoreChunk(it, qTokens, idf);
    if (r && (!minCover || r.cover >= minCover)) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  return {
    total: scored.length,
    // raw 保留内部字段（norm / titleNorm），assist 做相似度计算要用；对外接口只返回 items
    raw: top.map(r => ({ ...r.item, score: r.score, cover: r.cover })),
    items: top.map(r => ({
      docId: r.item.docId, docName: r.item.docName, url: r.item.url, format: r.item.format,
      id: r.item.id, title: r.item.title, path: r.item.path, text: r.item.text,
      score: Math.round(r.score * 10) / 10, cover: Math.round(r.cover * 100) / 100,
    })),
    qTokens,
  };
}

/* ───────── 给搭建器用：引用 + 候选补全 ───────── */
function coverOf(aBigrams, bNorm, bBigrams) {
  if (!aBigrams.size) return 0;
  let hit = 0;
  for (const g of aBigrams) if (bBigrams.has(g)) hit++;
  return hit / aBigrams.size;
}

function mentionOf(op, sentNorm, sentBigrams) {
  const n = match.normalize(op.name || '');
  if (!n || n.length < 3) return 0;
  if (sentNorm.includes(n)) return 1;                    // 原文引用了接口全名
  const g = match.bigrams(n);
  let hit = 0;
  for (const x of g) if (sentBigrams.has(x)) hit++;
  const cov = g.size ? hit / g.size : 0;
  return cov >= 0.85 ? 0.75 : cov >= 0.7 ? 0.45 : 0;
}

// 句子的「语义接近度」：用户这句话的二元组有多少落在这一句里。
// 短问句 vs 长句子用覆盖率比 Dice 更合适（「告警趋势」要能在 40 字的句子里拿到分）
function simOf(qNorm, qBigrams, sentNorm, sentBigrams) {
  const cov = coverOf(qBigrams, sentNorm, sentBigrams);
  const contain = qNorm.length >= 3 && sentNorm.includes(qNorm) ? 0.9 : 0;
  return Math.max(cov, contain);
}

/**
 * 解析这段描述时，手册里有哪些依据。
 * @returns {{refs:Array, candidates:Array, terms:Array}}
 *   refs        章节级引用（章节路径 + 最能说明问题的一句）
 *   candidates  手册里与这段描述对得上的接口（带置信度），主匹配落空时用来兜底
 */
function assist(text, ops, { limit = 4 } = {}) {
  const q = String(text || '').trim();
  const empty = { refs: [], candidates: [], terms: [] };
  if (!q || !pool().length) return empty;
  const qTokens = tokens(q);
  const qNorm = match.normalize(q);
  const qBigrams = match.bigrams(q);
  const found = search(q, { limit: 10, minCover: 0.12 });
  const hits = found.raw || [];
  if (!hits.length) return empty;

  const refs = [], candMap = new Map();
  const addCand = (list, sim, evidence, item, bonus = 0) => {
    for (const x of list) {
      // 置信度 = 这节和描述有多像 × 这节有没有点名该接口。
      // 两个因子是乘性的：只沾边（strength 低）压不过原文点名，纯点名但章节无关也拿不到高分。
      const conf = Math.min(1, sim * (0.5 + 0.5 * x.strength) + bonus);
      const sc = Math.round(conf * 100);
      const prev = candMap.get(x.op.id);
      if (prev && prev.score >= sc) continue;
      candMap.set(x.op.id, {
        op: x.op, score: sc, conf: Math.round(conf * 100) / 100, strength: x.strength,
        evidence: clip(evidence, 140), docName: item.docName, docId: item.docId,
        title: item.title, url: item.url,
      });
    }
  };
  for (const item of hits) {
    // 手册最常见是「一节讲一个接口」：标题即接口名。标题命中就先把这一节挂到该接口上，
    // 正文里再补「这一节在讲什么」，两边都能拿到分。
    const titleOps = [];
    for (const op of ops || []) {
      const st = mentionOf(op, item.titleNorm, match.bigrams(item.title || ''));
      if (st >= 0.6) titleOps.push({ op, strength: st });
    }
    const titleSim = simOf(qNorm, qBigrams, item.titleNorm, match.bigrams(item.title || ''));
    if (titleSim >= 0.34 && titleOps.length) addCand(titleOps, titleSim, item.title, item, 0.06);

    const sents = sentenceSplit(item.text).slice(0, 24);
    let best = { sim: titleSim, sent: '', ops: titleOps.slice(0, 2) };
    for (const sent of sents) {
      const sn = match.normalize(sent);
      if (!sn) continue;
      const sb = match.bigrams(sent);
      const sim = simOf(qNorm, qBigrams, sn, sb);
      const here = [];
      for (const op of ops || []) {
        const strength = mentionOf(op, sn, sb);
        if (strength) here.push({ op, strength });
      }
      if (sim > best.sim) best = { sim, sent, ops: here.length ? here : titleOps.slice(0, 2) };
      if (sim >= 0.34) addCand(here.length ? here : titleOps, sim, sent, item, here.length ? 0.1 : 0.02);
    }
    // 同一篇手册的同一节可能被抓到多页（目录页 + 正文页），引用只留一条
    const dup = refs.find(r => r.docId === item.docId && r.path === item.path);
    if (!dup) {
      refs.push({
        docId: item.docId, docName: item.docName, url: item.url,
        title: item.title, path: item.path,
        snippet: clip(best.sent || bestSentence(item.text, qTokens), 190),
        sim: Math.round(best.sim * 100) / 100,
        ops: [...new Set(best.ops.map(x => x.op.name))].slice(0, 3),
      });
    } else if (best.sim > dup.sim) {
      dup.sim = Math.round(best.sim * 100) / 100;
      dup.snippet = clip(best.sent || dup.snippet, 190);
    }
    if (refs.length >= limit) break;
  }
  // 同分时把「手册里原文点名」的接口排前面：分差相同的情况下，点名比沾边更可信。
  // 另外按接口名去重 —— 同一个接口被多个来源（SDK 导入 + OpenAPI 接入）登记时会有多条，
  // 那不是「两个候选打架」，只是同一个名字的多份记录，取分最高的那条即可。
  const seen = new Set();
  const candidates = [];
  for (const c of [...candMap.values()].sort((a, b) => (b.score - a.score) || (b.strength - a.strength) || (b.conf - a.conf))) {
    const key = c.op.name;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
    if (candidates.length >= 4) break;
  }
  return { refs, candidates, terms: found.qTokens || qTokens };
}

// 给前端做「手册里可能相关的章节」列表用
function preview(id, q) {
  const meta = get(id);
  if (!meta) return null;
  if (!q) {
    const chunks = readChunks(id);
    return { doc: meta, total: chunks.length, items: chunks.slice(0, 60) };
  }
  const found = search(q, { limit: 40, docId: id });
  return { doc: meta, total: found.total, items: found.items };
}

module.exports = {
  list, get, stats, remove, preview, search, assist,
  createFromUrl, createFromText, createFromFile,
  chunkText, htmlToText, pdfToText, tokens, crawl,
  MAX_UPLOAD, CRAWL_PAGES,
};

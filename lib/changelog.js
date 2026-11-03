// ── 版本更新记录：解析仓库根目录的 CHANGELOG.md（Keep a Changelog 格式）──
// 页面不维护第二份数据：发版时改 CHANGELOG.md，这里按 mtime 缓存自动失效。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
let PKG = {};
try { PKG = require('../package.json'); } catch { /* 单测环境可能没装 package.json */ }

// 分组展示顺序：常见分组按 Keep a Changelog 的语义排前面，自定义分组（如「平台核心」）保持原顺序居中，
// 「文档 / 测试 / 其他」这类兜底分组永远押后 —— 否则「其他」会蹿到自定义分组前面。
const GROUP_ORDER = ['新增', '变更', '修复', '移除', '废弃', '安全'];
const GROUP_TRAIL = ['文档', '测试', '其他'];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 极简内联渲染：`code` / **粗体** / [文字](链接)。先摘出 code span，避免里面的 * 被当成强调；
// 其余全部先转义再做替换，条目里写 <img onerror=…> 也只会显示成文本。
function inline(md) {
  const codes = [];
  let s = String(md).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

function buildRelease(head) {
  const unreleased = /unreleased|未发布/i.test(head);
  const dateM = head.match(/(\d{4}-\d{2}-\d{2})/);
  const verM = head.match(/\[([^\]]+)\]/) || head.match(/(\d+(?:\.\d+)+(?:-[\w.]+)?)/);
  const version = unreleased ? '未发布' : (verM ? verM[1] : head.trim());
  return { version, date: dateM ? dateM[1] : null, unreleased, notes: [], groups: [] };
}

/** 解析 markdown 文本（单独导出，便于单测直接喂字符串） */
function parse(md) {
  const releases = [];
  const intro = [];
  let rel = null, grp = null, item = null;

  const endItem = () => {
    if (!item) return;
    item.text = item.text.replace(/\s+/g, ' ').trim();
    item.html = inline(item.text);
    item = null;
  };
  const endGroup = () => {
    if (!grp) return;
    endItem();
    const items = grp.items.filter(x => x.text).map(x => x.html ? x : { ...x, html: inline(x.text) });   // 裸段落没经过 endItem，这里补渲染
    if (items.length && rel) rel.groups.push({ name: grp.name, items });
    grp = null;
  };
  const endRelease = () => {
    endItem(); endGroup();
    if (!rel) return;
    rel.notes = rel.notes.filter(x => x.text).map(x => x.html ? x : { ...x, html: inline(x.text) });
    rel.itemCount = rel.notes.length + rel.groups.reduce((n, g) => n + g.items.length, 0);
    const rank = (name, i) => {
      const t = GROUP_TRAIL.indexOf(name);
      if (t >= 0) return 90 + t;
      const k = GROUP_ORDER.indexOf(name);
      return k >= 0 ? k : 10 + i;
    };
    rel.groups = rel.groups
      .map((g, i) => ({ g, r: rank(g.name, i) }))
      .sort((a, b) => a.r - b.r)
      .map(x => x.g);
    rel.byGroup = rel.groups.map(g => g.name);
    releases.push(rel);
    rel = null;
  };

  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^##\s+(.+?)\s*$/))) {          // 版本
      endRelease();
      rel = buildRelease(m[1]);
      continue;
    }
    if ((m = line.match(/^###\s+(.+?)\s*$/))) {          // 分组（新增 / 修复 / …）
      endItem(); endGroup();
      grp = { name: m[1].trim(), items: [] };
      continue;
    }
    if (/^#\s+/.test(line)) { endRelease(); continue; }   // 文档标题
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { endItem(); endGroup(); continue; }   // 分隔线
    if (!line.trim()) { endItem(); continue; }            // 空行 = 条目结束
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {          // 列表项
      endItem();
      item = { text: m[1] };
      if (grp) grp.items.push(item);
      else if (rel) rel.notes.push(item);
      else intro.push(item);
      continue;
    }
    if (item) { item.text += ' ' + line.trim(); continue; }   // 缩进续行
    if (grp) { grp.items.push({ text: line.trim() }); continue; }   // 分组里的裸段落
    if (rel) { rel.notes.push({ text: line.trim() }); continue; }
    intro.push({ text: line.trim() });
  }
  endRelease();

  // 顶部导语（格式说明那几行）转成 html
  const introHtml = intro.map(x => inline(x.text || x)).filter(Boolean);
  return { intro: introHtml, releases };
}

/** 读文件 + 按 mtime 缓存 */
function load() {
  let st;
  try { st = fs.statSync(FILE); } catch {
    return { title: '版本更新记录', currentVersion: PKG.version || null, releases: [], intro: [], missing: true, error: '未找到 CHANGELOG.md' };
  }
  if (_cache && _cache.mtime === st.mtimeMs && _cache.size === st.size) return _cache.data;
  const md = fs.readFileSync(FILE, 'utf8');
  const { intro, releases } = parse(md);
  const versions = releases.filter(r => !r.unreleased);
  const data = {
    title: '版本更新记录',
    currentVersion: PKG.version || null,                 // package.json 里的当前版本
    latestVersion: versions.length ? versions[0].version : null,
    latestDate: versions.length ? versions[0].date : null,
    hasUnreleased: releases.some(r => r.unreleased),
    intro,
    releases,
    stats: {
      releases: releases.length,
      released: versions.length,
      items: releases.reduce((n, r) => n + r.itemCount, 0),
      groups: [...new Set(releases.flatMap(r => r.groups.map(g => g.name)))],
    },
    source: 'CHANGELOG.md',
    updatedAt: Math.round(st.mtimeMs),
    bytes: st.size,
  };
  _cache = { mtime: st.mtimeMs, size: st.size, data };
  return data;
}
let _cache = null;

function raw() {
  try { return fs.readFileSync(FILE, 'utf8'); } catch { return ''; }
}

module.exports = { load, raw, parse, inline, FILE, GROUP_ORDER, GROUP_TRAIL };

// ── 中文自然语言 ↔ 接口（operation）匹配器 ──
// 为什么不用「接口名原文包含」：人不会照着接口名说话。
//   「查一下告警策略列表」「看看这周告警趋势」「查看资源利用率排行榜」「把 A 和 B 串起来」
// 这些说法里没有一处完整接口名，但它们都明确指向唯一接口。
// 做法：先按连接词切子句，再逐句打分 —— 最长公共子串（长得像）+ 2-gram 覆盖率（说得全）
//       + 动作词一致性（查 / 删 / 建 别串味）+ 关键词命中（同义词兜底）。
// 每个子句只取最强的一个，避免「查一下告警策略列表」把「删除告警策略」一起带进来。

const CJK_RE = /[\u4e00-\u9fa5]/;
const PUNCT_RE = /[\s`~!@#$%^&*()\-_=+\[\]{}\\|;:'",.<>/?，。；：！？、（）【】《》〈〉「」『』“”‘’·…—～]/g;

// 全角 → 半角、去空白标点、小写：让「ＳＫＵ－02」「SKU 02」「sku-02」归一
function normalize(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(PUNCT_RE, '');
}

const hasCJK = s => CJK_RE.test(String(s || ''));

function bigrams(s) {
  const t = normalize(s);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

// 最长公共子串（滚动一维 DP）：返回长度 + 在 a（用户的话）/ b（接口名）里的起点
function lcs(a, b) {
  const A = normalize(a), B = normalize(b);
  if (!A || !B) return { len: 0, aStart: -1, bStart: -1 };
  const prev = new Array(B.length + 1).fill(0);
  let best = 0, ai = -1, bi = -1;
  for (let i = 1; i <= A.length; i++) {
    let diag = 0;
    for (let j = 1; j <= B.length; j++) {
      const tmp = prev[j];
      if (A[i - 1] === B[j - 1]) {
        const v = diag + 1;
        prev[j] = v;
        if (v > best) { best = v; ai = i - v; bi = j - v; }
      } else prev[j] = 0;
      diag = tmp;
    }
  }
  return { len: best, aStart: ai, bStart: bi };
}

/* ───────── 动作词：把口语说法归到 6 个家族 ───────── */
// 顺序即优先级：先判「删 / 增」，再看「改 / 跑 / 推」，最后才是「查」
// 单字动词（删 / 查 / 看 / 加 / 改）也要收：口语里「删门禁白名单」「查库存」都是常态
const VERB_FAMILIES = [
  ['del', /(删除|删掉|删了|删|去掉|移除|清除|清理|清空|注销|下线|关停|回收)/],
  ['add', /(创建|新建|新增|添加|加上|加一个|加个|加|建一个|建个|开通|绑定|授予|导入|加入|插入)/],
  ['edit', /(编辑|修改|更新|改成|改为|改|调整为|调整|变更|设置|配置|重置|重装|扩容|缩容|续订|重命名|改名)/],
  ['run', /(启停|开启|关闭|启用|停用|启动|停止|执行|运行|发起|触发|重放)/],
  ['report', /(上报|推送|写入|同步|提交|发送|通知|告警给)/],
  ['read', /(查询|查看|查一下|查下|查|看看|看一下|看下|看|获取|拉取|拉出来|列出|列表|清单|检索|搜索|读取|统计)/],
];

// 名字前缀决定这个接口是什么动作（查询告警策略列表 → read）
function familyOfName(name) {
  const n = normalize(name);
  for (const [fam, re] of VERB_FAMILIES) {
    const m = n.match(re);
    if (m && m.index === 0) return fam;
  }
  return null;
}

// 紧挨着命中片段之前的动作词，才是这句话里对这个接口的真实动作
function verbBefore(t, at) {
  if (at == null || at < 0) return null;
  const win = t.slice(Math.max(0, at - 6), at);
  let best = null, bestEnd = -1;
  for (const [fam, re] of VERB_FAMILIES) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(win))) {
      const end = m.index + m[0].length;
      if (end >= bestEnd) { bestEnd = end; best = fam; }
    }
  }
  // 只有贴着命中片段（间隔 ≤1 字）才算这句话的动作，否则是上一段的残留
  return bestEnd >= win.length - 1 ? best : null;
}

/* ───────── 打分 ───────── */
const STOPWORDS = new Set(['查询', '获取', '列表', '详情', '同步', '状态', '信息', '数据', '接口', '管理', '操作', '推送', '更新', '调用', '服务', 'api', 'edw', 'openapi', 'version', 'v1', 'v2', 'version2', 'dawn']);

function scoreOp(text, op) {
  const name = String(op.name || op.id || '');
  const t = normalize(text), n = normalize(name);
  if (!t || !n) return null;

  const span = lcs(t, n);
  const nr = bigrams(n), tr = bigrams(t);
  let hit = 0;
  for (const g of nr) if (tr.has(g)) hit++;
  const cov = nr.size ? hit / nr.size : 0;

  let score = 0;
  if (span.len >= 2) score += span.len * 9;       // 字面有多像
  score += cov * 46;                              // 接口名被说到多少
  if (t.includes(n)) score += 42;                 // 完整接口名出现：强信号

  // 首尾字都被点到：中间的字被口语省掉（「标记拒绝」=「标记供应商拒绝」）也认
  const firstG = n.slice(0, 2), lastG = n.slice(-2);
  const bookend = (t.includes(firstG) ? 8 : 0) + (t.includes(lastG) ? 8 : 0);
  score += bookend;
  if (bookend === 16 && n.length > 4) score += 10;

  let kwLen = 0, kwHit = '';
  for (const kw of op.keywords || []) {
    const k = normalize(kw);
    if (!k || k.length < 2) continue;
    if (STOPWORDS.has(String(kw).toLowerCase())) continue;
    if (t.includes(k) && k.length > kwLen) { kwLen = k.length; kwHit = kw; }
  }
  if (kwLen) score += Math.min(18, kwLen * 4);

  // 动作词一致性：「删除告警策略」不能被一堆「查询…列表」抢走，反之亦然
  const opVerb = familyOfName(n);
  const lead = verbBefore(t, span.aStart);
  if (opVerb && lead) score += (opVerb === lead ? 22 : -30);

  // 路径 / 参数命中的弱信号（英文路径名、参数名）
  const segs = String(op.path || '').split(/[/?&=]/).filter(x => x.length >= 3 && !/^\{/.test(x));
  let segHit = 0;
  for (const s of segs) if (t.includes(normalize(s))) segHit++;
  score += Math.min(6, segHit * 3);

  // SDK 里同一能力的另一套实现（_with_config / _with_http_info）让位给主实现
  if (/_with_(config|http_info|config_async|async)$/.test(String(op.id || ''))) score -= 26;

  return { op, score, cov, spanLen: span.len, span, kwHit, opVerb, lead };
}

function rankOps(text, ops, { minScore = 0 } = {}) {
  const out = [];
  for (const op of ops || []) {
    const r = scoreOp(text, op);
    if (r && r.score > 0 && r.score >= minScore) out.push(r);
  }
  out.sort((a, b) => b.score - a.score || b.cov - a.cov || String(a.op.name).length - String(b.op.name).length);
  return out;
}

/* ───────── 切子句：一句话里通常有多个动作 ───────── */
const CLAUSE_RE = /(?:然后|接着|之后|随后|再来|再|同时|并且|以及|还有|并|和|与|、|，|。|；|;|,|\n|：|:)/g;

function splitClauses(text) {
  const s = String(text || '');
  const out = [];
  let last = 0, m;
  CLAUSE_RE.lastIndex = 0;
  while ((m = CLAUSE_RE.exec(s))) {
    const seg = s.slice(last, m.index).trim();
    if (seg) out.push(seg);
    last = m.index + m[0].length;
  }
  const tail = s.slice(last).trim();
  if (tail) out.push(tail);
  return out.length ? out : [s.trim()];
}

// 单句里最像的那个接口（可带最低分门槛）
function bestOp(text, ops, { min = 44 } = {}) {
  const r = rankOps(text, ops)[0];
  return r && r.score >= min ? r : null;
}

// 整段话里的接口：逐子句取最强的一个，按出现顺序返回
function pickOps(text, ops, { min = 44 } = {}) {
  const picked = [], seen = new Set();
  // 同一个接口可能被导入过多次（同名不同来源）：只留最像的那个，别在一个草稿里塞两遍
  const keyOf = r => normalize(r.op.name) || String(r.op.id || '');
  for (const clause of splitClauses(text)) {
    const ranked = rankOps(clause, ops);
    if (!ranked.length) continue;
    const best = ranked[0];
    if (best.score < min) continue;
    // 子句里如果完整接口名都出现了（如「查询A，查询B」被切成一句），按原文顺序都收下
    const extra = ranked
      .filter(r => r !== best && normalize(clause).includes(normalize(r.op.name)))
      .sort((a, b) => a.span.aStart - b.span.aStart);
    for (const r of [best, ...extra]) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      picked.push(r);
    }
  }
  return picked;
}

// 认不出来时给建议，而不是把上百个接口名糊用户一脸
function suggest(text, ops, limit = 5) {
  const clean = (ops || []).filter(o => !/_with_(config|http_info|config_async|async)$/.test(String(o.id || '')));
  const r = rankOps(text, clean).filter(x => x.score >= 18 || x.cov >= 0.34);
  if (r.length) return r.slice(0, limit).map(x => x.op.name);
  // 完全没沾边：从用户自己的接口里挑几个读接口当引子（内置演示接口排后面）
  const reads = clean.filter(o => familyOfName(o.name) === 'read');
  const ordered = [...reads.filter(o => o.sourceId !== 'builtin'), ...reads.filter(o => o.sourceId === 'builtin')];
  const out = [];
  for (const o of ordered) {
    if (out.includes(o.name)) continue;
    out.push(o.name);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  normalize, bigrams, lcs, hasCJK,
  familyOfName, verbBefore, scoreOp, rankOps,
  splitClauses, bestOp, pickOps, suggest,
  VERB_FAMILIES,
};

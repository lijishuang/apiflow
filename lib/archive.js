'use strict';
/**
 * 压缩包导入：.zip / .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz
 *
 * 做法：
 *  1. 用户上传的压缩包落到系统临时目录，交给系统自带 unzip / tar 解压（不引第三方依赖）
 *  2. 递归扫描解压结果，用「多语言通用」的打分规则挑出最像 SDK 客户端的源码文件
 *     （打分维度：method+path 相邻对 > 调用痕迹 > 文件名/路径语义 > 体积）
 *  3. 单独保留 1~2 个写着服务地址的文件，保证 baseUrl 能被 lib/sdk.js 识别
 *  4. 只把挑选后的源码交给上层解析，临时目录随即销毁
 *
 * 安全边界：不进 shell（execFile 参数数组）、跳过符号链接、限制条目数/解压体积/耗时、
 * 只上传体积 ≤40MB 的包，避免 zip bomb 把临时盘写满。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { extractSymbols } = require('./materials');

const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;    // 上传的压缩包上限
const MAX_UNPACK_BYTES = 120 * 1024 * 1024;    // 解压后总大小上限（防 zip bomb）
const MAX_ENTRIES = 20000;                     // 解压出的文件条目上限
const MAX_FILES = 80;                          // 参与解析的源码文件数上限
const MAX_FILE_BYTES = 2 * 1024 * 1024;        // 单文件 2MB（与上传通道一致）
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;       // 送解析的总量 6MB
const UNPACK_TIMEOUT = 60000;

const ARCHIVE_EXT = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

// 参与解析的源码类型（与前端「上传文件」的 accept 保持一致，补充 jsx/kt/yaml）
const SRC_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|kt|kts|go|json|txt|ya?ml)$/i;

// 噪声目录：依赖、产物、测试、示例、文档 —— 里面几乎不会有客户端调用点
const SKIP_DIR = /(^|\/)(?:node_modules|\.git|\.svn|\.hg|dist|build|out|output|target|vendor|Pods|Carthage|coverage|__pycache__|\.venv|venv|env|\.tox|\.mypy_cache|\.pytest_cache|\.gradle|\.idea|\.vscode|docs?|examples?|samples?|demo|tests?|testing|__tests__|__mocks__|\.next|\.nuxt)(\/|$)/i;
const SKIP_FILE = /(?:^\.|\.min\.(?:js|css)$|\.d\.ts$|\.map$|lock\.(?:json|yaml)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock)$)/i;

// 形如 ("GET", "/v1/charges") / ('POST', f"/x") / ("GET", `/x/${id}`) 的方法 + 路径相邻对：
// 跨语言最强的「这里真有个接口」的信号
const PAIR_HINT = /["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*[fFrRbBuU]{0,2}["'`]/;
// 调用点痕迹：axios/requests/OkHttp/Retrofit/Spring/Go http 客户端
const CALL_HINT = /(?:\.(?:get|post|put|patch|delete|head|options|request|fetch|send)\s*[(`]|urlopen\s*\(|http\.NewRequest|HttpRequest\.newBuilder|RestTemplate|webClient\.)/;
// 注解即接口定义：Retrofit @GET("orders/{id}")、Spring @GetMapping、FastAPI @app.get(...)
// —— 这类文件里没有「方法名 + 路径」相邻对，必须单独给强信号，否则 Java/Python 客户端会被漏掉
const ANNOTATION_HINT = /(?:@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@[\w.]+\.(?:get|post|put|patch|delete|head|options)\s*\()/;
// 生成式 Python SDK 的写法：同一次调用的参数块里 method="POST" 与 uri="/v4/..." 分隔在不同行
const PY_PARAM_HINT = /["']?\bmethod["']?\s*[=:]\s*["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/i;
const PY_PATH_KV = /["']?\b(?:gateway_uri|uri|path|url|api_path)\b["']?\s*[=:]\s*["'][/]/i;
// 服务地址常量（含类型注解写法 DEFAULT_API_BASE: str = "https://…"）
const BASE_HINT = /(?:BASE_URL|BASEURL|baseURL|baseUrl|API_BASE|api_base|base_url|DEFAULT_HOST|API_HOST|SERVER_URL|DEFAULT_API_BASE|API_URL|END_POINT|ENDPOINT|HOST)\s*(?::\s*[\w[\]. ]{1,40})?[:=]\s*["'][^"']{6,200}["']/;
// 直接给配置 JSON 的包（{ operations: [...] } 或 OpenAPI）
const CONFIG_HINT = /["'](?:operations|paths)["']\s*:|["']openapi["']\s*:|["']baseUrl["']\s*:/;
const NAME_HINT = /(client|api|service|resource|endpoint|http|transport|request|gateway|connector|sdk)/i;
const AGGREGATOR = /(?:^|[\/_.-])(?:index|mod|__init__|types?|package|constants?|errors?|exceptions?)\.[a-z]+$/i;

const archiveKind = name => {
  const m = String(name || '').match(ARCHIVE_EXT);
  if (!m) return null;
  return m[1].toLowerCase() === 'zip' ? 'zip' : 'tar';
};
const prettyMB = n => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + 'MB';

/* ───────── 解压 ───────── */
function run(cmd, args, timeout = UNPACK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout || ''));
      const raw = String(stderr || stdout || err.message || '');
      if (err.code === 'ENOENT') {
        return reject(Object.assign(new Error(cmd === 'unzip'
          ? '系统里没有 unzip 命令，无法解压 .zip（macOS / Linux 一般自带；也可以用「文件夹」导入解压后的目录）'
          : '系统里没有 tar 命令，无法解压该压缩包'), { code: 'NO_TOOL' }));
      }
      if (err.killed) return reject(new Error(`解压超时（>${Math.round(timeout / 1000)}s），压缩包可能过大`));
      const line = raw.split(/\r?\n/).filter(l => /error|denied|not found|unsupported|corrupt|invalid|truncat/i.test(l)).slice(-1)[0]
        || raw.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '解压失败';
      reject(new Error('解压失败：' + line.trim().slice(0, 200)));
    });
  });
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return out;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isSymbolicLink()) continue;                       // 不跟随软链，防越界
    if (e.isDirectory()) {
      if (SKIP_DIR.test('/' + rel)) continue;
      walk(full, base, out);
    } else if (e.isFile()) {
      out.push({ full, rel });
    }
  }
  return out;
}

/* ───────── 打分与挑选 ───────── */
function scoreFile(rel, text) {
  let score = 0;
  if (PAIR_HINT.test(text) || ANNOTATION_HINT.test(text) || (PY_PARAM_HINT.test(text) && PY_PATH_KV.test(text))) score += 10;
  if (CALL_HINT.test(text)) score += 7;   // 有调用痕迹但没有「方法+路径」对的客户端（this.post('/x', ...)）也要能进
  if (/\.json$/i.test(rel) && CONFIG_HINT.test(text)) score += 20;   // 纯配置包也能直接识别
  if (/["'`]\//.test(text)) score += 1;
  if (NAME_HINT.test(path.basename(rel))) score += 3;
  if (AGGREGATOR.test(rel)) score -= 2;
  return score;
}

function safeBaseName(rel) {
  return rel.replace(/[\\/]+/g, '_').replace(/[^\w.-]+/g, '_').slice(-80);
}

/**
 * 从解压目录里挑出用于解析的源码：
 *  - 只要有接口痕迹（score ≥ 10）或配置 JSON 的文件
 *  - 额外优先带 1~2 个含服务地址字面量的文件（它们常常没有调用点，但定义着 baseUrl）
 *  - 单文件 / 总量 / 数量上限，按「命中强度 → 体积」排序
 */
function pickFiles(dir) {
  const all = walk(dir);
  let unpackedBytes = 0;
  const scanned = [];
  for (const f of all) {
    let st;
    try { st = fs.statSync(f.full); } catch { continue; }
    unpackedBytes += st.size;
    if (unpackedBytes > MAX_UNPACK_BYTES) {
      throw new Error(`解压后体积超过 ${prettyMB(MAX_UNPACK_BYTES)}，请只打包 SDK 客户端那一层目录`);
    }
    if (!SRC_EXT.test(f.rel) || SKIP_FILE.test(f.rel)) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    let text;
    try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    if (!text.trim() || text.includes('\0')) continue;        // 二进制 / 空文件
    scanned.push({ rel: f.rel, text, score: scoreFile(f.rel, text), bytes: Buffer.byteLength(text) });
  }

  const hits = scanned.filter(f => f.score >= 10).sort((a, b) => (b.score - a.score) || (a.bytes - b.bytes));
  if (!hits.length && !scanned.length) {
    throw new Error('压缩包里没有可解析的源码文件（支持 .ts/.js/.py/.java/.kt/.go/.json）');
  }
  // 一个「接口痕迹」都没有时（典型是基础库 / 框架包：只有 client 封装、鉴权、序列化）：
  // 退化成按体积挑最小的若干源码 —— parseSDK 会返回 0 接口，但符号已从全量源码抽出，
  // 上层据此提供「仅资料导入」，而不是把整个包判死
  const pool = hits.length ? hits : scanned.slice().sort((a, b) => a.bytes - b.bytes);

  const chosen = [], used = new Set();
  let bytes = 0;
  const push = f => {
    if (chosen.length >= MAX_FILES) return;
    const name = safeBaseName(f.rel);
    if (used.has(name)) return;
    if (bytes + f.bytes > MAX_TOTAL_BYTES) return;
    used.add(name); bytes += f.bytes;
    chosen.push({ name, text: f.text, path: f.rel, bytes: f.bytes });
  };
  // baseUrl 线索文件先占位，否则 80 个配额会被接口文件占满，服务地址永远识别不到
  const baseFiles = scanned.filter(f => BASE_HINT.test(f.text)).sort((a, b) => a.bytes - b.bytes).slice(0, 2);
  for (const f of baseFiles) push(f);
  for (const f of pool) push(f);

  return {
    files: chosen.map(f => ({ name: f.name, text: f.text, path: f.path })),
    // 资料库覆盖「整个包」而不只是挑中的 80 个文件：model / 枚举 / 工具函数这些不会
    // 出现在接口清单里，但后续智能体搭流程时经常要查（字段含义、分页参数、重试封装）
    materials: extractSymbols(scanned.map(f => ({ name: f.rel, text: f.text }))),
    stats: {
      sourceFiles: scanned.length, selected: chosen.length,
      bytes, unpackedBytes, entries: all.length, skipped: all.length - chosen.length,
    },
  };
}

/* ───────── 临时目录清理（沙箱对单轮批量删除有阈值，删不动就改名让路） ───────── */
function disposeDir(dir) {
  const attempt = (p, n) => {
    try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { /* 交给下一轮 */ }
    if (n <= 1) return;
    const t = setTimeout(() => attempt(p, n - 1), 20000);
    if (t.unref) t.unref();
  };
  try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* 文件多时会命中阈值 */ }
  const trash = dir + '.trash-' + Date.now();
  try { fs.renameSync(dir, trash); } catch { return; }          // 改名不被拦，先让路
  const t = setTimeout(() => attempt(trash, 4), 20000);
  if (t.unref) t.unref();
}

/**
 * @param {Buffer} buf      压缩包内容
 * @param {string} filename 原始文件名（决定用哪种解压命令）
 * @returns {Promise<{files:Array<{name:string,text:string}>, stats:object}>}
 */
async function extractArchive(buf, filename) {
  const kind = archiveKind(filename);
  if (!kind) throw new Error('只支持 .zip / .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz 压缩包');
  if (!buf || !buf.length) throw new Error('压缩包是空的，无法解析');
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`压缩包 ${prettyMB(buf.length)} 超过 ${prettyMB(MAX_ARCHIVE_BYTES)} 上限，请只打包 SDK 客户端目录`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apiflow-arc-'));
  const out = path.join(dir, 'unpacked');
  const file = path.join(dir, kind === 'zip' ? 'archive.zip' : 'archive.tar');
  try {
    fs.writeFileSync(file, buf);
    fs.mkdirSync(out);
    if (kind === 'zip') await run('unzip', ['-qq', '-o', file, '-d', out]);
    else await run('tar', ['-xf', file, '-C', out]);          // GNU tar / bsdtar 都能自动识别压缩
    const picked = pickFiles(out);
    if (!picked.files.length) throw new Error('压缩包里没有可解析的源码文件');
    return {
      files: picked.files,
      materials: picked.materials,
      stats: { ...picked.stats, kind, archiveBytes: buf.length },
    };
  } finally {
    disposeDir(dir);
  }
}

module.exports = { extractArchive, archiveKind, pickFiles, scoreFile, MAX_ARCHIVE_BYTES, MAX_FILES };

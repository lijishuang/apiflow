'use strict';
/**
 * pip 导入：真正执行一次 `python -m pip install --target <临时目录>`，
 * 再从装好的包源码里挑出「带 HTTP 调用」的文件，交给 lib/sdk.js 解析成接口清单。
 *
 * 设计要点：
 *  - 用 execFile + 参数数组执行 pip（不经过 shell），包名再做白名单校验，杜绝命令注入
 *  - 默认 --no-deps：只要 SDK 自身代码，避免把整棵依赖树搬进来
 *  - 装完即删临时目录，只把筛选后的源码交给上层落盘（data/sdk/<来源id>）
 *  - 并发上限 2，防止多人同时导入把磁盘和网络打满
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PY = process.env.APIFLOW_PYTHON || process.env.PIP_PYTHON || 'python3';
const MAX_FILES = 80;                        // 最多取多少个源码文件参与解析
const MAX_FILE_BYTES = 2 * 1024 * 1024;      // 单文件 2MB
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;     // 送解析的总量 6MB
const MAX_INSTALL_BYTES = 150 * 1024 * 1024; // 装出来的体积上限（含依赖时兜底）
const DEFAULT_TIMEOUT = 180000;

/* ───────── 包名校验 ───────── */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,79})$/;
const SPEC_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,79})(?:\[[A-Za-z0-9._,\s-]{0,80}\])?(?:(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9._+*!-]{1,40})*$/;

function normalizeSpec(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('请填写要安装的 Python 包名，例如 stripe==11.4.1');
  if (s.length > 200) throw new Error('包名太长（上限 200 字符）');
  if (/[;&|`$'"<>\n\r\t\0]/.test(s)) throw new Error('包名包含非法字符（不允许空格、引号、分号等）');
  if (s.startsWith('-')) throw new Error('包名不能以 - 开头（会被 pip 当成参数）');
  if (/^git\+(?:https?|ssh):\/\/\S+$/.test(s)) return { spec: s, name: null, version: null, kind: 'vcs' };
  if (/^https?:\/\/\S+\.(?:whl|tar\.gz|zip)(?:\?\S*)?$/i.test(s)) return { spec: s, name: null, version: null, kind: 'url' };
  if (/^https?:\/\//i.test(s)) throw new Error('远程地址只支持 .whl / .tar.gz / .zip 安装包，或 git+https:// 仓库地址');
  if (!SPEC_RE.test(s)) throw new Error('包名格式不正确：支持 name、name==1.2.3、name[extra]>=1.0 这几种写法');
  const name = s.split(/[\[=<>!~]/)[0];
  const pin = (s.match(/==\s*([A-Za-z0-9._+*!-]+)/) || [])[1] || null;
  return { spec: s, name, version: pin, kind: 'pypi' };
}

function normalizeIndex(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new Error('私有源地址必须以 http:// 或 https:// 开头');
  if (s.length > 300) throw new Error('私有源地址太长');
  return s;
}

/* ───────── 并发闸（最多同时装 2 个） ───────── */
let _running = 0;
const _queue = [];
async function withSlot(fn) {
  if (_running >= 2) await new Promise(r => _queue.push(r));
  _running++;
  try { return await fn(); }
  finally {
    _running--;
    const next = _queue.shift();
    if (next) next();
  }
}

/* ───────── 环境探测 ───────── */
let _envCache = null;
function pipEnv(force) {
  if (_envCache && !force && Date.now() - _envCache.at < 60000) return Promise.resolve(_envCache.data);
  return new Promise(resolve => {
    execFile(PY, ['-m', 'pip', '--version'], { timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const line = String(stdout || '').trim();
      const m = line.match(/^pip\s+([\w.]+)\s+from\s+(.+?)\s+\(python\s+([\w.]+)\)/);
      const data = m
        ? { ok: true, python: PY, pip: m[1], pythonVersion: m[3], location: m[2] }
        : { ok: false, python: PY, pip: null, pythonVersion: null, location: null, error: err ? shortErr(err) : '未检测到 pip（试着运行 ' + PY + ' -m pip --version）' };
      _envCache = { at: Date.now(), data };
      resolve(data);
    });
  });
}

/* ───────── 执行 pip ───────── */
function shortErr(src) {
  const txt = String(src || '');
  const line = txt.split(/\r?\n/).filter(l => /error|错误|denied|timeout|not found|no matching|could not/i.test(l)).slice(-1)[0];
  return (line || txt.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '执行失败').trim().slice(0, 240);
}
function friendlyPipError(stderr, spec) {
  const t = String(stderr || '');
  if (/No matching distribution found|Could not find a version that satisfies/i.test(t)) return `PyPI 上找不到「${spec}」这个包/版本，请检查包名或版本号`;
  if (/Could not find an activated virtualenv|externally-managed-environment/i.test(t)) return '当前 Python 拒绝写入（externally-managed），请用 venv 或设置 APIFLOW_PYTHON 指向可写的解释器';
  if (/Temporary failure in name resolution|proxy|SSL|Connection|timed out|timeout|Failed to establish/i.test(t)) return '拉取包时网络异常（可配置私有源，或检查代理 / 网络连通性）';
  if (/is not a valid editable requirement|Invalid requirement/i.test(t)) return `pip 无法识别「${spec}」，请检查写法`;
  if (/Permission denied/i.test(t)) return '安装时无写入权限，请检查临时目录权限';
  if (/error: subprocess-exited-with-error|BackendUnavailable|Failed building wheel/i.test(t)) return `「${spec}」需要本地编译（该版本只提供源码包），建议改用一个已发布 wheel 的版本，或换用「上传文件 / 粘贴代码」导入`;
  return shortErr(t) || 'pip 安装失败';
}

function runPip(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(PY, ['-m', 'pip', ...args], {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) { const e = new Error(friendlyPipError(stderr || stdout, args[args.length - 1])); e.raw = String(stderr || stdout || err.message); return reject(e); }
      resolve({ stdout, stderr });
    });
  });
}

/* ───────── 目录扫描 ───────── */
const SKIP_DIR = /(^|[\\/])(?:tests?|testing|__pycache__|node_modules|docs?|examples?|samples?|benchmarks?|\.git|\.mypy_cache|\.pytest_cache)([\\/]|$)/i;
const SKIP_FILE = /(?:^test_.*\.py$|.*_test\.py$|^conftest\.py$|^setup\.py$|^noxfile\.py$)/i;

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (e.name.endsWith('.dist-info') || e.name.endsWith('.egg-info') || e.name === '.data') continue;
      if (SKIP_DIR.test('/' + rel)) continue;
      walk(full, base, out);
    } else if (e.isFile()) {
      if (!/\.pyi?$/i.test(e.name)) continue;
      if (SKIP_FILE.test(e.name)) continue;
      out.push({ full, rel: rel.split(path.sep).join('/') });
    }
  }
  return out;
}

// 形如 ("GET", "/v1/charges") 的「方法 + 路径」相邻对，是判断文件是否真有接口的最强信号
const PAIR_HINT = /["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|get|post|put|patch|delete|head|options)["']\s*,\s*[fFrRbBuU]{0,2}["'`]/;
const CALL_HINT = /(?:_request|requests\.(?:get|post|put|patch|delete|request)|httpx\.(?:get|post|put|patch|delete|request|Client|AsyncClient)|session\.(?:get|post|put|patch|delete|request)|urlopen|http\.NewRequest|@[\w.]+\.(?:get|post|put|patch|delete)\s*\()/;
// 允许带类型注解的写法：DEFAULT_API_BASE: str = "https://api.stripe.com"
const BASE_HINT = /(?:BASE_URL|BASEURL|baseURL|baseUrl|API_BASE|api_base|base_url|DEFAULT_HOST|API_HOST|SERVER_URL|DEFAULT_API_BASE|API_URL|END_POINT|ENDPOINT)\s*(?::\s*[\w[\]. ]{1,40})?[:=]\s*["'][^"']{6,200}["']/;
const NAME_HINT = /(service|client|api|resource|endpoint|http|transport|request|gateway|connector)/i;

function scoreFile(rel, text) {
  let score = 0;
  if (PAIR_HINT.test(text)) score += 10;
  if (CALL_HINT.test(text)) score += 4;
  if (/["'`]\//.test(text)) score += 1;
  if (NAME_HINT.test(path.basename(rel))) score += 3;
  if (/(?:^|_)__init__\.py$/.test(path.basename(rel))) score -= 2;
  return score;
}

/**
 * 从装好的目录里挑出用于解析的文件：
 *  - 只保留有 HTTP 调用痕迹的文件（没有痕迹的包直接报错提示换方式导入）
 *  - 额外带上 1~2 个含服务地址字面量的文件，让 baseUrl 能被识别
 *  - 单文件/总量/数量都有上限，按「命中强度 + 体积」优先
 */
function pickFiles(dir) {
  const all = walk(dir);
  const scanned = [];
  let totalBytes = 0;
  for (const f of all) {
    let st;
    try { st = fs.statSync(f.full); } catch { continue; }
    totalBytes += st.size;
    if (st.size > MAX_FILE_BYTES) continue;
    let text;
    try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    if (!text.trim()) continue;
    if (text.includes('\0')) continue;                         // 二进制误判
    scanned.push({ name: f.rel, text, score: scoreFile(f.rel, text), bytes: Buffer.byteLength(text) });
  }
  const hits = scanned.filter(f => f.score >= 10).sort((a, b) => (b.score - a.score) || (b.bytes - a.bytes));
  if (!hits.length && !scanned.length) {
    throw new Error('这个包里没有识别到 HTTP 接口调用（可能只是协议/工具库）。可以勾选「包含依赖」再试，或改用上传文件 / 粘贴代码');
  }
  const pool = hits.length ? hits : scanned.slice().sort((a, b) => a.bytes - b.bytes);
  const chosen = [], names = new Set();
  let bytes = 0;
  const push = f => {
    if (chosen.length >= MAX_FILES || names.has(f.name)) return;
    if (bytes + f.bytes > MAX_TOTAL_BYTES) return;
    names.add(f.name); bytes += f.bytes; chosen.push(f);
  };
  // 先放 baseUrl 线索文件（通常没有接口调用，但写着服务地址），再放接口文件 ——
  // 否则 80 个配额被接口文件占满，服务地址就永远识别不到
  const baseFiles = scanned.filter(f => BASE_HINT.test(f.text)).sort((a, b) => a.bytes - b.bytes).slice(0, 2);
  for (const f of baseFiles) push(f);
  for (const f of pool) push(f);

  return {
    files: chosen.map(f => ({ name: f.name.replace(/\//g, '_'), text: f.text })),
    stats: {
      pyFiles: all.length, scanned: scanned.length, selected: chosen.length,
      bytes, totalBytes, skipped: all.length - chosen.length,
    },
  };
}

/* ───────── .dist-info/METADATA → 包信息 ───────── */
function readMetadata(dir, wantName) {
  let dirs = [];
  try { dirs = fs.readdirSync(dir).filter(n => n.endsWith('.dist-info')); } catch { return null; }
  if (!dirs.length) return null;
  const pickDir = wantName
    ? dirs.find(d => d.toLowerCase().startsWith(String(wantName).toLowerCase().replace(/-/g, '_'))) || dirs[0]
    : dirs[0];
  let txt = '';
  try { txt = fs.readFileSync(path.join(dir, pickDir, 'METADATA'), 'utf8'); } catch { return null; }
  const head = txt.split(/\r?\n\r?\n/)[0] || '';
  const get = k => {
    const m = head.match(new RegExp('^' + k + ':\\s*(.+)$', 'mi'));
    return m ? m[1].trim() : null;
  };
  const urls = [...head.matchAll(/^Project-URL:\s*(.+)$/gmi)].map(m => m[1].trim());
  return {
    name: get('Name'), version: get('Version'), summary: get('Summary'),
    homepage: get('Home-page'), author: get('Author'), license: get('License'),
    requiresPython: get('Requires-Python'),
    requiresDist: (head.match(/^Requires-Dist:/gmi) || []).length,
    projectUrls: urls.slice(0, 4),
    distInfo: pickDir,
  };
}

/* ───────── 主流程 ───────── */
function rmTrash(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 留给系统清理 */ } }

async function installAndCollect({ package: rawSpec, indexUrl, withDeps, timeoutMs, name } = {}) {
  const spec = normalizeSpec(rawSpec);
  const idx = normalizeIndex(indexUrl);
  const timeout = Math.min(600000, Math.max(30000, Number(timeoutMs) || DEFAULT_TIMEOUT));

  return withSlot(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apiflow-pip-'));
    const t0 = Date.now();
    try {
      const args = ['install', '--no-input', '--disable-pip-version-check', '--upgrade', '--target', dir];
      if (!withDeps) args.push('--no-deps');
      if (idx) args.push('--index-url', idx);
      args.push(spec.spec);
      const { stdout } = await runPip(args, timeout);

      const pkg = readMetadata(dir, spec.name) || {};
      const root = (pkg.name || spec.name || '').toLowerCase();
      const picked = pickFiles(dir);
      if (picked.stats.totalBytes > MAX_INSTALL_BYTES) {
        throw new Error(`装出来的包体积 ${(picked.stats.totalBytes / 1048576).toFixed(1)}MB 过大，请取消「包含依赖」或换用其他导入方式`);
      }
      return {
        spec: spec.spec, specName: spec.name || pkg.name || null,
        indexUrl: idx, withDeps: !!withDeps,
        pkg: {
          name: pkg.name || spec.name || null,
          version: pkg.version || spec.version || null,
          summary: pkg.summary || null,
          homepage: pkg.homepage || null,
          author: pkg.author || null,
          license: pkg.license || null,
          requiresDist: pkg.requiresDist || 0,
          projectUrls: pkg.projectUrls || [],
        },
        files: picked.files,
        stats: { ...picked.stats, installMs: Date.now() - t0, root },
        log: String(stdout || '').split(/\r?\n/).filter(Boolean).slice(-4),
      };
    } finally {
      // 临时目录同样可能撞上批量删除阈值：删不动就改名让路，30 秒后重试一次（/tmp 最终由系统回收）
      const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; } };
      if (!rm()) {
        const trash = dir + '.trash-' + Date.now();
        try { fs.renameSync(dir, trash); } catch { return; }
        const t = setTimeout(() => rmTrash(trash), 30000);
        if (t.unref) t.unref();
      }
    }
  });
}

module.exports = { installAndCollect, normalizeSpec, normalizeIndex, pipEnv, MAX_FILES };

// ── OpenAPI / Swagger → 工具注册表 operation ──
// 前端「接入接口」= 上传地址 / 粘贴文档 / 手填一条，最终都落到本模块产出 operation
const crypto = require('crypto');

// 稳定序列化（键排序）——保证同一份 spec 每次算出的指纹一致
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const hash = v => crypto.createHash('sha1').update(stable(v)).digest('hex');

// 本地 $ref（#/components/...）解引用，最多 6 层
function deref(spec, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return node;
  const r = node.$ref;
  if (typeof r === 'string' && r.startsWith('#/')) {
    let cur = spec;
    for (const seg of r.slice(2).split('/')) {
      cur = cur && cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (cur === undefined) return null;
    }
    return deref(spec, cur, depth + 1);
  }
  return node;
}

function pickBase(spec) {
  const s = spec.servers && spec.servers[0] && spec.servers[0].url;
  if (s) return String(s).replace(/\/+$/, '');
  if (spec.host) {
    const scheme = (spec.schemes && spec.schemes[0]) || 'https';
    return `${scheme}://${spec.host}${spec.basePath || ''}`.replace(/\/+$/, '');
  }
  return '';
}

// 按 schema 造一个可用的示例请求体（不做完整 JSON-Schema 推导，够生成草稿即可）
function example(spec, schema, depth = 0) {
  schema = deref(spec, schema);
  if (!schema || depth > 4) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = schema.type || (schema.properties ? 'object' : null);
  if (t === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const x = example(spec, v, depth + 1);
      if (x !== null) o[k] = x;
    }
    return o;
  }
  if (t === 'array') return [example(spec, schema.items, depth + 1) ?? ''];
  if (t === 'string') return schema.format === 'date' ? new Date().toISOString().slice(0, 10) : '';
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return false;
  return null;
}

const uniq = a => [...new Set(a.map(x => String(x || '').trim()).filter(Boolean))];

function buildOperation(spec, rawPath, method, raw, pathItem, ctx) {
  const params = [...(pathItem.parameters || []), ...(raw.parameters || [])].map(p => deref(spec, p)).filter(Boolean);
  const pathParams = params.filter(p => p.in === 'path').map(p => p.name);
  const queryParams = params.filter(p => p.in === 'query' && p.required).map(p => p.name);
  // 必填 query 直接拼成模板，运行时由引擎替换成真实值
  const fullPath = rawPath + (queryParams.length ? '?' + queryParams.map(n => `${n}={${n}}`).join('&') : '');

  let bodySchema = null;
  const rb = deref(spec, raw.requestBody);
  if (rb) {
    const content = rb.content || {};
    const media = content['application/json'] || content[Object.keys(content)[0]];
    bodySchema = media && media.schema ? deref(spec, media.schema) : null;
  }
  if (!bodySchema) {                                     // Swagger 2.0：body 参数
    const b = params.find(p => p.in === 'body');
    if (b && b.schema) bodySchema = deref(spec, b.schema);
  }

  const id = String(raw.operationId || `${method}_${rawPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`);
  const name = String(raw.summary || raw.description || raw.operationId || `${method.toUpperCase()} ${rawPath}`).slice(0, 40);
  const keywordSource = [
    raw.summary, raw.operationId, ...(raw.tags || []),
    rawPath.split('/').filter(Boolean).pop(),
    ...pathParams,
  ];
  // 中文描述按标点切成短语，让自然语言更容易命中
  const fromDesc = String(raw.description || '').split(/[，。；、,.;:：\s]+/).filter(w => w.length >= 2 && w.length <= 8);

  const op = {
    id,
    name,
    method: method.toUpperCase(),
    path: fullPath,
    version: ctx.version,
    readOnly: /^(GET|HEAD)$/.test(method.toUpperCase()),
    keywords: uniq([...keywordSource, ...fromDesc]).filter(k => !/[{}]/.test(k)).slice(0, 14),
    params: uniq([...pathParams, ...queryParams]),
    description: String(raw.description || raw.summary || '').slice(0, 160),
    baseUrl: ctx.baseUrl,                 // 每个来源可以有自己的服务地址
    sourceId: ctx.sourceId,
  };
  if (bodySchema) {
    op.bodySchema = bodySchema;
    const ex = example(spec, bodySchema);
    if (ex && typeof ex === 'object') op.bodyExample = ex;
  }
  // 接口内容指纹：不含 version —— 版本号常被人为忽略，指纹才是真相
  op.hash = hash({ method: op.method, path: rawPath, params: op.params, body: bodySchema || null });
  return op;
}

function parseOpenAPI(spec, opts = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('不是合法的 OpenAPI 文档（应为 JSON 对象）');
  if (!spec.paths || typeof spec.paths !== 'object') throw new Error('文档缺少 paths 字段，无法识别接口');
  const info = spec.info || {};
  const ctx = {
    version: String(info.version || opts.defaultVersion || 'v1'),
    baseUrl: pickBase(spec) || opts.fallbackBaseUrl || '',
    sourceId: opts.sourceId || null,
  };
  const operations = [];
  for (const [p, item0] of Object.entries(spec.paths)) {
    const item = deref(spec, item0);
    if (!item || typeof item !== 'object') continue;
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (!item[m]) continue;
      operations.push(buildOperation(spec, p, m, item[m], item, ctx));
    }
  }
  if (!operations.length) throw new Error('文档里没有可用的接口（paths 为空）');
  return {
    title: String(info.title || opts.name || '未命名接口文档').slice(0, 40),
    version: ctx.version,
    baseUrl: ctx.baseUrl,
    description: String(info.description || '').slice(0, 160),
    operations,
  };
}

// 手工添加一条接口（前端表单）
function parseManual(form, opts = {}) {
  const method = String(form.method || 'GET').toUpperCase();
  let p = String(form.path || '').trim();
  if (!p) throw new Error('接口路径不能为空');
  if (!p.startsWith('/')) p = '/' + p;
  const id = String(form.id || `${method.toLowerCase()}_${p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`);
  const name = String(form.name || id).slice(0, 40);
  let bodyExample = null, bodySchema = null;
  if (form.bodyExample) {
    try { bodyExample = JSON.parse(form.bodyExample); bodySchema = { type: 'object' }; }
    catch { throw new Error('请求体示例不是合法 JSON'); }
  }
  return {
    id, name, method, path: p,
    version: String(form.version || opts.defaultVersion || 'manual'),
    readOnly: /^(GET|HEAD)$/.test(method),
    keywords: uniq([...(form.keywords || '').split(/[,，\s]+/), name, p.split('/').filter(Boolean).pop()]),
    params: [...p.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    description: String(form.description || '').slice(0, 160),
    baseUrl: String(form.baseUrl || opts.fallbackBaseUrl || '').replace(/\/+$/, ''),
    sourceId: opts.sourceId || null,
    ...(bodySchema ? { bodySchema, bodyExample } : {}),
    hash: hash({ method, path: p, body: bodyExample }),
  };
}

module.exports = { parseOpenAPI, parseManual, stableHash: hash };

// ── 接口参数提示（Query / 表单参数）──
// 为什么需要它：SDK 生成的客户端方法签名往往是 f(self, xxx_request)，真正的 query 字段藏在
// model/<op>_query.py 的 setter 里 —— 只扫「方法 + 路径」的导入器看不到，于是接口清单里的
// params 是空的。等到真跑起来，网关才用 {"code":"010024","message":"参数校验异常,poolId"}
// 一个参数一个参数地告诉你还缺什么。
// 这里把两边拼起来：
//   ① SDK 资料库里 <Op>Query 类的 setter 字段（参数全集 + 中文名）
//   ② 运行期学到的必填项 / 可用取值（data/paramhints.json，来自真实网关的报错与成功回包）
// 结果供三处使用：搭建器自动填参、节点属性面板的参数候选、运行失败时的可读提示。
const { loadMaterials } = require('./materials');

// 常见字段的中文名（覆盖面按经验补，未收录的用 humanize 兜底）
const CN = {
  poolId: '资源池 ID', basePoolIds: '基础资源池', productType: '产品类型', region: '区域',
  pageNum: '页码', pageSize: '每页条数', keyword: '关键字', parentId: '父资源 ID',
  resourceId: '资源 ID', resourceName: '资源名称', ipList: 'IP 列表', orderBy: '排序字段',
  startTime: '开始时间', endTime: '结束时间', timeRange: '时间范围', metricName: '指标名',
  namespace: '命名空间', instanceId: '实例 ID', tenantId: '租户 ID', projectId: '项目 ID',
  status: '状态', type: '类型', name: '名称', id: 'ID', ids: 'ID 列表',
  offset: '偏移量', limit: '条数上限', sort: '排序', filter: '过滤条件',
};

// 自然语言里怎么说这些字段（「资源池：CIDC-RP-29」→ poolId）
const SYNONYM = {
  poolId: ['资源池', '资源池id', '资源池编号', '集群', 'pool', 'poolid', 'pool_id'],
  basePoolIds: ['基础资源池', 'basepoolids', 'base_pool_ids'],
  productType: ['产品类型', '产品类别', '资源类型', 'product', 'producttype', 'product_type'],
  region: ['区域', '地域', 'region'],
  pageNum: ['页码', '第几页', 'pagenum', 'page_num', 'page'],
  pageSize: ['每页条数', '分页大小', '每页', 'pagesize', 'page_size', 'size'],
  keyword: ['关键字', '关键词', '搜索词', 'keyword', 'key'],
  parentId: ['父资源', '父节点', 'parentid', 'parent_id'],
  resourceId: ['资源id', '资源编号', 'resourceid', 'resource_id'],
  startTime: ['开始时间', '起始时间', 'starttime', 'start_time'],
  endTime: ['结束时间', '截止时间', 'endtime', 'end_time'],
};

const camelize = s => String(s || '')
  .replace(/[_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
  .replace(/^[A-Z]/, c => c.toLowerCase());

const pascal = s => {
  const c = camelize(s);
  return c ? c[0].toUpperCase() + c.slice(1) : '';
};
const humanize = s => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
const labelOf = name => CN[name] || humanize(name);

const SKIP_SETTER = /^(?:to_dict|to_str|to_json|from_dict|serialize|deserialize|__init__|__repr__)$/i;

// 从 SDK 资料里找 <Op>Query 类的 setter 字段
function sdkQueryFields(srcId, opId) {
  if (!srcId || srcId === 'builtin') return [];
  const data = loadMaterials(srcId);
  if (!data || !Array.isArray(data.symbols)) return [];
  const want = (pascal(opId) + 'Query').toLowerCase();
  const classes = data.symbols.filter(s => s.kind === 'class' && /query$/i.test(s.name));
  let cls = classes.find(s => s.name.toLowerCase() === want);
  if (!cls) {
    // 版本后缀之类的变体：list_resource_v2_query → ListResourceV2Query 已覆盖；
    // 再退一步按「去掉尾部数字后的前缀」匹配，避免 _v2/_v3 版本漂移导致完全找不到
    const stem = want.replace(/v\d+query$/, '');
    cls = classes.find(s => s.name.toLowerCase().replace(/v\d+query$/, '') === stem);
  }
  if (!cls) return [];
  const seen = new Set(), out = [];
  for (const s of data.symbols) {
    if (s.kind !== 'method' || s.parent !== cls.name) continue;
    if (!Array.isArray(s.params) || s.params.length !== 2) continue;   // (self, value) 才是 setter
    if (SKIP_SETTER.test(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ sdkName: s.name, name: camelize(s.name), label: labelOf(camelize(s.name)) });
  }
  return out;
}

/**
 * 某个接口的 query 参数清单（SDK 字段 ∪ 运行期学到的必填/示例）。
 * @param {object} op     注册表里的接口
 * @param {object} store  存储层（可空；为空则只给 SDK 字段）
 */
function fieldsOf(op, store) {
  if (!op) return [];
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, { name, sdkName: '', label: labelOf(name), required: false, sample: null, rejected: [], source: 'learned' });
    return map.get(name);
  };
  // ① 接口定义里显式声明的 query（OpenAPI / 配置导入的接口可能有）
  for (const q of op.query || []) {
    const name = typeof q === 'string' ? q : q && q.name;
    if (!name) continue;
    const f = ensure(camelize(name));
    f.sdkName = name;
    f.label = (q && q.label) || labelOf(camelize(name));
    f.required = !!(q && q.required);
    f.source = 'spec';
  }
  // ② SDK 的 <Op>Query 类
  for (const f of sdkQueryFields(op.sourceId, op.id)) {
    const cur = ensure(f.name);
    cur.sdkName = cur.sdkName || f.sdkName;
    cur.label = CN[f.name] || cur.label;
    if (cur.source === 'learned') cur.source = 'sdk';
  }
  // ③ 运行期学习结果（真实网关说的才算数）
  const h = store && typeof store.getParamHint === 'function' ? store.getParamHint(op.id) : null;
  if (h) {
    for (const n of h.required || []) ensure(n).required = true;
    for (const [n, v] of Object.entries(h.sample || {})) if (v != null && String(v) !== '') ensure(n).sample = v;
    for (const [n, vs] of Object.entries(h.rejected || {})) if (Array.isArray(vs) && vs.length) ensure(n).rejected = vs.slice(-5);
  }
  return [...map.values()].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0) || a.name.localeCompare(b.name));
}

function aliasesOf(field) {
  const n = field.name, sn = field.sdkName;
  return [...new Set([n, sn, field.label, ...(SYNONYM[n] || []), n.toLowerCase()].filter(Boolean))];
}

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 在描述里找这个字段的取值：支持「资源池：CIDC-RP-29」「资源池是 CIDC-RP-29」「poolId=xx」
function matchValue(text, field) {
  const t = String(text || '');
  for (const a of aliasesOf(field)) {
    const A = escRe(a);
    const m = t.match(new RegExp(A + '\\s*(?:是|为|取|填|等于|设为)?\\s*[：:=＝]\\s*([^\\s，。；,;）)\\]】]+)', 'i'))
      || t.match(new RegExp(A + '\\s*(?:是|为|取|填|等于)\\s*([^\\s，。；,;）)\\]】]+)', 'i'))
      || t.match(new RegExp(A + '\\s+([A-Za-z0-9][\\w.:-]{1,60})', 'i'));
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

/**
 * 从一句自然语言里抽出这个接口的 query 取值。
 * @returns {{values:object, missing:Array<{name,label}>}}
 */
function slots(op, text, { store } = {}) {
  const values = {}, missing = [];
  for (const f of fieldsOf(op, store)) {
    const v = matchValue(text, f);
    if (v != null) {
      // 描述里点名了「不能是 X」之类的话不猜，只用正向取值
      if (f.rejected.includes(v)) continue;
      values[f.name] = v;
    } else if (f.required && f.sample) {
      values[f.name] = f.sample;                   // 学过的可用取值当默认值
    } else if (f.required) {
      missing.push({ name: f.name, label: f.label });
    }
  }
  return { values, missing };
}

module.exports = { fieldsOf, slots, sdkQueryFields, matchValue, aliasesOf, camelize, labelOf, CN, SYNONYM };

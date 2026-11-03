#!/bin/bash
# 数据映射面板回归：字段树推断 / 目标字段候选 / 同名自动匹配 / 取值预览
# 自己建夹具流程与运行记录，结尾清理，不动平台里的用户数据
B=http://127.0.0.1:3300
P=python3
pass=0; fail=0
chk() { if [ "$2" = "0" ]; then pass=$((pass+1)); else fail=$((fail+1)); fi; }
report() {   # 读 stdin 的 PASS/FAIL 行并累计
  while IFS= read -r line; do
    case "$line" in
      PASS*) echo "  ✓ ${line#PASS }"; pass=$((pass+1)) ;;
      FAIL*) echo "  ✗ ${line#FAIL }"; fail=$((fail+1)) ;;
    esac
  done
}

echo "══ A. 字段树推断（lib/schema.js 单测）══"
node - > /tmp/schema_test_a.txt 2>&1 <<'EOF'
const s = require('/Users/lijishuang/WorkBuddy/code/apiflow/lib/schema');
const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(extra)));

const out = { code: '000000', items: [{ id: 'A-1', amount: 199, tags: ['x'] }], meta: { nested: true }, empty: {} };
const t = s.buildTree(out);
const leaves = s.leavesOf(t.root);
const byPath = Object.fromEntries(leaves.map(l => [l.path, l]));

ok('顶层字段与类型', t.root.map(n => n.label + ':' + n.type).join(',') === 'code:string,items:array,meta:object,empty:object', t.root.map(n => n.label + ':' + n.type));
ok('数组带长度并取首元素展开', t.root.find(n => n.label === 'items').count === 1 && !!byPath['items.0.id'], byPath);
ok('嵌套对象递归到叶子', byPath['meta.nested'] && byPath['meta.nested'].sample === 'true', byPath['meta.nested']);
ok('空对象作为可映射叶子', !!byPath.empty && byPath.empty.sample === '{}', byPath.empty);
ok('叶子取值预览', byPath['items.0.amount'].sample === '199', byPath['items.0.amount']);
ok('长字符串预览截断', s.preview('x'.repeat(80)).endsWith('…') && s.preview('x'.repeat(80)).length <= 49, s.preview('x'.repeat(80)));

// 超大结构：必须截断，不能把弹窗撑爆
const big = {};
for (let i = 0; i < 80; i++) big['k' + i] = { a: 1, b: 2, c: 3 };
const bt = s.buildTree(big, 50);
ok('字段数量上限触发截断', bt.truncated === true && s.leavesOf(bt.root).length <= 60, { truncated: bt.truncated, n: s.leavesOf(bt.root).length });

const def = { nodes: [
  { id: 'a', config: { method: 'GET', url: 'x' } },
  { id: 'b', type: 'http', operationId: 'op1', config: { method: 'POST', url: 'y', body: { productName: '', note: '' }, query: { from: '' } } },
] };
const tg = s.targetsOf(def, 'b', [{ id: 'op1', params: [{ name: 'requiredThing', required: true }, 'plainParam'] }]);
const names = tg.map(x => x.name);
ok('目标字段取自 body/query', names.includes('productName') && names.includes('from'), names);
ok('目标字段合并接口参数', names.includes('requiredThing') && names.includes('plainParam'), names);
ok('必填参数带标记', tg.find(x => x.name === 'requiredThing').required === true, tg.find(x => x.name === 'requiredThing'));
EOF
report < /tmp/schema_test_a.txt

echo "══ B. 字段树接口（真实运行输出）══"
$P - > /tmp/schema_test_b.txt 2>&1 <<'PY'
import json, urllib.request, urllib.error
B = 'http://127.0.0.1:3300'
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(m, p, body=None):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json'})
    try:
        with op.open(req, timeout=30) as r: return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or '{}')
        except Exception: return e.code, {}
def ok(name, cond, extra=None):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  → ' + json.dumps(extra, ensure_ascii=False)[:300]))

FID = 'flow_mapsch'
call('DELETE', '/api/flows/' + FID)
DEF = {'id': FID, 'name': '映射字段夹具', 'version': 0, 'input': {'sample': {'seed': 1}}, 'nodes': [
    {'id': 'start', 'type': 'start', 'name': '开始', 'config': {}},
    {'id': 'src', 'type': 'http', 'name': '拉沙箱', 'config': {'method': 'GET', 'url': B + '/upstream/_sandbox'}},
    {'id': 'sink', 'type': 'http', 'name': '写回', 'config': {'method': 'POST', 'url': B + '/upstream/_sandbox',
                                                             'body': {'items': '', 'ok': ''}}}],
    'edges': [{'from': 'start', 'to': 'src'}, {'from': 'src', 'to': 'sink'}], 'layout': {}}
call('POST', '/api/flows/%s/draft' % FID, {'def': DEF})
st, dr = call('POST', '/api/flows/%s/dry-run' % FID, {})
ok('夹具 dry-run 成功', st == 200 and dr.get('status') == 'success', dr)

st, sc = call('GET', '/api/flows/%s/node-schema?nodeId=src&to=sink' % FID)
ok('接口返回 200', st == 200, sc)
ok('字段来源是真实运行', sc.get('source') == 'run' and sc.get('num'), {k: sc.get(k) for k in ('source', 'num', 'runId')})
labels = [f['label'] for f in sc.get('fields', [])]
ok('顶层字段含 ok / items', 'ok' in labels and 'items' in labels, labels)
paths = [l['path'] for l in sc.get('leaves', [])]
ok('数组元素可展开到叶子', 'items.0.id' in paths and 'items.0.amount' in paths, paths)
ok('下游目标字段候选', [t['name'] for t in sc.get('targets', [])] == ['items', 'ok'], sc.get('targets'))
ok('字段树未截断（小响应）', sc.get('truncated') is False, sc.get('truncated'))

st, sc2 = call('GET', '/api/flows/%s/node-schema?nodeId=start&to=src' % FID)
ok('开始节点也能给字段（流程输入）', st == 200 and any(l['path'] == 'seed' for l in sc2.get('leaves', [])), sc2.get('leaves'))

st, e404 = call('GET', '/api/flows/%s/node-schema?nodeId=nope' % FID)
ok('未知节点返回 404', st == 404, (st, e404))

# 从未运行过的流程：不能报错，要给「暂无数据」信号
EID = 'flow_mapsch_empty'
call('DELETE', '/api/flows/' + EID)
call('POST', '/api/flows/%s/draft' % EID, {'def': {'id': EID, 'name': '空夹具', 'version': 0,
    'nodes': [{'id': 'start', 'type': 'start', 'name': '开始', 'config': {}},
              {'id': 'x', 'type': 'http', 'name': '没跑过', 'config': {'method': 'GET', 'url': B + '/upstream/_sandbox'}}],
    'edges': [{'from': 'start', 'to': 'x'}], 'layout': {}}})
st, sc3 = call('GET', '/api/flows/%s/node-schema?nodeId=x&to=start' % EID)
ok('无运行记录时降级为 none', st == 200 and sc3.get('source') == 'none' and sc3.get('fields') == [], sc3)

call('DELETE', '/api/flows/' + FID)
call('DELETE', '/api/flows/' + EID)
PY
report < /tmp/schema_test_b.txt

echo "══ C. 前端映射逻辑（同名匹配 / 取值预览 / 字段树渲染）══"
node - > /tmp/schema_test_c.txt 2>&1 <<'EOF'
const fs = require('fs');
const src = fs.readFileSync('/Users/lijishuang/WorkBuddy/code/apiflow/public/app.js', 'utf8');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const grabFn = name => new RegExp('function ' + name + '\\([\\s\\S]*?\\n}').exec(src)[0];
const grabConst = name => new RegExp('const ' + name + ' = \\[[\\s\\S]*?\\];').exec(src)[0];
const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(extra)));

const state = { edgeCtx: null, edgeSchema: null };
const lookupPath = (obj, path) => String(path || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
eval(grabConst('EDGE_SYN').replace('const EDGE_SYN =', 'var EDGE_SYN ='));
eval(grabFn('edgeNormName'));
eval(grabFn('edgeSynGroup'));
eval(grabFn('edgeSuggestTarget'));
eval(grabFn('matchEdgeFields'));
eval(grabFn('evaluateEdgeExpr'));
eval(grabFn('edgePreviewText'));
eval(grabFn('edgeTreeHTML'));
eval(grabFn('edgeFilterTree'));

const leaves = [
  { path: 'code', name: 'code', type: 'string', sample: '000000' },
  { path: 'entity.0.id', name: 'id', type: 'string', sample: 'P-1' },
  { path: 'entity.0.productName', name: 'productName', type: 'string', sample: 'AI企哒' },
  { path: 'entity.0.title', name: 'title', type: 'string', sample: '标题' },
  { path: 'entity.0.createdAt', name: 'createdAt', type: 'string', sample: '2026-11-03' },
];
const targets = [
  { name: 'productName' }, { name: 'product_id' }, { name: 'name' }, { name: 'status' }, { name: 'code' },
];
const picked = matchEdgeFields(leaves, targets);
const map = Object.fromEntries(picked.map(p => [p.target, p.path]));
ok('① 完全同名优先', map.productName === 'entity.0.productName', map);
ok('② 归一化同名（product_id → productId 类）', map.code === 'code', map);
ok('③ 同义词兜底（name ← title）', map.name === 'entity.0.title', map);
ok('上游没有的字段不会硬凑', !('status' in map), map);
ok('同一上游字段不重复使用', new Set(picked.map(p => p.path)).size === picked.length, picked);

const synPicked = matchEdgeFields([{ path: 'state', name: 'state', type: 'string' }], [{ name: 'status' }]);
ok('同义词组 state → status', synPicked.length === 1 && synPicked[0].path === 'state', synPicked);

state.edgeCtx = { input: { who: '测试' }, run: { num: 7 }, nodes: { src: { output: { entity: [{ productName: 'AI企哒' }], n: 3 } } } };
let r = evaluateEdgeExpr('{{nodes.src.output.entity.0.productName}}');
ok('整体引用解析出实际值', r.found && r.value === 'AI企哒', r);
r = evaluateEdgeExpr('共 {{nodes.src.output.n}} 件 / {{input.who}}');
ok('混合模板插值', r.found && r.value === '共 3 件 / 测试', r);
r = evaluateEdgeExpr('{{nodes.src.output.missing.deep}}');
ok('路径不存在标记未取到', r.found === false, r);
r = evaluateEdgeExpr('固定值');
ok('字面量不查上下文', r.literal === true && r.value === '固定值', r);
ok('对象预览给结构摘要', edgePreviewText({ a: 1 }).includes('"a"'), edgePreviewText({ a: 1 }));
ok('null 预览', edgePreviewText(null) === 'null', edgePreviewText(null));

const tree = [
  { label: 'entity', path: 'entity', type: 'array', count: 2, children: [
    { label: '[0]', path: 'entity.0', type: 'object', count: 2, children: [
      { label: 'productName', path: 'entity.0.productName', type: 'string', sample: 'AI企哒' },
      { label: 'price', path: 'entity.0.price', type: 'number', sample: '12.5' },
    ] },
  ] },
];
const html = edgeTreeHTML(tree[0], 0);
ok('字段树渲染出分支与叶子', html.includes('em-branch') && html.includes('em-leaf') && html.includes('entity.0.productName'), html.slice(0, 200));
ok('叶子可点击可拖拽', html.includes('draggable="true"') && html.includes('data-path="entity.0.productName"'), '');
ok('数组显示元素个数', html.includes('array(2)'), '');
ok('默认展开第一层', html.includes('data-open="1"'), '');
ok('搜索按路径过滤并保留父节点', edgeFilterTree(tree, 'productname').length === 1, edgeFilterTree(tree, 'productname').length);
ok('搜索命中取值也算', edgeFilterTree(tree, '12.5').length === 1, '');
ok('搜索无命中返回空', edgeFilterTree(tree, 'zzz').length === 0, '');

state.edgeSchema = { targets: [{ name: 'productName' }, { name: 'product_name' }, { name: 'label' }] };
ok('点字段时优先套用下游同名目标', edgeSuggestTarget('productName') === 'productName', edgeSuggestTarget('productName'));
ok('点字段时归一化同名也能套', edgeSuggestTarget('product_name') === 'product_name', edgeSuggestTarget('product_name'));
ok('没有候选时沿用字段名', edgeSuggestTarget('unknownField') === 'unknownField', edgeSuggestTarget('unknownField'));
EOF
report < /tmp/schema_test_c.txt

echo "──────────────────────────────"
echo "结果：通过 $pass / 失败 $fail"
[ "$fail" = 0 ] || exit 1

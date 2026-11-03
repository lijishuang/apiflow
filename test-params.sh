#!/bin/bash
# 接口参数提示回归：HTTP 200 业务错误识别 / 缺参提取 / 参数学习 / 搭流程自动带参
# 背景：网关把业务错误包在 200 里（{"code":"010024","message":"参数校验异常,poolId","state":"ERROR"}），
#       不识别就会「绿灯成功 + 一堆错误 JSON」；参数本身又从 SDK 的 <Op>Query 类里才看得到。
B=http://127.0.0.1:3300
P=python3
pass=0; fail=0
chk() { if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }

echo "══ P1 错误信封识别（单元）══"
node -e "
const { detectBusinessError, describe } = require('./lib/bizerr');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error(m, JSON.stringify(a)); process.exit(1); } };

// ① 移动云的参数校验异常
let b = detectBusinessError({ code: '010024', message: '参数校验异常,poolId', state: 'ERROR' });
eq(b.code, '010024', 'code');
eq(b.missing, ['poolId'], 'missing');
if (!/缺少必填参数 poolId/.test(describe(b, { poolId: '资源池 ID' }))) process.exit(1);

// ② 认证参数缺失：提示要指向凭证，而不是 Query
b = detectBusinessError({ errorMessage: 'Input parameter AccessKey missing', errorCode: 'MISSING_PARAMETER', state: 'ERROR' });
eq(b.missing, ['AccessKey'], 'auth missing');
if (!/认证参数缺失/.test(describe(b))) process.exit(1);

// ③ 取值不被接受
b = detectBusinessError({ code: '010016', message: '不支持该产品类型:ecs,请检查资源池与产品类型是否正确', state: 'ERROR' });
eq(b.invalid[0].param, 'productType', 'invalid param');
eq(b.invalid[0].value, 'ecs', 'invalid value');

// ④ 正常响应不能误判
for (const ok of [
  { code: '000000', message: '成功', state: 'OK', entity: { total: 2 } },
  { code: 0, msg: 'ok', data: [] },
  { ok: true, items: [{ code: '010024' }] },
  { total: 2, content: [] },
  [],
  'plain',
  null,
]) if (detectBusinessError(ok)) { console.error('误判为错误:', JSON.stringify(ok)); process.exit(1); }
"; chk "错误信封识别 / 缺参提取 / 正常响应不误判" $?

echo "══ P2 SDK <Op>Query 字段 → 参数候选 ══"
node -e "
const paramhint = require('./lib/paramhint');
const { store } = require('./lib/store');
const fs = require('fs');
if (!fs.existsSync('data/materials/src_1b02ad.json')) { console.log('  （无 SDK 资料，跳过）'); process.exit(0); }
const op = { id: 'list_resource_v2', sourceId: 'src_1b02ad' };
const f = paramhint.fieldsOf(op, store);
const names = f.map(x => x.name);
for (const n of ['poolId', 'productType', 'pageNum', 'pageSize']) if (!names.includes(n)) { console.error('缺字段', n, names); process.exit(1); }
const pool = f.find(x => x.name === 'poolId');
if (pool.sdkName !== 'pool_id' || pool.label !== '资源池 ID') { console.error(pool); process.exit(1); }
"; chk "从 query 模型抽出 poolId / productType 等字段（含中文名）" $?

echo "══ P3 槽位抽取：描述里的取值 + 学到的必填默认值 ══"
node -e "
const { slots, matchValue } = require('./lib/paramhint');
const store = { getParamHint: () => ({ required: ['poolId', 'productType'], sample: { productType: 'vm' } }) };
const op = { id: 'x', sourceId: 'builtin' };
let q = slots(op, '帮我查询下云监控支持的资源列表（资源池：CIDC-RP-29）', { store });
if (q.values.poolId !== 'CIDC-RP-29') { console.error(q); process.exit(1); }
if (q.values.productType !== 'vm') { console.error('必填项没带默认值', q); process.exit(1); }
// 缺值 → 记成 missing，而不是发一个必然 400 的请求
const s2 = { getParamHint: () => ({ required: ['poolId'], sample: {} }) };
q = slots(op, '查一下资源列表', { store: s2 });
if (q.missing.length !== 1 || q.missing[0].name !== 'poolId') { console.error(q); process.exit(1); }
// 显式取值优先于默认值
q = slots(op, '资源池 CIDC-RP-01 的资源列表', { store });
if (q.values.poolId !== 'CIDC-RP-01') { console.error(q); process.exit(1); }
"; chk "「资源池：X」→ poolId；必填项回落到学到的默认值；缺值记 missing" $?

echo "══ P4 200 + 业务错误：不再当成功 ══"
OPID=gw_probe_$$
FLOW=flow_gw_$$
cat > /tmp/params-flow.json <<EOF
{"def":{"id":"$FLOW","name":"参数提示自测流程","version":0,
 "input":{"sample":{}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"$OPID","type":"http","name":"资源列表","operationId":"$OPID",
   "config":{"method":"GET","url":"$B/upstream/_gateway/resources"}}],
 "edges":[{"from":"start","to":"$OPID"}],
 "layout":{"start":{"x":40,"y":200},"$OPID":{"x":280,"y":200}}}}
EOF
curl -s -X POST $B/api/flows/$FLOW/draft -H 'content-type: application/json' -d @/tmp/params-flow.json > /dev/null
R=$(curl -s -X POST $B/api/flows/$FLOW/dry-run -H 'content-type: application/json' -d '{}')
echo "$R" | $P -c "
import sys,json
d=json.load(sys.stdin); n=d['nodes']['$OPID']
assert d['status']=='failed', d['status']
assert n['status']=='failed', n['status']
assert '缺少必填参数 poolId' in n['error'], n.get('error')
assert n.get('bizError',{}).get('code')=='010024', n.get('bizError')
" ; chk "HTTP 200 + code 010024 → 节点失败，错误指明缺 poolId" $?

echo "══ P5 逐参学习：补 poolId 后报 productType ══"
$P - <<'PY'
import json
p='/tmp/params-flow.json'
d=json.load(open(p))
for n in d['def']['nodes']:
    if n['type']=='http': n['config']['query']={'poolId':'CIDC-RP-29'}
json.dump(d,open(p,'w'),ensure_ascii=False)
PY
curl -s -X POST $B/api/flows/$FLOW/draft -H 'content-type: application/json' -d @/tmp/params-flow.json > /dev/null
curl -s -X POST $B/api/flows/$FLOW/dry-run -H 'content-type: application/json' -d '{}' | $P -c "
import sys,json
d=json.load(sys.stdin); n=d['nodes']['$OPID']
assert d['status']=='failed'
assert '缺少必填参数 productType' in n['error'], n.get('error')
" ; chk "补 poolId 后网关改报 productType（一个参数一个参数地教）" $?

echo "══ P6 学到的参数落库并可被界面取用 ══"
curl -s $B/api/ops/$OPID/params | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('missingOp') is True      # 这条自测接口不在注册表里，也照样给提示
q={x['name']:x for x in d['query']}
assert q['poolId']['required'] and q['productType']['required'], q.keys()
assert q['poolId']['label']=='资源池 ID', q['poolId']
" ; chk "GET /api/ops/:id/params 返回必填项（接口不在注册表也给）" $?

echo "══ P7 补齐后跑通，且不再误报 ══"
$P - <<'PY'
import json
p='/tmp/params-flow.json'
d=json.load(open(p))
for n in d['def']['nodes']:
    if n['type']=='http': n['config']['query']={'poolId':'CIDC-RP-29','productType':'vm'}
json.dump(d,open(p,'w'),ensure_ascii=False)
PY
curl -s -X POST $B/api/flows/$FLOW/draft -H 'content-type: application/json' -d @/tmp/params-flow.json > /dev/null
curl -s -X POST $B/api/flows/$FLOW/dry-run -H 'content-type: application/json' -d '{}' | $P -c "
import sys,json
d=json.load(sys.stdin); n=d['nodes']['$OPID']
assert d['status']=='success', n
assert n['output']['code']=='000000', n.get('output')
assert len(n['output']['entity']['content'])==2
" ; chk "参数补齐 → 正常返回（成功信封不被误判）" $?

echo "══ P7b 跑通后把可用取值记成示例 ══"
curl -s $B/api/ops/$OPID/params | $P -c "
import sys,json
d=json.load(sys.stdin); q={x['name']:x for x in d['query']}
assert q['poolId']['sample']=='CIDC-RP-29', q['poolId']
assert q['productType']['sample']=='vm', q['productType']
assert not (d.get('learned') or {}).get('lastError'), d.get('learned')
" ; chk "成功取值写回示例，上次报错已清空" $?

echo "══ P8 坏取值 → 指明参数与取值 ══"
$P - <<'PY'
import json
p='/tmp/params-flow.json'
d=json.load(open(p))
for n in d['def']['nodes']:
    if n['type']=='http': n['config']['query']={'poolId':'CIDC-RP-29','productType':'ecs'}
json.dump(d,open(p,'w'),ensure_ascii=False)
PY
curl -s -X POST $B/api/flows/$FLOW/draft -H 'content-type: application/json' -d @/tmp/params-flow.json > /dev/null
curl -s -X POST $B/api/flows/$FLOW/dry-run -H 'content-type: application/json' -d '{}' | $P -c "
import sys,json
d=json.load(sys.stdin); n=d['nodes']['$OPID']
assert '不接受取值「ecs」' in n['error'], n.get('error')
" ; chk "取值不被接受时点明参数与取值" $?

echo "══ P9 清理（流程 + 学到的提示）══"
curl -s -X DELETE $B/api/flows/$FLOW > /dev/null
curl -s -X DELETE $B/api/ops/$OPID/params | $P -c "import sys,json;assert json.load(sys.stdin)['ok']" ; chk "清理自测流程与参数提示" $?

echo
echo "════ 参数提示回归：通过 $pass / 失败 $fail ════"
[ "$fail" = "0" ] && echo "全部通过 ✓" || echo "存在失败 ✗"
exit $fail

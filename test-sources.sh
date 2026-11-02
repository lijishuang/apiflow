#!/bin/bash
# ═══ 接口接入（前端把 API 接入智能体）后端回归 ═══
# 覆盖：URL 接入 / 粘贴 JSON / 手工添加 / 目录合并 / 冲突后缀 / 文档更新指纹检测 / 卸载还原
# 运行前提：服务已启动（node server.js，端口 3300）；可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

echo "══ T0 清理历史 E2E 来源（保证可重复执行）══"
$P -c "
import json,urllib.request
base='$B'
items=json.load(urllib.request.urlopen(base+'/api/sources'))['items']
for s in items:
    if s['name'].startswith('E2E'):
        urllib.request.urlopen(urllib.request.Request(base+'/api/sources/'+s['id'],method='DELETE')).read()
print('  已清理', sum(1 for s in items if s['name'].startswith('E2E')), '个历史来源')
" ; chk "历史 E2E 来源清理" $?

echo "══ T1 内置接口全部标记 builtin ══"
$P -c "
import json,urllib.request
cat=json.load(urllib.request.urlopen('$B/api/catalog'))
bi=[o for o in cat['operations'] if o['sourceId']=='builtin']
assert len(bi)>=6, len(bi)
assert all('baseUrl' in o for o in bi)
" ; chk "内置接口存在且元数据完整" $?

echo "══ T2 URL 模式接入 OpenAPI 文档 ══"
curl -s -X POST $B/api/sources -H 'content-type: application/json' \
  -d '{"mode":"url","url":"http://127.0.0.1:3300/upstream/_specs/order-center.json","name":"E2E订单中心"}' > /tmp/t2.json
cat /tmp/t2.json | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('added')==3, d
assert '#' in d['catalogVersion'], d['catalogVersion']
ids={o['id'] for o in d['operations']}
assert sum(i.startswith('getOrder') for i in ids)==1, ids
open('/tmp/e2e-id1','w').write(d['source']['id'])
" ; chk "接入 3 个接口且目录版本号变化" $?
SID1=$(cat /tmp/e2e-id1)

echo "══ T3 目录合并：新接口带 baseUrl / 指纹 / 请求体示例 ══"
$P -c "
import json,urllib.request
cat=json.load(urllib.request.urlopen('$B/api/catalog'))
op=[o for o in cat['operations'] if o.get('sourceId')=='$SID1' and o['id'].startswith('applyRefund')][0]
assert op['baseUrl'].startswith('http'), op
assert len(op['hash'])==40, op['hash']
assert op['version']=='1.3.0' and op['readOnly']==False, op
assert op['bodyExample']=={'amount':99,'reason':'商品破损'}, op.get('bodyExample')
" ; chk "operation 元数据完整（含请求体示例）" $?

echo "══ T4 粘贴 JSON 模式 + 手工添加 ══"
curl -s -X POST $B/api/sources -H 'content-type: application/json' -d '{
  "mode":"text","name":"E2E粘贴",
  "text":{"openapi":"3.0.3","info":{"title":"粘贴示例","version":"0.9.0"},
    "servers":[{"url":"http://127.0.0.1:3300/upstream/_sandbox"}],
    "paths":{"/ping":{"get":{"summary":"健康检查","operationId":"ping"}}}}}' > /tmp/t4a.json
cat /tmp/t4a.json | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('added')==1, d
assert d['operations'][0]['id'].startswith('ping'), d
open('/tmp/e2e-id2','w').write(d['source']['id'])
" ; chk "粘贴 JSON 接入 1 个接口" $?
curl -s -X POST $B/api/sources -H 'content-type: application/json' -d '{
  "mode":"manual","name":"E2E手工接口","method":"GET","path":"/manual-check/{id}","keywords":"手工,检查"}' > /tmp/t4b.json
cat /tmp/t4b.json | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('added')==1 and d['operations'][0]['path']=='/manual-check/{id}', d
open('/tmp/e2e-id3','w').write(d['source']['id'])
" ; chk "手工添加接口成功" $?

echo "══ T5 operationId 冲突自动加后缀（不覆盖已有接口）══"
curl -s -X POST $B/api/sources -H 'content-type: application/json' \
  -d '{"mode":"url","url":"http://127.0.0.1:3300/upstream/_specs/order-center.json","name":"E2E重复"}' > /tmp/t5.json
cat /tmp/t5.json | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('added')==3, d
ids={o['id'] for o in d['operations']}
assert sum(i=='getOrder' for i in ids)==0 and any(i.startswith('getOrder_') for i in ids), ids
open('/tmp/e2e-id4','w').write(d['source']['id'])
" ; chk "重复接入的 operationId 被加后缀" $?

echo "══ T6 文档更新检测（版本号不变、字段变更 → 指纹变化）══"
cp fixtures/order-center.json /tmp/oc-orig.json
$P -c "
import json
s=json.load(open('fixtures/order-center.json'))
s['paths']['/orders/{orderNo}/refund']['post']['requestBody']['content']['application/json']['schema']['properties']['currency']={'type':'string','example':'CNY'}
json.dump(s,open('fixtures/order-center.json','w'),ensure_ascii=False)
"
curl -s -X POST $B/api/sources/$SID1/refresh > /tmp/t6.json
cat /tmp/t6.json | $P -c "
import sys,json
d=json.load(sys.stdin)
assert len(d.get('changed',[]))==1 and d['changed'][0].startswith('applyRefund'), d
assert not d['added'] and not d['removed'], d
" ; chk "刷新检出 applyRefund 内容变更" $?
cp /tmp/oc-orig.json fixtures/order-center.json
curl -s -X POST $B/api/sources/$SID1/refresh > /dev/null   # 刷回原文档，保持指纹一致

echo "══ T7 卸载来源 → 目录还原 ══"
for f in /tmp/e2e-id1 /tmp/e2e-id2 /tmp/e2e-id3 /tmp/e2e-id4; do
  [ -s $f ] && curl -s -X DELETE $B/api/sources/$(cat $f) > /dev/null
done
$P -c "
import json,urllib.request
src=json.load(urllib.request.urlopen('$B/api/sources'))
left=[s['name'] for s in src['items'] if s['name'].startswith('E2E')]
assert not left, left
ops=json.load(urllib.request.urlopen('$B/api/catalog'))['operations']
assert not [o for o in ops if o['id']=='ping' or o['path'].startswith('/manual-check')], ops
" ; chk "E2E 来源与接口全部移除" $?

echo
echo "═══════ 接入回归结果：通过 $PASS / 失败 $FAIL ═══════"
[ $FAIL -eq 0 ] || exit 1

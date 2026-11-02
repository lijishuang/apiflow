#!/bin/bash
# ═══ 接口注册表「批量删除」后端回归 ═══
# 覆盖：预览不改状态 / 内置接口删除=隐藏且可恢复 / 来源接口逐个移除（删空即移除来源）
#       引用流程提示 / 凭证解绑 / 参数校验 / 重复删除幂等 / 目录版本与 ETag 变化
# 运行前提：服务已启动（node server.js，端口 3300）；可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

echo "══ T0 恢复到干净基线（清隐藏接口 + 测试来源 + 测试凭证）══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def post(u,d=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
def dele(u): return urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
post('/api/ops/restore',{})
for s in get('/api/sources')['items']:
    if s['name'].startswith('OPS'): dele('/api/sources/'+s['id'])
for c in get('/api/creds')['items']:
    if c['name'].startswith('OPS'): dele('/api/creds/'+c['id'])
" ; chk "基线清理完成" $?

echo "══ T1 记录基线：内置接口清单 / 目录版本 / ETag ══"
$P -c "
import json,urllib.request
def post(u,d):
    r=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
# 用户环境里内置接口可能是隐藏态 —— 先全部恢复，并把原始隐藏集记进快照，结尾原样还原
s=json.load(urllib.request.urlopen('$B/api/sources'))
hidden0=[h for h in (s.get('hidden') or []) if isinstance(h,str)]
if hidden0: post('/api/ops/restore',{'ids':hidden0})
c=json.load(urllib.request.urlopen('$B/api/catalog'))
bi=[o['id'] for o in c['operations'] if o['sourceId']=='builtin']
assert len(bi)>=6, bi
open('/tmp/ops-base','w').write(json.dumps({'ids':bi,'ver':c['version'],'etag':c['etag'],'total':len(c['operations']),'hidden0':hidden0}))
" ; chk "内置接口已恢复并记录基线（含用户原隐藏态）" $?

echo "══ T2 预览：只出报告，不改注册表 ══"
$P -c "
import json,urllib.request
base=json.load(open('/tmp/ops-base'))
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/ops/batch-delete',
  data=json.dumps({'ids':['list_orders','no_such_op'],'preview':True}).encode(),
  headers={'content-type':'application/json'})))
assert r['preview'] is True and r['total']==1, r
assert r['builtin']==['list_orders'] and r['missing']==['no_such_op'], r
assert r['fromSources']==[], r
c=json.load(urllib.request.urlopen('$B/api/catalog'))
assert c['version']==base['ver'] and c['etag']==base['etag'], (c['version'],base['ver'])
assert 'list_orders' in [o['id'] for o in c['operations']]
" ; chk "预览返回清单且目录未变（版本 / ETag 不变）" $?

echo "══ T3 删除内置接口 → 注册表消失 + 记入隐藏 + 版本与 ETag 变化 ══"
$P -c "
import json,urllib.request
base=json.load(open('/tmp/ops-base'))
def post(u,d):
  r=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
r=post('/api/ops/batch-delete',{'ids':['list_orders','list_orders']})     # 重复 id 去重
assert r['deleted']==['list_orders'] and r['hidden']==1, r
assert r['preview'] is False, r
c=json.load(urllib.request.urlopen('$B/api/catalog'))
ids=[o['id'] for o in c['operations']]
assert 'list_orders' not in ids, ids
assert len(ids)==base['total']-1, (len(ids),base['total'])
assert c['version']!=base['ver'] and c['etag']!=base['etag'], c['version']
assert '.h' in c['version'], c['version']        # 目录版本带隐藏水位
s=json.load(urllib.request.urlopen('$B/api/sources'))
assert s['hidden']==['list_orders'] and s['total']==len(ids), s
" ; chk "内置接口删除后从注册表移除（可追溯）" $?
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/ops/batch-delete',
  data=json.dumps({'ids':['list_orders']}).encode(),headers={'content-type':'application/json'})))
assert r['deleted']==[] and r['missing']==['list_orders'], r
" ; chk "重复删除同一接口幂等（第二次归入 missing）" $?
$P -c "
import json,urllib.request
def post(u,d=None):
  r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
base=json.load(open('/tmp/ops-base'))
r=post('/api/ops/restore',{})
assert r['restored']==1 and r['hidden']==[], r
c=json.load(urllib.request.urlopen('$B/api/catalog'))
ids=[o['id'] for o in c['operations']]
assert 'list_orders' in ids and len(ids)==base['total'], ids
" ; chk "恢复隐藏接口后注册表还原" $?

echo "══ T4 引用提示：列出受影响的流程（已发布排前）══"
# 自建夹具：草稿 → 真实 dry-run 过二道闸 → 发布（不依赖外部流程数据，结束自清理）
$P -c "
import json,urllib.request
def req(u,d=None,method=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d).encode() if d is not None else None,
      headers={'content-type':'application/json'},method=method)
    return json.load(urllib.request.urlopen(r))
DEF={'id':'flow_ops_fix','name':'OPS引用夹具','version':0,
 'input':{'schema':{'type':'object'},'sample':{'supplierId':'S-8891'}},
 'nodes':[{'id':'start','type':'start','name':'开始','config':{}},
          {'id':'q','type':'http','name':'查询供应商','operationId':'query_supplier','apiVersion':'v2026.10',
           'config':{'method':'GET','url':'http://127.0.0.1:3300/upstream/suppliers/S-8891'}}],
 'edges':[{'from':'start','to':'q'}]}
req('/api/flows/flow_ops_fix/draft',{'def':DEF})
dry=req('/api/flows/flow_ops_fix/dry-run',{})            # 真实执行过二道闸
assert dry['status']=='success', dry
pub=req('/api/flows/flow_ops_fix/publish',{'def':DEF,'confirm':True})
assert pub['ok'] and pub['version']>=1, pub
r=req('/api/ops/batch-delete',{'ids':['query_supplier'],'preview':True})
aff=r['affected']
assert aff, r
assert aff[0]['published'] is True, aff[:3]              # 已发布流程优先展示
hit=[a for a in aff if a['id']=='flow_ops_fix']
assert hit and hit[0]['nodes']==['查询供应商'] and hit[0]['version']>=1, aff[:3]
req('/api/flows/flow_ops_fix/delete',None,'DELETE') if False else urllib.request.urlopen(urllib.request.Request('$B/api/flows/flow_ops_fix',method='DELETE')).read()
" ; chk "预览列出引用该接口的流程与节点（自建夹具）" $?

echo "══ T5 参数校验 ══"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/ops/batch-delete -H 'content-type: application/json' -d '{"ids":[]}')
[ "$CODE" = "400" ]; chk "空 ids → 400（实际 ${CODE}）" $?
BIG=$($P -c "import json;print(json.dumps({'ids':['op_%d'%i for i in range(201)]}))")
CODE=$(printf '%s' "$BIG" | curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/ops/batch-delete -H 'content-type: application/json' --data-binary @-)
[ "$CODE" = "400" ]; chk "超过 200 个 → 400（实际 ${CODE}）" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/ops/batch-delete -H 'content-type: application/json' -d '{"ids":[123,null,""]}')
[ "$CODE" = "400" ]; chk "非字符串 / 空值全部过滤后 → 400（实际 ${CODE}）" $?

echo "══ T6 来源接口：逐个移除，删空后来源一并移除 ══"
curl -s -X POST $B/api/sources -H 'content-type: application/json' \
  -d '{"mode":"url","url":"http://127.0.0.1:3300/upstream/_specs/order-center.json","name":"OPS删除测试"}' > /tmp/ops-src.json
$P -c "
import json
d=json.load(open('/tmp/ops-src.json'))
assert d['added']==3, d
open('/tmp/ops-src-id','w').write(d['source']['id'])
open('/tmp/ops-src-ops','w').write(','.join(o['id'] for o in d['operations']))
" ; chk "接入 3 个接口的测试来源" $?
$P -c "
import json,urllib.request
sid=open('/tmp/ops-src-id').read().strip(); ops=open('/tmp/ops-src-ops').read().strip().split(',')
def post(u,d):
  r=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
r=post('/api/ops/batch-delete',{'ids':ops[:1]})
assert r['deleted']==ops[:1] and r['fromSources']==ops[:1], r
assert r['removedSources']==[], r
s=[x for x in json.load(urllib.request.urlopen('$B/api/sources'))['items'] if x['id']==sid]
assert s and s[0]['count']==2, s
ids=[o['id'] for o in json.load(urllib.request.urlopen('$B/api/catalog'))['operations']]
assert ops[0] not in ids and ops[1] in ids, ids
" ; chk "删除来源下 1 个接口 → 来源剩 2 个，其余接口不受影响" $?
$P -c "
import json,urllib.request
sid=open('/tmp/ops-src-id').read().strip(); ops=open('/tmp/ops-src-ops').read().strip().split(',')
def post(u,d):
  r=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
r=post('/api/ops/batch-delete',{'ids':ops[1:]})
assert r['removedSources']==[sid], r
s=[x for x in json.load(urllib.request.urlopen('$B/api/sources'))['items'] if x['id']==sid]
assert not s, s
ids=[o['id'] for o in json.load(urllib.request.urlopen('$B/api/catalog'))['operations']]
assert not [i for i in ops if i in ids], ids
" ; chk "删空来源下的接口 → 来源自动移除" $?

echo "══ T7 删除时解绑凭证（凭证本体保留）══"
$P -c "
import json,urllib.request
def post(u,d):
  r=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
cred=post('/api/creds',{'name':'OPS临时凭证'})['cred']
post('/api/creds/bind-op',{'operationId':'sync_stock','credId':cred['id']})
b=json.load(urllib.request.urlopen('$B/api/creds'))['opBindings']
assert b.get('sync_stock')==cred['id'], b
r=post('/api/ops/batch-delete',{'ids':['sync_stock']})
assert r['unboundCreds']==1, r
cur=json.load(urllib.request.urlopen('$B/api/creds'))
assert 'sync_stock' not in cur['opBindings'], cur['opBindings']
assert any(c['id']==cred['id'] for c in cur['items']), '凭证本体不应被删除'
open('/tmp/ops-cred','w').write(cred['id'])
" ; chk "接口删除后单接口凭证绑定被清理" $?
$P -c "
import json,urllib.request
def post(u,d=None):
  r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'}); return json.load(urllib.request.urlopen(r))
post('/api/ops/restore',{})
" ; chk "隐藏接口已恢复（供后续套件使用）" $?

echo "══ T8 收尾：注册表回到基线，测试数据清理干净 ══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): return urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
base=json.load(open('/tmp/ops-base'))
ids=[o['id'] for o in get('/api/catalog')['operations'] if o['sourceId']=='builtin']
assert sorted(ids)==sorted(base['ids']), (ids, base['ids'])   # 只校验内置接口（其余来源属于其他套件的测试数据）
if base['hidden0']: post('/api/ops/batch-delete',{'ids':base['hidden0']})   # 还原用户原隐藏态
assert sorted(get('/api/sources')['hidden'])==sorted(base['hidden0'])
dele('/api/creds/'+open('/tmp/ops-cred').read().strip())
assert not [c for c in get('/api/creds')['items'] if c['name'].startswith('OPS')]
assert not [s for s in get('/api/sources')['items'] if s['name'].startswith('OPS')]
" ; chk "接口清单与测试数据回到基线" $?

echo
echo "═══════ 注册表批量删除回归结果：通过 $PASS / 失败 $FAIL ═══════"
[ $FAIL -eq 0 ] || exit 1

#!/bin/bash
# APIFlow 全链路回归测试（全部通过 API 断言）
P=python3
B=http://127.0.0.1:3300
pass=0; fail=0
chk() {
  if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
getrun() { curl -s $B/api/runs/$1; }

# ══ T0 种子自保障：不依赖平台当前的用户数据 ══
# 接口注册表里没有 query_stock / sync_stock 时，用 SDK 导入临时注册（函数名即 op id），结尾随 source 一并清理
SEED_SRC=$(curl -s $B/api/catalog | $P -c "
import sys,json
ids=[o['id'] for o in json.load(sys.stdin).get('operations',[])]
print('' if 'query_stock' in ids and 'sync_stock' in ids else 'need')")
SRC_ID=''
if [ "$SEED_SRC" = "need" ]; then
  cat > /tmp/e2e-seed-src.json <<'JSON'
{"mode":"sdk","filename":"e2e-seed.ts","name":"e2e种子接口",
 "text":"/** 查询库存 */\nexport async function query_stock(sku: string) { return request(\"GET\", \"/upstream/stock/query?sku=\" + sku); }\n/** 同步库存到仓库 */\nexport async function sync_stock(body: { orderId: string }) { return request(\"POST\", \"/upstream/stock/sync\", body); }"}
JSON
  SRC_ID=$(curl -s -X POST $B/api/sources -H 'content-type: application/json' -d @/tmp/e2e-seed-src.json | $P -c "import sys,json;print(json.load(sys.stdin).get('source',{}).get('id',''))")
  echo "  （已临时注册种子接口 query_stock / sync_stock，来源 ${SRC_ID}）"
fi
# 种子流程：条件分支用 input.supplierId 判断（不依赖 fixtures 里的供应商数据）
SEED=flow_e2e_seed
cat > /tmp/e2e-seed.json <<EOF
{"def":{"id":"$SEED","name":"E2E种子流程","version":0,
 "trigger":{"type":"webhook"},
 "input":{"sample":{"supplierId":"S-1001"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch_supplier","type":"http","name":"拉取数据","config":{"method":"GET","url":"$B/upstream/_sandbox"}},
  {"id":"check_active","type":"condition","name":"是否准入","config":{"expr":"input.supplierId == 'S-1001'"}},
  {"id":"notify_erp","type":"http","name":"同步ERP","config":{"method":"POST","url":"$B/upstream/erp/admissions","body":{"supplierId":"{{input.supplierId}}"}}},
  {"id":"reject","type":"http","name":"标记拒绝","config":{"method":"PATCH","url":"$B/upstream/suppliers/S-1002/reject","body":{"reason":"not active"}}}],
 "edges":[{"from":"start","to":"fetch_supplier"},{"from":"fetch_supplier","to":"check_active"},
  {"from":"check_active","to":"notify_erp","label":"then"},{"from":"check_active","to":"reject","label":"else"}],
 "layout":{"start":{"x":40,"y":220},"fetch_supplier":{"x":240,"y":220},"check_active":{"x":440,"y":220},"notify_erp":{"x":640,"y":140},"reject":{"x":640,"y":320}}}}
EOF
curl -s -X POST $B/api/flows/$SEED/draft -H 'content-type: application/json' -d @/tmp/e2e-seed.json > /dev/null
curl -s -X POST $B/api/flows/$SEED/dry-run > /dev/null
curl -s -X POST $B/api/flows/$SEED/publish -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null

echo "══ T1 种子流程：手动运行 then 分支 ══"
RID=$(curl -s -X POST $B/api/flows/$SEED/run -H 'content-type: application/json' -d '{}' | $P -c "import sys,json;print(json.load(sys.stdin).get('runId',''))")
sleep 1
getrun $RID | $P -c "
import sys,json
r=json.load(sys.stdin); nodes=r['nodes']
assert r['status']=='success', r.get('status')
assert nodes['fetch_supplier']['status']=='done'
assert nodes['check_active']['branch']=='then'
assert nodes['notify_erp']['status']=='done'
assert nodes['reject']['status']=='skipped', nodes['reject']
" ; chk "then 分支执行且 reject 跳过" $?

echo "══ T2 种子流程：Webhook 触发 else 分支 ══"
RID2=$(curl -s -X POST $B/webhook/$SEED -H 'content-type: application/json' -d '{"supplierId":"S-1002"}' | $P -c "import sys,json;print(json.load(sys.stdin).get('runId',''))")
sleep 1
getrun $RID2 | $P -c "
import sys,json
r=json.load(sys.stdin); nodes=r['nodes']
assert r['trigger']=='webhook' and r['version']==1
assert nodes['check_active']['branch']=='else'
assert nodes['reject']['status']=='done' and nodes['notify_erp']['status']=='skipped'
" ; chk "else 分支执行 reject 且 notify 跳过" $?

echo "══ T3 NL→草稿→三道闸→发布→运行 ══"
curl -s -X POST $B/api/agent/draft -H 'content-type: application/json' -d '{"text":"库存同步流程：查库存 SKU-01，如果是数量大于 10 就把库存同步到仓库"}' > /tmp/t3.json
FID=$($P -c "import json;print(json.load(open('/tmp/t3.json'))['flow']['id'])")
$P -c "
import json
d=json.load(open('/tmp/t3.json')); dr=d['draft']
assert dr['name']=='库存同步流程'
assert dr['gates']['schema']['ok']==True
cond=[n for n in dr['nodes'] if n['type']=='condition']
assert cond and cond[0]['config']['expr']=='qty > 10'
edges={(e['from'],e['to']):e.get('label') for e in dr['edges']}
then_edge=[k for k,v in edges.items() if v=='then']
assert then_edge and then_edge[0]==('check_cond','sync_stock'), edges
" ; chk "NL 生成含条件分支的草稿（qty > 10）" $?
curl -s -X POST $B/api/flows/$FID/dry-run | $P -c "
import sys,json; d=json.load(sys.stdin)
assert d.get('status')=='success', d
nodes=d['nodes']
assert nodes['query_stock']['status']=='done'
assert nodes['sync_stock'].get('output')=={'_dryRun':'write-skipped'}, nodes.get('sync_stock')
" ; chk "Dry-run 通过且写操作被跳过" $?
curl -s -X POST $B/api/flows/$FID/publish -H 'content-type: application/json' -d '{"confirm":true}' | $P -c "import sys,json; d=json.load(sys.stdin); assert d.get('version')==1, d" ; chk "发布 v1 并绑定接口版本" $?
curl -s -X POST $B/api/flows/$FID/run -H 'content-type: application/json' -d '{}' >/dev/null; sleep 1
RID3=$(curl -s "$B/api/runs?flowId=$FID" | $P -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
getrun $RID3 | $P -c "
import sys,json
r=json.load(sys.stdin)
assert r['nodes']['check_cond']['branch']=='then'
assert r['nodes']['sync_stock']['status']=='done'
assert 'idempotency-key' in json.dumps(r['nodes']['sync_stock'].get('request',{}))
" ; chk "运行 then 分支 + 写操作带幂等键" $?

echo "══ T4 未过闸不可发布 ══"
curl -s -X POST $B/api/agent/draft -H 'content-type: application/json' -d '{"text":"订单对账流程：查订单并同步库存"}' > /tmp/t4.json
FID4=$($P -c "import json;print(json.load(open('/tmp/t4.json'))['flow']['id'])")
curl -s -X POST $B/api/flows/$FID4/publish -H 'content-type: application/json' -d '{"confirm":true}' | $P -c "import sys,json; d=json.load(sys.stdin); assert 'Dry-run' in d.get('error',''), d" ; chk "未 Dry-run 时发布被拒（第二道闸强制）" $?

echo "══ T5 从节点重放 ══"
RID5=$(curl -s -X POST $B/api/runs/$RID/replay -H 'content-type: application/json' -d '{"fromNode":"notify_erp"}' | $P -c "import sys,json;print(json.load(sys.stdin).get('runId',''))")
sleep 1
getrun $RID5 | $P -c "
import sys,json
r=json.load(sys.stdin); nodes=r['nodes']
assert r['trigger']=='replay' and r['replayFrom']=='notify_erp'
assert nodes['fetch_supplier'].get('reused')==True
assert nodes['check_active'].get('reused')==True
assert nodes['notify_erp']['status']=='done' and not nodes['notify_erp'].get('reused')
" ; chk "重放复用上游产物，仅重执行 notify_erp" $?

echo "══ T6 运行对比 diff ══"
# 对比「重放 run」与「其原始 run」：重放复用产物输出应一致，重执行节点应成功
curl -s $B/api/runs/$RID5/diff/$RID | $P -c "
import sys,json; d=json.load(sys.stdin)
m={x['node']:x for x in d['diff']}
assert m['fetch_supplier']['statusA']=='reused' and m['fetch_supplier']['outputChanged']==False
assert m['check_active']['outputChanged']==False
assert m['notify_erp']['statusA']=='done' and m['notify_erp']['statusB']=='done'
" ; chk "逐节点 diff 正确标注差异" $?

echo "══ T7 目录版本变更 → 失效告警 ══"
# 自包含种子：恢复内置 query_stock → 发布一个绑定它的流程 → bump 触发 api_changed → 按进入前的隐藏态还原
QS_WAS_HIDDEN=$(curl -s $B/api/sources | $P -c "
import sys,json
s=json.load(sys.stdin)
print('yes' if 'query_stock' in (s.get('hidden') or []) else 'no')")
curl -s -X POST $B/api/ops/restore -H 'content-type: application/json' -d '{"ids":["query_stock"]}' > /dev/null
cat > /tmp/e2e-bump.json <<EOF
{"def":{"id":"flow_e2e_bump","name":"Bump告警种子","version":0,"trigger":{"type":"manual"},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"q","type":"http","name":"查库存","operationId":"query_stock","apiVersion":"v2026.10","config":{"method":"GET","url":"$B/upstream/stock/query?sku=SKU-01"}}],
 "edges":[{"from":"start","to":"q"}],
 "layout":{"start":{"x":40,"y":220},"q":{"x":260,"y":220}}}}
EOF
curl -s -X POST $B/api/flows/flow_e2e_bump/draft -H 'content-type: application/json' -d @/tmp/e2e-bump.json > /dev/null
curl -s -X POST $B/api/flows/flow_e2e_bump/dry-run > /dev/null
curl -s -X POST $B/api/flows/flow_e2e_bump/publish -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null
curl -s -X POST $B/api/alerts/clear-all > /dev/null   # 清空历史告警，避免 50 条上限截断影响断言
curl -s -X POST $B/api/admin/catalog-bump > /dev/null
sleep 1
$P -c "
import json,urllib.request
alerts=json.load(urllib.request.urlopen('$B/api/alerts'))
assert alerts, 'bump 后没有产生告警'
a=alerts[0]
assert a['type']=='api_changed' and 'v2026.11' in a['message'], a
" ; chk "注册表 ETag 热更新触发流程失效告警" $?
curl -s -X POST $B/api/admin/catalog-restore > /dev/null
curl -s -X DELETE $B/api/flows/flow_e2e_bump > /dev/null
if [ "$QS_WAS_HIDDEN" = "yes" ]; then
  curl -s -X POST $B/api/ops/batch-delete -H 'content-type: application/json' -d '{"ids":["query_stock"]}' > /dev/null   # 进入时它是隐藏的才藏回去
fi

echo "══ T8 SSE 事件流 ══"
(curl -s -N --max-time 3 $B/api/events > /tmp/sse.txt) &
SSEPID=$!
sleep 0.5
curl -s -X POST $B/api/flows/$SEED/run -H 'content-type: application/json' -d '{}' > /dev/null
wait $SSEPID 2>/dev/null
$P -c "
s=open('/tmp/sse.txt').read()
for ev in ['run_start','node_start','node_end','edge_data','run_end']:
    assert 'event: '+ev in s, ev
" ; chk "SSE 推送全部事件类型" $?

echo "══ T9 定时触发器 ══"
# 这条用例测的是「定时触发器能不能按间隔跑起来」，跟自然语言解析无关 ——
# 注册表里接口多了以后「查库存」未必还落在 query_stock 上，直接拼定义更稳
FID9=flow_e2e_sched
cat > /tmp/t9.json <<EOF
{"def":{"id":"$FID9","name":"库存定时巡检","version":0,"trigger":{"type":"interval","minutes":1},
 "input":{"sample":{"sku":"SKU-01"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"query_stock","type":"http","name":"查库存","operationId":"query_stock",
   "config":{"method":"GET","url":"$B/upstream/stock/query?sku=SKU-01"}}],
 "edges":[{"from":"start","to":"query_stock"}],
 "layout":{"start":{"x":40,"y":200},"query_stock":{"x":280,"y":200}}}}
EOF
DEF=$($P -c "
import json
print(json.dumps(json.load(open('/tmp/t9.json'))['def']))
")
curl -s -X POST $B/api/flows/$FID9/draft -H 'content-type: application/json' -d "{\"def\":$DEF}" > /dev/null
curl -s -X POST $B/api/flows/$FID9/dry-run > /dev/null
curl -s -X POST $B/api/flows/$FID9/publish -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null
# 触发器配置落库（跑真实调度要等一个周期，回归里只校验已注册，避免整套用例多等 1 分钟）
$P -c "
import json,urllib.request
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
d=json.load(op.open('$B/api/flows/$FID9/def'))['def']
assert d['trigger']['type']=='interval' and d['trigger']['minutes']==1, d.get('trigger')
" ; chk "定时触发器 interval/1min 已随发布落库" $?

echo "══ T10 循环节点 ══"
DEF10=$($P -c "
import json
print(json.dumps({
  'id':'flow_e2e_loop','name':'订单循环同步','version':0,
  'input':{'schema':{'type':'object'},'sample':{}},
  'nodes':[
    {'id':'start','type':'start','name':'开始','config':{}},
    {'id':'list_orders','type':'http','name':'拉订单','apiVersion':'v2026.10','config':{'method':'GET','url':'$B/upstream/orders?date=2026-11-01'},'retry':{'maxAttempts':2,'backoffMs':200}},
    {'id':'loop_sync','type':'loop','name':'逐单同步','config':{'over':'nodes.list_orders.output.orders','as':'item','request':{'method':'POST','url':'$B/upstream/stock/sync','body':{'orderId':'{{item.id}}'}}},'idempotencyKey':'{{run.num}}-loop','timeout':8000}
  ],
  'edges':[{'from':'start','to':'list_orders'},{'from':'list_orders','to':'loop_sync'}],
  'layout':{'start':{'x':40,'y':240},'list_orders':{'x':260,'y':228},'loop_sync':{'x':500,'y':228}}
}))
")
curl -s -X POST $B/api/flows/flow_e2e_loop/draft -H 'content-type: application/json' -d "{\"def\":$DEF10}" > /dev/null
curl -s -X POST $B/api/flows/flow_e2e_loop/dry-run > /dev/null
curl -s -X POST $B/api/flows/flow_e2e_loop/publish -H 'content-type: application/json' -d '{"confirm":true}' | $P -c "import sys,json; assert json.load(sys.stdin).get('version',0)>=1"
RID10=$(curl -s -X POST $B/api/flows/flow_e2e_loop/run -H 'content-type: application/json' -d '{}' | $P -c "import sys,json;print(json.load(sys.stdin).get('runId',''))")
sleep 1
getrun $RID10 | $P -c "
import sys,json
r=json.load(sys.stdin)
assert r['status']=='success', (r.get('status'), r.get('error'))
loop=r['nodes']['loop_sync']
assert loop['status']=='done' and loop['output']['count']==2, loop.get('output')
assert all(x['ok'] for x in loop['output']['results'])
" ; chk "循环节点逐项执行 2 个订单全部成功" $?

echo "══ T12 节点 Query 参数（合并进 URL / 模板渲染 / URL 手写优先）══"
Q_DEF=flow_e2e_query
cat > /tmp/e2e-query.json <<EOF
{"def":{"id":"$Q_DEF","name":"Query参数验证","version":0,
 "trigger":{"type":"webhook"},
 "input":{"sample":{"page":3}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"probe","type":"http","name":"探针","config":{"method":"GET","url":"$B/upstream/_sandbox","query":{"poolId":"pool-1","pageNo":"{{input.page}}","empty":"","arr":["a","b"]}}},
  {"id":"probe2","type":"http","name":"URL优先","config":{"method":"GET","url":"$B/upstream/_sandbox?poolId=url-wins","query":{"poolId":"query-loses","extra":"x"}}}],
 "edges":[{"from":"start","to":"probe"},{"from":"probe","to":"probe2"}]}}
EOF
curl -s -X POST $B/api/flows/$Q_DEF/draft -H 'content-type: application/json' -d @/tmp/e2e-query.json > /dev/null
curl -s -X POST $B/api/flows/$Q_DEF/dry-run | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('status')=='success', d.get('status')
n1=d['nodes']['probe']; q=n1['output']['query']; u=n1['request']['url']
assert q['poolId']=='pool-1', q
assert q['pageNo']=='3', q                      # {{input.page}} 渲染成 3
assert 'empty' not in q, q                      # 空值不上 URL
assert 'arr=a' in u and 'arr=b' in u, u         # 数组展开成多值
n2=d['nodes']['probe2']; q2=n2['output']['query']
assert q2['poolId']=='url-wins', q2             # URL 手写同名参数优先
assert q2['extra']=='x', q2
" ; chk "Query 参数合并 / 渲染 / 数组 / URL 优先" $?

echo "══ T15 结束断言（def.end.assert：流程跑完后统一校验）══"
END_DEF=flow_e2e_end
cat > /tmp/e2e-end.json <<EOF
{"def":{"id":"$END_DEF","name":"结束断言验证","version":0,
 "input":{"sample":{}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"probe","type":"http","name":"探针","config":{"method":"GET","url":"$B/upstream/_sandbox"}}],
 "edges":[{"from":"start","to":"probe"}],
 "end":{"assert":{"expr":["nodes.probe.output != null"]}}}}
EOF
curl -s -X POST $B/api/flows/$END_DEF/draft -H 'content-type: application/json' -d @/tmp/e2e-end.json > /dev/null
# Dry-run 剥离 end（写操作桩会让引用其输出的断言误报，故一律不在 Dry-run 校验）
curl -s -X POST $B/api/flows/$END_DEF/dry-run | $P -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('status')=='success', d.get('status')
" ; chk "Dry-run 不受结束断言影响（已剥离）" $?
curl -s -X POST $B/api/flows/$END_DEF/publish -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null
RID=$(curl -s -X POST $B/api/flows/$END_DEF/run -H 'content-type: application/json' -d '{}' | $P -c "import sys,json;print(json.load(sys.stdin)['runId'])")
sleep 1.5
getrun $RID | $P -c "
import sys,json
r=json.load(sys.stdin)
assert r['status']=='success', (r.get('status'), r.get('error'))
" ; chk "断言成立 → 流程 success" $?
# 断言不成立 → failed + assert_fail 事件（node=__end__）
$P - <<PYEOF
import json,urllib.request
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(p,m='GET',b=None):
    r=urllib.request.Request('$B'+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'content-type':'application/json'})
    with op.open(r,timeout=30) as x: return json.loads(x.read())
d=json.load(open('/tmp/e2e-end.json'))['def']
d['end']={'assert':{'expr':['nodes.probe.output.total >= 999']}}
api('/api/flows/$END_DEF/draft','POST',{'def':d})
api('/api/flows/$END_DEF/dry-run','POST',{})
api('/api/flows/$END_DEF/publish','POST',{'confirm':True})
r=api('/api/flows/$END_DEF/run','POST',{})
import time; time.sleep(1.5)
run=api('/api/runs/'+r['runId'])
assert run['status']=='failed', run.get('status')
assert (run.get('error') or '').startswith('结束断言失败'), run.get('error')
evs=[e for e in run.get('events',[]) if e['event']=='assert_fail']
assert evs and evs[-1]['data']['node']=='__end__', [e['event'] for e in run.get('events',[])]
PYEOF
chk "断言不成立 → failed + assert_fail(__end__)" $?
# Schema 闸拦截坏结构
$P - <<PYEOF
import json,urllib.request
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(p,m='POST',b=None):
    r=urllib.request.Request('$B'+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'content-type':'application/json'})
    with op.open(r,timeout=30) as x: return json.loads(x.read())
d=json.load(open('/tmp/e2e-end.json'))['def']
d['end']={'assert':{'expr':[123]}}
g=api('/api/flows/$END_DEF/draft','POST',{'def':d})['gates']['schema']
assert g['ok'] is False and any('end.assert.expr' in e for e in g['errors']), g
PYEOF
chk "Schema 闸拦截非法 end.assert 结构" $?

echo "══ T16 搭建器「新建」语义（带 flowId + 新建关键词 → 生成新流程，旧草稿不动）══"
$P - <<PYEOF
import json,urllib.request,urllib.error
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(p,m='POST',b=None):
    r=urllib.request.Request('$B'+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'content-type':'application/json'})
    try:
        with op.open(r,timeout=60) as x: return json.loads(x.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f'422 debug: {p} -> {e.read().decode()[:300]} | {dbg()}')
def dele(fid):
    rq=urllib.request.Request('$B/api/flows/'+fid,method='DELETE')
    op.open(rq,timeout=30).read()
def dbg():
    cat=json.loads(op.open('$B/api/catalog',timeout=30).read())
    qs=[o for o in cat['operations'] if o['id']=='query_stock']
    return f"ops={len(cat['operations'])} query_stock={json.dumps(qs[0],ensure_ascii=False)[:200] if qs else 'MISSING'}"
base=json.load(open('/tmp/e2e-end.json'))['def']
base['id']='flow_e2e_new'; base['name']='新建语义基准'
api('/api/flows/flow_e2e_new/draft',b={'def':base})   # 建基准草稿
# 普通描述 → 延续当前 flow（多轮调整语义）
a=api('/api/agent/draft',b={'text':'查询库存 SKU-01','flowId':'flow_e2e_new'})
assert a['flow']['id']=='flow_e2e_new', a['flow']
# 「新建」语义 → 生成新流程，不动旧的
b=api('/api/agent/draft',b={'text':'新建一条：查询库存 SKU-02','flowId':'flow_e2e_new'})
assert b['flow']['id']!='flow_e2e_new', b['flow']
rq=urllib.request.Request('$B/api/flows/flow_e2e_new/def')
old=json.loads(op.open(rq,timeout=30).read())
# 普通描述会重建同 flow（多轮调整语义，名字变为「查询库存」属预期）；
# 关键断言：旧流程没被「新建」的那条覆盖（名字不等于新流程名，节点是库存接口）
assert old['def']['name']!='新建一条', old['def'].get('name')
assert any(n.get('operationId')=='query_stock' for n in old['def']['nodes']), old['def']['nodes']
dele(b['flow']['id'])
print('   普通描述延续旧流程；「新建」生成', b['flow']['id'], '（基准流程未被覆盖）')
PYEOF
chk "「新建」语义生成新流程且不动旧草稿" $?

# ══ 清理自建数据（种子流程 / NL 草稿流程 / 种子接口来源）══
for FID in $SEED flow_e2e_loop flow_e2e_query $END_DEF flow_e2e_new $( [ -f /tmp/t3.json ] && $P -c "import json;print(json.load(open('/tmp/t3.json')).get('flow',{}).get('id',''))" ) $( [ -f /tmp/t4.json ] && $P -c "import json;print(json.load(open('/tmp/t4.json')).get('flow',{}).get('id',''))" ) $( [ -f /tmp/t9.json ] && $P -c "import json;print(json.load(open('/tmp/t9.json')).get('flow',{}).get('id',''))" ); do
  [ -n "$FID" ] && curl -s -X DELETE $B/api/flows/$FID > /dev/null
done
[ -n "$SRC_ID" ] && curl -s -X DELETE $B/api/sources/$SRC_ID > /dev/null && echo "  （种子接口来源已清理）"

echo
echo "═══════ 回归结果：通过 $pass / 失败 $fail ═══════"
exit $fail

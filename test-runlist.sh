#!/bin/bash
# APIFlow 运行记录列表回归：GET /api/runs?brief=1 摘要（供运行观测左栏「运行记录」）
# 种子自保障：自建流程与运行记录，结尾全部清理，不动平台里的用户数据
P=python3
B=http://127.0.0.1:3300
pass=0; fail=0
chk() {
  if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
call() {   # call <method> <path> [json]
  $P - "$1" "$2" "${3:-}" <<'PY'
import json,sys,urllib.request,urllib.error
m,p,body=sys.argv[1],sys.argv[2],sys.argv[3]
req=urllib.request.Request('http://127.0.0.1:3300'+p, method=m,
  data=body.encode() if body else None, headers={'content-type':'application/json'})
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with op.open(req, timeout=30) as r: print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode() or '{}')
PY
}

FA=flow_runlist_a; FB=flow_runlist_f

cleanup() {
  call DELETE /api/flows/$FA > /dev/null
  call DELETE /api/flows/$FB > /dev/null
  call DELETE "/api/runs?flowId=$FA" > /dev/null     # 删流程不级联删运行记录，重复跑要一并清
  call DELETE "/api/runs?flowId=$FB" > /dev/null
}
trap cleanup EXIT
cleanup   # 上次异常退出可能残留

# 失败样例的构造：dry-run 只跑只读节点（GET _sandbox 过闸），运行时非只读 POST 打不存在路径 → 节点失败
echo "── 种子：两个流程（一个会成功、一个运行时必失败）──"
call POST /api/flows/$FA/draft "{\"def\":{\"id\":\"$FA\",\"name\":\"运行列表-成功样例\",\"version\":0,\"input\":{\"sample\":{}},
  \"nodes\":[{\"id\":\"start\",\"type\":\"start\",\"name\":\"开始\",\"config\":{}},
            {\"id\":\"ping\",\"type\":\"http\",\"name\":\"ping\",\"config\":{\"method\":\"GET\",\"url\":\"$B/upstream/_sandbox\"}}],
  \"edges\":[{\"from\":\"start\",\"to\":\"ping\"}],\"layout\":{}}}" > /dev/null
call POST /api/flows/$FA/dry-run '{}' > /dev/null
call POST /api/flows/$FA/publish '{"confirm":true}' > /dev/null
call POST /api/flows/$FB/draft "{\"def\":{\"id\":\"$FB\",\"name\":\"运行列表-失败样例\",\"version\":0,\"input\":{\"sample\":{}},
  \"nodes\":[{\"id\":\"start\",\"type\":\"start\",\"name\":\"开始\",\"config\":{}},
            {\"id\":\"ping\",\"type\":\"http\",\"name\":\"ping\",\"config\":{\"method\":\"GET\",\"url\":\"$B/upstream/_sandbox\"}},
            {\"id\":\"push\",\"type\":\"http\",\"name\":\"push\",\"config\":{\"method\":\"POST\",\"url\":\"$B/upstream/_no_such_path_xyz\"}}],
  \"edges\":[{\"from\":\"start\",\"to\":\"ping\"},{\"from\":\"ping\",\"to\":\"push\"}],\"layout\":{}}}" > /dev/null
call POST /api/flows/$FB/dry-run '{}' > /dev/null
call POST /api/flows/$FB/publish '{"confirm":true}' > /dev/null
call POST /api/flows/$FA/run '{}' > /dev/null
sleep 0.5
call POST /api/flows/$FA/run '{}' > /dev/null
sleep 0.5
call POST /api/flows/$FB/run '{}' > /dev/null
sleep 1.2

echo "── brief=1 摘要 ──"
BODY=$(call GET "/api/runs?brief=1&flowId=$FA" | cut -d' ' -f2-)
echo "$BODY" | $P -c "
import sys,json
d=json.load(sys.stdin)
assert len(d)==2, f'条数应为 2，实得 {len(d)}'
r=d[0]
need=['id','num','flowId','flowName','version','status','trigger','startedAt','durationMs','nodeTotal','nodeOk','nodeFail','error']
missing=[k for k in need if k not in r]
assert not missing, f'缺字段 {missing}'
assert 'nodes' not in r and 'events' not in r, '摘要不应搬运 nodes/events 全量'
assert r['status']=='success' and r['nodeTotal']==2 and r['nodeOk']==2 and r['nodeFail']==0, f'成功样例计数异常 {r}'
print('OK')" > /tmp/rl_out 2>&1
chk "brief 返回 2 条且字段齐全（无 nodes/events 全量）" $?
cat /tmp/rl_out | tail -1

BODY=$(call GET "/api/runs?brief=1&flowId=$FB" | cut -d' ' -f2-)
echo "$BODY" | $P -c "
import sys,json
d=json.load(sys.stdin)
assert len(d)==1
r=d[0]
assert r['status']=='failed', r['status']
assert r['nodeFail']>=1 and r['error'], f'失败样例应带 error 摘要 {r}'
print('OK')" > /tmp/rl_out 2>&1
chk "失败样例：nodeFail>=1 且 error 摘要非空" $?
cat /tmp/rl_out | tail -1

BODY=$(call GET "/api/runs?flowId=$FA" | cut -d' ' -f2-)
echo "$BODY" | $P -c "
import sys,json
d=json.load(sys.stdin)
assert 'nodes' in d[0] and 'events' in d[0], '默认 /api/runs 必须保持全量（插件与测试依赖 nodes）'
print('OK')" > /tmp/rl_out 2>&1
chk "不带 brief 的 /api/runs 仍返回全量（兼容旧调用方）" $?
cat /tmp/rl_out | tail -1

echo "── 删除联动 ──"
RID=$($P -c "import json;print(json.loads('''$BODY''')[0]['id'])" 2>/dev/null)
BODY=$(call GET "/api/runs?brief=1&flowId=$FA" | cut -d' ' -f2-)
RID=$($P -c "import json;print(json.loads('''$BODY''')[0]['id'])")
CODE=$(call DELETE /api/runs/$RID | cut -d' ' -f1)
[ "$CODE" = "200" ] ; chk "DELETE 单条 200" $?
N=$(call GET "/api/runs?brief=1&flowId=$FA" | $P -c "import sys,json;print(len(json.loads(sys.stdin.read().split(' ',1)[1])))")
[ "$N" = "1" ] ; chk "删除后 brief 只剩 1 条" $?
N=$(call DELETE "/api/runs?flowId=$FA" | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['deleted'])")
[ "$N" -ge 1 ] ; chk "按流程清空 deleted=$N（含列表不显示的 dry-run 隐藏记录）" $?
N=$(call GET "/api/runs?brief=1&flowId=$FA" | $P -c "import sys,json;print(len(json.loads(sys.stdin.read().split(' ',1)[1])))")
[ "$N" = "0" ] ; chk "清空后 brief 为 0 条" $?

echo
echo "通过 $pass / $((pass+fail))"
[ "$fail" = "0" ]

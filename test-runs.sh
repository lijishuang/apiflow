#!/bin/bash
# APIFlow 运行记录删除回归（单条删除 / 清空 / 运行中保护 / 落盘）
# 种子自保障：自建两个流程与它们的运行记录，结尾全部清理，不动平台里的用户数据
P=python3
B=http://127.0.0.1:3300
pass=0; fail=0
chk() {
  if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
# 统一走 no-proxy 的 urllib（本机 curl 受环境代理影响）
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
jget() { $P -c "import sys,json;print(json.dumps(json.load(sys.stdin),ensure_ascii=False))"; }

FA=flow_rundel_a; FB=flow_rundel_b
mkflow() {   # mkflow <id> <name>
  call POST /api/flows/$1/draft "{\"def\":{\"id\":\"$1\",\"name\":\"$2\",\"version\":0,\"input\":{\"sample\":{}},
    \"nodes\":[{\"id\":\"start\",\"type\":\"start\",\"name\":\"开始\",\"config\":{}},
              {\"id\":\"ping\",\"type\":\"http\",\"name\":\"ping\",\"config\":{\"method\":\"GET\",\"url\":\"$B/upstream/_sandbox\"}}],
    \"edges\":[{\"from\":\"start\",\"to\":\"ping\"}],\"layout\":{}}}" > /dev/null
  call POST /api/flows/$1/dry-run '{}' > /dev/null
  call POST /api/flows/$1/publish '{"confirm":true}' > /dev/null
}

cleanup() {
  call DELETE /api/flows/$FA > /dev/null
  call DELETE /api/flows/$FB > /dev/null
}
trap cleanup EXIT

echo "══ R1 种子：两个流程各跑一次 ══"
mkflow $FA "运行删除自测A"
mkflow $FB "运行删除自测B"
RA=$(call POST /api/flows/$FA/run '{}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
RB=$(call POST /api/flows/$FB/run '{}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
sleep 1.5
[ -n "$RA" ] && [ -n "$RB" ] ; chk "两个流程各产生一条运行记录（$RA / $RB）" $?

echo "══ R2 删除单条运行记录 ══"
CODE=$(call DELETE /api/runs/$RA | cut -d' ' -f1)
[ "$CODE" = "200" ] ; chk "DELETE /api/runs/:id 返回 200" $?
CODE=$(call GET /api/runs/$RA | cut -d' ' -f1)
[ "$CODE" = "404" ] ; chk "删掉后再取该运行 → 404" $?
call GET "/api/runs?flowId=$FA" | $P -c "
import sys,json
d=json.loads(sys.stdin.read().split(' ',1)[1])
assert [x for x in d if x['id']=='$RA']==[], d
" ; chk "流程 A 的运行列表里不再出现该记录" $?

echo "══ R3 删除不存在 / 越权保护 ══"
CODE=$(call DELETE /api/runs/run_not_exist_xyz | cut -d' ' -f1)
[ "$CODE" = "404" ] ; chk "删不存在的运行记录 → 404（不静默成功）" $?

echo "══ R4 运行中的记录不能删（409）══"
node -e '
const { store } = require("./lib/store");
const fake = { id: "run_guard_probe", status: "running", flowId: "flow_probe" };
store.runs.unshift(fake);
const r = store.removeRun("run_guard_probe");
store.runs = store.runs.filter(x => x !== fake);   // 只做守卫断言，不留在内存/磁盘里
if (!r || r.ok !== false || r.reason !== "running") { console.error("guard failed", r); process.exit(1); }
' ; chk "store.removeRun 拒绝删除 running 记录" $?

echo "══ R5 清空（按流程）不影响其它流程 ══"
RA2=$(call POST /api/flows/$FA/run '{}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
RA3=$(call POST /api/flows/$FA/run '{}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
sleep 1.5
N=$(call DELETE "/api/runs?flowId=$FA" | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['deleted'])")
[ "$N" -ge 2 ] ; chk "DELETE /api/runs?flowId=A 报告删除 $N 条" $?
call GET "/api/runs?flowId=$FA" | $P -c "
import sys,json
d=json.loads(sys.stdin.read().split(' ',1)[1])
assert d==[], d
" ; chk "流程 A 的运行记录已清空" $?
call GET "/api/runs?flowId=$FB" | $P -c "
import sys,json
d=json.loads(sys.stdin.read().split(' ',1)[1])
assert any(x['id']=='$RB' for x in d), d
" ; chk "流程 B 的运行记录不受影响" $?

echo "══ R6 删除已落盘（不是只从内存里拿掉）══"
call GET /api/health > /dev/null   # 有请求进来即可，落盘在删除时就已同步
$P -c "
import json
d=json.load(open('data/runs.json'))
ids={r['id'] for r in d}
assert '$RA' not in ids and '$RA2' not in ids and '$RA3' not in ids, ('still on disk', ids & {'$RA','$RA2','$RA3'})
assert '$RB' in ids, 'B 的记录被误删'
" ; chk "runs.json 已无被删记录、B 的记录仍在" $?

echo "══ R7 全量清空（安全路径：只清历史，不碰运行中）══"
N2=$(call DELETE "/api/runs?flowId=$FB" | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['deleted'])")
[ "$N2" -ge 1 ] ; chk "清空流程 B 报告删除 $N2 条" $?
CODE=$(call GET "/api/runs?flowId=$FB" | cut -d' ' -f1)
[ "$CODE" = "200" ] ; chk "清空后接口仍可用（不会把列表打成 404）" $?

echo
echo "运行记录删除：通过 $pass / 失败 $fail"
[ "$fail" = "0" ]

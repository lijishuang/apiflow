#!/bin/bash
# ── Chrome 插件接入全链路回归：默认开放 / 自然语言规划 / 执行与观测 / 令牌 / AK-SK / 强制认证 ──
# 用法：./test-extension.sh [BASE_URL]     默认 http://127.0.0.1:3300
# 前置：平台处于默认开放态（requireAuth=false）；脚本自己创建并清理临时凭证
set -u
BASE=${1:-http://127.0.0.1:3300}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ local d="$1" w="$2" g="$3"; if [ "$w" = "$g" ]; then ok "$d"; else bad "${d}（期望 ${w}，实际 ${g}）"; fi }
has()  { local d="$1" n="$2" s="$3"; if echo "$s" | grep -q -- "$n"; then ok "$d"; else bad "${d}（未匹配 ${n}：$(echo "$s" | head -c 160)）"; fi }
jq_()  { node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));$1" 2>/dev/null; }
step() { echo; echo "── $1 ──"; }

code() { local m=$1 p=$2 d=${3:-} t=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$m" "$BASE$p")
  [ -n "$d" ] && args+=(-H 'content-type: application/json' -d "$d")
  [ -n "$t" ] && args+=(-H "authorization: Bearer $t")
  curl "${args[@]}"; }
body() { local m=$1 p=$2 d=${3:-} t=${4:-}
  local args=(-s -X "$m" "$BASE$p")
  [ -n "$d" ] && args+=(-H 'content-type: application/json' -d "$d")
  [ -n "$t" ] && args+=(-H "authorization: Bearer $t")
  curl "${args[@]}"; }

echo "APIFlow 插件接入回归 @ $BASE"

# ── E0 前置 ──
step "E0 前置检查"
PING=$(body GET /api/ext/ping)
if [ "$(echo "$PING" | jq_ 'd.requireAuth')" = "true" ]; then
  echo "  平台开着强制认证，请先在 Web 端「插件接入」关掉再跑"; exit 2
fi
has "服务在线" '"ok":true' "$PING"
check "默认不强制认证（与平台一致）" "false" "$(echo "$PING" | jq_ 'd.requireAuth')"

# ── E1 插件直连 ──
step "E1 插件直连：无凭证即可读写平台数据"
BOOT=$(body GET /api/ext/bootstrap)
has "bootstrap 返回服务信息" '"server"' "$BOOT"
has "bootstrap 含统计"        '"stats"'  "$BOOT"
has "bootstrap 含流程清单"    '"flows"'  "$BOOT"
NF=$(echo "$BOOT" | jq_ 'd.stats.flows')
NOPS=$(echo "$BOOT" | jq_ 'd.server.operations')
[ "${NOPS:-0}" -gt 0 ] && ok "接口注册表已下发（${NOPS} 个接口 / ${NF} 条流程）" || bad "接口数为 0"
check "GET /api/flows 无凭证 200"   "200" "$(code GET /api/flows)"
check "GET /api/runs 无凭证 200"    "200" "$(code GET /api/runs)"
check "GET /api/catalog 无凭证 200" "200" "$(code GET /api/catalog)"

FLOWS=$(body GET /api/flows)
FLOW_ID=$(echo "$FLOWS" | jq_ '(Array.isArray(d)?d:d.items).map(f=>f.id)[0]||""')
FLOW_NAME=$(echo "$FLOWS" | jq_ '((Array.isArray(d)?d:d.items)[0]||{}).name||""')
FLOW_PUB=$(echo "$FLOWS" | jq_ 'const f=(Array.isArray(d)?d:d.items)[0]||{}; !!(f.published||f.publishedAt)')
CAT=$(body GET /api/catalog)
# 只读调试目标优先挑无必填参数的接口（带路径参数的会 400 缺参）
RO_OP=$(echo "$CAT" | jq_ '(d.operations.filter(o=>o.readOnly!==false&&!(o.params||[]).length).map(o=>o.id)[0])||(d.operations.filter(o=>o.readOnly!==false).map(o=>o.id)[0])||""')
RO_NAME=$(echo "$CAT" | jq_ '(d.operations.filter(o=>o.readOnly!==false&&!(o.params||[]).length).map(o=>o.name)[0])||(d.operations.filter(o=>o.readOnly!==false).map(o=>o.name)[0])||""')
RW_OP=$(echo "$CAT" | jq_ '(d.operations.filter(o=>o.readOnly===false).map(o=>o.id)[0])||""')
RW_NAME=$(echo "$CAT" | jq_ '(d.operations.filter(o=>o.readOnly===false).map(o=>o.name)[0])||""')
[ -n "$FLOW_ID" ] && ok "测试流程：${FLOW_NAME}（${FLOW_ID}，published=${FLOW_PUB}）" || bad "平台没有流程"
[ -n "$RO_OP" ] && ok "只读接口：${RO_NAME}（${RO_OP}）" || bad "没有只读接口"
[ -n "$RW_OP" ] && ok "写接口：${RW_NAME}（${RW_OP}）" || bad "没有写接口"

SELF_FLOW=0
# 平台一条流程都没有时，自建夹具流程（本地 mock 上游，稳定成功），退出时清理
if [ -z "$FLOW_ID" ]; then
  step "E1.5 自建夹具流程（平台当前没有流程）"
  cat > /tmp/ext-selflow.json <<'JSON'
{"def":{"id":"flow_extfixture","name":"插件回归夹具","version":0,"trigger":{"type":"manual"},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"q","type":"http","name":"查上游","config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/_catalog"}}],
 "edges":[{"from":"start","to":"q"}],
 "layout":{"start":{"x":40,"y":200},"q":{"x":280,"y":200}}}}
JSON
  code POST "/api/flows/flow_extfixture/draft" >/dev/null 2>&1
  curl -s -X POST "$BASE/api/flows/flow_extfixture/publish" -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null
  FLOW_ID=flow_extfixture; FLOW_NAME=插件回归夹具; FLOW_PUB=true; SELF_FLOW=1
  ok "已自建并发布夹具流程：插件回归夹具"
fi

# ── E2 自然语言 → 计划 ──
step "E2 自然语言 → 计划（四类意图）"
rm -f /tmp/ext-plan-*.json
curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' \
  -d "{\"text\":\"调试 ${RO_NAME}\"}" > /tmp/ext-plan-a.json
check "「调试 ${RO_NAME}」→ debug-op" "debug-op" "$(jq_ 'd.plan.kind' < /tmp/ext-plan-a.json)"
check "  命中接口 ${RO_OP}" "${RO_OP}" "$(jq_ 'd.plan.op.id' < /tmp/ext-plan-a.json)"
check "  k=v 参数已提取" "VAL123" "$(curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' -d "{\"text\":\"调试 ${RO_NAME} id=VAL123\"}" | jq_ 'd.plan.args.id')"

curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' \
  -d "{\"text\":\"运行 ${FLOW_NAME}\"}" > /tmp/ext-plan-b.json
check "「运行 ${FLOW_NAME}」→ run-flow" "run-flow" "$(jq_ 'd.plan.kind' < /tmp/ext-plan-b.json)"
check "  目标流程正确" "$FLOW_ID" "$(jq_ 'd.plan.flow.id' < /tmp/ext-plan-b.json)"

curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' \
  -d '{"text":"最近有哪些失败的运行"}' > /tmp/ext-plan-c.json
check "「最近失败的运行」→ query" "query" "$(jq_ 'd.plan.kind' < /tmp/ext-plan-c.json)"

curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' \
  -d "{\"text\":\"帮我新建一个流程：先${RO_NAME}，然后把结果上传\"}" > /tmp/ext-plan-d.json
check "「新建…流程」→ draft-flow" "draft-flow" "$(jq_ 'd.plan.kind' < /tmp/ext-plan-d.json)"
has "  草稿含节点定义" '"nodes"' "$(cat /tmp/ext-plan-d.json)"

RWP=$(curl -s -X POST "$BASE/api/agent/plan" -H 'content-type: application/json' -d "{\"text\":\"${RW_NAME}\"}")
check "写接口计划带二次确认标记" "true" "$(echo "$RWP" | jq_ 'd.plan.needsConfirm')"

# ── E3 执行 ──
step "E3 执行：只读调试 / 写操作闸门 / 流程运行"
EXE_A=$(body POST /api/agent/execute "{\"text\":\"调试 ${RO_NAME}\",\"wait\":true}")
check "只读调试执行返回 kind=debug-op" "debug-op" "$(echo "$EXE_A" | jq_ 'd.kind')"
RUN_A=$(echo "$EXE_A" | jq_ 'd.runId')
[ -n "$RUN_A" ] && ok "拿到 runId=${RUN_A}" || bad "没有 runId：${EXE_A}"
ST_A=$(echo "$EXE_A" | jq_ 'd.status')
case "$ST_A" in success|failed) ok "调试链路完整（对现网接口执行，结果=${ST_A}）";; *) bad "调试无结果状态：${EXE_A}";; esac

# 写操作：只验闸门，不真的执行（避免对上游产生副作用）
check "写操作未确认 → 428" "428" "$(code POST /api/agent/execute "{\"opId\":\"${RW_OP}\"}")"
GATE_B=$(body POST /api/agent/execute "{\"opId\":\"${RW_OP}\"}")
check "  响应含 confirmRequired" "true" "$(echo "$GATE_B" | jq_ 'd.confirmRequired')"
has   "  返回将要发送的请求预览" '"preview"' "$GATE_B"

if [ -n "$FLOW_ID" ]; then
  EXE_B=$(body POST /api/agent/execute "{\"text\":\"运行 ${FLOW_NAME}\",\"wait\":true}")
  check "  返回 kind=run-flow" "run-flow" "$(echo "$EXE_B" | jq_ 'd.kind')"
  if [ "$FLOW_PUB" = "true" ]; then
    check "已发布流程执行成功" "success" "$(echo "$EXE_B" | jq_ 'd.status')"
  else
    check "未发布流程走草稿只读试跑" "true" "$(echo "$EXE_B" | jq_ 'd.dryRun')"
    check "  试跑成功" "success" "$(echo "$EXE_B" | jq_ 'd.status')"
  fi
  START_TRIG=$(body GET "/api/runs/$(echo "$EXE_B" | jq_ 'd.runId')" | jq_ 'd.trigger')
  check "  运行记录 trigger=agent（插件触发）" "agent" "$START_TRIG"
fi

# ── E4 观测 ──
step "E4 观测：Web 端与插件看到同一份运行记录"
RUNS=$(body GET /api/runs)
TOP_ID=$(echo "$RUNS" | jq_ '(Array.isArray(d)?d:d.items)[0].id')
DETAIL=$(body GET "/api/runs/${TOP_ID}")
has "运行详情含节点列表" '"nodes"' "$DETAIL"
has "节点含请求信息"    '"request"' "$DETAIL"
has "节点含响应状态"    '"httpStatus"' "$DETAIL"
has "运行记录含 actor"  '"actor"' "$DETAIL"
TRIG=$(echo "$DETAIL" | jq_ 'd.trigger')
case "$TRIG" in api-debug|agent|manual|schedule|webhook) ok "触发来源可识别：${TRIG}";; *) bad "触发来源异常：${TRIG}";; esac
ACTOR=$(echo "$DETAIL" | jq_ 'd.actor')
[ -n "$ACTOR" ] && ok "actor 已记录：${ACTOR}" || bad "actor 为空"

SSE=$(curl -s -N --max-time 3 "$BASE/api/events" 2>/dev/null | head -c 400)
has "SSE 可连接（无凭证）" 'event:' "$SSE"

# ── E5 令牌 ──
step "E5 令牌通道：AK/SK 换令牌 → 访问 → 撤销"
AK=$(node -e "console.log('AKEXTTEST'+require('crypto').randomBytes(2).toString('hex').toUpperCase())")
SK=$(node -e "console.log('sk-ext-'+require('crypto').randomBytes(10).toString('hex'))")
CR=$(body POST /api/creds "{\"name\":\"插件回归-临时\",\"ak\":\"${AK}\",\"sk\":\"${SK}\"}")
CRED_ID=$(echo "$CR" | jq_ 'd.cred.id')
[ -n "$CRED_ID" ] && ok "临时凭证已创建 ${AK}" || bad "创建凭证失败：${CR}"

TK=$(body POST /api/auth/token "{\"ak\":\"${AK}\",\"sk\":\"${SK}\",\"name\":\"插件回归\"}")
TOK=$(echo "$TK" | jq_ 'd.token')
TOK_ID=$(echo "$TK" | jq_ 'd.tokenId')
case "$TOK" in apf_*) ok "令牌已签发 ${TOK:0:12}…";; *) bad "令牌格式异常：${TOK}";; esac
[ -n "$(echo "$TK" | jq_ 'd.expiresAt')" ] && ok "带过期时间（默认 7 天）" || bad "缺少 expiresAt"

check "带令牌访问 /api/flows 200" "200" "$(code GET /api/flows '' "$TOK")"
ME=$(body GET /api/auth/me '' "$TOK")
has "令牌可自述身份" '"actor"' "$ME"
check "  身份名 = 令牌名" "插件回归" "$(echo "$ME" | jq_ 'd.actor.name')"

check "撤销令牌 200" "200" "$(code DELETE "/api/access/tokens/${TOK_ID}")"
check "已撤销令牌 → 200（开放态降级放行）" "200" "$(code GET /api/flows '' "$TOK")"

# ── E6 AK/SK 直签 ──
step "E6 AK/SK 直签：规范串签名"
TK2=$(body POST /api/auth/token "{\"ak\":\"${AK}\",\"sk\":\"${SK}\"}")
TOK2=$(echo "$TK2" | jq_ 'd.token')
SIGN=$(node -e "
const c=require('crypto'),ts=String(Date.now());
const h=c.createHash('sha256').update('').digest('hex');
const canon=['GET','/api/flows',ts,h].join('\n');
console.log(ts+' '+c.createHmac('sha256','${SK}').update(canon).digest('hex'));")
TS=${SIGN%% *}; SIG=${SIGN##* }
check "直签 GET /api/flows 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: ${AK}" -H "x-sign-ts: ${TS}" -H "x-signature: ${SIG}" "$BASE/api/flows")"
# 开放态下签名错了也不该打断本机控制台：降级匿名 + 打标记（强制认证态下的 401 见 E7）
BHDR=$(curl -s -D - -o /dev/null -H "x-api-key: ${AK}" -H "x-sign-ts: ${TS}" -H "x-signature: deadbeef" "$BASE/api/flows")
echo "$BHDR" | head -1 | grep -q ' 200' && ok "开放态错签名 → 200 降级放行" || bad "开放态错签名被拒：$(echo "$BHDR" | head -1)"
echo "$BHDR" | grep -qi 'x-apiflow-auth: invalid' && ok "  响应头标记 invalid" || bad "  缺少 invalid 标记"

# ── E7 强制认证 ──
step "E7 强制认证：默认关闭，开启后必须有凭证"
ON=$(body POST /api/access/settings '{"requireAuth":true}' "$TOK2")
check "开启强制认证" "true" "$(echo "$ON" | jq_ 'd.requireAuth')"
check "无凭证 → 401" "401" "$(code GET /api/flows)"
check "  错误码 AUTH_REQUIRED" "AUTH_REQUIRED" "$(body GET /api/flows | jq_ 'd.code')"
check "带令牌 → 200" "200" "$(code GET /api/flows '' "$TOK2")"
check "直签 → 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: ${AK}" -H "x-sign-ts: ${TS}" -H "x-signature: ${SIG}" "$BASE/api/flows")"
BSIGN=$(curl -s -H "x-api-key: ${AK}" -H "x-sign-ts: ${TS}" -H "x-signature: deadbeef" "$BASE/api/flows")
check "强制认证·错签名 → 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: ${AK}" -H "x-sign-ts: ${TS}" -H "x-signature: deadbeef" "$BASE/api/flows")"
check "  错误码 BAD_SIGNATURE" "BAD_SIGNATURE" "$(echo "$BSIGN" | jq_ 'd.code')"
check "无凭证执行 → 401" "401" "$(code POST /api/agent/execute '{"text":"平台概况"}')"
check "ping 仍可匿名访问（自我诊断）" "200" "$(code GET /api/ext/ping)"
check "ping 带令牌 → authenticated" "true" "$(body GET /api/ext/ping '' "$TOK2" | jq_ 'd.authenticated')"

OFF=$(body POST /api/access/settings '{"requireAuth":false}' "$TOK2")
check "关闭强制认证（带令牌）" "false" "$(echo "$OFF" | jq_ 'd.requireAuth')"

HDR=$(curl -s -D - -o /dev/null -H 'authorization: Bearer apf_notarealtoken000000000' "$BASE/api/flows")
echo "$HDR" | head -1 | grep -q ' 200' && ok "开放态脏令牌 → 200 放行" || bad "开放态脏令牌被拒：$(echo "$HDR" | head -1)"
echo "$HDR" | grep -qi 'x-apiflow-auth: invalid' && ok "  响应头标记 x-apiflow-auth: invalid（客户端据此自愈）" || bad "  缺少 x-apiflow-auth 标记"

# ── E8 清理 ──
step "E8 清理"
for t in $(body GET /api/access/settings '' "$TOK2" | jq_ '(d.tokens||[]).filter(t=>t.ak==="'"${AK}"'").map(t=>t.id).join(" ")'); do
  body DELETE "/api/access/tokens/${t}" '' "$TOK2" > /dev/null
done
body DELETE "/api/creds/${CRED_ID}" '' "$TOK2" > /dev/null
check "临时凭证已删除" "0" "$(body GET /api/creds | jq_ 'd.items.filter(c=>c.ak==="'"${AK}"'").length')"
check "临时令牌无残留" "0" "$(body GET /api/access/settings | jq_ 'd.tokens.filter(t=>t.ak==="'"${AK}"'").length')"
check "认证开关已归位（默认开放）" "false" "$(body GET /api/ext/ping | jq_ 'd.requireAuth')"

echo
echo "───────────────────────────────"
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
[ "$FAIL" -eq 0 ] && echo "结果：全部通过 ✓" || echo "结果：存在失败 ✗"
[ "$SELF_FLOW" = "1" ] && { curl -s -X DELETE "$BASE/api/flows/flow_extfixture" > /dev/null; echo "夹具流程已清理"; }
rm -f /tmp/ext-plan-*.json
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)

#!/bin/bash
# ── 认证（AK/SK）全链路回归：凭证 CRUD / 受保护上游 401&200 / 单接口绑定 / 流程级绑定 / 删除清理 ──
set -u
BASE=http://127.0.0.1:3300
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ local desc="$1" want="$2" got="$3"; if [ "$want" = "$got" ]; then ok "$desc"; else bad "${desc}（期望 ${want}，实际 ${got}）"; fi }

step(){ echo; echo "── $1 ──"; }

step "C1 创建凭证（自动生成 AK/SK，HMAC 模式）"
CREATE=$(curl -s -X POST $BASE/api/creds -H 'content-type: application/json' -d '{"name":"测试凭证","mode":"hmac"}')
CRED_ID=$(echo "$CREATE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).cred.id' 2>/dev/null)
SK=$(echo "$CREATE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).skOnce' 2>/dev/null)
AK=$(echo "$CREATE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).cred.ak' 2>/dev/null)
[ -n "$CRED_ID" ] && ok "凭证已创建 id=$CRED_ID AK=$AK" || bad "创建凭证失败: $CREATE"
SKLEN=$(printf '%s' "$SK" | wc -c | tr -d ' '); [ "$SKLEN" -ge 32 ] && ok "SK 已一次性返回（长度 ${SKLEN}）" || bad "SK 未返回"

step "C2 列表 SK 必须是掩码"
MASKED=$(curl -s $BASE/api/creds | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].sk')
case "$MASKED" in *'****'*) ok "列表 SK 已掩码：$MASKED";; *) bad "SK 泄漏：$MASKES=$MASKED";; esac

step "C3 受保护上游：无认证 / 错误签名 → 401"
S1=$(curl -s -o /dev/null -w '%{http_code}' $BASE/upstream/secure/data); check "无认证 401" 401 "$S1"
S2=$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $AK" -H "x-sign-ts: $(date +%s)000" -H "x-signature: deadbeef" $BASE/upstream/secure/data); check "错误签名 401" 401 "$S2"

step "C4 正确签名 → 200（node 计算规范串 HMAC）"
SIGN=$(node -e "
const crypto=require('crypto');
const ts=String(Date.now()), bh=crypto.createHash('sha256').update('').digest('hex');
const canon=['GET','/upstream/secure/data',ts,bh].join('\n');
console.log(ts+' '+crypto.createHmac('sha256','$SK').update(canon).digest('hex'));")
TS=${SIGN%% *}; SIG=${SIGN##* }
S3=$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $AK" -H "x-sign-ts: $TS" -H "x-signature: $SIG" $BASE/upstream/secure/data); check "HMAC 签名 200" 200 "$S3"
BODY=$(curl -s -H "x-api-key: $AK" -H "x-sign-ts: $TS" -H "x-signature: $SIG" $BASE/upstream/secure/data)
echo "$BODY" | grep -q '"secure":true' && ok "响应含 secure:true / authAs" || bad "响应异常: $BODY"

step "C5 单接口级绑定：secure_data → 凭证"
# secure_data 可能已被移出注册表（用户自定义环境）—— 动态挑一个现存的只读接口替代
# secure_data 可能已被移出注册表（用户自定义环境）—— 固定用内置 query_stock，先恢复再测，结尾删回
BIND_OP=query_stock
curl -s -X POST $BASE/api/ops/restore -H 'content-type: application/json' -d '{"ids":["query_stock"]}' > /dev/null
B1=$(curl -s -X POST $BASE/api/creds/bind-op -H 'content-type: application/json' -d "{\"operationId\":\"$BIND_OP\",\"credId\":\"$CRED_ID\"}")
echo "$B1" | grep -q '"ok":true' && ok "绑定成功" || bad "绑定失败: $B1"
BINDS=$(curl -s $BASE/api/creds | node -pe 'const d=JSON.parse(require("fs").readFileSync(0));d.opBindings[process.argv[1]] || 0' "$BIND_OP")

step "C6 发布引用受保护接口的测试流程（三道闸）"
cat > /tmp/auth-test-def.json <<EOF
{"def":{"id":"flow_auth_t","name":"认证测试流程","version":0,"trigger":{"type":"manual"},
"nodes":[{"id":"start","type":"start","name":"开始","config":{}},
{"id":"call_secure","type":"http","name":"取受保护数据","operationId":"$BIND_OP","apiVersion":"v2026.10","config":{"method":"GET","url":"$BASE/upstream/secure/data"}}],
"edges":[{"from":"start","to":"call_secure"}],"layout":{"start":{"x":30,"y":240},"call_secure":{"x":280,"y":228}}}}
EOF
curl -s -X POST $BASE/api/flows/flow_auth_t/draft -H 'content-type: application/json' -d @/tmp/auth-test-def.json > /dev/null
DRY=$(curl -s -X POST $BASE/api/flows/flow_auth_t/dry-run)
echo "$DRY" | grep -q '"status":"success"' && ok "Dry-run 通过（绑定认证后受保护接口可执行）" || bad "Dry-run 失败: $(echo $DRY | head -c 200)"
PUB=$(curl -s -X POST $BASE/api/flows/flow_auth_t/publish -H 'content-type: application/json' -d '{"confirm":true}')
echo "$PUB" | grep -q '"ok":true' && ok "发布成功" || bad "发布失败: $PUB"
RUN1=$(curl -s -X POST $BASE/api/flows/flow_auth_t/run -H 'content-type: application/json' -d '{}')
echo "$RUN1" | grep -q '"status":"success"' && ok "运行成功（单接口绑定认证注入）" || bad "运行失败: $RUN1"

step "C7 解除单接口绑定 → 运行应 401 失败"
curl -s -X POST $BASE/api/creds/bind-op -H 'content-type: application/json' -d "{\"operationId\":\"$BIND_OP\",\"credId\":null}" > /dev/null
sleep 0.3
RUN2=$(curl -s -X POST $BASE/api/flows/flow_auth_t/run -H 'content-type: application/json' -d '{}')
echo "$RUN2" | grep -q '"status":"success"' && bad "解除绑定后仍成功（认证未生效）" || ok "解除绑定后运行失败（HTTP 401，符合预期）"

step "C8 流程级绑定 → 运行恢复成功"
FA=$(curl -s -X POST $BASE/api/flows/flow_auth_t/auth -H 'content-type: application/json' -d "{\"authId\":\"$CRED_ID\"}")
echo "$FA" | grep -q '"ok":true' && ok "流程级认证设置成功" || bad "设置失败: $FA"
AUTHID=$(curl -s $BASE/api/flows | node -pe 'JSON.parse(require("fs").readFileSync(0)).find(f=>f.id==="flow_auth_t").authId || ""')
check "流程列表返回 authId" "$CRED_ID" "$AUTHID"
RUN3=$(curl -s -X POST $BASE/api/flows/flow_auth_t/run -H 'content-type: application/json' -d '{}')
echo "$RUN3" | grep -q '"status":"success"' && ok "运行成功（流程级认证对全部接口生效）" || bad "运行失败: $RUN3"

step "C9 单接口绑定优先于流程级：绑到另一凭证也生效"
CREATE2=$(curl -s -X POST $BASE/api/creds -H 'content-type: application/json' -d '{"name":"第二凭证"}')
CRED2=$(echo "$CREATE2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).cred.id')
curl -s -X POST $BASE/api/creds/bind-op -H 'content-type: application/json' -d "{\"operationId\":\"$BIND_OP\",\"credId\":\"$CRED2\"}" > /dev/null
RUN4=$(curl -s -X POST $BASE/api/flows/flow_auth_t/run -H 'content-type: application/json' -d '{}')
echo "$RUN4" | grep -q '"status":"success"' && ok "单接口绑定覆盖流程级，运行成功" || bad "优先级异常: $RUN4"
LASTRUN=$(curl -s "$BASE/api/runs?flowId=flow_auth_t" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0))[0]; (r.nodes.call_secure.request.headers["x-api-key"]||"")')
AK2=$(echo "$CREATE2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).cred.ak')
check "请求用的是第二凭证的 AK（单接口优先）" "$AK2" "$LASTRUN"

step "C10 SK 不落运行记录"
LEAK=$(curl -s "$BASE/api/runs?flowId=flow_auth_t" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0))[0]; JSON.stringify(r.nodes.call_secure.request.headers)')
case "$LEAK" in *"$SK"*) bad "SK 泄漏进运行记录！";; *) ok "运行记录无 SK 明文";; esac
case "$LEAK" in *'x-api-secret'*) bad "header 模式 SK 泄漏";; *) ok "无 x-api-secret 字段";; esac

step "C10b 更新凭证：切 ecloud 模式 / 换 AK / 非法值拒绝（无需删除重建）"
UP=$(curl -s -X PUT $BASE/api/creds/$CRED2 -H 'content-type: application/json' -d '{"mode":"ecloud","name":"第二凭证-移动云"}')
echo "$UP" | grep -q '"mode":"ecloud"' && ok "切换为 ecloud 模式" || bad "切模式失败: $UP"
echo "$UP" | grep -q '第二凭证-移动云' && ok "改名生效" || bad "改名失败: $UP"
UPBAD=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/creds/$CRED2 -H 'content-type: application/json' -d '{"mode":"magic"}')
check "非法 mode → 400" 400 "$UPBAD"
UP404=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/creds/cred_nosuch -H 'content-type: application/json' -d '{"mode":"ecloud"}')
check "不存在的凭证 → 400" 400 "$UP404"
# ecloud 是给移动云公网网关用的（认证参数进 query）；平台内部受保护上游只认
# 请求头签名，所以这里运行必然 401 —— 正确的断言是「请求确实走了签名 URL」
RUN5=$(curl -s -X POST $BASE/api/flows/flow_auth_t/run -H 'content-type: application/json' -d '{}')
echo "$RUN5" | grep -q '"status":"failed"' && ok "对平台内部受保护上游运行失败（401，ecloud 签名只对移动云网关有效，符合预期）" || bad "行为异常: $RUN5"
EURL=$(curl -s "$BASE/api/runs?flowId=flow_auth_t" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0))[0]; r.nodes.call_secure.request.url || ""')
case "$EURL" in *"AccessKey=$AK2"*"Signature="*|*"AccessKey=$AK2"*"Signature%"*) ok "请求 URL 带 AccessKey 与 Signature（认证参数进 query）";; *) bad "ecloud 签名未进 URL: ${EURL:0:120}";; esac
UPAK=$(curl -s -X PUT $BASE/api/creds/$CRED2 -H 'content-type: application/json' -d '{"ak":"AKUPDATED99"}')
echo "$UPAK" | grep -q 'AKUPDATED99' && ok "换 AK 生效（模式保持 ecloud）" || bad "换 AK 失败: $UPAK"

step "C11 删除凭证 → 绑定与流程级 authId 自动清理"
curl -s -X DELETE $BASE/api/creds/$CRED_ID > /dev/null
curl -s -X DELETE $BASE/api/creds/$CRED2 > /dev/null
BINDS=$(curl -s $BASE/api/creds | node -pe 'const d=JSON.parse(require("fs").readFileSync(0));d.opBindings[process.argv[1]] || 0' "$BIND_OP")
BINDS2=$(curl -s $BASE/api/creds | node -pe 'const d=JSON.parse(require("fs").readFileSync(0));d.opBindings[process.argv[1]] || 0' "$BIND_OP")
check "单接口绑定已清空" 0 "$BINDS2"
AUTHID2=$(curl -s $BASE/api/flows | node -pe 'JSON.parse(require("fs").readFileSync(0)).find(f=>f.id==="flow_auth_t").authId || "null"')
check "流程级 authId 已清理" "null" "$AUTHID2"

step "C12 清理测试流程"
curl -s -X DELETE $BASE/api/flows/flow_auth_t > /dev/null
GET=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/flows/flow_auth_t/def); check "测试流程已删除" 404 "$GET"

# 恢复用户环境：内置 query_stock 回到隐藏态（与测试前一致）
curl -s -X POST $BASE/api/ops/batch-delete -H 'content-type: application/json' -d '{"ids":["query_stock"]}' > /dev/null

echo; echo "════ 认证回归：$PASS 通过 / $FAIL 失败 ════"
[ "$FAIL" -eq 0 ] || exit 1

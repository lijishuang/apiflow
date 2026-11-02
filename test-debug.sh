#!/usr/bin/env bash
# ── 搭建器调试能力回归：自动修复 / 自动断言 / 调试运行（dry-run 输入覆盖 + runId）/ 断言引擎 ──
set -u
B=http://127.0.0.1:3300
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ✓ $1"; }
bad(){ fail=$((fail+1)); echo "  ✗ $1"; }
check(){ local d="$1" w="$2" g="$3"; if [ "$w" = "$g" ]; then ok "$d"; else bad "${d}（期望 ${w}，实际 ${g}）"; fi }
J() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

echo "══ 搭建器调试 · 自动修复 ══"

# T1 坏草稿：悬空边 + 条件缺分支 + 不可达节点 → autofix 全修好且 Schema 通过
python3 - <<'EOF' > /tmp/dbg-t1.json
import json
d = {"id":"flow_dbgtest","name":"调试测试","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch","type":"http","name":"查询供应商","operationId":"query_supplier","config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"},"retry":{"maxAttempts":3,"backoffMs":300}},
  {"id":"check","type":"condition","name":"条件","config":{"expr":"status == 'ACTIVE'"}},
  {"id":"orphan","type":"transform","name":"孤儿","config":{"expr":{"skipped":True}}}],
 "edges":[
  {"from":"start","to":"fetch"},
  {"from":"fetch","to":"check"},
  {"from":"check","to":"ghost_node","label":"then"}]}
print(json.dumps({"mode":"fix","def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_dbgtest/autofix -H 'content-type: application/json' -d @/tmp/dbg-t1.json)
NF=$(echo "$R" | J "len(d['fixes'])")
[ "$NF" -ge 3 ] && ok "自动修复了 ${NF} 处结构问题（悬空边/缺分支/不可达等）" || bad "修复数不足（${NF}）"
echo "$R" | J "d['schema']['ok']" | grep -q True && ok "修复后 Schema 校验通过" || bad "修复后 Schema 仍不通过：$(echo "$R" | J "d['schema']['errors']")"
echo "$R" | J "any('悬空边' in x for x in d['fixes'])" | grep -q True && ok "悬空边被删除" || bad "悬空边未处理"
echo "$R" | J "any('then 分支' in x for x in d['fixes'])" | grep -q True && ok "条件缺 then 分支被补桩" || bad "then 分支未处理"

# T2 写操作缺幂等键 → 自动补
python3 - <<'EOF' > /tmp/dbg-t2.json
import json
d = {"id":"flow_dbgtest2","name":"幂等键测试","version":0,
 "input":{"schema":{"type":"object"},"sample":{}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"sync1","type":"http","name":"同步库存","operationId":"sync_stock","config":{"method":"POST","url":"http://127.0.0.1:3300/upstream/stock/sync","body":{"sku":"SKU-01"}},"retry":{"maxAttempts":3,"backoffMs":300}}],
 "edges":[{"from":"start","to":"sync1"}]}
print(json.dumps({"mode":"fix","def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_dbgtest2/autofix -H 'content-type: application/json' -d @/tmp/dbg-t2.json)
echo "$R" | J "d['def']['nodes'][1].get('idempotencyKey')" | grep -q "run.num" && ok "写操作重试>1 未配幂等键 → 自动补" || bad "幂等键未自动补"

# T3 缺 method/url 的注册表节点 → 按注册表补全
python3 - <<'EOF' > /tmp/dbg-t3.json
import json
d = {"id":"flow_dbgtest3","name":"注册表补全","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","config":{}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"mode":"fix","def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_dbgtest3/autofix -H 'content-type: application/json' -d @/tmp/dbg-t3.json)
check "缺 method 按注册表补为 GET" "GET" "$(echo "$R" | J "d['def']['nodes'][1]['config']['method']")"
echo "$R" | J "'/upstream/suppliers/' in d['def']['nodes'][1]['config']['url']" | grep -q True && ok "缺 url 按注册表补全" || bad "url 未补全"

echo "══ 自动断言 ══"

# T4 mode=assert → HTTP 节点加断言，query_supplier 带 outputHas
python3 - <<'EOF' > /tmp/dbg-t4.json
import json
d = {"id":"flow_dbgtest4","name":"断言测试","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"},"retry":{"maxAttempts":3,"backoffMs":300}},
  {"id":"sync1","type":"http","name":"同步库存","operationId":"sync_stock","config":{"method":"POST","url":"http://127.0.0.1:3300/upstream/stock/sync","body":{"sku":"SKU-01"}}}],
 "edges":[{"from":"start","to":"fetch1"},{"from":"fetch1","to":"sync1"}]}
print(json.dumps({"mode":"assert","def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_dbgtest4/autofix -H 'content-type: application/json' -d @/tmp/dbg-t4.json)
check "加断言的节点数" "2" "$(echo "$R" | J "len(d['asserts'])")"
echo "$R" | J "'status' in d['def']['nodes'][1]['assert']['outputHas'] and 'score' in d['def']['nodes'][1]['assert']['outputHas']" | grep -q True && ok "query_supplier 断言含注册表期望字段 status/score" || bad "outputHas 未按注册表生成"
echo "$R" | J "d['def']['nodes'][2]['assert']['ok']" | grep -q True && ok "无 expect 的接口节点默认校验 2xx" || bad "默认 2xx 断言缺失"

# T5 已有断言的节点不覆盖
python3 - <<'EOF' > /tmp/dbg-t5.json
import json
d = {"id":"flow_dbgtest5","name":"断言不覆盖","version":0,
 "input":{"schema":{"type":"object"},"sample":{}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查","operationId":"query_supplier","assert":{"expr":"score > 0"},"config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"mode":"assert","def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_dbgtest5/autofix -H 'content-type: application/json' -d @/tmp/dbg-t5.json)
check "已有断言节点不被覆盖" "0" "$(echo "$R" | J "len(d['asserts'])")"
check "原断言表达式保留" "score > 0" "$(echo "$R" | J "d['def']['nodes'][1]['assert']['expr']")"

echo "══ 调试运行（dry-run 输入覆盖 + runId）══"

# T6 保存草稿 → 调试运行（自定义输入 + 客户端 runId）
python3 - <<'EOF' > /tmp/dbg-t6-def.json
import json
d = {"id":"flow_dbgrun","name":"调试运行","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/{supplierId}"},"retry":{"maxAttempts":2,"backoffMs":100}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
curl -s -X POST $B/api/flows/flow_dbgrun/draft -H 'content-type: application/json' -d @/tmp/dbg-t6-def.json > /dev/null
R=$(curl -s -X POST $B/api/flows/flow_dbgrun/dry-run -H 'content-type: application/json' -d '{"input":{"supplierId":"S-1002"},"runId":"run_dbg_case1"}')
check "客户端预指定 runId 生效" "run_dbg_case1" "$(echo "$R" | J "d['runId']")"
check "输入覆盖生效（S-1002 状态）" "SUSPENDED" "$(echo "$R" | J "d['nodes']['fetch1']['output']['status']")"
check "调试运行状态" "success" "$(echo "$R" | J "d['status']")"

# T7 路径参数未填时调试会失败（可观测）
python3 - <<'EOF' > /tmp/dbg-t7-def.json
import json
d = {"id":"flow_dbgrun2","name":"参数缺失调试","version":0,
 "input":{"schema":{"type":"object"},"sample":{}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/{supplierId}"}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
curl -s -X POST $B/api/flows/flow_dbgrun2/draft -H 'content-type: application/json' -d @/tmp/dbg-t7-def.json > /dev/null
R=$(curl -s -X POST $B/api/flows/flow_dbgrun2/dry-run -H 'content-type: application/json' -d '{}')
check "参数未填 → 调试运行失败可见" "failed" "$(echo "$R" | J "d['status']")"
echo "$R" | J "'404' in (d['nodes']['fetch1'].get('error') or '')" | grep -q True && ok "失败节点带明确错误（404）" || bad "失败原因不明确"

echo "══ 断言引擎（真实运行期）══"

# T8 断言通过：outputHas 匹配真实输出 → 发布后运行成功
python3 - <<'EOF' > /tmp/dbg-t8-def.json
import json
d = {"id":"flow_asrtok","name":"断言通过","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","assert":{"ok":True,"outputHas":["status","score"]},"config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
curl -s -X POST $B/api/flows/flow_asrtok/draft -H 'content-type: application/json' -d @/tmp/dbg-t8-def.json > /dev/null
curl -s -X POST $B/api/flows/flow_asrtok/dry-run -H 'content-type: application/json' -d '{}' > /dev/null
R=$(curl -s -X POST $B/api/flows/flow_asrtok/publish -H 'content-type: application/json' -d '{"confirm":true}')
echo "$R" | J "d.get('ok')" | grep -q True && ok "带断言流程可发布" || bad "发布失败：$R"
RUN=$(curl -s -X POST $B/api/flows/flow_asrtok/run -H 'content-type: application/json' -d '{}')
RID=$(echo "$RUN" | J "d['runId']")
R=$(curl -s $B/api/runs/$RID)
check "断言通过 → 运行成功" "success" "$(echo "$R" | J "d['status']")"

# T9 断言失败：outputHas 含不存在字段 → 调试（第二道闸）即拦截，不能发布
python3 - <<'EOF' > /tmp/dbg-t9-def.json
import json
d = {"id":"flow_asrtbad","name":"断言失败","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","assert":{"ok":True,"outputHas":["no_such_field"]},"config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
curl -s -X POST $B/api/flows/flow_asrtbad/draft -H 'content-type: application/json' -d @/tmp/dbg-t9-def.json > /dev/null
R=$(curl -s -X POST $B/api/flows/flow_asrtbad/dry-run -H 'content-type: application/json' -d '{}')
check "断言失败 → 调试运行失败" "failed" "$(echo "$R" | J "d['status']")"
echo "$R" | J "'断言失败' in (d['nodes']['fetch1'].get('error') or '')" | grep -q True && ok "错误信息含「断言失败」与缺失字段说明" || bad "断言错误信息缺失"
R=$(curl -s -X POST $B/api/flows/flow_asrtbad/publish -H 'content-type: application/json' -d '{"confirm":true}')
echo "$R" | J "'Dry-run' in d.get('error','')" | grep -q True && ok "第二道闸拦截：断言不过不能发布（422）" || bad "发布未被拦截：$R"

# T10 表达式断言：score >= 60（S-8891=87 通过 / S-1002=41 失败）
python3 - <<'EOF' > /tmp/dbg-t10-def.json
import json
d = {"id":"flow_asrtexpr","name":"表达式断言","version":0,
 "input":{"schema":{"type":"object"},"sample":{"supplierId":"S-8891"}},
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查询供应商","operationId":"query_supplier","assert":{"expr":"score >= 60"},"config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/{supplierId}"},"retry":{"maxAttempts":1,"backoffMs":100}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
curl -s -X POST $B/api/flows/flow_asrtexpr/draft -H 'content-type: application/json' -d @/tmp/dbg-t10-def.json > /dev/null
curl -s -X POST $B/api/flows/flow_asrtexpr/dry-run -H 'content-type: application/json' -d '{}' > /dev/null
curl -s -X POST $B/api/flows/flow_asrtexpr/publish -H 'content-type: application/json' -d '{"confirm":true}' > /dev/null
RUN=$(curl -s -X POST $B/api/flows/flow_asrtexpr/run -H 'content-type: application/json' -d '{"supplierId":"S-8891"}')
RID=$(echo "$RUN" | J "d['runId']")
check "表达式断言 score>=60（87）→ 通过" "success" "$(curl -s $B/api/runs/$RID | J "d['status']")"
RUN=$(curl -s -X POST $B/api/flows/flow_asrtexpr/run -H 'content-type: application/json' -d '{"supplierId":"S-1002"}')
RID=$(echo "$RUN" | J "d['runId']")
check "表达式断言 score>=60（41）→ 失败" "failed" "$(curl -s $B/api/runs/$RID | J "d['status']")"
curl -s $B/api/runs/$RID | J "any(e['event']=='assert_fail' for e in d['events'])" | grep -q True && ok "事件流含 assert_fail 事件（前端可实时展示）" || bad "assert_fail 事件未发出"

# T11 assert 形状校验
python3 - <<'EOF' > /tmp/dbg-t11.json
import json
d = {"id":"flow_asrtshape","name":"断言形状","version":0,
 "nodes":[
  {"id":"start","type":"start","name":"开始","config":{}},
  {"id":"fetch1","type":"http","name":"查","operationId":"query_supplier","assert":{"status":"200"},"config":{"method":"GET","url":"http://127.0.0.1:3300/upstream/suppliers/S-8891"}}],
 "edges":[{"from":"start","to":"fetch1"}]}
print(json.dumps({"def":d}))
EOF
R=$(curl -s -X POST $B/api/flows/flow_asrtshape/validate -H 'content-type: application/json' -d @/tmp/dbg-t11.json)
echo "$R" | J "any('assert.status 必须是数组' in e for e in d['errors'])" | grep -q True && ok "assert.status 非数组被校验拦截" || bad "assert 形状校验未生效"

# 清理测试流程
for id in flow_dbgtest flow_dbgtest2 flow_dbgtest3 flow_dbgtest4 flow_dbgtest5 flow_dbgrun flow_dbgrun2 flow_asrtok flow_asrtbad flow_asrtexpr flow_asrtshape; do
  curl -s -X DELETE $B/api/flows/$id > /dev/null
done

echo ""
echo "════════════════════════════════"
echo "通过 $pass / $((pass+fail))"
[ "$fail" -eq 0 ] && echo "全部通过 ✓" || { echo "存在失败 ✗"; exit 1; }

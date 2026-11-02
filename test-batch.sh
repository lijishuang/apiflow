#!/usr/bin/env bash
# ── 多流程并行执行回归：并发池 / 并发上限 / 串行退化 / 取消 / 参数校验 / 运行记录 ──
set -u
B=http://127.0.0.1:3300
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ✓ $1"; }
bad(){ fail=$((fail+1)); echo "  ✗ $1"; }
check(){ local d="$1" w="$2" g="$3"; if [ "$w" = "$g" ]; then ok "$d"; else bad "${d}（期望 ${w}，实际 ${g}）"; fi }
gt(){ awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }
lt(){ awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<b)}'; }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
post(){ curl -s -o /tmp/batch-resp.json -w '%{http_code}' -X POST "$B$1" -H 'content-type: application/json' -d "$2"; }

# 轮询批次直到非 running（最多约 12s），把最终快照输出到 stdout
wait_done(){
  local id="$1" i=0 s
  while [ "$i" -lt 100 ]; do
    sleep 0.12
    s=$(curl -s "$B/api/batches/$id")
    if echo "$s" | J "d['status']" | grep -q '^running$'; then i=$((i+1)); continue; fi
    echo "$s"; return 0
  done
  curl -s "$B/api/batches/$id"
}

# 4 个已发布流程：按节点数取最“重”的 4 个（节点多 → 耗时长，并行收益才可测）。
# 不硬编码流程 id —— e2e 反复跑会新建/重置流程，硬编码必然漂移
eval "$(curl -s "$B/api/flows" | python3 -c "
import sys,json
d=json.load(sys.stdin)
pub=sorted([x for x in d if x['version']>=1], key=lambda x:-(x.get('nodeCount') or 0))
ids=[x['id'] for x in pub[:4]]
if len(ids)<4:
    print('NEED_MORE=1'); raise SystemExit
if 'flow_supplier' in ids:                      # 取消测试要求第一个流程耗时 > 0.15s
    ids.remove('flow_supplier'); ids.insert(0,'flow_supplier')
print('F1=%s; F2=%s; F3=%s; F4=%s' % tuple(ids))
")"
[ -z "${NEED_MORE:-}" ] || { echo "前置条件缺失：已发布流程不足 4 个，无法测试并行执行"; exit 1; }
echo "  （选中并行测试流程：${F1} ${F2} ${F3} ${F4}）"

echo "══ 并行执行 · 受理与真并发 ══"
# T1 幂等去重 + 202 异步受理
CODE=$(post /api/flows/batch-run "{\"ids\":[\"$F1\",\"$F2\",\"$F1\"],\"concurrency\":2}")
check "批跑接口异步受理（HTTP 202）" 202 "$CODE"
BID=$(J "d['id']" < /tmp/batch-resp.json)
check "重复流程 id 自动去重" 2 "$(J "d['total']" < /tmp/batch-resp.json)"
check "批次初始状态为 running" running "$(J "d['status']" < /tmp/batch-resp.json)"

R=$(wait_done "$BID")
check "批次跑完落为 done" done "$(echo "$R" | J "d['status']")"
check "两个流程都执行完成" 2 "$(echo "$R" | J "d['done']")"
check "并发池峰值达到 2" 2 "$(echo "$R" | J "d['peakConcurrency']")"
GAP=$(echo "$R" | J "abs(d['items'][0]['startedAt']-d['items'][1]['startedAt'])")
lt "$GAP" 150 && ok "两个流程同时起跑（启动间隔 ${GAP}ms）" || bad "启动间隔过大：${GAP}ms，未真正并行"
SP=$(echo "$R" | J "d['speedup'] or 0")
gt "$SP" 1.2 && ok "并行加速比 ${SP}×（>1.2）" || bad "加速比过低：${SP}×"
WALL=$(echo "$R" | J "d['durationMs']")
SUM=$(echo "$R" | J "sum(i['durationMs'] or 0 for i in d['items'])")
lt "$WALL" "$SUM" && ok "墙钟 ${WALL}ms < 串行耗时之和 ${SUM}ms" || bad "墙钟未短于串行（${WALL} vs ${SUM}）"

echo ""
echo "══ 并行执行 · 并发度控制 ══"
# T2 并发度 2 + 4 个流程 → 峰值不超过 2
CODE=$(post /api/flows/batch-run "{\"ids\":[\"$F1\",\"$F2\",\"$F3\",\"$F4\"],\"concurrency\":2}")
BID=$(J "d['id']" < /tmp/batch-resp.json)
check "4 个流程受理" 4 "$(J "d['total']" < /tmp/batch-resp.json)"
R=$(wait_done "$BID")
PEAK=$(echo "$R" | J "d['peakConcurrency']")
check "峰值并发不超设定值 2" 2 "$PEAK"
check "4 个流程全部结束" 4 "$(echo "$R" | J "d['done']")"

# T3 并发度 1 → 退化串行，启动时间严格递增且无重叠
CODE=$(post /api/flows/batch-run "{\"ids\":[\"$F1\",\"$F2\",\"$F3\",\"$F4\"],\"concurrency\":1}")
BID=$(J "d['id']" < /tmp/batch-resp.json)
R=$(wait_done "$BID")
check "串行模式下峰值为 1" 1 "$(echo "$R" | J "d['peakConcurrency']")"
echo "$R" | J "all(d['items'][i]['startedAt']>=d['items'][i-1]['endedAt'] for i in range(1,len(d['items'])))" | grep -q True \
  && ok "串行模式下没有时间重叠（按顺序排队）" || bad "串行模式出现重叠执行"

echo ""
echo "══ 并行执行 · 异常与取消 ══"
# T4 未发布流程：整批不失败，该项标记失败原因
UNPUB=$(curl -s "$B/api/flows" | J "next((x['id'] for x in d if x['version']==0),'')")
if [ -n "$UNPUB" ]; then
  CODE=$(post /api/flows/batch-run "{\"ids\":[\"$F1\",\"$UNPUB\"],\"concurrency\":2}")
  BID=$(J "d['id']" < /tmp/batch-resp.json)
  R=$(wait_done "$BID")
  check "混入未发布流程时批次仍正常收尾" done "$(echo "$R" | J "d['status']")"
  echo "$R" | J "next(i['status'] for i in d['items'] if i['flowId']=='$UNPUB')" | grep -q failed \
    && ok "未发布流程标记为 failed" || bad "未发布流程状态不正确"
  echo "$R" | J "next((i['error'] or '') for i in d['items'] if i['flowId']=='$UNPUB')" | grep -q '未发布' \
    && ok "失败原因写明「未发布」" || bad "失败原因缺失"
else
  ok "（跳过：当前没有未发布流程）"; ok "（跳过：失败原因断言）"
fi

# T5 不存在的流程
CODE=$(post /api/flows/batch-run '{"ids":["flow_not_exist_zz"],"concurrency":1}')
BID=$(J "d['id']" < /tmp/batch-resp.json)
R=$(wait_done "$BID")
echo "$R" | J "d['items'][0]['status']" | grep -q failed && ok "不存在的流程标记为 failed" || bad "不存在流程状态异常"
echo "$R" | J "d['items'][0]['error']" | grep -q '不存在' && ok "不存在流程给出明确原因" || bad "原因缺失"

# T6 取消：串行启动 4 个，仅第一个在跑，其余未开始 → 应被取消
CODE=$(post /api/flows/batch-run "{\"ids\":[\"$F1\",\"$F2\",\"$F3\",\"$F4\"],\"concurrency\":1}")
BID=$(J "d['id']" < /tmp/batch-resp.json)
sleep 0.15
CANCEL=$(curl -s -X POST "$B/api/batches/$BID/cancel")
CS=$(echo "$CANCEL" | J "d['status']")
case "$CS" in
  cancelling|cancelled) ok "取消立即生效（即时状态 ${CS}，在跑的流程收尾后终止）" ;;
  *) bad "取消未生效（状态 ${CS}）" ;;
esac
R=$(wait_done "$BID")
check "取消收尾后批次状态为 cancelled" cancelled "$(echo "$R" | J "d['status']")"
CN=$(echo "$R" | J "d['cancelled']")
gt "$CN" 0 && ok "排队中的 ${CN} 个流程被取消（未开始的不再执行）" || bad "取消未生效"
echo "$R" | J "d['items'][0]['status']" | grep -q success && ok "已在跑的流程不被中途打断，正常跑完" || bad "运行中的流程被打断"

# T7 参数校验
check "空 ids 被拒绝" 400 "$(post /api/flows/batch-run '{"ids":[]}')"
check "并发度 0 被拒绝" 400 "$(post /api/flows/batch-run "{\"ids\":[\"$F1\"],\"concurrency\":0}")"
BIG=$(python3 -c "import json;print(json.dumps({'ids':['f%d'%i for i in range(60)],'concurrency':2}))")
check "单批超过 50 个流程被拒绝" 400 "$(post /api/flows/batch-run "$BIG")"

echo ""
echo "══ 并行执行 · 记录与兼容 ══"
# T8 批次列表 / 单个批次 / 不存在
LAST=$(curl -s "$B/api/batches" | J "d['items'][0]['id']")
check "批次列表最新在前" "$BID" "$LAST"
check "不存在的批次返回 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/batches/batch_nope")"

# T9 运行记录：trigger=batch，事件流完整
RUNS=$(curl -s "$B/api/runs?flowId=$F1")
check "并行运行已写入运行历史" batch "$(echo "$RUNS" | J "d[0]['trigger']")"
echo "$RUNS" | J "any(e['event']=='run_end' for e in d[0]['events'])" | grep -q True \
  && ok "并行运行的 run_end 事件完整（可回放/可对比）" || bad "并行运行事件缺失"
echo "$RUNS" | J "d[0]['status']" | grep -q success && ok "并行运行结果正常" || bad "并行运行结果异常"

# T10 单流程运行接口不受影响
CODE=$(curl -s -o /tmp/batch-single.json -w '%{http_code}' -X POST "$B/api/flows/$F1/run" -H 'content-type: application/json' -d '{}')
check "单流程运行接口仍返回 200" 200 "$CODE"
check "单流程运行仍标记 manual 触发" manual "$(curl -s "$B/api/flows" | J "next(x['lastRun']['trigger'] for x in d if x['id']=='$F1')")"

echo ""
echo "════════════════════════════════"
echo "通过 $pass / $((pass+fail))"
[ "$fail" -eq 0 ] && echo "全部通过 ✓" || { echo "存在失败 ✗"; exit 1; }

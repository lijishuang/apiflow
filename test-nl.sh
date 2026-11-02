#!/bin/bash
# 自然语言回归：口语描述 → 接口匹配，以及「调整现有草稿」不覆盖
# 自己造种子接口（门禁白名单），跑完清理，不依赖平台里已有的用户数据
P=python3
B=http://127.0.0.1:3300
C="curl -s --noproxy '*'"
pass=0; fail=0
chk() { if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }
eq() { [ "$2" = "$3" ]; chk "$1（期望 $3，实得 $2）" $?; }
pick() {
  $P -c "
import sys,json
d=json.load(sys.stdin)
for k in '$1'.split('.'):
    if isinstance(d,list):
        d=d[int(k)]
    elif isinstance(d,dict) and k in d:
        d=d[k]
    else:
        d=None; break
print('' if d is None else d)"
}
nodes() { $P -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for n in d['draft']['nodes'] if n['type']=='http'))"; }

echo "══ N0 准备：临时注册三个种子接口 ══"
cat > /tmp/nl-seed.json <<'JSON'
{"mode":"sdk","filename":"nl-seed.ts","name":"NL回归种子",
 "text":"/** 查询门禁白名单 */\nexport async function nl_list_guard(q: string) { return request(\"GET\", \"/nl/guard\"); }\n/** 删除门禁白名单 */\nexport async function nl_delete_guard(body: { id: string }) { return request(\"DELETE\", \"/nl/guard\"); }\n/** 新增门禁白名单 */\nexport async function nl_add_guard(body: { name: string }) { return request(\"POST\", \"/nl/guard\"); }"}
JSON
SRC=$($C -X POST $B/api/sources -H 'content-type: application/json' -d @/tmp/nl-seed.json | pick 'source.id')
[ -n "$SRC" ] && chk "种子来源已建立（$SRC）" 0 || chk "种子来源建立失败" 1
FID=''; FIDS=''
cleanup() {
  for f in $FID $FIDS; do $C -X DELETE $B/api/flows/$f > /dev/null 2>&1; done
  [ -n "$SRC" ] && $C -X DELETE $B/api/sources/$SRC > /dev/null 2>&1
}
trap cleanup EXIT

echo "══ N1 口语化描述：不照接口名说也能命中 ══"
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' -d '{"text":"查一下门禁白名单"}')
eq "「查一下门禁白名单」命中「查询门禁白名单」" "$(echo "$R" | pick 'draft.nodes.1.name')" "查询门禁白名单"
FID=$(echo "$R" | pick 'flow.id')

echo "══ N2 多动作：按提及顺序串行，动词不串味 ══"
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d '{"text":"先查门禁白名单，再删门禁白名单"}')
eq "「先查…再删…」两个动作分得清" \
   "$(echo "$R" | pick 'draft.nodes.1.name')→$(echo "$R" | pick 'draft.nodes.2.name')" \
   "查询门禁白名单→删除门禁白名单"
FIDS="$FIDS $(echo "$R" | pick 'flow.id')"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d '{"text":"删除门禁白名单，再新增门禁白名单"}')
eq "删除 / 新增 各归各位" "$(echo "$R" | nodes)" "2"
FIDS="$FIDS $(echo "$R" | pick 'flow.id')"

echo "══ N3 认不出：给建议，不再糊全部接口名 ══"
CODE=$($C -o /tmp/nl-bad.json -w '%{http_code}' -X POST $B/api/agent/draft -H 'content-type: application/json' -d '{"text":"今天天气不错"}')
eq "完全无关的描述 → 422" "$CODE" "422"
LEN=$($P -c "import json;print(len(json.load(open('/tmp/nl-bad.json')).get('error','')))")
[ "$LEN" -lt 200 ]; chk "错误信息不再罗列全部接口（${LEN} 字符）" $?
SUG=$($P -c "import json;print(len(json.load(open('/tmp/nl-bad.json')).get('suggestions') or []))")
[ "$SUG" -ge 1 ]; chk "带上了建议接口（$SUG 条）" $?

echo "══ N4 调整：在现有草稿上打补丁，不覆盖 ══"
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d '{"text":"门禁巡检：先查询门禁白名单，然后新增门禁白名单"}')
FID=$(echo "$R" | pick 'flow.id')
eq "初始草稿 2 步" "$(echo "$R" | nodes)" "2"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"把查询门禁白名单放到最前面\",\"flowId\":\"$FID\"}")
eq "「放到最前面」走调整（revised）" "$(echo "$R" | pick 'revised')" "True"
eq "  节点数没被覆盖" "$(echo "$R" | nodes)" "2"
eq "  顺序已变" "$(echo "$R" | pick 'draft.nodes.1.name')" "查询门禁白名单"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"再加一个删除门禁白名单\",\"flowId\":\"$FID\"}")
eq "「再加一个…」追加一步" "$(echo "$R" | nodes)" "3"
eq "  追加的是删除门禁白名单" "$(echo "$R" | pick 'draft.nodes.3.name')" "删除门禁白名单"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"超时改成 5 秒\",\"flowId\":\"$FID\"}")
eq "「超时改成 5 秒」落到节点配置" "$(echo "$R" | pick 'draft.nodes.1.timeout')" "5000"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"把新增门禁白名单和查询门禁白名单换个位置\",\"flowId\":\"$FID\"}")
eq "「换个位置」交换两步" "$(echo "$R" | pick 'draft.nodes.1.name')" "新增门禁白名单"

R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"删掉最后一步\",\"flowId\":\"$FID\"}")
eq "「删掉最后一步」减少一步" "$(echo "$R" | nodes)" "2"

echo "══ N5 调整说不清：说清楚，而不是拿它重建 ══"
CODE=$($C -o /tmp/nl-amb.json -w '%{http_code}' -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"调整一下顺序\",\"flowId\":\"$FID\"}")
eq "含义不明的调整 → 422" "$CODE" "422"
MSG=$($P -c "import json;print(json.load(open('/tmp/nl-amb.json')).get('error',''))")
case "$MSG" in *"没听出要调哪两步"*) chk "提示说清了怎么表达" 0;; *) chk "提示不够具体：$MSG" 1;; esac
KEEP=$($C $B/api/flows/$FID/def | $P -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for n in d['def']['nodes'] if n['type']=='http'))")
eq "  原草稿没被覆盖" "$KEEP" "2"

echo "══ N6 明确要求新流程：仍然重建 ══"
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d "{\"text\":\"重新做一条：先查询门禁白名单\",\"flowId\":\"$FID\"}")
eq "「重新做一条」按新建处理" "$(echo "$R" | nodes)" "1"
FIDS="$FIDS $(echo "$R" | pick 'flow.id')"

echo
echo "════ 自然语言回归：通过 $pass / 失败 $fail ════"
[ "$fail" -eq 0 ] && echo "全部通过 ✓" || echo "有失败项 ✗"
exit $fail

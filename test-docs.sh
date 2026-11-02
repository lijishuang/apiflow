#!/bin/bash
# 帮助手册回归：URL 抓取（本地 fixture） / 粘贴正文 / 文件上传 / 检索 / 搭建器引用与兜底
# 种子接口与手册都用独占前缀，跑完清理，不依赖平台里已有的用户数据
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

BEFORE_DOCS=$($C $B/api/docs | pick 'stats.docs')
BEFORE_SRC=''

echo "══ D0 准备：种子接口 + 本地手册站点 ══"
cat > /tmp/doc-seed.json <<'JSON'
{"mode":"sdk","filename":"doc-seed.ts","name":"DOC回归种子",
 "text":"/** 查询网关准入名单 */\nexport async function doc_list_gateway(q: string) { return request(\"GET\", \"/doc/gateway\"); }\n/** 删除网关准入名单 */\nexport async function doc_delete_gateway(body: { id: string }) { return request(\"DELETE\", \"/doc/gateway\"); }"}
JSON
SRC=$($C -X POST $B/api/sources -H 'content-type: application/json' -d @/tmp/doc-seed.json | pick 'source.id')
[ -n "$SRC" ] && chk "种子接口已建立（${SRC}）" 0 || chk "种子接口建立失败" 1

mkdir -p /tmp/apiflow-doc-fixture
cat > /tmp/apiflow-doc-fixture/index.html <<'EOF'
<html><head><title>网关准入手册（回归）</title></head><body>
<h1>网关准入手册</h1>
<p>本手册描述终端准入与下线的完整流程，适用于全部网关型产品线，接入前请先阅读名词解释与调用约束。</p>
<ul><li><a href="gate.html">准入检查</a></li></ul>
</body></html>
EOF
cat > /tmp/apiflow-doc-fixture/gate.html <<'EOF'
<html><head><title>准入检查 - 网关准入手册</title></head><body>
<h1>准入检查</h1>
<h2>终端准入流程</h2>
<p>终端接入前先做准入检查：调用「查询网关准入名单」确认设备是否在册。</p>
<h2>终端报废下线</h2>
<p>终端报废时，调用「删除网关准入名单」把设备从名单里移除。</p>
</body></html>
EOF
(python3 -m http.server 8931 --directory /tmp/apiflow-doc-fixture >/dev/null 2>&1 &) 
sleep 1
$C -o /dev/null -w '' http://127.0.0.1:8931/index.html
CODE=$($C -o /dev/null -w '%{http_code}' http://127.0.0.1:8931/index.html)
eq "本地手册站点可用" "$CODE" "200"

cleanup() {
  for f in $FIDS; do $C -X DELETE $B/api/flows/$f > /dev/null 2>&1; done
  [ -n "$SRC" ] && $C -X DELETE $B/api/sources/$SRC > /dev/null 2>&1
  for d in $DIDS; do $C -X DELETE $B/api/docs/$d > /dev/null 2>&1; done
  pkill -f "http.server 8931" >/dev/null 2>&1
}
DIDS=''
FIDS=''
trap cleanup EXIT

echo "══ D1 URL 抓取：多页合并 + 章节化 ══"
R=$($C -X POST $B/api/docs -H 'content-type: application/json' \
  -d '{"mode":"url","url":"http://127.0.0.1:8931/index.html","name":"网关准入手册（回归）"}')
DID=$(echo "$R" | pick 'doc.id'); DIDS="$DIDS $DID"
[ -n "$DID" ]; chk "抓取成功（${DID}）" $?
CH=$(echo "$R" | pick 'doc.chunks'); [ "${CH:-0}" -ge 2 ]; chk "  抓取后切成多块（${CH}）" $?
NOTE=$(echo "$R" | pick 'doc.note')
case "$NOTE" in *"2 页"*) chk "  备注说明了页数（${NOTE}）" 0;; *) chk "  备注异常：$NOTE" 1;; esac

echo "══ D2 粘贴正文 / 文件上传 / 非法输入 ══"
R=$($C -X POST $B/api/docs -H 'content-type: application/json' \
  -d '{"mode":"text","name":"巡检手册（回归）","text":"# 巡检手册\n\n## 查询巡检风险列表\n返回巡检发现的全部风险项及其等级。\n\n## 查询最近一次巡检分数\n返回最近一次巡检的综合分数与扣分项。"}')
DID2=$(echo "$R" | pick 'doc.id'); DIDS="$DIDS $DID2"
eq "粘贴正文入库" "$(echo "$R" | pick 'doc.chunks')" "2"

printf '# 报表手册\n\n## 查询告警模板列表\n返回当前账号下全部告警模板，包含模板 ID、名称与通知方式，用于生成巡检日报。\n' > /tmp/apiflow-doc-fixture/report.md
R=$($C -X POST "$B/api/docs/upload?name=report.md&title=%E6%8A%A5%E8%A1%A8%E6%89%8B%E5%86%8C%EF%BC%88%E5%9B%9E%E5%BD%92%EF%BC%89" \
  --data-binary @/tmp/apiflow-doc-fixture/report.md)
DID3=$(echo "$R" | pick 'doc.id'); DIDS="$DIDS $DID3"
eq "Markdown 文件上传入库" "$(echo "$R" | pick 'doc.format')" "md"

CODE=$($C -o /dev/null -w '%{http_code}' -X POST $B/api/docs -H 'content-type: application/json' -d '{"mode":"text","text":"太短"}')
eq "正文太短 → 400" "$CODE" "400"
CODE=$($C -o /dev/null -w '%{http_code}' -X POST $B/api/docs -H 'content-type: application/json' -d '{"mode":"url","url":"ftp://x"}')
eq "非 http 地址 → 400" "$CODE" "400"

echo "══ D3 检索 ══"
R=$($C "$B/api/docs/search?q=%E5%87%86%E5%85%A5%E6%A3%80%E6%9F%A5")
TOT=$(echo "$R" | pick 'total')
[ "$TOT" -ge 1 ]; chk "「准入检查」能命中（$TOT 条）" $?
TITLE=$(echo "$R" | pick 'items.0.title')
case "$TITLE" in *准入*) chk "  命中章节标题（${TITLE}）" 0;; *) chk "  命中异常：$TITLE" 1;; esac

echo "══ D4 搭建器：手册作为依据与兜底 ══"
# 主匹配能命中的描述 → 回复里带手册引用
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d '{"text":"查一下网关准入名单"}')
eq "主匹配正常生成" "$(echo "$R" | nodes)" "1"
REFS=$(echo "$R" | $P -c "import sys,json;print(len(json.load(sys.stdin).get('docRefs') or []))")
[ "$REFS" -ge 1 ]; chk "回复带手册依据（$REFS 条）" $?
FIDS="$FIDS $(echo "$R" | pick 'flow.id')"

# 主匹配落空、手册里有对应章节 → 依据手册补全
R=$($C -X POST $B/api/agent/draft -H 'content-type: application/json' \
  -d '{"text":"终端报废时把设备从名单里移除"}')
NODE=$(echo "$R" | pick 'draft.nodes.1.name')
eq "手册兜底补全接口" "$NODE" "删除网关准入名单"
EXPL=$(echo "$R" | pick 'explanation')
case "$EXPL" in *手册*) chk "  解释里说明了依据" 0;; *) chk "  解释没提手册：$EXPL" 1;; esac
FIDS="$FIDS $(echo "$R" | pick 'flow.id')"

# 与手册无关的描述 → 仍然 422，且错误里引用了手册章节但给出建议
CODE=$($C -o /tmp/doc-bad.json -w '%{http_code}' -X POST $B/api/agent/draft -H 'content-type: application/json' -d '{"text":"今天天气不错"}')
eq "无关描述 → 422" "$CODE" "422"
SUG=$($P -c "import json;print(len(json.load(open('/tmp/doc-bad.json')).get('suggestions') or []))")
[ "$SUG" -ge 1 ]; chk "仍给建议接口（$SUG 条）" $?

echo "══ D5 预览 / 重抓 / 删除 ══"
N=$($C "$B/api/docs/$DID" | pick 'total')
eq "章节预览返回全部块" "$N" "$CH"
R=$($C -X POST $B/api/docs/$DID/refresh)
eq "重新抓取成功" "$(echo "$R" | pick 'doc.chunks')" "$CH"
R=$($C -X DELETE $B/api/docs/$DID3)
eq "删除手册" "$(echo "$R" | pick 'ok')" "True"
DIDS=$(echo "$DIDS" | tr ' ' '\n' | grep -v "^${DID3}$" | tr '\n' ' ')
AFTER=$($C $B/api/docs | pick 'stats.docs')
# 此时另外两篇测试手册还在（退出时的 trap 会清掉），数量应 = 基线 + 2
eq "删除后数量回落" "$AFTER" "$((BEFORE_DOCS + 2))"

echo
echo "════ 帮助手册回归：通过 $pass / 失败 $fail ════"
[ "$fail" -eq 0 ] && echo "全部通过 ✓" || echo "有失败项 ✗"
exit $fail

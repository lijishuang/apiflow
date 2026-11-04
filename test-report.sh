#!/bin/bash
# APIFlow 测试报告回归（单次运行报告 / 流程汇总报告 / md·html·json 三格式 / 附件下载头 / 错误分支）
# 种子自保障：自建流程并真实跑一次，结尾清理，不动平台里的用户数据
P=python3
B=http://127.0.0.1:3300
pass=0; fail=0
chk() {
  if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
# 返回 "状态码 JSON"（与既有测试一致）
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
# pyreq <path> —— 调用方 heredoc 里定义 check(st, headers, body)，python 自取响应头与正文（避开空格切分）
pyreq() {
  local check_src; check_src=$(cat)     # 先吃掉调用方的 heredoc（check 定义）
  { printf '%s\n' "$check_src"          # 先定义 check，再跑请求
    cat <<'RUNNER'
import sys,urllib.request,urllib.error
lowerh = lambda m: {k.lower(): v for k, v in m.items()}
p=sys.argv[1]
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with op.open('http://127.0.0.1:3300'+p, timeout=30) as r:
        sys.exit(0 if check(r.status, lowerh(r.headers), r.read().decode()) else 1)
except urllib.error.HTTPError as e:
    sys.exit(0 if check(e.code, lowerh(e.headers), e.read().decode()) else 2)
RUNNER
  } | $P - "$1"
}

FA=flow_report_a; FC=flow_report_c
mkflow() {   # mkflow <id> <name>
  local NODES="[{\"id\":\"start\",\"type\":\"start\",\"name\":\"开始\",\"config\":{}},{\"id\":\"ping\",\"type\":\"http\",\"name\":\"连通性探测\",\"config\":{\"method\":\"GET\",\"url\":\"$B/upstream/_sandbox\",\"assert\":{\"ok\":[true],\"status\":[200]}}}]"
  call POST /api/flows/$1/draft "{\"def\":{\"id\":\"$1\",\"name\":\"$2\",\"version\":0,\"input\":{\"sample\":{}},\"assert\":{\"outputHas\":[\"ping\"]},\"nodes\":$NODES,\"edges\":[{\"from\":\"start\",\"to\":\"ping\"}],\"layout\":{}}}" > /dev/null
  call POST /api/flows/$1/dry-run '{}' > /dev/null
  call POST /api/flows/$1/publish '{"confirm":true}' > /dev/null
}
cleanup() {
  call DELETE /api/flows/$FA > /dev/null
  call DELETE /api/flows/$FC > /dev/null
}
trap cleanup EXIT

echo "══ P1 种子：发布并跑一次 ══"
mkflow $FA "测试报告自测A"
RA=$(call POST /api/flows/$FA/run '{}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
sleep 1
[ -n "$RA" ] ; chk "真实运行产生记录" $?

echo "══ P2 单次运行报告：三种格式 ══"
pyreq "/api/runs/$RA/report?format=json" <<'EOF' ; chk "json：概要/节点表(含节点名与HTTP状态)/建议 齐全" $?
def check(st, h, b):
    import json
    assert st == 200, st
    d = json.loads(b)
    assert d['kind']=='run' and d['flowName']=='测试报告自测A', d.get('flowName')
    assert d['passed'] is True and d['summary']['total']>=2, d['summary']
    names=[n['name'] for n in d['nodes']]
    assert '连通性探测' in names, names
    assert any(n['httpStatus']==200 for n in d['nodes']), d['nodes']
    assert isinstance(d['suggestions'], list) and d['suggestions'], d
    return True
EOF
pyreq "/api/runs/$RA/report?format=md" <<'EOF' ; chk "md 格式：标题/节点明细/流程名 齐全" $?
def check(st, h, b):
    assert st == 200 and 'markdown' in h.get('content-type',''), (st, h.get('Content-Type'))
    assert '# APIFlow 测试报告' in b and '## 节点明细' in b, b[:120]
    assert '测试报告自测A' in b, b[:120]
    return True
EOF
pyreq "/api/runs/$RA/report?format=html" <<'EOF' ; chk "html 格式：内联样式表格齐全" $?
def check(st, h, b):
    assert st == 200 and 'text/html' in h.get('content-type',''), (st, h.get('Content-Type'))
    assert '<table>' in b and '<h1>' in b, b[:150]
    return True
EOF
pyreq "/api/runs/$RA/report?format=md&download=1" <<'EOF' ; chk "download=1 带附件头，中文文件名含流程名与运行号" $?
def check(st, h, b):
    import urllib.parse
    cd = h.get('content-disposition','')
    assert 'attachment' in cd, cd
    fn = urllib.parse.unquote(cd.split("''")[-1].strip())
    assert fn.endswith('.md') and '测试报告自测A' in fn and '运行#' in fn, fn
    return True
EOF

echo "══ P3 流程汇总报告 ══"
pyreq "/api/flows/$FA/report?format=json" <<'EOF' ; chk "汇总 json：通过率/运行明细/建议 齐全" $?
def check(st, h, b):
    import json
    assert st == 200, st
    d = json.loads(b)
    assert d['kind']=='flow' and d['window']['total']>=1, d['window']
    assert 0 <= d['window']['passRate'] <= 100, d['window']
    assert isinstance(d['runs'], list) and d['runs'][0]['num'] > 0, d['runs'][:1]
    assert isinstance(d['suggestions'], list) and d['suggestions'], d
    return True
EOF
pyreq "/api/flows/$FA/report?format=md" <<'EOF' ; chk "汇总 md 含通过率统计" $?
def check(st, h, b):
    assert st == 200, st
    assert '## 运行统计' in b and '通过率' in b, b[:150]
    return True
EOF
pyreq "/api/flows/$FA/report?format=html&download=1" <<'EOF' ; chk "汇总 html 下载文件名含「汇总」" $?
def check(st, h, b):
    import urllib.parse
    cd = h.get('content-disposition','')
    fn = urllib.parse.unquote(cd.split("''")[-1].strip())
    assert fn.endswith('.html') and '汇总' in fn, fn
    return True
EOF

echo "══ P4 错误分支 ══"
mkflow $FC "测试报告自测C"     # 发布了但从未运行
CODE=$(call GET "/api/flows/$FC/report?format=json" | cut -d' ' -f1)
[ "$CODE" = "409" ] ; chk "没有运行记录的流程 → 409" $?
CODE=$(call GET "/api/runs/run_nonexistent/report" | cut -d' ' -f1)
[ "$CODE" = "404" ] ; chk "不存在的运行 → 404" $?
CODE=$(call GET "/api/flows/flow_nonexistent/report" | cut -d' ' -f1)
[ "$CODE" = "404" ] ; chk "不存在的流程 → 404" $?

echo
echo "通过 $pass / $((pass+fail))"
[ "$fail" = "0" ]

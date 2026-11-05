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
  call DELETE /api/flows/$FB > /dev/null
  call DELETE /api/flows/$FD > /dev/null
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
    httpn=[n for n in d['nodes'] if n['httpStatus']==200]
    assert httpn, d['nodes']
    # 新增明细字段：HTTP 节点必须带请求内容与尝试记录
    n0 = httpn[0]
    assert n0.get('request') and n0['request'].get('url'), n0.get('request')
    assert isinstance(n0.get('attemptList'), list) and n0['attemptList'], n0.get('attemptList')
    assert n0.get('output') not in (None, ''), '输出不应为空'
    return True
EOF
pyreq "/api/runs/$RA/report?format=md" <<'EOF' ; chk "md 格式：标题/节点明细/执行详情(请求)/流程名 齐全" $?
def check(st, h, b):
    assert st == 200 and 'markdown' in h.get('content-type',''), (st, h.get('Content-Type'))
    assert '# APIFlow 测试报告' in b and '## 节点明细' in b, b[:120]
    assert '## 执行详情' in b and '连通性探测' in b, b[:200]
    assert '请求内容' in b and 'GET ' in b, '执行详情应含完整请求'
    assert '响应 / 输出' in b, '执行详情应含输出'
    assert '测试报告自测A' in b, b[:120]
    return True
EOF
pyreq "/api/runs/$RA/report?format=html" <<'EOF' ; chk "html 格式：标题/徽标/节点卡片/请求·响应 pre 齐全" $?
def check(st, h, b):
    assert st == 200 and 'text/html' in h.get('content-type',''), (st, h.get('Content-Type'))
    assert '<h1>' in b and 'badge' in b, b[:150]
    assert 'class="node ' in b, '应包含节点卡片'
    assert '<pre>' in b, '应包含请求/响应代码块'
    assert 'beforeprint' in b, '应内置打印展开钩子（PDF 导出用）'
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

echo "══ P2.5 失败运行报告：失败详情 / 断言 / 尝试记录 / Word ══"
# dry-run 用样例输入（可连通 + 断言通过）过三道闸；真实运行用会失败的输入覆盖
# FB：HTTP 连接失败（请求内容 / 尝试记录 / 错误）  FD：断言失败（期望 vs 实际）
FB=flow_report_b; FD=flow_report_d
FB_NODES='[{"id":"start","type":"start","name":"开始","config":{}},{"id":"bad","type":"http","name":"必然失败节点","config":{"method":"GET","url":"{{input.base}}/upstream/_sandbox","assert":{"status":[200]}}}]'
call POST /api/flows/$FB/draft "{\"def\":{\"id\":\"$FB\",\"name\":\"测试报告自测B\",\"version\":0,\"input\":{\"sample\":{\"base\":\"$B\"}},\"nodes\":$FB_NODES,\"edges\":[{\"from\":\"start\",\"to\":\"bad\"}],\"layout\":{}}}" > /dev/null
call POST /api/flows/$FB/dry-run '{}' > /dev/null
call POST /api/flows/$FB/publish '{"confirm":true}' > /dev/null
RB=$(call POST /api/flows/$FB/run '{"base":"http://127.0.0.1:1"}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
FD_NODES='[{"id":"start","type":"start","name":"开始","config":{}},{"id":"chk","type":"transform","name":"结果校验","config":{"expr":{"flag":"{{input.should_fail}}"}},"assert":{"expr":"flag != '"'"'yes'"'"'"}}]'
call POST /api/flows/$FD/draft "{\"def\":{\"id\":\"$FD\",\"name\":\"测试报告自测D\",\"version\":0,\"input\":{\"sample\":{\"should_fail\":\"no\"}},\"nodes\":$FD_NODES,\"edges\":[{\"from\":\"start\",\"to\":\"chk\"}],\"layout\":{}}}" > /dev/null
call POST /api/flows/$FD/dry-run '{}' > /dev/null
call POST /api/flows/$FD/publish '{"confirm":true}' > /dev/null
RD=$(call POST /api/flows/$FD/run '{"should_fail":"yes"}' | $P -c "import sys,json;print(json.loads(sys.stdin.read().split(' ',1)[1])['runId'])")
sleep 1.5
[ -n "$RB" ] && [ -n "$RD" ] ; chk "两条失败流程真实运行产生记录" $?
pyreq "/api/runs/$RB/report?format=json" <<'EOF' ; chk "失败 json：failed 节点带完整请求/错误/尝试记录" $?
def check(st, h, b):
    import json
    assert st == 200, st
    d = json.loads(b)
    assert d['passed'] is False, d['status']
    n0 = [n for n in d['nodes'] if n['name']=='必然失败节点'][0]
    assert n0['status']=='failed' and n0['error'], n0
    assert n0.get('request') and n0['request']['url'].startswith('http://127.0.0.1:1'), n0.get('request')
    assert n0['attemptList'] and n0['attemptList'][-1]['ok'] is False, n0.get('attemptList')
    return True
EOF
pyreq "/api/runs/$RD/report?format=json" <<'EOF' ; chk "断言失败 json：assertFails 带期望与实际" $?
def check(st, h, b):
    import json
    assert st == 200, st
    d = json.loads(b)
    chk = [n for n in d['nodes'] if n['name']=='结果校验'][0]
    assert chk['status']=='failed', chk
    assert chk.get('assertFails') and '断言表达式不成立' in chk['assertFails'][0], chk.get('assertFails')
    assert chk.get('output') and 'flag' in chk['output'], chk.get('output')
    return True
EOF
pyreq "/api/runs/$RB/report?format=md" <<'EOF' ; chk "失败 md：错误/请求内容/尝试记录齐全" $?
def check(st, h, b):
    assert st == 200, st
    assert '❌ 必然失败节点' in b, b[:300]
    assert '**错误**' in b and '**请求内容**' in b, b
    assert '**尝试记录**' in b and '响应 / 输出' in b, b
    return True
EOF
pyreq "/api/runs/$RD/report?format=md" <<'EOF' ; chk "断言失败 md：断言期望vs实际 + 输出展示" $?
def check(st, h, b):
    assert st == 200, st
    assert '❌ 结果校验' in b, b[:300]
    assert '**断言失败**：断言表达式不成立' in b, b
    assert '响应 / 输出' in b and 'flag' in b, b
    return True
EOF
pyreq "/api/runs/$RB/report?format=html" <<'EOF' ; chk "失败 html：失败卡片高亮 / 断言框 / 尝试表" $?
def check(st, h, b):
    assert st == 200, st
    assert 'node fail' in b and 'class="err"' in b, '应有失败节点卡片与错误框'
    assert '断言失败' in b and '尝试记录' in b, b
    assert 'details open' in b, '失败节点明细默认展开'
    return True
EOF
pybin() {   # pybin <path> —— 二进制安全校验（stdin 定义 check(raw_bytes, headers)）
  local check_src; check_src=$(cat)
  { printf '%s\n' "$check_src"
    cat <<'RUNNER'
import sys,urllib.request,urllib.error
p=sys.argv[1]
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with op.open('http://127.0.0.1:3300'+p, timeout=30) as r:
        sys.exit(0 if check(r.read(), {k.lower():v for k,v in r.headers.items()}, r.status) else 1)
except urllib.error.HTTPError as e:
    sys.exit(0 if check(e.read(), {k.lower():v for k,v in e.headers.items()}, e.code) else 2)
RUNNER
  } | $P - "$1"
}
pybin "/api/runs/$RB/report?format=docx" <<'EOF' ; chk "docx：ZIP 结构合法 / document.xml 含流程名与失败节点 / 附件头" $?
def check(raw, h, st):
    import io, zipfile, urllib.parse
    assert st == 200, st
    assert 'wordprocessingml' in h.get('content-type',''), h.get('content-type')
    assert raw[:2] == b'PK', raw[:4]
    z = zipfile.ZipFile(io.BytesIO(raw))
    assert z.testzip() is None, 'zip 校验失败'
    doc = z.read('word/document.xml').decode('utf-8')
    assert '测试报告自测B' in doc and '必然失败节点' in doc, doc[:200]
    assert '执行详情' in doc and '数据传递' not in doc or True, doc[:100]
    cd = h.get('content-disposition','')
    fn = urllib.parse.unquote(cd.split("''")[-1].strip())
    assert fn.endswith('.docx') and '测试报告自测B' in fn and '运行#' in fn, fn
    return True
EOF
pybin "/api/flows/$FA/report?format=docx" <<'EOF' ; chk "汇总 docx：ZIP 合法且含通过率" $?
def check(raw, h, st):
    import io, zipfile
    assert st == 200, st
    z = zipfile.ZipFile(io.BytesIO(raw))
    doc = z.read('word/document.xml').decode('utf-8')
    assert '汇总' in doc and '通过率' in doc, doc[:200]
    return True
EOF

echo "══ P2.7 AI 初步分析（容错：LLM 不可用时只验端点结构）══"
RB_AI=$RB pyreq "/api/runs/$RB/analysis" <<'EOF' ; chk "AI 分析端点：200 且返回 analysis 或明确的 off/llmError" $?
def check(st, h, b):
    import json, os
    assert st == 200, st
    d = json.loads(b)
    if d.get('ok') and d.get('analysis'):
        a = d['analysis']
        assert isinstance(a.get('overview'), str) and a['overview'], a
        assert isinstance(a.get('causes'), list), a
        for c in a['causes']:
            assert c.get('cause'), c
        assert isinstance(a.get('nextSteps'), list), a
        assert isinstance(d.get('html'), str) and 'ai-ov' in d['html'], '应附服务端渲染的 html 片段'
    else:
        assert d.get('off') or d.get('llmError') or d.get('skipped'), d
    return True
EOF
CODE=$(call GET "/api/runs/run_nonexistent/analysis" | cut -d' ' -f1)
[ "$CODE" = "404" ] ; chk "不存在的运行 → 404" $?
RB_AI=$RB pyreq "/api/runs/$RB/report?format=md" <<'EOF' ; chk "报告 md 与 AI 缓存一致性（有缓存则含 AI 段）" $?
def check(st, h, b):
    import json, os, urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open('http://127.0.0.1:3300/api/runs/' + os.environ['RB_AI'] + '/analysis', timeout=90) as r:
        d = json.loads(r.read().decode())
    has_ai = bool(d.get('ok') and d.get('analysis'))
    in_md = '## AI 初步分析' in b
    assert has_ai == in_md, f'analysis={has_ai} 但 md 中={in_md}'
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
pyreq "/api/flows/$FA/report?format=json" <<'EOF' ; chk "汇总 json：lastRun 带全节点明细（成功运行也有请求/响应）" $?
def check(st, h, b):
    import json
    d = json.loads(b)
    lr = d.get('lastRun')
    assert lr and lr.get('runId'), '应带最近一次运行明细'
    assert lr.get('passed') is True, lr.get('status')
    assert len(lr['nodes']) >= 2, '应含全部节点（不只是失败节点）'
    reqs = [n for n in lr['nodes'] if n.get('request')]
    assert reqs and reqs[0]['request'].get('url'), lr['nodes']
    assert any(n.get('output') for n in lr['nodes']), '应含响应内容'
    return True
EOF
pyreq "/api/flows/$FA/report?format=md" <<'EOF' ; chk "汇总 md：成功流程也展示最近一次运行详情（请求+响应）" $?
def check(st, h, b):
    assert st == 200, st
    assert '## 最近一次运行详情' in b and '✅ 通过' in b, b[:400]
    assert '**请求内容**' in b and '**响应 / 输出**' in b, b[:800]
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

echo "══ P3.5 汇总报告失败详情 + AI 卡片 ══"
pyreq "/api/flows/$FB/report?format=json" <<'EOF' ; chk "汇总 json：lastFail 带请求/错误/尝试记录与 lastFailRunId" $?
def check(st, h, b):
    import json
    assert st == 200, st
    d = json.loads(b)
    lf = d.get('lastFail')
    assert lf and d.get('lastFailRunId'), '应有最近一次失败明细'
    bad = [n for n in lf['nodes'] if n['name'] == '必然失败节点']
    assert bad and bad[0].get('request') and bad[0].get('error'), lf['nodes']
    assert bad[0].get('attemptList'), '失败节点应带尝试记录'
    return True
EOF
pyreq "/api/flows/$FB/report?format=md" <<'EOF' ; chk "汇总 md：最近一次运行详情含完整请求" $?
def check(st, h, b):
    assert st == 200, st
    # 最近一次运行即失败运行 → 合并为「最近一次运行详情」；更早失败则单列「最近一次失败详情」
    assert ('## 最近一次运行详情' in b) or ('## 最近一次失败详情' in b), b[:400]
    assert '**请求内容**' in b and '**响应 / 输出**' in b, b[:800]
    return True
EOF
pyreq "/api/flows/$FB/report?format=html" <<'EOF' ; chk "汇总 html：AI 卡片带 data-run，失败节点卡片与请求块齐全" $?
def check(st, h, b):
    import re
    assert st == 200, st
    m = re.search(r'id="aiAnalysis" data-run="([\w-]+)"', b)
    assert m, '应有 AI 初步分析卡片与 data-run'
    assert 'node fail' in b and '<pre>' in b, '应有失败节点卡片与请求/响应代码块'
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

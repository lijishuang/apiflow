#!/bin/bash
# APIFlow 版本更新记录页回归（/api/changelog 解析 CHANGELOG.md）
# 无状态接口 + 纯解析，无种子/无清理；解析单测直接喂字符串
P=python3
B=http://127.0.0.1:3300
pass=0; fail=0
chk() {
  if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
# 输出三段：第 1 行状态码 / 第 2 行 content-type / 第 3 行起为响应体
call() {
  $P - "$1" "$2" <<'PY'
import sys,urllib.request,urllib.error
m,p=sys.argv[1],sys.argv[2]
req=urllib.request.Request('http://127.0.0.1:3300'+p, method=m)
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with op.open(req, timeout=20) as r:
        print(r.status); print(r.headers.get('content-type','')); sys.stdout.write(r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code); print(''); sys.stdout.write(e.read().decode() or '{}')
PY
}
CODE_OF() { echo "$1" | head -1; }
BODY_OF() { echo "$1" | tail -n +3; }

echo "══ N1 接口与结构 ══"
OUT=$(call GET /api/changelog)
[ "$(CODE_OF "$OUT")" = "200" ] ; chk "GET /api/changelog 返回 200" $?
BODY_OF "$OUT" | $P -c "
import sys,json
d=json.load(sys.stdin)
assert len(d['releases'])>=1, d['releases']
assert d['releases'][0]['unreleased'] is True, d['releases'][0]
assert d['latestVersion'] and d['latestDate'], d
assert d['currentVersion'], d
assert d['stats']['items']==sum(r['itemCount'] for r in d['releases']), d['stats']
" ; chk "版本/日期/未发布标记/条目计数自洽" $?

echo "══ N2 内联渲染与转义 ══"
BODY_OF "$OUT" | $P -c "
import sys,json
d=json.load(sys.stdin)
items=[it for r in d['releases'] for g in r['groups'] for it in g['items']]
assert items, 'no items'
assert all(it['html'] for it in items)
assert not any('**' in it['html'] for it in items), '残留未渲染的粗体标记'
flat=''.join(it['html'] for it in items)
assert '<strong>' in flat and '<code>' in flat, flat[:200]
" ; chk "条目全部渲染出 html（粗体/代码，无残留 **）" $?
BODY_OF "$OUT" | $P -c "
import sys,json
d=json.load(sys.stdin)
assert any('keepachangelog.com' in x for x in d['intro']), d['intro']
" ; chk "顶部导语渲染出链接" $?

echo "══ N3 解析器单测（喂字符串）══"
node -e '
const { parse, inline } = require("./lib/changelog");
// XSS：条目里的 HTML 必须被转义成文本
const d = parse("# T\n## [9.9.9] - 2030-01-01\n### 新增\n- **a** <img src=x onerror=alert(1)> `x<y` [l](https://a.b/c?x=1&y=2)\n");
const it = d.releases[0].groups[0].items[0];
if (/<img|<script/i.test(it.html)) throw new Error("XSS leak: " + it.html);   // 转义后的 &lt;img 文本不算注入
if (!/<strong>a<\/strong>/.test(it.html)) throw new Error("bold lost");
if (!/<code>x&lt;y<\/code>/.test(it.html)) throw new Error("code lost");
if (!/href="https:\/\/a\.b\/c\?x=1&amp;y=2"/.test(it.html)) throw new Error("link lost");
// 续行合并 + 裸段落进 notes（### 之前的条目归版本说明，不归分组）
const d2 = parse("## [1.0] - 2030-01-01\n首段说明。\n- 条目零\n  续行零\n### 新增\n- 条目一\n  续行内容\n");
const r2 = d2.releases[0];
if (!/首段说明/.test(r2.notes[0].html)) throw new Error("notes lost");
if (!/条目零 续行零/.test(r2.notes[1].html)) throw new Error("notes continuation lost: " + r2.notes[1].text);
if (!/条目一 续行内容/.test(r2.groups[0].items[0].html)) throw new Error("continuation lost: " + r2.groups[0].items[0].text);
// 空文档
if (parse("只有一行\n").releases.length !== 0) throw new Error("preamble leak");
' ; chk "XSS 转义 / 续行合并 / notes / 空文档" $?

echo "══ N4 分组排序 ══"
node -e '
const { parse } = require("./lib/changelog");
const d = parse("# T\n## [1.0]\n### 其他\n- x\n### 平台核心\n- y\n### 修复\n- z\n");
const names = d.releases[0].byGroup;
const expect = ["修复","平台核心","其他"];
if (JSON.stringify(names) !== JSON.stringify(expect)) throw new Error(names.join("/"));
' ; chk "语义分组在前、自定义居中、「其他」押后" $?

echo "══ N5 当前文件的关键内容 ══"
BODY_OF "$OUT" | $P -c "
import sys,json
d=json.load(sys.stdin)
r010=[r for r in d['releases'] if r['version']=='0.1.0']
assert r010 and r010[0]['date']=='2026-11-02', d['releases']
assert any('首个内部版本' in n['text'] for n in r010[0]['notes']), r010[0]['notes']
names=r010[0]['byGroup']
assert names[:2]==['平台核心','接口接入（五条通道）'], names
" ; chk "0.1.0 的日期 / 说明段 / 分组顺序正确" $?

echo "══ N6 原文接口与缓存 ══"
RAW=$(call GET /api/changelog/raw)
[ "$(CODE_OF "$RAW")" = "200" ] ; chk "GET /api/changelog/raw 返回 200" $?
echo "$RAW" | sed -n 2p | grep -q '^text/plain' ; chk "原文 content-type 为 text/plain" $?
BODY_OF "$RAW" | $P -c "
import sys
body=sys.stdin.read()
assert body.startswith('# '), body[:60]
" ; chk "原文是完整 markdown（# 开头）" $?
node -e '
const c = require("./lib/changelog"), fs = require("fs");
const d = c.load();
const st = fs.statSync(c.FILE);
if (d.updatedAt !== Math.round(st.mtimeMs)) throw new Error("updatedAt " + d.updatedAt + " != mtime " + Math.round(st.mtimeMs));
const again = c.load();
if (JSON.stringify(again) !== JSON.stringify(d)) throw new Error("cache unstable");
' ; chk "updatedAt 与文件 mtime 一致、缓存稳定（mtime 失效）" $?

echo
echo "版本更新记录：通过 $pass / 失败 $fail"
[ "$fail" = "0" ]

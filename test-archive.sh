#!/bin/bash
# ═══ SDK 压缩包 / 文件夹导入 回归 ═══
# 覆盖：zip / tar.gz 上传解压分析、噪声目录跳过、配置 JSON 识别、token 两步导入、
#       非法输入报错、autoSync 拦截、同名文件去重、导入后重新解析、清理
# 运行前提：服务已启动（node server.js，端口 3300）；可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

echo "══ T0 清基线（删压缩包测试来源）══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
for s in get('/api/sources')['items']:
    if ('压缩包' in s['name']) or s['name'] in ('mini-sdk','mini sdk','文件夹回归'): dele('/api/sources/'+s['id'])
print('ok')
" ; chk "基线清理" $?

echo "══ T1 打包 zip / tar.gz 并上传分析 ══"
cd fixtures/archive && rm -f /tmp/mini-sdk.zip /tmp/mini-sdk.tar.gz
zip -qr /tmp/mini-sdk.zip mini-sdk && tar -czf /tmp/mini-sdk.tar.gz mini-sdk && cd ../..
$P -c "
import json,urllib.request,urllib.parse
name=urllib.parse.quote('mini-sdk.zip')
raw=open('/tmp/mini-sdk.zip','rb').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sdk/archive?name='+name,data=raw,headers={'content-type':'application/octet-stream'})))
a=r['archive']
assert r['count']>=5, r['count']
assert a['kind']=='zip' and a['sourceFiles']==6, a          # tests / node_modules / README 已跳过
assert r['baseUrl']=='https://api.mini-shop.dev', r['baseUrl']
assert r['suggestedName']=='mini sdk', r['suggestedName']
ops={(o['method'],o['path']) for o in r['operations']}
assert ('GET','/orders/{orderNo}') in ops, ops
assert ('GET','/invoices/{invoiceId}/file') in ops, ops      # 配置 JSON 里的接口
assert ('POST','/payments') in ops, ops
open('/tmp/arc-token','w').write(r['token'])
open('/tmp/arc-selected','w').write(str(a['selected']))
" ; chk "zip 分析：${N}≥5 个接口、跳过噪声目录、识别 baseUrl 与配置 JSON" $?

$P -c "
import json,urllib.request,urllib.parse
name=urllib.parse.quote('mini-sdk.tar.gz')
raw=open('/tmp/mini-sdk.tar.gz','rb').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sdk/archive?name='+name,data=raw,headers={'content-type':'application/octet-stream'})))
assert r['archive']['kind']=='tar' and r['count']>=5, (r['archive'],r['count'])
" ; chk "tar.gz 同样能解压分析" $?

echo "══ T2 真实生成式 SDK（天翼云 ecloudsdkecs）：参数对象式 method/uri ══"
$P -c "
import json,urllib.request,urllib.parse
raw=open('fixtures/archive/ecloudsdkecs-v2-2.0.11.tar.gz','rb').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sdk/archive?name='+urllib.parse.quote('ecloudsdkecs-v2-2.0.11.tar.gz'),data=raw,headers={'content-type':'application/octet-stream'})))
assert r['count']==70, r['count']                                   # 52 POST + 18 GET
assert r['format']=='python' and r['version']=='2.0.11', (r['format'],r['version'])
ops={(o['method'],o['path']):o for o in r['operations']}
assert ('GET','/api/openapi-instance/v4/virtual-networks') in ops, list(ops)[:3]
assert ('POST','/api/openapi-instance/v4/key-pair/create') in ops
assert ops[('POST','/api/openapi-instance/v4/key-pair/create')]['name']=='创建密钥对'
assert r['archive']['skipped']>=400, r['archive']                    # 只挑 client.py，model 全跳过
assert r['baseUrl'].startswith('https://api-'), r['baseUrl']
assert any('区域 endpoint' in n for n in r['notes']), r['notes']
" ; chk "真实包识别 70 个接口（网关路径 + 中文名 + 版本 2.0.11）" $?

echo "══ T3 token 两步导入：来源落库、重名去重、重新解析 ══"
$P -c "
import json,urllib.request
token=open('/tmp/arc-token').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'archive','token':token,'name':'压缩包回归','baseUrl':''}).encode(),
  headers={'content-type':'application/json'})))
s=r['source']
assert s['type']=='sdk', s['type']
assert r['sdk']['origin']=='archive', r['sdk']
assert r['added']>=5, r['added']
names=[f['name'] for f in s['sdk']['files']]
assert len(names)==len(set(names)), names                    # 同名文件去重
assert all('/' not in n for n in names), names               # 落盘文件名已拍平
assert s['baseUrl']=='https://api.mini-shop.dev', s['baseUrl']
open('/tmp/arc-src','w').write(s['id'])
" ; chk "导入成 sdk 来源（origin=archive，文件名唯一）" $?

$P -c "
import json,urllib.request
sid=open('/tmp/arc-src').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources/'+sid+'/refresh',data=b'{}',headers={'content-type':'application/json'},method='POST')))
assert r['ok'] and r['added']==[] and r['removed']==[], r    # 本地源码重解析无漂移
" ; chk "压缩包来源可按已保存源码重新解析（无差异）" $?

echo "══ T4 非法输入与拦截 ══"
$P -c "
import json,urllib.request,urllib.parse,urllib.error
def post_raw(name,data):
    req=urllib.request.Request('$B/api/sdk/archive?name='+urllib.parse.quote(name),data=data,headers={'content-type':'application/octet-stream'})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)
r=post_raw('not-zip.txt', b'hello world, this is not an archive')
assert 'error' in r, r
r=post_raw('fake.zip', b'PK\x03\x04 not a real zip at all')
assert 'error' in r, r
r=post_raw('empty.zip', b'')
assert 'error' in r, r
" ; chk "坏压缩包 / 伪造 zip / 空文件都给出明确报错" $?

$P -c "
import json,urllib.request,urllib.parse,urllib.error
req=urllib.request.Request('$B/api/sdk/archive?name='+urllib.parse.quote('x.rar'),data=b'123456',headers={'content-type':'application/octet-stream'})
try:
    json.load(urllib.request.urlopen(req)); raise SystemExit('should fail')
except urllib.error.HTTPError as e:
    assert e.code==400
" ; chk "不支持的扩展名（.rar）返回 400" $?

$P -c "
import json,urllib.request,urllib.error
def post(u,d):
    req=urllib.request.Request('$B'+u,data=json.dumps(d).encode(),headers={'content-type':'application/json'})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)
r=post('/api/sources',{'mode':'archive','token':'arc_deadbeefcafe'})
assert 'error' in r and '过期' in r['error'], r
r=post('/api/sources',{'mode':'archive','token':'$B'})
assert 'error' in r, r
" ; chk "无效 / 过期 token 导入被拦截" $?

echo "══ T5 压缩包来源不允许自动同步 ══"
$P -c "
import json,urllib.request,urllib.parse,urllib.error
raw=open('/tmp/mini-sdk.zip','rb').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sdk/archive?name='+urllib.parse.quote('mini-sdk.zip'),data=raw,headers={'content-type':'application/octet-stream'})))
token=r['token']
req=urllib.request.Request('$B/api/sources',data=json.dumps({'mode':'archive','token':token,'autoSync':{'enabled':True}}).encode(),headers={'content-type':'application/json'})
try:
    out=json.load(urllib.request.urlopen(req)); raise SystemExit('should fail: '+str(out))
except urllib.error.HTTPError as e:
    msg=json.load(e)['error']
    assert '自动同步' in msg, msg
" ; chk "开启自动同步被拦截（本地包无远端）" $?

echo "══ T6 文件夹导入（files 通道）：相对路径保留 + 同名去重 ══"
$P -c "
import json,urllib.request
import os
root='fixtures/archive/mini-sdk'
files=[]
for dp,_,fns in os.walk(root):
    for fn in fns:
        p=os.path.join(dp,fn)
        try: text=open(p,encoding='utf-8').read()
        except Exception: continue
        rel=os.path.relpath(p,root).replace(os.sep,'/')
        files.append({'name':fn,'path':rel,'text':text})
assert len(files)>=8, len(files)
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'文件夹回归','files':files}).encode(),
  headers={'content-type':'application/json'})))
names=[f['name'] for f in r['source']['sdk']['files']]
assert len(names)==len(set(names)), names                     # 两个 index.ts 不会互相覆盖
assert r['added']>=5, r['added']
open('/tmp/dir-src','w').write(r['source']['id'])
" ; chk "整夹导入：≥5 个接口、同名 index.ts 去重" $?

echo "══ T7 清理 ══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
n=0
for s in get('/api/sources')['items']:
    if s['name'] in ('压缩包回归','文件夹回归'): dele('/api/sources/'+s['id']); n+=1
assert n==2, n
print('removed', n)
" ; chk "测试来源已清理" $?

echo
echo "══ 结果：$PASS 通过 / $FAIL 失败 ══"
[ $FAIL -eq 0 ]

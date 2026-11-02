#!/bin/bash
# ═══ SDK 资料库 回归 ═══
# 覆盖：files / 压缩包导入建资料、全局与单来源检索、类型过滤、refresh 保留全量扫描、
#       智能体引用、卸载清理资料文件、幂等卸载；可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

echo "══ T0 清基线 ══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
for s in get('/api/sources')['items']:
    if s['name'].startswith(('资料库','materials','资料 ')): dele('/api/sources/'+s['id'])
print('ok')
" ; chk "基线清理" $?

echo "══ T1 files 导入：函数与类都进资料库 ══"
$P -c "
import json,urllib.request
# 夹具客户端自带 HTTP 调用（否则 parseSDK 会拒绝），再拼上纯函数 / 类 / 类型定义验证资料抽取
ts=open('fixtures/archive/mini-sdk/src/client/order-client.ts').read() + '''
export class Retrier {
  // 指数退避重试，失败后自动等待再试
  async run(fn: () => Promise<any>, times = 3) { return fn() }
}
export function signPayload(body: string, secret: string): string {
  return body + secret
}
export interface PageResult<T> { items: T[]; next?: string }
'''
code={'files':[{'name':'util.ts','text':ts}],'mode':'sdk','name':'materials files'}
req=urllib.request.Request('$B/api/sources',data=json.dumps(code).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(req))
m=d.get('materials') or {}
assert m.get('count')>=4, m
assert m.get('classes')>=1 and m.get('functions')>=1, m
open('/tmp/mat-src1','w').write(d['source']['id'])
" ; chk "files 导入 → 资料 ≥4 条（类 + 函数）" $?

echo "══ T2 压缩包导入：全量扫描（含未挑中的 model 文件）══"
cd fixtures/archive && rm -f /tmp/mat-mini.zip && zip -qr /tmp/mat-mini.zip mini-sdk && cd ../..
$P -c "
import json,urllib.request,urllib.parse
raw=open('/tmp/mat-mini.zip','rb').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sdk/archive?name='+urllib.parse.quote('mat-mini.zip'),data=raw,headers={'content-type':'application/octet-stream'})))
assert r.get('materials') and r['materials']['count']>=3, r.get('materials')
req=urllib.request.Request('$B/api/sources',data=json.dumps({'mode':'archive','token':r['token'],'name':'资料库回归'}).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(req))
src=d['source']
assert (src.get('materials') or {}).get('count',0)>=3, src.get('materials')
open('/tmp/mat-src2','w').write(src['id'])
" ; chk "压缩包导入 → 来源带资料统计" $?

echo "══ T3 全局检索：中文 / 英文 / 来源过滤 ══"
$P -c "
import json,urllib.request,urllib.parse
def get(u): return json.load(urllib.request.urlopen('$B'+u))
r=get('/api/materials?q='+urllib.parse.quote('重试')+'&limit=10')
assert r['total']>=1, r['total']
hit=[i for i in r['items'] if 'Retrier' in (i['parent'] or '')+i['name']]
assert hit, [i['name'] for i in r['items'][:5]]
r2=get('/api/materials?q=signPayload&limit=5')
assert r2['total']>=1 and r2['items'][0]['name']=='signPayload', r2
sid=open('/tmp/mat-src2').read()
r3=get('/api/materials?sourceId='+sid+'&limit=5')
assert r3['total']>=3 and all(i['sourceId']==sid for i in r3['items']), r3['total']
" ; chk "中文「重试」/ 英文 signPayload / sourceId 过滤" $?

echo "══ T4 单来源检索 + 类型过滤 + 分页 ══"
$P -c "
import json,urllib.request,urllib.parse
sid=open('/tmp/mat-src1').read()
def get(u): return json.load(urllib.request.urlopen('$B'+u))
r=get('/api/sources/'+sid+'/materials?kind=function&limit=1')
assert r['total']>=1 and len(r['items'])==1 and r['items'][0]['kind']=='function', r
r2=get('/api/sources/'+sid+'/materials?limit=2&offset=1')
assert len(r2['items'])==2 and r2['offset']==1, r2
p=r2['items'][0].get('params')
assert isinstance(p,list), p
" ; chk "kind 过滤 / offset 分页 / 参数结构" $?

echo "══ T5 refresh：压缩包来源的全量资料不缩水 ══"
$P -c "
import json,urllib.request
sid=open('/tmp/mat-src2').read()
def get(u): return json.load(urllib.request.urlopen('$B'+u))
before=get('/api/sources/'+sid+'/materials')['stats']['count']
req=urllib.request.Request('$B/api/sources/'+sid+'/refresh',data=b'{}',headers={'content-type':'application/json'})
json.load(urllib.request.urlopen(req))
after=get('/api/sources/'+sid+'/materials')['stats']['count']
assert after>=before, (before, after)
" ; chk "重新解析后资料数不减少" $?

echo "══ T6 智能体引用（成功与失败路径都带资料）══"
$P -c "
import json,urllib.request
def draft(t):
    req=urllib.request.Request('$B/api/agent/draft',data=json.dumps({'text':t,'history':[]}).encode(),headers={'content-type':'application/json'})
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return json.load(e)
d=draft('订单流程：查询订单 o-1，创建支付 p-1')
assert isinstance(d.get('references'),list), d.get('references')
" ; chk "draft 返回 references 字段" $?

echo "══ T7 卸载清理 + 幂等卸载 ══"
$P -c "
import json,urllib.request,os
sid=open('/tmp/mat-src1').read()
def dele(u):
    req=urllib.request.Request('$B'+u,method='DELETE')
    return json.load(urllib.request.urlopen(req))
r=dele('/api/sources/'+sid)
assert r.get('ok'), r
assert not os.path.exists('data/materials/'+sid+'.json'), '资料文件应被删除'
r2=dele('/api/sources/'+sid)          # 再删一次：幂等，不再 404
assert r2.get('ok') and r2.get('alreadyGone'), r2
r3=dele('/api/sources/src_nonexist')
assert r3.get('alreadyGone'), r3
" ; chk "卸载删资料文件 / 重复卸载返回 alreadyGone" $?

echo "══ T8 清理 ══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
for s in get('/api/sources')['items']:
    if s['name'].startswith(('资料库','materials','资料 ')): dele('/api/sources/'+s['id'])
print('ok')
" ; chk "清理测试来源" $?

echo
echo "════════ 通过 $PASS / $((PASS+FAIL)) ════════"
[ $FAIL -eq 0 ]

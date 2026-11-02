#!/bin/bash
# ═══ pip 安装导入（真实 pip install → 扫描源码 → 接口清单）回归 ═══
# 覆盖：环境探测、包名校验/注入防护、无接口包报错、装包分析、两步导入（token 复用）、
#       重装同步幂等、指定版本重装、自动同步开关、卸载清理
# 运行前提：服务已启动（node server.js，端口 3300）；需要能访问 PyPI（或私有源）
# 可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi }

echo "══ T0 清基线（删 pip 测试来源 + 恢复隐藏接口）══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def post(u,d=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
def dele(u): return urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
post('/api/ops/restore',{})
for s in get('/api/sources')['items']:
    if s['name'].startswith('pip测试'): dele('/api/sources/'+s['id'])
print('ok')
" ; chk "基线清理" $?

echo "══ T1 环境探测 ══"
$P -c "
import json,urllib.request
e=json.load(urllib.request.urlopen('$B/api/sdk/pip/env'))
assert e['ok'] and e['pip'] and e['pythonVersion'], e
print('   pip',e['pip'],'/ python',e['pythonVersion'])
" ; chk "pip 环境可用" $?

echo "══ T2 包名校验与注入防护 ══"
$P -c "
import json,urllib.request,urllib.error
def analyze(d):
    r=urllib.request.Request('$B/api/sdk/pip/analyze',data=json.dumps(d).encode(),headers={'content-type':'application/json'})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as ex:
        return json.load(ex)
cases=[
    ({'package':''}, '请填写'),
    ({'package':'--rm -rf /'}, '不能以 - 开头'),
    ({'package':'pkg; rm -rf /'}, '非法字符'),
    ({'package':\"pkg\$(curl evil)\"}, '非法字符'),
    ({'package':'a\`id\`b'}, '非法字符'),
    ({'package':'pkg','indexUrl':'ftp://x'}, '私有源'),
    ({'package':'pkg','indexUrl':'http://x -o ProxyCommand=evil'}, '私有源'),
]
for d,kw in cases:
    e=analyze(d)
    assert 'error' in e and kw in e['error'], (d,e)
print('ok')
" ; chk "7 组非法输入全部 400 且提示可读" $?

echo "══ T3 纯工具库（无 HTTP 调用）→ 以资料形式可导入 ══"
$P -c "
import json,urllib.request
r=urllib.request.Request('$B/api/sdk/pip/analyze',data=json.dumps({'package':'six==1.16.0'}).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(r))
assert d.get('symbolOnly') is True, (d.get('count'), d.get('symbolOnly'))
assert (d.get('materials') or {}).get('count',0)>0, d
print('    six：0 个接口，资料', d['materials']['count'], '条')
" ; chk "six==1.16.0 → 0 接口但识别出函数/类资料" $?

echo "══ T4 不存在的包 ══"
$P -c "
import json,urllib.request,urllib.error
r=urllib.request.Request('$B/api/sdk/pip/analyze',data=json.dumps({'package':'no-such-sdk-xyz-999911'}).encode(),headers={'content-type':'application/json'})
try: json.load(urllib.request.urlopen(r)); raise SystemExit('should fail')
except urllib.error.HTTPError as ex:
    e=json.load(ex)
    assert '找不到' in e['error'], e
" ; chk "不存在的包 → 找不到提示" $?

echo "══ T5 装包分析：stripe==11.4.1 ══"
$P -c "
import json,urllib.request
r=urllib.request.Request('$B/api/sdk/pip/analyze',data=json.dumps({'package':'stripe==11.4.1'}).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(r))
assert d['pkg']['name']=='stripe' and d['pkg']['version']=='11.4.1', d['pkg']
assert d['pkg']['summary'], d['pkg']
assert d['count']>100, d['count']
assert d['baseUrl']=='https://api.stripe.com', d['baseUrl']
assert d['format']=='python' and d['formatName']=='Python', d['formatName']
assert d['stats']['selected']>=10 and d['stats']['selected']<=80, d['stats']
assert d['stats']['pyFiles']>100, d['stats']
assert d['token'].startswith('pip_'), d['token']
assert all(o['method'] in ('GET','POST','PUT','PATCH','DELETE') for o in d['operations'])
paths={(o['method'],o['path']) for o in d['operations']}
assert ('GET','/v1/charges') in paths, sorted(paths)[:5]
open('/tmp/pip-an','w').write(d['token'])
print('   ',d['count'],'个接口 /',d['stats']['selected'],'个文件 /',round(d['stats']['installMs']/1000,1),'s')
" ; chk "stripe 识别出 100+ 接口且服务地址正确" $?

echo "══ T6 两步导入：token 复用（不再装第二遍）══"
$P -c "
import json,urllib.request,time
token=open('/tmp/pip-an').read().strip()
t0=time.time()
r=urllib.request.Request('$B/api/sources',data=json.dumps({'mode':'pip','token':token,'name':'pip测试Stripe'}).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(r))
assert d['added']>100, d['added']
s=d['source']
assert s['type']=='sdk' and s['specVersion']=='11.4.1', (s['type'],s['specVersion'])
assert s['baseUrl']=='https://api.stripe.com', s['baseUrl']
assert s['sdk']['pip']['spec']=='stripe==11.4.1', s['sdk']['pip']
assert s['sdk']['pip']['pkg']['name']=='stripe', s['sdk']['pip']
assert s['sdk']['origin']=='pip', s['sdk']
open('/tmp/pip-src','w').write(s['id'])
print('   导入耗时',round(time.time()-t0,1),'s（应为解析耗时，不含安装）')
" ; chk "token 导入成功且元数据完整" $?

echo "══ T7 无 token 只有 package → 直接装包导入 ══"
$P -c "
import json,urllib.request,urllib.error
r=urllib.request.Request('$B/api/sources',data=json.dumps({'mode':'pip','package':'six==1.16.0','name':'pip测试无接口'}).encode(),headers={'content-type':'application/json'})
d=json.load(urllib.request.urlopen(r))
assert d['added']==0, d
assert (d.get('materials') or {}).get('count',0)>0, d
open('/tmp/pip-src2','w').write(d['source']['id'])
r=urllib.request.Request('$B/api/sources',data=json.dumps({'mode':'pip','token':'pip_expired','name':'x'}).encode(),headers={'content-type':'application/json'})
try: json.load(urllib.request.urlopen(r)); raise SystemExit('should fail')
except urllib.error.HTTPError as ex:
    e=json.load(ex); assert '过期' in e['error'], e
" ; chk "纯工具包以资料形式导入 / 过期 token 仍被拒" $?

echo "══ T8 重装同步幂等 + 指定版本重装 ══"
$P -c "
import json,urllib.request
def post(u,d=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
sid=open('/tmp/pip-src').read().strip()
d1=post('/api/sources/%s/refresh'%sid)
assert d1['added']==[] and d1['changed']==[] and d1['removed']==[], d1   # 同版本重装应无差异
d2=post('/api/sources/%s/refresh'%sid,{'spec':'stripe==11.4.0'})
assert d2['specVersion']=='11.4.0', d2['specVersion']
s=json.load(urllib.request.urlopen('$B/api/sources'))['items']
me=[x for x in s if x['id']==sid][0]
assert me['specVersion']=='11.4.0' and me['sdk']['pip']['spec']=='stripe==11.4.0', me
print('   11.4.0 差异 +%d ~%d -%d'%(len(d2['added']),len(d2['changed']),len(d2['removed'])))
" ; chk "同版本幂等 / 换版本重装生效" $?

echo "══ T9 自动同步开关（pip 来源允许）══"
$P -c "
import json,urllib.request
def post(u,d=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
sid=open('/tmp/pip-src').read().strip()
d=post('/api/sources/%s/autosync'%sid,{'enabled':True,'intervalMs':900000})
assert d['autoSync']['enabled'] and d['autoSync']['remote'].startswith('pip install'), d
d=post('/api/sources/%s/autosync'%sid,{'enabled':False})
assert not d['autoSync']['enabled'], d
" ; chk "pip 来源可开/关自动重新安装" $?

echo "══ T10 卸载清理 ══"
$P -c "
import json,urllib.request,os
def dele(u): return urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
sid=open('/tmp/pip-src').read().strip()
dele('/api/sources/'+sid)
sid2=open('/tmp/pip-src2').read().strip()
dele('/api/sources/'+sid2)
items=json.load(urllib.request.urlopen('$B/api/sources'))['items']
assert not [x for x in items if x['id'] in (sid,sid2)], items
assert not os.path.exists('data/sdk/'+sid), 'sdk 源码目录未清理'
print('ok')
" ; chk "来源删除且落盘源码一并清理（含资料导入来源）" $?

echo
echo "════════ pip 导入回归：$PASS 通过 / $FAIL 失败 ════════"
[ $FAIL -eq 0 ]

#!/bin/bash
# ═══ SDK 导入（自动分析接口）+ 现网自动更新 回归 ═══
# 覆盖：TS / Python / Java / Go / 配置 JSON 解析、多文件混合、URL 导入、
#       现网差异检测（新增/变更/移除）、自动同步调度、参数校验、卸载清理
# 运行前提：服务已启动（node server.js，端口 3300）；可重复执行，结束时自清理
B=http://127.0.0.1:3300
P=python3
PASS=0; FAIL=0
chk() { if [ $? -eq 0 ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

echo "══ T0 清基线（删测试来源 + 恢复隐藏接口）══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def post(u,d=None):
    r=urllib.request.Request('$B'+u,data=json.dumps(d or {}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
def dele(u): return urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
post('/api/ops/restore',{})
for s in get('/api/sources')['items']:
    if s['name'].startswith('SDK测试'): dele('/api/sources/'+s['id'])
print('ok')
" ; chk "基线清理" $?

echo "══ T1 TypeScript SDK：5 个接口 + 服务地址 / 版本识别 ══"
$P -c "
import json,urllib.request
text=open('fixtures/sdk/order-sdk.ts').read()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试TS','files':[{'name':'order-sdk.ts','text':text}]}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==5, r
assert r['sdk']['format']=='typescript', r['sdk']
assert r['source']['baseUrl']=='https://api.demo-shop.com/v1', r['source']['baseUrl']
paths={(o['method'],o['path']) for o in r['operations']}
assert ('GET','/orders/{orderNo}') in paths and ('PATCH','/orders/{orderNo}/cancel') in paths, paths
assert ('POST','/orders') in paths, paths
assert r['source']['sdk']['files'][0]['bytes']>0, r['source']['sdk']
open('/tmp/sdk-t1','w').write(r['source']['id'])
" ; chk "TS 解析出 5 个接口（含模板字符串 ${id} → {orderNo}）" $?

echo "══ T2 多文件混合（TS + Python）══"
$P -c "
import json,urllib.request
files=[{'name':'order-sdk.ts','text':open('fixtures/sdk/order-sdk.ts').read()},
       {'name':'order_sdk.py','text':open('fixtures/sdk/order_sdk.py').read()}]
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试混合','files':files}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==7, r['added']
assert r['sdk']['format']=='mixed' and r['sdk']['files']==2, r['sdk']
open('/tmp/sdk-t2','w').write(r['source']['id'])
" ; chk "同一来源合并多语言 SDK（7 个接口，去重后）" $?

echo "══ T3 Python SDK：f-string 路径 + 中文说明 ══"
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试PY','files':[{'name':'order_sdk.py','text':open('fixtures/sdk/order_sdk.py').read()}]}).encode(),
  headers={'content-type':'application/json'})))
sid=r['source']['id']
cat=json.load(urllib.request.urlopen('$B/api/catalog'))
ops=[o for o in cat['operations'] if o['sourceId']==sid]
paths={(o['method'],o['path']) for o in ops}
assert paths=={('GET','/orders/{order_no}'),('GET','/orders?date={date}&page={page}'),('POST','/orders/{order_no}/refund')}, paths
one=[o for o in ops if o['path']=='/orders/{order_no}'][0]
assert one['name']=='查询订单详情' and one['readOnly'] is True, one
ref=[o for o in ops if o['method']=='POST'][0]
assert ref['readOnly'] is False, ref
open('/tmp/sdk-t3','w').write(sid)
" ; chk "Python 解析（f\"…{order_no}\" → 路径参数）" $?

echo "══ T4 Java SDK：Retrofit 注解 ══"
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试JAVA','files':[{'name':'OrderApi.java','text':open('fixtures/sdk/OrderApi.java').read()}]}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==4, r['added']
sid=r['source']['id']
cat=json.load(urllib.request.urlopen('$B/api/catalog'))
ops=[o for o in cat['operations'] if o['sourceId']==sid]
paths={(o['method'],o['path']) for o in ops}
assert ('GET','/orders/{orderNo}') in paths and ('PATCH','/orders/{orderNo}/cancel') in paths, paths
assert [o for o in ops if o['path']=='/orders/{orderNo}'][0]['name']=='查询订单详情'
open('/tmp/sdk-t4','w').write(sid)
" ; chk "Java 解析出 4 个接口（@GET/@POST/@PATCH）" $?

echo "══ T5 Go SDK：路径拼接与 fmt.Sprintf ══"
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试GO','files':[{'name':'order_client.go','text':open('fixtures/sdk/order_client.go').read()}]}).encode(),
  headers={'content-type':'application/json'})))
paths={(o['method'],o['path']) for o in r['operations']}
assert r['added']==3, r['added']
assert ('GET','/orders/{orderNo}') in paths, paths
assert ('POST','/stock/{sku}/sync') in paths, paths          # fmt.Sprintf(\"/stock/%s/sync\", sku)
open('/tmp/sdk-t5','w').write(r['source']['id'])
" ; chk "Go 解析出 3 个接口（\"+var\" 与 %s 都归一化）" $?

echo "══ T6 配置 JSON：operations 清单 ══"
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试JSON','files':[{'name':'manifest.json','text':open('fixtures/sdk/manifest.json').read()}]}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==3, r['added']
assert r['source']['specVersion']=='1.4.0', r['source']['specVersion']
sid=r['source']['id']
cat=json.load(urllib.request.urlopen('$B/api/catalog'))
ops=[o for o in cat['operations'] if o['sourceId']==sid]
ref=[o for o in ops if o['path']=='/orders/{orderNo}/refund'][0]
assert ref['bodyExample']=={'amount':99,'reason':'商品破损'}, ref
assert ref['readOnly'] is False, ref
assert [o for o in ops if o['path']=='/orders/{orderNo}'][0]['readOnly'] is True
open('/tmp/sdk-t6','w').write(sid)
" ; chk "配置 JSON 直接导入（版本 / 请求体示例 / 读写标记）" $?

echo "══ T7 URL 导入 + 开启自动同步 ══"
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试URL','url':'$B/upstream/_specs/sdk/order_client.go',
                   'autoSync':{'enabled':True,'intervalMs':60000}}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==3, r['added']
s=r['source']
assert s['url'].endswith('order_client.go') and s['sdk']['manifestUrl']==s['url'], s
assert s['autoSync']['enabled'] is True and s['autoSync']['remote'], s['autoSync']
open('/tmp/sdk-t7','w').write(s['id'])
" ; chk "URL 导入并开启自动同步（记录远端地址）" $?

echo "══ T8 现网更新：重新同步后给出 新增 / 变更 / 移除 差异 ══"
cat > fixtures/sdk/tmp-live.ts <<'EOF'
export class LiveClient {
  /** 查询实时库存 */
  async getStock(sku: string) {
    return this.request('GET', `/stock/${sku}`);
  }
  /** 同步库存 */
  async syncStock(sku: string) {
    return this.request('POST', '/stock/sync');
  }
}
EOF
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试LIVE','url':'$B/upstream/_specs/sdk/tmp-live.ts'}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==2, r['added']
open('/tmp/sdk-t8','w').write(r['source']['id'])
" ; chk "接入可更新的示例 SDK（2 个接口）" $?
cat > fixtures/sdk/tmp-live.ts <<'EOF'
export class LiveClient {
  /** 查询实时库存（现网改为 v2 路径并带仓号） */
  async getStock(sku: string, warehouse: string) {
    return this.request('GET', `/v2/stock/${sku}?wh=${warehouse}`);
  }
  /** 同步库存 */
  async syncStock(sku: string) {
    return this.request('POST', '/stock/sync');
  }
  /** 释放库存占用 */
  async releaseStock(sku: string) {
    return this.request('DELETE', `/stock/${sku}/reserve`);
  }
}
EOF
SID=$(cat /tmp/sdk-t8)
$P -c "
import json,urllib.request
sid=open('/tmp/sdk-t8').read().strip()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources/'+sid+'/refresh',data=b'{}',headers={'content-type':'application/json'})))
assert r['changed']==['getStock'], r
assert r['added']==['releaseStock'], r
assert r['removed']==[], r
" ; chk "现网更新被识别（getStock 变更 + releaseStock 新增）" $?
cat > fixtures/sdk/tmp-live.ts <<'EOF'
export class LiveClient {
  /** 查询实时库存 */
  async getStock(sku: string) {
    return this.request('GET', `/stock/${sku}`);
  }
  /** 同步库存 */
  async syncStock(sku: string) {
    return this.request('POST', '/stock/sync');
  }
}
EOF
curl -s -X POST "$B/api/sources/$SID/refresh" > /dev/null

echo "══ T9 自动同步调度：到点自动重新解析并记录状态（约 17s）══"
# 独立来源：T7 来源经 T8 手动 refresh 后 lastAt 已回写（60s 内不再 due，调度语义），
# 自动同步的首跑必须用一块「从未手动刷新过」的干净来源验证
$P -c "
import json,urllib.request
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources',
  data=json.dumps({'mode':'sdk','name':'SDK测试AUTO','url':'$B/upstream/_specs/sdk/tmp-live.ts',
                   'autoSync':{'enabled':True,'intervalMs':60000}}).encode(),
  headers={'content-type':'application/json'})))
assert r['added']==2, r['added']
open('/tmp/sdk-t9','w').write(r['source']['id'])
open('/tmp/sdk-sync-at','w').write('0')
" ; chk "独立来源开启自动同步" $?
sleep 17
$P -c "
import json,urllib.request,time
sid=open('/tmp/sdk-t9').read().strip()
s=[x for x in json.load(urllib.request.urlopen('$B/api/sources'))['items'] if x['id']==sid][0]
a=s['autoSync']
assert a['lastAt'] and a['lastAt']>0, a
assert a['lastStatus']=='ok', a
assert a['lastDiff'] is not None, a
" ; chk "调度器自动执行并回写 lastAt / lastStatus / lastDiff" $?
$P -c "
import json,urllib.request
sid=open('/tmp/sdk-t7').read().strip()
r=json.load(urllib.request.urlopen(urllib.request.Request('$B/api/sources/'+sid+'/autosync',
  data=json.dumps({'enabled':False}).encode(),headers={'content-type':'application/json'})))
assert r['autoSync']['enabled'] is False, r
" ; chk "关闭自动同步" $?

echo "══ T10 参数校验 ══"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","files":[]}')
[ "$CODE" = "400" ]; chk "没有文件 / 地址 / 代码 → 400（实际 ${CODE}）" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","text":"Hello world, nothing to see here at all.","filename":"x.ts"}')
[ "$CODE" = "400" ]; chk "无接口且无符号 → 400（实际 ${CODE}）" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","text":"const x = 1;","filename":"x.ts"}')
[ "$CODE" = "400" ]; chk "仅一个常量、无类无函数 → 400（实际 ${CODE}）" $?
# 基础库语义：没有业务接口但有类/函数 → 允许「仅资料导入」（200，added=0）
R=$(curl -s -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","text":"class ApiClient { connect() { return 42 } }","filename":"c.ts"}')
echo "$R" | python3 -c "
import sys,json
r=json.load(sys.stdin)
assert r['added']==0, r.get('added')
assert (r.get('materials') or {}).get('count',0)>=1, r.get('materials')
print('    仅资料：', r['materials']['count'], '条')
" ; chk "有类无接口 → 以资料形式导入" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","text":"class A{ f(){ return this.request(\"GET\", \"/x\") } }","filename":"a.ts","autoSync":{"enabled":true}}')
[ "$CODE" = "400" ]; chk "本地上传却要自动同步 → 400（没有远端地址）" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sources -H 'content-type: application/json' -d '{"mode":"sdk","text":"{\"paths\":{\"/x\":{\"get\":{}}}}","filename":"openapi.json"}')
[ "$CODE" = "400" ]; chk "OpenAPI 文档误走 SDK 导入 → 400 并提示换入口（实际 ${CODE}）" $?

echo "══ T11 卸载来源 → 落盘 SDK 一并清理 ══"
$P -c "
import json,os,urllib.request
sid=open('/tmp/sdk-t1').read().strip()
assert os.path.isdir('data/sdk/'+sid), '导入后应落盘 SDK 源码'
urllib.request.urlopen(urllib.request.Request('$B/api/sources/'+sid,method='DELETE')).read()
assert not os.path.isdir('data/sdk/'+sid), '卸载后应清理源码目录'
cats=json.load(urllib.request.urlopen('$B/api/catalog'))['operations']
assert not [o for o in cats if o['sourceId']==sid]
" ; chk "卸载后源码目录与注册表接口都清空" $?

echo "══ T12 收尾清理 ══"
$P -c "
import json,urllib.request
def get(u): return json.load(urllib.request.urlopen('$B'+u))
def dele(u): urllib.request.urlopen(urllib.request.Request('$B'+u,method='DELETE')).read()
for s in get('/api/sources')['items']:
    if s['name'].startswith('SDK测试'): dele('/api/sources/'+s['id'])
assert not [s for s in get('/api/sources')['items'] if s['name'].startswith('SDK测试')]
" ; chk "测试来源清理完成" $?
rm -f fixtures/sdk/tmp-live.ts

echo
echo "═══════ SDK 导入回归结果：通过 $PASS / 失败 $FAIL ═══════"
[ $FAIL -eq 0 ] || exit 1

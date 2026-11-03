// ── 断言检查：调试 / 运行期对 HTTP 节点输出做确定性校验（无 LLM）──
// assert 形态（存于节点 node.assert）：
//   { ok: true }                    —— 要求 2xx 状态码
//   { status: [200, 201] }          —— 要求状态码在列表内
//   { outputHas: ['score','status'] } —— 输出（对象）必须包含这些顶层字段
//   { expr: 'qty > 0' }             —— 断言表达式（以上游输出字段为左值，复用条件表达式求值器）

// 返回失败原因数组；空数组 = 全部通过。evalExpr 延迟 require 避免与 engine 循环依赖
function checkAssert(assert, output, httpStatus) {
  const fails = [];
  if (!assert || typeof assert !== 'object') return fails;
  if (assert.ok === true) {
    const s = Number(httpStatus);
    if (!(s >= 200 && s < 300)) fails.push(`期望 2xx 状态码，实际 ${httpStatus ?? '无'}`);
  }
  if (Array.isArray(assert.status) && assert.status.length) {
    if (!assert.status.map(Number).includes(Number(httpStatus))) {
      fails.push(`期望状态码 ${assert.status.join('/')}，实际 ${httpStatus ?? '无'}`);
    }
  }
  if (Array.isArray(assert.outputHas) && assert.outputHas.length) {
    for (const f of assert.outputHas) {
      if (output == null || typeof output !== 'object' || !(f in output)) fails.push(`输出缺少字段 ${f}`);
    }
  }
  if (assert.expr) {
    const scope = { ...(typeof output === 'object' && output ? output : {}), output };
    let err = null, result = false;
    try { result = require('./engine').evalExpr(assert.expr, scope); } catch (e) { err = e; }
    if (err) fails.push(`断言表达式错误：${err.message}`);
    else if (!result) fails.push(`断言表达式不成立：${assert.expr}`);
  }
  return fails;
}

// 结束断言（def.end.assert）：整个流程跑完后统一校验，作用域为整条流程
//   { expr: 'nodes.x.output.total >= 1' } 或 { expr: ['a >= 1', 'b != null'] }
// 任一表达式报错或不成立即失败。evalExpr 延迟 require 避免与 engine 循环依赖
function checkEndAssert(assert, scope) {
  const fails = [];
  if (!assert || typeof assert !== 'object') return fails;
  const exprs = Array.isArray(assert.expr) ? assert.expr : (assert.expr ? [assert.expr] : []);
  for (const ex of exprs) {
    let err = null, result = false;
    try { result = require('./engine').evalExpr(ex, scope); } catch (e) { err = e; }
    if (err) fails.push(`表达式「${ex}」错误：${err.message}`);
    else if (!result) fails.push(`表达式不成立：${ex}`);
  }
  return fails;
}

module.exports = { checkAssert, checkEndAssert };

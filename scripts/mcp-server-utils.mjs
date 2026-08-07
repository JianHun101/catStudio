/**
 * mcp-server.mjs 纯函数工具层（无 shebang、无副作用——供 vitest 单测直接
 * import）。参数校验抽离原因：mcp-server.mjs 带 shebang（#!/usr/bin/env
 * node），vitest 模块执行器把带 shebang 的代码作为函数体执行时报
 * "Invalid or unexpected token"——测试 import 本文件即可，工具面本体保持
 * spike 留档模式（不做 spawn 子进程级测试）。
 */

/**
 * search_knowledge 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：query 非空字符串、topK 可选 1-10 整数（默认 3）。
 * 返回 { ok: true, query, topK } 或 { ok: false, reason }（reason 回模型可纠正）。
 */
export function validateSearchParams(args) {
  const query = args?.query
  if (typeof query !== 'string' || !query.trim()) {
    return {
      ok: false,
      reason: `search_knowledge 参数无效: query 必须是非空字符串（当前: ${JSON.stringify(query)}）`,
    }
  }
  const topK = args?.topK ?? 3
  if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 10) {
    return {
      ok: false,
      reason: `search_knowledge 参数无效: topK 必须是 1-10 整数（当前: ${JSON.stringify(topK)}）`,
    }
  }
  return { ok: true, query: query.trim(), topK }
}

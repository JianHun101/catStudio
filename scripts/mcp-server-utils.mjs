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

/**
 * query_db 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：table ∈ 白名单、conditions 可选数组（每项 { column: 非空字符串,
 * op: =/>/</LIKE, value: 字符串 }）、limit 可选 1-100 整数（默认 50）。
 * 列名白名单由服务端 QUERY_TABLE_SCHEMAS 权威校验（400 层）——本层只校形状，
 * 避免 JS/TS 两侧白名单双份漂移。
 * 返回 { ok: true, table, conditions, limit } 或 { ok: false, reason }。
 */
export const QUERY_DB_TABLES = [
  'messages',
  'memories',
  'execution_logs',
  'sessions',
  'agents',
  'knowledge',
]
const QUERY_DB_OPS = ['=', '>', '<', 'LIKE']

export function validateQueryDbParams(args) {
  const table = args?.table
  if (typeof table !== 'string' || !QUERY_DB_TABLES.includes(table)) {
    return {
      ok: false,
      reason: `query_db 参数无效: table 必须是白名单表之一（${QUERY_DB_TABLES.join('/')}；当前: ${JSON.stringify(table)}）`,
    }
  }
  const limit = args?.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return {
      ok: false,
      reason: `query_db 参数无效: limit 必须是 1-100 整数（当前: ${JSON.stringify(limit)}）`,
    }
  }
  const conditions = args?.conditions ?? []
  if (!Array.isArray(conditions)) {
    return {
      ok: false,
      reason: `query_db 参数无效: conditions 必须是数组（当前: ${JSON.stringify(conditions)}）`,
    }
  }
  for (const c of conditions) {
    if (
      typeof c !== 'object' ||
      c === null ||
      typeof c.column !== 'string' ||
      !c.column.trim() ||
      typeof c.op !== 'string' ||
      !QUERY_DB_OPS.includes(c.op) ||
      typeof c.value !== 'string'
    ) {
      return {
        ok: false,
        reason: `query_db 参数无效: conditions 每项须 { column: 非空字符串, op: ${QUERY_DB_OPS.join('/')}, value: 字符串 }（当前: ${JSON.stringify(c)}）`,
      }
    }
  }
  return { ok: true, table, conditions, limit }
}

/**
 * request_user_action 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：type ∈ {restart, push, choice}（枚举就绪——choice 服务端当前 400「暂不支持」，
 * 渲染留第二步，管道先通；push 为 push 审批，仅店长可发）、reason 必填非空字符串、
 * options 可选数组（每项 { id: 非空字符串, label: 非空字符串 }，choice 用，restart/push 忽略）。
 * 服务端角色白名单与 type 支持面由 internal.ts 权威校验（400/403 层）——
 * 本层只校形状，与 validateQueryDbParams 同款分层。
 * 返回 { ok: true, type, reason, options } 或 { ok: false, reason }。
 */
export const USER_REQUEST_TYPES = ['restart', 'push', 'choice']

export function validateUserRequestParams(args) {
  const type = args?.type
  if (typeof type !== 'string' || !USER_REQUEST_TYPES.includes(type)) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: type 必须是 ${USER_REQUEST_TYPES.join('/')} 之一（当前: ${JSON.stringify(type)}）`,
    }
  }
  const reason = args?.reason
  if (typeof reason !== 'string' || !reason.trim()) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: reason 必须是非空字符串（当前: ${JSON.stringify(reason)}）`,
    }
  }
  const options = args?.options ?? []
  if (!Array.isArray(options)) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: options 必须是数组（当前: ${JSON.stringify(options)}）`,
    }
  }
  for (const o of options) {
    if (
      typeof o !== 'object' ||
      o === null ||
      typeof o.id !== 'string' ||
      !o.id.trim() ||
      typeof o.label !== 'string' ||
      !o.label.trim()
    ) {
      return {
        ok: false,
        reason: `request_user_action 参数无效: options 每项须 { id: 非空字符串, label: 非空字符串 }（当前: ${JSON.stringify(o)}）`,
      }
    }
  }
  return { ok: true, type, reason: reason.trim(), options }
}

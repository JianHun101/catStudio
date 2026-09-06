#!/usr/bin/env node
/**
 * MCP 结构化路由 server（Phase 1 产物，知识库 Phase 1 扩展 search_knowledge）
 *
 * 原生 JSON-RPC 2.0 stdio 实现 MCP 最小子集（零依赖，Phase 0 spike 已验证协议层）：
 *   - initialize        → 协议握手
 *   - tools/list        → 暴露 MCP_TOOLS（工具定义在 mcp-server-utils.mjs：post_message / search_knowledge / query_db / query_session_messages / list_session_members / request_user_action / create_pr）
 *   - tools/call        → 参数校验 → POST 内部端点 → ACK / 错误文本（含 reason）
 *   - ping / 其他       → 空 result / method not found
 *   - notifications（无 id 消息）→ 不回复
 *
 * post_message 是 A2A 路由的结构化通道：模型把「投递下一棒」的意图
 * （目标猫名列表）通过工具调用声明，而非依赖文本行首 @（软约束，格式
 * 漂移导致静默丢单——ds@ 嵌句实锤）。本 server 由 claude.ts spawn 拉起，
 * 会话上下文（sessionId/agentId/msgId）与凭证从环境变量读取（buildEnv
 * 透传，见 packages/server/src/llm/claude.ts）：
 *   CATSTUDY_SESSION_ID / CATSTUDY_AGENT_ID / CATSTUDY_MSG_ID — 信号三要素
 *   CATSTUDY_SERVER_URL — 内部端点基址（如 http://127.0.0.1:3200）
 *   CATSTUDY_SIGNAL_TOKEN — 每 spawn 随机生成的信号 token（x-signal-token 头）
 *   CATSTUDY_TRIGGER_AUTHOR_NAME — 可选：本次触发消息作者名（OQ③ 补丁——
 *     内部端点预校验支持 reviewer @ 回请求人；缺失则 body 不带该字段）
 *
 * search_knowledge 是知识库检索的结构化通道（知识库 Phase 1）：语义检索
 * 工具（非 raw SQL——raw SQL 会把 messages/memories/execution_logs 全表
 * 暴露给模型，越权面过大），服务端只拼参数化 embedding 检索 SQL，
 * 模型不可注入。
 *
 * query_db 是白名单表查询通道（query_db Phase 1）：排障取证的窄通道——
 * 表名/列名双白名单（服务端 QUERY_TABLE_SCHEMAS 权威校验）+ value 参数化，
 * 敏感列（agents.llm_api_key 等、embedding BLOB）硬剔除，模型不可注入。
 *
 * 用法：node scripts/mcp-server.mjs（由 Claude Code CLI 作为 MCP server 拉起）。
 * 参数校验纯函数在 mcp-server-utils.mjs（无 shebang，供 vitest 直接 import——
 * 本文件带 shebang，vitest 模块执行器把 shebang 当非法 token）；stdio server
 * 启动仍在「直接运行」guard 内——防御性：任何 import 场景都不挂 stdin。
 */

import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  validateSearchParams,
  validateQueryDbParams,
  validateUserRequestParams,
  validateCreatePrParams,
  validateQuerySessionMessagesParams,
} from './mcp-server-utils.mjs'
import {
  TOOL_NAME,
  SEARCH_TOOL_NAME,
  QUERY_DB_TOOL_NAME,
  QUERY_SESSION_MESSAGES_TOOL_NAME,
  LIST_SESSION_MEMBERS_TOOL_NAME,
  REQUEST_USER_ACTION_TOOL_NAME,
  CREATE_PR_TOOL_NAME,
  MCP_TOOLS,
} from './mcp-server-utils.mjs'

const SERVER_INFO = { name: 'catstudy', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'

/** 向 stdout 写一条 JSON-RPC 消息（每行一个 JSON） */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/** 返回 JSON-RPC 错误对象 */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** 环境变量读取（缺失返回 null——调用时给出明确错误文本） */
function env(name) {
  return process.env[name] || null
}

/**
 * 调用猫咖内部端点 POST /api/internal/route-signals。
 * 成功（2xx）→ { ok: true, reason? }；失败 → { ok: false, reason }（含 HTTP 状态/响应 reason）。
 */
async function postRouteSignal(targetCats, clientMessageId) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')
  const triggerAuthorNameValue = env('CATSTUDY_TRIGGER_AUTHOR_NAME')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），路由信号未投递` }
  }

  // triggerAuthorName 可选（OQ③ 补丁）：有值才带 body 字段——内部端点
  // 预校验 filterAllowedMentions 用它支持 reviewer @ 回请求人
  const payload = { sessionId, agentId, msgId, targetCats, clientMessageId }
  if (triggerAuthorNameValue) payload.triggerAuthorName = triggerAuthorNameValue

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/route-signals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok) return { ok: true, reason: body?.reason }
  return {
    ok: false,
    reason: body?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/knowledge-search。
 * 成功（2xx）→ { ok: true, text }（检索结果 JSON 或「无命中」）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason）。
 * 环境变量缺失检查与 postRouteSignal 同款（同一内部端点鉴权链）。
 */
async function searchKnowledge(query, topK) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），知识库检索不可用` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/knowledge-search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId, query, topK }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok) {
    const results = body?.results ?? []
    return {
      ok: true,
      text:
        results.length > 0
          ? JSON.stringify(results, null, 2)
          : '（无命中）知识库暂无与该 query 相关的条目',
    }
  }
  return {
    ok: false,
    reason: body?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/db-query。
 * 成功（2xx）→ { ok: true, text }（rows JSON + total 概览）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason）。
 * 环境变量缺失检查与 searchKnowledge 同款（同一内部端点鉴权链）。
 */
async function queryDb(table, conditions, limit) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），数据库查询不可用` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/db-query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId, table, conditions, limit }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok) {
    const rows = body?.rows ?? []
    const total = body?.total ?? 0
    return {
      ok: true,
      text:
        rows.length > 0
          ? `table「${table}」共 ${total} 条匹配（返回前 ${rows.length} 条）：\n` +
            JSON.stringify(rows, null, 2)
          : `（无命中）table「${table}」无匹配行`,
    }
  }
  return {
    ok: false,
    reason: body?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/user-request。
 * 成功（2xx）→ { ok: true, reason? }（reason 为服务端回执说明）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason——403 角色白名单/
 * 400 类型不支持等错误文本直接回模型可诊断）。
 * 环境变量缺失检查与 queryDb 同款（同一内部端点鉴权链）。
 */
async function callUserRequest(type, reason, options) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），用户请求未投递` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/user-request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId, type, reason, options }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok) return { ok: true, reason: body?.reason }
  return {
    ok: false,
    reason: body?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/create-pr。
 * 成功（2xx）→ { ok: true, number, url }（number/url 透传服务端 createPr 结果）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason——403 角色白名单 /
 * 422 业务失败（not-authed/branch-not-pushed 等）错误文本直接回模型可诊断）。
 * 环境变量缺失检查与 callUserRequest 同款（同一内部端点鉴权链）。
 */
async function callCreatePr(base, head, title, body) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），创建 PR 不可用` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/create-pr`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId, base, head, title, body }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let resBody = null
  try {
    resBody = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok && resBody?.ok) {
    return { ok: true, number: resBody.number, url: resBody.url }
  }
  return {
    ok: false,
    reason: resBody?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/session-messages（B agent 会话回读）。
 * 成功（2xx）→ { ok: true, text }（messages JSON + total 概览）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason）。
 * 环境变量缺失检查与 callCreatePr 同款（同一内部端点鉴权链）。
 * params 已由 validateQuerySessionMessagesParams 归一：limit 必有，before/from/to/
 * kinds/agentIdFilter 缺省 undefined（JSON.stringify 省略 → 服务端走默认）。
 */
async function querySessionMessages(params) {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），会话回读不可用` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/session-messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({
        sessionId,
        agentId,
        msgId,
        limit: params.limit,
        before: params.before,
        from: params.from,
        to: params.to,
        kinds: params.kinds,
        agentIdFilter: params.agentIdFilter,
      }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let resBody = null
  try {
    resBody = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok && resBody?.ok) {
    const messages = resBody.messages ?? []
    const total = resBody.total ?? 0
    return {
      ok: true,
      text:
        messages.length > 0
          ? `会话回读共 ${total} 条消息（limit ${params.limit}，新→旧）：\n` +
            JSON.stringify(messages, null, 2)
          : `（空）会话无可回读消息（limit ${params.limit}）`,
    }
  }
  return {
    ok: false,
    reason: resBody?.reason || `内部端点 HTTP ${res.status}`,
  }
}

/**
 * 调用猫咖内部端点 POST /api/internal/session-members（list_session_members 工具——
 * 会话成员带 role 查询）。本工具无参数——session/agent/msg 三要素全部由 env 注入，
 * 直接 POST 即可。返回 members（agentId/name/role，session 注册序；悬空 agent
 * name/role null 由服务端补齐）。
 * 成功（2xx）→ { ok: true, text }（members JSON 概览）；
 * 失败 → { ok: false, reason }（含 HTTP 状态/响应 reason）。
 */
async function listSessionMembers() {
  const baseUrl = env('CATSTUDY_SERVER_URL')
  const token = env('CATSTUDY_SIGNAL_TOKEN')
  const sessionId = env('CATSTUDY_SESSION_ID')
  const agentId = env('CATSTUDY_AGENT_ID')
  const msgId = env('CATSTUDY_MSG_ID')

  if (!baseUrl || !token || !sessionId || !agentId || !msgId) {
    const missing = [
      ['CATSTUDY_SERVER_URL', baseUrl],
      ['CATSTUDY_SIGNAL_TOKEN', token],
      ['CATSTUDY_SESSION_ID', sessionId],
      ['CATSTUDY_AGENT_ID', agentId],
      ['CATSTUDY_MSG_ID', msgId],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n)
    return { ok: false, reason: `MCP 环境缺失（${missing.join('/')}），会话成员查询不可用` }
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/session-members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId }),
    })
  } catch (err) {
    return { ok: false, reason: `内部端点不可达: ${err.message}` }
  }

  let resBody = null
  try {
    resBody = await res.json()
  } catch {
    /* 非 JSON 响应体 */
  }

  if (res.ok && resBody?.ok) {
    const members = resBody.members ?? []
    return {
      ok: true,
      text:
        members.length > 0
          ? `会话成员共 ${members.length} 位（注册序）：\n` + JSON.stringify(members, null, 2)
          : '（空）会话无成员',
    }
  }
  return {
    ok: false,
    reason: resBody?.reason || `内部端点 HTTP ${res.status}`,
  }
}

// 直接运行时才启动 stdio server——vitest import 本模块（validateSearchParams
// 单测）不挂 stdin listener（resolve 兼容相对路径调用 node scripts/mcp-server.mjs）
const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', async (line) => {
    if (!line.trim()) return

    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // 无法解析的行直接忽略
    }

    const { id, method, params } = msg

    // ─── 握手：initialize ───
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      })
      return
    }

    // ─── 通知（notifications/initialized、logging 等）：无 id，不回复 ───
    if (id === undefined) return

    // ─── ping ───
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }

    // ─── 工具面 ───
    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      })
      return
    }

    if (method === 'tools/call') {
      const name = params?.name
      if (name === TOOL_NAME) {
        const args = params?.arguments ?? {}
        const targetCats = args.targetCats
        const clientMessageId = args.clientMessageId

        // 参数校验：targetCats 必须是非空字符串数组（元素非空、去重保序）
        if (
          !Array.isArray(targetCats) ||
          targetCats.length === 0 ||
          !targetCats.every((c) => typeof c === 'string' && c.trim().length > 0)
        ) {
          send(
            rpcError(
              id,
              -32602,
              `post_message 参数无效: targetCats 必须是非空字符串数组（当前: ${JSON.stringify(targetCats)}）`
            )
          )
          return
        }
        if (clientMessageId !== undefined && typeof clientMessageId !== 'string') {
          send(rpcError(id, -32602, 'post_message 参数无效: clientMessageId 必须是字符串'))
          return
        }

        const unique = [...new Set(targetCats.map((c) => c.trim()))]
        const result = await postRouteSignal(unique, clientMessageId)

        if (result.ok) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `✅ 路由信号已投递：${unique.join('、')}${
                    result.reason ? `（${result.reason}）` : ''
                  }`,
                },
              ],
              isError: false,
            },
          })
        } else {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `❌ 路由信号投递失败：${result.reason}。请改用文本行首 @ 投递下一棒。`,
                },
              ],
              isError: true,
            },
          })
        }
        return
      }
      if (name === SEARCH_TOOL_NAME) {
        const args = params?.arguments ?? {}
        const parsed = validateSearchParams(args)
        if (!parsed.ok) {
          send(rpcError(id, -32602, parsed.reason))
          return
        }
        const result = await searchKnowledge(parsed.query, parsed.topK)
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok ? result.text : `❌ 知识库检索失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      if (name === QUERY_DB_TOOL_NAME) {
        const args = params?.arguments ?? {}
        const parsed = validateQueryDbParams(args)
        if (!parsed.ok) {
          send(rpcError(id, -32602, parsed.reason))
          return
        }
        const result = await queryDb(parsed.table, parsed.conditions, parsed.limit)
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok ? result.text : `❌ 数据库查询失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      if (name === REQUEST_USER_ACTION_TOOL_NAME) {
        const args = params?.arguments ?? {}
        const parsed = validateUserRequestParams(args)
        if (!parsed.ok) {
          send(rpcError(id, -32602, parsed.reason))
          return
        }
        const result = await callUserRequest(parsed.type, parsed.reason, parsed.options)
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok
                  ? `✅ 用户请求已投递：${parsed.type}（${result.reason ?? '已入队'}）`
                  : `❌ 用户请求投递失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      if (name === CREATE_PR_TOOL_NAME) {
        const args = params?.arguments ?? {}
        const parsed = validateCreatePrParams(args)
        if (!parsed.ok) {
          send(rpcError(id, -32602, parsed.reason))
          return
        }
        const result = await callCreatePr(parsed.base, parsed.head, parsed.title, parsed.body)
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok
                  ? `✅ PR 已创建：#${result.number} ${result.url}`
                  : `❌ PR 创建失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      if (name === QUERY_SESSION_MESSAGES_TOOL_NAME) {
        const args = params?.arguments ?? {}
        const parsed = validateQuerySessionMessagesParams(args)
        if (!parsed.ok) {
          send(rpcError(id, -32602, parsed.reason))
          return
        }
        const result = await querySessionMessages(parsed)
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok ? result.text : `❌ 会话回读失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      if (name === LIST_SESSION_MEMBERS_TOOL_NAME) {
        // 无参数工具——listSessionMembers 直接读 env 三要素 POST 内部端点
        const result = await listSessionMembers()
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: result.ok ? result.text : `❌ 会话成员查询失败：${result.reason}`,
              },
            ],
            isError: !result.ok,
          },
        })
        return
      }
      send(
        rpcError(
          id,
          -32602,
          `unknown tool: ${name}（本 server 仅有 post_message、search_knowledge、query_db、query_session_messages、list_session_members、request_user_action 和 create_pr 七个工具）`
        )
      )
      return
    }

    // ─── 其他方法 ───
    send(rpcError(id, -32601, `Method not found: ${method}`))
  })
}

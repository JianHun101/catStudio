#!/usr/bin/env node
/**
 * MCP 结构化路由 server（Phase 1 产物，知识库 Phase 1 扩展 search_knowledge）
 *
 * 原生 JSON-RPC 2.0 stdio 实现 MCP 最小子集（零依赖，Phase 0 spike 已验证协议层）：
 *   - initialize        → 协议握手
 *   - tools/list        → 暴露 post_message + search_knowledge + query_db + request_user_action
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
} from './mcp-server-utils.mjs'

const SERVER_INFO = { name: 'catstudy', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'
const TOOL_NAME = 'post_message'
const SEARCH_TOOL_NAME = 'search_knowledge'
const QUERY_DB_TOOL_NAME = 'query_db'
const REQUEST_USER_ACTION_TOOL_NAME = 'request_user_action'

/** 工具定义——inputSchema 钉死契约：targetCats 必填数组、clientMessageId 可选 */
const POST_MESSAGE_TOOL = {
  name: TOOL_NAME,
  description:
    '把消息投递给猫咖的下一棒 Agent（结构化路由，替代文本行首 @）。' +
    'targetCats 传目标猫的完整名字（如「店长」「吐槽猫」），一次可投多个；' +
    '调用成功后猫咖服务端会把路由信号合并进当前回复的 mentions 并触发派发。' +
    '注意：仅用于「真的要把下一棒叫起来干活」时；叙述性提及猫名不要用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      targetCats: {
        type: 'array',
        items: { type: 'string' },
        description: '目标猫名数组（会话内已注册的猫名，非空字符串）',
      },
      clientMessageId: {
        type: 'string',
        description: '可选：客户端消息 id（幂等/追踪用）',
      },
    },
    required: ['targetCats'],
  },
}

/** 工具定义——inputSchema 钉死契约：table 必填、conditions 可选、limit 可选 1-100 默认 50 */
const QUERY_DB_TOOL = {
  name: QUERY_DB_TOOL_NAME,
  description:
    '查询猫咖数据库表（排障取证通道，替代 raw SQL——表/列白名单服务端强制）。' +
    'table 传白名单表（messages/memories/execution_logs/sessions/agents/knowledge）；' +
    'conditions 为结构化过滤条件（多条件 AND 连接，op 支持 =/>/</LIKE，LIKE 的 % 请自己写在 value 里）；' +
    'limit 1-100 默认 50。安全边界：仅可查白名单列（agents 不含密钥列，memories/knowledge 不含 embedding），' +
    '返回 snake_case 原样。查最近消息直接 {table:"messages"} 即可（created_at DESC）。',
  inputSchema: {
    type: 'object',
    properties: {
      table: {
        type: 'string',
        enum: ['messages', 'memories', 'execution_logs', 'sessions', 'agents', 'knowledge'],
        description: '白名单表名',
      },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: '该表可查列名（服务端白名单校验）' },
            op: { type: 'string', enum: ['=', '>', '<', 'LIKE'] },
            value: { type: 'string' },
          },
          required: ['column', 'op', 'value'],
        },
        description: '可选：结构化过滤条件（AND 连接）',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: '返回条数 1-100，默认 50',
      },
    },
    required: ['table'],
  },
}

/**
 * 工具定义——inputSchema 钉死契约：type 枚举（restart/push/choice）、reason 必填、
 * options 可选（choice 用选项组，restart/push 忽略）。
 */
const REQUEST_USER_ACTION_TOOL = {
  name: REQUEST_USER_ACTION_TOOL_NAME,
  description:
    '把「需要用户介入」的请求结构化投递给用户（稳定触发通道，替代文本格式匹配——' +
    '文本格式依赖 LLM 精确输出、格式漂移导致按钮不出现的历史事故已堆四层容错）。' +
    'type 传请求类型：restart（申请重启 server——仅店长角色可发，需用户批准后执行）；' +
    'push（申请 push 审批——仅店长角色可发，收口做完本地步骤后发起，用户批准才 push）；' +
    'choice（选项选择，渲染待后续版本，服务端当前返回暂不支持）。' +
    'reason 必填，写明请求原因（写请求文件/前端按钮展示用）。' +
    '注意：仅用于「真的需要用户操作」时；叙述性提及重启/推送不要用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['restart', 'push', 'choice'],
        description: '请求类型（restart/push 已落地；choice 渲染待后续版本，服务端当前暂不支持）',
      },
      reason: {
        type: 'string',
        description: '请求原因（必填，非空）',
      },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '选项 id（回灌用）' },
            label: { type: 'string', description: '选项展示文本' },
          },
          required: ['id', 'label'],
        },
        description: '可选：选项组（choice 用，restart/push 忽略）',
      },
    },
    required: ['type', 'reason'],
  },
}

/** 工具定义——inputSchema 钉死契约：query 必填、topK 可选 1-10 默认 3 */
const SEARCH_KNOWLEDGE_TOOL = {
  name: SEARCH_TOOL_NAME,
  description:
    '检索猫咖知识库（运营方维护的标准数据：项目接入文档/领域标准/工作规范等）。' +
    'query 传检索意图（如「提交规范」），topK 可选 1-10 默认 3；' +
    '返回命中的知识条目 JSON（含 content/source/distance），无命中返回空数组。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索意图（非空字符串）',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: '返回条数 1-10，默认 3',
      },
    },
    required: ['query'],
  },
}

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
          tools: [
            POST_MESSAGE_TOOL,
            SEARCH_KNOWLEDGE_TOOL,
            QUERY_DB_TOOL,
            REQUEST_USER_ACTION_TOOL,
          ],
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
      send(
        rpcError(
          id,
          -32602,
          `unknown tool: ${name}（本 server 仅有 post_message、search_knowledge、query_db 和 request_user_action 四个工具）`
        )
      )
      return
    }

    // ─── 其他方法 ───
    send(rpcError(id, -32601, `Method not found: ${method}`))
  })
}

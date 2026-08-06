#!/usr/bin/env node
/**
 * MCP 结构化路由 server（Phase 1 产物）
 *
 * 原生 JSON-RPC 2.0 stdio 实现 MCP 最小子集（零依赖，Phase 0 spike 已验证协议层）：
 *   - initialize        → 协议握手
 *   - tools/list        → 暴露 1 个 post_message 工具
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
 *
 * 用法：node scripts/mcp-server.mjs（由 Claude Code CLI 作为 MCP server 拉起）
 */

import readline from 'node:readline'

const SERVER_INFO = { name: 'catstudy', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'
const TOOL_NAME = 'post_message'

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

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/route-signals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-token': token,
      },
      body: JSON.stringify({ sessionId, agentId, msgId, targetCats, clientMessageId }),
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
    send({ jsonrpc: '2.0', id, result: { tools: [POST_MESSAGE_TOOL] } })
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
    send(rpcError(id, -32602, `unknown tool: ${name}（本 server 仅有 post_message 一个工具）`))
    return
  }

  // ─── 其他方法 ───
  send(rpcError(id, -32601, `Method not found: ${method}`))
})

#!/usr/bin/env node
/**
 * MCP echo 工具 server（Phase 0 spike 产物）
 *
 * 原生 JSON-RPC 2.0 stdio 实现 MCP 最小子集（零依赖）：
 *   - initialize        → 协议握手
 *   - tools/list        → 暴露 1 个 echo 工具
 *   - tools/call        → 原样回显文本
 *   - ping / 其他       → 空 result / method not found
 *   - notifications（无 id 消息）→ 不回复
 *
 * 用途：验证 Claude Code CLI 挂 --mcp-config 后能否发现并调用工具，
 *       stream-json 是否出 tool_use / tool_result 块、调用后是否续流。
 * 用法：node scripts/mcp-echo.mjs（由 Claude Code 作为 MCP server 拉起）
 */

import readline from 'node:readline'

const SERVER_INFO = { name: 'catstudy-echo', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'
const ECHO_TOOL = {
  name: 'echo',
  description: '把输入文本原样回显。用于验证 MCP 工具调用链路是否打通。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要回显的文本' },
    },
    required: ['text'],
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

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
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
    send({ jsonrpc: '2.0', id, result: { tools: [ECHO_TOOL] } })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'echo') {
      const text = params?.arguments?.text ?? ''
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `ECHO: ${text}` }], isError: false },
      })
      return
    }
    send(rpcError(id, -32602, `unknown tool: ${name}（本 server 仅有 echo 一个工具）`))
    return
  }

  // ─── 其他方法 ───
  send(rpcError(id, -32601, `Method not found: ${method}`))
})

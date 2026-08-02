/**
 * 消息 REST API — 供外部工具（pre-push hook 等）向 cat-study 管道注入消息。
 *
 * POST /api/messages → 写入 DB → 广播 → 调度 Agent 执行
 * 等价于 Web 前端通过 Socket.IO 发送 SEND_MESSAGE 事件，但不需要 WebSocket 连接。
 */
import type { FastifyInstance } from 'fastify'
import { messages as messagesRepo, executionLogs as execLogsRepo } from '../db/repository/index.js'
import { ingestUserMessage } from '../connectors/ingest.js'

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/messages/:id → 按消息 id 反查所属会话
   * 供 handoff-gen 从 commit message 的 catstudy [uuid]（uuid 即触发消息 id）
   * 反查投递目标会话——永远指向"用户实际发起这条消息的会话"，比硬编码更准。
   */
  app.get('/api/messages/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'id is required' })
    }
    const row = messagesRepo.getMessageByIdOnly(id)
    if (!row) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    return reply.send({ id: row.id, sessionId: row.session_id, role: row.role })
  })

  /**
   * GET /api/messages/:id/executor → 反查"执行这条消息"的 agent（实施者）
   * 供 handoff-gen 动态决定交接文档补填人——"谁执行了触发消息，谁补填"。
   * 一条消息可触发多个 agent（多人 @），取最近开始执行的一条；无执行记录 404。
   */
  app.get('/api/messages/:id/executor', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'id is required' })
    }
    const executor = execLogsRepo.getExecutorNameByTriggeredBy(id)
    if (!executor) {
      return reply.status(404).send({ error: 'No execution log for this message' })
    }
    return reply.send({ agentId: executor.agent_id, agentName: executor.name })
  })

  app.post('/api/messages', async (req, reply) => {
    const body = req.body as any

    // 基本参数校验
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      return reply.status(400).send({ error: 'sessionId is required (string)' })
    }
    if (!body.content || typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'content is required (string)' })
    }

    // 摄入管线（校验/重定向/落库/广播/调度/执行）已提取为共享核心，
    // 与 socketio SEND_MESSAGE 同构——两入口共用 ingest.ts。
    // 不传 saveMemory：外部工具注入的管道消息不进向量记忆库（保持现状）。
    const result = await ingestUserMessage({
      sessionId: body.sessionId,
      content: body.content,
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
      images: Array.isArray(body.images) ? body.images : undefined,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
    })

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error })
    }

    return reply.status(201).send({
      ok: true,
      messageId: result.messageId,
      // 已交接会话 → 消息被重定向到子会话，调用方据此感知落点
      ...(result.redirectedFrom ? { redirectedTo: result.effectiveSessionId } : {}),
    })
  })
}

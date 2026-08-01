/**
 * 消息 REST API — 供外部工具（pre-push hook 等）向 cat-study 管道注入消息。
 *
 * POST /api/messages → 写入 DB → 广播 → 调度 Agent 执行
 * 等价于 Web 前端通过 Socket.IO 发送 SEND_MESSAGE 事件，但不需要 WebSocket 连接。
 */
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { Events, estimateTokens } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import type { AgentConfig } from '@cat-study/shared'
import { getIO, rowToAgent, executeAgentsSerial } from '../connectors/socketio.js'
import { dispatch, initAgentSlot, getAgentState, completeExecution } from '../dispatch/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('messages-api')

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

    const sessionId = body.sessionId
    const content = body.content
    const mentions: string[] = Array.isArray(body.mentions) ? body.mentions : []
    const taskId: string | undefined = body.taskId || undefined
    // 图片守卫：必须 data:image/ 前缀、单张 base64 ≤ 3MB、最多 4 张
    // （与 socketio.ts 的 SEND_MESSAGE 守卫同构；前端已压缩到最长边 1280，此处防滥用）
    const images: string[] = Array.isArray(body.images)
      ? body.images
          .filter(
            (s: unknown) =>
              typeof s === 'string' && s.startsWith('data:image/') && s.length <= 3 * 1024 * 1024
          )
          .slice(0, 4)
      : []
    const msgId = uuid()
    const traceId = uuid()

    log.info('REST message received', {
      traceId,
      sessionId,
      mentions,
      contentLen: content.length,
      contentTokens: estimateTokens(content),
      imageCount: images.length,
    })

    // 1. 验证 session 存在
    const sessionRow = sessionsRepo.getSessionById(sessionId)
    if (!sessionRow) {
      log.warn('session not found', { sessionId })
      return reply.status(404).send({ error: 'Session not found' })
    }

    // 2. 写入消息
    const mentionsJson = JSON.stringify(mentions)
    messagesRepo.insertUserMessage(
      msgId,
      sessionId,
      content,
      mentionsJson,
      taskId || null,
      JSON.stringify(images)
    )

    const msg = {
      id: msgId,
      sessionId,
      agentId: null,
      role: 'user' as const,
      content,
      images: images.length > 0 ? images : undefined,
      mentions,
      taskId: taskId || undefined,
      createdAt: new Date().toISOString(),
    }

    // 3. 广播到 Session 房间
    const io = getIO()
    if (io) {
      io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, msg)
    }

    // 4. 获取 Session 内的 Agent
    const agentIds: string[] = JSON.parse(sessionRow.agent_ids || '[]')
    const agents = agentIds
      .map((id: string) => {
        const row = agentsRepo.getAgentById(id)
        return row ? rowToAgent(row) : null
      })
      .filter(Boolean) as AgentConfig[]

    // 过滤无效 Agent
    const validAgents = agents.filter((a) => {
      if (!agentsRepo.agentExists(a.id)) {
        log.warn('agent not in DB, skipping dispatch', { agentId: a.id, traceId })
        return false
      }
      return true
    })

    // 5. 初始化槽位并调度
    for (const a of validAgents) {
      if (!getAgentState(a.id)) {
        initAgentSlot(a.id)
      }
    }

    try {
      await dispatch(sessionId, msg, validAgents, traceId)
    } catch (err: any) {
      log.error('dispatch failed', { sessionId, traceId, error: err.message })
    }

    // 确定目标（被 @ 的 Agent，或广播模式下的全部）
    const targets =
      mentions.length > 0 ? validAgents.filter((a) => mentions.includes(a.name)) : validAgents

    // 发送 queued 状态
    if (io) {
      for (const a of targets) {
        io.to(`session:${sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
          messageId: msgId,
          agentId: a.id,
          agentName: a.name,
          agentAvatar: a.avatar,
          status: 'queued',
        })
      }
    }

    // 6. 串行执行 Agent（不 await，让多个消息交错执行）
    if (io && targets.length > 0) {
      executeAgentsSerial(io, sessionId, targets, msg, traceId).catch((err) => {
        log.error('executeAgentsSerial crashed — releasing stuck slots', {
          traceId,
          error: err.message,
        })
        for (const a of targets) {
          const state = getAgentState(a.id)
          if (state && state.status === 'busy') {
            completeExecution(a.id, false, {
              errorMessage: `executeAgentsSerial crash: ${err.message}`,
              traceId,
            }).catch(() => {})
          }
        }
      })
    }

    return reply.status(201).send({ ok: true, messageId: msgId })
  })
}

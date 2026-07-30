import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  SessionCreateSchema,
  SessionUpdateSchema,
  Events,
  type SessionConfig,
} from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
  sessionReadState as readStateRepo,
} from '../db/repository/index.js'
import type { SessionRow } from '../db/repository/index.js'
import { getIO } from '../connectors/socketio.js'
import { createLogger } from '../logger.js'

const log = createLogger('sessions')

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/sessions — 创建会话 ──────────────────

  app.post('/api/sessions', async (req, reply) => {
    const parsed = SessionCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { title, agentIds } = parsed.data

    // 验证 Agent 是否存在
    const existingIds = agentsRepo.checkAgentIdsExist(agentIds)
    if (existingIds.length !== agentIds.length) {
      return reply.status(400).send({
        error: 'Some agent IDs are invalid',
      })
    }

    const id = uuid()
    sessionsRepo.insertSession(id, title, agentIds)

    const row = sessionsRepo.getSessionById(id)
    return reply.status(201).send(toSessionConfig(row!))
  })

  // ─── GET /api/sessions — 列出所有会话 ───────────────

  app.get('/api/sessions', async () => {
    const rows = sessionsRepo.listAllSessions()
    return rows.map((row) => {
      const session = toSessionConfig(row)
      // Compute unread count: messages created after last_read_at
      const lastRead = readStateRepo.getLastReadAt(row.id) || row.created_at
      session.unreadCount = messagesRepo.countMessagesAfter(row.id, lastRead)
      return session
    })
  })

  // ─── GET /api/sessions/:id — 获取会话详情 ───────────

  app.get('/api/sessions/:id', async (req, reply) => {
    const row = sessionsRepo.getSessionById((req.params as any).id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    // 附带 Agent 详情
    const agentIds: string[] = JSON.parse(row.agent_ids || '[]')
    const agents = agentIds.length > 0 ? agentsRepo.listAgentsByIds(agentIds) : []

    return {
      ...toSessionConfig(row),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        avatar: a.avatar,
      })),
    }
  })

  // ─── PATCH /api/sessions/:id — 更新会话 ──────────────

  app.patch('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id
    const row = sessionsRepo.getSessionById(id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    const parsed = SessionUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { title, addAgentIds, removeAgentIds, broadcastMode } = parsed.data

    // 支持重命名
    if (title !== undefined) {
      sessionsRepo.updateSessionTitle(id, title)
    }

    // 支持切换广播模式
    if (broadcastMode !== undefined) {
      sessionsRepo.updateSessionBroadcastMode(id, broadcastMode)
    }

    // 支持增加/移除 Agent
    if (addAgentIds?.length || removeAgentIds?.length) {
      const currentIds: string[] = JSON.parse(row.agent_ids || '[]')

      // 验证要添加的 Agent 是否存在
      if (addAgentIds?.length) {
        const existing = agentsRepo.checkAgentIdsExist(addAgentIds)
        if (existing.length !== addAgentIds.length) {
          return reply.status(400).send({ error: 'Some agent IDs are invalid' })
        }
      }

      const removeSet = new Set(removeAgentIds || [])
      const newIds = currentIds
        .filter((aid) => !removeSet.has(aid))
        .concat(addAgentIds || [])
        // 去重
        .filter((aid, i, arr) => arr.indexOf(aid) === i)

      if (newIds.length === 0) {
        return reply.status(400).send({ error: '会话至少需要一只猫咪' })
      }

      sessionsRepo.updateSessionAgentIds(id, JSON.stringify(newIds))
    }

    // emit 通知前端
    const updated = sessionsRepo.getSessionById(id)
    const config = toSessionConfig(updated!)
    try {
      getIO()?.to(`session:${id}`).emit(Events.SESSION_UPDATE, config)
    } catch {
      /* emit 失败不影响响应 */
    }
    return config
  })

  // ─── DELETE /api/sessions/:id/messages — 清空消息 ────

  app.delete('/api/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    // 按外键依赖顺序删除
    const elogResult = execLogsRepo.deleteExecutionLogsBySession(id)
    const msgResult = messagesRepo.deleteMessagesBySession(id)

    // 更新会话时间戳
    sessionsRepo.updateSessionTimestamp(id)

    // 通知所有已连接的客户端（支持多 tab 同步）
    const io = getIO()
    if (io) {
      io.emit(Events.SESSION_MESSAGES_CLEARED, { sessionId: id })
    }

    log.info('session messages cleared', {
      sessionId: id,
      messagesRemoved: msgResult.changes,
      executionLogsRemoved: elogResult.changes,
    })

    return {
      ok: true,
      messagesRemoved: msgResult.changes,
      executionLogsRemoved: elogResult.changes,
    }
  })

  // ─── GET /api/sessions/:id/messages — 获取消息列表 ──

  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const limit = Math.min(
      Math.max(parseInt((req.query as any)?.limit || '200', 10) || 200, 1),
      1000
    )
    const rows = messagesRepo.getRecentMessages(id, limit)

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id || null,
      role: r.role,
      content: r.content,
      mentions: JSON.parse(r.mentions || '[]'),
      taskId: r.task_id || null,
      thinkingContent: r.thinking_content || undefined,
      createdAt: r.created_at.replace(' ', 'T') + 'Z',
    }))
  })

  // ─── POST /api/sessions/:id/read — 标记已读 ──────────

  app.post('/api/sessions/:id/read', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    readStateRepo.upsertLastReadAt(id)

    return { ok: true }
  })

  // ─── DELETE /api/sessions/:id — 删除会话 ────────────

  app.delete('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    // 删除关联数据（按外键依赖顺序）
    execLogsRepo.deleteExecutionLogsBySession(id)
    messagesRepo.deleteMessagesBySession(id)
    sessionsRepo.deleteSession(id)

    // 通知所有已连接的客户端（支持多 tab 同步）
    const io = getIO()
    if (io) {
      io.emit(Events.SESSION_DELETED, { sessionId: id })
    }

    return { ok: true }
  })
}

function toSessionConfig(row: SessionRow): SessionConfig {
  return {
    id: row.id,
    title: row.title,
    agentIds: JSON.parse(row.agent_ids || '[]'),
    broadcastMode: !!row.broadcast_mode,
    createdAt: row.created_at.replace(' ', 'T') + 'Z',
    updatedAt: row.updated_at.replace(' ', 'T') + 'Z',
    handoffFrom: row.handoff_from || null,
    runningSummary: row.running_summary || null,
  }
}

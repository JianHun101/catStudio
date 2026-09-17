import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  SessionCreateSchema,
  SessionUpdateSchema,
  Events,
  type SessionConfig,
  type ToolCallInfo,
  type StreamSegment,
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
import { toIsoDb } from '../db/repository/time.js'
import { getExecutionEngine } from '../execution/registry.js'
import { createLogger } from '../logger.js'
import { parseJsonArray, parseJsonValue } from '../utils.js'

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

  // ─── GET /api/sessions — 列出会话（默认过滤已归档）───

  app.get('/api/sessions', async (req) => {
    // 归档默认过滤（spec §4.1「列表默认过滤 + 『显示已归档』开关」）。开关走显式参数：
    // 任何非空且非 '0'/'false' 的值都算开——前端只传 '1'，宽松解析是为了手工 curl 时不踩坑。
    const raw = (req.query as any)?.includeArchived
    const includeArchived =
      raw !== undefined && raw !== '' && raw !== '0' && raw !== 'false' && raw !== false
    const rows = includeArchived
      ? sessionsRepo.listAllSessions()
      : sessionsRepo.listActiveSessions()
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

  // ─── POST /api/sessions/:id/archive — 归档 ──────────
  // 用户态「删除」的替代形态：数据全留（会话 / 消息 / 成员照常可查），只从默认列表隐藏。

  app.post('/api/sessions/:id/archive', async (req, reply) => {
    const id = (req.params as any).id
    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    sessionsRepo.archiveSession(id)
    return reply.send(emitArchived(id))
  })

  // ─── POST /api/sessions/:id/unarchive — 取消归档 ────

  app.post('/api/sessions/:id/unarchive', async (req, reply) => {
    const id = (req.params as any).id
    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    sessionsRepo.unarchiveSession(id)
    return reply.send(emitArchived(id))
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
  // 方案 3 A 读层端点：limit/before（messageId 游标）/from/to（created_at 时间窗）——
  // 无参数时行为与既有 getRecentMessages(id, 200) 一致（role != system 口径不变）。

  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const q = (req.query as any) ?? {}
    const limit = Math.min(Math.max(parseInt(q?.limit || '200', 10) || 200, 1), 1000)

    // 可选窗口参数校验：before = 消息 id 游标；from/to = created_at 时间窗（ISO/DB 秒级串）
    const before = q?.before
    if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
      return reply.status(400).send({ error: 'before 必须是非空字符串（消息 id 游标）' })
    }
    const from = q?.from
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      return reply.status(400).send({ error: 'from 必须是非空字符串（created_at 下界）' })
    }
    const to = q?.to
    if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
      return reply.status(400).send({ error: 'to 必须是非空字符串（created_at 上界）' })
    }

    const rows = messagesRepo.getSessionMessagesRange(id, {
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    })

    return rows.map((r) => {
      const msgImages: string[] = parseJsonArray(r.images)
      return {
        id: r.id,
        sessionId: r.session_id,
        agentId: r.agent_id || null,
        role: r.role,
        content: r.content,
        images: msgImages.length > 0 ? msgImages : undefined,
        mentions: JSON.parse(r.mentions || '[]'),
        taskId: r.task_id || null,
        thinkingContent: r.thinking_content || undefined,
        toolContent: parseJsonValue<ToolCallInfo[]>(r.tool_content),
        segments: parseJsonValue<StreamSegment[]>(r.segments),
        createdAt: toIsoDb(r.created_at),
      }
    })
  })

  // ─── GET /api/sessions/:id/executions — 执行元数据（耗时/token 展示投影）──

  app.get('/api/sessions/:id/executions', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const rows = execLogsRepo.getExecutionsBySession(id)

    return {
      executions: rows.map((r) => ({
        messageId: r.message_id,
        agentId: r.agent_id,
        status: r.status,
        latencyMs: r.latency_ms,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        startedAt: r.started_at ? r.started_at.replace(' ', 'T') + 'Z' : null,
      })),
    }
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

    // C1 dispose：同步清理引擎内该会话全部槽位——否则 (agentId, sessionId)
    // 槽位只增不减，连续开/关会话 snapshot 膨胀（OQ1 审查缺口）
    getExecutionEngine()?.disposeSession(id)

    // 通知所有已连接的客户端（支持多 tab 同步）
    const io = getIO()
    if (io) {
      io.emit(Events.SESSION_DELETED, { sessionId: id })
    }

    return { ok: true }
  })
}

/** 归档态变化后：全局广播 + 返回新配置（`archivedAt` 一律过归一器——列已是 ISO，但接口
 *  形态统一走 `toIsoDb` 免得日后有人把这里换成秒级列时静默漂移）。 */
function emitArchived(id: string): SessionConfig {
  const row = sessionsRepo.getSessionById(id)!
  const config = toSessionConfig(row)
  try {
    // 全局广播（非会话房间）——归档改的是列表可见性，受影响的是所有看列表的客户端
    getIO()?.emit(Events.SESSION_ARCHIVED, {
      sessionId: id,
      archivedAt: config.archivedAt ?? null,
    })
  } catch {
    /* emit 失败不影响响应 */
  }
  return config
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
    archivedAt: row.archived_at ? toIsoDb(row.archived_at) : null,
  }
}

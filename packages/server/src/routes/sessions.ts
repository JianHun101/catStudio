import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { SessionCreateSchema, Events } from '@cat-study/shared'
import { getDb } from '../db/index.js'
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
    const db = getDb()

    // 验证 Agent 是否存在
    const placeholders = agentIds.map(() => '?').join(',')
    const existing = db.prepare(
      `SELECT id FROM agents WHERE id IN (${placeholders})`
    ).all(...agentIds) as any[]

    if (existing.length !== agentIds.length) {
      return reply.status(400).send({
        error: 'Some agent IDs are invalid',
      })
    }

    const id = uuid()
    db.prepare(`
      INSERT INTO sessions (id, title, agent_ids)
      VALUES (?, ?, ?)
    `).run(id, title, JSON.stringify(agentIds))

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    return reply.status(201).send(toSessionConfig(row))
  })

  // ─── GET /api/sessions — 列出所有会话 ───────────────

  app.get('/api/sessions', async () => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as any[]
    return rows.map(toSessionConfig)
  })

  // ─── GET /api/sessions/:id — 获取会话详情 ───────────

  app.get('/api/sessions/:id', async (req, reply) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params as any).id) as any
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    // 附带 Agent 详情
    const agentIds: string[] = JSON.parse(row.agent_ids || '[]')
    const agents = agentIds.length > 0
      ? db.prepare(
          `SELECT * FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})`
        ).all(...agentIds)
      : []

    return {
      ...toSessionConfig(row),
      agents: (agents as any[]).map((a) => ({
        id: a.id,
        name: a.name,
        avatar: a.avatar,
      })),
    }
  })

  // ─── PATCH /api/sessions/:id — 切换广播模式 ──────────

  app.patch('/api/sessions/:id', async (req, reply) => {
    const db = getDb()
    const id = (req.params as any).id
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    const body = req.body as any
    const newMode = body.broadcastMode ? 1 : 0

    db.prepare(`
      UPDATE sessions SET broadcast_mode = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newMode, id)

    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    return toSessionConfig(updated)
  })

  // ─── DELETE /api/sessions/:id/messages — 清空消息 ────

  app.delete('/api/sessions/:id/messages', async (req, reply) => {
    const db = getDb()
    const id = (req.params as any).id

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })

    // 按外键依赖顺序删除
    const elogResult = db.prepare('DELETE FROM execution_logs WHERE session_id = ?').run(id)
    const msgResult = db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)

    // 更新会话时间戳
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(id)

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

  // ─── DELETE /api/sessions/:id — 删除会话 ────────────

  app.delete('/api/sessions/:id', async (req, reply) => {
    const db = getDb()
    const id = (req.params as any).id

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })

    // 删除关联数据（按外键依赖顺序）
    db.prepare('DELETE FROM execution_logs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)

    // 通知所有已连接的客户端（支持多 tab 同步）
    const io = getIO()
    if (io) {
      io.emit(Events.SESSION_DELETED, { sessionId: id })
    }

    return { ok: true }
  })
}

function toSessionConfig(row: any) {
  return {
    id: row.id,
    title: row.title,
    agentIds: JSON.parse(row.agent_ids || '[]'),
    broadcastMode: !!row.broadcast_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

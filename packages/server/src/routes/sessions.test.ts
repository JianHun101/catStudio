import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'

// Mock getIO from socketio connector (used by session DELETE)
vi.mock('../connectors/socketio.js', () => {
  const mockEmit = vi.fn()
  return {
    getIO: vi.fn(() => ({ emit: mockEmit })),
    createSocketIO: vi.fn(),
  }
})

describe('Session Routes', () => {
  let app: FastifyInstance
  let agentId1 = 'agent-001'
  let agentId2 = 'agent-002'

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()

    // 创建两个测试 Agent
    const db = (await import('../db/index.js')).getDb()
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk-test')
    `
    ).run(agentId1, '店长阿暹')
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk-test')
    `
    ).run(agentId2, '阿橘')

    // Import and register routes (must be after mock is set up)
    const { sessionRoutes } = await import('./sessions.js')
    await app.register(sessionRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  describe('POST /api/sessions', () => {
    it('creates a session and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试会话', agentIds: [agentId1, agentId2] },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.title).toBe('测试会话')
      expect(body.agentIds).toEqual([agentId1, agentId2])
      expect(body.id).toBeDefined()
    })

    it('returns 400 for invalid agent IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试', agentIds: ['nonexistent'] },
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for empty title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '', agentIds: [agentId1] },
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for empty agentIds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试', agentIds: [] },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/sessions', () => {
    it('returns empty array when no sessions', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual([])
    })

    it('returns all sessions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: 'S1', agentIds: [agentId1] },
      })
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: 'S2', agentIds: [agentId2] },
      })

      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toHaveLength(2)
    })

    // ─── 票 7 · 归档默认过滤 ─────────────────────────────
    const createSession = async (title: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title, agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id as string
    }

    it('默认滤掉已归档会话；?includeArchived=1 全量返回', async () => {
      const keep = await createSession('留着')
      const gone = await createSession('归档的')

      const archive = await app.inject({
        method: 'POST',
        url: `/api/sessions/${gone}/archive`,
      })
      expect(archive.statusCode).toBe(200)

      const def = await app.inject({ method: 'GET', url: '/api/sessions' })
      const defIds = (JSON.parse(def.body) as Array<{ id: string }>).map((s) => s.id)
      expect(defIds).toContain(keep)
      expect(defIds).not.toContain(gone)

      const all = await app.inject({ method: 'GET', url: '/api/sessions?includeArchived=1' })
      const allIds = (JSON.parse(all.body) as Array<{ id: string }>).map((s) => s.id)
      expect(allIds).toContain(keep)
      expect(allIds).toContain(gone)
    })

    it('includeArchived 的宽松解析：`0`/`false` 视为关（手工 curl 不踩坑）', async () => {
      const gone = await createSession('归档的-2')
      await app.inject({ method: 'POST', url: `/api/sessions/${gone}/archive` })

      for (const v of ['0', 'false', '']) {
        const res = await app.inject({ method: 'GET', url: `/api/sessions?includeArchived=${v}` })
        const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((s) => s.id)
        expect(ids, `includeArchived=${v}`).not.toContain(gone)
      }
    })
  })

  describe('POST /api/sessions/:id/archive | /unarchive', () => {
    const createSession = async (title: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title, agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id as string
    }

    it('归档返回带 archivedAt 的会话配置，并全局广播 SESSION_ARCHIVED', async () => {
      const id = await createSession('归档广播')
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/archive` })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

      const { getIO } = await import('../connectors/socketio.js')
      const emit = (getIO() as unknown as { emit: ReturnType<typeof vi.fn> }).emit
      expect(emit).toHaveBeenCalledWith('session-archived', {
        sessionId: id,
        archivedAt: body.archivedAt,
      })
    })

    it('取消归档返回 archivedAt=null，会话回到默认列表', async () => {
      const id = await createSession('取消归档')
      await app.inject({ method: 'POST', url: `/api/sessions/${id}/archive` })

      const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/unarchive` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).archivedAt).toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/sessions' })
      const ids = (JSON.parse(list.body) as Array<{ id: string }>).map((s) => s.id)
      expect(ids).toContain(id)
    })

    it('归档**不删数据**：会话详情与消息照常可查（用户态删除 = 归档）', async () => {
      const id = await createSession('数据全留')
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content) VALUES ('m-keep', ?, 'user', '原话')`
      ).run(id)

      await app.inject({ method: 'POST', url: `/api/sessions/${id}/archive` })

      const detail = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(detail.statusCode).toBe(200)
      expect(JSON.parse(detail.body).archivedAt).toMatch(/Z$/)

      const msgs = await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` })
      expect(msgs.statusCode).toBe(200)
      expect(JSON.parse(msgs.body)).toHaveLength(1)
    })

    it('会话不存在 → 404（两个端点都是）', async () => {
      for (const action of ['archive', 'unarchive']) {
        const res = await app.inject({ method: 'POST', url: `/api/sessions/nope/${action}` })
        expect(res.statusCode, action).toBe(404)
      }
    })
  })

  describe('GET /api/sessions/:id', () => {
    it('returns session with agent details', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '详情测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.title).toBe('详情测试')
      expect(body.agents).toBeDefined()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0].name).toBe('店长阿暹')
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('PATCH /api/sessions/:id', () => {
    it('toggles broadcast mode', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '广播测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      expect(JSON.parse(create.body).broadcastMode).toBe(false)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { broadcastMode: true },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).broadcastMode).toBe(true)
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/nonexistent',
        payload: { broadcastMode: true },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:id', () => {
    it('deletes a session and returns ok', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '删除测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })

      // 确认已删除
      const get = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(get.statusCode).toBe(404)
    })

    it('cascades to messages and execution_logs', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '级联测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      // 手动插入消息和执行日志
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hello')"
      ).run(id)
      db.prepare(
        `
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
        VALUES ('log1', ?, ?, 'm1', 'completed')
      `
      ).run(id, agentId1)

      // 删除
      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)

      // 确认消息和日志已级联删除
      const msg = db.prepare("SELECT * FROM messages WHERE id = 'm1'").get()
      expect(msg).toBeUndefined()
      const logRow = db.prepare("SELECT * FROM execution_logs WHERE id = 'log1'").get()
      expect(logRow).toBeUndefined()
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sessions/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:id/messages', () => {
    it('clears messages and execution_logs, keeps session', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '清空测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hello')"
      ).run(id)
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m2', ?, 'agent', 'hi')"
      ).run(id)
      db.prepare(
        `
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
        VALUES ('log1', ?, ?, 'm1', 'completed')
      `
      ).run(id, agentId1)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.messagesRemoved).toBe(2)
      expect(body.executionLogsRemoved).toBe(1)

      // 确认消息和日志已删除
      const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id)
      expect(msgs).toHaveLength(0)
      const logs = db.prepare('SELECT * FROM execution_logs WHERE session_id = ?').all(id)
      expect(logs).toHaveLength(0)

      // 确认会话仍存在
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
      expect(session).toBeDefined()
    })

    it('returns ok for session with no messages', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '空清空测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)
      expect(JSON.parse(res.body).messagesRemoved).toBe(0)
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sessions/nonexistent/messages' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /api/sessions/:id/messages', () => {
    it('返回 agent 消息带 segments + toolContent（REST 历史交错序可查）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '历史交错测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const db = (await import('../db/index.js')).getDb()
      const segs = [
        { kind: 'thinking', content: '先想一下再调工具' },
        {
          kind: 'tool',
          content: '',
          tool: { id: 'call_1', name: 'apply_patch', status: 'completed' },
        },
        { kind: 'text', content: '正文结论' },
      ]
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, tool_content, segments)
         VALUES ('m-seg', ?, ?, 'agent', '正文结论', '[]', ?, ?)`
      ).run(
        id,
        agentId1,
        JSON.stringify([
          {
            id: 'call_1',
            name: 'apply_patch',
            status: 'completed',
            input: { filePath: 'a.txt' },
            output: 'diff',
          },
        ]),
        JSON.stringify(segs)
      )

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      const m = body.find((x: any) => x.id === 'm-seg')
      expect(m).toBeDefined()
      expect(m.segments).toEqual(segs)
      expect(m.toolContent).toHaveLength(1)
      expect(m.toolContent[0].name).toBe('apply_patch')
    })

    it('老消息（segments 列 NULL）不带 segments 字段（前端退化现行为）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '老消息测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions)
         VALUES ('m-old', ?, ?, 'agent', '旧回复', '[]')`
      ).run(id, agentId1)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` })
      const body = JSON.parse(res.body)
      const m = body.find((x: any) => x.id === 'm-old')
      expect(m.segments).toBeUndefined()
    })

    it('无参数行为与现状一致（A 读层向后兼容铁律：换函数后既有断言全绿）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '兼容测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('m-c1', ?, 'user', '旧', '[]', '2026-09-01 10:00:00')`
      ).run(id)
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('m-c2', ?, 'user', '新', '[]', '2026-09-01 12:00:00')`
      ).run(id)
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('m-c3', ?, 'system', '重启', '[]', '2026-09-01 13:00:00')`
      ).run(id)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      // 新→旧、system 消息不返回（口径与 getRecentMessages 一致）
      expect(JSON.parse(res.body).map((x: any) => x.id)).toEqual(['m-c2', 'm-c1'])
    })

    it('before 游标翻更早历史：limit=1 后取最旧一条做游标 → 返回更早批次不重叠', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '游标测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = (await import('../db/index.js')).getDb()
      for (const [mid, ts] of [
        ['m-p1', '2026-09-01 10:00:00'],
        ['m-p2', '2026-09-01 11:00:00'],
        ['m-p3', '2026-09-01 12:00:00'],
      ]) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
           VALUES (?, ?, 'user', ?, '[]', ?)`
        ).run(mid, id, mid, ts)
      }

      const page1 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages?limit=1`,
      })
      expect(JSON.parse(page1.body).map((x: any) => x.id)).toEqual(['m-p3'])

      const page2 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages?limit=1&before=m-p3`,
      })
      expect(JSON.parse(page2.body).map((x: any) => x.id)).toEqual(['m-p2'])

      const page3 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages?limit=1&before=m-p2`,
      })
      expect(JSON.parse(page3.body).map((x: any) => x.id)).toEqual(['m-p1'])
    })

    it('from/to 时间窗（ISO 秒级时间戳）过滤批次', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '时间窗测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = (await import('../db/index.js')).getDb()
      // 夹具落库时间戳用 ISO 毫秒——票 5 起 `messages.created_at` 的列口径（迁移把存量
      // 秒级串全量转成了 ISO）。仍写秒级串的夹具代表不了任何真实行。
      for (const [mid, ts] of [
        ['m-w1', '2026-09-01T10:00:00.000Z'],
        ['m-w2', '2026-09-01T12:00:00.000Z'],
        ['m-w3', '2026-09-01T14:00:00.000Z'],
      ]) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
           VALUES (?, ?, 'user', ?, '[]', ?)`
        ).run(mid, id, mid, ts)
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages?from=2026-09-01T12:00:00Z&to=2026-09-01T13:00:00Z`,
      })
      expect(JSON.parse(res.body).map((x: any) => x.id)).toEqual(['m-w2'])
    })

    it('before/from/to 空串 → 400（窗口参数校验）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '参数校验', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      for (const qs of ['before=', 'from=', 'to=']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/sessions/${id}/messages?${qs}`,
        })
        expect(res.statusCode).toBe(400)
      }
    })
  })

  describe('GET /api/sessions/:id/executions', () => {
    it('返回该 session 全部 execution 的展示列投影（camelCase；message_id 关联回复气泡）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '执行元数据测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const db = (await import('../db/index.js')).getDb()
      // FK 补链后（票 6 批一）：execution_logs 的 `triggered_by_message_id`（触发消息）与
      // `message_id`（回复消息）双双 → messages.id ⇒ 两个父行都必须真的存在
      for (const mid of ['trigger-1', 'trigger-2', 'msg-reply-1']) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', 'x', '[]')`
        ).run(mid, id)
      }
      // 两条行刻意取**两种时间形态**：票 6 起列口径是 ISO 毫秒（主路径），存量库仍是
      // 空格分隔秒级串（兼容路径）。响应的 `startedAt` 必须两条都归一成 ISO 毫秒——
      // 旧的 `replace(' ','T') + 'Z'` 对 ISO 行会拼出 `…000ZZ`（前端拿到畸形串）。
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at, latency_ms, message_id, prompt_tokens, completion_tokens)
         VALUES ('log-ok', ?, ?, 'trigger-1', 'completed', 'trace-1', '2026-09-01T10:00:00.000Z', 12300, 'msg-reply-1', 2100, 800)`
      ).run(id, agentId1)
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at, message_id)
         VALUES ('log-null', ?, ?, 'trigger-2', 'failed', 'trace-2', '2026-09-01 11:00:00', NULL)`
      ).run(id, agentId2)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/executions` })
      expect(res.statusCode).toBe(200)
      const { executions } = JSON.parse(res.body)

      const ok = executions.find((x: any) => x.messageId === 'msg-reply-1')
      expect(ok).toBeDefined()
      expect(ok).toMatchObject({
        agentId: agentId1,
        status: 'completed',
        latencyMs: 12300,
        promptTokens: 2100,
        completionTokens: 800,
        startedAt: '2026-09-01T10:00:00.000Z', // ISO 行原样透出（不被二次拼 Z）
      })

      const failed = executions.find((x: any) => x.agentId === agentId2)
      expect(failed).toMatchObject({
        messageId: null, // 失败/中断路径 finalize 不写回 replyMessageId → NULL 原样透出
        status: 'failed',
        latencyMs: null,
        promptTokens: null,
        completionTokens: null,
        startedAt: '2026-09-01T11:00:00.000Z', // 存量秒级行被归一成 ISO 毫秒
      })
    })

    it('空 session 返回空数组不报错', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '空执行测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/executions` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ executions: [] })
    })

    it('返回 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent/executions' })
      expect(res.statusCode).toBe(404)
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, messageSearch } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'
import { Events } from '@cat-study/shared'
import { setExecutionEngine, __test_reset as __resetEngine } from '../execution/registry.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from '../execution/serial.js'

// Mock getIO from socketio connector (used by session DELETE)
//
// `emit` = 全局广播（SESSION_DELETED / SESSION_MESSAGES_CLEARED）；`roomEmit` = 房间广播
// （`io.to('session:<id>').emit(...)`，PATCH 的 SESSION_UPDATE 与回退的 SESSION_ROLLED_BACK）。
// 两个分开记，回退用例才能断言「发给了这个会话房间」而不是「随便发了一条」。
const { mockEmit, mockRoomEmit } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockRoomEmit: vi.fn(),
}))

vi.mock('../connectors/socketio.js', () => ({
  getIO: vi.fn(() => ({ emit: mockEmit, to: vi.fn(() => ({ emit: mockRoomEmit })) })),
  createSocketIO: vi.fn(),
}))

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
    mockEmit.mockClear()
    mockRoomEmit.mockClear()
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

    // ─── 票 7 · 归档 → T1 起退役（归档不再影响列表；T5 才删接口） ─────
    const createSession = async (title: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title, agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id as string
    }

    it('归档不再从默认列表隐藏（T1：收纳由分组折叠承担）；includeArchived 兼容参数仍可传', async () => {
      const keep = await createSession('留着')
      const archived = await createSession('归档的')

      const archive = await app.inject({
        method: 'POST',
        url: `/api/sessions/${archived}/archive`,
      })
      expect(archive.statusCode).toBe(200)

      const def = await app.inject({ method: 'GET', url: '/api/sessions' })
      const defIds = (JSON.parse(def.body) as Array<{ id: string }>).map((s) => s.id)
      expect(defIds).toContain(keep)
      // T1 起 `listActiveSessions` 只排除 `deleted_at`；归档列冻结、不参与可见性
      expect(defIds).toContain(archived)

      const all = await app.inject({ method: 'GET', url: '/api/sessions?includeArchived=1' })
      const allIds = (JSON.parse(all.body) as Array<{ id: string }>).map((s) => s.id)
      expect(allIds).toEqual(expect.arrayContaining([keep, archived]))
    })

    it('includeArchived 的宽松解析仍不误伤：`0`/`false`/空串都返回未删除会话', async () => {
      const id = await createSession('兼容参数')
      for (const v of ['0', 'false', '']) {
        const res = await app.inject({ method: 'GET', url: `/api/sessions?includeArchived=${v}` })
        expect(res.statusCode, `includeArchived=${v}`).toBe(200)
        const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((s) => s.id)
        expect(ids, `includeArchived=${v}`).toContain(id)
      }
    })

    // ─── T6：最后消息时间（列表行展示的数据源）─────────────────────────
    it('lastMessageAt = 最后一条对话消息（user/agent）的 created_at，系统通告不计入；空会话为 null', async () => {
      const busy = await createSession('有消息的')
      const empty = await createSession('空会话')
      const db = getDb()
      const ins = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES (?, ?, ?, 'x', '[]', ?)`
      )
      ins.run('m-early', busy, 'user', '2026-02-01T09:00:00.000Z')
      ins.run('m-late', busy, 'agent', '2026-02-01T10:30:00.000Z')
      // 更晚的系统通告（如评估告警广播）不能顶掉最后对话时间
      ins.run('m-system', busy, 'system', '2026-11-05T04:10:58.135Z')

      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      const list = JSON.parse(res.body) as Array<{
        id: string
        lastMessageAt: string | null
      }>

      expect(list.find((s) => s.id === busy)!.lastMessageAt).toBe('2026-02-01T10:30:00.000Z')
      // 形态钉死：ISO 毫秒 UTC（与 messages.created_at 同形），不补 `Z`、更不能 `ZZ`。
      const late = list.find((s) => s.id === busy)!.lastMessageAt!
      expect(late).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(late).not.toContain('ZZ')
      expect(list.find((s) => s.id === empty)!.lastMessageAt).toBeNull()
    })

    it('includeArchived 分支同样挂 lastMessageAt（两条路径不漏）且同样排除系统通告', async () => {
      const id = await createSession('兼容分支也带')
      const ins = getDb().prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES (?, ?, ?, 'x', '[]', ?)`
      )
      ins.run('m-arch', id, 'user', '2026-03-04T05:06:07.000Z')
      ins.run('m-arch-system', id, 'system', '2026-11-05T04:10:58.135Z')

      const res = await app.inject({ method: 'GET', url: '/api/sessions?includeArchived=1' })
      const list = JSON.parse(res.body) as Array<{ id: string; lastMessageAt: string | null }>

      expect(list.find((s) => s.id === id)!.lastMessageAt).toBe('2026-03-04T05:06:07.000Z')
      const value = list.find((s) => s.id === id)!.lastMessageAt!
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(value).not.toContain('ZZ')
    })

    it('多会话各取各的最后时间，不串号', async () => {
      const a = await createSession('A')
      const b = await createSession('B')
      const db = getDb()
      const ins = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES (?, ?, 'user', 'x', '[]', ?)`
      )
      ins.run('m-a', a, '2026-01-01T00:00:00.000Z')
      ins.run('m-b', b, '2026-01-02T00:00:00.000Z')

      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      const list = JSON.parse(res.body) as Array<{ id: string; lastMessageAt: string | null }>

      expect(list.find((s) => s.id === a)!.lastMessageAt).toBe('2026-01-01T00:00:00.000Z')
      expect(list.find((s) => s.id === b)!.lastMessageAt).toBe('2026-01-02T00:00:00.000Z')
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

    it('groupId 移动到分组：200 返回新 groupId，且不改 updated_at', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '移动测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = getDb()
      db.prepare(
        `INSERT INTO session_groups (id, name, created_at, updated_at)
         VALUES ('g-1', '小说连载', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(`UPDATE sessions SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: 'g-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).groupId).toBe('g-1')
      expect(
        db.prepare(`SELECT group_id, updated_at FROM sessions WHERE id = ?`).get(id) as {
          group_id: string | null
          updated_at: string
        }
      ).toEqual({ group_id: 'g-1', updated_at: '2020-01-01 00:00:00' })

      // `groupId: null` 回未分组
      const back = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: null },
      })
      expect(back.statusCode).toBe(200)
      expect(JSON.parse(back.body).groupId).toBeNull()
    })

    it('groupId 指向不存在/已删组 → 400 GROUP_NOT_FOUND，原分组不变', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '坏组', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = getDb()
      db.prepare(
        `INSERT INTO session_groups (id, name, created_at, updated_at, deleted_at)
         VALUES ('g-dead', '已删组', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                 '2026-01-02T00:00:00.000Z')`
      ).run()

      for (const groupId of ['g-missing', 'g-dead']) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/sessions/${id}`,
          payload: { groupId },
        })
        expect(res.statusCode, groupId).toBe(400)
        expect(JSON.parse(res.body)).toEqual({ error: 'GROUP_NOT_FOUND' })
      }
      expect(
        (
          db.prepare(`SELECT group_id FROM sessions WHERE id = ?`).get(id) as {
            group_id: string | null
          }
        ).group_id
      ).toBeNull()
    })

    it('GET 列表与详情都带 groupId（wire 契约）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '带组', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      const db = getDb()
      db.prepare(
        `INSERT INTO session_groups (id, name, created_at, updated_at)
         VALUES ('g-2', '组二', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: 'g-2' },
      })

      const list = await app.inject({ method: 'GET', url: '/api/sessions' })
      const row = (JSON.parse(list.body) as Array<{ id: string; groupId: string | null }>).find(
        (s) => s.id === id
      )
      expect(row?.groupId).toBe('g-2')

      const detail = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(JSON.parse(detail.body).groupId).toBe('g-2')
    })

    // ─── T1 收尾（P2-2 的 T1 半边）：移动会话要广播 GROUPS_CHANGED ─────────
    // 组归属是左栏结构：只发会话房间的 SESSION_UPDATE 时，别的 tab 的组会话数不会变。
    const countGroupsChanged = () =>
      mockEmit.mock.calls.filter((c: unknown[]) => c[0] === Events.GROUPS_CHANGED).length

    const createSessionForMove = async (): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '移动广播', agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id
    }

    const createGroupRow = (id: string, name: string) => {
      getDb()
        .prepare(
          `INSERT INTO session_groups (id, name, created_at, updated_at)
           VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        )
        .run(id, name)
    }

    it('groupId 真变化 → 全局 GROUPS_CHANGED 恰好 1 次（SESSION_UPDATE 仍发房间）', async () => {
      const id = await createSessionForMove()
      createGroupRow('g-move', '目标组')

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: 'g-move' },
      })
      expect(res.statusCode).toBe(200)
      expect(countGroupsChanged()).toBe(1)
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.SESSION_UPDATE,
        expect.objectContaining({ id, groupId: 'g-move' })
      )
    })

    it('groupId 同值 → 0 次 GROUPS_CHANGED（前端重放不触发全量刷新）', async () => {
      const id = await createSessionForMove()
      createGroupRow('g-same', '同值组')
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: 'g-same' },
      })
      mockEmit.mockClear()

      const again = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { groupId: 'g-same' },
      })
      expect(again.statusCode).toBe(200)
      expect(countGroupsChanged()).toBe(0)
    })

    it('只改 title / 成员 → 0 次 GROUPS_CHANGED', async () => {
      const id = await createSessionForMove()
      const title = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { title: '只改名' },
      })
      expect(title.statusCode).toBe(200)
      expect(countGroupsChanged()).toBe(0)

      const members = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { addAgentIds: [agentId2] },
      })
      expect(members.statusCode).toBe(200)
      expect(countGroupsChanged()).toBe(0)
    })
  })

  // ═══ T2 · 回收站：软删 / 恢复 / 彻底删除 / 守卫 / 列表 ═════════════
  describe('T2 回收站', () => {
    const DAY = 24 * 60 * 60 * 1000

    const newSession = async (title = '回收站测试'): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title, agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id as string
    }

    const insertGroup = (id: string, name: string, deletedAt: string | null = null) => {
      getDb()
        .prepare(
          `INSERT INTO session_groups (id, name, created_at, updated_at, deleted_at)
           VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
        )
        .run(id, name, deletedAt)
    }

    const setDeletedAt = (id: string, deletedAt: string | null) => {
      getDb().prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(deletedAt, id)
    }

    const rowOf = (id: string) =>
      getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
        deleted_at: string | null
        group_id: string | null
        updated_at: string
      }

    const trashIds = async (): Promise<string[]> => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/trash' })
      expect(res.statusCode).toBe(200)
      return (JSON.parse(res.body).entries as Array<{ kind: string; id: string }>)
        .filter((e) => e.kind === 'session')
        .map((e) => e.id)
    }

    function stubEngine(slots: Array<Record<string, unknown>>) {
      return {
        snapshot: () => slots,
        abortAgent: vi.fn(() => true),
        cancelQueuedCommand: vi.fn(() => 0),
        disposeSession: vi.fn(),
      } as unknown as ExecutionEngine & ExecutionEngineTestHooks
    }

    afterEach(() => {
      __resetEngine()
    })

    it('单删 = 软删：列表消失、进 /trash、purgeAfter = deletedAt+7d、消息一条不少', async () => {
      const id = await newSession('软删')
      const db = getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hi')"
      ).run(id)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toMatchObject({ id })
      expect(Date.parse(body.purgeAfter) - Date.parse(body.deletedAt)).toBe(7 * DAY)

      // 消息仍在（软删的唯一判据是 sessions.deleted_at）
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'm1'").get()).toEqual({
        n: 1,
      })
      // 详情 / 列表 / includeArchived 都当不存在
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode).toBe(404)
      const list = await app.inject({ method: 'GET', url: '/api/sessions' })
      expect((JSON.parse(list.body) as Array<{ id: string }>).map((s) => s.id)).not.toContain(id)
      const all = await app.inject({ method: 'GET', url: '/api/sessions?includeArchived=1' })
      expect((JSON.parse(all.body) as Array<{ id: string }>).map((s) => s.id)).not.toContain(id)

      // /trash 一条会话条目，带原组（无组 = null）与消息数
      const trash = await app.inject({ method: 'GET', url: '/api/sessions/trash' })
      const entries = JSON.parse(trash.body).entries as Array<Record<string, any>>
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'session',
        id,
        name: '软删',
        sessionCount: 1,
        messageCount: 1,
        groupId: null,
        groupName: null,
      })
      expect(entries[0].daysLeft).toBe(7)
      // 事件
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_TRASHED, {
        sessionIds: [id],
        groupIds: [],
      })
    })

    it('重复 DELETE 幂等：仍 200、返回**首次** deletedAt、不重置 7 天计时', async () => {
      const id = await newSession('幂等删除')
      const first = JSON.parse(
        (await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })).body
      )
      mockEmit.mockClear()

      const second = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(second.statusCode).toBe(200)
      const body = JSON.parse(second.body)
      expect(body.deletedAt).toBe(first.deletedAt)
      expect(body.purgeAfter).toBe(first.purgeAfter)
      expect(mockEmit).not.toHaveBeenCalledWith(Events.SESSION_TRASHED, expect.anything())
    })

    it('忙 / 排队 → 409 SESSION_BUSY，deleted_at 仍 NULL', async () => {
      const id = await newSession('忙碌')
      setExecutionEngine(
        stubEngine([
          // idle 槽位仍留 sessionId —— 不得判忙
          { agentId: agentId2, sessionId: id, status: 'idle', queueLength: 0 },
          // 真忙
          { agentId: agentId1, sessionId: id, status: 'busy', queueLength: 0 },
        ])
      )

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(409)
      const body = JSON.parse(res.body)
      expect(body.error).toBe('SESSION_BUSY')
      expect(body.sessions[0]).toMatchObject({ id, reason: 'busy' })
      expect(rowOf(id).deleted_at).toBeNull()
    })

    it('只有 idle 槽位（仍留 sessionId）不算忙：可以删除，且删后清槽位一次', async () => {
      const id = await newSession('空闲槽位')
      const engine = stubEngine([
        { agentId: agentId1, sessionId: id, status: 'idle', queueLength: 0 },
      ])
      setExecutionEngine(engine)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      expect(rowOf(id).deleted_at).not.toBeNull()
      expect(engine.disposeSession).toHaveBeenCalledTimes(1)
      expect(engine.disposeSession).toHaveBeenCalledWith(id)
    })

    it('绑定外部群 → 409 SESSION_BOUND，绑定行与 deleted_at 都不变', async () => {
      const id = await newSession('已绑定')
      const db = getDb()
      db.prepare(
        `INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id, created_at)
         VALUES ('b1', 'qq', 'group', '555', ?, '2026-01-01T00:00:00.000Z')`
      ).run(id)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(409)
      const body = JSON.parse(res.body)
      expect(body.error).toBe('SESSION_BOUND')
      expect(body.sessions[0]).toMatchObject({
        id,
        reason: 'bound',
        platform: 'qq',
        externalId: '555',
      })
      expect(rowOf(id).deleted_at).toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS n FROM connector_bindings').get()).toEqual({ n: 1 })
    })

    it('恢复：回原组、不改 updated_at；原组已删 → groupId=null；过期 → 404', async () => {
      const id = await newSession('恢复')
      insertGroup('g-live', '活组')
      getDb()
        .prepare(
          "UPDATE sessions SET group_id = 'g-live', updated_at = '2020-01-01 00:00:00' WHERE id = ?"
        )
        .run(id)
      await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })

      const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/restore` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.groupId).toBe('g-live')
      expect(body.session).toMatchObject({ id, groupId: 'g-live' })
      expect(rowOf(id)).toMatchObject({
        deleted_at: null,
        group_id: 'g-live',
        updated_at: '2020-01-01 00:00:00',
      })
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_RESTORED, {
        groupId: 'g-live',
        sessions: [expect.objectContaining({ id, groupId: 'g-live' })],
      })

      // 会话仍属已删组（组软删但会话未进组批次）→ 恢复落未分组
      const id2 = await newSession('原组已删')
      insertGroup('g-dead', '已删组', '2026-01-02T00:00:00.000Z')
      getDb().prepare("UPDATE sessions SET group_id = 'g-dead' WHERE id = ?").run(id2)
      await app.inject({ method: 'DELETE', url: `/api/sessions/${id2}` })
      const res2 = await app.inject({ method: 'POST', url: `/api/sessions/${id2}/restore` })
      expect(res2.statusCode).toBe(200)
      expect(JSON.parse(res2.body).groupId).toBeNull()

      // 过期 → 404（列表也已滤掉）
      const id3 = await newSession('过期')
      setDeletedAt(id3, new Date(Date.now() - 8 * DAY).toISOString())
      expect(
        (await app.inject({ method: 'POST', url: `/api/sessions/${id3}/restore` })).statusCode
      ).toBe(404)
      expect(await trashIds()).not.toContain(id3)
    })

    it('彻底删除：活会话 409；已删会话连同消息 / 执行日志 / 依赖行一起消失', async () => {
      const id = await newSession('彻底删除')
      const db = getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hi')"
      ).run(id)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
         VALUES ('log1', ?, ?, 'm1', 'completed')`
      ).run(id, agentId1)

      expect(
        (await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/purge` })).statusCode
      ).toBe(409)

      await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      const engine = stubEngine([])
      setExecutionEngine(engine)
      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/purge` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ id })
      expect(engine.disposeSession).toHaveBeenCalledTimes(1)
      expect(engine.disposeSession).toHaveBeenCalledWith(id)
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(id)).toEqual({
        n: 0,
      })
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(id)).toEqual(
        { n: 0 }
      )
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM execution_logs WHERE session_id = ?').get(id)
      ).toEqual({ n: 0 })
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_PURGED, {
        sessionIds: [id],
        groupIds: [],
      })
      // 已清除 = 不存在，再删除 404
      expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })).statusCode).toBe(
        404
      )
    })

    it('整组条目成员：单条 restore / purge / DELETE 全部 409 SESSION_IN_TRASH_GROUP', async () => {
      const id = await newSession('组条目成员')
      const ts = '2026-01-02T00:00:00.000Z'
      insertGroup('g-trash', '已删组', ts)
      getDb()
        .prepare("UPDATE sessions SET group_id = 'g-trash', deleted_at = ? WHERE id = ?")
        .run(ts, id)

      for (const [method, url] of [
        ['POST', `/api/sessions/${id}/restore`],
        ['DELETE', `/api/sessions/${id}/purge`],
        ['DELETE', `/api/sessions/${id}`],
      ] as const) {
        const res = await app.inject({ method, url })
        expect(res.statusCode, `${method} ${url}`).toBe(409)
        expect(JSON.parse(res.body)).toMatchObject({
          error: 'SESSION_IN_TRASH_GROUP',
          groupId: 'g-trash',
        })
      }
      // 一条都没被改
      expect(rowOf(id)).toMatchObject({ deleted_at: ts, group_id: 'g-trash' })
    })

    it('清空回收站：组条目连同等批会话、单个会话条目全部消失', async () => {
      const ts = '2026-01-02T00:00:00.000Z'
      insertGroup('g-clear', '清空组', ts)
      const inGroup = await newSession('组内')
      getDb()
        .prepare("UPDATE sessions SET group_id = 'g-clear', deleted_at = ? WHERE id = ?")
        .run(ts, inGroup)
      const single = await newSession('单个')
      await app.inject({ method: 'DELETE', url: `/api/sessions/${single}` })

      const engine = stubEngine([])
      setExecutionEngine(engine)
      const res = await app.inject({ method: 'DELETE', url: '/api/trash' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ purged: { groups: 1, sessions: 2 } })
      expect(engine.disposeSession).toHaveBeenCalledTimes(2)
      expect(engine.disposeSession).toHaveBeenCalledWith(inGroup)
      expect(engine.disposeSession).toHaveBeenCalledWith(single)
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM session_groups').get()).toEqual({ n: 0 })
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_PURGED, {
        sessionIds: expect.arrayContaining([inGroup, single]),
        groupIds: ['g-clear'],
      })
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})
    })
  })

  describe('DELETE /api/sessions/:id (旧物理删除用例已由 T2 回收站替换)', () => {
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

  // ─── T1 同会话回退 ─────────────────────────────────
  //
  // 组装式：真 SQLite（FK 生效，见 test-helpers 的 createTestDb）+ 真 Fastify handler。
  // 引擎是**桩**（回退只消费 snapshot/abortAgent/cancelQueuedCommand 三个面，起真引擎
  // 要拉 LLM 适配器与槽位工厂，与本票判据无关）。
  describe('POST /api/sessions/:id/rollback（T1 同会话回退）', () => {
    const T = (n: number) => `2026-09-01T10:00:${String(n).padStart(2, '0')}.000Z`

    /** 直插消息（绕开 socket 发送链——本组只测回退的删除语义，不测写入路径） */
    function seedMessage(id: string, sessionId: string, role: string, sec: number): void {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, sessionId, role === 'agent' ? agentId1 : null, role, `内容 ${id}`, T(sec))
    }

    async function newSession(title: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title, agentIds: [agentId1] },
      })
      return JSON.parse(res.body).id
    }

    /** 最小引擎桩：只实现回退会碰的三个方法，其余留给 as unknown 断言 */
    function stubEngine(slots: Array<Record<string, unknown>>) {
      return {
        snapshot: () => slots,
        abortAgent: vi.fn(() => true),
        cancelQueuedCommand: vi.fn(() => 0),
        disposeSession: vi.fn(),
      } as unknown as ExecutionEngine & ExecutionEngineTestHooks
    }

    afterEach(() => {
      __resetEngine()
    })

    it('回退后 messages 只剩目标及之前——目标本身保留', async () => {
      const sid = await newSession('回退-只剩目标及之前')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('m2', sid, 'agent', 1)
      seedMessage('m3', sid, 'user', 2)
      seedMessage('m4', sid, 'agent', 3)

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'm2' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.removedIds).toEqual(['m3', 'm4'])
      expect(body.removedCount).toBe(2)

      const left = getDb()
        .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .all(sid) as Array<{ id: string }>
      expect(left.map((r) => r.id)).toEqual(['m1', 'm2'])
    })

    it('关联 execution_logs 一并清理——只清被删消息引用到的那些（存活侧不动）', async () => {
      const sid = await newSession('回退-执行日志')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('m2', sid, 'agent', 1)
      seedMessage('m3', sid, 'user', 2)
      seedMessage('m4', sid, 'agent', 3)
      const db = getDb()
      const insLog = db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, message_id)
         VALUES (?, ?, ?, ?, 'completed', ?)`
      )
      insLog.run('log-survives', sid, agentId1, 'm1', 'm2')
      insLog.run('log-doomed', sid, agentId1, 'm3', 'm4')

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'm2' },
      })
      expect(res.statusCode).toBe(200)

      const logs = db
        .prepare('SELECT id FROM execution_logs WHERE session_id = ?')
        .all(sid) as Array<{ id: string }>
      expect(logs.map((r) => r.id)).toEqual(['log-survives'])
    })

    it('welcome 伪消息（welcome-<sessionId>，从不落库）作为目标 → 4xx', async () => {
      const sid = await newSession('回退-welcome')
      seedMessage('m1', sid, 'user', 0)

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: `welcome-${sid}` },
      })
      // 4xx 即可（票面口径）：它不在 messages 表里，404 与「不是可回退目标」同判据
      expect(res.statusCode).toBeGreaterThanOrEqual(400)
      expect(res.statusCode).toBeLessThan(500)
      // 未误删任何东西
      const left = getDb().prepare('SELECT id FROM messages WHERE session_id = ?').all(sid)
      expect(left).toHaveLength(1)
    })

    it('running 执行先停再删：abortAgent 带 sessionId，排队命令按 doomed 逐条取消', async () => {
      const sid = await newSession('回退-先停')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('m2', sid, 'agent', 1)
      seedMessage('m3', sid, 'user', 2)
      const engine = stubEngine([
        // 正在跑「即将被删」的 m3 → 必须 abort
        {
          agentId: agentId1,
          sessionId: sid,
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'm3',
        },
        // 别的会话在跑 → 不受影响
        {
          agentId: agentId2,
          sessionId: 'other-session',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'm3',
        },
        // 本会话但跑的是存活消息 → 不停
        {
          agentId: agentId2,
          sessionId: sid,
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'm1',
        },
      ])
      setExecutionEngine(engine)

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'm2' },
      })
      expect(res.statusCode).toBe(200)
      expect(engine.abortAgent).toHaveBeenCalledTimes(1)
      expect(engine.abortAgent).toHaveBeenCalledWith(agentId1, sid)
      expect(engine.cancelQueuedCommand).toHaveBeenCalledWith('m3')
    })

    it('目标是末尾 → 0 删除、仍然 200（空集不开事务也不报错）', async () => {
      const sid = await newSession('回退-末尾')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('m2', sid, 'agent', 1)

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'm2' },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).removedCount).toBe(0)
      const left = getDb().prepare('SELECT id FROM messages WHERE session_id = ?').all(sid)
      expect(left).toHaveLength(2)
    })

    it('目标不存在 → 404；目标属于别的会话 → 404（不跨会话删）', async () => {
      const sid = await newSession('回退-A')
      const other = await newSession('回退-B')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('x1', other, 'user', 0)
      seedMessage('x2', other, 'agent', 1)

      const missing = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'nope' },
      })
      expect(missing.statusCode).toBe(404)

      const cross = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'x1' },
      })
      expect(cross.statusCode).toBe(404)
      // 别的会话一行没少
      const otherLeft = getDb().prepare('SELECT id FROM messages WHERE session_id = ?').all(other)
      expect(otherLeft).toHaveLength(2)
    })

    it('会话不存在 → 404；body 缺 messageId → 400', async () => {
      const sid = await newSession('回退-参数')
      seedMessage('m1', sid, 'user', 0)

      const noSession = await app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/rollback',
        payload: { messageId: 'm1' },
      })
      expect(noSession.statusCode).toBe(404)

      const noBody = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: {},
      })
      expect(noBody.statusCode).toBe(400)
    })

    it('广播发到**会话房间**且带权威 removedIds（前端按 id 删，不自己重算）', async () => {
      const sid = await newSession('回退-广播')
      seedMessage('m1', sid, 'user', 0)
      seedMessage('m2', sid, 'agent', 1)
      seedMessage('m3', sid, 'user', 2)
      mockRoomEmit.mockClear()

      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/rollback`,
        payload: { messageId: 'm1' },
      })

      expect(mockRoomEmit).toHaveBeenCalledTimes(1)
      const [event, payload] = mockRoomEmit.mock.calls[0] as [string, Record<string, unknown>]
      expect(event).toBe(Events.SESSION_ROLLED_BACK)
      expect(payload).toMatchObject({
        sessionId: sid,
        messageId: 'm1',
        removedIds: ['m2', 'm3'],
        removedCount: 2,
      })
    })
  })

  // ─── 右栏历史面板：facets / search（两个只读端点）───────────────

  describe('GET /api/sessions/:id/messages/facets', () => {
    let sid = ''

    const seed = (
      id: string,
      role: 'user' | 'agent' | 'system',
      content: string,
      createdAt: string,
      agentId: string | null = null
    ) => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?)`
        )
        .run(id, sid, agentId, role, content, createdAt)
    }

    beforeEach(async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '历史 facets', agentIds: [agentId1] },
      })
      sid = JSON.parse(create.body).id
      seed('f1', 'user', '晚间', '2026-11-12T22:30:00.000Z')
      seed('f2', 'agent', '清晨', '2026-11-12T01:00:00.000Z', agentId1)
      seed('f3', 'system', '重启完成', '2026-11-01T03:00:00.000Z')
    })

    it('UTC 22:30 在 tzOffset=480 落 11-13、在 0 落 11-12；days DESC；total 含 system', async () => {
      const sh = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=480`,
      })
      expect(sh.statusCode).toBe(200)
      expect(JSON.parse(sh.body)).toEqual({
        total: 3,
        days: [
          { date: '2026-11-13', count: 1 },
          { date: '2026-11-12', count: 1 },
          { date: '2026-11-01', count: 1 },
        ],
        months: [{ month: '2026-11' }],
      })

      const utc = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=0`,
      })
      const body = JSON.parse(utc.body)
      expect(body.days[0]).toEqual({ date: '2026-11-12', count: 2 })
      expect(body.total).toBe(3)
    })

    it('边界：9999 clamp 到 840；非数字 → 400 且 reason 可诊断', async () => {
      const clamped = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=9999`,
      })
      const at840 = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=840`,
      })
      expect(clamped.statusCode).toBe(200)
      expect(JSON.parse(clamped.body)).toEqual(JSON.parse(at840.body))

      const bad = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=abc`,
      })
      expect(bad.statusCode).toBe(400)
      expect(JSON.parse(bad.body).error).toContain('tzOffset')
    })

    it('会话不存在 → 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/messages/facets',
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /api/sessions/:id/messages/search', () => {
    let sid = ''

    const seed = (
      id: string,
      role: 'user' | 'agent' | 'system',
      content: string,
      createdAt: string,
      agentId: string | null = null
    ) => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?)`
        )
        .run(id, sid, agentId, role, content, createdAt)
    }

    beforeEach(async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '历史 search', agentIds: [agentId1, agentId2] },
      })
      sid = JSON.parse(create.body).id
      seed('q1', 'user', '进度 100% 了', '2026-11-10T10:00:00.000Z')
      seed('q2', 'user', '进度 100x 了', '2026-11-10T10:01:00.000Z')
      seed('q3', 'agent', '文件 a_b 已生成', '2026-11-10T10:02:00.000Z', agentId1)
      seed('q4', 'user', '文件 axb 不存在', '2026-11-10T10:03:00.000Z')
      seed('q5', 'agent', '路径 C:\\tmp 可用', '2026-11-10T10:04:00.000Z', agentId2)
      seed('q6', 'user', '路径 C:tmp 不存在', '2026-11-10T10:05:00.000Z')
    })

    it('q 校验：缺失 / 空白 / 201 字符 → 400 且 reason 可诊断', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search`,
      })
      expect(missing.statusCode).toBe(400)
      expect(JSON.parse(missing.body).error).toContain('q')

      const blank = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('   ')}`,
      })
      expect(blank.statusCode).toBe(400)

      const long = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${'x'.repeat(201)}`,
      })
      expect(long.statusCode).toBe(400)
      expect(JSON.parse(long.body).error).toContain('200')
    })

    it('limit 夹取：0 → 1；1000 → 100', async () => {
      for (let i = 0; i < 120; i++) {
        const hh = String(i % 24).padStart(2, '0')
        const ss = String(i % 10).padStart(2, '0')
        seed(`many-${i}`, 'user', `批量命中 ${i}`, `2026-11-11T${hh}:00:${ss}.000Z`)
      }
      const one = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('批量命中')}&limit=0`,
      })
      expect(JSON.parse(one.body).rows).toHaveLength(1)

      const capped = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('批量命中')}&limit=1000`,
      })
      const cappedBody = JSON.parse(capped.body)
      expect(cappedBody.rows).toHaveLength(100)
      expect(cappedBody.total).toBe(120)
    })

    it('转义语料：100% / a_b / C:\\tmp 都只命中字面量', async () => {
      const ids = async (q: string) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent(q)}`,
        })
        return JSON.parse(res.body).rows.map((r: any) => r.id)
      }
      expect(await ids('100%')).toEqual(['q1'])
      expect(await ids('a_b')).toEqual(['q3'])
      expect(await ids('C:\\tmp')).toEqual(['q5'])
    })

    it('total 不受 before 影响（rows 变少、total 不变）；limit=1 时 total 仍全量', async () => {
      const all = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('文件')}`,
      })
      expect(JSON.parse(all.body).total).toBe(2)

      const before = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('文件')}&before=q4`,
      })
      const beforeBody = JSON.parse(before.body)
      expect(beforeBody.rows.map((r: any) => r.id)).toEqual(['q3'])
      expect(beforeBody.total).toBe(2)

      const limited = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('文件')}&limit=1`,
      })
      const limitedBody = JSON.parse(limited.body)
      expect(limitedBody.rows).toHaveLength(1)
      expect(limitedBody.total).toBe(2)
    })

    it('投影逐字一致：同一条消息在 /messages 与 /search 的键集与值完全相等', async () => {
      getDb()
        .prepare(
          `INSERT INTO messages
             (id, session_id, agent_id, role, content, mentions, images, thinking_content, tool_content, task_id, created_at)
           VALUES ('proj-1', ?, ?, 'agent', '带全字段的回复', '["店长阿暹"]', '["data:image/png;base64,AAA"]',
                   '想过', '[{"id":"c1","name":"t","status":"completed"}]', 'task-1', '2026-11-10T11:00:00.000Z')`
        )
        .run(sid, agentId1)

      const list = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/sessions/${sid}/messages` })).body
      ) as any[]
      const search = JSON.parse(
        (
          await app.inject({
            method: 'GET',
            url: `/api/sessions/${sid}/messages/search?q=${encodeURIComponent('带全字段')}`,
          })
        ).body
      ).rows as any[]

      const a = list.find((m) => m.id === 'proj-1')!
      const b = search.find((m) => m.id === 'proj-1')!
      expect(b).toEqual(a)
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
      expect(b.images).toEqual(['data:image/png;base64,AAA'])
      expect(b.taskId).toBe('task-1')
    })

    it('会话不存在 → 404；before 为空串 → 400', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/messages/search?q=x',
      })
      expect(missing.statusCode).toBe(404)

      const emptyBefore = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/search?q=文件&before=`,
      })
      expect(emptyBefore.statusCode).toBe(400)
    })
  })

  // ─── 右栏历史面板：默认列表（browse，含 system）───────────────

  describe('GET /api/sessions/:id/messages/browse', () => {
    let sid = ''

    const seed = (
      id: string,
      role: 'user' | 'agent' | 'system',
      content: string,
      createdAt: string,
      agentId: string | null = null
    ) => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?)`
        )
        .run(id, sid, agentId, role, content, createdAt)
    }

    beforeEach(async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '历史 browse', agentIds: [agentId1] },
      })
      sid = JSON.parse(create.body).id
      seed('br-1', 'user', '第一条', '2026-11-10T10:00:00.000Z')
      seed('br-2', 'agent', '第二条', '2026-11-10T10:01:00.000Z', agentId1)
      seed('br-3', 'system', '重启完成', '2026-11-01T03:00:00.000Z')
    })

    it('含 system；total = 窗口内全量，before/limit 只收窄 rows', async () => {
      const all = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse`,
      })
      expect(all.statusCode).toBe(200)
      const body = JSON.parse(all.body)
      expect(body.total).toBe(3)
      expect(body.rows.map((r: any) => r.id)).toEqual(['br-2', 'br-1', 'br-3'])
      expect(body.rows.some((r: any) => r.role === 'system')).toBe(true)

      const one = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?limit=1`,
      })
      const oneBody = JSON.parse(one.body)
      expect(oneBody.rows.map((r: any) => r.id)).toEqual(['br-2'])
      expect(oneBody.total).toBe(3)

      const before = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?before=br-2`,
      })
      const beforeBody = JSON.parse(before.body)
      expect(beforeBody.rows.map((r: any) => r.id)).toEqual(['br-1', 'br-3'])
      expect(beforeBody.total).toBe(3)
    })

    it('system-only 日：facets 计数与 browse 列表同一口径（不会「写 1 条、点进去空」）', async () => {
      const facets = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/facets?tzOffset=0`,
      })
      const day = JSON.parse(facets.body).days.find((d: any) => d.date === '2026-11-01')
      expect(day).toEqual({ date: '2026-11-01', count: 1 })

      const browse = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?from=${encodeURIComponent(
          '2026-11-01T00:00:00.000Z'
        )}&to=${encodeURIComponent('2026-11-01T23:59:59.999Z')}`,
      })
      const body = JSON.parse(browse.body)
      expect(body.rows.map((r: any) => r.id)).toEqual(['br-3'])
      expect(body.total).toBe(1)
    })

    it('before/from/to 为空串 → 400；会话不存在 → 404', async () => {
      const emptyBefore = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?before=`,
      })
      expect(emptyBefore.statusCode).toBe(400)

      const emptyFrom = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?from=`,
      })
      expect(emptyFrom.statusCode).toBe(400)
      expect(JSON.parse(emptyFrom.body).error).toContain('from')

      const emptyTo = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?to=`,
      })
      expect(emptyTo.statusCode).toBe(400)
      expect(JSON.parse(emptyTo.body).error).toContain('to')

      const missing = await app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/messages/browse',
      })
      expect(missing.statusCode).toBe(404)
    })

    it('limit clamp：0 → 1 条、1000 → 100 条（seed 105 条真钉上界）', async () => {
      // beforeEach 已 seed 3 条；再补 102 条凑 105（时间递增，确保排序确定）
      const base = Date.parse('2026-11-09T00:00:00.000Z')
      for (let i = 4; i <= 105; i += 1) {
        seed(`br-${i}`, 'user', `第 ${i} 条`, new Date(base + i * 60_000).toISOString())
      }

      const zero = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?limit=0`,
      })
      expect(zero.statusCode).toBe(200)
      const zeroBody = JSON.parse(zero.body)
      expect(zeroBody.rows).toHaveLength(1)
      expect(zeroBody.total).toBe(105)

      // 端点自己必须把上界压到 100：仓库层 `clampLimit` 也夹 [1,100]，只看 rows 条数时
      // 两层任一层都能兜住（端点写成 1000 仍绿）；故同时断言传给仓库的 limit 已是 100。
      const limitSpy = vi.spyOn(messageSearch, 'listSessionMessages')
      const thousand = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/messages/browse?limit=1000`,
      })
      expect(thousand.statusCode).toBe(200)
      const thousandBody = JSON.parse(thousand.body)
      expect(thousandBody.rows).toHaveLength(100)
      expect(thousandBody.total).toBe(105)
      expect(limitSpy).toHaveBeenCalledWith(sid, expect.objectContaining({ limit: 100 }))
      limitSpy.mockRestore()
    })
  })
})

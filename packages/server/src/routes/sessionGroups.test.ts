/**
 * 会话分组路由（T1）：GET/POST/PATCH/DELETE（仅解散）。
 *
 * `?withSessions=1` 是 T2 的契约（组软删 + 会话进回收站），本票显式 400 而不是静默按
 * 「仅解散」处理——测试把这条边界钉住，防 T2 接手时以为它已经半实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'
import { Events } from '@cat-study/shared'
import { setExecutionEngine, __test_reset as __resetEngine } from '../execution/registry.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from '../execution/serial.js'

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }))

vi.mock('../connectors/socketio.js', () => ({
  getIO: vi.fn(() => ({ emit: mockEmit })),
  createSocketIO: vi.fn(),
}))

describe('Session Group Routes（T1）', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    const { sessionGroupRoutes } = await import('./sessionGroups.js')
    await app.register(sessionGroupRoutes)
    // `/api/sessions/trash` 属于会话路由；组条目的回收站断言要真读这条端点
    const { sessionRoutes } = await import('./sessions.js')
    await app.register(sessionRoutes)
    mockEmit.mockClear()
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  const insertSession = (
    id: string,
    groupId: string | null = null,
    deletedAt: string | null = null
  ) => {
    getDb()
      .prepare(`INSERT INTO sessions (id, title, group_id, deleted_at) VALUES (?, ?, ?, ?)`)
      .run(id, `会话 ${id}`, groupId, deletedAt)
  }

  const createGroup = async (name: string): Promise<{ id: string }> => {
    const res = await app.inject({ method: 'POST', url: '/api/session-groups', payload: { name } })
    expect(res.statusCode).toBe(201)
    return JSON.parse(res.body)
  }

  describe('GET /api/session-groups', () => {
    it('空库 → { groups: [] }', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/session-groups' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ groups: [] })
    })

    it('返回活组（created_at ASC）+ sessionCount（不含已删会话）', async () => {
      const a = await createGroup('先建的')
      const b = await createGroup('后建的')
      // createGroup 的 created_at 可能同毫秒 → 显式拉开，测的是排序不是时间生成
      const db = getDb()
      db.prepare(
        `UPDATE session_groups SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`
      ).run(a.id)
      db.prepare(
        `UPDATE session_groups SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = ?`
      ).run(b.id)
      insertSession('s1', a.id)
      insertSession('s2', a.id)
      insertSession('s-trash', a.id, '2026-01-03T00:00:00.000Z')

      const res = await app.inject({ method: 'GET', url: '/api/session-groups' })
      const groups = JSON.parse(res.body).groups as Array<{
        id: string
        name: string
        collapsed: boolean
        sessionCount: number
      }>
      expect(groups.map((g) => g.id)).toEqual([a.id, b.id])
      expect(groups[0]).toMatchObject({ name: '先建的', collapsed: false, sessionCount: 2 })
      expect(groups[1]).toMatchObject({ name: '后建的', collapsed: false, sessionCount: 0 })
    })
  })

  describe('POST /api/session-groups', () => {
    it('建组：trim 名字、返回 201 + SessionGroup、全局广播 GROUPS_CHANGED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/session-groups',
        payload: { name: '  小说连载  ' },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.name).toBe('小说连载')
      expect(body.collapsed).toBe(false)
      expect(body.sessionCount).toBe(0)
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})
    })

    it('名字非法：空 / 全空白 / 25 字 / 非字符串 → 400', async () => {
      for (const name of ['', '   ', '字'.repeat(25), 123, null]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/session-groups',
          payload: { name },
        })
        expect(res.statusCode, JSON.stringify(name)).toBe(400)
        expect(JSON.parse(res.body).error).toBe('GROUP_NAME_INVALID')
      }
    })

    it('重名 → 409 GROUP_NAME_TAKEN（活组名唯一）', async () => {
      await createGroup('同名')
      const res = await app.inject({
        method: 'POST',
        url: '/api/session-groups',
        payload: { name: '同名' },
      })
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toEqual({ error: 'GROUP_NAME_TAKEN' })
    })
  })

  describe('PATCH /api/session-groups/:id', () => {
    it('改名 + 折叠都生效并落库；广播 GROUPS_CHANGED', async () => {
      const g = await createGroup('旧名')
      mockEmit.mockClear()

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/session-groups/${g.id}`,
        payload: { name: '新名', collapsed: true },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toMatchObject({ id: g.id, name: '新名', collapsed: true })
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})

      const db = getDb()
      expect(
        db.prepare(`SELECT name, collapsed FROM session_groups WHERE id = ?`).get(g.id)
      ).toEqual({ name: '新名', collapsed: 1 })
    })

    it('重名 → 409，原名不被改（就地报错语义）', async () => {
      await createGroup('已占用')
      const g = await createGroup('待改名')

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/session-groups/${g.id}`,
        payload: { name: '已占用' },
      })
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toEqual({ error: 'GROUP_NAME_TAKEN' })
      expect(
        (
          getDb().prepare(`SELECT name FROM session_groups WHERE id = ?`).get(g.id) as {
            name: string
          }
        ).name
      ).toBe('待改名')
    })

    it('组不存在 → 404；非法名字 / 非布尔 collapsed → 400', async () => {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/session-groups/nope',
            payload: { name: 'x' },
          })
        ).statusCode
      ).toBe(404)

      const g = await createGroup('校验')
      for (const payload of [{ name: '' }, { collapsed: 'yes' }]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/session-groups/${g.id}`,
          payload,
        })
        expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      }
    })
  })

  describe('DELETE /api/session-groups/:id（仅解散）', () => {
    it('组行消失、会话 group_id=NULL、deleted_at 仍 NULL；广播 GROUPS_CHANGED', async () => {
      const g = await createGroup('待解散')
      insertSession('s-in', g.id)
      mockEmit.mockClear()

      const res = await app.inject({ method: 'DELETE', url: `/api/session-groups/${g.id}` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ mode: 'dissolve', id: g.id })
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})

      const db = getDb()
      expect(db.prepare(`SELECT 1 FROM session_groups WHERE id = ?`).get(g.id)).toBeUndefined()
      expect(
        db.prepare(`SELECT group_id, deleted_at FROM sessions WHERE id = 's-in'`).get()
      ).toEqual({ group_id: null, deleted_at: null })
    })

    it('组不存在 → 404', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/session-groups/nope' })
      expect(res.statusCode).toBe(404)
    })
  })

  // ═══ T2 · 整组删除 / 恢复 / 彻底删除 ═════════════════════════════
  describe('T2 回收站（组条目）', () => {
    const DAY = 24 * 60 * 60 * 1000
    /** 未过期（列表 / 恢复接口都按 7 天过滤） */
    const TS = new Date(Date.now() - 1 * DAY).toISOString()

    const insertGroupRow = (id: string, name: string, deletedAt: string | null = null) => {
      getDb()
        .prepare(
          `INSERT INTO session_groups (id, name, created_at, updated_at, deleted_at)
           VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
        )
        .run(id, name, deletedAt)
    }

    /** 把一个活组连同其未删会话打进回收站（不经路由，直接造批次夹具） */
    const makeTrashedGroup = (groupId: string, sessionIds: string[], deletedAt = TS) => {
      getDb()
        .prepare(`UPDATE session_groups SET deleted_at = ?, updated_at = ? WHERE id = ?`)
        .run(deletedAt, deletedAt, groupId)
      for (const sid of sessionIds) {
        getDb()
          .prepare(`UPDATE sessions SET group_id = ?, deleted_at = ? WHERE id = ?`)
          .run(groupId, deletedAt, sid)
      }
    }

    const groupRow = (id: string) =>
      getDb().prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as
        { name: string; deleted_at: string | null; updated_at: string } | undefined

    function stubEngine(slots: Array<Record<string, unknown>>) {
      return {
        snapshot: () => slots,
        abortAgent: vi.fn(() => true),
        cancelQueuedCommand: vi.fn(() => 0),
      } as unknown as ExecutionEngine & ExecutionEngineTestHooks
    }

    afterEach(() => {
      __resetEngine()
    })

    it('withSessions=1：组与未删会话打**同一时间戳**，组 id 不变，早先单删不跟批', async () => {
      const g = await createGroup('整组删')
      insertSession('s-live-a', g.id)
      insertSession('s-live-b', g.id)
      insertSession('s-earlier', g.id, '2026-01-01T00:00:00.000Z')
      mockEmit.mockClear()

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/session-groups/${g.id}?withSessions=1`,
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ mode: 'trash', id: g.id })

      const db = getDb()
      const group = db.prepare('SELECT * FROM session_groups WHERE id = ?').get(g.id) as {
        deleted_at: string
      }
      const rows = db
        .prepare('SELECT id, deleted_at FROM sessions WHERE group_id = ? ORDER BY id')
        .all(g.id) as Array<{ id: string; deleted_at: string }>
      expect(group.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      // 同批两个会话时间戳与组精确相等
      expect(rows.find((r) => r.id === 's-live-a')?.deleted_at).toBe(group.deleted_at)
      expect(rows.find((r) => r.id === 's-live-b')?.deleted_at).toBe(group.deleted_at)
      // 早先单删的时间戳不变（不同批）
      expect(rows.find((r) => r.id === 's-earlier')?.deleted_at).toBe('2026-01-01T00:00:00.000Z')

      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_TRASHED, {
        sessionIds: expect.arrayContaining(['s-live-a', 's-live-b']),
        groupIds: [g.id],
      })
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})

      // /trash 只出现一条组条目，同批成员不在「单个会话」段重复出现
      const trash = await app.inject({ method: 'GET', url: '/api/sessions/trash' })
      const entries = JSON.parse(trash.body).entries as Array<Record<string, any>>
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'group',
        id: g.id,
        name: '整组删',
        sessionCount: 2,
        groupId: null,
      })
    })

    it('withSessions=1 有忙碌成员 → 409 且组与会话一行都没改', async () => {
      const g = await createGroup('有忙的')
      insertSession('s-busy', g.id)
      insertSession('s-idle', g.id)
      setExecutionEngine(
        stubEngine([
          { agentId: 'a1', sessionId: 's-busy', status: 'busy', queueLength: 0 },
          // idle 槽位留 sessionId 不算忙
          { agentId: 'a2', sessionId: 's-idle', status: 'idle', queueLength: 0 },
        ])
      )

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/session-groups/${g.id}?withSessions=1`,
      })
      expect(res.statusCode).toBe(409)
      const body = JSON.parse(res.body)
      expect(body.error).toBe('SESSION_BUSY')
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0]).toMatchObject({ id: 's-busy', reason: 'busy' })
      expect(groupRow(g.id)?.deleted_at).toBeNull()
      expect(
        (
          getDb().prepare(`SELECT deleted_at FROM sessions WHERE id = 's-idle'`).get() as {
            deleted_at: string | null
          }
        ).deleted_at
      ).toBeNull()
    })

    it('withSessions=1 但组内零未删会话 → 降级仅解散，不产生空组条目', async () => {
      const g = await createGroup('空组')
      insertSession('s-gone', g.id, TS)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/session-groups/${g.id}?withSessions=1`,
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ mode: 'dissolve', id: g.id })
      expect(groupRow(g.id)).toBeUndefined()
      expect(
        (
          getDb().prepare(`SELECT group_id FROM sessions WHERE id = 's-gone'`).get() as {
            group_id: string | null
          }
        ).group_id
      ).toBeNull()
      // 早先单删的会话仍在回收站（不复活、也不被解散删掉）
      const trash = await app.inject({ method: 'GET', url: '/api/sessions/trash' })
      expect((JSON.parse(trash.body).entries as Array<{ id: string }>).map((e) => e.id)).toContain(
        's-gone'
      )
    })

    it('整组恢复：只清同批、早先单删不复活；组 updated_at 更新', async () => {
      insertGroupRow('g-back', '恢复组')
      insertSession('s-batch', 'g-back')
      insertSession('s-earlier', 'g-back', '2026-01-01T00:00:00.000Z')
      makeTrashedGroup('g-back', ['s-batch'])
      mockEmit.mockClear()

      const res = await app.inject({ method: 'POST', url: '/api/session-groups/g-back/restore' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.group).toMatchObject({ id: 'g-back', name: '恢复组', sessionCount: 1 })
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0]).toMatchObject({ id: 's-batch', groupId: 'g-back' })

      expect(groupRow('g-back')?.deleted_at).toBeNull()
      const rows = getDb()
        .prepare('SELECT id, deleted_at FROM sessions WHERE group_id = ? ORDER BY id')
        .all('g-back') as Array<{ id: string; deleted_at: string | null }>
      expect(rows.find((r) => r.id === 's-batch')?.deleted_at).toBeNull()
      // 早先单删的会话仍已删（不随整组恢复复活）
      expect(rows.find((r) => r.id === 's-earlier')?.deleted_at).toBe('2026-01-01T00:00:00.000Z')
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_RESTORED, {
        groupId: 'g-back',
        sessions: [expect.objectContaining({ id: 's-batch' })],
      })
      expect(mockEmit).toHaveBeenCalledWith(Events.GROUPS_CHANGED, {})
    })

    it('恢复重名：先改名 name（恢复）再清 deleted_at；大小写不同也算重名', async () => {
      await createGroup('同名组')
      insertGroupRow('g-dup', '同名组', TS)
      insertSession('s-dup', 'g-dup')
      makeTrashedGroup('g-dup', ['s-dup'])

      const res = await app.inject({ method: 'POST', url: '/api/session-groups/g-dup/restore' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).group.name).toBe('同名组（恢复）')
      expect(groupRow('g-dup')?.deleted_at).toBeNull()

      // 大小写不同也算重名（COLLATE NOCASE）
      const a = await createGroup('Work')
      const b = await app.inject({
        method: 'POST',
        url: '/api/session-groups',
        payload: { name: 'work' },
      })
      expect(b.statusCode).toBe(409)
      expect(JSON.parse(b.body)).toEqual({ error: 'GROUP_NAME_TAKEN' })
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/session-groups/${a.id}`,
        payload: { name: 'WORK' },
      })
      expect(renamed.statusCode).toBe(200)
    })

    it('彻底删除组条目：组行 + 同批会话消失，早先单删的会话仍在', async () => {
      insertGroupRow('g-purge', '清除组')
      insertSession('s-batch', 'g-purge')
      insertSession('s-earlier', 'g-purge', '2026-01-01T00:00:00.000Z')
      makeTrashedGroup('g-purge', ['s-batch'])
      mockEmit.mockClear()

      const res = await app.inject({ method: 'DELETE', url: '/api/session-groups/g-purge/purge' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ id: 'g-purge' })
      expect(groupRow('g-purge')).toBeUndefined()
      expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-batch')).toBeUndefined()
      // 早先单删的会话属会话条目，不随组条目清除
      expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-earlier')).toBeDefined()
      expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_PURGED, {
        sessionIds: ['s-batch'],
        groupIds: ['g-purge'],
      })
    })

    it('彻底删除活组 → 409 GROUP_NOT_TRASHED', async () => {
      const g = await createGroup('还活着')
      const res = await app.inject({ method: 'DELETE', url: `/api/session-groups/${g.id}/purge` })
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toEqual({ error: 'GROUP_NOT_TRASHED' })
    })
  })
})

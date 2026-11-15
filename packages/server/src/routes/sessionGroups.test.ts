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

    it('?withSessions=1 → 400 SESSION_TRASH_NOT_AVAILABLE（T2 契约，不静默降级成仅解散）', async () => {
      const g = await createGroup('别静默')
      insertSession('s-in', g.id)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/session-groups/${g.id}?withSessions=1`,
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'SESSION_TRASH_NOT_AVAILABLE' })
      // 一行都没改
      expect(getDb().prepare(`SELECT 1 FROM session_groups WHERE id = ?`).get(g.id)).toBeDefined()
      expect(
        (
          getDb().prepare(`SELECT group_id FROM sessions WHERE id = 's-in'`).get() as {
            group_id: string | null
          }
        ).group_id
      ).toBe(g.id)
    })
  })
})

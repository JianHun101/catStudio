/**
 * sessionGroups repo — 分组 CRUD / 仅解散 / 会话计数（T1）。
 *
 * 软删语义（deleted_at 写入、恢复、彻底删除）是 T2 的面；本文件只钉 T1 交付的
 * 「活组」行为与两个不变量：组名唯一只约束活组、会话计数不含已删会话。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb } from '../index.js'
import { initRepository } from './index.js'
import { sessionGroups as groupsRepo } from './index.js'

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('sessionGroups repo — 分组 CRUD（T1）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
  })

  afterEach(() => {
    resetDb()
  })

  const insertSession = (id: string, groupId: string | null, deletedAt: string | null = null) => {
    db.prepare(
      `INSERT INTO sessions (id, title, group_id, deleted_at) VALUES (?, 'test', ?, ?)`
    ).run(id, groupId, deletedAt)
  }

  const insertGroup = (id: string, name: string, createdAt: string) => {
    db.prepare(
      `INSERT INTO session_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, name, createdAt, createdAt)
  }

  it('createGroup 落 ISO 毫秒时间 + 默认不折叠；getGroupById / getGroupByName 读回', () => {
    const created = groupsRepo.createGroup('g1', '小说连载')
    expect(created.name).toBe('小说连载')
    expect(created.collapsed).toBe(0)
    expect(created.deleted_at).toBeNull()
    expect(created.created_at).toMatch(ISO_MS)
    expect(created.updated_at).toMatch(ISO_MS)

    expect(groupsRepo.getGroupById('g1')?.name).toBe('小说连载')
    expect(groupsRepo.getGroupByName('小说连载')?.id).toBe('g1')
    expect(groupsRepo.getGroupByName('不存在')).toBeUndefined()
  })

  it('listGroups：按 created_at ASC，带组内未删除会话数（回收站会话不计）', () => {
    insertGroup('g-late', '后建的', '2026-01-02T00:00:00.000Z')
    insertGroup('g-early', '先建的', '2026-01-01T00:00:00.000Z')
    insertSession('s1', 'g-early')
    insertSession('s2', 'g-early')
    insertSession('s-trash', 'g-early', '2026-01-03T00:00:00.000Z')
    insertSession('s-none', null)

    const groups = groupsRepo.listGroups()
    expect(groups.map((g) => g.id)).toEqual(['g-early', 'g-late'])
    expect(groups.find((g) => g.id === 'g-early')?.session_count).toBe(2)
    expect(groups.find((g) => g.id === 'g-late')?.session_count).toBe(0)
  })

  it('listGroups 不含已删组；getGroupById / getGroupByName 对已删组当不存在', () => {
    insertGroup('g-dead', '已删组', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `UPDATE session_groups SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE id = 'g-dead'`
    ).run()

    expect(groupsRepo.listGroups()).toEqual([])
    expect(groupsRepo.getGroupById('g-dead')).toBeUndefined()
    expect(groupsRepo.getGroupByName('已删组')).toBeUndefined()
  })

  it('组名唯一只约束活组：活组重名抛 UNIQUE，软删后可复用同名', () => {
    groupsRepo.createGroup('g1', '同名')
    expect(() => groupsRepo.createGroup('g2', '同名')).toThrow(/UNIQUE/)
    db.prepare(
      `UPDATE session_groups SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE id = 'g1'`
    ).run()
    expect(() => groupsRepo.createGroup('g3', '同名')).not.toThrow()
  })

  it('renameGroup 改名 + 刷新组 updated_at；setGroupCollapsed 折叠态落库', () => {
    const created = groupsRepo.createGroup('g1', '旧名')
    db.prepare(
      `UPDATE session_groups SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'g1'`
    ).run()

    const renamed = groupsRepo.renameGroup('g1', '新名')
    expect(renamed?.name).toBe('新名')
    expect(renamed?.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
    expect(renamed?.created_at).toBe(created.created_at)

    expect(groupsRepo.setGroupCollapsed('g1', true)?.collapsed).toBe(1)
    expect(groupsRepo.getGroupById('g1')?.collapsed).toBe(1)
    expect(groupsRepo.setGroupCollapsed('g1', false)?.collapsed).toBe(0)
  })

  it('rename / collapse 对已删组 no-op（返回 undefined，不复活）', () => {
    insertGroup('g-dead', '已删组', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `UPDATE session_groups SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE id = 'g-dead'`
    ).run()

    expect(groupsRepo.renameGroup('g-dead', '改名')).toBeUndefined()
    expect(groupsRepo.setGroupCollapsed('g-dead', true)).toBeUndefined()
    expect(groupsRepo.getGroupById('g-dead')).toBeUndefined()
  })

  it('dissolveGroup：组行硬删、会话落未分组、deleted_at 与 updated_at 都不动', () => {
    insertGroup('g1', '待解散', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `INSERT INTO sessions (id, title, group_id, deleted_at, updated_at)
       VALUES ('s-in', '组内', 'g1', NULL, '2020-01-01 00:00:00'),
              ('s-already-gone', '早先单删', 'g1', '2026-01-02T00:00:00.000Z', '2020-01-02 00:00:00')`
    ).run()

    groupsRepo.dissolveGroup('g1')

    expect(groupsRepo.getGroupById('g1')).toBeUndefined()
    const rows = db
      .prepare(`SELECT id, group_id, deleted_at, updated_at FROM sessions ORDER BY id`)
      .all() as Array<{
      id: string
      group_id: string | null
      deleted_at: string | null
      updated_at: string
    }>
    // 两个会话都落未分组；已删行仍是已删（解散不负责回收站）
    expect(rows.map((r) => r.group_id)).toEqual([null, null])
    expect(rows.find((r) => r.id === 's-in')?.deleted_at).toBeNull()
    expect(rows.find((r) => r.id === 's-already-gone')?.deleted_at).toBe('2026-01-02T00:00:00.000Z')
    // 解散是组动作，不改写会话 updated_at
    expect(rows.find((r) => r.id === 's-in')?.updated_at).toBe('2020-01-01 00:00:00')
  })

  it('dissolveGroup 只影响目标组（别组会话原样）', () => {
    insertGroup('g1', '目标', '2026-01-01T00:00:00.000Z')
    insertGroup('g2', '别组', '2026-01-02T00:00:00.000Z')
    insertSession('s1', 'g1')
    insertSession('s2', 'g2')

    groupsRepo.dissolveGroup('g1')

    expect(groupsRepo.getGroupById('g2')).toBeDefined()
    expect(
      (
        db.prepare(`SELECT group_id FROM sessions WHERE id = 's2'`).get() as {
          group_id: string | null
        }
      ).group_id
    ).toBe('g2')
  })
})

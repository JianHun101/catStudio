/**
 * connectorBindings repo — 绑定管理语义测试（P2 AC1）。
 *
 * 覆盖：upsert 新建 / 同键改绑 / 查询 / 按平台过滤 / 删除 / DB 唯一约束
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository, connectorBindings as bindingsRepo } from './index.js'

describe('connectorBindings repo', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
  })

  afterEach(() => {
    resetDb()
  })

  it('upsert creates a new binding', () => {
    const binding = bindingsRepo.upsertConnectorBinding('qq', 'group', '123456', 'session-1')
    expect(binding.id).toBeTruthy()
    expect(binding.platform).toBe('qq')
    expect(binding.external_type).toBe('group')
    expect(binding.external_id).toBe('123456')
    expect(binding.session_id).toBe('session-1')
    expect(binding.created_at).toBeTruthy()
  })

  it('upsert on same unique key updates session_id (rebind) without duplicate row', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '123456', 'session-1')
    const rebound = bindingsRepo.upsertConnectorBinding('qq', 'group', '123456', 'session-2')
    expect(rebound.session_id).toBe('session-2')
    const rows = db.prepare('SELECT COUNT(*) AS c FROM connector_bindings').get() as {
      c: number
    }
    expect(rows.c).toBe(1)
  })

  it('get returns the binding / undefined for missing', () => {
    expect(bindingsRepo.getConnectorBinding('qq', 'group', 'nope')).toBeUndefined()
    bindingsRepo.upsertConnectorBinding('qq', 'private', '999', 'session-3')
    const b = bindingsRepo.getConnectorBinding('qq', 'private', '999')
    expect(b?.session_id).toBe('session-3')
  })

  it('same external id on different type or platform is a distinct binding', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '42', 'session-1')
    bindingsRepo.upsertConnectorBinding('qq', 'private', '42', 'session-2')
    bindingsRepo.upsertConnectorBinding('wechat', 'group', '42', 'session-3')
    expect(bindingsRepo.listConnectorBindings()).toHaveLength(3)
  })

  it('list filters by platform', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '1', 's1')
    bindingsRepo.upsertConnectorBinding('qq', 'private', '2', 's2')
    bindingsRepo.upsertConnectorBinding('wechat', 'group', '3', 's3')
    const qq = bindingsRepo.listConnectorBindings('qq')
    expect(qq).toHaveLength(2)
    expect(qq.every((b) => b.platform === 'qq')).toBe(true)
  })

  it('delete removes and reports false for missing', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '1', 's1')
    expect(bindingsRepo.deleteConnectorBinding('qq', 'group', '1')).toBe(true)
    expect(bindingsRepo.deleteConnectorBinding('qq', 'group', '1')).toBe(false)
    expect(bindingsRepo.getConnectorBinding('qq', 'group', '1')).toBeUndefined()
  })

  it('AC3: listBindingsBySession returns all bindings of a session', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '1', 's1')
    bindingsRepo.upsertConnectorBinding('qq', 'private', '2', 's1')
    bindingsRepo.upsertConnectorBinding('qq', 'group', '3', 's2')
    const rows = bindingsRepo.listBindingsBySession('s1')
    expect(rows).toHaveLength(2)
    expect(rows.every((b) => b.session_id === 's1')).toBe(true)
  })

  it('AC3-2: listBindingsBySession returns empty for session without bindings', () => {
    expect(bindingsRepo.listBindingsBySession('nope')).toEqual([])
  })

  it('DB unique constraint rejects raw duplicate insert', () => {
    bindingsRepo.upsertConnectorBinding('qq', 'group', '1', 's1')
    expect(() =>
      db
        .prepare(
          `INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id)
           VALUES ('dup', 'qq', 'group', '1', 's2')`
        )
        .run()
    ).toThrow()
  })
})

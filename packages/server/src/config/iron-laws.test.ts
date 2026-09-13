/**
 * iron-laws 单一权威访问器测试。
 *
 * - getIronLaws：空 settings 回退常量；写后返回新值（settings 优先）
 * - writeIronLaws：upsert 两键
 * - ironLawForRole：三态映射（reviewer→审查铁律；store/implementer→开发铁律；其余→''）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, settings as settingsRepo } from '../db/repository/index.js'
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from '../seed-data.js'
import { getIronLaws, writeIronLaws, ironLawForRole } from './iron-laws.js'

describe('config/iron-laws — getIronLaws', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('空 settings → 回退 seed 常量（coder/reviewer 逐字一致）', () => {
    const laws = getIronLaws()
    expect(laws.coder).toBe(IRON_LAWS_CODER)
    expect(laws.reviewer).toBe(IRON_LAWS_REVIEWER)
  })

  it('写后 → settings 优先（返回新值，不回退常量）', () => {
    writeIronLaws('开发铁律 v2', '审查铁律 v2')
    const laws = getIronLaws()
    expect(laws.coder).toBe('开发铁律 v2')
    expect(laws.reviewer).toBe('审查铁律 v2')
  })

  it('只写一个键 → 另一个键仍回退常量（键级独立）', () => {
    settingsRepo.setSetting('iron_laws_coder', '只改开发')
    const laws = getIronLaws()
    expect(laws.coder).toBe('只改开发')
    expect(laws.reviewer).toBe(IRON_LAWS_REVIEWER)
  })
})

describe('config/iron-laws — ironLawForRole 三态映射', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('reviewer → 审查铁律', () => {
    expect(ironLawForRole('reviewer')).toBe(IRON_LAWS_REVIEWER)
  })

  it('store / implementer → 开发铁律', () => {
    expect(ironLawForRole('store')).toBe(IRON_LAWS_CODER)
    expect(ironLawForRole('implementer')).toBe(IRON_LAWS_CODER)
  })

  it('不在边表的角色 / unknown / 缺失 → 不注入（空串）', () => {
    // 原 'vision' 一档随角色退役删除（2026-09-13，单A）：ironLawForRole 只有
    // reviewer / store|implementer / 其余 三个分支，'unknown' 覆盖的正是同一个
    // "其余"分支——留 'vision' 会是一个同分支同断言的重复用例，不增覆盖。
    expect(ironLawForRole('unknown')).toBe('')
    expect(ironLawForRole(undefined)).toBe('')
    expect(ironLawForRole('')).toBe('')
  })

  it('写后 ironLawForRole 返回新值（运行期编辑生效）', () => {
    writeIronLaws('开发铁律 new', '审查铁律 new')
    expect(ironLawForRole('reviewer')).toBe('审查铁律 new')
    expect(ironLawForRole('store')).toBe('开发铁律 new')
  })
})

/**
 * settings 表访问器测试（运行期全局设置的 key/value 直存）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository, settings as settingsRepo } from './index.js'

describe('db/repository/settings', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('getSetting 缺失 key → undefined', () => {
    expect(settingsRepo.getSetting('no-such-key')).toBeUndefined()
  })

  it('setSetting → getSetting 读回（value 原样）', () => {
    settingsRepo.setSetting('iron_laws_coder', '开发铁律 v1')
    expect(settingsRepo.getSetting('iron_laws_coder')).toBe('开发铁律 v1')
  })

  it('重复 setSetting 同 key → 覆盖旧值（upsert 幂等）', () => {
    settingsRepo.setSetting('iron_laws_coder', 'v1')
    settingsRepo.setSetting('iron_laws_coder', 'v2')
    expect(settingsRepo.getSetting('iron_laws_coder')).toBe('v2')
    // 单行不重复
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM settings WHERE key = 'iron_laws_coder'`)
      .get() as { c: number }
    expect(row.c).toBe(1)
  })

  it('不同 key 互不影响', () => {
    settingsRepo.setSetting('iron_laws_coder', 'coder')
    settingsRepo.setSetting('iron_laws_reviewer', 'reviewer')
    expect(settingsRepo.getSetting('iron_laws_coder')).toBe('coder')
    expect(settingsRepo.getSetting('iron_laws_reviewer')).toBe('reviewer')
  })

  it('deleteSetting 删指定 key，不动其他 key', () => {
    settingsRepo.setSetting('iron_laws_coder', 'coder')
    settingsRepo.setSetting('iron_laws_reviewer', 'reviewer')
    settingsRepo.deleteSetting('iron_laws_coder')
    expect(settingsRepo.getSetting('iron_laws_coder')).toBeUndefined()
    expect(settingsRepo.getSetting('iron_laws_reviewer')).toBe('reviewer')
  })

  it('deleteSetting 缺失 key 幂等 no-op（重复删不抛错）', () => {
    expect(() => settingsRepo.deleteSetting('no-such-key')).not.toThrow()
    expect(() => settingsRepo.deleteSetting('no-such-key')).not.toThrow()
    expect(settingsRepo.getSetting('no-such-key')).toBeUndefined()
  })
})

/**
 * 检索 topK 配置（`config/retrieval.ts`）测试。
 *
 * 判据面 = 三档优先级（settings > env > 默认）与来源回报，不是路由壳。
 * 用真实 SQLite（`createTestDb()`，无磁盘）+ 真实 settings 仓库——写侧键名、
 * 幂等 upsert / delete 都是被测面的一部分。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, settings as settingsRepo } from '../db/repository/index.js'
import {
  DEFAULT_TOP_K,
  RETRIEVAL_TOP_K_SETTING_KEY,
  getRetrievalConfig,
  isValidTopK,
  resetRetrievalTopK,
  setRetrievalTopK,
} from './retrieval.js'

describe('config/retrieval — topK 三档优先级', () => {
  beforeEach(() => {
    // 不赌「本机没设这个变量」——跑批进程会继承 .env（lesson env-default-assertion-is-coincidence）
    vi.stubEnv('MEMORY_TOP_K', undefined)
    vi.stubEnv('MEMORY_MAX_DISTANCE', undefined)
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetDb()
  })

  it('无 settings、无 env → 默认 3 / source=default / envTopK=null', () => {
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(DEFAULT_TOP_K)
    expect(cfg.topKSource).toBe('default')
    expect(cfg.envTopK).toBeNull()
    expect(cfg.defaultTopK).toBe(3)
  })

  it('env=4 → 生效 4 / source=env', () => {
    vi.stubEnv('MEMORY_TOP_K', '4')
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(4)
    expect(cfg.topKSource).toBe('env')
    expect(cfg.envTopK).toBe(4)
  })

  it('settings=7 且 env=4 → settings 优先（7 / settings / envTopK 仍回显 4）', () => {
    vi.stubEnv('MEMORY_TOP_K', '4')
    settingsRepo.setSetting(RETRIEVAL_TOP_K_SETTING_KEY, '7')
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(7)
    expect(cfg.topKSource).toBe('settings')
    expect(cfg.envTopK).toBe(4)
  })

  it('DELETE 设置行 → 回落 env（写 7 后再删 → 4 / env）', () => {
    vi.stubEnv('MEMORY_TOP_K', '4')
    expect(setRetrievalTopK(7).topK).toBe(7)
    const cfg = resetRetrievalTopK()
    expect(settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)).toBeUndefined()
    expect(cfg.topK).toBe(4)
    expect(cfg.topKSource).toBe('env')
  })

  it('env 坏值（abc）→ 默认 3 / source=default（不把坏值当来源）', () => {
    vi.stubEnv('MEMORY_TOP_K', 'abc')
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(3)
    expect(cfg.topKSource).toBe('default')
    expect(cfg.envTopK).toBeNull()
  })

  it('env 小数按旧口径取整（4.9 → 4 / env）', () => {
    vi.stubEnv('MEMORY_TOP_K', '4.9')
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(4)
    expect(cfg.topKSource).toBe('env')
  })

  it('settings 存脏值（0 / 11 / 1.5 / abc）→ 视为没写过，回落 env', () => {
    vi.stubEnv('MEMORY_TOP_K', '6')
    for (const dirty of ['0', '11', '1.5', 'abc', '']) {
      settingsRepo.setSetting(RETRIEVAL_TOP_K_SETTING_KEY, dirty)
      const cfg = getRetrievalConfig()
      expect(cfg.topK, dirty).toBe(6)
      expect(cfg.topKSource, dirty).toBe('env')
    }
  })

  it('maxDistance 仍读 MEMORY_MAX_DISTANCE（默认 0.6）', () => {
    expect(getRetrievalConfig().maxDistance).toBe(0.6)
    vi.stubEnv('MEMORY_MAX_DISTANCE', '0.7')
    expect(getRetrievalConfig().maxDistance).toBe(0.7)
  })

  it('DB 未就绪 → fail-soft 回落 env/默认，不抛错', () => {
    resetDb()
    vi.stubEnv('MEMORY_TOP_K', '5')
    const cfg = getRetrievalConfig()
    expect(cfg.topK).toBe(5)
    expect(cfg.topKSource).toBe('env')
  })
})

describe('config/retrieval — 写侧校验', () => {
  beforeEach(() => {
    // 不赌「本机没设这个变量」——跑批进程会继承 .env（lesson env-default-assertion-is-coincidence）
    vi.stubEnv('MEMORY_TOP_K', undefined)
    vi.stubEnv('MEMORY_MAX_DISTANCE', undefined)
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetDb()
  })

  it('isValidTopK：1 与 10 可存；0 / 11 / 1.5 / "7" / null 拒绝', () => {
    expect(isValidTopK(1)).toBe(true)
    expect(isValidTopK(10)).toBe(true)
    for (const bad of [0, 11, -1, 1.5, '7', null, undefined, NaN]) {
      expect(isValidTopK(bad), String(bad)).toBe(false)
    }
  })

  it('setRetrievalTopK 越界直接抛错且不落库（防绕过路由）', () => {
    expect(() => setRetrievalTopK(0)).toThrow(RangeError)
    expect(() => setRetrievalTopK(11)).toThrow(RangeError)
    expect(settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)).toBeUndefined()
  })

  it('重复 set 同 key → 覆盖（值原样为十进制字符串）', () => {
    setRetrievalTopK(7)
    expect(settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)).toBe('7')
    setRetrievalTopK(10)
    expect(settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)).toBe('10')
  })
})

/**
 * 评估告警阈值配置 — settings 优先 / env 兜底 / 逐字段来源 / 写时合并 / fail-soft。
 *
 * 真实 SQLite :memory:（settings 表走真 repo）；「settings 读抛错」用注入的坏 repo
 * 模拟 DB 未就绪路径——不能只靠 mock getSetting，否则测不到 catch 分支。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, settings as settingsRepo } from '../db/repository/index.js'
import { setRepoDb as setSettingsDb } from '../db/repository/settings.js'
import {
  EVAL_ALERT_SETTING_KEY,
  getEvalAlertConfig,
  validateEvalAlertPatch,
  writeEvalAlertConfig,
} from './eval-alert-config.js'

const ENV_KEYS = [
  'EVAL_ALERT_SUCCESS_RATE',
  'EVAL_ALERT_TIMEOUT_RATE',
  'EVAL_ALERT_REWORK_RATE',
  'EVAL_ALERT_MIN_EXECUTIONS',
  'EVAL_ALERT_MIN_VERDICTS',
] as const

/** 把五个 env 显式清空（= 正常兜底面）——防跑批进程继承 .env 造成假读数 */
function clearEnv(): void {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
}

describe('eval-alert-config — 读取优先级', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    clearEnv()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  it('无 settings → 全走 env/默认，source 全 env', () => {
    const { config, source } = getEvalAlertConfig()
    expect(config).toEqual({
      successRate: 0.8,
      timeoutRate: 0.1,
      reworkRate: 0.3,
      minExecutions: 20,
      minVerdicts: 30,
    })
    expect(source).toEqual({
      successRate: 'env',
      timeoutRate: 'env',
      reworkRate: 'env',
      minExecutions: 'env',
      minVerdicts: 'env',
    })
  })

  it('env 覆盖默认值（门限按整数收口）', () => {
    vi.stubEnv('EVAL_ALERT_SUCCESS_RATE', '0.7')
    vi.stubEnv('EVAL_ALERT_MIN_VERDICTS', '12')
    const { config, source } = getEvalAlertConfig()
    expect(config.successRate).toBe(0.7)
    expect(config.minVerdicts).toBe(12)
    expect(source.successRate).toBe('env')
    expect(source.minVerdicts).toBe('env')
  })

  it('只写 minVerdicts → 该字段走 settings，其余仍跟 env', () => {
    vi.stubEnv('EVAL_ALERT_SUCCESS_RATE', '0.7')
    writeEvalAlertConfig({ minVerdicts: 10 })
    const { config, source } = getEvalAlertConfig()
    expect(config.minVerdicts).toBe(10)
    expect(source.minVerdicts).toBe('settings')
    // 未被写过的字段不得被冻结成写入那一刻的默认值
    expect(config.successRate).toBe(0.7)
    expect(source.successRate).toBe('env')
    expect(source.minExecutions).toBe('env')
  })

  it('两次部分写合并，不互相覆盖', () => {
    writeEvalAlertConfig({ successRate: 0.5 })
    writeEvalAlertConfig({ minVerdicts: 5 })
    const { config, source } = getEvalAlertConfig()
    expect(config.successRate).toBe(0.5)
    expect(config.minVerdicts).toBe(5)
    expect(source.successRate).toBe('settings')
    expect(source.minVerdicts).toBe('settings')
  })

  it('坏 JSON / 非对象 → 回落 env，不抛', () => {
    settingsRepo.setSetting(EVAL_ALERT_SETTING_KEY, '{not json')
    expect(() => getEvalAlertConfig()).not.toThrow()
    expect(getEvalAlertConfig().config.successRate).toBe(0.8)

    settingsRepo.setSetting(EVAL_ALERT_SETTING_KEY, 'null')
    expect(getEvalAlertConfig().config.minVerdicts).toBe(30)

    settingsRepo.setSetting(EVAL_ALERT_SETTING_KEY, '[1,2,3]')
    expect(getEvalAlertConfig().source.minVerdicts).toBe('env')
  })

  it('坏字段 / 越界值逐字段回落：80（百分比）与 -1、非数字都不生效', () => {
    settingsRepo.setSetting(
      EVAL_ALERT_SETTING_KEY,
      JSON.stringify({ successRate: 80, reworkRate: '0.3', minVerdicts: -1, minExecutions: 1.5 })
    )
    const { config, source } = getEvalAlertConfig()
    expect(config.successRate).toBe(0.8)
    expect(config.reworkRate).toBe(0.3)
    expect(config.minVerdicts).toBe(30)
    expect(config.minExecutions).toBe(20)
    expect(Object.values(source).every((s) => s === 'env')).toBe(true)
  })

  it('settings 读抛错（DB 未就绪）→ 回落 env 不抛', () => {
    setSettingsDb({
      prepare() {
        throw new Error('db not ready')
      },
    } as never)
    vi.stubEnv('EVAL_ALERT_SUCCESS_RATE', '0.65')

    const { config, source } = getEvalAlertConfig()
    expect(config.successRate).toBe(0.65)
    expect(source.successRate).toBe('env')

    // 还原真实 repo，防污染后续用例
    initRepository(getDb())
  })
})

describe('eval-alert-config — POST 校验', () => {
  it('合法子集通过（不要求全量）', () => {
    expect(validateEvalAlertPatch({ minVerdicts: 10 })).toEqual({
      ok: true,
      value: { minVerdicts: 10 },
    })
  })

  it('reworkRate: 80（百分比而非小数）→ 400 判定', () => {
    const r = validateEvalAlertPatch({ reworkRate: 80 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('reworkRate')
  })

  it('minVerdicts: -1 / 1.5 / 10001 → 400 判定', () => {
    for (const v of [-1, 1.5, 10001]) {
      const r = validateEvalAlertPatch({ minVerdicts: v })
      expect(r.ok, `minVerdicts=${v}`).toBe(false)
    }
  })

  it('空 body / 非对象 / 未知字段 → 400 判定', () => {
    expect(validateEvalAlertPatch({}).ok).toBe(false)
    expect(validateEvalAlertPatch(null).ok).toBe(false)
    expect(validateEvalAlertPatch([1]).ok).toBe(false)
    expect(validateEvalAlertPatch({ minVerdict: 10 }).ok).toBe(false)
  })
})

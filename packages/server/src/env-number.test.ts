/**
 * `envNumber` 单元测试（OQ-6）。
 *
 * 边界 mock 只打日志：本函数**唯一可观测面**就是那条 warn——「坏值回退」与
 * 「正常兜底」在返回值上完全同形（都返回 fallback），不断言日志就等于只测了
 * 一半、且那一半恒真。其余（env 读写、`Number` 解析）全真。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logWarn = vi.fn()

vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}))

const { envNumber } = await import('./env-number.js')

/** 专用变量名：不碰任何生产 env 键，避免用例间串味 */
const NAME = 'CATSTUDY_TEST_ENV_NUMBER'

describe('envNumber', () => {
  beforeEach(() => {
    delete process.env[NAME]
    logWarn.mockClear()
  })

  afterEach(() => {
    delete process.env[NAME]
  })

  // ─── 正常兜底面：不出声 ───────────────────────────────
  describe('未设置 / 空串 ⇒ fallback 且不打日志', () => {
    it('未设置', () => {
      expect(envNumber(NAME, 7)).toBe(7)
      expect(logWarn).not.toHaveBeenCalled()
    })

    it('空串', () => {
      process.env[NAME] = ''
      expect(envNumber(NAME, 7)).toBe(7)
      expect(logWarn).not.toHaveBeenCalled()
    })

    // 纯空白不是「空串」的字面形态，但 `Number('   ') === 0`——对 topK / maxDistance
    // 这类阈值，0 与 NaN 同属静默失效。按「空串」的白话含义一并兜底（见回报 OQ）。
    it('纯空白串', () => {
      process.env[NAME] = '   '
      expect(envNumber(NAME, 7)).toBe(7)
      expect(logWarn).not.toHaveBeenCalled()
    })
  })

  // ─── 坏值：fail-loud ──────────────────────────────────
  describe('非有限数 ⇒ warn + fallback', () => {
    it('abc ⇒ 回退，且 warn 带变量名 / 原始串 / 回退值', () => {
      process.env[NAME] = 'abc'
      expect(envNumber(NAME, 0.6)).toBe(0.6)
      expect(logWarn).toHaveBeenCalledTimes(1)
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(NAME), {
        raw: 'abc',
        fallback: 0.6,
      })
    })

    it('Infinity / -Infinity ⇒ 回退（有限性而非仅 NaN）', () => {
      for (const v of ['Infinity', '-Infinity']) {
        logWarn.mockClear()
        process.env[NAME] = v
        expect(envNumber(NAME, 3)).toBe(3)
        expect(logWarn).toHaveBeenCalledTimes(1)
      }
    })

    // 本票对原 `parseInt` 语义的**有意收紧**：`parseInt('5abc', 10)` 静默取 5，
    // 不产生 NaN ⇒ 永远走不到 warn 分支，恰是「坏值静默生效」本人。
    it('部分可解析串 5abc ⇒ 回退（不是 parseInt 的前缀取值语义）', () => {
      process.env[NAME] = '5abc'
      expect(envNumber(NAME, 3)).toBe(3)
      expect(logWarn).toHaveBeenCalledTimes(1)
    })
  })

  // ─── 合法值：原样，不钳位 ─────────────────────────────
  describe('合法值原样生效', () => {
    it('整数 / 小数', () => {
      process.env[NAME] = '3'
      expect(envNumber(NAME, 7)).toBe(3)
      process.env[NAME] = '0.35'
      expect(envNumber(NAME, 7)).toBe(0.35)
      expect(logWarn).not.toHaveBeenCalled()
    })

    it('空白包裹的合法值（`Number` 自行 trim）', () => {
      process.env[NAME] = ' 3 '
      expect(envNumber(NAME, 7)).toBe(3)
      expect(logWarn).not.toHaveBeenCalled()
    })

    // 契约明写「本期只治 NaN，不加区间钳位」——0 与负数**原样**（`slowMs=0` 会把
    // 每一跳标 slow，钳位会改语义）。这条钉住「没有偷偷加钳位」。
    it('0 与负值不被钳位', () => {
      process.env[NAME] = '0'
      expect(envNumber(NAME, 7)).toBe(0)
      process.env[NAME] = '-1'
      expect(envNumber(NAME, 7)).toBe(-1)
      expect(logWarn).not.toHaveBeenCalled()
    })
  })
})

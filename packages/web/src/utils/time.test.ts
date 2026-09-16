import { describe, it, expect } from 'vitest'
import { normalizeUtc, parseUtc, fmtUtcShort, fmtUtcFull } from './time'
import timeSource from './time.ts?raw'

/**
 * 时间口径唯一解析入口（R5 从 `EvaluationView.vue` / `ChatPanel.vue` 收成单源）——
 * 纯函数测试，无 DOM、无 mock。
 *
 * **本文件是「必须显式当 UTC 解析」的唯一机械保证。** R5 之前该守卫是
 * `EvaluationView.test.ts` 里一条钉实现字面量的 `?raw` 断言；解析实现搬走后守卫跟着搬家
 * ——语义守卫是下面的行为断言，实现字面量守卫是文末那条静态源断言。
 *
 * 断言与机器时区无关：`parseUtc` 的产物用 `toISOString()` 断言（UTC 读数恒等），
 * 格式化函数的产物用「同一时刻的本地读数」断言（换时区只是换期望，不会假红）。
 *
 * 反面教材（R5 修的 bug）：`timeShort` 曾只做 `ts.slice(0, 16)` 字符串截断、零时区换算，
 * 把 UTC 串当本地时间显示 —— 评分时间与待回标时间**整整早 8 小时**。形状对、值错，
 * 肉眼看不出来，只有拿跨时区的期望值才测得出。
 */

const p2 = (n: number) => String(n).padStart(2, '0')

/** 独立构造「同一 UTC 时刻」的本地读数期望——不经过被测函数，避免自证 */
function expectLocal(y: number, mo: number, d: number, h: number, mi: number) {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi))
  return {
    short: `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`,
    full: `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`,
  }
}

describe('parseUtc：两种形态通吃，且一律按 UTC 解析', () => {
  it('SQLite 无后缀串按 UTC 解析（不是本地时区）——本票修掉的那个 8 小时', () => {
    // 期望走 toISOString，与机器时区无关。若实现退化成 `new Date(裸串)`，
    // 在 UTC+8 机器上会得到 2026-09-16T02:00:00.000Z ⇒ 本断言红。
    expect(parseUtc('2026-09-16 10:00:00')!.toISOString()).toBe('2026-09-16T10:00:00.000Z')
  })

  it('ISO 带 Z 串直接用（不补第二个 Z——老实现会拼出 `...ZZ` 而原样回显）', () => {
    expect(parseUtc('2026-09-14T13:20:00.000Z')!.toISOString()).toBe('2026-09-14T13:20:00.000Z')
  })

  it('ISO 带 +HH:MM 偏移串按偏移解析', () => {
    expect(parseUtc('2026-09-14T21:20:00+08:00')!.toISOString()).toBe('2026-09-14T13:20:00.000Z')
  })

  it('秒可省的 SQLite 形态照样按 UTC（收紧会造回归：老 fmtUtcShort 认得 `HH:MM`）', () => {
    expect(parseUtc('2026-09-16 10:00')!.toISOString()).toBe('2026-09-16T10:00:00.000Z')
  })

  it('空值 / 无法解析 → null（不返回 Invalid Date，调用方不必再判 NaN）', () => {
    expect(parseUtc(null)).toBeNull()
    expect(parseUtc(undefined)).toBeNull()
    expect(parseUtc('')).toBeNull()
    expect(parseUtc('不是时间')).toBeNull()
  })
})

describe('normalizeUtc：只归一形态、不解析', () => {
  it('SQLite 形态补 Z', () => {
    expect(normalizeUtc('2026-09-16 10:00:00')).toBe('2026-09-16T10:00:00Z')
  })

  it('已带时区标记的原样返回（`Z` 与 `+HH:MM` 都算）', () => {
    expect(normalizeUtc('2026-09-14T13:20:00.000Z')).toBe('2026-09-14T13:20:00.000Z')
    expect(normalizeUtc('2026-09-14T21:20:00+08:00')).toBe('2026-09-14T21:20:00+08:00')
  })

  it('识别不出的原样返回——不猜、不强行补 Z', () => {
    expect(normalizeUtc('2026/09/16')).toBe('2026/09/16')
  })
})

describe('两个格式化函数：形状不变、值按时区换算', () => {
  const S = '2026-09-16 10:00:00'
  const want = expectLocal(2026, 9, 16, 10, 0)

  it('fmtUtcFull 形状 = `YYYY-MM-DD HH:mm`（与它替换掉的旧 timeShort 逐字同形）', () => {
    expect(fmtUtcFull(S)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('fmtUtcShort 形状 = `MM-DD HH:mm`（链路跳起止沿用的格式，本票不改版）', () => {
    expect(fmtUtcShort(S)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('两者都渲染**同一时刻**的本地读数', () => {
    expect(fmtUtcFull(S)).toBe(want.full)
    expect(fmtUtcShort(S)).toBe(want.short)
  })

  it('两种形态喂同一个时刻 → 同一结果（通吃形态的意义）', () => {
    expect(fmtUtcFull('2026-09-16T10:00:00.000Z')).toBe(fmtUtcFull(S))
    expect(fmtUtcShort('2026-09-16T10:00:00.000Z')).toBe(fmtUtcShort(S))
  })

  it('空值 → `—`；无法解析 → 原样回显（不静默吞成空串）', () => {
    expect(fmtUtcShort(null)).toBe('—')
    expect(fmtUtcFull(undefined)).toBe('—')
    expect(fmtUtcShort('不是时间')).toBe('不是时间')
    expect(fmtUtcFull('不是时间')).toBe('不是时间')
  })
})

describe('静态源：解析必须显式当 UTC（守卫随实现搬家的落点）', () => {
  it('有显式 UTC 归一，没有裸 `new Date(raw)`', () => {
    expect(timeSource).toContain("replace(' ', 'T') + 'Z'")
    expect(timeSource).not.toContain('new Date(raw)')
  })
})

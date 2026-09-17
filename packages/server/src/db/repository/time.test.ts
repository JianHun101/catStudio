/**
 * 时间口径归一 / 生成（票 `db-schema-governance` 票 5，spec §4.2 ⑤-a / ⑤-c）。
 *
 * 纯单元（无 I/O）：判的是**字符串形态**与**比较序**，不碰库。库层的落地效果由
 * `messages.test.ts`（写入口 / 比较点）与 `migrations.test.ts`（迁移转换）分别钉。
 */
import { describe, it, expect } from 'vitest'
import { nowIso, isoMinutesAgo, toIsoDb, toIsoDbUpper } from './time.js'

describe('db/repository/time —— 时间口径唯一入口', () => {
  describe('nowIso', () => {
    it('产出 ISO 8601 UTC 毫秒串（定宽 ⇒ 字典序 = 时间序）', () => {
      const s = nowIso()
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Number.isNaN(Date.parse(s))).toBe(false)
    })

    it('字典序 = 时间序（相邻时刻可比）', () => {
      const a = nowIso()
      const b = new Date(Date.now() + 5000).toISOString()
      expect(a < b).toBe(true)
    })
  })

  describe('isoMinutesAgo', () => {
    it('回溯 N 分钟，且仍是 ISO 毫秒形态（超时窗比较必须与列同口径）', () => {
      const s = isoMinutesAgo(60)
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Date.now() - Date.parse(s)).toBeGreaterThanOrEqual(60 * 60_000 - 1000)
    })
  })

  describe('toIsoDb（下界口径）', () => {
    it("秒级 datetime('now') 串 → ISO 毫秒（毫秒位补 .000）", () => {
      expect(toIsoDb('2026-09-17 08:30:00')).toBe('2026-09-17T08:30:00.000Z')
    })

    it('ISO **无毫秒**串 → 补 .000（票 5 之前 API 自身就是这个形状，客户端会原样回传）', () => {
      expect(toIsoDb('2026-09-17T08:30:00Z')).toBe('2026-09-17T08:30:00.000Z')
    })

    it('已是 ISO 毫秒 → 原样（幂等）', () => {
      expect(toIsoDb('2026-09-17T08:30:00.123Z')).toBe('2026-09-17T08:30:00.123Z')
    })

    it('小数秒超三位 → 截到毫秒（不四舍五入进位，保持单向可预期）', () => {
      expect(toIsoDb('2026-09-17 08:30:00.1239')).toBe('2026-09-17T08:30:00.123Z')
    })

    it('形态认不出（带时区偏移 / 纯日期）→ **原样透传**，不猜', () => {
      expect(toIsoDb('2026-09-17T08:30:00+08:00')).toBe('2026-09-17T08:30:00+08:00')
      expect(toIsoDb('2026-09-17')).toBe('2026-09-17')
      expect(toIsoDb('')).toBe('')
    })

    it('混形态比较同序：秒级串与 ISO 串折算后落在同一根轴上', () => {
      // 这是本模块存在的**唯一理由**——不折算的话 '2026-09-17 08:30:00' < '2026-09-17T00:00:00.000Z'
      //（第 10 位 ' '(0x20) < 'T'(0x54)），跨表比较整段失配且不报错。
      expect(toIsoDb('2026-09-17 08:30:00') > toIsoDb('2026-09-17T07:00:00.000Z')).toBe(true)
    })
  })

  describe('toIsoDbUpper（上界口径）', () => {
    it('省略小数秒 → 折算到该秒的 .999（与迁移前「整秒含入」的 <= 行为对齐）', () => {
      expect(toIsoDbUpper('2026-09-17 08:30:00')).toBe('2026-09-17T08:30:00.999Z')
      expect(toIsoDbUpper('2026-09-17T08:30:00Z')).toBe('2026-09-17T08:30:00.999Z')
    })

    it('显式给了小数秒 → 精确比较（调用方说了算），不走 .999', () => {
      expect(toIsoDbUpper('2026-09-17T08:30:00.123Z')).toBe('2026-09-17T08:30:00.123Z')
    })

    it('**与下界口径成对**：同一秒里的毫秒值落在 [下界, 上界] 内（否则窗口边界静默漏行）', () => {
      const lower = toIsoDb('2026-09-17T08:30:00Z')
      const upper = toIsoDbUpper('2026-09-17T08:30:00Z')
      const sameSecondLaterMs = '2026-09-17T08:30:00.500Z'
      expect(sameSecondLaterMs >= lower).toBe(true)
      expect(sameSecondLaterMs <= upper).toBe(true)
    })
  })
})

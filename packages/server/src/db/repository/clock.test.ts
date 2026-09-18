import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nowIso, normalizeIsoMs, isoDaysAgo } from './clock.js'
import { nowIso as timeNowIso } from './time.js'

/**
 * 记录时间口径（spec §4.2 ⑤-c）**只有一个生成点**。
 *
 * 本文件钉的是审查回执 P2 那一处：`clock.ts` 与 `time.ts` 曾各带一份逐字相同的
 * `new Date().toISOString()`，两处都自称「唯一生成点」——⑤-c 契约措辞就是「由 repository
 * 层**统一 helper** 生成」，两个「唯一生成器」并存本身即违约，且消费面已分叉
 * （`clock.js` = 4 个 repository + eval 侧；`time.js` = messages/sessions 服务面），
 * 票 8 迁 `sessions` 时选错哪份全看运气。
 *
 * 判据取**函数引用同一**而不是「两个函数输出相等」：输出相等在双实现下也恒真（今天两份
 * 实现逐字相同），只有引用同一才证「不存在第二份实现」。谁再把实现抄回来，这里当场红。
 */
describe('clock · 记录时间生成点唯一性（⑤-c）', () => {
  it('clock 的 nowIso 就是 time 的 nowIso（同一函数引用，不是「行为相同的两份」）', () => {
    expect(nowIso).toBe(timeNowIso)
  })

  it('静态源断言：clock.ts 里不许再定义 nowIso，只能转出口', () => {
    const src = fs.readFileSync(new URL('./clock.ts', import.meta.url), 'utf8')
    // 只钉 `nowIso`：本模块的 `isoDaysAgo` 是**另一个**函数（`time.ts` 无对应物），
    // 它自带 `toISOString()` 是正当实现——把所有 toISOString 一网打尽会误伤它。
    expect(src).not.toMatch(/function\s+nowIso\s*\(/)
    // 唯一合法形态是转出口
    expect(src).toContain("export { nowIso } from './time.js'")
  })

  it('口径实况：nowIso 产 ISO 毫秒 UTC 定宽串（字典序 = 时间序）', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('normalizeIsoMs：秒级串补毫秒、已是 ISO 的原样透传、认不出的原样保留', () => {
    expect(normalizeIsoMs('2026-09-17 08:30:00')).toBe('2026-09-17T08:30:00.000Z')
    expect(normalizeIsoMs('2026-09-17T08:30:00.123Z')).toBe('2026-09-17T08:30:00.123Z')
    expect(normalizeIsoMs('不是时间')).toBe('不是时间')
  })

  it('isoDaysAgo：定宽 ISO 毫秒，且比 from 早整 N 天', () => {
    const from = Date.parse('2026-09-17T08:30:00.123Z')
    expect(isoDaysAgo(30, from)).toBe('2026-08-18T08:30:00.123Z')
  })
})

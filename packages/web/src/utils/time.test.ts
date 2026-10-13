import { describe, it, expect } from 'vitest'
import { normalizeUtc, parseUtc, fmtUtcShort, fmtUtcFull, fmtMsgTime, fmtDateSep } from './time'
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

/** 剥掉注释后的源码——**静态源断言的判据面只应是代码**。
 *  `?raw` 会把 JSDoc 一并喂进来：注释里的散文示例会污染「构造点清单」这类**计数/枚举**断言
 *  （改一句文档即假红），反过来，注释里写一句被正面锚找的字面量又能让它**假绿**。
 *  本文件两条静态源守卫一律跑在它上面。（`time.ts` 内无含 `//` 的字符串/正则字面量，已实读。） */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const codeSource = codeOnly(timeSource)

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
  it('串分支必须委托唯一解析入口（没有裸 new Date(串变量)）', () => {
    expect(codeSource).toContain("replace(' ', 'T') + 'Z'")
    expect(codeSource).toContain('new Date(normalizeUtc(raw))')
    // 正面锚住**串分支**：`toLocalDate` 的串路径必须委托 `parseUtc`（全文件唯一命中）。
    // 把它换成裸构造——本守卫要防的那件事——本行即红，且下面清单同时多出一个 `raw`。
    // （行为用例「吃 SQLite 无后缀串」也能抓，但它只在非 UTC 机器上有分辨力：输入串由本机
    //   `toISOString()` 派生，UTC 机器上串本地读数与 UTC 读数重合 ⇒ 该回归行为上不可见。）
    expect(codeSource).toContain('return parseUtc(raw)')
    // 裸构造的形态是 `new Date(<标识符>)`——数字分支走 `new Date(raw)` 是**合法**的
    // （数字无时区语义），故清单只钉「有哪些」，合法性逐条说明：
    //   raw  —— `toLocalDate` 的**数字**分支（数字无时区语义，不该走串归一）
    //   now  —— `dayBucket` 里 `new Date(now)` 的全日期拷贝（不是解析，是复制）
    const dateCtors = [...codeSource.matchAll(/new Date\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((arg) => /^\w+$/.test(arg))
      .sort()
    expect(dateCtors).toEqual(['now', 'raw'])
  })
})

// ─── 消息时间戳按日分级（fmtMsgTime / fmtDateSep） ───────────────────────
//
// **时区无关的构造法**：`now` 与消息戳都从**同一个本地 `Date`** 派生——
// 消息戳取 `d.toISOString()`（模拟服务端存的 UTC 串），被测函数解析回来仍是同一时刻、
// 同一本地读数；换机器时区时两者**同步平移**，自然日关系与时钟读数都不变。
//
// ⚠️ 反面构造（本文件初版踩过）：用 `Date.UTC(...)` 同时造消息戳与 `now` 是**错的**
//    ——`now` 是直接用的本地 `Date` 对象，而消息戳要经 `parseUtc` 走一遍本地换算，
//    两者在非 UTC 机器上异位（UTC+8 下整整差 8 小时，日期档位跟着错）。

/** 本地时刻 → 服务端形态的 ISO 串（模拟 DB 里存的 `createdAt`） */
const iso = (d: Date) => d.toISOString()
/** 本地时刻构造 + 序列化一步到位 */
const isoAt = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).toISOString()
/** 本地时刻构造（当 `now` 用；直接是 `Date`，不经解析） */
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi)

describe('fmtMsgTime：按自然日分五档', () => {
  it('今天 → `HH:mm`（无任何日期前缀——用户原话「当天不展示月份和日期」）', () => {
    // 今天 00:00 的消息在 23:59 看仍是今天：分档只看自然日，不看秒级间隔
    expect(fmtMsgTime(isoAt(2026, 10, 13, 0, 0), at(2026, 10, 13, 23, 59))).toBe('00:00')
  })

  it('昨天 → `昨天 HH:mm`（昨天 23:59 的消息在今天 00:01 看）', () => {
    expect(fmtMsgTime(isoAt(2026, 10, 12, 23, 59), at(2026, 10, 13, 0, 1))).toBe('昨天 23:59')
  })

  it('更早、当年内 → `M月D日 HH:mm`（月日不补零，与旧 formatDate 同形）', () => {
    const msg = at(2026, 10, 11, 10, 0)
    expect(fmtMsgTime(iso(msg), at(2026, 10, 13, 12, 0))).toBe(
      `${msg.getMonth() + 1}月${msg.getDate()}日 10:00`
    )
  })

  it('跨年边界：「昨天」优先于「跨年」——12-31 的消息在 01-01 看是「昨天」不是年份档', () => {
    // 本票钉死的口径之一。反过来（先判年）这一档会被吃掉，本断言即红。
    expect(fmtMsgTime(isoAt(2025, 12, 31, 22, 30), at(2026, 1, 1, 8, 0))).toBe('昨天 22:30')
  })

  it('跨年且非昨天 → `YYYY年M月D日 HH:mm`', () => {
    const msg = at(2025, 6, 15, 10, 0)
    expect(fmtMsgTime(iso(msg), at(2026, 10, 13, 12, 0))).toBe(
      `${msg.getFullYear()}年${msg.getMonth() + 1}月${msg.getDate()}日 10:00`
    )
  })

  it('吃 SQLite 无后缀串（与 ISO 串同源，走 parseUtc 唯一入口）', () => {
    const msg = at(2026, 10, 11, 10, 0)
    // 串面口径：DB 存的 UTC 串要在**本地**渲染 ⇒ 反向补 Z 造出与 msg 同一时刻的串
    const sqlite = msg.toISOString().replace('T', ' ').slice(0, 19)
    expect(fmtMsgTime(sqlite, at(2026, 10, 13, 12, 0))).toBe(
      `${msg.getMonth() + 1}月${msg.getDate()}日 10:00`
    )
  })

  it('吃数字时间戳（ChatPanel 的私有形态；数字直接 new Date(n)，不做串归一）', () => {
    expect(fmtMsgTime(at(2026, 10, 13, 10, 0).getTime(), at(2026, 10, 13, 12, 0))).toBe('10:00')
  })

  it('解析失败 / 空值 → 空串（该条消息只是不显示时间，不静默回显原始串）', () => {
    const now = at(2026, 10, 13, 12, 0)
    expect(fmtMsgTime('不是时间', now)).toBe('')
    expect(fmtMsgTime('', now)).toBe('')
    expect(fmtMsgTime(Number.NaN, now)).toBe('')
  })
})

describe('fmtDateSep：分档与 fmtMsgTime 同源，只是不带时刻', () => {
  const now = at(2026, 10, 13, 12, 0)

  it('今天 / 昨天 两档是字面量', () => {
    expect(fmtDateSep(isoAt(2026, 10, 13, 9, 0), now)).toBe('今天')
    expect(fmtDateSep(isoAt(2026, 10, 12, 9, 0), now)).toBe('昨天')
  })

  it('更早、当年内 → `M月D日`', () => {
    const msg = at(2026, 10, 11, 10, 0)
    expect(fmtDateSep(iso(msg), now)).toBe(`${msg.getMonth() + 1}月${msg.getDate()}日`)
  })

  it('跨年 → `YYYY年M月D日`（既有缺陷修复点：旧 formatDate 只到 `M月D日`，去年 12 月与上个月同形）', () => {
    const msg = at(2025, 6, 15, 10, 0)
    expect(fmtDateSep(iso(msg), now)).toBe(
      `${msg.getFullYear()}年${msg.getMonth() + 1}月${msg.getDate()}日`
    )
  })

  it('跨年边界同样「昨天」优先（与 fmtMsgTime 同一 dayBucket，不分叉）', () => {
    expect(fmtDateSep(isoAt(2025, 12, 31, 22, 30), at(2026, 1, 1, 8, 0))).toBe('昨天')
  })

  it('解析失败 / 空值 → 空串', () => {
    expect(fmtDateSep('不是时间', now)).toBe('')
    expect(fmtDateSep('', now)).toBe('')
  })
})

describe('静态源：分档顺序不能重排（昨天必须先于跨年判定）', () => {
  it('两函数共用同一个 dayBucket，且「昨天」以 setDate(-1) 表达', () => {
    // 「昨天优先跨年」是语义的一部分，重排顺序即回归——本断言把顺序钉在源码上
    // 计数跑在 codeSource 上：注释里提一次 `dayBucket(` 就能给这条 `>= 3` 添余量、
    // 掩掉真删一处消费——与上一条守卫同一失效机制（判据面混入注释），故同批收掉。
    expect(codeSource).toContain('function dayBucket(')
    expect(codeSource.match(/dayBucket\(/g)!.length).toBeGreaterThanOrEqual(3) // 定义 + 两处消费
    expect(codeSource).toContain('yesterday.setDate(yesterday.getDate() - 1)')
  })
})

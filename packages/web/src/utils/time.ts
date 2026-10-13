/**
 * 时间口径**唯一解析入口**（web 侧）。
 *
 * 后端透传的时间戳有**两种形态**，都必须显式当 UTC 解析：
 *   1. SQLite `datetime('now')` 原样串 —— `YYYY-MM-DD HH:MM:SS`，秒级、**无时区后缀**
 *   2. 已带时区标记的 ISO 串 —— `2026-09-14T13:20:00.000Z` / `...+08:00`
 *
 * ⚠️ `new Date(裸串)` 会按**浏览器本地时区**解析 —— UTC+8 下差 8 小时。
 *    这是本模块存在的唯一理由：解析只此一处，组件里别再另写一份。
 *
 * 反面教材（本仓真实发生过）：`timeShort` 曾只做 `ts.slice(0, 16)` 字符串截断、
 * 零时区换算，把 UTC 串当本地时间显示 —— 评分时间与待回标时间**整整早 8 小时**。
 * 形状对、值错，肉眼看不出来，只有拿跨时区的期望值才测得出。
 */

/** 已带时区标记（`Z` 或 `±HH:MM`）—— 原样透传，不再补 Z */
const HAS_TZ = /(?:Z|[+-]\d{2}:\d{2})$/
/** SQLite `datetime('now')` 形态：空格分隔、无时区。**秒可省**——收紧会造回归：
 *  旧 `fmtUtcShort` 是无条件 `replace(' ', 'T') + 'Z'`，`HH:MM` 形态它认得。 */
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/

/** 时间戳串 → 浏览器可正确解析的 UTC 串。识别不出形态的原样返回（由调用方判 Invalid）。 */
export function normalizeUtc(raw: string): string {
  if (HAS_TZ.test(raw)) return raw
  if (SQLITE_UTC.test(raw)) return raw.replace(' ', 'T') + 'Z'
  return raw
}

/** 唯一解析入口：时间戳串 → `Date`。空值 / 解析失败返回 `null`（**不返回 Invalid Date**，
 *  调用方不必再 `Number.isNaN(d.getTime())`）。 */
export function parseUtc(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const d = new Date(normalizeUtc(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** **本地时区** `MM-DD HH:mm`（同年内不显示年份）。无法解析时**原样回显**——不静默吞成空串。 */
export function fmtUtcShort(s: string | null | undefined): string {
  if (!s) return '—'
  const d = parseUtc(s)
  if (!d) return s
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** **本地时区** `YYYY-MM-DD HH:mm`（需要年份的场景）。
 *  形状与它替换掉的旧 `timeShort` **逐字一致**——本函数只修时区，不改显示格式。 */
export function fmtUtcFull(s: string | null | undefined): string {
  if (!s) return '—'
  const d = parseUtc(s)
  if (!d) return s
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// ─── 消息时间戳按日分级 ───────────────────────
//
// 分档**只看自然日**（`getFullYear`/`getMonth`/`getDate` 的本地读数），不看秒级间隔：
// 今天 00:00 的消息在 23:59 看仍是「今天」。
// `now` 是**显式入参**——纯函数不碰 `Date.now()`，测试不需要 fake timer。
//
// ⚠️ **「昨天」必须优先于「跨年」判定**：12-31 的消息在 01-01 看要显示「昨天」，
//    不是「2025年12月31日」。先判年会把这一档吃掉——顺序是语义的一部分，别重排。

/** 入参两种形态 → **本地读数**的 `Date`。数字走 `new Date(n)`，串走 `parseUtc`（唯一解析入口）。 */
function toLocalDate(raw: string | number): Date | null {
  if (typeof raw === 'number') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return parseUtc(raw)
}

/** 消息日期相对 `now` 的分档（自然日）：`0` = 今天，`1` = 昨天，`2` = 更早。 */
function dayBucket(d: Date, now: Date): 0 | 1 | 2 {
  if (d.toDateString() === now.toDateString()) return 0
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 1
  return 2
}

/** **消息时间戳**按日分级（本地时区，`now` 为参照时刻）：
 *
 *  | 相对 `now` | 产物 |
 *  | --- | --- |
 *  | 今天 | `HH:mm` |
 *  | 昨天 | `昨天 HH:mm` |
 *  | 更早、当年内 | `M月D日 HH:mm` |
 *  | 跨年 | `YYYY年M月D日 HH:mm` |
 *
 * 解析失败 / 空值 → `''`（该条消息只是不显示时间，不静默回显原始串）。 */
export function fmtMsgTime(raw: string | number, now: Date): string {
  const d = toLocalDate(raw)
  if (!d) return ''
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  switch (dayBucket(d, now)) {
    case 0:
      return hm
    case 1:
      return `昨天 ${hm}`
    default:
      return d.getFullYear() === now.getFullYear()
        ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
        : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  }
}

/** **日期分隔线**文案，分档与 `fmtMsgTime` 同源（同一 `dayBucket`），只是不带时刻：
 *  今天/`今天`、昨天/`昨天`、当年内/`M月D日`、跨年/`YYYY年M月D日`。
 *
 *  跨年档补年份是**既有缺陷的修复点**——旧 `formatDate` 只到 `M月D日`，去年 12 月
 *  与上个月在分隔线上同形、分不出来。 */
export function fmtDateSep(raw: string | number, now: Date): string {
  const d = toLocalDate(raw)
  if (!d) return ''
  switch (dayBucket(d, now)) {
    case 0:
      return '今天'
    case 1:
      return '昨天'
    default:
      return d.getFullYear() === now.getFullYear()
        ? `${d.getMonth() + 1}月${d.getDate()}日`
        : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  }
}

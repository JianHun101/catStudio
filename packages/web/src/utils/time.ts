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

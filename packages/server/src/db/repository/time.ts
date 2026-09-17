/**
 * 时间口径的**唯一生成 / 归一入口**（server 侧；spec §4.2 ⑤-a / ⑤-c）。
 *
 * 目标口径：ISO 8601 UTC **毫秒**（`2026-09-17T08:30:00.123Z`）。定宽 ⇒ 字典序 = 时间序，
 * 索引/排序/字符串比较三者同一把尺子；`new Date().toISOString()` 直出，零转换。
 *
 * 两个方向**分开**，混用是错序的源头：
 *
 * - **生成**（写库）：`nowIso()` / `isoMinutesAgo()`。记录时间（created_at / updated_at）由
 *   repository 层统一生成，调用方不许传（⑤-c）。事件时间（started_at / ended_at 这类
 *   「事情发生时刻」）允许调用方显式传入，但命名必须体现事件语义。
 * - **归一**（读库 / 比较）：`toIsoDb()` / `toIsoDbUpper()`。库里**同时存在**两种形态——
 *   已迁 ISO 的表（messages，票 5）与仍为秒级 `datetime('now')` 的表（sessions /
 *   review_verdicts 等，随各自重建票迁移）。跨形态比较会静默错序：`' '`(0x20) < `'T'`(0x54)
 *   ⇒ 秒级串在**同一天**的所有 ISO 串面前一律判小，区间条件整段失配，且不报错。
 */

/**
 * 库里/入参里实际会出现的**两种形态**，一并吃下：
 *
 * 1. `YYYY-MM-DD HH:MM:SS[.fff]` —— `datetime('now')` 的产物（未迁移的表、老夹具），无时区后缀；
 * 2. `YYYY-MM-DDTHH:MM:SS[.fff]Z` —— ISO。**省略毫秒是常客**：票 5 之前本仓 API 的
 *    `createdAt` 就是这个形状（`row.created_at.replace(' ','T')+'Z'`），客户端把它原样
 *    回传当窗口参数 ⇒ 归一器必须认，否则 `'…:00.000Z'` 与 `'…:00Z'` 在第 19 位
 *    （`.` 0x2E vs `Z` 0x5A）判不等，边界消息**静默漏出窗口**。
 *
 * 只认「UTC 或省略时区」（省略即按 UTC——仓内所有时间列都是 UTC）。带 `±HH:MM` 偏移的串
 * 不在这里折算：折算要真做日期运算，而本函数的职责是**统一形态**不是时区换算；认不出就
 * 原样透传，由下游按无效值处理（不猜）。
 */
const DB_TS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z)?$/

/** 记录时间生成点：当前时刻的 ISO 毫秒 UTC 串 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 回溯 N 分钟的 ISO 毫秒 UTC 串（超时窗比较用） */
export function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

/** 秒级/ISO 混形态 → 统一 ISO 毫秒（**下界**口径：省略小数秒 = 该秒的 `.000`）。
 *
 *  已是 ISO（含 `T`）或形态认不出 ⇒ **原样返回**——归一不负责纠错，认不出就交给下游按
 *  「无效时间」处理（`Date.parse` → NaN），不在这里猜。 */
export function toIsoDb(ts: string): string {
  const m = DB_TS.exec(ts)
  if (m === null) return ts
  const frac = (m[3] ?? '000').padEnd(3, '0').slice(0, 3)
  return `${m[1]}T${m[2]}.${frac}Z`
}

/** 秒级/ISO 混形态 → 统一 ISO 毫秒（**上界**口径：省略小数秒 = 该秒的 `.999`）。
 *
 *  为什么上界要单独一个函数：迁移前 `created_at <= '2026-09-17 08:30:00'` 是**整秒含入**
 *  （秒级列里 `.5` 那种值不存在），迁到毫秒精度后同一句会变成「含到 .000 为止」——
 *  同一秒里 `.001~.999` 的消息**静默从结果里消失**。省略小数秒的输入按「整秒含入」
 *  折算，新旧行为逐条对齐；显式给了小数秒的输入则精确比较（调用方说了算）。 */
export function toIsoDbUpper(ts: string): string {
  const m = DB_TS.exec(ts)
  if (m === null) return ts
  if (m[3] !== undefined) return toIsoDb(ts)
  return `${m[1]}T${m[2]}.999Z`
}

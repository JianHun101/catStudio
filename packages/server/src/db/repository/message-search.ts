/**
 * 会话历史视图的两个**只读**查询（右栏历史面板的服务端底座）。
 *
 * 与 `messages.ts` / `query.ts` 的分工：
 *   - `query.ts` 是**猫的排障通道**（可见性按上下文过滤、强制当前会话）；
 *   - 本文件是**给人看的历史视图**：不套 `getRelevantMessages`、不按 agent 过滤，
 *     `role='system'` 照常返回——人看的是会话全貌，不是某只猫的上下文。
 *   - 也因此这些函数不走 `messages.ts`（那一侧的口径是「agent 可读的消息」，
 *     `getSessionMessagesRange` 等一律排除 system），SQL 与投影范围都不同。
 *
 * 两个函数都只被 `routes/sessions.ts` 消费；行投影（11 字段 DTO）在路由层，本文件只出
 * `MessageRow`，避免同一个 wire 形状出现两处拼装点。
 */
import type Database from 'better-sqlite3'
import type { MessageRow } from './types.js'
import { toIsoDb, toIsoDbUpper } from './time.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 时区偏移的合法区间（分钟）：UTC-14:00 ~ UTC+14:00，与 IANA 时区实际范围一致 */
const TZ_OFFSET_MIN = -840
const TZ_OFFSET_MAX = 840

/** facets 的单日计数 */
export interface MessageFacetDay {
  date: string
  count: number
}

/** facets 的月份（由 days 聚合去重，不单独查 SQL） */
export interface MessageFacetMonth {
  month: string
}

export interface SessionMessageFacets {
  /** 会话全部消息数（**含 system**——人看的历史视图不排除运维通告） */
  total: number
  days: MessageFacetDay[]
  months: MessageFacetMonth[]
}

/**
 * 把 LIKE 的搜索词转义成**字面量**（`q` 里的 `\`、`%`、`_` 不得当通配符）。
 *
 * 顺序**不能反**：必须先转义 `\` 再转义 `%` / `_`，否则后两步产出的反斜杠会被再转一次，
 * 变成 `\\%`（匹配字面反斜杠 + 任意串）。SQL 侧配 `ESCAPE '\'`。
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** 偏移分钟 → SQLite `strftime` 的 modifier（`+480 minutes` / `-300 minutes`） */
function tzModifier(offsetMinutes: number): string {
  const clamped = Math.max(TZ_OFFSET_MIN, Math.min(TZ_OFFSET_MAX, offsetMinutes))
  const sign = clamped < 0 ? '-' : '+'
  return `${sign}${Math.abs(clamped)} minutes`
}

/**
 * 会话历史的日期/月份索引（右栏日期条的角标与「更早」入口）。
 *
 * **按 tzOffset 换算后分组**，不能用 `substr(created_at, 1, 10)` 直接截 UTC 日期：
 * UTC 22:30 的消息在东八区属于第二天，截 UTC 会把晚间消息错落到前一天（静默错位，
 * 不报错）。SQLite 认得 ISO 毫秒带 `Z` 的形态（3.38+），偏移以 modifier 绑定传入。
 */
export function getSessionMessageFacets(
  sessionId: string,
  tzOffsetMinutes = 0
): SessionMessageFacets {
  const modifier = tzModifier(Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0)

  const totalRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?')
    .get(sessionId) as { cnt: number }

  const days = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at, ?) AS date, COUNT(*) AS cnt
       FROM messages
       WHERE session_id = ?
       GROUP BY date
       ORDER BY date DESC`
    )
    .all(modifier, sessionId) as Array<{ date: string; cnt: number }>

  // 月份由 days 聚合：同一次扫描的产物，不另起一条 SQL（两处 GROUP BY 必然分叉）
  const seen = new Set<string>()
  const months: MessageFacetMonth[] = []
  for (const d of days) {
    const month = d.date.slice(0, 7)
    if (seen.has(month)) continue
    seen.add(month)
    months.push({ month })
  }

  return {
    total: totalRow?.cnt ?? 0,
    days: days.map((d) => ({ date: d.date, count: d.cnt })),
    months,
  }
}

export interface SearchSessionMessagesOptions {
  /** 搜索词（必填、trim 后非空、≤200 字符；校验在路由层，本函数只按原样使用） */
  q: string
  limit?: number
  /** 排他游标：严格早于该消息（与 `getSessionMessagesRange` 的 before 同语义） */
  before?: string
  from?: string
  to?: string
}

export interface SearchSessionMessagesResult {
  rows: MessageRow[]
  /** 该 `q` + `from`/`to` 的匹配总数——**不受 before/limit 影响**（单独 COUNT，不拿 rows.length 冒充） */
  total: number
}

/**
 * 按正文（或发送者名）搜会话内消息。
 *
 * - 排序 `created_at DESC, id DESC`：与既有 `/messages` 同口径（同毫秒并发写、老库整秒行
 *   折成同值，只比时间会漏行/重行）。
 * - `total` 单独 `COUNT(*)`：翻页时 total 不随 `before` 缩水。
 * - 发送者名匹配：前端契约要求「搜索匹配正文与发送者」，而正文 LIKE 单独无法覆盖
 *   只记得猫名的场景；用 `EXISTS` 子查询而不是 JOIN——一条消息最多一行，不会因 JOIN 放大。
 */
export function searchSessionMessages(
  sessionId: string,
  opts: SearchSessionMessagesOptions
): SearchSessionMessagesResult {
  const rawLimit = opts.limit ?? 50
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50
  const like = `%${escapeLikeTerm(opts.q.trim())}%`

  const where: string[] = [
    'm.session_id = ?',
    `(m.content LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM agents a WHERE a.id = m.agent_id AND a.name LIKE ? ESCAPE '\\'))`,
  ]
  const params: Array<string | number> = [sessionId, like, like]

  // 时间窗归一与 `getSessionMessagesRange` 同源：秒级串与 ISO 混比会静默错序
  if (opts.from !== undefined) {
    where.push('m.created_at >= ?')
    params.push(toIsoDb(opts.from))
  }
  if (opts.to !== undefined) {
    where.push('m.created_at <= ?')
    // 上界走 `toIsoDbUpper`：省略小数秒的输入按「整秒含入」折算（`.999`），
    // 否则同一秒里 `.001~.999` 的消息会静默从结果里消失
    params.push(toIsoDbUpper(opts.to))
  }

  const whereSql = where.join(' AND ')
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM messages m WHERE ${whereSql}`)
    .get(...params) as { cnt: number }

  const pageWhere = [...where]
  const pageParams = [...params]
  if (opts.before) {
    // 游标不在本会话 → 位置不可定 → 空页（与 getSessionMessagesRange 同款：
    // 客户端据此自然停止翻页，而不是从头再取一页）
    const cursor = db
      .prepare('SELECT created_at, id FROM messages WHERE id = ? AND session_id = ?')
      .get(opts.before, sessionId) as { created_at: string; id: string } | undefined
    if (!cursor) return { rows: [], total: totalRow?.cnt ?? 0 }
    pageWhere.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))')
    pageParams.push(cursor.created_at, cursor.created_at, cursor.id)
  }
  pageParams.push(limit)

  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(...pageParams) as MessageRow[]

  return { rows, total: totalRow?.cnt ?? 0 }
}

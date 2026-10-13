/**
 * `human_labels` 表写入/查询（J1 人工标注子系统）。
 *
 * 语义：**独立**的人工评分，与 `eval_scores`（判官分）**无外键关联**——它是判官分的
 * 基准，不是对判官分的回标（那是 `user_feedback` 的事，两表分工见迁移条目上方注释）。
 * 唯一关联面是 `message_id`：J1 的一致性计算按它 JOIN 两表。
 *
 * 重复提交同 `message_id` = **覆盖**（先查后写返回 covered，路由层据此 log 留痕）——
 * 照 `userFeedback.upsertFeedback` 同款语义（契约钉死：不 409）。覆盖只改分/评语，
 * `created_at` 保留**首次**标注时间锚点。
 */
import type Database from 'better-sqlite3'
import { nowIso } from './time.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export interface HumanLabelRow {
  id: string
  message_id: string
  session_id: string | null
  agent_id: string | null
  labeler: string
  score: number
  comment: string | null
  created_at: string
}

/** 该 message 是否已有人工标注（覆盖判定 + 盲标池排除已标注用） */
export function hasLabel(messageId: string): boolean {
  const row = db.prepare('SELECT 1 FROM human_labels WHERE message_id = ?').get(messageId) as
    { '1': number } | undefined
  return row !== undefined
}

/**
 * 落一条人工标注。先查后写：已存在 → UPDATE 分/评语/标注源（`created_at` 保留首次时间锚点）；
 * 不存在 → INSERT（时间取 `nowIso()`，不由调用方传——⑤-c）。返回是否覆盖，供路由层 log 留痕。
 */
export function upsertLabel(data: {
  id: string
  messageId: string
  sessionId: string | null
  agentId: string | null
  labeler: string
  score: number
  comment: string | null
}): boolean {
  const covered = hasLabel(data.messageId)
  if (covered) {
    db.prepare(
      `UPDATE human_labels
       SET score = ?, comment = ?, labeler = ?
       WHERE message_id = ?`
    ).run(data.score, data.comment, data.labeler, data.messageId)
  } else {
    db.prepare(
      `INSERT INTO human_labels (id, message_id, session_id, agent_id, labeler, score, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.id,
      data.messageId,
      data.sessionId,
      data.agentId,
      data.labeler,
      data.score,
      data.comment,
      nowIso()
    )
  }
  return covered
}

/** 按 message_id 查标注（覆盖留痕 / 测试断言用） */
export function getByMessageId(messageId: string): HumanLabelRow | undefined {
  return db.prepare('SELECT * FROM human_labels WHERE message_id = ?').get(messageId) as
    HumanLabelRow | undefined
}

/** 最近 N 条标注（倒序；标注进度展示用） */
export function listLabels(
  opts: { limit?: number; agentId?: string | null } = {}
): HumanLabelRow[] {
  const { limit = 50, agentId = null } = opts
  const rows = agentId
    ? db
        .prepare('SELECT * FROM human_labels WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(agentId, limit)
    : db.prepare('SELECT * FROM human_labels ORDER BY created_at DESC LIMIT ?').all(limit)
  return rows as HumanLabelRow[]
}

/** 已标注总条数（J1 分母读数用） */
export function countLabels(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM human_labels').get() as { n: number }
  return row.n
}

/** 提交标注前的目标校验取数：这条消息在不在、是不是**猫的回复**、归属哪只猫哪个会话。
 *
 *  为什么自带一条而不是复用 `messages.getMessageByIdOnly`（也在本仓、也按 id 查）：那个
 *  函数是 **handoff 链的契约件**（`catstudy [uuid]` 反查投递会话），返回值形状被跨模块
 *  依赖；为标注面往它的 SELECT 里加列 = 让一条无关链路跟着动。本函数只服务标注面，
 *  `role` 也一并取回（`'agent'` 判定要在写入前做，见路由）。 */
export function getLabelTarget(
  messageId: string
): { id: string; session_id: string; agent_id: string | null; role: string } | undefined {
  return db
    .prepare('SELECT id, session_id, agent_id, role FROM messages WHERE id = ?')
    .get(messageId) as
    { id: string; session_id: string; agent_id: string | null; role: string } | undefined
}

// ─── 盲标池取数 ────────────────────────────────────────

/** 池中一行 = 一条待标注的猫回复 + 猫名。**不含任何判官分字段**（盲标是方法论硬要求，
 *  见下方 `listLabelPool` 注释）。 */
export interface LabelPoolRow {
  id: string
  session_id: string
  agent_id: string | null
  content: string
  created_at: string
  agent_name: string | null
}

/**
 * 待标注候选池（J1 盲标池）。取数口径四条，**每条都有理由**：
 *
 * 1. `role = 'agent'` —— 只抽**猫的回复**。⚠️ 本仓 `messages.role` 的闭集是
 *    `('user','agent','system')`（`MESSAGES_TABLE_DDL`），**没有 `'assistant'`**；
 *    「猫的回复」在这一列上的字面量就是 `'agent'`（`repository/messages.ts` 的
 *    `role = 'agent'` 取数处同口径）。
 * 2. **跨会话分散**：`ROW_NUMBER() OVER (PARTITION BY session_id …) <= perSession`。
 *    不分散的话，池子会被最近活跃的那一个会话吃满——而判官可信度要测的恰恰是
 *    **跨语境**的稳定性（样本集中在一个会话 = 一个语境）。
 * 3. **排除已标注**：`NOT EXISTS (SELECT 1 FROM human_labels …)`。这是「标完即移出
 *    列表」的服务端真源，前端那次 filter 只是即时反馈。
 * 4. **排除空内容**：`TRIM(content) <> ''`——空回复没法标，放进池子只会消耗标注者的耐心。
 *
 * **判官分不参与任何一条**（既不筛高也不筛低，`eval_scores` 根本不 JOIN）：样本选择权
 * 一旦交给被判定的对象，测出来的就是「判官像不像它自己」。**响应结构里也不含判官分**
 * ——盲标不是 UI 偏好，显示了就污染基准。
 *
 * 时间窗用 SQLite 自己的 `strftime` 算（不与 JS 时钟对表），格式与 `messages.created_at`
 * 的 ISO 毫秒逐字同形；`days` 走**参数拼接**而非字符串插值（modifier 也是绑定值）。
 */
export function listLabelPool(opts: {
  limit: number
  perSession: number
  agentId?: string | null
  days?: number | null
}): LabelPoolRow[] {
  const { limit, perSession, agentId = null, days = null } = opts
  return db
    .prepare(
      `WITH ranked AS (
         SELECT m.id, m.session_id, m.agent_id, m.content, m.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY m.session_id
                  ORDER BY m.created_at DESC, m.id DESC
                ) AS rn
         FROM messages m
         WHERE m.role = 'agent'
           AND TRIM(m.content) <> ''
           AND (@agentId IS NULL OR m.agent_id = @agentId)
           AND (@days IS NULL
                OR m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || @days || ' days'))
           AND NOT EXISTS (SELECT 1 FROM human_labels h WHERE h.message_id = m.id)
       )
       SELECT r.id, r.session_id, r.agent_id, r.content, r.created_at,
              a.name AS agent_name
       FROM ranked r
       LEFT JOIN agents a ON a.id = r.agent_id
       WHERE r.rn <= @perSession
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT @limit`
    )
    .all({ limit, perSession, agentId, days }) as LabelPoolRow[]
}

// ─── J1 一致性取数 ─────────────────────────────────────

/** 一对已配对样本：同一条 message 上的判官分与人工分。**只取分数**——度量不需要别的。 */
export interface JudgeHumanPairRow {
  message_id: string
  judge_score: number
  human_score: number
  judge_model: string
}

/**
 * JOIN `eval_scores` × `human_labels`（按 `message_id`，两边都是 UNIQUE ⇒ 一对一，不会
 * 因 JOIN 放大而重复计样本）。**取数层不做任何筛选**：ignore（3 分）样本由
 * `phase0.agreementRate` 自己出分母（同一把尺子），本层筛一遍就是第二条真相源。
 */
export function listJudgeHumanPairs(): JudgeHumanPairRow[] {
  return db
    .prepare(
      `SELECT s.message_id      AS message_id,
              s.score           AS judge_score,
              h.score           AS human_score,
              s.judge_model     AS judge_model
       FROM eval_scores s
       JOIN human_labels h ON h.message_id = s.message_id
       ORDER BY s.created_at DESC`
    )
    .all() as JudgeHumanPairRow[]
}

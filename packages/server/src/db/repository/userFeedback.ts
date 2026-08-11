/**
 * user_feedback 表写入/查询（W4 用户回标子系统）。
 *
 * 语义：用户对低分采样样本的人工复核，与 eval_scores 通过 eval_score_id
 * 一对一关联（UNIQUE 兜底）。重复回标 = 覆盖（先查后写返回 covered，
 * 路由层据此 log 留痕）——覆盖只改值，created_at 保留首次回标时间锚点。
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export interface UserFeedbackRow {
  id: string
  eval_score_id: string
  message_id: string | null
  session_id: string | null
  user_score: number
  comment: string | null
  created_at: string
}

/** 该 eval_score_id 是否已有回标（覆盖判定用） */
export function hasFeedback(evalScoreId: string): boolean {
  const row = db.prepare('SELECT 1 FROM user_feedback WHERE eval_score_id = ?').get(evalScoreId) as
    { '1': number } | undefined
  return row !== undefined
}

/**
 * 落一条回标。先查后写：已存在 → UPDATE 全字段覆盖（created_at 保留
 * 首次时间锚点）；不存在 → INSERT。返回是否覆盖，供路由层 log 留痕。
 */
export function upsertFeedback(data: {
  id: string
  evalScoreId: string
  messageId: string | null
  sessionId: string | null
  userScore: number
  comment: string | null
}): boolean {
  const covered = hasFeedback(data.evalScoreId)
  if (covered) {
    db.prepare(
      `UPDATE user_feedback
       SET user_score = ?, comment = ?
       WHERE eval_score_id = ?`
    ).run(data.userScore, data.comment, data.evalScoreId)
  } else {
    db.prepare(
      `INSERT INTO user_feedback (id, eval_score_id, message_id, session_id, user_score, comment)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(data.id, data.evalScoreId, data.messageId, data.sessionId, data.userScore, data.comment)
  }
  return covered
}

/** 按 eval_score_id 查回标（路由覆盖判定/测试断言用） */
export function getByEvalScoreId(evalScoreId: string): UserFeedbackRow | undefined {
  return db.prepare('SELECT * FROM user_feedback WHERE eval_score_id = ?').get(evalScoreId) as
    UserFeedbackRow | undefined
}

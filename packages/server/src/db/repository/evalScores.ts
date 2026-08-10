/**
 * eval_scores 表写入/查询函数（W2 L2 评估子系统）。
 *
 * 语义：judge 模型对采样回复的评分落库，与执行日志独立——评估是旁路
 * （fire-and-forget，不占 agent slot、不进 dispatch 主链）。同一条回复
 * 只评一次：message_id 唯一约束由调用方保证（sampler 先查后写，防重复评分）。
 */
import type Database from 'better-sqlite3'
import type { SampleReason } from '../../eval/sampler.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export interface EvalScoreRow {
  id: string
  message_id: string
  session_id: string
  agent_id: string | null
  score: number
  dimensions: string | null
  judge_model: string
  sample_reason: SampleReason
  created_at: string
}

/** 该回复是否已有评分（避免同消息重复评分） */
export function hasScore(messageId: string): boolean {
  const row = db.prepare('SELECT 1 FROM eval_scores WHERE message_id = ?').get(messageId) as
    { '1': number } | undefined
  return row !== undefined
}

/** 落一条评分。调用方负责先查后写（hasScore），此处 INSERT 失败即抛。 */
export function insertScore(data: {
  id: string
  messageId: string
  sessionId: string
  agentId: string | null
  score: number
  dimensionsJson: string | null
  judgeModel: string
  sampleReason: SampleReason
}): void {
  db.prepare(
    `INSERT INTO eval_scores (id, message_id, session_id, agent_id, score, dimensions, judge_model, sample_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.id,
    data.messageId,
    data.sessionId,
    data.agentId,
    data.score,
    data.dimensionsJson,
    data.judgeModel,
    data.sampleReason
  )
}

/** 评分后回写 sample_reason（score ≤ 2 → 'low_score'，契约：同一条记录原地 UPDATE） */
export function updateSampleReason(messageId: string, reason: SampleReason): void {
  db.prepare('UPDATE eval_scores SET sample_reason = ? WHERE message_id = ?').run(reason, messageId)
}

/** 按 message_id 查评分（Phase 0 与低分回写复核用） */
export function getScoreByMessageId(messageId: string): EvalScoreRow | undefined {
  return db.prepare('SELECT * FROM eval_scores WHERE message_id = ?').get(messageId) as
    EvalScoreRow | undefined
}

/** 最近 N 条评分（倒序；低分样本回查用） */
export function getRecentScores(limit: number = 50): EvalScoreRow[] {
  return db
    .prepare('SELECT * FROM eval_scores ORDER BY created_at DESC LIMIT ?')
    .all(limit) as EvalScoreRow[]
}

/**
 * eval_scores 表写入/查询函数（W2 L2 评估子系统）。
 *
 * 语义：judge 模型对采样回复的评分落库，与执行日志独立——评估是旁路
 * （fire-and-forget，不占 agent slot、不进 dispatch 主链）。同一条回复
 * 只评一次：DB 层 message_id UNIQUE 索引兜底（迁移里建），调用方仍先查
 * 后写（hasScore）避免浪费一次 judge 调用。
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

/** 按 id 查评分（E4 回标 404 判定用） */
export function getScoreById(id: string): EvalScoreRow | undefined {
  return db.prepare('SELECT * FROM eval_scores WHERE id = ?').get(id) as EvalScoreRow | undefined
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

/** 评分行 + 猫名（E4 评估中心列表用；LEFT JOIN 兼容 agent 已删除的行） */
export interface ScoreWithAgentName extends EvalScoreRow {
  agent_name: string | null
}

/** 最近评分列表（倒序；agentId 可选过滤）——snake_case 原样出 */
export function listScores(
  opts: { limit?: number; agentId?: string | null } = {}
): ScoreWithAgentName[] {
  const { limit = 50, agentId = null } = opts
  const base = `
    SELECT s.*, a.name AS agent_name
    FROM eval_scores s
    LEFT JOIN agents a ON a.id = s.agent_id
  `
  const rows = agentId
    ? db
        .prepare(`${base} WHERE s.agent_id = ? ORDER BY s.created_at DESC LIMIT ?`)
        .all(agentId, limit)
    : db.prepare(`${base} ORDER BY s.created_at DESC LIMIT ?`).all(limit)
  return rows as ScoreWithAgentName[]
}

/** 按猫聚合（E4 评估中心卡片用）：count / avg_score / low_score_rate（≤2 占比） */
export interface ScoreAggregate {
  agent_id: string | null
  agent_name: string | null
  count: number
  avg_score: number
  low_score_rate: number
}

export function getAggregates(): ScoreAggregate[] {
  return db
    .prepare(
      `SELECT s.agent_id,
              a.name AS agent_name,
              COUNT(*) AS count,
              ROUND(AVG(s.score), 2) AS avg_score,
              ROUND(SUM(CASE WHEN s.score <= 2 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 2) AS low_score_rate
       FROM eval_scores s
       LEFT JOIN agents a ON a.id = s.agent_id
       GROUP BY s.agent_id
       ORDER BY count DESC`
    )
    .all() as unknown as ScoreAggregate[]
}

/** 待回标样本：low_score 且无 user_feedback 引用，附回复全文（倒序，最新在前） */
export interface PendingReviewScore extends EvalScoreRow {
  agent_name: string | null
  reply_content: string
  reply_created_at: string
}

export function getPendingReviewScores(limit: number = 20): PendingReviewScore[] {
  return db
    .prepare(
      `SELECT s.*, a.name AS agent_name, m.content AS reply_content, m.created_at AS reply_created_at
       FROM eval_scores s
       JOIN messages m ON m.id = s.message_id
       LEFT JOIN agents a ON a.id = s.agent_id
       WHERE s.sample_reason = 'low_score'
         AND NOT EXISTS (SELECT 1 FROM user_feedback f WHERE f.eval_score_id = s.id)
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .all(limit) as PendingReviewScore[]
}

/** 该回复之前最近 N 条会话上下文（ASC 返回，前端顺序展示） */
export function getContextBefore(
  sessionId: string,
  beforeCreatedAt: string,
  limit: number = 10
): Array<{
  id: string
  role: string
  agent_id: string | null
  content: string
  created_at: string
}> {
  const rows = db
    .prepare(
      `SELECT id, role, agent_id, content, created_at
       FROM messages
       WHERE session_id = ? AND created_at < ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(sessionId, beforeCreatedAt, limit) as Array<{
    id: string
    role: string
    agent_id: string | null
    content: string
    created_at: string
  }>
  return rows.reverse()
}

/** 回标写入成功后翻转样本标记（重复回标时同值 UPDATE 幂等无害） */
export function markSampleReason(evalScoreId: string, reason: SampleReason): void {
  db.prepare('UPDATE eval_scores SET sample_reason = ? WHERE id = ?').run(reason, evalScoreId)
}

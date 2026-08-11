/**
 * review_verdicts / review_parse_failures 表写入函数（W3 L3 契约）。
 *
 * 语义：reviewer 回复的审查结论结构化落库（L1 聚合的 suggest_rate/reject_rate
 * 与解析失败率的数据源）。设计路径失败（no_subject/bad_verdict）才写
 * review_parse_failures；DB 异常由调用方（recordReviewVerdict）包 try/catch
 * 静默丢弃，不阻塞审查链主流程。
 */
import type Database from 'better-sqlite3'
import type { ReviewVerdict, VerdictParseFailureReason } from '../../eval/verdict-parser.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/**
 * 落一条审查结论。INSERT OR IGNORE：message_id 主键——同消息重复解析
 * （理论上钩子单次执行只跑一遍，防御性去重）静默跳过不报错。
 */
export function insertReviewVerdict(data: {
  messageId: string
  sessionId: string
  reviewerAgentId: string
  subjectAgentId: string | null
  verdict: ReviewVerdict
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict)
     VALUES (?, ?, ?, ?, ?)`
  ).run(data.messageId, data.sessionId, data.reviewerAgentId, data.subjectAgentId, data.verdict)
}

/** 落一条解析失败记录（no_subject / bad_verdict），raw 存回复原文。 */
export function insertReviewParseFailure(data: {
  messageId: string
  reason: VerdictParseFailureReason
  raw: string
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO review_parse_failures (message_id, reason, raw)
     VALUES (?, ?, ?)`
  ).run(data.messageId, data.reason, data.raw)
}

/**
 * 按任务链反查"是否已有 ✅ approve 审查结论"（补填请求风暴根治方向 1）。
 * 判定链（与 executor 反查同源）：task_id = 链末 execution_log.trace_id（E3 接线
 * 锚定源）→ JOIN messages 找该任务链上审查结论消息 → 只认 verdict='approve'。
 * 语义：有修改（suggest/reject）就有新审查，仍须补填——只有 approve 才 true。
 * task_id 为空/无匹配 → false（无执行记录、老数据、无结论一律按未批准处理）。
 */
export function hasApproveVerdictByTaskId(taskId: string | null | undefined): boolean {
  if (!taskId) return false
  return !!db
    .prepare(
      `SELECT 1 FROM review_verdicts v
       JOIN messages m ON v.message_id = m.id
       WHERE m.task_id = ? AND v.verdict = 'approve'
       LIMIT 1`
    )
    .get(taskId)
}

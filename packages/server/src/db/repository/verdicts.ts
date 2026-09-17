/**
 * review_verdicts / review_parse_failures 表写入函数（W3 L3 契约）。
 *
 * 语义：reviewer 回复的审查结论结构化落库（L1 聚合的 suggest_rate/reject_rate
 * 与解析失败率的数据源）。设计路径失败（no_subject/bad_verdict）才写
 * review_parse_failures；DB 异常由调用方（recordReviewVerdict）包 try/catch
 * 静默丢弃，不阻塞审查链主流程。
 */
import type Database from 'better-sqlite3'
import { nowIso } from './clock.js'
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
    `INSERT OR IGNORE INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    data.messageId,
    data.sessionId,
    data.reviewerAgentId,
    data.subjectAgentId,
    data.verdict,
    nowIso()
  )
}

/** 落一条解析失败记录（no_subject / bad_verdict），raw 存回复原文。 */
export function insertReviewParseFailure(data: {
  messageId: string
  reason: VerdictParseFailureReason
  raw: string
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO review_parse_failures (message_id, reason, raw, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(data.messageId, data.reason, data.raw, nowIso())
}

/**
 * 按任务链反查"审查链是否已闭环"（补填请求风暴根治方向 1）。
 * 判定链（与 executor 反查同源）：task_id = 链末 execution_log.trace_id（E3 接线
 * 锚定源）→ JOIN messages 找该任务链上审查结论消息。
 * 语义：**闭环档 = approve / comment**——两者都不要求返工，链在他们之后不再
 * 产生新 commit，故不该再投补填请求（T-C：💬 非阻断，不得"起一轮"）。
 * 有修改（suggest/reject）就有新审查，仍须补填 → false。
 * task_id 为空/无匹配 → false（无执行记录、老数据、无结论一律按未闭环处理）。
 *
 * 命名：原 hasApproveVerdictByTaskId。T-C 加 comment 后「approve」已是子集，
 * 改名以免函数名继续骗人；HTTP 消费方的字段名 `approved` 保持不变（不动 T-A
 * 的 handoff-gen 契约），语义以本函数为准。
 */
export function hasClosedVerdictByTaskId(taskId: string | null | undefined): boolean {
  if (!taskId) return false
  return !!db
    .prepare(
      `SELECT 1 FROM review_verdicts v
       JOIN messages m ON v.message_id = m.id
       WHERE m.task_id = ? AND v.verdict IN ('approve', 'comment')
       LIMIT 1`
    )
    .get(taskId)
}

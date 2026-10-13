/**
 * T2 执行追踪详情两表写口 / 读口（`context_decisions` + `prompt_snapshots`）。
 *
 * 定位与 `retrievalEvents.ts` 同族：**只采不改**——本模块是纯新增写口，不改任何
 * 上下文构建 / 注入行为。三个板块（上下文决策 / 检索明细 / prompt 快照）里，
 * 检索明细完全复用既有 `retrievalEvents` 读函数，本模块只管另两块。
 *
 * 两条硬约束照抄 `retrievalEvents`（同一段关键路径，同一套失败语义）：
 *
 * 1. **两表同事务**：一次执行的决策明细与快照必须一起落盘——「有决策没快照」的
 *    详情页会渲染成半截（前端按 execution 一次拉全，缺哪块都是缺）。
 * 2. **失败绝不抛**：调用点在 `execution/reply.ts` 的关键路径上，抛了会杀死本轮回复。
 *    失败 = 整个事务回滚（无半截行）+ 记一次痕。
 *
 * **落库时机**：唯一写点是 `execution/reply.ts` 的 `recordTraceDetails`（在 memory /
 * knowledge 注入**之后**、`llm.chat` 之前）——快照要的是**当次真正送进模型的那串**，
 * 早一步写就会漏掉后注入的两块。
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../../logger.js'
import { messageOf } from '../../utils.js'
import { nowIso } from './time.js'

const log = createLogger('trace-details')

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 上下文决策（`context_decisions`）────────────────────────

/**
 * 一条消息在本轮上下文里的**去向**。
 *
 * 值域刻意互斥且穷尽——「没进 prompt」的三种成因对应**三种相反的药方**，
 * 糊成一个「没进」就永远分不出来（与 `retrieval_events.dropped_reason` 同款理由）：
 * - `kept`           进了 prompt。**唯一带 `replied` 细节的档**（见下）。
 * - `invisible`      被可见性过滤（`getRelevantMessages`）——@ 了别的猫的用户消息 /
 *                    非广播模式下别猫的回复。药方 = 广播模式或改 @ 对象。
 * - `summary_replaced` 被摘要块替代（压缩层）。药方 = 调 `SUMMARY_*` 阈值。
 * - `budget`         超 token 软预算被截断。药方 = 加 `MAX_CONTEXT_TOKENS`。
 */
export type ContextDecision = 'kept' | 'invisible' | 'summary_replaced' | 'budget'

/** 决策发生在哪一级（与 `context.assemble` / `context.compress` 两段一一对应） */
export type ContextDecisionStage = 'assemble' | 'compress' | 'truncate'

/** `kept` 行的细节：`replied` = 该用户消息被判定「已回复」并追加了标注（仍是筛入）。 */
export type ContextDecisionDetail = 'replied' | null

export interface ContextDecisionInput {
  messageId: string | null
  /** 在 `combinedMessages`（合并 task 历史后的全量）里的下标，0-based 时间正序 */
  ordinal: number
  stage: ContextDecisionStage
  decision: ContextDecision
  detail: ContextDecisionDetail
}

export interface PromptSectionInput {
  /** 稳定键（前端按它拉正文）。值域见 `reply.ts` 的 `TRACE_SECTION_*` 常量 */
  sectionKey: string
  label: string
  /** `injected` = 真进了 prompt / `empty` = 本轮为空 / `truncated` = 注入但被截断 */
  status: 'injected' | 'empty' | 'truncated'
  /** **当次真正注入的那串原文**——不是「重算一遍」的结果 */
  content: string
  /** 展示序（写入序即渲染序） */
  ordinal: number
}

export interface TraceDetailsInput {
  executionId: string
  sessionId: string | null
  decisions: ContextDecisionInput[]
  sections: PromptSectionInput[]
}

/**
 * 两表同事务落盘。**失败绝不抛**——回滚 + 记痕，返回 `false`。
 *
 * 幂等：同名 `section_key` 先删后插，同一 `execution_id` 重跑不留两行。
 * （决策表是自增行，重跑会追加——调用点在 `runAgentReply` 内**每次执行只走一次**，
 * 重跑即新 execution_id，故不需要去重键。）
 */
export function insertTraceDetails(input: TraceDetailsInput): boolean {
  try {
    db.transaction((): void => {
      const createdAt = nowIso()
      const insertDecision = db.prepare(
        `INSERT INTO context_decisions
           (execution_id, session_id, message_id, ordinal, stage, decision, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const d of input.decisions) {
        insertDecision.run(
          input.executionId,
          input.sessionId,
          d.messageId,
          d.ordinal,
          d.stage,
          d.decision,
          d.detail,
          createdAt
        )
      }

      // 同名节先删后插：主键 `(execution_id, section_key)` 下 plain INSERT 会撞键回滚
      db.prepare(`DELETE FROM prompt_snapshots WHERE execution_id = ?`).run(input.executionId)
      const insertSection = db.prepare(
        `INSERT INTO prompt_snapshots
           (execution_id, section_key, label, status, char_count, content, ordinal, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const s of input.sections) {
        insertSection.run(
          input.executionId,
          s.sectionKey,
          s.label,
          s.status,
          s.content.length,
          s.content,
          s.ordinal,
          createdAt
        )
      }
    })()
    return true
  } catch (err: any) {
    // 关键路径上的写口：吞掉 + 记痕（回复照常）。回滚由事务保证——不会留半截行。
    log.warn('执行追踪详情落盘失败（已回滚，不影响本轮回复）', {
      executionId: input.executionId,
      decisions: input.decisions.length,
      sections: input.sections.length,
      error: messageOf(err),
    })
    return false
  }
}

// ─── 读口 ───────────────────────────────────────────────────

/** 一条决策行（读侧投影，snake_case 同 DB 行） */
export interface ContextDecisionRow {
  ordinal: number
  message_id: string | null
  stage: string
  decision: string
  detail: string | null
}

/**
 * 按 `execution_id` 取决策明细（`ordinal` 升序 = 上下文时间正序）。
 *
 * **左连 `messages` 取正文摘要**：详情页要显示「哪条消息被丢了」，只有 id 等于让人
 * 去别处翻。`LEFT JOIN` 而非 `JOIN`——消息可能已随回退/清空删掉（本表 CASCADE 只在
 * 父 `execution_logs` 行删除时触发，而消息删除**会**连删 execution 行，故理论上
 * 同生共死；留 LEFT 是纵深防御，不让一行取不到正文就整条查询空手）。
 *
 * `content_head` 只取前 120 字：本出口是「一眼认出是哪条」，全文请去对话区看
 * （`body_head` 在 `retrieval_candidates` 里存全文是**判官判编造**的专用面，同款
 * 理由不适用于此——这里截断不会丢判据）。
 */
export function getContextDecisions(
  executionId: string
): Array<
  ContextDecisionRow & { agent_id: string | null; role: string | null; content_head: string | null }
> {
  return db
    .prepare(
      `SELECT cd.ordinal        AS ordinal,
              cd.message_id     AS message_id,
              cd.stage          AS stage,
              cd.decision       AS decision,
              cd.detail         AS detail,
              m.agent_id        AS agent_id,
              m.role            AS role,
              substr(m.content, 1, 120) AS content_head
       FROM context_decisions cd
       LEFT JOIN messages m ON m.id = cd.message_id
       WHERE cd.execution_id = ?
       ORDER BY cd.ordinal`
    )
    .all(executionId) as Array<
    ContextDecisionRow & {
      agent_id: string | null
      role: string | null
      content_head: string | null
    }
  >
}

/** 节元数据（**不含正文**——正文走 `getPromptSection` 逐节懒加载） */
export interface PromptSectionMeta {
  section_key: string
  label: string
  status: string
  char_count: number
  ordinal: number
}

/**
 * 按 `execution_id` 取节清单（**不带正文**）。
 *
 * 刻意不返回 `content`：单次执行的 system prompt 全文可达数十 KB，列表展开时一口气
 * 传完等于把详情页首屏绑在最大 payload 上。前端先拿清单渲染「节卡片 + 字符数」，
 * 用户点开哪节才拉哪节正文（与 `票 §三A` 的「点开展开」逐字对应）。
 */
export function getPromptSectionMetas(executionId: string): PromptSectionMeta[] {
  return db
    .prepare(
      `SELECT section_key, label, status, char_count, ordinal
       FROM prompt_snapshots WHERE execution_id = ? ORDER BY ordinal`
    )
    .all(executionId) as PromptSectionMeta[]
}

/**
 * 取单节**当次注入的完整原文**。不存在 → `null`（调用方回 404，不静默给空串——
 * 「这节没写」与「这节内容为空」是两态，后者是合法的 `empty` 节）。
 */
export function getPromptSection(executionId: string, sectionKey: string): string | null {
  const row = db
    .prepare(`SELECT content FROM prompt_snapshots WHERE execution_id = ? AND section_key = ?`)
    .get(executionId, sectionKey) as { content: string } | undefined
  return row ? row.content : null
}

/**
 * 一条执行有没有详情数据（存量行判据）。
 *
 * 详情页要据此显式渲染「无段数据（存量行）」占位——本票之前的所有执行都没有这两张
 * 表的行，直接查会得到空数组，与「跑过且有数据但为空」在面上同形。
 */
export function hasTraceDetails(executionId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM prompt_snapshots WHERE execution_id = ?
       UNION ALL
       SELECT 1 AS present FROM context_decisions WHERE execution_id = ? LIMIT 1`
    )
    .get(executionId, executionId) as { present: number } | undefined
  return row !== undefined
}

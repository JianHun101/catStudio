/**
 * `spans` / `span_llm` 两表写口（P2 / R2，段五执行时间轴）。
 *
 * 定位：**只采不改**——本模块是纯新增写口，不改任何检索 / LLM / 调度行为。
 * 读侧（「哪里耗时最长」看板 / 链路 tab）是后续叶子节点，不在 R2。
 *
 * 一次执行一个事务（R2 §七 硬点 2）：该执行的 8–12 行 span 必须一起落盘，
 * **禁止半写完**（根段落了、子段没落 = 时间轴残缺却看着像完整）。事务在模块内部
 * 自开（与 R1 `retrievalEvents.ts` 同款：`db/repository` 各 repo 持模块级 db 单例，
 * 路由层不包事务）。
 *
 * 写库失败**绝不抛**：调用点在 `finalizeRun` 的关键路径上（槽位释放 / 队列排空
 * 都排在其后），抛了会把一次正常执行拖成异常路径。失败 = 整个事务回滚（无半截行）
 * + 记一次痕，返回 `false`。
 *
 * 插入顺序 = **拓扑序**（根先、子后）：`parent_span_id` 有 FK（`PRAGMA foreign_keys
 * = ON` + SQLite 即时检查），父行必须先落。写口**自己排序**而不是信任调用方——
 * 顺序错了整批回滚，代价远大于一次 `sort`。
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../../logger.js'
import { messageOf } from '../../utils.js'

const log = createLogger('spans')

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** `llm.chat` 段的类型专属属性（`span_llm` 一行；其余段该列为 NULL） */
export interface LlmSpanDetail {
  /** `gen_ai.provider.name` */
  provider: string
  /** `gen_ai.request.model`——**快照**（`agents.llm_model` 可变） */
  model: string
  /** `gen_ai.usage.input_tokens` */
  inputTokens: number | null
  /** `gen_ai.usage.output_tokens` */
  outputTokens: number | null
  /** `gen_ai.response.time_to_first_chunk`——规范单位是秒，本仓存毫秒（导出时换算） */
  ttftMs: number | null
  /** `gen_ai.request.stream`（0/1） */
  stream: boolean
  /** `gen_ai.request.max_tokens`——快照 */
  maxTokens: number | null
}

/** 一行 span（`spans` + 可选 `span_llm`） */
export interface SpanInput {
  /** 业务身份（128 位随机 hex），导出时映射 OTel 的 `spanId` */
  spanId: string
  /** NULL = 该执行的根段 */
  parentSpanId: string | null
  /** **链锚** = `messages.task_id`（不是 `execution_logs.trace_id`，那是当轮执行 id） */
  chainId: string | null
  /** 挂 `execution_logs.id` */
  executionId: string
  sessionId: string | null
  agentId: string | null
  /** 段名——**闭集**，见 R2 §五 */
  name: string
  /** `gen_ai.operation.name` 字面量；NULL = 规范无此概念（自定义段） */
  operationName: string | null
  /** ISO 8601 UTC 带毫秒（`2026-09-14T13:20:00.000Z`） */
  startAt: string
  durationMs: number
  /** `ok` / `error` / `timeout` / `skipped` */
  status: string
  errorType: string | null
  errorMessage: string | null
  /** 通用产出计数；无产出概念的段留 NULL */
  itemCount: number | null
  /** 仅 `llm.chat` 段有值 */
  llm: LlmSpanDetail | null
}

/**
 * 一次执行的全部 span，**同一事务**落两表。
 *
 * @returns 落盘成功 `true`；失败（已回滚 + 已记痕）`false`——**不抛**
 */
export function insertExecTrace(spans: SpanInput[]): boolean {
  if (spans.length === 0) return true
  try {
    // 拓扑序：根段（parent NULL）先落，其余随后。`sort` 稳定 ⇒ 同层保持调用序。
    const ordered = [...spans].sort(
      (a, b) => (a.parentSpanId === null ? 0 : 1) - (b.parentSpanId === null ? 0 : 1)
    )
    db.transaction((): void => {
      const insertSpan = db.prepare(
        `INSERT INTO spans (
           span_id, parent_span_id, chain_id, execution_id, session_id, agent_id,
           name, operation_name, start_at, duration_ms, status, error_type, error_message, item_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertLlm = db.prepare(
        `INSERT INTO span_llm (
           span_id, provider, model, input_tokens, output_tokens, ttft_ms, stream, max_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const s of ordered) {
        insertSpan.run(
          s.spanId,
          s.parentSpanId,
          s.chainId,
          s.executionId,
          s.sessionId,
          s.agentId,
          s.name,
          s.operationName,
          s.startAt,
          s.durationMs,
          s.status,
          s.errorType,
          s.errorMessage,
          s.itemCount
        )
        if (s.llm) {
          insertLlm.run(
            s.spanId,
            s.llm.provider,
            s.llm.model,
            s.llm.inputTokens,
            s.llm.outputTokens,
            s.llm.ttftMs,
            s.llm.stream ? 1 : 0,
            s.llm.maxTokens
          )
        }
      }
    })()
    return true
  } catch (err: any) {
    // 关键路径上的写口：吞掉 + 记痕（执行照常收尾）。回滚由事务保证——不留半截时间轴。
    log.warn('执行时间轴落盘失败（已回滚，不影响本轮执行）', {
      executionId: spans[0]?.executionId,
      spanCount: spans.length,
      error: messageOf(err),
    })
    return false
  }
}

// ─── 读侧（最小面：仅供测试、轮次归属与后续看板取数）─────────

/** 一行 span 的原样形状（snake_case，与列名一致） */
export interface SpanRow {
  id: number
  span_id: string
  parent_span_id: string | null
  chain_id: string | null
  execution_id: string
  session_id: string | null
  agent_id: string | null
  name: string
  operation_name: string | null
  start_at: string
  duration_ms: number
  status: string
  error_type: string | null
  error_message: string | null
  item_count: number | null
}

/** 一次执行的全段时间轴（按 `start_at` 升序——R2 存在的理由就是这一条查询） */
export function getSpansByExecution(executionId: string): SpanRow[] {
  return db
    .prepare('SELECT * FROM spans WHERE execution_id = ? ORDER BY start_at, id')
    .all(executionId) as SpanRow[]
}

/** 该执行的根段 id（`parent_span_id IS NULL`）；无则 undefined */
export function getRootSpanId(executionId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT span_id FROM spans WHERE execution_id = ? AND parent_span_id IS NULL
       ORDER BY id LIMIT 1`
    )
    .get(executionId) as { span_id: string } | undefined
  return row?.span_id
}

/** 某个 span 的 LLM 详情行；无则 undefined */
export function getLlmDetail(spanId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM span_llm WHERE span_id = ?').get(spanId) as
    Record<string, unknown> | undefined
}

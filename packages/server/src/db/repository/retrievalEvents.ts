/**
 * `retrieval_*` 三表写口（P2 / R1，段四记忆检索流水）。
 *
 * 定位：**只采不改**——本模块是纯新增写口，不改任何检索行为。读侧（评估中心
 * 检索面看板）是后续叶子节点，不在 R1。
 *
 * 三表同事务（硬约束 1）：`retrieval_events` → `retrieval_queries` →
 * `retrieval_candidates` 必须一起落盘，**禁止半写完**（「有 event 没 queries」
 * 「有 query 没 candidates」都是拆表新引入的风险面）。事务在模块内部自开
 * （`db/repository` 各 repo 用模块级 db 单例，路由层不包事务）。
 *
 * 写库失败**绝不抛**（硬约束 2）：它在 `execution/reply.ts` 的关键路径上，
 * 抛了会杀死本轮的记忆注入。失败 = 整个事务回滚（无半截行）+ 记一次痕。
 *
 * 不回填（硬约束 4）：原始数从未落库，回填就是编数据。
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../../logger.js'

const log = createLogger('retrieval-events')

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 通道身份（P2 §二①）：由检索出口显式带出，退休 `distance === maxDistance` 隐式约定 */
export type RetrievalChannel = 'vector' | 'keyword' | 'both'

/** 候选来源：`final` = 融合后 topK / `probe` = 阈值**前** KNN 池 */
export type RetrievalCandidateSource = 'final' | 'probe'

/**
 * 未进 prompt 的原因。与 `injected` **必须分开**：「被阈值挡掉」和「被预算截断」
 * 是两个相反的药方（松 `MEMORY_MAX_DISTANCE` vs 加预算），糊成一个「没进」就
 * 永远分不出来。
 */
export type RetrievalDroppedReason = 'threshold' | 'status' | 'not_topk' | 'budget' | 'section_dup'

/** 一趟查询（`retrieval_queries` 一行） */
export interface RetrievalQueryInput {
  /** 0 = 原话，1+ = 改写。**没有它答不了「改写值不值」** */
  queryIndex: number
  /** 当时那一趟查的是什么——查询文本事后无从复现（消息会变、改写模型会换） */
  queryText: string
  /**
   * 该趟的向量通道有没有跑（与 `channel` **正交**，不可合并进 channel 值域）：
   * 降级路径产出的候选行与「关键词救回」在行面上完全同形，只有这一列能分开
   * 「向量通道跑了但没要它」与「向量通道压根没跑」——阈值该松还是紧，这是两个
   * 截然相反的结论。
   */
  queryEmbedOk: boolean
}

/** 一个候选片（`retrieval_candidates` 一行） */
export interface RetrievalCandidateInput {
  /** 归属：产出该候选的那趟查询（拆表后由 `query_id` 承载，不再候选行上手抄 query_index） */
  queryIndex: number
  source: RetrievalCandidateSource
  /** `keyword` 行的 `distance` 一律 NULL（哨兵退休）；probe 行恒 `vector` */
  channel: RetrievalChannel | null
  /** 身份三元组——**不用 `chunks.id`**（派生表 id 重扫即变） */
  docPath: string
  sectionAnchor: string
  contentHash: string
  /** ✅ 诊断专用探针，**绝不作 join 键**：回查「现在的 chunk_id 还是不是同一片」 */
  chunkId: number | null
  /** ✅ 让历史行自解释（`chunks` 重扫后该列会被覆盖） */
  breadcrumb: string | null
  /** ✅ 片段正文前 120 字（截断快照，非全文）。回答「这条召回到底是什么」 */
  bodyHead: string | null
  /** ✅ 该片**当时**的 status（不冗余则「`superseded` 是不是在挡活片」在重扫后无解） */
  statusAtQuery: string | null
  /** 余弦距离；纯关键词命中为 NULL（**不写哨兵**） */
  distance: number | null
  /** 该片在其命中通道内的**最好位次**（0-based；`both` 取两通道较小值） */
  rank: number | null
  /** RRF 融合分（probe 行 / 纯关键词降级行无融合 ⇒ NULL） */
  rrfScore: number | null
  /** 跨查询二次合并后的位次（0-based，仅 `final` 行） */
  finalRank: number | null
  /** X4 状态过滤是否放行——**仅 probe 行有值**（final 行按构造必然通过，记 NULL 表「不适用」） */
  passedStatusFilter: boolean | null
  /** 口径 = **节**：该片所属的节最终进了 prompt（注入单位是节，Decisions 14） */
  injected: boolean
  /** 所属节在注入序列（kept，相关度序）中的下标（0-based） */
  sectionRank: number | null
  /** 渲染后编号 **1..n**（`renderSections` 会做首尾重排——这是位置效应的直接变量） */
  injectedPosition: number | null
  droppedReason: RetrievalDroppedReason | null
}

/** 一次记忆检索（`retrieval_events` 一行 + 其下全部查询与候选） */
export interface RetrievalEventInput {
  /** 挂到哪次执行（对 `execution_logs.id`） */
  executionId: string
  sessionId: string | null
  agentId: string | null
  /** **链锚**，口径与 P1 一致（`coalesce(回复消息.task_id, 触发消息.task_id)`） */
  taskId: string | null
  /** ISO UTC */
  createdAt: string
  /** 参数快照（§一 推论一：阈值改一次，历史行的可解释性当场归零） */
  thresholdMaxDistance: number
  paramTopK: number
  paramProbeN: number | null
  /** 值域 **9**（模块 7 枚举 + `timeout` + `error`，见 P2 §二③） */
  reason: string
  retrievalMs: number | null
  contextTokens: number | null
  budgetTokens: number | null
  truncated: boolean | null
  queries: RetrievalQueryInput[]
  candidates: RetrievalCandidateInput[]
}

/**
 * 三表同事务落盘。**失败绝不抛**——回滚 + 记痕，返回 `undefined`。
 *
 * @returns 新 `retrieval_events.id`；写失败返回 `undefined`
 */
export function insertRetrievalTrace(input: RetrievalEventInput): number | undefined {
  try {
    return db.transaction((): number => {
      const eventId = db
        .prepare(
          `INSERT INTO retrieval_events (
             execution_id, session_id, agent_id, task_id, created_at,
             threshold_max_distance, param_top_k, param_probe_n, reason,
             retrieval_ms, context_tokens, budget_tokens, truncated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.executionId,
          input.sessionId,
          input.agentId,
          input.taskId,
          input.createdAt,
          input.thresholdMaxDistance,
          input.paramTopK,
          input.paramProbeN,
          input.reason,
          input.retrievalMs,
          input.contextTokens,
          input.budgetTokens,
          input.truncated === null ? null : input.truncated ? 1 : 0
        ).lastInsertRowid as number

      const insertQuery = db.prepare(
        `INSERT INTO retrieval_queries (retrieval_id, query_index, query_text, query_embed_ok)
         VALUES (?, ?, ?, ?)`
      )
      const queryIds = new Map<number, number>()
      for (const q of input.queries) {
        const queryId = insertQuery.run(eventId, q.queryIndex, q.queryText, q.queryEmbedOk ? 1 : 0)
          .lastInsertRowid as number
        queryIds.set(q.queryIndex, queryId)
      }

      // 逐行守卫：候选的 queryIndex 结构上恒来自 queries（见下），真越界时**只丢该行**、
      // 不整条 trace 陪葬——三表原子性不受影响（event/queries/其余候选一起提交）。
      // 不靠 FK 兜底的原因：FK 违规会让整个事务回滚，一行坏数据换掉一次完整检索的账。
      const insertCandidate = db.prepare(
        `INSERT INTO retrieval_candidates (
           query_id, source, channel, doc_path, section_anchor, content_hash, chunk_id,
           breadcrumb, body_head, status_at_query, distance, rank, rrf_score, final_rank,
           passed_status_filter, injected, section_rank, injected_position, dropped_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      let orphanCandidates = 0
      for (const c of input.candidates) {
        const queryId = queryIds.get(c.queryIndex)
        if (queryId === undefined) {
          orphanCandidates++
          continue
        }
        insertCandidate.run(
          queryId,
          c.source,
          c.channel,
          c.docPath,
          c.sectionAnchor,
          c.contentHash,
          c.chunkId,
          c.breadcrumb,
          c.bodyHead,
          c.statusAtQuery,
          c.distance,
          c.rank,
          c.rrfScore,
          c.finalRank,
          c.passedStatusFilter === null ? null : c.passedStatusFilter ? 1 : 0,
          c.injected ? 1 : 0,
          c.sectionRank,
          c.injectedPosition,
          c.droppedReason
        )
      }
      if (orphanCandidates > 0) {
        log.warn('检索流水：候选引用了不存在的 query_index，已逐行丢弃', {
          executionId: input.executionId,
          orphanCandidates,
        })
      }

      return eventId
    })()
  } catch (err: any) {
    // 关键路径上的写口：吞掉 + 记痕（检索照跑）。回滚由事务保证——不会留半截行。
    log.warn('检索流水落盘失败（已回滚，不影响本轮注入）', {
      executionId: input.executionId,
      reason: input.reason,
      candidates: input.candidates.length,
      error: err?.message,
    })
    return undefined
  }
}

// ─── 读侧（最小面：仅供测试与后续看板取数）─────────────

/** 一条 event 的查询行（按 `query_index` 升序） */
export function getRetrievalQueries(retrievalId: number): Array<{
  id: number
  query_index: number
  query_text: string
  query_embed_ok: number
}> {
  return db
    .prepare(
      `SELECT id, query_index, query_text, query_embed_ok
       FROM retrieval_queries WHERE retrieval_id = ? ORDER BY query_index`
    )
    .all(retrievalId) as Array<{
    id: number
    query_index: number
    query_text: string
    query_embed_ok: number
  }>
}

/** 一条 event 的候选行（按自增序） */
export function getRetrievalCandidates(retrievalId: number): Array<{
  id: number
  query_id: number
  source: string
  channel: string | null
  doc_path: string
  section_anchor: string
  content_hash: string
  chunk_id: number | null
  distance: number | null
  rank: number | null
  rrf_score: number | null
  final_rank: number | null
  passed_status_filter: number | null
  injected: number
  section_rank: number | null
  injected_position: number | null
  dropped_reason: string | null
  body_head: string | null
  breadcrumb: string | null
  status_at_query: string | null
}> {
  return db
    .prepare(
      `SELECT c.id, c.query_id, c.source, c.channel, c.doc_path, c.section_anchor,
              c.content_hash, c.chunk_id, c.distance, c.rank, c.rrf_score, c.final_rank,
              c.passed_status_filter, c.injected, c.section_rank, c.injected_position,
              c.dropped_reason, c.body_head, c.breadcrumb, c.status_at_query
       FROM retrieval_candidates c
       JOIN retrieval_queries q ON q.id = c.query_id
       WHERE q.retrieval_id = ?
       ORDER BY c.id`
    )
    .all(retrievalId) as Array<{
    id: number
    query_id: number
    source: string
    channel: string | null
    doc_path: string
    section_anchor: string
    content_hash: string
    chunk_id: number | null
    distance: number | null
    rank: number | null
    rrf_score: number | null
    final_rank: number | null
    passed_status_filter: number | null
    injected: number
    section_rank: number | null
    injected_position: number | null
    dropped_reason: string | null
    body_head: string | null
    breadcrumb: string | null
    status_at_query: string | null
  }>
}

/**
 * 记忆服务 — 切片索引（`chunks`）的检索与上下文构建。
 *
 * 检索链（段三接线后）：
 *   原话 + 改写查询 → 逐条嵌入 → **混合检索**（向量通道 vec0 `MATCH` +
 *   关键词通道 `chunks_fts`，RRF k=60 融合）→ 多查询按最优排名合并 →
 *   top-K 命中片 → **按节补齐**（Decisions 14「小块检索、整节返回」）→
 *   按节截断进预算 → 首尾各半排序 → 拼 system prompt。
 *
 * ⚠️ 旧链（`memories` / `memories_fts` 两张表 + `embedding BLOB` 扫表向量检索）
 * 已随票辛 ⑥ **整体下线**（两表 DROP，见 `db/index.ts`）。对话原话不再入库，
 * 索引的唯一来源是飞轮扫描器（`scripts/flywheel/scan.mjs`）。
 *
 * 降级面（W3 + W11）——**每一条返回空串的路径都有互不相同的 `reason`**，
 * 「静默返回空且无痕」在本模块是不允许的状态：
 *   `not-enabled`    功能关（压根没检索）
 *   `empty-query`    剥离 @mention 后没有可检索内容
 *   `embed-failed`   嵌入链不可用（`detail` 带票丁的六种 reason）
 *   `filtered-empty` 召回空——候选池被 X4 状态过滤挡光（嵌入是好的）
 *   `no-hit`         召回空——库空 / 候选全被距离阈值挡掉
 *   `budget-exhausted` 召回到片但整节都放不进预算
 *
 * 环境变量:
 *   MEMORY_TOP_K                — 检索片数（默认 3）
 *   MEMORY_MAX_DISTANCE         — 检索距离下限（默认 0.6）
 *   MEMORY_CONTEXT_TOKEN_BUDGET — 注入预算硬上限（默认 8000）
 *   KNOWLEDGE_TOP_K             — 知识库检索数量（默认 3），见 buildKnowledgeContext
 *   MEMORY_QUERY_REWRITE_ENABLED— 查询改写开关（默认 "1"），见 query-rewrite.ts
 */

import { estimateTokens } from '@cat-study/shared'
import { chunks as chunksRepo, knowledge as knowledgeRepo } from '../db/repository/index.js'
import type { ChunkVectorSearchResult } from '../db/repository/chunks.js'
import type { ChunkRow } from '../db/repository/types.js'
import { embedText, getEmbeddingStatus, isMemoryEnabled } from './embedding.js'
import { rewriteRetrievalQueries } from './query-rewrite.js'
import { createLogger } from '../logger.js'

const log = createLogger('memory')

/** 注入预算默认值（W2-a 契约：8k token 起） */
const DEFAULT_CONTEXT_TOKEN_BUDGET = 8000
/** 探针池大小（与混合检索两通道配额同量级：X5 要的是「阈值前 top-N」） */
const MAX_PROBE_N = 20

// ─── 向量 ↔ BLOB 转换 ─────────────────────────────────

/** number[] → Float32Array → Buffer（存为 SQLite BLOB） */
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

/** Buffer → Float32Array → number[]（从 BLOB 读取） */
export function blobToVector(blob: Buffer): number[] {
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
}

// ─── 检索结果形态 ─────────────────────────────────────

/** 注入单位是**节**不是片（Decisions 14） */
export interface RetrievedSection {
  docPath: string
  sectionAnchor: string
  breadcrumb: string
  /** 该节全部片正文，按 `part_index` 升序 */
  parts: string[]
  /** 该节内最相关片的余弦距离（节级排序依据） */
  distance: number
}

/** 降级原因（每一条空结果路径一个，互不相同 ⇒ 三态/四态可区分，W3/W11） */
export type MemoryRetrievalReason =
  | 'ok'
  | 'not-enabled'
  | 'empty-query'
  | 'embed-failed'
  | 'filtered-empty'
  | 'no-hit'
  | 'budget-exhausted'

/** X5 埋点字段：阈值**前** top-N 候选的切片身份 + 距离 */
export interface MemoryCandidateTrace {
  docPath: string
  sectionAnchor: string
  distance: number
  /** X4 状态过滤是否放行（false = 该候选被 `superseded`/`deprecated` 挡掉） */
  passesStatusFilter: boolean
}

export interface MemoryContextStats {
  /** 参与检索的查询条数（原话 + 改写） */
  queries: number
  /** 融合后、阈值内的命中片数 */
  candidateChunks: number
  /** 实际注入的节数 / 因预算被截断丢弃的节数 */
  sections: number
  droppedSections: number
  /** 注入文本的 token 数 / 本次预算 */
  contextTokens: number
  budgetTokens: number
  truncated: boolean
  /** 阈值前 top-N 候选（X5 埋点） */
  topCandidates: MemoryCandidateTrace[]
  /** 候选池里被 X4 状态过滤挡掉的行数（W11：与「真的无命中」区分） */
  blockedByStatus: number
  /** 候选池里被距离阈值挡掉的行数（W5：与「空手而归」区分） */
  droppedByThreshold: number
  /** 嵌入失败时的票丁 reason（`embed-failed` 态） */
  embedReason?: string
}

export interface MemoryContextResult {
  /** 可直接拼进 system prompt 的文本块；空串 = 未注入 */
  text: string
  reason: MemoryRetrievalReason
  /** 注入的节（含 `docPath`/`sectionAnchor`）——结果面可核「只来自 chunks」 */
  sections: RetrievedSection[]
  stats: MemoryContextStats
}

const EMPTY_STATS: MemoryContextStats = {
  queries: 0,
  candidateChunks: 0,
  sections: 0,
  droppedSections: 0,
  contextTokens: 0,
  budgetTokens: 0,
  truncated: false,
  topCandidates: [],
  blockedByStatus: 0,
  droppedByThreshold: 0,
}

function emptyResult(
  reason: MemoryRetrievalReason,
  stats: Partial<MemoryContextStats> = {}
): MemoryContextResult {
  return { text: '', reason, sections: [], stats: { ...EMPTY_STATS, ...stats } }
}

// ─── 降级标记（票丁契约 ①-②）─────────────────────────
// 嵌入链不可用时，检索会静默变空。此处**每条失败链只留一条痕**：
// 首次在检索面记 warn（带 reason），此后静默——避免每轮刷日志。
// 失败原因本身由 embedding-client 在首次失败时记 error。

let degradationNoted = false

/** 检索结果为空且嵌入链已降级 ⇒ 记一次痕（同一条失败链不重复记） */
function noteEmbeddingDegradation(): void {
  const status = getEmbeddingStatus()
  if (status.ok) {
    degradationNoted = false
    return
  }
  if (degradationNoted) return
  degradationNoted = true
  log.warn('记忆检索降级：嵌入链不可用，本轮召回为空', {
    reason: status.reason,
    failingSince: status.failingSince,
  })
}

// ─── 检索 ────────────────────────────────────────────

/** 类型守卫：向量/混合通道的行带 distance 真值，纯关键词行无该字段 */
function isVectorHitRow(r: ChunkRow | ChunkVectorSearchResult): r is ChunkVectorSearchResult {
  return 'distance' in r
}

/**
 * 检索并构建记忆上下文（票辛主入口）。
 *
 * 与旧的 `buildMemoryContext` 的差别：返回**结构化的结果**而不只是字符串——
 * `reason` 与 `stats` 是 W3/W4/W5/W11 的判据面（调用方据此打三态日志与埋点）。
 * 不返回结构化对象的话，调用方只能看见「有 / 没有」，三态就退化成两态。
 */
export async function retrieveMemoryContext(triggerContent: string): Promise<MemoryContextResult> {
  // 未启用优先于一切：此时连嵌入都不该碰（票丁：not-enabled 不 spawn sidecar）
  if (!isMemoryEnabled()) return emptyResult('not-enabled')

  // 剥离 @mention 再检索：@mention 是路由元数据而非用户意图，混入查询会
  // 拉偏查询向量、降低召回质量。
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) return emptyResult('empty-query')

  const topK = parseInt(process.env.MEMORY_TOP_K || '3', 10)
  const maxDistance = parseFloat(process.env.MEMORY_MAX_DISTANCE || '0.6')
  const budgetTokens = parseInt(
    process.env.MEMORY_CONTEXT_TOKEN_BUDGET || String(DEFAULT_CONTEXT_TOKEN_BUDGET),
    10
  )

  const rewrites = await rewriteRetrievalQueries(cleanContent)
  const queries = [...new Set([cleanContent, ...rewrites])]

  // 逐查询检索：嵌入成功走混合（向量 + 关键词 RRF），失败降级为仅关键词通道
  // ——关键词通道正是为短词召回设计，嵌入坏了不该连它一起废掉。
  type Scored = { row: ChunkVectorSearchResult; bestIndex: number }
  const merged = new Map<number, Scored>()
  const blobs: Buffer[] = []
  let embedReason: string | undefined
  let embeddedAny = false

  for (const q of queries) {
    let blob: Buffer | null = null
    const embedded = await embedText(q)
    if (embedded.ok && embedded.vector.length > 0) {
      blob = vectorToBlob(embedded.vector)
      blobs.push(blob)
      embeddedAny = true
    } else if (!embedded.ok) {
      embedReason = embedded.reason
      log.debug('记忆检索：查询嵌入不可用，降级仅关键词通道', { reason: embedded.reason })
    }

    const rows: Array<ChunkRow | ChunkVectorSearchResult> = blob
      ? chunksRepo.searchChunksHybrid(blob, q, topK, maxDistance)
      : chunksRepo.searchChunksByKeyword(q, topK)

    rows.forEach((r, i) => {
      const candidate: ChunkVectorSearchResult = isVectorHitRow(r)
        ? r
        : { ...r, distance: maxDistance }
      const existing = merged.get(r.id)
      if (!existing || i < existing.bestIndex) {
        merged.set(r.id, { row: candidate, bestIndex: i })
      }
    })
  }

  const ordered = [...merged.values()]
    .sort((a, b) => a.bestIndex - b.bestIndex)
    .slice(0, topK)
    .map((s) => s.row)

  // X5 埋点 + W11 判据：候选池探针取**首个嵌入成功的查询**（原话优先）。
  // 无任何嵌入成功 ⇒ 无池可探（嵌入失败本身已是结论）。
  const probe = blobs.length > 0 ? chunksRepo.probeChunkVectorCandidates(blobs[0], MAX_PROBE_N) : []
  const topCandidates: MemoryCandidateTrace[] = probe.map((c) => ({
    docPath: c.docPath,
    sectionAnchor: c.sectionAnchor,
    distance: c.distance,
    passesStatusFilter: c.passesStatusFilter,
  }))
  const blockedByStatus = probe.filter((c) => !c.passesStatusFilter).length
  const droppedByThreshold = probe.filter(
    (c) => c.passesStatusFilter && c.distance >= maxDistance
  ).length
  const trace: Partial<MemoryContextStats> = {
    queries: queries.length,
    candidateChunks: ordered.length,
    budgetTokens,
    topCandidates,
    blockedByStatus,
    droppedByThreshold,
  }

  if (ordered.length === 0) {
    // 空结果的归因顺序：嵌入坏了 > 被状态过滤挡光 > 真的没命中。
    // 三者都会原样带上 trace（pool 计数不作取舍），所以这个顺序只影响 reason 一个
    // 字段，不丢信息。
    if (!embeddedAny && embedReason) {
      noteEmbeddingDegradation()
      return emptyResult('embed-failed', { ...trace, embedReason })
    }
    if (blockedByStatus > 0) return emptyResult('filtered-empty', trace)
    return emptyResult('no-hit', trace)
  }

  // 按节补齐（Decisions 14）：命中的是片，注入的是节——节内片序按 part_index
  const bySection = new Map<string, RetrievedSection>()
  for (const chunk of ordered) {
    const key = `${chunk.doc_path} ${chunk.section_anchor}`
    if (bySection.has(key)) continue
    const parts = chunksRepo.getChunksBySection(chunk.doc_path, chunk.section_anchor)
    bySection.set(key, {
      docPath: chunk.doc_path,
      sectionAnchor: chunk.section_anchor,
      breadcrumb: chunk.breadcrumb,
      // 节在库内为空（极端：命中后又被并发删）⇒ 退回命中片正文，不注入空条目
      parts: parts.length > 0 ? parts.map((p) => p.body) : [chunk.body],
      distance: chunk.distance,
    })
  }

  // 按节截断（W2-a）：整节进退，**放不下的节起停**（截断语义，不是跳过挑小的
  // ——跳过会让注入内容随预算抖动而不可预测）。每次试探都按最终形态（首尾各半
  // + 重新编号）核算 token，故预算判据与真正注入的串逐字节同源。
  const kept: RetrievedSection[] = []
  for (const section of bySection.values()) {
    const candidate = renderSections([...kept, section])
    if (candidate.tokens > budgetTokens) break
    kept.push(section)
  }

  if (kept.length === 0) {
    return emptyResult('budget-exhausted', { ...trace, droppedSections: bySection.size })
  }

  const rendered = renderSections(kept)
  return {
    text: rendered.text,
    reason: 'ok',
    sections: kept,
    stats: {
      ...EMPTY_STATS,
      ...trace,
      sections: kept.length,
      droppedSections: bySection.size - kept.length,
      contextTokens: rendered.tokens,
      truncated: kept.length < bySection.size,
    },
  }
}

/**
 * 把若干节渲染成注入块，**最相关的首尾各半**（Lost in the Middle,
 * arXiv:2307.03172）：前半按相关度顺序置于串首，后半**逆序**置于串尾 ⇒
 * 最相关的两条分别落在首部与尾部的最外侧，不落正中段（W3）。
 *
 * 序号按**最终位置**编（猫读到的是连续 1..n），故本函数的输出即最终注入串，
 * token 核算与实际注入逐字节同源（预算判据不会与注入面脱钩）。
 */
function renderSections(sections: RetrievedSection[]): { text: string; tokens: number } {
  if (sections.length === 0) return { text: '', tokens: 0 }
  const half = Math.ceil(sections.length / 2)
  const ordered = [...sections.slice(0, half), ...sections.slice(half).reverse()]
  const lines = ordered.map((s, i) => `${i + 1}. ${s.parts.join('\n')}`)
  const text = `\n\n【相关记忆】\n${lines.join('\n')}`
  return { text, tokens: estimateTokens(text) }
}

// ─── 上下文构建（知识库）───────────────────────────────

/**
 * 检索知识库并格式化为 system prompt 的独立【知识库】区块。
 * 无匹配返回空字符串（与记忆块同约定）。
 *
 * 与【相关记忆】并列独立区块——来源权威性不同（运营方标准数据 vs 索引切片），
 * 检索语义不可混淆。
 *
 * 单向量通道（不改写双通道）：改写通道服务于用户口语化 query（索引切片检索
 * 场景），知识库查询由模型生成的结构化 query 发起，无口语歧义需求；
 * 命中为空 → 返回空串不注入，不降级模糊匹配。检索阈值 0.35 在
 * searchKnowledgeByVector 默认参数（知识文档语义密度高、宁缺毋滥）。
 *
 * ⚠️ `knowledge` 是 `embedding BLOB` + `vec_distance_cosine` 扫表形态，与
 * `chunks` 的 vec0 `MATCH` **不是同一种检索**——别互抄（票辛 X1）。
 *
 * 环境变量: KNOWLEDGE_TOP_K — 检索条目数（默认 3）
 */
export async function buildKnowledgeContext(triggerContent: string): Promise<string> {
  // 与 retrieveMemoryContext 同款：剥离 @mention 再检索，查询向量与存储向量同语义空间
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) return ''

  const topK = parseInt(process.env.KNOWLEDGE_TOP_K || '3', 10)
  const embedded = await embedText(cleanContent)
  if (!embedded.ok) {
    log.debug('知识库查询嵌入不可用，跳过检索', { reason: embedded.reason })
    return ''
  }
  const vector = embedded.vector
  if (vector.length === 0) return ''

  const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(vector), topK)
  if (rows.length === 0) return ''

  const lines = rows.map((r, i) => `${i + 1}. ${r.content}`)
  return `\n\n【知识库】\n${lines.join('\n')}`
}

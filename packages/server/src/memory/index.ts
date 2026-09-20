/**
 * 记忆服务 — 切片索引（`chunks`）的检索与上下文构建。
 *
 * 检索链（段三接线后）：
 *   原话 + 改写查询 → 逐条嵌入 → **混合检索**（向量通道 vec0 `MATCH` +
 *   关键词通道 `chunks_fts`，RRF k=60 融合）→ 多查询按最优排名合并 →
 *   top-K 命中片 → **按节补齐**（Decisions 14「小块检索、整节返回」）→
 *   按节截断进预算 → 首尾各半排序 → 拼 system prompt。
 *
 * 入口分工（R10）：`retrieveMemoryContext` = 生产入口（闸 → 剥 mention → 改写），
 * `runRetrievalChain` = **改写之后**的链段本体（可注入查询集，跑批用；两处口径同源）。
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
 *   `skipped-a2a`    a2a 触发且 `MEMORY_A2A_ENABLED` 关——**压根没检索**（T-1 门控）
 *
 * 环境变量:
 *   MEMORY_TOP_K                — 检索片数（默认 3）
 *   MEMORY_MAX_DISTANCE         — 检索距离下限（默认 0.6）
 *   MEMORY_CONTEXT_TOKEN_BUDGET — 注入预算硬上限（默认 8000）
 *   MEMORY_A2A_ENABLED          — a2a 触发时是否仍检索【相关记忆】（默认关），见 isA2aMemoryEnabled
 *   KNOWLEDGE_TOP_K             — 知识库检索数量（默认 3），见 buildKnowledgeContext
 *   MEMORY_QUERY_REWRITE_ENABLED— 查询改写开关（默认 "1"），见 query-rewrite.ts
 */

import { estimateTokens } from '@cat-study/shared'
import { chunks as chunksRepo, knowledge as knowledgeRepo } from '../db/repository/index.js'
import {
  CANDIDATE_BODY_HEAD_CHARS,
  HYBRID_POOL_PER_QUERY,
  RETIRED_STATUSES,
  type ChunkVectorSearchResult,
} from '../db/repository/chunks.js'
import type {
  RetrievalCandidateInput,
  RetrievalChannel,
  RetrievalQueryInput,
} from '../db/repository/retrievalEvents.js'
import { embedText, getEmbeddingStatus, isMemoryEnabled } from './embedding.js'
import { rewriteRetrievalQueries } from './query-rewrite.js'
import { createLogger } from '../logger.js'
import { envNumber } from '../env-number.js'

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
  /**
   * 该节所代表的片在库内的 `status`（C4：注入标记由**这一列**驱动）。
   *
   * 刻意不在渲染期回库补查：标记必须与「该片为什么被召回」同源——回查等于让
   * 渲染层与召回层各判一次状态，两者判反时表现为「召回得到、但不带标记」，
   * 正是用户要防的那种无声误导。
   */
  status: string | null
  /** 该节内最相关片的余弦距离（台账列：当前不参与排序，节序由片级累加 RRF 分决定，`bestIndex` 仅作同分 tie-break） */
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
  /** T-1 a2a 门控：触发消息来自 agent 且开关关 ⇒ **没有检索**（区别于 not-enabled
   *  ——那个是记忆功能整体关，a2a/用户两侧都不跑） */
  | 'skipped-a2a'

// ─── 检索流水（P2 / R1：只采不改，字段口径见 P2 §四）─────
//
// 类型**直接复用写口契约**（`db/repository/retrievalEvents.ts`），不在这里另写一份
// 字段表：两处各定义一份的话，改一处漏一处**没有编译期信号**——`stats` 与落库行
// 会静默错位。`RetrievalEventInput` 的候选/查询形状就是这里的形状。

/** 一趟查询的流水（`retrieval_queries` 一行的来源） */
export type MemoryQueryTrace = RetrievalQueryInput

/** 一个候选片的流水（`retrieval_candidates` 一行的来源） */
export type MemoryCandidateTrace = RetrievalCandidateInput

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
  /** 本次检索总耗时（含嵌入 + 两通道检索 + 分节渲染）——诉求③性能面 */
  retrievalMs: number
  /** 参数快照（P2 §一 推论一：阈值改一次，历史行的可解释性当场归零 ⇒ 必须冗余） */
  thresholdMaxDistance: number
  paramTopK: number
  paramProbeN: number
  /** 逐趟查询的流水 */
  queryTraces: MemoryQueryTrace[]
  /**
   * 候选明细：**probe 池 + 融合 topK 同列**，靠 `source` 判别（P2 §四 表 3）。
   * 「部分降级有没有发生」靠 `queryTraces.queryEmbedOk` 与本列的 `channel` 联看。
   */
  candidates: MemoryCandidateTrace[]
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

export interface RetrievalParamsSnapshot {
  topK: number
  maxDistance: number
  probeN: number
}

/**
 * 本次检索的参数快照。单一来源——检索链与 `execution/reply.ts` 的超时/抛错
 * 路径（拿不到 `MemoryContextResult` 时）都取它，避免两处各读一遍 env 漂移。
 */
export function currentRetrievalParams(): RetrievalParamsSnapshot {
  return {
    // topK 保持**整数**语义（原 `parseInt`）：`Math.trunc` 在调用点做，`envNumber`
    // 形状固定两参不带模式开关。切片点 `slice(0, topK)` 本会自行取整，此处显式化是
    // 为了 `RetrievalParamsSnapshot` 快照里读到的就是真实生效的整数。
    topK: Math.trunc(envNumber('MEMORY_TOP_K', 3)),
    maxDistance: envNumber('MEMORY_MAX_DISTANCE', 0.6),
    probeN: MAX_PROBE_N,
  }
}

/**
 * 一个片在其命中通道内的**最好位次**（0-based）。两通道都命中时取较小值
 * ——「这片排得多靠前」问的是它最好的那次表现，不是某条通道的。
 */
function bestChannelRank(vectorRank: number | null, keywordRank: number | null): number | null {
  if (vectorRank === null) return keywordRank
  if (keywordRank === null) return vectorRank
  return Math.min(vectorRank, keywordRank)
}

/**
 * 该候选是否**其所属节在融合 topK 里的代表片**。
 *
 * 节的代表由 `bySection` 的「首个胜出」决定，而 `ordered` 的顺序就是
 * `finalTraces` 的顺序 ⇒ 代表 = 前面没有同节的片。非代表片记 `section_dup`：
 * 它的正文没进 prompt **不是因为被挡**，而是同节已有更优片代表了整节
 * （整节返回，正文并不缺）——与 `budget`/`threshold` 是第三个不同的因。
 */
function isSectionRepresentative(traces: MemoryCandidateTrace[], index: number): boolean {
  const c = traces[index]
  return !traces.some(
    (other, j) =>
      j < index && other.docPath === c.docPath && other.sectionAnchor === c.sectionAnchor
  )
}

const EMPTY_STATS: MemoryContextStats = {
  queries: 0,
  candidateChunks: 0,
  sections: 0,
  droppedSections: 0,
  contextTokens: 0,
  budgetTokens: 0,
  truncated: false,
  retrievalMs: 0,
  thresholdMaxDistance: 0,
  paramTopK: 0,
  paramProbeN: MAX_PROBE_N,
  queryTraces: [],
  candidates: [],
  blockedByStatus: 0,
  droppedByThreshold: 0,
}

function emptyResult(
  reason: MemoryRetrievalReason,
  stats: Partial<MemoryContextStats> = {}
): MemoryContextResult {
  return { text: '', reason, sections: [], stats: { ...EMPTY_STATS, ...stats } }
}

// ─── a2a 门控（T-1）──────────────────────────────────
// 触发消息来自 **agent**（猫的回复 @ 了下一棒）时，默认不检索【相关记忆】。
// 依据：a2a 的触发内容本身就是上一只猫已消化的结论，检索拉回来的是白名单文档
// 里的通用切片——对这一步没有信息增量，是纯 token 税，且带着把结论带偏的风险。
// 【知识库】不受此门约束（a2a 高频场景正是审查与实施，ADR/规范仍要查）。
//
// 判据**不在本模块**：本模块只认调用点递进来的布尔，不回头看 `triggerContent`
// 里有没有 @、也不查 DB——「这条触发是不是 agent 发的」是调度层的知识。

/** a2a 触发时是否仍检索【相关记忆】——默认**关**（`MEMORY_A2A_ENABLED=1` 才开）。
 *  默认关的理由：本门要治的就是「a2a 白跑检索」，默认开等于什么都不治。 */
export function isA2aMemoryEnabled(): boolean {
  return process.env.MEMORY_A2A_ENABLED === '1'
}

/**
 * 门控跳过的空结果工厂。
 *
 * 为什么工厂在本模块而不是调用点手搓：`recordRetrievalTrace` 与 span 都按
 * `stats?.xxx` 取值——形状一旦与其它空结果分叉，落库就是一片 null（`threshold_max_distance`
 * 等参数快照列全是空），「跳过一次」与「参数没记上」当场不可区分。形状归本模块所有。
 *
 * `retrievalMs` 保持 `EMPTY_STATS` 的 0（**不传调用点计时**）：那是「检索跑了多久」
 * 的读数，而这次**没有跑**——填一个真实的微秒数会把「跳过」渲染成「极快的一次检索」。
 */
export function skippedRetrievalResult(): MemoryContextResult {
  const params = currentRetrievalParams()
  return emptyResult('skipped-a2a', {
    thresholdMaxDistance: params.maxDistance,
    paramTopK: params.topK,
    paramProbeN: params.probeN,
  })
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

/**
 * 检索并构建记忆上下文（票辛主入口）。
 *
 * 与旧的 `buildMemoryContext` 的差别：返回**结构化的结果**而不只是字符串——
 * `reason` 与 `stats` 是 W3/W4/W5/W11 的判据面（调用方据此打三态日志与埋点）。
 * 不返回结构化对象的话，调用方只能看见「有 / 没有」，三态就退化成两态。
 *
 * R1（P2）起 `stats` 额外承载**检索流水**（`queryTraces` / `candidates` / 参数快照
 * / `retrievalMs`）——**只采不改**：检索行为（召回、排序、注入）逐字节不变，
 * 落盘点在 `execution/reply.ts` 的 10s `Promise.race` **之外**。
 *
 * R10 起本函数只做**闸 → 剥 mention → 改写**，链段本体搬去 `runRetrievalChain`：
 * 跑批脚本要喂**冻结改写文本**、跳过改写器（D2 冻结纪律），链段必须可独立调用。
 * `t0` 仍在这一层取、经 `startedAt` 传下去 ⇒ `retrievalMs` 含改写耗时的口径不变。
 */
export async function retrieveMemoryContext(triggerContent: string): Promise<MemoryContextResult> {
  const t0 = Date.now()
  const params = currentRetrievalParams()
  /** 本次检索的公共 trace（参数快照 + 耗时）——**每一条返回路径都带**，
   *  否则「为什么没召回」在流水里无痕（W3：本模块不允许「返回空且无痕」） */
  const baseStats = (): Partial<MemoryContextStats> => ({
    thresholdMaxDistance: params.maxDistance,
    paramTopK: params.topK,
    paramProbeN: params.probeN,
    retrievalMs: Date.now() - t0,
  })
  const empty = (
    reason: MemoryRetrievalReason,
    stats: Partial<MemoryContextStats> = {}
  ): MemoryContextResult => emptyResult(reason, { ...baseStats(), ...stats })

  // 未启用优先于一切：此时连嵌入都不该碰（票丁：not-enabled 不 spawn sidecar）
  if (!isMemoryEnabled()) return empty('not-enabled')

  // 剥离 @mention 再检索：@mention 是路由元数据而非用户意图，混入查询会
  // 拉偏查询向量、降低召回质量。
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) return empty('empty-query')

  const rewrites = await rewriteRetrievalQueries(cleanContent)
  // 去重（`new Set`）搬进链段入口，它幂等；对本层逐字节等价——原话排在首位，
  // 改写里若含原话，去重后顺序不变（`queries[0]` 仍是原话，探针池语义不漂）。
  return runRetrievalChain([cleanContent, ...rewrites], { startedAt: t0 })
}

/**
 * 跑**改写之后**的完整链段（R10 契约 §A2）：逐查询嵌入降级 → 混合检索 →
 * 跨查询 RRF 合并 → 阈值过滤 → 节补齐 → 预算截断 → 渲染。
 *
 * 抽出它的唯一理由是**注入查询集**：改写器原先内嵌在 `retrieveMemoryContext` 里，
 * 导出签名只吃 `triggerContent`，外部无法喂冻结改写（R10 跑批要的正是这个）。
 * 参数 / 阈值 / 预算仍**只读 env**（`currentRetrievalParams` /
 * `MEMORY_CONTEXT_TOKEN_BUDGET`），**不为抽取新增任何旋钮**——生产与跑批的口径
 * 因此自动同源，不会各自漂移。
 *
 * @param rawQueries 待检索的查询串。**`rawQueries[0]` 必须是原始查询**——探针池的
 *   「原话优先」语义（取首个嵌入成功者）依赖顺序。重复项在入口去重（幂等）：同一
 *   查询在同一趟出现两次，会让同一片被 RRF 计两次分。
 * @param opts.startedAt 起始时刻（毫秒）。缺省取链段入口时刻；生产侧由
 *   `retrieveMemoryContext` 传自己的 `t0` 进来，使 `retrievalMs` 含改写耗时。
 */
export async function runRetrievalChain(
  rawQueries: string[],
  opts: { startedAt?: number } = {}
): Promise<MemoryContextResult> {
  const t0 = opts.startedAt ?? Date.now()
  const params = currentRetrievalParams()
  /** 见 `retrieveMemoryContext` 同款注释：每条返回路径都带公共 trace */
  const baseStats = (): Partial<MemoryContextStats> => ({
    thresholdMaxDistance: params.maxDistance,
    paramTopK: params.topK,
    paramProbeN: params.probeN,
    retrievalMs: Date.now() - t0,
  })
  const empty = (
    reason: MemoryRetrievalReason,
    stats: Partial<MemoryContextStats> = {}
  ): MemoryContextResult => emptyResult(reason, { ...baseStats(), ...stats })

  const queries = [...new Set(rawQueries)]

  const budgetTokens = parseInt(
    process.env.MEMORY_CONTEXT_TOKEN_BUDGET || String(DEFAULT_CONTEXT_TOKEN_BUDGET),
    10
  )

  // 逐查询检索：嵌入成功走混合（向量 + 关键词 RRF），失败降级为仅关键词通道
  // ——关键词通道正是为短词召回设计，嵌入坏了不该连它一起废掉。
  // 每个候选额外带上**通道身份**与位次（R1：判别不再靠 distance 等值哨兵）。
  type Scored = {
    row: ChunkVectorSearchResult
    /** 该片在各趟命中里的**最小**名次——**仅作同分 tie-break**（R1-b §二 改动 4b） */
    bestIndex: number
    channel: RetrievalChannel
    /**
     * **跨查询累加**的 RRF 分（R1-b §二 改动 4a）——排序主键。
     * 两路出口都保证它是**有限正数**（降级路径由 `searchChunksKeywordScored` 补分，
     * §三），故这里不再是 `number | null`：`null` 会静默当 0 参与求和。
     */
    rrfScore: number
    vectorRank: number | null
    keywordRank: number | null
    /** 产出该候选的查询序号（跨查询合并后仍要答「它是哪趟召回的」） */
    queryIndex: number
  }
  const merged = new Map<number, Scored>()
  const blobs: Buffer[] = []
  const queryTraces: MemoryQueryTrace[] = []
  let embedReason: string | undefined
  let embeddedAny = false
  /** 首个嵌入成功的查询序号——探针池取自它（「原话优先」） */
  let firstEmbeddedQueryIndex: number | null = null

  for (const [queryIndex, q] of queries.entries()) {
    let blob: Buffer | null = null
    const embedded = await embedText(q)
    if (embedded.ok && embedded.vector.length > 0) {
      blob = vectorToBlob(embedded.vector)
      blobs.push(blob)
      embeddedAny = true
      if (firstEmbeddedQueryIndex === null) firstEmbeddedQueryIndex = queryIndex
    } else if (!embedded.ok) {
      embedReason = embedded.reason
      log.debug('记忆检索：查询嵌入不可用，降级仅关键词通道', { reason: embedded.reason })
    }
    // 落流水的布尔与上面那个分支**同源同趟**（不是从候选行反推出来的）：
    // 它答的是「这趟查询的向量通道有没有跑」，与候选行的 channel 正交。
    queryTraces.push({ queryIndex, queryText: q, queryEmbedOk: blob !== null })

    // 两路出口**同形状**（R1-b §三 落点甲）：混合路径与「整趟嵌入挂了」的降级路径
    // 拿到同一种类型 ⇒ 下面的合并逻辑零分支、零类型守卫。降级路径的分由
    // `searchChunksKeywordScored` 按同一条 RRF 公式补（不是假值，见 §三 两条禁令）。
    const hits = blob
      ? chunksRepo.searchChunksHybrid(blob, q, HYBRID_POOL_PER_QUERY, params.maxDistance)
      : chunksRepo.searchChunksKeywordScored(q, HYBRID_POOL_PER_QUERY, params.maxDistance)
    hits.forEach((hit, i) => {
      const existing = merged.get(hit.row.id)
      if (!existing) {
        // (c) **首趟胜出**：`row` / `channel` / 两位次 / `queryIndex` 描述的是
        //     「这片长什么样」，与累计分无关
        // 内存态的 distance 哨兵沿用（`RetrievedSection.distance` 等消费方按
        // number 消费）；**落库面按 channel 转 NULL**，判别职责已交给 channel
        merged.set(hit.row.id, {
          row: hit.row,
          bestIndex: i,
          channel: hit.channel,
          rrfScore: hit.rrfScore,
          vectorRank: hit.vectorRank,
          keywordRank: hit.keywordRank,
          queryIndex,
        })
        return
      }
      // (a) **累加**：同一片被多趟查询命中 ⇒ 各趟分相加（这正是 RRF 的原始形态）。
      //     只改下面的排序键而漏掉这里的话，`rrfScore` 仍是单趟值——「累加」根本
      //     没发生，排序键换汤不换药（R1-b §二 改动 4 展开，最易只做一半的一步）
      existing.rrfScore += hit.rrfScore
      // (b) 位次取 min，**仅作同分 tie-break**，保排序确定性
      existing.bestIndex = Math.min(existing.bestIndex, i)
    })
  }

  const ordered = [...merged.values()]
    // 排序主键 = **跨查询累加 RRF 分降序**；同分按 `bestIndex` 升序 tie-break
    // （R1-b §二 改动 4：口径从「哪趟名次最小」变成「跨查询累计得分最大」）
    .sort((a, b) => b.rrfScore - a.rrfScore || a.bestIndex - b.bestIndex)
    .slice(0, params.topK)
  const orderedRows = ordered.map((s) => s.row)

  // X5 埋点 + W11 判据：候选池探针取**首个嵌入成功的查询**（原话优先）。
  // 无任何嵌入成功 ⇒ 无池可探（嵌入失败本身已是结论）。
  const probe =
    blobs.length > 0 ? chunksRepo.probeChunkVectorCandidates(blobs[0], params.probeN) : []
  const blockedByStatus = probe.filter((c) => !c.passesStatusFilter).length
  const droppedByThreshold = probe.filter(
    (c) => c.passesStatusFilter && c.distance >= params.maxDistance
  ).length

  // ── 候选流水（P2 §四 表 3）：`final` = 融合 topK / `probe` = 阈值前 KNN 池 ──
  // 两类**同列**，靠 `source` 判别；`dropped_reason` 按 source 分工（结构上不重叠）。
  const finalTraces: MemoryCandidateTrace[] = ordered.map((s, finalRank) => ({
    source: 'final',
    queryIndex: s.queryIndex,
    docPath: s.row.doc_path,
    sectionAnchor: s.row.section_anchor,
    contentHash: s.row.content_hash,
    chunkId: s.row.id,
    breadcrumb: s.row.breadcrumb,
    bodyHead: s.row.body.slice(0, CANDIDATE_BODY_HEAD_CHARS),
    statusAtQuery: s.row.status,
    // 纯关键词命中写 NULL，**不写 maxDistance 哨兵**（P2 §二①）
    distance: s.channel === 'keyword' ? null : s.row.distance,
    channel: s.channel,
    rank: bestChannelRank(s.vectorRank, s.keywordRank),
    rrfScore: s.rrfScore,
    finalRank,
    // final 行按构造必然过 X4 过滤 ⇒ null = 不适用（该列只为 probe 池的归因存在）
    passedStatusFilter: null,
    injected: false,
    sectionRank: null,
    injectedPosition: null,
    droppedReason: null,
  }))
  const probeTraces: MemoryCandidateTrace[] = probe.map((c, rank) => ({
    source: 'probe',
    queryIndex: firstEmbeddedQueryIndex ?? 0,
    docPath: c.docPath,
    sectionAnchor: c.sectionAnchor,
    contentHash: c.contentHash,
    chunkId: c.id,
    breadcrumb: c.breadcrumb,
    bodyHead: c.bodyHead,
    statusAtQuery: c.status,
    // 探针池来自向量通道 KNN（阈值之前）⇒ 恒有距离真值
    distance: c.distance,
    channel: 'vector',
    rank,
    rrfScore: null,
    finalRank: null,
    passedStatusFilter: c.passesStatusFilter,
    injected: false,
    sectionRank: null,
    injectedPosition: null,
    droppedReason: !c.passesStatusFilter
      ? 'status'
      : c.distance >= params.maxDistance
        ? 'threshold'
        : 'not_topk',
  }))
  const candidates = [...finalTraces, ...probeTraces]

  const trace: Partial<MemoryContextStats> = {
    ...baseStats(),
    queries: queries.length,
    candidateChunks: ordered.length,
    budgetTokens,
    queryTraces,
    candidates,
    blockedByStatus,
    droppedByThreshold,
  }

  if (ordered.length === 0) {
    // 空结果的归因顺序：嵌入坏了 > 被状态过滤挡光 > 真的没命中。
    // 三者都会原样带上 trace（pool 计数不作取舍），所以这个顺序只影响 reason 一个
    // 字段，不丢信息。
    if (!embeddedAny && embedReason) {
      noteEmbeddingDegradation()
      return empty('embed-failed', { ...trace, embedReason })
    }
    if (blockedByStatus > 0) return empty('filtered-empty', trace)
    return empty('no-hit', trace)
  }

  // 按节补齐（Decisions 14）：命中的是片，注入的是节——节内片序按 part_index
  const bySection = new Map<string, RetrievedSection>()
  for (const chunk of orderedRows) {
    const key = `${chunk.doc_path}\0${chunk.section_anchor}`
    if (bySection.has(key)) continue
    const parts = chunksRepo.getChunksBySection(chunk.doc_path, chunk.section_anchor)
    bySection.set(key, {
      docPath: chunk.doc_path,
      sectionAnchor: chunk.section_anchor,
      breadcrumb: chunk.breadcrumb,
      // 节在库内为空（极端：命中后又被并发删）⇒ 退回命中片正文，不注入空条目
      parts: parts.length > 0 ? parts.map((p) => p.body) : [chunk.body],
      // 代表片的 status（`bySection` 只留首个 = `ordered` 里最靠前的那片）
      status: chunk.status,
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
    // `truncated: true`——本条路径**按定义**就是「发生了预算截断」（`bySection` 非空
    // 却一节都没进）。不写会落成 `EMPTY_STATS` 的默认 `false`，而 P2 §四 表 1 明写
    // 该列答「预算够不够」：全程被截却记 0，是这张表最不该产出的那种谎账。
    // 与 ok 路径同口径（`kept.length < bySection.size` ⇒ `0 < N` ⇒ true）。
    return empty('budget-exhausted', {
      ...trace,
      truncated: true,
      droppedSections: bySection.size,
    })
  }

  // ── 注入面回填：injected / section_rank / injected_position / dropped_reason ──
  // 节的判定按 (doc_path, section_anchor) **成对比较**，刻意不另拼字符串键：
  // 本仓 C1 实证过「写入层把源码里的转义序列展开成真 NUL 字节」，能少写一处
  // 就少一处（成对比较与 `bySection` 的键等同——NUL 分隔符本就是为消歧而设）。
  const keptIndexOf = (docPath: string, sectionAnchor: string): number =>
    kept.findIndex((s) => s.docPath === docPath && s.sectionAnchor === sectionAnchor)
  const renderedPositions = renderOrder(kept.length)
  finalTraces.forEach((c, i) => {
    const keptIndex = keptIndexOf(c.docPath, c.sectionAnchor)
    if (keptIndex < 0) {
      // 节没进预算（kept 循环 `break` 起停）——与 probe 行的 'threshold' 是两个
      // 相反的药方（加预算 vs 松阈值），故各留各的因
      c.droppedReason = 'budget'
      return
    }
    c.injected = true
    c.sectionRank = keptIndex
    c.injectedPosition = renderedPositions.indexOf(keptIndex) + 1
    // 同节已有更优片代表（`bySection` 只留首个，即 `ordered` 里最靠前的那片）
    if (!isSectionRepresentative(finalTraces, i)) c.droppedReason = 'section_dup'
  })
  for (const c of probeTraces) {
    const keptIndex = keptIndexOf(c.docPath, c.sectionAnchor)
    if (keptIndex < 0) continue
    // 口径统一：`injected` 答的是「该片正文有没有进 prompt」——节进了则同节全部片
    // 都进了（整节返回），与它作为 probe 候选是否被挡无关（`droppedReason` 另记）
    c.injected = true
    c.sectionRank = keptIndex
    c.injectedPosition = renderedPositions.indexOf(keptIndex) + 1
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
 * 渲染序：**最相关的首尾各半**（Lost in the Middle, arXiv:2307.03172）——
 * 前半按相关度顺序置于串首，后半**逆序**置于串尾 ⇒ 最相关的两条分别落在首部
 * 与尾部的最外侧，不落正中段（W3）。
 *
 * 返回 `[渲染位置] = 原始下标`（0-based）。
 *
 * ⚠️ 本函数是这套重排的**唯一真相源**：`renderSections` 与检索流水里的
 * `injectedPosition` 都取它。分开写两份的话，谁改了重排而没改另一份，
 * 流水会**静默**记下与猫实际读到的位置不符的编号——而「位置效应」正是
 * 这列存在的理由。
 */
function renderOrder(n: number): number[] {
  const half = Math.ceil(n / 2)
  const order: number[] = []
  for (let i = 0; i < half; i++) order.push(i)
  for (let i = n - 1; i >= half; i--) order.push(i)
  return order
}

/**
 * 把若干节渲染成注入块（重排见 `renderOrder`）。
 *
 * 序号按**最终位置**编（猫读到的是连续 1..n），故本函数的输出即最终注入串，
 * token 核算与实际注入逐字节同源（预算判据不会与注入面脱钩）。
 */
function renderSections(sections: RetrievedSection[]): { text: string; tokens: number } {
  if (sections.length === 0) return { text: '', tokens: 0 }
  const ordered = renderOrder(sections.length).map((i) => sections[i])
  const lines = ordered.map((s, i) => `${i + 1}. ${retiredMark(s)}${s.parts.join('\n')}`)
  const text = `\n\n【相关记忆】\n${lines.join('\n')}`
  return { text, tokens: estimateTokens(text) }
}

/** C4 注入标记（票面契约字面量，**不许换写法**） */
const RETIRED_SECTION_PREFIX = '【已废弃·仅留结论】'

/**
 * 退役节的注入标记（C4）——由**节装配带下来的 `status` 列**驱动。
 *
 * 为什么不认正文内容（例如「正文里已有『已废弃』三字」）：正文是退役文档自己写的，
 * 它没写、或写法不同，标记就消失；而这里的判据是**库里的状态列**，与「为什么它
 * 被召回」同一个来源。正文不可信、状态列可信，这是标记的全部意义——猫读到这条
 * 结论时**不可能**把它当成活指导。
 */
function retiredMark(section: RetrievedSection): string {
  return section.status !== null && RETIRED_STATUSES.has(section.status)
    ? RETIRED_SECTION_PREFIX
    : ''
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
export async function buildKnowledgeContext(
  triggerContent: string,
  /**
   * R2 段五：把**本条查询的实际命中数**报给调用方（`knowledge.retrieval` 段的
   * `item_count`）。走回调而不是改返回类型——返回串是既有契约，为观测改掉它是
   * 「为观测改行为」。**空手而归的各条早退路径都会报 0**（不报 = 调用方分不清
   * 「没命中」与「压根没跑」，那正是本仓反复栽的「返回空且无痕」）。
   */
  onHits?: (hits: number) => void
): Promise<string> {
  // 与 retrieveMemoryContext 同款：剥离 @mention 再检索，查询向量与存储向量同语义空间
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) {
    onHits?.(0)
    return ''
  }

  const topK = parseInt(process.env.KNOWLEDGE_TOP_K || '3', 10)
  const embedded = await embedText(cleanContent)
  if (!embedded.ok) {
    log.debug('知识库查询嵌入不可用，跳过检索', { reason: embedded.reason })
    onHits?.(0)
    return ''
  }
  const vector = embedded.vector
  if (vector.length === 0) {
    onHits?.(0)
    return ''
  }

  const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(vector), topK)
  onHits?.(rows.length)
  if (rows.length === 0) return ''

  const lines = rows.map((r, i) => `${i + 1}. ${r.content}`)
  return `\n\n【知识库】\n${lines.join('\n')}`
}

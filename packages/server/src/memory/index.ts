/**
 * 记忆服务 — 向量记忆的检索与上下文构建。
 *
 * ⚠️ **本模块只读**（票壬 · 旧写口退役）：把「用户消息」写成向量记忆的那个函数
 * 已删除（见 `scripts/flywheel/retire-message-memory.mjs`）——索引侧唯一写口是
 * 飞轮扫描器（`scripts/flywheel/scan.mjs`），对话原话不再入库。
 * 检索面保留：`memories` 表结构未动（DROP 归票辛接线时统一做）。
 *
 * 检索: 原话 + 改写查询双通道 → 嵌入 → sqlite-vec cosine 相似度 → 距离下限过滤 → 合并去重 → top-K
 * 注入: 格式化记忆文本 → 拼接到 system prompt（始终是存储原文，改写不参与注入）
 *
 * 环境变量:
 *   MEMORY_TOP_K                — 检索记忆数量（默认 3）
 *   KNOWLEDGE_TOP_K             — 知识库检索数量（默认 3），见 buildKnowledgeContext
 *   MEMORY_MAX_DISTANCE         — 检索距离下限（默认 0.6），余弦距离超过此值的记忆不召回
 *   MEMORY_QUERY_REWRITE_ENABLED— 查询改写开关（默认 "1"），见 query-rewrite.ts
 */

import { memories as memoriesRepo, knowledge as knowledgeRepo } from '../db/repository/index.js'
import { embedText, getEmbeddingStatus, isMemoryEnabled } from './embedding.js'
import { rewriteRetrievalQueries } from './query-rewrite.js'
import { createLogger } from '../logger.js'

const log = createLogger('memory')

// ─── 向量 ↔ BLOB 转换 ─────────────────────────────────

/** number[] → Float32Array → Buffer（存为 SQLite BLOB） */
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

/** Buffer → Float32Array → number[]（从 BLOB 读取） */
export function blobToVector(blob: Buffer): number[] {
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
}

// ─── 检索 ────────────────────────────────────────────

export interface RetrievedMemory {
  id: string
  content: string
  distance: number // 余弦距离，0 = 最相似
  sourceMessageId: string
  createdAt: string
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

/**
 * 按余弦相似度从全局记忆空间中搜索与 queryText 最相关的 top-K 记忆。
 * 单通道便捷入口（= searchMemoriesMulti([queryText], topK)）。
 */
export async function searchMemories(
  queryText: string,
  topK: number = 3
): Promise<RetrievedMemory[]> {
  return searchMemoriesMulti([queryText], topK)
}

/**
 * 多查询检索：对每个查询（原话 + 改写）分别嵌入并检索，再按记忆 id 合并
 * （同一记忆保留最小距离），按距离重排后返回 top-K。
 *
 * 特征:
 * - 距离下限: 余弦距离 ≥ MEMORY_MAX_DISTANCE 的记忆不召回（过滤最大噪音源）
 * - 查询去重: 与原话重复的改写查询不会重复嵌入
 * - 通道容错: 单条查询嵌入失败/单通道检索失败不影响其他通道
 */
export async function searchMemoriesMulti(
  queries: string[],
  topK: number = 3
): Promise<RetrievedMemory[]> {
  if (!isMemoryEnabled() || queries.length === 0) return []

  const maxDistance = parseFloat(process.env.MEMORY_MAX_DISTANCE || '0.6')
  const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))]

  // 混合检索开关（MEMORY_HYBRID_ENABLED='1'）：向量 + FTS5 关键词双通道 RRF 融合。
  // 开关关（默认）→ 以下现有纯向量路径一行不动，行为与现网逐字节一致
  if (isHybridRetrievalEnabled()) {
    return searchMemoriesHybridPath(uniqueQueries, topK, maxDistance)
  }

  // 并行嵌入所有查询；单条失败降级为跳过该通道
  const vectors = await Promise.all(
    uniqueQueries.map(async (q) => {
      const r = await embedText(q)
      if (!r.ok) {
        log.debug('查询嵌入不可用，跳过该通道', { reason: r.reason })
        return null
      }
      return r.vector
    })
  )
  const blobs = vectors.filter((v): v is number[] => !!v && v.length > 0).map(vectorToBlob)
  if (blobs.length === 0) {
    noteEmbeddingDegradation()
    return []
  }

  // 各通道结果按 id 合并，保留最小距离
  const merged = new Map<string, RetrievedMemory>()
  for (const blob of blobs) {
    try {
      const rows = memoriesRepo.searchMemoriesByVector(blob, topK, maxDistance)
      for (const r of rows) {
        const existing = merged.get(r.id)
        if (!existing || r.distance < existing.distance) {
          merged.set(r.id, {
            id: r.id,
            content: r.content,
            distance: r.distance,
            sourceMessageId: r.source_message_id,
            createdAt: r.created_at,
          })
        }
      }
    } catch (err: any) {
      log.warn('单通道记忆检索失败', { error: err.message })
    }
  }

  return [...merged.values()].sort((a, b) => a.distance - b.distance).slice(0, topK)
}

// ─── 混合检索路径（开关开时替代纯向量路径）──────────────

/** 混合检索开关（MEMORY_HYBRID_ENABLED='1'；默认关，检索行为与现网逐字节一致） */
export function isHybridRetrievalEnabled(): boolean {
  return (process.env.MEMORY_HYBRID_ENABLED || '0') === '1'
}

/**
 * 混合检索路径：每个查询独立跑 向量+FTS5 关键词 RRF 融合（repo 层），
 * 多查询结果按最优排名（bestIndex）合并去重，返回 top-K。
 *
 * 容错：
 * - 单查询嵌入失败 → 该查询降级为仅关键词通道（关键词通道正是为短词召回设计）
 * - 关键词通道失败（FTS 表缺失等）→ repo 层已降级返回空，结果等价纯向量
 * - 纯关键词命中无向量距离 → distance 填 maxDistance 边界值（与 repo 层哨兵语义一致）
 */

/** 类型守卫：向量通道行带 distance 真值，关键词通道行无该字段（显式谓词，绕开 in 收窄歧义） */
function isVectorHitRow(
  r: memoriesRepo.MemorySearchResult | memoriesRepo.KeywordSearchResult
): r is memoriesRepo.MemorySearchResult {
  return 'distance' in r
}

async function searchMemoriesHybridPath(
  queries: string[],
  topK: number,
  maxDistance: number
): Promise<RetrievedMemory[]> {
  type Scored = { row: RetrievedMemory; bestIndex: number }
  const merged = new Map<string, Scored>()

  for (const q of queries) {
    let blob: Buffer | null = null
    const embedded = await embedText(q)
    if (embedded.ok && embedded.vector.length > 0) {
      blob = vectorToBlob(embedded.vector)
    } else if (!embedded.ok) {
      log.debug('混合检索：查询嵌入不可用，降级仅关键词通道', { reason: embedded.reason })
      noteEmbeddingDegradation()
    }

    let rows: memoriesRepo.MemorySearchResult[] | memoriesRepo.KeywordSearchResult[]
    if (blob) {
      rows = memoriesRepo.searchMemoriesHybrid(blob, q, topK, maxDistance)
    } else {
      rows = memoriesRepo.searchMemoriesByKeyword(q, topK)
    }

    rows.forEach((r, i) => {
      const candidate: RetrievedMemory = isVectorHitRow(r)
        ? {
            id: r.id,
            content: r.content,
            distance: r.distance,
            sourceMessageId: r.source_message_id,
            createdAt: r.created_at,
          }
        : {
            id: r.id,
            content: r.content,
            distance: maxDistance,
            sourceMessageId: r.source_message_id,
            createdAt: r.created_at,
          }
      const existing = merged.get(r.id)
      if (!existing || i < existing.bestIndex) {
        merged.set(r.id, { row: candidate, bestIndex: i })
      }
    })
  }

  return [...merged.values()]
    .sort((a, b) => a.bestIndex - b.bestIndex)
    .slice(0, topK)
    .map((s) => s.row)
}

// ─── 上下文构建 ───────────────────────────────────────

/**
 * 检索相关记忆并格式化为 system prompt 可拼接的文本块。
 * 无匹配时返回空字符串。
 *
 * 双通道检索：原话始终是第一通道；查询改写（指代消解/意图展开）
 * 只生成额外的检索查询，注入内容始终是存储原文，猫读到的是一手信息。
 * 改写失败/关闭时自动降级为仅原话检索。
 */
export async function buildMemoryContext(triggerContent: string): Promise<string> {
  // 剥离 @mention 再检索：@mention 是路由元数据而非用户意图，混入查询会
  // 拉偏查询向量、降低召回质量。
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) return ''

  const topK = parseInt(process.env.MEMORY_TOP_K || '3', 10)
  const rewrites = await rewriteRetrievalQueries(cleanContent)
  const queries = [cleanContent, ...rewrites]

  const memories = await searchMemoriesMulti(queries, topK)

  if (memories.length === 0) return ''

  const lines = memories.map((m, i) => `${i + 1}. ${m.content}`)
  return `\n\n【相关记忆】\n${lines.join('\n')}`
}

/**
 * 检索知识库并格式化为 system prompt 的独立【知识库】区块。
 * 无匹配返回空字符串（同 buildMemoryContext 约定）。
 *
 * 与【相关记忆】并列独立区块——来源权威性不同（运营方标准数据 vs 对话
 * 记忆），检索语义不可混淆。
 *
 * 单向量通道（不改写双通道）：改写通道服务于用户口语化 query（对话记忆
 * 检索场景），知识库查询由模型生成的结构化 query 发起，无口语歧义需求；
 * 命中为空 → 返回空串不注入，不降级模糊匹配。检索阈值 0.35 在
 * searchKnowledgeByVector 默认参数（知识文档语义密度高、宁缺毋滥）。
 *
 * 环境变量: KNOWLEDGE_TOP_K — 检索条目数（默认 3）
 */
export async function buildKnowledgeContext(triggerContent: string): Promise<string> {
  // 与 buildMemoryContext 同款：剥离 @mention 再检索，查询向量与存储向量同语义空间
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

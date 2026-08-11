/**
 * 记忆服务 — 向量记忆的存储、检索与上下文构建。
 *
 * 存储: 用户消息 → 嵌入 → memories 表（单行，所有 Agent 共享）
 * 检索: 原话 + 改写查询双通道 → 嵌入 → sqlite-vec cosine 相似度 → 距离下限过滤 → 合并去重 → top-K
 * 注入: 格式化记忆文本 → 拼接到 system prompt（始终是存储原文，改写不参与注入）
 *
 * 环境变量:
 *   MEMORY_TOP_K                — 检索记忆数量（默认 3）
 *   KNOWLEDGE_TOP_K             — 知识库检索数量（默认 3），见 buildKnowledgeContext
 *   MEMORY_MAX_DISTANCE         — 检索距离下限（默认 0.6），余弦距离超过此值的记忆不召回
 *   MEMORY_DEDUP_THRESHOLD      — 去重余弦距离阈值（默认 0.20），小于此值时跳过存储
 *   MEMORY_UPDATE_THRESHOLD     — 更新余弦距离阈值（默认 0.35），去重与更新之间的记忆会被 UPDATE 而非 INSERT
 *   MEMORY_DEDUP_ENABLED        — 是否开启去重/更新（默认 "1"），设为 "0" 关闭
 *   MEMORY_QUERY_REWRITE_ENABLED— 查询改写开关（默认 "1"），见 query-rewrite.ts
 *   MEMORY_FILTER_ENABLED       — 入库筛选开关（默认 "1"），见 filter.ts
 *   MEMORY_MIN_CONTENT_LENGTH   — 最小入库内容长度（默认 4），短于该值的消息不入库
 *
 * 三段式逻辑:
 *   距离 < DEDUP_THRESHOLD      → 跳过（几乎相同，无需存储）
 *   DEDUP ≤ 距离 < UPDATE       → UPDATE（话题相关但内容不同，修正旧记忆）
 *   距离 ≥ UPDATE               → INSERT（全新话题）
 */

import { v4 as uuid } from 'uuid'
import { memories as memoriesRepo, knowledge as knowledgeRepo } from '../db/repository/index.js'
import { embedText, isMemoryEnabled } from './embedding.js'
import { rewriteRetrievalQueries } from './query-rewrite.js'
import { evaluateMemoryContent, isMemoryFilterEnabled } from './filter.js'
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

// ─── 存储 ────────────────────────────────────────────

/**
 * 将用户消息存为向量记忆。
 *
 * 共享记忆模式：同一条消息只存一行，不再为每个 Agent 复制一份。
 * agentIds[0] 作为来源元数据记录在 agent_id 列。
 *
 * 这是"即发即弃"的——失败只记日志，不抛异常、不阻塞消息流。
 */
export async function saveMessageMemory(
  _sessionId: string,
  content: string,
  sourceMessageId: string,
  agentIds: string[]
): Promise<void> {
  if (!isMemoryEnabled()) return
  if (!agentIds.length) return

  // 剥离 @mention 再嵌入，避免路由元数据污染语义向量。
  // @mention 是分发信息而非用户意图，混入会降低去重精度，
  // 尤其在短消息场景下，@前缀占比过高会导致误判重复。
  const cleanContent = content.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) {
    log.debug('消息仅含 @mention，跳过记忆存储', { content })
    return
  }

  // 入库筛选：deny-list，只过滤高置信度垃圾（应答词/纯填充/一次性指令）。
  // 长期/偏好标记命中时无条件存储——约定的优先级高于指令特征。
  if (isMemoryFilterEnabled()) {
    const verdict = evaluateMemoryContent(cleanContent)
    if (!verdict.store) {
      log.debug('记忆筛选：跳过', { reason: verdict.reason, content: cleanContent })
      return
    }
  }

  let embedding: number[]
  try {
    embedding = await embedText(cleanContent)
  } catch (err: any) {
    log.warn('嵌入生成失败，跳过记忆存储', { error: err.message })
    return
  }

  if (!embedding || embedding.length === 0) return

  const blob = vectorToBlob(embedding)
  const now = new Date().toISOString()

  // ── 去重 / 更新检测（全局，不再按 agent 隔离） ──────
  const dedupEnabled = (process.env.MEMORY_DEDUP_ENABLED || '1') !== '0'
  const dedupThreshold = parseFloat(process.env.MEMORY_DEDUP_THRESHOLD || '0.20')
  const updateThreshold = parseFloat(process.env.MEMORY_UPDATE_THRESHOLD || '0.35')

  if (dedupEnabled) {
    try {
      const nearest = memoriesRepo.findNearestMemory(blob)

      if (nearest && nearest.distance < dedupThreshold) {
        // 几乎相同的记忆 → 跳过
        log.debug('记忆去重：跳过重复记忆', {
          distance: nearest.distance.toFixed(4),
          threshold: dedupThreshold,
        })
        return
      }

      if (nearest && nearest.distance < updateThreshold) {
        // 话题相关但内容不同 → 更新旧记忆（修正）
        memoriesRepo.updateMemory(nearest.id, cleanContent, blob, sourceMessageId, now)
        log.debug('记忆修正：更新已有记忆', {
          memoryId: nearest.id,
          distance: nearest.distance.toFixed(4),
          updateThreshold: updateThreshold.toFixed(2),
          contentLen: cleanContent.length,
        })
        return
      }

      // else: 全新话题 → 继续执行 INSERT
    } catch {
      // 去重查询失败不阻塞存储
    }
  }

  // ── 写入：共享模式只存一行，用第一个 agent 作为来源 ──

  try {
    const provenanceAgentId = agentIds[0]
    memoriesRepo.insertMemory(uuid(), provenanceAgentId, cleanContent, blob, sourceMessageId, now)
    log.debug('记忆已存储', {
      provenanceAgentId,
      contentLen: cleanContent.length,
      dim: embedding.length,
    })
  } catch (err: any) {
    log.error('记忆写入失败', { error: err.message, sourceMessageId })
  }
}

// ─── 检索 ────────────────────────────────────────────

export interface RetrievedMemory {
  id: string
  content: string
  distance: number // 余弦距离，0 = 最相似
  sourceMessageId: string
  createdAt: string
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
      try {
        return await embedText(q)
      } catch (err: any) {
        log.warn('查询嵌入生成失败，跳过该通道', { error: err.message })
        return []
      }
    })
  )
  const blobs = vectors.filter((v) => v && v.length > 0).map(vectorToBlob)
  if (blobs.length === 0) return []

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
    try {
      const v = await embedText(q)
      if (v && v.length > 0) blob = vectorToBlob(v)
    } catch (err: any) {
      log.warn('混合检索：查询嵌入失败，降级仅关键词通道', { error: err.message })
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
  // 剥离 @mention 再检索，与 saveMessageMemory 存储时保持一致，
  // 避免查询向量与存储向量处于不同语义空间导致召回质量下降。
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
  let vector: number[]
  try {
    vector = await embedText(cleanContent)
  } catch (err: any) {
    log.warn('知识库查询嵌入失败，跳过检索', { error: err.message })
    return ''
  }
  if (!vector || vector.length === 0) return ''

  const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(vector), topK)
  if (rows.length === 0) return ''

  const lines = rows.map((r, i) => `${i + 1}. ${r.content}`)
  return `\n\n【知识库】\n${lines.join('\n')}`
}

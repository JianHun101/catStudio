/**
 * 记忆服务 — 向量记忆的存储、检索与上下文构建。
 *
 * 存储: 用户消息 → 嵌入 → memories 表（单行，所有 Agent 共享）
 * 检索: 原话 + 改写查询双通道 → 嵌入 → sqlite-vec cosine 相似度 → 距离下限过滤 → 合并去重 → top-K
 * 注入: 格式化记忆文本 → 拼接到 system prompt（始终是存储原文，改写不参与注入）
 *
 * 环境变量:
 *   MEMORY_TOP_K                — 检索记忆数量（默认 3）
 *   MEMORY_MAX_DISTANCE         — 检索距离下限（默认 0.6），余弦距离超过此值的记忆不召回
 *   MEMORY_DEDUP_THRESHOLD      — 去重余弦距离阈值（默认 0.20），小于此值时跳过存储
 *   MEMORY_UPDATE_THRESHOLD     — 更新余弦距离阈值（默认 0.35），去重与更新之间的记忆会被 UPDATE 而非 INSERT
 *   MEMORY_DEDUP_ENABLED        — 是否开启去重/更新（默认 "1"），设为 "0" 关闭
 *   MEMORY_QUERY_REWRITE_ENABLED— 查询改写开关（默认 "1"），见 query-rewrite.ts
 *
 * 三段式逻辑:
 *   距离 < DEDUP_THRESHOLD      → 跳过（几乎相同，无需存储）
 *   DEDUP ≤ 距离 < UPDATE       → UPDATE（话题相关但内容不同，修正旧记忆）
 *   距离 ≥ UPDATE               → INSERT（全新话题）
 */

import { v4 as uuid } from 'uuid'
import { memories as memoriesRepo } from '../db/repository/index.js'
import { embedText, isMemoryEnabled } from './embedding.js'
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

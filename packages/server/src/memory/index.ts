/**
 * 记忆服务 — 向量记忆的存储、检索与上下文构建。
 *
 * 存储: 用户消息 → 嵌入 → memories 表（单行，所有 Agent 共享）
 * 检索: 触发消息 → 嵌入 → sqlite-vec cosine 相似度 → 全局 top-K 记忆
 * 注入: 格式化记忆文本 → 拼接到 system prompt
 *
 * 环境变量:
 *   MEMORY_TOP_K             — 检索记忆数量（默认 3）
 *   MEMORY_DEDUP_THRESHOLD   — 去重余弦距离阈值（默认 0.20），小于此值时跳过存储
 *   MEMORY_UPDATE_THRESHOLD  — 更新余弦距离阈值（默认 0.35），去重与更新之间的记忆会被 UPDATE 而非 INSERT
 *   MEMORY_DEDUP_ENABLED     — 是否开启去重/更新（默认 "1"），设为 "0" 关闭
 *
 * 三段式逻辑:
 *   距离 < DEDUP_THRESHOLD      → 跳过（几乎相同，无需存储）
 *   DEDUP ≤ 距离 < UPDATE       → UPDATE（话题相关但内容不同，修正旧记忆）
 *   距离 ≥ UPDATE               → INSERT（全新话题）
 */

import { v4 as uuid } from 'uuid'
import { memories as memoriesRepo } from '../db/repository/index.js'
import { embedText, isMemoryEnabled } from './embedding.js'
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
 * 使用 sqlite-vec 内置的 vec_distance_cosine()。
 * 不再按 agent_id 过滤——所有记忆对所有猫可见。
 */
export async function searchMemories(
  queryText: string,
  topK: number = 3
): Promise<RetrievedMemory[]> {
  if (!isMemoryEnabled()) return []

  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedText(queryText)
  } catch (err: any) {
    log.warn('查询嵌入生成失败，跳过记忆检索', { error: err.message })
    return []
  }

  if (!queryEmbedding || queryEmbedding.length === 0) return []

  const queryBlob = vectorToBlob(queryEmbedding)

  try {
    const rows = memoriesRepo.searchMemoriesByVector(queryBlob, topK)

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      distance: r.distance,
      sourceMessageId: r.source_message_id,
      createdAt: r.created_at,
    }))
  } catch (err: any) {
    log.error('记忆检索失败', { error: err.message })
    return []
  }
}

// ─── 上下文构建 ───────────────────────────────────────

/**
 * 检索相关记忆并格式化为 system prompt 可拼接的文本块。
 * 无匹配时返回空字符串。
 */
export async function buildMemoryContext(triggerContent: string): Promise<string> {
  // 剥离 @mention 再检索，与 saveMessageMemory 存储时保持一致，
  // 避免查询向量与存储向量处于不同语义空间导致召回质量下降。
  const cleanContent = triggerContent.replace(/@\S+\s*/g, '').trim()
  if (!cleanContent) return ''

  const topK = parseInt(process.env.MEMORY_TOP_K || '3', 10)
  const memories = await searchMemories(cleanContent, topK)

  if (memories.length === 0) return ''

  const lines = memories.map((m, i) => `${i + 1}. ${m.content}`)
  return `\n\n【相关记忆】\n${lines.join('\n')}`
}

/**
 * 记忆服务 — 向量记忆的存储、检索与上下文构建。
 *
 * 存储: 用户消息 → 嵌入 → memories 表（每 Agent 一行，共享 embedding BLOB）
 * 检索: 触发消息 → 嵌入 → sqlite-vec cosine 相似度 → top-K 记忆
 * 注入: 格式化记忆文本 → 拼接到 system prompt
 *
 * 环境变量:
 *   MEMORY_TOP_K            — 检索记忆数量（默认 3）
 *   MEMORY_DEDUP_THRESHOLD  — 去重余弦距离阈值（默认 0.20），新记忆与已有记忆距离小于此值时跳过存储
 *   MEMORY_DEDUP_ENABLED    — 是否开启去重（默认 "1"），设为 "0" 关闭
 */

import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'
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
  return Array.from(
    new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
  )
}

// ─── 存储 ────────────────────────────────────────────

/**
 * 将用户消息存为向量记忆。
 * 对 session 中每个 Agent 各写一行，embedding 相同。
 *
 * 这是"即发即弃"的——失败只记日志，不抛异常、不阻塞消息流。
 */
export async function saveMessageMemory(
  _sessionId: string,
  content: string,
  sourceMessageId: string,
  agentIds: string[],
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

  const db = getDb()
  const blob = vectorToBlob(embedding)
  const now = new Date().toISOString()

  // ── 去重检测 ────────────────────────────────────────
  const dedupEnabled = (process.env.MEMORY_DEDUP_ENABLED || '1') !== '0'
  const dedupThreshold = parseFloat(
    process.env.MEMORY_DEDUP_THRESHOLD || '0.20',
  )

  const agentsToStore: string[] = []

  if (dedupEnabled) {
    const checkStmt = db.prepare(`
      SELECT vec_distance_cosine(embedding, ?) AS distance
      FROM memories
      WHERE agent_id = ? AND embedding IS NOT NULL
      ORDER BY distance
      LIMIT 1
    `)

    for (const agentId of agentIds) {
      try {
        const row = checkStmt.get(blob, agentId) as
          | { distance: number }
          | undefined
        if (row && row.distance < dedupThreshold) {
          log.debug('记忆去重：跳过重复记忆', {
            agentId,
            distance: row.distance.toFixed(4),
            threshold: dedupThreshold,
          })
          continue
        }
        agentsToStore.push(agentId)
      } catch {
        // 去重查询失败不阻塞存储
        agentsToStore.push(agentId)
      }
    }

    if (agentsToStore.length === 0) {
      log.debug('记忆去重：所有 Agent 均已存在相似记忆，跳过存储', {
        totalAgents: agentIds.length,
      })
      return
    }
  } else {
    agentsToStore.push(...agentIds)
  }

  // ── 写入 ─────────────────────────────────────────────

  const insert = db.prepare(`
    INSERT INTO memories (id, agent_id, content, embedding, source_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((ids: string[]) => {
    for (const agentId of ids) {
      insert.run(uuid(), agentId, content, blob, sourceMessageId, now)
    }
  })

  try {
    insertMany(agentsToStore)
    log.debug('记忆已存储', {
      agentCount: agentsToStore.length,
      skippedCount: agentIds.length - agentsToStore.length,
      contentLen: content.length,
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
 * 按余弦相似度搜索与 queryText 最相关的 top-K 记忆。
 * 使用 sqlite-vec 内置的 vec_distance_cosine()。
 */
export async function searchMemories(
  agentId: string,
  queryText: string,
  topK: number = 3,
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

  const db = getDb()
  const queryBlob = vectorToBlob(queryEmbedding)

  try {
    const rows = db
      .prepare(
        `
      SELECT id, content, source_message_id, created_at,
             vec_distance_cosine(embedding, ?) AS distance
      FROM memories
      WHERE agent_id = ? AND embedding IS NOT NULL
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(queryBlob, agentId, topK) as Array<{
      id: string
      content: string
      source_message_id: string
      created_at: string
      distance: number
    }>

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
export async function buildMemoryContext(
  agentId: string,
  triggerContent: string,
): Promise<string> {
  const topK = parseInt(process.env.MEMORY_TOP_K || '3', 10)
  const memories = await searchMemories(agentId, triggerContent, topK)

  if (memories.length === 0) return ''

  const lines = memories.map(
    (m, i) => `${i + 1}. ${m.content}`,
  )
  return `\n\n【相关记忆】\n${lines.join('\n')}`
}

/**
 * Memory 表查询函数。
 *
 * 记忆共享：检索不再按 agent_id 过滤，所有猫共享同一向量空间。
 * agent_id 降级为来源元数据（记录该记忆由哪只猫的对话产生）。
 */
import type Database from 'better-sqlite3'
import type { MemoryRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 去重 / 更新检测 ────────────────────────────────────

export interface NearestMemoryResult {
  id: string
  distance: number
}

/**
 * 在全局记忆中查找与给定向量最相似的一条。
 * 不再按 agent_id 过滤——所有猫共享记忆空间。
 */
export function findNearestMemory(embeddingBlob: Buffer): NearestMemoryResult | undefined {
  return db
    .prepare(
      `SELECT id, vec_distance_cosine(embedding, ?) AS distance
       FROM memories
       WHERE embedding IS NOT NULL
       ORDER BY distance
       LIMIT 1`
    )
    .get(embeddingBlob) as NearestMemoryResult | undefined
}

// ─── 记忆修正 ──────────────────────────────────────────

/**
 * 更新已有记忆的 content 和 embedding。
 * 用于"同一话题出现新信息，覆盖旧记忆"的场景。
 */
export function updateMemory(
  id: string,
  content: string,
  embeddingBlob: Buffer,
  sourceMessageId: string,
  createdAt: string
): void {
  db.prepare(
    `UPDATE memories
     SET content = ?, embedding = ?, source_message_id = ?, created_at = ?
     WHERE id = ?`
  ).run(content, embeddingBlob, sourceMessageId, createdAt, id)
}

// ─── 检索 ──────────────────────────────────────────────

export interface MemorySearchResult {
  id: string
  content: string
  source_message_id: string
  created_at: string
  distance: number
}

/**
 * 按余弦距离搜索最相关的 top-K 记忆。
 * 全局搜索，不再按 agent_id 过滤。
 */
export function searchMemoriesByVector(queryBlob: Buffer, topK: number): MemorySearchResult[] {
  return db
    .prepare(
      `SELECT id, content, source_message_id, created_at,
              vec_distance_cosine(embedding, ?) AS distance
       FROM memories
       WHERE embedding IS NOT NULL
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryBlob, topK) as MemorySearchResult[]
}

// ─── 写入 ──────────────────────────────────────────────

export function insertMemory(
  id: string,
  agentId: string,
  content: string,
  embeddingBlob: Buffer,
  sourceMessageId: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO memories (id, agent_id, content, embedding, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, content, embeddingBlob, sourceMessageId, createdAt)
}

/** 批量插入记忆（事务内调用，复用同一条 prepared statement） */
export function insertMemoryBatch(
  items: Array<{
    id: string
    agentId: string
    content: string
    embeddingBlob: Buffer
    sourceMessageId: string
    createdAt: string
  }>
): void {
  const insert = db.prepare(
    `INSERT INTO memories (id, agent_id, content, embedding, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertMany = db.transaction(() => {
    for (const item of items) {
      insert.run(
        item.id,
        item.agentId,
        item.content,
        item.embeddingBlob,
        item.sourceMessageId,
        item.createdAt
      )
    }
  })
  insertMany()
}

/**
 * 删除与指定 agent 关联的记忆。
 * 注意：共享记忆模式下，这只删除来源是该猫的记录。
 * 其他猫产生的记忆不受影响。
 */
export function deleteMemoriesByAgent(agentId: string): void {
  db.prepare('DELETE FROM memories WHERE agent_id = ?').run(agentId)
}

/** 清空全部记忆（用于 --reset 流程，必须在删 agents 之前调用，否则 FK violation）。 */
export function deleteAllMemories(): void {
  db.prepare('DELETE FROM memories').run()
}

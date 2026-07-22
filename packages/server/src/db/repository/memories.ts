/**
 * Memory 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { MemoryRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 去重检测 ──────────────────────────────────────────

export function findNearestMemory(
  embeddingBlob: Buffer,
  agentId: string
): { distance: number } | undefined {
  return db
    .prepare(
      `SELECT vec_distance_cosine(embedding, ?) AS distance
       FROM memories
       WHERE agent_id = ? AND embedding IS NOT NULL
       ORDER BY distance
       LIMIT 1`
    )
    .get(embeddingBlob, agentId) as { distance: number } | undefined
}

// ─── 检索 ──────────────────────────────────────────────

export interface MemorySearchResult {
  id: string
  content: string
  source_message_id: string
  created_at: string
  distance: number
}

export function searchMemoriesByVector(
  queryBlob: Buffer,
  agentId: string,
  topK: number
): MemorySearchResult[] {
  return db
    .prepare(
      `SELECT id, content, source_message_id, created_at,
              vec_distance_cosine(embedding, ?) AS distance
       FROM memories
       WHERE agent_id = ? AND embedding IS NOT NULL
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryBlob, agentId, topK) as MemorySearchResult[]
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

export function deleteMemoriesByAgent(agentId: string): void {
  db.prepare('DELETE FROM memories WHERE agent_id = ?').run(agentId)
}

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
 *
 * maxDistance 为距离下限：余弦距离超过此值的记忆不召回。
 * 子查询包裹使 vec_distance_cosine 每行只求值一次（WHERE 中不能引用同层 SELECT 别名）。
 *
 * table 参数（知识库 Phase 1）：可选 'memories'（默认）/ 'knowledge'——
 * knowledge.ts 复用同一查询体。安全边界：入口白名单校验（非二者抛
 * TypeError），参数来源永不放宽到外部输入。knowledge 表无
 * source_message_id 列，其 source 列经 `source AS source_message_id`
 * 统一映射为「来源标注」载体（memories=消息 id，knowledge=文档来源）。
 */
const SEARCHABLE_TABLES = new Set(['memories', 'knowledge'])

export function searchMemoriesByVector(
  queryBlob: Buffer,
  topK: number,
  maxDistance: number,
  table: 'memories' | 'knowledge' = 'memories'
): MemorySearchResult[] {
  if (!SEARCHABLE_TABLES.has(table)) {
    throw new TypeError(`searchMemoriesByVector: 不支持的检索表 ${table}（仅 memories/knowledge）`)
  }
  // 列集合按表字面量取（与表名同源白名单）——memories 取 source_message_id，
  // knowledge 无该列，内层把 source 映射为 source_message_id 输出列名（外层
  // 只能引用子查询输出列名，若外层再写 source 会 no such column）
  const innerSourceColumn =
    table === 'knowledge' ? 'source AS source_message_id' : 'source_message_id'
  return db
    .prepare(
      `SELECT id, content, source_message_id, created_at, distance
       FROM (
         SELECT id, content, ${innerSourceColumn}, created_at,
                vec_distance_cosine(embedding, ?) AS distance
         FROM ${table}
         WHERE embedding IS NOT NULL
       )
       WHERE distance < ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryBlob, maxDistance, topK) as MemorySearchResult[]
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

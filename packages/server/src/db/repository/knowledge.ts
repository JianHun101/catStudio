/**
 * 知识库表查询函数（知识库 Phase 1）。
 *
 * 知识库 = 运营方维护的标准数据（与对话记忆语义隔离）：
 *   - 独立表（不加 type 列混进 memories）——对话记忆可被去重三段式 UPDATE
 *     修正，知识库不可被对话覆盖，复用表会让去重/更新语义硬分叉
 *   - 检索复用 searchMemoriesByVector 查询体（表名参数化 + 入口白名单校验，
 *     见 memories.ts），阈值 maxDistance = 0.35——知识文档语义密度高、
 *     宁缺毋滥，比对话记忆检索 MEMORY_MAX_DISTANCE=0.6 更严；0.35 不是
 *     去重三段式的 UPDATE 阈值（那是另一条线，互不干扰）
 */
import type Database from 'better-sqlite3'
import { searchMemoriesByVector } from './memories.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export interface KnowledgeSearchResult {
  id: string
  content: string
  /** 来源标注（文档名/URL）——memories 表的 source_message_id 列在此映射为 source */
  source: string
  created_at: string
  distance: number
}

/**
 * 按余弦距离搜索知识库 top-K 条目。
 * maxDistance 默认 0.35（知识库检索阈值，见文件头注释）。
 * 委托 searchMemoriesByVector 的 knowledge 分支（同一查询体），
 * 把统一的「来源标注」载体字段映射回 source。
 */
export function searchKnowledgeByVector(
  queryBlob: Buffer,
  topK: number,
  maxDistance = 0.35
): KnowledgeSearchResult[] {
  const rows = searchMemoriesByVector(queryBlob, topK, maxDistance, 'knowledge')
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    source: r.source_message_id,
    created_at: r.created_at,
    distance: r.distance,
  }))
}

/**
 * 写入/更新知识条目（upsert，seed 幂等通道）。
 *
 * ON CONFLICT(id) DO UPDATE——知识文档 id 固定（uuid.v5），重跑 seed 更新
 * 内容与嵌入而非报错。embedding 用 COALESCE 保护：嵌入失败（NULL）时保留
 * 既有嵌入，降级路径不冲掉已入库的好向量（重跑幂等补齐语义）。
 */
export function upsertKnowledge(
  id: string,
  content: string,
  embeddingBlob: Buffer | null,
  source: string,
  tags: string[]
): Database.RunResult {
  return db
    .prepare(
      `INSERT INTO knowledge (id, content, embedding, source, tags, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         embedding = COALESCE(excluded.embedding, knowledge.embedding),
         source = excluded.source,
         tags = excluded.tags`
    )
    .run(id, content, embeddingBlob, source, JSON.stringify(tags))
}

/**
 * 知识库表查询函数（知识库 Phase 1）。
 *
 * 知识库 = 运营方维护的标准数据（与对话记忆语义隔离）：
 *   - 独立表——对话记忆可被去重三段式 UPDATE 修正，知识库不可被对话覆盖，
 *     复用表会让去重/更新语义硬分叉
 *   - 检索形态是 `embedding BLOB` + `vec_distance_cosine` **扫表**，与 `chunks`
 *     的 vec0 `MATCH` **不是同一种检索**，不可互抄（票辛 X1：vec0 表没有列亲和性，
 *     且走的是 KNN 索引而非全表距离函数）
 *   - 阈值 maxDistance = 0.35——知识文档语义密度高、宁缺毋滥，比对话记忆检索
 *     `MEMORY_MAX_DISTANCE` 默认 0.6 更严；0.35 只是检索阈值，与去重/更新无关
 *
 * 取数逻辑原先借住在一个**以已下线的 `memories` 表命名**的 repository 模块里
 * （靠表名参数 + 白名单校验服务本表）。那个模块已于 2026-09-14 拆解，查询体
 * **内联到本文件**，用自己的 db 句柄。
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export interface KnowledgeSearchResult {
  id: string
  content: string
  /** 来源标注（文档名/URL）——即 `knowledge.source` 列 */
  source: string
  created_at: string
  distance: number
}

/**
 * 按余弦距离搜索知识库 top-K 条目。
 * maxDistance 默认 0.35（知识库检索阈值，见文件头注释）。
 *
 * maxDistance 为距离下限：余弦距离超过此值的行进不来。
 * 子查询包裹使 vec_distance_cosine 每行只求值一次（WHERE 中不能引用同层 SELECT 别名）。
 * 表名**硬编码 `knowledge`**——原先的「表名参数 + 入口白名单校验」在只剩一个值之后
 * 已退化为死代码，2026-09-14 整体删除。
 */
export function searchKnowledgeByVector(
  queryBlob: Buffer,
  topK: number,
  maxDistance = 0.35
): KnowledgeSearchResult[] {
  return db
    .prepare(
      `SELECT id, content, source, created_at, distance
       FROM (
         SELECT id, content, source, created_at,
                vec_distance_cosine(embedding, ?) AS distance
         FROM knowledge
         WHERE embedding IS NOT NULL
       )
       WHERE distance < ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryBlob, maxDistance, topK) as KnowledgeSearchResult[]
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

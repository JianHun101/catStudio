/**
 * chunks 切片索引表查询函数（段三主链，Decisions 34 X1–X5）。
 *
 * 定位：`chunks` 是 **MD 的派生投影**（Decisions 1），可从源文件无损重建——
 * 与 `memories`（对话原话）是**语义不同类**，故独立建表而非复用。
 *
 * 两侧分工：
 *   - **写入侧 = 扫描器**（票庚）：`upsertChunkWithIndexes`（三表同步）+ 孤儿物理删
 *   - **读侧 = 检索接线**（票辛）：本模块的检索入口 + RRF 融合 + 注入
 *
 * ⚠️ `upsertChunk` **只动 `chunks` 一张表**（票己契约，保持不变）；三表同步走
 * `upsertChunkWithIndexes` —— 前者是身份键 upsert 的裸写口，后者才是扫描器该用的写口。
 */
import type Database from 'better-sqlite3'
import type { ChunkRow } from './types.js'
import { buildFtsQuery, bigramTokenize } from './memories.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/**
 * 证据条目（G4）：真实 frontmatter 形态是 `{kind, ref}` 对象数组
 * （`kind ∈ {commit, file, exec-log, external}`，map Decisions 20）。
 *
 * 票己原写 `string[]` 太窄 ⇒ 本票按授权**最小放宽**为联合类型：
 * SQL / 存储语义**不变**（仍 `JSON.stringify` 落 JSON 文本），只是入参面变宽。
 * 保留 `string` 分支是为了兼容票己既有用例与任何纯文本证据。
 */
export type ChunkEvidence = string | { kind: string; ref: string }

export interface ChunkUpsertInput {
  docPath: string
  /** 节锚（= 票丙 `Segment.sectionAnchor`；无标题节为 `''`） */
  sectionAnchor: string
  /** `body` 的 sha256 hex——**必须与票庚扫描器同算法**，否则唯一键失效 */
  contentHash: string
  /** 扫描时该 MD 的 git blob SHA（`git hash-object <path>`） */
  originId: string
  type?: string | null
  status?: string | null
  date?: string | null
  /** JSON 数组入参，落库为 JSON 文本（X2-a） */
  evidence?: ChunkEvidence[] | null
  supersedes?: string | null
  supersededBy?: string | null
  validFrom?: string | null
  validTo?: string | null
  partIndex: number
  partTotal: number
  /** 该片由 L3-f 字符硬切产生（默认 0 = 非硬切） */
  hardCut?: number
  body: string
  /** `相对路径 > H1 > H2 > H3` */
  breadcrumb: string
}

/**
 * 写一片（身份键相同则覆盖）——「同一片重复写两次表内仍 1 行」。
 *
 * 身份键 = `(doc_path, section_anchor, content_hash)`（唯一索引 `idx_chunks_identity`）：
 * `ON CONFLICT` 命中时**保留原 `id`**、只更新搬运列（元数据 + 片序号 + 正文）——
 * id 稳定是 `chunk_vectors.chunk_id` 不悬空的前提（重扫不得让向量行孤儿化）。
 *
 * `content_hash` 变了 ⇒ 身份键变了 ⇒ **新行**（旧行是否删由扫描器的孤儿物理删负责，
 * 见 Q5 S4）——本函数不做任何删除。
 *
 * @returns `chunks.id`（供调用方写 `chunk_vectors` 用；写 vec0 时 **PK 须传 BigInt**，
 *          见 `db/index.ts` 该表建表注释里的绑定地雷）
 */
export function upsertChunk(input: ChunkUpsertInput): number {
  const row = db
    .prepare(
      `INSERT INTO chunks (
         doc_path, section_anchor, content_hash, origin_id,
         type, status, date, evidence, supersedes, superseded_by, valid_from, valid_to,
         part_index, part_total, hard_cut, body, breadcrumb
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_path, section_anchor, content_hash) DO UPDATE SET
         origin_id     = excluded.origin_id,
         type          = excluded.type,
         status        = excluded.status,
         date          = excluded.date,
         evidence      = excluded.evidence,
         supersedes    = excluded.supersedes,
         superseded_by = excluded.superseded_by,
         valid_from    = excluded.valid_from,
         valid_to      = excluded.valid_to,
         part_index    = excluded.part_index,
         part_total    = excluded.part_total,
         hard_cut      = excluded.hard_cut,
         body          = excluded.body,
         breadcrumb    = excluded.breadcrumb
       RETURNING id`
    )
    .get(
      input.docPath,
      input.sectionAnchor,
      input.contentHash,
      input.originId,
      input.type ?? null,
      input.status ?? null,
      input.date ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.supersedes ?? null,
      input.supersededBy ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.partIndex,
      input.partTotal,
      input.hardCut ?? 0,
      input.body,
      input.breadcrumb
    ) as { id: number }
  return row.id
}

/**
 * **扫描器的唯一写口**：写一片 + 同步两张派生表（`chunks_fts` / `chunk_vectors`）。
 *
 * 与 `upsertChunk` 的分工：后者是身份键 upsert 的裸写口（只动 `chunks`），本函数在
 * 其上补齐两处同步——三表齐写才是「一片已入库」的完整语义（写半截 = 该片在某个
 * 通道上永久不可见，且**静默**）。
 *
 * 三条下游契约地雷在此处落地（票庚 ⑧，全部实测取证）：
 *   - **G1**：`chunks_fts.content` 存 **bigram 预分词串**（`body + ' ' + breadcrumb`），
 *     与查询侧 `buildFtsQuery` 对称。照原文写 ⇒ MATCH 恒空且不报错。
 *   - **G2**：FTS 行 `rowid` = `chunks.rowid`（读侧 `JOIN chunks c ON c.rowid = f.rowid`）。
 *     先删后插——内容变了必须整行重建，否则残留旧 bigram。
 *   - **G3**：vec0 主键必须传 `BigInt`（`db/index.ts` 建表注释：better-sqlite3 把 JS
 *     number 一律绑成 REAL，vec0 无列亲和性 ⇒ 直接抛「Only integers are allows for
 *     primary key values」）。删除侧同样传 BigInt，理由相同。
 *
 * 三张表包在**一个事务**里：任一步失败 ⇒ 整片回滚，不留半截行。
 *
 * `embeddingBlob` 是 **512 维 float32 的裸字节**（`memory/index.ts` 的 `vectorToBlob`）；
 * 类型上不给 `null` —— 嵌入不可用时调用方（扫描器）**整件不写**，而不是写一片没向量的行。
 */
export function upsertChunkWithIndexes(
  input: ChunkUpsertInput,
  embeddingBlob: Buffer
): { id: number; created: boolean } {
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id FROM chunks
         WHERE doc_path = ? AND section_anchor = ? AND content_hash = ?`
      )
      .get(input.docPath, input.sectionAnchor, input.contentHash) as { id: number } | undefined

    const id = upsertChunk(input)
    syncChunkFts(id, input.body, input.breadcrumb)
    syncChunkVector(id, embeddingBlob)
    return { id, created: !existing }
  })()
}

/** 库内出现过的全部 `doc_path`（供扫描器算「本次未产出 ⇒ 孤儿」的差集） */
export function listChunkDocPaths(): string[] {
  return (
    db.prepare('SELECT DISTINCT doc_path FROM chunks ORDER BY doc_path').all() as Array<{
      doc_path: string
    }>
  ).map((r) => r.doc_path)
}

/**
 * 物理删：给定 `doc_path` 的**全部**切片行，**三表齐删**（G5）。
 *
 * 为什么三张表一起删：`chunks` 行没了而 `chunks_fts` / `chunk_vectors` 行还在 ⇒
 * FTS 僵尸行参与 MATCH、向量行参与 KNN，两者都靠 JOIN `chunks` 才拿得到原文 ⇒
 * 表现为「召回数比实际少」的静默劣化。删干净是唯一不留后患的形态。
 *
 * @returns 实际删掉的 `chunks` 行数
 */
export function deleteChunksByDocPaths(paths: string[]): number {
  if (paths.length === 0) return 0
  return db.transaction(() => {
    const placeholders = paths.map(() => '?').join(',')
    const ids = (
      db
        .prepare(`SELECT id FROM chunks WHERE doc_path IN (${placeholders})`)
        .all(...paths) as Array<{ id: number }>
    ).map((r) => r.id)
    return deleteChunkRowsByIds(ids)
  })()
}

/**
 * 物理删：**同路径的陈旧代**——该 `doc_path` 下 `origin_id` 不等于本次扫描
 * `originId` 的行。
 *
 * 动机（票庚 ⑥ 的落地面）：源文件被改动后，变更节的 `content_hash` 变了 ⇒ 身份键
 * 变了 ⇒ upsert **新增**行，而旧行还在（`doc_path` 仍在白名单内，按「doc_path 差集」
 * 算不出它是孤儿）。不删则旧正文永久留在库里、并被检索召回。`origin_id` 是本次扫描
 * 刚写入的「当前代」标记，故「代际 != 当前」即陈旧。
 *
 * 必须在写完该文件的新行**之后**调用：upsert 命中已有身份键时会把这些行的
 * `origin_id` 一并刷成新值，故此刻仍持旧值的行 = 本次未再产出的节（被删 / 被改）。
 */
export function deleteStaleChunkRows(docPath: string, originId: string): number {
  return db.transaction(() => {
    const ids = (
      db
        .prepare('SELECT id FROM chunks WHERE doc_path = ? AND origin_id <> ?')
        .all(docPath, originId) as Array<{ id: number }>
    ).map((r) => r.id)
    return deleteChunkRowsByIds(ids)
  })()
}

/** G2：FTS 行整删重建（`rowid` = `chunks.rowid`） */
function syncChunkFts(rowid: number, body: string, breadcrumb: string): void {
  db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)').run(
    rowid,
    bigramTokenize(`${body} ${breadcrumb}`).join(' ')
  )
}

/** G3：vec0 主键一律 `BigInt`（写入侧与删除侧同规则） */
function syncChunkVector(chunkId: number, embeddingBlob: Buffer): void {
  const key = BigInt(chunkId)
  db.prepare('DELETE FROM chunk_vectors WHERE chunk_id = ?').run(key)
  db.prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)').run(
    key,
    embeddingBlob
  )
}

/** 三表齐删的公共尾部（调用方负责开事务） */
function deleteChunkRowsByIds(ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id IN (${placeholders})`).run(
    ...ids.map((id) => BigInt(id))
  )
  db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids)
  return ids.length
}

/**
 * 按 `origin_id`（扫描时 MD 的 blob SHA）取该源文件的全部切片行。
 *
 * **本函数不是检索入口**（故不带 X4 状态过滤）：它是扫描器增量比对用的——
 * 必须看见**全量行含 `superseded`/`deprecated`**，否则被标失效的孤儿行在扫描器
 * 眼里「不存在」，S4 的孤儿物理删会漏。过滤面只在检索入口上（X4 管的是「召回」）。
 */
export function getChunksByOrigin(originId: string): ChunkRow[] {
  return db
    .prepare(
      `SELECT id, doc_path, section_anchor, content_hash, origin_id,
              type, status, date, evidence, supersedes, superseded_by, valid_from, valid_to,
              part_index, part_total, hard_cut, body, breadcrumb
       FROM chunks
       WHERE origin_id = ?
       ORDER BY doc_path, part_index`
    )
    .all(originId) as ChunkRow[]
}

/** 向量通道检索结果 = 整行 + 余弦距离 */
export interface ChunkVectorSearchResult extends ChunkRow {
  distance: number
}

/**
 * 向量通道：`chunk_vectors`（vec0）KNN → JOIN `chunks` 取原文。
 *
 * ⚠️ 候选池 = KNN 内层 `LIMIT topK`（**先近邻截断、后状态过滤**）⇒ 若最近的 topK
 * 片恰好全被标失效，本函数返回空而不是「顺延取更远的片」。这是刻意的形态对齐
 * （`searchMemoriesByVector` 同为「先召回后过滤」），非缺陷——但接线侧（票辛）
 * 的降级三态（W3）不能把这种空当成「嵌入失败」。
 *
 * maxDistance 为距离下限（余弦距离 ≥ 此值不召回），与 memories 侧同口径。
 */
export function searchChunksByVector(
  queryBlob: Buffer,
  topK: number,
  maxDistance: number
): ChunkVectorSearchResult[] {
  return db
    .prepare(
      `SELECT c.id, c.doc_path, c.section_anchor, c.content_hash, c.origin_id,
              c.type, c.status, c.date, c.evidence, c.supersedes, c.superseded_by,
              c.valid_from, c.valid_to, c.part_index, c.part_total, c.hard_cut,
              c.body, c.breadcrumb, v.distance AS distance
       FROM (
         SELECT chunk_id, distance
         FROM chunk_vectors
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?
       ) v
       JOIN chunks c ON c.id = v.chunk_id
       WHERE (c.status IS NULL OR c.status NOT IN ('superseded','deprecated'))
         AND v.distance < ?
       ORDER BY v.distance`
    )
    .all(queryBlob, topK, maxDistance) as ChunkVectorSearchResult[]
}

/** 关键词通道检索结果（FTS 表 content 列存的是 bigram 预分词串，不可直接输出 ⇒ JOIN 取原文） */
export interface ChunkKeywordSearchResult {
  id: number
  doc_path: string
  section_anchor: string
  body: string
  breadcrumb: string
}

/**
 * 关键词通道：bigram 查询词 MATCH + bm25 排序。
 *
 * 分词**复用 `memories.ts` 的 `bigramTokenize`/`buildFtsQuery`**（不另发明）——
 * 与 `memories_fts` 同一套切分，两侧对称是 MATCH 能命中的前提。
 * 无可用查询词 → 空结果（调用方降级纯向量）；FTS 表缺失（老库/手搓 schema）同样
 * 静默降级，其他 SQL 错误照抛（不掩盖真实问题）。
 */
export function searchChunksByKeyword(query: string, topN: number): ChunkKeywordSearchResult[] {
  const matchExpr = buildFtsQuery(query)
  if (!matchExpr) return []
  try {
    return db
      .prepare(
        `SELECT c.id, c.doc_path, c.section_anchor, c.body, c.breadcrumb
         FROM chunks_fts f
         JOIN chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ?
           AND (c.status IS NULL OR c.status NOT IN ('superseded','deprecated'))
         ORDER BY bm25(chunks_fts)
         LIMIT ?`
      )
      .all(matchExpr, topN) as ChunkKeywordSearchResult[]
  } catch (err: any) {
    if (err?.message && err.message.includes('no such table: chunks_fts')) return []
    throw err
  }
}

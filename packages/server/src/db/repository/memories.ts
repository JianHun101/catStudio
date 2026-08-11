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

// ─── FTS5 关键词通道（混合检索）─────────────────────

/**
 * bigram 分词：相邻两字符为一组（"猫咖测试" → "猫咖"/"咖测"/"测试"，
 * 英文数字同样按字符切："abc" → "ab"/"bc"）。
 *
 * 与 FTS 表同步策略：插入端全文切分存储（ftsContent 空格 join），
 * 查询端同样切分 → 两端对称，FTS unicode61 按空格分隔的预分词串切 token，
 * 每个 bigram 独立成 token，无需中文分词器依赖。
 *
 * 孤立代理（emoji 等增补平面字符的半截码元）片段跳过——写入 SQLite 会抛
 * invalid utf-8；查询端同规则切分，跳过不影响两端匹配对称性。
 */
export function bigramTokenize(text: string): string[] {
  const tokens: string[] = []
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.slice(i, i + 2)
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bigram)) {
      continue
    }
    tokens.push(bigram)
  }
  return tokens
}

/** 查询端停用词（bigram 粒度）：中文高频虚词/代词/连词。宁缺毋滥——只去纯虚词，
 * 有检索信息量的实词（如"问题"）不在此列；过滤只发生在查询端，存储与注入内容永不变 */
const KEYWORD_STOPWORDS = new Set([
  '什么',
  '怎么',
  '为什',
  '如何',
  '哪个',
  '哪些',
  '我们',
  '你们',
  '他们',
  '咱们',
  '自己',
  '这个',
  '那个',
  '这里',
  '那里',
  '这些',
  '那些',
  '这样',
  '那样',
  '的了',
  '的呢',
  '是吧',
  '因为',
  '所以',
  '虽然',
  '但是',
  '然后',
  '还是',
  '或者',
  '只是',
  '就是',
  '不是',
  '都是',
  '也是',
  '还有',
  '如果',
  '而且',
  '不过',
  '以及',
  '一下',
  '一样',
  '已经',
  '正在',
  '现在',
])

/** FTS5 MATCH 表达式特殊字符——含这些字符的 bigram 跳过（短语引号内仍会被解析器误解） */
const FTS_SPECIAL_CHARS = /["*():^]/

/**
 * 构造 FTS5 MATCH 表达式：bigram 切分 → 去停用词/特殊字符 → 每 token 短语化
 * （引号包裹，AND 语义）。查询词不截断——只过滤不删信息。
 * 无剩余词时返回 null（调用方降级纯向量）。
 */
export function buildFtsQuery(query: string): string | null {
  const terms = bigramTokenize(query).filter(
    (t) => !KEYWORD_STOPWORDS.has(t) && !FTS_SPECIAL_CHARS.test(t)
  )
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' ')
}

/** 存储侧 bigram 预分词 + 空格 join（FTS unicode61 按空格分隔的预分词串切回，两侧对称） */
function ftsContent(content: string): string {
  return bigramTokenize(content).join(' ')
}

/**
 * FTS 表同步（容错）：测试 :memory: schema 与极端老库可能无 memories_fts 表，
 * 此时静默降级（记忆存储照常，检索走纯向量）；其他 SQL 错误照抛，不掩盖真实问题。
 */
function syncFts(sql: string, ...params: unknown[]): void {
  try {
    db.prepare(sql).run(...params)
  } catch (err: any) {
    if (err?.message && err.message.includes('no such table: memories_fts')) return
    throw err
  }
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
  // FTS 同步需 rowid：先查后更（内容更新会改变 bigram 预分词串，FTS 行整删重建）
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as
    { rowid: number } | undefined
  db.prepare(
    `UPDATE memories
     SET content = ?, embedding = ?, source_message_id = ?, created_at = ?
     WHERE id = ?`
  ).run(content, embeddingBlob, sourceMessageId, createdAt, id)
  if (row) {
    syncFts('DELETE FROM memories_fts WHERE rowid = ?', row.rowid)
    syncFts(
      'INSERT INTO memories_fts (rowid, content) VALUES (?, ?)',
      row.rowid,
      ftsContent(content)
    )
  }
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

// ─── 混合检索（FTS5 关键词通道 + RRF 融合）──────────────

export interface KeywordSearchResult {
  id: string
  content: string
  source_message_id: string
  created_at: string
}

/**
 * FTS5 关键词通道检索：bigram 查询词 MATCH + bm25 排序。
 * JOIN memories 取原文（FTS 表 content 列存的是 bigram 预分词串，不可直接输出）。
 * 无可用查询词 / FTS 表缺失 → 空结果（调用方降级纯向量）。
 */
export function searchMemoriesByKeyword(query: string, topN: number): KeywordSearchResult[] {
  const matchExpr = buildFtsQuery(query)
  if (!matchExpr) return []
  try {
    return db
      .prepare(
        `SELECT m.id, m.content, m.source_message_id, m.created_at
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY bm25(memories_fts)
         LIMIT ?`
      )
      .all(matchExpr, topN) as KeywordSearchResult[]
  } catch (err: any) {
    if (err?.message && err.message.includes('no such table: memories_fts')) return []
    throw err
  }
}

/** 混合检索两通道各自召回数量（店长派活单建议值） */
const HYBRID_CHANNEL_TOP_N = 20
/** RRF 融合常数 k（店长派活单拍板值，控制排名分衰减速度） */
const RRF_K = 60

/**
 * 混合检索：向量通道 + FTS5 关键词通道各取 topN → RRF 融合（k=60）→ 排序取 topK。
 *
 * - 两通道都命中的 id：RRF 分相加，distance 取向量通道真值
 * - 纯关键词命中：distance 填 maxDistance（语义：超出向量通道召回边界、
 *   由关键词通道救回——向量通道 topN 截断也会漏，此处是边界值而非伪造距离）
 * - 通道容错：关键词通道空结果/表缺失 → 结果即纯向量 topK（含距离真值）
 */
export function searchMemoriesHybrid(
  embeddingBlob: Buffer,
  query: string,
  topK: number,
  maxDistance: number
): MemorySearchResult[] {
  const vectorHits = searchMemoriesByVector(embeddingBlob, HYBRID_CHANNEL_TOP_N, maxDistance)
  const keywordHits = searchMemoriesByKeyword(query, HYBRID_CHANNEL_TOP_N)

  type Scored = { score: number; row: MemorySearchResult }
  const scores = new Map<string, Scored>()
  vectorHits.forEach((row, i) => {
    scores.set(row.id, { score: 1 / (RRF_K + i + 1), row })
  })
  keywordHits.forEach((hit, i) => {
    const kwScore = 1 / (RRF_K + i + 1)
    const existing = scores.get(hit.id)
    if (existing) {
      existing.score += kwScore
    } else {
      scores.set(hit.id, { score: kwScore, row: { ...hit, distance: maxDistance } })
    }
  })

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.row)
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
  // lastInsertRowid 即 memories.rowid → 同步写 FTS 行（rowid 对齐，检索 JOIN 用）
  const info = db
    .prepare(
      `INSERT INTO memories (id, agent_id, content, embedding, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, agentId, content, embeddingBlob, sourceMessageId, createdAt)
  syncFts(
    'INSERT INTO memories_fts (rowid, content) VALUES (?, ?)',
    Number(info.lastInsertRowid),
    ftsContent(content)
  )
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
      const info = insert.run(
        item.id,
        item.agentId,
        item.content,
        item.embeddingBlob,
        item.sourceMessageId,
        item.createdAt
      )
      syncFts(
        'INSERT INTO memories_fts (rowid, content) VALUES (?, ?)',
        Number(info.lastInsertRowid),
        ftsContent(item.content)
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
  // FTS 同步需先取待删行的 rowid（删除后无法反查）
  const rows = db.prepare('SELECT rowid FROM memories WHERE agent_id = ?').all(agentId) as Array<{
    rowid: number
  }>
  db.prepare('DELETE FROM memories WHERE agent_id = ?').run(agentId)
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ')
    syncFts(
      `DELETE FROM memories_fts WHERE rowid IN (${placeholders})`,
      ...rows.map((r) => r.rowid)
    )
  }
}

/** 清空全部记忆（用于 --reset 流程，必须在删 agents 之前调用，否则 FK violation）。 */
export function deleteAllMemories(): void {
  db.prepare('DELETE FROM memories').run()
  // 独立 FTS 表支持整表 DELETE（external content 表才需特殊 'delete-all' 命令）
  syncFts('DELETE FROM memories_fts')
}

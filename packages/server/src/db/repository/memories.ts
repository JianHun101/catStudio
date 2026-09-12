/**
 * 检索链的**共享底座**（bigram 分词 + 参数化向量查询体）。
 *
 * ⚠️ 本模块的历史名字来自 `memories` 表（对话原话向量记忆）——该表已随段三
 * 检索接线**下线**（票辛 ⑥：`memories` / `memories_fts` 双 DROP，见 `db/index.ts`
 * 迁移）。留下的两样东西都与那张表**无关**：
 *
 *   1. **bigram 分词 + FTS5 MATCH 表达式构造**——`chunks_fts` 侧切分的唯一实现
 *      （`chunks.ts` 直接 import，不另发明一份；两侧对称是 MATCH 能命中的前提）
 *   2. **`searchMemoriesByVector` 的参数化查询体**——仍服务 `knowledge` 表
 *      （知识库 Phase 1 的 `embedding BLOB` + `vec_distance_cosine` 扫表形态）。
 *      它与 `chunks` 的 vec0 `MATCH` 检索是**两种形态**，不可互抄：
 *      vec0 表没有列亲和性，且走的是 KNN 索引而非全表距离函数。
 *
 * 写口在别处：索引写入 = 飞轮扫描器（`scripts/flywheel/scan.mjs` → `chunks.ts`）；
 * 对话原话**不再入库**（票壬 旧写口退役）。本模块只读 + 纯函数。
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── FTS5 关键词通道（chunks_fts 的切分底座）─────────

/**
 * bigram 分词：相邻两字符为一组（"猫咖测试" → "猫咖"/"咖测"/"测试"，
 * 英文数字同样按字符切："abc" → "ab"/"bc"）。
 *
 * 与 FTS 表同步策略：写入端全文切分存储（空格 join，见 `chunks.ts` 的
 * `syncChunkFts`），查询端同样切分 → 两端对称，FTS unicode61 按空格分隔的
 * 预分词串切 token，每个 bigram 独立成 token，无需中文分词器依赖。
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

// ─── 混合检索的融合参数（两条链共用一份）───────────────

/** 混合检索两通道各自召回数量（chunks 侧与 memories 侧同值，避免两处漂移） */
export const HYBRID_CHANNEL_TOP_N = 20
/** RRF 融合常数 k（控制排名分衰减速度） */
export const RRF_K = 60

// ─── 向量检索（knowledge 表）───────────────────────────

export interface MemorySearchResult {
  id: string
  content: string
  source_message_id: string
  created_at: string
  distance: number
}

/**
 * 按余弦距离搜索最相关的 top-K 行。
 *
 * maxDistance 为距离下限：余弦距离超过此值的行不召回。
 * 子查询包裹使 vec_distance_cosine 每行只求值一次（WHERE 中不能引用同层 SELECT 别名）。
 *
 * table 参数（知识库 Phase 1）：入口白名单校验（非白名单抛 TypeError），
 * 参数来源永不放宽到外部输入。`knowledge` 表无 `source_message_id` 列，其
 * `source` 列经 `source AS source_message_id` 统一映射为「来源标注」载体。
 *
 * ⚠️ `memories` 已不在白名单：该表随票辛 ⑥ 下线，留着会让默认参数变成
 * 「调到就 no such table」的隐形地雷。白名单是安全边界，参数化表名只认这里列出的。
 */
const SEARCHABLE_TABLES = new Set(['knowledge'])

export function searchMemoriesByVector(
  queryBlob: Buffer,
  topK: number,
  maxDistance: number,
  table: 'knowledge' = 'knowledge'
): MemorySearchResult[] {
  if (!SEARCHABLE_TABLES.has(table)) {
    throw new TypeError(`searchMemoriesByVector: 不支持的检索表 ${table}（仅 knowledge）`)
  }
  // knowledge 无 source_message_id 列，内层把 source 映射为 source_message_id
  // 输出列名（外层只能引用子查询输出列名，若外层再写 source 会 no such column）
  return db
    .prepare(
      `SELECT id, content, source_message_id, created_at, distance
       FROM (
         SELECT id, content, source AS source_message_id, created_at,
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

/**
 * FTS5 关键词通道底座——bigram 分词 + MATCH 表达式构造。
 *
 * 定位：`chunks_fts` 的**写入侧切分**与**查询侧构造**共用同一份实现
 * （`chunks.ts` 的 `syncChunkFts` 与 `searchChunksByKeyword` 直接 import，
 * 不另发明一份）——两侧对称是 MATCH 能命中的前提。
 *
 * **纯函数，无 db 依赖**：本模块不持 db 句柄、不参与 `repository/index.ts` 接线。
 *
 * 名字来源：这些函数原先住在 repository 层一个**以已下线的 `memories` 表命名**的
 * 共享底座模块里，但它们从一开始就与那张表无关。该模块已于 2026-09-14 拆解
 * （两个融合常量归 `chunks.ts`、向量查询体内联进 `knowledge.ts`），FTS 四件套
 * 独立成此文件。
 */

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

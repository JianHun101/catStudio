/**
 * FTS5 关键词通道底座 —— 分词 + MATCH 表达式构造（**分词器 v2**）。
 *
 * 定位：`chunks_fts` 的**写入侧切分**与**查询侧构造**共用同一份实现
 * （`chunks.ts` 的 `syncChunkFts` 与 `searchChunksByKeyword` 直接 import，
 * 不另发明一份）——两侧对称是 MATCH 能命中的前提。
 *
 * **纯函数，无 db 依赖**：本模块不持 db 句柄、不参与 `repository/index.ts` 接线。
 *
 * ## v2 改了什么（2026-11-12）
 *
 * **v1（bigram 一刀切）的两个病灶**，都是「查询串在库里根本对不上」的整通道失效：
 *
 * 1. **英文/标识符按单字符切**：`retrieval_events` 切成 `re/et/tr/…`，索引侧同样是这些
 *    碎片——看似对称，实则每个碎片都短到没有区分度，BM25 排序被噪声淹没。
 * 2. **查询用 AND 连接**：要求所有 bigram 同时出现在**同一片**里才能命中。实测
 *    dev 库 4,010/4,025 条查询的关键词通道 **0 行**——一个生僻 bigram 就把整条查询
 *    的关键词通道打死（报告 §4.1 的归因即此）。
 *
 * v2 三条规则：
 * - **中文仍按相邻两字成组**（bigram）：`猫咖测试` → `猫咖`/`咖测`/`测试`。中文二元组
 *   是零分词器依赖下最稳的召回面，实测换 jieba 一类分词器在 OR 下也救不回 AND。
 * - **ASCII 标识符整词保留，并按 camelCase 再切子词**：`getChunksByOrigin` →
 *   `get chunks by origin`、`AGENT_HARD_TIMEOUT_MS` → `agent hard timeout ms`。
 *   非字母数字字符（`_ - . /` 等）一律作分隔符，**单个 ASCII 字母丢弃**（`a*b` → 无词项）。
 * - **查询用 OR 连接**：任一词项命中即可进候选池，由 BM25 排序说话。
 *
 * 名字来源：这些函数原先住在 repository 层一个**以已下线的 `memories` 表命名**的
 * 共享底座模块里，但它们从一开始就与那张表无关。该模块已于 2026-09-14 拆解
 * （两个融合常量归 `chunks.ts`、向量查询体内联进 `knowledge.ts`），FTS 四件套
 * 独立成此文件。
 */

/** 中文（CJK 统一表意文字）判定：基本区 + 扩展 A + 兼容区。单码元，代理对不命中 */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/

/** ASCII 字母数字（标识符词内字符）——其余一律作分隔符 */
const ASCII_WORD_RE = /[A-Za-z0-9]/

/**
 * 分词器版本号 —— **`chunks_fts` 存量内容的切分口径**。索引侧与查询侧共用同一份实现，
 * 两侧版本必须同源；迁移条目 `chunks_fts rebuild` 按它重算存量（扫描器按 `origin_id`
 * 增量比对，内容没变的文档会被跳过，不重建就永远停在旧切分）。
 */
export const FTS_TOKENIZER_VERSION = 2

/**
 * 单条查询的词项上限。OR 语义下词项越多候选池越宽，但 **BM25 选人、`LIMIT` 截池**——
 * 上限只防病态长查询（把整段 prompt 当查询词）撑爆 MATCH 解析，正常查询远达不到。
 */
export const FTS_QUERY_MAX_TERMS = 64

/**
 * camelCase 切分：只在「小写/数字 → 大写」边界切。全大写缩写（`AGENT` / `MS`）不切——
 * 否则会被拆成单字母再被丢弃，等于把标识符整个抹掉。
 */
function splitCamel(word: string): string[] {
  return word.split(/(?<=[a-z0-9])(?=[A-Z])/)
}

/**
 * 分词：中文二元组 + ASCII 整词（camelCase 子词化，单个字母丢弃，全小写）。
 *
 * 写入侧与查询侧共用本函数（两侧对称是 MATCH 能命中的前提）：
 * - 写入侧 `chunks_fts.content = ftsTokenize(body + ' ' + breadcrumb).join(' ')`，
 *   **不去重、不过滤停用词**（BM25 的 tf 要保留）；
 * - 查询侧 `buildFtsQuery` 再做停用词/去重/截断。
 *
 * emoji 等增补平面字符（代理对）既非 CJK 也非 ASCII ⇒ 作分隔符跳过，不产生脏 token。
 */
export function ftsTokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (CJK_RE.test(ch)) {
      // 连续中文段 → 相邻两字成组
      let j = i
      while (j < text.length && CJK_RE.test(text[j])) j++
      const segment = text.slice(i, j)
      for (let k = 0; k + 1 < segment.length; k++) tokens.push(segment.slice(k, k + 2))
      i = j
      continue
    }
    if (ASCII_WORD_RE.test(ch)) {
      // 连续 ASCII 字母数字段 → 按 camelCase 切子词、小写、单字母丢弃
      let j = i
      while (j < text.length && ASCII_WORD_RE.test(text[j])) j++
      for (const part of splitCamel(text.slice(i, j))) {
        const token = part.toLowerCase()
        if (token.length === 1 && /[a-z]/.test(token)) continue
        tokens.push(token)
      }
      i = j
      continue
    }
    // 其余（标点、空白、emoji 代理对）作分隔符
    i += 1
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

/** FTS5 MATCH 表达式特殊字符——分词器 v2 的产出不含它们；保留过滤作防御（断言无脏词项） */
const FTS_SPECIAL_CHARS = /["*():^]/

/**
 * 构造 FTS5 MATCH 表达式：分词 → 去停用词/特殊字符 → 去重 → 截 64 → 每词项短语化
 * （引号包裹，**OR 语义**）。无剩余词时返回 null（调用方降级纯向量）。
 *
 * 为什么是 OR 而不是 AND：AND 要求所有词项落在**同一片**里，实测 dev 库 4,010/4,025
 * 条查询的关键词通道 0 行——一个生僻 bigram 就打死整条查询。OR 让任一词项进候选池，
 * 由 BM25 排序与「MATCH 选人、`LIMIT 20` 截池」做取舍（筛人逻辑不动）。
 */
export function buildFtsQuery(query: string): string | null {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const term of ftsTokenize(query)) {
    if (KEYWORD_STOPWORDS.has(term)) continue
    if (FTS_SPECIAL_CHARS.test(term)) continue
    if (seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length >= FTS_QUERY_MAX_TERMS) break
  }
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' OR ')
}

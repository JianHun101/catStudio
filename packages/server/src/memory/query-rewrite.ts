/**
 * 记忆查询改写 — 仅用于检索阶段。
 *
 * 把用户原话改写为 1~3 条更利于向量召回的独立查询（指代消解、意图展开、
 * 复合意图拆分），与原话构成双通道检索。改写结果只用于生成查询向量，
 * 注入给猫的记忆内容始终是存储原文——改写不参与、不改变猫看到的记忆。
 *
 * 降级路径: LLM 调用失败 / 超时 / 未配置 DS_KEY / 功能关闭 → 返回 []，
 * 调用方退化为仅原话检索，不阻塞消息流。
 *
 * 缓存: 同一文本 60 秒内复用改写结果——同一条用户消息被多只猫 @ 时，
 * 整个 dispatch 周期只做一次改写调用。
 *
 * 环境变量:
 *   MEMORY_QUERY_REWRITE_ENABLED   — '0' 关闭（默认 '1'）
 *   MEMORY_QUERY_REWRITE_MODEL     — 改写模型（默认 deepseek-v4-flash，与摘要同档便宜模型）
 *   MEMORY_QUERY_REWRITE_TIMEOUT_MS— 改写调用超时（默认 5000）
 */

import { chatComplete } from '../llm/complete.js'
import { createLogger } from '../logger.js'

const log = createLogger('memory:rewrite')

const REWRITE_CACHE_TTL_MS = 60_000
const REWRITE_CACHE_MAX = 200
const REWRITE_MAX_QUERIES = 3
const REWRITE_MAX_LINE_LEN = 200

const REWRITE_SYSTEM_PROMPT = `你是记忆检索查询改写助手。用户的消息会被用于向量检索历史记忆。
请把用户原话改写成 1~3 条更利于检索的独立查询：
- 保留原意，不要编造不存在的信息
- 指代消解：把"它/这家/上次/那个"等指代词替换为具体所指
- 意图展开：把隐含的检索意图说清楚
- 复合意图拆成多条独立查询
只输出查询文本，每行一条，不要编号、不要引号、不要解释。`

/** 改写缓存: 文本 → { 改写结果, 过期时间 } */
const rewriteCache = new Map<string, { queries: string[]; expiresAt: number }>()

/** 查询改写是否启用 */
export function isQueryRewriteEnabled(): boolean {
  return process.env.MEMORY_QUERY_REWRITE_ENABLED !== '0'
}

/** 清空改写缓存（测试用；生产环境无需调用） */
export function clearRewriteCache(): void {
  rewriteCache.clear()
}

/** 解析 LLM 输出: 逐行清理（编号/bullet/包裹引号），去重，剔除与原话相同的行 */
function parseRewriteLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\d+[.、)]\s*/, '') // 去掉 "1." "1、" "1)" 编号
        .replace(/^\s*[-*•]\s*/, '') // 去掉 bullet
        .replace(/^["'「『]/, '')
        .replace(/["'」』]+$/, '') // 去掉包裹引号
        .trim()
    )
    .filter((line) => line.length > 0 && line.length <= REWRITE_MAX_LINE_LEN)
}

/**
 * 将用户原话改写为 1~3 条检索查询。
 * 失败时返回 []，调用方应降级为仅原话检索。
 */
export async function rewriteRetrievalQueries(original: string): Promise<string[]> {
  if (!isQueryRewriteEnabled()) return []

  const cached = rewriteCache.get(original)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.queries
  }

  const apiKey = process.env.DS_KEY || ''
  if (!apiKey) {
    log.debug('未配置 DS_KEY，跳过查询改写')
    return []
  }

  try {
    const model = process.env.MEMORY_QUERY_REWRITE_MODEL || 'deepseek-v4-flash'
    const timeoutMs = parseInt(process.env.MEMORY_QUERY_REWRITE_TIMEOUT_MS || '5000', 10)
    const raw = await chatComplete(REWRITE_SYSTEM_PROMPT, original, {
      apiKey,
      model,
      maxTokens: 150,
      temperature: 0.3,
      timeoutMs,
    })

    const queries = [...new Set(parseRewriteLines(raw))]
      .filter((q) => q !== original)
      .slice(0, REWRITE_MAX_QUERIES)

    if (queries.length > 0) {
      if (rewriteCache.size >= REWRITE_CACHE_MAX) {
        rewriteCache.clear()
      }
      rewriteCache.set(original, {
        queries,
        expiresAt: Date.now() + REWRITE_CACHE_TTL_MS,
      })
    }
    return queries
  } catch (err: any) {
    log.warn('查询改写失败，降级为仅原话检索', { error: err.message })
    return []
  }
}

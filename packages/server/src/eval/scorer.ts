/**
 * G-Eval 评分器（W2 L2 评估子系统）。
 *
 * 契约要点：
 * - 按 session_id 拉被评回复**前置最近 10 条**拼 G-Eval 三件套（任务+上下文+回复），
 *   不做单条裸打分——上下文缺失时模型无法判断忠实度/完整性
 * - 准则分解：相关性 / 忠实度 / 完整性 三维度
 * - CoT 推理最后一步给分 + 概率加权 1-5（score_distribution 加权期望分）
 * - 长度偏见治理：准则显式"不因长度加分" + 被评回复与上下文同上限截断
 * - judge 复用 llm/registry 的 getAdapterForAgent（Kimi K3 经 deepseek 适配器走
 *   Moonshot OpenAI 兼容 HTTP 端点——K5 变更单裁定：claude adapter CLI 通道评测期
 *   连崩 2 次且不消费超时参数，换 HTTP 通道与评测稳定通道同构）
 * - 纯旁路：调用方 fire-and-forget，失败只记日志不抛
 */
import type { AgentConfig, ChatOptions } from '@cat-study/shared'
import { v4 as uuid } from 'uuid'
import { getAdapterForAgent } from '../llm/registry.js'
import { messages as messagesRepo, evalScores as evalScoresRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('eval-scorer')

/** 上下文窗口：被评回复 + 前置最近共 10 条 */
export const CONTEXT_WINDOW = 10

/** 截断上限（字符）：回复与每条上下文同一上限——长度偏见治理的硬约束 */
export const JUDGE_TRUNCATE_CHARS = 1200

/** 评分旁路超时（毫秒）：评分不阻塞主链，超时就放弃本次评分 */
const JUDGE_TIMEOUT_MS = 120_000

/**
 * Kimi K3 判官专用参数（Phase 0 实测钉死，K5 变更单契约）：
 * - temperature=1：端点强制，默认 0.7 被拒（400）
 * - maxTokens=65536：max_tokens = 思考+回答总预算，长思考吃光 2048/16384 致空响应
 * - chunkTimeoutMs=120s：深度思考停顿可超 deepseek 默认 30s（abort 致空响应的元凶）
 * - timeoutMs=240s：总超时相应放宽
 */
export const KIMI_JUDGE_OPTIONS = {
  temperature: 1,
  maxTokens: 65536,
  chunkTimeoutMs: 120_000,
  timeoutMs: 240_000,
} as const

/** 按 judge 模型分支构造 chatStream 参数：kimi 走专用参数；DS 兜底只传 model+timeoutMs 保持默认 */
export function judgeChatOptions(model: string, fallbackTimeoutMs: number): ChatOptions {
  if (model.startsWith('kimi')) {
    return { model, ...KIMI_JUDGE_OPTIONS }
  }
  return { model, timeoutMs: fallbackTimeoutMs }
}

export interface JudgeOutput {
  score: number
  /** 概率分布 {1..5} 的加权期望分（契约：概率加权 1-5） */
  distribution: Record<string, number> | null
  dimensions: { relevance: number; faithfulness: number; completeness: number } | null
  raw: string
}

/**
 * 解析 judge 输出。容错三层：JSON 块 → 正则补抽 score_distribution →
 * 正则补抽 score。全失败返回 null（调用方不落库，log.warn 留痕）。
 */
export function parseJudgeOutput(text: string): JudgeOutput | null {
  const raw = text.trim()
  if (!raw) return null

  let parsed: any = null
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    parsed = parseJsonWithFenceTolerance(jsonMatch[0])
  }

  const distribution = normalizeDistribution(parsed?.score_distribution)
  // score 是数字即采用（越界 clamp 到 1-5，不因格式漂移丢弃整条评分）
  const scoreFromJson = typeof parsed?.score === 'number' ? parsed.score : null
  const dimensions = normalizeDimensions(parsed?.dimensions)

  let finalScore: number | null = scoreFromJson
  if (distribution) {
    // 概率加权优先：契约指定加权期望分
    finalScore = weightedScore(distribution)
  } else if (finalScore === null) {
    // 正则兜底：裸数字/键值（模型没按 JSON 格式输出时）
    const m = raw.match(/(?:score|评分|得分)[：:\s]*([1-5])(?:\.\d+)?/)
    if (m) finalScore = Number(m[1])
  }

  if (finalScore === null) return null
  return {
    score: clampScore(finalScore),
    distribution,
    dimensions,
    raw,
  }
}

/**
 * JSON 候选容错解析（围栏/尾注）：模型常把 JSON 包在 ```json 围栏里或尾部补说明，
 * 贪婪匹配 \{[\s\S]*\} 会把尾部围栏（```）/含 } 的尾注吞进候选 → JSON.parse 失败。
 * 三级容错：剥尾部围栏再 parse → 逐 } 回溯（错位 } 候选失败后回退到真正收尾）。
 */
function parseJsonWithFenceTolerance(candidate: string): any | null {
  const tryParse = (s: string): any | null => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  // 剥尾部围栏（```json / ``` / 反引号）——贪婪匹配吞围栏的常见形态
  const cleaned = candidate.replace(/\s*```{1,3}[a-z]*\s*$/i, '').trim()
  let parsed = tryParse(cleaned)
  if (parsed) return parsed

  // 逐 } 回溯：字符串值内 }/尾注 } 被贪婪吞进时，错位 } 候选 parse 失败，回退到真正的 JSON 收尾
  let idx = cleaned.lastIndexOf('}')
  while (idx > 0) {
    parsed = tryParse(cleaned.slice(0, idx + 1))
    if (parsed) return parsed
    idx = cleaned.lastIndexOf('}', idx - 1)
  }
  return null
}

/** 概率分布 → 加权期望分（Σ p_i × i），分布和为 0 时返回 null */
export function weightedScore(distribution: Record<string, number>): number | null {
  const entries = Object.entries(distribution)
  if (entries.length === 0) return null
  let total = 0
  let weightSum = 0
  for (const [k, v] of entries) {
    const score = Number(k)
    if (Number.isNaN(score) || score < 1 || score > 5 || !Number.isFinite(v) || v < 0) continue
    total += score * v
    weightSum += v
  }
  if (weightSum <= 0) return null
  return total / weightSum
}

/** 解析 1-5 概率分布对象（容错：值可能是字符串、分布可能缺档） */
function normalizeDistribution(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object') return null
  const dist: Record<string, number> = {}
  for (const [k, v] of Object.entries(value)) {
    const n = Number(v)
    if (!Number.isNaN(n) && n >= 0) dist[k] = n
  }
  return Object.keys(dist).length > 0 ? dist : null
}

function normalizeDimensions(value: unknown): JudgeOutput['dimensions'] {
  if (!value || typeof value !== 'object') return null
  const num = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null
  }
  const relevance = num((value as any).relevance)
  const faithfulness = num((value as any).faithfulness)
  const completeness = num((value as any).completeness)
  if (relevance === null || faithfulness === null || completeness === null) return null
  return { relevance, faithfulness, completeness }
}

function clampScore(s: number): number {
  return Math.min(5, Math.max(1, s))
}

/** 长度偏见治理：同一上限截断（回复与上下文一致） */
export function truncateForJudge(text: string, maxChars: number = JUDGE_TRUNCATE_CHARS): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n…[已截断]'
}

/** 拉被评回复前置最近共 CONTEXT_WINDOW 条消息（含被评回复本身），时间正序 */
export function collectContextRows(
  rows: Array<{ id: string; role: string; agent_id: string | null; content: string }>,
  targetMessageId: string
): Array<{ role: string; agent_id: string | null; content: string }> {
  const idx = rows.findIndex((r) => r.id === targetMessageId)
  if (idx === -1) return []
  // rows 是倒序（created_at DESC，最新在前）——目标之后的元素即其前置（更早）消息。
  // 取 [idx, idx+WINDOW) = 目标 + 前置最近 N-1 条，再反转为时间正序
  const window = rows.slice(idx, Math.min(rows.length, idx + CONTEXT_WINDOW))
  return window.reverse() // 时间正序，被评回复在最后
}

/** G-Eval 三件套 prompt：任务（评分准则）+ 上下文（前置消息）+ 被评回复 */
export function buildGEvalPrompt(
  contextLines: Array<{ role: string; agent_id: string | null; content: string }>,
  replyContent: string,
  agentName: string
): string {
  const criteria = `
评分准则（分解为三个维度，各 1-5 分）：
1. 相关性（relevance）：回复是否针对上下文中的问题/请求，不跑题、不答非所问。
2. 忠实度（faithfulness）：回复是否忠实于给定上下文，不编造上下文没有的信息。
3. 完整性（completeness）：回复是否覆盖问题要点，需要时给出可执行步骤或结论。

评分要求：
- 先逐步推理（reasoning），最后给出 score_distribution（各分数概率，和为 1）与 dimensions。
- 概率加权评分：最终得分 = Σ(分数 × 概率)。
- 严禁因回复长度加分或减分——只依据内容质量评分，短而准确的回复应得高分。
- 上下文不包含的信息无法评估时，忠实度按"未编造"处理（不扣分）。

输出格式（严格 JSON，只输出一个 JSON 对象）：
{"reasoning": "…", "score_distribution": {"1": 0, "2": 0, "3": 0, "4": 0.7, "5": 0.3}, "dimensions": {"relevance": 4, "faithfulness": 5, "completeness": 3}}`

  const contextText =
    contextLines.length === 0
      ? '（无上下文消息）'
      : contextLines
          .map((m, i) => {
            const who = m.role === 'user' ? '用户' : m.agent_id ? '其他猫' : '系统'
            return `[${i + 1}] ${who}: ${truncateForJudge(m.content)}`
          })
          .join('\n')

  return `
你是猫咖评估裁判，评估 ${agentName} 的一条回复质量。

## 上下文（该回复之前的最近消息）
${contextText}

## 被评回复
${truncateForJudge(replyContent)}

${criteria}
`
}

/** 构造 judge Agent 配置（复用 getAdapterForAgent 的缓存实例）。
 *  配置了 KIMI_API_KEY → Kimi K3（Phase 0 当选 judge，经 deepseek 适配器走
 *  Moonshot OpenAI 兼容 HTTP 端点——K5 变更单接线形态）；
 *  未配置 → deepseek-v4-flash 便宜档兜底 */
export function resolveJudgeAgent(): AgentConfig {
  const kimiKey = process.env.KIMI_API_KEY || ''
  if (kimiKey) {
    return {
      id: 'judge-kimi-k3',
      name: '评估裁判',
      avatar: '⚖️',
      systemPrompt: '',
      llmProvider: 'deepseek',
      llmModel: 'kimi-k3',
      llmApiKey: kimiKey,
      llmBaseUrl: 'https://api.moonshot.cn',
    }
  }
  return {
    id: 'judge-ds-flash',
    name: '评估裁判',
    avatar: '⚖️',
    systemPrompt: '',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-flash',
    llmApiKey: process.env.DS_KEY || '',
  }
}

/** 对一条已落库的回复评分并写 eval_scores。
 *  返回 JudgeOutput（失败/重复评分返回 null）。纯旁路：异常由调用方捕获。 */
export async function scoreReply(
  agent: AgentConfig,
  sessionId: string,
  messageId: string
): Promise<JudgeOutput | null> {
  if (evalScoresRepo.hasScore(messageId)) {
    log.debug('already scored, skip', { messageId })
    return null
  }

  // 前置最近消息（倒序）——目标不在其中则放弃（消息可能已被撤回）
  const recent = messagesRepo.getRecentMessages(sessionId, 200)
  const contextRows = collectContextRows(recent, messageId)
  if (contextRows.length === 0) {
    log.warn('target message not found in session, skip scoring', { messageId, sessionId })
    return null
  }

  // 被评回复正文（窗口最后一条即目标）
  const targetRow = contextRows[contextRows.length - 1]
  const prompt = buildGEvalPrompt(contextRows.slice(0, -1), targetRow.content, agent.name)

  const judge = resolveJudgeAgent()
  const adapter = getAdapterForAgent(judge)

  let fullText = ''
  for await (const chunk of adapter.chatStream(
    [{ role: 'user', content: prompt }],
    judgeChatOptions(judge.llmModel, JUDGE_TIMEOUT_MS)
  )) {
    fullText += chunk.content
  }

  const output = parseJudgeOutput(fullText)
  if (!output) {
    log.warn('judge output unparsable, skip store', {
      messageId,
      rawPreview: fullText.slice(0, 200),
    })
    return null
  }

  // 落库：评分后 score ≤ 2 → sample_reason='low_score'（契约：同一条记录标注）
  evalScoresRepo.insertScore({
    id: uuid(),
    messageId,
    sessionId,
    agentId: agent.id,
    score: output.score,
    dimensionsJson: output.dimensions ? JSON.stringify(output.dimensions) : null,
    judgeModel: judge.llmModel,
    sampleReason: output.score <= 2 ? 'low_score' : 'random',
  })

  log.info('eval score stored', {
    messageId,
    agentName: agent.name,
    score: output.score,
    judgeModel: judge.llmModel,
    sampleReason: output.score <= 2 ? 'low_score' : 'random',
  })
  return output
}

/**
 * Execution — 上下文构建（备菜组）。
 *
 * 从 connectors/socketio.ts 迁出（第 1 刀，零行为变化）：
 * - getRelevantMessages：消息可见性过滤
 * - 摘要替代压缩（SUMMARY_REPLACE_HISTORY）：长会话 token 压缩的纯函数面
 */

import { estimateTokens } from '@cat-study/shared'
import type { LLMMessage } from '@cat-study/shared'

/**
 * 从消息列表中筛选当前 Agent 能"看到"的消息。
 *
 * 规则：
 * - Agent 自己的回复 → 始终可见
 * - 其他 Agent 的回复 → 广播模式下可见；非广播模式下仅当 @mention 了此 Agent 时可见
 * - 用户消息 → 没有 @mention（全员广播）或 @mention 了此 Agent 时可见
 * - 用户消息中 @mention 了其他 Agent → 对此 Agent 不可见（定向消息）
 */
export function getRelevantMessages(
  messages: any[],
  agentId: string,
  agentName: string,
  broadcastMode: boolean
): any[] {
  const relevant: any[] = []

  for (const m of messages) {
    const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []

    if (m.role === 'agent') {
      if (broadcastMode) {
        relevant.push(m)
      } else if (m.agent_id === agentId) {
        relevant.push(m)
      } else if (mentions.includes(agentName)) {
        // 其他 Agent 的回复中 @mention 了当前 Agent → 可见
        // 这是 agent-to-agent review 链的核心：coder 的交接文档
        // 中 @reviewer → reviewer 必须能看到该文档
        relevant.push(m)
      }
      continue
    }

    // 用户消息：无 @ 指定（广播）或 @ 了当前 Agent → 可见
    const targetsThisAgent = mentions.length === 0 || mentions.includes(agentName)
    if (targetsThisAgent) {
      relevant.push(m)
    }
  }

  return relevant
}

// ── 摘要替代压缩（SUMMARY_REPLACE_HISTORY）─────────────────
// 长会话 token 压缩：旧消息压成摘要块保留信息（省 token 不丢历史），
// 替代「超预算直接丢消息」的截断。压缩优先于截断——替换后仍超预算才走截断。
const SUMMARY_KEEP_RECENT = 10 // 保留最近 N 条原文
const SUMMARY_KEEP_TOKENS = 30_000 // 保留原文 token 双保险（超出从旧往新收紧）
const SUMMARY_BLOCK_TOKENS = 2000 // 摘要块生成 token 上限
const SUMMARY_MIN_TOKENS = 8_000 // 上下文低于此 token 不压缩
const SUMMARY_PRE_COMPRESS_RATIO = 0.6 // 预压缩阈值（异步生成，下一轮生效）
const SUMMARY_FORCE_COMPRESS_RATIO = 0.75 // 强制阈值（同步生成，本轮生效）
const SUMMARY_PREFIX = '[历史摘要（压缩）]'

/** 压缩摘要条目形状（与 sessions.compressed_summaries 存储一致）。
 * content 空串 = 异步生成中的 pending；coveredThrough = 生成时点会话消息总数
 * （消费侧判定覆盖边界，见 runAgentReply 的 coverageGap） */
export interface CompressedSummaryEntry {
  id: string
  createdAt: string
  tokenCount: number
  content: string
  coveredThrough: number
}

/** 从 JSON 数组解析压缩摘要条目；损坏返回空数组（读取侧容错） */
export function parseCompressedSummaries(raw: string | null): CompressedSummaryEntry[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 压缩计数 = 生成成功的块数（content 非空的条目；pending/失败残留不计，不消耗上限） */
export function countReadySummaries(entries: CompressedSummaryEntry[]): number {
  return entries.filter((e) => e.content.trim() !== '').length
}

/** 取最后一个就绪（content 非空）的摘要块；无返回 null */
export function lastReadySummary(entries: CompressedSummaryEntry[]): CompressedSummaryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].content.trim() !== '') return entries[i]
  }
  return null
}

/** 构建摘要块 user 消息（放消息数组最前 user 段，前缀防模型误当新输入） */
export function buildSummaryBlockMessage(summary: string): LLMMessage {
  return { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` }
}

/** 压缩消息集：保留最近 SUMMARY_KEEP_RECENT 条（≤SUMMARY_KEEP_TOKENS 双保险，
 * 超出从旧往新收紧），其余旧消息由摘要块替代 */
export function applySummaryReplace(messages: any[], summary: string): { kept: any[] } {
  const kept: any[] = []
  let acc = 0
  for (let i = messages.length - 1; i >= 0 && kept.length < SUMMARY_KEEP_RECENT; i--) {
    const t = estimateTokens(messages[i].content) + 50
    if (acc + t > SUMMARY_KEEP_TOKENS) {
      // 单条超限：至少保留最近这条——双保险是启发式，宁超预算不丢最新消息
      if (kept.length === 0) {
        acc += t
        kept.push(messages[i])
      }
      break
    }
    acc += t
    kept.push(messages[i])
  }
  kept.reverse()
  return { kept }
}

export {
  SUMMARY_KEEP_RECENT,
  SUMMARY_KEEP_TOKENS,
  SUMMARY_BLOCK_TOKENS,
  SUMMARY_MIN_TOKENS,
  SUMMARY_PRE_COMPRESS_RATIO,
  SUMMARY_FORCE_COMPRESS_RATIO,
  SUMMARY_PREFIX,
}

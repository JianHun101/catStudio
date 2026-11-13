/**
 * Execution — 上下文构建（备菜组）。
 *
 * 从 connectors/socketio.ts 迁出（第 1 刀，零行为变化）：
 * - getRelevantMessages：消息可见性过滤
 * - 摘要替代压缩（SUMMARY_REPLACE_HISTORY）：长会话 token 压缩的纯函数面
 */

import { estimateTokens } from '@cat-study/shared'
import type { LLMMessage } from '@cat-study/shared'
import type { CompressedSummaryEntry } from '../db/repository/sessions.js'

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
const FOLD_NOTICE_SEPARATOR = '────────────────'

/**
 * 压缩摘要条目形状的单一来源在 `db/repository/sessions.ts`（存储层）。
 * 此处只 re-export 类型，避免两份 interface 靠人肉对齐（加字段漏改一份不报错）。
 */
export type { CompressedSummaryEntry }

/** 折叠声明元数据。
 *
 * 只带**全局边界**（coveredToId/coveredToAt）与会话标识——区间与条数刻意不写：
 * `applySummaryReplace` 吃的是上下文过滤后的消息，每只猫实际折叠面不同，
 * 写「#1–#N，共 N 条」会让模型按全局数字回查到自己本来看不到的消息。
 */
export interface FoldNoticeMeta {
  sessionId: string
  coveredToId?: string | null
  coveredToAt?: string | null
}

/**
 * 构建摘要块头部的折叠声明（纯函数，便于直接对 meta 断言）。
 *
 * 内容面固定五项：会话标识（审计对齐）、覆盖边界消息 id、边界时间、有损声明、
 * 回查工具名与 `before` 游标。反向禁项：不出现 `sessionId=`、不提示可传会话 id、
 * 不暗示可跨会话查询——`query_session_messages` 的会话由环境注入，模型无从指定。
 */
export function buildFoldNotice(meta: FoldNoticeMeta): string {
  const lines = [`会话标识：${meta.sessionId}（仅供审计，无需在回答中提及）`]
  const lossy = '本摘要为有损压缩，原文完整保存在本会话中（system 通知不参与折叠与回查）。'
  if (meta.coveredToId) {
    const at = meta.coveredToAt ? `，边界时间：${meta.coveredToAt}` : ''
    lines.push(`折叠范围：本会话对话消息 #${meta.coveredToId} 之前的历史已折叠为下列摘要${at}`)
    lines.push(
      `${lossy}需要核对原文时，可调用 query_session_messages 工具，` +
        `以 before=${meta.coveredToId} 为游标回查被折叠区间的消息。`
    )
  } else {
    lines.push('折叠范围：边界未记录（旧版摘要条目）')
    lines.push(
      `${lossy}需要核对原文时，可调用 query_session_messages 工具，` +
        '以 before 游标向前翻阅被折叠区间的消息。'
    )
  }
  return lines.join('\n')
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

/**
 * 就绪块计数 = 生成成功的块数（content 非空的条目；pending/失败残留不计）。
 *
 * 只用于观测（日志里的 `totalCompressed`）——**不再作生成 gate**：保留上限由
 * `SUMMARY_COMPRESS_LIMIT`（数组条数）在有界存储侧执行，达到上限也继续生成新块。
 */
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

/**
 * 构建摘要块 user 消息（放消息数组最前 user 段，前缀防模型误当新输入）。
 *
 * 输出顺序**钉死**：SUMMARY_PREFIX → 折叠声明 → 分隔线 → 摘要。声明缺失时保持
 * 旧形状（前缀 + 摘要），供不关心元数据的调用方使用。
 */
export function buildSummaryBlockMessage(summary: string, notice?: string): LLMMessage {
  const body = notice ? `${notice}\n${FOLD_NOTICE_SEPARATOR}\n${summary}` : summary
  return { role: 'user', content: `${SUMMARY_PREFIX}\n${body}` }
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

/** 折叠窗口 token 估算的输入面（`connectors/socketio.ts` join 分支消费）。 */
export interface FoldedContextInput {
  systemPrompt: string
  messages: any[]
  summaryEntries: CompressedSummaryEntry[]
  maxTokens: number
}

/**
 * 按**折叠窗口**估算上下文 token（与执行期 `reply.ts` 的压缩口径对齐）。
 *
 * 背景：join 分支旧实现把 system_prompt + 全部可见消息逐条累加，不套用摘要折叠替换，
 * 于是刷新页面后右侧成员面板显示的是「未折叠历史」的超高值（实测 131%），而真实
 * prompt 只有 2 万多 token。本函数是纯函数：同一份输入执行期怎么压，这里就怎么算。
 *
 * 语义（与 `reply.ts` 的进入条件逐条对齐）：
 * - `raw < SUMMARY_MIN_TOKENS` 或 `raw/maxTokens < SUMMARY_PRE_COMPRESS_RATIO`
 *   → 执行期不会压缩，返回 raw；
 * - 否则取**最后一个就绪块**（content 非空），无就绪块（含只有 pending / JSON 坏）
 *   → 返回 raw；
 * - 有就绪块 → `system + 摘要块 + 最近窗口`，并与 raw 取 min（估算绝不高报）。
 *
 * 注意：摘要块按**不带折叠声明**的形状估算，声明文本（约百 token 级）不计入——
 * 这是刻意留的少量低估，好过在 join 分支复制一份声明构建逻辑。
 */
export function estimateFoldedContextTokens({
  systemPrompt,
  messages,
  summaryEntries,
  maxTokens,
}: FoldedContextInput): number {
  let raw = estimateTokens(systemPrompt)
  for (const m of messages) raw += estimateTokens(m.content) + 50

  if (raw < SUMMARY_MIN_TOKENS) return raw
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return raw
  if (raw / maxTokens < SUMMARY_PRE_COMPRESS_RATIO) return raw

  const ready = lastReadySummary(summaryEntries)
  if (!ready) return raw

  const { kept } = applySummaryReplace(messages, ready.content)
  let folded = estimateTokens(systemPrompt)
  folded += estimateTokens(buildSummaryBlockMessage(ready.content).content)
  for (const m of kept) folded += estimateTokens(m.content) + 50
  return Math.min(raw, folded)
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

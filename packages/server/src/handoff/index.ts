/**
 * 会话交接引擎 — 当上下文 token 达到 90% 阈值时触发。
 *
 * 设计原则：
 * - 同步执行：交接必须在 Agent 回复前完成，确保新会话干净可用
 * - 全量总结：使用便宜模型对整个对话历史做一次完整总结
 * - 无感切换：前端收到 SESSION_HANDOFF 事件后自动切到新会话
 * - 失败降级：交接失败时在旧会话中继续，不阻塞对话
 */

import { v4 as uuid } from 'uuid'
import { estimateTokens } from '@cat-study/shared'
import { chatComplete } from '../llm/complete.js'
import { sessions as sessionsRepo, messages as messagesRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'
import { envNumber } from '../env-number.js'
import { readRawContextConfig } from '../config/context-config.js'
import type { HandoffBus } from '../execution/bus.js'

const log = createLogger('handoff')

const HANDOFF_SYSTEM_PROMPT = `你是一个会话交接助手。你需要对整个对话做一个完整的总结，确保新会话中的 AI 助手能够无缝接续。

总结应包含：
1. **对话主题**：这段对话在讨论什么
2. **关键决策**：用户做了哪些决定、你的回复确认了什么
3. **待办事项**：还有哪些未完成的任务
4. **用户偏好**：用户表达了哪些偏好、习惯
5. **关键事实**：需要记住的重要信息（日期、数据、配置等）

输出格式：使用以上 5 个小标题组织，用简洁中文。控制在 500-1000 字。`

/**
 * 生成全量会话总结。
 * @param maxTokens - 输出 token 上限（默认 1500 = handoff 交接用；摘要替代传 2000）
 */
export async function generateFullSummary(
  sessionId: string,
  maxTokens: number = 1500
): Promise<string> {
  // 取最新 N 条消息，不截断每条内容（deepseek-v4-flash 有 1M 上下文）
  const allMessages = messagesRepo.getMessagesWithAgentName(sessionId)
  allMessages.reverse() // 恢复时间正序

  const conversationText = allMessages
    .map((m) => {
      if (m.role === 'user') return `用户：${m.content}`
      const name = m.agent_name || '助手'
      return `${name}：${m.content}`
    })
    .join('\n')

  const apiKey = process.env.SUMMARY_API_KEY
  if (!apiKey) {
    log.warn('no summary api key, skipping handoff')
    return ''
  }

  const summary = await chatComplete(HANDOFF_SYSTEM_PROMPT, conversationText, {
    apiKey,
    model: process.env.SUMMARY_MODEL || 'deepseek-v4-flash',
    baseUrl: process.env.SUMMARY_BASE_URL || 'https://api.deepseek.com',
    maxTokens,
    temperature: 0.3,
    timeoutMs: 30_000,
  })

  return summary
}

export interface HandoffResult {
  oldSessionId: string
  newSessionId: string
  summary: string
}

/** 服务端路由兜底的交接目标（与 HandoffResult 同构，供 SESSION_HANDOFF 复用） */
export type HandoffTarget = HandoffResult

/** 沿 handoff_from 链追真实子会话的最大深度（防循环/无限链） */
const HANDOFF_CHAIN_LIMIT = 5

/**
 * 空壳子会话的宽限期（秒）：窗内的 0 消息子会话按「刚交接建出、前端尚未切过去」对待。
 *
 * 固定常量——**不进 env、不进 settings 表**（env/settings 都有 seed-shadow 那类
 * 「改了不生效」的坑，且这是实现细节而非用户旋钮）。
 *
 * 取值依据：交接后前端从收到 SESSION_HANDOFF 到实际发消息之间有一段用户阅读/切换时间，
 * 生产实证里两次误杀间隔 10 分钟上下（14:13:29 与 14:22:12 各删掉一个刚建的新壳）。
 */
const HANDOFF_EMPTY_SHELL_GRACE_SECONDS = 600

/** 解析 running_summary JSON 提取 text 字段；无/解析失败返回 null */
function parseSummaryText(runningSummary: string | null): string | null {
  if (!runningSummary) return null
  try {
    const parsed = JSON.parse(runningSummary)
    return typeof parsed?.text === 'string' ? parsed.text : null
  } catch {
    return null
  }
}

/**
 * 解析消息应落地的会话（方案 A 路由兜底）：沿 handoff_from 链追
 * 最新"真实交接"子会话（有 ≥1 条消息），空壳子会话不算交接、直接跳过。
 *
 * 用户向已交接的旧会话发消息时，调用方把消息重定向到返回的 newSessionId，
 * 并向旧房间 emit SESSION_HANDOFF（复用前端现有切换机制）。
 *
 * @returns 命中返回 { oldSessionId（入参会话）, newSessionId, summary }；
 *          无真实子会话或链超深返回 null（消息留在原会话）
 */
export function resolveHandoffTarget(sessionId: string): HandoffTarget | null {
  let current = sessionId
  let depth = 0
  while (depth < HANDOFF_CHAIN_LIMIT) {
    const child = sessionsRepo.getHandoffChild(current)
    if (!child) return null
    const childRow = sessionsRepo.getSessionById(child.id)
    if (!childRow) return null
    // 子会话自己也交接了 → 继续追链，用户应去最新子会话
    if (sessionsRepo.getHandoffChild(child.id)) {
      current = child.id
      depth++
      continue
    }
    return {
      oldSessionId: sessionId,
      newSessionId: child.id,
      summary: parseSummaryText(childRow.running_summary) ?? '',
    }
  }
  log.warn('handoff chain too deep, giving up', { sessionId, depth: HANDOFF_CHAIN_LIMIT })
  return null
}

/**
 * 计算交接后新会话的标题（编号递增，替代旧「（续）」追加——避免标题无限变长被左侧栏省略）。
 *
 * - 先剥掉历史遗留的尾部「（续）」链（存量脏标题收敛：xxx（续）（续）→ xxx）
 * - 结尾是全角编号（N）→ 递增为（N+1）
 * - 否则追加（1）
 * - 半角括号 (N) 结尾不递增——那是用户自拟命名，不碰
 */
export function nextHandoffTitle(title: string): string {
  const stripped = title.replace(/(（续）)+$/, '')
  const numbered = stripped.match(/^(.*)（(\d+)）$/)
  if (numbered) return `${numbered[1]}（${Number(numbered[2]) + 1}）`
  return `${stripped}（1）`
}

/**
 * 执行会话交接。
 *
 * 顺序（任一「已交接」分支都返回 null，调用方对 null 一律无副作用）：
 * 1. 读原会话
 * 2. 按年龄清理**陈旧**空壳子会话 + 逐个广播 SESSION_DELETED
 * 3. 窗内仍有空壳 ⇒ 复用早退（不生成摘要、不重建、不 emit）
 * 4. 已有真实子会话（≥1 消息）⇒ 早退
 * 5. 生成全量总结 → 6. 建新会话（标题按 nextHandoffTitle 编号递增，继承 agents 与 broadcast）
 *    → 7. 通知前端
 *
 * @returns 交接结果，失败返回 null
 */
export async function performHandoff(
  sessionId: string,
  bus: HandoffBus
): Promise<HandoffResult | null> {
  const enabled = process.env.HANDOFF_ENABLED !== 'false'
  if (!enabled) return null

  // 去重：防止同一会话短时间内多次交接
  if (handoffInProgress.has(sessionId)) {
    log.debug('handoff already in progress for session', { sessionId })
    return null
  }
  handoffInProgress.add(sessionId)

  try {
    // 1. 读取原会话信息
    const oldSession = sessionsRepo.getSessionById(sessionId)
    if (!oldSession) return null

    // 2. 清理**陈旧**空壳子会话（前端切换失败留下的孤儿，0 条消息且早于宽限期）——
    //    不删它们会占住去重守卫，旧会话永不二次交接。刚建出的新壳落在窗内、不清（step 2.5 复用）。
    //    每个被删 id 逐个广播 SESSION_DELETED：纯 DB DELETE 无广播时，前端那条框会成幽灵框。
    const removedIds = sessionsRepo.deleteEmptyHandoffChildren(
      sessionId,
      HANDOFF_EMPTY_SHELL_GRACE_SECONDS
    )
    if (removedIds.length > 0) {
      log.info('removed empty handoff children before re-handoff', {
        sessionId,
        removed: removedIds.length,
      })
      for (const removedId of removedIds) {
        try {
          bus.emitSessionDeleted(removedId)
        } catch (emitErr: any) {
          // 广播失败只记录不抛出：清理本身已完成，不能让通知失败倒灌成交接失败
          log.warn('emit session-deleted for removed shell failed', {
            sessionId,
            removedId,
            error: emitErr.message,
          })
        }
      }
    }

    // 2.5 新鲜空壳复用（本单核心）：窗内仍有 0 消息子会话 ⇒ 它是上一次交接刚建出的新会话，
    //     前端可能还没切过去。此刻再交接一次只会（a）白花一次摘要 LLM 调用、（b）杀掉新壳
    //     再重建、（c）前端多出一条同名框。故直接早退——返回 null 与 step 3「已交接」同语义，
    //     调用方（reply.ts / ingest.ts）对二者都是 fire-and-forget，无差别。
    const freshShell = sessionsRepo.getEmptyHandoffChild(sessionId)
    if (freshShell) {
      log.info('handoff dedup: reusing fresh empty child', {
        sessionId,
        existingChildId: freshShell.id,
        graceSeconds: HANDOFF_EMPTY_SHELL_GRACE_SECONDS,
      })
      return null
    }

    // 4. 检查是否已被真实交接（子会话有 ≥1 条消息才算）
    const existingHandoff = sessionsRepo.getHandoffChild(sessionId)
    if (existingHandoff) {
      log.debug('session already handed off', { sessionId, handoffTo: existingHandoff.id })
      return null
    }

    // 5. 生成全量总结
    log.info('generating full summary for handoff', { sessionId })
    const summary = await generateFullSummary(sessionId)
    if (!summary) {
      // 无 API key（generateFullSummary 返回 ''）——失败必须对前端可见
      //（用户报「交接线到了没触发」的根因之一就是静默失败）
      emitHandoffFailed(sessionId, bus, '摘要 API Key 未配置（SUMMARY_API_KEY 与 DS_KEY 均为空）')
      return null
    }

    // 6. 创建新会话
    const newSessionId = uuid()
    const newTitle = nextHandoffTitle(oldSession.title)
    const oldAgentIds = JSON.parse(oldSession.agent_ids || '[]') as string[]

    sessionsRepo.insertSession(
      newSessionId,
      newTitle,
      oldAgentIds,
      oldSession.broadcast_mode,
      sessionId,
      JSON.stringify({
        text: summary,
        lastMessageId: '',
        tokenCount: estimateTokens(summary),
        roundCount: 0,
        createdAt: new Date().toISOString(),
      })
    )

    log.info('handoff session created', {
      oldSessionId: sessionId,
      newSessionId,
      summaryTokens: estimateTokens(summary),
    })

    // 7. 通知前端（emit 失败时回滚新会话，避免孤儿会话）
    try {
      bus.emitSessionHandoff({
        oldSessionId: sessionId,
        newSessionId,
        summary,
      })
    } catch (emitErr: any) {
      log.error('handoff emit failed — rolling back new session', {
        oldSessionId: sessionId,
        newSessionId,
        error: emitErr.message,
      })
      sessionsRepo.deleteSession(newSessionId)
      return null
    }

    return { oldSessionId: sessionId, newSessionId, summary }
  } catch (err: any) {
    log.error('handoff failed', {
      sessionId,
      error: err.message,
    })
    // LLM 失败（含 empty response 修复前）或 DB 异常——失败可见化，前端横幅展示原因
    emitHandoffFailed(sessionId, bus, err.message)
    return null
  } finally {
    handoffInProgress.delete(sessionId)
  }
}

/** 正在交接的会话 ID 集合（防并发重复） */
const handoffInProgress = new Set<string>()

/**
 * 交接失败可见化——emit HANDOFF_FAILED 到会话房间（`session:${id}`，仅该会话前端可见）。
 * emit 自身失败只记录不抛出（失败通知不能把失败路径拖成崩溃路径）。
 */
function emitHandoffFailed(sessionId: string, bus: HandoffBus, reason: string): void {
  try {
    bus.emitHandoffFailed({ sessionId, reason })
  } catch (emitErr: any) {
    log.warn('handoff failed emit error', { sessionId, error: emitErr.message })
  }
}

/**
 * 检查是否需要交接。
 * @param currentTokens - 当前上下文 token 数
 * @returns true 表示应触发交接
 */
export function shouldHandoff(currentTokens: number): boolean {
  const enabled = process.env.HANDOFF_ENABLED !== 'false'
  if (!enabled) return false

  const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
  // 阈值：配置文件优先（设置页保存即生效——每次现读盘，几字节文件开销微秒级；
  // 模块级缓存会引入「改完需重启」语义，恰是设置页要避免的），env HANDOFF_THRESHOLD 兜底
  // （旧用户无配置文件行为不变）。readRawContextConfig 返回 null = 无文件 → env；
  // 返回对象但缺 handoffThreshold = 文件无该字段/坏值 → env 同样兜底。
  const fileThreshold = readRawContextConfig()?.handoffThreshold
  const threshold =
    typeof fileThreshold === 'number' ? fileThreshold : envNumber('HANDOFF_THRESHOLD', 0.9)
  return currentTokens >= maxTokens * threshold
}

/**
 * 将会话摘要注入到 system prompt 中。
 */
export function injectSummaryIntoSystem(
  systemPrompt: string,
  runningSummary: string | null
): string {
  const summary = parseSummaryText(runningSummary)
  if (!summary) return systemPrompt

  return `${systemPrompt}\n\n【对话历史摘要】\n${summary}\n\n请基于以上摘要理解对话上下文，继续与用户交流。`
}

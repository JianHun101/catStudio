/**
 * 会话交接引擎 — 当上下文 token 达到 90% 阈值时触发。
 *
 * 设计原则：
 * - 同步执行：交接必须在 Agent 回复前完成，确保新会话干净可用
 * - 全量总结：使用便宜模型对整个对话历史做一次完整总结
 * - 无感切换：前端收到 SESSION_HANDOFF 事件后自动切到新会话
 * - 失败降级：交接失败时在旧会话中继续，不阻塞对话
 */

import type Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { estimateTokens, Events } from '@cat-study/shared'
import { chatComplete } from '../llm/complete.js'
import { createLogger } from '../logger.js'
import type { Server as SocketServer } from 'socket.io'

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
 */
async function generateFullSummary(sessionId: string, db: Database.Database): Promise<string> {
  const allMessages = db
    .prepare(
      `SELECT m.*, a.name as agent_name
       FROM messages m
       LEFT JOIN agents a ON m.agent_id = a.id
       WHERE m.session_id = ? AND m.role != 'system'
       ORDER BY m.created_at DESC
       LIMIT 500`
    )
    .all(sessionId) as any[]
  allMessages.reverse() // 恢复时间正序

  const conversationText = allMessages
    .map((m: any) => {
      if (m.role === 'user') return `用户：${m.content.slice(0, 500)}`
      const name = m.agent_name || '助手'
      return `${name}：${m.content.slice(0, 500)}`
    })
    .join('\n')

  const apiKey = process.env.SUMMARY_API_KEY
  if (!apiKey) {
    log.warn('no summary api key, skipping handoff')
    return ''
  }

  const summary = await chatComplete(HANDOFF_SYSTEM_PROMPT, conversationText, {
    apiKey,
    model: process.env.SUMMARY_MODEL || 'deepseek-chat',
    baseUrl: process.env.SUMMARY_BASE_URL || 'https://api.deepseek.com',
    maxTokens: 1500,
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

/**
 * 执行会话交接。
 *
 * 1. 生成全量总结
 * 2. 创建新会话（标题加"（续）"，继承原会话的 agents 和 broadcast 设置）
 * 3. 通知前端
 *
 * @returns 交接结果，失败返回 null
 */
export async function performHandoff(
  sessionId: string,
  io: SocketServer,
  db: Database.Database
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
    const oldSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any
    if (!oldSession) return null

    // 2. 检查是否已被交接：通过 handoff_from 列查是否有会话从此会话分叉
    const existingHandoff = db
      .prepare('SELECT id FROM sessions WHERE handoff_from = ?')
      .get(sessionId) as any
    if (existingHandoff) {
      log.debug('session already handed off', { sessionId, handoffTo: existingHandoff.id })
      return null
    }

    // 3. 生成全量总结
    log.info('generating full summary for handoff', { sessionId })
    const summary = await generateFullSummary(sessionId, db)
    if (!summary) return null // API key 未配置或 LLM 调用失败

    // 4. 创建新会话
    const newSessionId = uuid()
    const newTitle = `${oldSession.title}（续）`

    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode, handoff_from, running_summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      newSessionId,
      newTitle,
      oldSession.agent_ids,
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

    // 5. 通知前端（emit 失败时回滚新会话，避免孤儿会话）
    try {
      io.emit(Events.SESSION_HANDOFF, {
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
      db.prepare('DELETE FROM sessions WHERE id = ?').run(newSessionId)
      return null
    }

    return { oldSessionId: sessionId, newSessionId, summary }
  } catch (err: any) {
    log.error('handoff failed', {
      sessionId,
      error: err.message,
    })
    return null
  } finally {
    handoffInProgress.delete(sessionId)
  }
}

/** 正在交接的会话 ID 集合（防并发重复） */
const handoffInProgress = new Set<string>()

/**
 * 检查是否需要交接。
 * @param currentTokens - 当前上下文 token 数
 * @returns true 表示应触发交接
 */
export function shouldHandoff(currentTokens: number): boolean {
  const enabled = process.env.HANDOFF_ENABLED !== 'false'
  if (!enabled) return false

  const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
  const threshold = parseFloat(process.env.HANDOFF_THRESHOLD || '0.9')
  return currentTokens >= maxTokens * threshold
}

/**
 * 将会话摘要注入到 system prompt 中。
 */
export function injectSummaryIntoSystem(
  systemPrompt: string,
  runningSummary: string | null
): string {
  if (!runningSummary) return systemPrompt

  let summary: { text: string } | null = null
  try {
    summary = JSON.parse(runningSummary)
  } catch {
    return systemPrompt
  }

  if (!summary?.text) return systemPrompt

  return `${systemPrompt}\n\n【对话历史摘要】\n${summary.text}\n\n请基于以上摘要理解对话上下文，继续与用户交流。`
}

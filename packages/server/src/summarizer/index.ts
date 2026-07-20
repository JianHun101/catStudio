/**
 * 增量摘要引擎 — 每轮对话后将旧消息压缩为运行中的摘要。
 *
 * 设计原则：
 * - Fire-and-forget：异步执行，失败不影响对话流
 * - 增量合并：旧摘要 + 新增消息 → 新摘要，不重复总结全量历史
 * - 便宜模型：使用 deepseek-chat ($0.14/1M tokens)，成本可忽略
 */

import type Database from 'better-sqlite3'
import { estimateTokens } from '@cat-study/shared'
import { chatComplete } from '../llm/complete.js'
import { createLogger } from '../logger.js'

const log = createLogger('summarizer')

/** 摘要在消息历史中的位置标记（JSON 格式，存在 sessions.running_summary） */
interface RunningSummary {
  text: string
  lastMessageId: string
  tokenCount: number
  roundCount: number
  createdAt: string
}

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要助手。你的任务是将用户提供的新消息合并到已有的对话摘要中。

规则：
1. 保留重要决策、待办事项、用户偏好、关键事实
2. 丢弃闲聊、问候、纯表情等低信息量内容
3. 用简洁的中文描述，控制在 200-500 字
4. 如果旧摘要为空，则从新消息中提取摘要
5. 按时间顺序组织结构

输出格式：直接输出摘要文本，不要加任何前缀或解释。`

/**
 * 更新会话的运行中摘要。
 *
 * @param sessionId - 会话 ID
 * @param db - 数据库实例
 * @returns 更新后的摘要文本，如果跳过或失败则返回 null
 */
export async function updateRunningSummary(
  sessionId: string,
  db: Database.Database
): Promise<string | null> {
  const enabled = process.env.SUMMARY_ENABLED !== 'false'
  if (!enabled) return null

  const apiKey = process.env.SUMMARY_API_KEY
  if (!apiKey) {
    log.debug('no summary api key, skipping')
    return null
  }

  try {
    // 1. 读取当前摘要
    const sessionRow = db
      .prepare('SELECT running_summary, summary_msg_id FROM sessions WHERE id = ?')
      .get(sessionId) as any

    let oldSummary: RunningSummary | null = null
    if (sessionRow?.running_summary) {
      try {
        oldSummary = JSON.parse(sessionRow.running_summary)
      } catch {
        oldSummary = null
      }
    }

    // 2. 获取上次摘要之后的新消息
    const lastId = oldSummary?.lastMessageId || ''
    let newMessages: any[]
    if (lastId) {
      newMessages = db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND role != 'system' AND created_at > (
             SELECT created_at FROM messages WHERE id = ?
           )
           ORDER BY created_at ASC`
        )
        .all(sessionId, lastId) as any[]
    } else {
      // 首次摘要：取全部消息（每个会话只运行一次，成本可忽略）
      newMessages = db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND role != 'system'
           ORDER BY created_at ASC`
        )
        .all(sessionId) as any[]
    }

    if (newMessages.length === 0) return null

    // 3. 检查轮次是否达到间隔
    const interval = parseInt(process.env.SUMMARY_INTERVAL || '3', 10)
    const roundCount = (oldSummary?.roundCount || 0) + 1
    const lastMsg = newMessages[newMessages.length - 1]
    // 只有达到间隔时才真正调用 LLM
    // 注意：即使跳过也必须更新 roundCount，否则下次 oldSummary.roundCount 不变，摘要永远不触发
    if (roundCount % interval !== 0 && oldSummary) {
      const updatedSummary = { ...oldSummary, roundCount }
      if (lastMsg) {
        db.prepare('UPDATE sessions SET running_summary = ?, summary_msg_id = ? WHERE id = ?').run(
          JSON.stringify(updatedSummary),
          lastMsg.id,
          sessionId
        )
      }
      return null
    }

    // 4. 格式化新消息
    const newMessagesText = newMessages
      .map((m: any) => {
        const role = m.role === 'user' ? '用户' : m.agent_id ? getAgentName(db, m.agent_id) : '系统'
        return `[${role}]: ${m.content}`
      })
      .join('\n')

    // 5. 调用便宜 LLM 进行增量合并
    const oldSummaryText = oldSummary?.text || '（无，这是对话的开始）'
    const userPrompt = `【已有摘要】\n${oldSummaryText}\n\n【新消息】\n${newMessagesText}\n\n请将新消息合并到摘要中，输出更新后的摘要：`

    const summaryText = await chatComplete(SUMMARY_SYSTEM_PROMPT, userPrompt, {
      apiKey,
      model: process.env.SUMMARY_MODEL || 'deepseek-v4-flash',
      baseUrl: process.env.SUMMARY_BASE_URL || 'https://api.deepseek.com',
      maxTokens: 800,
      temperature: 0.3,
      timeoutMs: 15_000,
    })

    if (!summaryText) return null

    // 6. 存储更新后的摘要
    const newSummary: RunningSummary = {
      text: summaryText,
      lastMessageId: lastMsg.id,
      tokenCount: estimateTokens(summaryText),
      roundCount,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      `UPDATE sessions SET running_summary = ?, summary_msg_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(newSummary), lastMsg.id, sessionId)

    log.info('running summary updated', {
      sessionId,
      oldTokens: oldSummary?.tokenCount || 0,
      newTokens: newSummary.tokenCount,
      messagesIncluded: newMessages.length,
      roundCount,
    })

    return summaryText
  } catch (err: any) {
    log.warn('summary update failed (non-blocking)', {
      sessionId,
      error: err.message,
    })
    return null
  }
}

/**
 * 获取 Agent 名称（带缓存）。
 */
function getAgentName(db: Database.Database, agentId: string): string {
  if (!agentId) return '未知'
  try {
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as any
    return row?.name || agentId
  } catch {
    return agentId
  }
}

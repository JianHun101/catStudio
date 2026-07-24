/**
 * Message 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { MessageRow, MessageWithAgentName } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

/** 检查消息是否存在（不限 role），用于撤回时窗保护。
 *  区别于 getMessageById，不按 role 过滤 —— A2A 场景下触发消息可能是 agent 角色。 */
export function messageExists(id: string, sessionId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM messages WHERE id = ? AND session_id = ?')
    .get(id, sessionId)
  return row !== undefined
}

export function getMessageById(
  id: string,
  sessionId: string,
  role: string
): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = ?')
    .get(id, sessionId, role) as MessageRow | undefined
}

/** 获取会话中最近的用户消息 ID */
export function getLatestUserMessageId(sessionId: string): string | undefined {
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(sessionId, 'user') as { id: string } | undefined
  return row?.id
}

/** 获取会话中某条消息之后的所有 Agent 回复 */
export function getAgentRepliesAfter(sessionId: string, afterCreatedAt: string): MessageRow[] {
  return db
    .prepare('SELECT id FROM messages WHERE session_id = ? AND role = ? AND created_at > ?')
    .all(sessionId, 'agent', afterCreatedAt) as MessageRow[]
}

/** 获取会话的历史消息（用于前端加载，排除 system 角色，限制条数） */
export function getSessionHistory(sessionId: string, limit: number = 200): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageRow[]
}

/** 获取会话的最近消息（倒序，用于构建 Agent 上下文） */
export function getRecentMessages(sessionId: string, limit: number = 500): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageRow[]
}

/** 获取同一 taskId 的完整消息历史 */
export function getTaskHistory(
  taskId: string,
  sessionId: string,
  limit: number = 500
): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE task_id = ? AND session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(taskId, sessionId, limit) as MessageRow[]
}

/** 获取上次摘要之后的新消息 */
export function getMessagesAfterSummary(sessionId: string, lastMessageId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system' AND created_at > (
         SELECT created_at FROM messages WHERE id = ?
       )
       ORDER BY created_at ASC`
    )
    .all(sessionId, lastMessageId) as MessageRow[]
}

/** 获取会话全部非 system 消息（首次摘要用） */
export function getAllSessionMessages(sessionId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system'
       ORDER BY created_at ASC`
    )
    .all(sessionId) as MessageRow[]
}

/** 获取会话中指定时间之后的消息数（未读计数用） */
export function countMessagesAfter(sessionId: string, afterTime: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND created_at > ?')
    .get(sessionId, afterTime) as { cnt: number }
  return row?.cnt || 0
}

/** 获取带 Agent 名称的消息（用于交接总结） */
export function getMessagesWithAgentName(
  sessionId: string,
  limit: number = 300
): MessageWithAgentName[] {
  return db
    .prepare(
      `SELECT m.*, a.name as agent_name
       FROM messages m
       LEFT JOIN agents a ON m.agent_id = a.id
       WHERE m.session_id = ? AND m.role != 'system'
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageWithAgentName[]
}

// ─── 写入 ──────────────────────────────────────────────

export function insertMessage(
  id: string,
  sessionId: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  mentionsJson: string,
  agentId: string | null,
  taskId: string | null
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, agentId, role, content, mentionsJson, taskId)
}

export function insertUserMessage(
  id: string,
  sessionId: string,
  content: string,
  mentionsJson: string,
  taskId: string | null
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
     VALUES (?, ?, 'user', ?, ?, ?)`
  ).run(id, sessionId, content, mentionsJson, taskId)
}

export function insertAgentMessage(
  id: string,
  sessionId: string,
  agentId: string,
  content: string,
  taskId: string | null
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
     VALUES (?, ?, ?, 'agent', ?, '[]', ?)`
  ).run(id, sessionId, agentId, content, taskId)
}

export function updateMessageMentions(messageId: string, mentionsJson: string): void {
  db.prepare('UPDATE messages SET mentions = ? WHERE id = ?').run(mentionsJson, messageId)
}

export function deleteMessageById(id: string): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function deleteMessagesBySession(sessionId: string): { changes: number } {
  return db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
}

export function deleteMessagesByAgent(agentId: string): { changes: number } {
  return db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId)
}

export function deleteAllMessages(): void {
  db.exec('DELETE FROM messages')
}

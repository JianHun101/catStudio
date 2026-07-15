/**
 * Socket.IO Connector — Web 前端和 Server 之间的实时通道。
 *
 * 职责：
 * - 接收用户消息 → 写入 DB → 触发调度
 * - 推送 Agent 回复（含流式增量）→ 广播到 Session 房间
 * - 推送 Agent 状态变更 → 广播给所有关注者
 */

import { Server as HttpServer } from 'node:http'
import { Server as SocketServer } from 'socket.io'
import { Events } from '@cat-study/shared'
import { getDb } from '../db/index.js'
import { v4 as uuid } from 'uuid'
import { dispatch, completeExecution, initAgentSlot, getAllAgentStates, getAgentState } from '../dispatch/index.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { saveMessageMemory, buildMemoryContext } from '../memory/index.js'
import { createLogger } from '../logger.js'
import {
  getHeadCommit,
  gitCommit,
  gitResetHard,
  gitCleanWorkingTree,
  snapshotPackageDeps,
  diffNewPackages,
  npmUninstall,
} from '../llm/git-utils.js'
import type { AgentConfig, LLMMessage, Message } from '@cat-study/shared'
import { parseMentionsFromReply } from './a2a-mentions.js'

const log = createLogger('socketio')

/** 模块级 io 实例引用，供路由等模块获取 */
let _io: SocketServer | null = null

/** 正在执行的消息 ID → 是否被撤回（runAgentReply 检查此标志以提前终止） */
const retractionRequests = new Map<string, boolean>()

/** 获取 Socket.IO Server 实例（需在 createSocketIO() 之后调用） */
export function getIO(): SocketServer | null {
  return _io
}

/** DB row (snake_case) → AgentConfig (camelCase) */
function rowToAgent(row: any): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: row.effort_level || undefined,
  }
}

export function createSocketIO(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: [/^http:\/\/localhost:\d+$/],
      methods: ['GET', 'POST'],
    },
  })

  _io = io

  io.on('connection', (socket) => {
    log.info('client connected', { socketId: socket.id })

    // ─── Session: join ───────────────────────────

    socket.on(Events.JOIN_SESSION, (sessionId: string) => {
      socket.join(`session:${sessionId}`)
      log.info('joined session', { socketId: socket.id, sessionId })

      // 推送该 Session 的历史消息（转为 camelCase）
      const db = getDb()
      const messages = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND role != 'system'
        ORDER BY created_at ASC
        LIMIT 200
      `).all(sessionId) as any[]

      messages.forEach((row: any) => {
        socket.emit(Events.NEW_MESSAGE, {
          id: row.id,
          sessionId: row.session_id,
          agentId: row.agent_id,
          role: row.role,
          content: row.content,
          mentions: JSON.parse(row.mentions || '[]'),
          taskId: row.task_id || undefined,
          createdAt: row.created_at,
        })
      })
    })

    socket.on(Events.LEAVE_SESSION, (sessionId: string) => {
      socket.leave(`session:${sessionId}`)
    })

    // ─── Message: send ────────────────────────────

    socket.on(Events.SEND_MESSAGE, async (data: { sessionId: string; content: string; mentions: string[]; taskId?: string }) => {
      const db = getDb()
      const msgId = uuid()
      const traceId = uuid() // 贯穿全链路的请求追踪 ID

      log.info('message received', {
        traceId,
        sessionId: data.sessionId,
        mentions: data.mentions,
        contentLen: data.content.length,
      })

      // 1. 写入消息
      const mentionsJson = JSON.stringify(data.mentions || [])
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, mentions, task_id)
        VALUES (?, ?, 'user', ?, ?, ?)
      `).run(msgId, data.sessionId, data.content, mentionsJson, data.taskId || null)

      const msg = {
        id: msgId,
        sessionId: data.sessionId,
        agentId: null,
        role: 'user' as const,
        content: data.content,
        mentions: data.mentions || [],
        taskId: data.taskId || undefined,
        createdAt: new Date().toISOString(),
      }

      // 2. 广播到 Session 房间
      io.to(`session:${data.sessionId}`).emit(Events.NEW_MESSAGE, msg)

      // 3. 触发调度
      const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(data.sessionId) as any
      if (!sessionRow) {
        log.warn('session not found', { sessionId: data.sessionId })
        socket.emit(Events.ERROR, { message: 'Session not found' })
        return
      }

      const agentIds: string[] = JSON.parse(sessionRow.agent_ids || '[]')
      const agents = agentIds
        .map((id: string) => {
          const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
          return row ? rowToAgent(row) : null
        })
        .filter(Boolean) as AgentConfig[]

      // P0-2 防护：过滤掉不存在于 agents 表或缺少 API key 的无效 Agent
      const validAgents = agents.filter((a) => {
        const exists = db.prepare('SELECT id FROM agents WHERE id = ?').get(a.id)
        if (!exists) {
          log.warn('agent not in DB, skipping dispatch', { agentId: a.id, agentName: a.name, traceId })
          return false
        }
        return true
      })

      // 将用户消息保存为向量记忆（异步不阻塞消息流）
      saveMessageMemory(data.sessionId, data.content, msgId, validAgents.map(a => a.id)).catch((err) => {
        log.warn('记忆存储失败', { error: err.message, traceId })
      })

      // 初始化 Agent 槽位并存储
      for (const a of validAgents) {
        if (!getAgentState(a.id)) {
          initAgentSlot(a.id)
        }
      }

      // 4. 调度 + 执行
      await dispatch(data.sessionId, msg, validAgents, traceId)

      // 获取需要立即执行的 Agent（被 @ 的，或广播下的所有 Agent）
      const mentions = data.mentions || []
      const targets = mentions.length > 0
        ? validAgents.filter((a: any) => mentions.includes(a.name))
        : validAgents

      // 发送 MESSAGE_AGENT_STATUS: queued — 让前端知道消息已被 Agent 接收
      for (const a of targets) {
        io.to(`session:${data.sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
          messageId: msgId,
          agentId: a.id,
          agentName: a.name,
          agentAvatar: a.avatar,
          status: 'queued',
        })
      }

      // 按 FIFO 串行执行（不 await，让多个消息的 Agent 执行可以交错）
      executeAgentsSerial(io, data.sessionId, targets as AgentConfig[], msg, db, traceId)
    })

    // ─── Message retraction ───────────────────────

    socket.on(Events.MESSAGE_RETRACT, (data: { sessionId: string; messageId: string }) => {
      const db = getDb()

      // 1. 验证该消息是最新一条用户消息
      const msg = db.prepare(
        'SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = ?',
      ).get(data.messageId, data.sessionId, 'user') as any
      if (!msg) {
        socket.emit(Events.ERROR, { message: '消息不存在或不是用户消息' })
        return
      }

      const latestUser = db.prepare(
        'SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
      ).get(data.sessionId, 'user') as any
      if (!latestUser || latestUser.id !== data.messageId) {
        socket.emit(Events.ERROR, { message: '只能撤回最新一条消息' })
        return
      }

      // 2. 标记撤回（让正在执行的 runAgentReply 提前终止）
      retractionRequests.set(data.messageId, true)

      // 3. 查 execution_logs 找关联的 commit + packages
      const execLogs = db.prepare(
        'SELECT * FROM execution_logs WHERE triggered_by_message_id = ?',
      ).all(data.messageId) as any[]

      let hasCommit = false
      for (const ex of execLogs) {
        if (ex.commit_hash) {
          hasCommit = true
          break
        }
      }

      // 4. 回滚文件改动
      if (hasCommit) {
        gitResetHard()
      } else {
        gitCleanWorkingTree()
      }

      // 5. 卸载安装的包
      const pkgSet = new Set<string>()
      for (const ex of execLogs) {
        if (ex.packages_installed) {
          try {
            for (const pkg of JSON.parse(ex.packages_installed)) {
              pkgSet.add(pkg)
            }
          } catch { /* ignore */ }
        }
      }
      if (pkgSet.size > 0) {
        npmUninstall(Array.from(pkgSet))
      }

      // 6. 删除该消息触发的所有 agent 回复和该消息本身
      // 先删 execution_logs (外键)
      db.prepare('DELETE FROM execution_logs WHERE triggered_by_message_id = ?').run(data.messageId)
      // 找 agent 回复消息的 id
      const agentReplies = db.prepare(
        'SELECT id FROM messages WHERE session_id = ? AND role = ? AND created_at > ?',
      ).all(data.sessionId, 'agent', msg.created_at) as any[]
      for (const reply of agentReplies) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(reply.id)
      }
      // 删原消息
      db.prepare('DELETE FROM messages WHERE id = ?').run(data.messageId)

      // 7. 清理
      retractionRequests.delete(data.messageId)

      // 8. 广播给所有客户端
      io.emit(Events.MESSAGE_RETRACTED, {
        sessionId: data.sessionId,
        messageId: data.messageId,
        agentReplyIds: agentReplies.map((r: any) => r.id),
      })

      log.info('message retracted', {
        sessionId: data.sessionId,
        messageId: data.messageId,
        hadCommit: hasCommit,
        packagesRemoved: pkgSet.size,
      })
    })

    // ─── Broadcast mode toggle ────────────────────

    socket.on(Events.TOGGLE_BROADCAST, (data: { sessionId: string; broadcastMode: boolean }) => {
      const db = getDb()
      db.prepare(`
        UPDATE sessions SET broadcast_mode = ?, updated_at = datetime('now') WHERE id = ?
      `).run(data.broadcastMode ? 1 : 0, data.sessionId)

      io.to(`session:${data.sessionId}`).emit(Events.BROADCAST_MODE_CHANGED, {
        sessionId: data.sessionId,
        broadcastMode: data.broadcastMode,
      })
    })

    // ─── Agent state ──────────────────────────────

    socket.on('get-agent-states', () => {
      socket.emit('all-agent-states', getAllAgentStates())
    })

    // ─── Disconnect ───────────────────────────────

    socket.on('disconnect', () => {
      log.info('client disconnected', { socketId: socket.id })
    })
  })

  return io
}

/**
 * Agent 执行超时机制（多层纵深设计）。
 *
 *   层级 1 — CLI idle timeout（cli-utils.ts）:
 *     20 分钟无 stdout 输出 → SIGTERM → SIGKILL
 *     每次输出重置 timer，持续产出的 agent 不会被误杀
 *
 *   层级 2 — Dispatch hard timeout（此处）:
 *     30 分钟 AbortController 绝对上限
 *     无论 agent 是否在输出，到时间必定终止，释放槽位
 *
 *   比例: hard = 1.5x idle，idle 先触发，hard 是最终防线。
 *
 * 可通过 AGENT_HARD_TIMEOUT_MS 环境变量覆盖（设为 0 禁用）。 */
const AGENT_HARD_TIMEOUT_MS =
  parseInt(process.env.AGENT_HARD_TIMEOUT_MS || '') || 30 * 60 * 1000 // 30 分钟

/** Agent 间调度的最大递归深度（防止无限循环） */
const MAX_AGENT_DISPATCH_DEPTH = 10

/** 单个 Agent 在同一 traceId 下被 @ 的最大次数 */
const MAX_MENTIONS_PER_AGENT = 3

// ─── Serial Agent Execution ─────────────────────────

/** 追踪每个 Agent 在同一 traceId 下被 @ 的次数（防止无限循环） */
const mentionCounts = new Map<string, number>()

function getMentionKey(traceId: string, agentId: string): string {
  return `${traceId}:${agentId}`
}

async function executeAgentsSerial(
  io: SocketServer,
  sessionId: string,
  agents: AgentConfig[],
  triggerMsg: { id: string; content: string; mentions: string[]; taskId?: string },
  db: ReturnType<typeof getDb>,
  traceId: string,
  depth: number = 0,
): Promise<void> {
  // 深度限制：防止 Agent 间无限循环
  if (depth >= MAX_AGENT_DISPATCH_DEPTH) {
    log.warn('agent dispatch depth limit reached', { traceId, depth })
    return
  }

  // 获取 session 中所有 Agent 名称（用于 mention 解析）
  const sessionRow = db.prepare('SELECT agent_ids FROM sessions WHERE id = ?').get(sessionId) as any
  const sessionAgentIds: string[] = sessionRow ? JSON.parse(sessionRow.agent_ids || '[]') : []
  const sessionAgentNames: string[] = sessionAgentIds
    .map((id: string) => {
      const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as any
      return row?.name || null
    })
    .filter(Boolean)

  for (const agent of agents) {
    // 单个 Agent 被 @ 次数限制
    const mentionKey = getMentionKey(traceId, agent.id)
    const mentionCount = mentionCounts.get(mentionKey) || 0
    if (mentionCount >= MAX_MENTIONS_PER_AGENT) {
      log.info('agent mention limit reached, skipping', {
        traceId,
        agentId: agent.id,
        agentName: agent.name,
        mentionCount,
      })
      continue
    }
    mentionCounts.set(mentionKey, mentionCount + 1)

    const state = getAgentState(agent.id)
    if (!state || state.status !== 'busy') continue

    // 检查 API Key
    if (!agent.llmApiKey || agent.llmApiKey === 'sk-your-api-key-here') {
      log.warn('no API key', { agentId: agent.id, agentName: agent.name, traceId })
      io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
        id: uuid(),
        sessionId,
        agentId: agent.id,
        role: 'system',
        content: `🐱 ${agent.name} 还没有配置 API Key，请在右侧面板点击它进行配置`,
        mentions: [],
        createdAt: new Date().toISOString(),
      })
      await completeExecution(agent.id, true, { traceId })
      continue
    }

    let reply: { content: string; msgId: string } = { content: '', msgId: '' }
    const abortController = new AbortController()
    try {
      // 用 Promise.race 防止单个 Agent 的 LLM 调用挂起阻塞后续 Agent
      // AbortController 确保超时后子进程被 kill（P0-1 修复）
      reply = await Promise.race([
        runAgentReply(io, sessionId, agent, triggerMsg, db, traceId, abortController.signal),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            abortController.abort()
            reject(new Error(`执行超时 (${AGENT_HARD_TIMEOUT_MS / 1000}s)`))
          }, AGENT_HARD_TIMEOUT_MS),
        ),
      ])
    } catch (err: any) {
      abortController.abort() // 确保任何异常都 kill 子进程
      log.error('agent execution failed', {
        agentId: agent.id,
        agentName: agent.name,
        error: err.message,
        traceId,
      })
      io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
        id: uuid(),
        sessionId,
        agentId: agent.id,
        role: 'system',
        content: `🐱 ${agent.name} 暂时无法回复: ${err.message || '系统错误'}`,
        mentions: [],
        createdAt: new Date().toISOString(),
      })
      await completeExecution(agent.id, false, {
        errorMessage: err.message || 'unknown error',
        traceId,
      })
      continue
    }

    await completeExecution(agent.id, true, { traceId })

    // Agent-to-agent dispatch: 检测回复中的 @mentions
    const mentionedNames = parseMentionsFromReply(reply.content, sessionAgentNames)
      .filter((name) => name !== agent.name) // 排除自己 @ 自己
    if (mentionedNames.length > 0) {
      // 将解析出的 mentions 写回 DB，确保后续 Agent 构建上下文时
      // 能通过 mentions.includes(agent.name) 过滤规则看到本消息
      db.prepare('UPDATE messages SET mentions = ? WHERE id = ?')
        .run(JSON.stringify(mentionedNames), reply.msgId)

      // 通知前端更新该消息的 mentions（因为在 runAgentReply 发送
      // NEW_MESSAGE 时 mentions 尚未解析，前端拿到的 mentions 为空）
      io.to(`session:${sessionId}`).emit(Events.MESSAGE_UPDATED, {
        messageId: reply.msgId,
        mentions: mentionedNames,
      })

      log.info('agent-to-agent dispatch', {
        traceId,
        fromAgent: agent.name,
        mentionedNames,
        depth,
      })

      // 找到被 @ 的 Agent 配置
      const mentionedAgents = sessionAgentIds
        .map((id: string) => {
          const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
          return row ? rowToAgent(row) : null
        })
        .filter((a: AgentConfig | null): a is AgentConfig =>
          a !== null && mentionedNames.includes(a.name),
        )

      if (mentionedAgents.length === 0) continue

      // 初始化被 @ Agent 的槽位
      for (const a of mentionedAgents) {
        if (!getAgentState(a.id)) {
          initAgentSlot(a.id)
        }
      }

      // 构造触发消息，使用 runAgentReply 写入的真实 msgId
      // taskId 继承原有的，确保整个 review 链共享同一 task
      const agentTrigger: Message = {
        id: reply.msgId,
        sessionId,
        agentId: agent.id,
        role: 'agent',
        content: reply.content,
        mentions: mentionedNames,
        taskId: triggerMsg.taskId || traceId,
        createdAt: new Date().toISOString(),
      }

      // 调度并递归执行
      await dispatch(sessionId, agentTrigger, mentionedAgents, traceId)
      await executeAgentsSerial(
        io, sessionId, mentionedAgents, agentTrigger, db, traceId, depth + 1,
      )
    }
  }

  // 顶层调度完成后清理 + 自动提交
  if (depth === 0) {
    for (const key of mentionCounts.keys()) {
      if (key.startsWith(`${traceId}:`)) {
        mentionCounts.delete(key)
      }
    }
    // 自动 git commit（忽略非 git 仓库或无改动的情况）
    const commitHash = gitCommit(`catstudy [${triggerMsg.id}]`)
    if (commitHash) {
      // 将 commit hash 写回 execution_logs（本轮所有相关日志）
      db.prepare(
        'UPDATE execution_logs SET commit_hash = ? WHERE triggered_by_message_id = ?',
      ).run(commitHash, triggerMsg.id)
    }
  }
}

async function runAgentReply(
  io: SocketServer,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: { id: string; content: string; mentions: string[]; taskId?: string },
  db: ReturnType<typeof getDb>,
  traceId: string,
  signal?: AbortSignal,
): Promise<{ content: string; msgId: string }> {
  const adapter = getAdapterForAgent(agent)
  const t0 = Date.now()

  log.info('agent reply started', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.llmProvider,
    model: agent.llmModel,
  })

  // 状态：思考中
  io.to(`session:${sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'thinking',
  })

  // 构建对话上下文：只包含与该 Agent 相关的消息
  const allMessages = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND role != 'system'
    ORDER BY created_at ASC
    LIMIT 100
  `).all(sessionId) as any[]

  // 加载同一 taskId 的完整历史（跨越 LIMIT 100 的限制）
  const taskHistory: any[] = []
  if (triggerMsg.taskId) {
    const loadedIds = new Set(allMessages.map((m: any) => m.id))
    const taskMsgs = db.prepare(`
      SELECT * FROM messages
      WHERE task_id = ? AND session_id = ?
      ORDER BY created_at ASC
      LIMIT 200
    `).all(triggerMsg.taskId, sessionId) as any[]
    for (const m of taskMsgs) {
      if (!loadedIds.has(m.id)) {
        taskHistory.push(m)
      }
    }
    if (taskHistory.length > 0) {
      log.info('task history loaded', {
        traceId,
        agentId: agent.id,
        taskId: triggerMsg.taskId,
        taskHistoryCount: taskHistory.length,
      })
    }
  }

  // 合并：task 历史在前，当前消息在后
  const combinedMessages = [...taskHistory, ...allMessages]

  // 过滤规则：
  // - Agent 自己发的消息 → 保留
  // - 其他 Agent 的回复中 @mention 了当前 Agent → 保留（review 链关键）
  // - 用户消息 @ 了该 Agent → 保留
  // - 用户消息没有 @ 任何人（广播）→ 保留
  // - 用户消息 @ 了其他 Agent → 丢弃
  // - 广播模式下：保留所有 Agent 的回复
  // - 非广播模式下：丢弃本次执行无关的 Agent 回复
  const relevantMessages: any[] = []

  // 读取 Session 的广播模式
  const sessionRow = db.prepare('SELECT broadcast_mode FROM sessions WHERE id = ?').get(sessionId) as any
  const isBroadcastMode = !!sessionRow?.broadcast_mode

  for (const m of combinedMessages) {
    const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []

    if (m.role === 'agent') {
      if (isBroadcastMode) {
        relevantMessages.push(m)
      } else if (m.agent_id === agent.id) {
        relevantMessages.push(m)
      } else if (mentions.includes(agent.name)) {
        // 其他 Agent 的回复中 @mention 了当前 Agent → 可见
        // 这是 agent-to-agent review 链的核心：coder 的交接文档
        // 中 @reviewer → reviewer 必须能看到该文档
        relevantMessages.push(m)
      }
      continue
    }

    const targetsThisAgent = mentions.length === 0 || mentions.includes(agent.name)
    if (targetsThisAgent) {
      relevantMessages.push(m)
    }
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: agent.systemPrompt },
    ...relevantMessages.map((m: any, idx: number) => {
      const isLast = idx === relevantMessages.length - 1

      if (m.role === 'agent') {
        if (m.agent_id === agent.id) {
          return {
            role: 'assistant' as const,
            content: m.content,
          }
        }
        const otherAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(m.agent_id) as any
        const otherName = otherAgent?.name || '未知猫咪'
        return {
          role: 'user' as const,
          content: `【${otherName}】说：${m.content}`,
        }
      }

      const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
      const tagged = mentions.length > 0 ? `（@了${mentions.join('、')}）` : ''
      // 广播模式下，未 @ 特定 Agent 时用"对大家说"，让 Agent 意识到这是群聊
      const audience = isBroadcastMode && mentions.length === 0 ? '对大家' : '对你'

      if (isLast) {
        return {
          role: 'user' as const,
          content: `用户${tagged}${audience}说：${m.content}`,
        }
      }
      return {
        role: 'user' as const,
        content: `用户${tagged}说：${m.content}`,
      }
    }),
  ]

  log.info('context built', {
    traceId,
    agentId: agent.id,
    totalMessages: combinedMessages.length,
    relevantMessages: relevantMessages.length,
    contextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
  })

  // 检索相关记忆并注入 system prompt（带超时，不阻塞 LLM 调用）
  const MEMORY_TIMEOUT_MS = 10_000
  let memoryContext = ''
  try {
    memoryContext = await Promise.race([
      buildMemoryContext(agent.id, triggerMsg.content),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(''), MEMORY_TIMEOUT_MS),
      ),
    ])
  } catch {
    memoryContext = ''
  }
  if (memoryContext) {
    llmMessages[0] = {
      ...llmMessages[0],
      content: llmMessages[0].content + memoryContext,
    }
    log.info('记忆上下文已注入', {
      traceId,
      agentId: agent.id,
      memoryChars: memoryContext.length,
      totalContextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
    })
  }

  // 流式生成回复
  let fullContent = ''
  const msgId = uuid()

  // 记录执行前的包依赖快照
  const depsBefore = snapshotPackageDeps()

  io.to(`session:${sessionId}`).emit(Events.AGENT_TYPING, {
    agentId: agent.id,
    messageId: msgId,
    content: '',
  })

  // 状态：回复中
  io.to(`session:${sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'replying',
  })

  const stream = adapter.chatStream(llmMessages, { model: agent.llmModel, signal })

  for await (const chunk of stream) {
    // 检查是否被撤回或超时取消
    if (retractionRequests.get(triggerMsg.id)) {
      log.info('agent reply aborted (retracted)', { traceId, agentId: agent.id })
      return { content: fullContent || '[消息已撤回]', msgId }
    }
    if (signal?.aborted) {
      log.info('agent reply aborted (timeout)', { traceId, agentId: agent.id })
      return { content: fullContent, msgId }
    }
    if (chunk.content) {
      fullContent += chunk.content
      io.to(`session:${sessionId}`).emit(Events.AGENT_TYPING, {
        agentId: agent.id,
        messageId: msgId,
        content: fullContent,
      })
    }
  }

  // 超时取消时不写入消息也不更新状态（由 catch 块处理）
  if (signal?.aborted) {
    log.info('agent reply discarded after stream (timeout)', { traceId, agentId: agent.id })
    return { content: fullContent, msgId }
  }

  const latencyMs = Date.now() - t0

  // 写入完整消息
  db.prepare(`
    INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
    VALUES (?, ?, ?, 'agent', ?, '[]', ?)
  `).run(msgId, sessionId, agent.id, fullContent, triggerMsg.taskId || null)

  log.info('agent reply done', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    latencyMs,
    replyLen: fullContent.length,
    contextMessages: relevantMessages.length,
  })

  const finalMsg = {
    id: msgId,
    sessionId,
    agentId: agent.id,
    role: 'agent' as const,
    content: fullContent,
    mentions: [] as string[],
    taskId: triggerMsg.taskId || undefined,
    createdAt: new Date().toISOString(),
  }

  io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, finalMsg)

  // 状态：完成
  io.to(`session:${sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'done',
  })

  // 记录新安装的包
  const depsAfter = snapshotPackageDeps()
  const newPkgs = diffNewPackages(depsBefore, depsAfter)
  if (newPkgs.length > 0) {
    log.info('new packages installed', { traceId, agentId: agent.id, packages: newPkgs })
  }

  // 将延迟 + 包信息写回 execution_logs
  db.prepare(`
    UPDATE execution_logs
    SET latency_ms = ?,
        packages_installed = ?
    WHERE agent_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).run(latencyMs, JSON.stringify(newPkgs), agent.id)

  // P2: 清理 retractionRequests，防止内存泄漏
  retractionRequests.delete(triggerMsg.id)

  return { content: fullContent, msgId }
}

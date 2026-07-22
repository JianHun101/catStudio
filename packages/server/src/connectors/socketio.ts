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
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { Events, estimateTokens, estimateMessageTokens } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import type { MessageRow, SessionRow, AgentRow } from '../db/repository/index.js'
import { v4 as uuid } from 'uuid'
import {
  dispatch,
  completeExecution,
  initAgentSlot,
  getAllAgentStates,
  getAgentState,
} from '../dispatch/index.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { saveMessageMemory, buildMemoryContext } from '../memory/index.js'
import { createLogger } from '../logger.js'
import {
  gitCommit,
  gitResetHard,
  gitCleanWorkingTree,
  snapshotPackageDeps,
  diffNewPackages,
  npmUninstall,
} from '../llm/git-utils.js'
import type { AgentConfig, LLMMessage, Message } from '@cat-study/shared'
import { parseMentionsFromReply } from './a2a-mentions.js'
import { SkillLoader } from '../skills/skill-loader.js'
import { updateRunningSummary } from '../summarizer/index.js'
import { performHandoff, shouldHandoff, injectSummaryIntoSystem } from '../handoff/index.js'

const log = createLogger('socketio')

/** Agent 技能模块映射（种子 Agent 的 skillModules 定义，后续可迁移到 DB 列） */
const AGENT_SKILL_MODULES: Record<string, string[]> = {
  店长: ['handoff', 'dependency-request'],
  服务员: ['handoff', 'dependency-request'],
  吐槽猫: ['handoff', 'code-review', 'dependency-review'],
}

/** 模块级 io 实例引用，供路由等模块获取 */
let _io: SocketServer | null = null

/** 正在执行的消息 ID → 是否被撤回（runAgentReply 检查此标志以提前终止） */
const retractionRequests = new Map<string, boolean>()

/** 正在流式输出的 Agent 状态 → { sessionId, messageId, content }
 *  JOIN_SESSION 时用于恢复打字气泡（客户端切会话会清空 typingStates） */
const activeStreams = new Map<string, { sessionId: string; messageId: string; content: string }>()

/** 获取 Socket.IO Server 实例（需在 createSocketIO() 之后调用） */
export function getIO(): SocketServer | null {
  return _io
}

/** DB row (snake_case) → AgentConfig (camelCase) */
function rowToAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: (row.effort_level || undefined) as AgentConfig['effortLevel'],
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

      // 推送该 Session 的历史消息（转为 camelCase）— 批量发送，避免逐条渲染闪烁
      const rows = messagesRepo.getSessionHistory(sessionId)

      const historyMessages = rows.map((row: MessageRow) => ({
        id: row.id,
        sessionId: row.session_id,
        agentId: row.agent_id,
        role: row.role,
        content: row.content,
        mentions: JSON.parse(row.mentions || '[]'),
        taskId: row.task_id || undefined,
        createdAt: row.created_at.replace(' ', 'T') + 'Z',
      }))

      // 生成欢迎消息（会话中猫咪列表提示）
      const sessionMeta = sessionsRepo.getSessionMeta(sessionId)
      const agentIds: string[] = sessionMeta ? JSON.parse(sessionMeta.agent_ids || '[]') : []
      const catNames = agentIds
        .map((id: string) => {
          const name = agentsRepo.getAgentNameById(id)
          return name ? `@${name}` : null
        })
        .filter(Boolean)
        .join('、')

      const welcomeMsg = {
        id: `welcome-${sessionId}`,
        sessionId,
        agentId: null,
        role: 'system' as const,
        content: catNames
          ? `👋 欢迎！在消息中使用 ${catNames} 来指定谁来回复。也可以直接发送消息广播给所有猫咪。`
          : '👋 欢迎！在消息中使用 @猫咪名字 来指定谁来回复。',
        mentions: [] as string[],
        createdAt: new Date().toISOString(),
      }

      // 批量推送：欢迎消息 + 历史消息一次性发送，前端一次性渲染
      socket.emit(Events.SESSION_HISTORY, {
        messages: historyMessages,
        welcome: welcomeMsg,
      })

      // 推送每个 Agent 在当前会话的上下文 token 估算值。
      // 前端切换会话时 contextTokens 被清空，需要服务端主动推送初始值，
      // 否则在 Agent 首次回复前一直显示"等待首次回复…"。
      const broadcastMode = !!sessionMeta?.broadcast_mode
      const maxContext = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
      for (const agentId of agentIds) {
        const agent = agentsRepo.getAgentById(agentId)
        if (!agent) continue

        const relevant = getRelevantMessages(rows, agentId, agent.name, broadcastMode)
        let estimatedTokens = estimateTokens(agent.system_prompt || '')
        for (const m of relevant) {
          estimatedTokens += estimateTokens(m.content) + 50 // role 前缀开销
        }

        socket.emit(Events.CONTEXT_WINDOW_STATS, {
          sessionId,
          agentId,
          contextTokens: estimatedTokens,
          maxContextTokens: maxContext,
        })
      }

      // 恢复正在流式输出的 Agent 的打字气泡。
      // 客户端切换会话时 typingStates 被清空，服务端补推当前状态以避免气泡消失。
      for (const [agentId, stream] of activeStreams) {
        if (stream.sessionId === sessionId && agentIds.includes(agentId)) {
          socket.emit(Events.AGENT_TYPING, {
            sessionId,
            agentId,
            messageId: stream.messageId,
            content: stream.content,
          })
        }
      }
    })

    socket.on(Events.LEAVE_SESSION, (sessionId: string) => {
      socket.leave(`session:${sessionId}`)
    })

    // ─── Message: send ────────────────────────────

    socket.on(
      Events.SEND_MESSAGE,
      async (data: { sessionId: string; content: string; mentions: string[]; taskId?: string }) => {
        const msgId = uuid()
        const traceId = uuid() // 贯穿全链路的请求追踪 ID

        log.info('message received', {
          traceId,
          sessionId: data.sessionId,
          mentions: data.mentions,
          contentLen: data.content.length,
          contentTokens: estimateTokens(data.content),
        })

        // 1. 先检查 session 是否存在（在 INSERT 前，避免 FK 约束抛异常）
        const sessionRow = sessionsRepo.getSessionById(data.sessionId)
        if (!sessionRow) {
          log.warn('session not found', { sessionId: data.sessionId })
          socket.emit(Events.ERROR, { message: 'Session not found' })
          return
        }

        // 2. 写入消息
        const mentionsJson = JSON.stringify(data.mentions || [])
        messagesRepo.insertUserMessage(
          msgId,
          data.sessionId,
          data.content,
          mentionsJson,
          data.taskId || null
        )

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

        // 3. 广播到 Session 房间
        io.to(`session:${data.sessionId}`).emit(Events.NEW_MESSAGE, msg)

        // 4. 触发调度

        const agentIds: string[] = JSON.parse(sessionRow.agent_ids || '[]')
        const agents = agentIds
          .map((id: string) => {
            const row = agentsRepo.getAgentById(id)
            return row ? rowToAgent(row) : null
          })
          .filter(Boolean) as AgentConfig[]

        // P0-2 防护：过滤掉不存在于 agents 表或缺少 API key 的无效 Agent
        const validAgents = agents.filter((a) => {
          if (!agentsRepo.agentExists(a.id)) {
            log.warn('agent not in DB, skipping dispatch', {
              agentId: a.id,
              agentName: a.name,
              traceId,
            })
            return false
          }
          return true
        })

        // 将用户消息保存为向量记忆（异步不阻塞消息流）
        saveMessageMemory(
          data.sessionId,
          data.content,
          msgId,
          validAgents.map((a) => a.id)
        ).catch((err) => {
          log.warn('记忆存储失败', { error: err.message, traceId })
        })

        // 初始化 Agent 槽位并存储
        for (const a of validAgents) {
          if (!getAgentState(a.id)) {
            initAgentSlot(a.id)
          }
        }

        // 4. 调度 + 执行（捕获内部异常防止 SEND_MESSAGE 崩溃）
        try {
          await dispatch(data.sessionId, msg, validAgents, traceId)
        } catch (err: any) {
          log.error('dispatch failed', { sessionId: data.sessionId, traceId, error: err.message })
        }

        // 获取需要立即执行的 Agent（被 @ 的，或广播下的所有 Agent）
        const mentions = data.mentions || []
        const targets =
          mentions.length > 0
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
        executeAgentsSerial(io, data.sessionId, targets as AgentConfig[], msg, traceId).catch(
          (err) => {
            // S2 修复：executeAgentsSerial 内部 try/catch 只覆盖 for 循环体。
            // 若在进入循环前崩溃（session 查询、agent 名解析等），异常会成为
            // 未处理 Promise 拒绝，且 dispatch() 已将 agent 设为 busy →
            // 槽位永久卡死。这里做最后一道防线：释放所有仍为 busy 的槽位。
            log.error('executeAgentsSerial crashed — releasing stuck slots', {
              traceId,
              error: err.message,
            })
            for (const a of targets) {
              const state = getAgentState(a.id)
              if (state && state.status === 'busy') {
                completeExecution(a.id, false, {
                  errorMessage: `executeAgentsSerial crash: ${err.message}`,
                  traceId,
                }).catch(() => {})
              }
            }
          }
        )
      }
    )

    // ─── Message retraction ───────────────────────

    socket.on(Events.MESSAGE_RETRACT, (data: { sessionId: string; messageId: string }) => {
      // 1. 验证该消息是最新一条用户消息
      const msg = messagesRepo.getMessageById(data.messageId, data.sessionId, 'user')
      if (!msg) {
        socket.emit(Events.ERROR, { message: '消息不存在或不是用户消息' })
        return
      }

      const latestUserId = messagesRepo.getLatestUserMessageId(data.sessionId)
      if (!latestUserId || latestUserId !== data.messageId) {
        socket.emit(Events.ERROR, { message: '只能撤回最新一条消息' })
        return
      }

      // 2. 标记撤回（让正在执行的 runAgentReply 提前终止）
      retractionRequests.set(data.messageId, true)

      try {
        // 3. 查 execution_logs 找关联的 commit + packages
        const execLogs = execLogsRepo.getLogsByTriggerMessage(data.messageId)

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
            } catch {
              /* ignore */
            }
          }
        }
        if (pkgSet.size > 0) {
          npmUninstall(Array.from(pkgSet))
        }

        // 6. 删除该消息触发的所有 agent 回复和该消息本身
        // 先删 execution_logs (外键)
        execLogsRepo.deleteExecutionLogsByTriggerMessage(data.messageId)
        // 找 agent 回复消息的 id
        const agentReplies = messagesRepo.getAgentRepliesAfter(data.sessionId, msg.created_at)
        for (const reply of agentReplies) {
          messagesRepo.deleteMessageById(reply.id)
        }
        // 删原消息
        messagesRepo.deleteMessageById(data.messageId)

        // 7. 广播给所有客户端
        io.emit(Events.MESSAGE_RETRACTED, {
          sessionId: data.sessionId,
          messageId: data.messageId,
          agentReplyIds: agentReplies.map((r: MessageRow) => r.id),
        })

        log.info('message retracted', {
          sessionId: data.sessionId,
          messageId: data.messageId,
          hadCommit: hasCommit,
          packagesRemoved: pkgSet.size,
        })
      } finally {
        // 确保无论成功或失败都清理撤回标记
        retractionRequests.delete(data.messageId)
      }
    })

    // ─── Broadcast mode toggle ────────────────────

    socket.on(Events.TOGGLE_BROADCAST, (data: { sessionId: string; broadcastMode: boolean }) => {
      sessionsRepo.updateSessionBroadcastMode(data.sessionId, data.broadcastMode)

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
const AGENT_HARD_TIMEOUT_MS = parseInt(process.env.AGENT_HARD_TIMEOUT_MS || '') || 30 * 60 * 1000 // 30 分钟

/** Agent 间调度的最大递归深度（防止无限循环） */
const MAX_AGENT_DISPATCH_DEPTH = 10

/** 单个 Agent 在同一 traceId 下被 @ 的最大次数 */
const MAX_MENTIONS_PER_AGENT = 3

// ─── Agent Busy Lock ────────────────────────────────

/** Agent 执行锁文件路径 — 项目根目录下的 .agent-busy。
 *  存在此文件时，dev.js 文件监听器会推迟 tsx 重启，
 *  确保 Agent（Claude Code CLI）完成文件编辑后才允许重启。 */
const LOCK_FILE = resolve(process.cwd(), '.agent-busy')

/** 获取 Agent 执行锁（幂等 — 已存在则跳过）。
 *  TODO: 未来多 Agent 并发时改为引用计数 */
function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) return false
  writeFileSync(LOCK_FILE, String(process.pid))
  log.info('agent busy lock acquired', { pid: process.pid })
  return true
}

/** 释放 Agent 执行锁 */
function releaseLock(): void {
  if (!existsSync(LOCK_FILE)) return
  unlinkSync(LOCK_FILE)
  log.info('agent busy lock released')
}

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
  triggerMsg: {
    id: string
    content: string
    mentions: string[]
    taskId?: string
  },
  traceId: string,
  depth: number = 0
): Promise<void> {
  // 深度限制：防止 Agent 间无限循环
  if (depth >= MAX_AGENT_DISPATCH_DEPTH) {
    log.warn('agent dispatch depth limit reached', { traceId, depth })
    return
  }

  // 获取 session 中所有 Agent 名称（用于 mention 解析）
  const sessionAgentIds = sessionsRepo.getSessionAgentIds(sessionId)
  const sessionAgentNames: string[] = sessionAgentIds
    .map((id: string) => agentsRepo.getAgentNameById(id))
    .filter((n): n is string => n !== undefined)

  let lockAcquired = false

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
      log.warn('no API key', {
        agentId: agent.id,
        agentName: agent.name,
        traceId,
      })
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

    // 获取 Agent 执行锁（仅 Claude 适配器需要——它会编辑源文件）
    if (agent.llmProvider === 'claude' && !lockAcquired) {
      lockAcquired = acquireLock()
    }

    try {
      let reply: { content: string; msgId: string } = {
        content: '',
        msgId: '',
      }
      const abortController = new AbortController()
      try {
        // 用 Promise.race 防止单个 Agent 的 LLM 调用挂起阻塞后续 Agent
        // AbortController 确保超时后子进程被 kill（P0-1 修复）
        reply = await Promise.race([
          runAgentReply(io, sessionId, agent, triggerMsg, traceId, abortController.signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              abortController.abort()
              reject(new Error(`执行超时 (${AGENT_HARD_TIMEOUT_MS / 1000}s)`))
            }, AGENT_HARD_TIMEOUT_MS)
          ),
        ])
      } catch (err: any) {
        abortController.abort()
        activeStreams.delete(agent.id) // 确保任何异常都 kill 子进程
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

      // 释放槽位并检查队列（P0-2 修复：不再丢弃 completeExecution 返回值）
      const queuedCmd = await completeExecution(agent.id, true, { traceId })

      // Agent-to-agent dispatch: 检测回复中的 @mentions
      const mentionedNames = parseMentionsFromReply(reply.content, sessionAgentNames).filter(
        (name) => name !== agent.name
      ) // 排除自己 @ 自己
      if (mentionedNames.length > 0) {
        // 将解析出的 mentions 写回 DB，确保后续 Agent 构建上下文时
        // 能通过 mentions.includes(agent.name) 过滤规则看到本消息
        messagesRepo.updateMessageMentions(reply.msgId, JSON.stringify(mentionedNames))

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
            const row = agentsRepo.getAgentById(id)
            return row ? rowToAgent(row) : null
          })
          .filter(
            (a: AgentConfig | null): a is AgentConfig =>
              a !== null && mentionedNames.includes(a.name)
          )

        if (mentionedAgents.length > 0) {
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
            io,
            sessionId,
            mentionedAgents,
            agentTrigger,
            traceId,
            depth + 1
          )
        }
      }

      // P0-2 修复：处理队列中等待的命令
      // completeExecution 弹出队列后会返回下一个命令，不再丢弃
      if (queuedCmd) {
        log.info('draining queued command', {
          traceId,
          agentId: agent.id,
          agentName: agent.name,
        })
        const queuedTrigger = {
          id: queuedCmd.triggerMessageId,
          content: queuedCmd.triggerContent,
          mentions: queuedCmd.mentions,
          taskId: triggerMsg.taskId,
        }
        await executeAgentsSerial(io, sessionId, [agent], queuedTrigger, traceId, depth)
      }
    } catch (err: any) {
      // P0-1 修复：外层 try/catch 防止 completeExecution 或 agent-to-agent
      // dispatch 中的任何异常导致 for 循环崩溃、槽位永久卡死
      log.error('post-execution error — releasing slot', {
        agentId: agent.id,
        agentName: agent.name,
        error: err.message,
        traceId,
      })
      await completeExecution(agent.id, false, {
        errorMessage: err.message || 'post-execution error',
        traceId,
      }).catch(() => {
        log.error('critical: completeExecution itself failed', {
          agentId: agent.id,
          traceId,
        })
      })
    }
  }

  // 顶层调度完成后清理 + 自动提交
  if (depth === 0) {
    for (const key of mentionCounts.keys()) {
      if (key.startsWith(`${traceId}:`)) {
        mentionCounts.delete(key)
      }
    }
    try {
      // 自动 git commit（忽略非 git 仓库或无改动的情况）
      const commitHash = gitCommit(`catstudy [${triggerMsg.id}]`)
      if (commitHash) {
        // 将 commit hash 写回 execution_logs（本轮所有相关日志）
        execLogsRepo.updateExecutionLogCommitHash(triggerMsg.id, commitHash)
      }
    } finally {
      if (lockAcquired) {
        // 清理 Agent 执行遗留的脏文件（编辑中断、未追踪的新文件等）
        // 成功路径 git commit 后工作区应为干净状态，此检查为无操作
        try {
          const status = execSync('git status --porcelain', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim()
          if (status) {
            log.warn('dirty workspace after agent execution, resetting', {
              traceId,
            })
            execSync('git checkout -- .', { stdio: 'ignore' })
            execSync('git clean -fd', { stdio: 'ignore' })
          }
        } catch {
          // 非 git 仓库，忽略
        }
        releaseLock()
      }
    }

    // 增量摘要：异步更新运行中的会话摘要（fire-and-forget，不阻塞后续对话）
    updateRunningSummary(sessionId).catch((err) => {
      log.warn('incremental summary failed (non-blocking)', {
        traceId,
        sessionId,
        error: err.message,
      })
    })
  }
}

/**
 * 上下文过滤：返回 Agent 在当前会话中能"看到"的消息。
 *
 * 过滤规则（与 runAgentReply 内联逻辑完全一致）：
 * - Agent 自己发的消息 → 保留
 * - 其他 Agent 的回复中 @mention 了当前 Agent → 保留（review 链关键）
 * - 用户消息 @ 了该 Agent → 保留
 * - 用户消息没有 @ 任何人（广播）→ 保留
 * - 用户消息 @ 了其他 Agent → 丢弃
 * - 广播模式下：保留所有 Agent 的回复
 * - 非广播模式下：丢弃本次执行无关的 Agent 回复
 *
 * @param messages  DB rows（需含 role, agent_id, mentions）
 * @param agentId   当前 Agent ID
 * @param agentName 当前 Agent 名称（用于 @mention 名称匹配）
 * @param broadcastMode 是否广播模式
 */
function getRelevantMessages(
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

async function runAgentReply(
  io: SocketServer,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: {
    id: string
    content: string
    mentions: string[]
    taskId?: string
  },
  traceId: string,
  signal?: AbortSignal
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
  // 按时间倒序取最近消息（generous safety limit），后续用 token 预算做软截断
  const allMessages = messagesRepo.getRecentMessages(sessionId)
  // 反转为时间正序，后续过滤和截断都按时间顺序处理
  allMessages.reverse()

  // 加载同一 taskId 的完整历史（跨越消息加载限制，按 token 预算合并）
  const taskHistory: MessageRow[] = []
  if (triggerMsg.taskId) {
    const loadedIds = new Set(allMessages.map((m: MessageRow) => m.id))
    const taskMsgs = messagesRepo.getTaskHistory(triggerMsg.taskId, sessionId)
    taskMsgs.reverse() // 恢复时间正序
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

  // 读取 Session 的广播模式
  const isBroadcastMode = sessionsRepo.getSessionBroadcastMode(sessionId)

  // 上下文过滤：只保留该 Agent 能"看到"的消息
  const relevantMessages = getRelevantMessages(
    combinedMessages,
    agent.id,
    agent.name,
    isBroadcastMode
  )

  // ── 会话交接预检（截断前） ──────────────────────────
  // 必须在截断前计算消息总 token——handoff 在 90% 阈值触发，
  // 在此之前消息应尽量保留，截断只作最终保底（handoff 未拦住时出手）。
  let preTruncationTokens = 0
  for (const m of relevantMessages) {
    preTruncationTokens += estimateTokens(m.content) + 50 // role 前缀开销
  }

  // ── Token 感知软截断 ──────────────────────────────────
  // 从最新到最旧累加 token，超出预算的消息丢弃（不再用硬编码 LIMIT 100）
  const MAX_CONTEXT = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
  // 98% 预算给消息原文，2% 留给 system prompt（~2500 tokens 基础开销）。
  // Handoff 在 90% 已开新会话，截断只作保底——极少触发。
  const MESSAGE_BUDGET = Math.floor(MAX_CONTEXT * 0.98)
  let tokenAccum = 0
  const truncatedMessages: typeof relevantMessages = []
  for (let i = relevantMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(relevantMessages[i].content) + 50 // role 前缀开销
    if (tokenAccum + msgTokens > MESSAGE_BUDGET) break
    tokenAccum += msgTokens
    truncatedMessages.push(relevantMessages[i])
  }
  truncatedMessages.reverse() // 恢复时间正序

  log.info('token-aware truncation applied', {
    traceId,
    agentId: agent.id,
    beforeTruncation: relevantMessages.length,
    afterTruncation: truncatedMessages.length,
    messageTokensUsed: tokenAccum,
    messageBudget: MESSAGE_BUDGET,
    maxContext: MAX_CONTEXT,
  })

  // 动态组装 system prompt: 铁律（basePrompt）+ 按需加载的操作规则

  const skillModules = AGENT_SKILL_MODULES[agent.name] || []
  const { prompt: dynamicSystemPrompt, matchedSkills } = SkillLoader.getInstance().matchAndBuild(
    agent.systemPrompt,
    skillModules,
    triggerMsg.content
  )
  if (matchedSkills.length > 0) {
    log.debug('skills loaded for agent', {
      traceId,
      agentName: agent.name,
      matchedSkills,
    })
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: dynamicSystemPrompt },
    ...truncatedMessages.map((m: any, idx: number) => {
      const isLast = idx === truncatedMessages.length - 1

      if (m.role === 'agent') {
        if (m.agent_id === agent.id) {
          return {
            role: 'assistant' as const,
            content: m.content,
          }
        }
        const otherName = agentsRepo.getAgentNameById(m.agent_id) || '未知猫咪'
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

  const contextTokenStats = estimateMessageTokens(llmMessages)
  log.info('context built', {
    traceId,
    agentId: agent.id,
    totalMessages: combinedMessages.length,
    relevantBeforeTruncation: relevantMessages.length,
    relevantAfterTruncation: truncatedMessages.length,
    truncationMsgTokens: tokenAccum,
    contextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
    contextTokens: contextTokenStats.total,
    systemTokens: contextTokenStats.systemTokens,
    userTokens: contextTokenStats.userTokens,
    assistantTokens: contextTokenStats.assistantTokens,
  })

  // ── 会话交接检查 ──────────────────────────────────
  // 使用截断**前**的消息 token + system prompt token 判断。
  // preTruncationTokens 在上方截断前已计算。
  const estimatedTotalTokens = preTruncationTokens + contextTokenStats.systemTokens
  if (shouldHandoff(estimatedTotalTokens)) {
    log.info('handoff threshold reached, triggering handoff', {
      traceId,
      agentId: agent.id,
      contextTokens: estimatedTotalTokens,
      maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10),
    })
    // 异步触发交接，不 await — 当前回复在旧会话中继续
    performHandoff(sessionId, io).catch((err) => {
      log.warn('handoff failed (non-blocking)', {
        traceId,
        sessionId,
        error: err.message,
      })
    })
  }

  // ── 注入增量摘要到 system prompt ──────────────────
  // 从当前会话读取运行中的摘要，注入到 system prompt 顶部
  const runningSummary = sessionsRepo.getSessionRunningSummary(sessionId)
  if (runningSummary) {
    const enhancedPrompt = injectSummaryIntoSystem(llmMessages[0].content, runningSummary)
    if (enhancedPrompt !== llmMessages[0].content) {
      llmMessages[0] = { ...llmMessages[0], content: enhancedPrompt }
      const summaryLen = (() => {
        try {
          return JSON.parse(runningSummary)?.text?.length || 0
        } catch {
          return 0
        }
      })()
      log.info('running summary injected', {
        traceId,
        agentId: agent.id,
        summaryChars: summaryLen,
      })
    }
  }

  // 检索相关记忆并注入 system prompt（带超时，不阻塞 LLM 调用）
  const MEMORY_TIMEOUT_MS = 10_000
  let memoryContext = ''
  try {
    memoryContext = await Promise.race([
      buildMemoryContext(agent.id, triggerMsg.content),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), MEMORY_TIMEOUT_MS)),
    ])
  } catch {
    memoryContext = ''
  }
  if (memoryContext) {
    llmMessages[0] = {
      ...llmMessages[0],
      content: llmMessages[0].content + memoryContext,
    }
    const memoryTokens = estimateTokens(memoryContext)
    log.info('记忆上下文已注入', {
      traceId,
      agentId: agent.id,
      memoryChars: memoryContext.length,
      memoryTokens,
      totalContextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
      totalContextTokens: contextTokenStats.total + memoryTokens,
    })
  }

  // ── 最终 token 预算复核 ──────────────────────────
  // summary + memory 注入后重新估算总 token。
  // 超预算时不丢弃任何上下文，直接触发会话交接（fire-and-forget）——
  // 当前回复正常发送，下一条消息在新会话中带着完整摘要继续。
  {
    const finalStats = estimateMessageTokens(llmMessages)
    const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
    if (finalStats.total > maxTokens) {
      log.warn('token budget exceeded after summary/memory injection, triggering handoff', {
        traceId,
        agentId: agent.id,
        finalTokens: finalStats.total,
        maxTokens,
      })
      performHandoff(sessionId, io).catch((err) => {
        log.warn('handoff failed (non-blocking)', {
          traceId,
          sessionId,
          error: err.message,
        })
      })
    }
  }

  // 流式生成回复
  let fullContent = '' // 仅文本内容 — 存入 DB，参与 agent-to-agent 上下文
  let displayContent = '' // 文本 + 思考 — 流式推送给前端
  const msgId = uuid()

  // 记录执行前的包依赖快照
  const depsBefore = snapshotPackageDeps()

  io.to(`session:${sessionId}`).emit(Events.AGENT_TYPING, {
    sessionId,
    agentId: agent.id,
    messageId: msgId,
    content: '',
  })
  activeStreams.set(agent.id, { sessionId, messageId: msgId, content: '' })

  // 状态：回复中
  io.to(`session:${sessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'replying',
  })

  const stream = adapter.chatStream(llmMessages, {
    model: agent.llmModel,
    signal,
  })

  for await (const chunk of stream) {
    // 检查是否被撤回或超时取消
    if (retractionRequests.get(triggerMsg.id)) {
      log.info('agent reply aborted (retracted)', {
        traceId,
        agentId: agent.id,
      })
      activeStreams.delete(agent.id)
      return { content: fullContent || '[消息已撤回]', msgId }
    }
    if (signal?.aborted) {
      log.info('agent reply aborted (timeout)', { traceId, agentId: agent.id })
      activeStreams.delete(agent.id)
      return { content: fullContent, msgId }
    }
    if (chunk.content) {
      displayContent += chunk.content
      // 思考内容只流式展示，不进入存储和上下文
      if (chunk.kind !== 'thinking') {
        fullContent += chunk.content
      }
      io.to(`session:${sessionId}`).emit(Events.AGENT_TYPING, {
        sessionId,
        agentId: agent.id,
        messageId: msgId,
        content: displayContent,
      })
      activeStreams.set(agent.id, { sessionId, messageId: msgId, content: displayContent })
    }
  }

  // 超时取消时不写入消息也不更新状态（由 catch 块处理）
  if (signal?.aborted) {
    log.info('agent reply discarded after stream (timeout)', {
      traceId,
      agentId: agent.id,
    })
    activeStreams.delete(agent.id)
    return { content: fullContent, msgId }
  }

  const latencyMs = Date.now() - t0

  // 写入完整消息
  messagesRepo.insertAgentMessage(
    msgId,
    sessionId,
    agent.id,
    fullContent,
    triggerMsg.taskId || null
  )

  const estimatedPromptLen = llmMessages.reduce((sum, m) => sum + m.content.length, 0)
  const promptTokens = contextTokenStats.total

  log.info('agent reply done', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    latencyMs,
    replyLen: fullContent.length,
    promptLen: estimatedPromptLen,
    promptTokens,
    replyTokens: estimateTokens(fullContent),
    contextMessages: truncatedMessages.length,
  })

  // 短回复检测：上下文较大但回复极短 → CLI 可能静默失败
  if (fullContent.length < 100 && estimatedPromptLen > 10000) {
    log.warn('agent produced unusually short reply', {
      traceId,
      agentId: agent.id,
      agentName: agent.name,
      replyLen: fullContent.length,
      promptLen: estimatedPromptLen,
      contextMessages: truncatedMessages.length,
      latencyMs,
      replyPreview: fullContent.slice(0, 200),
    })
  }

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
    log.info('new packages installed', {
      traceId,
      agentId: agent.id,
      packages: newPkgs,
    })
  }

  // 将延迟 + 包信息 + 诊断数据 + token 统计写回 execution_logs
  execLogsRepo.updateExecutionLogDiagnostics(agent.id, {
    latencyMs,
    packagesInstalled: JSON.stringify(newPkgs),
    promptChars: estimatedPromptLen,
    replyChars: fullContent.length,
    promptTokens,
    completionTokens: estimateTokens(fullContent),
  })

  // 推送上下文窗口 token 用量给前端（驱动 handoff 的真实数字）
  io.to(`session:${sessionId}`).emit(Events.CONTEXT_WINDOW_STATS, {
    sessionId,
    agentId: agent.id,
    contextTokens: estimatedTotalTokens,
    maxContextTokens: MAX_CONTEXT,
  })

  // P2: 清理 retractionRequests + activeStreams，防止内存泄漏
  retractionRequests.delete(triggerMsg.id)
  activeStreams.delete(agent.id)

  return { content: fullContent, msgId }
}

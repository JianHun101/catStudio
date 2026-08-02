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
  cancelQueuedCommand,
  isAnyAgentExecutingMessage,
  setAgentStateBridge,
  executeAgentCommand,
} from '../dispatch/index.js'
import type { DispatchCommand } from '@cat-study/shared'
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
import { parseJsonArray } from '../utils.js'
import { SkillLoader } from '../skills/skill-loader.js'
import { updateRunningSummary } from '../summarizer/index.js'
import {
  performHandoff,
  shouldHandoff,
  injectSummaryIntoSystem,
  resolveHandoffTarget,
} from '../handoff/index.js'

const log = createLogger('socketio')

/** 从 agent.skill_modules JSON 字符串解析技能列表 */
export function parseSkillModules(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
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
export function rowToAgent(row: AgentRow): AgentConfig {
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
    skillModules: parseSkillModules(row.skill_modules),
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

      const historyMessages = rows.map((row: MessageRow) => {
        const msgImages: string[] = parseJsonArray(row.images)
        return {
          id: row.id,
          sessionId: row.session_id,
          agentId: row.agent_id,
          role: row.role,
          content: row.content,
          images: msgImages.length > 0 ? msgImages : undefined,
          mentions: JSON.parse(row.mentions || '[]'),
          taskId: row.task_id || undefined,
          thinkingContent: row.thinking_content || undefined,
          createdAt: row.created_at.replace(' ', 'T') + 'Z',
        }
      })

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
      async (data: {
        sessionId: string
        content: string
        mentions: string[]
        taskId?: string
        images?: string[]
      }) => {
        const msgId = uuid()
        const traceId = uuid() // 贯穿全链路的请求追踪 ID

        log.info('message received', {
          traceId,
          sessionId: data.sessionId,
          mentions: data.mentions,
          contentLen: data.content.length,
          contentTokens: estimateTokens(data.content),
          imageCount: data.images?.length || 0,
        })

        // 1. 先检查 session 是否存在（在 INSERT 前，避免 FK 约束抛异常）
        const sessionRow = sessionsRepo.getSessionById(data.sessionId)
        if (!sessionRow) {
          log.warn('session not found', { sessionId: data.sessionId })
          socket.emit(Events.ERROR, { message: 'Session not found' })
          return
        }

        // 1.5 已交接会话路由兜底（方案 A）：消息重定向到最新真实子会话。
        //     命中时通知旧房间前端切换（复用现有 SESSION_HANDOFF 机制），
        //     后续写入/广播/dispatch 全部走子会话，旧会话不再膨胀。
        const handoffTarget = resolveHandoffTarget(data.sessionId)
        const effectiveSessionId = handoffTarget?.newSessionId ?? data.sessionId

        // 2. 写入消息（先落库、后通知切换——写入失败时前端不应收到切换信号）
        const mentionsJson = JSON.stringify(data.mentions || [])
        // 图片守卫：必须 data:image/ 前缀、单张 base64 ≤ 3MB、最多 4 张
        // （前端已压缩到最长边 1280，此处仅防滥用）
        const images = (data.images || [])
          .filter(
            (s) =>
              typeof s === 'string' && s.startsWith('data:image/') && s.length <= 3 * 1024 * 1024
          )
          .slice(0, 4)
        try {
          messagesRepo.insertUserMessage(
            msgId,
            effectiveSessionId,
            data.content,
            mentionsJson,
            data.taskId || null,
            JSON.stringify(images)
          )
        } catch (err: any) {
          // 审查反馈 #1：resolveHandoffTarget 返回与 INSERT 之间，子会话可能被
          // 并发 DELETE /api/sessions/:id 删除 → FK 异常。async handler 抛异常
          // 会成为 unhandledRejection（项目无 handler，Node v15+ 默认崩进程），
          // 必须就地捕获——与下方 dispatch 的 try/catch 同款防护。
          log.error('insert user message failed', {
            sessionId: data.sessionId,
            effectiveSessionId,
            traceId,
            error: err.message,
          })
          socket.emit(Events.ERROR, { message: '消息写入失败，请重试' })
          return
        }

        if (handoffTarget) {
          log.info('message redirected to handoff child session', {
            oldSessionId: data.sessionId,
            newSessionId: effectiveSessionId,
          })
          io.to(`session:${data.sessionId}`).emit(Events.SESSION_HANDOFF, handoffTarget)
        }

        const msg = {
          id: msgId,
          sessionId: effectiveSessionId,
          agentId: null,
          role: 'user' as const,
          content: data.content,
          images: images.length > 0 ? images : undefined,
          mentions: data.mentions || [],
          taskId: data.taskId || undefined,
          createdAt: new Date().toISOString(),
        }

        // 3. 广播到 Session 房间（重定向时是子会话房间）
        io.to(`session:${effectiveSessionId}`).emit(Events.NEW_MESSAGE, msg)

        // 4. 触发调度（重定向时从子会话取 agents——子会话的 agent_ids
        //    可能已被 PATCH 更新，与旧会话不再一致）

        // 重定向时子会话行（兜底：子会话被删时回退旧会话行）
        const targetRow =
          effectiveSessionId === data.sessionId
            ? sessionRow
            : (sessionsRepo.getSessionById(effectiveSessionId) ?? sessionRow)
        const agentIds: string[] = JSON.parse(targetRow.agent_ids || '[]')
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
          effectiveSessionId,
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
          await dispatch(effectiveSessionId, msg, validAgents, traceId)
        } catch (err: any) {
          log.error('dispatch failed', {
            sessionId: effectiveSessionId,
            traceId,
            error: err.message,
          })
        }

        // 获取需要立即执行的 Agent（被 @ 的，或广播下的所有 Agent）
        const mentions = data.mentions || []
        const targets =
          mentions.length > 0
            ? validAgents.filter((a: any) => mentions.includes(a.name))
            : validAgents

        // 发送 MESSAGE_AGENT_STATUS: queued — 让前端知道消息已被 Agent 接收
        // （重定向时发子会话房间，与 NEW_MESSAGE 一致）
        for (const a of targets) {
          io.to(`session:${effectiveSessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
            messageId: msgId,
            agentId: a.id,
            agentName: a.name,
            agentAvatar: a.avatar,
            status: 'queued',
          })
        }

        // 按 FIFO 串行执行（不 await，让多个消息的 Agent 执行可以交错）
        executeAgentsSerial(io, effectiveSessionId, targets as AgentConfig[], msg, traceId).catch(
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
      //    同时清理所有排队命令（Window ①：Agent 在 FIFO 队列中等待）
      retractionRequests.set(data.messageId, true)
      const cancelledCount = cancelQueuedCommand(data.messageId)
      if (cancelledCount > 0) {
        log.info('retraction cancelled queued commands', {
          sessionId: data.sessionId,
          messageId: data.messageId,
          cancelledCount,
        })
      }

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
      } catch (err: any) {
        // 撤回失败时清理标记，避免永久残留
        retractionRequests.delete(data.messageId)
        log.error('message retraction failed', {
          sessionId: data.sessionId,
          messageId: data.messageId,
          error: err.message,
        })
      }

      // 撤回成功后：如果该消息没有 Agent 正在执行（全部在排队中被 cancel）
      // → 没有 runAgentReply 会清理标记 → 在此处清理，防止内存泄漏
      if (!isAnyAgentExecutingMessage(data.messageId)) {
        retractionRequests.delete(data.messageId)
      }
      // 如果有 Agent 正在执行，标记由 runAgentReply 出口清理
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

  // 桥接 dispatch 状态变化 → Socket.IO（Redis 不可用时前端仍能收到更新）
  setAgentStateBridge((_event, state) => {
    if (state.sessionId) {
      io.to(`session:${state.sessionId}`).emit(Events.AGENT_STATUS, state)
    }
    io.emit('all-agent-states', getAllAgentStates())
  })

  // 启动恢复：重新 dispatch 被 server 重启打断的执行（fire-and-forget，不阻塞启动）
  recoverInterruptedExecutions(io).catch((err) => {
    log.error('recoverInterruptedExecutions crashed', { error: (err as Error).message })
  })

  // P0 启动恢复：重新 dispatch 队列中的待处理消息（queued/running，fire-and-forget）
  recoverQueuedMessages(io).catch((err) => {
    log.error('recoverQueuedMessages crashed', { error: (err as Error).message })
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
const _HARD_TIMEOUT = parseInt(process.env.AGENT_HARD_TIMEOUT_MS || '')
const AGENT_HARD_TIMEOUT_MS = isNaN(_HARD_TIMEOUT) ? 30 * 60 * 1000 : _HARD_TIMEOUT // 30 分钟

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

/** 测试钩子：读取 mention 计数（仅测试用，生产路径不调用） */
export function __getMentionCount(traceId: string, agentId: string): number {
  return mentionCounts.get(getMentionKey(traceId, agentId)) || 0
}

/** 测试钩子：预置 mention 计数（仅测试用，生产路径不调用） */
export function __setMentionCount(traceId: string, agentId: string, count: number): void {
  mentionCounts.set(getMentionKey(traceId, agentId), count)
}

/** 测试钩子：重置 mention 计数（仅测试用，生产路径不调用） */
export function __test_resetMentionCounts(): void {
  mentionCounts.clear()
}

export async function executeAgentsSerial(
  io: SocketServer,
  sessionId: string,
  agents: AgentConfig[],
  triggerMsg: {
    id: string
    content: string
    mentions: string[]
    taskId?: string
    authorName?: string
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
    const state = getAgentState(agent.id)
    if (!state || state.status !== 'busy') continue
    // 跨会话忙碌：agent 正在其他 session 执行，已入队，不在此执行
    if (state.sessionId !== sessionId) continue
    // 只执行"本次 dispatch 标记的执行"：agent 正在处理其他消息时（本消息在
    // FIFO 队列中等待排空），必须跳过——否则同一条消息会被立即执行一次、
    // 队列排空再执行一次，产生重复回复（08:43:15 双补填事故根因）。
    // completeExecution 弹出队列时会更新 currentTriggerMessageId，
    // 排空路径自然通过此检查。
    if (state.currentTriggerMessageId !== triggerMsg.id) continue

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

      // 执行成功后记录 mention 计数（防止无限 agent-to-agent 循环——
      // 同一 trace 内某 agent 真实完成 ≥MAX 次执行后，不再被 A2A 重新调度。
      // 计数的是实际执行次数而非进入执行循环的次数，因此未执行的
      // 排队任务/审查闭环 mention 不消耗配额（阈值内不受限））
      const mentionKey = getMentionKey(traceId, agent.id)
      mentionCounts.set(mentionKey, (mentionCounts.get(mentionKey) || 0) + 1)

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

        // 单个 Agent 被 @ 次数限制（防止无限 agent-to-agent 循环）
        // 基于实际执行次数过滤——已执行 ≥MAX 次的 agent 不再被重新调度
        const limitedAgents = mentionedAgents.filter((a) => {
          const mk = getMentionKey(traceId, a.id)
          return (mentionCounts.get(mk) || 0) < MAX_MENTIONS_PER_AGENT
        })
        if (limitedAgents.length < mentionedAgents.length) {
          log.info('agent-to-agent mention limit filtered', {
            traceId,
            fromAgent: agent.name,
            skipped: mentionedAgents.filter((a) => !limitedAgents.includes(a)).map((a) => a.name),
            remaining: limitedAgents.map((a) => a.name),
          })
        }

        if (limitedAgents.length > 0) {
          // 初始化被 @ Agent 的槽位
          for (const a of limitedAgents) {
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
            mentions: limitedAgents.map((a) => a.name),
            taskId: triggerMsg.taskId || traceId,
            createdAt: new Date().toISOString(),
          }

          // 调度并递归执行
          await dispatch(sessionId, agentTrigger, limitedAgents, traceId)
          await executeAgentsSerial(
            io,
            sessionId,
            limitedAgents,
            { ...agentTrigger, authorName: agent.name },
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
        await executeAgentsSerial(io, queuedCmd.sessionId, [agent], queuedTrigger, traceId, depth)
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

// ─── 启动恢复：重新 dispatch 被 server 重启打断的执行 ───

/**
 * 重启恢复队列：server 重启时 dispatch 的 in-memory 队列（agentQueues/agentSlots）
 * 被清空，正在执行的 agent 被 fixStuckExecutionLogs 标记为 failed/server_restart，
 * 其触发消息永远不会再被处理——"投递到了但接收端从未处理"事故的根因。
 *
 * 启动时扫描这些记录逐条恢复：
 * 1. 触发消息必须还在（会话/消息已删则跳过）
 * 2. 该 agent 必须尚未回复（回复已写库、finalize 前被杀的场景跳过，防重复执行）
 * 3. 按 execution_logs 记录的 agent 逐个恢复——不整条消息重新 dispatch，
 *    避免同消息下已完成的 agent 被再次调度（@多个 agent 时只有被打断的重跑）
 */
export async function recoverInterruptedExecutions(io: SocketServer): Promise<void> {
  try {
    const interrupted = execLogsRepo.getInterruptedExecutions()
    if (interrupted.length === 0) return

    log.warn('启动恢复：重新 dispatch 被 server 重启打断的执行', { count: interrupted.length })

    for (const rec of interrupted) {
      try {
        const triggerMeta = messagesRepo.getMessageByIdOnly(rec.triggered_by_message_id)
        if (!triggerMeta || triggerMeta.session_id !== rec.session_id) continue

        const triggerRow = messagesRepo.getMessageById(
          triggerMeta.id,
          triggerMeta.session_id,
          triggerMeta.role
        )
        if (!triggerRow) continue

        // 已回复则跳过（防重复执行——重启可能发生在回复写库之后、finalize 之前）
        if (
          messagesRepo.hasAgentRepliedAfter(rec.agent_id, rec.session_id, triggerRow.created_at)
        ) {
          log.info('跳过恢复：agent 已回复', {
            agentId: rec.agent_id,
            triggerId: rec.triggered_by_message_id,
          })
          continue
        }

        const agentRow = agentsRepo.getAgentById(rec.agent_id)
        if (!agentRow) continue
        const agent = rowToAgent(agentRow)
        // 无 API key 无法执行（与 executeAgentsSerial 的检查一致）
        if (!agent.llmApiKey || agent.llmApiKey === 'sk-your-api-key-here') continue

        if (!getAgentState(agent.id)) initAgentSlot(agent.id)

        const mentions = JSON.parse(triggerRow.mentions || '[]') as string[]
        const cmd: DispatchCommand = {
          sessionId: rec.session_id,
          agentId: agent.id,
          triggerMessageId: triggerRow.id,
          triggerContent: triggerRow.content,
          mentions,
        }
        const traceId = uuid()

        // 设置槽位（与 dispatch 内部 executeAgent 等效：busy + currentTrigger + 新执行日志）
        await executeAgentCommand(agent, cmd, traceId)

        const triggerMsg = {
          id: triggerRow.id,
          content: triggerRow.content,
          mentions,
          taskId: triggerRow.task_id || undefined,
          authorName:
            triggerRow.role === 'agent' && triggerRow.agent_id
              ? (agentsRepo.getAgentNameById(triggerRow.agent_id) ?? undefined)
              : undefined,
        }

        log.warn('恢复执行', {
          agentId: agent.id,
          agentName: agent.name,
          triggerId: triggerRow.id,
          sessionId: rec.session_id,
          traceId,
        })

        await executeAgentsSerial(io, rec.session_id, [agent], triggerMsg, traceId, 0)
      } catch (err: any) {
        log.error('恢复单个执行失败', {
          agentId: rec.agent_id,
          triggerId: rec.triggered_by_message_id,
          error: err.message,
        })
      }
    }
  } catch (err: any) {
    log.error('recoverInterruptedExecutions failed', { error: err.message })
  }
}

// ─── P0 队列持久化恢复：重新 dispatch 队列中的待处理消息 ───

/**
 * server 重启时恢复 dispatch_state=queued/running 的消息，重新走 dispatch 调度。
 *
 * 与 recoverInterruptedExecutions 互补：
 * - 前者按 execution_logs 逐 agent 恢复——只覆盖"已开始执行"的 agent，
 *   入队了但还没轮到执行的队列消息在 execution_logs 里没有记录，恢复不到
 * - 此处按消息整条恢复——解析 mentions → 重新调度，覆盖队列中的那部分
 *
 * 幂等防线（防重启后重复执行）：
 * 1. 目标 agent 已回复（回复写库后、finalize 前被杀的场景）→ 跳过该 agent
 * 2. 无 API key 的 agent → 跳过（与 recoverInterruptedExecutions 一致）
 */
export async function recoverQueuedMessages(io: SocketServer): Promise<void> {
  try {
    const pending = messagesRepo.getPendingMessages()
    if (pending.length === 0) return

    log.warn('启动恢复：重新 dispatch 队列中的待处理消息', { count: pending.length })

    for (const row of pending) {
      try {
        const sessionRow = sessionsRepo.getSessionById(row.session_id)
        if (!sessionRow) continue

        // 补查完整行（getPendingMessages 只返回最小字段集，幂等判断需要 created_at）
        const fullRow = messagesRepo.getMessageById(row.id, row.session_id, row.role)
        if (!fullRow) continue

        const mentions = JSON.parse(row.mentions || '[]') as string[]
        const agentIds: string[] = JSON.parse(sessionRow.agent_ids || '[]')
        const agents = agentIds
          .map((id: string) => {
            const r = agentsRepo.getAgentById(id)
            return r ? rowToAgent(r) : null
          })
          .filter(Boolean) as AgentConfig[]

        // 目标 agent：有 @ 只恢复被 @ 的，广播恢复会话内全部
        const targets =
          mentions.length > 0 ? agents.filter((a) => mentions.includes(a.name)) : agents

        // 无 API key 无法执行（与 recoverInterruptedExecutions 一致）
        const executable = targets.filter(
          (a) => a.llmApiKey && a.llmApiKey !== 'sk-your-api-key-here'
        )

        // 幂等防线：已回复的 agent 不再调度（防重启后重复执行）
        const toDispatch = executable.filter(
          (a) => !messagesRepo.hasAgentRepliedAfter(a.id, row.session_id, fullRow.created_at)
        )

        if (toDispatch.length === 0) {
          log.info('跳过恢复：目标 agent 均已回复', { messageId: row.id })
          continue
        }

        // 槽位初始化（dispatch 对未知 slot 直接跳过，不初始化不调度）
        for (const a of toDispatch) {
          if (!getAgentState(a.id)) initAgentSlot(a.id)
        }

        const msg: Message = {
          id: row.id,
          sessionId: row.session_id,
          agentId: row.agent_id,
          role: row.role as Message['role'],
          content: row.content,
          mentions,
          taskId: fullRow.task_id || undefined,
          images: fullRow.images ? (JSON.parse(fullRow.images) as string[]) : undefined,
          createdAt: fullRow.created_at,
        }

        log.warn('恢复队列消息', {
          messageId: row.id,
          sessionId: row.session_id,
          agents: toDispatch.map((a) => a.name),
        })

        await dispatch(row.session_id, msg, toDispatch)
      } catch (err: any) {
        log.error('恢复单条队列消息失败', {
          messageId: row.id,
          error: err.message,
        })
      }
    }
  } catch (err: any) {
    log.error('recoverQueuedMessages failed', { error: err.message })
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

/**
 * 计算用户消息的受众标签。
 *
 * 纯函数，无副作用。
 *
 * @param mentions 消息中 @mention 的 agent 名列表
 * @param agentName 当前 agent 名称
 * @returns '对你' 当 agent 在 mentions 中，否则 '对大家'
 */
export function formatAudienceTag(mentions: string[], agentName: string): string {
  return mentions.includes(agentName) ? '对你' : '对大家'
}

/**
 * 格式化其他 agent 的消息为 LLM 上下文字符串。
 *
 * 使用强信号格式，让 LLM 明确知道这是来自另一个 Agent 的直接消息，
 * 而非用户在引用或转述。灵感来源：clowder-ai 的 D2 消息模板。
 *
 * 纯函数，无副作用。
 *
 * @param name    消息发送者的 agent 名称
 * @param content 消息内容
 * @param mentions 该消息中 @mention 的 agent 名列表（即接收方应回复给谁）
 * @param model   发送者使用的 LLM 模型（可选，提供上下文透明度）
 * @returns 格式为 "Direct message from name [model]; reply to mentions\n\ncontent"
 */
export function formatAgentMessage(
  name: string,
  content: string,
  mentions: string[] = [],
  model?: string
): string {
  const headerParts = [`Direct message from ${name}`]
  if (model) headerParts.push(` [${model}]`)
  if (mentions.length > 0) headerParts.push(`; reply to ${mentions.join(', ')}`)
  return `${headerParts.join('')}\n\n${content}`
}

/**
 * 审查循环检测：当审查者给出非通过结论时，向被审查的 agent 注入系统指令，
 * 确保修正后 @审查者 继续循环。
 *
 * 角色判断基于 skillModules（而非硬编码名称/ID）：
 *   - 有 code-review skill → 审查者
 *   - 无 code-review skill → coder（需要被审查）
 *
 * 结论判断基于 IRON_LAWS_REVIEWER 强制输出的结构化标记：
 *   - ✅可合并 → 通过，循环结束
 *   - ⚠️建议修改 / ❌需重做 → 需要继续循环
 *
 * @returns 系统指令字符串，不需要时返回 null
 */
function buildReviewLoopHint(
  agent: { name: string; skillModules?: string[] },
  relevantMessages: Array<{
    role: string
    agent_id: string | null
    content: string
    mentions: string | null
  }>
): string | null {
  // 审查者自己不需要被注入（有 code-review skill 的 agent 是审查者）
  if (agent.skillModules?.includes('code-review')) return null

  // 找最近一条来自审查者且 @mention 当前 agent 的消息
  for (let i = relevantMessages.length - 1; i >= 0; i--) {
    const m = relevantMessages[i]
    if (m.role !== 'agent' || !m.agent_id) continue

    // 检查发送者是否是审查者（基于 skillModules）
    const senderRow = agentsRepo.getAgentById(m.agent_id)
    if (!senderRow) continue
    if (!parseSkillModules(senderRow.skill_modules).includes('code-review')) continue

    const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
    if (!mentions.includes(agent.name)) continue

    // 找到审查者的消息。用 lastIndexOf 检测结论标记（而非 includes），
    // 因为审查正文可能引用/讨论这些标记，但审查结论总在消息末尾。
    // 取三个标记中最后出现者作为实际结论。
    const CONCLUSION_MARKERS = ['✅可合并', '⚠️建议修改', '❌需重做']
    let conclusionMarker: string | null = null
    let conclusionPos = -1
    for (const marker of CONCLUSION_MARKERS) {
      const pos = m.content.lastIndexOf(marker)
      if (pos > conclusionPos) {
        conclusionPos = pos
        conclusionMarker = marker
      }
    }

    if (conclusionMarker === '✅可合并') return null // 审查通过

    // 审查未通过（⚠️建议修改 / ❌需重做 / 无明确结论）→ 注入循环指令
    const reviewerName = senderRow.name
    const verdict = conclusionMarker || '未给出明确结论'
    return [
      `[系统指令] ${reviewerName} 的审查结论为 ${verdict}。`,
      `你必须逐项处理反馈，修正完成后在行首独占一行 @${reviewerName} 继续审查循环。`,
      `只有收到 ✅可合并 时才能结束回复。`,
    ].join(' ')
  }

  return null
}

/**
 * 交接文档触发检测：当 trigger 消息是 handoff-gen 投递的补填请求时，
 * 注入 system 指令确保 agent 补填完成后 @吐槽猫 发起审查。
 *
 * 一次 LLM 调用只产生一条回复，agent 在回复中同时完成补填和 @mention。
 */
function buildHandoffTriggerHint(triggerContent: string): string | null {
  if (!triggerContent.startsWith('@店长 请补填以下交接文档')) return null

  const allAgents = agentsRepo.listAllAgents()
  const reviewer = allAgents.find((a) => parseSkillModules(a.skill_modules).includes('code-review'))
  if (!reviewer) return null

  return [
    `[系统指令] 你收到了一份交接文档补填请求。`,
    `补填完 Why/Tradeoff/Open Questions 后，在回复末尾行首独占一行 @${reviewer.name} 发起代码审查。`,
  ].join(' ')
}

/**
 * 聚合所有动态上下文指令。
 *
 * 每个 hint 检查一个场景，返回要注入的 system 指令或 null。
 * 新场景只需加一行调用，无需改动 runAgentReply 主流程。
 */
function buildDynamicHints(
  agent: { name: string; skillModules?: string[] },
  triggerContent: string,
  relevantMessages: Array<{
    role: string
    agent_id: string | null
    content: string
    mentions: string | null
  }>
): string[] {
  return [
    buildReviewLoopHint(agent, relevantMessages),
    buildHandoffTriggerHint(triggerContent),
  ].filter((h): h is string => h !== null)
}

/**
 * 格式化用户消息为 LLM 上下文字符串。
 *
 * 纯函数，无副作用。
 *
 * @param content 消息内容
 * @param mentions @mention 的 agent 名列表
 * @param audience 受众标签（'对你' / '对大家'）
 * @param isLast 是否为最后一条消息（决定是否携带受众标签）
 * @returns 格式化后的用户消息字符串
 */
export function formatUserMessage(
  content: string,
  mentions: string[],
  audience: string,
  isLast: boolean
): string {
  const tagged = mentions.length > 0 ? `（@了${mentions.join('、')}）` : ''
  if (isLast) {
    return `用户${tagged}${audience}：${content}`
  }
  return `用户${tagged}：${content}`
}

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

async function runAgentReply(
  io: SocketServer,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: {
    id: string
    content: string
    mentions: string[]
    taskId?: string
    authorName?: string
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

  const skillModules = agent.skillModules
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

  // 将 system prompt 中的 @作者 占位符替换为实际触发者名字
  // 使 LLM 能正确输出 @店长 等实际 agent 名，而非 @作者
  const finalSystemPrompt = triggerMsg.authorName
    ? dynamicSystemPrompt.replace(/@作者/g, `@${triggerMsg.authorName}`)
    : dynamicSystemPrompt

  // 动态上下文指令：根据当前场景注入系统级提示（审查循环、交接触发等）
  const dynamicHints = buildDynamicHints(agent, triggerMsg.content, relevantMessages)

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: finalSystemPrompt },
    ...dynamicHints.map((h) => ({ role: 'system' as const, content: h })),
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
        const otherMentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
        const otherRow = agentsRepo.getAgentById(m.agent_id)
        const otherModel = otherRow?.llm_model || undefined
        return {
          role: 'user' as const,
          content: formatAgentMessage(otherName, m.content, otherMentions, otherModel),
        }
      }

      const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
      const audience = formatAudienceTag(mentions, agent.name)

      // 用户消息附带图片：真图（base64）走 images 字段供 ollama 视觉模型使用，
      // 同时加文字占位，让 deepseek/claude 等非视觉模型也能感知"用户发了图"
      const msgImages: string[] = parseJsonArray(m.images)
      const formatted = formatUserMessage(m.content, mentions, audience, isLast)
      const content =
        msgImages.length > 0 ? `${formatted}\n[用户附带了 ${msgImages.length} 张图片]` : formatted

      return {
        role: 'user' as const,
        content,
        ...(msgImages.length > 0 ? { images: msgImages } : {}),
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
      buildMemoryContext(triggerMsg.content),
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
  let thinkingContent = '' // 仅思考过程 — 存入 DB 的 thinking_content 列，回复后仍可查看
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

  // ── 撤回时窗保护（Window ②）──────────────────────
  // 在 LLM 调用前检查触发消息是否仍存在于 DB。
  // 用户在 Agent 构建上下文期间撤回 → DB 已删 → 阻止 LLM 调用。
  if (!messagesRepo.messageExists(triggerMsg.id, sessionId)) {
    log.info('trigger message retracted before LLM call', {
      traceId,
      agentId: agent.id,
    })
    activeStreams.delete(agent.id)
    return { content: '[消息已撤回]', msgId }
  }

  const stream = adapter.chatStream(llmMessages, {
    model: agent.llmModel,
    signal,
  })

  for await (const chunk of stream) {
    // ── 撤回时窗保护（Window ③）──────────────────────
    // 流式输出中途撤回 → 提前终止
    // 检查是否被撤回或超时取消
    if (retractionRequests.get(triggerMsg.id)) {
      log.info('agent reply aborted (retracted)', {
        traceId,
        agentId: agent.id,
      })
      activeStreams.delete(agent.id)
      retractionRequests.delete(triggerMsg.id)
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
      } else {
        thinkingContent += chunk.content
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
    triggerMsg.taskId || null,
    thinkingContent || undefined
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
    thinkingContent: thinkingContent || undefined,
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

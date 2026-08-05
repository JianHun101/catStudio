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
  clearAgentQueue,
  isAnyAgentExecutingMessage,
  setAgentStateBridge,
  setSystemMessageBridge,
  executeAgentCommand,
} from '../dispatch/index.js'
import type { DispatchCommand } from '@cat-study/shared'
import { getAdapterForAgent } from '../llm/registry.js'
import { buildMemoryContext } from '../memory/index.js'
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
import { filterAllowedMentions, allowedTargetsDescription } from '../dispatch/mention-policy.js'
import { parseJsonArray } from '../utils.js'
import { SkillLoader } from '../skills/skill-loader.js'
import { updateRunningSummary } from '../summarizer/index.js'
import { performHandoff, shouldHandoff, injectSummaryIntoSystem } from '../handoff/index.js'
import { ingestUserMessage } from './ingest.js'
import { emitAgentReply } from './replyBus.js'
import {
  RESTART_TTL_MS,
  isRestartRequestContent,
  extractRestartReason,
  createRestartRequest,
  readRestartRequest,
  updateRestartRequest,
  removeRestartRequest,
  readRestartDone,
  removeRestartDone,
} from '../restart-request.js'

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

/** 正在执行的 Agent → 其 AbortController（停止按钮中断思考用）。
 *  executeAgentsSerial 创建后注册、Promise.race 结束路径（正常/异常）清理。
 *  abortController 原本是循环内局部变量外部摸不到——升级为模块级注册表后，
 *  AGENT_INTERRUPT handler 才能跨会话按 agentId 全局寻址（用户手动改 DB 的场景）。 */
const activeAborts = new Map<string, AbortController>()

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
    // 老库迁移默认 'unknown'（不在 AgentRole 里）——白名单对未知角色放行
    role: (row.role || undefined) as AgentConfig['role'],
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

      // 重启请求文件（存在时其 expiresAt 是历史消息按钮过期的权威值——刷新后按钮状态正确）
      const restartReq = readRestartRequest()

      // 历史恢复只给「当前生效请求」的消息附加重启类型——按钮只属于当前请求，
      // 其他以【重启请求】开头的历史消息不附加（幽灵按钮：点它必报「已失效」）
      const isActiveRestart = (row: MessageRow): boolean => {
        if (!restartReq) return false
        if (!isRestartRequestContent(row.content)) return false
        return restartReq.sessionId === row.session_id && restartReq.messageId === row.id
      }

      const historyMessages = rows.map((row: MessageRow) => {
        const msgImages: string[] = parseJsonArray(row.images)
        const isRestart = isActiveRestart(row)
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
          // 历史恢复同样携带重启类型（前端按钮渲染依据；DB 不存类型，内容前缀是唯一事实源）
          ...(isRestart
            ? {
                messageType: 'restart_request' as const,
                // isRestart 为真时 restartReq 必非 null（isActiveRestart 前置条件）——文件 expiresAt 是权威
                restartExpiresAt: restartReq!.expiresAt,
              }
            : {}),
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

      // 重启请求状态推送：刷新/重连后前端按钮状态以服务端为权威恢复。
      // 请求存在且属于本会话 → 推当前状态；否则推 none 复位（历史消息按钮隐藏）。
      const joinRestartReq = readRestartRequest()
      if (joinRestartReq && joinRestartReq.sessionId === sessionId) {
        socket.emit(Events.RESTART_STATUS, {
          sessionId,
          messageId: joinRestartReq.messageId,
          state: joinRestartReq.state,
          expiresAt: joinRestartReq.expiresAt,
        })
      } else {
        socket.emit(Events.RESTART_STATUS, { sessionId, messageId: null, state: 'none' })
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
        // 摄入管线（校验/重定向/落库/广播/调度/执行）已提取为共享核心，
        // 与 REST POST /api/messages 同构——两入口共用 ingest.ts。
        const result = await ingestUserMessage({
          sessionId: data.sessionId,
          content: data.content,
          mentions: data.mentions || [],
          images: data.images,
          taskId: data.taskId,
          saveMemory: true,
        })
        if (!result.ok) {
          socket.emit(Events.ERROR, { message: result.error })
        }
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

    // ─── Restart confirm / cancel ─────────────────

    socket.on(
      Events.RESTART_CONFIRM,
      (
        data: { messageId: string },
        ack?: (res: { ok: boolean; reason?: 'missing' | 'expired' }) => void
      ) => {
        const req = readRestartRequest()
        if (!req) {
          socket.emit(Events.ERROR, { message: '重启请求已失效，请店长重新发起' })
          ack?.({ ok: false, reason: 'missing' })
          return
        }
        if (Date.now() > new Date(req.expiresAt).getTime()) {
          // 过期：清理文件 + 通知前端隐藏按钮
          removeRestartRequest()
          log.info('restart request expired', {
            messageId: req.messageId,
            sessionId: req.sessionId,
          })
          socket.emit(Events.ERROR, { message: '重启请求已过期（10 分钟有效），请店长重新发起' })
          socket.emit(Events.RESTART_STATUS, {
            sessionId: req.sessionId,
            messageId: req.messageId,
            state: 'expired',
          })
          ack?.({ ok: false, reason: 'expired' })
          return
        }
        if (req.state === 'pending') {
          // pending → confirmed：dev.js 轮询到 confirmed 且新鲜即执行重启
          updateRestartRequest({ ...req, state: 'confirmed' })
          log.info('restart request confirmed', {
            messageId: req.messageId,
            sessionId: req.sessionId,
          })
        }
        // 已 confirmed → 幂等重推（重复点击不报错）
        socket.emit(Events.RESTART_STATUS, {
          sessionId: req.sessionId,
          messageId: req.messageId,
          state: 'confirmed',
          expiresAt: req.expiresAt,
        })
        ack?.({ ok: true })
      }
    )

    socket.on(Events.RESTART_CANCEL, () => {
      const req = readRestartRequest()
      if (req) {
        removeRestartRequest()
        log.info('restart request cancelled', {
          messageId: req.messageId,
          sessionId: req.sessionId,
        })
        socket.emit(Events.RESTART_STATUS, {
          sessionId: req.sessionId,
          messageId: req.messageId,
          state: 'cancelled',
        })
      } else {
        // 文件已不存在（过期/已执行/重复取消）→ 幂等复位
        socket.emit(Events.RESTART_STATUS, { sessionId: '', messageId: null, state: 'none' })
      }
    })

    // ─── Agent 手动中断（停止按钮：中断思考 + 清空队列）───

    socket.on(Events.AGENT_INTERRUPT, (data: { agentId: string }) => {
      const { agentId } = data || {}
      if (!agentId) return
      const state = getAgentState(agentId)
      if (!state) return // 未知 agent → 幂等无操作

      // 先清队列再 abort：abort 后执行循环的 completeExecution(false) 收口时
      // 队列已空不会弹出新命令（中断后 agent 不自动重启执行，新消息才重新触发）
      const cleared = clearAgentQueue(agentId)
      // 中断当前执行——executeAgentsSerial 的 abort 检查发现 signal.aborted 后
      // 跳过 A2A 解析、走失败路径收口（execution_logs 记 failed）
      const controller = activeAborts.get(agentId)
      const executing = controller !== undefined
      controller?.abort()

      if (cleared > 0 || executing) {
        log.info('agent interrupted by user', { agentId, cleared })
        // 系统消息进 agent 实际所在的 session 房间——跨会话忙碌同样可中断，
        // 消息应出现在"正在干活"的那个会话里
        const sessionId = state.sessionId
        if (sessionId) {
          const agentRow = agentsRepo.getAgentById(agentId)
          const name = agentRow?.name || agentId
          io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
            id: uuid(),
            sessionId,
            agentId,
            role: 'system',
            content: `🐱 ${name} 已停止（用户中断）`,
            mentions: [],
            createdAt: new Date().toISOString(),
          })
        }
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

  // 桥接 dispatch 状态变化 → Socket.IO（Redis 不可用时前端仍能收到更新）
  setAgentStateBridge((_event, state) => {
    if (state.sessionId) {
      io.to(`session:${state.sessionId}`).emit(Events.AGENT_STATUS, state)
    }
    io.emit('all-agent-states', getAllAgentStates())
  })

  // 桥接 dispatch 系统消息 → Socket.IO（队列满拒绝入队时通知用户，与 NEW_MESSAGE 同形状）
  setSystemMessageBridge((sessionId, agentId, content) => {
    io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
      id: uuid(),
      sessionId,
      agentId,
      role: 'system',
      content,
      mentions: [],
      createdAt: new Date().toISOString(),
    })
  })

  // 启动恢复：重新 dispatch 被 server 重启打断的执行（fire-and-forget，不阻塞启动）
  recoverInterruptedExecutions(io).catch((err) => {
    log.error('recoverInterruptedExecutions crashed', { error: (err as Error).message })
  })

  // P0 启动恢复：重新 dispatch 队列中的待处理消息（queued/running，fire-and-forget）
  recoverQueuedMessages(io).catch((err) => {
    log.error('recoverQueuedMessages crashed', { error: (err as Error).message })
  })

  // 重启完成通知：dev.js 重启成功后写 .restart-done，此处广播「重启完成」并清理
  broadcastRestartDone(io).catch((err) => {
    log.error('broadcastRestartDone crashed', { error: (err as Error).message })
  })

  return io
}

/**
 * 广播重启完成通知。
 * dev.js 执行用户确认的重启后写 .restart-done（含 sessionId/reason）；
 * 新 server 启动时读取 → 以 system 消息落库 + 广播到该会话 → 删除 done 标记。
 * 会话已删除（FK 失败）→ 静默清理标记，不阻塞启动。
 */
async function broadcastRestartDone(io: SocketServer): Promise<void> {
  const done = readRestartDone()
  if (!done) return
  try {
    if (done.sessionId && sessionsRepo.getSessionById(done.sessionId)) {
      const msgId = uuid()
      const content = `🔄 重启完成（原因：${done.reason}）`
      messagesRepo.insertMessage(msgId, done.sessionId, 'system', content, '[]', null, null)
      io.to(`session:${done.sessionId}`).emit(Events.NEW_MESSAGE, {
        id: msgId,
        sessionId: done.sessionId,
        agentId: null,
        role: 'system',
        content,
        mentions: [],
        createdAt: new Date().toISOString(),
      })
      log.info('restart done broadcast', { sessionId: done.sessionId, reason: done.reason })
    }
  } catch (err) {
    log.warn('restart done broadcast failed', { error: (err as Error).message })
  } finally {
    removeRestartDone()
  }
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

/** 单个 Agent 在同一 traceId 下被 A2A @ 的最大次数（用户顶层触发不计数） */
const MAX_MENTIONS_PER_AGENT = 5

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
      activeAborts.set(agent.id, abortController)
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
      } finally {
        activeAborts.delete(agent.id)
      }

      // 用户中断检查：AGENT_INTERRUPT handler 对本执行 abort 后，runAgentReply
      // 在流循环里检测到 signal.aborted 提前返回（内容不落库、无 NEW_MESSAGE 终稿）。
      // 此处必须拦截——否则部分内容会被当正常回复走 A2A mention 解析，
      // 触发错误的 agent-to-agent 调度。中断走失败路径收口（execution_logs 记 failed）。
      if (abortController.signal.aborted) {
        log.info('agent execution interrupted by user', {
          agentId: agent.id,
          agentName: agent.name,
          traceId,
        })
        io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
          id: uuid(),
          sessionId,
          agentId: agent.id,
          role: 'system',
          content: `🐱 ${agent.name} 已停止（用户中断）`,
          mentions: [],
          createdAt: new Date().toISOString(),
        })
        await completeExecution(agent.id, false, {
          errorMessage: 'interrupted',
          traceId,
        })
        continue
      }

      // 释放槽位并检查队列（P0-2 修复：不再丢弃 completeExecution 返回值）
      const queuedCmd = await completeExecution(agent.id, true, { traceId })

      // 执行成功后记录 mention 计数（防止无限 agent-to-agent 循环——
      // 同一 trace 内某 agent 真实完成 ≥MAX 次 A2A 执行后，不再被重新调度。
      // 计数的是实际执行次数而非进入执行循环的次数，因此未执行的
      // 排队任务/审查闭环 mention 不消耗配额（阈值内不受限）。
      // 仅 depth>0（A2A 链路）计数——用户顶层触发（depth=0）不消耗配额，
      // 否则用户 @ 触发的执行会把计数推满，后续同 trace 的 A2A @ 被误杀）
      if (depth > 0) {
        const mentionKey = getMentionKey(traceId, agent.id)
        mentionCounts.set(mentionKey, (mentionCounts.get(mentionKey) || 0) + 1)
      }

      // Agent-to-agent dispatch: 检测回复中的 @mentions
      // 解析前归一化（解析层兜底）：prompt 层注入（resolveRolePlaceholders）只保证
      // system prompt 已替换，不保证 LLM 必然照做——LLM 只要照抄 prompt 的占位符
      // 字面输出，解析层严格精确匹配就会落空、收口信号静默丢失（a2c7f73 后事故链
      // 第三次变体：mock 泄漏盲区——端到端测试 mock 了解析层假结果，真实链路仍裸奔）。
      // 此处对回复正文再调一次同一函数，把 @架构师/@审查者/@作者 归一为真名后才解析，
      // 普通文本叙述（"是项目架构师"无 @ 前缀）零影响。解析层本身保持精确匹配不动。
      const mentionedNames = parseMentionsFromReply(
        resolveRolePlaceholders(reply.content, triggerMsg.authorName),
        sessionAgentNames
      ).filter((name) => name !== agent.name) // 排除自己 @ 自己
      if (mentionedNames.length > 0) {
        // 找到被 @ 的 Agent 配置（提前——白名单判定需要目标角色）
        const allMentionedAgents = sessionAgentIds
          .map((id: string) => {
            const row = agentsRepo.getAgentById(id)
            return row ? rowToAgent(row) : null
          })
          .filter(
            (a: AgentConfig | null): a is AgentConfig =>
              a !== null && mentionedNames.includes(a.name)
          )

        // A2A 风暴治理白名单：按发送者角色剥除违规 mention（执行顺序：白名单→配额→dispatch）。
        // 写回 DB 用允许集合——被拦猫在上下文过滤（getRelevantMessages 基于
        // mentions.includes 判定可见性）里也不可见，语义自洽。
        // 未知/缺失角色 → 放行不拦截（老库零回归，误杀审查链代价远大于漏拦一条 @）
        const policy = filterAllowedMentions(
          { role: agent.role, triggerAuthorName: triggerMsg.authorName },
          allMentionedAgents
        )
        const allowedNames = policy.allowed.map((a) => a.name)
        if (policy.blocked.length > 0) {
          log.warn('agent-to-agent mention blocked by role policy', {
            traceId,
            fromAgent: agent.name,
            fromRole: agent.role,
            blocked: policy.blocked.map((b) => `${b.name}:${b.reason}`),
          })
          // 系统提示：点名违规与正确规则（即时反馈，不持久化进 system_prompt）。
          // 文案按 reason 区分——role-not-allowed 是角色白名单违规；
          // count-limit 是超上限（≤1 个 @），提示拆条发送而非误报违规
          const hintParts: string[] = []
          const roleBlocked = policy.blocked.filter((b) => b.reason === 'role-not-allowed')
          if (roleBlocked.length > 0) {
            hintParts.push(
              `你 @ 的 ${roleBlocked.map((b) => b.name).join('、')} 不在你的角色允许范围内（当前可 @：${allowedTargetsDescription(agent.role)}），该 mention 已忽略`
            )
          }
          const countBlocked = policy.blocked.filter((b) => b.reason === 'count-limit')
          if (countBlocked.length > 0) {
            hintParts.push(
              `一条回复最多 @ 1 个 agent，你 @ 的 ${countBlocked.map((b) => b.name).join('、')} 已忽略，请拆条分别 @`
            )
          }
          io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
            id: uuid(),
            sessionId,
            agentId: agent.id,
            role: 'system',
            content: `🐱 ${agent.name} ${hintParts.join('；')}`,
            mentions: [],
            createdAt: new Date().toISOString(),
          })
        }

        if (allowedNames.length > 0) {
          // 将解析出的 mentions 写回 DB，确保后续 Agent 构建上下文时
          // 能通过 mentions.includes(agent.name) 过滤规则看到本消息
          messagesRepo.updateMessageMentions(reply.msgId, JSON.stringify(allowedNames))

          // 通知前端更新该消息的 mentions（因为在 runAgentReply 发送
          // NEW_MESSAGE 时 mentions 尚未解析，前端拿到的 mentions 为空）
          io.to(`session:${sessionId}`).emit(Events.MESSAGE_UPDATED, {
            messageId: reply.msgId,
            mentions: allowedNames,
          })

          log.info('agent-to-agent dispatch', {
            traceId,
            fromAgent: agent.name,
            mentionedNames: allowedNames,
            depth,
          })

          // 单个 Agent 被 @ 次数限制（防止无限 agent-to-agent 循环）
          // 基于实际执行次数过滤——已执行 ≥MAX 次的 agent 不再被重新调度
          const limitedAgents = policy.allowed.filter((a) => {
            const mk = getMentionKey(traceId, a.id)
            return (mentionCounts.get(mk) || 0) < MAX_MENTIONS_PER_AGENT
          })
          if (limitedAgents.length < policy.allowed.length) {
            log.info('agent-to-agent mention limit filtered', {
              traceId,
              fromAgent: agent.name,
              skipped: policy.allowed.filter((a) => !limitedAgents.includes(a)).map((a) => a.name),
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

            // 调度并递归执行——A2A 入队命令带 depth+1（>0 才会消耗 mention 配额）
            await dispatch(sessionId, agentTrigger, limitedAgents, traceId, depth + 1)
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
      }

      // P0-2 修复：处理队列中等待的命令
      // completeExecution 弹出队列后会返回下一个命令，不再丢弃。
      // 递归用 queuedCmd 自持的 traceId/depth（命令入队时记录的），不继承执行者的——
      // 否则另一条用户消息的命令会带着错误的 trace 执行（A2A 配额张冠李戴）
      if (queuedCmd) {
        log.info('draining queued command', {
          traceId: queuedCmd.traceId,
          agentId: agent.id,
          agentName: agent.name,
          depth: queuedCmd.depth,
        })
        // 补执行审计（恢复路径 recoverInterruptedExecutions 同款）：completeExecution
        // 已弹出队列命令并更新槽位（busy + currentTrigger），此处补 executeAgentCommand
        // 写 execution_log——否则排队命令的执行零审计（审查结论 151 秒执行无记录的根因）
        await executeAgentCommand(agent, queuedCmd, queuedCmd.traceId)
        // 出队反查触发作者（恢复路径 recoverInterruptedExecutions:1119-1122 同款）：
        // A2A 审查结论 @回请求人依赖 triggerAuthorName 例外判定（mention-policy），
        // 缺失则 undefined 与写死名比对失败 → 白名单误拦（10:38 事故根因）；
        // 反查失败（消息已删/非 agent）→ undefined，与现状等价不拦截
        const triggerMeta = messagesRepo.getMessageByIdOnly(queuedCmd.triggerMessageId)
        const triggerRow = triggerMeta
          ? messagesRepo.getMessageById(
              queuedCmd.triggerMessageId,
              queuedCmd.sessionId,
              triggerMeta.role
            )
          : undefined
        // B 触发合并点名：并入的触发在出队执行时告知（内存注入触发消息，
        // 不落库）——"还有 N 件事"让 Agent 上下文知道本次任务合并了多次触发
        const queuedTrigger = {
          id: queuedCmd.triggerMessageId,
          content:
            queuedCmd.pendingTriggers.length > 0
              ? `${queuedCmd.triggerContent}\n\n[系统提示] 你本次执行期间，另有 ${queuedCmd.pendingTriggers.length} 件事已并入本任务（触发消息：${queuedCmd.pendingTriggers.join('、')}），请一并处理。`
              : queuedCmd.triggerContent,
          mentions: queuedCmd.mentions,
          // taskId 用命令自持的（入队时抄 userMessage.taskId），不继承执行者——
          // 否则 A2A 审查链的 task 关联张冠李戴（与 traceId/depth 同语义）
          taskId: queuedCmd.taskId,
          authorName:
            triggerRow?.role === 'agent' && triggerRow.agent_id
              ? (agentsRepo.getAgentNameById(triggerRow.agent_id) ?? undefined)
              : undefined,
        }
        await executeAgentsSerial(
          io,
          queuedCmd.sessionId,
          [agent],
          queuedTrigger,
          queuedCmd.traceId,
          queuedCmd.depth
        )
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
          traceId: uuid(),
          depth: 0, // 重启恢复按用户顶层语义执行（不消耗 mention 配额）
          pendingTriggers: [],
        }
        const traceId = cmd.traceId

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
 * 1. 目标 agent 有被中断/进行中的 execution_log（同一触发消息）→ 跳过该 agent。
 *    这是与 recoverInterruptedExecutions 的职责切分：有执行日志的 agent 由
 *    路径 2 按日志逐 agent 恢复，此处再调度会造成确定性串行双跑
 *    （路径 2 执行中槽位 busy → dispatch 入队 → completeExecution 弹队列再执行一遍）
 * 2. 目标 agent 已回复（回复写库后、finalize 前被杀的场景）→ 跳过该 agent
 * 3. 无 API key 的 agent → 跳过（与 recoverInterruptedExecutions 一致）
 *
 * 执行配对：dispatch 只标 busy（槽位管理，见 executeAgentCommand 注释——实际
 * LLM 推理由 connector 触发），此处与 SEND_MESSAGE/recoverInterruptedExecutions
 * 同款补 executeAgentsSerial 配对调用，否则恢复的消息永久卡 busy 不回复。
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

        // 幂等防线①（职责切分）：同一触发消息下该 agent 有被中断（server_restart）
        // 或进行中（本启动内路径 2 恢复已插入）的 execution_log → 归
        // recoverInterruptedExecutions 逐 agent 恢复，此处跳过。否则两条恢复路径
        // 都调度同一条消息：路径 2 已把槽位标 busy，此处 dispatch 会把命令入队，
        // 路径 2 completeExecution 弹队列再执行一遍——确定性串行双跑。
        const interruptedLogs = new Set(
          execLogsRepo
            .getLogsByTriggerMessage(row.id)
            .filter(
              (l) =>
                l.status === 'running' ||
                (l.status === 'failed' && l.error_message === 'server_restart')
            )
            .map((l) => l.agent_id)
        )

        // 幂等防线②：已回复的 agent 不再调度（防重启后重复执行）
        const toDispatch = executable.filter(
          (a) =>
            !interruptedLogs.has(a.id) &&
            !messagesRepo.hasAgentRepliedAfter(a.id, row.session_id, fullRow.created_at)
        )

        if (toDispatch.length === 0) {
          log.info('跳过恢复：目标 agent 均已回复或已有执行日志', { messageId: row.id })
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

        const traceId = uuid()

        log.warn('恢复队列消息', {
          messageId: row.id,
          sessionId: row.session_id,
          agents: toDispatch.map((a) => a.name),
          traceId,
        })

        await dispatch(row.session_id, msg, toDispatch, traceId)
        // 配对执行：dispatch 只标 busy（槽位管理），实际 LLM 推理由 connector 触发
        // （executeAgentCommand 注释）。不配对则恢复的消息永久卡 busy 不回复、队列
        // 永不排空——与 SEND_MESSAGE（dispatch + executeAgentsSerial）及
        // recoverInterruptedExecutions（executeAgentCommand + executeAgentsSerial）同款
        await executeAgentsSerial(io, row.session_id, toDispatch, msg, traceId, 0)
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
 * 角色判断基于 agents 表 role 字段（而非硬编码名称/ID/skillModules）：
 *   - role === 'reviewer' → 审查者
 *   - 其他 role（store/implementer/vision/unknown）→ coder（需要被审查）
 *
 * 结论判断基于 IRON_LAWS_REVIEWER 强制输出的结构化标记：
 *   - ✅可合并 → 通过，循环结束
 *   - ⚠️建议修改 / ❌需重做 → 需要继续循环
 *
 * @returns 系统指令字符串，不需要时返回 null
 */
export function buildReviewLoopHint(
  agent: { name: string; role?: string },
  relevantMessages: Array<{
    role: string
    agent_id: string | null
    content: string
    mentions: string | null
  }>
): string | null {
  // 审查者自己不需要被注入（role === 'reviewer' 的 agent 是审查者）
  if (agent.role === 'reviewer') return null

  // 找最近一条来自审查者且 @mention 当前 agent 的消息
  for (let i = relevantMessages.length - 1; i >= 0; i--) {
    const m = relevantMessages[i]
    if (m.role !== 'agent' || !m.agent_id) continue

    // 检查发送者是否是审查者（基于 role 字段）
    const senderRow = agentsRepo.getAgentById(m.agent_id)
    if (!senderRow) continue
    if (senderRow.role !== 'reviewer') continue

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
export function buildHandoffTriggerHint(triggerContent: string): string | null {
  if (!triggerContent.startsWith('@店长 请补填以下交接文档')) return null

  const allAgents = agentsRepo.listAllAgents()
  const reviewer = allAgents.find((a) => a.role === 'reviewer')
  if (!reviewer) return null

  return [
    `[系统指令] 你收到了一份交接文档补填请求。`,
    `补填完 Why/Tradeoff/Open Questions 后，在回复末尾行首独占一行 @${reviewer.name} 发起代码审查。`,
  ].join(' ')
}

/**
 * 将 system prompt 中的角色占位符解析为实际 agent 名。
 *
 * 纯函数，无副作用（listAllAgents 为 DB 查询——调用点在 runAgentReply，
 * 该处执行栈内数据库始终就绪）。
 *
 * 占位符语义（全链路角色化设计——prompt 不写死猫名，运行时注入真名）：
 * - @作者 → 本次触发者名（triggerAuthorName 存在才替换，保留旧语义；
 *   用户消息触发时无作者，字面保留与历史行为一致）
 * - @架构师 → store 角色 agent 名；@审查者 → reviewer 角色 agent 名
 *   （角色存在才替换，缺失保留字面——与现状等价，零回归）
 *
 * 注入只发生在 prompt 层：mention 解析（a2a-mentions.ts）保持严格精确匹配，
 * LLM 输出真名后解析自然命中——占位符不替换 = 解析落空 = 静默不触发
 * （b542d24 审查结论分流断链事故根因：吐槽猫输出字面 @架构师，匹配不到
 * 任何会话 agent 名，收口信号从未投递）。正则只匹配 @ 前缀，prompt 中
 * "是项目架构师" 这类无 @ 的叙述不受影响。
 */
export function resolveRolePlaceholders(prompt: string, triggerAuthorName?: string): string {
  let result = prompt
  if (triggerAuthorName) {
    result = result.replace(/@作者/g, `@${triggerAuthorName}`)
  }
  const allAgents = agentsRepo.listAllAgents()
  const architect = allAgents.find((a) => a.role === 'store')
  if (architect) {
    result = result.replace(/@架构师/g, `@${architect.name}`)
  }
  const reviewer = allAgents.find((a) => a.role === 'reviewer')
  if (reviewer) {
    result = result.replace(/@审查者/g, `@${reviewer.name}`)
  }
  return result
}

/**
 * 聚合所有动态上下文指令。
 *
 * 每个 hint 检查一个场景，返回要注入的 system 指令或 null。
 * 新场景只需加一行调用，无需改动 runAgentReply 主流程。
 */
function buildDynamicHints(
  agent: { name: string; role?: string },
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

  // 将 system prompt 中的角色占位符（@作者/@架构师/@审查者）替换为实际 agent 名
  // 使 LLM 能正确输出 @店长 等实际 agent 名——mention 解析是严格精确匹配，
  // 占位符不替换 = 解析落空 = 静默不触发（b542d24 分流断链事故根因）
  const finalSystemPrompt = resolveRolePlaceholders(dynamicSystemPrompt, triggerMsg.authorName)

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

  // 重启请求识别：agent 回复以【重启请求】开头 → 广播附加 messageType（前端渲染按钮组），
  // 并写 .restart-request 文件（state=pending，dev.js 轮询执行重启）。
  // 与 ingest 用户路径同款——88d5f82 只覆盖了用户入口，店长是 agent 走本路径，
  // 此前触发链从未生效（agent 路径盲区）。消息本身仍以 agent role 落库（类型不落库）。
  const isRestartRequest = isRestartRequestContent(fullContent)
  const restartExpiresAt = new Date(Date.now() + RESTART_TTL_MS).toISOString()

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
    ...(isRestartRequest ? { messageType: 'restart_request' as const, restartExpiresAt } : {}),
  }

  // 写请求文件（幂等：已存在跳过——同一时间只保留首个生效请求，防连发覆盖）
  if (isRestartRequest) {
    try {
      createRestartRequest({
        messageId: msgId,
        sessionId,
        reason: extractRestartReason(fullContent),
        createdAt: new Date().toISOString(),
        expiresAt: restartExpiresAt,
        state: 'pending',
      })
    } catch (err: any) {
      // 文件写失败不阻塞消息流（dev.js 轮询读不到时只是不重启，消息与按钮仍在）
      log.warn('restart request file write failed', {
        traceId,
        agentId: agent.id,
        sessionId,
        error: err.message,
      })
    }
  }

  io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, finalMsg)

  // P3: 回复经 replyBus 转发到外部平台（OneBot 出站订阅后发回 QQ 绑定群/私聊）。
  // P4 #3（契约钉死）：此处无条件触发——A2A 互 @ 产生的回复同样走 runAgentReply、
  // 同样全量转发 QQ。语义：猫咖工作过程公开可见（公开营业）；将来若要区分
  // 「直接响应群友」的回复需要链路追踪（哪个回复对应哪条群友消息），复杂度远超收益，不做。
  emitAgentReply({
    id: msgId,
    sessionId,
    agentId: agent.id,
    agentName: agent.name,
    content: fullContent,
  })

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

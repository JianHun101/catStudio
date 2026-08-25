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
import { createLogger } from '../logger.js'
import { gitResetHard, gitCleanWorkingTree, npmUninstall } from '../llm/git-utils.js'
import type { AgentConfig, Message } from '@cat-study/shared'
import { parseJsonArray } from '../utils.js'
import { parseMessageExtra } from '../git/diff-collector.js'
import { ingestUserMessage } from './ingest.js'
import {
  isRestartRequestContent,
  readRestartRequest,
  updateRestartRequest,
  removeRestartRequest,
  readRestartDone,
  removeRestartDone,
} from '../restart-request.js'
import { getRelevantMessages } from '../execution/context.js'
import {
  setRetraction,
  clearRetraction,
  listActiveStreams,
  deleteActiveStream,
  abortAgent,
} from '../execution/state.js'
import { createExecutionEngine, agentHasUsableApiKey } from '../execution/serial.js'
import type { AgentTriggerMsg, ExecutionEngine } from '../execution/serial.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'

// 兼容 re-export（测试/internal/ingest 零改动；第 4 刀调用点迁移完成后收敛）
// 恢复路径本地消费 rowToAgent——re-export 语法不引入模块内绑定，双行同源
import { rowToAgent } from '../execution/row.js'
export { rowToAgent } from '../execution/row.js'
export {
  getActiveStream,
  __test_resetLockState,
  __test_resetMentionCounts,
  __test_resetM1Warned,
  __getMentionCount,
  __setMentionCount,
} from '../execution/state.js'

const log = createLogger('socketio')

/** 模块级 io 实例引用，供路由等模块获取 */
let _io: SocketServer | null = null

/** 模块级 bus 实例（createSocketIO 构造注入；执行链路消费） */
let _bus: (EngineBus & HandoffBus) | null = null

/** 模块级引擎实例（createSocketIO 构造注入；兼容包装与恢复路径消费） */
let _engine: ExecutionEngine | null = null

/** 获取 Socket.IO Server 实例（需在 createSocketIO() 之后调用） */
export function getIO(): SocketServer | null {
  return _io
}

/**
 * 兼容包装（第 3 刀）：存量调用点（ingest/恢复路径/测试）仍传 io 首参——忽略 io，
 * 委托引擎实例。第 4 刀调用点迁移到 engine.executeAgentsSerial 后删除。
 */
export function executeAgentsSerial(
  io: SocketServer,
  sessionId: string,
  agents: AgentConfig[],
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number = 0
): Promise<boolean> {
  void io
  return _engine!.executeAgentsSerial(sessionId, agents, triggerMsg, traceId, depth)
}

/**
 * 生产 MessageBus 适配器（connector 侧唯一实现；判别联合语义以方法形态落位）。
 * 房间路由统一在此：载荷带 sessionId 从载荷取房间；不带（agent 状态/消息更新）为显式首参。
 */
function createSocketBus(io: SocketServer): EngineBus & HandoffBus {
  const room = (sessionId: string) => io.to(`session:${sessionId}`)
  return {
    emitAgentMessage: (msg) => room(msg.sessionId).emit(Events.NEW_MESSAGE, msg),
    // role 恒为 'system'，类型隐含——adapter 补上（前端契约需要 role 字段）
    emitSystemNotice: (n) => room(n.sessionId).emit(Events.NEW_MESSAGE, { ...n, role: 'system' }),
    emitTyping: (u) => room(u.sessionId).emit(Events.AGENT_TYPING, u),
    emitAgentMessageStatus: (sessionId, s) => room(sessionId).emit(Events.MESSAGE_AGENT_STATUS, s),
    emitMessageUpdated: (sessionId, u) => room(sessionId).emit(Events.MESSAGE_UPDATED, u),
    emitContextWindowStats: (stats) =>
      room(stats.sessionId).emit(Events.CONTEXT_WINDOW_STATS, stats),
    emitSessionHandoff: (e) => io.emit(Events.SESSION_HANDOFF, e),
    emitHandoffFailed: (p) => room(p.sessionId).emit(Events.HANDOFF_FAILED, p),
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
  _bus = createSocketBus(io)
  _engine = createExecutionEngine(_bus)

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
          extra: parseMessageExtra(row.extra), // 富文本块（diff 等）；版本不符/损坏 → undefined 纯文本回退
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
      for (const [agentId, stream] of listActiveStreams()) {
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
      setRetraction(data.messageId)
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
        clearRetraction(data.messageId)
        log.error('message retraction failed', {
          sessionId: data.sessionId,
          messageId: data.messageId,
          error: err.message,
        })
      }

      // 撤回成功后：如果该消息没有 Agent 正在执行（全部在排队中被 cancel）
      // → 没有 runAgentReply 会清理标记 → 在此处清理，防止内存泄漏
      if (!isAnyAgentExecutingMessage(data.messageId)) {
        clearRetraction(data.messageId)
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
      const executing = abortAgent(agentId)

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

  // 启动恢复（fire-and-forget，不阻塞启动）：先恢复被打断的执行，再恢复队列
  // 消息——串行化防双跑竞态（此前两条并行：interrupted 未插 running 日志时队列
  // 兜底先调度 → 同一条消息被两条路径各执行一遍）。串行后 interrupted 完整跑完，
  // 漏恢复的 agent 由 recoverQueuedMessages 的洞 B 兜底重调度接住
  void (async () => {
    await recoverInterruptedExecutions(io)
    await recoverQueuedMessages(io)
  })().catch((err) => {
    log.error('startup recovery crashed', { error: (err as Error).message })
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

    // 按会话聚合恢复结果（避免同会话多 agent 刷屏）：恢复重跑 vs 已回复跳过
    // 分开列出，循环结束后统一广播 system 告警（照抄 broadcastRestartDone 范式）
    const recoveredBySession = new Map<string, string[]>()
    const skippedBySession = new Map<string, string[]>()

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

        // 已回复则跳过（防重复执行——重启可能发生在回复写库之后、finalize 之前）。
        // 洞 A 双轨判据：message_id 非空 = 该执行完成时已写回回复 id，精确跳过，
        // 不再把后续其他回复（消息 B）误判成本次回复；NULL（历史记录/被打断未
        // 回复）→ 回退时间窗判据（hasAgentRepliedAfter），兼容老数据防全量重跑
        const alreadyReplied =
          rec.message_id !== null ||
          messagesRepo.hasAgentRepliedAfter(rec.agent_id, rec.session_id, triggerRow.created_at)
        if (alreadyReplied) {
          const name = agentsRepo.getAgentNameById(rec.agent_id) ?? rec.agent_id
          log.info('跳过恢复：agent 已回复', {
            agentId: rec.agent_id,
            triggerId: rec.triggered_by_message_id,
          })
          skippedBySession.set(rec.session_id, [
            ...(skippedBySession.get(rec.session_id) ?? []),
            name,
          ])
          continue
        }

        const agentRow = agentsRepo.getAgentById(rec.agent_id)
        if (!agentRow) continue
        const agent = rowToAgent(agentRow)
        // 无 API key 无法执行（与 executeAgentsSerial 的检查一致；免 key provider 不拦）
        if (!agentHasUsableApiKey(agent)) continue

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

        recoveredBySession.set(rec.session_id, [
          ...(recoveredBySession.get(rec.session_id) ?? []),
          agent.name,
        ])

        await executeAgentsSerial(io, rec.session_id, [agent], triggerMsg, traceId, 0)
      } catch (err: any) {
        log.error('恢复单个执行失败', {
          agentId: rec.agent_id,
          triggerId: rec.triggered_by_message_id,
          error: err.message,
        })
      }
    }

    // 按会话聚合广播打断告警（system 消息，照抄 broadcastRestartDone 范式）：
    // 用户只看到「气泡消失」，此前恢复全程静默——广播让被打断事实可见
    //（两个 Map 的 key 都可能是会话来源：纯跳过场景 recovered 为空）
    const interruptedSessions = new Set([...recoveredBySession.keys(), ...skippedBySession.keys()])
    for (const sessionId of interruptedSessions) {
      // per-session 防御（照抄 broadcastRestartDone per-call try/catch，本函数 per-rec
      // 模式同款）：单会话 insertMessage 抛错（如 getSessionById → insertMessage 的
      // TOCTOU FK 违例）不 abort 其余会话告警——此前靠外层 catch 兜底，一红丢全部
      try {
        const recovered = recoveredBySession.get(sessionId) ?? []
        const skipped = skippedBySession.get(sessionId) ?? []
        if (recovered.length === 0 && skipped.length === 0) continue
        if (!sessionsRepo.getSessionById(sessionId)) continue // 会话已删 → 静默
        const parts: string[] = []
        if (recovered.length > 0) {
          parts.push(`${recovered.join('、')} 的执行在 server 重启时被打断，已自动恢复重跑`)
        }
        if (skipped.length > 0) {
          parts.push(`${skipped.join('、')} 的执行被打断但回复已落库，未重复执行`)
        }
        const content = `⚠️ ${parts.join('；')}`
        const msgId = uuid()
        messagesRepo.insertMessage(msgId, sessionId, 'system', content, '[]', null, null)
        io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
          id: msgId,
          sessionId,
          agentId: null,
          role: 'system',
          content,
          mentions: [],
          createdAt: new Date().toISOString(),
        })
        log.warn('打断恢复广播', { sessionId, content })
      } catch (err: any) {
        // 单会话告警失败只留痕（外层 catch 仍兜底整体崩溃）
        log.warn('打断恢复广播失败', { sessionId, error: err.message })
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
 * 1. 目标 agent 有被中断（server_restart）/进行中（running，串行化后只可能是
 *    启动期间实时执行）的 execution_log（同一触发消息）→ 该 agent 不参与常规
 *    调度（归 recoverInterruptedExecutions 或实时执行）。但仅 server_restart 且
 *    未回复的 agent 会被洞 B 兜底重调度——interrupted 已串行跑完仍挂
 *    server_restart = 漏恢复，不兜底则永久搁浅；running 不兜底（防双跑实时执行）
 * 2. 目标 agent 已回复（回复写库后、finalize 前被杀的场景）→ 跳过该 agent；
 *    全目标已回复 → dispatch_state 归一 done（处理已终结）
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

        const logsByTrigger = execLogsRepo.getLogsByTriggerMessage(row.id)

        // OQ1 幂等防线④（完成路径守卫的配套）：多目标消息 A 直跑完成、B 排队时，
        // completeExecution 保持 dispatch_state=queued（守卫见 dispatch/index.ts
        // completeExecution）——重启恢复此处捞到该消息，若把已完成目标也重派会
        // 双执行。execution_logs 上 status='completed' 的目标 = 该目标已为此消息
        // 完整执行过 → 跳过不重派；无 completed 行的目标（B）正常调度。
        // （logsByTrigger 已在 :1527 取全量，completed 集从既有数据派生，零新增 SQL）
        const completedSet = new Set(
          logsByTrigger.filter((l) => l.status === 'completed').map((l) => l.agent_id)
        )

        // 无 API key 无法执行（与 recoverInterruptedExecutions 一致；免 key provider 不拦）
        const executable = targets.filter((a) => agentHasUsableApiKey(a) && !completedSet.has(a.id))

        if (completedSet.size > 0) {
          log.info('恢复跳过已完成目标（OQ1 部分完成消息：保持 queued 的兄弟已跑完）', {
            messageId: row.id,
            sessionId: row.session_id,
            completedAgents: [...completedSet].map(
              (id) => agents.find((a) => a.id === id)?.name ?? id
            ),
          })
        }

        // 幂等防线①（职责切分）：同一触发消息下该 agent 有被中断（server_restart）
        // 或进行中（running——串行化后此处只可能是启动期间实时执行）的
        // execution_log → 归对应路径，此处不调度。否则两条恢复路径都调度同一条
        // 消息：路径 2 已把槽位标 busy，此处 dispatch 会把命令入队，路径 2
        // completeExecution 弹队列再执行一遍——确定性串行双跑。
        const interruptedLogs = new Set(
          logsByTrigger
            .filter(
              (l) =>
                l.status === 'running' ||
                (l.status === 'failed' && l.error_message === 'server_restart')
            )
            .map((l) => l.agent_id)
        )
        // 洞 B 漏恢复判据：仅 server_restart 记录——running 可能是实时执行，
        // 兜底重调度若含 running 会把实时执行双跑（串行化后路径 2 已完整跑完，
        // 不会残留 running 恢复记录）
        const serverRestartLogs = new Set(
          logsByTrigger
            .filter((l) => l.status === 'failed' && l.error_message === 'server_restart')
            .map((l) => l.agent_id)
        )

        // 幂等防线②：已回复的 agent 不再调度（防重启后重复执行）
        const repliedSet = new Set(
          executable
            .filter((a) =>
              messagesRepo.hasAgentRepliedAfter(a.id, row.session_id, fullRow.created_at)
            )
            .map((a) => a.id)
        )
        const toDispatch = executable.filter(
          (a) => !interruptedLogs.has(a.id) && !repliedSet.has(a.id)
        )
        // 洞 B 兜底：interrupted 恢复漏掉的 agent（server_restart 日志 + 未回复）
        // 补位重调度。串行化后语义：interrupted 已完整跑完，仍挂 server_restart
        // 且未回复 = 漏恢复（误判已回复/恢复失败），不兜底则永久搁浅
        const stranded = executable.filter(
          (a) => serverRestartLogs.has(a.id) && !repliedSet.has(a.id)
        )
        const dispatchTargets = [...stranded, ...toDispatch]

        if (dispatchTargets.length === 0) {
          // 洞 B：跳过 ≠ 撒手不管——此前跳过分支不归一 dispatch_state，消息
          // 永久 queued/running 搁浅，每次启动都被 getPendingMessages 捞出来空转。
          // 全目标已回复 = 处理已终结 → 归一 done
          if (executable.length > 0 && repliedSet.size === executable.length) {
            messagesRepo.setDispatchState(row.id, 'done')
            log.info('跳过恢复：目标 agent 均已回复，dispatch_state 归一 done', {
              messageId: row.id,
              sessionId: row.session_id,
            })
          } else {
            log.info('跳过恢复：目标 agent 均已回复或已有执行日志', { messageId: row.id })
          }
          continue
        }

        if (stranded.length > 0) {
          log.warn('恢复队列消息：interrupted 漏恢复的 agent 兜底重调度', {
            messageId: row.id,
            sessionId: row.session_id,
            agents: stranded.map((a) => a.name),
          })
        }

        // 槽位初始化（dispatch 对未知 slot 直接跳过，不初始化不调度）
        for (const a of dispatchTargets) {
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
          agents: dispatchTargets.map((a) => a.name),
          traceId,
        })
        // 合并触发持久化（明写丢失为已知噪声）：B 合并的 pendingTriggers 是内存态
        // （dispatch 模块 agentQueues），重启后不可恢复——重建的命令恒为空。从
        // messages 反查"同 session 未处理 @ 触发"无法区分合并触发与白名单拦截
        // （两者 dispatch_state 均为 NULL），误恢复会把被拦 mention 复活执行——
        // 故不恢复，依赖用户消息重放（replayStuckUserMessages）与 A2A 重新触发兜底
        log.info('恢复的命令 pendingTriggers 为空（B 合并为内存态，重启后丢失——已知噪声）', {
          messageId: row.id,
          sessionId: row.session_id,
        })

        await dispatch(row.session_id, msg, dispatchTargets, traceId)
        // 配对执行：dispatch 只标 busy（槽位管理），实际 LLM 推理由 connector 触发
        // （executeAgentCommand 注释）。不配对则恢复的消息永久卡 busy 不回复、队列
        // 永不排空——与 SEND_MESSAGE（dispatch + executeAgentsSerial）及
        // recoverInterruptedExecutions（executeAgentCommand + executeAgentsSerial）同款
        await executeAgentsSerial(io, row.session_id, dispatchTargets, msg, traceId, 0)
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

// ─── 静默丢重放：从未被调度的用户消息补派 ─────────────

/** 重放时窗（分钟）：落库超过该时长仍无任何调度痕迹的用户消息 → 补派候选 */
export const REPLAY_STUCK_WINDOW_MINUTES = 30

/**
 * 静默丢重放扫描：周期补派"落库但从未被调度"的用户消息。
 * 16:09/02:24 案例：@ 消息 INSERT 成功但 ingest 在 dispatch 之前崩溃/异常退出——
 * dispatch_state 保持 NULL、无任何 execution_log 引用，消息永久搁浅（恢复路径
 * recoverQueuedMessages 只捞 queued/running，NULL 不在其列）。
 *
 * 判据（只扫 NULL，不扫 queued/running——语义详见
 * messages.getUndispatchedUserMessagesOlderThan 注释）：role='user' +
 * dispatch_state IS NULL + 无 execution_log 引用 + 超 REPLAY_STUCK_WINDOW_MINUTES。
 * 有执行行存在性检查（NOT EXISTS）防重复补派——补派后必产生 execution_log，
 * 下轮扫描天然排除。
 *
 * 无有效目标（会话已删/成员无 API key/mentions 命中非成员）→ dispatch_state 归一
 * done（terminal：处理已终结，防每轮空转重复补派——recoverQueuedMessages 同款）。
 */
export async function replayStuckUserMessages(io: SocketServer): Promise<void> {
  try {
    const stuck = messagesRepo.getUndispatchedUserMessagesOlderThan(REPLAY_STUCK_WINDOW_MINUTES)
    if (stuck.length === 0) return

    log.warn('静默丢重放：发现从未被调度的用户消息', { count: stuck.length })

    for (const row of stuck) {
      try {
        const sessionRow = sessionsRepo.getSessionById(row.session_id)
        if (!sessionRow) {
          // 会话已删——消息成孤儿，归一 done 防每轮空转
          messagesRepo.setDispatchState(row.id, 'done')
          log.info('重放跳过：会话已删', { messageId: row.id, sessionId: row.session_id })
          continue
        }

        // 补填风暴根治方向 2：同 task_id 已有 agent 回复 → 消息事实上已被执行
        // （批量答复场景兄弟消息无独立 execution_log，NULL 面扫描会误判静默丢）→
        // 归一 done 不补派，防每轮空转（recoverQueuedMessages 同款 terminal 语义）。
        // task_id NULL → 退化现状（宁可不挡也不误伤真静默丢）。
        if (row.task_id && messagesRepo.hasAgentReplyByTaskId(row.session_id, row.task_id)) {
          messagesRepo.setDispatchState(row.id, 'done')
          log.warn('重放跳过：同 task_id 已有 agent 回复', {
            messageId: row.id,
            sessionId: row.session_id,
            taskId: row.task_id,
          })
          continue
        }

        const mentions = JSON.parse(row.mentions || '[]') as string[]
        const agentIds: string[] = JSON.parse(sessionRow.agent_ids || '[]')
        const agents = agentIds
          .map((id: string) => {
            const r = agentsRepo.getAgentById(id)
            return r ? rowToAgent(r) : null
          })
          .filter(Boolean) as AgentConfig[]

        const targets =
          mentions.length > 0 ? agents.filter((a) => mentions.includes(a.name)) : agents
        const executable = targets.filter((a) => agentHasUsableApiKey(a))

        if (executable.length === 0) {
          // 无有效目标（@ 了非成员/成员无 API key/空会话）→ 归一 done（terminal）
          messagesRepo.setDispatchState(row.id, 'done')
          log.info('重放跳过：无有效执行目标，dispatch_state 归一 done', {
            messageId: row.id,
            sessionId: row.session_id,
            mentioned: mentions,
          })
          continue
        }

        for (const a of executable) {
          if (!getAgentState(a.id)) initAgentSlot(a.id)
        }

        const msg: Message = {
          id: row.id,
          sessionId: row.session_id,
          agentId: null,
          role: 'user',
          content: row.content,
          mentions,
          taskId: row.task_id || undefined,
          images: row.images ? (JSON.parse(row.images) as string[]) : undefined,
          createdAt: row.created_at,
        }

        const traceId = uuid()
        log.warn('静默丢重放：补派执行', {
          messageId: row.id,
          sessionId: row.session_id,
          agents: executable.map((a) => a.name),
          traceId,
        })

        await dispatch(row.session_id, msg, executable, traceId)
        // 配对执行（dispatch 只标 busy——槽位管理，实际 LLM 推理由 connector 触发；
        // 不配对则补派消息卡 busy 不回复——recoverQueuedMessages 同款契约）
        await executeAgentsSerial(io, row.session_id, executable, msg, traceId, 0)
      } catch (err: any) {
        log.error('重放单条消息失败', { messageId: row.id, error: err.message })
      }
    }
  } catch (err: any) {
    log.error('replayStuckUserMessages failed', { error: err.message })
  }
}

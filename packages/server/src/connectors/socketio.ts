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
import { Events, estimateTokens } from '@cat-study/shared'
import type { SendMessageAck, ToolCallInfo, StreamSegment } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import type { MessageRow } from '../db/repository/index.js'
import { v4 as uuid } from 'uuid'
import {
  getAllAgentStates,
  getAgentState,
  cancelQueuedCommand,
  clearAgentQueue,
  isAnyAgentExecutingMessage,
  setAgentStateBridge,
  setSystemMessageBridge,
} from '../dispatch/index.js'
import { createLogger } from '../logger.js'
import { gitResetHard, gitCleanWorkingTree, npmUninstall } from '../llm/git-utils.js'
import { parseJsonArray, parseJsonValue } from '../utils.js'
import { parseMessageExtra } from '../git/diff-collector.js'
import { ingestUserMessage } from './ingest.js'
import {
  readRestartRequest,
  updateRestartRequest,
  removeRestartRequest,
  readRestartDone,
  removeRestartDone,
  RESTART_CONFIRMED_TTL_MS,
} from '../restart-request.js'
import type { RestartRequestFile } from '../restart-request.js'
import { getRelevantMessages } from '../execution/context.js'
import { createExecutionEngine } from '../execution/serial.js'
import type { StreamState } from '../execution/state.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'
import {
  setExecutionEngine,
  setExecutionBus,
  getExecutionEngine,
  getExecutionBus,
  __test_reset as __test_resetRegistry,
} from '../execution/registry.js'
import { recoverInterruptedExecutions, recoverQueuedMessages } from '../execution/recovery.js'

// 兼容 re-export（测试消费；恢复路径本地消费已随第 4 刀迁 execution/recovery.ts）
export { rowToAgent } from '../execution/row.js'

const log = createLogger('socketio')

/**
 * onAny 兜底诊断白名单（三层缺陷根治①）：Socket.IO 对无 handler 的 incoming event 静默丢弃
 * （不报错、不落日志、不 ack）——旧 server 收到前端新事件（版本错配）时问题完全不可见。
 * 白名单 = 全部已注册 client→server 事件 + Socket.IO 保留/内建事件名；白名单外的自定义事件打 warn。
 * 注意：只列 client→server 事件——onAny 只截获 incoming packet，server→client 广播不经此路径。
 */
const KNOWN_CLIENT_EVENTS = new Set<string>([
  Events.JOIN_SESSION,
  Events.LEAVE_SESSION,
  Events.SEND_MESSAGE,
  Events.MESSAGE_RETRACT,
  Events.RESTART_CONFIRM,
  Events.RESTART_CANCEL,
  Events.AGENT_INTERRUPT,
  Events.TOGGLE_BROADCAST,
  'get-agent-states', // 既有 handler 用裸字符串注册（非 Events 常量）
  // Socket.IO 保留/内建事件：onAny 是否截获随版本而异，白名单双保险防误报
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
  'error',
])

/** 模块级 io 实例引用，供路由等模块获取 */
let _io: SocketServer | null = null

/**
 * 兼容委托：internal.ts / socketio.test.ts 经注册表单例引擎寻址状态——
 * 引擎由 createSocketIO 初始化并注册（生产路径恒先于任何请求存在），未初始化时
 * no-op/undefined（模块级导入安全）。
 */
export function getActiveStream(agentId: string): StreamState | undefined {
  return getExecutionEngine()?.getActiveStream(agentId)
}
export function __test_resetLockState(): void {
  getExecutionEngine()?.__test_resetLockState()
}
export function __test_resetMentionCounts(): void {
  getExecutionEngine()?.__test_resetMentionCounts()
}
export function __test_resetM1Warned(): void {
  getExecutionEngine()?.__test_resetM1Warned()
}
export function __getMentionCount(traceId: string, agentId: string): number {
  return getExecutionEngine()?.__getMentionCount(traceId, agentId) ?? 0
}
export function __setMentionCount(traceId: string, agentId: string, count: number): void {
  getExecutionEngine()?.__setMentionCount(traceId, agentId, count)
}
/** 测试钩子：卸载引擎注册表（双注册表 fail-fast 断言后的用例间复位） */
export function __test_resetEngine(): void {
  __test_resetRegistry()
  _io = null
}

/** 获取 Socket.IO Server 实例（需在 createSocketIO() 之后调用） */
export function getIO(): SocketServer | null {
  return _io
}

/**
 * 生产 MessageBus 适配器（connector 侧唯一实现；判别联合语义以方法形态落位）。
 * 房间路由统一在此：载荷带 sessionId 从载荷取房间；不带（agent 状态/消息更新）为显式首参。
 */
function createSocketBus(io: SocketServer): EngineBus & HandoffBus {
  const room = (sessionId: string) => io.to(`session:${sessionId}`)
  return {
    emitMessage: (msg) => room(msg.sessionId).emit(Events.NEW_MESSAGE, msg),
    // role 恒为 'system'，类型隐含——adapter 补上（前端契约需要 role 字段）
    emitSystemNotice: (n) => room(n.sessionId).emit(Events.NEW_MESSAGE, { ...n, role: 'system' }),
    emitTyping: (u) => room(u.sessionId).emit(Events.AGENT_TYPING, u),
    emitAgentMessageStatus: (sessionId, s) => room(sessionId).emit(Events.MESSAGE_AGENT_STATUS, s),
    emitMessageUpdated: (sessionId, u) => room(sessionId).emit(Events.MESSAGE_UPDATED, u),
    emitContextWindowStats: (stats) =>
      room(stats.sessionId).emit(Events.CONTEXT_WINDOW_STATS, stats),
    emitSessionHandoff: (e) => room(e.oldSessionId).emit(Events.SESSION_HANDOFF, e),
    emitHandoffFailed: (p) => room(p.sessionId).emit(Events.HANDOFF_FAILED, p),
  }
}

export function createSocketIO(httpServer: HttpServer): SocketServer {
  // 单例 fail-fast（3.5 刀，热重启双注册表防护）：引擎实例持有全量执行态
  // （run 注册表/撤回标记/锁计数/配额），进程内重复创建 = 双注册表双驱动——
  // 仓库没吃过的新失败类，宁可炸在启动也不静默双跑。测试用例间先 __test_resetEngine()
  if (getExecutionEngine()) {
    throw new Error(
      'createSocketIO 重复调用：ExecutionEngine 已初始化（热重启双注册表防护；测试先 __test_resetEngine()）'
    )
  }

  const io = new SocketServer(httpServer, {
    cors: {
      origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
      methods: ['GET', 'POST'],
    },
  })

  _io = io
  const bus = createSocketBus(io)
  setExecutionBus(bus)
  setExecutionEngine(createExecutionEngine(bus))

  io.on('connection', (socket) => {
    log.info('client connected', { socketId: socket.id })

    // 未注册事件兜底诊断（三层缺陷根治①）：Socket.IO 对无 handler 的 incoming event 静默丢弃
    // ——前端 emit 了本 server 未注册的事件（版本错配）时零日志零 ack。
    // onAny 把「静默丢弃」变成「可诊断」：白名单（已注册 + 保留事件）之外的自定义事件打 warn。
    socket.onAny((event: string, ..._args: unknown[]) => {
      if (!KNOWN_CLIENT_EVENTS.has(event)) {
        log.warn('unhandled socket event (silently dropped by Socket.IO)', {
          socketId: socket.id,
          event,
        })
      }
    })

    // ─── Session: join ───────────────────────────

    socket.on(Events.JOIN_SESSION, (sessionId: string) => {
      socket.join(`session:${sessionId}`)
      log.info('joined session', { socketId: socket.id, sessionId })

      // 推送该 Session 的历史消息（转为 camelCase）— 批量发送，避免逐条渲染闪烁
      const rows = messagesRepo.getSessionHistory(sessionId)

      // 重启请求文件（存在时其 expiresAt 是历史消息按钮过期的权威值——刷新后按钮状态正确）
      const restartReq = readRestartRequest()

      // 历史恢复只给「当前生效请求」的消息附加重启类型——按钮只属于当前请求，
      // 其他历史重启消息不附加（幽灵按钮：点它必报「已失效」）。
      // 判据 = 请求文件精确匹配（sessionId + messageId），不以正文文本前缀为辅——
      // 文件由该消息的完成点写入（ingest 用户路径 / reply agent 路径），messageId 是
      // 比文本前缀更严的判据；结构化通道（request_user_action）下 agent 正文不含
      // 「【重启请求】」字样，文本检测那一层是纯冗余且会误杀（刷新后按钮消失的真根因）。
      // 幽灵按钮防护由精确匹配 + 前端 restartExpiresAt 过期守卫共同承担。
      const isActiveRestart = (row: MessageRow): boolean => {
        if (!restartReq) return false
        return restartReq.sessionId === row.session_id && restartReq.messageId === row.id
      }

      const historyMessages = rows.map((row: MessageRow) => {
        const msgImages: string[] = parseJsonArray(row.images)
        const isRestart = isActiveRestart(row)
        const msgExtra = parseMessageExtra(row.extra) // 富文本块（diff 等）；版本不符/损坏 → undefined 纯文本回退
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
          // 工具调用记录：tool_content JSON 列反序列化（三通道分离后历史独立工具卡渲染）
          toolContent: parseJsonValue<ToolCallInfo[]>(row.tool_content),
          // 回复分段（segments JSON 列反序列化）——历史折叠块还原生成期交错顺序的权威来源；
          // 老消息（无 segments 列数据）→ undefined，前端退化 thinking_content+tool_content 两块
          segments: parseJsonValue<StreamSegment[]>(row.segments),
          extra: msgExtra,
          createdAt: row.created_at.replace(' ', 'T') + 'Z',
          // 历史恢复同样携带重启类型（前端按钮渲染依据；DB 不存类型，请求文件是唯一事实源）
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
      for (const [agentId, stream] of getExecutionEngine()!.listActiveStreams()) {
        if (stream.sessionId === sessionId && agentIds.includes(agentId)) {
          socket.emit(Events.AGENT_TYPING, {
            sessionId,
            agentId,
            messageId: stream.messageId,
            content: stream.content,
            // 结构化分段随恢复补推（前端按 kind 渲染）；旧 server 无 segments → 省略，前端退化
            ...(stream.segments ? { segments: stream.segments } : {}),
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
      async (
        data: {
          sessionId: string
          content: string
          mentions: string[]
          taskId?: string
          images?: string[]
        },
        ack?: (res: SendMessageAck) => void
      ) => {
        // 摄入管线（校验/重定向/落库/广播/调度/执行）已提取为共享核心，
        // 与 REST POST /api/messages 同构——两入口共用 ingest.ts。
        const result = await ingestUserMessage({
          sessionId: data.sessionId,
          content: data.content,
          mentions: data.mentions || [],
          images: data.images,
          taskId: data.taskId,
          // T-F 入口主闸：前端 SEND_MESSAGE = 人类入口（用户消息天然是链首轮）→ 允许空锚，
          // 不受 agent 投递的锚必填约束。
          origin: 'human',
          saveMemory: true,
        })
        // ack 回传（C5）：成功带服务端生成的 messageId（客户端只消费不生成 id，安全性第一）；
        // 失败带 effectiveSessionId（用请求的 sessionId）+ error 透传。ack 可选——旧前端不传不报错。
        if (result.ok) {
          ack?.({
            ok: true,
            messageId: result.messageId,
            effectiveSessionId: result.effectiveSessionId,
            ...(result.redirectedFrom ? { redirectedFrom: result.redirectedFrom } : {}),
          })
        } else {
          ack?.({ ok: false, effectiveSessionId: data.sessionId, error: result.error })
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
      getExecutionEngine()!.setRetraction(data.messageId)
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
        getExecutionEngine()!.clearRetraction(data.messageId)
        log.error('message retraction failed', {
          sessionId: data.sessionId,
          messageId: data.messageId,
          error: err.message,
        })
      }

      // 撤回成功后：如果该消息没有 Agent 正在执行（全部在排队中被 cancel）
      // → 没有 runAgentReply 会清理标记 → 在此处清理，防止内存泄漏
      if (!isAnyAgentExecutingMessage(data.messageId)) {
        getExecutionEngine()!.clearRetraction(data.messageId)
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
          // 文案不写分钟数：pending(10min) 与 confirmed(35min) 走同一分支，
          // 写死任一方都会在另一方路径上失真（web chat.ts:434 同句待后续单收口）
          socket.emit(Events.ERROR, { message: '重启请求已过期，请店长重新发起' })
          socket.emit(Events.RESTART_STATUS, {
            sessionId: req.sessionId,
            messageId: req.messageId,
            state: 'expired',
          })
          ack?.({ ok: false, reason: 'expired' })
          return
        }
        // 回推的 expiresAt 须与文件一致——pending→confirmed 走续期后的值（见下），
        // 已 confirmed 走文件现值（不重复续期，防无限延长）
        let confirmedExpiresAt = req.expiresAt
        if (req.state === 'pending') {
          // pending → confirmed：dev.js 轮询到 confirmed 且新鲜即执行重启。
          // 确认动作同时续期：confirmed 的 TTL 从确认时刻起算，覆盖 dev.js 的忙碌
          // 等待窗（pending 的 10min 从 createdAt 起算，会被长执行吃光 → 超时静默掉单；
          // 语义与取值依据见 restart-request.ts RESTART_CONFIRMED_TTL_MS 注释）
          const confirmed: RestartRequestFile = {
            ...req,
            state: 'confirmed',
            expiresAt: new Date(Date.now() + RESTART_CONFIRMED_TTL_MS).toISOString(),
          }
          updateRestartRequest(confirmed)
          confirmedExpiresAt = confirmed.expiresAt
          log.info('restart request confirmed', {
            messageId: confirmed.messageId,
            sessionId: confirmed.sessionId,
            expiresAt: confirmed.expiresAt,
          })
        }
        // 已 confirmed → 幂等重推（重复点击不报错）
        socket.emit(Events.RESTART_STATUS, {
          sessionId: req.sessionId,
          messageId: req.messageId,
          state: 'confirmed',
          expiresAt: confirmedExpiresAt,
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
    // OQ3 双端 session 化：payload 带 sessionId?（旧客户端只发 agentId → fallback
    // 现状）。带 sessionId 时按 (agentId, sessionId) 精确寻址——并发双会话只停
    // 目标会话（目标 run abort + 目标队列清空 + 目标房间收提示），兄弟会话零影响

    socket.on(Events.AGENT_INTERRUPT, (data: { agentId: string; sessionId?: string }) => {
      const { agentId, sessionId } = data || {}
      if (!agentId) return

      const engine = getExecutionEngine()!
      // 目标会话定位：带 sessionId → engine.getSlot 精确寻址（无槽位 = 该 agent
      // 在该会话无调度状态 → 幂等 no-op）；无（旧客户端）→ fallback 取第一个
      // 匹配槽位的 sessionId（现状语义）
      const targetSessionId = sessionId
        ? engine.getSlot(agentId, sessionId)
          ? sessionId
          : undefined
        : getAgentState(agentId)?.sessionId
      if (!targetSessionId) return // 未知 agent/会话 → 幂等无操作

      // 先清队列再 abort：abort 后执行循环的 completeExecution(false) 收口时
      // 队列已空不会弹出新命令（中断后 agent 不自动重启执行，新消息才重新触发）。
      // 带 sessionId → 只清目标会话队列；无 → 清全部会话（旧语义）
      const cleared = sessionId
        ? engine.clearAgentQueue(agentId, sessionId)
        : clearAgentQueue(agentId)
      // 中断当前执行——executeAgentsSerial 的 abort 检查发现 signal.aborted 后
      // 跳过 A2A 解析、走失败路径收口（execution_logs 记 failed）。
      // 带 sessionId → 精确 abort 目标会话 run；无 → abort 全部 run（旧语义）
      const executing = engine.abortAgent(agentId, sessionId)

      if (cleared > 0 || executing) {
        log.info('agent interrupted by user', {
          agentId,
          sessionId: targetSessionId,
          cleared,
        })
        // 系统消息进目标会话房间（带 sessionId 精确；无 → 实际在跑的会话）
        const agentRow = agentsRepo.getAgentById(agentId)
        const name = agentRow?.name || agentId
        io.to(`session:${targetSessionId}`).emit(Events.NEW_MESSAGE, {
          id: uuid(),
          sessionId: targetSessionId,
          agentId,
          role: 'system',
          content: `🐱 ${name} 已停止（用户中断）`,
          mentions: [],
          createdAt: new Date().toISOString(),
        })
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
  // C1 v3：桥接签名简化为单参 state（原 (_event, state)——事件名恒为 agent-status）
  setAgentStateBridge((state) => {
    if (state.sessionId) {
      io.to(`session:${state.sessionId}`).emit(Events.AGENT_STATUS, state)
    }
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
    await recoverInterruptedExecutions(getExecutionBus()!)
    await recoverQueuedMessages(getExecutionBus()!)
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

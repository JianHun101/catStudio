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
import { createLogger } from '../logger.js'
import {
  gitCommit,
  gitResetHard,
  gitCleanWorkingTree,
  npmUninstall,
  getSessionWorktreePath,
} from '../llm/git-utils.js'
import type { AgentConfig, LLMMessage, Message } from '@cat-study/shared'
import {
  parseMentionsFromReply,
  detectUnknownHandle,
  detectInlineMentions,
} from './a2a-mentions.js'
import { filterAllowedMentions, allowedTargetsDescription } from '../dispatch/mention-policy.js'
import { consumeRouteSignals } from '../llm/route-signals.js'
import { parseJsonArray } from '../utils.js'
import { recordReviewVerdict } from '../eval/verdict-parser.js'
import { maybeScoreSample } from '../eval/sampler.js'
import { collectCommitDiffs, parseMessageExtra } from '../git/diff-collector.js'
import { updateRunningSummary } from '../summarizer/index.js'
import { ingestUserMessage } from './ingest.js'
import {
  isRestartRequestContent,
  readRestartRequest,
  updateRestartRequest,
  removeRestartRequest,
  readRestartDone,
  removeRestartDone,
} from '../restart-request.js'
import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  resolveRolePlaceholders,
  buildDynamicHints,
} from '../execution/hints.js'
import {
  getRelevantMessages,
  parseCompressedSummaries,
  countReadySummaries,
  lastReadySummary,
  buildSummaryBlockMessage,
  applySummaryReplace,
  SUMMARY_KEEP_RECENT,
  SUMMARY_MIN_TOKENS,
  SUMMARY_PRE_COMPRESS_RATIO,
  SUMMARY_FORCE_COMPRESS_RATIO,
  SUMMARY_BLOCK_TOKENS,
} from '../execution/context.js'
import { runAgentReply } from '../execution/reply.js'
import {
  setRetraction,
  clearRetraction,
  listActiveStreams,
  deleteActiveStream,
} from '../execution/state.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'

const log = createLogger('socketio')

/** 不消费 apiKey 的 provider（本地认证，key 留空合法）——no-key 守卫须按 provider 区分 */
const NO_API_KEY_PROVIDERS = new Set(['opencode', 'ollama'])

/** agent 是否具备可用的 API key：免 key provider 恒 true；否则要求非空且非占位符 */
function agentHasUsableApiKey(agent: Pick<AgentConfig, 'llmProvider' | 'llmApiKey'>): boolean {
  if (NO_API_KEY_PROVIDERS.has(agent.llmProvider)) return true
  return !!agent.llmApiKey && agent.llmApiKey !== 'sk-your-api-key-here'
}

/** 模块级 io 实例引用，供路由等模块获取 */
let _io: SocketServer | null = null

/** 模块级 bus 实例（createSocketIO 构造注入；执行链路消费） */
let _bus: (EngineBus & HandoffBus) | null = null

// 回复路径状态 Map 已迁入 execution/state.ts（第 2 刀）——
// internal.ts 经此 re-export 零改动（getActiveStream 是状态 accessor，非 connector 职责）
export { getActiveStream } from '../execution/state.js'

/** 正在执行的 Agent → 其 AbortController（停止按钮中断思考用）。
 *  executeAgentsSerial 创建后注册、Promise.race 结束路径（正常/异常）清理。
 *  abortController 原本是循环内局部变量外部摸不到——升级为模块级注册表后，
 *  AGENT_INTERRUPT handler 才能跨会话按 agentId 全局寻址（用户手动改 DB 的场景）。 */
const activeAborts = new Map<string, AbortController>()
/** M1 防线频控：agentId → 上次告警时间戳（5 分钟内同猫不重复告警） */
const m1WarnedAt = new Map<string, number>()
const M1_WARN_INTERVAL_MS = 5 * 60 * 1000

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
    llmMaxTokens: row.llm_max_tokens, // 迁移 DEFAULT 2048 回填存量行；透传点据此决定是否传 ChatOptions.maxTokens
    llmTemperature: row.llm_temperature,
    llmEnvExtra: row.llm_env_extra, // 迁移 DEFAULT '{}' 回填存量行；registry 构造时宽容解析
    // 老库迁移默认 'unknown'（不在 AgentRole 里）——白名单对未知角色放行
    role: (row.role || undefined) as AgentConfig['role'],
  }
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

/** Agent 执行锁引用计数——每个 Claude 执行体 acquire/release 严格配对，
 *  归零才删 .agent-busy。改造前 lockAcquired 是 executeAgentsSerial 的循环外
 *  变量：同消息 @ 多 Claude agent 时 A 完成后即删锁、B 执行期间无锁 →
 *  dev.js 误判空闲触发重启打断 B（派活单审查发现，实施必做项顺带根治） */
let lockRefCount = 0

/** 获取 Agent 执行锁（引用计数 +1；首次创建文件——文件已存在则不覆盖，
 *  可能是异常残留或并发实例持有，保留内容只计引用） */
function acquireLock(): void {
  lockRefCount++
  if (lockRefCount === 1 && !existsSync(LOCK_FILE)) {
    writeFileSync(LOCK_FILE, String(process.pid))
    log.info('agent busy lock acquired', { pid: process.pid })
  }
}

/** 释放 Agent 执行锁（引用计数 -1；归零才删除文件） */
function releaseLock(): void {
  if (lockRefCount <= 0) {
    log.warn('agent busy lock released with no holders', { lockRefCount })
    return
  }
  lockRefCount--
  if (lockRefCount === 0 && existsSync(LOCK_FILE)) {
    unlinkSync(LOCK_FILE)
    log.info('agent busy lock released')
  }
}

/** 测试钩子：重置锁引用计数并清理锁文件（仅测试用，生产路径不调用） */
export function __test_resetLockState(): void {
  lockRefCount = 0
  if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
}

// ─── Agent Execution（同消息并发调度） ────────────

/** 同消息并发执行的 agent 数上限——批内 Promise.allSettled 并发启动，批间串行。
 *  语义变化（方案级决策已过审）：广播模式下并行 agent 互不见彼此回复
 *  （A2A 接力不受影响——触发前提是回复已落库）；前端显示顺序 = 完成顺序 */
const CONCURRENT_AGENTS_PER_MESSAGE = 3

/** 运行时长心跳间隔——headless 黑盒适配器（dsh 等）在子进程 close 前一个 chunk
 *  都不 yield，AGENT_TYPING 全程空转、前端「回复中」标签静止；周期重发
 *  MESSAGE_AGENT_STATUS（status 不变、startedAt 相同）让前端显示「回复中 · 已 N 秒」
 *  N 递增，判断进程是否还活着。放 runAgentReply 层：所有适配器统一受益，
 *  零新增 socket 事件、零新增 chunk 契约。 */

/** 触发消息的静态形状（executeAgentsSerial / executeOneAgent 共用） */
type AgentTriggerMsg = {
  id: string
  content: string
  mentions: string[]
  taskId?: string
  authorName?: string
}

/** 追踪每个 Agent 在同一 traceId 下被 @ 的次数（防止无限循环） */
const mentionCounts = new Map<string, number>()

/** M1 频控：同猫 5 分钟内只告警一次（返回是否应告警） */
function maybeWarnM1(agentId: string): boolean {
  const now = Date.now()
  const last = m1WarnedAt.get(agentId) || 0
  if (now - last < M1_WARN_INTERVAL_MS) return false
  m1WarnedAt.set(agentId, now)
  return true
}

/** 测试钩子：清空 M1 频控时间戳（测试用例间隔离） */
export function __test_resetM1Warned(): void {
  m1WarnedAt.clear()
}

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

/**
 * 队列 drain：执行 completeExecution 弹出的下一命令（补审计 + 出队反查作者 +
 * B 合并点名 + 递归执行）。抽取为共享函数——成功路径（completeExecution 后立即
 * 调用）与 catch 路径（异常后弹出的命令不丢弃）两处复用。
 * @returns 传入的 claudeRan OR 本次 drain 是否执行过 Claude 适配器
 */
async function drainQueuedCommand(
  io: SocketServer,
  agent: AgentConfig,
  queuedCmd: DispatchCommand,
  claudeRan: boolean
): Promise<boolean> {
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
  // 出队反查触发作者（恢复路径 recoverInterruptedExecutions 同款）：
  // A2A 审查结论 @回请求人依赖 triggerAuthorName 例外判定（mention-policy），
  // 缺失则 undefined 与写死名比对失败 → 白名单误拦（10:38 事故根因）；
  // 反查失败（消息已删/非 agent）→ undefined，与现状等价不拦截
  const triggerMeta = messagesRepo.getMessageByIdOnly(queuedCmd.triggerMessageId)
  const triggerRow = triggerMeta
    ? messagesRepo.getMessageById(queuedCmd.triggerMessageId, queuedCmd.sessionId, triggerMeta.role)
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
  return (
    (await executeAgentsSerial(
      io,
      queuedCmd.sessionId,
      [agent],
      queuedTrigger,
      queuedCmd.traceId,
      queuedCmd.depth
    )) || claudeRan
  )
}

/**
 * 单 agent 执行体（原 executeAgentsSerial for 循环体抽出）。
 * 纯 per-agent 自包含，无共享可变状态——并发批内多个执行体可同时运行。
 * 返回 true = 本执行体（或其 A2A 子链 / 队列 drain）执行过 Claude 适配器
 * （Claude 会编辑源文件——顶层收尾据此决定是否需要脏文件清理）。
 *
 * 约束（派活单钉死）：
 * - 状态检查必须留在第一个 await 之前——批启动瞬间所有执行体同步完成
 *   检查，无中间态（若检查在 await 后，批内执行体可能交错看到彼此刚
 *   标 busy 的中间状态，双执行防护失效）
 * - 锁引用计数配对：needsLock（Claude）→ acquire，finally release——
 *   并发批内多个 Claude 执行体同时持有（计数 1→2→…），归零才删
 *   .agent-busy（dev.js 重启保护全程有效）
 * - A2A 递归（触发前提是回复已落库）与队列 drain 保持原语义，天然串行
 */
async function executeOneAgent(
  io: SocketServer,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number,
  /** 会话成员 id 与名（A2A mention 解析用——原 for 循环体的闭包变量，抽函数后显式传入） */
  sessionAgentIds: string[],
  sessionAgentNames: string[]
): Promise<boolean> {
  // 状态检查（同步——必须留在第一个 await 之前，见上方约束）
  const state = getAgentState(agent.id)
  if (!state || state.status !== 'busy') return false
  // 跨会话忙碌：agent 正在其他 session 执行，已入队，不在此执行
  if (state.sessionId !== sessionId) return false
  // 只执行"本次 dispatch 标记的执行"：agent 正在处理其他消息时（本消息在
  // FIFO 队列中等待排空），必须跳过——否则同一条消息会被立即执行一次、
  // 队列排空再执行一次，产生重复回复（08:43:15 双补填事故根因）。
  // completeExecution 弹出队列时会更新 currentTriggerMessageId，
  // 排空路径自然通过此检查。
  if (state.currentTriggerMessageId !== triggerMsg.id) return false

  // 检查 API Key（免 key provider 如 opencode 本地认证，不拦）
  if (!agentHasUsableApiKey(agent)) {
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
    // P0-2 同款守卫补全：completeExecution 弹出队列命令后不丢弃——无 key 的
    // 排队命令同样会落入 running+无执行日志的幽灵态（slot 卡 busy，恢复机制
    // 全盲）。弹出后补 drain：子链在 no-key 检查处逐个 completeExecution 弹
    // 下一个，直到队列空（每条发一次配置提示，执行日志逐条落库）
    const nextCmd = await completeExecution(agent.id, true, { traceId })
    if (nextCmd) {
      try {
        await drainQueuedCommand(io, agent, nextCmd, false)
      } catch (e: any) {
        log.error('drain failed after no-api-key completion (queue item stuck)', {
          agentId: agent.id,
          triggerMessageId: nextCmd.triggerMessageId,
          error: e.message,
        })
      }
    }
    return false
  }

  // 获取 Agent 执行锁（仅 Claude 适配器需要——它会编辑源文件）。
  // 引用计数配对：acquire 后所有出口走 finally release——并发批内多个
  // Claude 执行体同时持有（计数 1→2→…），归零才删文件（派活单必改点 2；
  // 改造前 lockAcquired 是循环外变量——A 完成即删锁、B 执行期间无锁的
  // dev.js 误重启隐患顺带根治）
  const needsLock = agent.llmProvider === 'claude'
  if (needsLock) acquireLock()
  try {
    let claudeRan = needsLock
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
        runAgentReply(_bus!, sessionId, agent, triggerMsg, traceId, abortController.signal),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            abortController.abort()
            reject(new Error(`执行超时 (${AGENT_HARD_TIMEOUT_MS / 1000}s)`))
          }, AGENT_HARD_TIMEOUT_MS)
        ),
      ])
    } catch (err: any) {
      abortController.abort()
      deleteActiveStream(agent.id) // 确保任何异常都 kill 子进程
      log.error('agent execution failed', {
        agentId: agent.id,
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
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
      // 异常路径也不丢弃弹出的队列命令（4eb3143 只补了外层 catch，此处同款补全）：
      // completeExecution 弹出后命令已出队，返回值若丢弃 → 弹出的命令永久
      // running + 无执行日志（幽灵 slot：dispatch_state=running 但 execution_logs
      // 无记录、槽位卡 busy，recoverQueuedMessages 仅启动时跑，三恢复机制全盲）——
      // LLM 失败/超时 + 有排队命令时必现（2026-08-11 26 分钟假 running 实锤同族
      // 机制：弹出后延迟/丢弃执行，用户侧"店长一直阻塞"）。try/catch 隔离——
      // drain 自身失败不掩盖原异常
      const nextCmd = await completeExecution(agent.id, false, {
        errorMessage: err.message || 'unknown error',
        traceId,
      })
      if (nextCmd) {
        try {
          claudeRan = await drainQueuedCommand(io, agent, nextCmd, claudeRan)
        } catch (e: any) {
          log.error('drain failed after execution error (queue item stuck)', {
            agentId: agent.id,
            triggerMessageId: nextCmd.triggerMessageId,
            error: e.message,
          })
        }
      }
      return claudeRan
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
      return claudeRan
    }

    // 释放槽位并检查队列（P0-2 修复：不再丢弃 completeExecution 返回值）。
    // 成功路径写回回复 id（洞 A 判据：execution_logs.message_id 非空即已回复，
    // 重启恢复精确跳过，不再被后续其他回复的时间窗误判）。撤回窗（Window ②/③）
    // 提前返回的 ghost id 不可达——撤回必删触发消息与 execution_logs（MESSAGE_RETRACT
    // handler），恢复入口 getMessageByIdOnly 直接 continue
    const queuedCmd = await completeExecution(agent.id, true, {
      traceId,
      replyMessageId: reply.msgId,
    })

    // W2 L2 评估采样：fire-and-forget——不 await、不占 slot、不进 dispatch 主链，
    // 失败静默（内部 catch）。只对 DS 族猫回复采样（ollama 图测猫不评估）
    maybeScoreSample(agent, sessionId, reply.msgId)

    // 队列命令优先执行（FIFO）：completeExecution 已弹出下一命令并标 busy/running，
    // 此处立即补执行（drain）——先于下方 A2A 派发，否则弹出命令会干等当前回复的
    // A2A 嵌套链跑完（d448413a 案例：07:00:02 弹出、07:05:54 才执行——被两层
    // A2A await 拖 5.9 分钟，'running' 状态干挂 + 槽位"忙碌"假象）
    if (queuedCmd) {
      claudeRan = await drainQueuedCommand(io, agent, queuedCmd, claudeRan)
    }

    // 执行成功后记录 mention 计数（防止无限 agent-to-agent 循环——
    // 同一 trace 内某 agent 真实完成 ≥MAX 次 A2A 执行后，不再被重新调度。
    // 计数的是实际执行次数而非进入执行循环的次数，因此未执行的
    // 排队任务/审查闭环 mention 不消耗配额（阈值内不受限）。
    // 仅 depth>0（A2A 链路）计数——用户顶层触发（depth=0）不消耗配额，
    // 否则用户 @ 触发的执行会把计数推满，后续同 trace 的 A2A @ 被误杀）
    // 并发化后注：A2A 调度点的「检查+预留」（下方原子段）与本处实际执行
    // 双计——预留是并发互斥机制（防双双放行），本处计真实执行（配额确认）
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

    // M3 防线：文本行首 @ 了会话外未知名 → warn 不路由（MCP 信号侧的
    // 未知名由 internal.ts 预校验 4xx 拦截回模型，此处只覆盖文本通道）
    const unknownHandle = detectUnknownHandle(reply.content, sessionAgentNames)
    if (unknownHandle) {
      log.warn('agent-to-agent mention: unknown handle', {
        traceId,
        fromAgent: agent.name,
        handle: unknownHandle,
      })
    }

    // MCP 结构化路由信号（汇入式合并，契约 5）：流中途 post_message 声明的
    // 目标与文本行首 @ 取并集（Set 去重）——一次 dispatch、配额单计数。
    // messageId 标签：只消费本流 msgId 的信号——abort 残留（旧流 msgId）
    // 天然失效，无需清理逻辑
    const signalNames = consumeRouteSignals(sessionId, agent.id, reply.msgId)
      .flatMap((s) => s.targetCats)
      .filter((name) => name !== agent.name)
    const routeNames = [...new Set([...mentionedNames, ...signalNames])]
    if (routeNames.length > 0) {
      // 找到被 @ 的 Agent 配置（提前——白名单判定需要目标角色）
      const allMentionedAgents = sessionAgentIds
        .map((id: string) => {
          const row = agentsRepo.getAgentById(id)
          return row ? rowToAgent(row) : null
        })
        .filter(
          (a: AgentConfig | null): a is AgentConfig => a !== null && routeNames.includes(a.name)
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

        // W3 L3 审查结论解析钩子（reviewer 角色门 + 锚定行首标记）。
        // subject 从作用域 allowedNames 直取——不读 DB mentions 列（此刻落库的是
        // '[]'，上一行才刚写回）；routeNames/allowedNames 为空（全剥除）时不进入
        // 本块，钩子天然不触发。recordReviewVerdict 内部写操作独立 try/catch，
        // DB 异常静默丢弃——审查链主流程零阻塞（契约边界）
        if (agent.role === 'reviewer') {
          recordReviewVerdict({
            messageId: reply.msgId,
            sessionId,
            reviewerAgentId: agent.id,
            content: reply.content,
            targets: policy.allowed.map((a) => ({ name: a.name, isStore: a.role === 'store' })),
          })
        }

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
        // 配额原子段（同步，中间无 await——Node 单线程天然原子）：
        // 目标「检查 + 预留」同段完成。并发化后若检查与计数分离（原
        // filter 只读不改），批内 A、B 执行体同时检查到 count=4 会双双
        // 放行、目标 C 实际被调度超限 1（派活单必改点 1）——先到者的
        // 预留写先落，后到者读到已预留值被拦截。
        // 预留 = 调度即计数：目标执行成功的递增（上方 completeExecution
        // 后，depth>0）仍在——双计让防护阈值更早触达，正常审查链深度
        // （2-3）远在阈值（MAX_MENTIONS_PER_AGENT=5）内不受影响；预留后
        // 未执行（跳过/失败）的配额不扣回——阈值 5 下影响边际，防循环优先
        const limitedAgents: AgentConfig[] = []
        for (const a of policy.allowed) {
          const mk = getMentionKey(traceId, a.id)
          const count = mentionCounts.get(mk) || 0
          if (count >= MAX_MENTIONS_PER_AGENT) continue
          mentionCounts.set(mk, count + 1) // 预留配额
          limitedAgents.push(a)
        }
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

          // 调度并递归执行——A2A 入队命令带 depth+1（>0 才会消耗 mention 配额）。
          // 子链返回值冒泡：子链若有 Claude 执行，顶层收尾同样需要脏文件清理
          await dispatch(sessionId, agentTrigger, limitedAgents, traceId, depth + 1)
          claudeRan =
            (await executeAgentsSerial(
              io,
              sessionId,
              limitedAgents,
              { ...agentTrigger, authorName: agent.name },
              traceId,
              depth + 1
            )) || claudeRan
        }
      }
    } else {
      // M1 防线：回复末段含行内 @已知猫名但最终无路由 → 静默变可见。
      // 嵌句 @ 是路由静默丢失的实锤形态（ds@「位置：@店长 请收口」mentions=[]）；
      // 本防线只在全链路（post_message + 文本行首 @）都失败时响应，正常路由零打扰
      const inlineMentions = detectInlineMentions(reply.content, sessionAgentNames)
      if (inlineMentions.length > 0 && maybeWarnM1(agent.id)) {
        log.warn('agent reply has inline mention but no route', {
          traceId,
          fromAgent: agent.name,
          inlineMentions,
        })
        io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
          id: uuid(),
          sessionId,
          agentId: agent.id,
          role: 'system',
          content: `🐱 ${agent.name} 回复中检测到嵌句 @（${inlineMentions.join('、')}）但未形成路由——@猫名 必须行首独占一行，或调用 post_message 工具投递下一棒。`,
          mentions: [],
          createdAt: new Date().toISOString(),
        })
      }
    }

    return claudeRan
  } catch (err: any) {
    // P0-1 修复：外层 try/catch 防止 completeExecution 或 agent-to-agent
    // dispatch 中的任何异常导致执行体崩溃、槽位永久卡死
    log.error('post-execution error — releasing slot', {
      agentId: agent.id,
      agentName: agent.name,
      error: err.message,
      traceId,
    })
    const nextCmd = await completeExecution(agent.id, false, {
      errorMessage: err.message || 'post-execution error',
      traceId,
    }).catch(() => {
      log.error('critical: completeExecution itself failed', {
        agentId: agent.id,
        traceId,
      })
      return undefined
    })
    // 异常路径也不丢弃弹出的队列命令：completeExecution 弹出后命令已出队，
    // 不补执行则 'running' 状态永久搁浅（只能等下次重启恢复）。try/catch 隔离——
    // drain 自身失败不掩盖原异常，槽位释放不受影响。
    // F2：drain 返回值并入返回——drain 子链若执行过 Claude 适配器（编辑源文件），
    // 顶层 anyClaude 判定必须看到（修复前返回值被丢弃 + return needsLock →
    // 非 claude 主执行下脏文件清理被跳过）
    let drainClaudeRan = needsLock
    if (nextCmd) {
      try {
        drainClaudeRan = await drainQueuedCommand(io, agent, nextCmd, needsLock)
      } catch (e: any) {
        log.error('drain failed after post-execution error (queue item stuck)', {
          agentId: agent.id,
          triggerMessageId: nextCmd.triggerMessageId,
          error: e.message,
        })
      }
    }
    return drainClaudeRan
  } finally {
    if (needsLock) releaseLock()
  }
}

export async function executeAgentsSerial(
  io: SocketServer,
  sessionId: string,
  agents: AgentConfig[],
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number = 0
): Promise<boolean> {
  // 深度限制：防止 Agent 间无限循环
  if (depth >= MAX_AGENT_DISPATCH_DEPTH) {
    log.warn('agent dispatch depth limit reached', { traceId, depth })
    return false
  }

  // 获取 session 中所有 Agent 名称（用于 mention 解析）
  const sessionAgentIds = sessionsRepo.getSessionAgentIds(sessionId)
  const sessionAgentNames: string[] = sessionAgentIds
    .map((id: string) => agentsRepo.getAgentNameById(id))
    .filter((n): n is string => n !== undefined)

  // 分批并发：批内 CONCURRENT_AGENTS_PER_MESSAGE 个执行体同时启动（状态检查
  // 在各自第一个 await 前同步完成，批启动瞬间无中间态），批间串行。
  // allSettled 只兜未预期 throw——执行体异常已自收口（completeExecution(false)），
  // 单个执行体崩溃不中断整批其余执行（原 for 循环中一个 throw 会中断后续）
  let anyClaude = false
  for (let i = 0; i < agents.length; i += CONCURRENT_AGENTS_PER_MESSAGE) {
    const batch = agents.slice(i, i + CONCURRENT_AGENTS_PER_MESSAGE)
    const results = await Promise.allSettled(
      batch.map((agent) =>
        executeOneAgent(
          io,
          sessionId,
          agent,
          triggerMsg,
          traceId,
          depth,
          sessionAgentIds,
          sessionAgentNames
        )
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) anyClaude = true
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
      // 自动 git commit（忽略非 git 仓库或无改动的情况）。
      // 会话 worktree 存在时提交到 worktree（落会话分支，提交隔离）；
      // 无 worktree（存量会话/降级）→ 提交主工作区 dev，行为与现网一致
      const worktreeCwd = getSessionWorktreePath(sessionId)
      const commitHash = worktreeCwd
        ? gitCommit(`catstudy [${triggerMsg.id}]`, { cwd: worktreeCwd })
        : gitCommit(`catstudy [${triggerMsg.id}]`)
      if (commitHash) {
        // 将 commit hash 写回 execution_logs（本轮所有相关日志）
        execLogsRepo.updateExecutionLogCommitHash(triggerMsg.id, commitHash)
      }
    } finally {
      if (anyClaude) {
        // 清理 Agent 执行遗留的脏文件（编辑中断、未追踪的新文件等）——
        // 仅当本次调度树有 Claude 执行过（只有它会编辑源文件；A2A 子链 /
        // 队列 drain 的 Claude 执行经返回值冒泡计入）。成功路径 git commit
        // 后工作区应为干净状态，此检查为无操作。
        // 锁文件已由各执行体 finally 配对释放（引用计数归零时删除）——
        // 此处不再操作锁（派活单必改点 2：保留会让引用计数变负）
        try {
          // 脏文件检查/清理作用到会话 worktree（存在时）——猫的执行环境在
          // worktree，脏文件只在 worktree 里产生；主工作区不受猫影响无需清理
          const cleanCwd = getSessionWorktreePath(sessionId) ?? process.cwd()
          const status = execSync('git status --porcelain', {
            cwd: cleanCwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim()
          if (status) {
            log.warn('dirty workspace after agent execution, resetting', {
              traceId,
              cwd: cleanCwd,
            })
            execSync('git checkout -- .', { cwd: cleanCwd, stdio: 'ignore' })
            execSync('git clean -fd', { cwd: cleanCwd, stdio: 'ignore' })
          }
        } catch {
          // 非 git 仓库，忽略
        }
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

  return anyClaude
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

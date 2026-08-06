/**
 * 消息摄入共享核心（ingest）——Socket.IO 与 REST 两个入口共用的消息注入管线。
 *
 * 与 SEND_MESSAGE / POST /api/messages 原有逻辑完全同构：
 * 图片守卫 → session 校验 → handoff 重定向 → INSERT → 广播 → agent 解析 → 调度 → 串行执行。
 * 入口只保留通道专属包装：socketio 的 ERROR emit、REST 的 status 映射与响应体。
 *
 * 循环依赖说明：ingest.ts ← socketio.ts（入口调用 ingestUserMessage），
 * ingest.ts → socketio.ts（取 getIO / rowToAgent / executeAgentsSerial）。
 * 所有对 socketio.js 导出的访问都在函数体内（运行时），ESM 循环引用安全。
 */
import { v4 as uuid } from 'uuid'
import { Events, estimateTokens } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
} from '../db/repository/index.js'
import type { AgentConfig } from '@cat-study/shared'
import { getIO, rowToAgent, executeAgentsSerial } from './socketio.js'
import { dispatch, initAgentSlot, getAgentState, completeExecution } from '../dispatch/index.js'
import { resolveHandoffTarget } from '../handoff/index.js'
import { saveMessageMemory } from '../memory/index.js'
import { createLogger } from '../logger.js'
import {
  RESTART_TTL_MS,
  createRestartRequest,
  extractRestartReason,
  isRestartRequestContent,
} from '../restart-request.js'

const log = createLogger('ingest')

export interface IngestInput {
  sessionId: string
  content: string
  mentions?: string[]
  images?: string[]
  taskId?: string
  /** 是否将消息写入向量记忆库。socketio 入口传 true（保持现有行为），
   *  REST 入口不传（外部工具注入的管道消息不进记忆库，保持现状）。 */
  saveMemory?: boolean
  /** 跳过重启请求识别与请求文件写入（消息本身照常摄入）。REST 测试调用
   *  （x-test-call: 1 头）传 true——测试消息含重启请求格式不应写
   *  .restart-request（会顶掉店长真实请求 10 分钟）。socketio 入口不传。 */
  skipRestartRequest?: boolean
}

export type IngestResult =
  | { ok: true; messageId: string; effectiveSessionId: string; redirectedFrom?: string }
  | { ok: false; status: number; error: string }

/**
 * 摄入一条用户消息：校验 → 重定向 → 落库 → 广播 → 调度 → 串行执行。
 * 返回结构化结果，由入口映射为通道专属响应（socketio ERROR emit / REST status）。
 */
export async function ingestUserMessage(input: IngestInput): Promise<IngestResult> {
  const { sessionId, content } = input
  const mentions = input.mentions ?? []
  const taskId = input.taskId || undefined
  // 图片守卫：必须 data:image/ 前缀、单张 base64 ≤ 3MB、最多 4 张
  // （前端已压缩到最长边 1280，此处仅防滥用）
  const images = (input.images || [])
    .filter(
      (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length <= 3 * 1024 * 1024
    )
    .slice(0, 4)

  const msgId = uuid()
  const traceId = uuid() // 贯穿全链路的请求追踪 ID

  log.info('message received', {
    traceId,
    sessionId,
    mentions,
    contentLen: content.length,
    contentTokens: estimateTokens(content),
    imageCount: images.length,
  })

  // 1. 先检查 session 是否存在（在 INSERT 前，避免 FK 约束抛异常）
  const sessionRow = sessionsRepo.getSessionById(sessionId)
  if (!sessionRow) {
    log.warn('session not found', { sessionId })
    return { ok: false, status: 404, error: 'Session not found' }
  }

  // 1.5 已交接会话路由兜底（方案 A）：消息重定向到最新真实子会话。
  //     命中时通知旧房间前端切换（复用现有 SESSION_HANDOFF 机制），
  //     后续写入/广播/dispatch 全部走子会话，旧会话不再膨胀。
  const handoffTarget = resolveHandoffTarget(sessionId)
  const effectiveSessionId = handoffTarget?.newSessionId ?? sessionId

  // 2. 写入消息（先落库、后通知切换——写入失败时前端不应收到切换信号）
  const mentionsJson = JSON.stringify(mentions)
  try {
    messagesRepo.insertUserMessage(
      msgId,
      effectiveSessionId,
      content,
      mentionsJson,
      taskId || null,
      JSON.stringify(images)
    )
  } catch (err: any) {
    // 审查反馈 #1：resolveHandoffTarget 返回与 INSERT 之间，子会话可能被
    // 并发 DELETE /api/sessions/:id 删除 → FK 异常。socketio 入口的 async handler
    // 若放任异常会成为 unhandledRejection（Node v15+ 默认崩进程），必须就地捕获
    // 并结构化返回——与 dispatch 的 try/catch 同款防护。
    log.error('insert user message failed', {
      sessionId,
      effectiveSessionId,
      traceId,
      error: err.message,
    })
    return { ok: false, status: 500, error: '消息写入失败，请重试' }
  }

  if (handoffTarget) {
    log.info('message redirected to handoff child session', {
      oldSessionId: sessionId,
      newSessionId: effectiveSessionId,
    })
  }

  // 重启请求识别：店长消息以【重启请求】开头 → 广播附加 messageType（前端渲染按钮组），
  // 并写 .restart-request 文件（state=pending，dev.js 轮询执行重启）。
  // 消息本身仍以 user role 落库（DB role 有 CHECK 约束，类型不落库）。
  // skipRestartRequest（REST x-test-call 测试调用）→ 跳过识别，消息照常摄入
  // 但不带 messageType、不写请求文件（防测试消息顶掉店长真实请求）。
  const isRestartRequest = !input.skipRestartRequest && isRestartRequestContent(content)
  const restartExpiresAt = new Date(Date.now() + RESTART_TTL_MS).toISOString()

  const msg = {
    id: msgId,
    sessionId: effectiveSessionId,
    agentId: null,
    role: 'user' as const,
    content,
    images: images.length > 0 ? images : undefined,
    mentions,
    taskId,
    createdAt: new Date().toISOString(),
    ...(isRestartRequest ? { messageType: 'restart_request' as const, restartExpiresAt } : {}),
  }

  // 写请求文件（幂等：已存在跳过——同一时间只保留首个生效请求，防店长连发覆盖）
  if (isRestartRequest) {
    try {
      createRestartRequest({
        messageId: msgId,
        sessionId: effectiveSessionId,
        reason: extractRestartReason(content),
        createdAt: new Date().toISOString(),
        expiresAt: restartExpiresAt,
        state: 'pending',
      })
    } catch (err: any) {
      // 文件写失败不阻塞消息流（dev.js 轮询读不到时只是不重启，消息与按钮仍在）
      log.warn('restart request file write failed', {
        sessionId: effectiveSessionId,
        traceId,
        error: err.message,
      })
    }
  }

  // 3. 广播到 Session 房间（重定向时是子会话房间，并向旧房间发 SESSION_HANDOFF）
  const io = getIO()
  if (io) {
    io.to(`session:${effectiveSessionId}`).emit(Events.NEW_MESSAGE, msg)
    if (handoffTarget) {
      io.to(`session:${sessionId}`).emit(Events.SESSION_HANDOFF, handoffTarget)
    }
  }

  // 4. 触发调度（重定向时从子会话取 agents——子会话的 agent_ids
  //    可能已被 PATCH 更新，与旧会话不再一致）

  // 重定向时子会话行（兜底：子会话被删时回退旧会话行）
  const targetRow =
    effectiveSessionId === sessionId
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

  // 将用户消息保存为向量记忆（异步不阻塞消息流；REST 入口按 input.saveMemory 保持现状）
  if (input.saveMemory) {
    saveMessageMemory(
      effectiveSessionId,
      content,
      msgId,
      validAgents.map((a) => a.id)
    ).catch((err) => {
      log.warn('记忆存储失败', { error: err.message, traceId })
    })
  }

  // 初始化 Agent 槽位并存储
  for (const a of validAgents) {
    if (!getAgentState(a.id)) {
      initAgentSlot(a.id)
    }
  }

  // 5. 调度 + 执行（捕获内部异常防止消息入口崩溃）
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
  const targets =
    mentions.length > 0 ? validAgents.filter((a) => mentions.includes(a.name)) : validAgents

  // 发送 MESSAGE_AGENT_STATUS: queued — 让前端知道消息已被 Agent 接收
  // （重定向时发子会话房间，与 NEW_MESSAGE 一致）
  if (io) {
    for (const a of targets) {
      io.to(`session:${effectiveSessionId}`).emit(Events.MESSAGE_AGENT_STATUS, {
        messageId: msgId,
        agentId: a.id,
        agentName: a.name,
        agentAvatar: a.avatar,
        status: 'queued',
      })
    }
  }

  // 按 FIFO 串行执行（不 await，让多个消息的 Agent 执行可以交错）
  if (io && targets.length > 0) {
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

  return {
    ok: true,
    messageId: msgId,
    effectiveSessionId,
    ...(handoffTarget ? { redirectedFrom: sessionId } : {}),
  }
}

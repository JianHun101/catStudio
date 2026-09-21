/**
 * 消息摄入共享核心（ingest）——Socket.IO 与 REST 两个入口共用的消息注入管线。
 *
 * 与 SEND_MESSAGE / POST /api/messages 原有逻辑完全同构：
 * 图片守卫 → session 校验 → handoff 重定向 → 投递契约主闸 → INSERT → 广播
 * → agent 解析 → 调度 → 串行执行。
 * （重定向在闸门**之前**：结构推导须按消息真正落地的会话查，见 N-2。）
 * 入口只保留通道专属包装：socketio 的 ERROR emit、REST 的 status 映射与响应体。
 *
 * 断环说明（第 4 刀）：ingest 不再 import connector——广播/执行经执行注册表
 * 单例寻址（getExecutionBus / getExecutionEngine，getIO 同款服务定位惯例），
 * rowToAgent 直接取 execution/row.js。bus/engine 未注册（引擎未初始化）时
 * 返回 null → 守卫跳过（与旧 getIO→null 同语义）。
 *
 * 断环说明（T-1 增补）：`isAgentAuthoredTrigger` **同样取 execution/row.js**，
 * 不是 serial.js。判据若从 serial 取值，本文件这条边会当场闭合出两个模块环
 * （F1 审查实测：原在 serial.ts 时 `serial→flow-advance→ingest→serial` 与
 * `worktree-fanin→ingest→serial→reply→worktree-fanin`，父提交 0 环）。
 * 判据住叶模块 row.js（只有 `import type`）⇒ 谁 import 它都不成环。
 * ⚠️ 环计数**只认增量不认绝对值**（F8）：绝对边数随检测器口径浮动（同一棵树
 * 「排除 `*.test.ts`」309 条 /「含 `*.test.ts`」640 条，两套都对）；能复现的是
 * 本笔引入或消除的那 ±1 条。
 * ⚠️ 本文件的**每一条** execution/* 值导入都受这条约束（取值方必须是叶或下游），
 * 加新边前先跑一遍环检测（本仓 lint 只跑 tsc，没有环守卫）。
 */
import { v4 as uuid } from 'uuid'
import { estimateTokens } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
} from '../db/repository/index.js'
import type { AgentConfig } from '@cat-study/shared'
import { rowToAgent, isAgentAuthoredTrigger } from '../execution/row.js'
import { getExecutionEngine, getExecutionBus } from '../execution/registry.js'
import { resolveHandoffTarget } from '../handoff/index.js'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'
import {
  RESTART_TTL_MS,
  createRestartRequest,
  extractRestartReason,
  isRestartRequestContent,
} from '../restart-request.js'

const log = createLogger('ingest')

/** 链内角色声明（T-F）。**对账位、不是锚**——它答不了"返到哪条链"（那仍从锚继承来），
 *  只用来抓两个今天正在静默通过的矛盾：声明 `first` 但链已存在（静默挂错链）、
 *  声明 `followup` 但锚为空（静默开新链）。 */
export type ChainType = 'first' | 'followup'

/** 结构推导三态。`unknown` = 查询失败/查不动（降级：以声明为准，不拒绝、不静默改归属）。 */
export type ChainExistence = 'exists' | 'absent' | 'unknown'

export interface IngestInput {
  sessionId: string
  content: string
  mentions?: string[]
  images?: string[]
  taskId?: string
  /** 投递来源（T-F 入口主闸）。`human` = 人/前端入口（SEND_MESSAGE / OneBot），
   *  天然是链首轮，**允许空锚**；`agent` = 工具/服务端入口（REST 注入 / 契约③），
   *  **强制携带链锚**。
   *
   *  为什么判据落在**入参**而不是落库列：T-E 之后 `messages.task_id` 由服务端自动
   *  生成，落库列**恒非空**——按 DB 列判"agent 缺锚"是一条永远判不出来的死码。
   *  唯一能回答"调用方漏没漏带锚"的地方是入参本身。
   *
   *  **必填**（T-F 返工 N-4 / spec D15，2026-09-10）：原为可选、默认 `'human'`，
   *  但该默认值在**生产上零消费方**（四个入口全部显式标注），只为"未来新入口忘标"
   *  而存在——且它选的是**放行**侧：新入口忘标即静默绕过主闸，与主闸「消灭静默
   *  通过」的目的反向。改必填后忘标 = `tsc` 编译错误（大声炸，不静默放行）。 */
  origin: 'human' | 'agent'
  /** 链内角色声明（审查类投递必填）。见 `ChainType`。 */
  chainType?: ChainType
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

/** 审查类投递 = mentions 里点名了本会话的审查者（role === 'reviewer'）。
 *
 *  基于 role 而非猫名：与 `execution/hints.ts` / `flow-advance` 的角色判据同源，
 *  换猫不用改这里。mentions 里的非猫名（用户手打错字）静默不命中——与 mention
 *  解析层"严格精确匹配"的既有语义一致。 */
export function isReviewDelivery(mentions: string[]): boolean {
  if (mentions.length === 0) return false
  return agentsRepo.listAllAgents().some((a) => a.role === 'reviewer' && mentions.includes(a.name))
}

/** 结构推导：该锚在 messages 表上是否已存在（⟹ 链已存在）。
 *
 *  - 锚为空 → `absent`（无锚即无链，确定，不需要查询）
 *  - 查询异常 → `unknown`（**查不动**，调用方降级为"以声明为准 + 记日志"）
 *
 *  这条查询**只**回答"链在不在"，不回答"锚合不合法"——后者是入参判据的事。 */
export function deriveChainExistence(sessionId: string, anchor?: string): ChainExistence {
  if (!anchor) return 'absent'
  try {
    return messagesRepo.hasMessagesByTaskId(sessionId, anchor) ? 'exists' : 'absent'
  } catch (err: any) {
    log.warn('chain existence probe failed — 降级为以声明为准', {
      sessionId,
      anchor,
      error: messageOf(err),
    })
    return 'unknown'
  }
}

/**
 * 投递契约主闸（T-F）——纯函数，无 I/O（结构推导已由调用方算好传入）。
 *
 * 四条规则，按特异性从高到低：
 *  1. 非 agent 入口 → 放行（人类消息天然是链首轮，允许空锚）
 *  2. 审查类缺 `chainType` → 400（对账位必填）
 *  3. 声明 `followup` 但锚为空 → 400（**漏带锚**：说是链内更新，却给不出链）
 *  4. 声明 `first` 但链已存在 → 400（**静默挂错链**：说是建链，链却在）
 *  5. 其余 agent 投递缺锚 → 400（A3 主闸）
 *
 * 降级（A5）：结构推导 `unknown`（查不动）→ 以声明为准、记日志，**不拒绝**。
 * 方向与 B3 一致——宁可漏拦一次，不可把一条合法投递判死。
 *
 * @returns 拒绝时的 `{status, error}`；放行返回 null
 */
export function buildDeliveryGateError(input: {
  origin?: 'human' | 'agent'
  taskId?: string
  chainType?: ChainType
  isReview: boolean
  /** 结构推导结果。**可空 = 不适用**（本条不需要探针：非 `agent` 入口 / 非审查类 /
   *  未声明 `first`）——与 `'absent'`（**探过了，确认不存在**）是两回事。
   *
   *  N-3 返工：原实现对"不适用"分支传字面量 `'absent'`，用假数据表达"不适用"。
   *  今天读起来等价（`absent` 与 `undefined` 在四条规则下同样放行），但下一个
   *  消费方无从区分"探针说链不存在"与"压根没探"——而这两者的正确处置相反
   *  （前者可拒 `first`，后者不能）。 */
  chainExistence?: ChainExistence
}): { status: number; error: string } | null {
  const { origin, taskId, chainType, isReview, chainExistence } = input
  if (origin !== 'agent') return null

  if (isReview) {
    if (!chainType) {
      return {
        status: 400,
        error: '审查类投递缺 chainType（需声明 first=建链 / followup=链内更新）',
      }
    }
    if (chainType === 'followup' && !taskId) {
      return { status: 400, error: '声明 chainType=followup 但缺链锚——链内更新必须带 task_id' }
    }
    if (chainType === 'first' && chainExistence === 'exists') {
      return { status: 400, error: '声明 chainType=first 但该链已存在——请改用 followup 或修正锚' }
    }
    if (chainType === 'first' && chainExistence === 'unknown') {
      log.warn('chainType=first 且结构推导查不动——以声明为准放行', { taskId })
    }
    if (chainType === 'first' && chainExistence === undefined) {
      // N-3：走到这里 = 调用方**该探针却没探**（`needsProbe` 为真时必传结果）。
      // 行为仍是放行（不把合法投递判死），但把"静默"消掉——这是调用方 bug，
      // 不该像 `unknown`（外部查询失败）那样被当成正常降级。
      log.warn('chainType=first 但调用方未提供结构推导——以声明为准放行（调用方缺探针）', {
        taskId,
      })
    }
  }

  if (!taskId) {
    return { status: 400, error: '缺链锚：agent 投递必须携带 task_id（首轮锚 = 本轮 trace_id）' }
  }
  return null
}

/**
 * 摄入一条用户消息：校验 → 重定向 → 落库 → 广播 → 调度 → 串行执行。
 * 返回结构化结果，由入口映射为通道专属响应（socketio ERROR emit / REST status）。
 */
export async function ingestUserMessage(input: IngestInput): Promise<IngestResult> {
  const { sessionId, content } = input
  const mentions = input.mentions ?? []
  /** 调用方显式传入的锚（REST 注入 / 前端 SEND_MESSAGE / flow-advance 收口提醒）。
   *  可空——首轮空锚由下方 `anchor` 生成，不再是落库的空值。 */
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
  // 链锚（T-E）：首轮锚由服务端生成——显式传入优先，缺省取本轮 traceId。
  // 旧实现落的是调用方的 `taskId || null`：traceId 早在上一行就生成了却没落列，
  // 于是链首锚恒为空，而 episodes / flow-advance / recovery / reply 四处消费方
  // 全按 messages.task_id 查——空锚即静默失配（不是报错，是查不到）。
  // 锚同时进广播 msg（与落库同源）：下游 reply.ts:822 / serial.ts:790 继承读的
  // 就是触发消息的 taskId，两处 `|| traceId` 从此只对存量空锚降级，不再是逃生舱。
  const anchor = taskId || traceId

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

  // 1.2 已交接会话路由兜底（方案 A）：消息重定向到最新真实子会话。
  //     命中时通知旧房间前端切换（复用现有 SESSION_HANDOFF 机制），
  //     后续写入/广播/dispatch 全部走子会话，旧会话不再膨胀。
  //     **N-2 返工：解析前移到闸门之前**——闸门的结构推导与下方 INSERT 必须看
  //     同一个会话。原实现闸门探 `sessionId`（父会话）、写入落 `effectiveSessionId`
  //     （子会话）：已交接会话的投递，链的消息全在子会话，探针在父会话必判
  //     `absent` ⇒「声明 first 但链已存在」**漏拦**（fail-open）。
  //     **不接受**"探针内部再解析一次"——两处解析就是下一个分歧点。
  //     本函数只读无副作用，前移不影响闸门"拒绝时零副作用"的性质。
  const handoffTarget = resolveHandoffTarget(sessionId)
  const effectiveSessionId = handoffTarget?.newSessionId ?? sessionId

  // 1.3 投递契约主闸（T-F）：审查类投递必须带 锚 + chainType；agent 投递必须带锚。
  //     放在 session 校验与路由解析之后（结构推导按**落地会话**查）、INSERT 之前
  //     （拒绝时零副作用）。结构推导只在"审查类 + 声明建链"时才查——其余分支
  //     不需要知道链在不在，传 `undefined`（不适用）而非 `'absent'`（确认不存在）。
  const isReview = isReviewDelivery(mentions)
  const needsProbe = input.origin === 'agent' && isReview && input.chainType === 'first'
  const gateError = buildDeliveryGateError({
    origin: input.origin,
    taskId,
    chainType: input.chainType,
    isReview,
    chainExistence: needsProbe ? deriveChainExistence(effectiveSessionId, taskId) : undefined,
  })
  if (gateError) {
    log.warn('delivery rejected by entry gate', {
      sessionId,
      effectiveSessionId, // 探针查的就是它——N-2 漏拦正是"查的会话 ≠ 写的会话"，日志里必须看得见
      traceId,
      origin: input.origin,
      chainType: input.chainType,
      isReview,
      hasAnchor: !!taskId,
      error: gateError.error,
    })
    return { ok: false, status: gateError.status, error: gateError.error }
  }

  // 2. 写入消息（先落库、后通知切换——写入失败时前端不应收到切换信号）
  const mentionsJson = JSON.stringify(mentions)
  try {
    messagesRepo.insertUserMessage(
      msgId,
      effectiveSessionId,
      content,
      mentionsJson,
      anchor,
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
      error: messageOf(err),
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
    taskId: anchor,
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
        error: messageOf(err),
      })
    }
  }

  // 3. 广播到 Session 房间（重定向时是子会话房间，并向旧房间发 SESSION_HANDOFF）
  const bus = getExecutionBus()
  if (bus) {
    bus.emitMessage(msg)
    if (handoffTarget) {
      bus.emitSessionHandoff(handoffTarget)
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

  // 5. 调度 + 执行——C1 v3 单入口（executeAgentsSerial 内部走 execute(cmd)：
  // 决策(直跑/入队)→token→执行→finally{release+收口+排空}）。槽位由 execute 决策段
  // 惰性创建（不再需要显式 initAgentSlot）。S2 手动兜底已移入 execute 的 finally
  // ——executeOneAgent 逃逸异常时补收口+排空，此处无需再逐槽位释放。
  const targets =
    mentions.length > 0 ? validAgents.filter((a) => mentions.includes(a.name)) : validAgents

  // 发送 MESSAGE_AGENT_STATUS: queued — 让前端知道消息已被 Agent 接收
  // （重定向时发子会话房间，与 NEW_MESSAGE 一致）
  if (bus) {
    for (const a of targets) {
      bus.emitAgentMessageStatus(effectiveSessionId, {
        messageId: msgId,
        agentId: a.id,
        agentName: a.name,
        agentAvatar: a.avatar,
        sessionId: effectiveSessionId,
        status: 'queued',
      })
    }
  }

  // 调度 + 执行（不 await，让多个消息的 Agent 执行可以交错）。异常兜底：
  // execute 的 finally 已保证槽位收口，此处只记日志防未处理 Promise 拒绝
  if (bus && targets.length > 0) {
    getExecutionEngine()!
      // fromAgent：`msg.role` 恒 'user'（本入口落库即 user，含 `origin:'agent'`
      // 的猫间投递——见 :300）⇒ 恒 false = 照常注入。**非判据面**（不进 makeCmd，
      // 执行体重建），填入只为满足 `AgentTriggerMsg.fromAgent` 必填。
      .executeAgentsSerial(
        effectiveSessionId,
        targets as AgentConfig[],
        { ...msg, fromAgent: isAgentAuthoredTrigger(msg.role) },
        traceId
      )
      .catch((err) => {
        log.error('executeAgentsSerial crashed', {
          traceId,
          error: err.message,
        })
      })
  }

  return {
    ok: true,
    messageId: msgId,
    effectiveSessionId,
    ...(handoffTarget ? { redirectedFrom: sessionId } : {}),
  }
}

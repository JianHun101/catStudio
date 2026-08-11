/**
 * Agent 调度引擎。
 *
 * 核心逻辑：
 * 1. 用户消息到达 → 解析 mentions
 * 2. 对每个被 @ 的 Agent，检查槽位
 * 3. 空闲 → 立即执行；忙碌 → 入 FIFO 队列
 * 4. Agent 执行完成 → 检查其私有队列是否有下一项
 */

import type { AgentConfig, AgentRuntimeState, DispatchCommand, Message } from '@cat-study/shared'
import { Channels } from '@cat-study/shared'
import { getRedis } from '../db/redis.js'
import {
  agents as agentsRepo,
  executionLogs as execLogsRepo,
  messages as messagesRepo,
} from '../db/repository/index.js'
import { v4 as uuid } from 'uuid'
import { createLogger } from '../logger.js'
import { classifyError } from '../eval/classify-error.js'

const log = createLogger('dispatch')

// ─── Slot state (in-memory) ─────────────────────────

const agentSlots = new Map<string, AgentRuntimeState>()
const agentQueues = new Map<string, DispatchCommand[]>()

/** 每个 Agent FIFO 队列的最大长度——超出拒绝入队（通知前端，不静默丢弃） */
export const MAX_QUEUE_PER_AGENT = 3

export function initAgentSlot(agentId: string): void {
  agentSlots.set(agentId, {
    agentId,
    sessionId: null,
    status: 'idle',
    queueLength: 0,
    currentTriggerMessageId: null,
  })
  agentQueues.set(agentId, [])
}

export function getAgentState(agentId: string): AgentRuntimeState | undefined {
  return agentSlots.get(agentId)
}

export function getAllAgentStates(): AgentRuntimeState[] {
  return [...agentSlots.values()]
}

// ─── Dispatch ───────────────────────────────────────

/**
 * 用户发消息后，调度系统决定哪些 Agent 执行、哪些排队。
 * @param depth 触发层深——用户顶层 0（默认），A2A 递归每层 +1
 * @returns traceId — 贯穿全链路的请求追踪 ID
 */
export async function dispatch(
  sessionId: string,
  userMessage: Message,
  agents: AgentConfig[],
  traceId?: string,
  depth: number = 0
): Promise<string> {
  const tid = traceId || uuid()
  const mentions = userMessage.mentions

  // 确定目标 Agent：有 @ 就只调度被 @ 的，广播则调度 Session 内所有 Agent
  const targets = mentions.length > 0 ? agents.filter((a) => mentions.includes(a.name)) : agents

  if (targets.length === 0) {
    return tid
  }

  for (const agent of targets) {
    const cmd: DispatchCommand = {
      sessionId,
      agentId: agent.id,
      triggerMessageId: userMessage.id,
      triggerContent: userMessage.content,
      mentions,
      // 命令自持 trace/depth——队列命令出队时用自身的，不继承执行者（防多 trace 叠加错配）
      traceId: tid,
      depth,
      // 命令自持 taskId——队列命令出队时重建触发消息继承同一 task（drain 段消费，
      // 与 traceId/depth 同语义；无 taskId 时 undefined 与现状等价）
      taskId: userMessage.taskId,
      pendingTriggers: [],
    }

    const slot = agentSlots.get(agent.id)
    if (!slot) {
      log.warn('unknown agent in dispatch', { agentId: agent.id, traceId: tid })
      continue
    }

    if (slot.status === 'idle') {
      // 交接请求去重（执行时点检查）：hook 在 commit 时投递「请补填交接文档」
      // 请求、作者在回复中落库完整文档——请求排队期间文档已补填 → 跳过执行
      // 不唤醒猫（727ff2e 案例：请求 03:19 入队、文档 03:20 落库、执行 03:23，
      // 入队时检查看不到还没出生的文档，必须执行时点查）
      if (isStaleHandoffRequest(cmd)) {
        log.info('stale handoff request skipped (idle)', {
          traceId: tid,
          agentId: agent.id,
          agentName: agent.name,
          triggerMessageId: cmd.triggerMessageId,
        })
        // 标 done 防重启恢复按 queued 复活（P0 恢复只看 queued/running）
        messagesRepo.setDispatchState(cmd.triggerMessageId, 'done')
        continue
      }
      await executeAgent(agent, cmd, tid)
    } else {
      const q = agentQueues.get(agent.id)!
      // B 触发合并（A2A 风暴治理）：A2A 链（depth>0）且同 session 已有排队命令 →
      // 不入队，并入该命令的 pendingTriggers（出队执行时点名"还有 N 件事"）。
      // 合并判定与并入写入同一同步块、中间无 await——Node 单线程下天然原子，
      // 队列消费（completeExecution 的 q.shift）不会插在两者之间，并入必先于消费。
      // 执行中的命令不并入（上下文已拉取，并入无效）；仅合并排队项。
      if (depth > 0) {
        const queued = q.find((c) => c.sessionId === cmd.sessionId)
        if (queued) {
          queued.pendingTriggers.push(cmd.triggerMessageId)
          log.info('agent trigger merged into queued command', {
            traceId: tid,
            agentId: agent.id,
            agentName: agent.name,
            mergedTrigger: cmd.triggerMessageId,
            totalPending: queued.pendingTriggers.length + 1,
          })
          systemMessageBridge?.(
            cmd.sessionId,
            agent.id,
            `🐱 ${agent.name} 收到新触发已合并——当前排队任务将一并处理（共 ${
              queued.pendingTriggers.length + 1
            } 件事待办）`
          )
          continue
        }
      }
      if (q.length >= MAX_QUEUE_PER_AGENT) {
        // 队列上限：拒绝入队并通知前端（不静默丢弃——用户消息需知道"没排上"）
        log.warn('agent queue full, rejecting command', {
          traceId: tid,
          agentId: agent.id,
          agentName: agent.name,
          queueLength: q.length,
          max: MAX_QUEUE_PER_AGENT,
        })
        systemMessageBridge?.(
          cmd.sessionId,
          agent.id,
          `🐱 ${agent.name} 的队列已满（${MAX_QUEUE_PER_AGENT} 条），本条消息暂未排队，请稍后再试`
        )
        continue
      }
      q.push(cmd)
      updateQueueState(agent.id, q.length)
      // P0 队列持久化：入队即落库 queued，server 重启后可恢复
      messagesRepo.setDispatchState(cmd.triggerMessageId, 'queued')
      log.info('agent queued', {
        traceId: tid,
        agentId: agent.id,
        agentName: agent.name,
        queueLength: q.length,
      })
    }
  }

  return tid
}

// ─── Handoff 交接请求去重 ─────────────────────────────

/** 交接文档补填请求的固定前缀（handoff-gen 生成，N9 钉死的精确前缀） */
const HANDOFF_FILL_REQUEST_PREFIX = '请补填以下交接文档'
/** 交接文档模板中的 TODO 占位标记（作者补填后删除） */
const HANDOFF_TODO_MARKER = 'TODO: 补填'
const COMMIT_SHA_RE = /Commit: ([0-9a-f]{7,})/

/**
 * 交接请求是否已 stale：触发消息是「请补填交接文档」请求，且同 session 已有
 * 该 commit 的完整文档（含 Commit: <sha> 且不含 TODO 占位标记）→ 请求已过时，
 * 执行只会白叫醒猫（727ff2e 案例：hook 在 commit 时投递请求、作者在回复中
 * 落库完整文档——请求排队期间文档已补填，执行时点检查可拦截）。
 * 只做执行时点检查——入队时文档可能还没落库（hook 投递早于同轮回复落库），
 * 入队时检查会漏判（03:19 入队、03:20 文档落库、03:23 执行的时窗）。
 *
 * 契约④ 防自证：请求自身（含 sha + 含 TODO 占位）不得作为"已补填"证据——
 * TODO 占位标记检查天然排除；同时排除触发消息自身 id，防止请求消息内容
 * 意外不含占位标记时自证误判。
 */
export function isStaleHandoffRequest(cmd: DispatchCommand): boolean {
  if (!cmd.triggerContent.includes(HANDOFF_FILL_REQUEST_PREFIX)) return false
  const m = cmd.triggerContent.match(COMMIT_SHA_RE)
  if (!m) return false
  const sha = m[1]
  // 同 session 查已落库消息：存在含「Commit: <sha>」且不含「TODO: 补填」的
  // 完整文档 → 请求已 stale（文档已补填投递）
  const rows = messagesRepo.getAllSessionMessages(cmd.sessionId)
  return rows.some(
    (r) =>
      r.id !== cmd.triggerMessageId && // 排除触发消息自身（防自证）
      r.content.includes(`Commit: ${sha}`) &&
      !r.content.includes(HANDOFF_TODO_MARKER)
  )
}

// ─── Execution ──────────────────────────────────────

/**
 * 为单个命令设置槽位（busy + currentTrigger）+ 写执行日志 + 发布状态。
 * 正常路径由 dispatch() 内部调用；重启恢复路径（connector 的
 * recoverInterruptedExecutions）复用同一逻辑，保证槽位语义一致。
 */
export async function executeAgentCommand(
  agent: AgentConfig,
  cmd: DispatchCommand,
  traceId: string
): Promise<void> {
  const slot = agentSlots.get(agent.id)!
  slot.status = 'busy'
  slot.sessionId = cmd.sessionId
  slot.currentTriggerMessageId = cmd.triggerMessageId
  setSlotSession(agent.id, cmd.sessionId)
  // P0 队列持久化：执行开始即落库 running（覆盖空闲直跑与重启恢复两条路径）
  messagesRepo.setDispatchState(cmd.triggerMessageId, 'running')

  const logId = uuid()
  execLogsRepo.insertExecutionLog(logId, cmd.sessionId, agent.id, cmd.triggerMessageId, traceId)

  log.info('agent executing', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    executionLogId: logId,
  })

  await publishAgentStatus(agent, 'busy')

  // ⚠ Agent 的实际 LLM 推理由 dispatch 调用方（connector）触发
  // 这里只做槽位管理和状态变更
  // connector 拿到 agent 配置后，调 LLM → 流式输出 → 写消息 → 标记完成
}

async function executeAgent(
  agent: AgentConfig,
  cmd: DispatchCommand,
  traceId: string
): Promise<void> {
  await executeAgentCommand(agent, cmd, traceId)
}

/**
 * Agent 执行完成后调用。释放槽位，处理队列中的下一个命令。
 */
export async function completeExecution(
  agentId: string,
  success: boolean,
  opts?: {
    latencyMs?: number
    errorMessage?: string
    traceId?: string
    /** 成功路径写回的回复消息 id（洞 A 判据，经 finalize 落 execution_logs.message_id） */
    replyMessageId?: string
  }
): Promise<DispatchCommand | undefined> {
  const slot = agentSlots.get(agentId)
  if (!slot) return

  // 更新执行日志（DB 失败不阻塞槽位释放）。
  // errorType 在此集中分类（L1 契约）：调用点（connector）零改动——dispatch
  // 主链语义不动，只补分类透传。同 UPDATE 契约：error_type 与 status/error_message
  // 一条 UPDATE 带走（finalize 按 running 定位无 id，二次更新会错配）
  try {
    execLogsRepo.finalizeExecutionLog(
      agentId,
      success ? 'completed' : 'failed',
      opts?.latencyMs ?? null,
      opts?.errorMessage ?? null,
      opts?.replyMessageId ?? null,
      opts?.errorMessage ? classifyError(opts.errorMessage) : null
    )
  } catch (err: any) {
    log.error('finalizeExecutionLog failed — releasing slot anyway', {
      agentId,
      error: err.message,
    })
  }

  if (opts?.latencyMs !== undefined) {
    log.info('execution completed', {
      agentId,
      latencyMs: opts.latencyMs,
      success,
      traceId: opts.traceId,
    })
  }
  if (opts?.errorMessage) {
    log.error('execution failed', {
      agentId,
      error: opts.errorMessage,
      traceId: opts.traceId,
    })
  }

  const q = agentQueues.get(agentId)!
  // 弹队列前保存当前触发消息——弹完会被 next 覆盖，done 必须标在旧值上
  const finishedTrigger = slot.currentTriggerMessageId

  // 交接请求去重（dequeue 后、执行前检查）：请求排队期间作者已落库完整文档
  // → 跳过执行不唤醒猫（727ff2e 案例：请求 03:19 入队、文档 03:20 落库、
  // 执行 03:23——只有执行时点（dequeue 后）检查才看得到文档，入队时检查
  // 会漏掉）。stale 命令标 done 后继续弹下一个，直到队列空或遇到非 stale。
  // 守卫：带 pendingTriggers 的 stale 命令不跳过——B 合并（dispatch 的
  // depth>0 触发并入）已在合并时通过 systemMessageBridge 告知用户「将一并
  // 处理 N 件事」，跳过会让合并进来的 A2A 触发静默蒸发（用户看到"已合并"
  // 却永远不执行）。带合并触发时执行不是白叫醒——有真实的跟进待办，照常弹出。
  let next = q.shift()
  while (next && isStaleHandoffRequest(next) && next.pendingTriggers.length === 0) {
    log.info('stale handoff request skipped (queued)', {
      agentId,
      triggerMessageId: next.triggerMessageId,
    })
    // 标 done 防重启恢复按 queued 复活（P0 恢复只看 queued/running）
    messagesRepo.setDispatchState(next.triggerMessageId, 'done')
    next = q.shift()
  }

  if (finishedTrigger) {
    // P0 队列持久化：当前执行收尾即落库 done
    messagesRepo.setDispatchState(finishedTrigger, 'done')
  }

  if (next) {
    slot.status = 'busy'
    slot.sessionId = next.sessionId
    slot.currentTriggerMessageId = next.triggerMessageId
    updateQueueState(agentId, q.length)
    // P0 队列持久化：队列命令被弹出执行——queued → running（重启恢复不重复调度）
    messagesRepo.setDispatchState(next.triggerMessageId, 'running')
    await publishAgentStatusById(agentId, 'busy')
    log.info('queue → next', { agentId, queueRemaining: q.length })
    return next
  } else {
    slot.status = 'idle'
    slot.sessionId = null
    slot.currentTriggerMessageId = null
    updateQueueState(agentId, 0)
    await publishAgentStatusById(agentId, 'idle')
    return undefined
  }
}

// ─── Socket.IO bridge ──────────────────────────────

type AgentStateEmit = (event: 'agent-status', data: AgentRuntimeState) => void
let stateBridge: AgentStateEmit | null = null

/** 注册 Socket.IO 桥接函数（由 connector 在启动时调用）。 */
export function setAgentStateBridge(fn: AgentStateEmit): void {
  stateBridge = fn
}

type SystemMessageEmit = (sessionId: string, agentId: string, content: string) => void
let systemMessageBridge: SystemMessageEmit | null = null

/** 注册系统消息桥接函数（由 connector 在启动时调用）——队列满拒绝入队时通知前端。 */
export function setSystemMessageBridge(fn: SystemMessageEmit): void {
  systemMessageBridge = fn
}

function emitViaBridge(slot: AgentRuntimeState): void {
  if (stateBridge) {
    try {
      stateBridge('agent-status', { ...slot })
    } catch {
      // 桥接失败不阻塞 dispatch
    }
  }
}

// ─── Redis publish helpers ──────────────────────────

async function publishAgentStatus(agent: AgentConfig, status: string): Promise<void> {
  // Socket.IO bridge — 即使 Redis 不可用，前端也能收到
  const slot = agentSlots.get(agent.id)
  if (slot) emitViaBridge(slot)
  try {
    const redis = getRedis()
    if (!redis) return
    await redis.publish(
      Channels.agentStatus(agent.name),
      JSON.stringify({
        agentId: agent.id,
        name: agent.name,
        status,
      })
    )
  } catch {
    // Redis 不可用时静默失败
  }
}

async function publishAgentStatusById(agentId: string, status: string): Promise<void> {
  const agent = agentsRepo.getAgentById(agentId)
  if (agent) {
    await publishAgentStatus(agent as unknown as AgentConfig, status)
  }
}

function setSlotSession(agentId: string, sessionId: string | null): void {
  const slot = agentSlots.get(agentId)
  if (slot) {
    slot.sessionId = sessionId
  }
}

/**
 * 撤回消息时调用：遍历所有 Agent 的 FIFO 队列，移除匹配 triggerMessageId 的命令。
 * 解决 "消息已撤回但 Agent 在排队中，轮到执行时标记已清理" 的时窗问题（Window ①）。
 * @returns 实际移除的命令数
 */
export function cancelQueuedCommand(triggerMessageId: string): number {
  let removed = 0
  for (const [agentId, q] of agentQueues) {
    const before = q.length
    const filtered = q.filter((cmd) => cmd.triggerMessageId !== triggerMessageId)
    if (filtered.length !== before) {
      agentQueues.set(agentId, filtered)
      removed += before - filtered.length
      updateQueueState(agentId, filtered.length)
    }
  }
  if (removed > 0) {
    log.info('queued commands cancelled', { triggerMessageId, removed })
  }
  return removed
}

/**
 * 用户中断（停止按钮）时调用：清空指定 Agent 的 FIFO 队列，并逐条将
 * dispatch_state 标为 done——否则运行中清掉的队列在 server 重启后会被
 * recoverQueuedMessages 按 queued 状态复活重新调度（回到手动改 DB 的老路）。
 * 单条 DB 标记失败不阻塞整体清队（try/catch 逐条兜底）。
 * @returns 实际清掉的命令数
 */
export function clearAgentQueue(agentId: string): number {
  const q = agentQueues.get(agentId)
  if (!q || q.length === 0) return 0
  const cleared = q.length
  for (const cmd of q) {
    try {
      messagesRepo.setDispatchState(cmd.triggerMessageId, 'done')
    } catch (err: any) {
      log.error('setDispatchState failed during queue clear (non-blocking)', {
        agentId,
        triggerMessageId: cmd.triggerMessageId,
        error: err.message,
      })
    }
  }
  agentQueues.set(agentId, [])
  updateQueueState(agentId, 0)
  log.info('agent queue cleared by user interrupt', { agentId, cleared })
  return cleared
}

/**
 * 撤回时用：检查是否有 Agent 正在执行（而非仅仅排队）给定的 trigger 消息。
 * 用于判断 retractionRequests 标记是否可以安全清理。
 */
export function isAnyAgentExecutingMessage(triggerMessageId: string): boolean {
  for (const slot of agentSlots.values()) {
    if (slot.currentTriggerMessageId === triggerMessageId) {
      return true
    }
  }
  return false
}

/** 仅在测试中使用：重置所有槽位和队列状态 */
export function __test_reset(): void {
  agentSlots.clear()
  agentQueues.clear()
}

function updateQueueState(agentId: string, queueLength: number): void {
  const slot = agentSlots.get(agentId)
  if (slot) {
    slot.queueLength = queueLength
    // Socket.IO bridge — 确保前端即使 Redis 不可用也能收到状态更新
    emitViaBridge(slot)
    try {
      const redis = getRedis()
      if (!redis) return
      redis.publish(
        Channels.agentStatus(agentId),
        JSON.stringify({
          agentId,
          status: slot.status,
          sessionId: slot.sessionId,
          queueLength,
        })
      )
    } catch {
      /* silent */
    }
  }
}

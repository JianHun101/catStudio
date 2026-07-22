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
import { agents as agentsRepo, executionLogs as execLogsRepo } from '../db/repository/index.js'
import { v4 as uuid } from 'uuid'
import { createLogger } from '../logger.js'

const log = createLogger('dispatch')

// ─── Slot state (in-memory) ─────────────────────────

const agentSlots = new Map<string, AgentRuntimeState>()
const agentQueues = new Map<string, DispatchCommand[]>()

export function initAgentSlot(agentId: string): void {
  agentSlots.set(agentId, {
    agentId,
    sessionId: null,
    status: 'idle',
    queueLength: 0,
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
 * @returns traceId — 贯穿全链路的请求追踪 ID
 */
export async function dispatch(
  sessionId: string,
  userMessage: Message,
  agents: AgentConfig[],
  traceId?: string
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
    }

    const slot = agentSlots.get(agent.id)
    if (!slot) {
      log.warn('unknown agent in dispatch', { agentId: agent.id, traceId: tid })
      continue
    }

    if (slot.status === 'idle') {
      await executeAgent(agent, cmd, tid)
    } else {
      const q = agentQueues.get(agent.id)!
      q.push(cmd)
      updateQueueState(agent.id, q.length)
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

// ─── Execution ──────────────────────────────────────

async function executeAgent(
  agent: AgentConfig,
  cmd: DispatchCommand,
  traceId: string
): Promise<void> {
  const slot = agentSlots.get(agent.id)!
  slot.status = 'busy'
  slot.sessionId = cmd.sessionId
  setSlotSession(agent.id, cmd.sessionId)

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

/**
 * Agent 执行完成后调用。释放槽位，处理队列中的下一个命令。
 */
export async function completeExecution(
  agentId: string,
  success: boolean,
  opts?: { latencyMs?: number; errorMessage?: string; traceId?: string }
): Promise<DispatchCommand | undefined> {
  const slot = agentSlots.get(agentId)
  if (!slot) return

  // 更新执行日志
  execLogsRepo.finalizeExecutionLog(
    agentId,
    success ? 'completed' : 'failed',
    opts?.latencyMs ?? null,
    opts?.errorMessage ?? null
  )

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
  const next = q.shift()

  if (next) {
    slot.status = 'busy'
    slot.sessionId = next.sessionId
    updateQueueState(agentId, q.length)
    await publishAgentStatusById(agentId, 'busy')
    log.info('queue → next', { agentId, queueRemaining: q.length })
    return next
  } else {
    slot.status = 'idle'
    slot.sessionId = null
    updateQueueState(agentId, 0)
    await publishAgentStatusById(agentId, 'idle')
    return undefined
  }
}

// ─── Redis publish helpers ──────────────────────────

async function publishAgentStatus(agent: AgentConfig, status: string): Promise<void> {
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

/** 仅在测试中使用：重置所有槽位和队列状态 */
export function __test_reset(): void {
  agentSlots.clear()
  agentQueues.clear()
}

function updateQueueState(agentId: string, queueLength: number): void {
  const slot = agentSlots.get(agentId)
  if (slot) {
    slot.queueLength = queueLength
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

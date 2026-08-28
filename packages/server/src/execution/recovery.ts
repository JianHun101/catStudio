/**
 * Execution — 三条启动恢复路径（第 4 刀从 connectors/socketio.ts 迁出，零控制流变化）。
 *
 * recoverInterruptedExecutions（execution_logs 逐 agent 恢复）/
 * recoverQueuedMessages（dispatch_state queued/running 按消息恢复）/
 * replayStuckUserMessages（静默丢重放，周期扫描 NULL 面）。
 *
 * 输出经注入 bus（EngineBus），执行经注册表单例引擎（getExecutionEngine——ingest 同款
 * 服务定位）；日志通道沿用 'socketio'（零可观测行为变化）。
 */

import { v4 as uuid } from 'uuid'
import type { AgentConfig, DispatchCommand, Message } from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import { createLogger } from '../logger.js'
import { rowToAgent } from './row.js'
import { agentHasUsableApiKey } from './serial.js'
import { getExecutionEngine } from './registry.js'
import type { EngineBus, HandoffBus } from './bus.js'

const log = createLogger('socketio')

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
export async function recoverInterruptedExecutions(bus: EngineBus & HandoffBus): Promise<void> {
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

        const mentions = JSON.parse(triggerRow.mentions || '[]') as string[]
        const traceId = uuid()

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

        // C1 v3 单入口：executeAgentsSerial 决策(标 busy+写审计)→执行→顶层收尾一次搞定。
        // 原 executeAgentCommand + executeAgentsSerial 两步合并——槽位由 execute 决策段
        // 惰性创建（不再需要 initAgentSlot / executeAgentCommand 显式设置）
        await getExecutionEngine()!.executeAgentsSerial(
          rec.session_id,
          [agent],
          triggerMsg,
          traceId,
          0
        )
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
        bus.emitSystemNotice({
          id: msgId,
          sessionId,
          agentId: null,
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
export async function recoverQueuedMessages(bus: EngineBus & HandoffBus): Promise<void> {
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

        // 槽位由 execute 决策段惰性创建（不再需要 initAgentSlot——C1 v3）
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
        // （重启后不可恢复）——重建的命令恒为空，依赖用户消息重放兜底（见注释）
        log.info('恢复的命令 pendingTriggers 为空（B 合并为内存态，重启后丢失——已知噪声）', {
          messageId: row.id,
          sessionId: row.session_id,
        })

        // C1 v3 单入口：executeAgentsSerial 决策(标 busy/入队)+执行一次搞定——原
        // dispatch + executeAgentsSerial 两步合并（S2 兜底已移入 execute 的 finally）
        await getExecutionEngine()!.executeAgentsSerial(
          row.session_id,
          dispatchTargets,
          msg,
          traceId,
          0
        )
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
export async function replayStuckUserMessages(bus: EngineBus & HandoffBus): Promise<void> {
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

        // 槽位由 execute 决策段惰性创建（不再需要 initAgentSlot——C1 v3）
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

        // C1 v3 单入口：executeAgentsSerial 决策(标 busy/入队)+执行一次搞定——原
        // dispatch + executeAgentsSerial 两步合并（S2 兜底已移入 execute 的 finally）
        await getExecutionEngine()!.executeAgentsSerial(row.session_id, executable, msg, traceId, 0)
      } catch (err: any) {
        log.error('重放单条消息失败', { messageId: row.id, error: err.message })
      }
    }
  } catch (err: any) {
    log.error('replayStuckUserMessages failed', { error: err.message })
  }
}

/**
 * Execution — 点单管理组（第 3 刀从 connectors/socketio.ts 迁出，零控制流变化；
 * 3.5 刀模块态 → 实例态：状态经注入的 EngineState 参数消费，finalizeRun 统一
 * 五处 completeExecution 收口点）。
 *
 * C1 v3（调度层重构）：模块级槽位状态（dispatch/ 的 agentSlots/agentQueues）收进
 * engine 闭包——调度键升 agentId+sessionId（跨会话同猫并行、同会话同猫 FIFO 保留），
 * 执行器并发化（批内并行），加 ProviderTokenPool（provider 并发 cap）。外面只认
 * engine 的 execute(cmd) 单接口：决策(直跑/入队) → acquire token → 执行 →
 * finally{release+收口+排空}。
 *
 * executeOneAgent / executeAgentsSerial / drainQueuedCommand + 执行常量与
 * no-key 守卫。输出经注入 bus（EngineBus & HandoffBus），状态经注入 state。
 * 日志通道沿用 'socketio'（零可观测行为变化）。
 */

import { execSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import { Channels, type AgentConfig, type AgentRuntimeState, type DispatchCommand, type Message } from '@cat-study/shared'
import {
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import { getRedis } from '../db/redis.js'
import { createLogger } from '../logger.js'
import { MAX_QUEUE_PER_AGENT, isStaleHandoffRequest } from '../dispatch/index.js'
import { ProviderTokenPool } from './token-pool.js'
import { classifyError } from '../eval/classify-error.js'
import { gitCommit, getSessionWorktreePath } from '../llm/git-utils.js'
import { updateRunningSummary } from '../summarizer/index.js'
import {
  parseMentionsFromReply,
  detectUnknownHandle,
  detectInlineMentions,
} from '../connectors/a2a-mentions.js'
import { filterAllowedMentions, allowedTargetsDescription } from '../dispatch/mention-policy.js'
import { consumeRouteSignals } from '../llm/route-signals.js'
import { recordReviewVerdict } from '../eval/verdict-parser.js'
import { maybeScoreSample } from '../eval/sampler.js'
import { resolveRolePlaceholders } from './hints.js'
import { runAgentReply } from './reply.js'
import { rowToAgent } from './row.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { createEngineState, type EngineState, type StreamState } from './state.js'

const log = createLogger('socketio')

/** 不消费 apiKey 的 provider（本地认证，key 留空合法）——no-key 守卫须按 provider 区分 */
const NO_API_KEY_PROVIDERS = new Set(['opencode', 'ollama'])

/** agent 是否具备可用的 API key：免 key provider 恒 true；否则要求非空且非占位符 */
export function agentHasUsableApiKey(
  agent: Pick<AgentConfig, 'llmProvider' | 'llmApiKey'>
): boolean {
  if (NO_API_KEY_PROVIDERS.has(agent.llmProvider)) return true
  return !!agent.llmApiKey && agent.llmApiKey !== 'sk-your-api-key-here'
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

// ─── Agent Execution（同消息并发调度） ────────────

/** 同消息并发执行的 agent 数上限——批内 Promise.allSettled 并发启动，批间串行。
 *  语义变化（方案级决策已过审）：广播模式下并行 agent 互不见彼此回复
 *  （A2A 接力不受影响——触发前提是回复已落库）；前端显示顺序 = 完成顺序 */
const CONCURRENT_AGENTS_PER_MESSAGE = 3

/** 触发消息的静态形状（executeAgentsSerial / executeOneAgent 共用） */
export type AgentTriggerMsg = {
  id: string
  content: string
  mentions: string[]
  taskId?: string
  authorName?: string
}

// ─── C1 v3 调度层重构：槽位（engine 闭包持有，键 agentId+sessionId） ────────────

/**
 * 单 agent×单会话的调度槽位（原 dispatch/ 模块级 agentSlots+agentQueues 合并形态）。
 * 调度键 (agentId, sessionId)：同 agent 跨会话独立槽位（并行），同会话同 agent
 * 自带 FIFO 队列（串行）。status 仅 idle/busy——thinking 是流式中间态（bus 事件），
 * 不在调度层。
 */
interface Slot {
  agentId: string
  sessionId: string
  status: 'idle' | 'busy'
  queue: DispatchCommand[]
  currentTriggerMessageId: string | null
}

/** 广播给前端的运行时状态形状（snapshot/getSlot 只读 accessor 产出） */
export type SlotState = AgentRuntimeState

/**
 * 引擎上下文——模块级执行函数（executeOneAgent/executeAgentsSerialImpl/
 * drainQueuedCommand/finalizeRun）经此消费 engine 闭包内的槽位与 token 池，
 * 避免把全部逻辑塞进 createExecutionEngine 一个闭包（可测性 + 可读性）。
 */
export interface EngineCtx {
  state: EngineState
  bus: EngineBus & HandoffBus
  slots: Map<string, Map<string, Slot>>
  tokenPool: ProviderTokenPool
  /** 槽位 accessor（模块函数只读消费；变更一律走 executeAgentCommand/completeExecution） */
  getSlotInternal(agentId: string, sessionId: string): Slot | undefined
  ensureSlot(agentId: string, sessionId: string): Slot
  slotToRuntimeState(slot: Slot): AgentRuntimeState
  /** 槽位队列长度/状态变更 → 前端 agent-status 广播（socket 桥接 + Redis） */
  updateQueueState(slot: Slot): void
  publishAgentStatus(slot: Slot, status: string): Promise<void>
  /** 标 busy + 写执行日志（原 dispatch.executeAgentCommand） */
  executeAgentCommand(agent: AgentConfig, cmd: DispatchCommand, traceId: string): Promise<void>
  /** 收口：finalize 执行日志 + 弹队列 + 槽位复位（原 dispatch.completeExecution） */
  completeExecution(
    agentId: string,
    sessionId: string,
    success: boolean,
    opts?: {
      errorMessage?: string
      traceId?: string
      replyMessageId?: string
    }
  ): Promise<DispatchCommand | undefined>
  /** 队列拒绝入队时的系统消息桥（dispatch 模块 setSystemMessageBridge 迁入） */
  systemBridge: ((sessionId: string, agentId: string, content: string) => void) | null
  /** per-agent 顶层入口：决策 → token → 执行 → finally{release+收口+排空} */
  execute(cmd: DispatchCommand): Promise<boolean>
}

/** token 池键——复用 llm/registry.ts 的 provider:apiKey 形态（registry 默认分支） */
function providerKey(agent: AgentConfig): string {
  return `${agent.llmProvider}:${agent.llmApiKey}`
}

/** 由命令构造触发消息静态形状（A2A authorName 从 DB 反查） */
function buildTriggerMsg(ctx: EngineCtx, cmd: DispatchCommand): AgentTriggerMsg {
  const triggerMeta = messagesRepo.getMessageByIdOnly(cmd.triggerMessageId)
  const triggerRow = triggerMeta
    ? messagesRepo.getMessageById(cmd.triggerMessageId, cmd.sessionId, triggerMeta.role)
    : undefined
  return {
    id: cmd.triggerMessageId,
    content: cmd.triggerContent,
    mentions: cmd.mentions,
    taskId: cmd.taskId,
    authorName:
      triggerRow?.role === 'agent' && triggerRow.agent_id
        ? (agentsRepo.getAgentNameById(triggerRow.agent_id) ?? undefined)
        : undefined,
  }
}

/** 构造 per-agent 调度命令（顶层/恢复/A2A 共用） */
function makeCmd(
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number
): DispatchCommand {
  return {
    sessionId,
    agentId: agent.id,
    triggerMessageId: triggerMsg.id,
    triggerContent: triggerMsg.content,
    mentions: triggerMsg.mentions,
    taskId: triggerMsg.taskId,
    traceId,
    depth,
    pendingTriggers: [],
  }
}

/**
 * 执行收口统一漏斗（3.5 刀）：run 注册表 endRun + completeExecution 单点合并。
 * 此前五处 completeExecution 各自管理清理——abort 注销在 finally、stream 清理
 * 在 inner catch、其余路径不清理，失败漏斗不一致（事故史最密集处）。
 * endRun 幂等：无注册（no-key 早退）/已清理（reply 撤回出口）路径 no-op。
 * @returns completeExecution 弹出的下一队列命令（调用点自行 drain）
 */
async function finalizeRun(
  ctx: EngineCtx,
  agentId: string,
  sessionId: string,
  opts: { success: boolean; errorMessage?: string; replyMessageId?: string; traceId: string }
): Promise<DispatchCommand | undefined> {
  // OQ3：runs 注册表 session 化——精确删本会话 run（跨会话并行的兄弟 run 不受影响）
  ctx.state.endRun(agentId, sessionId)
  return ctx.completeExecution(agentId, sessionId, opts.success, {
    ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    ...(opts.replyMessageId ? { replyMessageId: opts.replyMessageId } : {}),
    traceId: opts.traceId,
  })
}

/**
 * 队列 drain：执行 completeExecution 弹出的下一命令（补审计 + 出队反查作者 +
 * B 合并点名 + 递归执行）。抽取为共享函数——成功路径（completeExecution 后立即
 * 调用）与 catch 路径（异常后弹出的命令不丢弃）两处复用。
 * @returns 传入的 claudeRan OR 本次 drain 是否执行过 Claude 适配器
 */
async function drainQueuedCommand(
  ctx: EngineCtx,
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
  await ctx.executeAgentCommand(agent, queuedCmd, queuedCmd.traceId)
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
  // 直接执行（不走 execute 决策——槽位已被 completeExecution 标 busy，重入会再排队）。
  // 不 acquire token——drain 是同一 agent 的 FIFO 延续，运行在父 executeRun 持有的
  // token 之下（若嵌套 acquire，父持锁等子、子持锁等孙 → token cap 下死锁，实测
  // 4 连排队 drain 卡死）。drain 与父执行共享一个 provider 并发额度，顺序消费。
  return (
    (await executeOneAgent(
      ctx,
      queuedCmd.sessionId,
      agent,
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
  ctx: EngineCtx,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number
): Promise<boolean> {
  const { state, bus } = ctx
  // 会话成员 id 与名（A2A mention 解析用）——原 executeAgentsSerialImpl 循环外
  // 计算一次传入，C1 v3 后 execute 单入口各执行体自行查（DB 小读，正确性优先）
  const sessionAgentIds = sessionsRepo.getSessionAgentIds(sessionId)
  const sessionAgentNames: string[] = sessionAgentIds
    .map((id: string) => agentsRepo.getAgentNameById(id))
    .filter((n): n is string => n !== undefined)

  // 状态检查（同步——必须留在第一个 await 之前，见上方约束）
  const slot = ctx.getSlotInternal(agent.id, sessionId)
  if (!slot || slot.status !== 'busy') return false
  // 只执行"本次调度标记的执行"：agent 正在处理其他消息时（本消息在
  // FIFO 队列中等待排空），必须跳过——否则同一条消息会被立即执行一次、
  // 队列排空再执行一次，产生重复回复（08:43:15 双补填事故根因）。
  // completeExecution 弹出队列时会更新 currentTriggerMessageId，
  // 排空路径自然通过此检查。
  if (slot.currentTriggerMessageId !== triggerMsg.id) return false

  // 检查 API Key（免 key provider 如 opencode 本地认证，不拦）
  if (!agentHasUsableApiKey(agent)) {
    log.warn('no API key', {
      agentId: agent.id,
      agentName: agent.name,
      traceId,
    })
    bus.emitSystemNotice({
      id: uuid(),
      sessionId,
      agentId: agent.id,
      content: `🐱 ${agent.name} 还没有配置 API Key，请在右侧面板点击它进行配置`,
      mentions: [],
      createdAt: new Date().toISOString(),
    })
    // P0-2 同款守卫补全：completeExecution 弹出队列命令后不丢弃——无 key 的
    // 排队命令同样会落入 running+无执行日志的幽灵态（slot 卡 busy，恢复机制
    // 全盲）。弹出后补 drain：子链在 no-key 检查处逐个 completeExecution 弹
    // 下一个，直到队列空（每条发一次配置提示，执行日志逐条落库）
    const nextCmd = await finalizeRun(ctx, agent.id, sessionId,{ success: true, traceId })
    if (nextCmd) {
      try {
        await drainQueuedCommand(ctx, agent,nextCmd, false)
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
  if (needsLock) state.acquireLock()
  // claudeRan 提升到 try 外——catch 路径需读取。F2 回归：drain 提前到主回复
  // parse 之前（FIFO 修复）后，若主回复 parse 抛错进 catch，catch 只返 needsLock
  // 会丢掉 drain 子链已执行过的 claudeRan → 顶层 anyClaude 判定漏 → 脏文件清理跳过
  let claudeRan = needsLock
  try {
    let reply: { content: string; msgId: string } = {
      content: '',
      msgId: '',
    }
    const abortController = new AbortController()
    // OQ3：registerAbort 带 sessionId——同 agent 跨会话并行各占独立 run 条目
    state.registerAbort(agent.id, sessionId, abortController)
    try {
      // 用 Promise.race 防止单个 Agent 的 LLM 调用挂起阻塞后续 Agent
      // AbortController 确保超时后子进程被 kill（P0-1 修复）
      reply = await Promise.race([
        runAgentReply(state, bus, sessionId, agent, triggerMsg, traceId, abortController.signal),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            abortController.abort()
            reject(new Error(`执行超时 (${AGENT_HARD_TIMEOUT_MS / 1000}s)`))
          }, AGENT_HARD_TIMEOUT_MS)
        ),
      ])
    } catch (err: any) {
      // run 注册表收口由 finalizeRun 的 endRun 统一（此前 abort 注销在 finally、
      // stream 清理在此处、其余失败漏斗不清理——各管各的正是本刀收编对象）
      abortController.abort()
      log.error('agent execution failed', {
        agentId: agent.id,
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
        traceId,
      })
      bus.emitSystemNotice({
        id: uuid(),
        sessionId,
        agentId: agent.id,
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
      const nextCmd = await finalizeRun(ctx, agent.id, sessionId,{
        success: false,
        errorMessage: err.message || 'unknown error',
        traceId,
      })
      if (nextCmd) {
        try {
          claudeRan = await drainQueuedCommand(ctx, agent,nextCmd, claudeRan)
        } catch (e: any) {
          log.error('drain failed after execution error (queue item stuck)', {
            agentId: agent.id,
            triggerMessageId: nextCmd.triggerMessageId,
            error: e.message,
          })
        }
      }
      return claudeRan
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
      bus.emitSystemNotice({
        id: uuid(),
        sessionId,
        agentId: agent.id,
        content: `🐱 ${agent.name} 已停止（用户中断）`,
        mentions: [],
        createdAt: new Date().toISOString(),
      })
      await finalizeRun(ctx, agent.id, sessionId,{
        success: false,
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
    const queuedCmd = await finalizeRun(ctx, agent.id, sessionId,{
      success: true,
      replyMessageId: reply.msgId,
      traceId,
    })

    // W2 L2 评估采样：fire-and-forget——不 await、不占 slot、不进 dispatch 主链，
    // 失败静默（内部 catch）。只对 DS 族猫回复采样（ollama 图测猫不评估）
    maybeScoreSample(agent, sessionId, reply.msgId)

    // 队列命令优先执行（FIFO）：completeExecution 已弹出下一命令并标 busy/running，
    // 此处立即补执行（drain）——先于下方 A2A 派发，否则弹出命令会干等当前回复的
    // A2A 嵌套链跑完（d448413a 案例：07:00:02 弹出、07:05:54 才执行——被两层
    // A2A await 拖 5.9 分钟，'running' 状态干挂 + 槽位"忙碌"假象）
    if (queuedCmd) {
      claudeRan = await drainQueuedCommand(ctx, agent,queuedCmd, claudeRan)
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
      state.setMentionCount(traceId, agent.id, state.getMentionCount(traceId, agent.id) + 1)
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
        bus.emitSystemNotice({
          id: uuid(),
          sessionId,
          agentId: agent.id,
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
        bus.emitMessageUpdated(sessionId, {
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
          const count = state.getMentionCount(traceId, a.id)
          if (count >= MAX_MENTIONS_PER_AGENT) continue
          state.setMentionCount(traceId, a.id, count + 1) // 预留配额
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
          // C1 v3：槽位由 execute 的决策段 ensureSlot 惰性创建（原 initAgentSlot
          // 显式调用删除——execute 决策段对未知 agent 同样跳过不调度，语义保留）。
          // 子链返回值冒泡：子链若有 Claude 执行，顶层收尾同样需要脏文件清理
          claudeRan =
            (await executeAgentsSerialImpl(
              ctx,
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
      if (inlineMentions.length > 0 && state.maybeWarnM1(agent.id)) {
        log.warn('agent reply has inline mention but no route', {
          traceId,
          fromAgent: agent.name,
          inlineMentions,
        })
        bus.emitSystemNotice({
          id: uuid(),
          sessionId,
          agentId: agent.id,
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
    const nextCmd = await finalizeRun(ctx, agent.id, sessionId,{
      success: false,
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
    let drainClaudeRan = claudeRan
    if (nextCmd) {
      try {
        drainClaudeRan = await drainQueuedCommand(ctx, agent,nextCmd, needsLock)
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
    if (needsLock) state.releaseLock()
  }
}

async function executeAgentsSerialImpl(
  ctx: EngineCtx,
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

  // 分批并发：批内 CONCURRENT_AGENTS_PER_MESSAGE 个命令同时 execute（决策段
  // 同步完成——各 execute 在第一个 await 前 mark busy，批启动瞬间无中间态，
  // 双执行防护有效），批间串行。allSettled 只兜未预期 throw——执行体异常
  // 已自收口（execute 的 finally 收口），单个执行体崩溃不中断整批其余执行。
  // C1 v3：多猫并行是外层 for 循环职责（命令 per-agent 意图，agents 不进命令）
  let anyClaude = false
  for (let i = 0; i < agents.length; i += CONCURRENT_AGENTS_PER_MESSAGE) {
    const batch = agents.slice(i, i + CONCURRENT_AGENTS_PER_MESSAGE)
    const results = await Promise.allSettled(
      batch.map((agent) =>
        ctx.execute(makeCmd(sessionId, agent, triggerMsg, traceId, depth))
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) anyClaude = true
    }
  }

  // 顶层调度完成后清理 + 自动提交
  if (depth === 0) {
    ctx.state.clearMentionCountsForTrace(traceId)
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

/** 执行引擎公共面（第 3 刀最小形态：执行入口 + 中断控制；恢复入口第 4 刀并入）。
 *  3.5 刀补状态 accessor：connector handler（MESSAGE_RETRACT / JOIN_SESSION）与
 *  internal.ts（经 socketio 委托）经此寻址引擎实例态。
 *  C1 v3：调度键升 agentId+sessionId——同 agent 跨会话并行，同会话同 agent FIFO
 *  保留；execute(cmd) 单入口（决策→token→执行→finally 收口+排空）；加并发护栏
 *  （ProviderTokenPool）。 */
export interface ExecutionEngine {
  /** C1 v3 顶层单入口：决策(直跑/入队)→acquire token→执行→finally{release+收口+排空}。
   *  命令是 per-agent 意图（agents 数组不进命令——多猫并行是外层 for 循环职责）。
   *  返回是否执行过 Claude 适配器（顶层收尾据此外链脏文件清理）。 */
  execute(cmd: DispatchCommand): Promise<boolean>
  /** 顶层批量入口（dispatch 配对调用：决策+执行一次搞定，内部走 execute；多猫
   *  并行 + 顶层收尾清理）。 */
  executeAgentsSerial(
    sessionId: string,
    agents: AgentConfig[],
    triggerMsg: AgentTriggerMsg,
    traceId: string,
    depth?: number
  ): Promise<boolean>
  /** MESSAGE_RETRACT handler：遍历所有槽位 FIFO 队列移除匹配 triggerMessageId 的命令 */
  cancelQueuedCommand(triggerMessageId: string): number
  /** AGENT_INTERRUPT handler：清空该 agent 槽位的 FIFO 队列（逐条标 done）。
   *  带 sessionId → 只清该会话；无 → 清全部会话（旧客户端语义） */
  clearAgentQueue(agentId: string, sessionId?: string): number
  /** 撤回时用：是否有 agent 正在执行（而非排队）给定 trigger 消息 */
  isAnyAgentExecutingMessage(triggerMessageId: string): boolean
  /** 只读槽位访问（agentId+sessionId 键控；替代 getAgentState） */
  getSlot(agentId: string, sessionId: string): SlotState | undefined
  /** 全量槽位快照（替代 getAllAgentStates） */
  snapshot(): SlotState[]
  /** 会话关闭：dispose 该会话所有槽位（内存不涨——连续开/关会话 snapshot 不膨胀） */
  disposeSession(sessionId: string): void
  /** agent-status 桥接注册（connector 启动时调用；状态变更时触发 + 顶层 emit） */
  setAgentStateBridge(fn: (state: AgentRuntimeState) => void): void
  /** 系统消息桥接注册（队列满拒绝入队时通知用户） */
  setSystemMessageBridge(fn: (sessionId: string, agentId: string, content: string) => void): void
  /** AGENT_INTERRUPT handler：abort 目标会话的执行。返回是否真的在跑。
   *  带 sessionId 精确 abort；无（旧客户端）→ abort 该 agent 全部会话 run */
  abortAgent(agentId: string, sessionId?: string): boolean
  /** MESSAGE_RETRACT handler：标记撤回（runAgentReply Window ②/③ 检查） */
  setRetraction(messageId: string): void
  /** 撤回标记清理（handler 失败/无执行者清理；runAgentReply 出口内部走 state） */
  clearRetraction(messageId: string): void
  /** JOIN_SESSION 打字气泡恢复遍历 */
  listActiveStreams(): Array<[string, StreamState]>
  /** internal.ts 信号校验（只读） */
  getActiveStream(agentId: string): StreamState | undefined
}

/** 测试钩子视图（socketio 兼容 re-export 委托消费；生产路径不调用） */
export interface ExecutionEngineTestHooks {
  __test_reset(): void
  __test_resetLockState(): void
  __test_resetMentionCounts(): void
  __test_resetM1Warned(): void
  __test_resetRuns(): void
  __getMentionCount(traceId: string, agentId: string): number
  __setMentionCount(traceId: string, agentId: string, count: number): void
  /**
   * 测试钩子：种子化槽位状态（替代旧测试 mock dispatch.getAgentState 的形态）。
   * 设置 (agentId, sessionId) 槽位为 busy + 指定 currentTrigger，并可选注入排队命令
   * ——让测试复现「dispatch 已标 busy + FIFO 队列」的场景，无需真跑 LLM 建态。
   */
  __test_seedSlot(
    agentId: string,
    sessionId: string,
    opts: {
      currentTriggerMessageId: string
      queue?: DispatchCommand[]
    }
  ): void
}

/**
 * 引擎工厂：bus + state 构造注入（零 socket 引用）——每个实例自带独立状态，
 * 生产单实例（connector createSocketIO 持有，重复创建 fail-fast），测试每用例新造。
 *
 * C1 v3：槽位状态（slots/tokenPool/桥接）全部收进本闭包——dispatch/ 的模块级
 * 单例不再存在；调度键 agentId+sessionId（同 agent 跨会话并行、同会话同 agent
 * FIFO 保留）。
 */
export function createExecutionEngine(
  bus: EngineBus & HandoffBus
): ExecutionEngine & ExecutionEngineTestHooks {
  const state = createEngineState()
  // ─── C1 v3 槽位 + 并发护栏（模块级单例收编为实例态） ───
  const slots = new Map<string, Map<string, Slot>>()
  const tokenPool = new ProviderTokenPool()
  let stateBridge: ((state: AgentRuntimeState) => void) | null = null
  let systemBridge: ((sessionId: string, agentId: string, content: string) => void) | null = null

  // ─── 槽位 accessor ───────────────────────────────

  function ensureSlot(agentId: string, sessionId: string): Slot {
    let bySession = slots.get(agentId)
    if (!bySession) {
      bySession = new Map()
      slots.set(agentId, bySession)
    }
    let slot = bySession.get(sessionId)
    if (!slot) {
      slot = {
        agentId,
        sessionId,
        status: 'idle',
        queue: [],
        currentTriggerMessageId: null,
      }
      bySession.set(sessionId, slot)
    }
    return slot
  }

  function getSlotInternal(agentId: string, sessionId: string): Slot | undefined {
    return slots.get(agentId)?.get(sessionId)
  }

  /** 广播形状：idle 槽位的 sessionId 置 null（前端语义——"在哪忙"而非"键在哪"） */
  function slotToRuntimeState(slot: Slot): AgentRuntimeState {
    return {
      agentId: slot.agentId,
      sessionId: slot.status === 'busy' ? slot.sessionId : null,
      status: slot.status,
      queueLength: slot.queue.length,
      currentTriggerMessageId: slot.currentTriggerMessageId,
    }
  }

  /** 槽位状态变更 → 前端 agent-status 广播（socket 桥接 + Redis 双通道） */
  function emitSlotState(slot: Slot): void {
    if (stateBridge) {
      try {
        stateBridge(slotToRuntimeState(slot))
      } catch {
        // 桥接失败不阻塞调度
      }
    }
  }

  function updateQueueState(slot: Slot): void {
    emitSlotState(slot)
    try {
      const redis = getRedis()
      if (!redis) return
      redis.publish(
        Channels.agentStatus(slot.agentId),
        JSON.stringify({
          agentId: slot.agentId,
          status: slot.status,
          sessionId: slot.status === 'busy' ? slot.sessionId : null,
          queueLength: slot.queue.length,
        })
      )
    } catch {
      /* silent */
    }
  }

  async function publishAgentStatus(slot: Slot, status: string): Promise<void> {
    emitSlotState(slot)
    try {
      const redis = getRedis()
      if (!redis) return
      await redis.publish(
        Channels.agentStatus(slot.agentId),
        JSON.stringify({
          agentId: slot.agentId,
          status,
          sessionId: slot.status === 'busy' ? slot.sessionId : null,
        })
      )
    } catch {
      // Redis 不可用时静默失败
    }
  }

  // ─── 命令执行（原 dispatch 模块函数，引擎实例化） ──

  async function executeAgentCommand(
    agent: AgentConfig,
    cmd: DispatchCommand,
    traceId: string
  ): Promise<void> {
    const slot = ensureSlot(agent.id, cmd.sessionId)
    slot.status = 'busy'
    slot.currentTriggerMessageId = cmd.triggerMessageId
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

    await publishAgentStatus(slot, 'busy')
  }

  async function completeExecution(
    agentId: string,
    sessionId: string,
    success: boolean,
    opts?: {
      latencyMs?: number
      errorMessage?: string
      traceId?: string
      replyMessageId?: string
    }
  ): Promise<DispatchCommand | undefined> {
    const slot = getSlotInternal(agentId, sessionId)
    if (!slot) return

    // 更新执行日志（DB 失败不阻塞槽位释放）。errorType 在此集中分类（L1 契约）
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

    // 弹队列前保存当前触发消息——弹完会被 next 覆盖，done 必须标在旧值上
    const finishedTrigger = slot.currentTriggerMessageId

    // 交接请求去重（dequeue 后、执行前检查）——守卫：带 pendingTriggers 的 stale
    // 命令不跳过（B 合并已告知用户「将一并处理 N 件事」，跳过会让合并触发静默蒸发）
    let next = slot.queue.shift()
    while (next && isStaleHandoffRequest(next) && next.pendingTriggers.length === 0) {
      log.info('stale handoff request skipped (queued)', {
        agentId,
        triggerMessageId: next.triggerMessageId,
      })
      // 标 done 防重启恢复按 queued 复活（P0 恢复只看 queued/running）
      messagesRepo.setDispatchState(next.triggerMessageId, 'done')
      next = slot.queue.shift()
    }

    if (finishedTrigger) {
      // OQ1 完成路径守卫（多目标部分完成）：当前状态 = queued（兄弟目标排队中）
      // → 不写 done 保持 queued（恢复路径可捞，兄弟的排队命令不丢）
      if (messagesRepo.getDispatchState(finishedTrigger) !== 'queued') {
        messagesRepo.setDispatchState(finishedTrigger, 'done')
      } else {
        log.info('多目标部分完成：保持 queued（兄弟目标排队中，不写 done）', {
          agentId,
          triggerMessageId: finishedTrigger,
        })
      }
    }

    if (next) {
      slot.status = 'busy'
      slot.currentTriggerMessageId = next.triggerMessageId
      updateQueueState(slot)
      // P0 队列持久化：队列命令被弹出执行——queued → running（重启恢复不重复调度）
      messagesRepo.setDispatchState(next.triggerMessageId, 'running')
      await publishAgentStatus(slot, 'busy')
      log.info('queue → next', { agentId, queueRemaining: slot.queue.length })
      return next
    } else {
      slot.status = 'idle'
      slot.currentTriggerMessageId = null
      updateQueueState(slot)
      await publishAgentStatus(slot, 'idle')
      return undefined
    }
  }

  // ─── C1 v3 execute 单入口（决策 → token → 执行 → finally） ──

  const ctx: EngineCtx = {
    state,
    bus,
    slots,
    tokenPool,
    getSlotInternal,
    ensureSlot,
    slotToRuntimeState,
    updateQueueState,
    publishAgentStatus,
    executeAgentCommand,
    completeExecution,
    systemBridge,
    execute: () => Promise.resolve(false), // 占位——下方 execute 内引用 ctx 时替换
  }

  /** per-agent 核心执行体：acquire token → executeOneAgent → finally release */
  async function executeRun(cmd: DispatchCommand, agent: AgentConfig): Promise<boolean> {
    const release = await tokenPool.acquire(providerKey(agent))
    let execError: unknown
    try {
      const triggerMsg = buildTriggerMsg(ctx, cmd)
      return await executeOneAgent(
        ctx,
        cmd.sessionId,
        agent,
        triggerMsg,
        cmd.traceId,
        cmd.depth
      )
    } catch (err: any) {
      execError = err
      log.error('execute crashed — releasing slot in finally', {
        agentId: cmd.agentId,
        traceId: cmd.traceId,
        error: err.message,
      })
      return false
    } finally {
      release()
      // 原 S2 手动兜底（ingest .catch 里的槽位释放）移入 execute 的 finally：
      // executeOneAgent 若逃逸异常未自收口（槽位仍 busy），此处补收口 + 排空
      const s = getSlotInternal(cmd.agentId, cmd.sessionId)
      if (s && s.status === 'busy') {
        const next = await completeExecution(cmd.agentId, cmd.sessionId, false, {
          errorMessage: execError instanceof Error ? execError.message : 'execute crash',
          traceId: cmd.traceId,
        }).catch(() => undefined)
        if (next) {
          try {
            await drainQueuedCommand(ctx, agent, next, false)
          } catch (e: any) {
            log.error('drain failed after execute crash (queue item stuck)', {
              agentId: cmd.agentId,
              triggerMessageId: next.triggerMessageId,
              error: e.message,
            })
          }
        }
      }
    }
  }

  /** C1 v3 顶层单入口：决策(直跑/入队) → token → 执行 → finally{release+收口+排空} */
  async function execute(cmd: DispatchCommand): Promise<boolean> {
    const agent = agentsRepo.getAgentById(cmd.agentId)
    if (!agent) {
      log.warn('unknown agent in execute', { agentId: cmd.agentId, traceId: cmd.traceId })
      return false
    }
    const agentCfg = rowToAgent(agent)
    const slot = ensureSlot(cmd.agentId, cmd.sessionId)

    // ── 决策段（同步，无 await——单线程原子，防批内双执行） ──
    if (slot.status === 'busy') {
      // B 触发合并（A2A 风暴治理）：A2A 链（depth>0）且同 session 已有排队命令 →
      // 不入队，并入该命令的 pendingTriggers（出队执行时点名"还有 N 件事"）。
      // 合并判定与并入写入同一同步块、中间无 await——Node 单线程下天然原子。
      if (cmd.depth > 0) {
        const queued = slot.queue.find((c) => c.sessionId === cmd.sessionId)
        if (queued) {
          queued.pendingTriggers.push(cmd.triggerMessageId)
          log.info('agent trigger merged into queued command', {
            traceId: cmd.traceId,
            agentId: cmd.agentId,
            agentName: agentCfg.name,
            mergedTrigger: cmd.triggerMessageId,
            totalPending: queued.pendingTriggers.length + 1,
          })
          systemBridge?.(
            cmd.sessionId,
            cmd.agentId,
            `🐱 ${agentCfg.name} 收到新触发已合并——当前排队任务将一并处理（共 ${
              queued.pendingTriggers.length + 1
            } 件事待办）`
          )
          return false
        }
      }
      if (slot.queue.length >= MAX_QUEUE_PER_AGENT) {
        // 队列上限：拒绝入队并通知前端（不静默丢弃——用户消息需知道"没排上"）
        log.warn('agent queue full, rejecting command', {
          traceId: cmd.traceId,
          agentId: cmd.agentId,
          agentName: agentCfg.name,
          queueLength: slot.queue.length,
          max: MAX_QUEUE_PER_AGENT,
        })
        systemBridge?.(
          cmd.sessionId,
          cmd.agentId,
          `🐱 ${agentCfg.name} 的队列已满（${MAX_QUEUE_PER_AGENT} 条），本条消息暂未排队，请稍后再试`
        )
        // 标 done（terminal，与「无有效目标→done」同款）——多目标守卫：非 NULL 不覆盖
        if (!messagesRepo.getDispatchState(cmd.triggerMessageId)) {
          messagesRepo.setDispatchState(cmd.triggerMessageId, 'done')
        }
        return false
      }
      slot.queue.push(cmd)
      updateQueueState(slot)
      // P0 队列持久化：入队即落库 queued，server 重启后可恢复
      messagesRepo.setDispatchState(cmd.triggerMessageId, 'queued')
      log.info('agent queued', {
        traceId: cmd.traceId,
        agentId: cmd.agentId,
        agentName: agentCfg.name,
        queueLength: slot.queue.length,
      })
      return false
    }

    // 交接请求去重（执行时点检查）：请求排队期间作者已落库完整文档 → 跳过执行
    if (isStaleHandoffRequest(cmd)) {
      log.info('stale handoff request skipped (idle)', {
        traceId: cmd.traceId,
        agentId: cmd.agentId,
        agentName: agentCfg.name,
        triggerMessageId: cmd.triggerMessageId,
      })
      messagesRepo.setDispatchState(cmd.triggerMessageId, 'done')
      return false
    }

    // ── idle → 标 busy + 审计 + 执行 ──
    await executeAgentCommand(agentCfg, cmd, cmd.traceId)
    return executeRun(cmd, agentCfg)
  }

  // 修正 ctx 的 execute 引用（占位换真实现）
  ctx.execute = execute

  return {
    execute,
    executeAgentsSerial: (sessionId, agents, triggerMsg, traceId, depth = 0) =>
      executeAgentsSerialImpl(ctx, sessionId, agents, triggerMsg, traceId, depth),
    cancelQueuedCommand: (triggerMessageId: string): number => {
      let removed = 0
      for (const bySession of slots.values()) {
        for (const slot of bySession.values()) {
          const before = slot.queue.length
          const filtered = slot.queue.filter((cmd) => cmd.triggerMessageId !== triggerMessageId)
          if (filtered.length !== before) {
            slot.queue = filtered
            removed += before - filtered.length
            updateQueueState(slot)
          }
        }
      }
      if (removed > 0) {
        log.info('queued commands cancelled', { triggerMessageId, removed })
      }
      return removed
    },
    clearAgentQueue: (agentId: string, sessionId?: string): number => {
      const bySession = slots.get(agentId)
      if (!bySession) return 0
      let cleared = 0
      // OQ3：带 sessionId 只清该会话槽位；无 → 遍历全部会话（旧语义）
      const targetSessions = sessionId ? [sessionId] : [...bySession.keys()]
      for (const sid of targetSessions) {
        const slot = bySession.get(sid)
        if (!slot || slot.queue.length === 0) continue
        for (const cmd of slot.queue) {
          try {
            messagesRepo.setDispatchState(cmd.triggerMessageId, 'done')
          } catch (err: any) {
            log.error('setDispatchState failed during queue clear (non-blocking)', {
              agentId,
              sessionId: sid,
              triggerMessageId: cmd.triggerMessageId,
              error: err.message,
            })
          }
        }
        cleared += slot.queue.length
        slot.queue = []
        updateQueueState(slot)
      }
      if (cleared > 0) {
        log.info('agent queue cleared by user interrupt', { agentId, sessionId, cleared })
      }
      return cleared
    },
    isAnyAgentExecutingMessage: (triggerMessageId: string): boolean => {
      for (const bySession of slots.values()) {
        for (const slot of bySession.values()) {
          if (slot.currentTriggerMessageId === triggerMessageId) return true
        }
      }
      return false
    },
    getSlot: (agentId, sessionId) => {
      const slot = getSlotInternal(agentId, sessionId)
      return slot ? slotToRuntimeState(slot) : undefined
    },
    snapshot: () => {
      const out: AgentRuntimeState[] = []
      for (const bySession of slots.values()) {
        for (const slot of bySession.values()) {
          out.push(slotToRuntimeState(slot))
        }
      }
      return out
    },
    disposeSession: (sessionId: string) => {
      for (const [agentId, bySession] of slots) {
        bySession.delete(sessionId)
        if (bySession.size === 0) slots.delete(agentId)
      }
    },
    setAgentStateBridge: (fn) => {
      stateBridge = fn
    },
    setSystemMessageBridge: (fn) => {
      systemBridge = fn
    },
    abortAgent: (agentId, sessionId) => state.abortAgent(agentId, sessionId),
    setRetraction: (messageId) => state.setRetraction(messageId),
    clearRetraction: (messageId) => state.clearRetraction(messageId),
    listActiveStreams: () => state.listActiveStreams(),
    getActiveStream: (agentId) => state.getActiveStream(agentId),
    __test_reset: () => {
      state.__test_reset()
      slots.clear()
      tokenPool.reset()
      stateBridge = null
      systemBridge = null
    },
    __test_resetLockState: () => state.__test_resetLockState(),
    __test_resetMentionCounts: () => state.__test_resetMentionCounts(),
    __test_resetM1Warned: () => state.__test_resetM1Warned(),
    __test_resetRuns: () => state.__test_resetRuns(),
    __getMentionCount: (traceId, agentId) => state.getMentionCount(traceId, agentId),
    __setMentionCount: (traceId, agentId, count) => state.setMentionCount(traceId, agentId, count),
    __test_seedSlot: (agentId, sessionId, opts) => {
      const slot = ensureSlot(agentId, sessionId)
      slot.status = 'busy'
      slot.currentTriggerMessageId = opts.currentTriggerMessageId
      slot.queue = opts.queue ?? []
    },
  }
}

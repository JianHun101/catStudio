/**
 * Execution — 点单管理组（第 3 刀从 connectors/socketio.ts 迁出，零控制流变化；
 * 3.5 刀模块态 → 实例态：状态经注入的 EngineState 参数消费，finalizeRun 统一
 * 五处 completeExecution 收口点）。
 *
 * C1 v3（调度层重构）：模块级槽位状态（dispatch/ 的 agentSlots/agentQueues）收进
 * engine 闭包——调度键升 agentId+sessionId（跨会话同猫并行、同会话同猫 FIFO 保留），
 * 执行器并发化（批内并行），加 ProviderTokenPool（provider 并发 cap）。外面只认
 * engine 的 execute(cmd) 单接口：决策(直跑/入队) → 执行 → finally{收口+排空}
 * （token 由 executeOneAgent 的 LLM 段自持——A 方案，见该函数注释）。
 *
 * executeOneAgent / executeAgentsSerial / drainQueuedCommand + 执行常量与
 * no-key 守卫。输出经注入 bus（EngineBus & HandoffBus），状态经注入 state。
 * 日志通道沿用 'socketio'（零可观测行为变化）。
 */

import { execSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import {
  type AgentConfig,
  type AgentRuntimeState,
  type DispatchCommand,
  type Message,
} from '@cat-study/shared'
import {
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  executionLogs as execLogsRepo,
  spans as spansRepo,
} from '../db/repository/index.js'
import { createExecTrace, insertDetachedSpan, type ExecTrace } from './trace.js'
import { createLogger } from '../logger.js'
import { MAX_QUEUE_PER_AGENT, isStaleHandoffRequest } from '../dispatch/index.js'
import { ProviderTokenPool } from './token-pool.js'
import { classifyError } from '../eval/classify-error.js'
// 诊断取值单源（R5 §B）：catch 到的**任何**值都要能落出可辨识信息——`err.message`
// 对非 Error 抛出物恒为 undefined（诊断当场归零）。注：库内 19 行 `execute crash`
// **不是**这条路来的（那 19 行的 catch 从未触发过），成因是 `executeRun` finally 段
// 的误收口——R7 已加归属校验除根，该词随之退役；19 行是历史存量，不再新增。
import { messageOf } from '../utils.js'
import {
  cleanGitEnv,
  ensureAgentWorktree,
  getSessionWorktreePath,
  gitCommit,
} from '../llm/git-utils.js'
import { updateRunningSummary } from '../summarizer/index.js'
import {
  parseMentionsFromReply,
  detectUnknownHandle,
  detectInlineMentions,
} from '../connectors/a2a-mentions.js'
import { filterAllowedMentions, allowedTargetsDescription } from '../dispatch/mention-policy.js'
import { consumeRouteSignals } from '../llm/route-signals.js'
import { recordReviewVerdict } from '../eval/verdict-parser.js'
import { advanceFlowAfterVerdict } from './flow-advance.js'
import { maybeScoreSample } from '../eval/sampler.js'
import { judgeReviewFallback, spawnReviewFallback } from './review-fallback.js'
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

/** 单 Agent 在同一 traceId 下被 A2A @ 的**默认**执行上限（用户顶层触发不计数）。 */
export const DEFAULT_MAX_MENTIONS_PER_AGENT = 5

/** 配额阈值（T-K 可配）：`MAX_MENTIONS_PER_AGENT`。
 *
 *  **每次判据处现读**而非模块加载时快照——护栏参数不该重启才生效（与同为运行期
 *  读取的 `PROVIDER_TOKEN_CAP` 同口径），且让"阈值可配"能被测试直接钉住
 *  （改 env → 行为变），不必重载模块。
 *
 *  `0` / 负数 / 非法值 → **回默认 5**，不开放"不限"：这是防循环护栏，不是性能旋钮。
 *  与 `PROVIDER_TOKEN_CAP`（0 = 不限）**刻意不同**，写在此处防按那个惯例误推。
 *
 *  **计数口径 = 单计**（票丑归一）：唯一计数点是 A2A 调度点的「检查 + 预留」
 *  原子段（下方锚点 `+ 1) // 预留配额`），计的是**被派发的目标**。故
 *  `MAX_MENTIONS_PER_AGENT = N` ⇒ **单 trace 内单猫最多被 A2A 派发 N 次**，可直读。
 *  原「调度点 + 执行完成处各计一次 ⇒ 实际轮次 ≈ limit / 2（默认 5 → 约 3 轮）」
 *  的双计口径**已作废**（那是配置值不可直读的根因）。
 *
 *  语义注：预留先于槽位检查 ⇒ **调度即计数**——入队后未执行/失败的派发同样占额
 *  （「预留不退回」是既有语义），钉在 V7。 */
export function resolveMentionLimit(
  raw: string | undefined = process.env.MAX_MENTIONS_PER_AGENT
): number {
  const n = parseInt(raw || '')
  return isNaN(n) || n <= 0 ? DEFAULT_MAX_MENTIONS_PER_AGENT : n
}

// ─── Agent Execution（同消息并发调度） ────────────

/** 同消息并发执行的 agent 数上限——批内 Promise.allSettled 并发启动，批间串行。
 *  语义变化（方案级决策已过审）：广播模式下并行 agent 互不见彼此回复
 *  （A2A 接力不受影响——触发前提是回复已落库）；前端显示顺序 = 完成顺序 */
const CONCURRENT_AGENTS_PER_MESSAGE = 3

/**
 * 入队时刻表（R2 §七 硬点 1）——`dispatch.queue_wait` 的时刻**必须在
 * `slot.queue.push(cmd)` 当场打**，存进队列条目本身。
 *
 * 为什么不落 `DispatchCommand` 上的一个字段：那是 `@cat-study/shared` 的公共类型，
 * 为一个纯观测面的时刻加列要动共享层；`WeakMap` 以队列条目**对象本身**为键，
 * 语义上就是「存在这个条目上」（条目被 shift 出来时同一个引用），且内存态、
 * 不落库、随条目 GC——**硬点要的是「当场打 + 不落库 + 不用
 * `messages.created_at → started_at` 代理」，三条都满足**。
 *
 * 为什么不能用 created_at 代理：对**重放 / 恢复**路径不准（命令重新入队时
 * created_at 是原消息的落库时刻，不是这次排队的时刻）——那正是本段要量的东西。
 */
const queueArrival = new WeakMap<DispatchCommand, number>()

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
  /** 槽位队列长度/状态变更 → 前端 agent-status 广播（socket 桥接） */
  updateQueueState(slot: Slot): void
  publishAgentStatus(slot: Slot, status: string): Promise<void>
  /** 标 busy + 写执行日志（原 dispatch.executeAgentCommand）。
   *  R2 起**返回 execution_logs.id**——段采集器要用它当 `spans.execution_id`
   *  （`ExecTrace` 必须 per-execution，而 executionId 只在这里诞生）。 */
  executeAgentCommand(agent: AgentConfig, cmd: DispatchCommand, traceId: string): Promise<string>
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
  /** per-agent 顶层入口：决策 → 执行 → finally{收口+排空}（token 由 LLM 段自持） */
  execute(cmd: DispatchCommand): Promise<boolean>
}

/** 会话内 store 猫反查（收口决策归店长）——`role-not-allowed` 与 A2A 配额闸
 *  **共用同一形态**（票子：复用而非另写一份）。从 sessionAgentIds 反查，不能复用
 *  allMentionedAgents——那已按 routeNames 过滤，正是被剥除后的集合。无 store 成员
 *  或 store 不在会话内时返回 undefined（调用方据此跳过广播）。 */
function findStoreCat(sessionAgentIds: string[]): AgentConfig | undefined {
  return sessionAgentIds
    .map((id: string) => {
      const row = agentsRepo.getAgentById(id)
      return row ? rowToAgent(row) : null
    })
    .find((a): a is AgentConfig => a !== null && a.role === 'store')
}

/**
 * 段 G `git.auto_commit` 的归属与落库（R2 段五，**轮次级**）。
 *
 * 反查链：触发消息 → 该消息**唯一**执行者那一行（判据与 T-M
 * `updateExecutionLogCommitHash` 逐字同源，`executionLogs.getUnambiguousExecutionRow`）
 * → 该执行的根段 → 挂父落一行。
 *
 * 任一环断了都**只记痕不写行**：跨多只猫（不可消歧）、执行行不存在、时间轴没落库
 * （写失败/被跳过）。**不猜**——「指错父」比「缺一段」坏得多（缺是 R2 §九 26 明写
 * 允许的形态）。全程 try/catch：它在顶层收尾块里，抛了会带走下面的脏文件清理。
 */
function recordAutoCommitSpan(
  triggerMsgId: string,
  chainId: string,
  startMs: number,
  durationMs: number
): void {
  try {
    const logRow = execLogsRepo.getUnambiguousExecutionRow(triggerMsgId)
    if (!logRow) {
      log.info('auto-commit span skipped — executor ambiguous or absent', {
        triggerMessageId: triggerMsgId,
      })
      return
    }
    const rootSpanId = spansRepo.getRootSpanId(logRow.id)
    if (!rootSpanId) {
      log.info('auto-commit span skipped — no root span for execution', {
        triggerMessageId: triggerMsgId,
        executionId: logRow.id,
      })
      return
    }
    insertDetachedSpan({
      executionId: logRow.id,
      parentSpanId: rootSpanId,
      chainId,
      sessionId: logRow.session_id,
      agentId: logRow.agent_id,
      name: 'git.auto_commit',
      startMs,
      durationMs,
    })
  } catch (err: any) {
    log.warn('auto-commit span failed (non-blocking)', {
      triggerMessageId: triggerMsgId,
      error: messageOf(err),
    })
  }
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
  opts: {
    success: boolean
    errorMessage?: string
    replyMessageId?: string
    traceId: string
    /** R2：本执行的段采集器；**收口即落库**（一次事务落 `spans` + `span_llm`）。
     *  缺省 = 无采集器（崩溃兜底路径）——那就不落，不编数据。 */
    trace?: ExecTrace
  }
): Promise<DispatchCommand | undefined> {
  // OQ3：runs 注册表 session 化——精确删本会话 run（跨会话并行的兄弟 run 不受影响）
  ctx.state.endRun(agentId, sessionId)
  // ── R2 段五：关根段 + 一次事务落两表（硬点 2）──────────
  // 位置在 `completeExecution` **之前**：段是这次执行的产物，先落产物再释放槽位。
  // 写库失败绝不抛（`finish` 内部吞掉）——它在关键路径上，抛了会把槽位释放与
  // 队列排空一起带走。超时三条路径（30min 硬超时 / 20min CLI 空闲 / 35min token）
  // 都走本漏斗 ⇒ **都不丢**；只有进程级崩溃丢（R2 §七 残余风险，v1 接受）。
  opts.trace?.finish({
    success: opts.success,
    ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
  })
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
  const queueExecutionId = await ctx.executeAgentCommand(agent, queuedCmd, queuedCmd.traceId)
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
  // token 不在此 acquire：A 方案后 token 由 executeOneAgent 的 LLM 段自行
  // acquire/release——drain 与父执行各自在 LLM 段持 token、编排段都不持。原注释
  // 「运行在父 executeRun 持有的 token 之下」的前提已随作用域收窄失效（父不再持
  // token；而那种共享持锁写法正是嵌套死锁的另一半）。两条入口共用同一 acquire 点，
  // drain 不会无护栏裸跑。
  return (
    (await executeOneAgent(
      ctx,
      queuedCmd.sessionId,
      agent,
      queuedTrigger,
      queuedCmd.traceId,
      queuedCmd.depth,
      {
        executionId: queueExecutionId,
        // 入队时刻（`execute()` 的 push 处当场打的）——本段是「在队列里等了多久」
        ...(queueArrival.has(queuedCmd) ? { queuedAtMs: queueArrival.get(queuedCmd) } : {}),
      }
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
 * - A2A 递归（触发前提是回复已落库）与队列 drain 保持原语义。**两者在收尾段
 *   并发、不互为前置**（形态 D，票 docs/run/dispatch-deferral/tickets.md §五-2）——
 *   原注写「天然串行」已随本笔失效：串行序会把 A2A 派发排在整条 drain 子树之后，
 *   延迟随嵌套深度叠加（实测最坏 47 / 68 分钟）。并发的前提是**两子树无依赖**，
 *   该前提的门取证见 report-gate-concurrency.md（Q1–Q4 零推翻）。
 */
async function executeOneAgent(
  ctx: EngineCtx,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: AgentTriggerMsg,
  traceId: string,
  depth: number,
  /** R2 段五：本次执行的身份 + 入队时刻（见 `queueArrival`） */
  exec: { executionId: string; queuedAtMs?: number }
): Promise<boolean> {
  const { state, bus } = ctx
  // 根段起点取**函数入口时刻**（早于下面两个守卫的判定）——根段覆盖的是一次
  // 「已排上槽位」的完整执行
  const entryMs = Date.now()
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

  // ── R2 段五：采集器创建点（**per-execution**，绝不上 `EngineState`）──────
  // 建在两个守卫**之后**：那两条是「本次不执行」的提前返回（槽位不对/已被别的
  // 触发接管），没有执行可分解，不该留下一个空时间轴。以下任何出口都经
  // `finalizeRun` ⇒ 带着这个 trace 落库。
  const trace = createExecTrace({
    executionId: exec.executionId,
    // 链锚口径 = P1 的 `coalesce(回复.task_id, 触发.task_id)`，回复侧因
    // `insertAgentMessage(..., triggerMsg.taskId || traceId)` 恒非空 ⇒ 链锚 = 本表达式
    chainId: triggerMsg.taskId || traceId,
    sessionId,
    agentId: agent.id,
    startMs: entryMs,
  })
  // ── 段 H `dispatch.queue_wait`（R2 §七 硬点 1）─────────
  // 时刻在 `slot.queue.push(cmd)` 当场打的（`queueArrival`），此处只是补记；
  // 空闲直跑（没进过队列）**没有这一段**——不是漏采，是它压根没排队。
  if (exec.queuedAtMs !== undefined) {
    trace.recordSpan('dispatch.queue_wait', { startMs: exec.queuedAtMs })
  }

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
    const nextCmd = await finalizeRun(ctx, agent.id, sessionId, { success: true, traceId, trace })
    if (nextCmd) {
      try {
        await drainQueuedCommand(ctx, agent, nextCmd, false)
      } catch (e: any) {
        log.error('drain failed after no-api-key completion (queue item stuck)', {
          agentId: agent.id,
          triggerMessageId: nextCmd.triggerMessageId,
          error: messageOf(e),
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
      // ── A 方案（死锁根治，2026-09-09）：token 只包 LLM 段 ──
      // 原 executeRun 把 token 持到「整棵 A2A 子树结束」才在 finally 释放，而 A2A
      // 派发是 await 嵌套子执行（下方 :732）——父持 token 等子、子等 token，链深
      // ≥ cap 即循环等待（09:48:23 静默 7m47s 事故：cap=8、第 9 跳永久互等）。
      // 收窄到此处后，持有 token 的代码段内不再有任何会申请 token 的路径（编排段
      // finalize/drain/A2A 一律不持），等待图从「有环」变成「无环且有界」。
      // executeRun 与 drainQueuedCommand 两条入口都经本函数，自动覆盖。
      // ── 段 D `dispatch.token_wait`（R2 段五）────────────
      // 量在池内（`acquire` 的 `onWaited` 回调）而不是在调用点外侧包一层计时：
      // 「池满时等了多久」是池**自身**的事实（while 循环 + release 唤醒都在里面）。
      // 超时那趟同样报——acquire 的 finally 保证两条路径都回调。
      let tokenWaitedMs: number | null = null
      let releaseToken: (() => void) | undefined
      try {
        releaseToken = await ctx.tokenPool.acquire(providerKey(agent), (ms) => {
          tokenWaitedMs = ms
        })
      } catch (err: unknown) {
        // 池内等待超时（`ProviderTokenAcquireTimeoutError`）：这段**等过、没等着**，
        // 仍要留行（不留 = 事故现场零痕）。本地计时兜底防回调未及触发。
        trace.recordSpan('dispatch.token_wait', {
          startMs: Date.now() - (tokenWaitedMs ?? 0),
          status: 'timeout',
          error: err,
        })
        throw err
      }
      trace.recordSpan('dispatch.token_wait', {
        startMs: Date.now() - (tokenWaitedMs ?? 0),
        durationMs: tokenWaitedMs ?? 0,
      })
      try {
        // 用 Promise.race 防止单个 Agent 的 LLM 调用挂起阻塞后续 Agent
        // AbortController 确保超时后子进程被 kill（P0-1 修复）
        reply = await Promise.race([
          runAgentReply(
            state,
            bus,
            sessionId,
            agent,
            triggerMsg,
            traceId,
            abortController.signal,
            trace
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              abortController.abort()
              reject(new Error(`执行超时 (${AGENT_HARD_TIMEOUT_MS / 1000}s)`))
            }, AGENT_HARD_TIMEOUT_MS)
          ),
        ])
      } finally {
        releaseToken()
      }
    } catch (err: any) {
      // run 注册表收口由 finalizeRun 的 endRun 统一（此前 abort 注销在 finally、
      // stream 清理在此处、其余失败漏斗不清理——各管各的正是本刀收编对象）
      abortController.abort()
      log.error('agent execution failed', {
        agentId: agent.id,
        agentName: agent.name,
        error: messageOf(err),
        stack: err.stack,
        traceId,
      })
      bus.emitSystemNotice({
        id: uuid(),
        sessionId,
        agentId: agent.id,
        content: `🐱 ${agent.name} 暂时无法回复: ${messageOf(err) || '系统错误'}`,
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
      const nextCmd = await finalizeRun(ctx, agent.id, sessionId, {
        success: false,
        errorMessage: messageOf(err) || 'unknown error',
        traceId,
        trace,
      })
      if (nextCmd) {
        try {
          claudeRan = await drainQueuedCommand(ctx, agent, nextCmd, claudeRan)
        } catch (e: any) {
          log.error('drain failed after execution error (queue item stuck)', {
            agentId: agent.id,
            triggerMessageId: nextCmd.triggerMessageId,
            error: messageOf(e),
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
      await finalizeRun(ctx, agent.id, sessionId, {
        success: false,
        errorMessage: 'interrupted',
        traceId,
        trace,
      })
      return claudeRan
    }

    // ── P0（2026-09-09）：mention 解析 + 白名单 + 写回必须早于 drain/A2A await ──
    // 原写回点排在 `await drainQueuedCommand` 与 A2A 子链之后，父执行一旦 drain 了
    // 排队命令，写回就被推迟到整棵下游子树收场；链一断（重启/超时/抛错）即丢失
    // ——实证 7daf017c / 163a981f / 1b1e33c5 / 4377a2e0 / 5c75a555 至今 mentions=[]，
    // 而同窗未 drain 的嵌套回复全部送达。写回是「这条消息路由给谁」的事实记录，
    // 不该依赖下游编排是否跑完，故整体前移到槽位释放之前。
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
    // 天然失效，无需清理逻辑。
    // ⚠️ consumeRouteSignals 是消费语义（取走即清），全流程只能调用一次——
    // 本段前移后，下方 A2A 派发段直接复用此处结果，不得二次调用。
    const signalNames = consumeRouteSignals(sessionId, agent.id, reply.msgId)
      .flatMap((s) => s.targetCats)
      .filter((name) => name !== agent.name)
    const routeNames = [...new Set([...mentionedNames, ...signalNames])]
    // 白名单结果需跨 drain 复用（下方 A2A 派发段），故声明在 if 之外。
    // 泛型实参显式给 AgentConfig：ReturnType 默认按约束实例化会退化成
    // MentionPolicyTarget（丢 id），而下游派发段需要完整 AgentConfig。
    let policy: ReturnType<typeof filterAllowedMentions<AgentConfig>> | undefined
    let allowedNames: string[] = []
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
      policy = filterAllowedMentions(
        { role: agent.role, triggerAuthorName: triggerMsg.authorName },
        allMentionedAgents
      )
      allowedNames = policy.allowed.map((a) => a.name)

      // 将解析出的 mentions 写回 DB，确保后续 Agent 构建上下文时
      // 能通过 mentions.includes(agent.name) 过滤规则看到本消息。
      // 位置契约（P0）：必须在 finalizeRun/drain/A2A 之前——理由见本段首注释。
      if (allowedNames.length > 0) {
        messagesRepo.updateMessageMentions(reply.msgId, JSON.stringify(allowedNames))
      }
    }

    // ── T-A ②（2026-09-10）：执行收尾兜底投递 ──
    // 本执行有 commit 但回复未 @ 审查者 → 补投审查请求（判据与设计理由见
    // execution/review-fallback.ts）。位置契约：必须在 mentions 写回之后（判据读的
    // 就是写回结果）、finalizeExecutionLog 之前（commit_hash 只在 running 行上）。
    // 判据用内存态 allowedNames 而非回读 DB：insertAgentMessage 落库恒为 '[]'，
    // 仅非空时被 updateMessageMentions 覆盖，故 allowedNames 与落库列恒等。
    // fire-and-forget + 全 catch：兜底是安全网，不能把成功路径拖成异常路径。
    try {
      const commitSha = execLogsRepo.getRunningExecutionCommitHash(agent.id)
      const reviewerName =
        sessionAgentIds
          .map((id: string) => agentsRepo.getAgentById(id))
          .find((row) => row?.role === 'reviewer')?.name ?? null
      const judgement = judgeReviewFallback({ commitSha, mentions: allowedNames, reviewerName })
      // 留痕：每一次裁决都记（投/不投 + 理由）——本票唯一的安全网
      log.info('review fallback judged', {
        traceId,
        agentId: agent.id,
        commitSha: commitSha ?? null,
        deliver: judgement.deliver,
        reason: judgement.reason,
      })
      if (judgement.deliver && commitSha) {
        const outcome = spawnReviewFallback(
          getSessionWorktreePath(sessionId) ?? process.cwd(),
          commitSha
        )
        if (!outcome.spawned) {
          log.error('review fallback spawn failed', {
            traceId,
            commitSha,
            reason: outcome.reason,
          })
        }
      }
    } catch (err: any) {
      // 判据查不动（本地 DB 读失败）→ 不静默：error 级留痕。此处 sha 不可知、
      // 无投递目标，故只记错。钩子侧的同一判据**已不是这个方向**：2026-09-12 A 案
      // （`44de053`）把 `decideHookDelivery(null)` 由「投」翻转为「静默让位」，
      // 补投责任移交收尾兜底 `--fallback-sha`——本处的 error 留痕不受其影响。
      log.error('review fallback judgement failed — not delivered', {
        traceId,
        agentId: agent.id,
        error: messageOf(err),
      })
    }

    // 释放槽位并检查队列（P0-2 修复：不再丢弃 completeExecution 返回值）。
    // 成功路径写回回复 id（洞 A 判据：execution_logs.message_id 非空即已回复，
    // 重启恢复精确跳过，不再被后续其他回复的时间窗误判）。撤回窗（Window ②/③）
    // 提前返回的 ghost id 不可达——撤回必删触发消息与 execution_logs（MESSAGE_RETRACT
    // handler），恢复入口 getMessageByIdOnly 直接 continue
    const queuedCmd = await finalizeRun(ctx, agent.id, sessionId, {
      success: true,
      replyMessageId: reply.msgId,
      traceId,
      trace,
    })

    // W2 L2 评估采样：fire-and-forget——不 await、不占 slot、不进 dispatch 主链，
    // 失败静默（内部 catch）。只对 DS 族猫回复采样（ollama 猫不评估）
    maybeScoreSample(agent, sessionId, reply.msgId)

    // ── 形态 D（票 docs/run/dispatch-deferral/tickets.md §五-2）：drain 子树与下方
    // A2A 派发子树**并发**，帧尾合并 await。
    // 原实现把 drain 串在派发之前（为 d448413a「弹出命令干等 A2A 嵌套链 5.9 分钟」
    // 而设），代价在反方向：A2A 派发要等**整条** drain 子树跑完，而 drain 出的命令
    // 自己又跑一整条 A2A 嵌套链 ⇒ 派发延迟随嵌套深度叠加、无上界（实测最坏 47 / 68
    // 分钟，票面 §三-2 / §三-3，两例全为延迟、零丢弃）。
    // 两子树在同一帧内本无依赖，唯一关系是「都在本帧收尾之后」——谁都不搬：两条
    // promise 并发启动。这样 V1（派发时点不随 drain 子树漂移）与 V3（排队命令不干等
    // A2A 嵌套链，d448413a 不回归）**同时**成立，因为没有谁排在谁后面。
    // 失败路径的不对称（本笔新增边界，见报告 §V6）：任一子树抛错 ⇒ 帧立即进下方
    // catch（与串行同）；另一子树**不再被帧等待**（串行下它根本不会启动）。其异常
    // 仍被 Promise.all 订阅，不产生 unhandledRejection，但它的完成不再阻塞帧。
    const drainP: Promise<boolean> = queuedCmd
      ? drainQueuedCommand(ctx, agent, queuedCmd, claudeRan)
      : Promise.resolve(false)
    /** A2A 派发子树（`:1020` 段赋值）；无目标时保持 false 的已决 promise */
    let dispatchP: Promise<boolean> = Promise.resolve(false)

    // ── 票丑 · 计数点归一：此处原「执行成功后记录 mention 计数」（`depth>0` 时对
    // **执行者自己** +1）已删除，配额改为**单计**。唯一计数点是下方 A2A 调度点的
    // 「检查 + 预留」原子段（锚点 `+ 1) // 预留配额`），计的是**被派发的目标**。
    //   · 语义 = **调度即计数**：预留先于槽位检查 ⇒ 入队未执行/失败的派发同样占额
    //     （「预留不退回」是既有语义）。原此处注释主张的「未执行的排队任务不消耗
    //     配额」在单计下**与原意相反**，下葬凭证是 V7（机器判据，非注释）。
    //   · 单位可直读：`MAX_MENTIONS_PER_AGENT=N` ⇒ 单 trace 内单猫最多被 A2A **派发** N 次。
    //   · 顶层触发（depth=0）不消耗**自己的**配额——单计后执行者永不自计，与旧
    //     `depth>0` 门等效（用户 @ 触发的执行不会把计数推满、误杀后续同 trace 的 A2A @）。
    //   · 并发互斥仍由预留点单独承担（检查与执行之间隔着整个 LLM 调用，见下方原子段）。

    // Agent-to-agent dispatch：解析/白名单/写回已在上方 P0 段完成（槽位释放
    // 之前），本段只做「通知 + 配额 + 派发」——写回不再依赖本段执行时机。
    if (policy) {
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

        // 兜底通知（收口链回作者通路修复 · 修法②）：仅提示发送者不够——它若没
        // 另寻他路，被拦的结论就静默停摆（2026-09-09 实证：吐槽猫 的 ⚠️ 被拦，
        // 作者与店长均不知情，卡 10 分钟）。故除提示发送者外，同时告知会话内
        // store 猫（收口决策归店长）。只对 role-not-allowed 发——count-limit 的
        // 补救路径明确（拆条重发，提示已给发送者），不构成结论悬空。
        // 目标从 sessionAgentIds 反查（不能复用 allMentionedAgents——那已按
        // routeNames 过滤，正是被剥除后的集合）；发送者本身是 store 时跳过。
        //
        // ⚠️ 触达边界（裁决 (a)，2026-09-09 实测）：本通知是 **UI 提示（人类可见）**，
        // **不触达 store agent 上下文**——emitSystemNotice 只做房间广播、不落库
        // （socketio.ts:134），而 agent 上下文由 getRecentMessages 过滤
        // role != 'system'（routes/messages.ts:120）→ 店长 agent 永远看不到它，
        // 包括「下次执行」时。真正的 agent 级触达需落库 + 定向 dispatch 唤醒店长，
        // 属新的自动唤醒链（要过 ADR-0007 + 风暴护栏评估），另单评估。
        // 所以本通知的作用是「给人看、别让结论无声消失」，**不是「叫醒店长」**。
        if (roleBlocked.length > 0 && agent.role !== 'store') {
          const storeCat = findStoreCat(sessionAgentIds)
          if (storeCat) {
            bus.emitSystemNotice({
              id: uuid(),
              sessionId,
              agentId: storeCat.id,
              content: `🐱 ${agent.name} 的 @ 被角色策略拦下（${roleBlocked
                .map((b) => b.name)
                .join('、')}）——该结论可能悬空，请关注`,
              mentions: [],
              createdAt: new Date().toISOString(),
            })
          }
        }
      }

      if (allowedNames.length > 0) {
        // W3 L3 审查结论解析钩子（reviewer 角色门 + 锚定行首标记）。
        // subject 从作用域 allowedNames 直取——不读 DB mentions 列（写回已在上方
        // P0 段独立完成，与本钩子解耦）；allowedNames 为空（全剥除）时不进入
        // 本块，钩子天然不触发。recordReviewVerdict 内部写操作独立 try/catch，
        // DB 异常静默丢弃——审查链主流程零阻塞（契约边界）
        if (agent.role === 'reviewer') {
          // 契约③ X2（flow-advance）：verdict 落盘后推进状态机 + closeout 兜底提醒。
          // recordReviewVerdict 返回落盘的 verdict（null=无有效结论，不推进）；
          // verdict 判据（approve→closed 推进 / suggest●reject→内容寻址不动）+ 判定式
          // 收口是否已投（targets 含 store 猫）由 flow-advance 内判。非阻塞：同步函数
          // 内部 try/catch（状态推进是同步 DB 写；closeout 投递走 ingest 异步管线，
          // 以 then/catch 收尾不 await）——本钩子在评审回复落库后，主流程零影响。
          // id 必须带（T-N 修复）：`recordReviewVerdict` 落库的 subject 取 target.id，
          // 少了它编译期就炸（VerdictTarget.id 必填）——这正是必填的目的。
          // policy.allowed 运行时是完整 AgentConfig（见上方 :538-540 注释——
          // 那里特意显式给了泛型实参，防的正是「退化成 MentionPolicyTarget 丢 id」），
          // 所以 id 现成，不需回查 DB。
          const reviewedTargets = policy.allowed.map((a) => ({
            id: a.id,
            name: a.name,
            isStore: a.role === 'store',
          }))
          const parsedVerdict = recordReviewVerdict({
            messageId: reply.msgId,
            sessionId,
            reviewerAgentId: agent.id,
            content: reply.content,
            targets: reviewedTargets,
          })
          if (parsedVerdict) {
            advanceFlowAfterVerdict({
              messageId: reply.msgId,
              sessionId,
              verdict: parsedVerdict,
              targets: reviewedTargets,
            })
          }
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
        // 预留 = **调度即计数**（票丑归一后**唯一**计数点，本处即配额单位本身）：
        // 单位 = 被派发次数，含**入队未执行/后续失败**的派发（预留后不扣回）；
        // 本段之前的「目标执行成功再 +1」已删——那条双计让 limit 不可直读。
        // 顶层触发（depth=0）不消耗自己的配额：计数只落**目标桶**，执行者永不自计。
        // 阈值 T-K 起可配（resolveMentionLimit 现读 env）：单计 ⇒ `limit` **就是
        // 「单 trace 内单猫最多被派发几次」**，可直读。
        const limit = resolveMentionLimit()
        const limitedAgents: AgentConfig[] = []
        for (const a of policy.allowed) {
          const count = state.getMentionCount(traceId, a.id)
          if (count >= limit) continue
          state.setMentionCount(traceId, a.id, count + 1) // 预留配额
          limitedAgents.push(a)
        }
        if (limitedAgents.length < policy.allowed.length) {
          const skipped = policy.allowed.filter((a) => !limitedAgents.includes(a))
          // T-K：配额拦截此前**只有 info 级日志**——info 级在生产没人看 ⇒ 观感上就是
          // "派活凭空消失"（派活单实证：4 条被吞的派活 `dispatch_state=NULL`，执行链上
          // 无 warn）。抬到 `warn`，与 depth limit 同口径。
          // 计数字段名带**单位**：单计后 `limit` = 该 trace 内该猫的**派发次数**上限，
          // 可直读（不再有双计那层「实际轮次 ≈ limit/2」的折半）。
          log.warn('agent-to-agent mention limit filtered', {
            traceId,
            fromAgent: agent.name,
            limit,
            skippedCount: skipped.length,
            skipped: skipped.map((a) => a.name),
            remainingCount: limitedAgents.length,
            remaining: limitedAgents.map((a) => a.name),
          })

          // 票子（Decisions 39 二）：warn 只落文件 ⇒ 生产上仍等于静默。实证两点
          // （2026-09-12 12:55:02 ds猫 的审查请求 / 12:59:37 店长的补投，两次撞同一
          // 堵墙）——被拦方故障窗口 6 分钟，链上无人在能感知。故按同文件另两条护栏
          // 补「可见面」，形态逐项对齐、不引新机制：
          //   · 发送者提示 ← count-limit（emitSystemNotice 到发送者 agent.id）
          //   · store 广播 ← role-not-allowed（收口决策归店长；发送者是 store 时跳过）
          // 触达边界与 role-not-allowed 同（裁决 (a)）：UI 提示、不进 agent 上下文。
          // ⚠️ 与 role-not-allowed 的**差异**在此：那条的补救路径明确（拆条/换目标
          // 重发），本条桶 `(traceId, agentId)` 已耗尽 ⇒ 发送者自己修不了，所以
          // **不能照搬「补救路径明确就不发 store」的豁免**，store 广播必须发。
          const skippedNames = skipped.map((a) => a.name)
          bus.emitSystemNotice({
            id: uuid(),
            sessionId,
            agentId: agent.id,
            content: `🐱 ${agent.name} 你 @ 的 ${skippedNames.join('、')} 未派发：本任务链上该猫的 A2A 配额已用尽（上限 ${limit}），该 mention 已忽略`,
            mentions: [],
            createdAt: new Date().toISOString(),
          })
          if (agent.role !== 'store') {
            const storeCat = findStoreCat(sessionAgentIds)
            if (storeCat) {
              bus.emitSystemNotice({
                id: uuid(),
                sessionId,
                agentId: storeCat.id,
                content: `🐱 ${agent.name} 的 @ 被 A2A 配额拦下（${skippedNames.join('、')}）——该结论可能悬空，请关注`,
                mentions: [],
                createdAt: new Date().toISOString(),
              })
            }
          }
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
          // ——形态 D 下改为「并发启动 + 帧尾合并 await」（见上方 drainP 段注释）：
          // 返回值仍是 `|| claudeRan` 的并集，只是合并点从本行挪到帧尾
          dispatchP = executeAgentsSerialImpl(
            ctx,
            sessionId,
            limitedAgents,
            { ...agentTrigger, authorName: agent.name },
            traceId,
            depth + 1
          )
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

    // 形态 D 帧尾合并：两子树都 await（`claudeRan` 冒泡通道**逐字保留**——票面 §五-2
    // 据此弃了候选 A：登记化会让这条返回值无处回传，顶层 anyClaude 脏文件清理判定漏判）。
    // `Promise.all` 的拒绝语义与串行等价：任一子树抛错即进下方 catch。
    const [drainedRan, dispatchedRan] = await Promise.all([drainP, dispatchP])
    return claudeRan || drainedRan || dispatchedRan
  } catch (err: any) {
    // P0-1 修复：外层 try/catch 防止 completeExecution 或 agent-to-agent
    // dispatch 中的任何异常导致执行体崩溃、槽位永久卡死
    log.error('post-execution error — releasing slot', {
      agentId: agent.id,
      agentName: agent.name,
      error: messageOf(err),
      traceId,
    })
    const nextCmd = await finalizeRun(ctx, agent.id, sessionId, {
      success: false,
      errorMessage: messageOf(err) || 'post-execution error',
      traceId,
      trace,
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
        drainClaudeRan = await drainQueuedCommand(ctx, agent, nextCmd, needsLock)
      } catch (e: any) {
        log.error('drain failed after post-execution error (queue item stuck)', {
          agentId: agent.id,
          triggerMessageId: nextCmd.triggerMessageId,
          error: messageOf(e),
        })
      }
    }
    return drainClaudeRan
  } finally {
    if (needsLock) state.releaseLock()
  }
}

/** 顶层收尾的提交 / 清理目标树（一猫一 worktree，T-2 Phase I §三-3） */
interface CommitTarget {
  agentId: string
  /** 该猫的目标树；null = 建不出（降级：跳过这棵，**绝不落主仓库**） */
  cwd: string | null
}

/**
 * 解析「本调度树内执行过的猫」→ 各自的提交 / 清理目标树。
 *
 * **为什么不能只提交一棵树**（票面 §三-3，本票最重的一处）：一猫一 worktree 后
 * 猫的改动停在**各自的** worktree 里，会话树不再是猫干活的地方 ⇒ 只提交会话树会让
 * 猫分支恒空、fan-in 合个寂寞（E5 静默丢活）。
 *
 * 取数点 = `execution_logs.trace_id`（见 `listExecutorAgentIdsByTrace` 的取舍论证），
 * 并**防御性并上本次批次**：查询异常 / DB 写失败时至少不丢本轮直接派发的猫。
 * 多出来的一棵是零代价的 no-op（`gitCommit` 对无改动树返回 null），少一棵却是
 * 「改动永远没进过任何地方」——两个方向的代价不对称，故并集取宽。
 *
 * 本函数**不抛**：顶层收尾之后还有 ② 脏文件清理与增量摘要，单只猫建树失败不该
 * 带走它们；失败逐条留痕，不静默。
 */
function resolveCommitTargets(
  sessionId: string,
  traceId: string,
  batch: AgentConfig[]
): CommitTarget[] {
  const out: CommitTarget[] = []
  try {
    const ids = new Set<string>(batch.map((a) => a.id))
    try {
      for (const id of execLogsRepo.listExecutorAgentIdsByTrace(traceId)) ids.add(id)
    } catch (err: any) {
      log.warn('executed-agent lookup failed — falling back to current batch', {
        traceId,
        error: messageOf(err),
      })
    }

    const seenCwd = new Set<string>()
    for (const id of ids) {
      const row = agentsRepo.getAgentById(id)
      if (!row) continue
      const agent = rowToAgent(row)
      let cwd: string | null = null
      try {
        cwd = ensureAgentWorktree(sessionId, agent)
      } catch (err: any) {
        // 猫名非法（含 `/` / 清洗后为空）或所有权冲突 ⇒ `ensureCatWorktree` 显式抛错。
        // 此处不吞成静默：该猫这一轮的改动确实不会被提交，留一条 error 级留痕。
        log.error('worktree resolve failed — tree skipped', {
          traceId,
          agentId: agent.id,
          agentName: agent.name,
          error: messageOf(err),
        })
      }
      if (cwd) {
        if (seenCwd.has(cwd)) continue // 同一棵树只提交 / 清理一次
        seenCwd.add(cwd)
      }
      out.push({ agentId: agent.id, cwd })
    }
  } catch (err: any) {
    log.error('commit target resolution failed', { traceId, error: messageOf(err) })
  }
  return out
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
      batch.map((agent) => ctx.execute(makeCmd(sessionId, agent, triggerMsg, traceId, depth)))
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) anyClaude = true
    }
  }

  // 顶层调度完成后清理 + 自动提交
  if (depth === 0) {
    ctx.state.clearMentionCountsForTrace(traceId)
    // 目标树在 try 之外解析：② 的脏文件清理要用**同一份**集合，而它在 finally 里。
    // `resolveCommitTargets` 自身不抛（见其注释），两条路径都拿到稳定读数。
    const commitTargets = resolveCommitTargets(sessionId, traceId, agents)
    try {
      // 自动 git commit —— **逐猫各自那棵树**（T-2 Phase I §三-3，本票最重的一处）。
      //
      // ── T-1 Phase 2：降级路径收窄（①）──────────────────────
      // worktree 是**唯一合法**的提交作用域（现为一猫一棵，见 `resolveCommitTargets`），
      // 目标树建不出来（非 git 仓 / shortId 形态异常 / 集成分支不在 / 命名非法 / 自建失败）
      // → **不提交** + 显式告警。
      //
      // 删掉的 `?? process.cwd()` 兜底不是「少了一条降级路」，而是**拆掉一个静默翻译**：
      // 它把「worktree 不可用」译成「在主仓库干」——`gitCommit` 无 cwd ⇒ `git add -A`
      // + commit **落主仓库当前分支**（绕过审查链）。它与 ② 是配对的：① 一旦停手，
      // ② 的 `git checkout -- .` 会把同一批改动**静默删除**（内容不在 git 里，比误提交
      // 更不可逆）。故 ①② 同批改，缺一不可（票面 §一 Phase 2）。
      //
      // 注：`ensureAgentWorktree` 是同步阻塞调用（建分支 + worktree add + junction，
      // 票面 R1 要求实测耗时）。本段下面的 `git.auto_commit` span 仍**只量 `gitCommit`
      // 本身**，不含建 worktree 的耗时——不悄悄改写 R2 已交付段的口径（是否纳入挂 OQ）。
      const commitT0 = Date.now()
      const commits: Array<{ agentId: string; cwd: string; hash: string }> = []
      for (const target of commitTargets) {
        if (!target.cwd) {
          // 降级**不静默**：`ensureAgentWorktree` 内部已对具体成因各留一条 warn，此处补的是
          // 「于是这棵树的自动提交被跳过了」这一后果——缺了它，读者只看得到成因、看不到后果。
          log.warn('auto commit skipped — worktree unavailable', {
            traceId,
            sessionId,
            agentId: target.agentId,
            triggerMessageId: triggerMsg.id,
            reason: '目标 worktree 不可用（ensureAgentWorktree 返回 null）⇒ 不提交，绝不落主仓库',
          })
          continue
        }
        const hash = gitCommit(`catstudy [${triggerMsg.id}]`, { cwd: target.cwd })
        if (hash) commits.push({ agentId: target.agentId, cwd: target.cwd, hash })
      }
      // ── 段 G `git.auto_commit`（R2 段五）─────────────────
      // 这是本票唯一一段**跨执行**的 span：`depth=0` 的自动提交在全部 `execute()`
      // 返回之后跑，收的是整轮改动，不属于任何单次执行。归属判据与下面
      // `updateExecutionLogCommitHash`（T-M）**逐字同源**：执行行跨多只猫时这个 sha
      // 指认不出作者 ⇒ 段也指认不出父 ⇒ **不写**（缺 ≠ 失败，验收 26）。
      // `gitCommit` 是 3 次连续 `execSync`（阻塞整个 Node 事件循环）——`execLogsRepo`
      // 之外本段是全票唯一的「跨执行隐藏停顿」，值得留痕。
      // 只为**真产生了 commit** 的轮次留行：无改动时 `gitCommit` 返回 null，
      // 该段缺省（验收 26 明写「无改动时该段可缺」）。
      if (commits.length > 0) {
        // 链锚口径与执行内各段**逐字同源**（`triggerMsg.taskId || traceId`）——
        // 轮次段与执行段必须能串进同一条链，两处各写一份表达式就是下一个漂移源
        recordAutoCommitSpan(
          triggerMsg.id,
          triggerMsg.taskId || traceId,
          commitT0,
          Date.now() - commitT0
        )
        // 将 commit hash 写回 execution_logs（本轮所有相关日志）。
        // T-M：本轮执行行跨多只猫时这个 sha 指认不出作者 → 写回侧**拒写**（不再给每只猫
        // 都记一笔"我提交了它"，把"指错人"从读侧的猜变成写侧的制造）。拒写可观测：
        // 不静默——静默拦截正是 T-K 治的形态。
        //
        // 一猫一 worktree 后多一种不可消歧形态：**同一轮里多棵树各自提交**（每只猫
        // 一个 sha）⇒ 单值 `commit_hash` 列装不下，与「跨多只猫」同款处置——不猜、
        // 不挑一个写进去，缺 ≠ 失败（验收 26）。
        if (commits.length === 1) {
          const written = execLogsRepo.updateExecutionLogCommitHash(triggerMsg.id, commits[0].hash)
          if (written.skippedAmbiguous) {
            log.warn('auto-commit hash not written back — executor ambiguous', {
              traceId,
              triggerMessageId: triggerMsg.id,
              commitHash: commits[0].hash,
              distinctAgents: '>1',
              writtenRows: written.changes,
              reason: '本轮执行行跨多只猫，自动提交的 sha 无法指认唯一作者（T-M）',
            })
          }
        } else {
          log.warn('auto-commit hash not written back — multiple trees committed', {
            traceId,
            triggerMessageId: triggerMsg.id,
            commitCount: commits.length,
            agents: commits.map((c) => c.agentId),
            reason:
              '一猫一 worktree ⇒ 本轮多棵树各自提交，单值 commit_hash 列装不下（无唯一值可写）',
          })
        }
      }
    } finally {
      if (anyClaude) {
        // 清理 Agent 执行遗留的脏文件（编辑中断、未追踪的新文件等）——
        // 仅当本次调度树有 Claude 执行过（只有它会编辑源文件；A2A 子链 /
        // 队列 drain 的 Claude 执行经返回值冒泡计入）。成功路径 git commit
        // 后工作区应为干净状态，此检查为无操作。
        // 锁文件已由各执行体 finally 配对释放（引用计数归零时删除）——
        // 此处不再操作锁（派活单必改点 2：保留会让引用计数变负）
        //
        // 脏文件检查/清理作用到**每只猫各自那棵树**（与 ① 同一份 `commitTargets`）
        // ——猫的执行环境在 worktree，脏文件只在 worktree 里产生；主工作区不受猫
        // 影响无需清理。
        //
        // ── T-1 Phase 2：与 ① 同批收窄（②）────────────────────
        // 作用域走 `ensureAgentWorktree`（查 + 建）；建不出 → **不清理** + 显式告警。
        // 删掉的 `?? process.cwd()` 兜底会让下面三条命令**作用到主仓库整棵树**：
        // `git checkout -- .` 回滚主仓库全部未提交的 tracked 改动（含他人在 dev 上的
        // 在途工作），`git clean -fd` 删主仓库未跟踪且未忽略的文件。这条路径**无回滚**
        // ——被删的内容不在 git 里。
        //
        // `env: cleanGitEnv()` 与 `git-utils.ts` 的 `gitCommit` 对称：git 跑钩子时向
        // 子进程注入 `GIT_DIR`，而环境变量优先级高于 `cwd` 探测 ⇒ 不剥就会让清理
        // **漂移出目标仓库**（本仓被这条坑过：主仓库 `core.bare` 被写成 true）。
        for (const target of commitTargets) {
          if (!target.cwd) {
            // 措辞刻意**不含** `dirty workspace` 子串：`dirty workspace after agent
            // execution, resetting` 是「② 真动手了」的判据，两者的告警文本一旦重叠，
            // 「跳过」与「执行了」在读日志时就再也分不开
            log.warn('dirty-file cleanup skipped — worktree unavailable', {
              traceId,
              sessionId,
              agentId: target.agentId,
              reason:
                '目标 worktree 不可用（ensureAgentWorktree 返回 null）⇒ 不清理，作用域绝不落主仓库',
            })
            continue
          }
          try {
            const status = execSync('git status --porcelain', {
              cwd: target.cwd,
              env: cleanGitEnv(),
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }).trim()
            if (status) {
              log.warn('dirty workspace after agent execution, resetting', {
                traceId,
                agentId: target.agentId,
                cwd: target.cwd,
              })
              execSync('git checkout -- .', {
                cwd: target.cwd,
                env: cleanGitEnv(),
                stdio: 'ignore',
              })
              execSync('git clean -fd', { cwd: target.cwd, env: cleanGitEnv(), stdio: 'ignore' })
            }
          } catch {
            // 非 git 仓库 / 该树已不可达，忽略
          }
        }
      }
    }

    // 增量摘要：异步更新运行中的会话摘要（fire-and-forget，不阻塞后续对话）
    updateRunningSummary(sessionId).catch((err) => {
      log.warn('incremental summary failed (non-blocking)', {
        traceId,
        sessionId,
        error: messageOf(err),
      })
    })
  }

  return anyClaude
}

/** 执行引擎公共面（第 3 刀最小形态：执行入口 + 中断控制；恢复入口第 4 刀并入）。
 *  3.5 刀补状态 accessor：connector handler（MESSAGE_RETRACT / JOIN_SESSION）与
 *  internal.ts（经 socketio 委托）经此寻址引擎实例态。
 *  C1 v3：调度键升 agentId+sessionId——同 agent 跨会话并行，同会话同 agent FIFO
 *  保留；execute(cmd) 单入口（决策→执行→finally 收口+排空；token 由 LLM 段自持）；
 *  加并发护栏（ProviderTokenPool）。 */
export interface ExecutionEngine {
  /** C1 v3 顶层单入口：决策(直跑/入队)→执行→finally{收口+排空}。token 不在此层
   *  acquire——A 方案收进 executeOneAgent 的 LLM 段（原覆盖整棵 A2A 子树，链深
   *  ≥ cap 即循环等待死锁）。
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
   * 测试钩子：读 token 池在某 providerKey 上的在飞数。
   * 验收③/⑧ 用它断言「LLM 段外 activeCount = 0」——作用域收窄前父执行在
   * 编排段仍持有 token（值 1），收窄后编排段为 0。
   */
  __getTokenActiveCount(providerKey: string): number
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

  /** 广播形状：恒带 slot.sessionId（busy 与 idle 都路由到目标会话房间——idle 转换
   *  必须能到达 web 才能把忙灯收回；前端按 (agent, session) 桶收敛，不搞"在哪忙"
   *  语义丢 sessionId） */
  function slotToRuntimeState(slot: Slot): AgentRuntimeState {
    return {
      agentId: slot.agentId,
      sessionId: slot.sessionId,
      status: slot.status,
      queueLength: slot.queue.length,
      currentTriggerMessageId: slot.currentTriggerMessageId,
    }
  }

  /** 槽位状态变更 → 前端 agent-status 广播（socket 桥接） */
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
  }

  async function publishAgentStatus(slot: Slot, status: string): Promise<void> {
    emitSlotState(slot)
  }

  // ─── 命令执行（原 dispatch 模块函数，引擎实例化） ──

  async function executeAgentCommand(
    agent: AgentConfig,
    cmd: DispatchCommand,
    traceId: string
  ): Promise<string> {
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
    // R2：把 execution_logs.id 交给执行体——段采集器的 `spans.execution_id` 就是它
    return logId
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
        sessionId,
        success ? 'completed' : 'failed',
        opts?.latencyMs ?? null,
        opts?.errorMessage ?? null,
        opts?.replyMessageId ?? null,
        opts?.errorMessage ? classifyError(opts.errorMessage) : null
      )
    } catch (err: any) {
      log.error('finalizeExecutionLog failed — releasing slot anyway', {
        agentId,
        error: messageOf(err),
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

  /** per-agent 核心执行体：executeOneAgent + 崩溃兜底收口。
   *  token 不在此 acquire——A 方案把它收进 executeOneAgent 的 LLM 段（见该函数
   *  注释：原作用域覆盖整棵 A2A 子树，链深 ≥ cap 即死锁）。 */
  async function executeRun(
    cmd: DispatchCommand,
    agent: AgentConfig,
    executionId: string
  ): Promise<boolean> {
    let execError: unknown
    try {
      const triggerMsg = buildTriggerMsg(ctx, cmd)
      return await executeOneAgent(ctx, cmd.sessionId, agent, triggerMsg, cmd.traceId, cmd.depth, {
        executionId,
      })
    } catch (err: any) {
      execError = err
      // 本行只说「本帧抛了」——槽位收不放，由下面的 finally 按归属判（R7 前这里写
      // 'releasing slot in finally'，那是承诺了 finally 不一定兑现的事）。
      log.error('execute crashed', {
        agentId: cmd.agentId,
        traceId: cmd.traceId,
        error: messageOf(err),
      })
      return false
    } finally {
      // 原 S2 手动兜底（ingest .catch 里的槽位释放）移入 execute 的 finally：
      // executeOneAgent 若逃逸异常未自收口（槽位仍 busy），此处补收口 + 排空。
      const s = getSlotInternal(cmd.agentId, cmd.sessionId)
      if (s && s.status === 'busy') {
        // ── 归属校验（R7 甲案）：busy 的必须是**本帧的**槽位，才轮到本帧兜底 ──
        // 无校验就收正是存量 19 行 `'execute crash'` 的来源，逐环有据：
        //   ① 本帧正常路径已自收口（`:806` finalizeRun ⇒ 槽位 idle）；
        //   ② 本帧仍挂在 `:1093` 的 `Promise.all([drainP, dispatchP])` 上
        //      （A2A 派发子树 / 队列排空子树都还在跑）；
        //   ③ 该 await 窗口内控制权让出 ⇒ 新触发走 `:1772` 决策段见 idle ⇒ 标 busy 开跑；
        //   ④ 本帧 await 结束 → return → 本 finally 见 busy —— **那是别人的槽位**。
        // 收下去 = 释放正在跑的那笔的槽位（单槽位 FIFO 被击穿，同 agent+session 双执行）
        // + 把 `failed` 写进它的行（`finalizeExecutionLog` 按「agent + 最新 running」
        // 定位，WHERE 里没有 sessionId ⇒ 跨会话也能命中）。
        // R7 前这里只有一行注释写着「本帧无权收口」，代码紧接着就收了。
        if (s.currentTriggerMessageId !== cmd.triggerMessageId) {
          log.warn('slot busy but owned by another trigger — finalize skipped', {
            agentId: cmd.agentId,
            traceId: cmd.traceId,
            slotOwnerTriggerMessageId: s.currentTriggerMessageId,
            thisTriggerMessageId: cmd.triggerMessageId,
          })
        } else {
          const next = await completeExecution(cmd.agentId, cmd.sessionId, false, {
            // 诊断词三选一（票面 §2.1：`execError` 决定词）——三条互斥，不再共用一词：
            //   · `messageOf(execError)` 有值 ⇒ 逐字原样（`??` 而非 `||`：`Error('')`
            //     的空串零回归；`messageOf` 自身不抛——本行在 finally 的槽位收口路径上，
            //     它抛错会毁掉收口）；
            //   · `execError === undefined` ⇒ 本帧没抛也没崩，却仍占着槽位 = 「正常返回
            //     但没自收口」。`:806` 那次 completeExecution 自身抛错是唯一可达源
            //     （`:1096` catch 会补收一次，再失败被 `.catch` 吞掉）——防御分支，
            //     兜底词即事实描述；
            //   · 其余 ⇒ 抛了非 Error 且取不出信息（`messageOf` 对 `{}` / 循环引用返回
            //     undefined）。**不能沿用上一词**：那会把「真抛了」说成「没抛」，
            //     与旧词 `'execute crash'` 同型的谎报。
            errorMessage:
              messageOf(execError) ??
              (execError === undefined
                ? 'slot busy after executeOneAgent returned'
                : 'execute threw a value with no extractable message'),
            traceId: cmd.traceId,
          }).catch(() => undefined)
          if (next) {
            try {
              await drainQueuedCommand(ctx, agent, next, false)
            } catch (e: any) {
              log.error('drain failed after finally fallback finalize (queue item stuck)', {
                agentId: cmd.agentId,
                triggerMessageId: next.triggerMessageId,
                error: messageOf(e),
              })
            }
          }
        }
      }
    }
  }

  /** C1 v3 顶层单入口：决策(直跑/入队) → 执行 → finally{收口+排空} */
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
      // R2 §七 硬点 1：入队时刻**当场打**（存进队列条目本身，内存态不落库）。
      // 事后用 `messages.created_at → started_at` 代理对重放/恢复路径不准。
      queueArrival.set(cmd, Date.now())
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
    const executionId = await executeAgentCommand(agentCfg, cmd, cmd.traceId)
    return executeRun(cmd, agentCfg, executionId)
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
              error: messageOf(err),
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
    __getTokenActiveCount: (providerKey) => tokenPool.activeCount(providerKey),
    __test_seedSlot: (agentId, sessionId, opts) => {
      const slot = ensureSlot(agentId, sessionId)
      slot.status = 'busy'
      slot.currentTriggerMessageId = opts.currentTriggerMessageId
      slot.queue = opts.queue ?? []
    },
  }
}

/**
 * Execution — runAgentReply（第 2 刀从 connectors/socketio.ts 迁出，零控制流变化；
 * 3.5 刀模块态 → 实例态：状态经注入的 EngineState 参数消费）。
 *
 * 输出经注入的 MessageBus（bus: EngineBus & HandoffBus）——引擎零 socket.io 引用。
 * 日志通道沿用 'socketio'（零可观测行为变化）。
 */

import { randomBytes } from 'node:crypto'
import { v4 as uuid } from 'uuid'
import { estimateTokens, estimateMessageTokens } from '@cat-study/shared'
import type {
  AgentConfig,
  Chunk,
  LLMMessage,
  Message,
  StreamSegment,
  ToolCallInfo,
} from '@cat-study/shared'
import type { MessageRow } from '../db/repository/index.js'
import {
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  executionLogs as execLogsRepo,
  retrievalEvents as retrievalRepo,
} from '../db/repository/index.js'
import { HYBRID_POOL_PER_QUERY } from '../db/repository/chunks.js'
import { getAdapterForAgent } from '../llm/registry.js'
import {
  retrieveMemoryContext,
  buildKnowledgeContext,
  currentRetrievalParams,
  isA2aMemoryEnabled,
  skippedRetrievalResult,
  type MemoryContextResult,
} from '../memory/index.js'
import { createLogger } from '../logger.js'
import { snapshotPackageDeps, diffNewPackages } from '../llm/git-utils.js'
import { ensureExecutionWorktree } from '../llm/worktree-fanin.js'
import { parseJsonArray, messageOf } from '../utils.js'
import { collectCommitDiffs, GIT_TIMEOUT_MS } from '../git/diff-collector.js'
import type { ExecTrace } from './trace.js'
import {
  shouldHandoff,
  performHandoff,
  injectSummaryIntoSystem,
  generateFullSummary,
} from '../handoff/index.js'
import { emitAgentReply } from '../connectors/replyBus.js'
import {
  RESTART_TTL_MS,
  isRestartRequestContent,
  extractRestartReason,
  createRestartRequest,
} from '../restart-request.js'
import { consumeUserRequestSignals } from '../llm/user-request-signals.js'
import { ironLawForRole } from '../config/iron-laws.js'
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
} from './context.js'
import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  resolveRolePlaceholders,
  buildDynamicHints,
  buildSkillDirectorySection,
} from './hints.js'
import type { EngineBus, HandoffBus } from './bus.js'
import type { EngineState } from './state.js'

const log = createLogger('socketio')

/** 运行时长心跳间隔（从 socketio.ts 随迁；headless 黑盒可观测性） */
const HEARTBEAT_INTERVAL_MS = 10_000

/** 工具 input/output 落库单值截断上限（字符）——只防爆存储，工具名/状态恒全量可查 */
const MAX_TOOL_IO_CHARS = 4000

/**
 * 同锚（`messages.task_id`）历史回捞上界（T-G 验收④）——两个维度同时生效，
 * 超出丢**最旧**。单位：`TASK_HISTORY_MAX_MESSAGES` = 条，`TASK_HISTORY_BUDGET_TOKENS` = token。
 *
 * 条数取 30：病灶实测单锚名下 20 条，30 是「不再无界」的护栏而非精确阈值；
 * token 预算 12000 与 `context.ts` 的 `SUMMARY_KEEP_TOKENS`（30k）同量级但更小——
 * 同锚历史是**附加**上下文，不该与摘要后的保留原文抢同一份预算。
 */
export const TASK_HISTORY_MAX_MESSAGES = 30
export const TASK_HISTORY_BUDGET_TOKENS = 12_000

/**
 * 同锚历史截取（纯函数，T-G 验收④）——时间正序进、时间正序出。
 *
 * 从**最新**往回累加 token（与 summary 层 `applySummaryReplace` 同向）：丢的是最旧的
 * 噪声，不是链首任务书。单条即超预算时仍保该条（宁超预算不丢最新，同款启发式）。
 * `excludeIds` = 已在近期窗口里的消息（不重复注入）。
 */
export function selectTaskHistory<T extends { id: string; content: string }>(
  ascendingMsgs: T[],
  excludeIds: Set<string>,
  budgetTokens: number
): T[] {
  let budget = budgetTokens
  const kept: T[] = []
  for (let i = ascendingMsgs.length - 1; i >= 0; i--) {
    const m = ascendingMsgs[i]
    if (excludeIds.has(m.id)) continue
    const t = estimateTokens(m.content) + 50 // role 前缀开销（与 preTruncation 同口径）
    if (kept.length > 0 && t > budget) break
    budget -= t
    kept.push(m)
  }
  kept.reverse()
  return kept
}

/**
 * 累积流式分段：同类相邻合并（text 后 text 追加、thinking 后 thinking 追加），
 * 切换 kind 时 push 新段——前端按 kind 渲染折叠块，结构不依赖 [思考] 文本标记。
 * tool kind 不在此合并（多状态推进需按 id 关联，见 mergeToolSegment）。
 * chunk.kind 缺失/undefined 的适配器按 text 处理（与 fullContent 累积语义一致）。 */
function appendSegment(
  segments: StreamSegment[],
  kind: 'text' | 'thinking',
  content: string
): void {
  const last = segments[segments.length - 1]
  if (last && last.kind === kind) {
    last.content += content
  } else {
    segments.push({ kind, content })
  }
}

/**
 * 工具分段合并（按 id）：同一次工具调用的多状态快照（running→completed）流式到来时
 * 更新既有 tool 段而非新增——前端工具卡实时从 running 翻到 completed，不刷一列重复卡。
 * 未知状态原样透出（status 是开放 union）。缺 id 的工具事件无法归并 → push 新段
 * （顺序执行假设成立时 id 恒在；并行工具交错时同 id 段仍正确更新）。 */
function mergeToolSegment(segments: StreamSegment[], chunk: Chunk): void {
  const tool = chunk.tool
  if (!tool) return
  const existingIdx = segments.findIndex(
    (s) => s.kind === 'tool' && s.tool?.id != null && tool.id != null && s.tool.id === tool.id
  )
  const wireTool: ToolCallInfo = { id: tool.id, name: tool.name, status: tool.status }
  if (existingIdx >= 0) {
    const ex = segments[existingIdx]
    ex.content = chunk.content
    ex.tool = wireTool
  } else {
    segments.push({ kind: 'tool', content: chunk.content, tool: wireTool })
  }
}

/** 截断工具 input/output 单值（落库防爆存储）：序列化超上限 → {truncated:true, preview:<前缀>}
 *  结构占位保留——查询侧知道结果不完整、仍能看到摘要；不把「这单跑了哪个工具」一起截掉。 */
function clipToolIo(value: unknown): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false }
  const s = JSON.stringify(value)
  if (s && s.length <= MAX_TOOL_IO_CHARS) return { value, truncated: false }
  return {
    value: { truncated: true, preview: (s ?? '').slice(0, MAX_TOOL_IO_CHARS) },
    truncated: true,
  }
}

/** 工具持久化记录 upsert（按 id 合并多状态快照成单条；顺序保持首次出现序） */
function upsertTool(tools: ToolCallInfo[], chunk: Chunk): void {
  const info = chunk.tool
  if (!info) return
  const inputClipped = clipToolIo(info.input)
  const outputClipped = clipToolIo(info.output)
  const record: ToolCallInfo = {
    id: info.id,
    name: info.name,
    status: info.status,
    input: inputClipped.value,
    output: outputClipped.value,
    isError: info.isError,
    ...(inputClipped.truncated || outputClipped.truncated ? { truncated: true } : {}),
  }
  const idx = tools.findIndex((t) => t.id != null && info.id != null && t.id === info.id)
  if (idx >= 0) tools[idx] = record
  else tools.push(record)
}

/**
 * 检索流水落盘（P2 / R1）——**三处口径与既有代码逐字同源**，不是重新推导：
 *
 * · `taskId` = `triggerMsg.taskId || traceId`：与写回复消息那一行
 *   （`insertAgentMessage`，本文件下方「写入完整消息」段）**同一表达式**。链锚口径 = P1 的
 *   `COALESCE(回复.task_id, 触发.task_id)`，而回复侧因这个 `|| traceId` 恒非空
 *   ⇒ 链锚 = 本表达式。写成 `triggerMsg.taskId` 会与 P1 对不上账。
 * · `reason`：照抄下方日志的三元式——值域 **10**（模块 8 枚举 + `timeout` +
 *   `error`；第 8 个是 T-1 的 `skipped-a2a`）。超时那次 `memoryResult === null`，
 *   只读 `memoryResult.reason` 会恰好在「最慢、最该记」的那一次丢数据。
 * · `executionId`：该 (会话, 猫, 触发消息) 当前 running 的执行行。**不在
 *   serial 里穿线拿 logId**——那要改 4 个签名、把 R1 拖进 `serial.ts` 这个
 *   事故密集区（P2 §八 已把它划给另票）。此处多带 trigger 一个条件，
 *   比 `updateExecutionLogDiagnostics` 的「agent_id + session_id + running」窄，错挂面更小。
 *
 * 写失败在写口内部吞掉（硬约束 2），本函数不抛。
 *
 * 导出供直测（与 `selectTaskHistory` 同款：`runAgentReply` 主流程需 LLM 适配器，
 * 而本函数只依赖 db——组装口径是本票最容易写错的一处，必须能独立断言）。
 * 「调用点位置」由静态源断言守（见 `reply.test.ts`）。
 */
export function recordRetrievalTrace(args: {
  sessionId: string
  agentId: string
  triggerMessageId: string
  taskId: string
  memoryResult: MemoryContextResult | null
  memoryTimeout: boolean
  /** 外侧计时——超时/抛错路径拿不到内测值时的唯一来源 */
  elapsedMs: number
}): void {
  // 关键路径兜底（硬约束 2 的**本意**）：埋点**整段**不许杀死本轮注入。
  // 写口内部已自吞一次；这里防的是写口之外的三段——查执行行、取参数快照、组装。
  // 它们任一段抛（实测过的例子：`../memory/index.js` 被测试替身换成 partial
  // factory ⇒ `currentRetrievalParams` 是 undefined），回复就整条发不出去。
  try {
    const logRow = execLogsRepo
      .getLogsByTriggerMessage(args.triggerMessageId)
      .find(
        (r) =>
          r.agent_id === args.agentId && r.session_id === args.sessionId && r.status === 'running'
      )
    if (!logRow) {
      // 生产路径不可达：`execute()` 先 executeAgentCommand（落 running 行）再 executeRun。
      // 不写 = 不留一行挂不上执行的账；但不静默（本模块不允许「返回空且无痕」）。
      log.warn('检索流水：找不到本轮 running 执行行，跳过落盘', {
        agentId: args.agentId,
        sessionId: args.sessionId,
        triggerMessageId: args.triggerMessageId,
      })
      return
    }

    const stats = args.memoryResult?.stats
    const params = currentRetrievalParams()
    retrievalRepo.insertRetrievalTrace({
      executionId: logRow.id,
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskId: args.taskId,
      createdAt: new Date().toISOString(),
      // 参数快照：有 stats 就取同一趟读到的值；超时/抛错路径无 stats，现读 env
      thresholdMaxDistance: stats?.thresholdMaxDistance ?? params.maxDistance,
      paramTopK: stats?.paramTopK ?? params.topK,
      paramProbeN: stats?.paramProbeN ?? params.probeN,
      // R1-b §四 4.1 参数快照的第三项。**不取 `stats`**：与另两项不同，池大小是
      // 编译期常量（非 env 驱动）⇒ 跑这次检索的二进制里它就是这个值，同趟/跨趟同值，
      // 再往 `MemoryContextStats` 里复制一份是冗余字段（P2 三表方案正是靠「删冗余」
      // 立身的）。真源 = `HYBRID_POOL_PER_QUERY` 本身。
      paramPoolN: HYBRID_POOL_PER_QUERY,
      reason: args.memoryTimeout ? 'timeout' : (args.memoryResult?.reason ?? 'error'),
      // 同上：内测值优先（同一趟），外侧计时只兜超时/抛错两条无内测值的路径
      retrievalMs: stats?.retrievalMs ?? args.elapsedMs,
      contextTokens: stats?.contextTokens ?? null,
      budgetTokens: stats?.budgetTokens ?? null,
      truncated: stats?.truncated ?? null,
      queries: stats?.queryTraces ?? [],
      candidates: stats?.candidates ?? [],
    })
  } catch (err: any) {
    log.warn('检索流水埋点异常（已跳过，不影响本轮回复）', {
      agentId: args.agentId,
      sessionId: args.sessionId,
      error: err?.message,
    })
  }
}

export async function runAgentReply(
  state: EngineState,
  bus: EngineBus & HandoffBus,
  sessionId: string,
  agent: AgentConfig,
  triggerMsg: {
    id: string
    content: string
    mentions: string[]
    taskId?: string
    authorName?: string
    /** 触发消息由 agent 发出（T-1 a2a 记忆门的判据）。**必填**——可选会静默缺省
     *  成 `false`（= 照常注入），正是门要防的那条静默路径。形状与
     *  `serial.ts` 的 `AgentTriggerMsg` 同源（本处仍是结构化内联类型，不动 7 参
     *  签名——见下方 R2 §4.7 形态裁决）。 */
    fromAgent: boolean
  },
  traceId: string,
  /**
   * ⚠️ 形态由 `signal?: AbortSignal` 改为 `signal: AbortSignal | undefined`：
   * TS 不允许**必填参数跟在可选参数之后**（TS1016），而 `trace` 必须是必填——
   * 可选的话每个埋点都要写 `trace?.`，漏传就静默不采（观测面最怕的正是静默）。
   * **调用侧契约零变化**（两者都接受省略/`undefined`），原 7 个参数一个没挪位。
   */
  signal: AbortSignal | undefined,
  /**
   * R2 段五采集器（**per-execution**，由 `executeOneAgent` 创建并传入）。
   *
   * 形态裁决（R2 §4.7 / D9）：**只加这一个参数**，不做本函数 7 参数 → 上下文对象的
   * 整体收口——那要改本文件内这 7 个名字的 **241 处**引用（`agent.` 79 / `sessionId`
   * 62 / `traceId` 39 / `triggerMsg.` 28 / `signal` 13 / `state.` 11 / `bus.` 9），
   * 动的是 1208 行的事故密集热文件，而**观测收益为零**：新维度加在 `trace` 上即可，
   * 不加在签名上。
   */
  trace: ExecTrace
): Promise<{ content: string; msgId: string }> {
  const adapter = getAdapterForAgent(agent)
  const t0 = Date.now()

  log.info('agent reply started', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.llmProvider,
    model: agent.llmModel,
  })

  // 计时锚点：**一次取值**，本函数内唯一来源 = 「这轮执行从什么时候开始跑」。
  // 取在下方 `context.assemble` 段之前，与 trace 根段 `invoke_agent` 同口径（都是执行入口）。
  // 'thinking' 就带上它，是为了让 A2A（猫 @ 猫，无用户消息状态行可挂）与 headless
  // 适配器的执行从第一刻起就有锚点；后面 'replying' 首发与心跳重发**沿用同一常量**
  // （本函数内搜 `startedAt`），一次执行内三种事件的 startedAt 恒等——前端据此本地 tick 递增。
  const startedAt = Date.now()

  // 状态：思考中
  bus.emitAgentMessageStatus(sessionId, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'thinking',
    startedAt,
  })

  // ── 段 E1 `context.assemble`（R2 段五）──────────────────
  // 起止 = 取消息 → 过滤出「本猫可见」的那批（压缩/截断前的原始上下文量）
  const assembleHandle = trace.startSpan('context.assemble')
  // 构建对话上下文：只包含与该 Agent 相关的消息
  // 按时间倒序取最近消息（generous safety limit），后续用 token 预算做软截断
  const allMessages = messagesRepo.getRecentMessages(sessionId)
  // 反转为时间正序，后续过滤和截断都按时间顺序处理
  allMessages.reverse()

  // 加载同一 taskId 的完整历史（跨越消息加载限制，按 token 预算合并）
  // T-G 验收④：回捞**上界**——原实现无任何上限（病灶实测：单锚名下 20 条 / 7.7 万字符，
  // 整段塞进上下文且与 summary 层的 30k 保留预算各自为政）。
  // 为什么是「条数 + token 预算」而不是「墙钟时间窗」：时间窗会**系统性丢掉链首**——
  // 而链首恰恰是任务书（用户诉求原文），对长链是最贵的那段；token 预算按「离当前多远」
  // 收口，丢的是最旧的噪声。单位：条 / token。
  const taskHistory: MessageRow[] = []
  if (triggerMsg.taskId) {
    const loadedIds = new Set(allMessages.map((m: MessageRow) => m.id))
    const taskMsgs = messagesRepo.getTaskHistory(
      triggerMsg.taskId,
      sessionId,
      TASK_HISTORY_MAX_MESSAGES
    )
    taskMsgs.reverse() // 恢复时间正序
    const kept = selectTaskHistory(taskMsgs, loadedIds, TASK_HISTORY_BUDGET_TOKENS)
    taskHistory.push(...kept)
    if (taskHistory.length > 0) {
      const tokens = kept.reduce((sum, m) => sum + estimateTokens(m.content) + 50, 0)
      // 三个计数**单位与含义各自独立**，不合并（面③：计数混义 = 下一个误读源）。
      // loaded 是**查询返回**条数——等于 TASK_HISTORY_MAX_MESSAGES 时表示
      // 「可能还有更旧的没取到」，不是链的真实长度。
      const dupCount = taskMsgs.filter((m) => loadedIds.has(m.id)).length
      log.info('task history loaded', {
        traceId,
        agentId: agent.id,
        taskId: triggerMsg.taskId,
        taskHistoryCount: kept.length, // 条（实际并入上下文）
        taskHistoryTokens: tokens, // token（并入部分）
        taskHistoryLoaded: taskMsgs.length, // 条（查询返回）
        taskHistoryDupSkipped: dupCount, // 条（已在本轮窗口内，不重复注入）
        taskHistoryBudgetDropped: taskMsgs.length - dupCount - kept.length, // 条（超 token 预算丢弃）
      })
    }
  }

  // 合并：task 历史在前，当前消息在后
  const combinedMessages = [...taskHistory, ...allMessages]

  // 读取 Session 的广播模式
  const isBroadcastMode = sessionsRepo.getSessionBroadcastMode(sessionId)

  // 上下文过滤：只保留该 Agent 能"看到"的消息
  const relevantMessages = getRelevantMessages(
    combinedMessages,
    agent.id,
    agent.name,
    isBroadcastMode
  )

  // ── 会话交接预检（截断前） ──────────────────────────
  // 必须在截断前计算消息总 token——handoff 在 90% 阈值触发，
  // 在此之前消息应尽量保留，截断只作最终保底（handoff 未拦住时出手）。
  let preTruncationTokens = 0
  for (const m of relevantMessages) {
    preTruncationTokens += estimateTokens(m.content) + 50 // role 前缀开销
  }
  // E1 收口：item_count = 过滤后进入压缩/截断的消息**条数**（单位：条）
  trace.endSpan(assembleHandle, 'ok', { itemCount: relevantMessages.length })

  // ── 段 E2 `context.compress`（R2 段五）──────────────────
  // 覆盖「摘要替代 + token 软截断」两段——它们是同一件事（把上下文压进预算）的
  // 两级手段，顺序钉死（先压缩后截断），中间没有可归属给别段的等待。
  const compressHandle = trace.startSpan('context.compress')

  // ── 摘要替代压缩（截断前，顺序钉死：先压缩后截断） ──────
  // 长会话消息超阈值时把旧消息压成摘要块（保留最近 10 条/30k 双保险），
  // 替代「超预算直接丢消息」的截断——压缩优先于截断，替换后仍超预算才走截断。
  // 0.60 预压缩异步生成（本轮零阻塞，下一轮构建消费）；0.75 强制同步生成（本轮生效）。
  // 压缩只是延迟交接不是取消交接：达 SUMMARY_COMPRESS_LIMIT 上限后走既有 handoff/截断。
  const summaryReplaceEnabled = process.env.SUMMARY_REPLACE_HISTORY !== '0'
  let messagesForTruncation: typeof relevantMessages = relevantMessages
  let summaryBlockMsg: LLMMessage | null = null
  if (summaryReplaceEnabled && preTruncationTokens >= SUMMARY_MIN_TOKENS) {
    const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
    const ratio = preTruncationTokens / maxTokens
    const compressLimit = parseInt(process.env.SUMMARY_COMPRESS_LIMIT || '3', 10)
    const entries = parseCompressedSummaries(sessionsRepo.getCompressedSummaries(sessionId))
    const readyCount = countReadySummaries(entries)
    const ready = lastReadySummary(entries)
    // 覆盖间隙：块覆盖边界（生成时点消息数）之后新增消息超出保留窗口容量（10 条）
    // → 中间段（块覆盖点之后、保留窗口之前）会丢——ready 永真时块不更新，间隙持续扩大
    // （消费复用缺陷实证修复：有间隙必须重新生成新块把中间段并入，不能只消费旧块）
    const coverageGap =
      ready != null &&
      (typeof ready.coveredThrough !== 'number' ||
        messagesRepo.countBySession(sessionId) - ready.coveredThrough > SUMMARY_KEEP_RECENT - 1)
    if (readyCount < compressLimit && ratio >= SUMMARY_PRE_COMPRESS_RATIO) {
      if (ready && !coverageGap) {
        // 消费既有就绪块——块覆盖到生成时点全部消息、保留窗口容得下新增 → 零 LLM 调用
        messagesForTruncation = applySummaryReplace(relevantMessages, ready.content).kept
        summaryBlockMsg = buildSummaryBlockMessage(ready.content)
        log.info('summary replace: consumed ready block', {
          traceId,
          agentId: agent.id,
          sessionId,
          readyTokenCount: ready.tokenCount,
          totalCompressed: readyCount,
        })
      } else if (ratio >= SUMMARY_FORCE_COMPRESS_RATIO || coverageGap) {
        // 强制阈值 或 消费发现覆盖间隙：同步生成新块（本轮生效，块覆盖到最新）
        // 先落 pending（带唯一 id + 覆盖边界）再按 id 回填（与异步路径同形）
        const entryId = uuid()
        sessionsRepo.appendCompressedSummary(sessionId, {
          id: entryId,
          createdAt: new Date().toISOString(),
          tokenCount: 0,
          content: '',
          coveredThrough: messagesRepo.countBySession(sessionId),
        })
        try {
          const summary = await generateFullSummary(sessionId, SUMMARY_BLOCK_TOKENS)
          if (summary) {
            sessionsRepo.updateCompressedSummary(sessionId, entryId, {
              tokenCount: estimateTokens(summary),
              content: summary,
            })
            messagesForTruncation = applySummaryReplace(relevantMessages, summary).kept
            summaryBlockMsg = buildSummaryBlockMessage(summary)
            log.info('summary replace: sync generated', {
              traceId,
              agentId: agent.id,
              sessionId,
              summaryTokens: estimateTokens(summary),
              totalCompressed: readyCount + 1,
            })
          } else {
            // 无 key / 空摘要：降级普通截断 + 留痕（不阻塞主流程）
            log.warn('summary replace skipped (no summary generated), fallback to truncation', {
              traceId,
              agentId: agent.id,
              sessionId,
            })
          }
        } catch (err: any) {
          log.warn('summary replace sync failed, fallback to truncation', {
            traceId,
            agentId: agent.id,
            sessionId,
            error: err.message,
          })
        }
      } else {
        // 预压缩阈值：异步生成（fire-and-forget），落 pending 下一轮消费生效
        const entryId = uuid()
        sessionsRepo.appendCompressedSummary(sessionId, {
          id: entryId,
          createdAt: new Date().toISOString(),
          tokenCount: 0,
          content: '',
          coveredThrough: messagesRepo.countBySession(sessionId),
        })
        generateFullSummary(sessionId, SUMMARY_BLOCK_TOKENS)
          .then((summary) => {
            if (!summary) {
              log.warn('summary replace async skipped (no summary generated)', {
                traceId,
                agentId: agent.id,
                sessionId,
              })
              return
            }
            sessionsRepo.updateCompressedSummary(sessionId, entryId, {
              tokenCount: estimateTokens(summary),
              content: summary,
            })
            log.info('summary replace async completed', {
              traceId,
              agentId: agent.id,
              sessionId,
              summaryTokens: estimateTokens(summary),
            })
          })
          .catch((err: any) => {
            log.warn('summary replace async failed (pending entry left, skipped on read)', {
              traceId,
              agentId: agent.id,
              sessionId,
              error: err.message,
            })
          })
        log.info('summary replace async triggered (pending, next round effective)', {
          traceId,
          agentId: agent.id,
          sessionId,
          ratio: ratio.toFixed(3),
        })
      }
    }
  }

  // 压缩替换后重算消息 token（handoff 检查用压缩后的真实值——压缩成功不该再 handoff）
  if (summaryBlockMsg) {
    preTruncationTokens = 0
    for (const m of messagesForTruncation) {
      preTruncationTokens += estimateTokens(m.content) + 50
    }
  }

  // ── Token 感知软截断 ──────────────────────────────────
  // 从最新到最旧累加 token，超出预算的消息丢弃（不再用硬编码 LIMIT 100）
  const MAX_CONTEXT = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
  // 98% 预算给消息原文，2% 留给 system prompt（~2500 tokens 基础开销）。
  // Handoff 在 90% 已开新会话，截断只作保底——极少触发。
  const MESSAGE_BUDGET = Math.floor(MAX_CONTEXT * 0.98)
  let tokenAccum = 0
  const truncatedMessages: typeof relevantMessages = []
  for (let i = messagesForTruncation.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messagesForTruncation[i].content) + 50 // role 前缀开销
    if (tokenAccum + msgTokens > MESSAGE_BUDGET) break
    tokenAccum += msgTokens
    truncatedMessages.push(messagesForTruncation[i])
  }
  truncatedMessages.reverse() // 恢复时间正序
  // E2 收口：item_count = 压缩/截断后**实际进 prompt** 的消息条数（单位：条）
  trace.endSpan(compressHandle, 'ok', { itemCount: truncatedMessages.length })

  log.info('token-aware truncation applied', {
    traceId,
    agentId: agent.id,
    beforeTruncation: relevantMessages.length,
    afterTruncation: truncatedMessages.length,
    messageTokensUsed: tokenAccum,
    messageBudget: MESSAGE_BUDGET,
    maxContext: MAX_CONTEXT,
  })

  // system prompt 直接使用 agent.systemPrompt——技能由模型经 MCP read_skill 工具自取
  // （懒加载：MCP 工具面暴露 read_skill/list_skills，模型在对应流程阶段按需求自取
  // skills/<名>/SKILL.md 正文），server 不再做全文拼装（注入层已拆除，见 delivery 单 A）。

  // 铁律运行期注入：铁律从「seed 期烘焙」升级为「settings 表全局策略」（getIronLaws
  // 单一权威访问器）——按 role 取应注入铁律（reviewer→审查铁律；store/implementer→开发
  // 铁律；其余 role→'' 不注入），拼到 system prompt 之后统一走占位符替换。防重复注入：
  // seed 已解除烘焙，但老库 system_prompt 可能仍带旧铁律（收口后 seed 清洗前）——本 agent
  // 的 systemPrompt 已包含该铁律全文时不再追加（避免双份）。
  const ironLaw = ironLawForRole(agent.role)
  const baseSystemPrompt =
    ironLaw && !agent.systemPrompt.includes(ironLaw)
      ? `${agent.systemPrompt}\n\n${ironLaw}`
      : agent.systemPrompt

  // 技能发现面（甲案，2026-09-20）：常驻目录段拼在**替换面内**——与铁律同款理由，
  // 注入文本若含角色占位符（@作者/@架构师/@审查者）必须一并被替换，否则占位符漏网
  // ⇒ mention 精确匹配落空 ⇒ 静默不触发。目录段每轮不变，坐的是第一条 system
  // message（真 system prompt 面），不是 dynamicHints 的位置——后者是场景提示，
  // 有「超限时被当最旧先丢」的观察项（CLI 截断止血单），常驻菜单不能坐那儿。
  const systemPromptWithDirectory = `${baseSystemPrompt}\n\n${buildSkillDirectorySection()}`

  // 将 system prompt 中的角色占位符（@作者/@架构师/@审查者）替换为实际 agent 名
  // 使 LLM 能正确输出 @店长 等实际 agent 名——mention 解析是严格精确匹配，
  // 占位符不替换 = 解析落空 = 静默不触发（b542d24 分流断链事故根因）。
  // 注入的铁律全文同样含占位符（@作者/@架构师/@审查者）——必须一起替换
  const finalSystemPrompt = resolveRolePlaceholders(
    systemPromptWithDirectory,
    triggerMsg.authorName
  )

  // 动态上下文指令：根据当前场景注入系统级提示（审查循环、交接触发等）
  const dynamicHints = buildDynamicHints(agent, triggerMsg.content, relevantMessages, {
    // 链锚 = 触发消息的 messages.task_id（T-E 后 ingest 必落此列）。缺省 = 存量无锚
    // → 审查循环 hint 走窗口降级路径（见 hints.ts）
    anchor: triggerMsg.taskId,
    sessionId,
  })

  // 已回复用户消息识别（陈旧上下文重复回答失败模式根修，2026-08-13 实证）：
  // 若某条用户消息在时间序上之后存在该 agent 自己的回复（截断窗口内），则视为
  // 已回复——剥离旧图不重附、追加标注，防模型重复回答旧问题（luna 重启后首跑
  // 重复回答 18:47 旧图问题的实证：旧图 @luna 消息一小时后仍在上下文且 images
  // 原样重附，模型选了最显眼的旧图题而非最新派活单）。反向扫描一次 O(n)，
  // ownReplySeen 一旦置位即保持——用户消息与回复之间可穿插其他 agent 消息。
  const repliedUserIndexes = new Set<number>()
  {
    let ownReplySeen = false
    for (let i = truncatedMessages.length - 1; i >= 0; i--) {
      const m = truncatedMessages[i]
      if (m.role === 'agent' && m.agent_id === agent.id) {
        ownReplySeen = true
      } else if (m.role === 'user' && ownReplySeen) {
        repliedUserIndexes.add(i)
      }
    }
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: finalSystemPrompt },
    ...dynamicHints.map((h) => ({ role: 'system' as const, content: h })),
    // 摘要块放消息数组最前（user 段第一，system 段之后）——独立于 runningSummary
    // （system 段注入 :2286），两段不共享状态（分层互不耦合钉死）
    ...(summaryBlockMsg ? [summaryBlockMsg] : []),
    ...truncatedMessages.map((m: any, idx: number) => {
      const isLast = idx === truncatedMessages.length - 1

      if (m.role === 'agent') {
        if (m.agent_id === agent.id) {
          return {
            role: 'assistant' as const,
            content: m.content,
          }
        }
        const otherName = agentsRepo.getAgentNameById(m.agent_id) || '未知猫咪'
        const otherMentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
        const otherRow = agentsRepo.getAgentById(m.agent_id)
        const otherModel = otherRow?.llm_model || undefined
        return {
          role: 'user' as const,
          content: formatAgentMessage(otherName, m.content, otherMentions, otherModel),
        }
      }

      const alreadyReplied = repliedUserIndexes.has(idx)

      const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
      const audience = formatAudienceTag(mentions, agent.name)
      const msgImages: string[] = parseJsonArray(m.images)
      const formatted = formatUserMessage(m.content, mentions, audience, isLast)

      if (alreadyReplied) {
        // 已回复过的用户消息：不重附旧图（images 字段与文字占位一并剥离）、
        // 追加标注——模型不再被旧图牵引重复回答（陈旧上下文重复回答根修）。
        // 带图时标注图片数（msgImages 已在 :2509 解析直接取用）并提示可请用户重发——
        // 方案 v2 升级：图片数字事实不再丢失（吐槽猫审查硬缺口 ②）
        const replyNote =
          msgImages.length > 0
            ? `（含 ${msgImages.length} 张图片；你已回复过这条，无需重复回答，如需重新看图请用户重发）`
            : `（你已回复过这条，无需再次回复）`
        return {
          role: 'user' as const,
          content: `${formatted}\n${replyNote}`,
        }
      }

      // 未回复用户消息：附带图片走 images 字段供 ollama 视觉模型使用，
      // 同时加文字占位，让 deepseek/claude 等非视觉模型也能感知"用户发了图"
      const content =
        msgImages.length > 0 ? `${formatted}\n[用户附带了 ${msgImages.length} 张图片]` : formatted

      return {
        role: 'user' as const,
        content,
        ...(msgImages.length > 0 ? { images: msgImages } : {}),
      }
    }),
  ]

  const contextTokenStats = estimateMessageTokens(llmMessages)
  log.info('context built', {
    traceId,
    agentId: agent.id,
    totalMessages: combinedMessages.length,
    relevantBeforeTruncation: relevantMessages.length,
    relevantAfterTruncation: truncatedMessages.length,
    truncationMsgTokens: tokenAccum,
    contextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
    contextTokens: contextTokenStats.total,
    systemTokens: contextTokenStats.systemTokens,
    userTokens: contextTokenStats.userTokens,
    assistantTokens: contextTokenStats.assistantTokens,
  })

  // ── 会话交接检查 ──────────────────────────────────
  // 使用截断**前**的消息 token + system prompt token 判断。
  // preTruncationTokens 在上方截断前已计算。
  const estimatedTotalTokens = preTruncationTokens + contextTokenStats.systemTokens
  if (shouldHandoff(estimatedTotalTokens)) {
    log.info('handoff threshold reached, triggering handoff', {
      traceId,
      agentId: agent.id,
      contextTokens: estimatedTotalTokens,
      maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10),
    })
    // 异步触发交接，不 await — 当前回复在旧会话中继续
    performHandoff(sessionId, bus).catch((err) => {
      log.warn('handoff failed (non-blocking)', {
        traceId,
        sessionId,
        error: err.message,
      })
    })
  }

  // ── 注入增量摘要到 system prompt ──────────────────
  // 从当前会话读取运行中的摘要，注入到 system prompt 顶部
  const runningSummary = sessionsRepo.getSessionRunningSummary(sessionId)
  if (runningSummary) {
    const enhancedPrompt = injectSummaryIntoSystem(llmMessages[0].content, runningSummary)
    if (enhancedPrompt !== llmMessages[0].content) {
      llmMessages[0] = { ...llmMessages[0], content: enhancedPrompt }
      const summaryLen = (() => {
        try {
          return JSON.parse(runningSummary)?.text?.length || 0
        } catch {
          return 0
        }
      })()
      log.info('running summary injected', {
        traceId,
        agentId: agent.id,
        summaryChars: summaryLen,
      })
    }
  }

  // 检索相关记忆并注入 system prompt（带超时，不阻塞 LLM 调用）。
  // 超时/抛错 → 结果置 null（reason 记 'timeout'/'error'），与记忆模块自己的
  // 七种 reason 一起构成**穷尽的**空结果台账——不许有「返回空且无痕」的路径。
  const MEMORY_TIMEOUT_MS = 10_000
  const memoryT0 = Date.now()
  // ── a2a 记忆门（T-1）───────────────────────────────────
  // 触发者是被 @ 的猫（上一条 agent 回复）且开关默认关 ⇒ **整段检索跳过**。
  // 跳过的不只是召回：`rewriteRetrievalQueries` 在 `retrieveMemoryContext`
  // **内部**（`memory/index.ts`），门开在调用点，改写（每条新内容一次 LLM 调用）
  // 天然一并省掉——这正是本门要拿掉的那笔 token 税。
  // 【知识库】不走此门（下方 `buildKnowledgeContext` 原样保留）。
  const a2aMemorySkipped = triggerMsg.fromAgent && !isA2aMemoryEnabled()
  let memoryResult: MemoryContextResult | null = null
  let memoryTimeout = false
  if (a2aMemorySkipped) {
    // 不静默：结果仍是一个**形状同构**的空结果（`skipped-a2a`），下面 span /
    // 流水落盘 / 日志三条路径照常走，三处各留一条痕。
    memoryResult = skippedRetrievalResult()
  } else {
    try {
      memoryResult = await Promise.race([
        retrieveMemoryContext(triggerMsg.content),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            memoryTimeout = true
            resolve(null)
          }, MEMORY_TIMEOUT_MS)
        ),
      ])
    } catch (err: any) {
      log.warn('记忆检索抛错，本轮不注入', { traceId, agentId: agent.id, error: err?.message })
    }
  }

  // ── 段 E3 `memory.retrieval`（R2 段五；详情表 = R1 `retrieval_events`）──
  // **双写同源**（R2 §4.5）：本段的 `duration_ms` 与 `retrieval_events.retrieval_ms`
  // 由**同一个变量**给出，不是两处独立测量——否则「同一件事两个耗时」当场造出
  // 「哪个才对」的混淆面。内测值优先（同一趟），外侧计时只兜超时/抛错两条无内测
  // 值的路径（与 `recordRetrievalTrace` 的 `stats?.retrievalMs ?? args.elapsedMs` 逐字同源）。
  const memoryElapsedMs = Date.now() - memoryT0
  trace.recordSpan('memory.retrieval', {
    startMs: memoryT0,
    durationMs: memoryResult?.stats?.retrievalMs ?? memoryElapsedMs,
    // 跳过 ≠ ok（那是「跑过且零命中」的假读数）、≠ error（那是「跑挂了」的假读数）。
    status: a2aMemorySkipped
      ? 'skipped'
      : memoryTimeout
        ? 'timeout'
        : memoryResult
          ? 'ok'
          : 'error',
    // 命中数 = 实际注入的节数（与 retrieval_events 的 sections 同口径）
    itemCount: memoryResult?.stats?.sections ?? null,
  })

  // ── 检索流水落盘（P2 / R1）────────────────────────────
  // 位置两条都是硬要求：
  //  ① 在 10s `Promise.race` **之外**——写库耗时不算进检索超时预算，且 race 超时
  //     不会把整个写库丢掉（那恰是检索最慢、最该记的一次）；
  //  ② 在下方 `if (memoryContext)` **之外**——那一分支只在注入成功时走，写在里
  //     面会让「空手而归」和「超时」两条路径无痕。
  recordRetrievalTrace({
    sessionId,
    agentId: agent.id,
    triggerMessageId: triggerMsg.id,
    taskId: triggerMsg.taskId || traceId,
    memoryResult,
    memoryTimeout,
    elapsedMs: memoryElapsedMs,
  })

  const memoryContext = memoryResult?.text ?? ''
  if (memoryContext) {
    llmMessages[0] = {
      ...llmMessages[0],
      content: llmMessages[0].content + memoryContext,
    }
    const memoryTokens = estimateTokens(memoryContext)
    log.info('记忆上下文已注入', {
      traceId,
      agentId: agent.id,
      memoryChars: memoryContext.length,
      memoryTokens,
      totalContextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
      totalContextTokens: contextTokenStats.total + memoryTokens,
      // ── 检索面台账（W1/W3/W5/W11 判据）──────────────────────
      reason: memoryResult?.reason,
      // 注入来源（W1：只来自白名单内的 MD 切片）
      sections: memoryResult?.sections.map((s) => ({
        docPath: s.docPath,
        sectionAnchor: s.sectionAnchor,
        distance: s.distance,
      })),
      ...memoryResult?.stats,
    })
  } else {
    // 三态/四态可区分（W3 + W11）：未启用 / 无命中 / 嵌入失败 / 召回空（被状态过滤）
    // 各带互不相同的 reason，且都带 X5 埋点（阈值前 top-N 的身份 + 距离）——
    // 「空手而归」与「被阈值挡掉」凭 topCandidates / droppedByThreshold 可分辨。
    log.info('记忆上下文为空', {
      traceId,
      agentId: agent.id,
      reason: memoryTimeout ? 'timeout' : (memoryResult?.reason ?? 'error'),
      ...memoryResult?.stats,
    })
  }

  // 检索知识库并注入 system prompt（知识库 Phase 1）——retrieveMemoryContext
  // 同款位置 + 同款 Promise.race 超时降级防护：知识库是读增强，不阻塞 LLM 调用。
  // 独立【知识库】区块，零污染【相关记忆】
  // ── 段 E5 `knowledge.retrieval`（R2 段五）───────────────
  // `knowledge` 表**没有** R1 那样的详情表（它不是 `chunks` 的派生投影，检索形态也
  // 不同），故命中数只落在骨架的 `item_count` 上。
  let knowledgeContext = ''
  const knowledgeT0 = Date.now()
  let knowledgeHits: number | null = null
  let knowledgeTimedOut = false
  try {
    knowledgeContext = await Promise.race([
      // 命中数经回调带出：**空手而归的各条早退路径都会报 0**（不报 = 分不清
      // 「没命中」与「压根没跑」）
      buildKnowledgeContext(triggerMsg.content, (n) => {
        knowledgeHits = n
      }),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          knowledgeTimedOut = true
          resolve('')
        }, MEMORY_TIMEOUT_MS)
      ),
    ])
  } catch {
    knowledgeContext = ''
  }
  trace.recordSpan('knowledge.retrieval', {
    startMs: knowledgeT0,
    status: knowledgeHits !== null ? 'ok' : knowledgeTimedOut ? 'timeout' : 'error',
    itemCount: knowledgeHits,
  })
  if (knowledgeContext) {
    llmMessages[0] = {
      ...llmMessages[0],
      content: llmMessages[0].content + knowledgeContext,
    }
    const knowledgeTokens = estimateTokens(knowledgeContext)
    log.info('知识库上下文已注入', {
      traceId,
      agentId: agent.id,
      knowledgeChars: knowledgeContext.length,
      knowledgeTokens,
      totalContextChars: llmMessages.reduce((sum, m) => sum + m.content.length, 0),
      totalContextTokens: contextTokenStats.total + knowledgeTokens,
    })
  }

  // ── 最终 token 预算复核 ──────────────────────────
  // summary + memory + 知识库注入后重新估算总 token。
  // 超预算时不丢弃任何上下文，直接触发会话交接（fire-and-forget）——
  // 当前回复正常发送，下一条消息在新会话中带着完整摘要继续。
  {
    const finalStats = estimateMessageTokens(llmMessages)
    const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
    if (finalStats.total > maxTokens) {
      log.warn('token budget exceeded after summary/memory injection, triggering handoff', {
        traceId,
        agentId: agent.id,
        finalTokens: finalStats.total,
        maxTokens,
      })
      performHandoff(sessionId, bus).catch((err) => {
        log.warn('handoff failed (non-blocking)', {
          traceId,
          sessionId,
          error: err.message,
        })
      })
    }
  }

  // 流式生成回复
  let fullContent = '' // 仅文本内容 — 存入 DB，参与 agent-to-agent 上下文
  let displayContent = '' // 文本 + 思考 — 流式推送给前端（content 兼容字段，保留完整展示文本；不含 tool）
  let thinkingContent = '' // 仅思考过程 — 存入 DB 的 thinking_content 列，回复后仍可查看
  // 工具调用持久化记录（id/name/status/input/output 截断摘要）——落 messages.tool_content
  // 结构化 JSON 列（可查「这单跑了哪个工具/结果」）；与正文/思考三通道分离，永不进上下文
  const tools: ToolCallInfo[] = []
  // 结构化分段（kind+content+tool）——替代前端从 [思考] 文本标记回推结构；同类相邻合并、
  // tool 按 id 归并。推 typing 与 setActiveStream 均携带（会话恢复补推复用），前端优先消费，缺失才退化。
  const segments: StreamSegment[] = []
  const msgId = uuid()
  // 每 spawn 随机的信号 token（一次流一次 spawn——「每 spawn 随机」语义保持）。
  // 随 context 进 buildEnv → .mcp.json env → MCP server 的 x-signal-token 头；
  // internal.ts 精确匹配 activeStreams 存值（契约裁决：方案 A）
  const signalToken = randomBytes(16).toString('hex')

  // 记录执行前的包依赖快照
  const depsBefore = snapshotPackageDeps()

  bus.emitTyping({
    sessionId,
    agentId: agent.id,
    messageId: msgId,
    content: '',
    segments: [],
  })
  state.setActiveStream(agent.id, sessionId, {
    sessionId,
    messageId: msgId,
    content: '',
    segments: [],
    token: signalToken,
  })

  // 状态：回复中（带 startedAt——前端据此显示「回复中 · 已 N 秒」递增，替代静止标签）。
  // 这里**不重新取 Date.now()**：取值点已在执行起点（上下文组装之前），沿用同一常量，
  // 故 'thinking' / 'replying' / 心跳三者同一个值；重新取值会把锚点挪到「LLM 流开始」，
  // 既漏掉上下文组装那段、又与已发的 'thinking' 不等（前端会看到秒数倒退）。
  bus.emitAgentMessageStatus(sessionId, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'replying',
    startedAt,
  })

  // ── 撤回时窗保护（Window ②）──────────────────────
  // 在 LLM 调用前检查触发消息是否仍存在于 DB。
  // 用户在 Agent 构建上下文期间撤回 → DB 已删 → 阻止 LLM 调用。
  if (!messagesRepo.messageExists(triggerMsg.id, sessionId)) {
    log.info('trigger message retracted before LLM call', {
      traceId,
      agentId: agent.id,
    })
    state.deleteActiveStream(agent.id, sessionId)
    return { content: '[消息已撤回]', msgId }
  }

  // ── 段 E7 `llm.chat`（R2 段五；详情表 = `span_llm`）─────
  // **硬点 3**：`start_at` 取 `chatStream` 调用**前一刻**，不是 `for await` 进入时刻——
  // 否则 TTFT（`gen_ai.response.time_to_first_chunk`）的分母把「建流」那段也算了进去。
  // `provider` / `model` / `max_tokens` 是**快照**：`agents` 表可变，事后 join 拿到的是
  // 「今天的配置」而非「当时的配置」。
  const llmHandle = trace.startSpan('llm.chat', {
    llm: {
      provider: agent.llmProvider,
      model: agent.llmModel,
      maxTokens: agent.llmMaxTokens ?? null,
      stream: true,
    },
  })
  const stream = adapter.chatStream(llmMessages, {
    model: agent.llmModel,
    signal,
    // per-agent 静态运行配置透传：缺省不传让适配器兜底（deepseek 2048/0.7、ollama 同）
    // llmMaxTokens 是单次输出上限，与 MAX_CONTEXT_TOKENS（上下文窗口）是两套数字体系
    ...(agent.llmMaxTokens != null ? { maxTokens: agent.llmMaxTokens } : {}),
    ...(agent.llmTemperature != null ? { temperature: agent.llmTemperature } : {}),
    // 一猫一 worktree（ADR 0015 D1）：目标树按**角色**分派（`ensureAgentWorktree`
    // 单源）——店长（`role === 'store'`）走会话 worktree（它是唯一检出
    // `session/<sid8>` 的地方 = fan-in 的 cwd）；其余猫（含 `role` 缺失/未知、
    // 含审查猫）走各自的猫 worktree（隔离优先）。猫在独立目录执行，auto-commit
    // 落各自的分支。
    // 建不出（非 git 仓库 / 集成分支不在 / 命名非法）返回 null → **不传 cwd**，
    // 适配器取默认 `workspace/`；**绝不回落主仓库**（T-1 已收窄，不得回退）。
    // T-2 Phase I-b 形态 G：审查者（`role === 'reviewer'`）额外把本会话全部猫分支
    // 合进**它自己的猫分支**，否则它的树 fork 自集成分支、读到的是**旧版内容且读不出
    // 是旧的**（`report-phase-ib.md` §三 V16-b 实测）。合并冲突 ⇒ 显式抛错，审查者
    // **不开跑**也不产出回执（fail-closed，票面 §二-3）。
    // 注意这是**同步阻塞调用**（建树 + merge 全是 `execFileSync`），与本行原语义一致。
    // 第三个实参 = **链锚**（票 9）：prep 撞冲突时用它把返修单投回实施猫。取值与
    // :783 / :1127 同 Expression（`triggerMsg.taskId || traceId`）——投出去的消息
    // 与「本轮执行属于哪条链」必须同源，否则实施猫的返修工作会挂到另一条链上。
    cwd: ensureExecutionWorktree(sessionId, agent, triggerMsg.taskId || traceId) ?? undefined,
    // MCP 结构化路由上下文（契约 3 二次修订——店长裁决）：claude.ts 透传
    // 到 MCP server env；其他适配器忽略 context 零影响。
    // triggerAuthorName 与 :947 合并点同款来源（triggerMsg.authorName）——
    // internal.ts 预校验 filterAllowedMentions 支持 reviewer @ 回请求人（OQ③）
    context: {
      sessionId,
      agentId: agent.id,
      msgId,
      token: signalToken,
      traceId,
      triggerAuthorName: triggerMsg.authorName,
      // triggerMsgId = 真实触发消息 id（:2701 的 msgId 是本猫回复 id，两 id 明确区分）——
      // 猫提交 commit 的 catstudy [uuid] 取自它（git-utils auto-commit 同源，:1332）
      triggerMsgId: triggerMsg.id,
    },
  })

  // ── 运行时长心跳（headless 黑盒可观测性）────────────────
  // dsh 等 headless 适配器在子进程 close 前一个 chunk 都不 yield，上面那个
  // 「回复中」状态从第一秒到最后 107 秒一动不动——用户无法判断进程是还在跑
  // 还是已经死了。周期重发 MESSAGE_AGENT_STATUS（status 不变、startedAt 相同），
  // 前端据此显示「回复中 · 已 N 秒」N 递增。
  // 落点放在 runAgentReply 而非适配器层：所有适配器统一受益，零新增 socket 事件、
  // 零新增 chunk 契约。try/finally 保证正常走完 / abort return / 抛错三条路径都
  // clearInterval，不留泄漏 timer（对应 activeStreams.delete 的 cleanup 位置，
  // 并补上 caller catch 触及不到的抛错路径——timer 是本函数局部变量）。
  const heartbeatTimer = setInterval(() => {
    bus.emitAgentMessageStatus(sessionId, {
      messageId: triggerMsg.id,
      agentId: agent.id,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      status: 'replying',
      startedAt,
    })
  }, HEARTBEAT_INTERVAL_MS)

  // 流的两条提前退出（撤回 / abort）走 `return`——用 finally 收段，避免留下
  // `duration_ms = 0` 的半截 LLM 段（那会让「哪段最耗时」把最贵的一段算成 0）
  let llmStreamStatus: 'ok' | 'timeout' | 'skipped' = 'ok'
  try {
    for await (const chunk of stream) {
      // ttft：**首个 chunk 到达即记**（幂等，重复调用只认第一次）。放在循环体最前——
      // 它是「模型什么时候开始吐字」，与后面的撤回/abort 判定无关。
      llmHandle.markFirstChunk()
      // ── 撤回时窗保护（Window ③）──────────────────────
      // 流式输出中途撤回 → 提前终止
      // 检查是否被撤回或超时取消
      if (state.hasRetraction(triggerMsg.id)) {
        log.info('agent reply aborted (retracted)', {
          traceId,
          agentId: agent.id,
        })
        state.deleteActiveStream(agent.id, sessionId)
        state.clearRetraction(triggerMsg.id)
        llmStreamStatus = 'skipped'
        return { content: fullContent || '[消息已撤回]', msgId }
      }
      if (signal?.aborted) {
        // 超时（serial.ts 的 Promise.race 硬上限）与用户主动停止（AGENT_INTERRUPT）
        // **共用本分支**，故文案不得写死任一方——原因由 `signal.reason` 承载。
        // （旧文案写死超时语义，用户点停止也被记成超时，2026-09-18 排障现场即被带偏。）
        // 上游 reason 契约（2026-09-18 补齐）：serial.ts 硬超时 `'timeout'`、执行抛错
        // `'error'`；state.ts abortAgent（用户点停止）`'user-stop'`。
        // signal 只能 abort 一次、先到者胜——硬超时已 abort('timeout') 后 catch 再
        // abort('error') 是 no-op，收尾仍记 'timeout'（正确）。
        log.info('agent reply aborted', {
          traceId,
          agentId: agent.id,
          reason: String(signal?.reason ?? 'unknown'),
        })
        state.deleteActiveStream(agent.id, sessionId)
        llmStreamStatus = 'timeout'
        return { content: fullContent, msgId }
      }
      // 三通道分流（语义拆分）：text → fullContent（正文，入上下文）；thinking →
      // thinkingContent（纯思考，落 thinking_content 不入上下文）；tool → tools
      // 持久化数组（落 tool_content，独立通道）。displayContent 只含 text+thinking
      // （content 兼容字段），tool 不并入——旧前端无 tool 段消费能力，工具不进正文/思考。
      if (chunk.kind === 'tool') {
        upsertTool(tools, chunk)
        mergeToolSegment(segments, chunk)
      } else {
        if (chunk.content) {
          displayContent += chunk.content
          if (chunk.kind === 'thinking') {
            thinkingContent += chunk.content
            appendSegment(segments, 'thinking', chunk.content)
          } else {
            fullContent += chunk.content
            appendSegment(segments, 'text', chunk.content)
          }
        }
      }
      // 每次有实际推进（text/thinking 内容或 tool 状态变化）就推送一次 typing
      // ——tool chunk 可能 content 空（claude running 阶段），仍须推（卡片状态推进）
      if (chunk.kind === 'tool' || chunk.content) {
        bus.emitTyping({
          sessionId,
          agentId: agent.id,
          messageId: msgId,
          content: displayContent,
          segments,
        })
        state.setActiveStream(agent.id, sessionId, {
          sessionId,
          messageId: msgId,
          content: displayContent,
          segments,
          token: signalToken,
        })
      }
    }
  } finally {
    clearInterval(heartbeatTimer)
    // E7 收口：`ttft_ms` 在 `endSpan` 内结算（首 chunk 相对本段起点）。token 数取与
    // `updateExecutionLogDiagnostics` **同一表达式**的估算值——适配器不回流 usage，
    // 本仓的 `Chunk` 没有 usage 字段（R2 §八 明写不改 shared 类型）。
    trace.endSpan(llmHandle, llmStreamStatus, {
      llmUsage: {
        inputTokens: contextTokenStats.total,
        outputTokens: estimateTokens(fullContent),
      },
    })
  }

  // 超时取消时不写入消息也不更新状态（由 catch 块处理）
  if (signal?.aborted) {
    log.info('agent reply discarded after stream (timeout)', {
      traceId,
      agentId: agent.id,
    })
    state.deleteActiveStream(agent.id, sessionId)
    return { content: fullContent, msgId }
  }

  const latencyMs = Date.now() - t0

  // 写入完整消息
  // ── 段 E8 `reply.persist`（R2 段五）─────────────────────
  // 只包「回复落库」这一句：它是本地同步写，与后面的 diff 采集（外部 git 子进程）
  // 是两件不同的事，时长必须分得开。
  const persistT0 = Date.now()
  messagesRepo.insertAgentMessage(
    msgId,
    sessionId,
    agent.id,
    fullContent,
    // E3 接线（规格 G2-残留 B）：`|| traceId` 与瞬态层（agentTrigger taskId = triggerMsg.taskId || traceId）
    // 同构——审查链投递带 taskId 后，审查回复落库 = 源链 trace_id，verdict JOIN m.task_id = chain_task_id 匹配；
    // 投递缺失（老版本已知噪声）→ 落库 = 本链 trace_id，仍关联不到任务链，噪声记录在案
    triggerMsg.taskId || traceId,
    thinkingContent || undefined,
    // 工具调用记录：结构化 JSON 数组（id/name/status/input/output 截断摘要）——
    // 独立列 tool_content，与正文/思考三通道分离，query_db/get_message 可查
    tools.length > 0 ? JSON.stringify(tools) : undefined,
    undefined, // extra（对话内 diff 等附加富内容：落库先于采集，成功后经 updateMessageExtra 补写，此处不传）
    // 回复分段（kind+content+tool 时间序交错）JSON——历史渲染还原生成期交错顺序的权威来源。
    // 镜像 clowder 有序块数组；流式 segments 已按 appendSegment 同类合并 + mergeToolSegment
    // 按 id 归并成最终形态（生成期前端看到的交错序），落库持久化后历史不再「工具收拢尾部」
    segments.length > 0 ? JSON.stringify(segments) : undefined
  )
  trace.recordSpan('reply.persist', { startMs: persistT0 })

  const estimatedPromptLen = llmMessages.reduce((sum, m) => sum + m.content.length, 0)
  const promptTokens = contextTokenStats.total

  log.info('agent reply done', {
    traceId,
    agentId: agent.id,
    agentName: agent.name,
    latencyMs,
    replyLen: fullContent.length,
    promptLen: estimatedPromptLen,
    promptTokens,
    replyTokens: estimateTokens(fullContent),
    contextMessages: truncatedMessages.length,
  })

  // 短回复检测：上下文较大但回复极短 → CLI 可能静默失败
  if (fullContent.length < 100 && estimatedPromptLen > 10000) {
    log.warn('agent produced unusually short reply', {
      traceId,
      agentId: agent.id,
      agentName: agent.name,
      replyLen: fullContent.length,
      promptLen: estimatedPromptLen,
      contextMessages: truncatedMessages.length,
      latencyMs,
      replyPreview: fullContent.slice(0, 200),
    })
  }

  // 重启请求识别：agent 回复以【重启请求】开头 → 广播附加 messageType（前端渲染按钮组），
  // 并写 .restart-request 文件（state=pending，dev.js 轮询执行重启）。
  // 与 ingest 用户路径同款——88d5f82 只覆盖了用户入口，店长是 agent 走本路径，
  // 此前触发链从未生效（agent 路径盲区）。消息本身仍以 agent role 落库（类型不落库）。
  // 结构化通道（request_user_action 工具信号，msgId 标签消费）与文本检测取并集——
  // 信号是主路径（稳定触发，reason 直接来自结构化参数），文本检测保留为兼容
  // fallback（历史消息 + 用户聊天直说"重启"仍可触发，但 seed prompt 不再教格式）。
  const userRequestSignals = consumeUserRequestSignals(sessionId, agent.id, msgId)
  const signalRestart = userRequestSignals.find((s) => s.type === 'restart')
  const isRestartRequest = isRestartRequestContent(fullContent) || !!signalRestart
  const restartReason = signalRestart?.reason || extractRestartReason(fullContent)
  const restartExpiresAt = new Date(Date.now() + RESTART_TTL_MS).toISOString()

  const finalMsg: Message = {
    id: msgId,
    sessionId,
    agentId: agent.id,
    role: 'agent',
    content: fullContent,
    mentions: [] as string[],
    taskId: triggerMsg.taskId || undefined,
    thinkingContent: thinkingContent || undefined,
    ...(tools.length > 0 ? { toolContent: tools } : {}),
    // 分段数组本体随 NEW_MESSAGE 广播（与 toolContent: tools 同款——数组直接携带，
    // socket.io 序列化时取值，不二次 stringify）；web store 收到后消息即带 segments，
    // 历史折叠块/后续会话重入（SESSION_HISTORY 走 DB segments 列）两路都拿到交错序
    ...(segments.length > 0 ? { segments } : {}),
    createdAt: new Date().toISOString(),
    // agent 耗时（C5）：随广播注入，前端气泡展示「耗时 X.X 秒」。瞬态不落库——
    // 落库在 708 行 insertAgentMessage（独立参数，先于 finalMsg 构造），此处仅广播对象；
    // 刷新后历史重放无 durationMs，评估权威数据仍在 execution_logs.latency_ms。
    // 口径（票① 起）：startedAt 前移到执行起点（上下文组装之前）⇒ 本值 = 整轮执行墙钟
    // 时长（含上下文组装/记忆检索），与运行计时 chip 同源同口径、与 latencyMs 同起点；
    // 早于本票的旧值只含「LLM 流 + 落库」段，两者不可直接跨版本比较。
    durationMs: Date.now() - startedAt,
    ...(isRestartRequest ? { messageType: 'restart_request' as const, restartExpiresAt } : {}),
  }

  // 对话内 diff 采集（富文本块通道）：猫的 content 只写摘要，diff 正文由
  // server 自动从 git 反查 commit 采集——extra 独立列，永不进 LLM 上下文。
  // 失败静默跳过（collectCommitDiffs 内部 5s 超时 + 查不到即 null），不阻塞回复；
  // 外层 try/catch 双保险（保险丝：任何意外都不让回复 emit 延迟/失败）。
  if (triggerMsg.id) {
    // ── 段 E9 `diff.collect`（R2 段五；内部 5s 超时）──────
    const diffT0 = Date.now()
    let diffBlocks: Awaited<ReturnType<typeof collectCommitDiffs>> = null
    try {
      diffBlocks = await collectCommitDiffs(triggerMsg.id)
      if (diffBlocks && diffBlocks.length > 0) {
        finalMsg.extra = { ...(finalMsg.extra ?? {}), rich: { v: 1, blocks: diffBlocks } }
      }
    } catch (err: any) {
      log.warn('diff collect failed (silent)', {
        traceId,
        agentId: agent.id,
        error: err?.message,
      })
    }
    // `collectCommitDiffs` **内部吞掉超时并返回 null**（静默语义是本模块的契约），
    // 外部看不见失败原因 ⇒ 超时判据只能取「本段跑满 `GIT_TIMEOUT_MS`」：`execFile`
    // 在满 5s 时 kill，故「跑满」与「被超时 kill」在当前实现下等价。等价关系的唯一
    // 缺口是「多个 git 调用各自不快、累加超 5s」——代价已知，不为此改采集器语义。
    const diffMs = Date.now() - diffT0
    trace.recordSpan('diff.collect', {
      startMs: diffT0,
      durationMs: diffMs,
      status: diffMs >= GIT_TIMEOUT_MS ? 'timeout' : 'ok',
      itemCount: diffBlocks?.length ?? null,
    })
  }

  // extra 落库（push 的 push 字段 + diff 的 rich 块；任一存在即持久化——
  // SESSION_HISTORY 恢复时按钮数据/ diff 块随消息还原；回复落库先于采集，此处补写）
  if (finalMsg.extra) {
    try {
      messagesRepo.updateMessageExtra(msgId, JSON.stringify(finalMsg.extra))
    } catch (err: any) {
      log.warn('extra persist failed (silent)', {
        traceId,
        agentId: agent.id,
        error: messageOf(err),
      })
    }
  }

  // 写请求文件（幂等：已存在跳过——同一时间只保留首个生效请求，防连发覆盖）
  if (isRestartRequest) {
    try {
      createRestartRequest({
        messageId: msgId,
        sessionId,
        reason: restartReason,
        createdAt: new Date().toISOString(),
        expiresAt: restartExpiresAt,
        state: 'pending',
      })
    } catch (err: any) {
      // 文件写失败不阻塞消息流（dev.js 轮询读不到时只是不重启，消息与按钮仍在）
      log.warn('restart request file write failed', {
        traceId,
        agentId: agent.id,
        sessionId,
        error: messageOf(err),
      })
    }
  }

  bus.emitMessage(finalMsg)

  // P3: 回复经 replyBus 转发到外部平台（OneBot 出站订阅后发回 QQ 绑定群/私聊）。
  // P4 #3（契约钉死）：此处无条件触发——A2A 互 @ 产生的回复同样走 runAgentReply、
  // 同样全量转发 QQ。语义：猫咖工作过程公开可见（公开营业）；将来若要区分
  // 「直接响应群友」的回复需要链路追踪（哪个回复对应哪条群友消息），复杂度远超收益，不做。
  emitAgentReply({
    id: msgId,
    sessionId,
    agentId: agent.id,
    agentName: agent.name,
    content: fullContent,
  })

  // 状态：完成
  bus.emitAgentMessageStatus(sessionId, {
    messageId: triggerMsg.id,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatar,
    status: 'done',
  })

  // 记录新安装的包
  const depsAfter = snapshotPackageDeps()
  const newPkgs = diffNewPackages(depsBefore, depsAfter)
  if (newPkgs.length > 0) {
    log.info('new packages installed', {
      traceId,
      agentId: agent.id,
      packages: newPkgs,
    })
  }

  // 将延迟 + 包信息 + 诊断数据 + token 统计写回 execution_logs
  execLogsRepo.updateExecutionLogDiagnostics(agent.id, sessionId, {
    latencyMs,
    packagesInstalled: JSON.stringify(newPkgs),
    promptChars: estimatedPromptLen,
    replyChars: fullContent.length,
    promptTokens,
    completionTokens: estimateTokens(fullContent),
  })

  // 推送上下文窗口 token 用量给前端（驱动 handoff 的真实数字）
  bus.emitContextWindowStats({
    sessionId,
    agentId: agent.id,
    contextTokens: estimatedTotalTokens,
    maxContextTokens: MAX_CONTEXT,
  })

  // P2: 清理 retractionRequests + activeStreams，防止内存泄漏
  state.clearRetraction(triggerMsg.id)
  state.deleteActiveStream(agent.id, sessionId)

  return { content: fullContent, msgId }
}

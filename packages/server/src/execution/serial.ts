/**
 * Execution — 点单管理组（第 3 刀从 connectors/socketio.ts 迁出，零控制流变化）。
 *
 * executeOneAgent / executeAgentsSerial / drainQueuedCommand + 执行常量与
 * no-key 守卫。输出经注入 bus（EngineBus & HandoffBus），状态经 ./state.js accessor。
 * 日志通道沿用 'socketio'（零可观测行为变化）。
 */

import { execSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import type { AgentConfig, DispatchCommand, Message } from '@cat-study/shared'
import {
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import { createLogger } from '../logger.js'
import {
  dispatch,
  completeExecution,
  initAgentSlot,
  getAgentState,
  executeAgentCommand,
} from '../dispatch/index.js'
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
import {
  registerAbort,
  unregisterAbort,
  acquireLock,
  releaseLock,
  maybeWarnM1,
  getMentionCount,
  setMentionCount,
  clearMentionCountsForTrace,
  deleteActiveStream,
  abortAgent,
} from './state.js'

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

/**
 * 队列 drain：执行 completeExecution 弹出的下一命令（补审计 + 出队反查作者 +
 * B 合并点名 + 递归执行）。抽取为共享函数——成功路径（completeExecution 后立即
 * 调用）与 catch 路径（异常后弹出的命令不丢弃）两处复用。
 * @returns 传入的 claudeRan OR 本次 drain 是否执行过 Claude 适配器
 */
async function drainQueuedCommand(
  bus: EngineBus & HandoffBus,
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
    (await executeAgentsSerialImpl(
      bus,
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
  bus: EngineBus & HandoffBus,
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
    const nextCmd = await completeExecution(agent.id, true, { traceId })
    if (nextCmd) {
      try {
        await drainQueuedCommand(bus, agent, nextCmd, false)
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
    registerAbort(agent.id, abortController)
    try {
      // 用 Promise.race 防止单个 Agent 的 LLM 调用挂起阻塞后续 Agent
      // AbortController 确保超时后子进程被 kill（P0-1 修复）
      reply = await Promise.race([
        runAgentReply(bus, sessionId, agent, triggerMsg, traceId, abortController.signal),
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
      const nextCmd = await completeExecution(agent.id, false, {
        errorMessage: err.message || 'unknown error',
        traceId,
      })
      if (nextCmd) {
        try {
          claudeRan = await drainQueuedCommand(bus, agent, nextCmd, claudeRan)
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
      unregisterAbort(agent.id)
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
      claudeRan = await drainQueuedCommand(bus, agent, queuedCmd, claudeRan)
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
      setMentionCount(traceId, agent.id, getMentionCount(traceId, agent.id) + 1)
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
          const count = getMentionCount(traceId, a.id)
          if (count >= MAX_MENTIONS_PER_AGENT) continue
          setMentionCount(traceId, a.id, count + 1) // 预留配额
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
            (await executeAgentsSerialImpl(
              bus,
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
        drainClaudeRan = await drainQueuedCommand(bus, agent, nextCmd, needsLock)
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

async function executeAgentsSerialImpl(
  bus: EngineBus & HandoffBus,
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
          bus,
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
    clearMentionCountsForTrace(traceId)
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

/** 执行引擎公共面（第 3 刀最小形态：执行入口 + 中断控制；恢复入口第 4 刀并入） */
export interface ExecutionEngine {
  /** 顶层串行执行入口（dispatch 配对调用：dispatch 标 busy → 本方法推 LLM） */
  executeAgentsSerial(
    sessionId: string,
    agents: AgentConfig[],
    triggerMsg: AgentTriggerMsg,
    traceId: string,
    depth?: number
  ): Promise<boolean>
  /** AGENT_INTERRUPT handler：abort 该 agent 当前执行。返回是否真的在跑 */
  abortAgent(agentId: string): boolean
}

/** 引擎工厂：bus 构造注入（零 socket 引用）；生产单实例，测试每用例新造 */
export function createExecutionEngine(bus: EngineBus & HandoffBus): ExecutionEngine {
  return {
    executeAgentsSerial: (sessionId, agents, triggerMsg, traceId, depth = 0) =>
      executeAgentsSerialImpl(bus, sessionId, agents, triggerMsg, traceId, depth),
    abortAgent,
  }
}

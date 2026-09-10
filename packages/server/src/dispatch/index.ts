/**
 * Agent 调度引擎（C1 v3 重构后）。
 *
 * 模块级槽位状态（agentSlots/agentQueues）已收进 execution/serial.ts 的
 * createExecutionEngine 闭包——调度键升 agentId+sessionId（跨会话同猫并行、
 * 同会话同猫 FIFO 保留），决策+执行合并为 engine.execute(cmd) 单接口。
 *
 * 本模块保留：
 * 1. 纯函数：MAX_QUEUE_PER_AGENT（队列上限）、isStaleHandoffRequest（交接去重）
 * 2. 兼容 shim：socketio 等调用方仍从本模块 import 状态访问函数——委托给注册表
 *    单例引擎（getExecutionEngine 服务定位，getIO 同款惯例；未注册时 no-op/空，
 *    与旧模块级空态语义一致）
 * 3. __test_reset：测试钩子（委托引擎复位）
 */

import { v4 as uuid } from 'uuid'
import type { AgentConfig, AgentRuntimeState, DispatchCommand, Message } from '@cat-study/shared'
import { messages as messagesRepo } from '../db/repository/index.js'
import { getExecutionEngine } from '../execution/registry.js'

/** 每个 Agent FIFO 队列的最大长度——超出拒绝入队（通知前端，不静默丢弃） */
export const MAX_QUEUE_PER_AGENT = 3

// ─── Handoff 交接请求去重 ─────────────────────────────

/** 交接文档补填请求的固定前缀（handoff-gen 生成，N9 钉死的精确前缀） */
const HANDOFF_FILL_REQUEST_PREFIX = '请补填以下交接文档'
/** 交接文档模板中的 TODO 占位标记（作者补填后删除）。
 *
 *  **注释形态 + 行首锚定，两个半缺一不可**（T-J 修法 1）：
 *  - 裸串 `TODO: 补填` 扫全会话 `content` 会把**描述本机制**的正文（票单 / 复审 /
 *    交付叙述自己）判成"未补填"，而入口不止文档体——过程叙述与文档体**同面**
 *    （`getAllSessionMessages` 取整条 `content`）。
 *  - 只要注释形态、不要行首锚定**同样拦不住实测样本**：`0319b7f3`（len 6757）的
 *    引用里**就带** `<!--`（注释符偏移 799、裸串 804），且落在**过程叙述行的行中**
 *    （列 804，不顶行）——救下它的只有"行首锚定"那半。
 *  - 范围：**只覆盖 §2–§4** 的模板占位（`handoff-gen.mjs:192/197/202`，行首）；
 *    **不含** §5 的 `buildChecklistSection` 降级文案（`handoff-gen.mjs:658`）。
 *    「改动类型未匹配」是**正常降级**，把降级当「未补填」会让它触发补填——
 *    正是本 spec 要治的无效消耗。 */
const HANDOFF_TODO_MARKER_RE = /^\s*<!-- TODO: 补填/m
const COMMIT_SHA_RE = /Commit: ([0-9a-f]{7,})/

/** 交接文档**体**的判据（T-J 修法 2）：`Commit: <sha>` 只证明"这条消息提到了该
 *  commit"——台账 / 更正 / 复审消息同样命中，于是被当成"该 sha 的完整文档"。
 *  完整文档体另有**结构**特征：三个固定小节名**行首锚定**（模板生成即各自独占一行）。
 *
 *  - "有 `## ` 小节结构"由这三个行首标题承载，**不另设**"标题计数 ≥ 3"——同一事实的
 *    两种说法，多一条就多一个会漂的真相源。
 *  - 取小节名**前缀**（`## 2. Why`）而非全名：编号 + 英文名是模板的固定部分，
 *    破折号后的中文注解可改，改注解不该让判据失效。
 *  - 长度阈值是三者里**最弱**的一条，如实标：真实库实测**零过滤**（232 条含
 *    `Commit: ` 的消息全部 ≥500 字符——补填请求本身就内嵌整份文档）。留着只防
 *    "极短消息恰好凑齐小节名"的构造，真正干活的是那三个行首小节名。 */
const HANDOFF_DOC_MIN_LEN = 500
const HANDOFF_DOC_SECTION_RES = [/^## 2\. Why/m, /^## 3\. Tradeoff/m, /^## 4\. Open Questions/m]

function isHandoffDocBody(content: string): boolean {
  return (
    content.length >= HANDOFF_DOC_MIN_LEN && HANDOFF_DOC_SECTION_RES.every((re) => re.test(content))
  )
}

/**
 * 交接请求是否已 stale：触发消息是「请补填交接文档」请求，且同 session 已有
 * 该 commit 的**完整文档体**（文档体判据 + 含 Commit: <sha> + 无真占位）→ 请求已过时，
 * 执行只会白叫醒猫。只做执行时点检查（入队时文档可能还没落库）。
 *
 * 两个判据面都必须是"被判面本身"（T-J）：
 * - 「已补填」= 有**文档体**且无**真占位**，不是"消息里出现过这几个字"；
 * - 扫的是消息 `content`（`getAllSessionMessages` 取整条），所以判据必须扛得住
 *   描述本机制的**过程叙述**——那是同一条 `content` 的一部分，躲不开。
 *
 * 契约④ 防自证：请求自身不得作为"已补填"证据——真占位判据天然排除；同时排除
 * 触发消息自身 id。
 */
export function isStaleHandoffRequest(cmd: DispatchCommand): boolean {
  if (!cmd.triggerContent.includes(HANDOFF_FILL_REQUEST_PREFIX)) return false
  const m = cmd.triggerContent.match(COMMIT_SHA_RE)
  if (!m) return false
  const sha = m[1]
  const rows = messagesRepo.getAllSessionMessages(cmd.sessionId)
  return rows.some(
    (r) =>
      r.id !== cmd.triggerMessageId && // 排除触发消息自身（防自证）
      r.content.includes(`Commit: ${sha}`) &&
      isHandoffDocBody(r.content) &&
      !HANDOFF_TODO_MARKER_RE.test(r.content)
  )
}

// ─── 兼容 shim（委托注册表单例引擎） ─────────────────

/**
 * 槽位初始化——C1 v3 后由 engine.execute 决策段 ensureSlot 惰性创建，本函数为
 * no-op 兼容（旧调用方显式 init 的意图已不需要；保留导出防存量 import 断链）。
 */
export function initAgentSlot(_agentId: string): void {
  // no-op——槽位惰性创建（execute 决策段 ensureSlot）
}

/**
 * 兼容 shim（C1 v3 前 dispatch 两步走的决策入口）——现已并入 engine.execute。
 * 生产调用方（ingest/recovery）已改走 executeAgentsSerial 单入口，本函数仅
 * 供测试/存量 import 保持类型面：委托 engine.execute 逐目标派发（决策+执行
 * 一次搞定，fire-and-forget）。返回 traceId（与旧契约一致）。
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
  const targets = mentions.length > 0 ? agents.filter((a) => mentions.includes(a.name)) : agents
  const engine = getExecutionEngine()
  if (!engine) return tid
  for (const agent of targets) {
    void engine.execute({
      sessionId,
      agentId: agent.id,
      triggerMessageId: userMessage.id,
      triggerContent: userMessage.content,
      mentions,
      taskId: userMessage.taskId,
      traceId: tid,
      depth,
      pendingTriggers: [],
    })
  }
  return tid
}

/**
 * 兼容 shim——标 busy + 写执行日志（原 dispatch 决策段副作用）。C1 v3 后由
 * engine.execute 决策段内部完成（executeAgentCommand 收进闭包）。本函数 no-op
 * 兼容（测试 mock 仍可断言调用，生产无调用方）。
 */
export async function executeAgentCommand(
  _agent: AgentConfig,
  _cmd: DispatchCommand,
  _traceId: string
): Promise<void> {
  // no-op——引擎决策段内部完成（executeAgentCommand 收进 engine 闭包）
}

/**
 * 兼容 shim——执行收口（原 dispatch 模块函数）。C1 v3 后收进 engine 闭包，
 * 键含 sessionId，接口不暴露该方法（窄接口只留 execute/snapshot/getSlot 等
 * 读与决策方法）。生产无调用方（ingest/recovery 走 engine.execute 单入口，
 * socketio 不 import 本函数），测试用 mock 断言调用——no-op 兼容，
 * 真实收口断言用 engine.getSlot 观察槽位释放。
 */
export async function completeExecution(
  _agentId: string,
  _success: boolean,
  _opts?: {
    latencyMs?: number
    errorMessage?: string
    traceId?: string
    replyMessageId?: string
  }
): Promise<DispatchCommand | undefined> {
  // no-op——收口逻辑在 engine 闭包 completeExecution（键含 sessionId）
  return undefined
}

/**
 * 单 agent 状态（旧键 agentId；多会话并行后一 agent 可能多槽——返回第一个
 * busy/idle 槽位，与旧模块级单槽语义等价）。带 sessionId → engine.getSlot 精确
 * 寻址（AGENT_INTERRUPT 双端 session 化后调用方优先带）；无 → 现状取第一个。
 */
export function getAgentState(agentId: string, sessionId?: string): AgentRuntimeState | undefined {
  const engine = getExecutionEngine()
  if (!engine) return undefined
  if (sessionId) return engine.getSlot(agentId, sessionId)
  return engine.snapshot().find((s) => s.agentId === agentId)
}

/** 全量槽位快照（委托 engine.snapshot） */
export function getAllAgentStates(): AgentRuntimeState[] {
  return getExecutionEngine()?.snapshot() ?? []
}

/** 撤回消息时调用：遍历所有槽位 FIFO 队列移除匹配 triggerMessageId 的命令 */
export function cancelQueuedCommand(triggerMessageId: string): number {
  return getExecutionEngine()?.cancelQueuedCommand(triggerMessageId) ?? 0
}

/** 用户中断（停止按钮）时调用：清空指定 Agent 槽位的 FIFO 队列。
 *  带 sessionId → 只清该会话（OQ3 双端 session 化）；无 → 全部会话（旧客户端语义） */
export function clearAgentQueue(agentId: string, sessionId?: string): number {
  return getExecutionEngine()?.clearAgentQueue(agentId, sessionId) ?? 0
}

/** 撤回时用：是否有 Agent 正在执行（而非仅排队）给定 trigger 消息 */
export function isAnyAgentExecutingMessage(triggerMessageId: string): boolean {
  return getExecutionEngine()?.isAnyAgentExecutingMessage(triggerMessageId) ?? false
}

/** 注册 Socket.IO 桥接函数（委托 engine） */
export function setAgentStateBridge(fn: (state: AgentRuntimeState) => void): void {
  getExecutionEngine()?.setAgentStateBridge(fn)
}

/** 注册系统消息桥接函数（委托 engine）——队列满拒绝入队时通知前端 */
export function setSystemMessageBridge(
  fn: (sessionId: string, agentId: string, content: string) => void
): void {
  getExecutionEngine()?.setSystemMessageBridge(fn)
}

/** 仅在测试中使用：重置引擎槽位/队列/token 池状态 */
export function __test_reset(): void {
  getExecutionEngine()?.__test_reset()
}

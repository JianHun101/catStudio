/** Agent 槽位状态 */
export type SlotStatus = 'idle' | 'thinking' | 'busy'

/** 消息角色 */
export type MessageRole = 'user' | 'agent' | 'system'

/** Agent 执行状态 */
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed'

/** Channel 渠道类型 */
export type ChannelType = 'web' | 'qq'

// ─── Agent ──────────────────────────────────────────

export interface AgentConfig {
  id: string
  name: string
  avatar: string // emoji or URL
  systemPrompt: string
  llmProvider: string // 'deepseek' | 'claude' | 'openai' | 'pi' | 'custom'
  llmModel: string // 'deepseek-v4-pro' | 'claude-sonnet-4-6' | ...
  llmApiKey: string
  llmBaseUrl?: string // for custom providers
  effortLevel?: 'low' | 'medium' | 'high' | 'max' // Claude Code 推理深度
  skillModules: string[] // 可用技能列表
}

/** Agent 运行时状态（广播到前端） */
export interface AgentRuntimeState {
  agentId: string
  sessionId: string | null // 当前在哪个 Session 里忙
  status: SlotStatus
  queueLength: number
  /** 当前正在处理的消息 ID（撤回时用来判断该消息是否还有 Agent 在执行） */
  currentTriggerMessageId?: string | null
}

// ─── Session ────────────────────────────────────────

export interface SessionConfig {
  id: string
  title: string
  agentIds: string[]
  broadcastMode: boolean // true = Agent 可以看到其他 Agent 的回复
  createdAt: string // ISO 8601
  updatedAt: string
  unreadCount?: number // 未读消息数（仅 GET /api/sessions 返回）
  /** 交接来源会话 ID（会话由 handoff 创建时非空） */
  handoffFrom?: string | null
  /** 运行中的增量摘要（JSON 字符串，SessionSummary） */
  runningSummary?: string | null
}

// ─── Message ────────────────────────────────────────

export interface Message {
  id: string
  sessionId: string
  agentId: string | null // null = user or system
  role: MessageRole
  content: string
  mentions: string[] // agent names mentioned with @
  taskId?: string // 任务 ID，串联同一任务的多轮 agent 交互
  createdAt: string
}

// ─── Memory ─────────────────────────────────────────

export interface MemoryEntry {
  id: string
  agentId: string
  content: string // human-readable summary
  embedding: number[] // vector (dim depends on embedding provider)
  sourceMessageId: string
  createdAt: string
}

// ─── Execution Log ──────────────────────────────────

export interface ExecutionLog {
  id: string
  sessionId: string
  agentId: string
  triggeredByMessageId: string
  status: ExecutionStatus
  traceId: string // 请求追踪 ID，串联 dispatch → LLM → reply
  startedAt: string | null
  endedAt: string | null
  latencyMs: number | null // 实际 LLM 调用耗时（毫秒）
  errorMessage: string | null // 失败时的错误信息
}

// ─── Dispatch ───────────────────────────────────────

/** 调度器发给 Agent 的指令 */
export interface DispatchCommand {
  sessionId: string
  agentId: string
  triggerMessageId: string
  triggerContent: string
  mentions: string[]
  taskId?: string // 任务 ID，Agent 间交互继承同一个 taskId
}

// ─── Token Stats ────────────────────────────────────

export interface AgentTokenStats {
  agentId: string
  agentName: string
  /** 累计 prompt token 消耗（所有调用） */
  totalPromptTokens: number
  /** 累计 completion token 消耗 */
  totalCompletionTokens: number
  /** 当前会话 prompt token 消耗 */
  sessionPromptTokens: number
  /** 当前会话 completion token 消耗 */
  sessionCompletionTokens: number
  /** 上下文 token 预算上限 */
  maxContextTokens: number
}

// ─── LLM ────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number // fetch + stream 总超时（毫秒），默认 300000
  signal?: AbortSignal // 外部取消信号，用于中断正在进行的 LLM 调用
}

export interface Chunk {
  content: string
  done: boolean
  /** 区分文本内容和思考过程，思考内容只用于前端流式展示，不存入 DB */
  kind?: 'text' | 'thinking'
}

// ─── Summary & Handoff ──────────────────────────────

/** 会话摘要（存在 sessions.running_summary 列） */
export interface SessionSummary {
  /** 摘要文本 */
  text: string
  /** 摘要覆盖到的最后一条消息 ID */
  lastMessageId: string
  /** 摘要本身的 token 数 */
  tokenCount: number
  /** 生成时间 */
  createdAt: string
}

/** 会话交接事件（推送到前端） */
export interface HandoffEvent {
  oldSessionId: string
  newSessionId: string
  /** 交接摘要（全量总结） */
  summary: string
}

/** 上下文窗口 token 统计（每次 Agent 回复后推送） */
export interface ContextWindowStats {
  sessionId: string
  agentId: string
  /** 当前上下文窗口的 token 用量（截断前消息 + system prompt，驱动 handoff 的值） */
  contextTokens: number
  /** 上下文 token 预算上限 */
  maxContextTokens: number
}

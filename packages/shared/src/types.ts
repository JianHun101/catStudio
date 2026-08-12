/** Agent 槽位状态 */
export type SlotStatus = 'idle' | 'thinking' | 'busy'

/** Agent 角色——A2A mention 白名单的判定依据（店长架构定稿：store/implementer/reviewer/vision） */
export type AgentRole = 'store' | 'implementer' | 'reviewer' | 'vision'

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
  llmProvider: string // 'deepseek' | 'claude' | 'openai' | 'pi' | 'ollama' | 'custom'
  llmModel: string // 'deepseek-v4-pro' | 'claude-sonnet-4-6' | ...
  llmApiKey: string
  llmBaseUrl?: string // for custom providers
  effortLevel?: 'low' | 'medium' | 'high' | 'max' // Claude Code 推理深度
  /** 单次输出 token 上限（per-agent 静态运行配置；缺省 → 适配器兜底 2048） */
  llmMaxTokens?: number
  /** 采样温度（per-agent 静态运行配置；缺省 → 适配器兜底 0.7） */
  llmTemperature?: number
  /** 额外环境变量（JSON 字符串直存任意 env KV，如 {"HTTPS_PROXY":"http://127.0.0.1:7897"}；
   *  仅 spawn CLI 的适配器消费，HTTP 适配器忽略——Node fetch 不读代理 env；DB 直存直取零解析） */
  llmEnvExtra?: string
  role?: AgentRole // 角色——A2A mention 白名单依据；缺失/未知 → 放行不拦截（老库零回归）
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

/**
 * 消息类型——驱动前端渲染分支（如重启确认按钮组）。
 * DB 的 messages.role 有 CHECK 约束（仅 user/agent/system），类型不落库，
 * 由服务端检测消息内容前缀后作为附加字段随广播（NEW_MESSAGE/SESSION_HISTORY）携带。
 */
export type MessageType = 'normal' | 'restart_request'

/**
 * 富文本块——结构化展示内容（当前仅 diff）。
 * 服务端从 git 反查 commit 采集，随消息 extra 列持久化 + 广播，
 * 永不进 LLM 上下文（上下文构建只消费 content）。
 */
export interface RichBlock {
  id: string
  kind: 'diff'
  v: 1
  filePath: string
  /** 文件级 unified diff 文本（不含 diff --git 头；服务端已做 200/500 行截断） */
  diff: string
}

/**
 * 消息附加富内容（extra 列 JSON 序列化；服务端采集附加，前端按需渲染，
 * 无 extra 的消息前端纯文本回退——与现网行为一致）。
 */
export interface MessageExtra {
  rich?: {
    v: 1
    blocks: RichBlock[]
  }
}

export interface Message {
  id: string
  sessionId: string
  agentId: string | null // null = user or system
  role: MessageRole
  content: string
  /** 用户消息附带的图片（base64 dataURL 数组，仅 ollama 视觉模型可见真图） */
  images?: string[]
  mentions: string[] // agent names mentioned with @
  taskId?: string // 任务 ID，串联同一任务的多轮 agent 交互
  thinkingContent?: string // 思考过程内容（仅前端展示，不参与 Agent 间上下文）
  createdAt: string
  /** 消息类型（服务端检测附加，默认 normal 不携带该字段） */
  messageType?: MessageType
  /** restart_request 消息的请求过期时间（ISO 8601，默认 10 分钟）——前端据此隐藏过期按钮 */
  restartExpiresAt?: string
  /** 消息附加富内容（diff 块等；服务端采集附加，永不进 LLM 上下文） */
  extra?: MessageExtra
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
  traceId: string // 请求追踪 ID——队列命令出队时用自身 trace，防多 trace 叠加错配（A2A 配额张冠李戴）
  depth: number // 触发层深：用户顶层 0、A2A 每层 +1——决定该执行是否消耗 mention 配额
  pendingTriggers: string[] // 已并入本命令的触发消息 ID（B 触发合并：A2A 同 session 排队期间的后续触发并入，出队执行时点名"还有 N 件事"）
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
  /** 视觉图片（base64 dataURL）。仅 Ollama 适配器使用，其他适配器忽略（但仍会收到文字占位提示） */
  images?: string[]
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number // fetch + stream 总超时（毫秒），默认 300000
  chunkTimeoutMs?: number // 流式 chunk 间停顿超时（毫秒），默认 30000（deepseek.ts 消费；推理模型深度思考可超 30s）
  signal?: AbortSignal // 外部取消信号，用于中断正在进行的 LLM 调用
  /**
   * 猫咖内部路由上下文（MCP 结构化路由 v4，契约 3 二次修订——店长裁决）。
   * 仅 claude.ts 适配器消费（挂 MCP 工具面 + buildEnv 透传），
   * 其他适配器忽略，零影响。
   *  sessionId/agentId/msgId — 信号三要素（MCP server 读 CATSTUDY_* env）
   *  token — 每 spawn 随机信号 token（activeStreams 存值 → internal.ts 精确匹配）
   *  triggerAuthorName — 本次触发消息作者名（可选；internal.ts 预校验传给
   *    filterAllowedMentions，reviewer 可 @ 回请求人的特殊边，OQ③ 补丁）
   */
  context?: {
    sessionId: string
    agentId: string
    msgId: string
    token: string
    traceId?: string
    triggerAuthorName?: string
  }
  /**
   * CLI 子进程工作目录（会话 worktree 隔离用——猫在独立目录执行，
   * auto-commit 落会话分支）。缺省由适配器取默认 workspace。
   * 仅 claude/pi 等 spawn CLI 的适配器消费；HTTP 适配器忽略。
   */
  cwd?: string
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

import type { ExecutionMeta } from '@cat-study/shared'

const BASE = '/api'
const DEFAULT_TIMEOUT = 10_000 // 10s，确保重试循环能推进

async function request<T>(path: string, options?: RequestInit & { timeout?: number }): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, ...fetchOptions } = options || {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const hasBody = fetchOptions.body != null
    const res = await fetch(`${BASE}${path}`, {
      ...(hasBody ? { headers: { 'Content-Type': 'application/json' } } : {}),
      ...fetchOptions,
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      const detail = body?.message || body?.error || res.statusText
      // 根据状态码提供中文前缀
      let prefix = ''
      if (res.status === 404) prefix = '资源不存在：'
      else if (res.status === 409) prefix = '冲突：'
      else if (res.status >= 500) prefix = '服务器错误：'
      const err = new Error(`${prefix}${detail || `HTTP ${res.status}`}`) as any
      err.status = res.status
      err.body = body
      throw err
    }
    return res.json()
  } catch (err: any) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`请求超时 (${timeout / 1000}s)`) as any
      timeoutErr.status = 0
      throw timeoutErr
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 连接器绑定行——后端 snake_case 原样返回（routes/connectors.ts，无 camelCase 转换） */
export interface ConnectorBinding {
  id: string
  platform: string
  external_type: 'group' | 'private'
  external_id: string
  session_id: string
  created_at: string
}

/** OneBot/NapCat 生命周期状态——server 只读探测（TOKEN 服务端脱敏，只给掩码） */
export interface OneBotStatus {
  ok: boolean
  enabled: boolean
  apiBase: string
  running: boolean
  /** dev 启动时自动拉起 NapCat（.napcat-config.json autoStart，缺省 true）——与 config 契约同源 */
  autoStart: boolean
  launchCmdConfigured: boolean
  /** 启动命令就绪：模板非空且（无 {NAPCAT_PATH} 占位符 || 页面路径已配置）——start 按钮以此为准 */
  launchReady: boolean
  tokenConfigured: boolean
  tokenMasked: string
}

/** NapCat 启动路径配置（.napcat-config.json）——pathExists 在路径未配置时为 null；
 *  autoStart 缺省 true：旧配置无该字段 = 自动拉起（用户决策，行为不变） */
export interface NapcatConfig {
  ok: boolean
  napcatPath: string
  pathExists: boolean | null
  autoStart: boolean
}

/** NapCat 路径浏览条目（只读目录导航——浏览器拿不到本地路径，选择器走 server 列目录） */
export interface NapcatBrowseEntry {
  name: string
  type: 'dir' | 'file'
  executable: boolean
}

export interface NapcatBrowseResult {
  ok: boolean
  dir: string | null
  parent: string | null
  entries: NapcatBrowseEntry[]
}

/** context 阈值配置（context-config.json——80% 告警 / 90% 交接，服务端权威，缺文件返回默认值） */
export interface ContextConfig {
  warnThreshold: number
  handoffThreshold: number
  /** 上下文窗口上限（env MAX_CONTEXT_TOKENS 读，只读回显不回写） */
  maxContextTokens: number
}

/** 摘要配置（SUMMARY_MODEL/SUMMARY_API_KEY——写 .env 行级 patch，重启生效；key 不出 server 只给掩码） */
export interface SummaryConfig {
  summaryModel: string
  summaryBaseUrl: string
  summaryApiKeyMasked: string
  hasKey: boolean
  /** POST 后为 true——.env 写回需重启 server 才生效 */
  needsRestart: boolean
}

/** 铁律全文（GET /api/iron-laws——settings 表优先、seed-data.ts 常量兜底，运行期注入的全局策略） */
export interface IronLaws {
  coder: string
  reviewer: string
}

// ─── Eval 评估中心（E4-A 后端契约，snake_case 原样返回）─────────

/** 评分行（EvalScoreRow + join agents 的猫名；agent 已删除时 agent_name 为 null） */
export interface EvalScoreRow {
  id: string
  message_id: string
  session_id: string
  agent_id: string | null
  score: number
  dimensions: string | null
  judge_model: string
  sample_reason: string
  created_at: string
  agent_name: string | null
}

/** 按猫聚合（count / avg_score / low_score_rate≤2 占比，服务端 ROUND 2 位） */
export interface ScoreAggregate {
  agent_id: string | null
  agent_name: string | null
  count: number
  avg_score: number
  low_score_rate: number
}

/** 待回标样本（low_score 且无 user_feedback，附回复全文 + 前置上下文数组） */
export interface PendingReviewScore extends EvalScoreRow {
  reply_content: string
  reply_created_at: string
  context: Array<{
    id: string
    role: string
    agent_id: string | null
    content: string
    created_at: string
  }>
}

/** 任务结局分布（E4-B 契约缺口裁决补充的路由）：U 根/H 根 outcome 计数 + open + 版本偏差 */
export interface EpisodeStats {
  versionStale: number
  uRoot: Record<string, number>
  hRoot: Record<string, number>
  open: number
}

// ─── P1 链路视图（GET /eval/l1-metrics + GET /eval/chains，契约由 P1-A 冻结在字段级）──
// 两条响应均为**平铺**（无 `ok` 外壳）——与上方 E4-A 的 `{ ok, … }` 不同，照契约读顶层字段。

/** L1 八口径（服务端 `aggregateMetrics()` 原样）。`avgLatencyMs` 为 null = 窗口内无 completed
 *  样本（或 latency 采集修复前的存量窗口）。「无数据」≠「0」，展示端必须区分。 */
export interface EvalL1Metrics {
  windowDays: number
  successRate: number
  timeoutRate: number
  avgLatencyMs: number | null
  totalTokens: number
  suggestRate: number
  rejectRate: number
  parseFailureRate: number
  infraFailures: number
  sampleTotal: number
}

/** 卡点标记（P1 裁决：四值互不排斥、全标不筛选——先看到真实分布再定阈值） */
export type HopFlag = 'failed' | 'no_reply' | 'slow' | 'no_data'

/** 一跳 = 一条 execution_logs（执行跳，**不是**一条 messages 行）。
 *  失败跳没有回复消息，但**必须**出现在 `hops[]` 里——按消息行分组会把卡点静默吞掉。 */
export interface ChainHop {
  executionLogId: string
  agentId: string
  agentName: string
  status: string
  errorType: string | null
  /** SQLite 原样 UTC 串（无时区后缀）——**消费必须走 `utils/time.ts`**（唯一解析入口；
   *  直喂 `new Date` 会按本地时区解析，差 8 小时） */
  startedAt: string | null
  /** null = 该跳仍在飞（展示「进行中」+ 耗时 `—`） */
  endedAt: string | null
  /** 秒级精度（`datetime('now')` 写）；`endedAt` 为 null → null */
  totalMs: number | null
  /** = `latency_ms`（毫秒精度）。语义 = 上下文过滤 + 记忆检索 + LLM 流式 + 落库（不只是 LLM） */
  replyMs: number | null
  /** = `totalMs − replyMs`。语义 = 等 token 锁 + 编排收尾 + 建行开销——**禁用「等锁」类命名** */
  nonReplyMs: number | null
  /** true = 秒级舍入导致 `totalMs − replyMs < 0`（已钳位但显式暴露，不静默） */
  segmentClamped: boolean
  flags: HopFlag[]
  triggerMessageId: string
  replyMessageId: string | null
}

/** 一条链（后端已按 `spanMs` 降序排好并截断，前端不重排） */
export interface EvalChain {
  /** 链锚 = `coalesce(reply.task_id, trigger.task_id)` */
  chainId: string
  startedAt: string | null
  /** 链内有在飞跳时是**已结束跳的下界**，故 `spanMs` 偏小 */
  endedAt: string | null
  spanMs: number | null
  hopCount: number
  completedCount: number
  failedCount: number
  hops: ChainHop[]
}

export interface EvalChainTotals {
  chains: number
  hops: number
  orphanHops: number
  avgHopsPerChain: number
  maxHops: number
}

/** GET /eval/chains 响应体（窗口全量口径在 `totals`，`chains[]` 是被 `limit` 截断的那部分） */
export interface EvalChainsResponse {
  windowDays: number
  anchor: string
  slowMs: number
  totals: EvalChainTotals
  chains: EvalChain[]
  /** 链锚为 NULL 的孤儿跳。**恒在**——无孤儿时 `{ chainId: null, hopCount: 0, hops: [] }` */
  orphanChain: { chainId: null; hopCount: number; hops: ChainHop[] }
}

// ─── R3 段分解（GET /eval/spans，契约由 R3 票面 §二 冻结在字段级）──

/** 一行段（R2 `spans` 表原样 snake_case）。
 *  ⚠️ `start_at` 是 **ISO 毫秒 UTC**（`2026-09-14T13:20:00.000Z`），与
 *  `execution_logs` 的秒级 `YYYY-MM-DD HH:MM:SS` **不同形**——但 `utils/time.ts`
 *  两种形态通吃（R5 起：老实现遇到 ISO 串会 `+ 'Z'` 出 `...ZZ` 而原样回显），
 *  消费一律走它，别再按形态各写一份。 */
export interface SpanRow {
  id: number
  span_id: string
  /** NULL = 该执行的根段（`invoke_agent`） */
  parent_span_id: string | null
  chain_id: string | null
  /** = `ChainHop.executionLogId`（同值，故前端零契约变更） */
  execution_id: string
  session_id: string | null
  agent_id: string | null
  /** 段名——闭集 11 条（R2 §五） */
  name: string
  operation_name: string | null
  start_at: string
  duration_ms: number
  status: string
  error_type: string | null
  error_message: string | null
  item_count: number | null
}

/** `llm.chat` 段专属详情（`span_llm` 表）。**camelCase**——服务端换算过，不是 DB 列名 */
export interface LlmSpanDetail {
  provider: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  /** 首 chunk 延迟（毫秒）；本仓存毫秒，导出 OTel 时才换算成秒 */
  ttftMs: number | null
  stream: boolean
  maxTokens: number | null
}

/** 段 + **内联**的 LLM 详情。非 `llm.chat` 段 `llm` 恒 `null`；
 *  内联而非单开端点，是为了掐掉前端 N+1（11 段各发一次请求）。 */
export interface SpanDto extends SpanRow {
  llm: LlmSpanDetail | null
}

/** 本会话**每只猫的最后一次执行**（R4 §A，右侧面板内联 trace 用）。
 *  **camelCase**——随 eval 面 chains 面惯例（同构的 `ChainHop` 亦是 camelCase；
 *  `SpanDto` 走 snake_case 是因为它直接透传 DB 行，两者别混）。 */
export interface SessionTraceDto {
  agentId: string
  executionId: string
  status: string
  startedAt: string
  /** 在飞恒 `null` ⇒ 耗时不可得：前端必须显式显示「采集中」，不是 `0` 也不是空白 */
  endedAt: string | null
  totalMs: number | null
}

export const api = {
  // Agents
  getAgents: () => request<any[]>('/agents'),

  createAgent: (data: {
    name: string
    avatar: string
    systemPrompt: string
    llmProvider: string
    llmModel: string
    llmApiKey: string
    llmBaseUrl?: string
    effortLevel?: string
  }) =>
    request<any>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAgent: (
    id: string,
    data: Partial<{
      name: string
      avatar: string
      systemPrompt: string
      llmProvider: string
      llmModel: string
      llmApiKey: string
      llmBaseUrl: string
      effortLevel: string
      /** 静态运行配置（单 A 契约：maxTokens 正整数 1..131072、temperature 0..2） */
      llmMaxTokens: number
      llmTemperature: number
      /** 额外环境变量（JSON 字符串原样，如 {"HTTPS_PROXY":"http://127.0.0.1:7897"}） */
      llmEnvExtra: string
    }>
  ) =>
    request<any>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteAgent: (id: string) => request<any>(`/agents/${id}`, { method: 'DELETE' }),

  getAgentStats: (id: string, sessionId?: string) => {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<any>(`/agents/${id}/stats${query}`)
  },

  // Sessions
  getSessions: () => request<any[]>('/sessions'),

  getSession: (id: string) => request<any>(`/sessions/${id}`),

  createSession: (data: { title: string; agentIds: string[] }) =>
    request<any>('/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /** 更新会话成员（PATCH /api/sessions/:id——server 契约：addAgentIds/removeAgentIds 均可选，删除后空列表 400 由后端兜底） */
  updateSessionAgents: (
    sessionId: string,
    data: { addAgentIds?: string[]; removeAgentIds?: string[] }
  ) =>
    request<any>(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteSession: (id: string) => request<any>(`/sessions/${id}`, { method: 'DELETE' }),

  clearSessionMessages: (id: string) =>
    request<any>(`/sessions/${id}/messages`, { method: 'DELETE' }),

  markSessionRead: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${id}/read`, { method: 'POST' }),

  // 执行元数据（气泡 footer 耗时/token 的落库稳定数据源——execution_logs.message_id 关联回复消息，
  // GET /api/sessions/:id/executions，camelCase 由 server 转换；空 session 返回 { executions: [] }）
  getSessionExecutions: (id: string) =>
    request<{ executions: ExecutionMeta[] }>(`/sessions/${id}/executions`),

  // Connector bindings (QQ / OneBot)
  getConnectorBindings: (platform?: string) => {
    const query = platform ? `?platform=${encodeURIComponent(platform)}` : ''
    return request<{ ok: boolean; bindings: ConnectorBinding[] }>(`/connectors/bindings${query}`)
  },

  createConnectorBinding: (data: {
    platform: string
    externalType: 'group' | 'private'
    externalId: string
    sessionId: string
  }) =>
    request<{ ok: boolean; binding: ConnectorBinding }>('/connectors/bindings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteConnectorBinding: (data: {
    platform: string
    externalType: 'group' | 'private'
    externalId: string
  }) =>
    request<{ ok: boolean }>('/connectors/bindings', {
      method: 'DELETE',
      body: JSON.stringify(data),
    }),

  // NapCat / OneBot 生命周期薄桥（server 零 spawn，只读探测 + 写请求文件）
  getOneBotStatus: () => request<OneBotStatus>('/connectors/onebot/status'),

  napcatControl: (action: 'start' | 'stop') =>
    request<{ ok: boolean }>('/connectors/napcat/control', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  // NapCat 启动路径配置（.napcat-config.json——页面保存路径 + autoStart 开关，dev.js 拉起时读）
  getNapcatConfig: () => request<NapcatConfig>('/connectors/napcat/config'),

  saveNapcatConfig: (data: { napcatPath: string; autoStart?: boolean }) =>
    request<{ ok: boolean; napcatPath: string }>('/connectors/napcat/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // NapCat 路径浏览（只读目录导航：dir 空 → 盘符列表；dir 存在 → 目录条目）
  browseNapcatDir: (dir?: string) => {
    const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
    return request<NapcatBrowseResult>(`/connectors/napcat/browse${query}`)
  },

  // context 阈值配置（80% 告警 / 90% 交接——单 A 契约：GET 缺文件返回默认；POST 未传字段 → 默认）
  getContextConfig: () => request<ContextConfig>('/config/context'),

  saveContextConfig: (data: { warnThreshold?: number; handoffThreshold?: number }) =>
    request<ContextConfig>('/config/context', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 摘要配置（SUMMARY_MODEL/SUMMARY_API_KEY——写 .env 行级 patch，needsRestart 驱动「重启后生效」提示；
  // POST 可选字段：summaryApiKey 未传=保持现状、空串=清空回退 DS_KEY，前端留空不传避免误清空）
  getSummaryConfig: () => request<SummaryConfig>('/config/summary'),

  saveSummaryConfig: (data: { summaryModel?: string; summaryApiKey?: string }) =>
    request<SummaryConfig>('/config/summary', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 铁律读写（GET/POST /api/iron-laws——settings 表优先、常量兜底；编辑后下一轮回复立即生效）
  getIronLaws: () => request<IronLaws>('/iron-laws'),

  putIronLaws: (payload: { coder: string; reviewer: string }) =>
    request<IronLaws>('/iron-laws', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Eval 评估中心（E4-A 后端四接口 + E4-B 契约缺口裁决补充的 episode-stats；纯展示 + 回标写入零 LLM）
  getEvalScores: (limit?: number, agentId?: string) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (agentId) params.set('agent_id', agentId)
    const qs = params.toString()
    return request<{ ok: boolean; scores: EvalScoreRow[] }>(`/eval/scores${qs ? `?${qs}` : ''}`)
  },

  getEvalAggregates: () =>
    request<{ ok: boolean; aggregates: ScoreAggregate[] }>('/eval/aggregates'),

  getEvalPending: () =>
    request<{ ok: boolean; pending: PendingReviewScore[] }>('/eval/review/pending'),

  /** 提交回标（重复提交同一 eval_score_id → 后端覆盖 + log 留痕，covered=true） */
  submitEvalReview: (evalScoreId: string, data: { score: number; comment?: string }) =>
    request<{ ok: boolean; covered: boolean }>(`/eval/review/${evalScoreId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getEvalEpisodeStats: () => request<{ ok: boolean; stats: EpisodeStats }>('/eval/episode-stats'),

  /** L1 八口径（纯读；窗口由服务端 env 控制——P1 不做筛选交互，故不传参） */
  getEvalL1Metrics: () => request<EvalL1Metrics>('/eval/l1-metrics'),

  /** 链路视图（后端已排序 + 截断；孤儿跳只在 `orphanChain`，不在 `chains[]` 内） */
  getEvalChains: () => request<EvalChainsResponse>('/eval/chains'),

  /** 一次执行的段分解时间轴（R3）。**空数组是合法响应**——running 中 / 采集修复前的
   *  存量行都回 `[]`，不是 404；前端据「跳是否结束」区分文案，不靠这个空数组。 */
  getEvalSpans: (executionId: string) =>
    request<{ ok: boolean; spans: SpanDto[] }>(
      `/eval/spans?execution_id=${encodeURIComponent(executionId)}`
    ),

  /** 本会话**每只有执行的猫的最后一次执行**（R4 §A，右侧面板内联 trace 的入口）。
   *  契约（派活单钉死）：每猫取 `started_at` 最大的一条、**不看状态**；在飞
   *  （`endedAt == null`）**照样返回**；本会话零执行的猫**不出现**在数组里
   *  （不是 `0` 不是空白——前端据此显示「本会话暂无执行」）。
   *  段数据**不内联**：拿到 `executionId` 后再调 `getEvalSpans` 懒加载。 */
  getSessionTraces: (sessionId: string) =>
    request<{ ok: boolean; traces: SessionTraceDto[] }>(
      `/eval/session-traces?session_id=${encodeURIComponent(sessionId)}`
    ),
}

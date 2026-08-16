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
}

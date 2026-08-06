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
  launchCmdConfigured: boolean
  /** 启动命令就绪：模板非空且（无 {NAPCAT_PATH} 占位符 || 页面路径已配置）——start 按钮以此为准 */
  launchReady: boolean
  tokenConfigured: boolean
  tokenMasked: string
}

/** NapCat 启动路径配置（.napcat-config.json）——pathExists 在路径未配置时为 null */
export interface NapcatConfig {
  ok: boolean
  napcatPath: string
  pathExists: boolean | null
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

  // NapCat 启动路径配置（.napcat-config.json——页面保存路径，dev.js 拉起时读）
  getNapcatConfig: () => request<NapcatConfig>('/connectors/napcat/config'),

  saveNapcatConfig: (data: { napcatPath: string }) =>
    request<{ ok: boolean; napcatPath: string }>('/connectors/napcat/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // NapCat 路径浏览（只读目录导航：dir 空 → 盘符列表；dir 存在 → 目录条目）
  browseNapcatDir: (dir?: string) => {
    const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
    return request<NapcatBrowseResult>(`/connectors/napcat/browse${query}`)
  },
}

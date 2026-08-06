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
  tokenConfigured: boolean
  tokenMasked: string
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
}

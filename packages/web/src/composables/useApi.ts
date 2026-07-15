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

export const api = {
  // Agents
  getAgents: () =>
    request<any[]>('/agents'),

  createAgent: (data: {
    name: string
    avatar: string
    systemPrompt: string
    llmProvider: string
    llmModel: string
    llmApiKey: string
    llmBaseUrl?: string
    effortLevel?: string
  }) => request<any>('/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  updateAgent: (id: string, data: Partial<{
    name: string
    avatar: string
    systemPrompt: string
    llmProvider: string
    llmModel: string
    llmApiKey: string
    llmBaseUrl: string
    effortLevel: string
  }>) => request<any>(`/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),

  deleteAgent: (id: string) =>
    request<any>(`/agents/${id}`, { method: 'DELETE' }),

  // Sessions
  getSessions: () =>
    request<any[]>('/sessions'),

  createSession: (data: { title: string; agentIds: string[] }) =>
    request<any>('/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteSession: (id: string) =>
    request<any>(`/sessions/${id}`, { method: 'DELETE' }),

  clearSessionMessages: (id: string) =>
    request<any>(`/sessions/${id}/messages`, { method: 'DELETE' }),
}

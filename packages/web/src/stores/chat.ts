import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Events } from '@cat-study/shared'
import type {
  Message,
  AgentRuntimeState,
  SessionConfig,
  AgentConfig,
  AgentTokenStats,
} from '@cat-study/shared'
import { useSocket } from '@/composables/useSocket'
import { api } from '@/composables/useApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('chatStore')

/** 将技术错误信息转为用户可读的中文提示 */
function friendlyError(err: any): string {
  if (!err) return '未知错误'
  const msg: string = err?.body?.message || err?.body?.error || err.message || String(err)
  if (msg.includes('AbortError') || msg.includes('超时') || msg.includes('timeout')) {
    return '服务器响应超时，请检查后端是否已启动'
  }
  if (msg.includes('fetch') || msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
    return '无法连接服务器，请确认后端正在运行 (端口 3200)'
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('Connection refused')) {
    return '服务器尚未就绪，请稍后刷新页面'
  }
  return msg
}

export const useChatStore = defineStore('chat', () => {
  // ─── State ────────────────────────────────

  const sessions = ref<SessionConfig[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<Message[]>([])
  const agentStates = ref<Map<string, AgentRuntimeState>>(new Map())
  const agents = ref<AgentConfig[]>([])
  const typingStates = ref<Map<string, { messageId: string; content: string }>>(new Map())
  const unreadCounts = ref<Map<string, number>>(new Map()) // sessionId → unread count
  const loading = ref(false)
  const waitingForServer = ref(false) // 等待服务器启动（health check 轮询中）
  const dataReady = ref(false) // 首次数据加载完成后为 true
  const dataError = ref('') // 加载失败时的错误信息
  const broadcastMode = ref(false)
  const serverOnline = ref(false) // Socket.IO 是否已连接
  const errorMessage = ref<string | null>(null) // 服务端 ERROR 事件的 toast 消息
  let errorTimer: ReturnType<typeof setTimeout> | null = null
  const loadingMessages = ref(false) // session 切换时等待历史消息加载
  const pendingHandoffSummary = ref<string | null>(null) // handoff 摘要，等待 SESSION_HISTORY 到达后注入
  let handoffJoining = false // S8: 防止 handoff 重入（两次 SESSION_HANDOFF 先后到达时相互覆盖）

  /** 显示错误 toast，5 秒后自动消失 */
  function showError(message: string): void {
    if (errorTimer) clearTimeout(errorTimer)
    errorMessage.value = message
    errorTimer = setTimeout(() => {
      errorMessage.value = null
      errorTimer = null
    }, 5000)
  }

  /** 关闭错误 toast */
  function dismissError(): void {
    if (errorTimer) clearTimeout(errorTimer)
    errorMessage.value = null
    errorTimer = null
  }

  /** 每条消息对应的 Agent 执行状态 */
  type AgentStatusEntry = {
    agentId: string
    agentName: string
    agentAvatar: string
    status: 'queued' | 'thinking' | 'replying' | 'done'
  }
  const messageStatus = ref<Map<string, AgentStatusEntry[]>>(new Map())

  /** Agent token 消耗统计: agentId → AgentTokenStats */
  const agentTokenStats = ref<Map<string, AgentTokenStats>>(new Map())

  /** 上下文窗口 token 用量（驱动 handoff 的真实数字）: agentId → contextTokens */
  const contextTokens = ref<Map<string, number>>(new Map())

  // ─── Computed ──────────────────────────────

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  )

  const activeMessages = computed(() =>
    messages.value.filter((m) => m.sessionId === activeSessionId.value)
  )

  const agentStateList = computed(() => {
    const list: AgentRuntimeState[] = []
    agentStates.value.forEach((v) => list.push(v))
    return list
  })

  /** 根据 agentId 查找 Agent 名字和头像 */
  function agentInfo(agentId: string | null): { name: string; avatar: string } | null {
    if (!agentId) return null
    const agent = agents.value.find((a) => a.id === agentId)
    return agent ? { name: agent.name, avatar: agent.avatar } : null
  }

  // ─── API Actions ───────────────────────────

  /** 先轮询健康检查，服务器就绪后再拉数据（最长等 30s） */
  async function fetchData(): Promise<void> {
    if (loading.value) return // 防止重复调用
    loading.value = true
    waitingForServer.value = true
    dataError.value = ''

    // 阶段 1：等待服务器启动（轮询 /api/health，500ms 间隔，最长 30s）
    // 测试环境跳过（无真实后端）
    const isTest = import.meta.env?.MODE === 'test'
    if (typeof fetch === 'function' && !isTest) {
      const maxWait = 30_000
      const interval = 500
      const startedAt = Date.now()

      while (Date.now() - startedAt < maxWait) {
        try {
          const res = await fetch('/api/health', { signal: AbortSignal.timeout(2000) })
          if (res.ok) break // 服务器就绪
        } catch {
          // 还没就绪，继续等
        }
        await new Promise((r) => setTimeout(r, interval))
      }
    }

    waitingForServer.value = false

    // 阶段 2：加载数据
    try {
      const [agentList, sessionList] = await Promise.all([api.getAgents(), api.getSessions()])
      agents.value = agentList
      sessions.value = sessionList
      // 拉取各 Agent 的 token 统计
      fetchAgentStats()
      // Populate unread counts from server response
      const counts = new Map<string, number>()
      for (const s of sessionList) {
        if (s.unreadCount && s.unreadCount > 0) {
          counts.set(s.id, s.unreadCount)
        }
      }
      unreadCounts.value = counts
      dataReady.value = true
      dataError.value = ''

      // 自动选中第一个 Session
      if (!activeSessionId.value && sessionList.length > 0) {
        joinSession(sessionList[0].id)
      }
    } catch (err: any) {
      log.error('fetchData failed', { error: friendlyError(err) })
      dataError.value = friendlyError(err)
    } finally {
      loading.value = false
    }
  }

  // ─── Socket Actions ────────────────────────

  /** 加入一个 Session */
  function joinSession(sessionId: string): void {
    const { socket } = useSocket()
    const switching = activeSessionId.value !== null && activeSessionId.value !== sessionId
    // 离开旧会话的 Socket.IO room，停止接收旧会话的实时事件
    if (activeSessionId.value && switching) {
      socket.emit(Events.LEAVE_SESSION, activeSessionId.value)
    }
    activeSessionId.value = sessionId
    messages.value = []
    loadingMessages.value = true // 等待 SESSION_HISTORY 到达
    // 清除旧会话的打字气泡（切换会话时状态应完全重置）
    typingStates.value.clear()
    // 清除旧会话的上下文窗口 token 数据（不同会话的 Agent 上下文不同）
    contextTokens.value.clear()
    // 标记已读（清除未读计数 + 通知服务端）
    unreadCounts.value.delete(sessionId)
    api.markSessionRead(sessionId).catch(() => {
      /* fire-and-forget */
    })
    // 同步广播模式
    const session = sessions.value.find((s) => s.id === sessionId)
    broadcastMode.value = session?.broadcastMode ?? false
    socket.emit(Events.JOIN_SESSION, sessionId)
    socket.emit('get-agent-states')

    // 欢迎消息由服务端通过 SESSION_HISTORY 事件统一发送（含历史消息批量加载）
    // 不再在客户端生成，避免与历史消息渲染不同步
  }

  /** 发送用户消息 */
  function sendMessage(content: string, mentions: string[] = []): void {
    if (!activeSessionId.value) return
    const { socket } = useSocket()
    socket.emit(Events.SEND_MESSAGE, {
      sessionId: activeSessionId.value,
      content,
      mentions,
    })
  }

  /** 更新 Agent 配置 */
  async function updateAgent(
    id: string,
    data: Parameters<typeof api.updateAgent>[1]
  ): Promise<void> {
    const updated = await api.updateAgent(id, data)
    const idx = agents.value.findIndex((a) => a.id === id)
    if (idx >= 0) agents.value[idx] = updated
  }

  /** 撤回最新一条用户消息（终止任务、还原改动） */
  async function retractMessage(sessionId: string, messageId: string): Promise<void> {
    const { socket } = useSocket()
    socket.emit(Events.MESSAGE_RETRACT, { sessionId, messageId })
  }

  /** 清空会话消息（保留会话配置） */
  async function clearSessionMessages(id: string): Promise<void> {
    try {
      await api.clearSessionMessages(id)
    } catch (err) {
      log.error('clearSessionMessages API failed', { error: String(err) })
      throw err
    }
    // 如果清空的是当前活跃会话，清空本地消息
    if (activeSessionId.value === id) {
      messages.value = []
    }
  }

  /** 删除会话 */
  async function deleteSession(id: string): Promise<void> {
    try {
      await api.deleteSession(id)
    } catch (err) {
      log.error('deleteSession API failed', { error: String(err) })
      throw err
    }
    sessions.value = sessions.value.filter((s) => s.id !== id)
    // 如果删除的是当前活跃会话，切换到第一个可用会话
    if (activeSessionId.value === id) {
      const next = sessions.value[0]
      if (next) {
        joinSession(next.id)
      } else {
        activeSessionId.value = null
        messages.value = []
      }
    }
  }

  /** 删除 Agent */
  async function deleteAgent(id: string): Promise<void> {
    await api.deleteAgent(id)
    agents.value = agents.value.filter((a) => a.id !== id)
  }

  /** 切换广播模式 */
  function toggleBroadcast(): void {
    if (!activeSessionId.value) return
    broadcastMode.value = !broadcastMode.value
    const { socket } = useSocket()
    socket.emit(Events.TOGGLE_BROADCAST, {
      sessionId: activeSessionId.value,
      broadcastMode: broadcastMode.value,
    })
  }

  /** 拉取所有 Agent 的 token 统计 */
  async function fetchAgentStats(): Promise<void> {
    if (agents.value.length === 0) return
    const sessionId = activeSessionId.value
    const map = new Map<string, AgentTokenStats>()
    await Promise.all(
      agents.value.map(async (a) => {
        try {
          const stats = await api.getAgentStats(a.id, sessionId || undefined)
          map.set(a.id, stats)
        } catch {
          // 静默失败，token 统计不影响核心功能
        }
      })
    )
    if (map.size > 0) {
      agentTokenStats.value = map
    }
  }

  /** 创建新会话（通过 REST API） */
  async function createSession(title: string, agentIds: string[]): Promise<void> {
    const session = await api.createSession({ title, agentIds })
    sessions.value.unshift(session)
    joinSession(session.id)
  }

  // ─── Socket event handlers ─────────────────

  function bindEvents(): void {
    const { socket } = useSocket()

    // 跟踪连接状态
    socket.on('connect', () => {
      serverOnline.value = true
      // 重连后重新加入 Session，获取最新消息
      if (activeSessionId.value) {
        socket.emit(Events.JOIN_SESSION, activeSessionId.value)
        socket.emit('get-agent-states')
      }
    })
    socket.on('disconnect', () => {
      serverOnline.value = false
    })

    // 服务端错误通知 → toast 提示
    socket.on(Events.ERROR, (data: { message: string }) => {
      showError(data.message)
    })

    // 初始状态
    serverOnline.value = socket.connected

    socket.on(Events.NEW_MESSAGE, (msg: Message) => {
      // 防止重复消息
      if (messages.value.some((m) => m.id === msg.id)) return
      // S6: 非活跃会话的消息不存入数组（避免内存泄漏）——
      // 仅递增未读计数。用户切回该会话时 SESSION_HISTORY 会重新加载。
      if (msg.sessionId !== activeSessionId.value) {
        const current = unreadCounts.value.get(msg.sessionId) || 0
        unreadCounts.value.set(msg.sessionId, current + 1)
        // Agent 完成回复后也刷新 token 统计（影响会话列表的 token 用量显示）
        if (msg.role === 'agent' && msg.agentId) {
          fetchAgentStats()
        }
        return
      }
      messages.value.push(msg)
      // Agent 完成回复后清除打字状态 + 刷新 token 统计
      if (msg.role === 'agent' && msg.agentId) {
        typingStates.value.delete(msg.agentId)
        fetchAgentStats()
      }
    })

    // 批量历史消息加载（服务端 JOIN_SESSION 响应）
    // 一次性替换 messages 数组，避免逐条 NEW_MESSAGE 导致的多次渲染和闪烁
    socket.on(Events.SESSION_HISTORY, (data: { messages: Message[]; welcome: Message }) => {
      const all: Message[] = []
      if (data.welcome) {
        all.push(data.welcome)
      }
      // 如果是 handoff 续接的会话，在历史消息前插入摘要
      if (pendingHandoffSummary.value) {
        all.push({
          id: `handoff-${Date.now()}`,
          sessionId: activeSessionId.value!,
          role: 'system',
          content: `📋 对话已续接。以下是此前的对话摘要：\n\n${pendingHandoffSummary.value}`,
          agentId: null,
          mentions: [],
          createdAt: new Date().toISOString(),
        })
        pendingHandoffSummary.value = null
      }
      all.push(...data.messages)
      messages.value = all
      loadingMessages.value = false
    })

    // Agent 回复中的 @mentions 在消息发送后才解析，通过此事件补发
    socket.on(Events.MESSAGE_UPDATED, (data: { messageId: string; mentions: string[] }) => {
      const msg = messages.value.find((m) => m.id === data.messageId)
      if (msg) {
        msg.mentions = data.mentions
      }
    })

    socket.on(
      Events.AGENT_TYPING,
      (data: { agentId: string; messageId: string; content: string }) => {
        typingStates.value.set(data.agentId, data)
      }
    )

    socket.on(Events.AGENT_STATUS, (state: AgentRuntimeState) => {
      agentStates.value.set(state.agentId, state)
      // Agent 空闲时清除打字状态（处理超时/中止等未发 NEW_MESSAGE 的情况）
      if (state.status === 'idle') {
        typingStates.value.delete(state.agentId)
      }
    })

    socket.on('all-agent-states', (states: AgentRuntimeState[]) => {
      const map = new Map<string, AgentRuntimeState>()
      states.forEach((s) => map.set(s.agentId, s))
      agentStates.value = map
    })

    // 上下文窗口 token 用量（每次 Agent 回复后推送，驱动 handoff 的真实数字）
    socket.on(
      Events.CONTEXT_WINDOW_STATS,
      (data: { agentId: string; contextTokens: number; maxContextTokens: number }) => {
        contextTokens.value.set(data.agentId, data.contextTokens)
        // 同步更新 token 统计里的 maxContextTokens（该值一般不变，但首次拿到时可能未设置）
        const existing = agentTokenStats.value.get(data.agentId)
        if (existing) {
          existing.maxContextTokens = data.maxContextTokens
        }
      }
    )

    socket.on(Events.SESSION_UPDATE, (session: SessionConfig) => {
      const idx = sessions.value.findIndex((s) => s.id === session.id)
      if (idx >= 0) {
        sessions.value[idx] = session
      } else {
        sessions.value.push(session)
      }
    })

    socket.on(
      Events.BROADCAST_MODE_CHANGED,
      (data: { sessionId: string; broadcastMode: boolean }) => {
        // 同步 sessions 数组中的广播模式（joinSession 会从这里读取）
        const idx = sessions.value.findIndex((s) => s.id === data.sessionId)
        if (idx >= 0) {
          sessions.value[idx] = { ...sessions.value[idx], broadcastMode: data.broadcastMode }
        }
        // 只有当前活跃会话才更新 UI 状态
        if (data.sessionId === activeSessionId.value) {
          broadcastMode.value = data.broadcastMode
          // 系统消息提示广播模式变更
          messages.value.push({
            id: `broadcast-${Date.now()}`,
            sessionId: data.sessionId,
            role: 'system',
            content: data.broadcastMode
              ? '📢 广播模式已开启 — Agent 可以看到其他 Agent 的回复'
              : '🔇 广播模式已关闭 — Agent 只能看到自己的回复和被 @ 的消息',
            agentId: null,
            mentions: [],
            createdAt: new Date().toISOString(),
          } as any)
        }
      }
    )

    socket.on(Events.SESSION_DELETED, (data: { sessionId: string }) => {
      sessions.value = sessions.value.filter((s) => s.id !== data.sessionId)
      // S9: 清理已删除会话的未读计数，避免 Map 内存泄漏
      unreadCounts.value.delete(data.sessionId)
      if (activeSessionId.value === data.sessionId) {
        const next = sessions.value[0]
        if (next) {
          joinSession(next.id)
        } else {
          activeSessionId.value = null
          messages.value = []
        }
      }
    })

    socket.on(Events.SESSION_MESSAGES_CLEARED, (data: { sessionId: string }) => {
      if (activeSessionId.value === data.sessionId) {
        messages.value = []
      }
    })

    socket.on(
      Events.MESSAGE_AGENT_STATUS,
      (data: {
        messageId: string
        agentId: string
        agentName: string
        agentAvatar: string
        status: 'queued' | 'thinking' | 'replying' | 'done'
      }) => {
        const current = messageStatus.value.get(data.messageId) || []
        const idx = current.findIndex((e) => e.agentId === data.agentId)
        if (idx >= 0) {
          current[idx] = data
        } else {
          current.push(data)
        }
        messageStatus.value = new Map(messageStatus.value.set(data.messageId, current))
      }
    )

    socket.on(
      Events.MESSAGE_RETRACTED,
      (data: { sessionId: string; messageId: string; agentReplyIds: string[] }) => {
        // 从本地消息列表移除被撤回的消息和所有关联的 agent 回复
        const idsToRemove = new Set([data.messageId, ...data.agentReplyIds])
        messages.value = messages.value.filter((m) => !idsToRemove.has(m.id))
        messageStatus.value.delete(data.messageId)
      }
    )

    socket.on(Events.QUEUE_UPDATE, (data: { agentId: string; queueLength: number }) => {
      const state = agentStates.value.get(data.agentId)
      if (state) {
        state.queueLength = data.queueLength
      }
    })

    // 会话交接：前端收到后无缝切换到新会话
    socket.on(
      Events.SESSION_HANDOFF,
      (data: { oldSessionId: string; newSessionId: string; summary: string }) => {
        // S8: 防止重入——两次 SESSION_HANDOFF 先后到达会相互覆盖
        if (handoffJoining) {
          console.warn('[store] handoff already in progress, skipping duplicate')
          return
        }
        handoffJoining = true

        // 在异步操作前保存摘要——SESSION_HISTORY 到达时会自动注入
        pendingHandoffSummary.value = data.summary

        // 异步拉取新会话的完整信息并加入列表
        api
          .getSession(data.newSessionId)
          .then((newSession) => {
            // 添加到会话列表
            const exists = sessions.value.some((s) => s.id === newSession.id)
            if (!exists) {
              sessions.value.unshift(newSession)
            }
            // 自动切换到新会话（joinSession emit JOIN_SESSION → SESSION_HISTORY 注入摘要）
            if (activeSessionId.value === data.oldSessionId) {
              joinSession(newSession.id)
            }
          })
          .catch((err) => {
            console.warn('[store] failed to load handoff session', err)
          })
          .finally(() => {
            handoffJoining = false
          })
      }
    )
  }

  // 初始化时绑定
  bindEvents()

  return {
    sessions,
    activeSessionId,
    messages,
    agentStates,
    agents,
    typingStates,
    unreadCounts,
    loading,
    waitingForServer,
    dataReady,
    dataError,
    serverOnline,
    errorMessage,
    showError,
    dismissError,
    loadingMessages,
    broadcastMode,
    activeSession,
    activeMessages,
    agentStateList,
    agentInfo,
    fetchData,
    joinSession,
    sendMessage,
    createSession,
    toggleBroadcast,
    updateAgent,
    deleteAgent,
    deleteSession,
    clearSessionMessages,
    retractMessage,
    fetchAgentStats,
    agentTokenStats,
    contextTokens,
    messageStatus,
  }
})

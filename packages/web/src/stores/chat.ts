import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Events } from '@cat-study/shared'
import type { Message, AgentRuntimeState, SessionConfig, AgentConfig } from '@cat-study/shared'
import { useSocket } from '@/composables/useSocket'
import { api } from '@/composables/useApi'

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
  const loading = ref(false)
  const waitingForServer = ref(false)   // 等待服务器启动（health check 轮询中）
  const dataReady = ref(false)          // 首次数据加载完成后为 true
  const dataError = ref('')             // 加载失败时的错误信息
  const broadcastMode = ref(false)
  const serverOnline = ref(false)       // Socket.IO 是否已连接

  /** 每条消息对应的 Agent 执行状态 */
  type AgentStatusEntry = {
    agentId: string
    agentName: string
    agentAvatar: string
    status: 'queued' | 'thinking' | 'replying' | 'done'
  }
  const messageStatus = ref<Map<string, AgentStatusEntry[]>>(new Map())

  // ─── Computed ──────────────────────────────

  const activeSession = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value) ?? null
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
      const [agentList, sessionList] = await Promise.all([
        api.getAgents(),
        api.getSessions(),
      ])
      agents.value = agentList
      sessions.value = sessionList
      dataReady.value = true
      dataError.value = ''

      // 自动选中第一个 Session
      if (!activeSessionId.value && sessionList.length > 0) {
        joinSession(sessionList[0].id)
      }
    } catch (err: any) {
      console.error('[store] fetchData failed:', err)
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
    activeSessionId.value = sessionId
    messages.value = []
    // 同步广播模式
    const session = sessions.value.find((s) => s.id === sessionId)
    broadcastMode.value = session?.broadcastMode ?? false
    socket.emit(Events.JOIN_SESSION, sessionId)
    socket.emit('get-agent-states')

    // 首次加入或切换会话时，显示引导消息
    if (!switching && session) {
      const catNames = session.agentIds
        .map((id) => agents.value.find((a) => a.id === id))
        .filter(Boolean)
        .map((a) => `@${a!.name}`)
        .join('、')
      messages.value.push({
        id: `welcome-${sessionId}`,
        sessionId,
        role: 'system',
        content: catNames
          ? `👋 欢迎！在消息中使用 ${catNames} 来指定谁来回复。也可以直接发送消息广播给所有猫咪。`
          : '👋 欢迎！在消息中使用 @猫咪名字 来指定谁来回复。',
        agentId: null,
        mentions: [],
        createdAt: Date.now(),
      } as any)
    }
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
  async function updateAgent(id: string, data: Parameters<typeof api.updateAgent>[1]): Promise<void> {
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
      console.error('[store] clearSessionMessages API failed:', err)
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
      console.error('[store] deleteSession API failed:', err)
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
      // 重连后刷新数据
      if (activeSessionId.value) {
        socket.emit(Events.JOIN_SESSION, activeSessionId.value)
        socket.emit('get-agent-states')
      }
    })
    socket.on('disconnect', () => {
      serverOnline.value = false
    })
    // 初始状态
    serverOnline.value = socket.connected

    socket.on(Events.NEW_MESSAGE, (msg: Message) => {
      messages.value.push(msg)
      // Agent 完成回复后清除打字状态，停止闪烁光标
      if (msg.role === 'agent' && msg.agentId) {
        typingStates.value.delete(msg.agentId)
      }
    })

    socket.on(Events.AGENT_TYPING, (data: { agentId: string; messageId: string; content: string }) => {
      typingStates.value.set(data.agentId, data)
    })

    socket.on(Events.AGENT_STATUS, (state: AgentRuntimeState) => {
      agentStates.value.set(state.agentId, state)
      // Agent 空闲时清除打字状态（处理超时/中止等未发 NEW_MESSAGE 的情况）
      if (state.slotState === 'idle') {
        typingStates.value.delete(state.agentId)
      }
    })

    socket.on('all-agent-states', (states: AgentRuntimeState[]) => {
      const map = new Map<string, AgentRuntimeState>()
      states.forEach((s) => map.set(s.agentId, s))
      agentStates.value = map
    })

    socket.on(Events.SESSION_UPDATE, (session: SessionConfig) => {
      const idx = sessions.value.findIndex((s) => s.id === session.id)
      if (idx >= 0) {
        sessions.value[idx] = session
      } else {
        sessions.value.push(session)
      }
    })

    socket.on(Events.BROADCAST_MODE_CHANGED, (data: { sessionId: string; broadcastMode: boolean }) => {
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
        createdAt: Date.now(),
      } as any)
    })

    socket.on(Events.SESSION_DELETED, (data: { sessionId: string }) => {
      sessions.value = sessions.value.filter((s) => s.id !== data.sessionId)
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

    socket.on(Events.MESSAGE_AGENT_STATUS, (data: {
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
    })

    socket.on(Events.MESSAGE_RETRACTED, (data: { sessionId: string; messageId: string; agentReplyIds: string[] }) => {
      // 从本地消息列表移除被撤回的消息和所有关联的 agent 回复
      const idsToRemove = new Set([data.messageId, ...data.agentReplyIds])
      messages.value = messages.value.filter((m) => !idsToRemove.has(m.id))
      messageStatus.value.delete(data.messageId)
    })

    socket.on(Events.QUEUE_UPDATE, (data: { agentId: string; queueLength: number }) => {
      const state = agentStates.value.get(data.agentId)
      if (state) {
        state.queueLength = data.queueLength
      }
    })
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
    loading,
    waitingForServer,
    dataReady,
    dataError,
    serverOnline,
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
    messageStatus,
  }
})

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Events } from '@cat-study/shared'
import type { Message, AgentRuntimeState, SessionConfig, AgentConfig } from '@cat-study/shared'
import { useSocket } from '@/composables/useSocket'
import { api } from '@/composables/useApi'

export const useChatStore = defineStore('chat', () => {
  // ─── State ────────────────────────────────

  const sessions = ref<SessionConfig[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<Message[]>([])
  const agentStates = ref<Map<string, AgentRuntimeState>>(new Map())
  const agents = ref<AgentConfig[]>([])
  const typingStates = ref<Map<string, { messageId: string; content: string }>>(new Map())
  const loading = ref(false)
  const dataReady = ref(false)   // 首次数据加载完成后为 true
  const dataError = ref('')      // 加载失败时的错误信息
  const broadcastMode = ref(false)

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

  /** 从后端加载 Agent 和 Session 列表（带重试，应对 server 启动慢于 Vite 的场景） */
  async function fetchData(retries = 3): Promise<void> {
    loading.value = true
    dataError.value = ''

    try {
      for (let attempt = 0; attempt < retries; attempt++) {
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
          return // 成功，退出
        } catch (err: any) {
          console.error(`[store] fetchData attempt ${attempt + 1}/${retries} failed:`, err.message)
          if (attempt < retries - 1) {
            // 等待后重试（指数退避：1s, 2s, 4s）
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
          } else {
            dataError.value = err.message || '无法连接服务器'
            console.error('[store] fetchData exhausted retries:', err)
          }
        }
      }
    } finally {
      loading.value = false
    }
  }

  // ─── Socket Actions ────────────────────────

  /** 加入一个 Session */
  function joinSession(sessionId: string): void {
    const { socket } = useSocket()
    activeSessionId.value = sessionId
    messages.value = []
    // 同步广播模式
    const session = sessions.value.find((s) => s.id === sessionId)
    broadcastMode.value = session?.broadcastMode ?? false
    socket.emit(Events.JOIN_SESSION, sessionId)
    socket.emit('get-agent-states')
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

    socket.on(Events.NEW_MESSAGE, (msg: Message) => {
      messages.value.push(msg)
    })

    socket.on(Events.AGENT_TYPING, (data: { agentId: string; messageId: string; content: string }) => {
      typingStates.value.set(data.agentId, data)
    })

    socket.on(Events.AGENT_STATUS, (state: AgentRuntimeState) => {
      agentStates.value.set(state.agentId, state)
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
    dataReady,
    dataError,
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
  }
})

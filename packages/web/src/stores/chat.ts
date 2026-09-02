import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Events } from '@cat-study/shared'
import type {
  Message,
  AgentRuntimeState,
  SessionConfig,
  AgentConfig,
  AgentTokenStats,
  SendMessageAck,
  StreamSegment,
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

/** localStorage key：记住上次选中的会话（刷新恢复用） */
const ACTIVE_SESSION_KEY = 'catstudy.activeSessionId'

/** 安全读上次选中会话 id（SSR/test 环境容错，失败返回 null） */
function readActiveSessionId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY)
  } catch {
    return null
  }
}

/** 安全写上次选中会话 id（id=null 时清除，用于删除当前活跃会话后清理） */
function writeActiveSessionId(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id === null) {
      localStorage.removeItem(ACTIVE_SESSION_KEY)
    } else {
      localStorage.setItem(ACTIVE_SESSION_KEY, id)
    }
  } catch {
    // 静默失败：localStorage 不可用不影响核心功能
  }
}

export const useChatStore = defineStore('chat', () => {
  // ─── State ────────────────────────────────

  const sessions = ref<SessionConfig[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<Message[]>([])
  const agentStates = ref<Map<string, Map<string, AgentRuntimeState>>>(new Map())
  const agents = ref<AgentConfig[]>([])
  const typingStates = ref<
    Map<string, {
      messageId: string
      content: string
      sessionId: string
      segments?: StreamSegment[]
    }>
  >(new Map())
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
  /**
   * 消息本地缓存：sessionId → 消息数组。切走时存当前数组引用，切回命中则立即渲染（不亮 skeleton）；
   * SESSION_HISTORY 到达后做权威全量校正（补切走期间非活跃会话的增量）。引用语义安全：
   * 切走存的是旧数组引用，之后 messages.value 被重新赋值成新数组，不会原地改旧引用——无需深拷贝。
   */
  const sessionMessages = new Map<string, Message[]>()
  /** 重启请求按钮状态（messageId → pending/confirmed/none；none=隐藏按钮） */
  const restartStates = ref<Map<string, 'pending' | 'confirmed' | 'none'>>(new Map())
  /** 确认重启进行中（点击瞬间置位，ack / RESTART_STATUS / ERROR 到达后清除） */
  const confirmingRestartMessageId = ref<string | null>(null)
  const pendingHandoffSummary = ref<string | null>(null) // handoff 摘要，等待 SESSION_HISTORY 到达后注入
  let handoffJoining = false // S8: 防止 handoff 重入（两次 SESSION_HANDOFF 先后到达时相互覆盖）
  /** 交接失败横幅数据（HANDOFF_FAILED 事件——摘要生成失败可见化；仅当前会话生效，收到新消息/切会话/手动关闭清除） */
  const handoffFailed = ref<{ sessionId: string; reason: string } | null>(null)

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

  /** 手动关闭交接失败横幅 */
  function dismissHandoffFailed(): void {
    handoffFailed.value = null
  }

  /** 每条消息对应的 Agent 执行状态 */
  type AgentStatusEntry = {
    agentId: string
    agentName: string
    agentAvatar: string
    status: 'queued' | 'thinking' | 'replying' | 'done'
    /** 回复开始时间戳（epoch ms）——服务端心跳注入，前端据此显示「回复中 · 已 N 秒」 */
    startedAt?: number
    /** 最后一次收到 replying 心跳的客户端接收时间戳（epoch ms）——心跳失联超阈值显示「无响应」 */
    lastBeatAt?: number
  }
  const messageStatus = ref<Map<string, AgentStatusEntry[]>>(new Map())

  // ─── Message lifecycle (C5) ─────────────────
  // 用户消息发送生命周期：store 独占状态机，key=server 生成的 messageId（ack 回传后进入）。
  // 客户端只消费不生成 id（安全性第一）；瞬态不占 Message。终态保留供只读查询，
  // 单会话消息量有限无清理压力。
  type MessageLifecycle = 'sending' | 'received' | 'agent-processing' | 'replied' | 'failed'
  const lifecycles = new Map<string, MessageLifecycle>()
  /** 发送管线信号（sending=等待 ack/回显；ok/failed=终态）——ChatPanel 据此复位发送按钮。
   *   sending/failed 两态无 server messageId 可 key（发送时尚未落库），不进 lifecycles Map */
  const sendStatus = ref<'idle' | 'sending' | 'ok' | 'failed'>('idle')
  function setLifecycle(messageId: string, lc: MessageLifecycle): void {
    lifecycles.set(messageId, lc)
  }
  /** 只读访问器：查询消息当前生命周期（非本客户端发送/无 ack 回传 → undefined） */
  function getLifecycle(messageId: string): MessageLifecycle | undefined {
    return lifecycles.get(messageId)
  }

  /** Agent token 消耗统计: agentId → AgentTokenStats */
  const agentTokenStats = ref<Map<string, AgentTokenStats>>(new Map())

  /** 上下文窗口 token 用量（驱动 handoff 的真实数字）: agentId → contextTokens */
  const contextTokens = ref<Map<string, number>>(new Map())

  /** context 阈值配置（80% 告警 / 90% 交接——服务端权威 context-config.json，失败回退默认 0.8/0.9） */
  const contextConfig = ref({
    warnThreshold: 0.8,
    handoffThreshold: 0.9,
    maxContextTokens: 128000,
  })

  // ─── Computed ──────────────────────────────

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  )

  const activeMessages = computed(() =>
    messages.value.filter((m) => m.sessionId === activeSessionId.value)
  )

  /** 纯存：镜像 server slots——agentId → (sessionId ?? '') → AgentRuntimeState。
   *  哨兵桶用 '' 键存 sessionId 为 null/空 的状态（无 session 维度的全局态）。 */
  function storeAgentState(state: AgentRuntimeState): void {
    const key = state.sessionId ?? ''
    const bySession = agentStates.value.get(state.agentId)
    if (bySession) {
      bySession.set(key, state)
    } else {
      agentStates.value.set(state.agentId, new Map([[key, state]]))
    }
  }

  /** 唯一查询 helper：当前会话状态优先，回退哨兵桶（sessionId 空/无 → ''）。
   *  把「忙闲」收敛到 (agent, session) 语义单位——A 会话忙 ≠ B 会话忙。 */
  function currentStateFor(agentId: string): AgentRuntimeState | undefined {
    const bySession = agentStates.value.get(agentId)
    if (!bySession) return undefined
    return bySession.get(activeSessionId.value ?? '') ?? bySession.get('')
  }

  const agentStateList = computed(() => {
    const list: AgentRuntimeState[] = []
    for (const agentId of agentStates.value.keys()) {
      const state = currentStateFor(agentId)
      if (state) list.push(state)
    }
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
  async function fetchData(force = false): Promise<void> {
    if (loading.value) return // 防止重复调用
    if (dataReady.value && !force) return // 数据已就绪，除非 force 强制刷新（编辑/创建后重拉、手动重试必须 force）
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
      // 拉取各 Agent 的 token 统计 + context 阈值配置
      fetchAgentStats()
      fetchContextConfig()
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

      // 自动选中会话：优先恢复上次选中的（localStorage），不在列表则回退第一个
      if (!activeSessionId.value && sessionList.length > 0) {
        const lastActive = readActiveSessionId()
        const sessionIds = new Set(sessionList.map((s) => s.id))
        const target = lastActive && sessionIds.has(lastActive) ? lastActive : sessionList[0].id
        joinSession(target)
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
    // 切走前把当前消息存入缓存（存数组引用，后续 messages.value 重新赋值不会改旧引用）
    if (switching) {
      sessionMessages.set(activeSessionId.value!, messages.value)
    }
    activeSessionId.value = sessionId
    writeActiveSessionId(sessionId) // 记住本次选中会话（刷新恢复用）
    handoffFailed.value = null // 切会话清除旧会话的交接失败横幅
    const cached = sessionMessages.get(sessionId)
    if (cached) {
      // 命中缓存：立即渲染、不亮 skeleton；SESSION_HISTORY 仍会回来做权威全量校正
      messages.value = cached
      loadingMessages.value = false
    } else {
      messages.value = []
      loadingMessages.value = true // 等待 SESSION_HISTORY 到达
    }
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

  /** 发送用户消息（images: base64 dataURL 数组，用于视觉模型识别） */
  function sendMessage(content: string, mentions: string[] = [], images: string[] = []): void {
    if (!activeSessionId.value) return
    const { socket } = useSocket()
    sendStatus.value = 'sending'
    // ack 超时兜底：旧 server 不回调 ack / 连接静默断 → 10s 后置 failed + 报错。根治
    // fire-and-forget 静默失败（此前靠 ChatPanel 的 activeMessages watch + 10s timeout 兜底，
    // C5 收进 store 独占——ChatPanel 只消费 sendStatus 复位按钮）。
    let settled = false
    const ackTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      sendStatus.value = 'failed'
      showError('服务器无响应，请检查后端是否已启动')
    }, 10000)
    socket.emit(
      Events.SEND_MESSAGE,
      {
        sessionId: activeSessionId.value,
        content,
        mentions,
        ...(images.length > 0 ? { images } : {}),
      },
      (res: SendMessageAck | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(ackTimeout)
        if (!res) {
          // 旧 server 不回调 ack（fire-and-forget）：无法确认结果，按失败处理
          sendStatus.value = 'failed'
          return
        }
        if (res.ok) {
          setLifecycle(res.messageId, 'received')
          sendStatus.value = 'ok'
        } else {
          // ok:false 无 messageId（消息未落库）——lifecycle 无 key 可记，仅失败信号 + 报错
          sendStatus.value = 'failed'
          showError(res.error)
        }
      }
    )
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

  /**
   * 确认重启（dev.js 轮询 .restart-request 执行）。
   * 点击瞬间置位 confirming 状态（按钮变「已确认，等待重启…」，无需等服务端即有反馈）；
   * 服务端 ack 回传结果：成功由既有 RESTART_STATUS confirmed 驱动「重启中…」，
   * 失效/过期 → toast 明示 + 恢复可点。ack 缺失（旧 server）时由 RESTART_STATUS/ERROR 既有事件流兜底。
   */
  function confirmRestart(messageId: string): void {
    const { socket } = useSocket()
    confirmingRestartMessageId.value = messageId
    socket.emit(
      Events.RESTART_CONFIRM,
      { messageId },
      (ack: { ok: boolean; reason?: string } | undefined) => {
        if (confirmingRestartMessageId.value === messageId) confirmingRestartMessageId.value = null
        if (!ack || ack.ok) return // 成功（或旧 server 无 ack 回调）→ 既有事件流驱动
        showError(
          ack.reason === 'expired'
            ? '重启请求已过期（10 分钟有效），请店长重新发起'
            : '重启请求已失效，请店长重新发起'
        )
      }
    )
  }

  /** 取消重启 */
  function cancelRestart(messageId: string): void {
    const { socket } = useSocket()
    socket.emit(Events.RESTART_CANCEL, { messageId })
  }

  /** 停止 Agent：中断当前思考 + 清空排队任务（无需等回复，可重新发消息恢复）。
   *  OQ3 双端 session 化：带 sessionId 精确中断该会话（并发双会话只停目标）；
   *  缺省旧客户端兼容（服务端 fallback 中断该 agent 全部） */
  function interruptAgent(agentId: string, sessionId?: string): void {
    const { socket } = useSocket()
    socket.emit(Events.AGENT_INTERRUPT, { agentId, sessionId })
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
        writeActiveSessionId(null) // 无可用会话 → 清除记忆，防刷新回已删会话
      }
    }
    // 防删会话后缓存残留（Map 无界增长）——必须在 joinSession 之后删：
    // 活跃会话删除路径上 joinSession 的切走缓存会把被删会话的数组重新塞回 Map，
    // 若在 joinSession 之前删会被立即撤销（吐槽猫 review 发现的孤儿条目内存泄漏）
    sessionMessages.delete(id)
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

  /** 拉取 context 阈值配置（GET /api/config/context，失败静默回退默认 0.8/0.9——UI 不崩） */
  async function fetchContextConfig(): Promise<void> {
    try {
      contextConfig.value = await api.getContextConfig()
    } catch {
      // 静默失败：横幅/色阶回退默认阈值
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

    // 服务端错误通知 → toast 提示（同时解除确认中状态——ack 丢失时 ERROR 是兜底信号）
    socket.on(Events.ERROR, (data: { message: string }) => {
      confirmingRestartMessageId.value = null
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
      // 交接失败横幅：收到新消息即清除（失败提示不常驻，与告警横幅一致的不脱流处理）
      handoffFailed.value = null
      // 重启请求消息：初始按钮状态 pending（服务端 RESTART_STATUS 后续校正）
      if (msg.messageType === 'restart_request') {
        restartStates.value.set(msg.id, 'pending')
      }
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
      // 权威全量校正后更新缓存（补切走期间非活跃会话的增量，防缓存陈旧）
      sessionMessages.set(activeSessionId.value!, all)
      // 重启请求消息：历史恢复初始 pending（JOIN 后服务端 RESTART_STATUS 校正）
      for (const m of data.messages) {
        if (m.messageType === 'restart_request') {
          restartStates.value.set(m.id, 'pending')
        }
      }
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
      (data: {
        agentId: string
        messageId: string
        content: string
        sessionId: string
        segments?: StreamSegment[]
      }) => {
        if (data.sessionId !== activeSessionId.value) return
        typingStates.value.set(data.agentId, data)
      }
    )

    socket.on(Events.AGENT_STATUS, (state: AgentRuntimeState) => {
      storeAgentState(state)
      // Agent 空闲时清除打字状态（处理超时/中止等未发 NEW_MESSAGE 的情况）
      if (state.status === 'idle') {
        typingStates.value.delete(state.agentId)
      }
    })

    socket.on('all-agent-states', (states: AgentRuntimeState[]) => {
      agentStates.value = new Map()
      states.forEach(storeAgentState)
    })

    // 上下文窗口 token 用量（每次 Agent 回复后推送，驱动 handoff 的真实数字）
    socket.on(
      Events.CONTEXT_WINDOW_STATS,
      (data: {
        agentId: string
        contextTokens: number
        maxContextTokens: number
        sessionId: string
      }) => {
        if (data.sessionId !== activeSessionId.value) return
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
          writeActiveSessionId(null) // 无可用会话 → 清除记忆，防刷新回已删会话
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
        startedAt?: number
      }) => {
        // C5 lifecycle 推进：replying = agent 开始思考（锚点）；done = agent 回复完成（= replied）。
        // 仅推进本客户端发送的消息（lifecycles 有该 messageId）；非本客户端发送 → undefined 跳过。
        const lc = lifecycles.get(data.messageId)
        if (lc === 'received' || lc === 'agent-processing') {
          if (data.status === 'replying') setLifecycle(data.messageId, 'agent-processing')
          else if (data.status === 'done') setLifecycle(data.messageId, 'replied')
        }
        const current = messageStatus.value.get(data.messageId) || []
        const idx = current.findIndex((e) => e.agentId === data.agentId)
        // replying 心跳：记录客户端接收时间戳（liveness 锚点）。心跳 10s 重发、
        // 本地 1s tick 平滑秒数；超阈值未收到心跳 → ChatPanel 显示「无响应」
        // （本地时钟不能把死进程显示成「还在跑」）。
        const entry: AgentStatusEntry =
          data.status === 'replying' ? { ...data, lastBeatAt: Date.now() } : data
        // 整对象替换：done/queued/thinking 不带 startedAt/lastBeatAt，会抹掉 entry 已有字段——
        // 当前无害（done 是终态、不显示时长、服务端心跳已在 finally 停）；将来 thinking/done
        // 要显示时长时注意此隐式前提（须改字段级合并而非整对象替换）。
        if (idx >= 0) {
          current[idx] = entry
        } else {
          current.push(entry)
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

    // 重启请求状态变化：confirmed → 「重启中…」；pending → 按钮保留（join 恢复的权威状态）；
    // none/cancelled/expired → 隐藏按钮
    socket.on(
      Events.RESTART_STATUS,
      (data: { sessionId: string; messageId: string | null; state: string }) => {
        // 状态到达即解除确认中（服务端权威状态接管按钮显示）
        confirmingRestartMessageId.value = null
        if (data.state === 'confirmed' && data.messageId) {
          restartStates.value.set(data.messageId, 'confirmed')
          return
        }
        // pending → 请求存在但未确认，按钮保持可点（join 广播的当前状态，不能当 none 打掉）
        if (data.state === 'pending' && data.messageId) {
          restartStates.value.set(data.messageId, 'pending')
          return
        }
        // none/cancelled/expired → 隐藏按钮；messageId 为空时按会话复位所有重启消息
        if (data.messageId) {
          restartStates.value.set(data.messageId, 'none')
        } else {
          for (const m of messages.value) {
            if (m.sessionId === data.sessionId && m.messageType === 'restart_request') {
              restartStates.value.set(m.id, 'none')
            }
          }
        }
      }
    )

    // 交接失败：server 端摘要生成失败时 emit（payload { sessionId, reason }）——仅当前会话生效
    // 事件名字面量对齐单 A 契约（shared Events.HANDOFF_FAILED 由单 A 添加，落地后可换常量）
    socket.on('handoff-failed', (data: { sessionId: string; reason: string }) => {
      if (data.sessionId !== activeSessionId.value) return
      handoffFailed.value = { sessionId: data.sessionId, reason: data.reason }
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
    currentStateFor,
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
    restartStates,
    confirmingRestartMessageId,
    confirmRestart,
    cancelRestart,
    interruptAgent,
    fetchAgentStats,
    fetchContextConfig,
    agentTokenStats,
    contextTokens,
    contextConfig,
    messageStatus,
    handoffFailed,
    dismissHandoffFailed,
    sendStatus,
    getLifecycle,
  }
})

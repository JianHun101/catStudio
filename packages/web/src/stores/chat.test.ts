import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { Message, AgentRuntimeState, SessionConfig, AgentConfig } from '@cat-study/shared'
import { Events } from '@cat-study/shared'

// ── Mock socket ──────────────────────────────────

const mockEmit = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()
const mockSocket = { emit: mockEmit, on: mockOn, off: mockOff }

vi.mock('@/composables/useSocket', () => ({
  useSocket: () => ({
    socket: mockSocket,
    connected: { value: true },
  }),
}))

// ── Mock API ─────────────────────────────────────

const mockGetAgents = vi.fn()
const mockGetSessions = vi.fn()
const mockCreateSession = vi.fn()
const mockDeleteSession = vi.fn()
const mockDeleteAgent = vi.fn()
const mockUpdateAgent = vi.fn()
const mockMarkSessionRead = vi.fn().mockResolvedValue({ ok: true })
const mockGetContextConfig = vi.fn()

vi.mock('@/composables/useApi', () => ({
  api: {
    getAgents: mockGetAgents,
    getSessions: mockGetSessions,
    createSession: mockCreateSession,
    deleteSession: mockDeleteSession,
    deleteAgent: mockDeleteAgent,
    updateAgent: mockUpdateAgent,
    markSessionRead: mockMarkSessionRead,
    getContextConfig: mockGetContextConfig,
  },
}))

// ── Mock logger ────────────────────────────────────

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

// ── Test data ────────────────────────────────────

const mockAgent: AgentConfig = {
  id: 'a1',
  name: '店长',
  avatar: '🐱',
  systemPrompt: 'test',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-test',
}

const mockSession: SessionConfig = {
  id: 's1',
  title: '测试会话',
  agentIds: ['a1'],
  broadcastMode: false,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
}

const mockMessage: Message = {
  id: 'm1',
  sessionId: 's1',
  agentId: null,
  role: 'user',
  content: '你好',
  mentions: ['店长'],
  createdAt: '2024-01-01',
}

// ── Tests ────────────────────────────────────────

describe('chatStore', () => {
  let store: ReturnType<typeof import('./chat.js').useChatStore>
  let pushConfirmTimeoutMs = 8000

  beforeEach(async () => {
    vi.clearAllMocks()
    setActivePinia(createPinia())

    // Import store dynamically
    const { useChatStore, PUSH_CONFIRM_TIMEOUT_MS } = await import('./chat.js')
    store = useChatStore()
    pushConfirmTimeoutMs = PUSH_CONFIRM_TIMEOUT_MS
  })

  describe('initial state', () => {
    it('has empty default state', () => {
      expect(store.sessions).toEqual([])
      expect(store.activeSessionId).toBeNull()
      expect(store.messages).toEqual([])
      expect(store.agents).toEqual([])
      expect(store.loading).toBe(false)
      expect(store.broadcastMode).toBe(false)
    })

    it('contextConfig 默认回退 0.8 / 0.9（API 未拉取前 UI 不崩）', () => {
      expect(store.contextConfig).toEqual({
        warnThreshold: 0.8,
        handoffThreshold: 0.9,
        maxContextTokens: 128000,
      })
    })
  })

  describe('fetchContextConfig', () => {
    it('成功 → contextConfig 更新为服务端值', async () => {
      mockGetContextConfig.mockResolvedValue({
        warnThreshold: 0.5,
        handoffThreshold: 0.6,
        maxContextTokens: 64000,
      })
      await store.fetchContextConfig()
      expect(store.contextConfig).toEqual({
        warnThreshold: 0.5,
        handoffThreshold: 0.6,
        maxContextTokens: 64000,
      })
    })

    it('失败 → 静默回退默认 0.8 / 0.9，不抛错', async () => {
      mockGetContextConfig.mockRejectedValue(new Error('network'))
      await expect(store.fetchContextConfig()).resolves.toBeUndefined()
      expect(store.contextConfig).toEqual({
        warnThreshold: 0.8,
        handoffThreshold: 0.9,
        maxContextTokens: 128000,
      })
    })
  })

  describe('agentInfo', () => {
    it('returns null for null agentId', () => {
      expect(store.agentInfo(null)).toBeNull()
    })

    it('returns name and avatar for known agent', () => {
      store.agents = [mockAgent]
      const info = store.agentInfo('a1')
      expect(info).toEqual({ name: '店长', avatar: '🐱' })
    })

    it('returns null for unknown agent', () => {
      store.agents = [mockAgent]
      expect(store.agentInfo('unknown')).toBeNull()
    })
  })

  describe('activeMessages', () => {
    it('filters messages by activeSessionId', () => {
      store.activeSessionId = 's1'
      store.messages = [
        { ...mockMessage, sessionId: 's1', id: 'm1' },
        { ...mockMessage, sessionId: 's2', id: 'm2' },
      ]
      expect(store.activeMessages).toHaveLength(1)
      expect(store.activeMessages[0].id).toBe('m1')
    })
  })

  describe('joinSession', () => {
    it('sets activeSessionId, clears messages, and emits join event', () => {
      store.sessions = [mockSession]
      store.joinSession('s1')
      expect(store.activeSessionId).toBe('s1')
      // 欢迎消息已移至服务端（通过 SESSION_HISTORY 事件发送），客户端 joinSession 不再生成
      expect(store.messages).toHaveLength(0)
      expect(mockEmit).toHaveBeenCalledWith(Events.JOIN_SESSION, 's1')
      expect(mockEmit).toHaveBeenCalledWith('get-agent-states')
    })

    it('syncs broadcast mode from session', () => {
      store.sessions = [{ ...mockSession, broadcastMode: true }]
      store.joinSession('s1')
      expect(store.broadcastMode).toBe(true)
    })

    it('emits LEAVE_SESSION when switching sessions', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      store.activeSessionId = 's1'
      store.joinSession('s2')
      expect(mockEmit).toHaveBeenCalledWith(Events.LEAVE_SESSION, 's1')
      expect(store.activeSessionId).toBe('s2')
      // 切换会话清空旧消息 + 打字状态
      expect(store.messages).toHaveLength(0)
    })
  })

  describe('消息缓存（切换会话不亮 skeleton）', () => {
    it('A→B 存缓存，B→A 命中缓存立即渲染、不亮 loading', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      store.activeSessionId = 's1'
      store.messages = [{ ...mockMessage, id: 'm1', sessionId: 's1' }]

      // A → B：切走，缓存 A
      store.joinSession('s2')
      expect(store.messages).toHaveLength(0) // B 未命中缓存 → 清空
      expect(store.loadingMessages).toBe(true) // 等待 SESSION_HISTORY

      // B → A：命中缓存 → 立即渲染，不亮 loading
      store.joinSession('s1')
      expect(store.messages).toHaveLength(1)
      expect(store.messages[0].id).toBe('m1')
      expect(store.loadingMessages).toBe(false)
    })

    it('SESSION_HISTORY 权威校正后更新缓存（补切走期间增量，防缓存陈旧）', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      store.activeSessionId = 's1'
      store.messages = [{ ...mockMessage, id: 'stale', sessionId: 's1' }]

      store.joinSession('s2') // 缓存 s1 的 stale
      store.joinSession('s1') // 命中缓存，先渲染 stale
      expect(store.messages[0].id).toBe('stale')

      // SESSION_HISTORY 权威校正：替换为最新全量
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_HISTORY)?.[1] as
        ((data: { messages: Message[]; welcome: Message }) => void) | undefined
      expect(handler).toBeDefined()
      handler!({
        messages: [
          { ...mockMessage, id: 'm1', sessionId: 's1' },
          { ...mockMessage, id: 'm2', sessionId: 's1' },
        ],
        welcome: undefined as any,
      })
      expect(store.messages).toHaveLength(2)
      expect(store.messages[0].id).toBe('m1')

      // 校正后缓存同步更新：再切走切回，拿到的是校正后的数组
      store.joinSession('s2')
      store.joinSession('s1')
      expect(store.messages).toHaveLength(2)
      expect(store.messages[0].id).toBe('m1')
    })
  })

  describe('sendMessage', () => {
    it('emits SEND_MESSAGE with payload', () => {
      store.activeSessionId = 's1'
      store.sendMessage('你好', ['店长'])
      expect(mockEmit).toHaveBeenCalledWith(Events.SEND_MESSAGE, {
        sessionId: 's1',
        content: '你好',
        mentions: ['店长'],
      })
    })

    it('does nothing without active session', () => {
      store.activeSessionId = null
      store.sendMessage('test')
      expect(mockEmit).not.toHaveBeenCalled()
    })
  })

  describe('toggleBroadcast', () => {
    it('flips broadcast mode and emits', () => {
      store.activeSessionId = 's1'
      store.broadcastMode = false
      store.toggleBroadcast()
      expect(store.broadcastMode).toBe(true)
      expect(mockEmit).toHaveBeenCalledWith(Events.TOGGLE_BROADCAST, {
        sessionId: 's1',
        broadcastMode: true,
      })
    })

    it('does nothing without active session', () => {
      store.activeSessionId = null
      store.toggleBroadcast()
      expect(mockEmit).not.toHaveBeenCalled()
    })
  })

  describe('interruptAgent', () => {
    it('emits AGENT_INTERRUPT with agentId', () => {
      store.interruptAgent('a1')
      expect(mockEmit).toHaveBeenCalledWith(Events.AGENT_INTERRUPT, { agentId: 'a1' })
    })
  })

  describe('confirmRestart', () => {
    it('emits RESTART_CONFIRM with messageId + ack callback, sets confirming state on click', () => {
      store.confirmRestart('m-restart')

      // 点击瞬间乐观置位（按钮变「已确认，等待重启…」，无需等服务端）
      expect(store.confirmingRestartMessageId).toBe('m-restart')
      // emit 携带 ack 回调（第三个参数）
      expect(mockEmit).toHaveBeenCalledWith(
        Events.RESTART_CONFIRM,
        { messageId: 'm-restart' },
        expect.any(Function)
      )
    })

    it('ack ok → 清除 confirming 状态、不弹 toast（由 RESTART_STATUS 驱动「重启中…」）', () => {
      store.confirmRestart('m-restart')
      const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean; reason?: string }) => void

      ack({ ok: true })

      expect(store.confirmingRestartMessageId).toBeNull()
      expect(store.errorMessage).toBeNull()
    })

    it('ack 过期 → 清除 confirming 状态 + toast 已过期', () => {
      store.confirmRestart('m-restart')
      const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean; reason?: string }) => void

      ack({ ok: false, reason: 'expired' })

      expect(store.confirmingRestartMessageId).toBeNull()
      expect(store.errorMessage).toContain('已过期')
    })

    it('ack 失效（missing）→ 清除 confirming 状态 + toast 已失效', () => {
      store.confirmRestart('m-restart')
      const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean; reason?: string }) => void

      ack({ ok: false, reason: 'missing' })

      expect(store.confirmingRestartMessageId).toBeNull()
      expect(store.errorMessage).toContain('已失效')
    })

    it('ack 缺失（旧 server 无回调）→ 清除 confirming 状态、不弹 toast（既有事件流兜底）', () => {
      store.confirmRestart('m-restart')
      const ack = mockEmit.mock.calls[0][2] as (ack: undefined) => void

      ack(undefined)

      expect(store.confirmingRestartMessageId).toBeNull()
      expect(store.errorMessage).toBeNull()
    })
  })

  describe('confirmPush / cancelPush', () => {
    it('confirmPush emits PUSH_CONFIRM with messageId + ack callback, sets confirming state on click', () => {
      store.confirmPush('m-push')

      // 点击瞬间乐观置位（按钮变「推送中…」，无需等服务端）
      expect(store.confirmingPushMessageId).toBe('m-push')
      expect(mockEmit).toHaveBeenCalledWith(
        Events.PUSH_CONFIRM,
        { messageId: 'm-push' },
        expect.any(Function)
      )
    })

    it('ack ok → 清除 confirming 状态、不弹 toast（由 PUSH_STATUS done 驱动「已推送」）', () => {
      store.confirmPush('m-push')
      const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean; reason?: string }) => void

      ack({ ok: true })

      expect(store.confirmingPushMessageId).toBeNull()
      expect(store.errorMessage).toBeNull()
    })

    it('ack failed → 清除 confirming 状态 + toast push 失败', () => {
      store.confirmPush('m-push')
      const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean; reason?: string }) => void

      ack({ ok: false, reason: 'failed' })

      expect(store.confirmingPushMessageId).toBeNull()
      expect(store.errorMessage).toContain('push 失败')
    })

    it('ack 缺失（旧 server 无回调）→ 清除 confirming 状态、不弹 toast（既有事件流兜底）', () => {
      store.confirmPush('m-push')
      const ack = mockEmit.mock.calls[0][2] as (ack: undefined) => void

      ack(undefined)

      expect(store.confirmingPushMessageId).toBeNull()
      expect(store.errorMessage).toBeNull()
    })

    it('超时兜底：ack/PUSH_STATUS/ERROR 三条路都不来（旧 server 静默丢弃）→ 超时后复位 + toast 明示', () => {
      vi.useFakeTimers()
      try {
        store.confirmPush('m-push')
        expect(store.confirmingPushMessageId).toBe('m-push')

        // 超时阈值内无任何确认信号 → 到点复位 + 明示「可能未加载 push 功能」
        vi.advanceTimersByTime(pushConfirmTimeoutMs)

        expect(store.confirmingPushMessageId).toBeNull()
        expect(store.errorMessage).toContain('服务端未确认 push')
      } finally {
        vi.useRealTimers()
      }
    })

    it('超时竞态：先点 m1 再点 m2，m1 的超时不得复位 m2 的 confirming 态', () => {
      vi.useFakeTimers()
      try {
        store.confirmPush('m-push-1')
        vi.advanceTimersByTime(3000)
        store.confirmPush('m-push-2')
        expect(store.confirmingPushMessageId).toBe('m-push-2')

        // m1 的超时到点——但当前 confirming 目标是 m2，不得误复位
        vi.advanceTimersByTime(pushConfirmTimeoutMs - 3000)
        expect(store.confirmingPushMessageId).toBe('m-push-2')

        // m2 自己的超时到点才复位
        vi.advanceTimersByTime(3000)
        expect(store.confirmingPushMessageId).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('ack 先于超时到达 → 超时到点不弹 toast（confirming 已清，messageId 校验拦截）', () => {
      vi.useFakeTimers()
      try {
        store.confirmPush('m-push')
        const ack = mockEmit.mock.calls[0][2] as (ack: { ok: boolean }) => void
        ack({ ok: true })
        expect(store.confirmingPushMessageId).toBeNull()

        vi.advanceTimersByTime(pushConfirmTimeoutMs)

        expect(store.errorMessage).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancelPush emits PUSH_CANCEL with messageId', () => {
      store.cancelPush('m-push')
      expect(mockEmit).toHaveBeenCalledWith(Events.PUSH_CANCEL, { messageId: 'm-push' })
    })
  })

  describe('fetchData', () => {
    it('loads agents and sessions, auto-joins first session', async () => {
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([mockSession])

      await store.fetchData()

      expect(store.agents).toEqual([mockAgent])
      expect(store.sessions).toEqual([mockSession])
      expect(store.activeSessionId).toBe('s1')
      expect(mockEmit).toHaveBeenCalledWith(Events.JOIN_SESSION, 's1')
    })

    it('handles empty sessions gracefully', async () => {
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([])

      await store.fetchData()

      expect(store.sessions).toEqual([])
      expect(store.activeSessionId).toBeNull()
    })

    it('dataReady 就绪后默认不重拉，force=true 强制刷新', async () => {
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([mockSession])

      await store.fetchData() // 首次加载 → dataReady = true
      expect(store.dataReady).toBe(true)
      const agentsCalls = mockGetAgents.mock.calls.length
      const sessionsCalls = mockGetSessions.mock.calls.length

      await store.fetchData() // 无 force → 直接 return，不重拉
      expect(mockGetAgents.mock.calls.length).toBe(agentsCalls)
      expect(mockGetSessions.mock.calls.length).toBe(sessionsCalls)

      await store.fetchData(true) // force → 重拉
      expect(mockGetAgents.mock.calls.length).toBe(agentsCalls + 1)
      expect(mockGetSessions.mock.calls.length).toBe(sessionsCalls + 1)
    })
  })

  describe('createSession', () => {
    it('creates session and joins it', async () => {
      mockCreateSession.mockResolvedValue(mockSession)

      await store.createSession('新会话', ['a1'])

      expect(store.sessions).toEqual([mockSession])
      expect(store.activeSessionId).toBe('s1')
    })
  })

  describe('deleteSession', () => {
    it('removes session and switches to next', async () => {
      const s2 = { ...mockSession, id: 's2', title: 'S2' }
      store.sessions = [mockSession, s2]
      store.activeSessionId = 's1'

      mockDeleteSession.mockResolvedValue({ ok: true })
      await store.deleteSession('s1')

      expect(store.sessions).toEqual([s2])
      expect(store.activeSessionId).toBe('s2')
    })

    it('clears activeSession when no sessions remain', async () => {
      store.sessions = [mockSession]
      store.activeSessionId = 's1'
      store.messages = [mockMessage]

      mockDeleteSession.mockResolvedValue({ ok: true })
      await store.deleteSession('s1')

      expect(store.sessions).toEqual([])
      expect(store.activeSessionId).toBeNull()
    })
  })

  describe('deleteAgent', () => {
    it('removes agent from list', async () => {
      store.agents = [mockAgent]
      mockDeleteAgent.mockResolvedValue({ ok: true })

      await store.deleteAgent('a1')

      expect(store.agents).toEqual([])
      expect(mockDeleteAgent).toHaveBeenCalledWith('a1')
    })
  })

  describe('updateAgent', () => {
    it('updates agent in list', async () => {
      store.agents = [mockAgent]
      const updated = { ...mockAgent, name: '新名字' }
      mockUpdateAgent.mockResolvedValue(updated)

      await store.updateAgent('a1', { name: '新名字' })

      expect(store.agents[0].name).toBe('新名字')
    })
  })

  describe('unread counts', () => {
    it('fetchData populates unreadCounts, then joinSession clears own', async () => {
      // s1 is first → auto-joined → unread cleared; s2 keeps its count
      const s1 = { ...mockSession, id: 's1', unreadCount: 3 }
      const s2 = { ...mockSession, id: 's2', unreadCount: 7 }
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([s1, s2])

      await store.fetchData()

      // s1 was auto-joined → unread cleared by joinSession
      expect(store.unreadCounts.has('s1')).toBe(false)
      // s2 was NOT joined → unread persists from server response
      expect(store.unreadCounts.get('s2')).toBe(7)
    })

    it('NEW_MESSAGE increments unread for non-active sessions', () => {
      store.activeSessionId = null // no active session → all new messages are unread
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.NEW_MESSAGE)?.[1] as
        ((msg: Message) => void) | undefined
      expect(handler).toBeDefined()

      handler!({ ...mockMessage, sessionId: 's1', id: 'm1' })
      expect(store.unreadCounts.get('s1')).toBe(1)

      handler!({ ...mockMessage, sessionId: 's1', id: 'm2' })
      expect(store.unreadCounts.get('s1')).toBe(2)

      handler!({ ...mockMessage, sessionId: 's2', id: 'm3' })
      expect(store.unreadCounts.get('s2')).toBe(1)
      expect(store.unreadCounts.get('s1')).toBe(2) // unchanged
    })

    it('NEW_MESSAGE does not increment unread for active session', () => {
      store.activeSessionId = 's1'
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.NEW_MESSAGE)?.[1] as
        ((msg: Message) => void) | undefined
      expect(handler).toBeDefined()

      handler!({ ...mockMessage, sessionId: 's1', id: 'm1' })
      // Active session → no unread increment
      expect(store.unreadCounts.has('s1')).toBe(false)
    })

    it('joinSession clears unread count and calls markSessionRead', () => {
      store.unreadCounts.set('s1', 5)
      store.sessions = [mockSession]
      store.agents = [mockAgent]

      store.joinSession('s1')

      expect(store.unreadCounts.has('s1')).toBe(false)
      expect(mockMarkSessionRead).toHaveBeenCalledWith('s1')
    })
  })

  describe('socket event handlers', () => {
    it('NEW_MESSAGE appends to messages', () => {
      // Find the NEW_MESSAGE handler from bindEvents
      const newMsgHandler = mockOn.mock.calls.find(
        (call) => call[0] === Events.NEW_MESSAGE
      )?.[1] as ((msg: Message) => void) | undefined

      expect(newMsgHandler).toBeDefined()
      // S6: NEW_MESSAGE 只在 msg.sessionId === activeSessionId 时存储
      store.activeSessionId = 's1'
      newMsgHandler!(mockMessage)
      expect(store.messages).toEqual([mockMessage])
    })

    it('SESSION_HISTORY replaces messages in one batch', () => {
      // Pre-populate with some stale messages
      store.messages = [
        { ...mockMessage, id: 'old-1', sessionId: 'old-session' },
        { ...mockMessage, id: 'old-2', sessionId: 'old-session' },
      ]

      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_HISTORY)?.[1] as
        ((data: { messages: Message[]; welcome: Message }) => void) | undefined

      expect(handler).toBeDefined()

      const welcomeMsg: Message = {
        id: 'welcome-s1',
        sessionId: 's1',
        agentId: null,
        role: 'system',
        content: '👋 欢迎！',
        mentions: [],
        createdAt: '2024-01-01',
      }

      const historyMsgs: Message[] = [
        { ...mockMessage, id: 'm1', sessionId: 's1' },
        { ...mockMessage, id: 'm2', sessionId: 's1', role: 'agent', agentId: 'a1' },
      ]

      handler!({ messages: historyMsgs, welcome: welcomeMsg })

      // Should replace the entire messages array (not append)
      expect(store.messages).toHaveLength(3)
      expect(store.messages[0].id).toBe('welcome-s1')
      expect(store.messages[1].id).toBe('m1')
      expect(store.messages[2].id).toBe('m2')
    })

    it('AGENT_TYPING sets typing state', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.AGENT_TYPING)?.[1] as
        ((data: any) => void) | undefined

      store.activeSessionId = 's1'
      handler!({ agentId: 'a1', messageId: 'm1', content: 'hello...', sessionId: 's1' })
      expect(store.typingStates.get('a1')).toEqual({
        agentId: 'a1',
        messageId: 'm1',
        content: 'hello...',
        sessionId: 's1',
      })
    })

    it('AGENT_STATUS updates agent state map', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.AGENT_STATUS)?.[1] as
        ((data: any) => void) | undefined

      store.activeSessionId = 's1'
      handler!({ agentId: 'a1', status: 'busy', sessionId: 's1', queueLength: 0 })
      expect(store.agentStates.get('a1')?.status).toBe('busy')
    })

    it('MESSAGE_AGENT_STATUS replying 心跳 stamp lastBeatAt；done 整对象替换抹 startedAt/lastBeatAt（终态不显示时长）', () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.MESSAGE_AGENT_STATUS
      )?.[1] as ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_700_000_000_000)

        // replying 心跳 → 记录客户端接收时间戳 lastBeatAt（liveness 锚点）
        handler!({
          messageId: 'm1',
          agentId: 'a1',
          agentName: '店长',
          agentAvatar: '🐱',
          status: 'replying',
          startedAt: 1_700_000_000_000 - 30_000,
        })
        expect(store.messageStatus.get('m1')![0].lastBeatAt).toBe(1_700_000_000_000)

        // done → 整对象替换，无 startedAt/lastBeatAt（终态不显示时长，隐式前提钉死）
        handler!({
          messageId: 'm1',
          agentId: 'a1',
          agentName: '店长',
          agentAvatar: '🐱',
          status: 'done',
        })
        expect(store.messageStatus.get('m1')![0].lastBeatAt).toBeUndefined()
        expect(store.messageStatus.get('m1')![0].startedAt).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('SESSION_DELETED removes session from list', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'

      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_DELETED)?.[1] as
        ((data: any) => void) | undefined

      handler!({ sessionId: 's1' })
      expect(store.sessions).toHaveLength(1)
      expect(store.sessions[0].id).toBe('s2')
    })

    it('RESTART_STATUS pending → 按钮保持 pending（join 广播的当前状态不被当 none 打掉）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.RESTART_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      // 先置 confirmed（模拟按钮已「重启中…」），再收到 join 的 pending 广播 → 应回到 pending 可点
      handler!({ sessionId: 's1', messageId: 'm-restart', state: 'confirmed' })
      expect(store.restartStates.get('m-restart')).toBe('confirmed')

      handler!({ sessionId: 's1', messageId: 'm-restart', state: 'pending' })
      expect(store.restartStates.get('m-restart')).toBe('pending')
    })

    it('RESTART_STATUS confirmed → 置 confirmed；none → 复位 none（既有语义不回归）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.RESTART_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      store.restartStates.set('m-restart', 'pending')
      handler!({ sessionId: 's1', messageId: 'm-restart', state: 'confirmed' })
      expect(store.restartStates.get('m-restart')).toBe('confirmed')

      handler!({ sessionId: 's1', messageId: 'm-restart', state: 'none' })
      expect(store.restartStates.get('m-restart')).toBe('none')
    })

    it('RESTART_STATUS pending 到达也解除 confirming（join 后确认中状态不悬挂）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.RESTART_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      store.confirmingRestartMessageId = 'm-restart'
      handler!({ sessionId: 's1', messageId: 'm-restart', state: 'pending' })
      expect(store.confirmingRestartMessageId).toBeNull()
    })

    it('PUSH_STATUS pushing/done/failed/cancelled → 驱动按钮状态', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.PUSH_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      handler!({ messageId: 'm-push', state: 'pushing' })
      expect(store.pushStates.get('m-push')).toBe('pushing')

      handler!({ messageId: 'm-push', state: 'done' })
      expect(store.pushStates.get('m-push')).toBe('done')

      handler!({ messageId: 'm-push', state: 'failed' })
      expect(store.pushStates.get('m-push')).toBe('failed')

      handler!({ messageId: 'm-push', state: 'cancelled' })
      expect(store.pushStates.get('m-push')).toBe('cancelled')
    })

    it('PUSH_STATUS 到达也解除 confirming（服务端权威状态接管按钮显示）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.PUSH_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      store.confirmingPushMessageId = 'm-push'
      handler!({ messageId: 'm-push', state: 'pushing' })
      expect(store.confirmingPushMessageId).toBeNull()
    })

    it('socket connect（重连）→ 清 confirmingPushMessageId（断开期间的确认已不可能被响应）', () => {
      const connectHandler = mockOn.mock.calls.find((call) => call[0] === 'connect')?.[1] as
        (() => void) | undefined
      expect(connectHandler).toBeDefined()

      store.confirmingPushMessageId = 'm-push'
      connectHandler!()

      expect(store.confirmingPushMessageId).toBeNull()
    })

    it('NEW_MESSAGE push_request → pushStates 初始 pending；SESSION_HISTORY 同理', () => {
      const newMsgHandler = mockOn.mock.calls.find(
        (call) => call[0] === Events.NEW_MESSAGE
      )?.[1] as ((msg: Message) => void) | undefined
      const histHandler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_HISTORY
      )?.[1] as ((data: any) => void) | undefined
      expect(newMsgHandler).toBeDefined()
      expect(histHandler).toBeDefined()
      store.activeSessionId = 's1'

      newMsgHandler!({
        id: 'm-push-1',
        sessionId: 's1',
        agentId: 'a1',
        role: 'agent',
        content: 'push 请求',
        mentions: [],
        createdAt: new Date().toISOString(),
        messageType: 'push_request',
      })
      expect(store.pushStates.get('m-push-1')).toBe('pending')

      histHandler!({
        messages: [
          {
            id: 'm-push-2',
            sessionId: 's1',
            agentId: 'a1',
            role: 'agent',
            content: 'push 请求',
            mentions: [],
            createdAt: new Date().toISOString(),
            messageType: 'push_request',
          },
        ],
        welcome: null,
      })
      expect(store.pushStates.get('m-push-2')).toBe('pending')
    })

    it('HANDOFF_FAILED 仅当前会话生效：非当前会话不显示，当前会话设置 handoffFailed', () => {
      // 事件名字面量对齐单 A 契约（shared Events.HANDOFF_FAILED 由单 A 添加，落地后可换常量）
      const handler = mockOn.mock.calls.find((call) => call[0] === 'handoff-failed')?.[1] as
        ((data: { sessionId: string; reason: string }) => void) | undefined
      expect(handler).toBeDefined()

      store.activeSessionId = 's1'
      handler!({ sessionId: 'other-session', reason: 'boom' })
      expect(store.handoffFailed).toBeNull()
      handler!({ sessionId: 's1', reason: 'empty response' })
      expect(store.handoffFailed).toEqual({ sessionId: 's1', reason: 'empty response' })
    })

    it('交接失败横幅清除链：收到新消息 / dismissHandoffFailed / 切会话', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === 'handoff-failed')?.[1] as
        ((data: { sessionId: string; reason: string }) => void) | undefined
      const newMsgHandler = mockOn.mock.calls.find(
        (call) => call[0] === Events.NEW_MESSAGE
      )?.[1] as ((msg: Message) => void) | undefined

      store.activeSessionId = 's1'
      handler!({ sessionId: 's1', reason: 'empty response' })
      expect(store.handoffFailed).not.toBeNull()

      // 收到新消息清除（失败提示不常驻）
      newMsgHandler!(mockMessage)
      expect(store.handoffFailed).toBeNull()

      // 手动关闭清除
      handler!({ sessionId: 's1', reason: 'empty response' })
      store.dismissHandoffFailed()
      expect(store.handoffFailed).toBeNull()

      // 切会话清除（joinSession 重置横幅，防旧会话失败提示串台）
      handler!({ sessionId: 's1', reason: 'empty response' })
      store.joinSession('s2')
      expect(store.handoffFailed).toBeNull()
    })
  })
})

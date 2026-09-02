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
const mockSaveContextConfig = vi.fn()
const mockGetSessionExecutions = vi.fn().mockResolvedValue({ executions: [] })

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
    saveContextConfig: mockSaveContextConfig,
    getSessionExecutions: mockGetSessionExecutions,
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

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear() // 会话记忆测试：每个用例从干净的 localStorage 开始
    setActivePinia(createPinia())

    // Import store dynamically
    const { useChatStore } = await import('./chat.js')
    store = useChatStore()
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

  describe('saveContextConfig', () => {
    it('成功 → 调 API + 写回 contextConfig（C8：ChatPanel 横幅 live 读它即刷新）+ 返回更新值', async () => {
      mockSaveContextConfig.mockResolvedValue({
        warnThreshold: 0.85,
        handoffThreshold: 0.95,
        maxContextTokens: 128000,
      })
      const res = await store.saveContextConfig({
        warnThreshold: 0.85,
        handoffThreshold: 0.95,
      })
      expect(mockSaveContextConfig).toHaveBeenCalledWith({
        warnThreshold: 0.85,
        handoffThreshold: 0.95,
      })
      expect(store.contextConfig).toEqual({
        warnThreshold: 0.85,
        handoffThreshold: 0.95,
        maxContextTokens: 128000,
      })
      expect(res).toEqual({
        warnThreshold: 0.85,
        handoffThreshold: 0.95,
        maxContextTokens: 128000,
      })
    })

    it('失败 → 抛错不静默，contextConfig 保持原值（保存失败必须让用户知道）', async () => {
      mockSaveContextConfig.mockRejectedValue(new Error('400 bad'))
      await expect(
        store.saveContextConfig({ warnThreshold: 0.85, handoffThreshold: 0.95 })
      ).rejects.toThrow('400 bad')
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

  describe('sessionExecutions（execution meta 耗时/token 落库稳定展示）', () => {
    it('成功 → 按 messageId 建 Map（message_id NULL 行跳过——失败/中断 execution 无回复气泡可关联）', async () => {
      store.activeSessionId = 's1'
      mockGetSessionExecutions.mockResolvedValue({
        executions: [
          {
            messageId: 'msg-1',
            agentId: 'a1',
            status: 'completed',
            latencyMs: 12300,
            promptTokens: 2100,
            completionTokens: 800,
            startedAt: '2026-09-01T10:00:00Z',
          },
          {
            messageId: null,
            agentId: 'a2',
            status: 'failed',
            latencyMs: null,
            promptTokens: null,
            completionTokens: null,
            startedAt: null,
          },
        ],
      })
      await store.fetchSessionExecutions()
      expect(mockGetSessionExecutions).toHaveBeenCalledWith('s1')
      expect(store.sessionExecutions.size).toBe(1)
      expect(store.sessionExecutions.get('msg-1')).toMatchObject({
        agentId: 'a1',
        latencyMs: 12300,
        promptTokens: 2100,
        completionTokens: 800,
      })
    })

    it('失败静默 log，不清空旧缓存（会话内仍显示已加载部分）', async () => {
      store.activeSessionId = 's1'
      const old = new Map([
        [
          'old-msg',
          {
            messageId: 'old-msg',
            agentId: 'a1',
            status: 'completed',
            latencyMs: 100,
            promptTokens: 1,
            completionTokens: 1,
            startedAt: null,
          },
        ],
      ])
      store.sessionExecutions = old
      mockGetSessionExecutions.mockRejectedValue(new Error('network'))
      await expect(store.fetchSessionExecutions()).resolves.toBeUndefined()
      expect(store.sessionExecutions.has('old-msg')).toBe(true)
    })

    it('SESSION_HISTORY 权威校正后重拉执行元数据（补切走/刷新期间增量 execution）', async () => {
      store.activeSessionId = 's1'
      mockGetSessionExecutions.mockResolvedValue({
        executions: [
          {
            messageId: 'm-ack',
            agentId: 'a1',
            status: 'completed',
            latencyMs: 500,
            promptTokens: 10,
            completionTokens: 5,
            startedAt: null,
          },
        ],
      })
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_HISTORY)?.[1] as
        ((data: { messages: Message[]; welcome: Message }) => void) | undefined
      expect(handler).toBeDefined()
      handler!({
        messages: [{ ...mockMessage, id: 'm-ack' }],
        welcome: undefined as any,
      })
      // fire-and-forget 拉取：等微任务 flush
      await new Promise((r) => setTimeout(r, 0))
      expect(store.sessionExecutions.get('m-ack')).toMatchObject({ latencyMs: 500 })
    })

    it('joinSession 切换会话时清空旧会话的 sessionExecutions', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      store.sessionExecutions = new Map([
        [
          's1-msg',
          {
            messageId: 's1-msg',
            agentId: 'a1',
            status: 'completed',
            latencyMs: 100,
            promptTokens: 1,
            completionTokens: 1,
            startedAt: null,
          },
        ],
      ])
      store.joinSession('s2')
      expect(store.sessionExecutions.size).toBe(0)
    })
  })

  describe('sendMessage', () => {
    it('emits SEND_MESSAGE with payload + ack 回调（C5：store 独占生命周期）', () => {
      store.activeSessionId = 's1'
      store.sendMessage('你好', ['店长'])
      expect(mockEmit).toHaveBeenCalledWith(
        Events.SEND_MESSAGE,
        {
          sessionId: 's1',
          content: '你好',
          mentions: ['店长'],
        },
        expect.any(Function)
      )
      // 发送后 sendStatus=sending（等待 ack/超时）
      expect(store.sendStatus).toBe('sending')
    })

    it('does nothing without active session', () => {
      store.activeSessionId = null
      store.sendMessage('test')
      expect(mockEmit).not.toHaveBeenCalled()
      expect(store.sendStatus).toBe('idle')
    })
  })

  describe('message lifecycle (C5)', () => {
    /** 捕获最近一次 SEND_MESSAGE 的 ack 回调 */
    function captureAck(): (res: any) => void {
      const emitCall = mockEmit.mock.calls.find((c) => c[0] === Events.SEND_MESSAGE)
      expect(emitCall).toBeDefined()
      return emitCall![2] as (res: any) => void
    }

    it('ack ok:true → sendStatus ok + lifecycle received（key=server 生成的 messageId）', () => {
      store.activeSessionId = 's1'
      store.sendMessage('你好')
      const ack = captureAck()
      ack({ ok: true, messageId: 'm-ack', effectiveSessionId: 's1' })
      expect(store.sendStatus).toBe('ok')
      expect(store.getLifecycle('m-ack')).toBe('received')
    })

    it('ack ok:false → sendStatus failed + error toast；lifecycle 无记录（失败无 messageId 可 key）', () => {
      store.activeSessionId = 's1'
      store.sendMessage('你好')
      const ack = captureAck()
      ack({ ok: false, effectiveSessionId: 's1', error: 'Session not found' })
      expect(store.sendStatus).toBe('failed')
      expect(store.errorMessage).toBe('Session not found')
      expect(store.getLifecycle('m-none')).toBeUndefined()
    })

    it('ack 超时（旧 server 不回调 / 连接静默断）→ 10s 后 sendStatus failed + 报错（根治静默失败）', () => {
      vi.useFakeTimers()
      try {
        store.activeSessionId = 's1'
        store.sendMessage('你好')
        expect(store.sendStatus).toBe('sending')
        vi.advanceTimersByTime(10000)
        expect(store.sendStatus).toBe('failed')
        expect(store.errorMessage).toContain('服务器无响应')
      } finally {
        vi.useRealTimers()
      }
    })

    it('MESSAGE_AGENT_STATUS replying → agent-processing；done → replied（仅推进已 ack 的消息）', () => {
      store.activeSessionId = 's1'
      store.sendMessage('你好 @店长')
      captureAck()({ ok: true, messageId: 'm-user', effectiveSessionId: 's1' })

      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.MESSAGE_AGENT_STATUS
      )?.[1] as ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      handler!({
        messageId: 'm-user',
        agentId: 'a1',
        agentName: '店长',
        agentAvatar: '🐱',
        status: 'replying',
        startedAt: 1_700_000_000_000,
      })
      expect(store.getLifecycle('m-user')).toBe('agent-processing')

      handler!({
        messageId: 'm-user',
        agentId: 'a1',
        agentName: '店长',
        agentAvatar: '🐱',
        status: 'done',
      })
      expect(store.getLifecycle('m-user')).toBe('replied')
    })

    it('非本客户端发送的消息：MESSAGE_AGENT_STATUS 不推进（lifecycles 无该 messageId → 跳过）', () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.MESSAGE_AGENT_STATUS
      )?.[1] as ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      handler!({
        messageId: 'm-other',
        agentId: 'a1',
        agentName: '店长',
        agentAvatar: '🐱',
        status: 'replying',
      })
      expect(store.getLifecycle('m-other')).toBeUndefined()
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
      expect(store.currentStateFor('a1')?.status).toBe('busy')
    })

    it('回归：A 会话 X busy、B 会话视图 X idle（复合键隔离会话，实锤用户报的跨会话忙泄露）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.AGENT_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      // A 会话 @ X → X 在 A 会话 busy（sessionId 维度精确存储）
      store.activeSessionId = 's1'
      handler!({ agentId: 'x', status: 'busy', sessionId: 's1', queueLength: 0 })
      expect(store.currentStateFor('x')?.status).toBe('busy')

      // 切到 B 会话 → X 在 B 会话无状态（哨兵桶也无）→ idle，不泄露 A 的忙
      store.activeSessionId = 's2'
      expect(store.currentStateFor('x')?.status).toBeUndefined()
    })

    it('回归：同会话 busy→idle 收敛——AGENT_STATUS idle（带 sessionId）清掉忙灯', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.AGENT_STATUS)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      // X 在 A 会话 busy（忙灯亮）
      store.activeSessionId = 's1'
      handler!({ agentId: 'x', status: 'busy', sessionId: 's1', queueLength: 0 })
      expect(store.currentStateFor('x')?.status).toBe('busy')

      // X 完成 → AGENT_STATUS idle（idle 保留 sessionId 形状，服务端不再丢这条收敛）→ 忙灯收回
      handler!({ agentId: 'x', status: 'idle', sessionId: 's1', queueLength: 0 })
      expect(store.currentStateFor('x')?.status).toBe('idle')

      // 收敛不破坏跨会话隔离：B 会话视图 X 仍无状态（不泄露 A 的忙/闲）
      store.activeSessionId = 's2'
      expect(store.currentStateFor('x')?.status).toBeUndefined()
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

  describe('会话记忆（刷新恢复）', () => {
    it('joinSession 持久化上次选中会话到 localStorage', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      store.joinSession('s2')
      expect(localStorage.getItem('catstudy.activeSessionId')).toBe('s2')
    })

    it('fetchData 优先恢复上次选中会话（非列表第一个）', async () => {
      const s2 = { ...mockSession, id: 's2', title: 'S2' }
      localStorage.setItem('catstudy.activeSessionId', 's2')
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([mockSession, s2])

      await store.fetchData()

      expect(store.activeSessionId).toBe('s2') // 恢复存储，而不是无条件列表第一个 s1
    })

    it('fetchData 存储的会话不存在 → 回退第一个', async () => {
      localStorage.setItem('catstudy.activeSessionId', 'missing')
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([mockSession])

      await store.fetchData()

      expect(store.activeSessionId).toBe('s1')
    })

    it('fetchData 无存储 → 回退列表第一个', async () => {
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([mockSession])

      await store.fetchData()

      expect(store.activeSessionId).toBe('s1')
    })

    it('deleteSession 删除当前活跃会话（无后继）→ 清除 localStorage 记忆', async () => {
      store.sessions = [mockSession]
      store.activeSessionId = 's1'
      store.messages = [mockMessage]
      localStorage.setItem('catstudy.activeSessionId', 's1')

      mockDeleteSession.mockResolvedValue({ ok: true })
      await store.deleteSession('s1')

      expect(store.activeSessionId).toBeNull()
      expect(localStorage.getItem('catstudy.activeSessionId')).toBeNull()
    })

    it('deleteSession 删除当前活跃会话（有后继）→ 记忆更新为新会话', async () => {
      const s2 = { ...mockSession, id: 's2', title: 'S2' }
      store.sessions = [mockSession, s2]
      store.activeSessionId = 's1'
      localStorage.setItem('catstudy.activeSessionId', 's1')

      mockDeleteSession.mockResolvedValue({ ok: true })
      await store.deleteSession('s1')

      expect(store.activeSessionId).toBe('s2')
      expect(localStorage.getItem('catstudy.activeSessionId')).toBe('s2')
    })

    it('SESSION_DELETED 删除当前活跃会话（无后继）→ 清除 localStorage 记忆', () => {
      store.sessions = [mockSession]
      store.activeSessionId = 's1'
      localStorage.setItem('catstudy.activeSessionId', 's1')

      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_DELETED)?.[1] as
        ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      handler!({ sessionId: 's1' })

      expect(store.activeSessionId).toBeNull()
      expect(localStorage.getItem('catstudy.activeSessionId')).toBeNull()
    })
  })
})

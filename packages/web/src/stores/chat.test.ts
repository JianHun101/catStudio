import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type {
  Message,
  AgentRuntimeState,
  SessionConfig,
  AgentConfig,
  TrashEntry,
} from '@cat-study/shared'
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
const mockRollbackSession = vi.fn()
/** SESSION_HANDOFF handler 拉新会话详情用（双框幂等用例） */
const mockGetSession = vi.fn()
/** 懒加载更早历史分页口（GET /sessions/:id/messages?before=…） */
const mockGetSessionMessages = vi.fn()
// ── T3 分组（会话管理 v2）──
const mockGetSessionGroups = vi.fn()
const mockCreateSessionGroup = vi.fn()
const mockUpdateSessionGroup = vi.fn()
const mockDeleteSessionGroup = vi.fn()
const mockMoveSessionToGroup = vi.fn()
const mockGetTrash = vi.fn()
const mockRestoreSession = vi.fn()
const mockPurgeSession = vi.fn()
const mockRestoreSessionGroup = vi.fn()
const mockPurgeSessionGroup = vi.fn()
const mockEmptyTrash = vi.fn()

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
    rollbackSession: mockRollbackSession,
    getSession: mockGetSession,
    getSessionMessages: mockGetSessionMessages,
    getSessionGroups: mockGetSessionGroups,
    createSessionGroup: mockCreateSessionGroup,
    updateSessionGroup: mockUpdateSessionGroup,
    deleteSessionGroup: mockDeleteSessionGroup,
    moveSessionToGroup: mockMoveSessionToGroup,
    getTrash: mockGetTrash,
    restoreSession: mockRestoreSession,
    purgeSession: mockPurgeSession,
    restoreSessionGroup: mockRestoreSessionGroup,
    purgeSessionGroup: mockPurgeSessionGroup,
    emptyTrash: mockEmptyTrash,
  },
}))

// ── Mock logger ────────────────────────────────────

// error 需可断言（票②取证面），其余级别保持静默
const mockLogError = vi.fn()

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: mockLogError,
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
  groupId: null,
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
    mockGetSessionGroups.mockResolvedValue({ groups: [] })
    mockGetTrash.mockResolvedValue({ entries: [] })
    // 恢复/撤销/清空/回退后会 fire-and-forget 重拉列表（T6 行内时间一致性）；给默认空列表，
    // 免得未显式设置的用例把 sessions 写成 undefined。
    mockGetSessions.mockResolvedValue([])
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

    it('命中缓存时 hasMoreOlder 按缓存里的非合成消息数判初值（不再无条件 false）', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2', title: 'S2' }]
      const welcome = { ...mockMessage, id: 'welcome-s1', role: 'system' as const, sessionId: 's1' }
      const real = (n: number): Message[] =>
        Array.from({ length: n }, (_, i) => ({
          ...mockMessage,
          id: `c${i + 1}`,
          sessionId: 's1',
        })) as Message[]

      // 200 条非合成 + 1 条合成 → 满页 ⇒ 切回时 hasMoreOlder 应为 true
      store.activeSessionId = 's1'
      store.messages = [welcome, ...real(200)]
      store.joinSession('s2') // 缓存 s1
      store.joinSession('s1') // 命中缓存
      expect(store.messages).toHaveLength(201)
      expect(store.hasMoreOlder).toBe(true)

      // 10 条非合成 + 1 条合成 → 不足一页 ⇒ false
      store.messages = [welcome, ...real(10)]
      store.joinSession('s2')
      store.joinSession('s1')
      expect(store.hasMoreOlder).toBe(false)
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
            executionId: 'exec-old',
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

    // ── 票③：原始 error 落日志（与 fetchData 同款取证面）─────
    it('失败时原始 error 三字段落日志，友好文案保留', async () => {
      store.activeSessionId = 's1'
      const raw = new TypeError('Failed to fetch')
      mockGetSessionExecutions.mockRejectedValue(raw)

      await store.fetchSessionExecutions()

      expect(mockLogError).toHaveBeenCalledWith(
        'fetchSessionExecutions failed',
        expect.objectContaining({
          // 友好文案只断言「在」——其内容正确性由 fetchData 用例覆盖（同一个
          // friendlyError），此处不重复断言，避免两条用例被同一改动同时拖红、归因不清
          error: expect.any(String),
          rawMessage: 'Failed to fetch',
          rawName: 'TypeError',
          rawStack: raw.stack,
        })
      )
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
            executionId: 'exec-s1',
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

    // ── 票①：HTTP 层故障文案 ──────────────────────
    it('HTTP 接口失败文案标注 HTTP 层、不指控具体端口', async () => {
      mockGetAgents.mockRejectedValue(new TypeError('Failed to fetch'))
      mockGetSessions.mockResolvedValue([])

      await store.fetchData()

      expect(store.dataError).toContain('HTTP')
      expect(store.dataError).not.toContain('3200')
    })

    it('相邻分支未被误伤：ECONNREFUSED 仍走「尚未就绪」文案', async () => {
      mockGetAgents.mockRejectedValue(new Error('ECONNREFUSED'))
      mockGetSessions.mockResolvedValue([])

      await store.fetchData()

      expect(store.dataError).toBe('服务器尚未就绪，请稍后刷新页面')
    })

    // ── 票②：原始 error 落日志 ─────────────────────
    it('原始 error 三字段落日志，友好文案保留', async () => {
      const raw = new TypeError('Failed to fetch')
      mockGetAgents.mockRejectedValue(raw)
      mockGetSessions.mockResolvedValue([])

      await store.fetchData()

      expect(mockLogError).toHaveBeenCalledWith(
        'fetchData failed',
        expect.objectContaining({
          // 友好文案保留（与用户所见一致）——文案内容正确性由票①用例覆盖，此处不重复断言
          error: store.dataError,
          rawMessage: 'Failed to fetch',
          rawName: 'TypeError',
          rawStack: raw.stack,
        })
      )
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
      // 删除活跃会话 → 切到下一个会触发 fetchSessions（第六条路径），给服务端权威列表
      mockGetSessions.mockResolvedValue([s2])
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

  describe('joinSession 列表行时间校准（第六条一致性路径）', () => {
    it('首屏只拉一次列表；切走再切回后行时间与服务端一致', async () => {
      const s1 = { ...mockSession, id: 's1', lastMessageAt: '2026-01-02T00:00:00.000Z' }
      const s2 = {
        ...mockSession,
        id: 's2',
        title: 'S2',
        lastMessageAt: '2026-01-03T00:00:00.000Z',
      }
      mockGetAgents.mockResolvedValue([mockAgent])
      mockGetSessions.mockResolvedValue([s1, s2])

      // 首屏：一次列表 + 自动 join 第一个——自动 join 是「非切换」，不得再拉一次
      await store.fetchData()
      expect(mockGetSessions).toHaveBeenCalledTimes(1)
      expect(store.activeSessionId).toBe('s1')

      // 同会话重入也不重拉
      store.joinSession('s1')
      expect(mockGetSessions).toHaveBeenCalledTimes(1)

      // 切到 B（switching 为真）→ 校准一次
      store.joinSession('s2')
      await new Promise((r) => setTimeout(r, 0))
      expect(mockGetSessions).toHaveBeenCalledTimes(2)

      // 再切到 A：离开 B
      store.joinSession('s1')
      await new Promise((r) => setTimeout(r, 0))
      expect(mockGetSessions).toHaveBeenCalledTimes(3)

      // 离开 B 期间服务端给 B 落了一条回复（房间广播，本 tab 不在 B 房间收不到 NEW_MESSAGE）
      mockGetSessions.mockResolvedValue([s1, { ...s2, lastMessageAt: '2026-01-04T09:30:00.000Z' }])
      expect(store.sessions.find((s) => s.id === 's2')!.lastMessageAt).toBe(
        '2026-01-03T00:00:00.000Z'
      )

      // 切回 B：joinSession → fetchSessions，左栏行时间校准到服务端值
      store.joinSession('s2')
      await new Promise((r) => setTimeout(r, 0))
      expect(mockGetSessions).toHaveBeenCalledTimes(4)
      expect(store.sessions.find((s) => s.id === 's2')!.lastMessageAt).toBe(
        '2026-01-04T09:30:00.000Z'
      )
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

    it('NEW_MESSAGE 即时更新列表行 lastMessageAt（不往回拨）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.NEW_MESSAGE)?.[1] as
        ((msg: Message) => void) | undefined
      expect(handler).toBeDefined()
      store.activeSessionId = 's1'
      store.sessions = [{ ...mockSession, lastMessageAt: '2026-01-01T00:00:00.000Z' }]

      handler!({ ...mockMessage, id: 'm-new', createdAt: '2026-01-02T00:00:00.000Z' })
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-02T00:00:00.000Z')

      // 乱序/重放帧：更早的 created_at 不能把行上时间拨回去
      handler!({ ...mockMessage, id: 'm-old', createdAt: '2025-12-31T00:00:00.000Z' })
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-02T00:00:00.000Z')
    })

    it('NEW_MESSAGE 不推进系统通告的行内时间（只有对话消息算会话活动）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.NEW_MESSAGE)?.[1] as
        ((msg: Message) => void) | undefined
      expect(handler).toBeDefined()
      store.activeSessionId = 's1'
      store.sessions = [{ ...mockSession, lastMessageAt: '2026-01-02T00:00:00.000Z' }]

      // 重启告警 / 广播等系统通告：时间更晚，但不得顶掉上一条对话时间
      handler!({
        ...mockMessage,
        id: 'm-system',
        role: 'system',
        createdAt: '2026-11-05T04:10:58.135Z',
      })
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-02T00:00:00.000Z')

      // user/agent 对话消息照旧推进（比较后再写）
      handler!({
        ...mockMessage,
        id: 'm-user',
        role: 'user',
        createdAt: '2026-01-03T00:00:00.000Z',
      })
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-03T00:00:00.000Z')
      handler!({
        ...mockMessage,
        id: 'm-agent',
        role: 'agent',
        agentId: 'a1',
        createdAt: '2026-01-04T00:00:00.000Z',
      })
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-04T00:00:00.000Z')
    })

    it('SESSION_UPDATE 合并不抹行内时间（PATCH 不聚合；显式 null 才清）', () => {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_UPDATE)?.[1] as
        ((session: SessionConfig) => void) | undefined
      expect(handler).toBeDefined()
      store.sessions = [
        {
          ...mockSession,
          title: '旧名',
          lastMessageAt: '2026-01-02T00:00:00.000Z',
        },
      ]

      // PATCH 响应不带 lastMessageAt（字段缺失）→ 保留旧值，其余字段照常合并
      handler!({ ...mockSession, title: '新名' })
      expect(store.sessions[0]!.title).toBe('新名')
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-02T00:00:00.000Z')

      // 显式 null 表示「真的没有消息了」→ 置空，不能当成「字段缺失」保留旧值
      handler!({ ...mockSession, title: '新名', lastMessageAt: null })
      expect(store.sessions[0]!.lastMessageAt).toBeNull()
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

    // ── 票②/③：气泡计时表 replyTimers（sessionId:agentId 键控，A2A / headless 执行的唯一计时来源）──
    describe('replyTimers（Agent 回复计时）', () => {
      /** 取最新一处 handler（store 每建一次就重绑一遍，clearAllMocks 后只剩当轮的） */
      function handlerOf(event: string): (data: any) => void {
        const h = mockOn.mock.calls.find((call) => call[0] === event)?.[1] as
          ((data: any) => void) | undefined
        expect(h).toBeDefined()
        return h!
      }

      function statusEvent(over: Record<string, unknown> = {}) {
        return {
          sessionId: 's1',
          messageId: 'm1',
          agentId: 'a1',
          agentName: 'ds猫',
          agentAvatar: '🐱',
          status: 'replying',
          ...over,
        }
      }

      beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(1_700_000_000_000)
        store.activeSessionId = 's1'
      })
      afterEach(() => {
        vi.useRealTimers()
      })

      it('thinking 写入锚点：startedAt 取载荷值、lastBeatAt = 接收时刻（A2A / headless 无状态行也计时）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ status: 'thinking', startedAt: 1_700_000_000_000 - 20_000 })
        )
        expect(store.replyTimers.get('s1:a1')).toEqual({
          startedAt: 1_700_000_000_000 - 20_000,
          lastBeatAt: 1_700_000_000_000,
        })
      })

      it('心跳重发只刷新 lastBeatAt，startedAt 取新旧较小者（防乱序/中途刷新导致秒数倒退）', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(statusEvent({ status: 'thinking', startedAt: 1_700_000_000_000 - 20_000 }))

        // 中途刷新场景：只在执行中途收到一发 replying，锚点来自载荷而非本地首次渲染时刻
        vi.setSystemTime(1_700_000_000_000 + 10_000)
        handler(statusEvent({ startedAt: 1_700_000_000_000 - 20_000 }))
        expect(store.replyTimers.get('s1:a1')).toEqual({
          startedAt: 1_700_000_000_000 - 20_000,
          lastBeatAt: 1_700_000_000_000 + 10_000,
        })

        // 迟到事件带更早锚点 → 取更早者（不倒退成更晚的起点）
        handler(statusEvent({ startedAt: 1_700_000_000_000 - 30_000 }))
        expect(store.replyTimers.get('s1:a1')!.startedAt).toBe(1_700_000_000_000 - 30_000)
      })

      it('执行 N 失败后队列直转 N+1：thinking 无条件重置锚点，不继承上一轮起点（防跨执行虚高）', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        // 执行 N 起跑后失败：服务端既不发 done、也不发 AGENT_STATUS idle——serial.ts:1670
        // 队列有下一条时只发 `busy` 直转 N+1，故 idle 那条清空兜底不会触发，N 的条目留在表里
        handler(statusEvent({ status: 'thinking', startedAt: 1_700_000_000_000 - 20_000 }))
        handlerOf(Events.AGENT_STATUS)({
          agentId: 'a1',
          status: 'busy',
          sessionId: 's1',
          queueLength: 1,
        })
        expect(store.replyTimers.get('s1:a1')!.startedAt).toBe(1_700_000_000_000 - 20_000)

        // N+1 起跑：thinking 带**更晚**的新锚点 → 必须直接落新值。若与 prev 取小则保留 N 的
        // 起点，秒数会把两次执行之间的失败间隙一并算进去（虚高到 N+1 done 才自愈）
        vi.setSystemTime(1_700_000_000_000 + 60_000)
        handler(statusEvent({ status: 'thinking', startedAt: 1_700_000_000_000 + 60_000 }))
        expect(store.replyTimers.get('s1:a1')).toEqual({
          startedAt: 1_700_000_000_000 + 60_000,
          lastBeatAt: 1_700_000_000_000 + 60_000,
        })
      })

      it('载荷无 startedAt（旧 server）且本地无存量 → 不建条目（无锚点不显示时长，气泡回退静态文案）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(statusEvent({ startedAt: undefined }))
        expect(store.replyTimers.has('s1:a1')).toBe(false)
      })

      it('done → 删除计时（含 heartbeat 途中的中途删除，不留残留条目）', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(statusEvent({ startedAt: 1_700_000_000_000 - 5_000 }))
        expect(store.replyTimers.has('s1:a1')).toBe(true)

        handler(statusEvent({ status: 'done' }))
        expect(store.replyTimers.has('s1:a1')).toBe(false)
      })

      it('NEW_MESSAGE（本猫回复落库）→ 删除计时：服务端 NEW_MESSAGE 先于 done 广播，只靠 done 会闪一帧占位气泡', () => {
        store.activeSessionId = 's1'
        const statusHandler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        const newMessageHandler = handlerOf(Events.NEW_MESSAGE)
        statusHandler(statusEvent({ startedAt: 1_700_000_000_000 - 5_000 }))

        newMessageHandler({ ...mockMessage, id: 'r1', role: 'agent', agentId: 'a1' })
        expect(store.replyTimers.has('s1:a1')).toBe(false)
      })

      it('用户消息 NEW_MESSAGE 不清计时（只认 agent 回复落库为执行终点）', () => {
        store.activeSessionId = 's1'
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ startedAt: 1_700_000_000_000 - 5_000 })
        )
        handlerOf(Events.NEW_MESSAGE)({ ...mockMessage, id: 'u2', role: 'user', agentId: null })
        expect(store.replyTimers.has('s1:a1')).toBe(true)
      })

      it('AGENT_STATUS idle → 删除计时（abort/timeout 无 done 事件，只认 idle 终止信号）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ startedAt: 1_700_000_000_000 - 5_000 })
        )

        handlerOf(Events.AGENT_STATUS)({
          agentId: 'a1',
          status: 'idle',
          sessionId: 's1',
          queueLength: 0,
        })
        expect(store.replyTimers.has('s1:a1')).toBe(false)
      })

      it('AGENT_STATUS busy 不清计时（只有终止信号才清）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ startedAt: 1_700_000_000_000 - 5_000 })
        )
        handlerOf(Events.AGENT_STATUS)({
          agentId: 'a1',
          status: 'busy',
          sessionId: 's1',
          queueLength: 0,
        })
        expect(store.replyTimers.has('s1:a1')).toBe(true)
      })

      it('切会话 → 清空（兜底：会话隔离已由键保证，清空只防全局表无界增长）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ startedAt: 1_700_000_000_000 - 5_000 })
        )
        expect(store.replyTimers.has('s1:a1')).toBe(true)

        store.joinSession('s2')
        expect(store.replyTimers.size).toBe(0)
      })

      it('切走再切回：只靠心跳（10s 内）重收锚点即恢复原秒数，不归零', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(statusEvent({ status: 'thinking', startedAt: 1_700_000_000_000 - 40_000 }))
        store.joinSession('s2')
        expect(store.replyTimers.size).toBe(0)

        // 心跳重发同 startedAt（服务端一次执行一次取值）⇒ 切回后从原起点续算
        vi.setSystemTime(1_700_000_000_000 + 10_000)
        store.joinSession('s1')
        handler(statusEvent({ startedAt: 1_700_000_000_000 - 40_000 }))
        expect(store.currentReplyTimerFor('a1')).toEqual({
          startedAt: 1_700_000_000_000 - 40_000,
          lastBeatAt: 1_700_000_000_000 + 10_000,
        })
      })

      // ── 票③：会话维度（幽灵计时根治）────────────────────────────
      it('跨会话帧不落当前会话视图：注入 sessionId=s2 的帧 → 当前会话（s1）取不到计时', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({
            sessionId: 's2',
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 20_000,
          })
        )
        expect(store.replyTimers.has('s2:a1')).toBe(true)
        expect(store.currentReplyTimerFor('a1')).toBeUndefined()

        // 真空性反对照：同载荷换成本会话 ⇒ 必须取到——证明上一条的「取不到」是被键隔离，
        // 而不是载荷形状不对 / 守卫误伤（换个假的守卫实现，本断言会红）
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({ sessionId: 's1', status: 'thinking', startedAt: 1_700_000_000_000 - 9_000 })
        )
        expect(store.currentReplyTimerFor('a1')).toEqual({
          startedAt: 1_700_000_000_000 - 9_000,
          lastBeatAt: 1_700_000_000_000,
        })
      })

      it('同一只猫跨会话并行：A/B 两条 entry 并存，B 的 done 不误删 A', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(
          statusEvent({
            sessionId: 's1',
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 30_000,
          })
        )
        handler(
          statusEvent({
            sessionId: 's2',
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 10_000,
          })
        )
        expect(store.replyTimers.size).toBe(2)

        handler(statusEvent({ sessionId: 's2', status: 'done' }))
        expect(store.replyTimers.has('s2:a1')).toBe(false)
        expect(store.replyTimers.get('s1:a1')!.startedAt).toBe(1_700_000_000_000 - 30_000)
      })

      it('同一只猫跨会话并行：B 的 AGENT_STATUS idle 不误删 A（idle 按 state.sessionId 归位）', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(
          statusEvent({
            sessionId: 's1',
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 30_000,
          })
        )
        handler(
          statusEvent({
            sessionId: 's2',
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 10_000,
          })
        )

        handlerOf(Events.AGENT_STATUS)({
          agentId: 'a1',
          status: 'idle',
          sessionId: 's2',
          queueLength: 0,
        })
        expect(store.replyTimers.has('s2:a1')).toBe(false)
        expect(store.replyTimers.has('s1:a1')).toBe(true)
      })

      it('NEW_MESSAGE 按消息自身 sessionId 清（用户已切走时也要清对格子）', () => {
        const handler = handlerOf(Events.MESSAGE_AGENT_STATUS)
        handler(
          statusEvent({ sessionId: 's1', status: 'thinking', startedAt: 1_700_000_000_000 - 5_000 })
        )
        handler(
          statusEvent({ sessionId: 's2', status: 'thinking', startedAt: 1_700_000_000_000 - 5_000 })
        )
        // 当前视图停在 s1，落库的是 s2 的回复 → 清 s2 那条，s1 不受影响
        handlerOf(Events.NEW_MESSAGE)({
          ...mockMessage,
          id: 'r2',
          sessionId: 's2',
          role: 'agent',
          agentId: 'a1',
        })
        expect(store.replyTimers.has('s2:a1')).toBe(false)
        expect(store.replyTimers.has('s1:a1')).toBe(true)
      })

      it('载荷缺 sessionId（旧 server wire）→ 不建条目（无会话维度即无从键控，宁可不显示）', () => {
        handlerOf(Events.MESSAGE_AGENT_STATUS)(
          statusEvent({
            sessionId: undefined,
            status: 'thinking',
            startedAt: 1_700_000_000_000 - 5_000,
          })
        )
        expect(store.replyTimers.size).toBe(0)
      })
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

    // ─── 双框：SESSION_HANDOFF 幂等（同一父会话只留最新一条）──────────
    /** handler 内的 api.getSession 是异步链——等一拍让 .then 落表 */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const handoffHandler = () =>
      mockOn.mock.calls.find((call) => call[0] === Events.SESSION_HANDOFF)?.[1] as
        ((data: any) => void) | undefined

    it('SESSION_HANDOFF 剔除同一父会话的陈旧交接条目（重拉后仍不复活）', async () => {
      store.sessions = [
        { ...mockSession, id: 'child-old', title: '测试会话（1）', handoffFrom: 'old-1' },
        { ...mockSession, id: 'old-1', title: '测试会话' },
      ]
      store.activeSessionId = 'old-1'
      mockGetSession.mockResolvedValue({
        ...mockSession,
        id: 'child-new',
        title: '测试会话（1）',
        handoffFrom: 'old-1',
      })
      // 服务端列表只过滤 deleted_at、不按 handoffFrom 过滤：旧子会话会被权威列表带回来。
      // 故意把 child-old 放进返回，钉住「重拉落地后重放剔除」——少了重放，最终列表会被
      // mock 里的 child-old 顶掉。
      mockGetSessions.mockResolvedValue([
        { ...mockSession, id: 'child-old', title: '测试会话（1）', handoffFrom: 'old-1' },
        { ...mockSession, id: 'child-new', title: '测试会话（1）', handoffFrom: 'old-1' },
        { ...mockSession, id: 'old-1', title: '测试会话' },
      ])

      handoffHandler()!({
        oldSessionId: 'old-1',
        newSessionId: 'child-new',
        summary: '摘要',
      })
      await flush()
      await flush()

      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions.map((s) => s.id)).toEqual(['child-new', 'old-1'])
    })

    it('SESSION_HANDOFF 不在父会话时只做本地剔除、不触发列表重拉', async () => {
      store.sessions = [
        { ...mockSession, id: 'child-old', title: '测试会话（1）', handoffFrom: 'old-1' },
        { ...mockSession, id: 'old-1', title: '测试会话' },
      ]
      store.activeSessionId = 'other'
      mockGetSession.mockResolvedValue({
        ...mockSession,
        id: 'child-new',
        title: '测试会话（1）',
        handoffFrom: 'old-1',
      })

      handoffHandler()!({
        oldSessionId: 'old-1',
        newSessionId: 'child-new',
        summary: '摘要',
      })
      await flush()

      // 不在旧父会话里不 join，也就没有第六条路径的重拉；本地剔除仍需生效
      expect(mockGetSessions).not.toHaveBeenCalled()
      expect(store.sessions.map((s) => s.id)).toEqual(['child-new', 'old-1'])
    })

    it('真空性反对照：父会话不匹配的条目不被误剔（探针能区分新旧，非恒真门）', async () => {
      store.sessions = [
        { ...mockSession, id: 'other-child', title: '别的会话（1）', handoffFrom: 'other-parent' },
        { ...mockSession, id: 'old-1', title: '测试会话' },
      ]
      store.activeSessionId = 'old-1'
      mockGetSession.mockResolvedValue({
        ...mockSession,
        id: 'child-new',
        title: '测试会话（1）',
        handoffFrom: 'old-1',
      })
      // 同上：切到新会话触发 fetchSessions，给含新会话的服务端列表（顺序与断言一致）
      mockGetSessions.mockResolvedValue([
        { ...mockSession, id: 'child-new', title: '测试会话（1）', handoffFrom: 'old-1' },
        { ...mockSession, id: 'other-child', title: '别的会话（1）', handoffFrom: 'other-parent' },
        { ...mockSession, id: 'old-1', title: '测试会话' },
      ])

      handoffHandler()!({
        oldSessionId: 'old-1',
        newSessionId: 'child-new',
        summary: '摘要',
      })
      await flush()

      expect(store.sessions.map((s) => s.id)).toEqual(['child-new', 'other-child', 'old-1'])
    })

    // ─── T1 同会话回退 ─────────────────────────────
    it('SESSION_ROLLED_BACK 按权威 removedIds 移除消息 + 状态行 + 落分隔线标记', () => {
      store.activeSessionId = 's1'
      store.messages = [
        { id: 'm1', sessionId: 's1', role: 'user', content: '一' },
        { id: 'm2', sessionId: 's1', role: 'agent', content: '二' },
        { id: 'm3', sessionId: 's1', role: 'user', content: '三' },
      ] as never
      store.messageStatus = new Map([['m3', [{ agentId: 'a1' } as never]]])

      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_ROLLED_BACK
      )?.[1] as ((data: any) => void) | undefined
      expect(handler).toBeDefined()

      handler!({ sessionId: 's1', messageId: 'm1', removedIds: ['m2', 'm3'], removedCount: 2 })

      expect(store.messages.map((m) => m.id)).toEqual(['m1'])
      // 状态行一并清（否则 statusEntries 挂在已不存在的消息上）
      expect(store.messageStatus.has('m3')).toBe(false)
      expect(store.rollbackMarks.get('s1')).toEqual({ afterMessageId: 'm1', removedCount: 2 })
    })

    it('SESSION_ROLLED_BACK 非当前会话不落本地（别的会话被回退不该动这棵树）', () => {
      store.activeSessionId = 's2'
      store.messages = [{ id: 'm1', sessionId: 's2', role: 'user', content: '一' }] as never

      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_ROLLED_BACK
      )?.[1] as ((data: any) => void) | undefined
      handler!({ sessionId: 's1', messageId: 'x', removedIds: ['m1'], removedCount: 1 })

      expect(store.messages.map((m) => m.id)).toEqual(['m1'])
      expect(store.rollbackMarks.get('s1')).toBeUndefined()
    })

    it('SESSION_ROLLED_BACK 重拉列表校准行内时间（不用本地 welcome 末条重算）', async () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_ROLLED_BACK
      )?.[1] as ((data: any) => void) | undefined
      store.sessions = [{ ...mockSession, lastMessageAt: '2026-01-05T00:00:00.000Z' }]
      mockGetSessions.mockResolvedValue([
        { ...mockSession, lastMessageAt: '2026-01-01T00:00:00.000Z' },
      ])

      // 非当前会话也要重拉：多 tab 下别的会话被回退，行内时间同样得落
      store.activeSessionId = 's2'
      handler!({ sessionId: 's1', messageId: 'm1', removedIds: ['m2'], removedCount: 1 })
      await new Promise((r) => setTimeout(r, 0))

      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-01T00:00:00.000Z')
    })

    it('SESSION_MESSAGES_CLEARED 把该会话行 lastMessageAt 置 null（不只清当前消息）', () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_MESSAGES_CLEARED
      )?.[1] as ((data: { sessionId: string }) => void) | undefined
      expect(handler).toBeDefined()
      store.sessions = [
        { ...mockSession, id: 's1', lastMessageAt: '2026-01-05T00:00:00.000Z' },
        { ...mockSession, id: 's2', lastMessageAt: '2026-01-04T00:00:00.000Z' },
      ]
      store.activeSessionId = 's2'

      // 非当前会话被清空（多 tab）：也要落，且不新建/误删行
      handler!({ sessionId: 's1' })
      expect(store.sessions).toHaveLength(2)
      expect(store.sessions.find((s) => s.id === 's1')!.lastMessageAt).toBeNull()
      expect(store.sessions.find((s) => s.id === 's2')!.lastMessageAt).toBe(
        '2026-01-04T00:00:00.000Z'
      )
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

    it('rollbackSession 按服务端回执的 removedIds 本地移除 + 落分隔线标记', async () => {
      store.activeSessionId = 's1'
      store.messages = [
        { id: 'm1', sessionId: 's1', role: 'user', content: '一' },
        { id: 'm2', sessionId: 's1', role: 'agent', content: '二' },
        { id: 'm3', sessionId: 's1', role: 'user', content: '三' },
      ] as never
      store.messageStatus = new Map([['m2', [{ agentId: 'a1' } as never]]])
      // 服务端说删 m3（不是前端自己按时间戳算的 m2/m3）——回执就是权威
      mockRollbackSession.mockResolvedValueOnce({
        ok: true,
        messageId: 'm1',
        removedIds: ['m3'],
        removedCount: 1,
      })

      const count = await store.rollbackSession('s1', 'm1')

      expect(mockRollbackSession).toHaveBeenCalledWith('s1', 'm1')
      expect(count).toBe(1)
      expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(store.rollbackMarks.get('s1')).toEqual({ afterMessageId: 'm1', removedCount: 1 })
    })

    it('rollbackSession 非当前会话只调端点、不动本地树', async () => {
      store.activeSessionId = 's2'
      store.messages = [{ id: 'keep', sessionId: 's2', role: 'user', content: 'x' }] as never
      mockRollbackSession.mockResolvedValueOnce({
        ok: true,
        messageId: 'm1',
        removedIds: ['m9'],
        removedCount: 1,
      })

      await store.rollbackSession('s1', 'm1')

      expect(store.messages.map((m) => m.id)).toEqual(['keep'])
      expect(store.rollbackMarks.get('s1')).toBeUndefined()
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

  // ─── 懒加载更早历史（票 C-1）──────────────────────────
  describe('懒加载更早历史（C-1）', () => {
    const welcome = (): Message => ({ ...mockMessage, id: 'welcome-s1', role: 'system' })

    /** 造 n 条消息，id 从 `offset+1` 起、createdAt 毫秒位即序号（严格 ASC） */
    function msgs(n: number, offset = 0): Message[] {
      return Array.from({ length: n }, (_, i) => ({
        id: `m${i + 1 + offset}`,
        sessionId: 's1',
        agentId: null,
        role: 'user',
        content: `msg-${i + 1 + offset}`,
        mentions: [],
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i + 1 + offset)).toISOString(),
      })) as Message[]
    }

    const ids = (list: Message[]): string[] => list.map((m) => m.id)

    function sessionHistoryHandler(): (data: { messages: Message[]; welcome: Message }) => void {
      const handler = mockOn.mock.calls.find((call) => call[0] === Events.SESSION_HISTORY)?.[1] as
        ((data: { messages: Message[]; welcome: Message }) => void) | undefined
      expect(handler).toBeDefined()
      return handler!
    }

    it('hasMoreOlder 初值 = 首屏是否拿满一页（200 条留口，不足即封口）', () => {
      store.activeSessionId = 's1'
      sessionHistoryHandler()({ messages: msgs(199), welcome: welcome() })
      expect(store.hasMoreOlder).toBe(false)

      sessionHistoryHandler()({ messages: msgs(200), welcome: welcome() })
      expect(store.hasMoreOlder).toBe(true)

      // 合成头部不计入服务端页大小：199 条真实 + welcome 仍不足一页
      sessionHistoryHandler()({ messages: msgs(199), welcome: welcome() })
      expect(store.hasMoreOlder).toBe(false)
    })

    it('B｜连翻到开头：前插保持全局 ASC、无重复 id、空页封口', async () => {
      store.activeSessionId = 's1'
      // 会话 120 条；首屏只载最新 20 条（长会话的首屏窗口），更早 100 条分两页 50+50，再一页空
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      mockGetSessionMessages
        .mockResolvedValueOnce(msgs(50, 50).reverse()) // m51..m100（wire 是 DESC）
        .mockResolvedValueOnce(msgs(50, 0).reverse()) // m1..m50
        .mockResolvedValueOnce([]) // 空页 ⇒ 封口

      await store.loadOlderMessages()
      await store.loadOlderMessages()
      expect(store.hasMoreOlder).toBe(true) // 两页都拿满，仍可能有更早
      await store.loadOlderMessages()

      expect(ids(store.messages)).toEqual(ids(msgs(120)))
      expect(new Set(ids(store.messages)).size).toBe(120)
      expect(store.hasMoreOlder).toBe(false)
      // 契约允许一次多余的空请求：第三页用于确认到底
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(3)
      // 游标是**当前最旧一条**，且排他
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(1, 's1', { before: 'm101', limit: 50 })
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(2, 's1', { before: 'm51', limit: 50 })
    })

    it('合成头部（欢迎语/交接摘要）不作 before 游标，且保持在数组最前', async () => {
      store.activeSessionId = 's1'
      store.messages = [welcome(), ...msgs(5, 10)] // welcome + m11..m15
      store.hasMoreOlder = true
      mockGetSessionMessages.mockResolvedValueOnce(msgs(2, 0).reverse()) // m1,m2

      await store.loadOlderMessages()

      expect(mockGetSessionMessages).toHaveBeenCalledWith('s1', { before: 'm11', limit: 50 })
      expect(ids(store.messages)).toEqual([
        'welcome-s1',
        'm1',
        'm2',
        'm11',
        'm12',
        'm13',
        'm14',
        'm15',
      ])
    })

    it('不足一页即封口；已封口不再发请求', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5, 10)
      store.hasMoreOlder = true
      mockGetSessionMessages.mockResolvedValueOnce(msgs(3, 7).reverse()) // m8..m10（不足 50）

      await store.loadOlderMessages()
      expect(store.hasMoreOlder).toBe(false)
      expect(ids(store.messages).slice(0, 3)).toEqual(['m8', 'm9', 'm10'])

      await store.loadOlderMessages() // 已封口 ⇒ no-op
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)
    })

    it('并发调两次只发一次请求，两个调用复用同一个在途 Promise（C-3 契约 6）', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5, 10)
      store.hasMoreOlder = true
      let resolve!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((r) => {
          resolve = r
        })
      )

      const p1 = store.loadOlderMessages()
      const p2 = store.loadOlderMessages()
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)
      expect(store.loadingOlder).toBe(true)

      resolve(msgs(3, 7).reverse()) // m8..m10
      expect(await p1).toBe(true)
      expect(await p2).toBe(true)
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)
      expect(store.loadingOlder).toBe(false)
    })

    it('等待期间切了会话 → 丢弃这一页，不串进新会话', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      let resolve!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((r) => {
          resolve = r
        })
      )

      const pending = store.loadOlderMessages()
      store.activeSessionId = 's2' // 用户切走
      resolve(msgs(50, 50).reverse())
      await pending

      expect(ids(store.messages)).toEqual(ids(msgs(20, 100)))
      expect(store.loadingOlder).toBe(false)
    })

    it('失败 → olderError 存可读文案，loadingOlder 复位，消息数组不动', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5, 10)
      store.hasMoreOlder = true
      mockGetSessionMessages.mockRejectedValueOnce(new Error('Failed to fetch'))

      await store.loadOlderMessages()

      expect(store.olderError).toContain('HTTP 接口请求失败')
      expect(store.loadingOlder).toBe(false)
      expect(store.messages).toHaveLength(5)
    })

    it('OQ-3｜切会话后旧请求失败：B 首滚发新请求，A 的失败不写 B 的错误态、不清 B 的 loading', async () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100) // m101..m120
      store.hasMoreOlder = true
      let rejectA!: (err: Error) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((_, reject) => {
          rejectA = reject
        })
      )

      const pendingA = store.loadOlderMessages()
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(1, 's1', { before: 'm101', limit: 50 })

      // 用户切到 B：B 的首屏消息已在、还有更早
      store.joinSession('s2')
      store.messages = msgs(20, 200) // m201..m220
      store.hasMoreOlder = true
      let resolveB!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveB = resolve
        })
      )

      const pendingB = store.loadOlderMessages()
      // B 的首滚必须发出**以 B 为会话**的新请求，而不是复用 A 的在途 Promise
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(2)
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(2, 's2', { before: 'm201', limit: 50 })
      expect(store.loadingOlder).toBe(true)

      rejectA(new Error('Failed to fetch'))
      await pendingA

      // 旧会话的收尾只属于旧会话：不把失败写进 B，也不把 B 的加载态打掉
      expect(store.olderError).toBeNull()
      expect(store.loadingOlder).toBe(true)

      resolveB(msgs(3, 217).reverse()) // m218..m220
      expect(await pendingB).toBe(true)
      expect(store.loadingOlder).toBe(false)
    })

    it('OQ-3｜切会话后旧请求成功返回：同样不清 B 的 loadingOlder', async () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      let resolveA!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveA = resolve
        })
      )
      const pendingA = store.loadOlderMessages()

      store.joinSession('s2')
      store.messages = msgs(20, 200)
      store.hasMoreOlder = true
      let resolveB!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveB = resolve
        })
      )
      const pendingB = store.loadOlderMessages()

      resolveA([]) // 旧会话确认到底——不得把 B 的 loadingOlder 一起收掉
      await pendingA
      expect(store.loadingOlder).toBe(true)

      resolveB([])
      await pendingB
      expect(store.loadingOlder).toBe(false)
    })

    it('OQ-3｜切回原会话不复用已被丢弃的旧请求（joinSession 必须清句柄）', async () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.messages = msgs(200) // m1..m200，切回来时缓存仍判「还有更早」
      store.hasMoreOlder = true
      let resolveA!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveA = resolve
        })
      )
      const pendingA = store.loadOlderMessages() // 发起后一直挂起

      store.joinSession('s2')
      store.joinSession('s1') // 切回：缓存命中，hasMoreOlder=true

      mockGetSessionMessages.mockReturnValueOnce([])
      await store.loadOlderMessages()

      // 旧 Promise 会按切会话判据丢弃；不清句柄就会把它当成 s1 的在途请求复用 → 这里只发过 1 次
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(2)
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(2, 's1', { before: 'm1', limit: 50 })

      resolveA([])
      await pendingA
    })

    it('C-5｜A→B→A 后旧请求成功返回：旧页不进 A 的数组，也不清 A 的 loadingOlder', async () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.messages = msgs(200) // m1..m200（缓存命中时仍判「还有更早」）
      store.hasMoreOlder = true
      let resolveOld!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveOld = resolve
        })
      )
      const pendingOld = store.loadOlderMessages() // 代际 0、会话 s1
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(1, 's1', { before: 'm1', limit: 50 })

      store.joinSession('s2') // 代际 1
      store.messages = msgs(20, 200)
      store.hasMoreOlder = true
      store.joinSession('s1') // 代际 2，缓存命中 → m1..m200
      expect(ids(store.messages)).toEqual(ids(msgs(200)))

      // A 重新开始一页（代际 2）——旧请求收尾时不许把它打掉
      let resolveNew!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveNew = resolve
        })
      )
      const pendingNew = store.loadOlderMessages()
      expect(store.loadingOlder).toBe(true)
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(2)

      // 旧请求现在返回：sessionId 已重新对上 s1，只有代际判据能挡住
      resolveOld(msgs(50, 900).reverse())
      expect(await pendingOld).toBe(false)
      expect(ids(store.messages)).toEqual(ids(msgs(200)))
      expect(store.loadingOlder).toBe(true)

      resolveNew([])
      expect(await pendingNew).toBe(true)
      expect(store.loadingOlder).toBe(false)
    })

    it('C-5｜A→B→A 后旧请求失败：不写 A 的 olderError，也不清 A 的 loadingOlder', async () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.messages = msgs(200)
      store.hasMoreOlder = true
      let rejectOld!: (err: Error) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((_, reject) => {
          rejectOld = reject
        })
      )
      const pendingOld = store.loadOlderMessages()

      store.joinSession('s2')
      store.messages = msgs(20, 200)
      store.hasMoreOlder = true
      store.joinSession('s1')

      let resolveNew!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveNew = resolve
        })
      )
      const pendingNew = store.loadOlderMessages()
      expect(store.loadingOlder).toBe(true)

      rejectOld(new Error('Failed to fetch'))
      expect(await pendingOld).toBe(false)
      // 旧世界的失败不得落到当前会话，也不得替当前请求收掉 loading
      expect(store.olderError).toBeNull()
      expect(store.loadingOlder).toBe(true)

      resolveNew([])
      await pendingNew
      expect(store.olderError).toBeNull()
      expect(store.loadingOlder).toBe(false)
    })

    it('C-5｜SESSION_HISTORY 整体替换历史后上滚：不复用旧 Promise，必须发新请求', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(200)
      store.hasMoreOlder = true
      let resolveOld!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveOld = resolve
        })
      )
      const pendingOld = store.loadOlderMessages() // 代际 0

      // 重连：服务端重发 SESSION_HISTORY，历史整体替换（代际 +1、句柄清空）
      sessionHistoryHandler()({ messages: msgs(200), welcome: welcome() })

      mockGetSessionMessages.mockReturnValueOnce([])
      const pending = store.loadOlderMessages()
      // 先同步判调用次数：若沿用旧句柄，这里拿到的就是那笔永不落定的旧 Promise
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(2)
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(2, 's1', { before: 'm1', limit: 50 })
      expect(await pending).toBe(true)

      resolveOld([])
      expect(await pendingOld).toBe(false)
    })

    it('C-7｜同会话重入（joinSession 同一 id）换代：旧请求不插页、不清新请求的 loadingOlder', async () => {
      // 首屏经 SESSION_HISTORY 落缓存，同 id 重入时能命中缓存恢复消息数组
      store.activeSessionId = 's1'
      sessionHistoryHandler()({ messages: msgs(20, 100), welcome: welcome() })
      const initialIds = ids(store.messages) // [welcome-s1, m101..m120]
      store.hasMoreOlder = true // 模拟长会话留口（首屏只有 20 条，不足一页）
      let resolveOld!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveOld = resolve
        })
      )
      const pendingOld = store.loadOlderMessages() // 代际 E、会话 s1
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(1, 's1', { before: 'm101', limit: 50 })
      expect(store.loadingOlder).toBe(true)

      // 用户在会话列表里点了当前会话：同 id、switching=false，仍必须换代（否则旧请求的 finally
      // 会看到 epoch 未变，把下面这笔新请求的 loadingOlder 清掉、并把旧页插进数组）
      store.joinSession('s1')
      expect(ids(store.messages)).toEqual(initialIds) // 命中缓存，同会话重入不清空
      store.hasMoreOlder = true // 缓存里的 20 条非合成消息不满一页，这里按长会话继续留口

      let resolveNew!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((resolve) => {
          resolveNew = resolve
        })
      )
      const pendingNew = store.loadOlderMessages()
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(2)
      expect(mockGetSessionMessages).toHaveBeenNthCalledWith(2, 's1', { before: 'm101', limit: 50 })
      expect(store.loadingOlder).toBe(true)

      // 旧代的页现在返回：sessionId 与当前会话相同，只有代际判据能挡住
      resolveOld(msgs(50, 50).reverse()) // m51..m100
      expect(await pendingOld).toBe(false)
      expect(ids(store.messages)).toEqual(initialIds) // 旧页未插入
      expect(store.loadingOlder).toBe(true) // 新请求的加载态不被旧请求收掉
      expect(store.olderError).toBeNull()

      // 新代请求正常落地
      resolveNew(msgs(50, 50).reverse()) // m51..m100
      expect(await pendingNew).toBe(true)
      expect(store.loadingOlder).toBe(false)
      expect(ids(store.messages).slice(0, 3)).toEqual(['welcome-s1', 'm51', 'm52'])
      expect(store.messages).toHaveLength(initialIds.length + 50)
    })

    it('C-4｜await 期间消息数组被替换：前插点重算到合成头之后，原消息不丢', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5, 10) // m11..m15
      store.hasMoreOlder = true
      let resolve!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((r) => {
          resolve = r
        })
      )
      const pending = store.loadOlderMessages()

      // 等待期间会话内交接重排头部（合成消息不落库）——请求发起时 realStart 还是 0
      store.messages = [{ ...mockMessage, id: 'handoff-s1', role: 'system' }, ...msgs(5, 10)]
      resolve(msgs(2, 0).reverse()) // m1,m2
      await pending

      expect(ids(store.messages)).toEqual([
        'handoff-s1',
        'm1',
        'm2',
        'm11',
        'm12',
        'm13',
        'm14',
        'm15',
      ])
    })

    it('C-4｜await 期间只剩合成消息：插入点落空时追加，不丢合成头', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5, 10)
      store.hasMoreOlder = true
      let resolve!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((r) => {
          resolve = r
        })
      )
      const pending = store.loadOlderMessages()

      store.messages = [{ ...mockMessage, id: 'welcome-s1', role: 'system' }]
      resolve(msgs(2, 0).reverse())
      await pending

      expect(ids(store.messages)).toEqual(['welcome-s1', 'm1', 'm2'])
    })

    it('D｜未加载目标：向前翻页到命中 → 发焦点信号并返回 true', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      mockGetSessionMessages
        .mockResolvedValueOnce(msgs(50, 50).reverse()) // m51..m100
        .mockResolvedValueOnce(msgs(50, 0).reverse()) // m1..m50

      const found = await store.revealMessage('m30') // 第 2 页才出现

      expect(found).toBe(true)
      expect(store.messages.some((m) => m.id === 'm30')).toBe(true)
      expect(store.focusMessageId).toBe('m30')
      expect(store.focusNonce).toBe(1)
    })

    it('reveal 在途：复用滚动已触发的同一次翻页，命中即返回 true（不空转到轮次上限）', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100) // m101..m120
      store.hasMoreOlder = true
      let resolve!: (rows: Message[]) => void
      mockGetSessionMessages.mockReturnValueOnce(
        new Promise<Message[]>((r) => {
          resolve = r
        })
      )

      const inFlight = store.loadOlderMessages() // 用户上滚触发的那一页
      const reveal = store.revealMessage('m90') // 目标正好落在这一页
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)

      resolve(msgs(50, 50).reverse()) // m51..m100
      expect(await reveal).toBe(true)
      expect(await inFlight).toBe(true)
      expect(store.focusMessageId).toBe('m90')
      // 在途请求被复用，没有为 reveal 再发一次同游标请求
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)
    })

    it('reveal 遇失败页：不空转到上限，当轮即返回 false', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      mockGetSessionMessages.mockRejectedValueOnce(new Error('Failed to fetch'))

      expect(await store.revealMessage('m90')).toBe(false)
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1)
      // 失败态留给 UI 重试入口，不用无进展的重试掩盖
      expect(store.olderError).toContain('HTTP 接口请求失败')
    })

    it('D｜已加载目标：直接发焦点信号，不再翻页', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(5)

      expect(await store.revealMessage('m3')).toBe(true)
      expect(store.focusMessageId).toBe('m3')
      expect(mockGetSessionMessages).not.toHaveBeenCalled()
    })

    it('D｜目标不存在：不死循环，轮次 ≤ 50 且返回 false', async () => {
      store.activeSessionId = 's1'
      store.messages = msgs(20, 100)
      store.hasMoreOlder = true
      // 每页都拿满 50 条新 id（hasMoreOlder 恒真）——只能靠轮次上限收敛
      let call = 0
      mockGetSessionMessages.mockImplementation(async () => msgs(50, 1000 + call++ * 50).reverse())

      const found = await store.revealMessage('m-not-exist')

      expect(found).toBe(false)
      expect(mockGetSessionMessages.mock.calls.length).toBeLessThanOrEqual(50)
      expect(mockGetSessionMessages.mock.calls.length).toBe(50)
    })

    it('切会话复位懒加载状态（不沿用旧会话的「还有更早」）', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'
      store.hasMoreOlder = true
      store.loadingOlder = true
      store.olderError = '上次失败'

      store.joinSession('s2')

      expect(store.hasMoreOlder).toBe(false)
      expect(store.loadingOlder).toBe(false)
      expect(store.olderError).toBeNull()
    })
  })

  // ─── T3：分组状态、动作与事件投影（会话管理 v2）────────────────────
  describe('T3 分组', () => {
    const groupsFixture = [
      {
        id: 'g1',
        name: '小说连载',
        collapsed: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sessionCount: 1,
      },
      {
        id: 'g2',
        name: '归档',
        collapsed: true,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        sessionCount: 0,
      },
    ]

    const grouped = (id: string, groupId: string | null, updatedAt: string): any => ({
      id,
      title: `会话 ${id}`,
      agentIds: ['a1'],
      broadcastMode: false,
      createdAt: updatedAt,
      updatedAt,
      groupId,
    })

    it('fetchGroups 写入活组（服务端序）', async () => {
      mockGetSessionGroups.mockResolvedValue({ groups: groupsFixture })
      await store.fetchGroups()
      expect(store.groups.map((g) => g.id)).toEqual(['g1', 'g2'])
    })

    it('fetchGroups 失败不抛错、不覆盖已有组（二级数据静默降级）', async () => {
      store.groups = groupsFixture
      mockGetSessionGroups.mockRejectedValue(new Error('boom'))
      await expect(store.fetchGroups()).resolves.toBeUndefined()
      expect(store.groups).toHaveLength(2)
    })

    it('fetchData 顺带拉组（独立失败域：组失败不阻断会话列表）', async () => {
      mockGetAgents.mockResolvedValue([])
      mockGetSessions.mockResolvedValue([mockSession])
      mockGetSessionGroups.mockResolvedValue({ groups: groupsFixture })
      await store.fetchData()
      expect(store.sessions).toHaveLength(1)
      expect(store.groups.map((g) => g.id)).toEqual(['g1', 'g2'])
    })

    it('moveSessionToGroup：只改 groupId，不重排（updatedAt 序不由前端触碰）', async () => {
      const a = grouped('s1', null, '2026-01-03T00:00:00.000Z')
      const b = grouped('s2', null, '2026-01-01T00:00:00.000Z')
      store.sessions = [a, b]
      mockMoveSessionToGroup.mockResolvedValue({ ...a, groupId: 'g1' })

      await store.moveSessionToGroup('s1', 'g1')

      expect(store.sessions.map((s) => s.id)).toEqual(['s1', 's2'])
      expect(store.sessions[0]!.groupId).toBe('g1')
      expect(store.sessions[0]!.updatedAt).toBe(a.updatedAt)
    })

    it('batchMoveToGroup：一次动作逐条 PATCH，全部成功后更新 groupId 且保持顺序', async () => {
      store.sessions = [
        grouped('s1', null, '2026-01-03T00:00:00.000Z'),
        grouped('s2', null, '2026-01-02T00:00:00.000Z'),
      ]
      mockMoveSessionToGroup.mockImplementation(async (id: string, groupId: string | null) => ({
        id,
        groupId,
      }))

      await store.batchMoveToGroup(['s1', 's2'], 'g1')

      expect(mockMoveSessionToGroup).toHaveBeenCalledTimes(2)
      expect(store.sessions.map((s) => s.id)).toEqual(['s1', 's2'])
      expect(store.sessions.every((s) => s.groupId === 'g1')).toBe(true)
    })

    it('deleteGroup(false) 仅解散：组消失、会话回未分组、顺序不变', async () => {
      store.groups = groupsFixture
      store.sessions = [grouped('s1', 'g1', '2026-01-03T00:00:00.000Z')]
      mockDeleteSessionGroup.mockResolvedValue({ mode: 'dissolve', id: 'g1' })

      await store.deleteGroup('g1', false)

      expect(mockDeleteSessionGroup).toHaveBeenCalledWith('g1', false)
      expect(store.groups.map((g) => g.id)).toEqual(['g2'])
      expect(store.sessions[0]!.groupId).toBeNull()
      expect(store.sessions[0]!.id).toBe('s1')
    })

    it('deleteGroup(true) 整组进回收站：同批会话移出列表、活跃会话切走', async () => {
      store.groups = groupsFixture
      store.sessions = [
        grouped('s1', 'g1', '2026-01-03T00:00:00.000Z'),
        grouped('s2', null, '2026-01-02T00:00:00.000Z'),
      ]
      store.activeSessionId = 's1'
      mockDeleteSessionGroup.mockResolvedValue({ mode: 'trash', id: 'g1' })
      // 活跃会话随组进回收站 → 切到 s2 触发 fetchSessions（第六条路径）：服务端只剩 s2
      mockGetSessions.mockResolvedValue([grouped('s2', null, '2026-01-02T00:00:00.000Z')])

      await store.deleteGroup('g1', true)

      expect(mockDeleteSessionGroup).toHaveBeenCalledWith('g1', true)
      expect(store.sessions.map((s) => s.id)).toEqual(['s2'])
      expect(store.activeSessionId).toBe('s2')
    })

    it('trashSessions 显式关闸：不落到旧物理 DELETE，逐条返回未启用', async () => {
      store.sessions = [
        grouped('s1', null, '2026-01-03T00:00:00.000Z'),
        grouped('s2', null, '2026-01-02T00:00:00.000Z'),
      ]

      // 默认 TRASH_ENABLED=true；显式传 false = T2 前守卫的等价值
      const failed = await store.trashSessions(['s1', 's2'], { enabled: false })

      // 关键判别力：关闸时一条删除 API 都不发
      expect(mockDeleteSession).not.toHaveBeenCalled()
      expect(failed).toEqual([
        { id: 's1', message: '回收站暂未启用' },
        { id: 's2', message: '回收站暂未启用' },
      ])
      expect(store.sessions.map((s) => s.id)).toEqual(['s1', 's2'])
    })

    it('逐条删除的部分失败：一条抛错不整批回滚，失败项带原因（T2 接线后复用）', async () => {
      const { removeSessionsSequentially } = await import('./chat.js')
      const remove = vi.fn(async (id: string) => {
        if (id === 's2') throw new Error('会话正在执行')
        return { ok: true }
      })

      const failed = await removeSessionsSequentially(['s1', 's2', 's1'], remove)

      // 去重后逐条执行：s1 成功、s2 失败；s1 不会被重复调用
      expect(remove.mock.calls).toEqual([['s1'], ['s2']])
      expect(failed).toEqual([{ id: 's2', message: '会话正在执行' }])
    })

    it('setGroupCollapsed：PATCH 落服务端并回写；失败回滚折叠态', async () => {
      store.groups = groupsFixture.map((g) => ({ ...g }))
      mockUpdateSessionGroup.mockResolvedValue({ ...groupsFixture[0]!, collapsed: true })

      await store.setGroupCollapsed('g1', true)

      expect(mockUpdateSessionGroup).toHaveBeenCalledWith('g1', { collapsed: true })
      expect(store.groups[0]!.collapsed).toBe(true)

      mockUpdateSessionGroup.mockRejectedValueOnce(new Error('boom'))
      await expect(store.setGroupCollapsed('g1', false)).rejects.toThrow('boom')
      expect(store.groups[0]!.collapsed).toBe(true)
    })

    it('移到折叠组 → 自动展开目标组（否则刚移过去的行立刻不可见）', async () => {
      store.groups = [
        { ...groupsFixture[1]!, collapsed: true },
        { ...groupsFixture[0]!, collapsed: false },
      ]
      store.sessions = [grouped('s1', null, '2026-01-03T00:00:00.000Z')]
      mockMoveSessionToGroup.mockResolvedValue({ id: 's1', groupId: 'g2' })
      mockUpdateSessionGroup.mockResolvedValue({ ...groupsFixture[1]!, collapsed: false })

      await store.moveSessionToGroup('s1', 'g2')

      expect(mockUpdateSessionGroup).toHaveBeenCalledWith('g2', { collapsed: false })
      expect(store.groups.find((g) => g.id === 'g2')!.collapsed).toBe(false)
    })

    it('移动到不存在的分组 → moveActionError 翻成人话（原始码不甩给用户）', async () => {
      const { moveActionError } = await import('./chat.js')
      expect(moveActionError({ body: { error: 'GROUP_NOT_FOUND' } })).toBe('分组不存在或已被删除')
      expect(moveActionError({ body: { error: 'SESSION_BUSY' } })).toBe('会话正在执行，无法移动')
    })

    it('批量删除部分失败：两条都点名、原因翻成人话（不吞第二条）', async () => {
      const { formatTrashFailures, trashFailureReason } = await import('./chat.js')
      const failed = [
        { id: 's1', message: trashFailureReason({ body: { error: 'SESSION_BUSY' } }) },
        { id: 's2', message: trashFailureReason({ body: { error: 'SESSION_BOUND' } }) },
      ]

      const text = formatTrashFailures(failed, (id) => (id === 's1' ? '甲会话' : '乙会话'))

      expect(text).toContain('2 个会话未能移入回收站')
      expect(text).toContain('「甲会话」正在执行')
      expect(text).toContain('「乙会话」已绑定外部群')
    })

    // ─── T4 回收站：单删撤销 / 两段投影 / 恢复清除 ───────────────────

    const trashEntry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
      kind: 'session',
      id: 's1',
      name: '会话 s1',
      deletedAt: '2026-01-05T00:00:00.000Z',
      purgeAfter: '2026-01-12T00:00:00.000Z',
      daysLeft: 7,
      sessionCount: 1,
      messageCount: 3,
      groupId: null,
      groupName: null,
      ...over,
    })

    it('fetchData 顺带拉回收站（头行回收站按钮的初值，独立失败域）', async () => {
      mockGetAgents.mockResolvedValue([])
      mockGetSessions.mockResolvedValue([mockSession])
      mockGetTrash.mockResolvedValue({
        entries: [trashEntry(), trashEntry({ kind: 'group', id: 'g1', name: '小说连载' })],
      })

      await store.fetchData()

      expect(store.trashEntries).toHaveLength(2)
    })

    it('单删成功 → 5 秒撤销 toast；撤销后会话按 updatedAt 插回列表', async () => {
      vi.useFakeTimers()
      try {
        const s1 = grouped('s1', null, '2026-01-03T00:00:00.000Z')
        const s2 = grouped('s2', null, '2026-01-02T00:00:00.000Z')
        store.sessions = [s1, s2]
        store.activeSessionId = 's1'
        mockDeleteSession.mockResolvedValue({
          id: 's1',
          deletedAt: '2026-01-05T00:00:00.000Z',
          purgeAfter: '2026-01-12T00:00:00.000Z',
        })
        mockRestoreSession.mockResolvedValue({ session: s1, groupId: null })
        mockGetSessions.mockResolvedValue([s1, s2])

        await store.trashSessions(['s1'], { undo: true })

        expect(store.undoToast).toMatchObject({ sessionId: 's1', daysLeft: 7 })
        expect(store.activeSessionId).toBe('s2')

        await store.undoLastTrash()

        expect(store.undoToast).toBeNull()
        expect(mockRestoreSession).toHaveBeenCalledWith('s1')
        expect(store.sessions.map((s) => s.id)).toEqual(['s1', 's2'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('撤销 toast 5 秒自动消失；新单删替换旧计时器', async () => {
      vi.useFakeTimers()
      try {
        store.sessions = [
          grouped('s1', null, '2026-01-03T00:00:00.000Z'),
          grouped('s2', null, '2026-01-02T00:00:00.000Z'),
        ]
        mockDeleteSession.mockResolvedValue({ id: 's1', deletedAt: 'x', purgeAfter: 'y' })

        await store.trashSessions(['s1'], { undo: true })
        vi.advanceTimersByTime(4999)
        expect(store.undoToast).not.toBeNull()
        vi.advanceTimersByTime(1)
        expect(store.undoToast).toBeNull()

        // 新单删开新窗口
        await store.trashSessions(['s2'], { undo: true })
        expect(store.undoToast).toMatchObject({ sessionId: 's2' })
        vi.advanceTimersByTime(4999)
        expect(store.undoToast).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('批量删除不提供撤销（只有单条行删除才开 toast）', async () => {
      store.sessions = [
        grouped('s1', null, '2026-01-03T00:00:00.000Z'),
        grouped('s2', null, '2026-01-02T00:00:00.000Z'),
      ]
      mockDeleteSession.mockResolvedValue({ id: 's1', deletedAt: 'x', purgeAfter: 'y' })

      await store.trashSessions(['s1', 's2'])

      expect(store.undoToast).toBeNull()
      expect(store.sessions).toEqual([])
    })

    it('恢复单条：条目移出回收站、会话回列表；404 时提示并重拉回收站（不静默）', async () => {
      const s1 = grouped('s1', null, '2026-01-03T00:00:00.000Z')
      store.trashEntries = [trashEntry()]
      mockRestoreSession.mockResolvedValueOnce({ session: s1, groupId: null })
      mockGetSessions.mockResolvedValue([{ ...s1, lastMessageAt: '2026-01-03T09:00:00.000Z' }])

      await store.restoreTrashSession('s1')
      await new Promise((r) => setTimeout(r, 0))

      expect(store.trashEntries).toEqual([])
      expect(store.sessions.map((s) => s.id)).toEqual(['s1'])

      // 已被另一 tab 清掉 → 404：可见提示 + 重拉
      store.trashEntries = [trashEntry({ id: 's9', name: '旧会话' })]
      mockRestoreSession.mockRejectedValueOnce({
        status: 404,
        message: '资源不存在：Session not in trash',
      })
      const ok = await store.restoreTrashSession('s9')
      await new Promise((r) => setTimeout(r, 0))

      expect(ok).toBe(false)
      expect(store.errorMessage).toContain('过期或已被清除')
      expect(mockGetTrash).toHaveBeenCalled()
    })

    it('恢复 / 撤销后重拉列表回填行内时间（恢复响应不带 lastMessageAt）', async () => {
      const s1 = grouped('s1', null, '2026-01-03T00:00:00.000Z')
      mockRestoreSession.mockResolvedValue({ session: s1, groupId: null })
      mockGetSessions.mockResolvedValue([{ ...s1, lastMessageAt: '2026-01-03T09:30:00.000Z' }])

      // 撤销路径：toast 指向刚删的会话
      store.sessions = [s1]
      store.undoToast = { sessionId: 's1', title: '会话 s1', daysLeft: 7 }
      expect(await store.undoLastTrash()).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions.find((s) => s.id === 's1')!.lastMessageAt).toBe(
        '2026-01-03T09:30:00.000Z'
      )

      // 恢复路径：从回收站恢复单条
      mockGetSessions.mockClear()
      store.sessions = []
      store.trashEntries = [trashEntry()]
      expect(await store.restoreTrashSession('s1')).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions.find((s) => s.id === 's1')!.lastMessageAt).toBe(
        '2026-01-03T09:30:00.000Z'
      )
    })

    it('恢复整组：同批会话回列表、组重拉（组名可能被改成「（恢复）」）', async () => {
      const s1 = grouped('s1', 'g1', '2026-01-03T00:00:00.000Z')
      store.trashEntries = [trashEntry({ kind: 'group', id: 'g1', name: '小说连载' })]
      mockRestoreSessionGroup.mockResolvedValue({ group: groupsFixture[0], sessions: [s1] })
      mockGetSessionGroups.mockResolvedValue({ groups: groupsFixture })
      mockGetSessions.mockResolvedValue([{ ...s1, lastMessageAt: '2026-01-03T08:00:00.000Z' }])

      const ok = await store.restoreTrashGroup('g1')
      await new Promise((r) => setTimeout(r, 0))

      expect(ok).toBe(true)
      expect(store.trashEntries).toEqual([])
      expect(store.sessions.map((s) => s.id)).toEqual(['s1'])
      expect(mockGetSessionGroups).toHaveBeenCalled()
      // 整组恢复同批回填行内时间：恢复响应不带 lastMessageAt，必须靠 fetchSessions
      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions[0]!.lastMessageAt).toBe('2026-01-03T08:00:00.000Z')
    })

    it('永久删除单条 / 清空回收站：条目同步移除', async () => {
      store.trashEntries = [trashEntry({ id: 's1' }), trashEntry({ id: 's2' })]
      mockPurgeSession.mockResolvedValue({ id: 's1' })

      expect(await store.purgeTrashSession('s1')).toBe(true)
      expect(store.trashEntries.map((e) => e.id)).toEqual(['s2'])

      mockEmptyTrash.mockResolvedValue({ purged: { groups: 0, sessions: 1 } })
      expect(await store.emptyTrash()).toBe(true)
      expect(store.trashEntries).toEqual([])
    })

    it('session-restored / session-purged 广播 → 列表与回收站投影（多 tab）', async () => {
      const s1 = grouped('s1', null, '2026-01-03T00:00:00.000Z')
      const s2 = grouped('s2', null, '2026-01-02T00:00:00.000Z')
      store.sessions = [s2]
      mockGetSessions.mockResolvedValue([s1, s2])
      const restored = mockOn.mock.calls.find((c) => c[0] === 'session-restored')?.[1] as (d: {
        groupId: string | null
        sessions: SessionConfig[]
      }) => void

      restored({ groupId: null, sessions: [s1] })
      await new Promise((r) => setTimeout(r, 0))

      expect(store.sessions.map((s) => s.id)).toEqual(['s1', 's2'])
      expect(mockGetTrash).toHaveBeenCalled()
      expect(mockGetSessions).toHaveBeenCalled()

      const purged = mockOn.mock.calls.find((c) => c[0] === 'session-purged')?.[1] as (d: {
        sessionIds: string[]
        groupIds: string[]
      }) => void
      purged({ sessionIds: ['s1'], groupIds: [] })
      expect(mockGetTrash).toHaveBeenCalledTimes(2)
    })

    it('另一 tab 恢复 / 清除同一条 → 本 tab 撤销 toast 自动撤（不留死入口）', () => {
      const restored = mockOn.mock.calls.find((c) => c[0] === 'session-restored')?.[1] as (d: {
        groupId: string | null
        sessions: SessionConfig[]
      }) => void
      store.undoToast = { sessionId: 's1', title: '会话 s1', daysLeft: 7 }
      restored({ groupId: null, sessions: [grouped('s1', null, '2026-01-03T00:00:00.000Z')] })
      expect(store.undoToast).toBeNull()

      const purged = mockOn.mock.calls.find((c) => c[0] === 'session-purged')?.[1] as (d: {
        sessionIds: string[]
        groupIds: string[]
      }) => void
      store.undoToast = { sessionId: 's2', title: '会话 s2', daysLeft: 7 }
      purged({ sessionIds: ['s2'], groupIds: [] })
      expect(store.undoToast).toBeNull()
    })

    it('fetchTrash 失败 → 保留旧条目并置错误态；下次成功清除错误', async () => {
      store.trashEntries = [trashEntry()]
      mockGetTrash.mockRejectedValueOnce(new Error('boom'))
      await store.fetchTrash()
      expect(store.trashLoadError).toBe('boom')
      // 失败不清空旧读数（旧条目好过伪装成「空的」）
      expect(store.trashEntries).toHaveLength(1)

      mockGetTrash.mockResolvedValueOnce({ entries: [] })
      await store.fetchTrash()
      expect(store.trashLoadError).toBeNull()
      expect(store.trashEntries).toEqual([])
    })

    it('删当前会话 → 切到下一条可见会话，跳过折叠组里的隐藏行', async () => {
      store.groups = [
        { ...groupsFixture[1]!, collapsed: true },
        { ...groupsFixture[0]!, collapsed: false },
      ]
      store.sessions = [
        grouped('hidden', 'g2', '2026-01-03T00:00:00.000Z'),
        grouped('visible', 'g1', '2026-01-02T00:00:00.000Z'),
        grouped('next', 'g1', '2026-01-01T00:00:00.000Z'),
      ]
      store.activeSessionId = 'visible'
      mockDeleteSession.mockResolvedValue({ ok: true })

      await store.deleteSession('visible')

      expect(store.activeSessionId).toBe('next')
    })

    it('删当前会话且剩余全在折叠组 → 空态，不切到不可见的行', async () => {
      store.groups = [{ ...groupsFixture[1]!, collapsed: true }]
      store.sessions = [
        grouped('hidden', 'g2', '2026-01-03T00:00:00.000Z'),
        grouped('visible', 'g2', '2026-01-02T00:00:00.000Z'),
      ]
      store.activeSessionId = 'visible'
      mockDeleteSession.mockResolvedValue({ ok: true })

      await store.deleteSession('visible')

      expect(store.activeSessionId).toBeNull()
    })

    it('session-trashed 广播 → 会话与组同时从列表移除（多 tab 投影，钉实际 wire 名）', () => {
      store.sessions = [
        grouped('s1', 'g1', '2026-01-03T00:00:00.000Z'),
        grouped('s2', 'g1', '2026-01-02T00:00:00.000Z'),
      ]
      store.groups = groupsFixture
      const handler = mockOn.mock.calls.find((c) => c[0] === 'session-trashed')?.[1] as (d: {
        sessionIds: string[]
        groupIds: string[]
      }) => void

      handler({ sessionIds: ['s1', 's2'], groupIds: ['g1'] })

      expect(store.sessions).toEqual([])
      expect(store.groups.map((g) => g.id)).toEqual(['g2'])
    })

    it('groups-changed 广播 → 组与会话双刷（另一 tab 移动会话后行落到新组）', async () => {
      store.groups = groupsFixture.map((g) => ({ ...g }))
      store.sessions = [grouped('s1', 'g1', '2026-01-03T00:00:00.000Z')]
      mockGetSessionGroups.mockResolvedValue({ groups: groupsFixture })
      mockGetSessions.mockResolvedValue([grouped('s1', 'g2', '2026-01-03T00:00:00.000Z')])
      const handler = mockOn.mock.calls.find((c) => c[0] === 'groups-changed')?.[1] as () => void

      handler()
      await new Promise((r) => setTimeout(r, 0))

      expect(mockGetSessionGroups).toHaveBeenCalled()
      expect(mockGetSessions).toHaveBeenCalled()
      expect(store.sessions[0]!.groupId).toBe('g2')
    })
  })
})

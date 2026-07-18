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

vi.mock('@/composables/useApi', () => ({
  api: {
    getAgents: mockGetAgents,
    getSessions: mockGetSessions,
    createSession: mockCreateSession,
    deleteSession: mockDeleteSession,
    deleteAgent: mockDeleteAgent,
    updateAgent: mockUpdateAgent,
    markSessionRead: mockMarkSessionRead,
  },
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
    it('sets activeSessionId and emits join event', () => {
      store.sessions = [mockSession]
      store.joinSession('s1')
      expect(store.activeSessionId).toBe('s1')
      // 欢迎消息被添加到 messages（因 agents 为空，显示通用指引）
      expect(store.messages).toHaveLength(1)
      expect(store.messages[0].role).toBe('system')
      expect(store.messages[0].id).toBe('welcome-s1')
      expect(mockEmit).toHaveBeenCalledWith(Events.JOIN_SESSION, 's1')
      expect(mockEmit).toHaveBeenCalledWith('get-agent-states')
    })

    it('syncs broadcast mode from session', () => {
      store.sessions = [{ ...mockSession, broadcastMode: true }]
      store.joinSession('s1')
      expect(store.broadcastMode).toBe(true)
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
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.NEW_MESSAGE,
      )?.[1] as ((msg: Message) => void) | undefined
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
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.NEW_MESSAGE,
      )?.[1] as ((msg: Message) => void) | undefined
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
        (call) => call[0] === Events.NEW_MESSAGE,
      )?.[1] as ((msg: Message) => void) | undefined

      expect(newMsgHandler).toBeDefined()
      newMsgHandler!(mockMessage)
      expect(store.messages).toEqual([mockMessage])
    })

    it('AGENT_TYPING sets typing state', () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.AGENT_TYPING,
      )?.[1] as ((data: any) => void) | undefined

      handler!({ agentId: 'a1', messageId: 'm1', content: 'hello...' })
      expect(store.typingStates.get('a1')).toEqual({
        agentId: 'a1',
        messageId: 'm1',
        content: 'hello...',
      })
    })

    it('AGENT_STATUS updates agent state map', () => {
      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.AGENT_STATUS,
      )?.[1] as ((data: any) => void) | undefined

      handler!({ agentId: 'a1', status: 'busy', sessionId: 's1', queueLength: 0 })
      expect(store.agentStates.get('a1')?.status).toBe('busy')
    })

    it('SESSION_DELETED removes session from list', () => {
      store.sessions = [mockSession, { ...mockSession, id: 's2' }]
      store.activeSessionId = 's1'

      const handler = mockOn.mock.calls.find(
        (call) => call[0] === Events.SESSION_DELETED,
      )?.[1] as ((data: any) => void) | undefined

      handler!({ sessionId: 's1' })
      expect(store.sessions).toHaveLength(1)
      expect(store.sessions[0].id).toBe('s2')
    })
  })
})

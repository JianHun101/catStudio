/**
 * socketio.ts 关键路径测试。
 *
 * 策略: mock 所有外部依赖，使用真实 SQLite (in-memory) 验证 DB 操作，
 * 捕获 on('connection') 回调中注册的 socket.on 处理器并直接调用。
 * 无需 socket.io-client 依赖。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { Events } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'

// ═══ Mock all external dependencies ═══

vi.mock('../dispatch/index.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  completeExecution: vi.fn(),
  initAgentSlot: vi.fn(),
  getAllAgentStates: vi.fn(() => []),
  getAgentState: vi.fn(() => null),
  cancelQueuedCommand: vi.fn(() => 0),
  isAnyAgentExecutingMessage: vi.fn(() => false),
  setAgentStateBridge: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => null),
}))

vi.mock('../memory/index.js', () => ({
  saveMessageMemory: vi.fn().mockResolvedValue(undefined),
  buildMemoryContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../handoff/index.js', () => ({
  performHandoff: vi.fn().mockResolvedValue(undefined),
  shouldHandoff: vi.fn(() => false),
  injectSummaryIntoSystem: vi.fn((msgs) => msgs),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  gitResetHard: vi.fn(),
  gitCleanWorkingTree: vi.fn(),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
  npmUninstall: vi.fn(),
}))

vi.mock('./a2a-mentions.js', () => ({
  parseMentionsFromReply: vi.fn(() => []),
}))

vi.mock('../skills/skill-loader.js', () => ({
  SkillLoader: class {
    async loadSkillModule() {
      return ''
    }
    async getCombinedSkillPrompt() {
      return ''
    }
  },
}))

// ═══ Test helpers ═══

/** 所有 socket.on 注册的 handler 收集于此 */
const socketHandlers = new Map<string, Function[]>()

/** 所有 io.on('connection') 注册的回调 */
let connectionCallback: ((socket: any) => void) | null = null

/** mock socket.emit — 测试用它验证 emit 了什么 */
const mockSocketEmit = vi.fn()

/** mock io.to().emit — 测试用它验证广播 */
const mockRoomEmit = vi.fn()

/** mock io.emit — 全局广播 */
const mockIoEmit = vi.fn()

/** mock socket.join */
const mockSocketJoin = vi.fn()

/** mock socket.leave */
const mockSocketLeave = vi.fn()

const mockSocket = {
  id: 'test-socket-id',
  join: mockSocketJoin,
  leave: mockSocketLeave,
  emit: mockSocketEmit,
  on: vi.fn((event: string, handler: Function) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, [])
    socketHandlers.get(event)!.push(handler)
    return mockSocket
  }),
}

const mockIo = {
  on: vi.fn((event: string, cb: any) => {
    if (event === 'connection') {
      connectionCallback = cb
    }
  }),
  to: vi.fn().mockReturnValue({ emit: mockRoomEmit }),
  emit: mockIoEmit,
}

// Mock socket.io module itself so createSocketIO returns our mockIo.
// 注意：不能用箭头函数——`new` 要求 constructor。
vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(function (this: any, _httpServer: any, _opts: any) {
    return mockIo
  }),
}))

describe('socketio connector', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    socketHandlers.clear()
    connectionCallback = null
    mockSocketEmit.mockClear()
    mockRoomEmit.mockClear()
    mockIoEmit.mockClear()
    mockSocketJoin.mockClear()

    // 设置测试 DB 并填入基础数据
    const db = createTestDb()
    setDb(db)
    initRepository(db)

    // Seed: 一个 agent
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run('agent-1', '店长', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')

    // Seed: 一个 session
    db.prepare(
      `
      INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
      VALUES (?, ?, ?, ?)
    `
    ).run('session-1', '测试会话', JSON.stringify(['agent-1']), 0)

    // 动态导入 socketio（Vitest 已处理 ts→js 映射 + mock 提前生效）
    const httpServer = createServer()
    const mod = await import('./socketio.js')
    mod.createSocketIO(httpServer)

    // 模拟客户端连接 → 触发 io.on('connection', ...) 回调
    expect(connectionCallback).not.toBeNull()
    connectionCallback!(mockSocket)
  })

  afterEach(() => {
    resetDb()
  })

  // ─── JOIN_SESSION ──────────────────────────

  describe('JOIN_SESSION', () => {
    it('joins the socket room and emits SESSION_HISTORY with welcome', () => {
      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      expect(handlers).toBeDefined()
      expect(handlers!.length).toBe(1)

      // 模拟客户端发送 JOIN_SESSION
      handlers![0]('session-1')

      // socket.join 被调用
      expect(mockSocketJoin).toHaveBeenCalledWith('session:session-1')

      // SESSION_HISTORY 被 emit 回客户端
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.SESSION_HISTORY,
        expect.objectContaining({
          messages: expect.any(Array),
          welcome: expect.objectContaining({
            sessionId: 'session-1',
            role: 'system',
          }),
        })
      )

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const data = call[1]
      expect(data.welcome.content).toContain('@店长')
      expect(data.welcome.role).toBe('system')
    })

    it('sends welcome without agent names when session has no agents', () => {
      // 创建无 agent 的 session
      getDb()
        .prepare("INSERT INTO sessions (id, title, agent_ids) VALUES (?, ?, '[]')")
        .run('session-empty', '空会话')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      handlers![0]('session-empty')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      expect(call[1].welcome.content).toContain('@猫咪名字')
      expect(call[1].welcome.content).not.toContain('@店长')
    })

    it('includes history messages in SESSION_HISTORY', () => {
      // 插入历史消息
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, ?, 'user', ?, '[]')
      `
      ).run('msg-1', 'session-1', '你好')
      db.prepare(
        `
        INSERT INTO messages (id, session_id, agent_id, role, content, mentions)
        VALUES (?, ?, ?, 'agent', ?, '[]')
      `
      ).run('msg-2', 'session-1', 'agent-1', '喵~')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const history = call[1].messages
      expect(history).toHaveLength(2)
      expect(history[0].role).toBe('user')
      expect(history[1].role).toBe('agent')
      // 确认 camelCase 转换
      expect(history[0].sessionId).toBe('session-1')
    })

    it('limits history to 200 messages', () => {
      const db = getDb()
      // 插入 250 条消息
      const insert = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', ?, '[]')
      `)
      for (let i = 0; i < 250; i++) {
        insert.run(`msg-${i}`, `消息 ${i}`)
      }

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      expect(call[1].messages.length).toBeLessThanOrEqual(200)
    })

    it('excludes system messages from history', () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'system', 'welcome', '[]')
      `
      ).run('sys-1')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const roles = call[1].messages.map((m: any) => m.role)
      expect(roles).not.toContain('system')
    })
  })

  // ─── LEAVE_SESSION ─────────────────────────

  describe('LEAVE_SESSION', () => {
    it('leaves the socket room', () => {
      const handlers = socketHandlers.get(Events.LEAVE_SESSION)
      expect(handlers).toBeDefined()

      handlers![0]('session-1')
      expect(mockSocketLeave).toHaveBeenCalledWith('session:session-1')
    })
  })

  // ─── SEND_MESSAGE ──────────────────────────

  describe('SEND_MESSAGE', () => {
    it('persists message to DB and broadcasts NEW_MESSAGE', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      expect(handlers).toBeDefined()

      await handlers![0]({
        sessionId: 'session-1',
        content: '你好 @店长',
        mentions: ['店长'],
      })

      // 消息已写入 DB
      const db = getDb()
      const row = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('session-1') as any
      expect(row).toBeDefined()
      expect(row.content).toBe('你好 @店长')
      expect(JSON.parse(row.mentions)).toEqual(['店长'])

      // NEW_MESSAGE 已广播到房间
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({
          sessionId: 'session-1',
          role: 'user',
          content: '你好 @店长',
        })
      )
    })

    it('emits ERROR when session does not exist (checked before INSERT)', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockSocketEmit.mockClear()

      // 不存在的 session → 先检查后拒绝，emit ERROR 而非抛 FK 异常
      await handlers![0]({
        sessionId: 'nonexistent',
        content: 'hello',
        mentions: [],
      })

      // 验证 emit ERROR 事件
      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: 'Session not found',
      })

      // 验证消息未写入（检查前就拦截了）
      const db = getDb()
      const row = db
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('nonexistent') as any
      expect(row.cnt).toBe(0)
    })

    it('broadcasts MESSAGE_AGENT_STATUS: queued for mentioned agents', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockRoomEmit.mockClear()

      await handlers![0]({
        sessionId: 'session-1',
        content: '你好 @店长',
        mentions: ['店长'],
      })

      // MESSAGE_AGENT_STATUS 已广播
      const statusCalls = mockRoomEmit.mock.calls.filter(
        (c: any[]) => c[0] === Events.MESSAGE_AGENT_STATUS
      )
      expect(statusCalls.length).toBeGreaterThanOrEqual(1)
      expect(statusCalls[0][1]).toMatchObject({
        agentName: '店长',
        status: 'queued',
      })
    })
  })

  // ─── MESSAGE_RETRACT ──────────────────────

  describe('MESSAGE_RETRACT', () => {
    it('emits ERROR when message does not exist', () => {
      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      expect(handlers).toBeDefined()

      handlers![0]({ sessionId: 'session-1', messageId: 'nonexistent' })

      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: '消息不存在或不是用户消息',
      })
    })

    it('emits ERROR when message is not a user message', () => {
      // Seed: agent 消息
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
        VALUES (?, ?, ?, 'agent', ?, '[]', datetime('now'))
      `
      ).run('agent-msg-1', 'session-1', 'agent-1', '喵')

      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      handlers![0]({ sessionId: 'session-1', messageId: 'agent-msg-1' })

      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: '消息不存在或不是用户消息',
      })
    })

    it('emits ERROR when message is not the latest user message', () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, created_at)
        VALUES (?, ?, 'user', ?, '[]', datetime('now', '-1 minute'))
      `
      ).run('old-user-msg', 'session-1', '旧消息')
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, created_at)
        VALUES (?, ?, 'user', ?, '[]', datetime('now'))
      `
      ).run('latest-user-msg', 'session-1', '最新消息')

      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      handlers![0]({ sessionId: 'session-1', messageId: 'old-user-msg' })

      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: '只能撤回最新一条消息',
      })
    })

    it('successfully retracts latest user message and broadcasts MESSAGE_RETRACTED', () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, created_at)
        VALUES (?, ?, 'user', ?, '[]', datetime('now'))
      `
      ).run('user-msg-retract', 'session-1', '撤回测试')

      // 验证消息存在
      let row = db.prepare('SELECT id FROM messages WHERE id = ?').get('user-msg-retract')
      expect(row).toBeDefined()

      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      mockSocketEmit.mockClear()
      mockIoEmit.mockClear()

      handlers![0]({ sessionId: 'session-1', messageId: 'user-msg-retract' })

      // 消息已从 DB 删除
      row = db.prepare('SELECT id FROM messages WHERE id = ?').get('user-msg-retract')
      expect(row).toBeUndefined()

      // MESSAGE_RETRACTED 已全局广播
      expect(mockIoEmit).toHaveBeenCalledWith(
        Events.MESSAGE_RETRACTED,
        expect.objectContaining({
          sessionId: 'session-1',
          messageId: 'user-msg-retract',
          agentReplyIds: expect.any(Array),
        })
      )
    })

    it('removes associated agent replies when retracting', () => {
      const db = getDb()

      // 用户消息
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, created_at)
        VALUES (?, ?, 'user', ?, '[]', datetime('now'))
      `
      ).run('user-msg-with-replies', 'session-1', '用户消息')

      // Agent 回复（created_at 在用户消息之后）
      db.prepare(
        `
        INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
        VALUES (?, ?, ?, 'agent', ?, '[]', datetime('now', '+1 second'))
      `
      ).run('agent-reply-1', 'session-1', 'agent-1', '回复 1')

      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      mockIoEmit.mockClear()

      handlers![0]({ sessionId: 'session-1', messageId: 'user-msg-with-replies' })

      // 用户消息和 agent 回复都被删除
      expect(
        db.prepare('SELECT id FROM messages WHERE id = ?').get('user-msg-with-replies')
      ).toBeUndefined()
      expect(
        db.prepare('SELECT id FROM messages WHERE id = ?').get('agent-reply-1')
      ).toBeUndefined()

      // MESSAGE_RETRACTED 包含 agent 回复 ID 列表
      const call = mockIoEmit.mock.calls.find((c: any[]) => c[0] === Events.MESSAGE_RETRACTED)!
      expect(call[1].agentReplyIds).toContain('agent-reply-1')
    })

    it('cleans up execution_logs when retracting', () => {
      const db = getDb()

      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, created_at)
        VALUES (?, ?, 'user', ?, '[]', datetime('now'))
      `
      ).run('user-msg-execlog', 'session-1', '测试')

      db.prepare(
        `
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
        VALUES (?, ?, ?, ?, 'running')
      `
      ).run('exec-1', 'session-1', 'agent-1', 'user-msg-execlog')

      const handlers = socketHandlers.get(Events.MESSAGE_RETRACT)
      handlers![0]({ sessionId: 'session-1', messageId: 'user-msg-execlog' })

      const execLog = db.prepare('SELECT id FROM execution_logs WHERE id = ?').get('exec-1')
      expect(execLog).toBeUndefined()
    })
  })

  // ─── TOGGLE_BROADCAST ──────────────────────

  describe('TOGGLE_BROADCAST', () => {
    it('updates broadcast_mode in DB and broadcasts change', () => {
      const handlers = socketHandlers.get(Events.TOGGLE_BROADCAST)
      expect(handlers).toBeDefined()

      handlers![0]({ sessionId: 'session-1', broadcastMode: true })

      // DB 已更新
      const db = getDb()
      const row = db
        .prepare('SELECT broadcast_mode FROM sessions WHERE id = ?')
        .get('session-1') as any
      expect(row.broadcast_mode).toBe(1)

      // BROADCAST_MODE_CHANGED 已广播到房间
      expect(mockRoomEmit).toHaveBeenCalledWith(Events.BROADCAST_MODE_CHANGED, {
        sessionId: 'session-1',
        broadcastMode: true,
      })
    })
  })

  // ─── get-agent-states ─────────────────────

  describe('get-agent-states', () => {
    it('emits all-agent-states with current agent states', () => {
      const handlers = socketHandlers.get('get-agent-states')
      expect(handlers).toBeDefined()

      handlers![0]()

      expect(mockSocketEmit).toHaveBeenCalledWith('all-agent-states', expect.any(Array))
    })
  })
})

// ═══ Pure utility functions (no DB/mock dependencies) ═══

import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  parseSkillModules,
} from './socketio.js'

describe('parseSkillModules', () => {
  it('returns empty array for null', () => {
    expect(parseSkillModules(null)).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(parseSkillModules('')).toEqual([])
  })

  it('parses JSON array of skills', () => {
    expect(parseSkillModules('["code-review","testing","docs"]')).toEqual([
      'code-review',
      'testing',
      'docs',
    ])
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseSkillModules('not-json')).toEqual([])
  })

  it('returns empty array for JSON that is not an array', () => {
    expect(parseSkillModules('{"key":"value"}')).toEqual([])
  })

  it('returns empty array for empty JSON array', () => {
    expect(parseSkillModules('[]')).toEqual([])
  })
})

describe('formatAudienceTag', () => {
  it('returns "对你" when agent is mentioned', () => {
    expect(formatAudienceTag(['店长', '服务员'], '店长')).toBe('对你')
  })

  it('returns "对大家" when agent is not mentioned', () => {
    expect(formatAudienceTag(['服务员'], '店长')).toBe('对大家')
  })

  it('returns "对大家" for empty mentions', () => {
    expect(formatAudienceTag([], '店长')).toBe('对大家')
  })
})

describe('formatAgentMessage', () => {
  it('formats basic agent message without mentions or model', () => {
    const result = formatAgentMessage('店长', '你好，我是店长。')
    expect(result).toBe('Direct message from 店长\n\n你好，我是店长。')
  })

  it('includes reply-to mentions', () => {
    const result = formatAgentMessage('服务员', '我来处理。', ['店长'])
    expect(result).toBe('Direct message from 服务员; reply to 店长\n\n我来处理。')
  })

  it('includes multiple mention targets', () => {
    const result = formatAgentMessage('吐槽猫', '代码已审查。', ['店长', '服务员'])
    expect(result).toBe('Direct message from 吐槽猫; reply to 店长, 服务员\n\n代码已审查。')
  })

  it('includes model when provided', () => {
    const result = formatAgentMessage('店长', '分析完成。', [], 'deepseek-v4-pro')
    expect(result).toBe('Direct message from 店长 [deepseek-v4-pro]\n\n分析完成。')
  })

  it('includes both model and mentions', () => {
    const result = formatAgentMessage('店长', '修正完毕。', ['吐槽猫'], 'claude-opus-4-8')
    expect(result).toBe('Direct message from 店长 [claude-opus-4-8]; reply to 吐槽猫\n\n修正完毕。')
  })
})

describe('formatUserMessage', () => {
  it('formats last user message with mentions and audience', () => {
    const result = formatUserMessage('你好', ['店长'], '对你', true)
    expect(result).toBe('用户（@了店长）对你：你好')
  })

  it('formats last user message without mentions', () => {
    const result = formatUserMessage('大家好啊', [], '对大家', true)
    expect(result).toBe('用户对大家：大家好啊')
  })

  it('formats non-last user message', () => {
    const result = formatUserMessage('上一句话', ['店长'], '对你', false)
    expect(result).toBe('用户（@了店长）：上一句话')
  })

  it('formats non-last message without mentions', () => {
    const result = formatUserMessage('普通消息', [], '对大家', false)
    expect(result).toBe('用户：普通消息')
  })

  it('joins multiple mention names', () => {
    const result = formatUserMessage('帮我看看', ['店长', '服务员', '吐槽猫'], '对大家', false)
    expect(result).toBe('用户（@了店长、服务员、吐槽猫）：帮我看看')
  })
})

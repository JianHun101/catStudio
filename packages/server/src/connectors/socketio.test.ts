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
  executeAgentCommand: vi.fn(),
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
  // 默认不重定向；AC3 测试里 mockReturnValue 命中子会话
  resolveHandoffTarget: vi.fn(() => null),
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
    static getInstance() {
      return new this()
    }
    async loadSkillModule() {
      return ''
    }
    async getCombinedSkillPrompt() {
      return ''
    }
    // 注意：matchAndBuild 是同步方法（skill-loader.ts:144），
    // 若 mock 成 async 会返回 Promise，解构得到 undefined
    matchAndBuild(prompt: string) {
      return { prompt, matchedSkills: [] }
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

    it('includes images in history messages (refresh roundtrip)', () => {
      // 插入一条带图片的用户消息 + 一条纯文本消息（模拟前端粘贴图片后发送）
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions, images)
        VALUES (?, 'session-1', 'user', '带图消息', '[]', ?)
      `
      ).run('img-msg-1', JSON.stringify(['data:image/png;base64,CCCC']))
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', '纯文本消息', '[]')
      `
      ).run('plain-msg-1')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      // 图片已随历史消息返回（camelCase images 数组）
      const imgMsg = call[1].messages.find((m: any) => m.id === 'img-msg-1')
      expect(imgMsg).toBeDefined()
      expect(imgMsg.images).toEqual(['data:image/png;base64,CCCC'])
      // 无图片的消息不携带 images 字段（与 NEW_MESSAGE 广播行为一致）
      const plainMsg = call[1].messages.find((m: any) => m.id === 'plain-msg-1')
      expect(plainMsg.images).toBeUndefined()
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

    it('persists images to DB and broadcasts them with NEW_MESSAGE', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockRoomEmit.mockClear()

      await handlers![0]({
        sessionId: 'session-1',
        content: '看看这张图',
        mentions: [],
        images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
      })

      // 图片已写入 DB（JSON 数组）
      const db = getDb()
      const row = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('session-1') as any
      expect(JSON.parse(row.images)).toEqual([
        'data:image/png;base64,AAAA',
        'data:image/png;base64,BBBB',
      ])

      // NEW_MESSAGE 广播携带 images
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({
          images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
        })
      )
    })

    it('truncates images to 4 and drops oversized ones (server guard)', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockRoomEmit.mockClear()

      const oversized = `data:image/png;base64,${'x'.repeat(4 * 1024 * 1024)}`
      await handlers![0]({
        sessionId: 'session-1',
        content: '防滥用',
        mentions: [],
        images: [
          'data:image/png;base64,1',
          'data:image/png;base64,2',
          'data:image/png;base64,3',
          'data:image/png;base64,4',
          'data:image/png;base64,5', // 第 5 张被截断
          oversized, // 超 3MB 被过滤
        ],
      })

      const db = getDb()
      const row = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('session-1') as any
      const stored: string[] = JSON.parse(row.images)
      expect(stored).toHaveLength(4)
      expect(stored).not.toContain('data:image/png;base64,5')
      expect(stored).not.toContain(oversized)
    })

    it('filters out strings without data:image/ prefix', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockRoomEmit.mockClear()

      await handlers![0]({
        sessionId: 'session-1',
        content: '防垃圾',
        mentions: [],
        images: ['data:image/png;base64,OK', 'not-an-image', 'javascript:alert(1)'],
      })

      const db = getDb()
      const row = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('session-1') as any
      expect(JSON.parse(row.images)).toEqual(['data:image/png;base64,OK'])
    })

    it('AC3: 发往已交接旧会话 → 消息落子会话，广播子房间 + 旧房间 SESSION_HANDOFF + dispatch 子会话', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      mockRoomEmit.mockClear()
      ;(mockIo.to as any).mockClear()

      // fixture: 真实子会话 child-session（1 条消息）挂在 session-1 下
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, handoff_from, running_summary)
         VALUES (?, 'child', '[]', 'session-1', ?)`
      ).run('child-session', JSON.stringify({ text: '总结' }))
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run('m-child-1', 'child-session')

      // 路由兜底命中：session-1 → child-session
      const { resolveHandoffTarget, performHandoff } = await import('../handoff/index.js')
      ;(resolveHandoffTarget as any).mockReturnValue({
        oldSessionId: 'session-1',
        newSessionId: 'child-session',
        summary: '总结',
      })

      await handlers![0]({
        sessionId: 'session-1',
        content: '还在吗 @店长',
        mentions: ['店长'],
      })

      // 消息落子会话，旧会话无新消息
      const row = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('child-session') as any
      expect(row).toBeDefined()
      expect(row.content).toBe('还在吗 @店长')
      const oldCnt = db
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('session-1') as any
      expect(oldCnt.cnt).toBe(0)

      // NEW_MESSAGE 广播到子会话房间
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ sessionId: 'child-session', role: 'user' })
      )

      // SESSION_HANDOFF 发旧房间（session:session-1），payload 完整
      const roomEmitCalls = mockRoomEmit.mock.calls as Array<[string, any]>
      const handoffIdx = roomEmitCalls.findIndex((c) => c[0] === Events.SESSION_HANDOFF)
      expect(handoffIdx).toBeGreaterThanOrEqual(0)
      const toCalls = (mockIo.to as any).mock.calls.map((c: any[]) => c[0])
      expect(toCalls[handoffIdx]).toBe('session:session-1')
      expect(roomEmitCalls[handoffIdx][1]).toEqual({
        oldSessionId: 'session-1',
        newSessionId: 'child-session',
        summary: '总结',
      })

      // dispatch 用子会话（agents 从子会话取，子会话 agent_ids='[]' → 不触发执行）
      const { dispatch } = await import('../dispatch/index.js')
      expect(dispatch).toHaveBeenCalledWith(
        'child-session',
        expect.objectContaining({ sessionId: 'child-session' }),
        expect.any(Array),
        expect.any(String)
      )
      // performHandoff 未被调用——路由兜底只重定向，不重复交接
      expect(performHandoff).not.toHaveBeenCalled()
    })
  })

  // ─── executeAgentsSerial 双执行防护 ──────────
  // 回归测试：08:43:15 双补填事故 — 同一条消息被 executeAgentsSerial
  // 立即执行一次、队列排空又执行一次，产生两条重复回复。

  describe('executeAgentsSerial — 双执行防护', () => {
    const agentCfg = {
      id: 'agent-1',
      name: '店长',
      avatar: '🐱',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: 'sk-test',
    }

    it('agent 正在处理消息 A 时，消息 B 不应立即执行（留在队列等排空）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState } = await import('../dispatch/index.js')

      // 模拟：dispatch 已把 A 标记到槽位（busy + currentTrigger=A），B 在 FIFO 队列
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 1,
        currentTriggerMessageId: 'msg-A',
      })
      mockRoomEmit.mockClear()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [agentCfg as any],
        { id: 'msg-B', content: '@店长 补填文档', mentions: ['店长'] },
        'trace-double-exec'
      )

      // B 未执行：无 thinking/replying 状态事件，也无任何 NEW_MESSAGE
      const emitted = mockRoomEmit.mock.calls.map((c: any[]) => c[0])
      expect(emitted).not.toContain(Events.MESSAGE_AGENT_STATUS)
      expect(emitted).not.toContain(Events.NEW_MESSAGE)
    })

    it('completeExecution 弹出队列后（currentTrigger 已更新为 B），B 正常执行', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState } = await import('../dispatch/index.js')

      // 模拟：A 已完成，completeExecution 弹出 B 并更新 currentTrigger=B
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-B',
      })
      mockRoomEmit.mockClear()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [agentCfg as any],
        { id: 'msg-B', content: '@店长 补填文档', mentions: ['店长'] },
        'trace-double-exec-2'
      )

      // B 被执行：至少出现 thinking 状态（registry mock 返回 null adapter，
      // runAgentReply 会在 chatStream 处失败并 emit 错误 NEW_MESSAGE）
      const emitted = mockRoomEmit.mock.calls.map((c: any[]) => c[0])
      expect(emitted).toContain(Events.MESSAGE_AGENT_STATUS)
    })
  })

  // ─── MAX_MENTIONS_PER_AGENT 限流语义 ──────────
  // 回归测试：be5d861 将 mention 计数从"进入执行循环"改为"实际执行成功"。
  // 守护两个语义：
  //  ① 已执行 ≥MAX 次的 agent 不再被 A2A 调度（防无限循环仍在）
  //  ② 未执行（busy/currentTrigger 不匹配跳过）的 mention 不消耗配额

  describe('MAX_MENTIONS_PER_AGENT — mention 限流语义', () => {
    const execAgentCfg = {
      id: 'agent-1',
      name: '店长',
      avatar: '🐱',
      systemPrompt: 'You are a cat.',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      llmApiKey: 'sk-test',
    }

    beforeEach(async () => {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue(undefined)
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockImplementation(() => null as any)
      const mod = await import('./socketio.js')
      mod.__test_resetMentionCounts()
    })

    /** 在 session-1 中加入第二个 agent（吐槽猫），供 A2A 过滤测试使用 */
    function seedSecondAgent(db: any) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('agent-2', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-flash', 'sk-test')
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(['agent-1', 'agent-2'])
      )
    }

    it('未执行的 mention 不消耗配额——跳过多次后正常执行只计 1 次', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')

      // 多次调度但 currentTrigger 不匹配（agent 正忙于其他消息）→ 全部跳过
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-other',
      })
      // depth=1 绕过 depth=0 的 trace 清理，才能在调用后断言计数
      for (let i = 0; i < 5; i++) {
        await mod.executeAgentsSerial(
          mockIo as any,
          'session-1',
          [execAgentCfg as any],
          { id: `msg-skip-${i}`, content: '@店长 x', mentions: ['店长'] },
          'trace-quota',
          1
        )
      }
      // 跳过 5 次，计数仍为 0（未执行的 mention 不消耗配额）
      expect(mod.__getMentionCount('trace-quota', 'agent-1')).toBe(0)

      // currentTrigger 匹配 → 正常执行成功 → 计数 +1
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-run',
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到', kind: 'text' }
        }),
      } as any)
      // 触发消息必须存在于 DB，否则 runAgentReply 的 Window ② 撤回保护
      // （!messageExists → retracted）会在 LLM 调用前提前返回，不走 adapter
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-run', 'session-1', '收到请处理')
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-run', content: '@店长 x', mentions: ['店长'] },
        'trace-quota',
        1
      )

      // 只计成功执行的 1 次，而非 1 + 5 次跳过
      expect(mod.__getMentionCount('trace-quota', 'agent-1')).toBe(1)
    })

    it('已执行 ≥MAX 次的 agent 不再被 A2A 调度（过滤）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')

      seedSecondAgent(getDb())

      // 店长执行成功，回复 @吐槽猫 → A2A 尝试调度吐槽猫
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      }))
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '@吐槽猫 请审查', kind: 'text' }
        }),
      } as any)
      vi.mocked(parseMentionsFromReply).mockReturnValue(['吐槽猫'])

      // 触发消息必须存在于 DB（Window ② 撤回保护），否则提前返回不走 adapter
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', '@店长 派活')

      // 对照组：吐槽猫计数 2（未达上限）→ 正常调度
      mod.__test_resetMentionCounts()
      mod.__setMentionCount('trace-limit-ok', 'agent-2', 2)
      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-limit-ok'
      )
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-2' })]),
        'trace-limit-ok'
      )

      // 目标组：吐槽猫计数 3（已达上限）→ 过滤，不调度
      // trigger id 必须为 'msg-trigger'（与 mock 的 currentTriggerMessageId 匹配），
      // 否则 agent 在状态检查（:615）处 continue 跳过，A2A 过滤分支永不执行——
      // dispatch 不被调用只是"agent 没干活"的必然结果，断言空洞通过
      mod.__test_resetMentionCounts()
      mod.__setMentionCount('trace-limit-full', 'agent-2', 3)
      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-limit-full'
      )
      expect(dispatch).not.toHaveBeenCalled()
    })
  })

  // ─── recoverInterruptedExecutions 重启恢复队列 ──────────
  // 回归测试：server 重启时 dispatch 的 in-memory 队列被清空，正在执行的 agent
  // 被 fixStuckExecutionLogs 标记为 failed/server_restart，其触发消息永远不会
  // 再被处理（"投递到了但接收端从未处理"事故根因）。启动时应重新 dispatch 这些执行。

  describe('recoverInterruptedExecutions — 重启恢复队列', () => {
    // 前置测试（双执行防护）用 mockReturnValue 设置了 getAgentState 的返回值，
    // vi.clearAllMocks 不清除 mockReturnValue——这里显式重置为 null
    // （槽位未初始化 = 需要 initAgentSlot 的状态）。
    beforeEach(async () => {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue(undefined)
    })

    /** 造数据：被中断的执行日志 + 可选触发消息/回复 */
    function seedInterruptedExecution(
      db: any,
      opts: { triggerExists?: boolean; agentReplied?: boolean } = {}
    ) {
      if (opts.triggerExists !== false) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
           VALUES (?, ?, 'user', ?, '["店长"]', datetime('now', '-2 minutes'))`
        ).run('msg-trigger', 'session-1', '@店长 请补填交接文档')
      }
      if (opts.agentReplied) {
        db.prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, 'agent', ?, '[]', datetime('now', '-1 minute'))`
        ).run('msg-reply', 'session-1', 'agent-1', '已补填')
      }
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, error_message, started_at)
         VALUES (?, ?, ?, ?, 'failed', 'server_restart', datetime('now', '-1 minute'))`
      ).run('exec-1', 'session-1', 'agent-1', 'msg-trigger')
    }

    it('server_restart 记录 + 触发消息存在 + 未回复 → 重新执行该 agent', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand, initAgentSlot } = await import('../dispatch/index.js')
      seedInterruptedExecution(getDb())

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
      expect(executeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1', name: '店长' }),
        expect.objectContaining({
          sessionId: 'session-1',
          agentId: 'agent-1',
          triggerMessageId: 'msg-trigger',
          triggerContent: '@店长 请补填交接文档',
          mentions: ['店长'],
        }),
        expect.any(String)
      )
      expect(initAgentSlot).toHaveBeenCalledWith('agent-1')
    })

    it('触发消息已删（会话/消息被清理）→ 跳过恢复', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      seedInterruptedExecution(getDb(), { triggerExists: false })

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).not.toHaveBeenCalled()
    })

    it('agent 已回复（重启发生在回复写库后、finalize 前）→ 跳过，防重复执行', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      seedInterruptedExecution(getDb(), { agentReplied: true })

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).not.toHaveBeenCalled()
    })

    it('无 API key 的 agent → 跳过（无法执行）', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      getDb()
        .prepare('UPDATE agents SET llm_api_key = ? WHERE id = ?')
        .run('sk-your-api-key-here', 'agent-1')
      seedInterruptedExecution(getDb())

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).not.toHaveBeenCalled()
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
    expect(formatAudienceTag(['店长', 'ds猫'], '店长')).toBe('对你')
  })

  it('returns "对大家" when agent is not mentioned', () => {
    expect(formatAudienceTag(['ds猫'], '店长')).toBe('对大家')
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
    const result = formatAgentMessage('ds猫', '我来处理。', ['店长'])
    expect(result).toBe('Direct message from ds猫; reply to 店长\n\n我来处理。')
  })

  it('includes multiple mention targets', () => {
    const result = formatAgentMessage('吐槽猫', '代码已审查。', ['店长', 'ds猫'])
    expect(result).toBe('Direct message from 吐槽猫; reply to 店长, ds猫\n\n代码已审查。')
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
    const result = formatUserMessage('帮我看看', ['店长', 'ds猫', '吐槽猫'], '对大家', false)
    expect(result).toBe('用户（@了店长、ds猫、吐槽猫）：帮我看看')
  })
})

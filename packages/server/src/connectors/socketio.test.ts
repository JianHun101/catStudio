/**
 * socketio.ts 关键路径测试。
 *
 * 策略: mock 所有外部依赖，使用真实 SQLite (in-memory) 验证 DB 操作，
 * 捕获 on('connection') 回调中注册的 socket.on 处理器并直接调用。
 * 无需 socket.io-client 依赖。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Events } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { RESTART_REQUEST_FILE, RESTART_DONE_FILE } from '../restart-request.js'
import type { AgentReplyMessage } from './replyBus.js'

// ═══ Mock all external dependencies ═══

vi.mock('../dispatch/index.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  completeExecution: vi.fn(),
  initAgentSlot: vi.fn(),
  getAllAgentStates: vi.fn(() => []),
  getAgentState: vi.fn(() => null),
  cancelQueuedCommand: vi.fn(() => 0),
  clearAgentQueue: vi.fn(() => 0),
  isAnyAgentExecutingMessage: vi.fn(() => false),
  setAgentStateBridge: vi.fn(),
  setSystemMessageBridge: vi.fn(),
  executeAgentCommand: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => null),
}))

vi.mock('../memory/index.js', () => ({
  saveMessageMemory: vi.fn().mockResolvedValue(undefined),
  buildMemoryContext: vi.fn().mockResolvedValue(''),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
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

// 包装 insertUserMessage 为可注入失败的 spy——默认走真实实现（现有测试零影响），
// 审查反馈 #1 的用例里 mockImplementationOnce 模拟 FK 异常
vi.mock('../db/repository/messages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repository/messages.js')>()
  return {
    ...actual,
    insertUserMessage: vi.fn(actual.insertUserMessage),
  }
})

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  gitResetHard: vi.fn(),
  gitCleanWorkingTree: vi.fn(),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
  npmUninstall: vi.fn(),
}))

// 顶层收尾的脏文件清理（socketio.ts:1152-1161）用真实 execSync 跑 git status/checkout/clean
// ——测试跑批时工作区含未提交改动（如正在写的测试文件），任何 Claude agent 用例
// （anyClaude=true）触发清理会真实执行 `git checkout -- .` 抹掉未提交工作。
// 边界 mock：execSync 恒返回空串（工作区"干净"→ 清理跳过），其余 child_process 能力
// （spawn/exec 等）保持真实，不影响其他模块。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn(() => ''),
  }
})

vi.mock('./a2a-mentions.js', () => ({
  parseMentionsFromReply: vi.fn(() => []),
  // M1/M3 防线：默认不响（检测函数本体在 a2a-mentions.test.ts 单独测），
  // 防线的接线（告警 + 频控）用专门用例覆盖
  detectUnknownHandle: vi.fn(() => null),
  detectInlineMentions: vi.fn(() => []),
}))

// MCP 路由信号：默认无信号（标签匹配/消费语义在 route-signals.test.ts 单独测），
// 合并点用例按测试预置 mock 返回
vi.mock('../llm/route-signals.js', () => ({
  consumeRouteSignals: vi.fn(() => []),
}))

// MCP 用户请求信号（request_user_action）：默认无信号（标签匹配/消费语义在
// user-request-signals.test.ts 单独测），重启合并点用例按测试预置 mock 返回
vi.mock('../llm/user-request-signals.js', () => ({
  consumeUserRequestSignals: vi.fn(() => []),
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
    // 清理重启机制文件（正常用例不产生；重启用例防残留污染下个用例的启动广播/状态推送断言）
    // 注：路径由 vitest env RESTART_FILES_DIR 隔离到 node_modules/.cache/restart-test——
    // 此清理只碰隔离目录，不再误删运行时真实请求文件（17:38 事故根因）
    try {
      if (existsSync(RESTART_REQUEST_FILE)) unlinkSync(RESTART_REQUEST_FILE)
      if (existsSync(RESTART_DONE_FILE)) unlinkSync(RESTART_DONE_FILE)
    } catch {}
  })

  it('重启机制文件路径被隔离到 node_modules/.cache（测试跑批不碰运行时真实文件）', () => {
    // 防回归：若有人删除 vitest.config.ts 的 RESTART_FILES_DIR env 或该 env 失效，
    // 此断言会失败——afterEach 清理将与运行时 server 共享路径（17:38 事故模式）
    // 用隔离目录名作平台无关标识（Windows 分隔符是反斜杠，不能断言 '/' 拼写的完整路径）
    expect(RESTART_REQUEST_FILE).toContain('restart-test')
    expect(RESTART_DONE_FILE).toContain('restart-test')
  })

  /** 写一个重启请求文件（模拟店长消息触发 ingest 写入） */
  function writeRestartRequest(overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      RESTART_REQUEST_FILE,
      JSON.stringify({
        messageId: 'msg-restart',
        sessionId: 'session-1',
        reason: '测试重启',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        state: 'pending',
        ...overrides,
      })
    )
  }

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

    it('includes system messages in history (重启完成需刷新后可见)', () => {
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
      expect(roles).toContain('system')
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

    it('历史恢复只给当前生效请求的消息附加 restart 类型（其他 restart 消息不带 → 无幽灵按钮）', () => {
      // 当前生效请求：文件 messageId=msg-restart 与历史消息 id 匹配
      writeRestartRequest()
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', '【重启请求】原因：当前请求', '[]')
      `
      ).run('msg-restart')
      // 非当前请求：更早的历史 restart 消息（文件 messageId 不匹配）
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', '【重启请求】原因：历史请求', '[]')
      `
      ).run('msg-restart-old')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const current = call[1].messages.find((m: any) => m.id === 'msg-restart')
      const old = call[1].messages.find((m: any) => m.id === 'msg-restart-old')
      // 当前请求 → 带类型 + 文件 expiresAt
      expect(current.messageType).toBe('restart_request')
      expect(current.restartExpiresAt).toBe(
        JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8')).expiresAt
      )
      // 历史非当前请求 → 不带类型（幽灵按钮消失）
      expect(old.messageType).toBeUndefined()
      expect(old.restartExpiresAt).toBeUndefined()
    })

    it('请求文件属于其他会话 → 本会话 restart 历史消息不带类型', () => {
      writeRestartRequest({ sessionId: 'session-other' })
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', '【重启请求】原因：本会话请求', '[]')
      `
      ).run('msg-restart')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const m = call[1].messages.find((x: any) => x.id === 'msg-restart')
      expect(m.messageType).toBeUndefined()
      expect(m.restartExpiresAt).toBeUndefined()
    })

    it('无请求文件 → restart 前缀历史消息全不带类型', () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO messages (id, session_id, role, content, mentions)
        VALUES (?, 'session-1', 'user', '【重启请求】原因：无文件请求', '[]')
      `
      ).run('msg-restart')

      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const m = call[1].messages.find((x: any) => x.id === 'msg-restart')
      expect(m.messageType).toBeUndefined()
      expect(m.restartExpiresAt).toBeUndefined()
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

    it('审查反馈#1: INSERT 失败 → emit ERROR 且不广播 NEW_MESSAGE（就地捕获，不崩进程）', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      const messagesMod = await import('../db/repository/messages.js')
      // 模拟 FK 异常（resolveHandoffTarget 返回与 INSERT 之间子会话被并发删除）
      vi.mocked(messagesMod.insertUserMessage).mockImplementationOnce(() => {
        throw new Error('FOREIGN KEY constraint failed')
      })
      mockSocketEmit.mockClear()
      mockRoomEmit.mockClear()

      // handler 不抛异常（async 就地捕获）——抛了测试本身就会红
      await handlers![0]({
        sessionId: 'session-1',
        content: '写入会失败',
        mentions: [],
      })

      // emit ERROR 提示用户
      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: '消息写入失败，请重试',
      })
      // 消息未落库，不得广播 NEW_MESSAGE
      const newMsgCalls = mockRoomEmit.mock.calls.filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
      expect(newMsgCalls).toHaveLength(0)
    })

    it('审查反馈#1: 重定向命中但 INSERT 失败 → 不 emit SESSION_HANDOFF（先落库后通知）', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      const messagesMod = await import('../db/repository/messages.js')
      vi.mocked(messagesMod.insertUserMessage).mockImplementationOnce(() => {
        throw new Error('FOREIGN KEY constraint failed')
      })
      mockSocketEmit.mockClear()
      mockRoomEmit.mockClear()

      // fixture: 真实子会话挂在 session-1 下
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, handoff_from, running_summary)
         VALUES (?, 'child', '[]', 'session-1', ?)`
      ).run('child-session-2', JSON.stringify({ text: '总结2' }))
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run('m-child-2', 'child-session-2')

      // 路由兜底命中：session-1 → child-session-2
      const { resolveHandoffTarget } = await import('../handoff/index.js')
      ;(resolveHandoffTarget as any).mockReturnValue({
        oldSessionId: 'session-1',
        newSessionId: 'child-session-2',
        summary: '总结2',
      })

      await handlers![0]({
        sessionId: 'session-1',
        content: '写不进',
        mentions: [],
      })

      // 写入失败 → 前端不应收到切换信号（切过去但消息丢了）
      const roomEmitCalls = mockRoomEmit.mock.calls as Array<[string, any]>
      expect(roomEmitCalls.find((c) => c[0] === Events.SESSION_HANDOFF)).toBeUndefined()
      expect(mockSocketEmit).toHaveBeenCalledWith(Events.ERROR, {
        message: '消息写入失败，请重试',
      })
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
        'trace-limit-ok',
        1 // A2A 入队命令带 depth+1（冻结改动：命令自持 depth 语义）
      )

      // 目标组：吐槽猫计数 5（已达上限）→ 过滤，不调度
      // trigger id 必须为 'msg-trigger'（与 mock 的 currentTriggerMessageId 匹配），
      // 否则 agent 在状态检查（:615）处 continue 跳过，A2A 过滤分支永不执行——
      // dispatch 不被调用只是"agent 没干活"的必然结果，断言空洞通过
      mod.__test_resetMentionCounts()
      mod.__setMentionCount('trace-limit-full', 'agent-2', 5)
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

    it('用户顶层触发（depth=0）不消耗配额；A2A（depth=1）执行才计数', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')

      // currentTrigger 匹配 → 正常执行成功
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-user',
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
        .run('msg-user', 'session-1', '收到请处理')

      // depth=0（用户 @ 顶层触发）执行成功 → 不消耗配额。
      // 注：depth=0 结束后顶层清理会删除本 trace 的全部计数键（:699-704），
      // 断言 0 是"无残留、未污染后续 trace"的终态检查
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-user', content: '@店长 x', mentions: ['店长'] },
        'trace-user',
        0
      )
      expect(mod.__getMentionCount('trace-user', 'agent-1')).toBe(0)

      // depth=1（A2A 链路）执行成功 → 计数 +1（防循环防护保留）
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-a2a',
      })
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-a2a', 'session-1', '收到请处理')
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-a2a', content: '@店长 x', mentions: ['店长'] },
        'trace-a2a',
        1
      )
      expect(mod.__getMentionCount('trace-a2a', 'agent-1')).toBe(1)
    })

    it('P4 #3: A2A 链回复（depth=1）同样触发 replyBus 转发（契约钉死）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { onAgentReply } = await import('./replyBus.js')

      seedSecondAgent(getDb())

      // currentTrigger 匹配 → agent-1 正常执行
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-a2a-fwd',
      })
      // agent-1 的回复 @吐槽猫（A2A 上下文），继续触发 A2A 调度
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '@吐槽猫 请审查', kind: 'text' }
        }),
      } as any)
      vi.mocked(parseMentionsFromReply).mockImplementation(() => ['吐槽猫'])
      // 触发消息必须存在于 DB（Window ② 撤回保护）
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-a2a-fwd', 'session-1', '@店长 派活')

      // 订阅 replyBus——捕获 A2A 回复触发的转发事件
      const forwarded: AgentReplyMessage[] = []
      const unsub = onAgentReply((m) => forwarded.push(m))
      try {
        await mod.executeAgentsSerial(
          mockIo as any,
          'session-1',
          [execAgentCfg as any],
          { id: 'msg-a2a-fwd', content: '@店长 派活', mentions: ['店长'] },
          'trace-a2a-fwd',
          1 // depth=1：A2A 链上下文
        )
      } finally {
        unsub()
        vi.mocked(parseMentionsFromReply).mockImplementation(() => []) // 恢复默认，防污染后续用例
      }

      // ① 该回复继续触发了 A2A 调度（吐槽猫，depth+1=2）——确认是 A2A 链回复
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-2' })]),
        'trace-a2a-fwd',
        2
      )
      // ② 契约钉死：A2A 回复同样无条件触发 replyBus（emitAgentReply 无过滤，
      //    全量转发 QQ——猫咖工作过程公开可见）
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0].content).toBe('@吐槽猫 请审查')
      expect(forwarded[0].sessionId).toBe('session-1')
      expect(forwarded[0].agentName).toBe('店长')
    })
  })

  // ─── A2A 白名单（mention-policy 接入）──────────────────
  // A2A 风暴治理：按发送者角色剥除违规 mention（写回 DB 用允许集合，
  // 被拦猫在上下文过滤里也不可见——语义自洽）。

  /** 在 session-1 中加入吐槽猫（reviewer）与图测猫（vision）。
   *  模块级共享：A2A 白名单块 + W3 审查结论钩子块共用同一角色种子 */
  function seedRoleAgents(db: any) {
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'agent-2',
      '吐槽猫',
      '🐱',
      'You are a cat.',
      'deepseek',
      'deepseek-v4-flash',
      'sk-test',
      'reviewer'
    )
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'agent-3',
      '图测猫',
      '🐱',
      'You are a cat.',
      'deepseek',
      'deepseek-v4-flash',
      'sk-test',
      'vision'
    )
    db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
      JSON.stringify(['agent-1', 'agent-2', 'agent-3'])
    )
  }

  /** 构造带角色的执行者 AgentConfig（模块级共享：白名单块 + W3 钩子块共用） */
  function makeAgentCfg(overrides: Record<string, any> = {}) {
    return {
      id: 'agent-1',
      name: '店长',
      avatar: '🐱',
      systemPrompt: 'You are a cat.',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      llmApiKey: 'sk-test',
      ...overrides,
    }
  }

  describe('A2A mention 白名单 — role policy 接入', () => {
    /** 通用 setup：触发消息入 DB + 状态 mock + adapter mock + mention 解析 mock */
    async function setupExecution(parseResult: string[], cfg: any) {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      }))
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: parseResult.join(' '), kind: 'text' }
        }),
      } as any)
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      vi.mocked(parseMentionsFromReply).mockReturnValue(parseResult)
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', '派活')
      return cfg
    }

    it('implementer @ reviewer+vision → 剥除 vision，只路由 reviewer + 系统提示', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      seedRoleAgents(getDb())

      const dsCatCfg = makeAgentCfg({ id: 'agent-9', name: 'ds猫', role: 'implementer' })
      await setupExecution(['吐槽猫', '图测猫'], dsCatCfg)
      vi.mocked(dispatch).mockClear()
      mockRoomEmit.mockClear()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [dsCatCfg],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-policy',
        1
      )

      // ① 只路由合法目标（吐槽猫），不路由图测猫
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ name: '吐槽猫' })]),
        'trace-policy',
        2
      )
      const dispatchAgents = vi.mocked(dispatch).mock.calls[0][2] as any[]
      expect(dispatchAgents.map((a) => a.name)).not.toContain('图测猫')

      // ② 系统提示 emit（点名违规与正确规则）
      const systemMsgs = mockRoomEmit.mock.calls.filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
      const policyHint = systemMsgs.find(
        (c: any[]) =>
          c[1]?.role === 'system' && String(c[1]?.content).includes('不在你的角色允许范围内')
      )
      expect(policyHint).toBeDefined()
      expect(policyHint![1].content).toContain('图测猫')
      expect(policyHint![1].content).toContain('店长、吐槽猫')

      // ③ 写回 DB 的 mentions 只含允许集合——被拦猫上下文过滤不可见
      const row = getDb()
        .prepare(`SELECT mentions FROM messages WHERE id = ?`)
        .get(vi.mocked(dispatch).mock.calls[0][1].id) as { mentions: string }
      expect(JSON.parse(row.mentions)).toEqual(['吐槽猫'])
    })

    it('store @ 任意角色 → 全放行不拦截', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seedRoleAgents(getDb())

      const storeCfg = makeAgentCfg({ role: 'store' })
      await setupExecution(['吐槽猫', '图测猫'], storeCfg)
      vi.mocked(dispatch).mockClear()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [storeCfg],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-store'
      )

      const dispatchAgents = vi.mocked(dispatch).mock.calls[0][2] as any[]
      expect(dispatchAgents.map((a) => a.name)).toEqual(
        expect.arrayContaining(['吐槽猫', '图测猫'])
      )
    })

    it('发送者角色缺失（老库）→ 全放行零回归', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seedRoleAgents(getDb())

      const noRoleCfg = makeAgentCfg({ role: undefined })
      await setupExecution(['吐槽猫', '图测猫'], noRoleCfg)
      vi.mocked(dispatch).mockClear()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [noRoleCfg],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-no-role'
      )

      const dispatchAgents = vi.mocked(dispatch).mock.calls[0][2] as any[]
      expect(dispatchAgents.map((a) => a.name)).toEqual(
        expect.arrayContaining(['吐槽猫', '图测猫'])
      )
    })

    it('用户消息永不拦——用户 @ 任何猫原样进入 dispatch（白名单只挂 A2A 路径）', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)
      const { dispatch } = await import('../dispatch/index.js')
      // 显式重置 handoff 重定向 mock（前序 HANDOFF 测试的 mockReturnValue 会残留，
      // 导致本消息被重定向到不存在的子会话 → INSERT FK 失败 → dispatch 不执行）
      const { resolveHandoffTarget } = await import('../handoff/index.js')
      vi.mocked(resolveHandoffTarget).mockReturnValue(null)
      vi.mocked(dispatch).mockClear()

      await handlers![0]({
        sessionId: 'session-1',
        content: '你好 @图测猫',
        mentions: ['图测猫'],
      })

      // 用户消息的 mentions 原样传给 dispatch——白名单只挂 A2A 路径
      // （parseMentionsFromReply 之后），用户路径不剥除任何 mention
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['图测猫'] }),
        expect.anything(), // validAgents 由 session agent_ids 决定，mention 过滤在 dispatch 内部
        expect.any(String) // traceId
      )
    })
  })

  describe('W3 L3 审查结论解析钩子 — review_verdicts 落库', () => {
    /** 复用白名单块的角色种子（agent-2 吐槽猫 reviewer / agent-1 店长 store） */
    const seed = seedRoleAgents

    /** 定制版 setup：adapter 输出回复正文，parseMentionsFromReply 单独 mock 路由 */
    async function setupVerdictExecution(content: string, mentions: string[]) {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      }))
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content, kind: 'text' }
        }),
      } as any)
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      vi.mocked(parseMentionsFromReply).mockReturnValue(mentions)
      // seed 的店长 agent-1 未设 role（默认 'unknown'）——钩子 isStore 判定依赖
      // role==='store'，补为 store 才符合真实会话（store 白名单角色）
      getDb().prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', '派活')
    }

    const lastVerdict = () =>
      getDb()
        .prepare('SELECT * FROM review_verdicts ORDER BY created_at DESC, message_id DESC LIMIT 1')
        .get() as Record<string, unknown> | undefined

    const lastFailure = () =>
      getDb()
        .prepare(
          'SELECT * FROM review_parse_failures ORDER BY created_at DESC, message_id DESC LIMIT 1'
        )
        .get() as Record<string, unknown> | undefined

    it('reviewer 输出行首 ✅可合并 + @店长 → review_verdicts 落库 approve/subject=null', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seed(getDb())
      await setupVerdictExecution('全部通过，无问题\n✅可合并', ['店长'])
      vi.mocked(dispatch).mockClear()

      const reviewerCfg = makeAgentCfg({ id: 'agent-2', name: '吐槽猫', role: 'reviewer' })
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [reviewerCfg],
        { id: 'msg-trigger', content: '@吐槽猫 审查', mentions: ['吐槽猫'] },
        'trace-verdict-approve',
        1
      )

      const row = lastVerdict()
      expect(row).toBeDefined()
      expect(row!.verdict).toBe('approve')
      expect(row!.subject_agent_id).toBeNull()
      expect(row!.session_id).toBe('session-1')
      expect(row!.reviewer_agent_id).toBe('agent-2')
      // 回复消息 id 与 execution_logs.message_id 一致（遥测锚点契约）
      expect(lastFailure()).toBeUndefined()
    })

    it('reviewer 输出 ⚠️建议修改 + @店长+作者 → subject=作者（触发者 ds猫 放行）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seed(getDb())
      // 补 ds猫（implementer）进 DB 与会话成员——reviewer 白名单对触发作者放行，
      // subject 取首个非 store 目标
      getDb()
        .prepare(
          `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'agent-9',
          'ds猫',
          '🐱',
          'You are a cat.',
          'deepseek',
          'deepseek-v4-flash',
          'sk-test',
          'implementer'
        )
      getDb()
        .prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`)
        .run(JSON.stringify(['agent-1', 'agent-2', 'agent-3', 'agent-9']))
      await setupVerdictExecution('⚠️建议修改 有几处要返工。', ['店长', 'ds猫'])
      vi.mocked(dispatch).mockClear()

      const reviewerCfg = makeAgentCfg({ id: 'agent-2', name: '吐槽猫', role: 'reviewer' })
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [reviewerCfg],
        { id: 'msg-trigger', content: '@吐槽猫 审查', mentions: ['吐槽猫'], authorName: 'ds猫' },
        'trace-verdict-suggest',
        1
      )

      const row = lastVerdict()
      expect(row!.verdict).toBe('suggest')
      // subject 从作用域 allowedNames 直取（名字数组，不读 DB mentions 列）——存名字
      expect(row!.subject_agent_id).toBe('ds猫')
      expect(lastFailure()).toBeUndefined()
    })

    it('reviewer 输出 ❌需重做 + 只@店长 → subject=null + failure no_subject 双写', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seed(getDb())
      await setupVerdictExecution('❌需重做 推倒重来。', ['店长'])
      vi.mocked(dispatch).mockClear()

      const reviewerCfg = makeAgentCfg({ id: 'agent-2', name: '吐槽猫', role: 'reviewer' })
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [reviewerCfg],
        { id: 'msg-trigger', content: '@吐槽猫 审查', mentions: ['吐槽猫'] },
        'trace-verdict-reject',
        1
      )

      const row = lastVerdict()
      expect(row!.verdict).toBe('reject')
      expect(row!.subject_agent_id).toBeNull()
      const fail = lastFailure()
      expect(fail).toBeDefined()
      expect(fail!.reason).toBe('no_subject')
    })

    it('非 reviewer（implementer）输出含标记 → 不落库（角色门）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seed(getDb())
      await setupVerdictExecution('完成，自评 ✅可合并', ['店长'])
      vi.mocked(dispatch).mockClear()

      const implCfg = makeAgentCfg({ id: 'agent-9', name: 'ds猫', role: 'implementer' })
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [implCfg],
        { id: 'msg-trigger', content: '派活', mentions: ['店长'] },
        'trace-verdict-nonreviewer',
        1
      )

      expect(lastVerdict()).toBeUndefined()
      expect(lastFailure()).toBeUndefined()
    })

    it('reviewer 回复无 @（routeNames=0）→ 钩子不触发不落库', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seed(getDb())
      await setupVerdictExecution('✅可合并', [])
      vi.mocked(dispatch).mockClear()

      const reviewerCfg = makeAgentCfg({ id: 'agent-2', name: '吐槽猫', role: 'reviewer' })
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [reviewerCfg],
        { id: 'msg-trigger', content: '@吐槽猫 审查', mentions: ['吐槽猫'] },
        'trace-verdict-noroute',
        1
      )

      expect(lastVerdict()).toBeUndefined()
      expect(lastFailure()).toBeUndefined()
    })
  })

  // ─── hint 角色判定 — agents 表 role 字段接入 ──────────
  // 原 skillModules（含 code-review）判定拆除，切 role === 'reviewer'（一对一已实锤）。
  // buildReviewLoopHint / buildHandoffTriggerHint 内部用 agentsRepo 查真实 DB。

  describe('hint 角色判定 — role 字段接入（skillModules 判定拆除）', () => {
    /** 插入 reviewer（吐槽猫）与 implementer（ds猫） */
    function seedHintAgents(db: any) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-3',
        'ds猫',
        '🐯',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'implementer'
      )
    }

    it('buildReviewLoopHint：reviewer（role）发 ⚠️建议修改 且 @实施猫 → 注入循环指令（真名动态装配）', async () => {
      const { buildReviewLoopHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-2',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      expect(hint).not.toBeNull()
      expect(hint!).toContain('吐槽猫') // 真名由运行时动态装配（规则说角色，运行时给名字）
      expect(hint!).toContain('继续审查循环')
      expect(hint!).toContain('✅可合并')
    })

    it('buildReviewLoopHint：发送者非 reviewer（implementer 消息）→ 不注入（role 判定等价旧 skillModules 判据）', async () => {
      const { buildReviewLoopHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-3',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      // 发送者 agent-3 是 implementer 不是 reviewer → 走发送者检查 continue → 不注入
      expect(hint).toBeNull()
    })

    it('buildReviewLoopHint：reviewer 自己 → 不注入（审查者不需要循环指令）', async () => {
      const { buildReviewLoopHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: '吐槽猫', role: 'reviewer' }, [
        {
          role: 'agent',
          agent_id: 'agent-3',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['吐槽猫']),
        },
      ])
      expect(hint).toBeNull()
    })

    it('buildReviewLoopHint：✅可合并 → 不注入（审查通过循环结束）', async () => {
      const { buildReviewLoopHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-2',
          content: '✅可合并 通过',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      expect(hint).toBeNull()
    })

    it('buildHandoffTriggerHint：DB 有 reviewer → 注入 @吐槽猫 发起代码审查（真名动态装配）', async () => {
      const { buildHandoffTriggerHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildHandoffTriggerHint('@店长 请补填以下交接文档')
      expect(hint).not.toBeNull()
      expect(hint!).toContain('吐槽猫')
      expect(hint!).toContain('发起代码审查')
    })

    it('buildHandoffTriggerHint：DB 无 reviewer → 不注入', async () => {
      const { buildHandoffTriggerHint } = await import('./socketio.js')
      // beforeEach 只插入 agent-1（店长，role 默认 unknown）——无 reviewer
      const hint = buildHandoffTriggerHint('@店长 请补填以下交接文档')
      expect(hint).toBeNull()
    })

    it('buildHandoffTriggerHint：非补填请求消息 → 不注入', async () => {
      const { buildHandoffTriggerHint } = await import('./socketio.js')
      seedHintAgents(getDb())
      const hint = buildHandoffTriggerHint('普通派活消息')
      expect(hint).toBeNull()
    })
  })

  // ─── queue drain — 出队反查 authorName + 审计 + taskId 自持 ──────────
  // 回归测试：10:38 事故——吐槽猫审查结论 @实施猫 被 role policy 拦截。
  // 根因：drain 段构造 queuedTrigger 漏 authorName → 触发作者例外判定
  // undefined === 目标名 → false → 拦截。同轮实锤伴生缺陷一并钉死：
  // ①无 executeAgentCommand → 排队命令执行零审计；②taskId 取执行者的。

  describe('queue drain — 出队反查 authorName + 审计 + taskId 自持', () => {
    it('reviewer busy 排队 → 出队回复 @实施猫 → 放行不拦截（mention 写回/调度/审计/占位符替换）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution, dispatch, executeAgentCommand } =
        await import('../dispatch/index.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const db = getDb()

      // 会话成员：吐槽猫（reviewer，排队执行者）+ ds猫（implementer，审查请求人）
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        '你是审查者。审查结论必须 @作者 通知提交者。',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-3',
        'ds猫',
        '🐯',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'implementer'
      )
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(['agent-1', 'agent-2', 'agent-3'])
      )

      // 触发消息（审查请求，作者=ds猫）与主执行消息落库（runAgentReply Window ②
      // 撤回保护要求触发消息存在于 DB）
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
         VALUES (?, ?, ?, 'agent', ?, ?, ?)`
      ).run(
        'msg-queued',
        'session-1',
        'agent-3',
        '@吐槽猫 请审查（P3 遗留点收尾）',
        JSON.stringify(['吐槽猫']),
        'task-review'
      )
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, '[]')`
      ).run('msg-main', 'session-1', '@吐槽猫 处理消息')

      // 队列命令：吐槽猫排队的审查任务（命令自持 trace/depth/taskId）
      const queuedCmd = {
        sessionId: 'session-1',
        agentId: 'agent-2',
        triggerMessageId: 'msg-queued',
        triggerContent: '@吐槽猫 请审查（P3 遗留点收尾）',
        mentions: ['吐槽猫'],
        traceId: 'trace-queued',
        depth: 1,
        taskId: 'task-review',
        pendingTriggers: [],
      }
      // 主执行（msg-main）槽位匹配；completeExecution 弹出 queuedCmd 后
      // 槽位 currentTrigger 更新为 msg-queued（drain 内层执行匹配）
      vi.mocked(getAgentState)
        .mockReset()
        .mockReturnValueOnce({
          agentId: 'agent-2',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-main',
        })
        .mockReturnValue({
          agentId: 'agent-2',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-queued',
        })
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValueOnce(queuedCmd as any)
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      vi.mocked(dispatch).mockReset()
      // 审计落库：模拟 executeAgentCommand 的核心副作用（dispatch 模块整体
      // mock，其内部 insertExecutionLog 由 dispatch 单测覆盖——此处钉死
      // "drain 段调用它"这一调用点 + DB 层验证排队命令有执行日志）
      vi.mocked(executeAgentCommand).mockReset()
      vi.mocked(executeAgentCommand).mockImplementation(
        async (agent: any, cmd: any, traceId: string) => {
          db.prepare(
            `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
             VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
          ).run('exec-log-queued', cmd.sessionId, cmd.agentId, cmd.triggerMessageId, traceId)
        }
      )
      // 主回复无 mention；drain 审查结论 @实施猫。顺序注意：drain 段现位于
      // A2A 派发之前（FIFO 修复——弹出命令立即执行，不干等 A2A 链），
      // 故第一次 parse 调用是 drain 的回复（@ds猫），第二次是主回复（无 mention）
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValueOnce(['ds猫'])
      vi.mocked(parseMentionsFromReply).mockReturnValue([])
      // LLM 流：第一次=主执行回复，第二次=drain 审查结论（参数捕获断言 @作者 替换）
      // 显式参数签名——否则 mock.calls[0] 推断为空元组，取 [0] 报 TS2493
      let streamCall = 0
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        streamCall++
        yield {
          content: streamCall === 1 ? '收到，主消息已处理' : '✅可合并 审查通过',
          kind: 'text',
        }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
      mod.__test_resetMentionCounts()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-2',
            name: '吐槽猫',
            avatar: '😼',
            systemPrompt: '你是审查者。审查结论必须 @作者 通知提交者。',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
            role: 'reviewer',
          } as any,
        ],
        { id: 'msg-main', content: '@吐槽猫 处理消息', mentions: ['吐槽猫'] },
        'trace-main'
      )

      // 断言① 放行不拦截：被 @ 的实施猫被调度执行（修复前白名单拦截 → 不调度）
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['ds猫'], taskId: 'task-review' }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-3', name: 'ds猫' })]),
        'trace-queued',
        2
      )
      // 白名单 blocked 会 emit 系统提示点名违规——放行则无
      const news = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => JSON.stringify(c[1]))
      expect(news.some((s) => s.includes('不在你的角色允许范围内'))).toBe(false)
      // mention 写回（updateMessageMentions 真实执行）：drain 回复消息 mentions 含实施猫
      const replyRow = db
        .prepare(`SELECT * FROM messages WHERE role = 'agent' AND content LIKE '%审查通过%'`)
        .get() as any
      expect(replyRow).toBeDefined()
      expect(JSON.parse(replyRow.mentions)).toContain('ds猫')

      // 断言② 审计：drain 段补 executeAgentCommand（排队命令执行有 execution_log）
      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
      expect(executeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-2', name: '吐槽猫' }),
        expect.objectContaining({ triggerMessageId: 'msg-queued', taskId: 'task-review' }),
        'trace-queued'
      )
      const execLog = db
        .prepare(`SELECT * FROM execution_logs WHERE id = 'exec-log-queued'`)
        .get() as any
      expect(execLog).toBeDefined()
      expect(execLog.triggered_by_message_id).toBe('msg-queued')

      // 断言②' FIFO 顺序：drain（弹出命令执行）先于当前回复的 A2A 派发——修复前
      // drain 排在 A2A 之后，弹出命令以 'running' 干等整条 A2A 嵌套链
      // （d448413a 案例：07:00:02 弹出、07:05:54 才执行，被两层 A2A await 拖 5.9 分钟）
      expect(vi.mocked(executeAgentCommand).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(dispatch).mock.invocationCallOrder[0]
      )

      // 断言③ @作者 占位符：主执行无 authorName → 保留；drain 出队反查成功 → 替换
      const firstMsgs = chatStream.mock.calls[0][0] as any[]
      expect(firstMsgs[0].content).toContain('@作者')
      const secondMsgs = chatStream.mock.calls[1][0] as any[]
      expect(secondMsgs[0].content).toContain('@ds猫')
      expect(secondMsgs[0].content).not.toContain('@作者')
    })

    it('post-execution 异常路径：completeExecution 弹出的命令不丢弃（catch 路径 drain）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution, executeAgentCommand } =
        await import('../dispatch/index.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const db = getDb()

      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, '[]')`
      ).run('msg-main', 'session-1', '处理消息')
      // 队列命令的触发消息（drain 出队反查 authorName 需要存在于 DB）
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions)
         VALUES (?, ?, ?, 'agent', ?, '[]')`
      ).run('msg-queued2', 'session-1', 'agent-1', '@店长 排队任务')
      const queuedCmd = {
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-queued2',
        triggerContent: '@店长 排队任务',
        mentions: ['店长'],
        traceId: 'trace-queued2',
        depth: 0,
        taskId: undefined,
        pendingTriggers: [],
      }
      // 状态：main 执行中 →（catch 路径 drain 时）队列命令命中
      vi.mocked(getAgentState)
        .mockReset()
        .mockReturnValueOnce({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-main',
        })
        .mockReturnValue({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-queued2',
        })
      // completeExecution：成功路径无队列 → undefined；异常路径弹出 queuedCmd → drain
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValueOnce(undefined)
      vi.mocked(completeExecution).mockResolvedValueOnce(queuedCmd as any)
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      // 审计落库：mock executeAgentCommand 的核心副作用（真实 insertExecutionLog 在
      // dispatch 单测覆盖——此处钉死"catch 路径也调用它"这一调用点）
      vi.mocked(executeAgentCommand).mockReset()
      vi.mocked(executeAgentCommand).mockImplementation(
        async (agent: any, cmd: any, traceId: string) => {
          db.prepare(
            `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
             VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
          ).run('exec-log-catch', cmd.sessionId, cmd.agentId, cmd.triggerMessageId, traceId)
        }
      )
      // 主回复的 mention 解析抛错 → 进入外层 catch（post-execution error 路径）
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockImplementationOnce(() => {
        throw new Error('parse boom')
      })
      vi.mocked(parseMentionsFromReply).mockReturnValue([])
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        yield { content: '已处理', kind: 'text' }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-1',
            name: '店长',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
            role: 'store',
          } as any,
        ],
        { id: 'msg-main', content: '处理消息', mentions: [] },
        'trace-main'
      )

      // catch 路径弹出的命令仍被执行（修复前返回值被丢弃 → 'running' 永久搁浅）：
      // executeAgentCommand 被调用 + 执行日志落库
      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
      expect(executeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1' }),
        expect.objectContaining({ triggerMessageId: 'msg-queued2' }),
        'trace-queued2'
      )
      const execLog = db
        .prepare(`SELECT * FROM execution_logs WHERE id = 'exec-log-catch'`)
        .get() as any
      expect(execLog).toBeDefined()
      expect(execLog.triggered_by_message_id).toBe('msg-queued2')
    })
  })

  // ─── executeAgentsSerial 并发（同消息 @ 多猫） ──────────
  // 7749500 分批并发重构的验证面（派活单测试计划 4 组：并行性重叠 / 锁引用计数 /
  // 并发度上限 / A2A 目标 busy 入队-排空——方案审查必改点 3 原文带入）。
  // 既有 120 例只证明串行语义保持；本 describe 钉并发不变量的直接断言。

  describe('executeAgentsSerial — 并发（同消息 @ 多猫）', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    /** 等待条件成立（gate 类测试避免挂死；超时报错） */
    async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时: ${what}`)
        await sleep(10)
      }
    }

    /** 在 session-1 追加 agent 并纳入会话成员（并发用例需要多成员） */
    function seedAgent(
      db: any,
      id: string,
      name: string,
      role?: string,
      llmProvider: string = 'deepseek'
    ) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        name,
        '🐱',
        'You are a cat.',
        llmProvider,
        'deepseek-v4-flash',
        'sk-test',
        role ?? 'unknown'
      )
      const row = db.prepare(`SELECT agent_ids FROM sessions WHERE id = 'session-1'`).get() as any
      const ids = JSON.parse(row.agent_ids)
      if (!ids.includes(id)) ids.push(id)
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(ids)
      )
    }

    beforeEach(async () => {
      const mod = await import('./socketio.js')
      mod.__test_resetLockState()
      mod.__test_resetMentionCounts()
    })

    afterEach(async () => {
      const mod = await import('./socketio.js')
      mod.__test_resetLockState()
    })

    it('并行性：同消息 @2 猫 → 第二个 agent 的流在第一个完成前开始（重叠证据）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const db = getDb()

      seedAgent(db, 'agent-2', '吐槽猫')
      seedAgent(db, 'agent-3', 'ds猫')
      // 触发消息落库（runAgentReply Window ② 撤回保护要求触发消息存在于 DB）
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, ?)`
      ).run('msg-batch', 'session-1', '@吐槽猫 @ds猫 处理消息', JSON.stringify(['吐槽猫', 'ds猫']))

      // 两执行体都命中（批启动瞬间同步完成状态检查，无中间态）
      vi.mocked(getAgentState).mockReset()
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-batch',
      }))
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValue([])

      // 事件序钉死并发形态：a2 的流卡在 gate 上 → a3 的流全程在 a2 流结束前
      // 运行（若回归串行：a3 永远等不到 a2 结束，gate 不释放 → waitFor 超时红）
      const events: string[] = []
      let releaseA: () => void = () => {}
      const gateA = new Promise<void>((r) => (releaseA = r))
      vi.mocked(getAdapterForAgent).mockImplementation(
        (agent: any) =>
          ({
            chatStream: vi.fn(async function* () {
              const tag = agent.id === 'agent-2' ? 'a2' : 'a3'
              events.push(`${tag}-start`)
              if (tag === 'a2') await gateA
              yield { content: '收到', kind: 'text' }
              events.push(`${tag}-end`)
            }),
          }) as any
      )

      const p = mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-2',
            name: '吐槽猫',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
          } as any,
          {
            id: 'agent-3',
            name: 'ds猫',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
          } as any,
        ],
        { id: 'msg-batch', content: '@吐槽猫 @ds猫 处理消息', mentions: ['吐槽猫', 'ds猫'] },
        'trace-parallel'
      )
      try {
        // a3 完整跑完时 a2 仍在执行中（a2-end 未出现）→ 并发重叠的证据
        await waitFor(
          () => events.includes('a3-start') && events.includes('a3-end'),
          '第二个 agent 未在第一个 agent 执行期间完成（串行回归？）'
        )
        expect(events).toEqual(['a2-start', 'a3-start', 'a3-end'])
      } finally {
        releaseA()
      }
      await p
      expect(events).toEqual(['a2-start', 'a3-start', 'a3-end', 'a2-end'])
    })

    it('锁引用计数：2 个 Claude agent 并行 → 第一个完成后 .agent-busy 仍在、最后一个完成后删除', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const db = getDb()

      seedAgent(db, 'agent-2', '吐槽猫', undefined, 'claude')
      seedAgent(db, 'agent-3', 'ds猫', undefined, 'claude')
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, '[]')`
      ).run('msg-trigger', 'session-1', '@吐槽猫 @ds猫 处理消息')

      vi.mocked(getAgentState).mockReset()
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      }))
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValue([])

      // A（agent-2）的流卡在 gate → B（agent-3）先行完成。锁引用计数配对：
      // B 完成时 A 仍持有（计数 2→1），.agent-busy 必须还在；A 完成归零才删
      const events: string[] = []
      let releaseA: () => void = () => {}
      const gateA = new Promise<void>((r) => (releaseA = r))
      vi.mocked(getAdapterForAgent).mockImplementation(
        (agent: any) =>
          ({
            chatStream: vi.fn(async function* () {
              const tag = agent.id === 'agent-2' ? 'a2' : 'a3'
              events.push(`${tag}-start`)
              if (tag === 'a2') await gateA
              yield { content: '收到', kind: 'text' }
              events.push(`${tag}-end`)
            }),
          }) as any
      )

      // 与生产代码同式（socketio.ts LOCK_FILE = resolve(process.cwd(), '.agent-busy')）
      const lockFile = resolve(process.cwd(), '.agent-busy')
      const p = mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-2',
            name: '吐槽猫',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'claude',
            llmModel: 'claude-opus-4-8',
            llmApiKey: 'sk-test',
          } as any,
          {
            id: 'agent-3',
            name: 'ds猫',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'claude',
            llmModel: 'claude-opus-4-8',
            llmApiKey: 'sk-test',
          } as any,
        ],
        { id: 'msg-trigger', content: '@吐槽猫 @ds猫 处理消息', mentions: ['吐槽猫', 'ds猫'] },
        'trace-lock'
      )
      try {
        // B 完整跑完（其 releaseLock 已执行或即将执行，计数 2→1）——A 仍持有锁
        await waitFor(() => events.includes('a3-end'), '第二个 Claude agent 未完成')
        expect(existsSync(lockFile)).toBe(true)
      } finally {
        releaseA()
      }
      await p
      // 两个执行体都完成 → 引用计数归零 → 锁文件删除
      expect(events).toEqual(['a2-start', 'a3-start', 'a3-end', 'a2-end'])
      expect(existsSync(lockFile)).toBe(false)
    })

    it('并发度上限：同消息 @4 猫 → 同时执行 ≤3（第 4 个等批间串行）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const db = getDb()

      for (const [id, name] of [
        ['agent-2', '吐槽猫'],
        ['agent-3', 'ds猫'],
        ['agent-4', 'flash猫'],
      ] as const) {
        seedAgent(db, id, name)
      }
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, ?)`
      ).run(
        'msg-4',
        'session-1',
        '@店长 @吐槽猫 @ds猫 @flash猫 处理消息',
        JSON.stringify(['店长', '吐槽猫', 'ds猫', 'flash猫'])
      )

      vi.mocked(getAgentState).mockReset()
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-4',
      }))
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValue([])

      // 并发计数：流开始 +1、流结束 -1；gate 卡住所有流 → 只有首批（≤3）能启动，
      // 第 4 个必须等批间串行（batch2 在 batch1 allSettled 后才启动，而 gate 未
      // 放行时 batch1 不可能完成——同时执行数超 3 或等不到 3 都会红）
      let active = 0
      let maxActive = 0
      let releaseGate: () => void = () => {}
      const gate = new Promise<void>((r) => (releaseGate = r))
      const chatStream = vi.fn(async function* () {
        active++
        maxActive = Math.max(maxActive, active)
        await gate
        yield { content: '收到', kind: 'text' }
        active--
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

      const cfg = (id: string, name: string) =>
        ({
          id,
          name,
          avatar: '🐱',
          systemPrompt: 'You are a cat.',
          llmProvider: 'deepseek',
          llmModel: 'deepseek-v4-flash',
          llmApiKey: 'sk-test',
        }) as any
      const p = mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          cfg('agent-1', '店长'),
          cfg('agent-2', '吐槽猫'),
          cfg('agent-3', 'ds猫'),
          cfg('agent-4', 'flash猫'),
        ],
        {
          id: 'msg-4',
          content: '@店长 @吐槽猫 @ds猫 @flash猫 处理消息',
          mentions: ['店长', '吐槽猫', 'ds猫', 'flash猫'],
        },
        'trace-limit'
      )
      try {
        await waitFor(() => active === 3, '首批 3 个执行体未全部启动')
        expect(active).toBe(3)
        expect(maxActive).toBe(3)
      } finally {
        releaseGate()
      }
      await p
      // 全程峰值 ≤3，且 4 个 agent 都执行完成
      expect(maxActive).toBe(3)
      expect(chatStream).toHaveBeenCalledTimes(4)
    })

    it('A2A 目标 busy 入队-排空：批内 A 的 A2A 命令进 B 队列 → B 完成后 drain 执行（必改点 3）', async () => {
      const mod = await import('./socketio.js')
      const { getAgentState, completeExecution, dispatch, executeAgentCommand } =
        await import('../dispatch/index.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const db = getDb()

      // A = 吐槽猫（reviewer），B = 店长（store）——✅可合并 收口链标准路径
      // （mention-policy：reviewer 只可 @ store 或本次触发作者，@implementer 会被
      // 真实白名单拦截——首版用例即因此 dispatch 0 次，必须用合法 A2A 形态）
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      seedAgent(db, 'agent-2', '吐槽猫', 'reviewer')
      // 触发消息（同消息 @2 猫 → 同一批并发执行）
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', ?, ?)`
      ).run('msg-batch', 'session-1', '@吐槽猫 @店长 处理消息', JSON.stringify(['吐槽猫', '店长']))
      // A2A 排队命令的触发消息（吐槽猫的 A2A 回复形态——drain 出队反查 authorName 用）
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
         VALUES (?, ?, ?, 'agent', ?, ?, ?)`
      ).run(
        'msg-queued-a2a',
        'session-1',
        'agent-2',
        '@店长 请收口',
        JSON.stringify(['店长']),
        'task-a2a'
      )

      // 状态检查序列（mockReturnValueOnce 按调用序）：
      // 1. 批启动 agent-2（吐槽猫）→ msg-batch 命中
      // 2. 批启动 agent-1（店长）→ msg-batch 命中
      // 3. 吐槽猫 A2A 的 initAgentSlot 检查（socketio.ts:969 getAgentState(店长)）
      // 4. 吐槽猫 A2A 递归店长 → 仍 busy（msg-batch）→ 跳过入队（双执行防护）
      // 5. 之后（drain 递归）→ msg-queued-a2a 命中
      vi.mocked(getAgentState)
        .mockReset()
        .mockReturnValueOnce({
          agentId: 'agent-2',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-batch',
        })
        .mockReturnValueOnce({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-batch',
        })
        .mockReturnValueOnce({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-batch',
        })
        .mockReturnValueOnce({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-batch',
        })
        .mockReturnValue({
          agentId: 'agent-1',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-queued-a2a',
        })
      // completeExecution：吐槽猫（无队列）→ undefined；店长 main 完成 → 弹出排队
      // 命令；drain 收尾 → undefined
      const queuedCmd = {
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-queued-a2a',
        triggerContent: '@店长 请收口',
        mentions: ['店长'],
        traceId: 'trace-batch',
        depth: 1,
        taskId: 'task-a2a',
        pendingTriggers: [],
      }
      vi.mocked(completeExecution).mockReset()
      vi.mocked(completeExecution).mockResolvedValueOnce(undefined)
      vi.mocked(completeExecution).mockResolvedValueOnce(queuedCmd as any)
      vi.mocked(completeExecution).mockResolvedValue(undefined)
      vi.mocked(dispatch).mockReset()
      vi.mocked(executeAgentCommand).mockReset()
      // mention 解析：吐槽猫 main → ['店长']（A2A）；店长 main / drain → 无
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValueOnce(['店长'])
      vi.mocked(parseMentionsFromReply).mockReturnValue([])

      // LLM 流：1=吐槽猫 main（A2A 触发），2=店长 main（延迟 200ms——保证 A2A
      // 递归发生时店长仍在执行中 → busy 入队），3=店长 drain（排队命令执行）
      let streamCall = 0
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        streamCall++
        if (streamCall === 2) await sleep(200)
        yield {
          content: streamCall === 1 ? '@店长 请收口' : streamCall === 2 ? '收到' : '已收口',
          kind: 'text',
        }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-2',
            name: '吐槽猫',
            avatar: '😼',
            systemPrompt: '你是审查者。审查结论必须 @作者 通知提交者。',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
            role: 'reviewer',
          } as any,
          {
            id: 'agent-1',
            name: '店长',
            avatar: '🐱',
            systemPrompt: 'You are a cat.',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
            role: 'store',
          } as any,
        ],
        { id: 'msg-batch', content: '@吐槽猫 @店长 处理消息', mentions: ['吐槽猫', '店长'] },
        'trace-batch'
      )

      // 断言① A2A 调度：吐槽猫回复 @店长 → dispatch 入队命令（目标 busy 时排队）
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['店长'] }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-1', name: '店长' })]),
        'trace-batch',
        1 // A2A 入队命令带 depth+1
      )
      // 白名单放行：reviewer @ store 不拦（无违规系统提示）
      const news = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => JSON.stringify(c[1]))
      expect(news.some((s) => s.includes('不在你的角色允许范围内'))).toBe(false)

      // 断言② 双执行防护（并发形态）：A2A 递归时店长 busy → 跳过，不重复执行
      // main——LLM 流恰好 3 次（吐槽猫 main + 店长 main + 店长 drain）；防护失效
      // 会多 1 次（A2A 立即执行）→ 4 次
      expect(chatStream).toHaveBeenCalledTimes(3)

      // 断言③ drain 在店长 main 完成之后执行：顺序 = 收到 → 已收口（独立消息非重复回复）
      const replies = db
        .prepare(
          `SELECT content FROM messages WHERE agent_id = 'agent-1' AND role = 'agent' ORDER BY rowid`
        )
        .all() as any[]
      expect(replies.map((r: any) => r.content)).toEqual(['收到', '已收口'])

      // 断言④ drain 审计：排队命令执行补 executeAgentCommand（execution_logs 有记录）
      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
      expect(executeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1', name: '店长' }),
        expect.objectContaining({ triggerMessageId: 'msg-queued-a2a', taskId: 'task-a2a' }),
        'trace-batch'
      )

      // 断言⑤ mention 写回：吐槽猫 A2A 回复（dispatch 入队命令引用的 msgId）的
      // mentions 列含店长（updateMessageMentions 真实执行——974159e 断言④ 同款取 id 范式）
      const a2aReplyId = (vi.mocked(dispatch).mock.calls[0][1] as any).id
      const a2aRow = db
        .prepare(`SELECT content, mentions FROM messages WHERE id = ?`)
        .get(a2aReplyId) as any
      expect(a2aRow).toBeDefined()
      expect(a2aRow.content).toBe('@店长 请收口')
      expect(JSON.parse(a2aRow.mentions)).toContain('店长')
    })
  })

  // ─── 角色占位符运行时注入 — @架构师/@审查者 端到端形态 ──────────
  // 回归测试：b542d24 审查结论分流断链——吐槽猫 prompt 写角色占位符 @架构师，
  // 但运行时只实现了 @作者 替换，LLM 照抄输出字面 @架构师 → mention 解析
  // 精确匹配落空 → 收口信号静默丢失（店长从未收到 ✅）。修复 = 三占位符统一
  // 运行时注入（store/reviewer 角色查真名）。本测试钉死事故教训要求的端到端
  // 形态：LLM 输出字面占位符 → system prompt 已替换 → 解析命中 → dispatch
  // 触发 → 白名单放行（seed-data 静态断言拦不住运行时断链，正是那次教训）。

  describe('角色占位符运行时注入 — @架构师/@审查者 端到端', () => {
    it('吐槽猫输出字面 @架构师 → system prompt 已替换 @店长、mention 命中、dispatch 触发店长、白名单无拦截', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, getAgentState } = await import('../dispatch/index.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const db = getDb()

      // 会话成员全角色：店长（store）+ 吐槽猫（reviewer）+ ds猫（implementer）
      // beforeEach 的 agent-1 店长 role 默认 'unknown'——补为 store（白名单判定需要真实角色）
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        '你是审查者。审查结论分流：✅可合并 → 行首@架构师 请收口；⚠️建议修改/❌需重做 → 行首@作者。',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-3',
        'ds猫',
        '🐯',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'implementer'
      )
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(['agent-1', 'agent-2', 'agent-3'])
      )

      // 审查请求消息（触发者 = ds猫 → @作者 注入 @ds猫）
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id)
         VALUES (?, ?, ?, 'agent', ?, ?, ?)`
      ).run(
        'msg-review',
        'session-1',
        'agent-3',
        '@吐槽猫 请审查 6846bb4（重启确认机制升级）',
        JSON.stringify(['吐槽猫']),
        'task-review'
      )

      // LLM 照抄 prompt 输出字面占位符（真实事故形态逐字复刻）：prompt 教「行首@架构师
      // 请收口」，LLM 格式照做、名字照抄占位符——行首是解析层（a2a-mentions 严格行首
      // 匹配）的命中前提，嵌中 @ 在真实解析下永远落空（a2c7f73 的 mock 假结果曾掩盖
      // 这一点）。尾缀「附一句给后续：…」复刻 09:02 审查 cff6bda 实况——mention 后跟
      // 空格即命中，同行尾缀不影响解析（真实 LLM 输出不会只有孤零零一句 @）
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        yield {
          content:
            '✅可合并 审查通过。\n@架构师 请收口。附一句给后续：本单无遗留项，事故链三变体已全部根治。',
          kind: 'text',
        }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
      // executeAgentsSerial 只执行「busy 且 currentTriggerMessageId === triggerMsg.id」
      // 的 agent（:696-706）——mock busy 状态放行吐槽猫执行；A2A 递归店长时
      // currentTrigger 不匹配 reply.msgId → 自然跳过（dispatch 触发即链路通，
      // 店长是否真实执行非本测试目标，与 queue drain 测试同模式）
      vi.mocked(getAgentState)
        .mockReset()
        .mockReturnValue({
          agentId: 'agent-2',
          sessionId: 'session-1',
          status: 'busy',
          queueLength: 0,
          currentTriggerMessageId: 'msg-review',
        } as any)
      // 解析层真实链路（mock 泄漏盲区修复）：a2c7f73 曾在此 mock 返回 ['店长']——
      // 断言②的「解析命中」是假结果，真实链路「LLM 照抄字面 @架构师 → 解析落空」
      // 从未被测试覆盖。文件级 vi.mock 仍 shadow 掉模块（socketio.ts 内部 import
      // 拿到的就是 mock 实例），故 vi.importActual 取真实实现注入 mock——
      // 归一化后的 content（\n@店长 请收口。）走真实精确行首匹配命中店长，
      // 断言②从 mock 假结果变为真实解析结果；精确匹配本身由 a2a-mentions.test.ts 钉死
      const realParse = (await vi.importActual('./a2a-mentions.js')) as {
        parseMentionsFromReply: (content: string, agentNames: string[]) => string[]
      }
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockImplementation(realParse.parseMentionsFromReply)
      vi.mocked(dispatch).mockReset()
      mod.__test_resetMentionCounts()

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [
          {
            id: 'agent-2',
            name: '吐槽猫',
            avatar: '😼',
            systemPrompt:
              '你是审查者。审查结论分流：✅可合并 → 行首@架构师 请收口；⚠️建议修改/❌需重做 → 行首@作者。',
            llmProvider: 'deepseek',
            llmModel: 'deepseek-v4-flash',
            llmApiKey: 'sk-test',
            role: 'reviewer',
          } as any,
        ],
        {
          id: 'msg-review',
          content: '@吐槽猫 请审查 6846bb4（重启确认机制升级）',
          mentions: ['吐槽猫'],
          taskId: 'task-review',
          authorName: 'ds猫',
        },
        'trace-review'
      )

      // 断言① 三占位符替换：@架构师→@店长、@作者→@ds猫（system prompt 无字面残留）
      const msgs = chatStream.mock.calls[0][0] as any[]
      expect(msgs[0].content).toContain('@店长 请收口')
      expect(msgs[0].content).toContain('@ds猫')
      expect(msgs[0].content).not.toContain('@架构师')
      expect(msgs[0].content).not.toContain('@作者')

      // 断言② mention 解析命中 → 店长被调度（修复前解析落空 → 零调度）
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['店长'] }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-1', name: '店长' })]),
        'trace-review',
        1 // 顶层执行 depth=0 → A2A 第一跳 +1
      )
      // 断言③ 白名单无 blocked（reviewer→store 直通；修复前是解析层静默落空，
      // 不产生 blocked emit——此处断言修复后放行且不产生误导性违规提示）
      const news = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => JSON.stringify(c[1]))
      expect(news.some((s) => s.includes('不在你的角色允许范围内'))).toBe(false)

      // 断言④ 落库契约（「原文落库 + 真名调度」双轨）：content 保持 LLM 原文
      // （@架构师 字面——归一化只作用于解析输入，不污染落库，防后人"顺手"改写
      // 落库原文制造虚假记录）；mentions 列已由 updateMessageMentions 写回解析后
      // 真名 ['店长']（:888 真实执行）——上下文过滤与前端 mentions 可见性拿到的
      // 是解析后真名。这正是「动态替换」在数据层的最终形态
      const replyMsgId = vi.mocked(dispatch).mock.calls[0][1].id as string
      const replyRow = db
        .prepare(`SELECT content, mentions FROM messages WHERE id = ?`)
        .get(replyMsgId) as any
      expect(replyRow).toBeDefined()
      expect(replyRow.content).toContain('@架构师') // 原文落库契约
      expect(JSON.parse(replyRow.mentions)).toEqual(['店长']) // 真名写回

      // 恢复文件级默认 mock（() => []），防真实实现泄漏到后续用例
      vi.mocked(parseMentionsFromReply).mockReset()
    })
  })

  // ─── resolveRolePlaceholders — 纯函数单测 ──────────
  // 三占位符替换语义钉死：@作者→触发者（authorName 存在才替换）、
  // @架构师→store 角色名、@审查者→reviewer 角色名（角色缺失保留字面零回归）。

  describe('resolveRolePlaceholders — 纯函数单测', () => {
    it('三占位符同时替换：@作者→触发者、@架构师→store 名、@审查者→reviewer 名', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )

      const { resolveRolePlaceholders } = await import('./socketio.js')
      const out = resolveRolePlaceholders(
        '请审核只 @审查者。✅可合并 → 行首@架构师 请收口；⚠️/❌ → 行首@作者。',
        'ds猫'
      )
      expect(out).toContain('@吐槽猫')
      expect(out).toContain('@店长')
      expect(out).toContain('@ds猫')
      expect(out).not.toContain('@架构师')
      expect(out).not.toContain('@审查者')
      expect(out).not.toContain('@作者')
    })

    it('角色缺失 → 保留字面（零回归：老库无 store/reviewer 角色时不替换）', async () => {
      // beforeEach 的 agent-1 店长 role 默认 'unknown'——无任何 store/reviewer 角色
      const { resolveRolePlaceholders } = await import('./socketio.js')
      const out = resolveRolePlaceholders(
        '请审核只 @审查者。✅可合并 → 行首@架构师 请收口；结论归 @作者。',
        'ds猫'
      )
      expect(out).toContain('@架构师')
      expect(out).toContain('@审查者')
      expect(out).toContain('@ds猫') // @作者 有 authorName 仍替换
    })

    it('authorName 缺失 → @作者 保留字面（用户消息触发场景）', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      const { resolveRolePlaceholders } = await import('./socketio.js')
      const out = resolveRolePlaceholders('你是审查者，结论 @作者 通知。')
      expect(out).toContain('@作者') // authorName undefined → 不替换
      expect(out).not.toContain('@店长') // 但 @架构师 占位符不在 prompt 中
    })

    it('无 @ 前缀的叙述不受影响（"是项目架构师"不误替换）', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      const { resolveRolePlaceholders } = await import('./socketio.js')
      const out = resolveRolePlaceholders('你是项目架构师，负责整体设计。')
      expect(out).toBe('你是项目架构师，负责整体设计。')
    })

    it('无占位符 → 原样返回', async () => {
      const { resolveRolePlaceholders } = await import('./socketio.js')
      const prompt = '你是审查者，逐项核对。'
      expect(resolveRolePlaceholders(prompt)).toBe(prompt)
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

    it('洞 A：message_id 非空（执行完成时已写回回复 id）→ 精确跳过，不再依赖时间窗', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      // 造数据：server_restart 记录带 message_id，但 messages 表无任何回复
      //（message_id 本身即"已回复"的精确证据——不靠时间窗猜）
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
           VALUES (?, ?, 'user', ?, '["店长"]', datetime('now', '-2 minutes'))`
        )
        .run('msg-trigger', 'session-1', '@店长 请补填交接文档')
      getDb()
        .prepare(
          `INSERT INTO execution_logs
             (id, session_id, agent_id, triggered_by_message_id, status, error_message, message_id, started_at)
           VALUES (?, ?, ?, ?, 'failed', 'server_restart', ?, datetime('now', '-1 minute'))`
        )
        .run('exec-1', 'session-1', 'agent-1', 'msg-trigger', 'msg-reply')

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).not.toHaveBeenCalled()
    })

    it('洞 A：message_id NULL（历史记录/被打断未回复）→ 回退时间窗判据，未回复即恢复', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      // 无 message_id + 无任何回复 → 时间窗判据放行 → 恢复重跑（老数据兼容路径）
      seedInterruptedExecution(getDb())

      await mod.recoverInterruptedExecutions(mockIo as any)

      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
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

    it('恢复执行 → 会话收到 system 打断告警（含猫名与『已自动恢复重跑』）', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      seedInterruptedExecution(getDb())

      await mod.recoverInterruptedExecutions(mockIo as any)

      // 广播告警（按会话聚合，消息含 agent 名与恢复语义）
      const call = mockRoomEmit.mock.calls.find((c: any[]) => c[0] === Events.NEW_MESSAGE)
      expect(call).toBeDefined()
      expect(call![1].role).toBe('system')
      expect(call![1].content).toContain('店长')
      expect(call![1].content).toContain('已自动恢复重跑')
      // 告警以 system 消息落库（刷新会话历史可见）
      const row = getDb()
        .prepare("SELECT * FROM messages WHERE role = 'system' ORDER BY created_at DESC LIMIT 1")
        .get() as any
      expect(row).toBeDefined()
      expect(row.session_id).toBe('session-1')
      expect(row.content).toContain('已自动恢复重跑')
      // 恢复本身照常执行
      expect(executeAgentCommand).toHaveBeenCalledTimes(1)
    })

    it('agent 已回复跳过恢复 → 广播计入『未重复执行』（跳过场景同样可见）', async () => {
      const mod = await import('./socketio.js')
      const { executeAgentCommand } = await import('../dispatch/index.js')
      seedInterruptedExecution(getDb(), { agentReplied: true })

      await mod.recoverInterruptedExecutions(mockIo as any)

      const call = mockRoomEmit.mock.calls.find((c: any[]) => c[0] === Events.NEW_MESSAGE)
      expect(call).toBeDefined()
      expect(call![1].role).toBe('system')
      expect(call![1].content).toContain('店长')
      expect(call![1].content).toContain('未重复执行')
      const row = getDb()
        .prepare("SELECT * FROM messages WHERE role = 'system' ORDER BY created_at DESC LIMIT 1")
        .get() as any
      expect(row).toBeDefined()
      expect(row.content).toContain('未重复执行')
      expect(executeAgentCommand).not.toHaveBeenCalled()
    })
  })

  // ─── P0 队列持久化恢复：recoverQueuedMessages ──────────
  // 与 recoverInterruptedExecutions（execution_logs 路径）互补：
  // 恢复 dispatch_state=queued/running 的消息整条重新 dispatch。

  describe('recoverQueuedMessages — P0 队列持久化恢复', () => {
    // 前置测试可能 mockReturnValue 了 getAgentState，显式重置为 undefined
    //（undefined = 槽位未初始化 → 应触发 initAgentSlot）
    beforeEach(async () => {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue(undefined)
    })

    /** 造数据：一条 dispatch_state=queued 的用户消息 + 可选 agent 回复 */
    function seedQueuedMessage(db: any, opts: { agentReplied?: boolean } = {}) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES (?, ?, 'user', ?, '["店长"]', datetime('now', '-2 minutes'))`
      ).run('msg-queued', 'session-1', '@店长 请补填交接文档')
      db.prepare('UPDATE messages SET dispatch_state = ? WHERE id = ?').run('queued', 'msg-queued')
      if (opts.agentReplied) {
        db.prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, 'agent', ?, '[]', datetime('now', '-1 minute'))`
        ).run('msg-reply', 'session-1', 'agent-1', '已补填')
      }
    }

    it('AC4: pending 消息 → dispatch 并配对执行——恢复后真实产生回复、执行收尾', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, completeExecution, initAgentSlot } = await import('../dispatch/index.js')
      const { getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      seedQueuedMessage(getDb())

      // dispatch 在测试里被 mock 为 no-op——用调用序列模拟真实路径：
      // 恢复循环先检查槽位（未初始化 → initAgentSlot），
      // 随后 executeAgentsSerial 看到 dispatch 标 busy 后的槽位状态
      //（真实路径：dispatch → executeAgentCommand 标 busy + currentTrigger=msg-queued）
      vi.mocked(getAgentState).mockReturnValueOnce(undefined).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-queued',
      })
      // adapter 返回可流式产出的 chatStream——runAgentReply 真正走 LLM 链路
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到', kind: 'text' }
        }),
      } as any)

      await mod.recoverQueuedMessages(mockIo as any)

      // ① 整条重新 dispatch（4 参：含 traceId）
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          id: 'msg-queued',
          content: '@店长 请补填交接文档',
          mentions: ['店长'],
        }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-1' })]),
        expect.any(String)
      )
      // ② 槽位初始化
      expect(initAgentSlot).toHaveBeenCalledWith('agent-1')
      // ③ 真实执行：回复已写入 DB（chatStream 产出 '收到' → runAgentReply 落库）
      //    ——只断言 dispatch 被调用会与"卡 busy 永不执行"的 bug 同构漏过
      const reply = getDb()
        .prepare(`SELECT * FROM messages WHERE role = 'agent' AND agent_id = ? AND session_id = ?`)
        .get('agent-1', 'session-1') as any
      expect(reply).toBeDefined()
      expect(reply.content).toBe('收到')
      // ④ 执行收尾：completeExecution(成功) 被调用——生产路径释放槽位回 idle
      expect(completeExecution).toHaveBeenCalledWith('agent-1', true, expect.anything())
      // ⑤ NEW_MESSAGE 广播（前端能看到恢复的回复）
      expect(mockRoomEmit).toHaveBeenCalledWith(Events.NEW_MESSAGE, expect.anything())
    })

    it('AC5: 目标 agent 已回复（回复写库后、finalize 前被杀）→ 跳过，防重复执行；全目标已回复 → dispatch_state 归一 done', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seedQueuedMessage(getDb(), { agentReplied: true })

      await mod.recoverQueuedMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
      // 洞 B：跳过 ≠ 撒手不管——处理已终结，消息不再永久 queued/running 搁浅
      const row = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get('msg-queued') as any
      expect(row.dispatch_state).toBe('done')
    })

    it('洞 B 兜底：有 server_restart 日志且未回复的 agent（interrupted 漏恢复）兜底重调度，无日志的 agent 照常恢复——一条消息一次 dispatch', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      // 双 agent 会话：agent-1 有被中断的执行日志（路径 2 的职责域），agent-2 无
      getDb()
        .prepare(
          `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('agent-2', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')
      getDb()
        .prepare('UPDATE sessions SET agent_ids = ? WHERE id = ?')
        .run(JSON.stringify(['agent-1', 'agent-2']), 'session-1')
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
           VALUES (?, ?, 'user', ?, '["店长","吐槽猫"]', datetime('now', '-2 minutes'))`
        )
        .run('msg-queued', 'session-1', '@店长 @吐槽猫 请补填')
      getDb()
        .prepare('UPDATE messages SET dispatch_state = ? WHERE id = ?')
        .run('queued', 'msg-queued')
      getDb()
        .prepare(
          `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, error_message, started_at)
           VALUES (?, ?, ?, ?, 'failed', 'server_restart', datetime('now', '-1 minute'))`
        )
        .run('exec-1', 'session-1', 'agent-1', 'msg-queued')

      await mod.recoverQueuedMessages(mockIo as any)

      // 一条消息一次 dispatch：agent-1（server_restart + 未回复 = 漏恢复，兜底补位）
      // 与 agent-2（无日志，常规恢复）合并调度——串行化后路径 2 已跑完，不再有
      // 确定性串行双跑风险
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ id: 'msg-queued' }),
        [expect.objectContaining({ id: 'agent-1' }), expect.objectContaining({ id: 'agent-2' })],
        expect.any(String)
      )
    })

    it('洞 B 边界：running execution_log（启动期间实时执行）不兜底重调度，防双跑', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      seedQueuedMessage(getDb())
      // 把 server_restart 换成 running——模拟启动期间实时执行（串行化后路径 2
      // 不会残留 running 恢复记录，running 只可能是实时执行）
      getDb()
        .prepare(
          `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
           VALUES (?, ?, ?, ?, 'running', datetime('now', '-1 minute'))`
        )
        .run('exec-1', 'session-1', 'agent-1', 'msg-queued')

      await mod.recoverQueuedMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
    })

    it('无 API key 的 agent → 跳过（无法执行）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      getDb()
        .prepare('UPDATE agents SET llm_api_key = ? WHERE id = ?')
        .run('sk-your-api-key-here', 'agent-1')
      seedQueuedMessage(getDb())

      await mod.recoverQueuedMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
    })

    it('无 pending 消息 → 不触发任何 dispatch', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')

      await mod.recoverQueuedMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
    })

    it('合并触发持久化：恢复的命令不恢复 pendingTriggers（B 合并为内存态——明写已知噪声）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      seedQueuedMessage(getDb())
      // 同 session 一条"曾被合并"的触发消息（role agent + dispatch_state NULL——
      // B 合并从不 setDispatchState，重启后无从反查"谁合并了谁"；且无法与白名单
      // 拦截区分（拦截同样 NULL），误恢复会把被拦 mention 复活——明写丢失为已知噪声。
      // created_at 设在 queued 之前（-5min）：agent 消息若在触发之后会被洞 A
      // 判为"已回复"跳过恢复，测不到"不恢复 pendingTriggers"的本意
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES (?, ?, ?, 'agent', ?, '["店长"]', datetime('now', '-5 minutes'))`
        )
        .run('msg-merged', 'session-1', 'agent-1', '@店长 跟进（曾并入排队任务）')

      vi.mocked(getAgentState).mockReturnValueOnce(undefined).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-queued',
      })
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        yield { content: '已补填', kind: 'text' }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

      await mod.recoverQueuedMessages(mockIo as any)

      // 恢复的命令 pendingTriggers 为空——LLM 上下文不得出现合并点名（"已并入本任务"）
      const llmMessages = chatStream.mock.calls[0][0] as any[]
      expect(llmMessages.some((m) => String(m.content).includes('已并入本任务'))).toBe(false)
      // 合并触发消息保持原样（NULL）——不复活不误判
      const mergedRow = getDb()
        .prepare(`SELECT dispatch_state FROM messages WHERE id = 'msg-merged'`)
        .get() as any
      expect(mergedRow.dispatch_state).toBeNull()
      // 恢复照常执行（主消息不受影响）
      expect(dispatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('replayStuckUserMessages — 静默丢重放（从未被调度的用户消息补派）', () => {
    beforeEach(async () => {
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue(undefined)
    })

    /** SQLite datetime 格式（YYYY-MM-DD HH:MM:SS，UTC）——bound 参数传
     *  datetime('now',...) 函数表达式会被存成字面量字符串（不执行），
     *  created_at 过滤类测试必须用 JS 预先算好真实时间戳 */
    function sqliteDatetime(minutesAgo: number): string {
      return new Date(Date.now() - minutesAgo * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19)
    }

    /** 造数据：一条从未被调度的用户消息（dispatch_state NULL + 无执行行 + 超窗） */
    function seedStuckMessage(db: any, overrides: any = {}) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES (?, ?, 'user', ?, ?, ?)`
      ).run(
        overrides.id || 'msg-stuck',
        'session-1',
        overrides.content || '@店长 请处理',
        overrides.mentions || JSON.stringify(['店长']),
        overrides.createdAt || sqliteDatetime(40)
      )
    }

    it('① 落库无执行行的 @ 消息 → 补派执行 + log 留痕 + 真实回复落库', async () => {
      const mod = await import('./socketio.js')
      const { dispatch, completeExecution, executeAgentCommand } =
        await import('../dispatch/index.js')
      const { getAgentState } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const db = getDb()
      seedStuckMessage(db)

      // dispatch 在测试里被 mock 为 no-op——用调用序列模拟真实路径（AC4 同款）：
      // 扫描循环先检查槽位（未初始化 → initAgentSlot），随后 executeAgentsSerial
      // 看到 dispatch 标 busy 后的槽位状态
      vi.mocked(getAgentState).mockReturnValueOnce(undefined).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-stuck',
      })
      vi.mocked(executeAgentCommand).mockImplementation(
        async (agent: any, cmd: any, traceId: string) => {
          db.prepare(
            `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
             VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
          ).run('exec-replay', cmd.sessionId, cmd.agentId, cmd.triggerMessageId, traceId)
        }
      )
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到补派', kind: 'text' }
        }),
      } as any)

      await mod.replayStuckUserMessages(mockIo as any)

      // 补派：dispatch 4 参（含 traceId）
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ id: 'msg-stuck', content: '@店长 请处理', mentions: ['店长'] }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-1' })]),
        expect.any(String)
      )
      // 配对执行：真实回复落库 + completeExecution 收尾（不配对则补派消息卡 busy）
      const reply = db
        .prepare(`SELECT * FROM messages WHERE role = 'agent' AND agent_id = ? AND session_id = ?`)
        .get('agent-1', 'session-1') as any
      expect(reply).toBeDefined()
      expect(reply.content).toBe('收到补派')
      expect(completeExecution).toHaveBeenCalledWith('agent-1', true, expect.anything())
    })

    it('② 不重复补派：已补派（有执行行）的消息二轮扫描跳过', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const { getAgentState } = await import('../dispatch/index.js')
      const db = getDb()
      seedStuckMessage(db)
      // 槽位 mock：一轮补派真实走到 executeAgentsSerial 的执行体
      vi.mocked(getAgentState).mockReturnValueOnce(undefined).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-stuck',
      })
      // dispatch 在测试里被 mock 为 no-op——用 mockImplementation 模拟真实
      // dispatch 的核心副作用（idle 直跑 executeAgentCommand → 执行行落库）：
      // 补派后必产生 execution_log，二轮 NOT EXISTS 才能天然排除
      vi.mocked(dispatch).mockImplementation(
        async (_sessionId: string, msg: any, agents: any[], traceId?: string): Promise<string> => {
          const agent = agents[0]
          db.prepare(
            `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
             VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
          ).run('exec-replay', _sessionId, agent.id, msg.id, traceId ?? '')
          return traceId ?? ''
        }
      )

      await mod.replayStuckUserMessages(mockIo as any)
      await mod.replayStuckUserMessages(mockIo as any)

      // 一轮补派 + 执行行落库 → 二轮 NOT EXISTS 天然排除——全程只 dispatch 一次
      expect(dispatch).toHaveBeenCalledTimes(1)
      const execRow = db
        .prepare(`SELECT * FROM execution_logs WHERE triggered_by_message_id = 'msg-stuck'`)
        .get() as any
      expect(execRow).toBeDefined()
    })

    it('③ 跳过面：近期消息 / 已有执行行 / dispatch_state=done 均不补派', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const db = getDb()
      // 近期（-10min，未超时窗）
      seedStuckMessage(db, { id: 'msg-recent', createdAt: sqliteDatetime(10) })
      // 已有执行行（NOT EXISTS 排除）
      seedStuckMessage(db, { id: 'msg-has-exec' })
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'completed', datetime('now', '-30 minutes'))`
      ).run('exec-exists', 'session-1', 'agent-1', 'msg-has-exec')
      // 已终结（done）
      seedStuckMessage(db, { id: 'msg-done' })
      db.prepare(`UPDATE messages SET dispatch_state = 'done' WHERE id = 'msg-done'`).run()

      await mod.replayStuckUserMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
    })

    it('④ 无有效目标（成员无 API key）→ 归一 done，防每轮空转', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const db = getDb()
      db.prepare('UPDATE agents SET llm_api_key = ? WHERE id = ?').run(
        'sk-your-api-key-here',
        'agent-1'
      )
      seedStuckMessage(db)

      await mod.replayStuckUserMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
      const row = db
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get('msg-stuck') as any
      expect(row.dispatch_state).toBe('done')
    })

    it('⑤ 广播消息（mentions=[]）→ 补派全部会话 agent', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const db = getDb()
      seedStuckMessage(db, { id: 'msg-bcast', content: '大家好', mentions: '[]' })

      await mod.replayStuckUserMessages(mockIo as any)

      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ id: 'msg-bcast' }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-1' })]),
        expect.any(String)
      )
    })

    it('⑥ 无待补派消息 → 零 dispatch 零日志', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')

      await mod.replayStuckUserMessages(mockIo as any)

      expect(dispatch).not.toHaveBeenCalled()
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

  // ─── RESTART_CONFIRM / RESTART_CANCEL — 重启确认机制 ─────

  describe('RESTART_CONFIRM', () => {
    it('pending → state=confirmed 写回文件 + 推 RESTART_STATUS confirmed + ack ok', () => {
      writeRestartRequest()
      const handlers = socketHandlers.get(Events.RESTART_CONFIRM)
      expect(handlers).toBeDefined()

      const ack = vi.fn()
      handlers![0]({ messageId: 'msg-restart' }, ack)

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('confirmed')
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ messageId: 'msg-restart', state: 'confirmed' })
      )
      expect(ack).toHaveBeenCalledWith({ ok: true })
    })

    it('confirmed 幂等：重复确认不报错、仍推 confirmed + ack ok', () => {
      writeRestartRequest({ state: 'confirmed' })
      const handlers = socketHandlers.get(Events.RESTART_CONFIRM)

      const ack = vi.fn()
      handlers![0]({ messageId: 'msg-restart' }, ack)

      expect(mockSocketEmit).not.toHaveBeenCalledWith(Events.ERROR, expect.anything())
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'confirmed' })
      )
      expect(ack).toHaveBeenCalledWith({ ok: true })
    })

    it('已过期 → 删文件 + ERROR + 推 expired + ack expired（dev.js 不会执行）', () => {
      writeRestartRequest({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      const handlers = socketHandlers.get(Events.RESTART_CONFIRM)

      const ack = vi.fn()
      handlers![0]({ messageId: 'msg-restart' }, ack)

      expect(existsSync(RESTART_REQUEST_FILE)).toBe(false)
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.ERROR,
        expect.objectContaining({ message: expect.stringContaining('已过期') })
      )
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'expired' })
      )
      expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'expired' })
    })

    it('文件不存在 → ERROR 请求已失效 + ack missing', () => {
      const handlers = socketHandlers.get(Events.RESTART_CONFIRM)

      const ack = vi.fn()
      handlers![0]({ messageId: 'msg-restart' }, ack)

      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.ERROR,
        expect.objectContaining({ message: expect.stringContaining('已失效') })
      )
      expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'missing' })
    })

    it('ack 可选：不带 ack 回调调用不报错（旧前端兼容）', () => {
      writeRestartRequest()
      const handlers = socketHandlers.get(Events.RESTART_CONFIRM)

      expect(() => handlers![0]({ messageId: 'msg-restart' })).not.toThrow()
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'confirmed' })
      )
    })
  })

  describe('RESTART_CANCEL', () => {
    it('存在请求 → 删文件 + 推 cancelled', () => {
      writeRestartRequest()
      const handlers = socketHandlers.get(Events.RESTART_CANCEL)

      handlers![0]()

      expect(existsSync(RESTART_REQUEST_FILE)).toBe(false)
      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'cancelled' })
      )
    })

    it('无请求 → 幂等推 none（前端按钮隐藏）', () => {
      const handlers = socketHandlers.get(Events.RESTART_CANCEL)

      handlers![0]()

      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'none' })
      )
    })
  })

  // ─── 重启请求 ingest 链路（前缀检测 → 文件生成 → 广播类型）─────

  describe('重启请求 ingest 链路', () => {
    it('【重启请求】前缀消息 → 写请求文件（pending）+ 广播带 messageType', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)

      await handlers![0]({
        sessionId: 'session-1',
        content: '【重启请求】原因：测试重启',
        mentions: [],
      })

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('pending')
      expect(req.sessionId).toBe('session-1')
      expect(req.reason).toBe('测试重启')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })

    it('普通消息 → 不写请求文件、广播不带 messageType', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)

      await handlers![0]({ sessionId: 'session-1', content: '你好', mentions: [] })

      expect(existsSync(RESTART_REQUEST_FILE)).toBe(false)
      const call = mockRoomEmit.mock.calls.find((c: any[]) => c[0] === Events.NEW_MESSAGE)
      expect(call![1].messageType).toBeUndefined()
    })

    it('嵌中命中：叙述 + 「：【重启请求】原因：」合并消息 → 写文件 + 广播带类型（第六次行首事故根治）', async () => {
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)

      await handlers![0]({
        sessionId: 'session-1',
        content: '收到。先自查一遍：【重启请求】原因：验证嵌中识别',
        mentions: [],
      })

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('pending')
      expect(req.reason).toBe('验证嵌中识别')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })

    it('请求文件已存在 → 第二条不覆盖（保留首个生效请求）', async () => {
      writeRestartRequest({ messageId: 'first-request' })
      const handlers = socketHandlers.get(Events.SEND_MESSAGE)

      await handlers![0]({
        sessionId: 'session-1',
        content: '【重启请求】原因：第二条',
        mentions: [],
      })

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.messageId).toBe('first-request')
    })
  })

  // ─── 重启请求 agent reply 链路（agent 路径盲区修复）─────
  // 88d5f82 只覆盖 ingest 用户消息入口；店长是 agent，其消息走 runAgentReply 的
  // finalMsg 广播路径——此前无识别 → 按钮对店长从未生效。以下两例守护该路径
  //（行首触发写入+广播带类型；非行首不触发，防"嵌在长汇报中间"事故回归）。

  describe('重启请求 agent reply 链路', () => {
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
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      })
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockImplementation(() => null as any)
      const mod = await import('./socketio.js')
      mod.__test_resetMentionCounts()
      // 触发消息必须存在于 DB，否则 runAgentReply 的 Window ② 撤回保护
      // （!messageExists → retracted）会在 LLM 调用前提前返回，不走 adapter
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', '@店长 请处理')
    })

    it('回复以【重启请求】开头 → 写请求文件（pending）+ 广播带 messageType', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '【重启请求】原因：测试重启', kind: 'text' }
        }),
      } as any)

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-restart-agent'
      )

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('pending')
      expect(req.sessionId).toBe('session-1')
      expect(req.reason).toBe('测试重启')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })

    it('回复不以【重启请求】开头 → 不写请求文件、广播不带 messageType', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到，已完成', kind: 'text' }
        }),
      } as any)

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-restart-agent'
      )

      expect(existsSync(RESTART_REQUEST_FILE)).toBe(false)
      const call = mockRoomEmit.mock.calls.find((c: any[]) => c[0] === Events.NEW_MESSAGE)
      expect(call![1].messageType).toBeUndefined()
    })

    it('嵌中命中：叙述 + 请求合并的回复 → 写请求文件 + 广播带类型（agent 真实产出模式）', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到。链路核实完毕：【重启请求】原因：服务器需要重启', kind: 'text' }
        }),
      } as any)

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-restart-agent'
      )

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('pending')
      expect(req.reason).toBe('服务器需要重启')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })

    it('MCP 信号路径：回复无文本格式但存在 restart 信号 → 写请求文件（reason 取信号）+ 广播带 messageType', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { consumeUserRequestSignals } = await import('../llm/user-request-signals.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '收到，已申请重启，请用户批准。', kind: 'text' }
        }),
      } as any)
      // 结构化信号是主路径：无文本格式也能触发（msgId 标签匹配语义在
      // user-request-signals.test.ts 单独测，此处 mock 返回值直测合并点并集）
      vi.mocked(consumeUserRequestSignals).mockReturnValueOnce([
        {
          sessionId: 'session-1',
          agentId: 'agent-1',
          msgId: 'msg-x',
          type: 'restart',
          reason: '服务器需要重启',
        },
      ])

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-restart-signal'
      )

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.state).toBe('pending')
      expect(req.reason).toBe('服务器需要重启')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })

    it('信号与文本并存 → reason 优先取信号（结构化参数是权威，文本提取为 fallback）', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { consumeUserRequestSignals } = await import('../llm/user-request-signals.js')
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '【重启请求】原因：文本里的原因', kind: 'text' }
        }),
      } as any)
      vi.mocked(consumeUserRequestSignals).mockReturnValueOnce([
        {
          sessionId: 'session-1',
          agentId: 'agent-1',
          msgId: 'msg-x',
          type: 'restart',
          reason: '信号里的原因',
        },
      ])

      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-restart-dual'
      )

      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8'))
      expect(req.reason).toBe('信号里的原因')
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ messageType: 'restart_request' })
      )
    })
  })

  // ─── AGENT_INTERRUPT — 手动停止按钮 ─────────

  describe('AGENT_INTERRUPT', () => {
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
      // 默认空闲；busy 用例内覆盖。dispatch 模块整体 mock——getAgentState 返回
      // 什么就代表什么状态（executeAgentsSerial 靠它决定是否执行）
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'idle',
        queueLength: 0,
        currentTriggerMessageId: null,
      })
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockImplementation(() => null as any)
      const mod = await import('./socketio.js')
      mod.__test_resetMentionCounts()
      // 触发消息必须存在于 DB，否则 runAgentReply 的 Window ② 撤回保护
      // （!messageExists → retracted）会在 LLM 调用前提前返回，不走 adapter
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', '@店长 请处理')
    })

    it('busy agent 收到中断 → abort、无回复落库、completeExecution(false)、队列清空', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { getAgentState, completeExecution, clearAgentQueue } =
        await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue({
        agentId: 'agent-1',
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 1,
        currentTriggerMessageId: 'msg-trigger',
      })

      // 门控流：首个 chunk 产出后挂起，等中断触发再释放——模拟"思考中"被用户停止。
      // mock adapter 不感知 signal，abort 后流恢复时由 runAgentReply 流循环的
      // signal.aborted 检查提前返回（真实 adapter 会在 abort 时 kill 子进程）
      let releaseGate = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const chatStream = vi.fn(async function* () {
        yield { content: '思考中', kind: 'text' }
        await gate
        yield { content: '被中断的剩余内容', kind: 'text' }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

      const execPromise = mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 请处理', mentions: ['店长'] },
        'trace-interrupt'
      )

      // 等流式已产出首个 chunk（执行确实在跑，中断才有的放矢）
      await vi.waitFor(() => {
        expect(mockRoomEmit).toHaveBeenCalledWith(
          Events.AGENT_TYPING,
          expect.objectContaining({ content: '思考中' })
        )
      })

      // 用户点停止：中断 handler → 清队 + abort 当前执行
      const handlers = socketHandlers.get(Events.AGENT_INTERRUPT)
      expect(handlers).toBeDefined()
      handlers![0]({ agentId: 'agent-1' })
      expect(clearAgentQueue).toHaveBeenCalledWith('agent-1')

      releaseGate()
      await execPromise

      // 无回复落库（runAgentReply 检测到 abort 后提前返回，未 insertAgentMessage）
      const agentMsgs = getDb()
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE role = 'agent'")
        .get() as { c: number }
      expect(agentMsgs.c).toBe(0)

      // 失败路径收口：completeExecution(false, interrupted)——部分内容不能当正常回复
      expect(completeExecution).toHaveBeenCalledWith(
        'agent-1',
        false,
        expect.objectContaining({ errorMessage: 'interrupted' })
      )
      // 未被当正常成功执行收口（防 A2A 解析误触发）
      expect(completeExecution).not.toHaveBeenCalledWith('agent-1', true, expect.anything())

      // 「已停止」系统消息广播进 session 房间（handler 或执行循环，内容一致）
      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ content: '🐱 店长 已停止（用户中断）' })
      )

      // 无 A2A mention 触发（MESSAGE_UPDATED 是 A2A 写回 mentions 的信号）
      expect(mockRoomEmit).not.toHaveBeenCalledWith(Events.MESSAGE_UPDATED, expect.anything())
    })

    it('idle agent 收到中断 → 幂等无操作（不广播、不报错）', async () => {
      const { clearAgentQueue } = await import('../dispatch/index.js')
      const handlers = socketHandlers.get(Events.AGENT_INTERRUPT)

      handlers![0]({ agentId: 'agent-1' })

      // 队列/abort 都无实际对象可操作——clearAgentQueue 幂等返回 0，无系统消息广播
      expect(clearAgentQueue).toHaveBeenCalledWith('agent-1')
      expect(mockRoomEmit).not.toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ content: expect.stringContaining('已停止') })
      )
      expect(mockSocketEmit).not.toHaveBeenCalledWith(Events.ERROR, expect.anything())
    })

    it('未知 agentId → 完全无操作（不碰队列）', async () => {
      const { getAgentState, clearAgentQueue } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockReturnValue(undefined)
      const handlers = socketHandlers.get(Events.AGENT_INTERRUPT)

      handlers![0]({ agentId: 'agent-ghost' })

      expect(clearAgentQueue).not.toHaveBeenCalled()
      expect(mockRoomEmit).not.toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ content: expect.stringContaining('已停止') })
      )
    })
  })

  // ─── JOIN_SESSION 重启状态推送 ─────────────────

  describe('JOIN_SESSION 重启状态推送', () => {
    it('请求存在且属于本会话 → 推当前状态（刷新后按钮恢复）', () => {
      writeRestartRequest()
      const handlers = socketHandlers.get(Events.JOIN_SESSION)

      handlers![0]('session-1')

      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({
          sessionId: 'session-1',
          messageId: 'msg-restart',
          state: 'pending',
        })
      )
    })

    it('请求属于其他会话 → 推 none（不串台）', () => {
      writeRestartRequest({ sessionId: 'session-other' })
      const handlers = socketHandlers.get(Events.JOIN_SESSION)

      handlers![0]('session-1')

      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'none' })
      )
    })

    it('无请求 → 推 none 复位', () => {
      const handlers = socketHandlers.get(Events.JOIN_SESSION)

      handlers![0]('session-1')

      expect(mockSocketEmit).toHaveBeenCalledWith(
        Events.RESTART_STATUS,
        expect.objectContaining({ state: 'none' })
      )
    })
  })

  // ─── broadcastRestartDone — 启动广播重启完成 ─────────

  describe('broadcastRestartDone', () => {
    it('启动时存在 .restart-done → system 消息落库 + 广播 + 删文件', async () => {
      writeFileSync(
        RESTART_DONE_FILE,
        JSON.stringify({
          sessionId: 'session-1',
          reason: '测试重启',
          completedAt: new Date().toISOString(),
        })
      )

      const httpServer = createServer()
      const mod = await import('./socketio.js')
      mod.createSocketIO(httpServer)

      // broadcastRestartDone 是 fire-and-forget，等微任务完成
      await vi.waitFor(() => expect(existsSync(RESTART_DONE_FILE)).toBe(false))

      expect(mockRoomEmit).toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ role: 'system', content: expect.stringContaining('重启完成') })
      )
      const row = getDb()
        .prepare("SELECT * FROM messages WHERE role = 'system' ORDER BY created_at DESC LIMIT 1")
        .get() as any
      expect(row).toBeDefined()
      expect(row.content).toContain('重启完成（原因：测试重启）')
    })

    it('done 广播落库后 join 会话 → 历史含「🔄 重启完成」消息（刷新后可见）', async () => {
      writeFileSync(
        RESTART_DONE_FILE,
        JSON.stringify({
          sessionId: 'session-1',
          reason: '测试重启',
          completedAt: new Date().toISOString(),
        })
      )

      const httpServer = createServer()
      const mod = await import('./socketio.js')
      mod.createSocketIO(httpServer)

      // broadcastRestartDone 是 fire-and-forget，等落库完成（删文件即广播已完成）
      await vi.waitFor(() => expect(existsSync(RESTART_DONE_FILE)).toBe(false))

      // join 会话 → SESSION_HISTORY 应包含「重启完成」system 消息
      const handlers = socketHandlers.get(Events.JOIN_SESSION)
      mockSocketEmit.mockClear()
      handlers![0]('session-1')

      const call = mockSocketEmit.mock.calls.find((c: any[]) => c[0] === Events.SESSION_HISTORY)!
      const sys = call[1].messages.find((m: any) => m.role === 'system')
      expect(sys).toBeDefined()
      expect(sys.content).toContain('重启完成（原因：测试重启）')
    })

    it('done 的会话已删除 → 静默清理标记不抛错', async () => {
      writeFileSync(
        RESTART_DONE_FILE,
        JSON.stringify({
          sessionId: 'ghost-session',
          reason: 'x',
          completedAt: new Date().toISOString(),
        })
      )

      const httpServer = createServer()
      const mod = await import('./socketio.js')
      mod.createSocketIO(httpServer)

      await vi.waitFor(() => expect(existsSync(RESTART_DONE_FILE)).toBe(false))
      // 未广播（会话不存在，FK 失败被捕获）
      expect(mockRoomEmit).not.toHaveBeenCalledWith(
        Events.NEW_MESSAGE,
        expect.objectContaining({ role: 'system' })
      )
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

  // ─── MCP 结构化路由 — 合并点 + M1 防线（Phase 1 契约 5） ──────

  describe('MCP 结构化路由 — 合并点 + M1 防线', () => {
    const execAgentCfg = {
      id: 'agent-1',
      name: '店长',
      avatar: '🐱',
      systemPrompt: 'You are a cat.',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      llmApiKey: 'sk-test',
    }

    /** 在 session-1 中加入第二个 agent（吐槽猫），供路由目标使用 */
    function seedSecondAgent(db: any) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('agent-2', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-flash', 'sk-test')
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(['agent-1', 'agent-2'])
      )
    }

    beforeEach(async () => {
      // agent 状态必须 busy 且 currentTriggerMessageId 与触发消息匹配，
      // executeOneAgent 才会真正执行 runAgentReply（否则跳过、合并点不跑）
      const { getAgentState } = await import('../dispatch/index.js')
      vi.mocked(getAgentState).mockImplementation((agentId: string) => ({
        agentId,
        sessionId: 'session-1',
        status: 'busy',
        queueLength: 0,
        currentTriggerMessageId: 'msg-trigger',
      }))
      const { getAdapterForAgent } = await import('../llm/registry.js')
      vi.mocked(getAdapterForAgent).mockImplementation(() => null as any)
      const mod = await import('./socketio.js')
      mod.__test_resetMentionCounts()
      mod.__test_resetM1Warned()
      // 防线默认不响；信号默认无（各用例按需定制）
      const { parseMentionsFromReply, detectUnknownHandle, detectInlineMentions } =
        await import('./a2a-mentions.js')
      vi.mocked(parseMentionsFromReply).mockReset()
      vi.mocked(parseMentionsFromReply).mockReturnValue([])
      vi.mocked(detectUnknownHandle).mockReset()
      vi.mocked(detectUnknownHandle).mockReturnValue(null)
      vi.mocked(detectInlineMentions).mockReset()
      vi.mocked(detectInlineMentions).mockReturnValue([])
      const { consumeRouteSignals } = await import('../llm/route-signals.js')
      vi.mocked(consumeRouteSignals).mockReset()
      vi.mocked(consumeRouteSignals).mockReturnValue([])
    })

    /** 插入一条触发消息（Window ② 撤回保护要求触发消息存在于 DB） */
    function seedTrigger(content = '@店长 派活'): void {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run('msg-trigger', 'session-1', content)
    }

    it('验收2-汇入式：流中信号（无文本 @）→ mentions 写回含目标 + dispatch 一次 + 配额计 1', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { consumeRouteSignals } = await import('../llm/route-signals.js')
      seedSecondAgent(getDb())
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '已处理，无需 @', kind: 'text' }
        }),
      } as any)
      vi.mocked(consumeRouteSignals).mockReturnValue([
        { sessionId: 'session-1', agentId: 'agent-1', msgId: 'msg-x', targetCats: ['吐槽猫'] },
      ])
      seedTrigger()

      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-signal',
        1
      )

      // dispatch 恰好一次，目标吐槽猫（agent-2）
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['吐槽猫'] }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-2' })]),
        'trace-signal',
        2 // 入参 depth=1 → 递归调度 +1 = 2
      )
      // mentions 写回 DB（:931 updateMessageMentions）
      const replyRow = getDb()
        .prepare(`SELECT * FROM messages WHERE role = 'agent' AND content LIKE '%已处理%'`)
        .get() as any
      expect(replyRow).toBeDefined()
      expect(JSON.parse(replyRow.mentions)).toEqual(['吐槽猫'])
      // 配额计 1（A2A 链 depth>0 计数执行者 agent-1）
      expect(mod.__getMentionCount('trace-signal', 'agent-1')).toBe(1)
    })

    it('验收3-双通道同目标：信号 + 文本行首 @ 同目标 → mentions 一次、dispatch 一次、配额计 1', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { parseMentionsFromReply } = await import('./a2a-mentions.js')
      const { consumeRouteSignals } = await import('../llm/route-signals.js')
      seedSecondAgent(getDb())
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '@吐槽猫 请审查', kind: 'text' }
        }),
      } as any)
      // 双通道同目标：文本行首 @ + 信号
      vi.mocked(parseMentionsFromReply).mockReturnValue(['吐槽猫'])
      vi.mocked(consumeRouteSignals).mockReturnValue([
        { sessionId: 'session-1', agentId: 'agent-1', msgId: 'msg-x', targetCats: ['吐槽猫'] },
      ])
      seedTrigger()

      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-dual',
        1
      )

      // Set 去重：dispatch 一次、mentions 一次
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ mentions: ['吐槽猫'] }),
        expect.arrayContaining([expect.objectContaining({ id: 'agent-2' })]),
        'trace-dual',
        2 // 入参 depth=1 → 递归调度 +1 = 2
      )
      const replyRow = getDb()
        .prepare(`SELECT * FROM messages WHERE role = 'agent' AND content LIKE '%请审查%'`)
        .get() as any
      expect(JSON.parse(replyRow.mentions)).toEqual(['吐槽猫']) // 一次，非重复
      expect(mod.__getMentionCount('trace-dual', 'agent-1')).toBe(1) // 配额单计数（执行者）
    })

    it('验收4-工具成功 + 末段嵌句 @ → M1 零告警（防线只在全链路失败时响）', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { detectInlineMentions } = await import('./a2a-mentions.js')
      const { consumeRouteSignals } = await import('../llm/route-signals.js')
      seedSecondAgent(getDb())
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '已处理，位置：@吐槽猫 请审查', kind: 'text' }
        }),
      } as any)
      // 工具成功（信号路由）+ 文本嵌句存在（防线检测会命中）——
      // 但路由已成功 → M1 不响
      vi.mocked(consumeRouteSignals).mockReturnValue([
        { sessionId: 'session-1', agentId: 'agent-1', msgId: 'msg-x', targetCats: ['吐槽猫'] },
      ])
      vi.mocked(detectInlineMentions).mockReturnValue(['吐槽猫'])
      seedTrigger()

      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-ok'
      )

      expect(dispatch).toHaveBeenCalledTimes(1) // 路由正常
      // M1 零告警：无「嵌句」系统消息
      const news = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => JSON.stringify(c[1]))
      expect(news.some((s) => s.includes('嵌句'))).toBe(false)
    })

    it('验收5-M1 重放：ds猫 历史失败形态（全链路失败 + 末段嵌句）→ 点名 + 频控', async () => {
      const mod = await import('./socketio.js')
      const { dispatch } = await import('../dispatch/index.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')
      const { detectInlineMentions } = await import('./a2a-mentions.js')
      const { consumeRouteSignals } = await import('../llm/route-signals.js')
      seedSecondAgent(getDb())
      vi.mocked(getAdapterForAgent).mockReturnValue({
        chatStream: vi.fn(async function* () {
          yield { content: '实施完成。\n\n位置：@店长 请收口', kind: 'text' }
        }),
      } as any)
      // 全链路失败：无信号、无文本行首 @
      vi.mocked(consumeRouteSignals).mockReturnValue([])
      vi.mocked(detectInlineMentions).mockReturnValue(['店长'])
      seedTrigger()

      vi.mocked(dispatch).mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-m1'
      )

      // 无路由（dispatch 零调用）
      expect(dispatch).not.toHaveBeenCalled()
      // M1 点名：系统消息含「嵌句」+ 正确规则提示
      const news = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => c[1] as any)
      const m1Msg = news.find((n) => n.role === 'system' && String(n.content).includes('嵌句'))
      expect(m1Msg).toBeDefined()
      expect(String(m1Msg.content)).toContain('店长')
      expect(String(m1Msg.content)).toContain('行首独占一行')

      // 频控：同 agent 二次触发（5 分钟内）→ 不再告警
      mockRoomEmit.mockClear()
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活', mentions: ['店长'] },
        'trace-m1-again'
      )
      const news2 = mockRoomEmit.mock.calls
        .filter((c: any[]) => c[0] === Events.NEW_MESSAGE)
        .map((c: any[]) => c[1] as any)
      expect(news2.some((n) => n.role === 'system' && String(n.content).includes('嵌句'))).toBe(
        false
      )
    })

    it('验收-装配链（审查知会②）：signalToken 每 spawn 随机 + context 与 activeStreams 存值一致 + triggerAuthorName 透传', async () => {
      const mod = await import('./socketio.js')
      const { getAdapterForAgent } = await import('../llm/registry.js')

      // 第一次执行：gate 挂起流——流存活期间断言 context 与 activeStreams 存值
      // 一致（:2396 完成时 delete，完成后再查只剩 undefined）
      let release: () => void
      const gate = new Promise<void>((r) => (release = r))
      const chatStream = vi.fn(async function* (_messages: any[], _opts: any) {
        yield { content: '已处理，无需 @', kind: 'text' }
        await gate
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
      seedTrigger('@店长 派活一')

      const run1 = mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活一', mentions: ['店长'], authorName: '实施猫' },
        'trace-asmb1',
        1
      )
      await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

      // context 与 activeStreams 存值同源（token/msgId 一致），triggerAuthorName 透传
      const ctx = chatStream.mock.calls[0][1].context
      const stream = mod.getActiveStream('agent-1')
      expect(stream).toBeDefined()
      expect(stream!.sessionId).toBe('session-1')
      expect(ctx).toMatchObject({
        sessionId: 'session-1',
        agentId: 'agent-1',
        msgId: stream!.messageId,
        token: stream!.token,
        traceId: 'trace-asmb1',
        triggerAuthorName: '实施猫',
      })

      // 放行完成第一次执行
      release!()
      await run1

      // 第二次执行：新 spawn 新 token（每 spawn 随机——activeStreams 存值随之更新）
      const chatStream2 = vi.fn(async function* (_messages: any[], _opts: any) {
        yield { content: '已处理二', kind: 'text' }
      })
      // 注意属性名必须叫 chatStream（runAgentReply 访问 adapter.chatStream）
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream: chatStream2 } as any)
      await mod.executeAgentsSerial(
        mockIo as any,
        'session-1',
        [execAgentCfg as any],
        { id: 'msg-trigger', content: '@店长 派活二', mentions: ['店长'] },
        'trace-asmb2',
        1
      )
      const ctx2 = chatStream2.mock.calls[0][1].context
      expect(ctx2.token).not.toBe(ctx.token)
    })
  })
})

// ═══ Pure utility functions (no DB/mock dependencies) ═══

import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  getRelevantMessages,
} from './socketio.js'

// ═══ getRelevantMessages — 消息可见性过滤（纯函数） ═══
// 原 socketio-context.test.ts 归并于此（同源文件测试归一）。

function userMsg(content: string, mentions: string[] = []) {
  return {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    mentions: JSON.stringify(mentions),
  }
}

function agentMsg(content: string, agentId: string, mentions: string[] = []) {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    role: 'agent',
    agent_id: agentId,
    content,
    mentions: JSON.stringify(mentions),
  }
}

describe('getRelevantMessages', () => {
  const AGENT_ID = 'agent-tucao'
  const AGENT_NAME = '吐槽猫'
  const OTHER_ID = 'agent-dianzhang'
  const OTHER_NAME = '店长'

  describe('用户消息', () => {
    it('无 @mention（广播）→ 所有 agent 可见', () => {
      const msgs = [userMsg('大家早上好', [])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('@mention 了当前 agent → 可见', () => {
      const msgs = [userMsg('帮我review', ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('帮我review')
    })

    it('@mention 了其他 agent → 当前 agent 不可见', () => {
      const msgs = [userMsg('店长接客', ['店长'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })

    it('@mention 了多个 agent，包含当前 → 可见', () => {
      const msgs = [userMsg('你们两个看看', ['店长', '吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('@mention 了多个 agent，不包含当前 → 不可见', () => {
      const msgs = [userMsg('你们两个看看', ['店长', 'ds猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })
  })

  describe('Agent 回复', () => {
    it('自己的回复 → 可见（作为 assistant）', () => {
      const msgs = [agentMsg('我来看看', AGENT_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('其他 agent 回复，非广播模式 → 不可见（除非 @mention 了当前）', () => {
      const msgs = [agentMsg('没问题', OTHER_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })

    it('其他 agent 回复中 @mention 了当前 agent → 可见（review 链）', () => {
      const msgs = [agentMsg('@吐槽猫 你看看', OTHER_ID, ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('@吐槽猫 你看看')
    })

    it('广播模式下 → 所有 agent 回复可见', () => {
      const msgs = [agentMsg('没问题', OTHER_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(1)
    })

    it('广播模式下自己的回复也可见', () => {
      const msgs = [agentMsg('我来看看', AGENT_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(1)
    })
  })

  describe('混合消息', () => {
    it('正确过滤混合场景：用户广播 + 定向 + agent 回复', () => {
      const msgs = [
        userMsg('早上好', []), // 广播 → 可见
        userMsg('店长接客', ['店长']), // 定向店长 → 不可见
        userMsg('吐槽猫 review', ['吐槽猫']), // 定向吐槽猫 → 可见
        agentMsg('好的', OTHER_ID), // 非广播 → 不可见
        agentMsg('收到 @吐槽猫', OTHER_ID, ['吐槽猫']), // @了吐槽猫 → 可见
        agentMsg('review结果来了', AGENT_ID), // 自己的 → 可见
      ]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(4)
      expect(result.map((m: any) => m.content)).toEqual([
        '早上好',
        '吐槽猫 review',
        '收到 @吐槽猫',
        'review结果来了',
      ])
    })

    it('广播模式下：所有 agent 回复可见 + 用户消息仍按 mention 过滤', () => {
      // 广播模式只影响 agent 回复——所有 agent 回复都可见。
      // 用户消息仍然按 mention 过滤：定向 @店长 的消息吐槽猫看不到。
      const msgs = [
        userMsg('早上好', []), // 无 @mention → 可见
        userMsg('店长接客', ['店长']), // 定向店长 → 吐槽猫不可见
        agentMsg('好的', OTHER_ID), // 广播模式 → 可见
        agentMsg('收到', AGENT_ID), // 广播模式 → 可见
      ]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(3)
      expect(result.map((m: any) => m.content)).toEqual(['早上好', '好的', '收到'])
    })

    it('非广播模式下定向其他 agent 的用户消息被丢弃', () => {
      const msgs = [userMsg('店长过来', ['店长']), userMsg('吐槽猫过来', ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('吐槽猫过来')
    })
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

  it('多人 @mention 中包含当前 agent → 对你', () => {
    expect(formatAudienceTag(['吐槽猫', '店长', 'ds猫'], '吐槽猫')).toBe('对你')
    expect(formatAudienceTag(['店长', '吐槽猫'], '吐槽猫')).toBe('对你')
  })

  it('当前 agent 不在 @mention 中 → 对大家', () => {
    expect(formatAudienceTag(['店长'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['店长', 'ds猫'], '吐槽猫')).toBe('对大家')
  })

  it('名称精确匹配，不部分命中', () => {
    expect(formatAudienceTag(['小吐槽猫'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['吐槽'], '吐槽猫')).toBe('对大家')
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

  it('未知猫咪回退名也正常格式化', () => {
    expect(formatAgentMessage('未知猫咪', '喵~')).toBe('Direct message from 未知猫咪\n\n喵~')
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

// ─── per-agent 静态运行配置透传（单A：llm_max_tokens/llm_temperature） ──────

describe('runAgentReply — per-agent 静态运行配置透传', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  async function runWithAgent(agent: any) {
    const mod = await import('./socketio.js')
    const { getAdapterForAgent } = await import('../llm/registry.js')
    const { getAgentState } = await import('../dispatch/index.js')
    const chatStream = vi.fn(async function* (_m: any[], _o: any) {
      yield { content: '透传测试', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    // executeOneAgent 只执行"本次 dispatch 标记的执行"：状态必须 busy 且
    // currentTriggerMessageId 匹配触发消息，否则提前 return 不走 adapter
    vi.mocked(getAgentState).mockReturnValue({
      agentId: agent.id,
      sessionId: 'session-tf',
      status: 'busy',
      queueLength: 0,
      currentTriggerMessageId: 'msg-tf',
    })

    getDb()
      .prepare(
        `INSERT INTO sessions (id, title, agent_ids) VALUES ('session-tf', 'tf', '["agent-tf"]')`
      )
      .run()
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES ('msg-tf', 'session-tf', 'user', '@ds猫 透传', '["ds猫"]')`
      )
      .run()

    await mod.executeAgentsSerial(
      mockIo as any,
      'session-tf',
      [agent],
      { id: 'msg-tf', content: '@ds猫 透传', mentions: ['ds猫'] },
      'trace-tf'
    )
    return chatStream
  }

  it('agent 配置 llmMaxTokens/llmTemperature → chatStream options 透传', async () => {
    const chatStream = await runWithAgent({
      id: 'agent-tf',
      name: 'ds猫',
      avatar: '🐱',
      systemPrompt: 'prompt',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: 'sk-test',
      llmMaxTokens: 4096,
      llmTemperature: 1.2,
    })

    const opts = chatStream.mock.calls[0][1] as any
    expect(opts.maxTokens).toBe(4096)
    expect(opts.temperature).toBe(1.2)
  })

  it('agent 无配置 → options 不传 maxTokens/temperature（适配器兜底 2048/0.7）', async () => {
    const chatStream = await runWithAgent({
      id: 'agent-tf',
      name: 'ds猫',
      avatar: '🐱',
      systemPrompt: 'prompt',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: 'sk-test',
    })

    const opts = chatStream.mock.calls[0][1] as any
    expect('maxTokens' in opts).toBe(false)
    expect('temperature' in opts).toBe(false)
  })
})

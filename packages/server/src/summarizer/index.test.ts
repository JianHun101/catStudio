/**
 * Summarizer tests — 增量摘要引擎的单元测试。
 *
 * Mock chatComplete (HTTP 调用)，用内存 SQLite 验证：
 * - 开关控制、首次摘要、增量合并、间隔跳过、异常降级
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb } from '../db/index.js'

const mockChatComplete = vi.fn()

vi.mock('../llm/complete.js', () => ({
  chatComplete: mockChatComplete,
}))

describe('summarizer', () => {
  let db: Database.Database
  let summarizer: typeof import('./index.js')

  const originalEnv = { ...process.env }

  beforeAll(async () => {
    summarizer = await import('./index.js')
  })

  beforeEach(() => {
    process.env = { ...originalEnv }
    db = createTestDb()
    setDb(db)
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetDb()
  })

  // ── helpers ──

  function insertAgent(id: string, name: string) {
    db.prepare('INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      'test prompt',
      'sk-test'
    )
  }

  function insertSession(id: string) {
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, 'test')
  }

  /** 插入消息，可选指定 agentId 和 created_at 偏移（秒） */
  function insertMsg(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    opts?: { agentId?: string; secondsAgo?: number }
  ) {
    const agentId = opts?.agentId || null
    const offset = opts?.secondsAgo ?? 0
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-${offset} seconds'))`
    ).run(id, sessionId, role, content, agentId)
  }

  // ── tests ──

  it('returns null when SUMMARY_ENABLED is false', async () => {
    process.env.SUMMARY_ENABLED = 'false'
    process.env.SUMMARY_API_KEY = 'sk-test'
    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'hello')

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
  })

  it('returns null when SUMMARY_API_KEY is not set', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    delete process.env.SUMMARY_API_KEY
    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'hello')

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
  })

  it('returns null when session has no messages', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    insertSession('s1')

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
  })

  it('generates first summary from all messages and stores it', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    mockChatComplete.mockResolvedValue('first summary text')

    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'hello', { secondsAgo: 10 })
    insertMsg('m2', 's1', 'user', 'world', { secondsAgo: 5 })

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBe('first summary text')
    expect(mockChatComplete).toHaveBeenCalledTimes(1)

    // DB 中应存储 running_summary 和 summary_msg_id
    const row = db
      .prepare('SELECT running_summary, summary_msg_id FROM sessions WHERE id = ?')
      .get('s1') as any
    const parsed = JSON.parse(row.running_summary)
    expect(parsed.text).toBe('first summary text')
    expect(parsed.lastMessageId).toBe('m2')
    expect(parsed.roundCount).toBe(1)
    expect(row.summary_msg_id).toBe('m2')

    // prompt 应包含所有消息的文本
    const userPrompt = mockChatComplete.mock.calls[0][1] as string
    expect(userPrompt).toContain('hello')
    expect(userPrompt).toContain('world')
  })

  it('formats agent messages with agent name in summary prompt', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    mockChatComplete.mockResolvedValue('summary with agent')

    insertSession('s1')
    insertAgent('a1', '店长')
    insertMsg('m1', 's1', 'user', 'hello', { secondsAgo: 5 })
    insertMsg('m2', 's1', 'agent', '喵~你好', { agentId: 'a1', secondsAgo: 2 })

    await summarizer.updateRunningSummary('s1', db)

    const userPrompt = mockChatComplete.mock.calls[0][1] as string
    expect(userPrompt).toContain('[店长]')
  })

  it('merges new messages with existing summary incrementally', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    process.env.SUMMARY_INTERVAL = '1' // 每轮都触发

    mockChatComplete.mockResolvedValue('first summary')
    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'round one', { secondsAgo: 20 })

    // 第一轮：无旧摘要 → 全量生成
    await summarizer.updateRunningSummary('s1', db)

    // 第二轮：有旧摘要 → 增量合并
    insertMsg('m2', 's1', 'user', 'round two', { secondsAgo: 5 })
    mockChatComplete.mockResolvedValue('incrementally merged')

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBe('incrementally merged')

    // prompt 中应包含旧摘要文本和新消息
    const userPrompt = mockChatComplete.mock.calls[1][1] as string
    expect(userPrompt).toContain('first summary')
    expect(userPrompt).toContain('round two')
    // 不应包含第一轮的消息正文（已被旧摘要替代）
    expect(userPrompt).not.toContain('round one')
  })

  it('skips LLM when round is not at interval but still advances roundCount', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    process.env.SUMMARY_INTERVAL = '3' // 每 3 轮触发一次

    mockChatComplete.mockResolvedValue('first')
    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'msg 1', { secondsAgo: 20 })

    // 第 1 轮：无旧摘要 → 总是触发
    await summarizer.updateRunningSummary('s1', db)
    expect(mockChatComplete).toHaveBeenCalledTimes(1)

    insertMsg('m2', 's1', 'user', 'msg 2', { secondsAgo: 5 })

    // 第 2 轮：roundCount=2，2%3≠0 → 跳过 LLM
    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
    expect(mockChatComplete).toHaveBeenCalledTimes(1) // 未再次调用

    // roundCount 仍应推进到 2（否则下次还是 1，永远不会触发）
    const row = db.prepare('SELECT running_summary FROM sessions WHERE id = ?').get('s1') as any
    const parsed = JSON.parse(row.running_summary)
    expect(parsed.roundCount).toBe(2)
  })

  it('treats corrupted running_summary as first summary', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    mockChatComplete.mockResolvedValue('fresh from corruption')

    insertSession('s1')
    // 写入损坏的 JSON
    db.prepare('UPDATE sessions SET running_summary = ? WHERE id = ?').run('{bad json!!!', 's1')
    insertMsg('m1', 's1', 'user', 'hello', { secondsAgo: 5 })

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBe('fresh from corruption')

    // prompt 中不应有旧摘要，而是初始占位文本
    const userPrompt = mockChatComplete.mock.calls[0][1] as string
    expect(userPrompt).toContain('（无，这是对话的开始）')
  })

  it('returns null when LLM returns empty string', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    mockChatComplete.mockResolvedValue('')

    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'hello', { secondsAgo: 5 })

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
  })

  it('returns null when LLM throws', async () => {
    process.env.SUMMARY_ENABLED = 'true'
    process.env.SUMMARY_API_KEY = 'sk-test'
    mockChatComplete.mockRejectedValue(new Error('API error'))

    insertSession('s1')
    insertMsg('m1', 's1', 'user', 'hello', { secondsAgo: 5 })

    const result = await summarizer.updateRunningSummary('s1', db)
    expect(result).toBeNull()
  })
})

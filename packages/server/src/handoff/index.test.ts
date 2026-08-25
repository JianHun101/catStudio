import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Events } from '@cat-study/shared'
import {
  shouldHandoff,
  injectSummaryIntoSystem,
  nextHandoffTitle,
  performHandoff,
  resolveHandoffTarget,
} from './index.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { chatComplete } from '../llm/complete.js'

// performHandoff 的 generateFullSummary 调 chatComplete → mock 掉，避免真实 LLM 调用
vi.mock('../llm/complete.js', () => ({
  chatComplete: vi.fn().mockResolvedValue('测试总结内容'),
}))

describe('handoff', () => {
  describe('shouldHandoff', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    it('returns true when tokens >= 90% of max', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      // 5400 >= 6000 * 0.9 = 5400
      expect(shouldHandoff(5400)).toBe(true)
      expect(shouldHandoff(6000)).toBe(true)
    })

    it('returns false when tokens < 90% of max', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      expect(shouldHandoff(5399)).toBe(false)
      expect(shouldHandoff(0)).toBe(false)
    })

    it('returns false when handoff is disabled', () => {
      process.env.HANDOFF_ENABLED = 'false'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      expect(shouldHandoff(10000)).toBe(false)
    })

    it('respects custom threshold', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '8000'
      process.env.HANDOFF_THRESHOLD = '0.8'
      expect(shouldHandoff(6400)).toBe(true)
      expect(shouldHandoff(6399)).toBe(false)
    })

    it('triggers at 90% with realistic 128K context (regression test)', () => {
      // 验证：128K 模型，截断前消息总 token 数 ≥115200 时应触发交接。
      // 这是对 bug #handoff-deadlock 的回归测试：
      //   截断将消息锁死在预算内，截断后检查永远达不到 90%（115200）。
      //   修复后 socketio.ts 在截断前计算消息总 token 并传给 shouldHandoff。
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '128000'
      process.env.HANDOFF_THRESHOLD = '0.9'

      // 截断后典型值（~75000）不应触发
      expect(shouldHandoff(75000)).toBe(false)

      // 截断前典型值（~120000）应触发
      expect(shouldHandoff(120000)).toBe(true)

      // 正好 90%（115200）应触发
      expect(shouldHandoff(115200)).toBe(true)
      // 差 1 token 不应触发
      expect(shouldHandoff(115199)).toBe(false)
    })
  })

  describe('nextHandoffTitle', () => {
    it('普通标题追加（1）', () => {
      expect(nextHandoffTitle('猫咖日常')).toBe('猫咖日常（1）')
    })

    it('结尾全角编号递增', () => {
      expect(nextHandoffTitle('猫咖日常（1）')).toBe('猫咖日常（2）')
      expect(nextHandoffTitle('猫咖日常（3）')).toBe('猫咖日常（4）')
    })

    it('存量「（续）」脏标题收敛为（1）', () => {
      expect(nextHandoffTitle('猫咖日常（续）')).toBe('猫咖日常（1）')
      expect(nextHandoffTitle('猫咖日常（续）（续）')).toBe('猫咖日常（1）')
    })

    it('脏标题 + 编号混合：先剥「（续）」再递增', () => {
      expect(nextHandoffTitle('猫咖日常（1）（续）')).toBe('猫咖日常（2）')
    })

    it('半角括号编号不递增（用户自拟命名不碰）', () => {
      expect(nextHandoffTitle('猫咖日常(1)')).toBe('猫咖日常(1)（1）')
    })

    it('空标题 / 纯「（续）」不炸、输出可预期', () => {
      expect(nextHandoffTitle('')).toBe('（1）')
      expect(nextHandoffTitle('（续）')).toBe('（1）')
    })
  })

  describe('injectSummaryIntoSystem', () => {
    it('returns original prompt when summary is null', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, null)).toBe(prompt)
    })

    it('returns original prompt when summary is empty string', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, '')).toBe(prompt)
    })

    it('returns original prompt when summary is invalid JSON', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, 'not-json')).toBe(prompt)
    })

    it('injects summary text into system prompt', () => {
      const prompt = 'You are a cat named 店长'
      const summary = JSON.stringify({
        text: '用户问了天气和猫粮的问题',
        lastMessageId: 'msg-1',
        tokenCount: 30,
        roundCount: 5,
      })
      const result = injectSummaryIntoSystem(prompt, summary)
      expect(result).toContain('You are a cat named 店长')
      expect(result).toContain('【对话历史摘要】')
      expect(result).toContain('用户问了天气和猫粮的问题')
      expect(result).toContain('请基于以上摘要理解对话上下文')
    })

    it('handles summary JSON without text field', () => {
      const prompt = 'You are a cat'
      const summary = JSON.stringify({ other: 'data' })
      expect(injectSummaryIntoSystem(prompt, summary)).toBe(prompt)
    })
  })

  // ─── resolveHandoffTarget — 服务端路由兜底（方案 A） ──────────
  describe('resolveHandoffTarget — 路由兜底', () => {
    let db: Database.Database

    const insertSession = (
      id: string,
      opts: { handoffFrom?: string; runningSummary?: string | null } = {}
    ) => {
      db.prepare(
        `INSERT INTO sessions (id, title, handoff_from, running_summary)
         VALUES (?, 'test', ?, ?)`
      ).run(id, opts.handoffFrom ?? null, opts.runningSummary ?? null)
    }

    const insertMessage = (id: string, sessionId: string) => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run(id, sessionId)
    }

    beforeEach(() => {
      db = createTestDb()
      setDb(db)
      initRepository(db)
    })

    afterEach(() => {
      resetDb()
    })

    it('无子会话 → null（消息留在原会话）', () => {
      insertSession('p1')
      expect(resolveHandoffTarget('p1')).toBeNull()
    })

    it('只有空壳子会话（0 条消息）→ null（空壳不算交接）', () => {
      insertSession('p2')
      insertSession('c-shell', { handoffFrom: 'p2' })
      expect(resolveHandoffTarget('p2')).toBeNull()
    })

    it('真实子会话 → 返回 { oldSessionId, newSessionId, summary }', () => {
      insertSession('p3')
      insertSession('c-real', {
        handoffFrom: 'p3',
        runningSummary: JSON.stringify({ text: '总结A' }),
      })
      insertMessage('m1', 'c-real')
      expect(resolveHandoffTarget('p3')).toEqual({
        oldSessionId: 'p3',
        newSessionId: 'c-real',
        summary: '总结A',
      })
    })

    it('链式交接（p→c1→c2）→ 追到最新真实子会话 c2', () => {
      insertSession('p4')
      insertSession('c1', { handoffFrom: 'p4', runningSummary: JSON.stringify({ text: '总结1' }) })
      insertMessage('m2', 'c1')
      insertSession('c2', { handoffFrom: 'c1', runningSummary: JSON.stringify({ text: '总结2' }) })
      insertMessage('m3', 'c2')
      expect(resolveHandoffTarget('p4')).toEqual({
        oldSessionId: 'p4',
        newSessionId: 'c2',
        summary: '总结2',
      })
    })

    it('链中夹空壳子会话 → 空壳不算交接，停在上一真实子会话', () => {
      insertSession('p5')
      insertSession('c1', { handoffFrom: 'p5', runningSummary: JSON.stringify({ text: '总结1' }) })
      insertMessage('m4', 'c1')
      insertSession('c-shell', { handoffFrom: 'c1' }) // 0 条消息空壳
      expect(resolveHandoffTarget('p5')).toEqual({
        oldSessionId: 'p5',
        newSessionId: 'c1',
        summary: '总结1',
      })
    })

    it('链深超过上限（6 层）→ null，防无限追链', () => {
      insertSession('p6')
      let prev = 'p6'
      for (let i = 1; i <= 6; i++) {
        const id = `c-chain-${i}`
        insertSession(id, {
          handoffFrom: prev,
          runningSummary: JSON.stringify({ text: `总结${i}` }),
        })
        insertMessage(`m-chain-${i}`, id)
        prev = id
      }
      expect(resolveHandoffTarget('p6')).toBeNull()
    })

    it('running_summary 非法 JSON → summary 为空串，仍返回子会话', () => {
      insertSession('p7')
      insertSession('c7', { handoffFrom: 'p7', runningSummary: 'not-json' })
      insertMessage('m7', 'c7')
      expect(resolveHandoffTarget('p7')).toEqual({
        oldSessionId: 'p7',
        newSessionId: 'c7',
        summary: '',
      })
    })
  })

  // ─── performHandoff — 空壳清理 + 去重守卫（方案 C） ──────────
  describe('performHandoff — 去重守卫修复', () => {
    let db: Database.Database
    // 假 HandoffBus（第 2 刀：performHandoff 从 io 收窄为 bus）
    const mockBus = { emitSessionHandoff: vi.fn(), emitHandoffFailed: vi.fn() } as any

    const insertSession = (
      id: string,
      opts: { handoffFrom?: string; runningSummary?: string | null } = {}
    ) => {
      db.prepare(
        `INSERT INTO sessions (id, title, handoff_from, running_summary)
         VALUES (?, 'test', ?, ?)`
      ).run(id, opts.handoffFrom ?? null, opts.runningSummary ?? null)
    }

    const insertMessage = (id: string, sessionId: string) => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run(id, sessionId)
    }

    beforeEach(() => {
      db = createTestDb()
      setDb(db)
      initRepository(db)
      process.env.SUMMARY_API_KEY = 'test-key'
      process.env.HANDOFF_ENABLED = 'true'
    })

    afterEach(() => {
      resetDb()
      delete process.env.SUMMARY_API_KEY
      vi.clearAllMocks()
    })

    it('AC1: 只有空壳子会话 → 再次交接成功，空壳先删，sessions 只剩 1 个子会话', async () => {
      insertSession('parent-a')
      insertSession('child-shell', { handoffFrom: 'parent-a' }) // 0 条消息空壳

      const result = await performHandoff('parent-a', mockBus)

      expect(result).not.toBeNull()
      expect(result!.oldSessionId).toBe('parent-a')
      // 空壳被删 + 新子会话创建 → 只剩 1 个
      const children = db
        .prepare('SELECT id FROM sessions WHERE handoff_from = ?')
        .all('parent-a') as Array<{ id: string }>
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe(result!.newSessionId)
      // 前端收到切换通知
      expect(mockBus.emitSessionHandoff).toHaveBeenCalledWith({
        oldSessionId: 'parent-a',
        newSessionId: result!.newSessionId,
        summary: '测试总结内容',
      })
    })

    it('AC2: 已有真实子会话（≥1 条消息）→ 去重保护，返回 null，不新建', async () => {
      insertSession('parent-b')
      insertSession('child-real', { handoffFrom: 'parent-b' })
      insertMessage('m-1', 'child-real')

      const result = await performHandoff('parent-b', mockBus)

      expect(result).toBeNull()
      const children = db
        .prepare('SELECT id FROM sessions WHERE handoff_from = ?')
        .all('parent-b') as Array<{ id: string }>
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe('child-real')
      expect(mockBus.emitSessionHandoff).not.toHaveBeenCalled()
    })
  })

  // ─── performHandoff — HANDOFF_FAILED 失败可见化（单A：交接失败必须对前端可见） ──────────
  describe('performHandoff — HANDOFF_FAILED 失败可见化', () => {
    let db: Database.Database
    // 假 HandoffBus（第 2 刀：房间路由归 adapter，此处只断言 payload）
    const handoffFailed = vi.fn()
    const mockBus = { emitSessionHandoff: vi.fn(), emitHandoffFailed: handoffFailed } as any

    const insertSession = (id: string) => {
      db.prepare(
        `INSERT INTO sessions (id, title, handoff_from, running_summary)
         VALUES (?, 'test', NULL, NULL)`
      ).run(id)
    }

    beforeEach(() => {
      db = createTestDb()
      setDb(db)
      initRepository(db)
      process.env.HANDOFF_ENABLED = 'true'
      process.env.SUMMARY_API_KEY = 'test-key'
    })

    afterEach(() => {
      resetDb()
      delete process.env.SUMMARY_API_KEY
      vi.clearAllMocks()
    })

    it('无 API key → emit HANDOFF_FAILED 到会话房间，reason 明示配置缺失，不新建会话', async () => {
      process.env.SUMMARY_API_KEY = ''
      process.env.DS_KEY = ''
      insertSession('parent-nokey')

      const result = await performHandoff('parent-nokey', mockBus)

      expect(result).toBeNull()
      expect(handoffFailed).toHaveBeenCalledWith({
        sessionId: 'parent-nokey',
        reason: expect.stringContaining('API Key'),
      })
      // 失败路径零副作用：不新建子会话
      const children = db
        .prepare('SELECT id FROM sessions WHERE handoff_from = ?')
        .all('parent-nokey') as Array<{ id: string }>
      expect(children).toHaveLength(0)
    })

    it('LLM 失败（chatComplete reject）→ emit HANDOFF_FAILED 携带错误原因', async () => {
      vi.mocked(chatComplete).mockRejectedValueOnce(
        new Error('Chat completion API returned empty response')
      )
      insertSession('parent-llm')

      const result = await performHandoff('parent-llm', mockBus)

      expect(result).toBeNull()
      expect(handoffFailed).toHaveBeenCalledWith({
        sessionId: 'parent-llm',
        reason: 'Chat completion API returned empty response',
      })
      // 成功路径的全局通知不被触发（这是失败路径）
      expect(mockBus.emitSessionHandoff).not.toHaveBeenCalled()
    })
  })
})

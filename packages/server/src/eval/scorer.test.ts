/**
 * scorer.test.ts — G-Eval 评分器单测 + 落库集成（真实 SQLite，只 mock 最外层 LLM）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  parseJudgeOutput,
  weightedScore,
  truncateForJudge,
  collectContextRows,
  buildGEvalPrompt,
  scoreReply,
  CONTEXT_WINDOW,
} from './scorer.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb } from '../db/index.js'
import {
  initRepository,
  messages as messagesRepo,
  evalScores as evalScoresRepo,
} from '../db/repository/index.js'

// 只 mock LLM 边界：registry 的 getAdapterForAgent
vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(),
}))

import { getAdapterForAgent } from '../llm/registry.js'

const DS_AGENT = {
  id: 'agent-1',
  name: '实施猫',
  avatar: '🐱',
  systemPrompt: '',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-flash',
  llmApiKey: 'sk-test',
}

function fakeAdapter(reply: string): any {
  return {
    provider: 'deepseek',
    chatStream: vi.fn(async function* () {
      yield { content: reply, done: false }
      yield { content: '', done: true }
    }),
  }
}

function setupDb(): Database.Database {
  const db = createTestDb()
  setDb(db)
  initRepository(db)
  return db
}

function insertMsg(
  db: Database.Database,
  id: string,
  sessionId: string,
  role: 'user' | 'agent',
  content: string,
  agentId: string | null,
  created: string
): void {
  messagesRepo.insertMessage(id, sessionId, role, content, '[]', agentId, null)
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(created, id)
}

beforeEach(() => {
  process.env.KIMI_API_KEY = ''
  process.env.EVAL_SAMPLE_RATE = '0.02'
})

afterEach(() => {
  resetDb()
  vi.clearAllMocks()
})

describe('parseJudgeOutput', () => {
  it('解析完整 JSON（分布 + 维度 + 推理）', () => {
    const out = parseJudgeOutput(
      '{"reasoning": "ok", "score_distribution": {"1": 0, "2": 0, "3": 0.1, "4": 0.7, "5": 0.2}, "dimensions": {"relevance": 4, "faithfulness": 5, "completeness": 3}}'
    )
    expect(out).not.toBeNull()
    expect(out!.score).toBeCloseTo(4.1, 5) // 0.1*3 + 0.7*4 + 0.2*5
    expect(out!.dimensions).toEqual({ relevance: 4, faithfulness: 5, completeness: 3 })
  })

  it('只有 score 字段时直接用（分布缺失兜底）', () => {
    const out = parseJudgeOutput('{"score": 4, "reasoning": "ok"}')
    expect(out!.score).toBe(4)
  })

  it('正则兜底：裸 "score: 5" 键值', () => {
    const out = parseJudgeOutput('评分: 5\n理由: 很好')
    expect(out!.score).toBe(5)
  })

  it('不可解析返回 null', () => {
    expect(parseJudgeOutput('今天天气不错')).toBeNull()
    expect(parseJudgeOutput('')).toBeNull()
  })

  it('score 越界被 clamp 到 1-5', () => {
    const out = parseJudgeOutput('{"score": 9}')
    expect(out!.score).toBe(5)
    const out2 = parseJudgeOutput('{"score": 0}')
    expect(out2!.score).toBe(1)
  })
})

describe('weightedScore', () => {
  it('概率加权期望分', () => {
    expect(weightedScore({ '1': 0, '2': 0, '3': 1 })).toBe(3)
    expect(weightedScore({ '3': 0.5, '5': 0.5 })).toBe(4)
  })

  it('非法分布（空/和为零/越界）返回 null', () => {
    expect(weightedScore({})).toBeNull()
    expect(weightedScore({ '1': 0, '2': 0 })).toBeNull()
    expect(weightedScore({ '9': 1 })).toBeNull()
  })
})

describe('truncateForJudge', () => {
  it('短文本原样返回', () => {
    expect(truncateForJudge('短', 10)).toBe('短')
  })

  it('超长截断并带标记', () => {
    const long = 'x'.repeat(50)
    const out = truncateForJudge(long, 10)
    expect(out.startsWith('xxxxxxxxxx')).toBe(true)
    expect(out).toContain('[已截断]')
  })
})

describe('collectContextRows', () => {
  it('取被评回复前置最近 CONTEXT_WINDOW 条（时间正序，含被评回复）', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      agent_id: null,
      content: `msg-${i}`,
    })).reverse() // 模拟 getRecentMessages 倒序
    const ctx = collectContextRows(rows, 'm20')
    expect(ctx.length).toBe(CONTEXT_WINDOW)
    expect(ctx[0].content).toBe('msg-11') // 前置最早
    expect(ctx[ctx.length - 1].content).toBe('msg-20') // 被评回复在最后
  })

  it('目标不在窗口内返回空', () => {
    const rows = [{ id: 'a', role: 'user', agent_id: null, content: 'x' }]
    expect(collectContextRows(rows, 'nope')).toEqual([])
  })

  it('消息不足 10 条时返回全部', () => {
    const rows = [
      { id: 'a', role: 'user', agent_id: null, content: 'x' },
      { id: 'b', role: 'user', agent_id: null, content: 'y' },
    ].reverse()
    expect(collectContextRows(rows, 'b').length).toBe(2)
  })
})

describe('buildGEvalPrompt', () => {
  it('包含三件套（任务/上下文/被评回复）与长度偏见条款', () => {
    const prompt = buildGEvalPrompt(
      [{ role: 'user', agent_id: null, content: '用户问题' }],
      '猫的回复',
      '实施猫'
    )
    expect(prompt).toContain('实施猫')
    expect(prompt).toContain('用户问题')
    expect(prompt).toContain('猫的回复')
    expect(prompt).toContain('严禁因回复长度')
    expect(prompt).toContain('相关性')
    expect(prompt).toContain('忠实度')
    expect(prompt).toContain('完整性')
  })
})

describe('scoreReply（真实 SQLite 集成，只 mock LLM 边界）', () => {
  it('正常评分落库：judge_model/sample_reason/dimensions 齐全', async () => {
    const db = setupDb()
    const sessionId = 's-1'
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(sessionId)
    for (let i = 0; i < 15; i++) {
      insertMsg(db, `m${i}`, sessionId, 'user', `问题 ${i}`, null, `2026-08-01 00:0${i}:00`)
    }
    insertMsg(db, 'target', sessionId, 'agent', '这是被评回复', 'agent-1', '2026-08-01 00:16:00')

    vi.mocked(getAdapterForAgent).mockReturnValue(
      fakeAdapter(
        '{"reasoning": "ok", "score_distribution": {"1": 0, "2": 0, "3": 0, "4": 1, "5": 0}, "dimensions": {"relevance": 4, "faithfulness": 5, "completeness": 4}}'
      )
    )

    const out = await scoreReply(DS_AGENT, sessionId, 'target')
    expect(out).not.toBeNull()
    expect(out!.score).toBe(4)

    const row = evalScoresRepo.getScoreByMessageId('target')
    expect(row).toBeDefined()
    expect(row!.score).toBe(4)
    expect(row!.judge_model).toBe('deepseek-v4-flash')
    expect(row!.sample_reason).toBe('random')
    expect(JSON.parse(row!.dimensions!)).toEqual({ relevance: 4, faithfulness: 5, completeness: 4 })
  })

  it('score ≤ 2 落库标注 low_score', async () => {
    const db = setupDb()
    const sessionId = 's-2'
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(sessionId)
    insertMsg(db, 'm1', sessionId, 'user', '问题', null, '2026-08-01 00:01:00')
    insertMsg(db, 'target2', sessionId, 'agent', '差回复', 'agent-1', '2026-08-01 00:02:00')

    vi.mocked(getAdapterForAgent).mockReturnValue(
      fakeAdapter('{"score_distribution": {"1": 1, "2": 0, "3": 0, "4": 0, "5": 0}}')
    )

    await scoreReply(DS_AGENT, sessionId, 'target2')
    const row = evalScoresRepo.getScoreByMessageId('target2')
    expect(row!.score).toBe(1)
    expect(row!.sample_reason).toBe('low_score')
  })

  it('已评分消息跳过（不重复评分，adapter 不重复调用）', async () => {
    const db = setupDb()
    const sessionId = 's-3'
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(sessionId)
    insertMsg(db, 'm1', sessionId, 'user', '问题', null, '2026-08-01 00:01:00')
    insertMsg(db, 'target3', sessionId, 'agent', '回复', 'agent-1', '2026-08-01 00:02:00')

    const adapter = fakeAdapter('{"score": 5}')
    vi.mocked(getAdapterForAgent).mockReturnValue(adapter)

    await scoreReply(DS_AGENT, sessionId, 'target3')
    await scoreReply(DS_AGENT, sessionId, 'target3')
    expect(adapter.chatStream).toHaveBeenCalledTimes(1)
    expect(evalScoresRepo.getRecentScores(10)).toHaveLength(1)
  })

  it('目标消息不存在 → 返回 null 不落库', async () => {
    const db = setupDb()
    const sessionId = 's-4'
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(sessionId)
    insertMsg(db, 'm1', sessionId, 'user', '问题', null, '2026-08-01 00:01:00')

    const adapter = fakeAdapter('{"score": 5}')
    vi.mocked(getAdapterForAgent).mockReturnValue(adapter)

    const out = await scoreReply(DS_AGENT, sessionId, 'ghost')
    expect(out).toBeNull()
    expect(adapter.chatStream).not.toHaveBeenCalled()
  })
})

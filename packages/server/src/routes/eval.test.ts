import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import {
  initRepository,
  agents as agentsRepo,
  sessions as sessionsRepo,
  messages as messagesRepo,
  evalScores as evalScoresRepo,
  userFeedback as userFeedbackRepo,
} from '../db/repository/index.js'
import { evalRoutes } from './eval.js'
import type { FastifyInstance } from 'fastify'

describe('Eval Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    await app.register(evalRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  /** 插一个 agent，返回 id */
  function seedAgent(name: string): string {
    const id = uuid()
    agentsRepo.insertAgent(
      id,
      name,
      '🐱',
      'p',
      'deepseek',
      'deepseek-v4-flash',
      'sk-test',
      null,
      null
    )
    return id
  }

  /** 插一个会话（messages 有 FK 约束，必须先有 session） */
  function seedSession(): string {
    const id = uuid()
    sessionsRepo.insertSession(id, 't', [])
    return id
  }

  /** 插一条 agent 回复消息（评分样本的载体），返回 messageId */
  function seedReply(sessionId: string, agentId: string, content: string): string {
    const id = uuid()
    messagesRepo.insertAgentMessage(id, sessionId, agentId, content, null)
    return id
  }

  /** 插一条评分（默认 low_score；createdAt 可覆盖以错开排序） */
  function seedScore(opts: {
    agentId: string
    sessionId: string
    messageId: string
    score?: number
    sampleReason?: 'random' | 'low_score' | 'user_feedback'
  }): string {
    const id = uuid()
    evalScoresRepo.insertScore({
      id,
      messageId: opts.messageId,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      score: opts.score ?? 1,
      dimensionsJson: null,
      judgeModel: 'test-judge',
      sampleReason: opts.sampleReason ?? 'low_score',
    })
    return id
  }

  /** 裸 SQL 改 created_at（同秒插入下排序/上下文断言需要时间差） */
  function setCreatedAt(table: 'messages' | 'eval_scores', id: string, at: string): void {
    getDb().prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(at, id)
  }

  describe('GET /api/eval/scores', () => {
    it('空库返回空数组', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/eval/scores' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true, scores: [] })
    })

    it('返回评分列表并 join 猫名，倒序', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const m1 = seedReply(sessionId, agentId, 'r1')
      const m2 = seedReply(sessionId, agentId, 'r2')
      const s1 = seedScore({ agentId, sessionId, messageId: m1, score: 3 })
      const s2 = seedScore({ agentId, sessionId, messageId: m2, score: 5 })
      setCreatedAt('eval_scores', s1, '2026-08-01 10:00:00')
      setCreatedAt('eval_scores', s2, '2026-08-01 11:00:00')

      const res = await app.inject({ method: 'GET', url: '/api/eval/scores' })
      expect(res.statusCode).toBe(200)
      const { scores } = JSON.parse(res.body)
      expect(scores).toHaveLength(2)
      expect(scores[0].id).toBe(s2) // 倒序：新评分的在前
      expect(scores[0].agent_name).toBe('店长')
      expect(scores[1].score).toBe(3)
    })

    it('agent_id 过滤只回该猫', async () => {
      const a1 = seedAgent('店长')
      const a2 = seedAgent('吐槽猫')
      const sessionId = seedSession()
      seedScore({ agentId: a1, sessionId, messageId: seedReply(sessionId, a1, 'r1') })
      seedScore({ agentId: a2, sessionId, messageId: seedReply(sessionId, a2, 'r2') })

      const res = await app.inject({ method: 'GET', url: `/api/eval/scores?agent_id=${a2}` })
      const { scores } = JSON.parse(res.body)
      expect(scores).toHaveLength(1)
      expect(scores[0].agent_name).toBe('吐槽猫')
    })

    it('limit 非法 → 400（钉死契约：字符串/超界/小数）', async () => {
      for (const limit of ['abc', '0', '500', '2.5']) {
        const res = await app.inject({ method: 'GET', url: `/api/eval/scores?limit=${limit}` })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).error).toContain('limit')
      }
    })
  })

  describe('GET /api/eval/aggregates', () => {
    it('按猫聚合 count / avg_score / low_score_rate（≤2 占比）', async () => {
      const a1 = seedAgent('店长')
      const a2 = seedAgent('吐槽猫')
      const sessionId = seedSession()
      // 店长 3 条 [1, 2, 5]：avg 2.67，low_rate 2/3
      seedScore({ agentId: a1, sessionId, messageId: seedReply(sessionId, a1, 'r1'), score: 1 })
      seedScore({ agentId: a1, sessionId, messageId: seedReply(sessionId, a1, 'r2'), score: 2 })
      seedScore({ agentId: a1, sessionId, messageId: seedReply(sessionId, a1, 'r3'), score: 5 })
      // 吐槽猫 1 条 [4]：avg 4，low_rate 0
      seedScore({ agentId: a2, sessionId, messageId: seedReply(sessionId, a2, 'r4'), score: 4 })

      const res = await app.inject({ method: 'GET', url: '/api/eval/aggregates' })
      expect(res.statusCode).toBe(200)
      const { aggregates } = JSON.parse(res.body)
      expect(aggregates).toHaveLength(2)
      const store = aggregates.find((x: any) => x.agent_name === '店长')
      expect(store).toMatchObject({ count: 3, avg_score: 2.67, low_score_rate: 0.67 })
      const critic = aggregates.find((x: any) => x.agent_name === '吐槽猫')
      expect(critic).toMatchObject({ count: 1, avg_score: 4, low_score_rate: 0 })
    })
  })

  describe('GET /api/eval/review/pending', () => {
    it('返回 low_score 无回标样本，附回复全文 + 前置上下文 ASC', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      // 3 条前置上下文（早时间）+ 1 条待回标回复（晚时间）
      messagesRepo.insertUserMessage(uuid(), sessionId, 'ctx-1', '[]', null)
      messagesRepo.insertUserMessage(uuid(), sessionId, 'ctx-2', '[]', null)
      const ctx3 = uuid()
      messagesRepo.insertUserMessage(ctx3, sessionId, 'ctx-3', '[]', null)
      const replyId = seedReply(sessionId, agentId, '这是低分回复正文')
      // 错开时间：ctx 在回复之前
      const db = getDb()
      db.prepare(
        `UPDATE messages SET created_at = '2026-08-01 09:00:00' WHERE session_id = ? AND role = 'user'`
      ).run(sessionId)
      db.prepare(`UPDATE messages SET created_at = '2026-08-01 10:00:00' WHERE id = ?`).run(replyId)
      const scoreId = seedScore({ agentId, sessionId, messageId: replyId, score: 1 })

      const res = await app.inject({ method: 'GET', url: '/api/eval/review/pending' })
      expect(res.statusCode).toBe(200)
      const { pending } = JSON.parse(res.body)
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(scoreId)
      expect(pending[0].reply_content).toBe('这是低分回复正文')
      expect(pending[0].agent_name).toBe('店长')
      expect(pending[0].context.map((c: any) => c.content)).toEqual(['ctx-1', 'ctx-2', 'ctx-3'])
    })

    it('random 样本与已回标样本不进待回标', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const randomId = seedScore({
        agentId,
        sessionId,
        messageId: seedReply(sessionId, agentId, 'r-random'),
        score: 4,
        sampleReason: 'random',
      })
      const lowId = seedScore({
        agentId,
        sessionId,
        messageId: seedReply(sessionId, agentId, 'r-low'),
        score: 1,
      })
      userFeedbackRepo.upsertFeedback({
        id: uuid(),
        evalScoreId: lowId,
        messageId: null,
        sessionId: null,
        userScore: 5,
        comment: '已回标',
      })
      void randomId

      const res = await app.inject({ method: 'GET', url: '/api/eval/review/pending' })
      const { pending } = JSON.parse(res.body)
      expect(pending).toHaveLength(0)
    })
  })

  describe('POST /api/eval/review/:evalScoreId', () => {
    it('正常提交：写 user_feedback + sample_reason 翻转为 user_feedback + 移出待回标', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const replyId = seedReply(sessionId, agentId, 'r')
      const scoreId = seedScore({ agentId, sessionId, messageId: replyId, score: 1 })

      const res = await app.inject({
        method: 'POST',
        url: `/api/eval/review/${scoreId}`,
        payload: { score: 5, comment: '其实写得不赖' },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.covered).toBe(false)
      expect(body.feedback.user_score).toBe(5)
      expect(body.feedback.comment).toBe('其实写得不赖')

      const row = evalScoresRepo.getScoreById(scoreId)
      expect(row?.sample_reason).toBe('user_feedback')
      const pendingRes = await app.inject({ method: 'GET', url: '/api/eval/review/pending' })
      expect(JSON.parse(pendingRes.body).pending).toHaveLength(0)
    })

    it('重复提交同一 eval_score_id → 覆盖 + log 留痕（不 409）', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const replyId = seedReply(sessionId, agentId, 'r')
      const scoreId = seedScore({ agentId, sessionId, messageId: replyId, score: 1 })

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        await app.inject({
          method: 'POST',
          url: `/api/eval/review/${scoreId}`,
          payload: { score: 4, comment: '第一版' },
        })
        const res2 = await app.inject({
          method: 'POST',
          url: `/api/eval/review/${scoreId}`,
          payload: { score: 2, comment: '再看一眼，改判' },
        })
        expect(res2.statusCode).toBe(200)
        const body = JSON.parse(res2.body)
        expect(body.covered).toBe(true)
        expect(body.feedback.user_score).toBe(2) // 覆盖生效：以最新为准
        expect(body.feedback.comment).toBe('再看一眼，改判')
        // 只覆盖不新增行：UNIQUE 语义
        expect(userFeedbackRepo.getByEvalScoreId(scoreId)?.user_score).toBe(2)
        // log 留痕：覆盖行为落日志
        const calls = stdoutSpy.mock.calls.map((c) => String(c[0]))
        expect(calls.some((l) => l.includes('user feedback overwrote previous'))).toBe(true)
      } finally {
        stdoutSpy.mockRestore()
      }
    })

    it('score 非法（0/6/字符串/小数）→ 400', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const scoreId = seedScore({
        agentId,
        sessionId,
        messageId: seedReply(sessionId, agentId, 'r'),
      })
      for (const score of [0, 6, '3', 2.5]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/eval/review/${scoreId}`,
          payload: { score },
        })
        expect(res.statusCode).toBe(400)
      }
    })

    it('evalScoreId 不存在 → 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/eval/review/${uuid()}`,
        payload: { score: 3 },
      })
      expect(res.statusCode).toBe(404)
    })

    it('comment 非 string → 400', async () => {
      const agentId = seedAgent('店长')
      const sessionId = seedSession()
      const scoreId = seedScore({
        agentId,
        sessionId,
        messageId: seedReply(sessionId, agentId, 'r'),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/eval/review/${scoreId}`,
        payload: { score: 3, comment: 123 },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('comment')
    })
  })

  describe('GET /api/eval/episode-stats（E4-B 契约缺口裁决补充）', () => {
    it('空库 → 全零统计', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/eval/episode-stats' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.stats).toEqual({ versionStale: 0, uRoot: {}, hRoot: {}, open: 0 })
    })

    it('有数据 → U 根/H 根 outcome 分列计数，open 单列，H 根不计任务结局', async () => {
      const db = getDb()
      // 裸 SQL 种 episodes（episodes 表无 FK 依赖，直接插）
      const seedEpisode = (id: string, triggeredBy: 'U' | 'H', outcome: string | null) => {
        db.prepare(
          `INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, root_message_id,
                                 task_id, chain_task_id, session_id, outcome, episode_state, classification_ver)
           VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, 'classified', 'stale-ver')`
        ).run(id, id, triggeredBy, outcome)
      }
      seedEpisode('e1', 'U', 'success')
      seedEpisode('e2', 'U', 'success')
      seedEpisode('e3', 'U', 'corrected_success')
      seedEpisode('e4', 'U', null) // outcome NULL → 计入 open 不计入 uRoot
      seedEpisode('e5', 'H', 'abandoned')
      seedEpisode('e6', 'H', 'success') // H 根（审查链）不计任务结局，但单独计数（E3 拍板语义）

      const res = await app.inject({ method: 'GET', url: '/api/eval/episode-stats' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.stats.uRoot).toEqual({ success: 2, corrected_success: 1 })
      expect(body.stats.hRoot).toEqual({ abandoned: 1, success: 1 })
      expect(body.stats.open).toBe(1)
      expect(body.stats.versionStale).toBe(6) // 6 行全部 stale 版本
    })
  })
})

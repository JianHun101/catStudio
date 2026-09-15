import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import {
  initRepository,
  agents as agentsRepo,
  sessions as sessionsRepo,
  messages as messagesRepo,
  evalScores as evalScoresRepo,
  userFeedback as userFeedbackRepo,
  spans as spansRepo,
} from '../db/repository/index.js'
import type { SpanInput } from '../db/repository/index.js'
import { evalRoutes } from './eval.js'
import { getLogLevel, setLogLevel } from '../logger.js'
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
      // 本用例断言的留痕是 `log.warn`（routes/eval.ts「user feedback overwrote previous」）
      // ⇒ 必须**自己把级别放到 warn**：票 F1-c c2 起测试进程真的吃 `LOG_LEVEL=error` 了
      // （改前该配置是死的、minLevel 恒为 debug），不声明前置条件这条 warn 会被静默掉。
      const prevLevel = getLogLevel()
      setLogLevel('warn')
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
        setLogLevel(prevLevel)
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

  describe('P1-A 链路查询与 L1 口径端点', () => {
    // 注意：**不能在 describe body 里 `const db = getDb()`**——describe 回调在收集期跑，
    // 早于 beforeEach 的 setDb，会捕到上一个用例的句柄。每处用时现取。
    const q = () => getDb()

    /** 响应体最小形状——只声明断言用到的字段（免 `any`） */
    interface ChainHopBody {
      executionLogId: string
      status: string
    }
    interface ChainBody {
      chainId: string
      hopCount: number
      hops: ChainHopBody[]
    }

    /** 插一条消息（task_id = 链锚，null 即孤儿），返回 id */
    function seedMsg(sessionId: string, id: string, taskId: string | null): string {
      q()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
           VALUES (?, ?, 'agent', 'x', '[]', ?)`
        )
        .run(id, sessionId, taskId)
      return id
    }

    /** 插一条执行行。`startedOffsetSec`/`endedOffsetSec` 相对 now 的秒偏移（便于造跨度与超窗行）；
     *  `endedOffsetSec: null` ⇒ ended_at 为 NULL（在飞跳）。 */
    function seedExec(spec: {
      id: string
      agentId: string
      triggerMsgId: string
      status: string
      latencyMs?: number | null
      replyChars?: number | null
      messageId?: string | null
      startedOffsetSec?: number
      endedOffsetSec?: number | null
    }): void {
      const start = spec.startedOffsetSec ?? 0
      const end = spec.endedOffsetSec === undefined ? start + 1 : spec.endedOffsetSec
      q()
        .prepare(
          `INSERT INTO execution_logs
             (id, session_id, agent_id, triggered_by_message_id, status, trace_id,
              started_at, ended_at, latency_ms, reply_chars, message_id)
           VALUES (?, 's1', ?, ?, ?, 'tr', datetime('now', ?), datetime('now', ?), ?, ?, ?)`
        )
        .run(
          spec.id,
          spec.agentId,
          spec.triggerMsgId,
          spec.status,
          `${start} seconds`,
          // SQLite 日期函数遇 NULL 参数返回 NULL —— 恰好就是「在飞跳」要的语义
          end === null ? null : `${end} seconds`,
          spec.latencyMs ?? null,
          spec.replyChars ?? null,
          spec.messageId ?? null
        )
    }

    beforeEach(() => {
      q().prepare("INSERT OR IGNORE INTO sessions (id, title) VALUES ('s1', 't')").run()
    })

    it('GET /api/eval/l1-metrics：200 且 avgLatencyMs 非 null（有 completed 样本时）', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const trig = seedMsg(sid, 'trig-1', 'anchor-1')
      seedExec({ id: 'x1', agentId: a, triggerMsgId: trig, status: 'completed', latencyMs: 1200 })

      const res = await app.inject({ method: 'GET', url: '/api/eval/l1-metrics' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.windowDays).toBe(30)
      expect(body.avgLatencyMs).toBe(1200)
      expect(body.sampleTotal).toBe(1)
    })

    it('GET /api/eval/l1-metrics 是纯读：不落任何告警消息', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const trig = seedMsg(sid, 'trig-1', 'anchor-1')
      seedExec({ id: 'x1', agentId: a, triggerMsgId: trig, status: 'failed', latencyMs: null })
      const before = (q().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c

      await app.inject({ method: 'GET', url: '/api/eval/l1-metrics' })
      // 一次 GET 顺带触发滞回状态机 = 假告警——本端点不得走 runL1Aggregation
      const after = (q().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c
      expect(after).toBe(before)
    })

    it('GET /api/eval/chains：totals 与手工 SQL 一致，孤儿只落 orphanChain', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const t1 = seedMsg(sid, 'trig-1', 'anchor-1')
      const t2 = seedMsg(sid, 'trig-2', 'anchor-2')
      const t3 = seedMsg(sid, 'trig-3', null) // 无链锚 → 孤儿
      seedExec({ id: 'x1', agentId: a, triggerMsgId: t1, status: 'completed', latencyMs: 1000 })
      seedExec({ id: 'x2', agentId: a, triggerMsgId: t1, status: 'completed', latencyMs: 2000 })
      seedExec({ id: 'x3', agentId: a, triggerMsgId: t2, status: 'completed', latencyMs: 3000 })
      seedExec({ id: 'x4', agentId: a, triggerMsgId: t3, status: 'failed', latencyMs: null })

      const res = await app.inject({ method: 'GET', url: '/api/eval/chains' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.windowDays).toBe(30)
      expect(body.anchor).toBe('coalesce(reply.task_id, trigger.task_id)')
      expect(body.slowMs).toBe(300000)

      // 手工 SQL 对照（验证面与被判面同面）
      const expected = q()
        .prepare(
          `SELECT COUNT(*) AS hops,
                  COUNT(DISTINCT COALESCE(rm.task_id, tm.task_id)) AS chains,
                  SUM(CASE WHEN COALESCE(rm.task_id, tm.task_id) IS NULL THEN 1 ELSE 0 END) AS orphans
           FROM execution_logs el
           LEFT JOIN messages rm ON rm.id = el.message_id
           LEFT JOIN messages tm ON tm.id = el.triggered_by_message_id
           WHERE el.started_at >= datetime('now', '-30 days')`
        )
        .get() as { hops: number; chains: number; orphans: number }

      expect(body.totals.chains).toBe(expected.chains)
      expect(body.totals.hops).toBe(expected.hops)
      expect(body.totals.orphanHops).toBe(expected.orphans)
      expect(body.totals.orphanHops).toBe(1)
      expect(body.totals.maxHops).toBe(2) // 真链最大 2 跳；孤儿桶不计入

      // chains[] 里的链不含孤儿跳
      const ids = (body.chains as ChainBody[]).flatMap((c) => c.hops.map((h) => h.executionLogId))
      expect(ids).not.toContain('x4')
      expect(body.orphanChain.chainId).toBeNull()
      expect(body.orphanChain.hopCount).toBe(1)
      expect((body.orphanChain.hops as ChainHopBody[]).map((h) => h.executionLogId)).toEqual(['x4'])
    })

    it('orphanChain 恒在：无孤儿时 hopCount 0 / hops []（字段不省略）', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const t1 = seedMsg(sid, 'trig-1', 'anchor-1')
      seedExec({ id: 'x1', agentId: a, triggerMsgId: t1, status: 'completed', latencyMs: 1000 })

      const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/eval/chains' })).body)
      expect(body.orphanChain).toEqual({ chainId: null, hopCount: 0, hops: [] })
    })

    it('limit 只截链不截跳：每条返回链 hops.length === hopCount', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const t1 = seedMsg(sid, 'trig-1', 'anchor-1')
      const t2 = seedMsg(sid, 'trig-2', 'anchor-2')
      seedExec({
        id: 'x1',
        agentId: a,
        triggerMsgId: t1,
        status: 'completed',
        latencyMs: 1000,
        startedOffsetSec: -9000,
        endedOffsetSec: -8000,
      })
      seedExec({
        id: 'x2',
        agentId: a,
        triggerMsgId: t1,
        status: 'completed',
        latencyMs: 1000,
        startedOffsetSec: -7000,
        endedOffsetSec: -6000,
      })
      seedExec({ id: 'x3', agentId: a, triggerMsgId: t2, status: 'completed', latencyMs: 1000 })

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?limit=1' })).body
      )
      expect(body.chains).toHaveLength(1)
      expect(body.chains[0].hopCount).toBe(2) // 整链回来，不是半条
      expect(body.chains[0].hops).toHaveLength(2)
      // totals 仍是全窗口，不受 limit 影响
      expect(body.totals.chains).toBe(2)
      expect(body.totals.hops).toBe(3)
    })

    it('limit 越界钳位不报错（999 → 100、abc → 默认 20）', async () => {
      expect(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?limit=999' })).statusCode
      ).toBe(200)
      expect(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?limit=abc' })).statusCode
      ).toBe(200)
      expect(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?limit=-5' })).statusCode
      ).toBe(200)
    })

    it('windowDays 生效：窗口收紧后 totals 变小且原样回报', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const t1 = seedMsg(sid, 'trig-1', 'anchor-1')
      seedExec({ id: 'recent', agentId: a, triggerMsgId: t1, status: 'completed', latencyMs: 1000 })
      q()
        .prepare(
          `INSERT INTO execution_logs
             (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
           VALUES ('old', 's1', ?, ?, 'completed', 'tr', datetime('now', '-90 days'))`
        )
        .run(a, t1)

      const wide = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?windowDays=365' })).body
      )
      const narrow = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/eval/chains?windowDays=30' })).body
      )
      expect(narrow.windowDays).toBe(30)
      expect(wide.totals.hops).toBe(2)
      expect(narrow.totals.hops).toBe(1)
    })

    it('链级字段：startedAt/endedAt 是 UTC 字符串原样透传，spanMs 为毫秒差', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      const t1 = seedMsg(sid, 'trig-1', 'anchor-1')
      seedExec({
        id: 'x1',
        agentId: a,
        triggerMsgId: t1,
        status: 'completed',
        latencyMs: 1000,
        startedOffsetSec: -120,
        endedOffsetSec: -60,
      })

      const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/eval/chains' })).body)
      const chain = body.chains[0]
      expect(chain.chainId).toBe('anchor-1')
      expect(chain.spanMs).toBe(60000)
      expect(chain.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) // 无时区后缀 = 未经转换
      expect(chain.hopCount).toBe(1)
    })
  })

  describe('GET /api/eval/spans（R3 段分解时间轴）', () => {
    // `test-helpers.ts` 的 SCHEMA_SQL 不含 spans / span_llm 两表（R2 的测试自建）。
    // 走**真实 additive 迁移**建表，而不是手搓 DDL——手搓等于把「被判面」抄一遍，
    // 迁移改了这里不同步也照样绿（同 chunks.test.ts 结论）。
    beforeEach(() => {
      initDb()
    })

    const T0 = Date.parse('2026-09-15T10:00:00.000Z')
    /** 相对 T0 的毫秒偏移 → ISO 毫秒 UTC（与 R2 `start_at` 列同形） */
    const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

    function span(over: Partial<SpanInput> & { spanId: string; name: string }): SpanInput {
      return {
        parentSpanId: null,
        chainId: 'chain-1',
        executionId: 'exec-1',
        sessionId: null,
        agentId: null,
        operationName: null,
        startAt: iso(0),
        durationMs: 0,
        status: 'ok',
        errorType: null,
        errorMessage: null,
        itemCount: null,
        llm: null,
        ...over,
      }
    }

    /** 落一次执行的段——走**真实写口** `insertExecTrace`（拓扑序 / 事务 / FK 都用真的） */
    function seedTrace(rows: SpanInput[]): void {
      expect(spansRepo.insertExecTrace(rows)).toBe(true)
    }

    /** 真实库里一次执行的几何（实测自 `cat-study-dev.db`：排队段起点为负偏移） */
    function seedRealisticTrace(): void {
      seedTrace([
        span({
          spanId: 'sp-qw',
          name: 'dispatch.queue_wait',
          startAt: iso(-109330),
          durationMs: 109330,
        }),
        span({ spanId: 'sp-root', name: 'invoke_agent', startAt: iso(0), durationMs: 60810 }),
        span({
          spanId: 'sp-cta',
          parentSpanId: 'sp-root',
          name: 'context.assemble',
          startAt: iso(1),
          durationMs: 15,
          itemCount: 5,
        }),
        span({
          spanId: 'sp-llm',
          parentSpanId: 'sp-root',
          name: 'llm.chat',
          operationName: 'chat',
          startAt: iso(3005),
          durationMs: 57752,
          llm: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            inputTokens: 1234,
            outputTokens: 567,
            ttftMs: 2980,
            stream: true,
            maxTokens: 2048,
          },
        }),
        span({
          spanId: 'sp-rp',
          parentSpanId: 'sp-root',
          name: 'reply.persist',
          startAt: iso(60757),
          durationMs: 0,
        }),
      ])
    }

    /** B1：N 段原样返回 + 升序 + `llm.chat` 带详情 + 非 LLM 段恒 null */
    it('B1：一次执行的 N 段命中 N 条、按 start_at 升序、llm 内联且非 llm.chat 恒 null', async () => {
      seedRealisticTrace()

      const res = await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=exec-1' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)

      expect(body.ok).toBe(true)
      expect(body.spans).toHaveLength(5)
      // 升序 = 时间序（`ORDER BY start_at, id` 归 repo，路由不得重排）
      expect(body.spans.map((s: any) => s.name)).toEqual([
        'dispatch.queue_wait',
        'invoke_agent',
        'context.assemble',
        'llm.chat',
        'reply.persist',
      ])

      // snake_case 原样出（前端直接消费 DB 行，随 eval 面既有惯例）
      const root = body.spans.find((s: any) => s.name === 'invoke_agent')
      expect(root).toHaveProperty('span_id', 'sp-root')
      expect(root).toHaveProperty('duration_ms', 60810)
      expect(root.parent_span_id).toBeNull()

      // llm 内联：只有 llm.chat 有；形状按 LlmSpanDetail（camelCase），不是 DB 列名
      const llm = body.spans.find((s: any) => s.name === 'llm.chat')
      expect(llm.llm).toEqual({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 1234,
        outputTokens: 567,
        ttftMs: 2980,
        stream: true,
        maxTokens: 2048,
      })
      for (const s of body.spans) {
        if (s.name !== 'llm.chat') expect(s.llm).toBeNull()
      }

      // null ≠ 0：产不出「条数」的段是 null，不是 0
      expect(root.item_count).toBeNull()
      expect(body.spans.find((s: any) => s.name === 'context.assemble').item_count).toBe(5)
    })

    it('B1 续：同 start_at 的段按 id 升序（排序稳定，不随查询计划抖）', async () => {
      seedTrace([
        span({ spanId: 'sp-a', name: 'invoke_agent', startAt: iso(0), durationMs: 100 }),
        span({ spanId: 'sp-b', parentSpanId: 'sp-a', name: 'context.assemble', startAt: iso(10) }),
        span({ spanId: 'sp-c', parentSpanId: 'sp-a', name: 'context.compress', startAt: iso(10) }),
      ])

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=exec-1' })).body
      )
      expect(body.spans.map((s: any) => s.name)).toEqual([
        'invoke_agent',
        'context.assemble',
        'context.compress',
      ])
    })

    /** B2：空数组是合法响应（不是 404）；缺参才是 400 */
    it('B2：execution_id 不存在 → 200 + spans: []（不是 404）；缺参 / 空参 → 400', async () => {
      const unknown = await app.inject({
        method: 'GET',
        url: '/api/eval/spans?execution_id=no-such-exec',
      })
      expect(unknown.statusCode).toBe(200)
      expect(JSON.parse(unknown.body)).toEqual({ ok: true, spans: [] })

      const missing = await app.inject({ method: 'GET', url: '/api/eval/spans' })
      expect(missing.statusCode).toBe(400)
      expect(JSON.parse(missing.body).error).toBe('execution_id is required')

      const empty = await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=' })
      expect(empty.statusCode).toBe(400)
    })

    it('B2 续：「执行存在但未落段」（running / 存量行）同样是 200 + []，与「id 不存在」不可区分', async () => {
      const a = seedAgent('店长')
      const sid = seedSession()
      getDb()
        .prepare(
          `INSERT INTO execution_logs
             (id, session_id, agent_id, triggered_by_message_id, status, trace_id,
              started_at, ended_at, latency_ms)
           VALUES ('exec-no-spans', ?, ?, 'trig-x', 'completed', 'tr',
                   datetime('now'), datetime('now'), 1000)`
        )
        .run(sid, a)

      const res = await app.inject({
        method: 'GET',
        url: '/api/eval/spans?execution_id=exec-no-spans',
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).spans).toEqual([])
    })

    it('只读：连查两次结果一致，且不写任何表', async () => {
      seedRealisticTrace()
      const before = getDb().prepare('SELECT COUNT(*) c FROM spans').get() as { c: number }

      const first = await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=exec-1' })
      const second = await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=exec-1' })

      expect(second.body).toBe(first.body)
      const after = getDb().prepare('SELECT COUNT(*) c FROM spans').get() as { c: number }
      expect(after.c).toBe(before.c)
    })

    it('另一执行的段不会串进来（按 execution_id 分组，不是全表）', async () => {
      seedRealisticTrace()
      seedTrace([
        span({ spanId: 'sp-x-root', name: 'invoke_agent', executionId: 'exec-2', durationMs: 1 }),
      ])

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/eval/spans?execution_id=exec-2' })).body
      )
      expect(body.spans).toHaveLength(1)
      expect(body.spans[0].span_id).toBe('sp-x-root')
    })
  })
})

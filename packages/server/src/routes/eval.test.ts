import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { evalRoutes, __test_setRetrievalReportsDir, RETRIEVAL_REPO_MARKER } from './eval.js'
import { findRepoRootFrom } from '../repo-root.js'
import { agreementRate, spearman } from '../eval/phase0.js'
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
    // env 派生断言用 `vi.stubEnv` 钉本用例的 env ⇒ 逐用例复位，防泄漏到同块其他用例
    vi.unstubAllEnvs()
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
      const ctx1 = uuid()
      const ctx2 = uuid()
      const ctx3 = uuid()
      messagesRepo.insertUserMessage(ctx1, sessionId, 'ctx-1', '[]', null)
      messagesRepo.insertUserMessage(ctx2, sessionId, 'ctx-2', '[]', null)
      messagesRepo.insertUserMessage(ctx3, sessionId, 'ctx-3', '[]', null)
      const replyId = seedReply(sessionId, agentId, '这是低分回复正文')
      // 错开时间：ctx 在回复之前。**三条 ctx 必须彼此不同秒**——本用例判的是
      // 「前置上下文按时间 ASC 返回」，而同秒平局下的次序不属于契约（`messages` 是秒级
      // `datetime('now')`，平局的隐含判据随索引形状变：三列索引上线后由 rowid 变 id，
      // 判据记录见 `db/migrations.test.ts`）。让它们同秒 = 把时序断言押在实现细节上。
      const db = getDb()
      const stamp = (id: string, at: string): void => {
        db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(at, id)
      }
      stamp(ctx1, '2026-08-01 09:00:00')
      stamp(ctx2, '2026-08-01 09:00:01')
      stamp(ctx3, '2026-08-01 09:00:02')
      stamp(replyId, '2026-08-01 10:00:00')
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

      // `slowMs` 现读 env（`eval.ts:272` `envNumber('EVAL_CHAIN_SLOW_MS', 300000)`）⇒ 断言
      // 钉**本用例自己设的**非默认值：钉回 300000 是假绿门——「读 env」与「写死默认值」
      // 两种实现都能过；钉 600000 才证「返回的是**当时生效**的阈值」。同理不可依赖外部
      // env 恰好等于默认值：跑批进程继承 server 加载的 .env。
      vi.stubEnv('EVAL_CHAIN_SLOW_MS', '600000')
      const res = await app.inject({ method: 'GET', url: '/api/eval/chains' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.windowDays).toBe(30)
      expect(body.anchor).toBe('coalesce(reply.task_id, trigger.task_id)')
      expect(body.slowMs).toBe(600000)

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

    // ─── env 坏值回归（票 env-number-guards · 组件 B）───────────────
    // 上面那条钉的是**合法值**（'600000'）——它证「读 env」，证不了「坏值不静默穿透」。
    // 本条补的是后者：改前表达式 `parseFloat(process.env.X || '300000')` 对 'abc' 得 NaN，
    // 序列化成 JSON 就是 `"slowMs":null`（OQ-6 实测读数），前端读不出「配置写错了」。
    it('env 坏值回归：EVAL_CHAIN_SLOW_MS 坏值/空串 ⇒ slowMs 回退 300000（不是 null/NaN）', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      // 本用例断言的 warn 走**真 logger** ⇒ 必须自己把级别放到 warn：测试进程真吃
      // `LOG_LEVEL=error`（packages/server/vitest.config.ts 的 test.env），不声明这个前置
      // 条件的话 warn 被级别静默掉，「坏值出声」会退化成恒真的假绿门。
      const prevLevel = getLogLevel()
      setLogLevel('warn')
      try {
        // stdout 行形如 `WARN <ts> env-number <msg> <meta>`——按模块名 + 变量名双筛
        const warns = (): string[] =>
          stdoutSpy.mock.calls
            .map((c) => String(c[0]))
            .filter((l) => l.includes('env-number') && l.includes('EVAL_CHAIN_SLOW_MS'))

        vi.stubEnv('EVAL_CHAIN_SLOW_MS', 'abc')
        const bad = JSON.parse((await app.inject({ method: 'GET', url: '/api/eval/chains' })).body)
        expect(bad.slowMs).toBe(300000) // 读到 fallback：不是 NaN、不是 0、不是 null
        // 正对照：坏值必须**出声**（否则下面的「不新增」是恒真的假绿门）。只断「至少一条」
        // ——确切条数 = 该键在一次请求里被读几次（实现细节），钉死它会在无关重构时假红。
        expect(warns().length).toBeGreaterThan(0)
        const afterBad = warns().length

        vi.stubEnv('EVAL_CHAIN_SLOW_MS', '')
        const empty = JSON.parse(
          (await app.inject({ method: 'GET', url: '/api/eval/chains' })).body
        )
        expect(empty.slowMs).toBe(300000)
        expect(warns().length).toBe(afterBad) // 空串：调用次数可变，warn 一条都不许新增
      } finally {
        stdoutSpy.mockRestore()
        setLogLevel(prevLevel)
      }
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
      // FK 补链后（票 6 批一）：triggered_by_message_id → messages.id ⇒ 触发消息先落库
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES ('trig-x', ?, 'user', 'x', '[]')`
        )
        .run(sid)
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

  describe('GET /api/eval/session-traces（R4 §A 面板取数口）', () => {
    // 同 P1-A 段的告诫：**不能在 describe body 里 `const db = getDb()`**——describe
    // 回调在收集期跑，早于 beforeEach 的 setDb，会捕到上一个用例的句柄。用时现取。
    const q = () => getDb()

    /** 落一条执行行。`endedAt` 省略 ⇒ 与 `startedAt` 同值（已完成）；
     *  显式传 `null` ⇒ 在飞（`ended_at IS NULL` 正是在飞判据）。
     *  `latencyMs` 缺省 null —— 与真实一致：诊断数据在收口漏斗里才写。 */
    function seedExec(spec: {
      id: string
      sessionId: string
      agentId: string
      status: 'running' | 'completed' | 'failed'
      startedAt: string
      endedAt?: string | null
      latencyMs?: number | null
    }): void {
      // FK 补链后（票 6 批一）：triggered_by_message_id → messages.id ⇒ 触发消息先落库
      // （`INSERT OR IGNORE`：本段多个用例复用同一字面量 id，PK 全局唯一即可满足 FK）
      q()
        .prepare(
          `INSERT OR IGNORE INTO messages (id, session_id, role, content, mentions)
           VALUES ('trig-1', ?, 'user', 'x', '[]')`
        )
        .run(spec.sessionId)
      q()
        .prepare(
          `INSERT INTO execution_logs
             (id, session_id, agent_id, triggered_by_message_id, status, trace_id,
              started_at, ended_at, latency_ms)
           VALUES (?, ?, ?, 'trig-1', ?, 'tr', ?, ?, ?)`
        )
        .run(
          spec.id,
          spec.sessionId,
          spec.agentId,
          spec.status,
          spec.startedAt,
          spec.endedAt === undefined ? spec.startedAt : spec.endedAt,
          spec.latencyMs ?? null
        )
    }

    /** A1-① 每猫取最新——且判据是「最晚**开始**」而非「最晚结束」：
     *  `a-late-end` 结束最晚（15:00），`a-late-start` 开始最晚（12:00）⇒ 必须给后者。
     *  两条判据在这份数据上给出**不同**答案，故此用例对「按 started_at 还是按 ended_at」
     *  有判别力，不是怎么实现都绿。 */
    it('A1-①：每猫一条、取 started_at 最大者（不是最晚结束、不是最早）', async () => {
      const a = seedAgent('ds猫')
      const b = seedAgent('flash猫')
      const sid = seedSession()
      seedExec({
        id: 'a-late-end',
        sessionId: sid,
        agentId: a,
        status: 'completed',
        startedAt: '2026-09-15T10:00:00.000Z',
        endedAt: '2026-09-15T15:00:00.000Z',
        latencyMs: 1000,
      })
      seedExec({
        id: 'a-late-start',
        sessionId: sid,
        agentId: a,
        status: 'failed',
        startedAt: '2026-09-15T12:00:00.000Z',
        endedAt: '2026-09-15T12:00:05.000Z',
        latencyMs: 2000,
      })
      seedExec({
        id: 'b-1',
        sessionId: sid,
        agentId: b,
        status: 'completed',
        startedAt: '2026-09-15T09:00:00.000Z',
        endedAt: '2026-09-15T09:00:01.000Z',
        latencyMs: 4000,
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/eval/session-traces?session_id=${sid}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      // 每**猫**一条，不是每执行一条
      expect(body.traces).toHaveLength(2)
      expect(body.traces.find((t: any) => t.agentId === a).executionId).toBe('a-late-start')
      expect(body.traces.find((t: any) => t.agentId === b).executionId).toBe('b-1')
    })

    /** A1-② 在飞照样返回，且**不得回退**到更早那次——回退等于拿旧执行冒充当前状态。 */
    it('A1-②：在飞（endedAt null）照样返回，不回退到更早的已完成执行', async () => {
      const a = seedAgent('ds猫')
      const sid = seedSession()
      seedExec({
        id: 'done',
        sessionId: sid,
        agentId: a,
        status: 'completed',
        startedAt: '2026-09-15T10:00:00.000Z',
        endedAt: '2026-09-15T10:01:00.000Z',
        latencyMs: 60000,
      })
      seedExec({
        id: 'inflight',
        sessionId: sid,
        agentId: a,
        status: 'running',
        startedAt: '2026-09-15T11:00:00.000Z',
        endedAt: null,
      })

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/eval/session-traces?session_id=${sid}` }))
          .body
      )
      expect(body.traces).toHaveLength(1)
      expect(body.traces[0].executionId).toBe('inflight') // 不是 'done'
      expect(body.traces[0].status).toBe('running')
      expect(body.traces[0].endedAt).toBeNull()
      // null ≠ 0：采集中拿不到总时长就如实 null，不回落成「瞬间完成」
      expect(body.traces[0].totalMs).toBeNull()
    })

    /** A1-③ 零执行的猫**不出现**（不是补一条 0 / 空对象）。
     *  含跨会话面：在**别的会话**执行过的猫，在本会话同样是「无执行」。 */
    it('A1-③：本会话零执行的猫不出现（含「只在别的会话执行过」）', async () => {
      const a = seedAgent('ds猫')
      const idle = seedAgent('闲置猫')
      const elsewhere = seedAgent('别的会话猫')
      const sid = seedSession()
      const sid2 = seedSession()
      seedExec({
        id: 'a-1',
        sessionId: sid,
        agentId: a,
        status: 'completed',
        startedAt: '2026-09-15T10:00:00.000Z',
        latencyMs: 1000,
      })
      seedExec({
        id: 'o-1',
        sessionId: sid2,
        agentId: elsewhere,
        status: 'completed',
        startedAt: '2026-09-15T10:00:00.000Z',
        latencyMs: 1000,
      })

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/eval/session-traces?session_id=${sid}` }))
          .body
      )
      const ids = body.traces.map((t: any) => t.agentId)
      expect(ids).toEqual([a])
      expect(ids).not.toContain(idle)
      expect(ids).not.toContain(elsewhere)
    })

    /** A1-④ 缺参 / 空参 → 400；无匹配 → 200 + `[]`（口径与 `/spans` 逐字一致）。 */
    it('A1-④：缺参 / 空参 → 400；无匹配会话 → 200 + traces: []（不是 404）', async () => {
      const missing = await app.inject({ method: 'GET', url: '/api/eval/session-traces' })
      expect(missing.statusCode).toBe(400)
      expect(JSON.parse(missing.body).error).toBe('session_id is required')

      const empty = await app.inject({ method: 'GET', url: '/api/eval/session-traces?session_id=' })
      expect(empty.statusCode).toBe(400)

      const unknown = await app.inject({
        method: 'GET',
        url: `/api/eval/session-traces?session_id=${uuid()}`,
      })
      expect(unknown.statusCode).toBe(200)
      expect(JSON.parse(unknown.body)).toEqual({ ok: true, traces: [] })
    })

    it('A1-⑤ 只读：连查两次结果逐字节一致，且执行行不被改写', async () => {
      const a = seedAgent('ds猫')
      const sid = seedSession()
      seedExec({
        id: 'a-1',
        sessionId: sid,
        agentId: a,
        status: 'completed',
        startedAt: '2026-09-15T10:00:00.000Z',
        latencyMs: 1000,
      })
      const before = q().prepare('SELECT * FROM execution_logs').all()

      const first = await app.inject({
        method: 'GET',
        url: `/api/eval/session-traces?session_id=${sid}`,
      })
      const second = await app.inject({
        method: 'GET',
        url: `/api/eval/session-traces?session_id=${sid}`,
      })
      expect(second.body).toBe(first.body)
      expect(q().prepare('SELECT * FROM execution_logs').all()).toEqual(before)
    })

    /** A2 段数据**不内联**（契约第 7 条）。
     *
     *  这条不能只断「响应里有哪几个键」——那在我全程没 SELECT spans 的前提下是恒真的。
     *  真正的判别力来自**先让该执行真的落上段**：段表里躺着数据而响应体里一个字都没有，
     *  才证明「不内联」是行为而非巧合。故本段走真实 additive 迁移建 spans 表
     *  （同上方 R3 段：`test-helpers.ts` 的 SCHEMA_SQL 不含这两张表）。 */
    describe('A2：段数据不内联', () => {
      beforeEach(() => {
        initDb()
      })

      it('执行已落段时，响应体仍只有六个契约键、零段数据', async () => {
        const a = seedAgent('ds猫')
        const sid = seedSession()
        seedExec({
          id: 'exec-with-spans',
          sessionId: sid,
          agentId: a,
          status: 'completed',
          startedAt: '2026-09-15T10:00:00.000Z',
          latencyMs: 1000,
        })
        // 前置断言：段**真的**落进去了——否则下面的「零段」是真空通过
        // （`insertExecTrace` 吞异常只回 false，故这里必须断 true，不能只 `await` 过去）
        expect(
          spansRepo.insertExecTrace([
            {
              spanId: 'sp-root',
              parentSpanId: null,
              chainId: 'chain-1',
              executionId: 'exec-with-spans',
              sessionId: sid,
              agentId: a,
              name: 'invoke_agent',
              operationName: null,
              startAt: '2026-09-15T10:00:00.000Z',
              durationMs: 60810,
              status: 'ok',
              errorType: null,
              errorMessage: null,
              itemCount: null,
              llm: null,
            },
          ])
        ).toBe(true)
        expect(q().prepare('SELECT COUNT(*) c FROM spans').get()).toEqual({ c: 1 })

        const body = JSON.parse(
          (await app.inject({ method: 'GET', url: `/api/eval/session-traces?session_id=${sid}` }))
            .body
        )
        expect(body.traces).toHaveLength(1)
        // 两条断言管的是**不同的**泄漏面，都要留（各自做过反对照，非装饰）：
        //  1) 段内容混进了既有字段里（例如有人把段名拼进 status）——键集查不出来
        expect(JSON.stringify(body)).not.toContain('sp-root')
        //  2) 多挂了一个键（如 `spans: [...]`）——内容断言在上一条就拦住了，键集是兜底
        expect(Object.keys(body.traces[0]).sort()).toEqual([
          'agentId',
          'endedAt',
          'executionId',
          'startedAt',
          'status',
          'totalMs',
        ])
      })
    })
  })

  // ─── J1 · 人工标注（盲标池 / 提交 / 一致性读数）──────────────────────────
  describe('J1 人工标注', () => {
    /** 盲标池 / 标注提交 / 一致性读数共用的造数：n 条猫回复 */
    function seedReplies(sessionId: string, agentId: string, n: number, prefix: string): string[] {
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        const id = `${prefix}-${i}`
        messagesRepo.insertAgentMessage(id, sessionId, agentId, `${prefix} 的回复 ${i}`, null)
        // 错开时间，让「每会话取最新 perSession 条」可判
        setCreatedAt('messages', id, `2026-09-0${i + 1}T10:00:00.000Z`)
        ids.push(id)
      }
      return ids
    }

    /** 人工标注（绕过路由直接写库——用于「已标注不入池」这类取数断言） */
    function seedHumanLabel(
      messageId: string,
      sessionId: string,
      agentId: string,
      score: number
    ): void {
      const id = uuid()
      getDb()
        .prepare(
          `INSERT INTO human_labels (id, message_id, session_id, agent_id, labeler, score, created_at)
           VALUES (?, ?, ?, ?, 'user', ?, '2026-09-10T00:00:00.000Z')`
        )
        .run(id, messageId, sessionId, agentId, score)
    }

    describe('GET /api/eval/label/pool', () => {
      it('**盲标可机验**：池响应里没有判官分（全文 + 键集两道）；反对照——回标端点响应里有', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')
        // 这条回复**带判官分**：池子若顺手 JOIN 了 eval_scores，下面两道断言会当场炸
        const scoreId = seedScore({ agentId, sessionId, messageId: m0, score: 1 })

        const poolRes = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        expect(poolRes.statusCode).toBe(200)
        // 第 1 道：全文（店长派活单写的就是这条）——fixture 文案刻意不含这几个词，
        // 故全文命中只可能来自**字段名**，不会因回复正文里恰好写了「score」而假红
        expect(poolRes.body).not.toMatch(/score|judge/i)
        // 第 2 道：键集（逐行递归——全文 grep 是超集探针，第 1 道过了不代表结构没多挂键）
        const keys: string[] = []
        const walk = (v: unknown): void => {
          if (Array.isArray(v)) return v.forEach(walk)
          if (v && typeof v === 'object') {
            for (const [k, sub] of Object.entries(v)) {
              keys.push(k)
              walk(sub)
            }
          }
        }
        walk(JSON.parse(poolRes.body))
        expect(keys.filter((k) => /score|judge/i.test(k))).toEqual([])

        // 反对照：**同一个 fixture** 走回标端点，响应里必须有判官分 —— 证明上面两条
        // 不是「夹具本来就什么都没有」的恒真
        const reviewRes = await app.inject({ method: 'GET', url: '/api/eval/review/pending' })
        expect(reviewRes.statusCode).toBe(200)
        expect(reviewRes.body).toMatch(/score/)
        expect(JSON.parse(reviewRes.body).pending[0].message_id).toBe(m0)
        expect(scoreId).toBeTruthy()
      })

      it('E1 契约 D：每条附前置上下文，取的是**之前最近**的 N 条（不是会话头几条）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        // 12 条 user 排在回复之前，**刻意超过 limit=10**：这样「取最早 10 条」与「取最近
        // 10 条」返回的是两个不同的集合。只摆两三条的话两种取法结果一样——那是假绿门。
        for (let i = 0; i < 12; i++) {
          const id = `u${String(i).padStart(2, '0')}`
          messagesRepo.insertUserMessage(id, sessionId, `第 ${i} 条 user`, '[]', null)
          setCreatedAt('messages', id, `2026-09-01T10:${String(i).padStart(2, '0')}:00.000Z`)
        }
        messagesRepo.insertAgentMessage('r1', sessionId, agentId, '待标注的猫回复', null)
        setCreatedAt('messages', 'r1', '2026-09-01T11:00:00.000Z')
        // 回复**之后**的一条：`created_at < ?` 是严格的，它不得出现在上文里
        messagesRepo.insertUserMessage('after', sessionId, '回复之后的 user', '[]', null)
        setCreatedAt('messages', 'after', '2026-09-01T12:00:00.000Z')

        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        const { pool } = JSON.parse(res.body) as {
          pool: Array<{ id: string; context: Array<{ id: string; content: string }> }>
        }
        const sample = pool.find((p) => p.id === 'r1')
        expect(sample).toBeTruthy()
        expect(sample!.context.length).toBeGreaterThan(0) // 非空 ⇒ 下面那道键集行走真能下潜
        // 盲标面（E1 新增字段的 ⑩ 复验）：既有的键集断言跑在 `context` 为空的夹具上，
        // 递归行走根本进不去新字段——探针宽度 < 判据宽度时，「没测到」会被读成「没问题」。
        const keys: string[] = []
        const walk = (v: unknown): void => {
          if (Array.isArray(v)) return v.forEach(walk)
          if (v && typeof v === 'object') {
            for (const [k, sub] of Object.entries(v)) {
              keys.push(k)
              walk(sub)
            }
          }
        }
        walk(JSON.parse(res.body))
        expect(keys.filter((k) => /score|judge/i.test(k))).toEqual([])
        expect(res.body).not.toMatch(/score|judge/i)
        const ids = sample!.context.map((c) => c.id)
        // 最近 10 条 = u02..u11。「取最早 10 条」会给 u00..u09 ⇒ 首元素不同，必红
        expect(ids).toEqual(['u02', 'u03', 'u04', 'u05', 'u06', 'u07', 'u08', 'u09', 'u10', 'u11'])
        expect(ids).not.toContain('after')
        // ASC 序 = 渲染序（`getContextBefore` 内部 `reverse()` 过）：最近的一条在**最后**
        // ——前端不做重排，顺序错了在标注界面上就是「倒着读」
        expect(sample!.context[sample!.context.length - 1].content).toBe('第 11 条 user')
      })

      it('E1：上文**跨会话不泄漏**（同 agent 在别的会话里的消息不得混进来）', async () => {
        const agentId = seedAgent('flash猫')
        const s1 = seedSession()
        const s2 = seedSession()
        messagesRepo.insertUserMessage('other', s2, '别的会话里的 user 原话', '[]', null)
        setCreatedAt('messages', 'other', '2026-09-01T09:00:00.000Z')
        messagesRepo.insertUserMessage('same', s1, '本会话里的 user 原话', '[]', null)
        setCreatedAt('messages', 'same', '2026-09-01T09:30:00.000Z')
        messagesRepo.insertAgentMessage('r1', s1, agentId, '待标注的猫回复', null)
        setCreatedAt('messages', 'r1', '2026-09-01T10:00:00.000Z')

        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        const { pool } = JSON.parse(res.body) as {
          pool: Array<{ id: string; context: Array<{ id: string }> }>
        }
        const sample = pool.find((p) => p.id === 'r1')
        expect(sample!.context.map((c) => c.id)).toEqual(['same'])
      })

      it('跨会话分散：默认参数下每会话 ≤3 条，且每个会话都出得来', async () => {
        const agentId = seedAgent('flash猫')
        for (const s of ['s1', 's2', 's3']) {
          const sid = seedSession()
          void s
          seedReplies(sid, agentId, 5, `r-${sid}`)
        }
        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        const { pool, perSession, limit, days } = JSON.parse(res.body) as {
          pool: Array<{ session_id: string }>
          perSession: number
          limit: number
          days: number | null
        }
        expect(perSession).toBe(3)
        expect(limit).toBe(30)
        expect(days).toBeNull() // 不给 days = 不限窗（值本身也要能看见）
        const bySession = pool.reduce<Record<string, number>>((a, r) => {
          a[r.session_id] = (a[r.session_id] ?? 0) + 1
          return a
        }, {})
        expect(Object.values(bySession).every((n) => n <= 3)).toBe(true)
        expect(Object.keys(bySession)).toHaveLength(3)
        expect(pool).toHaveLength(9)
      })

      it('已标注的样本不再出现；同会话未标注的照常出现（反例面）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const ids = seedReplies(sessionId, agentId, 3, 'r')
        seedHumanLabel(ids[2], sessionId, agentId, 5)

        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        const pool = JSON.parse(res.body).pool as Array<{ id: string }>
        expect(pool.map((p) => p.id)).not.toContain(ids[2])
        expect(pool).toHaveLength(2)
      })

      it('非法参数 400（limit / perSession / days 三处，不静默回默认）', async () => {
        for (const url of [
          '/api/eval/label/pool?limit=0',
          '/api/eval/label/pool?limit=abc',
          '/api/eval/label/pool?limit=201',
          '/api/eval/label/pool?perSession=0',
          '/api/eval/label/pool?perSession=abc',
          '/api/eval/label/pool?perSession=21',
          '/api/eval/label/pool?days=abc',
          '/api/eval/label/pool?days=0',
        ]) {
          const res = await app.inject({ method: 'GET', url })
          expect(res.statusCode, url).toBe(400)
        }
      })

      it('空库 → 200 + 空数组（不是 404 / 500）', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).pool).toEqual([])
      })
    })

    describe('POST /api/eval/label/:messageId', () => {
      it('提交 → 落 human_labels（带会话/猫/标注源），covered=false', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')

        const res = await app.inject({
          method: 'POST',
          url: `/api/eval/label/${m0}`,
          payload: { score: 5, comment: '写得好' },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.covered).toBe(false)
        expect(body.label.score).toBe(5)
        expect(body.label.comment).toBe('写得好')
        expect(body.label.session_id).toBe(sessionId)
        expect(body.label.agent_id).toBe(agentId)
        expect(body.label.labeler).toBe('user') // 不传 labeler → 默认单源
      })

      it('重复提交同一 message → 覆盖 + 留痕（log.warn），**不 409**、不新增行', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')

        await app.inject({
          method: 'POST',
          url: `/api/eval/label/${m0}`,
          payload: { score: 1 },
        })
        const res2 = await app.inject({
          method: 'POST',
          url: `/api/eval/label/${m0}`,
          payload: { score: 4, comment: '改判' },
        })
        expect(res2.statusCode).toBe(200)
        const body = JSON.parse(res2.body)
        expect(body.covered).toBe(true)
        expect(body.label.score).toBe(4)
        const n = getDb().prepare('SELECT COUNT(*) AS n FROM human_labels').get() as { n: number }
        expect(n.n).toBe(1)
      })

      it('非 1-5 整数 → 400（0 / 6 / 3.5 / "3" 四种；字符串不静默转 number）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')
        for (const score of [0, 6, 3.5, '3', null, undefined]) {
          const res = await app.inject({
            method: 'POST',
            url: `/api/eval/label/${m0}`,
            payload: { score },
          })
          expect(res.statusCode, String(score)).toBe(400)
        }
        const n = getDb().prepare('SELECT COUNT(*) AS n FROM human_labels').get() as { n: number }
        expect(n.n).toBe(0)
      })

      it('消息不存在 → 404；**不是猫的回复**（user / system）→ 400（两种失败面分开）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const db = getDb()
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES ('u1', ?, 'user', '用户说的话', '[]')`
        ).run(sessionId)

        const missing = await app.inject({
          method: 'POST',
          url: '/api/eval/label/nope',
          payload: { score: 3 },
        })
        expect(missing.statusCode).toBe(404)

        const notReply = await app.inject({
          method: 'POST',
          url: '/api/eval/label/u1',
          payload: { score: 3 },
        })
        expect(notReply.statusCode).toBe(400)
        expect(JSON.parse(notReply.body).error).toBe('message is not an agent reply')
        // 反例面：同一条路径喂**猫的回复**必须成功——证明 400 来自角色判定不是路径坏了
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')
        const ok = await app.inject({
          method: 'POST',
          url: `/api/eval/label/${m0}`,
          payload: { score: 3 },
        })
        expect(ok.statusCode).toBe(200)
      })

      it('提交后该条移出池子（池子的排除面走服务端真源，不靠前端 filter）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0, m1] = seedReplies(sessionId, agentId, 2, 'r')

        await app.inject({
          method: 'POST',
          url: `/api/eval/label/${m0}`,
          payload: { score: 4 },
        })
        const res = await app.inject({ method: 'GET', url: '/api/eval/label/pool' })
        const pool = JSON.parse(res.body).pool as Array<{ id: string }>
        expect(pool.map((p) => p.id)).toEqual([m1])
      })
    })

    describe('GET /api/eval/judge-agreement', () => {
      it('空库 → 200 + 结构化空态（**不是 500**）：counted=0、sufficient=false、读数 null 不是 0', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.total).toBe(0)
        expect(body.counted).toBe(0)
        expect(body.sufficient).toBe(false)
        // null 而不是 0：0 是个合法读数（完全不相关），会把「没数据」画成「完全不相关」
        expect(body.spearman).toBeNull()
        expect(body.agreement).toBeNull()
        expect(body.judgeModels).toEqual([])
        expect(body.gate).toBeNull()
        expect(typeof body.gateUnavailableReason).toBe('string')
      })

      it('读数与 phase0.agreementRate **逐位相同**（防第二条真相源）+ 与手算一致', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const ids = seedReplies(sessionId, agentId, 6, 'r')
        // 六对：同 pass / 同 fail / 一方 3 不计 / 分歧 —— 四类都覆盖
        const pairs: Array<[number, number]> = [
          [5, 4],
          [5, 5],
          [2, 1],
          [1, 2],
          [4, 3],
          [2, 5],
        ]
        pairs.forEach(([judge, human], i) => {
          seedScore({ agentId, sessionId, messageId: ids[i], score: judge, sampleReason: 'random' })
          seedHumanLabel(ids[i], sessionId, agentId, human)
        })

        const res = await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)

        const expected = agreementRate(
          pairs.map((p) => p[0]),
          pairs.map((p) => p[1])
        )
        // 逐位相同（不是 toBeCloseTo）——J1 §六-4 的验收就是这条
        expect(body.agreement).toBe(expected.rate)
        expect(body.counted).toBe(expected.counted)
        expect(body.total).toBe(expected.total)
        // 手算对照：六对里 [4,3] 出分母（人工 3）⇒ counted=5，其中 [2,5] 分歧 ⇒ 4/5
        expect(body.counted).toBe(5)
        expect(body.agreement).toBeCloseTo(0.8, 10)
        expect(body.spearman).toBeCloseTo(
          spearman(
            pairs.map((p) => p[0]),
            pairs.map((p) => p[1])
          ),
          10
        )
        expect(body.judgeModels).toEqual(['test-judge'])
      })

      it('分母下界：counted < minCount ⇒ sufficient=false，**不给判定**（gate 仍为 null）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')
        seedScore({ agentId, sessionId, messageId: m0, score: 5, sampleReason: 'random' })
        seedHumanLabel(m0, sessionId, agentId, 5)

        // 同 `slowMs`：`minCount` 现读 env（`eval.ts:561` `envNumber('EVAL_LABEL_MIN_COUNT', 30)`）。
        // 钉非默认值 50——它仍 > counted=1，本用例的判据（counted < minCount ⇒ 不给判定）不变。
        vi.stubEnv('EVAL_LABEL_MIN_COUNT', '50')
        const res = await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })
        const body = JSON.parse(res.body)
        expect(body.counted).toBe(1)
        expect(body.minCount).toBe(50)
        expect(body.sufficient).toBe(false)
        expect(body.gate).toBeNull()
      })

      // ─── env 坏值回归（票 env-number-guards · 组件 B）─────────────
      // 上面那条钉合法值 50——证「读 env」；本条钉坏值 ⇒ 回退：改前表达式得 NaN，
      // `Math.trunc(NaN)` 仍是 NaN ⇒ JSON 出 `"minCount":null`，「样本够不够」当场不可判。
      it('env 坏值回归：EVAL_LABEL_MIN_COUNT 坏值/空串 ⇒ minCount 回退 30（不是 null/NaN）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const [m0] = seedReplies(sessionId, agentId, 1, 'r')
        seedScore({ agentId, sessionId, messageId: m0, score: 5, sampleReason: 'random' })
        seedHumanLabel(m0, sessionId, agentId, 5)

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const prevLevel = getLogLevel()
        setLogLevel('warn') // 同 slowMs：走真 logger，级别不放 warn 则断言恒真
        try {
          const warns = (): string[] =>
            stdoutSpy.mock.calls
              .map((c) => String(c[0]))
              .filter((l) => l.includes('env-number') && l.includes('EVAL_LABEL_MIN_COUNT'))

          vi.stubEnv('EVAL_LABEL_MIN_COUNT', 'abc')
          const bad = JSON.parse(
            (await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })).body
          )
          expect(bad.minCount).toBe(30) // 读到 fallback：不是 NaN、不是 0、不是 null
          // 正对照：坏值必须出声（否则下面的「不新增」恒真）。条数 = 读取次数，不作断言。
          expect(warns().length).toBeGreaterThan(0)
          const afterBad = warns().length

          vi.stubEnv('EVAL_LABEL_MIN_COUNT', '')
          const empty = JSON.parse(
            (await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })).body
          )
          expect(empty.minCount).toBe(30)
          expect(warns().length).toBe(afterBad) // 空串：调用次数可变，warn 一条都不许新增
        } finally {
          stdoutSpy.mockRestore()
          setLogLevel(prevLevel)
        }
      })

      it('只有人工分、没有判官分的 message 不进分母（JOIN 是内连接）', async () => {
        const agentId = seedAgent('flash猫')
        const sessionId = seedSession()
        const ids = seedReplies(sessionId, agentId, 2, 'r')
        seedScore({ agentId, sessionId, messageId: ids[0], score: 5, sampleReason: 'random' })
        seedHumanLabel(ids[0], sessionId, agentId, 5)
        seedHumanLabel(ids[1], sessionId, agentId, 1) // 无判官分

        const res = await app.inject({ method: 'GET', url: '/api/eval/judge-agreement' })
        const body = JSON.parse(res.body)
        expect(body.total).toBe(1)
        expect(body.counted).toBe(1)
      })
    })
  })

  describe('E1 检索跑批报告（只读出口）', () => {
    /** 夹具根 = `os.tmpdir()` 下自建目录。**报告目录是它的子目录**——「穿越」那条要往
     *  上一级写诱饵文件，放在自己根下才收得干净（别往 `tmpdir()` 裸根里扔东西）。 */
    let base: string
    let dir: string

    /** 造一份最小但形状真实的报告 JSON（= `buildReportJson(ctx)` = `{schema, ...ctx}`）。 */
    function reportBody(date: string): string {
      return JSON.stringify({
        schema: 1,
        date,
        groups: { real: { recallMean: 0.5833 }, constructed: { recallMean: 0.8261 } },
        scores: [],
      })
    }

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'eval-retrieval-'))
      dir = join(base, 'docs-eval')
      mkdirSync(dir)
      writeFileSync(join(dir, 'retrieval-baseline-2026-09-20.json'), reportBody('2026-09-20'))
      writeFileSync(join(dir, 'retrieval-baseline-2026-09-19.json'), reportBody('2026-09-19'))
      // 同目录还躺着跑批落的 md 报告与别的 json——**只有契约名算报告**，其余绝不进清单
      writeFileSync(join(dir, 'retrieval-baseline-2026-09-18.md'), '# md 不是报告')
      writeFileSync(join(dir, 'notes.json'), '{}')
      __test_setRetrievalReportsDir(dir)
    })

    afterEach(() => {
      __test_setRetrievalReportsDir(undefined)
      rmSync(base, { recursive: true, force: true })
    })

    it('清单：日期倒序，且只认契约文件名（md 与别的 json 不进）', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/eval/retrieval/reports' })
      expect(res.statusCode).toBe(200)
      const { ok, reports } = JSON.parse(res.body) as {
        ok: boolean
        reports: Array<{ date: string; file: string; writtenAt: string | null }>
      }
      expect(ok).toBe(true)
      expect(reports.map((r) => r.date)).toEqual(['2026-09-20', '2026-09-19'])
      expect(reports[0].file).toBe('retrieval-baseline-2026-09-20.json')
      // `writtenAt` 取自**文件 mtime**（报告本体按 B1 零时间量），必须是可解析的 ISO
      expect(Number.isFinite(Date.parse(reports[0].writtenAt!))).toBe(true)
    })

    it('空清单是 200 + `[]`，**不是 404**（「还没跑过批」不是错误）', async () => {
      __test_setRetrievalReportsDir(null) // 钉成「解析不到仓库根」
      const res = await app.inject({ method: 'GET', url: '/api/eval/retrieval/reports' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true, reports: [] })
    })

    it('单份：缺省 = 最新；`?date=` 取指定那份', async () => {
      const latest = await app.inject({ method: 'GET', url: '/api/eval/retrieval/report' })
      expect(latest.statusCode).toBe(200)
      expect(JSON.parse(latest.body).date).toBe('2026-09-20')

      const older = await app.inject({
        method: 'GET',
        url: '/api/eval/retrieval/report?date=2026-09-19',
      })
      expect(older.statusCode).toBe(200)
      const body = JSON.parse(older.body) as {
        date: string
        report: { schema: number; groups: { real: { recallMean: number } } }
      }
      expect(body.date).toBe('2026-09-19')
      // 取的是**那一份的内容**，不是「最新那份换个日期标签」——夹具两天的 recallMean
      // 刻意不同，张冠李戴这里就红（虽是同一份 body 造的，读的文件名不同即路径错）
      expect(body.report.groups.real.recallMean).toBe(0.5833)
      expect(body.report.schema).toBe(1)
    })

    it('没有报告 ⇒ 404 + reason（不静默给空对象）', async () => {
      rmSync(join(dir, 'retrieval-baseline-2026-09-20.json'))
      rmSync(join(dir, 'retrieval-baseline-2026-09-19.json'))
      const none = await app.inject({ method: 'GET', url: '/api/eval/retrieval/report' })
      expect(none.statusCode).toBe(404)
      expect(JSON.parse(none.body).error).toContain('no retrieval baseline report yet')

      // 清单非空但**那天没有** ⇒ 也是 404，但理由不同（否则会去查错方向）
      writeFileSync(join(dir, 'retrieval-baseline-2026-09-20.json'), reportBody('2026-09-20'))
      const missing = await app.inject({
        method: 'GET',
        url: '/api/eval/retrieval/report?date=2026-09-01',
      })
      expect(missing.statusCode).toBe(404)
      expect(JSON.parse(missing.body).error).toContain('2026-09-01')
    })

    it('`?date=` 形状不对 ⇒ 400（与 404 分开：写错的调用方不该被伪装成「那天没有」）', async () => {
      for (const bad of ['abc', '2026-9-1', '2026-09-20T00:00:00Z', '../../etc/passwd']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/eval/retrieval/report?date=${encodeURIComponent(bad)}`,
        })
        expect(res.statusCode, `date=${bad}`).toBe(400)
      }
    })

    it('穿越防护：date 拼进文件名**之前**就死在形状闸上', async () => {
      // 上一级真放一个「穿越目标」——证明挡住它的是正则，而不是「那个文件恰好不存在」
      const bait = join(base, 'retrieval-baseline-1999-01-01.json')
      writeFileSync(bait, reportBody('1999-01-01'))
      const res = await app.inject({
        method: 'GET',
        url: '/api/eval/retrieval/report?date=..%2Fretrieval-baseline-1999-01-01.json',
      })
      expect(res.statusCode).toBe(400)
      expect(existsSync(bait)).toBe(true) // 诱饵仍在 ⇒ 上面不是「读到了才挡」
    })

    it('读不动 / 顶层不是对象 ⇒ 500（不是调用方写错，不能伪装成 404）', async () => {
      writeFileSync(join(dir, 'retrieval-baseline-2026-09-17.json'), 'not json at all')
      const broken = await app.inject({
        method: 'GET',
        url: '/api/eval/retrieval/report?date=2026-09-17',
      })
      expect(broken.statusCode).toBe(500)

      writeFileSync(join(dir, 'retrieval-baseline-2026-09-16.json'), '[1,2,3]')
      const arr = await app.inject({
        method: 'GET',
        url: '/api/eval/retrieval/report?date=2026-09-16',
      })
      expect(arr.statusCode).toBe(500)
    })

    it('契约 B 路径解析：源码布局与产物布局**同解**（负对照：固定层级必有一边红）', () => {
      const srcStart = dirname(fileURLToPath(import.meta.url))
      const root = findRepoRootFrom(srcStart, RETRIEVAL_REPO_MARKER)
      expect(root).not.toBeNull()
      expect(existsSync(join(root!, 'docs', 'eval', 'retrieval-golden.json'))).toBe(true)
      // 产物布局：`tsconfig.json` 的 `rootDir: ".."` + `outDir: "./dist"` ⇒ 比源码深两层
      const distStart = join(root!, 'packages', 'server', 'dist', 'server', 'src', 'routes')
      expect(findRepoRootFrom(distStart, RETRIEVAL_REPO_MARKER)).toBe(root)

      // 负对照**两条缺一不可**：只断言「产物下错」的话，一个「恒返回垃圾」的实现也绿
      const fixed4 = (d: string): string => resolve(d, '..', '..', '..', '..')
      const marker = join('docs', 'eval', 'retrieval-golden.json')
      expect(existsSync(join(fixed4(srcStart), marker))).toBe(true) // 源码下固定层级确实对
      expect(existsSync(join(fixed4(distStart), marker))).toBe(false) // 产物下必错
    })

    it('契约 B：报告目录走 `findRepoRootFrom`，本文件不得再出现固定层级上溯', () => {
      // 上一条证的是「向上找能同解」，这条证的是**路由真的用了它**——少了这条，
      // 路由改回固定层级而测试照绿（G5 已把这类写法点名拒绝过一次）。
      const src = readFileSync(new URL('./eval.ts', import.meta.url), 'utf8')
      expect(src).toContain('findRepoRootFrom(')
      expect(src).not.toMatch(/new URL\(\s*['"]\.\.\//)
    })
  })
})

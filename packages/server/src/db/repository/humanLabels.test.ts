/**
 * `human_labels` 仓储测试（J1 人工标注）。
 *
 * 判据面三条，每条配一个**真空性反对照**（正例全绿也可能只是约束/过滤压根没生效）：
 *
 * 1. **覆盖语义**：同 `message_id` 再写 → 覆盖（不新增行、不抛 UNIQUE），且 `created_at`
 *    保留**首次**时间锚点 —— 反例：换一个 `message_id` 写 → 必须新增第二行（证明
 *    「没新增」不是「压根写不进去」）。
 * 2. **池子只出猫的回复**：`role='user'` / `role='system'` 的行不得入池 —— 反例：同会话
 *    放一条 `role='agent'` 的进去 → 必须出现（证明过滤不是「把谁都滤掉」）。
 * 3. **池子排除已标注**：标过一条 → 它不再出现，**同会话的其余回复照常出现**（反例面）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import {
  initRepository,
  humanLabels as humanLabelsRepo,
  evalScores as evalScoresRepo,
} from './index.js'

describe('db/repository/humanLabels', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  /** 建一个会话 + 一只猫 + n 条猫回复，返回 [sessionId, agentId, messageIds] */
  function seedSessionWithReplies(n: number, sessionId = 'sess-1'): [string, string, string[]] {
    const db = getDb()
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(sessionId)
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, system_prompt, llm_api_key)
       VALUES ('a1', 'flash猫', 'p', 'sk')`
    ).run()
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = `${sessionId}-m${i}`
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES (?, ?, 'a1', 'agent', ?, '[]', ?)`
      ).run(id, sessionId, `回复 ${i}`, `2026-09-0${i + 1}T10:00:00.000Z`)
      ids.push(id)
    }
    return [sessionId, 'a1', ids]
  }

  const label = (messageId: string, score: number, comment: string | null = null): boolean =>
    humanLabelsRepo.upsertLabel({
      id: `hl-${messageId}-${score}`,
      messageId,
      sessionId: 'sess-1',
      agentId: 'a1',
      labeler: 'user',
      score,
      comment,
    })

  describe('upsertLabel —— 覆盖语义（不 409，照 user_feedback 同款）', () => {
    it('首次写入 → 新增一行，covered=false，created_at 由仓储生成（ISO 毫秒 UTC）', () => {
      const [, , [m0]] = seedSessionWithReplies(1)
      expect(label(m0, 4, '还行')).toBe(false)

      const row = humanLabelsRepo.getByMessageId(m0)
      expect(row?.score).toBe(4)
      expect(row?.comment).toBe('还行')
      expect(row?.labeler).toBe('user')
      expect(row?.session_id).toBe('sess-1')
      expect(row?.agent_id).toBe('a1')
      // 时间形态 = 全库记录时间口径（ISO 毫秒 UTC），不是 `datetime('now')` 的秒级裸串
      expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('重复提交同一 message_id → 覆盖改值、**不新增行**、covered=true、created_at 不动', () => {
      const [, , [m0]] = seedSessionWithReplies(1)
      label(m0, 1, '差')
      const first = humanLabelsRepo.getByMessageId(m0)

      expect(label(m0, 5, '其实很好')).toBe(true)
      const second = humanLabelsRepo.getByMessageId(m0)

      expect(second?.score).toBe(5)
      expect(second?.comment).toBe('其实很好')
      // 时间锚点保留首次：否则「这条标注是什么时候做的」会被一次改分抹掉
      expect(second?.created_at).toBe(first?.created_at)
      expect(humanLabelsRepo.countLabels()).toBe(1)
    })

    it('反例（真空性）：换一条 message_id → 必须新增第二行', () => {
      const [, , [m0, m1]] = seedSessionWithReplies(2)
      label(m0, 4)
      label(m1, 2)
      expect(humanLabelsRepo.countLabels()).toBe(2)
      expect(humanLabelsRepo.getByMessageId(m1)?.score).toBe(2)
    })

    it('库层 CHECK 兜底：越界分（0 / 6）抛错，不被静默写入', () => {
      const [, , [m0]] = seedSessionWithReplies(1)
      expect(() => label(m0, 0)).toThrowError(/CHECK/)
      expect(() => label(m0, 6)).toThrowError(/CHECK/)
      expect(humanLabelsRepo.countLabels()).toBe(0)
    })
  })

  describe('listLabelPool —— 盲标池取数口径', () => {
    it('只出 role=agent 的回复；user / system 行不入池（反例：同会话的 agent 行必须入池）', () => {
      const [sid, , msgs] = seedSessionWithReplies(1)
      const db = getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('u1', ?, 'user', '用户消息', '[]', '2026-09-05T10:00:00.000Z')`
      ).run(sid)
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('sys1', ?, 'system', '系统通告', '[]', '2026-09-06T10:00:00.000Z')`
      ).run(sid)

      const pool = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 })
      expect(pool.map((r) => r.id)).toEqual(msgs)
      // 反例面：池子非空 —— 证明上面那行不是「过滤把谁都滤掉了」的恒真
      expect(pool).toHaveLength(1)
    })

    it('空内容回复不入池（标不了）', () => {
      const [sid] = seedSessionWithReplies(1)
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES ('blank', ?, 'a1', 'agent', '   ', '[]', '2026-09-07T10:00:00.000Z')`
        )
        .run(sid)
      expect(
        humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 }).map((r) => r.id)
      ).not.toContain('blank')
    })

    it('跨会话分散：每会话 ≤ perSession 条，且**别的会话照常出现**（反例面）', () => {
      seedSessionWithReplies(5, 'sess-1')
      seedSessionWithReplies(5, 'sess-2')

      const pool = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 })
      const bySession = pool.reduce<Record<string, number>>((acc, r) => {
        acc[r.session_id] = (acc[r.session_id] ?? 0) + 1
        return acc
      }, {})
      // 两个会话各 3 条 —— 两半都要有：只查 "≤3" 的话「池子空」也会通过
      expect(bySession).toEqual({ 'sess-1': 3, 'sess-2': 3 })
    })

    it('perSession 收紧 → 每会话条数跟着收紧（证明这个参数真的在起作用）', () => {
      seedSessionWithReplies(5, 'sess-1')
      expect(humanLabelsRepo.listLabelPool({ limit: 30, perSession: 1 })).toHaveLength(1)
      expect(humanLabelsRepo.listLabelPool({ limit: 30, perSession: 5 })).toHaveLength(5)
    })

    it('已标注的不再入池；**同会话未标注的照常出现**（反例面）', () => {
      const [, , msgs] = seedSessionWithReplies(3)
      label(msgs[2], 5) // 最新那条已标

      const pool = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 })
      expect(pool.map((r) => r.id)).not.toContain(msgs[2])
      expect(pool.map((r) => r.id).sort()).toEqual([msgs[0], msgs[1]].sort())
    })

    it('agentId 过滤：只出该猫的回复', () => {
      const [sid] = seedSessionWithReplies(1)
      const db = getDb()
      db.prepare(
        `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES ('a2', 'ds猫', 'p', 'sk')`
      ).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES ('m-a2', ?, 'a2', 'agent', '另一只猫', '[]', '2026-09-08T10:00:00.000Z')`
      ).run(sid)

      const pool = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3, agentId: 'a2' })
      expect(pool.map((r) => r.id)).toEqual(['m-a2'])
    })

    it('days 时间窗：窗口外的老回复不入池（不给 days = 不限窗，老回复照常入池）', () => {
      const [sid] = seedSessionWithReplies(1) // 固定为 2026-09-01，早于「今天」
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
           VALUES ('fresh', ?, 'a1', 'agent', '刚说的', '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        )
        .run(sid)

      const noWindow = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 5 })
      expect(noWindow.map((r) => r.id).sort()).toEqual(['fresh', `${sid}-m0`].sort())

      const windowed = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 5, days: 7 })
      expect(windowed.map((r) => r.id)).toEqual(['fresh'])
    })

    it('空库 → 空数组（不抛）', () => {
      expect(humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 })).toEqual([])
    })

    it('响应形状 = 白名单列，**不含任何判官分字段**（结构层，防将来有人顺手 JOIN 进来）', () => {
      const [sid, , [m0]] = seedSessionWithReplies(1)
      // 给这条回复造一个判官分：若取数层漏出它，下面逐列断言会当场炸
      evalScoresRepo.insertScore({
        id: 'es1',
        messageId: m0,
        sessionId: sid,
        agentId: 'a1',
        score: 1,
        dimensionsJson: null,
        judgeModel: 'test-judge',
        sampleReason: 'low_score',
      })
      const [row] = humanLabelsRepo.listLabelPool({ limit: 30, perSession: 3 })
      expect(Object.keys(row).sort()).toEqual(
        ['agent_id', 'agent_name', 'content', 'created_at', 'id', 'session_id'].sort()
      )
    })
  })

  describe('listJudgeHumanPairs —— J1 一致性取数（按 message_id JOIN）', () => {
    it('只有两边都有分的 message 才配对；判官分 / 人工分各取自己表的值', () => {
      const [sid, , msgs] = seedSessionWithReplies(3)
      const score = (messageId: string, s: number): void =>
        evalScoresRepo.insertScore({
          id: `es-${messageId}`,
          messageId,
          sessionId: sid,
          agentId: 'a1',
          score: s,
          dimensionsJson: null,
          judgeModel: 'kimi-k3',
          sampleReason: 'random',
        })
      // 三条回复：两条双边齐（配对）、一条只有人工分（落单，不得进分母）
      score(msgs[0], 5)
      label(msgs[0], 4)
      score(msgs[1], 1)
      label(msgs[1], 2)
      label(msgs[2], 3)

      const pairs = humanLabelsRepo.listJudgeHumanPairs()
      expect(pairs).toHaveLength(2)
      expect(pairs.map((p) => [p.judge_score, p.human_score]).sort()).toEqual([
        [1, 2],
        [5, 4],
      ])
      expect(pairs.every((p) => p.judge_model === 'kimi-k3')).toBe(true)
    })

    it('空库 → 空数组（空态不抛）', () => {
      expect(humanLabelsRepo.listJudgeHumanPairs()).toEqual([])
    })
  })
})

/**
 * `retrieval_*` 三表写口测试（P2 / R1）。
 *
 * 测试面 = **真实迁移路径**：`createTestDb()` 造「老库」（无 retrieval 三表）→
 * `initDb()` 跑生产同一条 additive 迁移建表。不手搓 DDL——手搓等于把「被判面」
 * 换成测试自己写的代理面（票丁 B9 教训，chunks.test.ts 同款范式）。
 *
 * 覆盖 P2 §九 中**写口侧可独立判定**的验收：1（additive）/ 2（写入成立）/
 * 3（同事务无半写完）/ 8（写失败不致命）/ 10（FK 与唯一约束）/ 11（参数快照）。
 * 4 / 5 / 6 / 7 / 9 / 13 / 15 / 16 的**判据面在调用方**（`memory/index.ts` 的
 * 映射与 `execution/reply.ts` 的 reason 三元式），落在 `memory/index.test.ts`——
 * 在本文件里测它们只能测到「写口原样存了给它的值」，是恒真的假绿门。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../index.js'
import { initRepository, retrievalEvents as repo } from './index.js'
import type { RetrievalEventInput } from './retrievalEvents.js'

/** 造一条最小可用的 event 输入（用例只覆盖关心的字段，其余用默认值） */
function makeEvent(over: Partial<RetrievalEventInput> = {}): RetrievalEventInput {
  return {
    executionId: 'exec-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    taskId: 'task-anchor-1',
    createdAt: '2026-09-14T00:00:00.000Z',
    thresholdMaxDistance: 0.6,
    paramTopK: 3,
    paramProbeN: 20,
    paramPoolN: 20,
    reason: 'ok',
    retrievalMs: 42,
    contextTokens: 100,
    budgetTokens: 8000,
    truncated: false,
    queries: [{ queryIndex: 0, queryText: '原话', queryEmbedOk: true }],
    candidates: [
      {
        queryIndex: 0,
        source: 'final',
        channel: 'vector',
        docPath: 'docs/adr/0002-b.md',
        sectionAnchor: '## 决策',
        contentHash: 'h1',
        chunkId: 7,
        breadcrumb: 'docs/adr/0002-b.md > 决策',
        bodyHead: '候选片正文全文',
        statusAtQuery: null,
        distance: 0.293,
        rank: 0,
        rrfScore: 0.016,
        finalRank: 0,
        passedStatusFilter: null,
        injected: true,
        sectionRank: 0,
        injectedPosition: 1,
        droppedReason: null,
      },
    ],
    ...over,
  }
}

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('retrievalEvents 写口', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 1：additive ──────────────────────────────
  describe('验收 1 · 三表 additive 建表', () => {
    it('三表在迁移产物里，且重跑 initDb 时既有表行数一行不变', () => {
      // 夹具三表来自真实迁移路径（空库重放基线集）；再塞几行数据后重跑一次 initDb
      // ——证明台账路径**零执行**、既有数据一行不动
      const db = getDb()
      db.prepare(
        `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES ('agent-1', 'flash猫', 'p', 'k')`
      ).run()
      db.prepare(`INSERT INTO sessions (id, title) VALUES ('sess-1', 't')`).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, task_id)
         VALUES ('m1', 'sess-1', 'user', 'x', 'task-anchor-1')`
      ).run()
      const before = {
        agents: countRows('agents'),
        sessions: countRows('sessions'),
        messages: countRows('messages'),
      }

      initDb() // 再跑一次迁移（老库重跑零副作用）

      const names = (
        getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
      expect(names).toContain('retrieval_events')
      expect(names).toContain('retrieval_queries')
      expect(names).toContain('retrieval_candidates')

      expect(countRows('agents')).toBe(before.agents)
      expect(countRows('sessions')).toBe(before.sessions)
      expect(countRows('messages')).toBe(before.messages)
    })
  })

  // ─── 验收 2：写入成立 ──────────────────────────────
  describe('验收 2 · 三表按 1 / N / N 增加', () => {
    it('一次写入落 1 行 event + 2 行 query + 2 行 candidate，execution_id 可对账', () => {
      const id = repo.insertRetrievalTrace(
        makeEvent({
          queries: [
            { queryIndex: 0, queryText: '原话', queryEmbedOk: true },
            { queryIndex: 1, queryText: '改写', queryEmbedOk: true },
          ],
          candidates: [
            { ...makeEvent().candidates[0] },
            { ...makeEvent().candidates[0], queryIndex: 1, contentHash: 'h2', chunkId: 8 },
          ],
        })
      )

      expect(id).toBeTypeOf('number')
      expect(countRows('retrieval_events')).toBe(1)
      expect(countRows('retrieval_queries')).toBe(2)
      expect(countRows('retrieval_candidates')).toBe(2)

      const row = getDb().prepare('SELECT * FROM retrieval_events WHERE id = ?').get(id) as Record<
        string,
        unknown
      >
      expect(row.execution_id).toBe('exec-1')
      expect(row.task_id).toBe('task-anchor-1')
      // 与 execution_logs 对账（写口只是存值，对账靠同一 id 串）
      expect(row.session_id).toBe('sess-1')
      expect(row.agent_id).toBe('agent-1')
    })
  })

  // ─── 验收 3：同事务，无半写完 ──────────────────────
  describe('验收 3 · 同事务（拆表新引入的风险面）', () => {
    it('第三张表插入抛错 → 前两张表零残留', () => {
      // 注入真错：`content_hash` 是 NOT NULL，传 null 必抛
      const bad = makeEvent({
        candidates: [{ ...makeEvent().candidates[0], contentHash: null as unknown as string }],
      })

      const id = repo.insertRetrievalTrace(bad)

      // 写口吞错（硬约束 2）
      expect(id).toBeUndefined()
      // 关键断言：**不是**「只丢了 candidates」
      expect(countRows('retrieval_events')).toBe(0)
      expect(countRows('retrieval_queries')).toBe(0)
      expect(countRows('retrieval_candidates')).toBe(0)
    })

    it('候选引用不存在的 query_index → 只丢该行，event 与 query 照常落盘', () => {
      const id = repo.insertRetrievalTrace(
        makeEvent({
          candidates: [
            { ...makeEvent().candidates[0] },
            { ...makeEvent().candidates[0], queryIndex: 99, contentHash: 'orphan' },
          ],
        })
      )

      expect(id).toBeTypeOf('number')
      expect(countRows('retrieval_events')).toBe(1)
      expect(countRows('retrieval_queries')).toBe(1)
      // 越界那行被逐行丢弃，合法那行仍在
      expect(countRows('retrieval_candidates')).toBe(1)
      expect(
        (getDb().prepare('SELECT content_hash FROM retrieval_candidates').get() as any).content_hash
      ).toBe('h1')
    })
  })

  // ─── 验收 8：写失败不致命 ──────────────────────────
  describe('验收 8 · 写库失败绝不抛', () => {
    it('表被删（模拟 schema 漂移）→ 返回 undefined，不抛异常', () => {
      getDb().exec('DROP TABLE retrieval_candidates')
      expect(() => repo.insertRetrievalTrace(makeEvent())).not.toThrow()
      expect(repo.insertRetrievalTrace(makeEvent())).toBeUndefined()
    })
  })

  // ─── 验收 10：FK 与唯一约束 ────────────────────────
  describe('验收 10 · FK 与 UNIQUE 生效', () => {
    it('插入不存在的 retrieval_id 被 FK 拒', () => {
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO retrieval_queries (retrieval_id, query_index, query_text, query_embed_ok)
             VALUES (99999, 0, 'x', 1)`
          )
          .run()
      ).toThrow(/FOREIGN KEY/i)
    })

    it('同 (retrieval_id, query_index) 插两次被 UNIQUE 拒', () => {
      const id = repo.insertRetrievalTrace(makeEvent())!
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO retrieval_queries (retrieval_id, query_index, query_text, query_embed_ok)
             VALUES (?, 0, 'x', 1)`
          )
          .run(id)
      ).toThrow(/UNIQUE/i)
    })

    it('候选引用不存在的 query_id 被 FK 拒', () => {
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO retrieval_candidates
               (query_id, source, doc_path, section_anchor, content_hash, injected)
             VALUES (99999, 'final', 'd', 's', 'h', 1)`
          )
          .run()
      ).toThrow(/FOREIGN KEY/i)
    })

    it('删 event 级联删 queries 与 candidates（ON DELETE CASCADE）', () => {
      const id = repo.insertRetrievalTrace(makeEvent())!
      getDb().prepare('DELETE FROM retrieval_events WHERE id = ?').run(id)
      expect(countRows('retrieval_queries')).toBe(0)
      expect(countRows('retrieval_candidates')).toBe(0)
    })
  })

  // ─── 验收 11：参数快照 ─────────────────────────────
  describe('验收 11 · 参数快照随行冻结', () => {
    it('改阈值后新行随之改变，旧行不变', () => {
      const first = repo.insertRetrievalTrace(makeEvent({ thresholdMaxDistance: 0.6 }))!
      const second = repo.insertRetrievalTrace(makeEvent({ thresholdMaxDistance: 0.35 }))!

      const read = (id: number) =>
        (
          getDb()
            .prepare('SELECT threshold_max_distance FROM retrieval_events WHERE id = ?')
            .get(id) as { threshold_max_distance: number }
        ).threshold_max_distance

      expect(read(first)).toBe(0.6)
      expect(read(second)).toBe(0.35)
    })
  })

  // ─── 验收 4 的写口半边：NULL 哨兵不落库 ────────────
  describe('候选列：哨兵不落库（P2 §二①）', () => {
    it('channel=keyword 的 distance 存 NULL 而非 maxDistance', () => {
      repo.insertRetrievalTrace(
        makeEvent({
          candidates: [
            { ...makeEvent().candidates[0], channel: 'keyword', distance: null, rrfScore: null },
          ],
        })
      )
      const row = getDb().prepare('SELECT channel, distance FROM retrieval_candidates').get() as {
        channel: string
        distance: number | null
      }
      expect(row.channel).toBe('keyword')
      expect(row.distance).toBeNull()
    })
  })

  // ─── bool ↔ int 三态 ───────────────────────────────
  describe('布尔列三态落库', () => {
    it('passed_status_filter 的 false / true / null 各存 0 / 1 / NULL', () => {
      const base = makeEvent().candidates[0]
      repo.insertRetrievalTrace(
        makeEvent({
          candidates: [
            { ...base, contentHash: 'h-false', passedStatusFilter: false },
            { ...base, contentHash: 'h-true', passedStatusFilter: true },
            { ...base, contentHash: 'h-null', passedStatusFilter: null },
          ],
        })
      )
      const rows = getDb()
        .prepare('SELECT content_hash, passed_status_filter FROM retrieval_candidates ORDER BY id')
        .all() as Array<{ content_hash: string; passed_status_filter: number | null }>
      expect(rows).toEqual([
        { content_hash: 'h-false', passed_status_filter: 0 },
        { content_hash: 'h-true', passed_status_filter: 1 },
        { content_hash: 'h-null', passed_status_filter: null },
      ])
    })

    it('truncated 的 null 保持 NULL（不写成 0——「无数据」≠「没截断」）', () => {
      const id = repo.insertRetrievalTrace(makeEvent({ truncated: null }))!
      const v = (
        getDb().prepare('SELECT truncated FROM retrieval_events WHERE id = ?').get(id) as {
          truncated: number | null
        }
      ).truncated
      expect(v).toBeNull()
    })
  })

  // ─── 读侧 ──────────────────────────────────────────
  describe('读侧取数', () => {
    it('query 按 query_index 升序、candidate 跨查询合并返回', () => {
      const id = repo.insertRetrievalTrace(
        makeEvent({
          queries: [
            { queryIndex: 1, queryText: '改写', queryEmbedOk: true },
            { queryIndex: 0, queryText: '原话', queryEmbedOk: false },
          ],
          candidates: [
            { ...makeEvent().candidates[0], queryIndex: 0, contentHash: 'h-q0' },
            { ...makeEvent().candidates[0], queryIndex: 1, contentHash: 'h-q1' },
          ],
        })
      )!

      const queries = repo.getRetrievalQueries(id)
      expect(queries.map((q) => q.query_index)).toEqual([0, 1])
      expect(queries.map((q) => q.query_embed_ok)).toEqual([0, 1])

      const cands = repo.getRetrievalCandidates(id)
      expect(cands.map((c) => c.content_hash).sort()).toEqual(['h-q0', 'h-q1'])
    })
  })

  // ─── M1 读侧：按 message_id 批量取已注入节 ─────────
  // 判据面在**关联链**（execution_logs.message_id → retrieval_events.execution_id →
  // queries → candidates）与**按节去重**两处——两处写错都不会抛，只会静默多算/漏算，
  // 而 UI 上的「记忆 3 条」正是拿这个数跟用户对账的。
  describe('M1 · getInjectedRefsByMessageIds', () => {
    /** 造「触发消息 + 回复消息 + 一条 running 执行行」，返回执行行 id */
    function seedExecution(opts: {
      sessionId: string
      replyMessageId: string
      execId: string
    }): string {
      const db = getDb()
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, system_prompt, llm_api_key)
         VALUES ('agent-1', 'flash猫', 'p', 'k')`
      ).run()
      db.prepare(`INSERT OR IGNORE INTO sessions (id, title) VALUES (?, 't')`).run(opts.sessionId)
      for (const mid of [`trigger-${opts.execId}`, opts.replyMessageId]) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'agent', 'x', '[]')`
        ).run(mid, opts.sessionId)
      }
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, message_id)
         VALUES (?, ?, 'agent-1', ?, 'completed', 'trace-1', ?)`
      ).run(opts.execId, opts.sessionId, `trigger-${opts.execId}`, opts.replyMessageId)
      return opts.execId
    }

    /** 一次注入的候选行（默认 = 已注入的 final 行） */
    function cand(over: Record<string, unknown> = {}) {
      return { ...makeEvent().candidates[0], ...over }
    }

    it('按节去重：同节的 final 与 probe 行合成 1 条，代表行取 final（片正文来自 final 那片）', () => {
      const execId = seedExecution({
        sessionId: 'sess-1',
        replyMessageId: 'reply-1',
        execId: 'exec-m1-a',
      })
      repo.insertRetrievalTrace(
        makeEvent({
          executionId: execId,
          candidates: [
            cand({ source: 'final', bodyHead: 'final 那片正文' }),
            // 同节的 probe 行（同 doc/anchor，不同片）：写侧口径下 probe 的 injected 也可能为 true
            cand({
              source: 'probe',
              contentHash: 'h-probe',
              bodyHead: 'probe 那片正文',
              injected: true,
            }),
          ],
        })
      )

      const got = repo.getInjectedRefsByMessageIds(['reply-1'], 'sess-1')
      const entry = got.get('reply-1')!
      expect(entry.sections).toHaveLength(1)
      expect(entry.sections[0].bodyHead).toBe('final 那片正文')
      expect(entry.reason).toBe('ok')
    })

    it('只取 injected = 1：未注入的 final 行（budget 丢弃）不进结果', () => {
      const execId = seedExecution({
        sessionId: 'sess-1',
        replyMessageId: 'reply-2',
        execId: 'exec-m1-b',
      })
      repo.insertRetrievalTrace(
        makeEvent({
          executionId: execId,
          candidates: [
            cand({ contentHash: 'h-in', injected: true }),
            cand({
              contentHash: 'h-out',
              injected: false,
              sectionRank: null,
              injectedPosition: null,
              droppedReason: 'budget',
              sectionAnchor: '## 没进去的那节',
            }),
          ],
        })
      )

      const sections = repo
        .getInjectedRefsByMessageIds(['reply-2'], 'sess-1')
        .get('reply-2')!.sections
      expect(sections.map((s) => s.sectionAnchor)).toEqual(['## 决策'])
    })

    it('有 event 无注入 → 条目在（sections 空、reason 保留）；无 event 的消息 → 键不在', () => {
      const execId = seedExecution({
        sessionId: 'sess-1',
        replyMessageId: 'reply-3',
        execId: 'exec-m1-c',
      })
      repo.insertRetrievalTrace(
        makeEvent({ executionId: execId, reason: 'no-hit', candidates: [] })
      )
      // 同会话但压根没有执行行的消息：只建消息、不建 execution
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES ('reply-no-trace', 'sess-1', 'agent', 'x', '[]')`
        )
        .run()

      const got = repo.getInjectedRefsByMessageIds(['reply-3', 'reply-no-trace'], 'sess-1')
      expect(got.get('reply-3')).toEqual({ reason: 'no-hit', sections: [] })
      expect(got.has('reply-no-trace')).toBe(false)
    })

    it('批量不串台：两条回复各取各的节；跨会话的执行行不进（sessionId 双条件）', () => {
      const execA = seedExecution({
        sessionId: 'sess-1',
        replyMessageId: 'reply-a',
        execId: 'exec-m1-d',
      })
      const execB = seedExecution({
        sessionId: 'sess-2',
        replyMessageId: 'reply-b',
        execId: 'exec-m1-e',
      })
      repo.insertRetrievalTrace(
        makeEvent({
          executionId: execA,
          sessionId: 'sess-1',
          candidates: [cand({ sectionAnchor: '## A 的节' })],
        })
      )
      repo.insertRetrievalTrace(
        makeEvent({
          executionId: execB,
          sessionId: 'sess-2',
          candidates: [cand({ sectionAnchor: '## B 的节' })],
        })
      )

      const got = repo.getInjectedRefsByMessageIds(['reply-a', 'reply-b'], 'sess-1')
      expect(got.get('reply-a')!.sections.map((s) => s.sectionAnchor)).toEqual(['## A 的节'])
      // 跨会话：B 的执行行不因「消息 id 被请求了」而漏进来
      expect(got.get('reply-b')?.sections ?? []).toEqual([])
    })

    it('节序按注入位置（renderSections 首尾重排后的 1..n），不是按候选自增 id', () => {
      const execId = seedExecution({
        sessionId: 'sess-1',
        replyMessageId: 'reply-ord',
        execId: 'exec-m1-f',
      })
      repo.insertRetrievalTrace(
        makeEvent({
          executionId: execId,
          candidates: [
            // 先写入的是「渲染位置 2」（末位），后写入的是「渲染位置 1」
            cand({ contentHash: 'h-p2', sectionAnchor: '## 位置二', injectedPosition: 2 }),
            cand({ contentHash: 'h-p1', sectionAnchor: '## 位置一', injectedPosition: 1 }),
          ],
        })
      )
      const sections = repo
        .getInjectedRefsByMessageIds(['reply-ord'], 'sess-1')
        .get('reply-ord')!.sections
      expect(sections.map((s) => s.injectedPosition)).toEqual([1, 2])
    })
  })

  // ─── R1-b：param_pool_n（验收 7 / 8）─────────────────
  // 判据面在**写口**：值的正确性（== 当时的池常数）由 `execution/reply.test.ts`
  // 从消费侧取，这里只判「列在、存得住、老行是 NULL」。
  describe('R1-b · param_pool_n 查询级池快照', () => {
    it('验收 8 · additive 迁移：老行该列为 NULL，重跑迁移既有行一行不变', () => {
      const db = getDb()
      // 先落一行「R1-b 之前」形态的数据（该列不存在于契约 → NULL）
      const oldId = repo.insertRetrievalTrace(makeEvent({ paramPoolN: null }))!
      const rowBefore = db
        .prepare('SELECT param_pool_n FROM retrieval_events WHERE id = ?')
        .get(oldId) as { param_pool_n: number | null }
      expect(rowBefore.param_pool_n).toBeNull()

      const eventsBefore = countRows('retrieval_events')
      const candsBefore = countRows('retrieval_candidates')

      // 老库重跑迁移：`ALTER TABLE ... ADD COLUMN` 撞「列已存在」→ 被 `catch {}` 吞掉
      // （`db/index.ts` 迁移循环的既有幂等范式），**不得**重建表或清行
      initDb()

      expect(countRows('retrieval_events')).toBe(eventsBefore)
      expect(countRows('retrieval_candidates')).toBe(candsBefore)
      const rowAfter = db
        .prepare('SELECT param_pool_n FROM retrieval_events WHERE id = ?')
        .get(oldId) as { param_pool_n: number | null }
      expect(rowAfter.param_pool_n).toBeNull()
    })

    it('新行按传入值落库（含 0 与 NULL 的区分：不把「没有」写成 0）', () => {
      const a = repo.insertRetrievalTrace(makeEvent({ paramPoolN: 20 }))!
      const b = repo.insertRetrievalTrace(makeEvent({ paramPoolN: null, executionId: 'exec-2' }))!
      const read = (id: number) =>
        (
          getDb().prepare('SELECT param_pool_n FROM retrieval_events WHERE id = ?').get(id) as {
            param_pool_n: number | null
          }
        ).param_pool_n
      expect(read(a)).toBe(20)
      expect(read(b)).toBeNull()
    })
  })
})

/**
 * M1 记忆引用读侧路由测试。
 *
 * 测的是**出口契约**，不是仓储：仓储的按节去重/关联链判据在
 * `db/repository/retrievalEvents.test.ts`，本文件判「路由把它投影成了什么」——
 * 三态口径、越权拒绝、批量口形状、白名单守卫。
 *
 * 夹具走**真实迁移路径**（`createTestDb()` + `initDb()`），不手搓 DDL
 * ——手搓等于把被判面换成测试自己写的代理面。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository, retrievalEvents as retrievalRepo } from '../db/repository/index.js'
import { findRepoRootFrom } from '../repo-root.js'
import { memoryRoutes } from './memory.js'
import type { RetrievalEventInput } from '../db/repository/retrievalEvents.js'
import type { FastifyInstance } from 'fastify'

/** 造一条最小可用 event（与仓储测试同款；用例只覆盖关心的字段） */
function makeEvent(over: Partial<RetrievalEventInput> = {}): RetrievalEventInput {
  return {
    executionId: 'exec-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    createdAt: '2026-09-22T00:00:00.000Z',
    thresholdMaxDistance: 0.6,
    paramTopK: 3,
    paramProbeN: 20,
    paramPoolN: 20,
    reason: 'ok',
    retrievalMs: 12,
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

/**
 * 造「会话 + 触发/回复消息 + running 执行行」，返回执行行 id。
 *
 * `replyContent` 缺省 `'x'`——R14b 的角标用例靠它把带 `[n]` 的正文落进**回复**那条
 * （触发消息保持无号，免得判据面把两侧的号混起来）。
 */
function seedReply(
  sessionId: string,
  replyMessageId: string,
  executionId: string,
  replyContent = 'x'
): string {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, system_prompt, llm_api_key)
     VALUES ('agent-1', 'flash猫', 'p', 'k')`
  ).run()
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title) VALUES (?, 't')`).run(sessionId)
  for (const [mid, content] of [
    [`trigger-${executionId}`, 'x'],
    [replyMessageId, replyContent],
  ] as const) {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'agent', ?, '[]')`
    ).run(mid, sessionId, content)
  }
  db.prepare(
    `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, message_id)
     VALUES (?, ?, 'agent-1', ?, 'completed', 'trace-1', ?)`
  ).run(executionId, sessionId, `trigger-${executionId}`, replyMessageId)
  return executionId
}

/** 仓库根（与路由同锚：`scripts/flywheel/scan.mjs`） */
function repoRoot(): string {
  const root = findRepoRootFrom(process.cwd(), ['scripts', 'flywheel', 'scan.mjs'])
  if (!root) throw new Error('测试环境定位不到仓库根——夹具前提不成立')
  return root
}

describe('M1 记忆引用路由', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
    app = await buildTestApp()
    await app.register(memoryRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  // ─── GET /api/sessions/:id/memory-refs ────────────
  describe('GET /api/sessions/:id/memory-refs', () => {
    it('A1 · 与库对账：UI 条数 == 该 message 在 retrieval_candidates 里 injected=1 的不同节数', async () => {
      const execId = seedReply('sess-1', 'reply-1', 'exec-a1')
      retrievalRepo.insertRetrievalTrace(
        makeEvent({
          executionId: execId,
          candidates: [
            // 3 节进注入；另有 1 节被预算截断（injected=0）——不参与计数
            {
              ...makeEvent().candidates[0],
              contentHash: 'h1',
              sectionAnchor: '## A',
              injectedPosition: 1,
            },
            {
              ...makeEvent().candidates[0],
              contentHash: 'h2',
              sectionAnchor: '## B',
              injectedPosition: 2,
              sectionRank: 1,
            },
            {
              ...makeEvent().candidates[0],
              contentHash: 'h3',
              sectionAnchor: '## C',
              injectedPosition: 3,
              sectionRank: 2,
            },
            {
              ...makeEvent().candidates[0],
              contentHash: 'h4',
              sectionAnchor: '## D',
              injected: false,
              sectionRank: null,
              injectedPosition: null,
              droppedReason: 'budget',
            },
          ],
        })
      )

      // 直接 SQL 取真值（不用被测代码算）
      const truth = (
        getDb()
          .prepare(
            // 节身份键用 `char(0)` 拼——TS 模板串里的 `\0` 会被 JS 先展开成真 NUL 字节，
            // SQLite 解析器见到裸 NUL 直接报 unrecognized token
            `SELECT COUNT(DISTINCT c.doc_path || char(0) || c.section_anchor) AS n
             FROM retrieval_candidates c
             JOIN retrieval_queries q ON q.id = c.query_id
             JOIN retrieval_events e ON e.id = q.retrieval_id
             JOIN execution_logs el ON el.id = e.execution_id
             WHERE el.message_id = 'reply-1' AND c.injected = 1`
          )
          .get() as { n: number }
      ).n
      expect(truth).toBe(3)
      const injectedRows = (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM retrieval_candidates c
             JOIN retrieval_queries q ON q.id = c.query_id
             JOIN retrieval_events e ON e.id = q.retrieval_id
             JOIN execution_logs el ON el.id = e.execution_id
             WHERE el.message_id = 'reply-1' AND c.injected = 1`
          )
          .get() as { n: number }
      ).n
      expect(injectedRows).toBe(3)

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-1/memory-refs?messageIds=reply-1',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body['reply-1'].state).toBe('injected')
      expect(body['reply-1'].refs).toHaveLength(truth)
      expect(body['reply-1'].refs.map((r: { sectionAnchor: string }) => r.sectionAnchor)).toEqual([
        '## A',
        '## B',
        '## C',
      ])
    })

    it('A2 · 三态可分：injected / none（检索了没注入）/ not-retrieved（无流水行）/ not-retrieved（skipped-a2a）', async () => {
      const execA = seedReply('sess-1', 'reply-inj', 'exec-s1')
      const execB = seedReply('sess-1', 'reply-empty', 'exec-s2')
      const execC = seedReply('sess-1', 'reply-a2a', 'exec-s3')
      // 第四态：消息在、**压根没有执行/检索流水行**（最朴素的「未检索」）
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES ('reply-no-trace', 'sess-1', 'agent', 'x', '[]')`
        )
        .run()

      retrievalRepo.insertRetrievalTrace(makeEvent({ executionId: execA }))
      retrievalRepo.insertRetrievalTrace(
        makeEvent({ executionId: execB, reason: 'no-hit', candidates: [] })
      )
      retrievalRepo.insertRetrievalTrace(
        makeEvent({ executionId: execC, reason: 'skipped-a2a', candidates: [] })
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-1/memory-refs?messageIds=reply-inj,reply-empty,reply-a2a,reply-no-trace',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body['reply-inj']).toMatchObject({ state: 'injected', reason: 'ok' })
      expect(body['reply-inj'].refs).toHaveLength(1)
      // 「查了没用」与「压根没查」的**分母口径**，不许混
      expect(body['reply-empty']).toMatchObject({ state: 'none', reason: 'no-hit', refs: [] })
      expect(body['reply-a2a']).toMatchObject({
        state: 'not-retrieved',
        reason: 'skipped-a2a',
        refs: [],
      })
      expect(body['reply-no-trace']).toMatchObject({
        state: 'not-retrieved',
        reason: null,
        refs: [],
      })
    })

    // ─── R14b：角标两列（**读口派生、不落库**）──────────────────────
    //
    // 组装式：真 DB + 真路由，正文由 `seedReply` 的 `replyContent` 落进**回复**那条消息。
    // 判据面（`extractCitationMarkers`）本身的边界在 `memory/citationMarkers.test.ts`，
    // 本组判「路由把它投影成了什么」——合法号域取自**该消息实际注入的节数**。
    describe('角标两列（R14b）', () => {
      /** 造 N 节注入（位置 1..N）+ 指定回复正文，返回执行行 id */
      function seedInjected(
        replyId: string,
        execId: string,
        sections: number,
        replyContent: string
      ): string {
        const exec = seedReply('sess-1', replyId, execId, replyContent)
        const base = makeEvent().candidates[0]
        retrievalRepo.insertRetrievalTrace(
          makeEvent({
            executionId: exec,
            candidates: Array.from({ length: sections }, (_, i) => ({
              ...base,
              contentHash: `h${i + 1}`,
              sectionAnchor: `## S${i + 1}`,
              sectionRank: i,
              injectedPosition: i + 1,
            })),
          })
        )
        return exec
      }

      async function fetchRefs(ids: string[]): Promise<Record<string, any>> {
        const res = await app.inject({
          method: 'GET',
          url: `/api/sessions/sess-1/memory-refs?messageIds=${ids.join(',')}`,
        })
        expect(res.statusCode).toBe(200)
        return JSON.parse(res.body)
      }

      it('验收 5a · 回复含 [2]、注入 3 节 ⇒ markers=[2]，且号按 injectedPosition 对到那节', async () => {
        seedInjected('reply-mark', 'exec-m1', 3, '我采纳了 [2] 这条。')
        const body = await fetchRefs(['reply-mark'])
        expect(body['reply-mark'].state).toBe('injected')
        expect(body['reply-mark'].markers).toEqual([2])
        expect(body['reply-mark'].markersInCode).toEqual([])
        // 映射契约：`[2]` 指向的必须是 `injectedPosition === 2` 的那节（不是数组下标 2）
        const target = body['reply-mark'].refs.find(
          (r: { injectedPosition: number }) => r.injectedPosition === 2
        )
        expect(target.sectionAnchor).toBe('## S2')
      })

      it('验收 5b · 越界号（注入 3 节、回复含 [7]）⇒ markers=[]，不报错、不最近邻猜测', async () => {
        seedInjected('reply-oob', 'exec-m2', 3, '另见 [7]。')
        const body = await fetchRefs(['reply-oob'])
        expect(body['reply-oob'].state).toBe('injected')
        expect(body['reply-oob'].markers).toEqual([])
        // 节照旧全在——角标越界不影响注入面
        expect(body['reply-oob'].refs).toHaveLength(3)
      })

      it('验收 5c · 回复无号 ⇒ markers=[]', async () => {
        seedInjected('reply-none', 'exec-m3', 3, '这条回复一个号都没标。')
        const body = await fetchRefs(['reply-none'])
        expect(body['reply-none'].markers).toEqual([])
      })

      it('验收 5d · 代码字面量内的号进 markersInCode、不进 markers（成列可见，不静默剔除）', async () => {
        seedInjected('reply-code', 'exec-m4', 3, '见 [1]。举例如下：\n```js\nconst a = b[2]\n```\n')
        const body = await fetchRefs(['reply-code'])
        expect(body['reply-code'].markers).toEqual([1])
        expect(body['reply-code'].markersInCode).toEqual([2])
      })

      it('验收 5e · 非 injected 的两态：两列是**空数组**（不是 undefined、不是漏字段）', async () => {
        const execNone = seedReply('sess-1', 'reply-x-none', 'exec-m5')
        retrievalRepo.insertRetrievalTrace(
          makeEvent({ executionId: execNone, reason: 'no-hit', candidates: [] })
        )
        getDb()
          .prepare(
            `INSERT INTO messages (id, session_id, role, content, mentions)
             VALUES ('reply-x-notrace', 'sess-1', 'agent', '正文里就算写了 [1] 也不算数', '[]')`
          )
          .run()

        const body = await fetchRefs(['reply-x-none', 'reply-x-notrace'])
        expect(body['reply-x-none']).toMatchObject({
          state: 'none',
          markers: [],
          markersInCode: [],
        })
        // 无流水行 ⇒ 压根没有「注入了哪几节」这回事，正文里的号无号域可对 ⇒ 空
        expect(body['reply-x-notrace']).toMatchObject({
          state: 'not-retrieved',
          markers: [],
          markersInCode: [],
        })
      })
    })

    it('A5 · 越权：用 session A 的 id 请求 session B 的消息 id → 400（不是静默空）', async () => {
      seedReply('sess-A', 'reply-of-A', 'exec-v1')
      seedReply('sess-B', 'reply-of-B', 'exec-v2')

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-A/memory-refs?messageIds=reply-of-A,reply-of-B',
      })
      expect(res.statusCode).toBe(400)
      // 拒绝文案要点出越权的那个 id——静默空会让「越权」与「真没注入」同形
      expect(JSON.parse(res.body).error).toContain('reply-of-B')
      // 全部合法的另一半仍是 200（证明 400 来自越权而不是别的）
      const ok = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-A/memory-refs?messageIds=reply-of-A',
      })
      expect(ok.statusCode).toBe(200)
    })

    it('会话不存在 → 404；messageIds 缺失/全空 → 400；超上限 → 400', async () => {
      const notFound = await app.inject({
        method: 'GET',
        url: '/api/sessions/nope/memory-refs?messageIds=x',
      })
      expect(notFound.statusCode).toBe(404)

      seedReply('sess-1', 'reply-1', 'exec-l1')
      const missing = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-1/memory-refs',
      })
      expect(missing.statusCode).toBe(400)

      const blank = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-1/memory-refs?messageIds=,,',
      })
      expect(blank.statusCode).toBe(400)

      const tooMany = await app.inject({
        method: 'GET',
        url: `/api/sessions/sess-1/memory-refs?messageIds=${Array.from({ length: 201 }, (_, i) => `m${i}`).join(',')}`,
      })
      expect(tooMany.statusCode).toBe(400)
    })

    it('重复 id 去重（同一消息只算一次，不因重复键撑大响应）', async () => {
      const execId = seedReply('sess-1', 'reply-dup', 'exec-dup')
      retrievalRepo.insertRetrievalTrace(makeEvent({ executionId: execId }))
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/sess-1/memory-refs?messageIds=reply-dup,reply-dup,reply-dup',
      })
      expect(res.statusCode).toBe(200)
      expect(Object.keys(JSON.parse(res.body))).toEqual(['reply-dup'])
    })
  })

  // ─── GET /api/memory/doc ──────────────────────────
  describe('GET /api/memory/doc', () => {
    /** 白名单内一个**真实存在**的 md（按目录扫，不硬编码文件名——改名不该弄红用例） */
    function realDocRelPath(): string {
      const dir = join(repoRoot(), 'docs', 'adr')
      const name = readdirSync(dir).find((f) => f.endsWith('.md'))
      if (!name) throw new Error('docs/adr 下没有 .md——A3 反对照的夹具前提不成立')
      return `docs/adr/${name}`
    }

    it('A3 · 四种穿越/越界变体全拒，且**拒绝原因是白名单/穿越**（400，不是 404）', async () => {
      const cases: Array<[string, string]> = [
        ['相对穿越', '../../etc/passwd'],
        ['绝对路径', '/etc/passwd'],
        ['白名单外（docs/run/**）', 'docs/run/map.md'],
        ['归一后穿越', 'docs/adr/../../../x.md'],
      ]
      for (const [name, p] of cases) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memory/doc?path=${encodeURIComponent(p)}`,
        })
        // 400 而不是 404：404 会让「守卫生效」与「文件恰好不存在」在读数上同形
        expect(res.statusCode, `${name} 未被拒`).toBe(400)
        expect(JSON.parse(res.body).error, `${name} 的拒绝原因不是白名单/穿越`).toContain(
          'rejected'
        )
      }
    })

    it('A3 · 反对照：白名单内真实文件正常返回（证明上面四条红不是「一律拒绝」的假绿）', async () => {
      const rel = realDocRelPath()
      const res = await app.inject({
        method: 'GET',
        url: `/api/memory/doc?path=${encodeURIComponent(rel)}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.path).toBe(rel)
      expect(body.content.length).toBeGreaterThan(0)
      // 只读不缓存
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('白名单内的**不存在**文件才是 404（与 400 是两件事）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/doc?path=docs%2Fadr%2F__definitely-missing__.md',
      })
      expect(res.statusCode).toBe(404)
    })

    it('反斜杠变体被拒（Windows 上 `\\` 是合法分隔符——守卫不能交给平台决定）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memory/doc?path=${encodeURIComponent('docs\\adr\\x.md')}`,
      })
      expect(res.statusCode).toBe(400)
    })

    it('扩展名不在白名单（非 .md）被拒', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/doc?path=docs%2Fadr%2Fsecret.txt',
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

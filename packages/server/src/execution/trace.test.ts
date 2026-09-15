/**
 * `execution/trace.ts` 测试 — R2 段五采集器（**per-execution** 的那一半）。
 *
 * 覆盖票 §九 的 2 / 8 / 11 / 15 / 17 / 19 / 20 / 22 八条。落库面（两表四索引、
 * 事务原子性、UNIQUE）在 `db/repository/spans.test.ts`；引擎接线面（11 段落点、
 * 队列等待、token 等待、失败不抛）在 `serial.spans.test.ts`——本文件只测采集器
 * 自己的行为：它攒了什么、`start_at`/`duration`/`ttft` 怎么算、`finish` 落什么。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecTrace, insertDetachedSpan, SPAN_NAMES } from './trace.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository, spans as spansRepo } from '../db/repository/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_SRC = path.resolve(HERE, '..')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeTrace(over?: Partial<{ executionId: string; chainId: string | null }>) {
  return createExecTrace({
    executionId: over?.executionId ?? 'exec-1',
    chainId: over?.chainId === undefined ? 'chain-1' : over.chainId,
    sessionId: 'sess-1',
    agentId: 'agent-1',
  })
}

describe('execution/trace — R2 段五采集器', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 2：一次执行恰一个根，其余挂本执行的段 ─────────
  it('验收 2 · 恰一个 `parent_span_id IS NULL`，其余 parent 均指向本次执行内的 span', () => {
    const trace = makeTrace()
    trace.startSpan('context.assemble')
    const llm = trace.startSpan('llm.chat', {
      llm: { provider: 'deepseek', model: 'm', maxTokens: 100, stream: true },
    })
    llm.markFirstChunk()
    trace.endSpan(llm, 'ok')
    trace.recordSpan('dispatch.token_wait', { startMs: Date.now() })
    trace.finish({ success: true })

    const rows = getDb()
      .prepare('SELECT * FROM spans WHERE execution_id = ?')
      .all('exec-1') as Array<{ span_id: string; parent_span_id: string | null; name: string }>

    expect(rows.length).toBe(4)
    const roots = rows.filter((r) => r.parent_span_id === null)
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('invoke_agent')

    const inExecution = new Set(rows.map((r) => r.span_id))
    for (const r of rows.filter((x) => x.parent_span_id !== null)) {
      expect(r.parent_span_id).toBe(roots[0].span_id)
      expect(inExecution.has(r.parent_span_id!)).toBe(true)
    }
  })

  // ─── 验收 8：TTFT 在首 chunk 处记 ──────────────────────
  it('验收 8 · `ttft_ms` < `duration_ms`，且首 chunk 即记（整段结束才记会相等）', async () => {
    const trace = makeTrace()
    const llm = trace.startSpan('llm.chat', {
      llm: { provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 2048, stream: true },
    })
    await sleep(25) // 首 chunk 之前的「建流 + 首字节」等待
    llm.markFirstChunk()
    await sleep(40) // 首 chunk 之后的流式产出
    trace.endSpan(llm, 'ok')
    trace.finish({ success: true })

    const row = getDb().prepare('SELECT * FROM span_llm WHERE span_id = ?').get(llm.spanId) as any
    expect(row).toBeTruthy()
    expect(row.ttft_ms).toBeGreaterThanOrEqual(15)
    // 承重判据：若 TTFT 在 `endSpan` 才记，两者会**相等**（同为整段时长）
    expect(row.ttft_ms).toBeLessThan(
      (getDb().prepare('SELECT duration_ms FROM spans WHERE span_id = ?').get(llm.spanId) as any)
        .duration_ms
    )
    // 重复打点只认第一次（流循环每个 chunk 都会调，语义必须幂等）
    llm.markFirstChunk()
    expect(
      (getDb().prepare('SELECT ttft_ms FROM span_llm WHERE span_id = ?').get(llm.spanId) as any)
        .ttft_ms
    ).toBe(row.ttft_ms)
  })

  it('验收 8 · 未出现首 chunk（超时/空流）⇒ `ttft_ms` 为 NULL（不写 0 冒充）', () => {
    const trace = makeTrace()
    const llm = trace.startSpan('llm.chat', {
      llm: { provider: 'p', model: 'm', maxTokens: null, stream: true },
    })
    trace.endSpan(llm, 'timeout')
    trace.finish({ success: false })

    const row = getDb().prepare('SELECT * FROM span_llm WHERE span_id = ?').get(llm.spanId) as any
    expect(row.ttft_ms).toBeNull()
    expect(row.max_tokens).toBeNull()
  })

  // ─── 验收 11：operation_name 取值 ──────────────────────
  it('验收 11 · operation_name：检索/LLM 三段有标准键，两个 wait 段为 NULL', () => {
    const trace = makeTrace()
    trace.recordSpan('dispatch.queue_wait', { startMs: Date.now() })
    trace.recordSpan('dispatch.token_wait', { startMs: Date.now() })
    trace.recordSpan('memory.retrieval', { startMs: Date.now() })
    trace.recordSpan('knowledge.retrieval', { startMs: Date.now() })
    trace.startSpan('llm.chat', {
      llm: { provider: 'p', model: 'm', maxTokens: null, stream: true },
    })
    trace.finish({ success: true })

    const byName = new Map(
      (
        getDb().prepare('SELECT name, operation_name FROM spans').all() as Array<{
          name: string
          operation_name: string | null
        }>
      ).map((r) => [r.name, r.operation_name])
    )
    expect(byName.get('invoke_agent')).toBe('invoke_agent')
    expect(byName.get('memory.retrieval')).toBe('retrieval')
    expect(byName.get('knowledge.retrieval')).toBe('retrieval')
    expect(byName.get('llm.chat')).toBe('chat')
    expect(byName.get('dispatch.queue_wait')).toBeNull()
    expect(byName.get('dispatch.token_wait')).toBeNull()
  })

  // ─── 验收 15：start_at 毫秒精度 + ISO 形态 ─────────────
  it('验收 15 · `start_at` 是 `...THH:MM:SS.mmmZ`（毫秒可区分，非秒级对齐）', async () => {
    const trace = makeTrace()
    trace.recordSpan('context.assemble', { startMs: Date.now() })
    await sleep(6)
    trace.recordSpan('reply.persist', { startMs: Date.now() })
    trace.finish({ success: true })

    const rows = getDb().prepare('SELECT name, start_at FROM spans ORDER BY id').all() as Array<{
      name: string
      start_at: string
    }>
    for (const r of rows) {
      // 秒级形态（`YYYY-MM-DD HH:MM:SS`）在这里必红——没有 `T`、没有毫秒
      expect(r.start_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    const assemble = rows.find((r) => r.name === 'context.assemble')!
    const persist = rows.find((r) => r.name === 'reply.persist')!
    expect(assemble.start_at).not.toBe(persist.start_at)
  })

  // ─── 验收 19：per-execution 隔离（并发三个执行互不串台）──
  it('验收 19 · 并发三个执行体各持一个采集器，span 互不串台', async () => {
    const traces = ['exec-a', 'exec-b', 'exec-c'].map((id) => makeTrace({ executionId: id }))

    // 三个「执行体」交错打点（模拟并发批内 3 个 executeOneAgent 同时跑）
    await Promise.all(
      traces.map(async (t, i) => {
        t.recordSpan('context.assemble', { startMs: Date.now() })
        await sleep(2 + i)
        t.recordSpan('memory.retrieval', { startMs: Date.now() })
        await sleep(2)
        t.startSpan('llm.chat', {
          llm: { provider: 'p', model: `m-${i}`, maxTokens: null, stream: true },
        })
        t.finish({ success: true })
      })
    )

    for (const t of traces) {
      const rows = spansRepo.getSpansByExecution(t.executionId)
      expect(rows.length).toBe(4)
      const rootId = spansRepo.getRootSpanId(t.executionId)!
      expect(rootId).toBeTruthy()
      for (const r of rows) {
        expect(r.chain_id).toBe('chain-1')
        if (r.span_id !== rootId) expect(r.parent_span_id).toBe(rootId)
      }
      // model 只在自持的那条 span_llm 上（不串到别人的执行）
      const models = getDb()
        .prepare(
          `SELECT l.model FROM span_llm l JOIN spans s ON s.span_id = l.span_id
           WHERE s.execution_id = ?`
        )
        .all(t.executionId) as Array<{ model: string }>
      expect(models).toHaveLength(1)
    }
    // 三个执行各 4 行，共 12 行——没有互相覆盖
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as any).n).toBe(12)
  })

  // ─── finish 语义 ──────────────────────────────────────
  it('finish 幂等：重复调用只落一次（根段不会被二次结算）', () => {
    const trace = makeTrace()
    trace.finish({ success: true })
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as any).n
    trace.finish({ success: true })
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as any).n).toBe(before)
    expect(before).toBe(1)
  })

  it('根段状态随执行结局：失败执行 ⇒ 根段 status=error + error_message', () => {
    const trace = makeTrace()
    trace.startSpan('llm.chat', {
      llm: { provider: 'p', model: 'm', maxTokens: null, stream: true },
    })
    trace.finish({ success: false, errorMessage: '执行超时 (1800s)' })

    const root = getDb().prepare("SELECT * FROM spans WHERE name = 'invoke_agent'").get() as any
    expect(root.status).toBe('error')
    expect(root.error_message).toBe('执行超时 (1800s)')
    // error_type 复用 execution_logs 的分类口径（含「超时」关键词 → timeout 桶）
    expect(root.error_type).toBe('timeout')
  })

  it('`startMs` 可显式指定（重放式打点）：duration_ms 由起止算出，不为负', () => {
    const trace = makeTrace()
    const start = Date.now() - 500
    trace.recordSpan('dispatch.queue_wait', { startMs: start, endMs: Date.now() })
    trace.finish({ success: true })
    const row = getDb()
      .prepare("SELECT * FROM spans WHERE name = 'dispatch.queue_wait'")
      .get() as any
    expect(row.duration_ms).toBeGreaterThanOrEqual(400)
  })

  // ─── insertDetachedSpan（全票唯一一处跨执行段）──────────
  it('insertDetachedSpan · 挂到既有根段下；无根段时不写（不编父 id）', () => {
    const trace = makeTrace()
    trace.finish({ success: true })
    const rootId = spansRepo.getRootSpanId('exec-1')!

    const ok = insertDetachedSpan({
      executionId: 'exec-1',
      parentSpanId: rootId,
      chainId: 'chain-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      name: 'git.auto_commit',
      startMs: Date.now() - 10,
      durationMs: 10,
    })
    expect(ok).toBe(true)
    expect(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM spans WHERE name = 'git.auto_commit'")
          .get() as any
      ).n
    ).toBe(1)
    // 根段仍恰一个（补记的段有父，没造出第二个根）
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM spans WHERE parent_span_id IS NULL').get() as any)
        .n
    ).toBe(1)

    const bad = insertDetachedSpan({
      executionId: 'exec-1',
      parentSpanId: 'no-such-span',
      chainId: null,
      sessionId: null,
      agentId: null,
      name: 'git.auto_commit',
      startMs: Date.now(),
      durationMs: 1,
    })
    expect(bad).toBe(false) // FK 拒绝 ⇒ 吞掉返回 false，不抛
  })

  // ═══ 静态源断言（防回退，票 §八 / §九） ═══════════════════

  describe('静态源断言', () => {
    const readSrc = (rel: string) => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8')

    // ─── 验收 20：采集器未挂 EngineState ─────────────────
    it('验收 20 · `EngineState` 类型上无 span / 采集器字段', () => {
      const src = readSrc('execution/state.ts')
      const start = src.indexOf('export interface EngineState {')
      expect(start).toBeGreaterThan(0)
      // 取到接口结尾（下一个顶层 `}`）
      const body = src.slice(start, src.indexOf('\n}', start))
      // 成员名逐条对账：`traceId` 这类**既有的**参数名不算（那是当轮执行 id，
      // 与段采集器是两回事）——查的是「有没有多出一个 span/采集器成员」
      const members = [...body.matchAll(/^\s{2}(\w+)[(:<]/gm)].map((m) => m[1])
      expect(members.length).toBeGreaterThan(5)
      for (const m of members) expect(m).not.toMatch(/span|collector|exectrace/i)
      expect(body).not.toMatch(/ExecTrace|SpanHandle|span_id/)
      // 反证：真挂上去会长的样子（防止这条断言因为「body 切错了」而恒真）
      expect(body).toContain('registerAbort')
    })

    it('验收 20 · 采集器模块零模块级可变状态（每次 createExecTrace 各持一份）', () => {
      const src = readSrc('execution/trace.ts')
      // 模块级 `const X = []` / `= new Map()` / `= new Set()` 都是「跨执行共享」的形态；
      // 本模块只允许函数与类型在模块级
      const moduleLevelMutable = src.match(/^(?:export )?const \w+ = (\[\]|new Map|new Set)/gm)
      expect(moduleLevelMutable).toBeNull()
    })

    // ─── 验收 22：段名闭集无越界 ─────────────────────────
    it('验收 22 · 全部 `startSpan(...)` / `recordSpan(...)` 实参 ⊆ §五 闭集', () => {
      const files = ['execution/serial.ts', 'execution/reply.ts', 'execution/trace.ts']
      const used: string[] = []
      for (const f of files) {
        const src = readSrc(f)
        for (const m of src.matchAll(/(?:startSpan|recordSpan)\(\s*'([^']+)'/g)) used.push(m[1])
      }
      // 真打到点上才有意义（全零 = 断言恒真）
      expect(used.length).toBeGreaterThanOrEqual(11)
      for (const name of used) expect(SPAN_NAMES as readonly string[]).toContain(name)

      // `insertDetachedSpan` 是唯一不走上表的落点：全仓恰一处，且只有一个段名
      const serial = readSrc('execution/serial.ts')
      expect(serial.match(/insertDetachedSpan\(/g)).toHaveLength(1)
      expect(serial.match(/name: 'git\.auto_commit'/g)).toHaveLength(1)
    })

    it('验收 22 · 闭集本身 = 11 段（v1 那 11 个，不含延后的 tool/a2a）', () => {
      expect([...SPAN_NAMES]).toEqual([
        'invoke_agent',
        'dispatch.queue_wait',
        'dispatch.token_wait',
        'context.assemble',
        'context.compress',
        'memory.retrieval',
        'knowledge.retrieval',
        'llm.chat',
        'diff.collect',
        'reply.persist',
        'git.auto_commit',
      ])
      expect(SPAN_NAMES as readonly string[]).not.toContain('tool.execute')
      expect(SPAN_NAMES as readonly string[]).not.toContain('dispatch.a2a')
    })

    // ─── 验收 17：边界证明 ───────────────────────────────
    it('验收 17 · 全 packages/ 无 OTel SDK / 导出器痕迹', () => {
      // 正则由碎片拼出——**本断言文件自身不在扫描面内**（否则自匹配恒红）
      const forbidden = new RegExp(
        ['open' + 'telemetry', 'ot' + 'lp', 'export' + 'er'].join('|'),
        'i'
      )
      const hits: string[] = []
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            walk(full)
          } else if (/\.(ts|vue|js|mjs)$/.test(e.name)) {
            if (forbidden.test(fs.readFileSync(full, 'utf8')))
              hits.push(path.relative(SERVER_SRC, full))
          }
        }
      }
      walk(path.resolve(SERVER_SRC, '..'))
      expect(hits).toEqual([])
    })

    it('验收 17 · `shared/src/types.ts` 的 `ToolCallInfo` 未增时间字段', () => {
      const src = fs.readFileSync(
        path.resolve(SERVER_SRC, '..', '..', 'shared', 'src', 'types.ts'),
        'utf8'
      )
      const start = src.indexOf('export interface ToolCallInfo {')
      expect(start).toBeGreaterThan(0)
      const body = src.slice(start, src.indexOf('\n}', start))
      const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
      // 字段清单**逐字钉死**：任何新增字段（时间字段是 §八 明写要另开票的那类）
      // 都会让这条当场变红——这比在注释散文里搜关键词可靠（注释本来就在叙述时间）
      expect(fields).toEqual(['id', 'name', 'status', 'input', 'output', 'isError', 'truncated'])
      for (const f of fields) expect(f).not.toMatch(/time|duration|start|end|_at$|_ms$/i)
    })
  })
})

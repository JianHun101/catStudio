/**
 * `spans.ts` 写口测试 — R2 段五的**落库面**。
 *
 * 覆盖票 §九 的 1（两表四索引）/ 3（`span_id` UNIQUE）/ 4（写失败绝不抛）/
 * 5（一次执行一个事务，零残留）/ 16（无 `trace_id` 列，防 §六 纪律回退）。
 * 采集器行为在 `execution/trace.test.ts`；引擎接线在 `execution/serial.spans.test.ts`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { insertExecTrace, getSpansByExecution, getRootSpanId, type SpanInput } from './spans.js'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../index.js'
import { initRepository } from './index.js'

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf8'
)

function span(over: Partial<SpanInput> & { spanId: string; name: string }): SpanInput {
  return {
    parentSpanId: null,
    chainId: 'chain-1',
    executionId: 'exec-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    operationName: null,
    startAt: new Date().toISOString(),
    durationMs: 1,
    status: 'ok',
    errorType: null,
    errorMessage: null,
    itemCount: null,
    llm: null,
    ...over,
  }
}

const tableNames = () =>
  (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
const indexNames = () =>
  (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)

describe('db/repository/spans — R2 段五落库面', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 1：两表四索引 ────────────────────────────────
  it('验收 1 · 老库（有 schema、无 spans）重跑 initDb ⇒ 建出两表四索引', () => {
    // createTestDb() 造的就是「老库」：完整旧 schema，不含 R2 两表
    expect(tableNames()).toContain('spans')
    expect(tableNames()).toContain('span_llm')
    for (const idx of [
      'idx_spans_execution',
      'idx_spans_chain',
      'idx_spans_start',
      'idx_spans_name',
    ]) {
      expect(indexNames()).toContain(idx)
    }
  })

  it('验收 1 · 全新空库 ⇒ initDb 同样建出两表四索引（幂等重跑不炸）', () => {
    resetDb()
    const fresh = new Database(':memory:')
    fresh.pragma('foreign_keys = ON')
    setDb(fresh)
    initDb()
    initRepository(fresh)
    expect(tableNames()).toContain('spans')
    expect(tableNames()).toContain('span_llm')
    for (const idx of [
      'idx_spans_execution',
      'idx_spans_chain',
      'idx_spans_start',
      'idx_spans_name',
    ]) {
      expect(indexNames()).toContain(idx)
    }
    // 幂等：再跑一次不抛（迁移数组的 `try { exec } catch {}` 范式）
    expect(() => initDb()).not.toThrow()
  })

  it('验收 1 · `spans` 恰 15 列 / `span_llm` 恰 9 列（DDL 计数逐条点数，非印象）', () => {
    const cols = (t: string) =>
      (getDb().prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    expect(cols('spans')).toEqual([
      'id',
      'span_id',
      'parent_span_id',
      'chain_id',
      'execution_id',
      'session_id',
      'agent_id',
      'name',
      'operation_name',
      'start_at',
      'duration_ms',
      'status',
      'error_type',
      'error_message',
      'item_count',
    ])
    expect(cols('span_llm')).toEqual([
      'id',
      'span_id',
      'provider',
      'model',
      'input_tokens',
      'output_tokens',
      'ttft_ms',
      'stream',
      'max_tokens',
    ])
  })

  // ─── 验收 3：span_id 全局唯一 ──────────────────────────
  it('验收 3 · 重复 `span_id` 被 UNIQUE 拒绝（整笔回滚 + 不抛）', () => {
    expect(
      insertExecTrace([
        span({ spanId: 'dup-1', name: 'invoke_agent' }),
        span({ spanId: 'other', name: 'reply.persist', parentSpanId: 'dup-1' }),
      ])
    ).toBe(true)

    const ok = insertExecTrace([span({ spanId: 'dup-1', name: 'invoke_agent' })])
    expect(ok).toBe(false) // 吞掉，不抛
    expect(getSpansByExecution('exec-1')).toHaveLength(2) // 原样不动
  })

  // ─── 验收 4：写失败绝不抛 ──────────────────────────────
  it('验收 4 · `parent_span_id` FK 违规 ⇒ 吞掉返回 false，绝不抛', () => {
    let result: boolean | undefined
    expect(() => {
      result = insertExecTrace([span({ spanId: 'c1', name: 'llm.chat', parentSpanId: 'ghost' })])
    }).not.toThrow()
    expect(result).toBe(false)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as any).n).toBe(0)
  })

  it('验收 4 · 表不存在（写口整个不可用）⇒ 同样吞掉，不抛', () => {
    getDb().exec('DROP TABLE span_llm; DROP TABLE spans')
    expect(() => insertExecTrace([span({ spanId: 'x', name: 'invoke_agent' })])).not.toThrow()
    expect(insertExecTrace([span({ spanId: 'x', name: 'invoke_agent' })])).toBe(false)
  })

  // ─── 验收 5：一次执行一个事务（零残留）─────────────────
  it('验收 5 · 第二张表抛错 ⇒ `spans` / `span_llm` **零残留**（整笔回滚）', () => {
    // 让 span_llm 那一刻不可写：DROP 掉它。此时 spans 的 INSERT 已执行过
    // ——若没用事务，`spans` 会留下半截时间轴
    getDb().exec('DROP TABLE span_llm')
    const ok = insertExecTrace([
      span({ spanId: 'root', name: 'invoke_agent' }),
      span({
        spanId: 'llm-1',
        name: 'llm.chat',
        parentSpanId: 'root',
        llm: {
          provider: 'deepseek',
          model: 'm',
          inputTokens: 10,
          outputTokens: 5,
          ttftMs: 3,
          stream: true,
          maxTokens: 100,
        },
      }),
    ])
    expect(ok).toBe(false)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM spans').get() as any).n).toBe(0)
  })

  it('正常路径：根先子后的**拓扑序**自动成立（调用方顺序颠倒也不触发 FK）', () => {
    // 故意把子段放在前面——写口内部排序兜住
    const ok = insertExecTrace([
      span({ spanId: 'child', name: 'context.assemble', parentSpanId: 'root' }),
      span({ spanId: 'root', name: 'invoke_agent' }),
    ])
    expect(ok).toBe(true)
    expect(getRootSpanId('exec-1')).toBe('root')
  })

  // ─── 验收 16：无 trace_id 列（防 §六 纪律回退）──────────
  it('验收 16 · `spans` 表无 `trace_id` 列；DDL 里也没有（§六 命名纪律）', () => {
    const cols = (getDb().prepare('PRAGMA table_info(spans)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).not.toContain('trace_id')
    expect(cols).toContain('chain_id')

    const ddl = SRC.slice(SRC.indexOf('CREATE TABLE IF NOT EXISTS spans'))
    const tableDdl = ddl.slice(0, ddl.indexOf('`)'))
    expect(tableDdl).not.toContain('trace_id')
    expect(tableDdl).toContain('chain_id')
  })

  // ─── 验收 15 的落库侧：ISO 毫秒原样过手 ─────────────────
  it('`start_at` 原样落 ISO 毫秒（写口不做时间格式转换）', () => {
    insertExecTrace([
      span({ spanId: 'r', name: 'invoke_agent', startAt: '2026-09-14T13:20:00.000Z' }),
    ])
    expect(getSpansByExecution('exec-1')[0].start_at).toBe('2026-09-14T13:20:00.000Z')
  })

  // ─── §4.4 的一条 SQL 出全段时间轴（写口侧）──────────────
  it('§4.4 查询原样跑通：按 `execution_id` 取全段时间轴、按 `start_at` 升序', () => {
    insertExecTrace([
      span({ spanId: 'r', name: 'invoke_agent', startAt: '2026-09-14T13:20:00.000Z' }),
      span({
        spanId: 'b',
        name: 'llm.chat',
        parentSpanId: 'r',
        startAt: '2026-09-14T13:20:00.500Z',
      }),
      span({
        spanId: 'a',
        name: 'context.assemble',
        parentSpanId: 'r',
        startAt: '2026-09-14T13:20:00.100Z',
      }),
    ])
    const rows = getDb()
      .prepare(
        `SELECT s.name, s.start_at, s.duration_ms, s.status,
                (SELECT COUNT(*) FROM retrieval_events r WHERE r.execution_id = s.execution_id) AS has_detail
         FROM spans s WHERE s.execution_id = ? ORDER BY s.start_at`
      )
      .all('exec-1') as Array<{ name: string; start_at: string }>
    expect(rows.map((r) => r.name)).toEqual(['invoke_agent', 'context.assemble', 'llm.chat'])
  })
})

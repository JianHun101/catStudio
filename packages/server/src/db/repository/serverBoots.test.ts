/**
 * `server_boots` 仓储 + `query_db` 白名单测试（票 A · 启动账本）。
 *
 * 判据面：
 *
 * 1. **写入**：`boot_id` 为 UUID、`started_at` 是 ISO 毫秒 UTC；字段逐一落库。
 * 2. **追加不覆盖（V4）**：连写两行 ⇒ 总行数 +2，旧行仍在、主键不同。
 * 3. **query_db 真值 + 列白名单**：返回恰为 14 个白名单列，不多不少。
 * 4. **复合排序（V8）**：同 `started_at` 两行 ⇒ 后插入的（rowid 大）先返回。
 * 5. **反例（真空性）**：其余表不带 tie-break，查询照常不报错——证明 `tiebreak`
 *    是可选分支，没有把既有 5 张表拖进新路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository, serverBoots as serverBootsRepo, query as queryRepo } from './index.js'
import type { BootInfo } from '../../boot-info.js'

const bootInfo = (over: Partial<BootInfo> = {}): BootInfo => ({
  pid: 1234,
  port: 3200,
  cwd: 'D:/Game/ai/catStudy',
  module_file: 'D:/Game/ai/catStudy/packages/server/src/index.ts',
  mode: 'dev',
  probe_mode: 0,
  git_root: 'D:/Game/ai/catStudy',
  git_sha: 'a'.repeat(40),
  git_dirty: 0,
  dirty_summary: null,
  db_file: 'cat-study-dev.db',
  node_version: 'v24.14.0',
  ...over,
})

describe('db/repository/serverBoots', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('插入一行：boot_id 是 UUID、started_at 是 ISO 毫秒 UTC、字段逐一落库', () => {
    const bootId = serverBootsRepo.insertServerBoot(
      bootInfo({ probe_mode: 1, git_dirty: 1, dirty_summary: '?? a.txt' })
    )
    expect(bootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    const rows = serverBootsRepo.listServerBoots(10)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.boot_id).toBe(bootId)
    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row.pid).toBe(1234)
    expect(row.port).toBe(3200)
    expect(row.mode).toBe('dev')
    expect(row.probe_mode).toBe(1)
    expect(row.git_dirty).toBe(1)
    expect(row.dirty_summary).toBe('?? a.txt')
    expect(row.db_file).toBe('cat-study-dev.db')
    expect(serverBootsRepo.countServerBoots()).toBe(1)
  })

  it('追加不覆盖（V4）：连写两行 ⇒ 旧行仍在、返回总数 2', () => {
    const first = serverBootsRepo.insertServerBoot(bootInfo())
    const second = serverBootsRepo.insertServerBoot(bootInfo())
    expect(first).not.toBe(second)
    expect(serverBootsRepo.countServerBoots()).toBe(2)
    const ids = serverBootsRepo.listServerBoots(10).map((r) => r.boot_id)
    expect(ids.sort()).toEqual([first, second].sort())
  })

  it('query_db：server_boots 返回恰为 14 个白名单列，值可读', () => {
    const bootId = serverBootsRepo.insertServerBoot(bootInfo())
    const result = queryRepo.queryTable({ table: 'server_boots', limit: 10 })
    expect(result.total).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(Object.keys(result.rows[0]).sort()).toEqual(
      (queryRepo.QUERY_TABLE_SCHEMAS.server_boots.columns as readonly string[]).slice().sort()
    )
    expect(result.rows[0].boot_id).toBe(bootId)
    expect(result.rows[0].git_sha).toBe('a'.repeat(40))
  })

  it('复合排序（V8）：同 started_at 两行 ⇒ 后插入的先返回（rowid DESC tie-break）', () => {
    const first = serverBootsRepo.insertServerBoot(bootInfo())
    const second = serverBootsRepo.insertServerBoot(bootInfo())
    // 把两行的时间钉成同一值——模拟同毫秒连启（正常路径里 nowIso 可能撞同一毫秒）
    const same = '2026-11-04T00:00:00.000Z'
    getDb().prepare('UPDATE server_boots SET started_at = ?').run(same)

    expect(serverBootsRepo.listServerBoots(10).map((r) => r.boot_id)).toEqual([second, first])
    expect(
      queryRepo.queryTable({ table: 'server_boots', limit: 10 }).rows.map((r) => r.boot_id)
    ).toEqual([second, first])
  })

  it('反例：其余表不带 tie-break，queryTable 照常工作（可选分支不拖累既有表）', () => {
    expect(queryRepo.queryTable({ table: 'sessions', limit: 5 })).toEqual({ rows: [], total: 0 })
    expect(queryRepo.queryTable({ table: 'messages', limit: 5 })).toEqual({ rows: [], total: 0 })
  })
})

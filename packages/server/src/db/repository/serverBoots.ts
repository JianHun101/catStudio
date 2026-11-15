/**
 * `server_boots` 启动账本读写（票 A）。
 *
 * 一张**只追加**的表：每次 server 启动插一行，永不更新/删除。消费者只有
 * `query_db(table='server_boots')`（店长对账「这个进程跑的是哪一版代码」），故本层
 * 只提供写入与倒序读取，不做业务聚合。
 *
 * 排序契约：`started_at DESC, rowid DESC`——同一毫秒内两次启动靠 `rowid` 定序
 * （`started_at` 是 ISO 毫秒，快速连启会撞同一值）。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { nowIso } from './time.js'
import type { BootInfo } from '../../boot-info.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 一行账本 = 采集面字段 + 写入层生成的主键与时间 */
export interface ServerBootRow extends BootInfo {
  boot_id: string
  started_at: string
}

/** 写入层产出的身份双值——`started_at` 与落库行逐字相同（票 B 契约 A） */
export interface InsertServerBootResult {
  bootId: string
  startedAt: string
}

/**
 * 落一行启动账本，返回本次 `bootId` 与 `startedAt`。
 *
 * `boot_id` 在写入层用 `randomUUID()` 生成（采集层不关心主键）；`started_at` 走
 * 全库统一的时间生成点 `nowIso()`（ISO 毫秒 UTC）。
 *
 * **时间只取一次**：`started_at` 先落到局部变量，同一值既进 INSERT 又进返回值。
 * 若让调用方再取一次 `nowIso()`，两个值会在毫秒级分叉，`server_boots` 与注入行
 * 就不再是同一份读数（票 B 契约 A 的逐字相等判据）。
 */
export function insertServerBoot(info: BootInfo): InsertServerBootResult {
  const bootId = randomUUID()
  const startedAt = nowIso()
  db.prepare(
    `INSERT INTO server_boots
       (boot_id, started_at, pid, port, cwd, module_file, mode, probe_mode,
        git_root, git_sha, git_dirty, dirty_summary, db_file, node_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bootId,
    startedAt,
    info.pid,
    info.port,
    info.cwd,
    info.module_file,
    info.mode,
    info.probe_mode,
    info.git_root,
    info.git_sha,
    info.git_dirty,
    info.dirty_summary,
    info.db_file,
    info.node_version
  )
  return { bootId, startedAt }
}

/** 最近 N 次启动（倒序；对账取首行 = 当前进程） */
export function listServerBoots(limit = 50): ServerBootRow[] {
  return db
    .prepare(
      `SELECT * FROM server_boots
       ORDER BY started_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(limit) as ServerBootRow[]
}

/** 账本总行数（V4「追加不覆盖」判据用） */
export function countServerBoots(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM server_boots').get() as { n: number }
  return row.n
}

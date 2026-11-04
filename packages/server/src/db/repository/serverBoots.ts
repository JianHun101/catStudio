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

/**
 * 落一行启动账本，返回本次 `boot_id`。
 *
 * `boot_id` 在写入层用 `randomUUID()` 生成（采集层不关心主键）；`started_at` 走
 * 全库统一的时间生成点 `nowIso()`（ISO 毫秒 UTC）。
 */
export function insertServerBoot(info: BootInfo): string {
  const bootId = randomUUID()
  db.prepare(
    `INSERT INTO server_boots
       (boot_id, started_at, pid, port, cwd, module_file, mode, probe_mode,
        git_root, git_sha, git_dirty, dirty_summary, db_file, node_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bootId,
    nowIso(),
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
  return bootId
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

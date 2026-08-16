/**
 * settings 表访问器——运行期全局设置的 key/value 直存。
 *
 * 语义：铁律等全局运营规则的挂载点（getIronLaws 读此表、常量兜底）；
 * 通用性——任何全局设置都能塞这张表（key 字符串直存），不再动 seed 或主链路。
 * upsert：setSetting 用 ON CONFLICT 覆盖（幂等，重复写同 key 只更新值）。
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value)
}

/**
 * retire-message-memory 测试 —— 假库注入，**不碰真实库**。
 *
 * 被测面：目标表硬编码 / 逐表前后行数 / 幂等 / 不 DROP / 只清目标表 /
 * 库缺失不新建 / 目标表缺失判失败。
 * 不测：真库存量清零（票壬 V3，一次性动作，留执行记录不写成常驻测试）。
 *
 * 临时库一律落 `os.tmpdir()`——**不得落仓库根**（仓根临时产物会被 auto-commit 扫走）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TARGET_TABLES, retireMessageMemory, formatRecord } from './retire-message-memory.mjs'

let dir
let seq = 0

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'retire-mem-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个带 memories / memories_fts / messages 的假库；行数可控 */
function makeDb({ memories = 3, fts = 2, messages = 5 } = {}) {
  const file = path.join(dir, `fixture-${seq++}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT, embedding BLOB);
    CREATE VIRTUAL TABLE memories_fts USING fts5(content);
    CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT);
  `)
  for (let i = 0; i < memories; i++) {
    db.prepare('INSERT INTO memories (id, content) VALUES (?, ?)').run(`m${i}`, `记忆 ${i}`)
  }
  for (let i = 0; i < fts; i++) {
    db.prepare('INSERT INTO memories_fts (content) VALUES (?)').run(`词 ${i}`)
  }
  for (let i = 0; i < messages; i++) {
    db.prepare('INSERT INTO messages (id, content) VALUES (?, ?)').run(`msg${i}`, `消息 ${i}`)
  }
  db.close()
  return file
}

const countOf = (file, table) => {
  const db = new DatabaseSync(file, { readOnly: true })
  const c = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c)
  db.close()
  return c
}

const tableNames = (file) => {
  const db = new DatabaseSync(file, { readOnly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name)
  db.close()
  return names
}

describe('retire-message-memory', () => {
  describe('目标表清单', () => {
    it('硬编码两张真实表，且**不含**本仓不存在的 memories_vec（V7/V8 翻车点）', () => {
      expect(TARGET_TABLES).toEqual(['memories', 'memories_fts'])
      expect(TARGET_TABLES).not.toContain('memories_vec')
    })

    it('接受表名的参数位不存在——签名只吃库路径（V7：不接受参数化表名）', () => {
      // 函数 length 之外的路径不开放：传第二个参数也不改变目标表
      const file = makeDb()
      const rec = retireMessageMemory(file, ['messages'])
      expect(rec.tables.map((t) => t.table)).toEqual(['memories', 'memories_fts'])
      expect(countOf(file, 'messages')).toBe(5) // 参数未被采纳 ⇒ messages 未被动
    })
  })

  describe('清理', () => {
    it('逐表清空并记录前后行数（V7）', () => {
      const file = makeDb({ memories: 3, fts: 2 })
      const rec = retireMessageMemory(file)

      expect(rec.ok).toBe(true)
      expect(rec.error).toBeNull()
      expect(rec.tables).toEqual([
        { table: 'memories', before: 3, after: 0, deleted: 3 },
        { table: 'memories_fts', before: 2, after: 0, deleted: 2 },
      ])
      expect(countOf(file, 'memories')).toBe(0)
      expect(countOf(file, 'memories_fts')).toBe(0)
    })

    it('只清目标表：其它表行数一行不动（V7 反例面）', () => {
      const file = makeDb({ messages: 5 })
      retireMessageMemory(file)
      expect(countOf(file, 'messages')).toBe(5)
    })

    it('表结构保留，且清理后仍可写（V6：未 DROP）', () => {
      const file = makeDb()
      const rec = retireMessageMemory(file)

      expect(rec.tablesStillPresent).toBe(true)
      expect(tableNames(file)).toEqual(expect.arrayContaining(['memories', 'memories_fts']))

      const db = new DatabaseSync(file)
      db.prepare('INSERT INTO memories (id, content) VALUES (?, ?)').run('after', '清理后写入')
      db.close()
      expect(countOf(file, 'memories')).toBe(1)
    })

    it('零 no such table（V8）——目标表齐备时报告里不出现该字样', () => {
      const file = makeDb()
      const rec = retireMessageMemory(file)
      const text = formatRecord('fixture', rec).join('\n')
      expect(text).not.toContain('no such table')
      expect(rec.error).toBeNull()
    })
  })

  describe('幂等（V4）', () => {
    it('连跑两次：第二次零报错、零变更', () => {
      const file = makeDb({ memories: 4, fts: 1 })

      const first = retireMessageMemory(file)
      const second = retireMessageMemory(file)

      expect(first.tables.map((t) => t.deleted)).toEqual([4, 1])
      expect(second.ok).toBe(true)
      expect(second.error).toBeNull()
      expect(second.tables.map((t) => t.deleted)).toEqual([0, 0])
      expect(second.tablesStillPresent).toBe(true)
    })
  })

  describe('目标库异常面', () => {
    it('库文件不存在 ⇒ 报 db-file-missing，且**不新建**空库文件', () => {
      const file = path.join(dir, 'never-created.db')
      const rec = retireMessageMemory(file)

      expect(rec.ok).toBe(false)
      expect(rec.error).toBe('db-file-missing')
      expect(existsSync(file)).toBe(false)
      expect(formatRecord('missing', rec).join('\n')).toContain('不新建空库')
    })

    it('库在但目标表缺失 ⇒ 判失败并点名缺哪张（不静默跳过）', () => {
      const file = path.join(dir, 'no-fts.db')
      const db = new DatabaseSync(file)
      db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT)')
      db.close()

      const rec = retireMessageMemory(file)
      expect(rec.ok).toBe(false)
      expect(rec.error).toBe('table-missing: memories_fts')
      expect(formatRecord('no-fts', rec).join('\n')).toContain('table-missing: memories_fts')
    })
  })
})

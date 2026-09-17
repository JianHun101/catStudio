import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS, SCHEMA_MIGRATIONS_DDL, type Migration } from './migrations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// DB 分离（ADR 决策 9，脚本即配置）：NODE_ENV=production（pnpm start，日常真实
// 使用，记忆延续）→ 主库 cat-study.db；其他（pnpm dev 实验场，空库自举自动
// seed 同款猫）→ cat-study-dev.db。NODE_ENV 由 dev.js 的 --mode 设定（Windows
// 无内联 env 语法，零新依赖）；vitest 走 setDb 注入 :memory: 不受影响。
const DB_FILE_NAME = process.env.NODE_ENV === 'production' ? 'cat-study.db' : 'cat-study-dev.db'
const DB_PATH = path.join(__dirname, '..', '..', 'data', DB_FILE_NAME)

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    const dataDir = path.dirname(DB_PATH)
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

/** 仅在测试中使用：注入外部 DB 实例（如 :memory:） */
export function setDb(testDb: Database.Database): void {
  db = testDb
}

/** 仅在测试中使用：关闭并重置 DB 单例 */
export function resetDb(): void {
  if (db) {
    db.close()
    db = undefined as unknown as Database.Database
  }
}

/** 条目的正文指纹 = `sql` 原文 sha256（**不做空白归一化**）——落地后格式化也算篡改 */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

function userTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/**
 * 迁移 runner —— 启动链上唯一改结构的路径。
 *
 * 三条判据，缺一条这套机制就不成立：
 *
 * 1. **checksum 校验先行**：已登记条目的 `sql` 原文指纹对不上 ⇒ **拒启**，并明示
 *    fix-forward 路径。台账管的是「历史已发生」，历史不许被改写——否则「跑过的库」
 *    与「新库」会悄悄长成两个形状。
 * 2. **老库 = 有用户表且无台账**（②-b）：旧机制每次启动全量重跑迁移数组，效果早已
 *    发生（缺了会以故障形式暴露）⇒ 基线**逐条只登记不执行**，`note='baseline'`。
 *    例外只有带 `verify` 探针的条目：探针报「效果缺失」⇒ 该条破例真执行（矫正路径）。
 * 3. **差集逐条事务**（②-c）：未登记的条目按数组序，每条一个 `BEGIN IMMEDIATE` 事务，
 *    失败 `ROLLBACK` + 拒启，错误带迁移名 + SQLite 原错。零吞咽、零「预期错误」白名单
 *    ——「跳过」已由台账接管，「老库」已由 baseline 接管，catch 再无合法存在理由。
 *
 * `list` 只在测试里传（注入失败/篡改条目验拒启），生产恒为 `MIGRATIONS`。
 */
export function applyMigrations(
  db: Database.Database,
  list: ReadonlyArray<Migration> = MIGRATIONS
): void {
  const isOldDb = !tableExists(db, 'schema_migrations') && userTableNames(db).length > 0

  db.exec(SCHEMA_MIGRATIONS_DDL)
  const applied = new Map<string, string>()
  for (const row of db.prepare(`SELECT name, checksum FROM schema_migrations`).all() as Array<{
    name: string
    checksum: string
  }>) {
    applied.set(row.name, row.checksum)
  }

  for (const m of list) {
    const recorded = applied.get(m.name)
    if (recorded === undefined) continue
    if (recorded !== checksumOf(m.sql)) {
      throw new Error(
        `[db] 迁移「${m.name}」落地后被修改（台账 checksum ${recorded.slice(0, 12)}… ≠ 当前 ${checksumOf(m.sql).slice(0, 12)}…）。` +
          `已落地的迁移一个字节都不许改——要改结构，请在 packages/server/src/db/migrations.ts 的数组末尾**追加**一条新迁移（fix-forward），不要改这一条。`
      )
    }
  }

  const record = db.prepare(
    `INSERT INTO schema_migrations (name, checksum, applied_at, note) VALUES (?, ?, ?, ?)`
  )
  const note = isOldDb ? 'baseline' : null
  let registered = 0
  let repaired = 0

  for (const m of list) {
    if (applied.has(m.name)) continue

    // 探针：true = 效果已成立（或目标对象不存在、无事可做）⇒ 跳过执行只登记。
    // 全新库靠它避开「先建好再白重建一次」；老库靠它走矫正路径。
    const probeSaysDone = m.verify !== undefined && m.verify(db)
    // 老库的默认动作是**只登记**（②-b）：无探针的条目一律不执行；带探针的条目
    // 只有探针报「效果缺失」才破例真执行。全新库则相反——一律执行，除非探针说已成立。
    const execute = !probeSaysDone && (!isOldDb || m.verify !== undefined)
    if (!execute) {
      record.run(m.name, checksumOf(m.sql), new Date().toISOString(), note)
      if (isOldDb) registered++
      continue
    }

    const run = db.transaction(() => {
      db.exec(m.sql)
      record.run(m.name, checksumOf(m.sql), new Date().toISOString(), note)
    })
    try {
      run.immediate()
    } catch (err) {
      throw new Error(
        `[db] 迁移「${m.name}」执行失败，拒绝启动：${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (isOldDb) {
      repaired++
      console.log(`[db] baseline 矫正：${m.name}（探针报效果缺失，已真执行）`)
    } else {
      console.log(`[db] migrated: ${m.name}`)
    }
  }

  if (isOldDb) {
    console.log(
      `[db] 老库补登：${registered} 条基线迁移只登记未执行，${repaired} 条经探针矫正真执行`
    )
  }
}

export function initDb(): void {
  const db = getDb()

  // 加载 sqlite-vec 向量扩展（vec_distance_cosine 等函数，chunk_vectors 虚拟表依赖）
  sqliteVec.load(db)

  applyMigrations(db)

  console.log('[db] SQLite initialized at', DB_PATH)
}

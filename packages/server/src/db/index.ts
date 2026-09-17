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
 *    发生（缺了会以故障形式暴露）⇒ **基线集**（`baseline === true` 的条目）逐条只登记
 *    不执行，`note='baseline'`。例外只有带 `verify` 探针的条目：探针报「效果缺失」⇒
 *    该条破例真执行（矫正路径）。
 *    **只登记不执行只认基线条目**：追加区的条目（`baseline !== true`）今天才第一次上船，
 *    在任何老库上都从未发生过，「没台账」不构成跳过它们的理由 ⇒ 一律走增量路径
 *    （②-a「新旧库同一条增量路径」）。把这条判据放宽到整个数组 = 跳版本升级时静默缺表
 *    却记成「历史已发生」，正是本票要消灭的那类失败。
 * 3. **差集逐条事务**（②-c）：未登记的条目按数组序，每条一个 `BEGIN IMMEDIATE` 事务，
 *    失败 `ROLLBACK` + 拒启，错误带迁移名 + SQLite 原错。零吞咽、零「预期错误」白名单
 *    ——「跳过」已由台账接管，「老库」已由 baseline 接管，catch 再无合法存在理由。
 *
 * 第 2 与第 3 条各有一个**过程式**例外（spec §4.4 纪律 7，条目带 `run` 时）：
 *
 * - **事务归属反转**：runner 不包事务，由 hook 自己开（重建类必须如此——`rebuildTable`
 *   自带事务，且 `PRAGMA foreign_keys` 事务内 no-op）。拒启语义不变，错误照样带迁移名。
 * - **探针跳过**：`verify` 对 `run` 条目无意义（执行完结构必然已是新形状），不调用。
 *
 * `note` 语义不变：`run` 条目只出现在追加区，永远不是 `baseline`，故老库上同样**真执行**
 * ——它们从未在任何老库上发生过。
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
  let registered = 0
  let repaired = 0
  // OQ4：追加区条目**真执行**的条数。基线补登那行只讲基线（老库上「0 条经探针矫正真执行」
  // 读起来像「这次启动什么都没修」），而追加区恰恰是每次上船必须真跑的那部分——单列一行摊开。
  let appended = 0

  for (const m of list) {
    if (applied.has(m.name)) continue

    const isBaselineEntry = m.baseline === true
    // 探针：true = 效果已成立（或目标对象不存在、无事可做）⇒ 跳过执行只登记。
    // 全新库靠它避开「先建好再白重建一次」；老库靠它走矫正路径。
    // 过程式条目（`run`）**跳过探针**：探针问的是「效果是否已成立」，而 run 执行完结构必然
    // 已是新形状，探针没有可做的事（spec §4.4 纪律 7）。
    const probeSaysDone = m.run === undefined && m.verify !== undefined && m.verify(db)
    // 两条路径的**唯一**岔路（②-a vs ②-b），判据面只认基线条目：
    // - 老库 + 基线条目：默认**只登记**——历史已在此库发生（②-b）。带探针的条目探针报
    //   「效果缺失」才破例真执行（矫正）；无探针的条目一律不执行。
    // - 其余（全新库的全部条目 + 老库的追加区条目）：走增量路径——一律执行，除非探针
    //   说效果已成立（②-a）。追加区条目对老库同样**真执行**：它们从未在老库上发生过，
    //   「没台账」不构成跳过它们的理由。
    const baselineRepair = isBaselineEntry && m.verify !== undefined && !probeSaysDone
    const registerOnly = isOldDb && isBaselineEntry && !baselineRepair
    const execute = !registerOnly && !probeSaysDone
    // note 只标**补登来源**（该行是老库过户产物），故同样只认基线条目
    const note = isOldDb && isBaselineEntry ? 'baseline' : null

    if (!execute) {
      record.run(m.name, checksumOf(m.sql), new Date().toISOString(), note)
      if (isOldDb && isBaselineEntry) registered++
      continue
    }

    try {
      if (m.run !== undefined) {
        // **过程式通道**（spec §4.4 纪律 7）：不包事务——`rebuildTable` 自带事务，且
        // `PRAGMA foreign_keys` 事务内是 no-op（关不掉 FK ⇒ DROP 旧表会静默 CASCADE 清空
        // 子表，实测 9723 行）。事务归属交给 hook，`record` 由它在自己那侧调用。
        m.run(db, () => record.run(m.name, checksumOf(m.sql), new Date().toISOString(), note))
        // 漏登记 = 这条迁移**每次启动都重跑**（静默劣化）⇒ 按硬错误处理，拒启。
        const recorded2 = db.prepare(`SELECT 1 FROM schema_migrations WHERE name = ?`).get(m.name)
        if (recorded2 === undefined) {
          throw new Error(
            `过程式迁移未登记台账——hook 收尾必须调用 record()（漏调会让它每次启动都重跑）`
          )
        }
      } else {
        const run = db.transaction(() => {
          db.exec(m.sql)
          record.run(m.name, checksumOf(m.sql), new Date().toISOString(), note)
        })
        run.immediate()
      }
    } catch (err) {
      throw new Error(
        `[db] 迁移「${m.name}」执行失败，拒绝启动：${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (isOldDb && isBaselineEntry) {
      repaired++
      console.log(`[db] baseline 矫正：${m.name}（探针报效果缺失，已真执行）`)
    } else {
      if (!isBaselineEntry) appended++
      console.log(`[db] migrated: ${m.name}`)
    }
  }

  if (isOldDb) {
    console.log(
      `[db] 老库补登：${registered} 条基线迁移只登记未执行，${repaired} 条经探针矫正真执行`
    )
  }
  // OQ4：**每次启动都播报**，两种情形措辞都与实际一致——`0 条` = 本次启动确实没跑追加迁移
  // （库已是最新）；`N 条` = 真跑了 N 条。计数含 `CREATE … IF NOT EXISTS` 的 no-op 条目：
  // 它们**确实执行过**，只是没改结构，与「没执行」是两回事。
  console.log(`[db] 追加区迁移真执行：${appended} 条`)
}

export function initDb(): void {
  const db = getDb()

  // 加载 sqlite-vec 向量扩展（vec_distance_cosine 等函数，chunk_vectors 虚拟表依赖）
  sqliteVec.load(db)

  applyMigrations(db)

  console.log('[db] SQLite initialized at', DB_PATH)
}

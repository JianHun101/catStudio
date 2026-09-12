/**
 * 旧写口退役 · 存量清理（票壬 · S5「退 + 删」）——**一次性、幂等**。
 *
 * 做什么：把两张**硬编码**目标表的存量清空（`DELETE`，**不 DROP**）。
 *
 * 为什么是这两张:
 *   - `memories`     —— 记忆正文 + `embedding` BLOB（向量不是独立表，见下）
 *   - `memories_fts` —— FTS5 混合检索的关键词通道
 *   ⚠️ `memories_vec` **在本仓不存在**：`grep -rn 'memories_vec' packages/ scripts/`
 *   零命中，向量就是 `memories.embedding` 这一列（`db/index.ts`）。把它写进
 *   目标表 ⇒ 当场 `no such table` —— **这是本脚本唯一的「照文档抄就翻车」点**。
 *
 * 为什么不 DROP:
 *   读侧 `searchMemoriesHybridPath` 此刻仍在调用这两张表，现在 drop ⇒ 读侧
 *   抛「no such table」。本票交付的是一个**显式临时态：空表 + 零写口**，读侧
 *   返回零命中；**表结构的 DROP 归票辛**（接线时旧链整体下线）。
 *
 * 用法:
 *   node scripts/flywheel/retire-message-memory.mjs                    # 本仓 dev 库 + 主库各跑一次
 *   node scripts/flywheel/retire-message-memory.mjs --db <path>        # 指定库（可重复，覆盖缺省）
 *
 * 契约（票壬 ③ / V4 / V6 / V7 / V8）:
 *   - 目标表名**硬编码**在本文件，**不接受参数化表名**（V7）
 *   - 幂等：连跑两次，第二次零报错、零变更（V4）
 *   - 执行记录**逐表**列前后行数（V7：防「误删其它表」在单条汇总数里不可见）
 *   - 关闭前自检表结构仍在（V6：防「顺手 drop」）
 *   - 库文件不存在 ⇒ 跳过（**不新建空库**）；库在但目标表缺失 ⇒ 判失败、非零退出
 *
 * SQLITE_BUSY：只做**一次有界等待**（`busy_timeout`），**不做重试循环**；
 * 仍拿不到锁就如实报错退出——主库被 server 持有时按实据报告，不硬干。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

/**
 * 目标表（**硬编码**，V7）。加表前先确认它在真库里存在——
 * 写一个不存在的表名不会静默跳过，会当场 `no such table`（V8）。
 */
export const TARGET_TABLES = ['memories', 'memories_fts']

/** 有界等待上限（ms）——单次，不重试 */
export const BUSY_TIMEOUT_MS = 5000

/** 缺省目标库（与 `scripts/dev.js` / `db/index.ts` 的库分离同源） */
export function defaultDbs(root = ROOT) {
  const dataDir = path.join(root, 'packages', 'server', 'data')
  return [
    { label: 'dev', file: path.join(dataDir, 'cat-study-dev.db') },
    { label: 'prod', file: path.join(dataDir, 'cat-study.db') },
  ]
}

/** 逐表行数（表名来自 TARGET_TABLES 硬编码常量，非外部输入） */
function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c)
}

/** 库内已有的表名集合 */
function existingTables(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
  )
}

/**
 * 对一个库执行退役清理。**不抛异常**——失败以 `ok:false` + `error` 回传，
 * 由调用方决定退出码（清理脚本不该用栈回溯当报告）。
 *
 * @param {string} dbFile 库文件绝对路径
 * @returns {{db: string, ok: boolean, error: string|null, tables: Array<{table: string, before: number|null, after: number|null, deleted: number|null}>, tablesStillPresent: boolean|null}}
 */
export function retireMessageMemory(dbFile) {
  const record = {
    db: dbFile,
    ok: true,
    error: null,
    tables: [],
    tablesStillPresent: null,
  }

  if (!existsSync(dbFile)) {
    // 不 new DatabaseSync —— 它会**创建**空库文件（在 worktree 里跑会落一地假库）
    record.ok = false
    record.error = `db-file-missing`
    return record
  }

  let db
  try {
    db = new DatabaseSync(dbFile)
    // 一次有界等待：并发写事务（server 正在写）时等 5s 拿锁；超时如实报错，不重试
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)

    const present = existingTables(db)
    const missing = TARGET_TABLES.filter((t) => !present.has(t))
    if (missing.length) {
      // 表不存在 ⇒ 「空表」这个目标态无从验证 ⇒ 判失败（不静默跳过）
      record.ok = false
      record.error = `table-missing: ${missing.join(', ')}`
      return record
    }

    for (const table of TARGET_TABLES) {
      record.tables.push({ table, before: countRows(db, table), after: null, deleted: null })
    }

    // 两表一次事务：中途失败不留「正文清了、FTS 没清」的半拉态
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const t of record.tables) {
        db.exec(`DELETE FROM ${t.table}`)
        t.after = countRows(db, t.table)
        t.deleted = t.before - t.after
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 事务未开/已断——回滚失败不掩盖原始错误 */
      }
      throw err
    }

    // V6 自检：表结构仍在（DELETE 不改 schema——这里是防「顺手 drop」的机器判据）
    const after = existingTables(db)
    record.tablesStillPresent = TARGET_TABLES.every((t) => after.has(t))
    if (!record.tablesStillPresent) {
      record.ok = false
      record.error = 'table-dropped'
    }
  } catch (err) {
    record.ok = false
    record.error = err?.message ?? String(err)
    // 事务已开未提交时 ROLLBACK 已在上面做过；此处只兜底关连接
  } finally {
    try {
      db?.close()
    } catch {
      /* 关连接失败不影响结论 */
    }
  }

  return record
}

/** 执行记录 → 文本行（V7：逐表前后行数） */
export function formatRecord(label, record) {
  const lines = [`[retire-message-memory] ${label} → ${record.db}`]
  if (record.error === 'db-file-missing') {
    lines.push('  跳过：库文件不存在（不新建空库）')
    return lines
  }
  if (record.error?.startsWith('table-missing')) {
    lines.push(`  ❌ ${record.error}`)
    return lines
  }
  for (const t of record.tables) {
    lines.push(`  ${t.table}: ${t.before} → ${t.after}（删除 ${t.deleted} 行）`)
  }
  if (record.error) {
    lines.push(`  ❌ ${record.error}`)
  } else {
    lines.push(`  表结构保留：${record.tablesStillPresent ? '是（未 DROP）' : '否 ❌'}`)
  }
  return lines
}

function main(argv) {
  const overrides = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      const file = argv[++i]
      if (!file) {
        console.error('[retire-message-memory] --db 缺路径')
        process.exitCode = 2
        return
      }
      overrides.push({ label: 'explicit', file: path.resolve(file) })
    } else {
      console.error(`[retire-message-memory] 未知参数 ${argv[i]}`)
      process.exitCode = 2
      return
    }
  }

  const targets = overrides.length ? overrides : defaultDbs()
  let failed = false
  for (const { label, file } of targets) {
    const record = retireMessageMemory(file)
    for (const line of formatRecord(label, record)) console.log(line)
    // 「库文件不存在」= 没有目标可清，不算失败；表缺失/写失败才算
    if (!record.ok && record.error !== 'db-file-missing') failed = true
  }
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}

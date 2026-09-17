/**
 * `__fixtures__/schema-baseline.json` 的**生成器**（票 1 验收 1「压扁誊写校验」的比对基准）。
 *
 * 跑法（packages/server 下）：`node node_modules/tsx/dist/cli.mjs src/db/__gen-fixture.ts`
 *
 * ⚠️ 基准的取证面必须钉在**改动前**的旧码上（票面原话：「先跑旧码留 dump 作 fixture，
 * 再跑新码比对」）。本仓库的旧码在 `852349d:packages/server/src/db/index.ts` —— 要复核
 * 基准真伪，请 `git stash` 回旧码（或从该提交取 index.ts）再跑本脚本，比对产物是否与
 * 已提交的 JSON 一致。**直接在压扁后的树上跑它 = 自己证自己**（新码产物当然等于新码产物）。
 *
 * 留着的理由：它是基准唯一可复算的取证路径，删了就只能信 JSON 里那 47 行字。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { setDb, initDb } from './index.js'

const db = new Database(':memory:')
setDb(db)
initDb()

/**
 * 空白归一（与 migrations.test.ts 的比对函数**逐字同款**）：誊写校验判结构/词法，
 * 不判排版——SQL 里空白唯一承载语义的地方是字符串字面量，本库 DDL 无此形态。
 */
const canonSql = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()

const rows = db
  .prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  )
  .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>

const dump = rows.map((r) => ({
  type: r.type,
  name: r.name,
  tblName: r.tbl_name,
  sql: r.sql === null ? null : canonSql(r.sql),
}))

fs.mkdirSync(new URL('./__fixtures__/', import.meta.url), { recursive: true })
fs.writeFileSync(
  new URL('./__fixtures__/schema-baseline.json', import.meta.url),
  JSON.stringify(dump, null, 2) + '\n'
)
console.log('rows dumped:', dump.length)

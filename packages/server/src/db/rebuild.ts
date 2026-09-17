/**
 * 通用表重建 helper（票 `db-schema-governance` 票 4；spec §4.4 纪律 2/3）。
 *
 * B 范围的重建批（票 5/6/8）做的是同一件事：把一张表换成新形状（补 FK / 补 CHECK /
 * 改时间口径 / 删列），数据一行不丢。SQLite 的 `ALTER TABLE` 做不了这些，官方路子是
 * 「十二步表重建」。本文件是那十二步里**与表形状无关**的机制部分——不含任何真实表
 * 形状，各表 DDL 由调用方在各自的重建票里给。
 *
 * 单事务：建新表 → 按 columnMap 拷数据 → **行数硬校验** → 删旧表 → 改名 → 按 createSql
 * 重建索引 → FK 体检 → 提交。任何一步抛错 ⇒ 整体回滚，库里连临时表都不留。
 *
 * ## 三个「不这么做就静默出事」的点（都实测过，不是推断）
 *
 * 1. **必须先关 FK 再动**：`PRAGMA foreign_keys` **在事务内是 no-op**——实测在 `BEGIN`
 *    之后设 OFF，读回仍是 1。所以开关只能在事务外、由本 helper 自己管。不关的后果是
 *    **子表数据被静默清空**：子表 `ON DELETE CASCADE` 时，`DROP TABLE` 父表走隐式
 *    DELETE，把子表行一并 CASCADE 掉（实测子表 1 行 → 0 行，全程零报错）。
 * 2. **拷贝必须 `ORDER BY rowid`**：不加的话 SQLite 可能改走覆盖索引扫（实测计划
 *    `SCAN t USING COVERING INDEX idx_t_id`），新表 rowid 就按**索引序**重排了。而本项目
 *    「同值平局按插入序」的隐含判据正是 rowid（票 2 OQ 实测过同一条）。实测：插入序
 *    z,a,m 的表，不加 ORDER BY 重建后 rowid 序变成 a,m,z。
 * 3. **`foreign_key_check` 只查本表**：不带表名的版本会把**全库既有**孤儿一起报出来
 *    （别的表的历史遗留与本表重建无关），带表名只查本表**出向** FK——正是「重建新加的
 *    约束撞上存量数据」这个面。存量孤儿怎么处置由孤儿审计（票 3）报告 + 用户拍板决定，
 *    本 helper 只负责「撞上就拒建」，不替用户做删除决定。
 *
 * ## 不吞东西
 *
 * 旧表上「重建后没再出现」的索引/触发器一律**抛错回滚**（`sqlite_autoindex_*` 这类
 * 由约束自动生成的不算，它们随新表约束自动重建）——静默丢一个索引 = 静默的性能回归，
 * 正是重建类改动最容易留下的暗伤。确实要丢的，用 `allowDropped` 明确列名。
 *
 * 旧表有、新表没有的**列**同理：数据随列一起没了，必须由调用方在 `allowDroppedColumns`
 * 里点名确认，否则抛错回滚（票 8 删 `sessions.agent_ids` 是已知意图，仍要显式声明）。
 *
 * ## 拷贝一律按列名，禁位置对齐（票 4 契约补充，票 3 发现①）
 *
 * 两库 `messages` 的**列序不同**（main `…created_at,task_id…` / dev `…task_id,created_at…`，
 * 老库 ALTER 追加列的历史产物），而 `INSERT INTO new SELECT * FROM old` 是**按位置**对齐的
 * ——错列之后行数校验照样通过，属于查不出来的静默事故。故本 helper 的拷贝清单由
 * `PRAGMA table_info` 双侧取列名构造，每列的取值表达式要么是 `quoteIdent(来源列)`，
 * 要么是调用方显式给的 `convert`；`convert` 是本文件里**唯一**能引入通配的入口，故在此挡掉。
 */
import type Database from 'better-sqlite3'

/** 一条列映射：只列**需要改名或转换**的列，其余同名列自动直拷 */
export interface RebuildColumn {
  /** 新表里的列名（数据落到这一列） */
  to: string
  /** 旧表里的来源列名；缺省 = 与 `to` 同名 */
  from?: string
  /**
   * 取值表达式，**原样**拼进 `SELECT`（作用域 = 旧表的列），如
   * `strftime('%Y-%m-%dT%H:%M:%fZ', created_at)`（秒级 → ISO 毫秒，头号用例）。
   * 给了 `convert` 就以它为准；`from` 退化成「来源列必须存在」的存在性校验。
   */
  convert?: string
}

export interface RebuildOptions {
  /** 要重建的表名（旧名 = 新名 = 最终名；`createSql` 里也必须是这个名字） */
  table: string
  /**
   * 目标形状 DDL：**首条必须是 `CREATE TABLE <table>`**，其后可跟该表的
   * `CREATE INDEX` / `CREATE TRIGGER` 等语句（分号分隔；引号与注释内的分号不算分隔符）。
   * 正文按原样建表（`IF NOT EXISTS` 会被 SQLite 自身剥掉，与本仓其它 DDL 同款）。
   */
  createSql: string
  /** 列映射（缺省 = 新旧同名直拷，仅存于新表的列走 DEFAULT/NULL） */
  columnMap?: ReadonlyArray<RebuildColumn>
  /** 明确声明要丢弃的旧索引/触发器名（缺省：丢一个没在 `createSql` 里重建的就抛） */
  allowDropped?: ReadonlyArray<string>
  /** 明确声明要丢弃的旧表列名（缺省：丢一列没在这里点名的就抛——列丢 = 数据丢，不许静默） */
  allowDroppedColumns?: ReadonlyArray<string>
}

export interface RebuildReport {
  table: string
  /** 实际拷贝的行数（行数硬校验通过才会返回） */
  rows: number
  /** 实际参与拷贝的新表列名 */
  copiedColumns: string[]
  /** 旧表有、新表没有的列（数据随列丢弃——必须先在 `allowDroppedColumns` 里点名才走到这里） */
  droppedColumns: string[]
  /** 新表有、旧表没有且未给取值的列（走该列的 DEFAULT / NULL） */
  addedColumns: string[]
}

/** 临时表名后缀：建新表先落这个名字，删旧表后改回 `table` */
const TEMP_SUFFIX = '__rebuild_tmp'

/** 首条语句的 `CREATE TABLE` 头（捕获前缀，便于只替换表名、其余正文一个字节不动） */
const CREATE_TABLE_RE =
  /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/i

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** `convert` 里的通配取值（`*` / `t.*`）——本文件里唯一能写出「按位置拷」的入口 */
const WILDCARD_EXPR_RE = /^\s*(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?\*\s*$/

/** 引号/注释感知的分号切分——DDL 正文里的 `-- 注释；含分号` 不是语句边界 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipQuoted(sql, i, ch)
      buf += sql.slice(i, end)
      i = end
      continue
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i)
      const stop = end === -1 ? sql.length : end + 1
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === ';') {
      const stmt = buf.trim()
      if (stmt !== '') out.push(stmt)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  const tail = buf.trim()
  if (tail !== '') out.push(tail)
  return out
}

/** 跳过一个引号串（SQL 里 `''` 是转义的双写引号）；未闭合则吃到结尾，交给 SQLite 报错 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

/**
 * 硬校验：拷贝前后行数必须一致。
 *
 * 不一致 ⇒ 抛（调用方在事务里 ⇒ 整体回滚，旧表原样）。拷贝是纯
 * `INSERT … SELECT`，SQLite 没有「静默少插几行」的路径，故这条断言在公开路径上打不响
 * ——它是**防未来改动的护栏**（谁把拷贝改成 `INSERT OR IGNORE`、或给 SELECT 加了过滤，
 * 这里当场炸），故导出供测试直接钉住判据。
 */
export function assertRowCountPreserved(table: string, before: number, after: number): void {
  if (before !== after) {
    throw new Error(
      `[db] 重建「${table}」行数不一致：旧表 ${before} 行 → 新表 ${after} 行。` +
        `重建必须一行不丢，已回滚，库结构未变。`
    )
  }
}

function tableSql(db: Database.Database, name: string): string | undefined {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql: string | null } | undefined
  return row === undefined ? undefined : (row.sql ?? '')
}

function columnNames(db: Database.Database, table: string): string[] {
  // 生成列（GENERATED ALWAYS AS）不在 table_info 里 —— 正合需要：它们不可 INSERT。
  return (db.pragma(`table_info(${quoteIdent(table)})`) as Array<{ name: string }>).map(
    (c) => c.name
  )
}

/** 表上挂的索引 / 触发器名（`sql IS NULL` = 约束自动生成的 autoindex，随新形状自动重建，不算） */
function objectsOn(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL`
    )
    .all(table) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }
  return row.n
}

interface CopyColumn {
  to: string
  expr: string
}

/** 解析拷贝列清单：同名列直拷 / `columnMap` 改名或转换 / 新表独有列走 DEFAULT */
function planCopy(
  table: string,
  oldColumns: ReadonlyArray<string>,
  newColumns: ReadonlyArray<string>,
  columnMap: ReadonlyArray<RebuildColumn>
): { plan: CopyColumn[]; dropped: string[]; added: string[] } {
  const byTarget = new Map<string, RebuildColumn>()
  for (const entry of columnMap) {
    if (byTarget.has(entry.to)) {
      throw new Error(`[db] 重建「${table}」的 columnMap 里「${entry.to}」重复映射。`)
    }
    if (!newColumns.includes(entry.to)) {
      throw new Error(
        `[db] 重建「${table}」的 columnMap 指向新表不存在的列「${entry.to}」——` +
          `映射的目标列必须在 createSql 建出的新形状里。`
      )
    }
    if (entry.from !== undefined && !oldColumns.includes(entry.from)) {
      throw new Error(
        `[db] 重建「${table}」的 columnMap 里「${entry.to}」声明的来源列「${entry.from}」在旧表不存在。`
      )
    }
    byTarget.set(entry.to, entry)
  }

  const plan: CopyColumn[] = []
  const added: string[] = []
  for (const col of newColumns) {
    const entry = byTarget.get(col)
    if (entry !== undefined) {
      if (entry.convert !== undefined) {
        if (WILDCARD_EXPR_RE.test(entry.convert)) {
          throw new Error(
            `[db] 重建「${table}」的 columnMap 里「${col}」的 convert 写成了通配取值——` +
              `拷贝必须按列名显式映射（两库列序可能不同，位置对齐会静默错列且行数校验查不出来）。`
          )
        }
        plan.push({ to: col, expr: entry.convert })
        continue
      }
      const source = entry.from ?? col
      if (!oldColumns.includes(source)) {
        throw new Error(
          `[db] 重建「${table}」的新列「${col}」在旧表没有同名来源列——` +
            `改名请用 columnMap 的 from，转换请用 convert。`
        )
      }
      plan.push({ to: col, expr: quoteIdent(source) })
      continue
    }
    if (oldColumns.includes(col)) {
      plan.push({ to: col, expr: quoteIdent(col) })
      continue
    }
    added.push(col)
  }

  const dropped = oldColumns.filter((c) => !newColumns.includes(c))
  return { plan, dropped, added }
}

/**
 * 把 `table` 重建成 `createSql` 描述的形状，数据一行不丢；任何一步出错整体回滚。
 *
 * 调用方**不得**已处于事务中——本 helper 自带事务，且 FK 开关只能在事务外切换。
 */
export function rebuildTable(db: Database.Database, options: RebuildOptions): RebuildReport {
  const { table, createSql } = options
  const columnMap = options.columnMap ?? []
  const allowDropped = new Set(options.allowDropped ?? [])
  const allowDroppedColumns = new Set(options.allowDroppedColumns ?? [])

  if (db.inTransaction) {
    throw new Error(
      `[db] 重建「${table}」不能在事务内调用：helper 自带事务，且 ` +
        `PRAGMA foreign_keys 在事务内是 no-op（关不掉 FK，DROP 旧表会静默 CASCADE 清空子表）。`
    )
  }

  const oldSql = tableSql(db, table)
  if (oldSql === undefined) {
    throw new Error(`[db] 重建「${table}」：表不存在。`)
  }
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(oldSql)) {
    throw new Error(
      `[db] 重建「${table}」：虚拟表（VIRTUAL TABLE）不支持重建——` +
        `其影子表由扩展自己管，重建会拆坏索引。`
    )
  }

  const statements = splitStatements(createSql)
  const first = statements[0]
  const head = first === undefined ? null : CREATE_TABLE_RE.exec(first)
  if (first === undefined || head === null) {
    throw new Error(`[db] 重建「${table}」：createSql 首条必须是 CREATE TABLE。`)
  }
  const declared = head[2] ?? head[3] ?? head[4] ?? head[5]
  if (declared !== table) {
    throw new Error(
      `[db] 重建「${table}」：createSql 建的是「${declared}」——两者必须同名（helper 靠改名把新表扶正）。`
    )
  }

  const tmp = `${table}${TEMP_SUFFIX}`
  const tmpTaken = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(tmp)
  if (tmpTaken !== undefined) {
    throw new Error(`[db] 重建「${table}」：临时表「${tmp}」已存在，疑似上次重建的半成品残留。`)
  }

  // 只换表名，其余正文（含行内注释、列序、约束原文）一个字节不动
  const createTmpSql = head[1] + quoteIdent(tmp) + first.slice(head[0].length)
  const shapeStatements = statements.slice(1)

  const oldColumns = columnNames(db, table)
  const oldObjects = objectsOn(db, table)
  const withoutRowid = /WITHOUT\s+ROWID/i.test(oldSql)

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (fkWasOn) db.pragma('foreign_keys = OFF')
  try {
    return db
      .transaction((): RebuildReport => {
        db.exec(createTmpSql)

        const newColumns = columnNames(db, tmp)
        const { plan, dropped, added } = planCopy(table, oldColumns, newColumns, columnMap)

        const undeclared = dropped.filter((c) => !allowDroppedColumns.has(c))
        if (undeclared.length > 0) {
          throw new Error(
            `[db] 重建「${table}」会丢掉旧表的列：${undeclared.join('、')}（数据随列一起没了）。` +
              `确认要丢的，在 allowDroppedColumns 里明确列出。已回滚。`
          )
        }

        const before = countRows(db, table)
        if (plan.length > 0) {
          const cols = plan.map((p) => quoteIdent(p.to)).join(', ')
          const exprs = plan.map((p) => p.expr).join(', ')
          // ORDER BY rowid：钉住「插入序」（见文件头第 2 条）
          const order = withoutRowid ? '' : ' ORDER BY rowid'
          db.exec(
            `INSERT INTO ${quoteIdent(tmp)} (${cols}) SELECT ${exprs} FROM ${quoteIdent(table)}${order}`
          )
        }
        assertRowCountPreserved(table, before, countRows(db, tmp))

        db.exec(`DROP TABLE ${quoteIdent(table)}`)
        db.exec(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`)
        for (const stmt of shapeStatements) db.exec(stmt)

        const survived = new Set(objectsOn(db, table))
        const lost = oldObjects.filter((name) => !survived.has(name) && !allowDropped.has(name))
        if (lost.length > 0) {
          throw new Error(
            `[db] 重建「${table}」会丢掉索引/触发器：${lost.join('、')}。` +
              `把它们的 DDL 放进 createSql 一起重建；确实要丢的，在 allowDropped 里明确列出。已回滚。`
          )
        }

        // 只查本表出向 FK：新加的约束撞上存量孤儿 ⇒ 拒建（孤儿怎么处置由审计报告 + 用户拍板）
        const violations = db.pragma(`foreign_key_check(${quoteIdent(table)})`) as Array<{
          rowid: number | null
          parent: string
        }>
        if (violations.length > 0) {
          const sample = violations
            .slice(0, 3)
            .map((v) => `rowid=${v.rowid} → ${v.parent}`)
            .join('；')
          throw new Error(
            `[db] 重建「${table}」后有 ${violations.length} 行违反新 FK 约束（${sample}…）。` +
              `存量孤儿必须先按审计结论处置（删除 / 收容），或该关系本轮不加 FK。已回滚。`
          )
        }

        return {
          table,
          rows: before,
          copiedColumns: plan.map((p) => p.to),
          droppedColumns: dropped,
          addedColumns: added,
        }
      })
      .immediate()
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON')
  }
}

/**
 * 表重建 helper 测试（票 `db-schema-governance` 票 4）。
 *
 * 判据面 = **外部行为**：重建后的数据、`sqlite_master` 结构、约束是否真的拦得住新的写、
 * 出错后库里剩什么、连接上的 `foreign_keys` 有没有被 helper 改坏。
 *
 * 夹具刻意**不带任何真实表形状**（helper 本身也不带）：一律 `new Database(':memory:')`
 * 手搓两张小表，这样「机制对不对」与「票 5/6/8 的形状对不对」不会互相掩盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { rebuildTable, assertRowCountPreserved, splitStatements } from './rebuild.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
})

afterEach(() => {
  db.close()
})

const tableSql = (name: string): string =>
  (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as {
      sql: string
    }
  ).sql

const indexNames = (name: string): string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
      )
      .all(name) as Array<{ name: string }>
  ).map((r) => r.name)

const rows = (name: string, order = 'rowid'): unknown[] =>
  db.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).all()

describe('db/rebuild —— 通用表重建 helper（票 4）', () => {
  describe('验收 1 · :memory: 往返（数据原样 / 格式已转 / 新约束生效）', () => {
    it('同名列直拷：数据原样、行数一致、新 CHECK 当场拦得住违规写', () => {
      db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, v TEXT)`)
      db.exec(`INSERT INTO notes VALUES ('n1','a'), ('n2','b'), ('n3','c')`)

      const report = rebuildTable(db, {
        table: 'notes',
        createSql: `CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          v TEXT NOT NULL CHECK (length(v) > 0)
        )`,
      })

      expect(report).toEqual({
        table: 'notes',
        rows: 3,
        copiedColumns: ['id', 'v'],
        droppedColumns: [],
        addedColumns: [],
      })
      expect(rows('notes')).toEqual([
        { id: 'n1', v: 'a' },
        { id: 'n2', v: 'b' },
        { id: 'n3', v: 'c' },
      ])
      expect(tableSql('notes')).toContain('CHECK (length(v) > 0)')
      // 新约束**真的生效**（不是只写进了 DDL 文本）
      expect(() => db.exec(`INSERT INTO notes VALUES ('n4','')`)).toThrow(/CHECK/)
    })

    it('时间列秒级 → ISO 毫秒：格式转了、时刻没变（columnMap.convert）', () => {
      db.exec(`CREATE TABLE logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`)
      db.exec(`INSERT INTO logs VALUES ('l1', '2026-09-17 08:30:00'), ('l2', datetime('now'))`)
      const before = rows('logs', 'id') as Array<{ id: string; created_at: string }>

      rebuildTable(db, {
        table: 'logs',
        createSql: `CREATE TABLE logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
        columnMap: [{ to: 'created_at', convert: `strftime('%Y-%m-%dT%H:%M:%fZ', created_at)` }],
      })

      const after = rows('logs', 'id') as Array<{ id: string; created_at: string }>
      for (const r of after) {
        expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      }
      // 同一时刻：ISO 毫秒定宽串与秒级串解析出的 epoch 必须相等。
      // 秒级串是 `YYYY-MM-DD HH:MM:SS`（空格分隔），`Date.parse` 会当**本地时间**，
      // 故先补 `T`+`Z` 还原成 UTC 再比 —— 判据面与被判面必须同面。
      const asUtc = (sqliteSeconds: string): number =>
        Date.parse(`${sqliteSeconds.replace(' ', 'T')}Z`)
      expect(Date.parse(after[0].created_at)).toBe(Date.parse('2026-09-17T08:30:00.000Z'))
      expect(after[0].created_at).toBe('2026-09-17T08:30:00.000Z')
      expect(Date.parse(after[1].created_at)).toBe(asUtc(before[1].created_at))
    })

    it('列改名（columnMap.from）：旧列的值落到新列名上', () => {
      db.exec(`CREATE TABLE s (session_id TEXT PRIMARY KEY, legacy_note TEXT)`)
      db.exec(`INSERT INTO s VALUES ('s1','hello')`)

      const report = rebuildTable(db, {
        table: 's',
        createSql: `CREATE TABLE s (session_id TEXT PRIMARY KEY, note TEXT NOT NULL)`,
        columnMap: [{ to: 'note', from: 'legacy_note' }],
        allowDroppedColumns: ['legacy_note'], // 改名 = 旧列名在新形状里「消失」，须点名
      })

      expect(report.copiedColumns).toEqual(['session_id', 'note'])
      expect(report.droppedColumns).toEqual(['legacy_note'])
      expect(rows('s')).toEqual([{ session_id: 's1', note: 'hello' }])
    })

    it('增列走 DEFAULT；删列须在 allowDroppedColumns 点名，点了才丢并进报告', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, dead TEXT)`)
      db.exec(`INSERT INTO t VALUES ('a','x')`)

      const report = rebuildTable(db, {
        table: 't',
        createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, added TEXT NOT NULL DEFAULT 'dflt')`,
        allowDroppedColumns: ['dead'],
      })

      expect(report.droppedColumns).toEqual(['dead'])
      expect(report.addedColumns).toEqual(['added'])
      expect(rows('t')).toEqual([{ id: 'a', added: 'dflt' }])
    })

    it('两库列序不同（票 4 契约补充 · 票 3 发现①）：按列名映射，数据不错列', () => {
      // main 与 dev 的 messages 实测列序不同（老库 ALTER 追加列的产物），
      // 按位置拷会静默错列且行数校验查不出来——故这里刻意让新旧列序互不相同。
      db.exec(
        `CREATE TABLE m (id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT, task_id TEXT)`
      )
      db.exec(`INSERT INTO m VALUES ('m1','s1','2026-09-17 08:30:00','task-1')`)

      const report = rebuildTable(db, {
        table: 'm',
        createSql: `CREATE TABLE m (id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, created_at TEXT)`,
      })

      expect(report.copiedColumns).toEqual(['id', 'session_id', 'task_id', 'created_at'])
      expect(rows('m')).toEqual([
        { id: 'm1', session_id: 's1', task_id: 'task-1', created_at: '2026-09-17 08:30:00' },
      ])
    })

    it('行序按 rowid（插入序）保持——不被索引序顶掉', () => {
      // 判别性：旧表在拷贝列上有覆盖索引，无 ORDER BY rowid 时计划退化成
      // `SCAN t USING COVERING INDEX idx_t_id`（实测），拷出来就是索引序 a,m,z；
      // 带 ORDER BY rowid 才是插入序 z,a,m（也正是本项目「同值平局按插入序」的隐含判据）。
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
      db.exec(`CREATE INDEX idx_t_id ON t(id)`)
      db.exec(`INSERT INTO t VALUES ('z','1'), ('a','2'), ('m','3')`)

      rebuildTable(db, {
        table: 't',
        // 新形状不再有 v；索引照旧重建（索引原样，行序仍必须是插入序）
        createSql: `CREATE TABLE t (id TEXT PRIMARY KEY);
                    CREATE INDEX idx_t_id ON t(id)`,
        allowDroppedColumns: ['v'],
      })

      expect(rows('t', 'rowid')).toEqual([{ id: 'z' }, { id: 'a' }, { id: 'm' }])
      expect(indexNames('t')).toEqual(['idx_t_id'])
    })

    it('WITHOUT ROWID 旧表：拷贝不拼 ORDER BY rowid（那种表根本没有 rowid 列）', () => {
      db.exec(`CREATE TABLE w (id TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`)
      db.exec(`INSERT INTO w VALUES ('z','1'), ('a','2')`)

      const report = rebuildTable(db, {
        table: 'w',
        createSql: `CREATE TABLE w (id TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`,
      })

      expect(report.rows).toBe(2)
      expect(rows('w', 'id')).toEqual([
        { id: 'a', v: '2' },
        { id: 'z', v: '1' },
      ])
      expect(tableSql('w')).toContain('WITHOUT ROWID')
    })

    it('生成列不进拷贝清单（table_info 天然不含它，INSERT 不会撞 generated column）', () => {
      db.exec(`CREATE TABLE g (a INTEGER PRIMARY KEY, b INTEGER)`)
      db.exec(`INSERT INTO g VALUES (1, 10)`)

      const report = rebuildTable(db, {
        table: 'g',
        createSql: `CREATE TABLE g (
          a INTEGER PRIMARY KEY,
          b INTEGER,
          doubled INTEGER GENERATED ALWAYS AS (b * 2) STORED
        )`,
      })

      expect(report.copiedColumns).toEqual(['a', 'b'])
      expect(report.addedColumns).toEqual([])
      expect(rows('g')).toEqual([{ a: 1, b: 10, doubled: 20 }])
    })
  })

  describe('验收 2 · 硬校验与回滚（零半成品）', () => {
    it('assertRowCountPreserved：行数不符即抛，消息带表名与两个数', () => {
      expect(() => assertRowCountPreserved('messages', 1825, 1824)).toThrow(
        /重建「messages」行数不一致：旧表 1825 行 → 新表 1824 行/
      )
      expect(() => assertRowCountPreserved('messages', 3, 3)).not.toThrow()
    })

    it('端到端故障注入（新形状 UNIQUE 撞旧数据重值）→ 整体回滚：结构/数据/索引原样、无临时表残留', () => {
      db.exec(`CREATE TABLE c (id TEXT PRIMARY KEY, tag TEXT)`)
      db.exec(`CREATE INDEX idx_c_tag ON c(tag)`)
      db.exec(`INSERT INTO c VALUES ('1','dup'), ('2','dup')`)
      const beforeSql = tableSql('c')
      const beforeObjects = indexNames('c')

      expect(() =>
        rebuildTable(db, {
          table: 'c',
          createSql: `CREATE TABLE c (id TEXT PRIMARY KEY, tag TEXT UNIQUE)`,
          allowDropped: ['idx_c_tag'],
        })
      ).toThrow(/UNIQUE/)

      expect(tableSql('c')).toBe(beforeSql)
      expect(indexNames('c')).toEqual(beforeObjects)
      expect(rows('c')).toHaveLength(2)
      expect(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'c__rebuild_tmp'`).get()
      ).toBeUndefined()
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('新 FK 撞存量孤儿 → 拒建 + 回滚（不替用户做删除决定）', () => {
      db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY)`)
      db.exec(`INSERT INTO agents VALUES ('a1')`)
      db.exec(`CREATE TABLE msgs (id TEXT PRIMARY KEY, agent_id TEXT)`)
      db.exec(`INSERT INTO msgs VALUES ('m1','a1'), ('m2','ghost')`)
      const beforeSql = tableSql('msgs')

      expect(() =>
        rebuildTable(db, {
          table: 'msgs',
          createSql: `CREATE TABLE msgs (
            id TEXT PRIMARY KEY,
            agent_id TEXT REFERENCES agents(id)
          )`,
        })
      ).toThrow(/1 行违反新 FK 约束/)

      expect(tableSql('msgs')).toBe(beforeSql)
      expect(rows('msgs')).toHaveLength(2)
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('旧表带 CASCADE 子表时重建父表：子表行不被静默清空（FK 开关只在事务外切）', () => {
      // 不关 FK 的后果实测是**静默丢数据**：DROP TABLE 父表走隐式 DELETE，
      // 子表 ON DELETE CASCADE 跟着清空（子表 1 行 → 0 行，全程零报错）。
      db.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY, v TEXT)`)
      db.exec(
        `CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id) ON DELETE CASCADE)`
      )
      db.exec(`INSERT INTO parent VALUES ('p1','x')`)
      db.exec(`INSERT INTO child VALUES ('c1','p1')`)

      rebuildTable(db, {
        table: 'parent',
        createSql: `CREATE TABLE parent (id TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      })

      expect(rows('child')).toEqual([{ id: 'c1', pid: 'p1' }])
      expect(rows('parent')).toEqual([{ id: 'p1', v: 'x' }])
      // 开关是「借来用一下」：用完必须还回原值（spec §4.1：每个连接路径都开 FK 是不变量）
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('删列没在 allowDroppedColumns 点名 → 抛 + 回滚（列丢 = 数据丢，不许静默）', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, legacy TEXT)`)
      db.exec(`CREATE INDEX idx_t_legacy ON t(legacy)`)
      db.exec(`INSERT INTO t VALUES ('a','keep?')`)
      const beforeSql = tableSql('t')

      expect(() =>
        rebuildTable(db, {
          table: 't',
          createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, note TEXT)`,
        })
      ).toThrow(/会丢掉旧表的列：legacy/)

      expect(tableSql('t')).toBe(beforeSql)
      expect(rows('t')).toEqual([{ id: 'a', legacy: 'keep?' }])
      expect(indexNames('t')).toEqual(['idx_t_legacy'])
    })

    it('连接本来就关着 FK → 重建后仍关着（不擅自把不变量塞给调用方）', () => {
      db.pragma('foreign_keys = OFF')
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
      db.exec(`INSERT INTO t VALUES ('a')`)

      rebuildTable(db, { table: 't', createSql: `CREATE TABLE t (id TEXT PRIMARY KEY)` })

      expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
    })
  })

  describe('验收 3 · 索引丢失守卫（静默性能回归也是静默事故）', () => {
    it('旧索引没在 createSql 里重建 → 抛 + 回滚；allowDropped 明确列出才放行', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, tag TEXT, note TEXT)`)
      db.exec(`CREATE INDEX idx_t_tag ON t(tag)`)
      db.exec(`INSERT INTO t VALUES ('a','x','n')`)
      const beforeSql = tableSql('t')

      expect(() =>
        rebuildTable(db, {
          table: 't',
          createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, tag TEXT, note TEXT)`,
        })
      ).toThrow(/会丢掉索引\/触发器：idx_t_tag/)
      expect(tableSql('t')).toBe(beforeSql) // 回滚了，形状没动

      const report = rebuildTable(db, {
        table: 't',
        createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, tag TEXT, note TEXT);
                    CREATE INDEX idx_t_tag ON t(tag)`,
      })
      expect(report.rows).toBe(1)
      expect(indexNames('t')).toEqual(['idx_t_tag'])
    })

    it('约束自动生成的 autoindex 不算丢（sql IS NULL，随新形状自动重建）', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, e TEXT UNIQUE)`)
      db.exec(`INSERT INTO t VALUES ('a','x')`)

      const report = rebuildTable(db, {
        table: 't',
        createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, e TEXT UNIQUE)`,
      })

      expect(report.rows).toBe(1)
      expect(() => db.exec(`INSERT INTO t VALUES ('b','x')`)).toThrow(/UNIQUE/)
    })
  })

  describe('验收 4 · 前置校验（错用就当场说清，不留半成品）', () => {
    it('调用方已在事务内 → 抛，且不破坏调用方那个事务', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)

      db.exec('BEGIN')
      expect(() =>
        rebuildTable(db, { table: 't', createSql: `CREATE TABLE t (id TEXT PRIMARY KEY)` })
      ).toThrow(/不能在事务内调用/)
      expect(db.inTransaction).toBe(true)
      db.exec('ROLLBACK')
    })

    it('表不存在 / 虚拟表 / 临时表残留 → 各自抛错', () => {
      expect(() =>
        rebuildTable(db, { table: 'nope', createSql: `CREATE TABLE nope (id TEXT)` })
      ).toThrow(/表不存在/)

      db.exec(`CREATE VIRTUAL TABLE fx USING fts5(a)`)
      expect(() =>
        rebuildTable(db, { table: 'fx', createSql: `CREATE TABLE fx (a TEXT)` })
      ).toThrow(/虚拟表/)

      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)
      db.exec(`CREATE TABLE t__rebuild_tmp (id TEXT PRIMARY KEY)`)
      expect(() =>
        rebuildTable(db, { table: 't', createSql: `CREATE TABLE t (id TEXT PRIMARY KEY)` })
      ).toThrow(/半成品残留/)
    })

    it('createSql 首条不是 CREATE TABLE / 表名对不上 → 抛', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)

      expect(() => rebuildTable(db, { table: 't', createSql: `CREATE INDEX i ON t(id)` })).toThrow(
        /首条必须是 CREATE TABLE/
      )
      expect(() =>
        rebuildTable(db, { table: 't', createSql: `CREATE TABLE other (id TEXT PRIMARY KEY)` })
      ).toThrow(/createSql 建的是「other」/)
    })

    it('columnMap 指向新表没有的列 / 来源列旧表没有 → 抛', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`)

      expect(() =>
        rebuildTable(db, {
          table: 't',
          createSql: `CREATE TABLE t (id TEXT PRIMARY KEY)`,
          columnMap: [{ to: 'ghost', from: 'id' }],
        })
      ).toThrow(/指向新表不存在的列「ghost」/)

      expect(() =>
        rebuildTable(db, {
          table: 't',
          createSql: `CREATE TABLE t (id TEXT PRIMARY KEY)`,
          columnMap: [{ to: 'id', from: 'ghost' }],
        })
      ).toThrow(/来源列「ghost」在旧表不存在/)
    })

    it('convert 写成通配取值（`*` / `t.*`）→ 抛（禁位置对齐的唯一可达入口）', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
      db.exec(`INSERT INTO t VALUES ('a','x')`)

      for (const convert of ['*', ' t.* ']) {
        expect(() =>
          rebuildTable(db, {
            table: 't',
            createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`,
            columnMap: [{ to: 'v', convert }],
          })
        ).toThrow(/convert 写成了通配取值/)
      }
      // 真空性反对照：表达式里的**引号内星号**不是通配，不许被守卫误伤
      const report = rebuildTable(db, {
        table: 't',
        createSql: `CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`,
        columnMap: [{ to: 'v', convert: `upper(v) || '*'` }],
      })
      expect(report.rows).toBe(1)
      expect(rows('t')).toEqual([{ id: 'a', v: 'X*' }])
    })
  })

  describe('验收 5 · 语句切分（DDL 正文里的分号不是边界）', () => {
    it('splitStatements：引号 / 方括号 / 行注释 / 块注释里的分号都不切', () => {
      expect(
        splitStatements(
          `CREATE TABLE t (a TEXT DEFAULT ';', b TEXT); -- 尾注；带分号\nCREATE INDEX i ON t(a); /* 块；注释 */ CREATE INDEX j ON t(b)`
        )
      ).toEqual([
        `CREATE TABLE t (a TEXT DEFAULT ';', b TEXT)`,
        `-- 尾注；带分号\nCREATE INDEX i ON t(a)`,
        `/* 块；注释 */ CREATE INDEX j ON t(b)`,
      ])
      expect(splitStatements(`CREATE TABLE t ([a;b] TEXT, "c;d" TEXT)`)).toHaveLength(1)
    })

    it('端到端：DDL 里的行内注释（含分号）原样进 sqlite_master', () => {
      db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`)
      db.exec(`INSERT INTO t VALUES ('a','x')`)

      rebuildTable(db, {
        table: 't',
        createSql: `CREATE TABLE t (
          id TEXT PRIMARY KEY,
          -- 行内注释；含分号 ; 的那行
          v TEXT NOT NULL
        )`,
      })

      expect(tableSql('t')).toContain('-- 行内注释；含分号 ; 的那行')
      expect(rows('t')).toEqual([{ id: 'a', v: 'x' }])
    })
  })
})

/**
 * 迁移机制测试（票 `db-schema-governance` 票 1，spec §3.1 / §3.3）。
 *
 * 测试面 = **外部行为**：启动结果（放行/拒启）、台账内容、`sqlite_master` 结构。
 * seam = `initDb()` / `applyMigrations()`，不碰 runner 内部实现。
 *
 * 「老库」怎么造：判据与 runner 的 `isOldDb` **同面**——有用户表 + 无台账，故一律
 * `createTestDb()` 造好全量结构后 `DROP TABLE schema_migrations`。这样测的确实是
 * 「老库路径」，而不是「全新库被自己当成老库」（`test-helpers.ts` 有同款说明）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import fs from 'node:fs'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb, applyMigrations } from './index.js'
import {
  MIGRATIONS,
  CHUNK_VECTOR_METRIC_FIX_SEQUENCE,
  MAIN_DB_REPAIR_ENTRY_NAMES,
  type Migration,
} from './migrations.js'

/**
 * 誊写校验的归一函数：判**词法**，不判排版。空白唯一承载语义的地方是字符串字面量，
 * 而本库 DDL 里没有任何含空白的字面量（列默认值全是 `'[]'` / `'{}'` / `datetime('now')` 这类）。
 * 两者必须与 `__gen-fixture.ts` 里的生成函数**逐字同款**——否则基准与比对不同面。
 */
const canonSql = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()

interface SchemaRow {
  type: string
  name: string
  tblName: string
  sql: string | null
}

/** 全量 sqlite_master 快照（剔除 `sqlite_%` 内部表与台账自身——台账是票 1 新增物） */
function dumpSchema(db: Database.Database): SchemaRow[] {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
       ORDER BY type, name`
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  return rows.map((r) => ({
    type: r.type,
    name: r.name,
    tblName: r.tbl_name,
    sql: r.sql === null ? null : canonSql(r.sql),
  }))
}

const BASELINE: SchemaRow[] = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/schema-baseline.json', import.meta.url), 'utf8')
)

/**
 * 与基准 dump **故意不同面**的物体名单 —— 名单之外的任何形状漂移都必须红。
 *
 * - `idx_messages_session`：票 2 的**同名升级**（两列 → 三列），判据单列在该用例组；
 * - 票 6 批一重建的 7 张叶子表：FK 补链 / 时间口径 ISO 毫秒 / 去时间 DEFAULT 是**故意**
 *   改形，各自的形状由「票 6 · B 范围重建批」用例组单独钉死；
 * - `messages`：票 5 的重建（FK / CHECK / 时间口径），形状由紧随本用例的那段断言钉死；
 * - `sessions`：票 7 的 `ALTER TABLE ADD COLUMN archived_at`——**SQLite 会把新列追加进
 *   `sqlite_master` 里存的建表原文**，故文本必然与冻结基准分叉（基线集本身一字节没动）。
 *   这是「轻量加列」这条路的固有代价，判据单列在下面（取「列在不在」而非「逐字相等」）；
 *   票 8 重建 sessions 时会把该列并进 DDL，届时这条一并撤掉。
 *
 * 写成**显式名单**而不是「跳过这几张表」：将来任何一条追加迁移改了别的表，
 * 都会在这里红出来——这正是「新物体/新形状静默出现」的兜底。
 */
const BASELINE_SHAPE_DIVERGENCE = new Set<string>([
  'index:idx_messages_session',
  'table:messages',
  'table:sessions',
  'table:execution_logs',
  'table:flow_states',
  'table:flow_state_events',
  'table:connector_bindings',
  'table:episode_attributions',
  'table:review_verdicts',
  'table:review_parse_failures',
])

/** 台账全量（name → note） */
function ledger(db: Database.Database): Array<{ name: string; note: string | null }> {
  return db.prepare(`SELECT name, note FROM schema_migrations ORDER BY rowid`).all() as Array<{
    name: string
    note: string | null
  }>
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

function tableSqlOf(db: Database.Database, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql: string } | undefined
  return row?.sql ?? ''
}

/** 「老库」= 有用户表 + 无台账（与 runner 的 isOldDb 判据同面） */
function makeOldDb(): Database.Database {
  const db = createTestDb()
  db.exec(`DROP TABLE schema_migrations`)
  return db
}

/**
 * 「台账上船那一刻的老库」= `makeOldDb()` **再退回台账之后追加的结构**。
 *
 * 为什么需要单独一个：`createTestDb()` 给的是**当前**全量结构，而真实老库只有**台账上船
 * 那一刻**的结构——台账之后追加的物体它一概没有。票 2 之前追加区只有 `CREATE INDEX
 * IF NOT EXISTS`，这个虚构看不出来（真执行也只是 no-op）；票 7 的 `archived_at` 是追加区里
 * 唯一的**加列**条目，虚构当场显形：夹具「已有该列」⇒ 探针如实报「效果已成立」⇒ 跳过执行。
 * 要测「追加条目在老库上真执行」，夹具就得真的是老库。
 */
function makePreLedgerDb(): Database.Database {
  const db = makeOldDb()
  db.exec('DROP INDEX IF EXISTS idx_sessions_active')
  db.exec('ALTER TABLE sessions DROP COLUMN archived_at')
  return db
}

/** 全新库（空库，无任何用户表）。与生产同款：vec0 虚拟表要求扩展先加载。 */
function makeFreshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  sqliteVec.load(db)
  return db
}

describe('db/migrations —— 迁移机制立闸（票 1）', () => {
  beforeEach(() => {
    setDb(createTestDb())
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 1 · 压扁誊写校验 ───────────────────────────────────────────
  describe('验收 1 · 空库重放基线集 = 改动前产物（压扁誊写校验）', () => {
    it('空库重放基线集 → sqlite_master 与改动前旧码 dump 逐行一致', () => {
      setDb(makeFreshDb())
      // ⚠️ 判据面是**基线集**（票 1 的原文就是「空库重放基线集」），故只重放 baseline 条目。
      // 票 2 起追加区非空，若把追加条目也放进来，基准就不再是「改动前旧码产物」了——
      // 那不是本用例要判的东西（追加区的产出由下面那条用例单独穷举钉死）。
      applyMigrations(
        getDb(),
        MIGRATIONS.filter((m) => m.baseline === true)
      )

      const actual = dumpSchema(getDb())
      // 逐表比而不是整包比：失败时报出**是哪张表**不一致，而不是一句 toEqual 大 diff
      const byName = new Map(actual.map((r) => [`${r.type}:${r.name}`, r]))
      for (const expected of BASELINE) {
        expect(
          byName.get(`${expected.type}:${expected.name}`),
          `${expected.type} ${expected.name}`
        ).toEqual(expected)
      }
      expect(actual).toHaveLength(BASELINE.length)
    })

    it('空库跑完整 initDb → 基线 47 件之上追加区净增 3 件，且两列索引已升成三列', () => {
      setDb(makeFreshDb())
      initDb()

      const actual = dumpSchema(getDb())
      const baselineKeys = new Set(BASELINE.map((r) => `${r.type}:${r.name}`))
      const added = actual.filter((r) => !baselineKeys.has(`${r.type}:${r.name}`))
      // 穷举清单（票 2 + 票 7 追加区迁移的净产出）：
      //   - `idx_messages_session` 是**同名升级**（DROP 旧两列 + 建新三列）⇒ 物体数不变、定义变；
      //   - 票 5 的 `messages` 重建是**同名重建** ⇒ 物体数不变（形状变）；
      //   - fix-forward 条目对已齐件的库是 14 个 `IF NOT EXISTS` no-op ⇒ 零产出
      //     （该条**不挂探针**，走的是「真执行 no-op」，见 `migrations.ts` 该条上方注释）；
      //   - 票 7 的 `sessions archived_at` 是加列 ⇒ `sqlite_master` 里**不产生物体**（列不是物体）；
      //   - 其余三条索引各 +1。
      // 将来往追加区加迁移**必须来改这里**——否则新物体静默出现，没人知道结构被谁改了。
      expect(added.map((r) => `${r.type}:${r.name}`)).toEqual([
        'index:idx_execution_logs_session_started',
        'index:idx_execution_logs_status',
        'index:idx_sessions_active',
      ])
      // 「升级」的判据是定义本身：末列 `id` 是游标 tie-break，两列版里没有
      expect(actual.find((r) => r.name === 'idx_messages_session')?.sql).toContain(
        'session_id,created_at,id'
      )
    })

    it('基准本身就是 24 表 + 14 索引 + 9 张虚拟表影子表（防基准被误再生成成空壳）', () => {
      expect(BASELINE.filter((r) => r.type === 'table')).toHaveLength(33)
      expect(BASELINE.filter((r) => r.type === 'index')).toHaveLength(14)
    })

    it('全新库跑完：台账行数 = 数组长度、note 全空（不是补登）', () => {
      setDb(makeFreshDb())
      initDb()
      const rows = ledger(getDb())
      expect(rows).toHaveLength(MIGRATIONS.length)
      expect(rows.every((r) => r.note === null)).toBe(true)
    })

    it('数组纪律：name 是台账主键 ⇒ 不得重名；只许追加', () => {
      expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length)
    })

    it('基线集条数冻结 = 41（压扁产物是封存的历史：往里加条目 = 老库会静默跳过它）', () => {
      const baseline = MIGRATIONS.filter((m) => m.baseline === true)
      expect(baseline).toHaveLength(41)
      // 基线标记是**结构上**盖的（拼接点统一盖），且必须盖在数组前段：追加区在尾巴上
      expect(MIGRATIONS.slice(0, baseline.length).every((m) => m.baseline === true)).toBe(true)
    })

    it('票 10 · ticket 标记：追加区每条必有、基线区一律不补（fail-loud，忘标当场红）', () => {
      const appended = MIGRATIONS.filter((m) => m.baseline !== true)
      const baseline = MIGRATIONS.filter((m) => m.baseline === true)

      // 前提：两段都非空 —— 否则下面两条 `every` 恒真（空集上恒真正是本仓点名的假绿门形态）
      expect(appended.length).toBeGreaterThan(0)
      expect(baseline.length).toBeGreaterThan(0)

      // 追加区：每条必有非空 ticket。数组形态的断言（而非 every）是为了失败时**列出是谁**——
      // `every` 只回一句 false，忘标的那条还得自己去数组里数。
      expect(appended.filter((m) => !m.ticket).map((m) => m.name)).toEqual([])
      // 票号形态：挡 `t6` / `T6 ` / 全角 `Ｔ6` 这类手滑。拼错的票号不会让上面那条红
      // （它是「非空」判断），但会让各票自己的 `filter` 静默少收 —— 从这条兜住。
      expect(
        [...new Set(appended.map((m) => m.ticket))].filter((t) => !/^T\d+$/.test(t as string))
      ).toEqual([])

      // 反向对照：基线区**一律不补** —— 若给 41 条基线逐条补票号，等于在「41 条基线」这层
      // 再造一个逐条手写面（正是本票要拆的那类必撞点）。
      expect(baseline.filter((m) => m.ticket !== undefined).map((m) => m.name)).toEqual([])
    })

    it('基线探针清单 = 审计定稿的 3 条（重建类静默失败型），多一条少一条都要改审计结论', () => {
      expect(
        MIGRATIONS.filter((m) => m.verify !== undefined && m.baseline === true).map((m) => m.name)
      ).toEqual([
        'widen review_verdicts verdict CHECK (comment)',
        'chunk_vectors distance_metric=cosine (量纲校正)',
        'drop memories chain tables (票辛 旧链下线)',
      ])
    })

    // 追加区的探针是**另一类**：不是静默失败型，而是「无 IF NOT EXISTS 的加列」——库里已有
    // 该列但台账无记录时，它会永久拒启（`duplicate column name`），探针把这条路径收敛成
    // 「跳过 + 登记」。清单单列一份，别与基线那 3 条混成一锅。
    it('追加区探针清单 = 1 条（票 7 加列条目），与基线三类失败形态不同', () => {
      expect(
        MIGRATIONS.filter((m) => m.verify !== undefined && m.baseline !== true).map((m) => m.name)
      ).toEqual(['sessions archived_at 列（归档 = 用户态删除）'])
    })

    it('量纲校正条目正文 = 导出序列按序拼接（测试判据面 = 生产导出，改序即改被测对象）', () => {
      const entry = MIGRATIONS.find((m) => m.name.includes('distance_metric=cosine'))
      expect(entry?.sql).toBe(CHUNK_VECTOR_METRIC_FIX_SEQUENCE.join(';\n'))
    })
  })

  // ─── 验收 2 · 老库 baseline 补登 + 探针矫正 ──────────────────────────
  describe('验收 2 · 老库补登（只登记不执行）+ 探针矫正', () => {
    it('老库：基线逐条只登记（note=baseline）、不重复执行、数据原样', () => {
      const db = makeOldDb()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES ('a1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk')`
      ).run()
      db.prepare(`INSERT INTO sessions (id, title) VALUES ('s1', '会话')`).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 's1', 'user', '原话')`
      ).run()
      // 「未重复执行」的**可证伪**现场：老库缺一张表（模拟更早版本升级上来的库），
      // 基线若真跑过，这张表会被建回来
      db.exec(`DROP TABLE chunks`)

      setDb(db)
      initDb()

      const rows = ledger(db)
      expect(rows).toHaveLength(MIGRATIONS.length)
      // 只登记不执行**只认基线条目**：基线条目全 `baseline` ⇒ note='baseline'；
      // 追加区条目（`baseline !== true` 的全部——补建 / 票 2 索引 / 票 5 重建 / 票 6 批一 /
      // 票 7 归档）在任何库上都走增量路径真执行，note 恒空（判据按标记分面，不按名单枚举，
      // 故新票往追加区接条目不会让这条失真）
      const baselineNames = new Set(
        MIGRATIONS.filter((m) => m.baseline === true).map((m) => m.name)
      )
      expect(rows.filter((r) => baselineNames.has(r.name))).toHaveLength(41)
      expect(
        rows.filter((r) => baselineNames.has(r.name)).every((r) => r.note === 'baseline')
      ).toBe(true)
      expect(rows.filter((r) => !baselineNames.has(r.name)).every((r) => r.note === null)).toBe(
        true
      )
      expect(tableNames(db)).not.toContain('chunks') // 基线没执行
      expect(db.prepare(`SELECT COUNT(*) n FROM agents`).get()).toEqual({ n: 1 })
      expect(db.prepare(`SELECT content FROM messages WHERE id = 'm1'`).get()).toEqual({
        content: '原话',
      })
    })

    it('探针矫正 · widen：旧 CHECK 的 review_verdicts → 真执行放宽、旧行保住', () => {
      const db = makeOldDb()
      // 父行前置（票 6 起 review_verdicts 的 message_id/session_id/reviewer_agent_id 都是
      // RESTRICT 外键）：缺父行的旧行会被重建条目的 D1 孤儿清理删掉，那就测不到「放宽」了。
      db.exec(`
        INSERT INTO sessions (id, title, agent_ids) VALUES ('s1', 't', '[]');
        INSERT INTO agents (id, name, system_prompt, llm_api_key)
          VALUES ('r1', '吐槽猫', 'p', 'sk');
        INSERT INTO messages (id, session_id, role, content, mentions)
          VALUES ('m-old', 's1', 'agent', 'x', '[]'), ('m-new', 's1', 'agent', 'x', '[]');
      `)
      db.exec(`
        DROP TABLE review_verdicts;
        CREATE TABLE review_verdicts (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          reviewer_agent_id TEXT NOT NULL,
          subject_agent_id TEXT,
          verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'suggest', 'reject')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict)
          VALUES ('m-old', 's1', 'r1', 'suggest');
      `)

      setDb(db)
      initDb()

      expect(tableSqlOf(db, 'review_verdicts')).toContain("'comment'")
      // 旧行保住，且**时间列随重建条目的无损转换**从秒级变 ISO 毫秒（⑤-b 首段实证）
      const old = db
        .prepare(`SELECT verdict, created_at FROM review_verdicts WHERE message_id='m-old'`)
        .get() as { verdict: string; created_at: string }
      expect(old.verdict).toBe('suggest')
      expect(old.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(() =>
        db
          .prepare(
            `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict, created_at)
             VALUES ('m-new', 's1', 'r1', 'comment', '2026-09-01T00:00:00.000Z')`
          )
          .run()
      ).not.toThrow()
      expect(ledger(db).find((r) => r.name.includes('widen'))?.note).toBe('baseline')
    })

    it('探针矫正 · 量纲：L2 的 chunk_vectors → 真执行重建 cosine、三表同清', () => {
      const db = makeOldDb()
      db.prepare(
        `INSERT INTO chunks (doc_path, section_anchor, content_hash, origin_id, part_index, part_total, body, breadcrumb)
         VALUES ('docs/adr/0001-a.md', '## 决策', 'h1', 'blob1', 1, 1, '正文', 'docs/adr/0001-a.md > 决策')`
      ).run()
      db.exec(`DROP TABLE chunk_vectors`)
      db.exec(
        `CREATE VIRTUAL TABLE chunk_vectors USING vec0(
           chunk_id INTEGER PRIMARY KEY, embedding float[512]
         )`
      )
      const countAll = () => [
        (db.prepare(`SELECT COUNT(*) n FROM chunks`).get() as { n: number }).n,
        (db.prepare(`SELECT COUNT(*) n FROM chunks_fts`).get() as { n: number }).n,
        (db.prepare(`SELECT COUNT(*) n FROM chunk_vectors`).get() as { n: number }).n,
      ]
      expect(tableSqlOf(db, 'chunk_vectors')).not.toContain('distance_metric=cosine')

      setDb(db)
      initDb()

      expect(tableSqlOf(db, 'chunk_vectors')).toContain('distance_metric=cosine')
      // 向量行没了的 chunks 行必须一起清掉，否则扫描器按 origin_id 判「没变」永远跳过
      expect(countAll()).toEqual([0, 0, 0])
    })

    it('探针矫正 · 死表：老库残留 memories / memories_fts → 真执行 DROP', () => {
      const db = makeOldDb()
      db.exec(`
        CREATE TABLE memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL);
        CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='unicode61');
      `)

      setDb(db)
      initDb()

      expect(tableNames(db)).not.toContain('memories')
      expect(tableNames(db)).not.toContain('memories_fts')
    })

    it('老库已是目标形态 → 三条探针全 true，一条都不执行（台账里没有矫正痕迹）', () => {
      const db = makeOldDb()
      setDb(db)
      initDb()
      // 帮凶判据：探针条目若被误判 false，量纲校正会清 chunks 三表 —— 用行数做探针
      expect(ledger(db)).toHaveLength(MIGRATIONS.length)
      expect(tableSqlOf(db, 'chunk_vectors')).toContain('distance_metric=cosine')
    })
  })

  // ─── ②-a × ②-b 岔路 · 「只登记不执行」只认基线条目 ────────────────────
  describe('②-a × ②-b 岔路 · 老库撞上含有追加条目的数组', () => {
    /** 一条台账立闸后才追加的迁移（不带 `baseline` 标记 = 从未在任何老库上发生过） */
    const appended: Migration = {
      name: 'append fix-forward (跳版本升级)',
      sql: `CREATE TABLE appended_side_effect (id TEXT PRIMARY KEY)`,
    }

    it('老库 + 追加条目 → 追加条目真执行；同一次启动里基线条目仍只登记（真伪对照）', () => {
      const db = makeOldDb()
      // 对照面：老库缺一张基线表。基线若被误执行，这张表会被建回来
      db.exec(`DROP TABLE chunks`)

      setDb(db)
      applyMigrations(db, [...MIGRATIONS, appended])

      // 追加条目：真执行（结构建出来了 + 台账 note 为空 = 不是补登行）
      expect(tableNames(db)).toContain('appended_side_effect')
      expect(ledger(db).find((r) => r.name === appended.name)?.note).toBeNull()
      // 对照组：同一次启动、同一个老库判据下，基线条目照旧不执行
      expect(tableNames(db)).not.toContain('chunks')
      expect(ledger(db).find((r) => r.name === 'chunks table (段三切片索引)')?.note).toBe(
        'baseline'
      )
    })

    it('老库 + 追加条目 + 探针报效果已成立 → 只登记不执行（与全新库同一判据，②-a 路径一致）', () => {
      const db = makeOldDb()
      // 现实中这条路径怎么发生：该追加迁移的效果被手工 SQL 提前做掉了
      db.exec(`ALTER TABLE settings ADD COLUMN probe_marker TEXT`)
      const alreadyApplied: Migration = {
        name: 'append add column (效果已手工提前成立)',
        // 真执行必撞 duplicate column name ⇒ 拒启。故「不抛 + 列没有变成两遍」就是
        // 「没执行」的硬证据——比断言某张表不存在更难自证
        sql: `ALTER TABLE settings ADD COLUMN probe_marker TEXT`,
        verify: (d) => tableSqlOf(d, 'settings').includes('probe_marker'),
      }

      setDb(db)
      expect(() => applyMigrations(db, [...MIGRATIONS, alreadyApplied])).not.toThrow()

      // 探针 true ⇒ 效果已成立 ⇒ 跳过执行只登记（note 为空：它不是老库过户产物）
      expect(ledger(db).find((r) => r.name === alreadyApplied.name)?.note).toBeNull()
      expect(tableSqlOf(db, 'settings').match(/probe_marker/g)).toHaveLength(1)
    })

    it('追加条目的失败照样拒启：老库路径不是「跳过」的遮阳伞', () => {
      const db = makeOldDb()
      const broken: Migration = {
        name: 'append that fails',
        sql: `ALTER TABLE no_such_table ADD COLUMN x TEXT`,
      }
      setDb(db)
      expect(() => applyMigrations(db, [...MIGRATIONS, broken])).toThrowError(/append that fails/)
    })
  })

  // ─── 补建迁移 · 主库缺件补回（票 1 OQ1 / 店长裁决 ②）──────────────────
  describe('补建迁移 · 主库形态（老库 + 缺 14 件物体）', () => {
    const REPAIR_NAME = 'fix-forward 补建 retrieval_*/spans 五表九索引（票 1 OQ1）'
    const repairEntry = MIGRATIONS.find((m) => m.name === REPAIR_NAME) as Migration

    /**
     * 追加区在**齐件库**上的净增物体数（票 2 起 = 3：`idx_execution_logs_session_started` /
     * `idx_execution_logs_status` / 票 7 的 `idx_sessions_active`；`idx_messages_session` 是
     * 同名升级 ⇒ 物体数不变，票 5 的 `messages` 重建同理，票 7 的加列不是物体）。
     * 追加区的**权威清单**在「验收 1 · 空库跑完整 initDb → 净增 3 件」那条穷举用例里；
     * 这里只拿它把 ds猫 侧「齐件库 = 47 件」的旧读数换算到追加区上线后的口径。
     */
    const APPENDED_NET_OBJECTS = 3

    /** 补建目标 = 5 表 + 9 索引，**顺序 = 建表依赖序**（FK 目标先建） */
    const EXPECTED_OBJECTS = [
      'retrieval_events',
      'idx_retrieval_events_execution',
      'idx_retrieval_events_created',
      'idx_retrieval_events_task',
      'retrieval_queries',
      'retrieval_candidates',
      'idx_retrieval_candidates_query',
      // ⚠️ 索引名与条目名不同面：条目叫 `…_content_hash`，建出来的索引叫 `…_hash`
      'idx_retrieval_candidates_hash',
      'spans',
      'span_llm',
      'idx_spans_execution',
      'idx_spans_chain',
      'idx_spans_start',
      'idx_spans_name',
    ]

    /**
     * 主库形态的**因果造法**：段四/段五上船前就停机的库 = 那 14 条基线从未执行过。
     * 故直接从数组里摘掉这些条目跑一遍（而不是建好再 DROP——DROP 是「事后抹掉」，
     * 摘条目是「从未发生」，与真实来路同面），再摘掉台账（票 1 才有它）。
     */
    function makeMainDbLike(): Database.Database {
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      sqliteVec.load(db)
      const skip = new Set<string>([...MAIN_DB_REPAIR_ENTRY_NAMES, REPAIR_NAME])
      applyMigrations(
        db,
        MIGRATIONS.filter((m) => !skip.has(m.name))
      )
      db.exec(`DROP TABLE schema_migrations`)
      return db
    }

    it('造出来的「主库形态」确实是缺这 14 件的老库（防夹具自己失真）', () => {
      const db = makeMainDbLike()
      const names = new Set(
        (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
            .all() as Array<{
            name: string
          }>
        ).map((r) => r.name)
      )
      // 缺件面：14 件物体一件都不在；且无台账 ⇒ 命中 isOldDb
      for (const obj of EXPECTED_OBJECTS) expect(names.has(obj), obj).toBe(false)
      expect(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'`).get()
      ).toBeUndefined()
      // 存量面：其余结构在（47 − 14 = 33，实测主库读数即 33；追加区的净增物体另计，
      // 见 `APPENDED_NET_OBJECTS`）
      expect(dumpSchema(db)).toHaveLength(
        BASELINE.length - EXPECTED_OBJECTS.length + APPENDED_NET_OBJECTS
      )
    })

    it('主库形态跑 initDb → 14 件全部建回，且形状与基准逐行一致、存量数据原样', () => {
      const db = makeMainDbLike()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES ('a1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk')`
      ).run()

      setDb(db)
      initDb()

      // ① 一件不少：全量 dump 与基准（改动前旧码产物）逐行一致 —— 既证「补回来了」，
      //    也证「补出来的形状就是基线形状」，不存在第二份 DDL 走样的可能
      const actual = dumpSchema(db)
      expect(actual).toHaveLength(BASELINE.length + APPENDED_NET_OBJECTS)
      const byName = new Map(actual.map((r) => [`${r.type}:${r.name}`, r]))
      // 名单之外的物体**逐行等于基准**（白名单见 `BASELINE_SHAPE_DIVERGENCE`）
      const drifted = BASELINE.filter((e) => !BASELINE_SHAPE_DIVERGENCE.has(`${e.type}:${e.name}`))
        .filter((e) => JSON.stringify(byName.get(`${e.type}:${e.name}`)) !== JSON.stringify(e))
        .map((e) => `${e.type}:${e.name}`)
      expect(drifted).toEqual([])
      // 白名单里的物体必须**在**（只是形状不同）——防「表丢了却因跳过而假绿」
      for (const key of BASELINE_SHAPE_DIVERGENCE) {
        expect(byName.get(key), key).toBeDefined()
      }
      expect(byName.get('index:idx_messages_session')?.sql).toContain('session_id,created_at,id')

      // 票 5 重建后的 `messages` 形状 —— 也是**老库路径上 append 真执行**最硬的结构证据：
      // 基线补登（只登记不执行）不会改形状，这段文字只可能来自重建条目的真执行。
      const messagesSql = byName.get('table:messages')?.sql ?? ''
      expect(messagesSql).toContain('agent_id TEXT REFERENCES agents(id)ON DELETE RESTRICT')
      expect(messagesSql).toContain("CHECK(dispatch_state IN('queued','running','done'))")
      expect(messagesSql).toContain(
        "created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      )
      // 表名被 SQLite 写成带引号形式（RENAME 扶正的固有产物，票 4 OQ4 已留痕）——两条启动
      // 路径（全新库重放 / 老库增量）都经过同一次重建，故终点形状逐字相同。
      expect(messagesSql.startsWith('CREATE TABLE "messages"')).toBe(true)

      // 票 7 加列后的 `sessions` 形状——同样是 append 真执行的结构证据（基线补登不改形状）。
      // 判据取「列在不在」而不是「文本与基准逐字相等」：`ALTER TABLE ADD COLUMN` 的产物
      // 就是基线原文 + 追加列，文本必然分叉（见上方 skip 处的理由）。
      const sessionsSql = byName.get('table:sessions')?.sql ?? ''
      expect(sessionsSql).toContain('archived_at TEXT')
      // 归档不重建 old 表 ⇒ 基线的 9 列一列不少（防「加列」误写成「重建丢列」）
      for (const col of [
        'agent_ids',
        'broadcast_mode',
        'running_summary',
        'handoff_from',
        'summary_msg_id',
        'compressed_summaries',
      ]) {
        expect(sessionsSql, col).toContain(col)
      }

      // ② 台账：41 条补登 + 1 条真执行（补建），补建行**不是**补登
      const rows = ledger(db)
      expect(rows).toHaveLength(MIGRATIONS.length)
      expect(rows.filter((r) => r.note === 'baseline')).toHaveLength(41)
      expect(rows.find((r) => r.name === REPAIR_NAME)?.note).toBeNull()

      // ③ 手术不动存量数据
      expect(db.prepare(`SELECT COUNT(*) n FROM agents`).get()).toEqual({ n: 1 })
    })

    it('补建正文 = 恰好这 14 件物体（防漏防多）、条条 IF NOT EXISTS、顺序 = 依赖序', () => {
      const stmts = repairEntry.sql.split(';\n')
      expect(stmts).toHaveLength(EXPECTED_OBJECTS.length)
      const created = stmts.map((s) => {
        const m = /^\s*CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(s)
        expect(m, `不是 IF NOT EXISTS 建表/建索引：${s}`).not.toBeNull()
        return (m as RegExpExecArray)[1]
      })
      expect(created).toEqual(EXPECTED_OBJECTS)
    })

    it('已完整的库（全新库 / dev 库）：补建是 no-op，不新增任何物体', () => {
      setDb(makeFreshDb())
      initDb()
      expect(dumpSchema(getDb())).toHaveLength(BASELINE.length + APPENDED_NET_OBJECTS)
      expect(ledger(getDb()).find((r) => r.name === REPAIR_NAME)?.note).toBeNull()
    })
  })

  // ─── 验收 3 · 拒启 ──────────────────────────────────────────────────
  describe('验收 3 · 失败拒启 / 篡改拒启', () => {
    it('注入失败迁移 → 抛错带迁移名 + SQLite 原错；整条事务回滚', () => {
      setDb(makeFreshDb())
      initDb() // 先把基线跑完，只留注入的那条未登记

      const broken: Migration = {
        name: 'boom injection',
        sql: `CREATE TABLE boom_side_effect (id TEXT PRIMARY KEY);
              ALTER TABLE no_such_table ADD COLUMN x TEXT`,
      }
      expect(() => applyMigrations(getDb(), [...MIGRATIONS, broken])).toThrowError(
        /boom injection[\s\S]*no such table: no_such_table/
      )
      // 「一个事务」的判据：前半句建出的表必须随 ROLLBACK 消失，且台账不登记
      expect(tableNames(getDb())).not.toContain('boom_side_effect')
      expect(ledger(getDb()).map((r) => r.name)).not.toContain('boom injection')
    })

    it('篡改已登记条目（改一个字节）→ 拒启 + fix-forward 提示', () => {
      setDb(makeFreshDb())
      initDb()

      const tampered = MIGRATIONS.map((m) =>
        m.name === 'agents table' ? { ...m, sql: m.sql.replace('DEFAULT 2048', 'DEFAULT 4096') } : m
      )
      expect(() => applyMigrations(getDb(), tampered)).toThrowError(
        /迁移「agents table」落地后被修改[\s\S]*fix-forward/
      )
    })

    it('中止的首次启动（台账只落了一部分）→ 续跑补齐剩余条目，不重复登记', () => {
      setDb(makeFreshDb())
      const db = getDb()
      applyMigrations(db, MIGRATIONS.slice(0, 3))
      expect(ledger(db)).toHaveLength(3)

      applyMigrations(db, MIGRATIONS)

      expect(ledger(db)).toHaveLength(MIGRATIONS.length)
      expect(tableNames(db)).toContain('spans')
    })
  })

  // ─── 验收 4 · 重复启动幂等 ──────────────────────────────────────────
  describe('验收 4 · 重复启动零副作用', () => {
    it('连跑三次 initDb()：不抛、台账不增长、结构不变', () => {
      const db = getDb()
      initDb()
      const before = dumpSchema(db).length
      const n = ledger(db).length

      expect(() => initDb()).not.toThrow()
      expect(() => initDb()).not.toThrow()

      expect(dumpSchema(db)).toHaveLength(before)
      expect(ledger(db)).toHaveLength(n)
    })
  })

  // ─── 验收 5 · 唯一 schema 真相源（静态源断言）────────────────────────
  describe('验收 5 · CREATE TABLE 独立块已删，迁移数组是唯一 schema 真相源', () => {
    /** 剥掉行注释与块注释行——只对**代码**判 DDL 关键词（注释里提一句不算违规） */
    function codeLines(file: URL): string {
      const src = fs.readFileSync(file, 'utf8')
      return src
        .split('\n')
        .filter((l) => {
          const t = l.trim()
          return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
        })
        .join('\n')
    }

    it('db/index.ts 里一句建表/改表语句都没有（台账 DDL 也在 migrations.ts）', () => {
      const code = codeLines(new URL('./index.ts', import.meta.url))
      expect(code).not.toMatch(
        /CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE/i
      )
    })

    it('全部 24 张用户表的建表语句都出自 migrations.ts', () => {
      const mig = codeLines(new URL('./migrations.ts', import.meta.url))
      const userTables = BASELINE.filter(
        (r) => r.type === 'table' && !/^(chunk_vectors_|chunks_fts_)/.test(r.name)
      )
      expect(userTables).toHaveLength(24)
      for (const table of userTables) {
        const virtual = table.sql?.startsWith('CREATE VIRTUAL TABLE') === true
        const needle = virtual
          ? `CREATE VIRTUAL TABLE IF NOT EXISTS ${table.name} USING`
          : `CREATE TABLE IF NOT EXISTS ${table.name} (`
        expect(mig, table.name).toContain(needle)
      }
    })
  })

  // ─── 票 2 · 索引三条（追加区首次实战）─────────────────────────────────
  describe('票 2 · 索引三条（追加区首次实战）', () => {
    /** 库内是否存在该物体（与 `verify` 探针同面：`sqlite_master` 的 type + name） */
    const has = (db: Database.Database, type: string, name: string): boolean =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) !==
      undefined

    const sqlOf = (db: Database.Database, name: string): string =>
      (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as
          { sql: string } | undefined
      )?.sql ?? ''

    /** `EXPLAIN QUERY PLAN` 的 detail 列表（带参绑定，与生产调用同形） */
    function plan(db: Database.Database, sql: string, params: unknown[]): string[] {
      return (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
      ).map((r) => r.detail)
    }

    /** 全表扫判据：任一 detail 出现 `SCAN` 即红（`SEARCH … USING INDEX` 合格） */
    const scansIn = (details: string[]): string[] => details.filter((d) => /\bSCAN\b/.test(d))

    // ─── 验收 1 · 三条索引服务的查询无 SCAN ────────────────────────────
    describe('验收 1 · 三条索引服务的查询 EXPLAIN QUERY PLAN 无 SCAN', () => {
      it('messages 会话历史 + 游标 tie-break → 走三列索引、无 SCAN、无临时 B 树排序', () => {
        // SQL 逐字对应 `repository/messages.ts` 的 getSessionMessagesRange（下方源断言钉着它没漂）
        const details = plan(
          getDb(),
          `SELECT * FROM messages
           WHERE session_id = ? AND role != 'system'
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          ['s1', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'm0', 200]
        )
        expect(scansIn(details)).toEqual([])
        expect(details.join('\n')).toContain('idx_messages_session')
        // 三列版的**增量价值**：末列 `id` 进了索引 ⇒ 游标谓词与 ORDER BY 的 tie-break
        // 都由索引顺序满足，不再需要 `USE TEMP B-TREE FOR ORDER BY`（两列版做不到）
        expect(details.filter((d) => /TEMP B-TREE/i.test(d))).toEqual([])
      })

      it('execution_logs 会话级取数 → 走 (session_id, started_at)、无 SCAN', () => {
        // 对应 `repository/executionLogs.ts` 的 getExecutionsBySession / getLatestExecutionPerAgent
        const details = plan(
          getDb(),
          `SELECT id, agent_id, status, started_at, ended_at, latency_ms
           FROM execution_logs WHERE session_id = ?`,
          ['s1']
        )
        expect(scansIn(details)).toEqual([])
        expect(details.join('\n')).toContain('idx_execution_logs_session_started')
      })

      it('running 计数（重启判据主查询）→ 走 idx_execution_logs_status、无 SCAN', () => {
        // 逐字对应 `scripts/dev.js` 的重启保护窗查询（下方源断言钉着它没漂）
        const details = plan(
          getDb(),
          `SELECT COUNT(*) AS cnt FROM execution_logs WHERE status = 'running'`,
          []
        )
        expect(scansIn(details)).toEqual([])
        expect(details.join('\n')).toContain('idx_execution_logs_status')
      })

      it('三处被判查询在源文件里仍是同一句（防「测试测的是手抄副本」——判据面与被判面同面）', () => {
        const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
        expect(read('./repository/messages.ts')).toContain(
          '(created_at < ? OR (created_at = ? AND id < ?))'
        )
        expect(read('./repository/executionLogs.ts')).toContain('WHERE session_id = ?')
        expect(read('../../../../scripts/dev.js')).toContain(
          "SELECT COUNT(*) AS cnt FROM execution_logs WHERE status = 'running'"
        )
      })
    })

    // ─── 验收 2 · 老库路径 append 真执行 ───────────────────────────────
    describe('验收 2 · 老库路径：追加区条目真执行（append-only 首次实战）', () => {
      it('无台账老库（三条索引先删掉）→ initDb 真建上、两列版升成三列，登记 note 全空', () => {
        const db = makeOldDb()
        // 「真执行」的可证伪现场：索引先删掉，不执行就**不会**存在（存在性即硬证据）
        db.exec(`DROP INDEX IF EXISTS idx_messages_session`)
        expect(has(db, 'index', 'idx_messages_session')).toBe(false)

        setDb(db)
        initDb()

        expect(sqlOf(db, 'idx_messages_session')).toContain('session_id, created_at, id')
        expect(has(db, 'index', 'idx_execution_logs_session_started')).toBe(true)
        expect(has(db, 'index', 'idx_execution_logs_status')).toBe(true)
        // 追加区条目**不是**老库过户产物 ⇒ note 恒空（「只登记不执行」只认基线条目）
        const rows = ledger(db)
        for (const name of [
          'idx_messages_session upgrade (session_id, created_at, id)',
          'idx_execution_logs_session_started',
          'idx_execution_logs_status',
        ]) {
          expect(rows.find((r) => r.name === name)?.note, name).toBeNull()
        }
      })

      it('票 1 已补登过的库（台账只有 baseline 行）→ 追加条目照样真执行（主库真实升级路径）', () => {
        const db = makeOldDb()
        // ① 票 1 的代码先跑过一次：基线只登记不执行 —— 这正是主库今天的台账形态
        applyMigrations(
          db,
          MIGRATIONS.filter((m) => m.baseline === true)
        )
        // ② 票 2 上船时，索引还是旧形态 / 压根没有（老机制静默失败的残骸）
        db.exec(`DROP INDEX IF EXISTS idx_messages_session`)
        db.exec(`DROP INDEX IF EXISTS idx_execution_logs_session_started`)
        db.exec(`DROP INDEX IF EXISTS idx_execution_logs_status`)

        applyMigrations(db, MIGRATIONS)

        expect(sqlOf(db, 'idx_messages_session')).toContain('session_id, created_at, id')
        expect(has(db, 'index', 'idx_execution_logs_session_started')).toBe(true)
        expect(has(db, 'index', 'idx_execution_logs_status')).toBe(true)
        const rows = ledger(db)
        expect(rows).toHaveLength(MIGRATIONS.length)
        // baseline 行仍是补登（没被这轮覆盖），追加行 note 全空
        expect(rows.find((r) => r.name === 'chunks table (段三切片索引)')?.note).toBe('baseline')
        for (const name of [
          'idx_messages_session upgrade (session_id, created_at, id)',
          'idx_execution_logs_session_started',
          'idx_execution_logs_status',
        ]) {
          expect(rows.find((r) => r.name === name)?.note, name).toBeNull()
        }
      })
    })

    // ─── OQ4 · 汇总播报的「追加区真执行」计数 ──────────────────────────
    describe('OQ4 · 汇总播报「追加区迁移真执行：N 条」与实际一致', () => {
      /** 抓 `[db]` 播报行（只认这一面，不把其他 console 输出混进来） */
      function migrationLogs(fn: () => void): string[] {
        const lines: string[] = []
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
          lines.push(args.map((a) => String(a)).join(' '))
        })
        try {
          fn()
        } finally {
          spy.mockRestore()
        }
        return lines.filter((l) => l.startsWith('[db]'))
      }

      const appendedLine = (lines: string[]): string | undefined =>
        lines.find((l) => l.startsWith('[db] 追加区迁移真执行：'))

      it('N 条真执行：老库 + 追加区首次上船 → 播报条数 = 追加区条目数（不是 0）', () => {
        // 夹具必须是**台账上船那一刻**的老库：`makeOldDb()` 带的是当前全量结构，票 7 的
        // 加列条目会因探针报「已成立」而跳过（那是另一条用例的面，见「票 7 · 归档」）。
        const db = makePreLedgerDb()
        const total = MIGRATIONS.filter((m) => m.baseline !== true).length
        // 真空性反对照：追加区若为空，下面的断言恒等于「0 条」而假绿
        expect(total).toBeGreaterThan(0)

        const lines = migrationLogs(() => {
          setDb(db)
          initDb()
        })

        expect(appendedLine(lines)).toBe(`[db] 追加区迁移真执行：${total} 条`)
        // OQ4 是**补**一行：老库补登那行照旧并存，没被顶掉
        expect(lines.some((l) => l.startsWith('[db] 老库补登：'))).toBe(true)
      })

      it('0 条真执行：库已最新再跑一次 → 播报 0 条，不谎报「修了什么」', () => {
        const db = makeFreshDb()
        setDb(db)
        initDb() // 首次：全部落地

        const lines = migrationLogs(() => applyMigrations(db))

        expect(appendedLine(lines)).toBe('[db] 追加区迁移真执行：0 条')
        expect(lines.some((l) => l.startsWith('[db] migrated:'))).toBe(false)
      })
    })

    // ─── 行为变更记录 · 同秒平局判据（⚠️ 不是「验收」，是留痕）──────────
    describe('行为变更记录 · 三列索引改了同秒平局的隐含判据', () => {
      it('ORDER BY created_at（单列）平局时按 id 分序——此前按 rowid（插入序）', () => {
        // **机制**：`ORDER BY created_at` 是三列索引 `(session_id, created_at, id)` 的**前缀**
        // ⇒ 排序由索引直接满足 ⇒ 平局由末列 `id`（UUID，随机）分序；两列版
        // `(session_id, created_at)` 只到 `created_at` 为止 ⇒ 平局落回 rowid（插入序）。
        //
        // **影响面** = 一切**按 created_at 单列排序**的既有查询：`getRecentMessages`（猫上下文）、
        // `getSessionHistory`（UI 历史）、`getAllSessionMessages`（派发扫描）、`getContextBefore`
        // （评估上下文）、`getTaskHistory`、`getLatestUserMessageId`（撤回判据）、`getAgentRepliesAfter`。
        // **量级**（dev / 主库实测）：同秒平局覆盖 **1.5%** 消息行，其中位次真会变的 **0.6% / 1.1%**。
        //
        // 本用例把现状**钉住**（不判它对错）：谁要改这条——包括「回退成 rowid 序」——
        // 都得先显式改这里，并回答一次「平局该按谁」。根治方向在 B 范围 ⑤-a（毫秒精度时间戳，
        // 平局基本消失）。裁决记录见 `docs/run/db-schema-governance/tickets.md`。
        const db = getDb()
        db.prepare(`INSERT INTO sessions (id, title) VALUES ('s-tie', '平局')`).run()
        // id 字典序与插入序**刻意相反**：这样「按 id 分序」与「按 rowid 分序」给出相反结果
        const ids = ['zzzz-4', 'zzzz-3', 'zzzz-2', 'zzzz-1']
        ids.forEach((id, i) => {
          db.prepare(
            `INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?, 's-tie', 'user', ?, '2026-01-01 00:00:00')`
          ).run(id, `msg-${i + 1}`)
        })

        const rows = db
          .prepare(
            `SELECT content FROM messages WHERE session_id = 's-tie' ORDER BY created_at ASC`
          )
          .all() as Array<{ content: string }>
        // id 升序 = zzzz-1…zzzz-4 = 插入序的**反转** ⇒ 按 id 分序得到 msg-4,3,2,1
        expect(rows.map((r) => r.content)).toEqual(['msg-4', 'msg-3', 'msg-2', 'msg-1'])
      })
    })
  })

  // ─── 票 6 批一 · B 范围重建批（D3 归一 + 7 张叶子表重建）───────────────────
  describe('票 6 · B 范围重建批（FK 补链 + 时间口径 ISO + D1 孤儿清理）', () => {
    /**
     * 票 6 的 8 条条目 —— **按身份认亲**（`ticket`），不按座位（数组下标）。
     *
     * 票 10 之前这里是 `slice(T6_START, T6_END)`：拿位置表达「属于票 6」。票 7 一接上
     * 去就切错区间——`slice(T6_START)` 会一路切到数组末尾（实得 10 条 vs 断言 8 条），
     * 而 **git 不报冲突**（两侧改的是文件不同位置），只有跑测试才露。这正是墙 #2/#3 的
     * 结构性来源之一。
     */
    const T6_ENTRIES = MIGRATIONS.filter((m) => m.ticket === 'T6')
    const T6_NAMES = T6_ENTRIES.map((m) => m.name)

    /**
     * **冻结的名字集合** —— 票 10 改造前的 `T6_NAMES` 逐字抄下来当基准。
     *
     * 为什么不拿 `T6_ENTRIES` 自我比对：那是恒真断言（filter 出一堆、再断言它等于自己），
     * 正是本仓反复点名的假绿门形态。冻结字面量让「少标一条 / 多标一条 / 名字写错」三种
     * 错都当场红。
     */
    const T6_NAMES_FROZEN = [
      'D3 review_verdicts.subject_agent_id 猫名→id 归一',
      'rebuild execution_logs（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild flow_states（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild flow_state_events（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild connector_bindings（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild episode_attributions（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild review_verdicts（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
      'rebuild review_parse_failures（FK 补链 + 时间口径 ISO + D1 孤儿清理）',
    ]

    /**
     * 「重建前」的库 = 只跑到票 6 首条为止（这 8 条一条都还没上船）。
     *
     * 这里仍用**顺序**切分，是刻意的：「之前」本来就是顺序语义，本票消灭的是拿位置表达
     * 「属于」。定位起点用身份（`ticket`），切分动作本身仍是 `slice`。
     */
    function makePreTicket6Db(): Database.Database {
      const db = makeFreshDb()
      const start = MIGRATIONS.findIndex((m) => m.ticket === 'T6')
      applyMigrations(db, MIGRATIONS.slice(0, start))
      return db
    }

    /**
     * 存量夹具：秒级时间 + 各类孤儿 + 猫名 subject。
     * 父行（sessions / agents）必须真实存在——`execution_logs.session_id/agent_id` 是**旧有**
     * FK，夹具造不出悬空。
     */
    function seedLegacy(db: Database.Database): void {
      db.exec(`
        INSERT INTO sessions (id, title, agent_ids) VALUES ('s1', 't', '[]');
        INSERT INTO agents (id, name, system_prompt, llm_api_key)
          VALUES ('a1', 'ds猫', 'p', 'sk'), ('a2', '吐槽猫', 'p', 'sk');
        INSERT INTO messages (id, session_id, role, content, mentions)
          VALUES ('m1', 's1', 'user', 'x', '[]'), ('m2', 's1', 'agent', 'y', '[]');

        -- ① 正常行：两条引用都指得到
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, ended_at, message_id)
          VALUES ('e-ok', 's1', 'a1', 'm1', 'completed', '2026-08-13 05:41:29', '2026-08-13 05:42:00', 'm2');
        -- ② 孤儿：message_id 指向已删消息
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, message_id)
          VALUES ('e-orphan-reply', 's1', 'a1', 'm1', 'completed', '2026-08-13 05:41:29', 'm-gone');
        -- ③ 孤儿：triggered_by_message_id 指向已删消息
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
          VALUES ('e-orphan-trigger', 's1', 'a1', 'm-gone', 'completed', '2026-08-13 05:41:29');
        -- ④ 脏存量：上次进程留下的 running 残骸（ended_at 为 NULL）
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
          VALUES ('e-running', 's1', 'a1', 'm1', 'running', '2026-08-13 05:41:29');
        -- ⑤ 时间列非实测形态（不该被转换吞成 NULL）
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
          VALUES ('e-weird', 's1', 'a1', 'm1', 'completed', '不是时间');
        -- ⑥ 时间列本来就 NULL（NULL 必须保持 NULL，不许被转换变成别的东西）
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
          VALUES ('e-null-time', 's1', 'a1', 'm1', 'completed', NULL);

        INSERT INTO flow_states (session_id, commit_sha, state, updated_at)
          VALUES ('s1', 'sha-ok', 'closed', '2026-08-13 05:41:29'),
                 ('s-gone', 'sha-orphan', 'closed', '2026-08-13 05:41:29');
        INSERT INTO flow_state_events (session_id, commit_sha, to_state, intent, created_at)
          VALUES ('s1', 'sha-ok', 'closed', 'closeout', '2026-08-13 05:41:29');

        INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id, created_at)
          VALUES ('cb1', 'qq', 'group', 'g1', 's1', '2026-08-13 05:41:29');

        INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, episode_state, classification_ver)
          VALUES ('ep1', 'm1', 'U', 'open', 'v1');
        INSERT INTO episode_attributions (id, episode_id, outcome, action_type, status, delivery_message_id, created_at, updated_at)
          VALUES ('ea-ok', 'ep1', 'abandoned', 'replay', 'resolved', 'm2', '2026-08-13 05:41:29', '2026-08-13 05:41:29');

        INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
          VALUES ('m2', 's1', 'a2', 'ds猫', 'suggest', '2026-08-13 05:41:29'),
                 ('m-gone', 's-gone', 'a2', NULL, 'suggest', '2026-08-13 05:41:29');
        INSERT INTO review_parse_failures (message_id, reason, raw, created_at)
          VALUES ('m2', 'bad_verdict', 'r', '2026-08-13 05:41:29'), ('m-gone', 'no_subject', 'r', '2026-08-13 05:41:29');
      `)
    }

    it('8 条条目形态 = 1 条 D3 归一 + 7 张重建，且全部落在追加区（不带 baseline 标记）', () => {
      // 恰好 8 条 + 名字集合与**冻结基准**逐字一致（票 10 验收 1）。
      // 判据非恒真：少标一条 ticket ⇒ 7 条；多标一条 ⇒ 9 条；名字被改 ⇒ 逐字不等。
      expect(T6_ENTRIES).toHaveLength(8)
      expect(T6_NAMES).toEqual(T6_NAMES_FROZEN)
      expect(T6_NAMES[0]).toContain('D3 review_verdicts.subject_agent_id 猫名→id 归一')
      expect(T6_NAMES.slice(1).every((n) => n.startsWith('rebuild '))).toBe(true)
      expect(T6_ENTRIES.every((m) => m.baseline !== true)).toBe(true)
      // 身份锚（`makePreTicket6Db` 的切分点）必须真落在数组**中段**：`findIndex` 返 -1
      // ⇒ 切出空集（「重建前」的库变成了全量库，那几格会静默测错东西）；返 0 ⇒ 同上。
      const start = MIGRATIONS.findIndex((m) => m.ticket === 'T6')
      expect(start).toBeGreaterThan(0)
      expect(start).toBeLessThan(MIGRATIONS.length)
    })

    it('形状 · 7 张表：新 FK 全 ON DELETE RESTRICT，CHECK 一个不少，时间列一律无 DEFAULT', () => {
      setDb(makePreTicket6Db())
      applyMigrations(getDb())
      const db = getDb()

      const fks = (t: string): string[] =>
        (
          db.pragma(`foreign_key_list(${t})`) as Array<{
            table: string
            from: string
            on_delete: string
          }>
        )
          .map((r) => `${r.from}→${r.table}:${r.on_delete}`)
          .sort()
      expect(fks('execution_logs')).toEqual([
        'agent_id→agents:RESTRICT',
        'message_id→messages:RESTRICT',
        'session_id→sessions:RESTRICT',
        'triggered_by_message_id→messages:RESTRICT',
      ])
      expect(fks('flow_states')).toEqual(['session_id→sessions:RESTRICT'])
      expect(fks('flow_state_events')).toEqual(['session_id→sessions:RESTRICT'])
      expect(fks('connector_bindings')).toEqual(['session_id→sessions:RESTRICT'])
      expect(fks('episode_attributions')).toEqual([
        'delivery_message_id→messages:RESTRICT',
        'episode_id→episodes:RESTRICT',
      ])
      expect(fks('review_verdicts')).toEqual([
        'message_id→messages:RESTRICT',
        'reviewer_agent_id→agents:RESTRICT',
        'session_id→sessions:RESTRICT',
        'subject_agent_id→agents:RESTRICT',
      ])
      expect(fks('review_parse_failures')).toEqual(['message_id→messages:RESTRICT'])

      // 时间列去掉 DEFAULT（⑤-c：漏传 value 撞 NOT NULL，不许静默降级）；CHECK 原样保留
      for (const t of [
        'flow_states',
        'flow_state_events',
        'connector_bindings',
        'episode_attributions',
        'review_verdicts',
        'review_parse_failures',
      ]) {
        const timeCols = (
          db.pragma(`table_info(${t})`) as Array<{
            name: string
            notnull: number
            dflt_value: string | null
          }>
        ).filter((c) => c.name.endsWith('_at'))
        expect(timeCols.length, t).toBeGreaterThan(0)
        for (const c of timeCols) {
          expect(c.notnull, `${t}.${c.name} 应 NOT NULL`).toBe(1)
          expect(c.dflt_value, `${t}.${c.name} 不该再有 DEFAULT`).toBeNull()
        }
      }
      expect(tableSqlOf(db, 'review_verdicts')).toContain("'comment'")
      expect(tableSqlOf(db, 'execution_logs')).toContain(
        "'queued', 'running', 'completed', 'failed'"
      )
      expect(tableSqlOf(db, 'episode_attributions')).toContain("'dispatched', 'resolved'")
      expect(tableSqlOf(db, 'review_parse_failures')).toContain("'no_subject', 'bad_verdict'")
    })

    it('索引随重建回归：DROP TABLE 连索引一起删，而建索引的迁移已登记不再重跑 ⇒ 重建条目必须自建', () => {
      setDb(makePreTicket6Db())
      const before = (
        getDb()
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='execution_logs' AND name LIKE 'idx_%' ORDER BY name`
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(before).toEqual(['idx_execution_logs_session_started', 'idx_execution_logs_status'])

      applyMigrations(getDb())
      const after = (
        getDb()
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='execution_logs' AND name LIKE 'idx_%' ORDER BY name`
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(after).toEqual(before)
      // 定义也要在（不是建了个同名空壳）
      const sql = (
        getDb()
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_execution_logs_session_started'`
          )
          .get() as { sql: string }
      ).sql
      expect(sql).toContain('execution_logs(session_id, started_at)')
    })

    it('D1 孤儿清理：4 类孤儿行被删、正常行与相关表原样（真删，不是空转）', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      const db = getDb()
      const ids = () =>
        (
          db.prepare(`SELECT id FROM execution_logs ORDER BY id`).all() as Array<{ id: string }>
        ).map((r) => r.id)
      expect(ids()).toEqual([
        'e-null-time',
        'e-ok',
        'e-orphan-reply',
        'e-orphan-trigger',
        'e-running',
        'e-weird',
      ])

      applyMigrations(db)

      // ②③ 两条执行日志孤儿被删；①④⑤⑥ 完好（⑤ 形态怪但**不是孤儿**，不该被误伤）
      expect(ids()).toEqual(['e-null-time', 'e-ok', 'e-running', 'e-weird'])
      expect((db.prepare(`SELECT COUNT(*) n FROM flow_states`).get() as { n: number }).n).toBe(1)
      expect(
        (db.prepare(`SELECT session_id FROM flow_states`).get() as { session_id: string })
          .session_id
      ).toBe('s1')
      // review_verdicts / review_parse_failures 的孤儿（'m-gone' / 's-gone'）各删一行
      expect((db.prepare(`SELECT COUNT(*) n FROM review_verdicts`).get() as { n: number }).n).toBe(
        1
      )
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM review_parse_failures`).get() as { n: number }).n
      ).toBe(1)
    })

    it('时间口径：秒级 → ISO 毫秒；NULL 保持 NULL；**非实测形态原样保留**（不静默抹成 NULL）', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      const db = getDb()
      applyMigrations(db)

      const rows = db
        .prepare(`SELECT id, started_at, ended_at FROM execution_logs ORDER BY id`)
        .all() as Array<{ id: string; started_at: string | null; ended_at: string | null }>
      expect(rows.find((r) => r.id === 'e-ok')).toEqual({
        id: 'e-ok',
        started_at: '2026-08-13T05:41:29.000Z',
        ended_at: '2026-08-13T05:42:00.000Z',
      })
      // 秒级 → ISO 毫秒是**无损单向**（⑤-b）：毫秒位补 .000，时刻不变
      expect(rows.find((r) => r.id === 'e-running')?.started_at).toBe('2026-08-13T05:41:29.000Z')
      // NULL 保持 NULL
      expect(rows.find((r) => r.id === 'e-null-time')?.started_at).toBeNull()
      expect(rows.find((r) => r.id === 'e-null-time')?.ended_at).toBeNull()
      // 认不出的取值**留着**——strftime 对解析不了的输入返回 NULL，直接套用就是静默丢数据
      expect(rows.find((r) => r.id === 'e-weird')?.started_at).toBe('不是时间')

      expect(
        (db.prepare(`SELECT updated_at FROM flow_states`).get() as { updated_at: string })
          .updated_at
      ).toBe('2026-08-13T05:41:29.000Z')
      expect(
        (db.prepare(`SELECT created_at FROM connector_bindings`).get() as { created_at: string })
          .created_at
      ).toBe('2026-08-13T05:41:29.000Z')
    })

    it('脏存量改判：running 行 → failed + error_type=server_restart + ended_at 补 ISO 毫秒', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      applyMigrations(getDb())

      const row = getDb()
        .prepare(
          `SELECT status, error_type, error_message, ended_at FROM execution_logs WHERE id='e-running'`
        )
        .get() as { status: string; error_type: string; error_message: string; ended_at: string }
      expect(row.status).toBe('failed')
      expect(row.error_type).toBe('server_restart')
      expect(row.error_message).toBe('server_restart')
      expect(row.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('flow_state_events 的 AUTOINCREMENT 不断档：显式 id 拷回 ⇒ sqlite_sequence 跟着走，新行不撞主键', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      const db = getDb()
      const maxBefore = (
        db.prepare(`SELECT MAX(id) m FROM flow_state_events`).get() as { m: number }
      ).m
      applyMigrations(db)
      expect((db.prepare(`SELECT MAX(id) m FROM flow_state_events`).get() as { m: number }).m).toBe(
        maxBefore
      )
      const seq = (
        db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='flow_state_events'`).get() as
          { seq: number } | undefined
      )?.seq
      expect(seq).toBe(maxBefore)
      // 下一条自动 id 必须**严格大于**存量最大值（否则主键撞车）
      db.prepare(
        `INSERT INTO flow_state_events (session_id, commit_sha, to_state, intent, created_at)
         VALUES ('s1', 'sha-new', 'closed', 'closeout', '2026-09-01T00:00:00.000Z')`
      ).run()
      const newId = (
        db.prepare(`SELECT id FROM flow_state_events WHERE commit_sha='sha-new'`).get() as {
          id: number
        }
      ).id
      expect(newId).toBeGreaterThan(maxBefore)
    })

    it('D3 归一：猫名按 agents.name 解析成 id（库里存的就是 id 后不再重复解析）', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      applyMigrations(getDb())

      const row = getDb()
        .prepare(`SELECT subject_agent_id FROM review_verdicts WHERE message_id='m2'`)
        .get() as { subject_agent_id: string | null }
      expect(row.subject_agent_id).toBe('a1') // 'ds猫' → agents.id
    })

    it('D3 归一不许静默降级：解析不到的猫名 → **拒启**（而不是悄悄抹成 NULL）', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      getDb()
        .prepare(`UPDATE review_verdicts SET subject_agent_id = '查无此猫' WHERE message_id = 'm2'`)
        .run()

      // 归一 SQL 的 COALESCE 保留原值 ⇒ 紧随其后的重建条目 FK 校验失败 ⇒ 拒启带迁移名
      expect(() => applyMigrations(getDb())).toThrowError(/rebuild review_verdicts/)
    })

    it('FK 真在：插入指向不存在消息的 review_verdicts → 被 RESTRICT 拦下', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      applyMigrations(getDb())

      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict, created_at)
             VALUES ('m-ghost', 's1', 'a2', 'approve', '2026-09-01T00:00:00.000Z')`
          )
          .run()
      ).toThrowError(/FOREIGN KEY/)
      // 父行在时同一条写得进（证明上一条红的是 FK、不是别的约束）
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict, created_at)
             VALUES ('m1', 's1', 'a2', 'approve', '2026-09-01T00:00:00.000Z')`
          )
          .run()
      ).not.toThrow()
    })

    it('纪律 6 · 全库 foreign_key_check 零违规（重建不动子表，但体检是收尾唯一兜）', () => {
      setDb(makePreTicket6Db())
      seedLegacy(getDb())
      applyMigrations(getDb())
      expect(getDb().pragma('foreign_key_check')).toEqual([])
    })

    it('新库路径同款：空库跑完整 initDb 也零违规、7 张表形状与老库路径一致', () => {
      setDb(makeFreshDb())
      initDb()
      const db = getDb()
      expect(db.pragma('foreign_key_check')).toEqual([])
      const fks = (t: string): string[] =>
        (
          db.pragma(`foreign_key_list(${t})`) as Array<{
            table: string
            from: string
            on_delete: string
          }>
        )
          .map((r) => `${r.from}→${r.table}:${r.on_delete}`)
          .sort()
      expect(fks('review_verdicts')).toHaveLength(4)
      expect(fks('execution_logs')).toHaveLength(4)
    })
  })

  // ─── 票 5 · 过程式迁移通道（spec §4.4 纪律 7）─────────────────────────
  describe('票 5 · 过程式迁移通道（run 条目）', () => {
    /** 把基线 + 追加区先跑满，只留注入的那条未登记（注入条目永远是列表末尾） */
    function primedDb(): Database.Database {
      setDb(makeFreshDb())
      const db = getDb()
      applyMigrations(db, MIGRATIONS)
      return db
    }

    it('run 条目在**事务外**执行 + 执行后登记台账（note=null）', () => {
      const db = primedDb()
      let inTransaction: boolean | null = null
      const probe = vi.fn(() => true)
      const entry: Migration = {
        name: 'proc ok',
        sql: `CREATE TABLE proc_ok (id TEXT PRIMARY KEY)`,
        verify: probe,
        run: (d, record) => {
          inTransaction = d.inTransaction
          d.exec(`CREATE TABLE proc_ok (id TEXT PRIMARY KEY)`)
          record()
        },
      }

      applyMigrations(db, [...MIGRATIONS, entry])

      // 事务外是**硬前提**不是风格：`PRAGMA foreign_keys` 在事务内是 no-op ⇒ 关不掉 FK ⇒
      // DROP 旧表要么拒启要么静默 CASCADE 清空子表（rebuildTable 因此直接拒事务内调用）。
      expect(inTransaction).toBe(false)
      // verify 对 run 条目跳过：执行完结构必然已是新形状，探针没有可做的事
      expect(probe).not.toHaveBeenCalled()
      expect(ledger(db).find((r) => r.name === 'proc ok')?.note).toBeNull()
      expect(tableNames(db)).toContain('proc_ok')
    })

    it('run 条目抛错 → 拒启（错误带迁移名 + 原错），台账不登记', () => {
      const db = primedDb()
      const entry: Migration = {
        name: 'proc boom',
        sql: `CREATE TABLE proc_boom (id TEXT PRIMARY KEY)`,
        run: () => {
          throw new Error('rebuild exploded')
        },
      }

      expect(() => applyMigrations(db, [...MIGRATIONS, entry])).toThrowError(
        /proc boom[\s\S]*rebuild exploded/
      )
      expect(ledger(db).map((r) => r.name)).not.toContain('proc boom')
    })

    it('run 条目漏调 record() → 拒启（漏登记 = 每次启动都重跑，属静默劣化）', () => {
      const db = primedDb()
      const entry: Migration = {
        name: 'proc forget',
        sql: `CREATE TABLE proc_forget (id TEXT PRIMARY KEY)`,
        run: (d) => {
          d.exec(`CREATE TABLE proc_forget (id TEXT PRIMARY KEY)`)
          // 故意不调 record()
        },
      }

      expect(() => applyMigrations(db, [...MIGRATIONS, entry])).toThrowError(
        /proc forget[\s\S]*未登记台账/
      )
      expect(ledger(db).map((r) => r.name)).not.toContain('proc forget')
    })

    it('老库路径：追加区的 run 条目**真执行**（不因「无台账」被当成历史跳过）', () => {
      const db = makeOldDb()
      db.prepare(`INSERT INTO sessions (id, title) VALUES ('s1', 't')`).run()
      setDb(db)

      initDb()

      // `messages` 的 FK / CHECK 只可能来自重建条目的**真执行**——基线补登只登记不执行，
      // 造不出这段文字。这是「新库老库同一条增量路径」在 run 通道上的实证。
      expect(tableSqlOf(db, 'messages')).toContain('REFERENCES agents(id) ON DELETE RESTRICT')
      expect(tableSqlOf(db, 'messages')).toContain(
        "CHECK (dispatch_state IN ('queued', 'running', 'done'))"
      )
      expect(ledger(db).find((r) => r.name.startsWith('messages rebuild'))?.note).toBeNull()
    })

    it('崩溃窗自愈：结构已新但台账无行 → 重跑重建条目不抛、形状与行数不变', () => {
      // 重现 run 通道的已知窗口：rebuildTable 先提交、record() 后写（两者无法同事务）——
      // 窗口内崩 ⇒ 结构新 + 台账无行 ⇒ 下次启动重跑。重跑必须幂等。
      const db = makeOldDb()
      db.prepare(
        `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES ('a1', '猫', 'p', 'sk')`
      ).run()
      db.prepare(`INSERT INTO sessions (id, title) VALUES ('s1', 't')`).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content) VALUES ('m1', 's1', 'a1', 'user', 'hi')`
      ).run()
      const before = tableSqlOf(db, 'messages')
      setDb(db)

      initDb()

      expect(tableSqlOf(db, 'messages')).toBe(before)
      expect(db.prepare(`SELECT COUNT(*) n FROM messages`).get()).toEqual({ n: 1 })
    })

    it('静态源断言：追加区的 run 条目只能经工厂构造（防 createSql 与 sql 分叉）', () => {
      const src = fs.readFileSync(new URL('./migrations.ts', import.meta.url), 'utf8')
      const start = src.indexOf('const APPENDED_MIGRATIONS')
      const end = src.indexOf('export const MIGRATIONS')
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      const body = src.slice(start, end)

      // 数组体里不许出现字面量 `run:` —— 手写 hook 就能造出「台账指纹对得上、实际建的
      // 是另一张形状」的静默分叉（checksum 只认 sql，管不到 hook 正文）。
      expect(body).not.toMatch(/\brun\s*:/)
      // 工厂把 createSql 与 sql 钉成**同一个变量** ⇒ createSql === m.sql 结构性成立。
      // 票 10 后 `ticket: opts.ticket,` 夹在 name 与 sql 之间 ⇒ 正则同步纳入（族修纪律：
      // 改了实现/形状就要扫一遍复述它的断言，否则留下的是一条**恒假**的假绿门）。
      expect(src).toMatch(/name: opts\.name,\s*\n\s*ticket: opts\.ticket,\s*\n\s*sql: opts\.ddl,/)
      expect(src).toMatch(/createSql: opts\.ddl,/)
      // hook 正文只做两件事：调 rebuildTable + 收尾 record()
      const hook = src.slice(
        src.indexOf('run: (db, record) => {'),
        src.indexOf('const APPENDED_MIGRATIONS')
      )
      expect(hook.match(/rebuildTable\(/g)).toHaveLength(1)
      expect(hook).toMatch(/record\(\)/)
    })
  })

  // ─── 票 7 · 归档（archived_at 加列 + 活跃列表部分索引）────────────────
  describe('票 7 · 归档', () => {
    const COL_ENTRY = 'sessions archived_at 列（归档 = 用户态删除）'
    const IDX_ENTRY = 'idx_sessions_active（活跃会话列表部分索引）'

    const hasColumn = (db: Database.Database, table: string, col: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (r) => r.name === col
      )

    const hasObject = (db: Database.Database, type: string, name: string): boolean =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) !==
      undefined

    it('全新库：列与部分索引都建出来，台账两条 note 全空（走增量路径不是补登）', () => {
      setDb(makeFreshDb())
      initDb()
      const db = getDb()
      expect(hasColumn(db, 'sessions', 'archived_at')).toBe(true)
      expect(hasObject(db, 'index', 'idx_sessions_active')).toBe(true)
      for (const name of [COL_ENTRY, IDX_ENTRY]) {
        expect(ledger(db).find((r) => r.name === name)?.note, name).toBeNull()
      }
    })

    it('老库（台账上船那一刻）：两条都在老库路径上真执行——列建出来、索引建出来', () => {
      const db = makePreLedgerDb()
      // 前置：夹具确实是老库（无列、无索引、无台账），否则下面的断言恒真
      expect(hasColumn(db, 'sessions', 'archived_at')).toBe(false)
      expect(hasObject(db, 'index', 'idx_sessions_active')).toBe(false)

      setDb(db)
      initDb()

      expect(hasColumn(db, 'sessions', 'archived_at')).toBe(true)
      expect(hasObject(db, 'index', 'idx_sessions_active')).toBe(true)
      // 追加区条目：note 空（补登才写 'baseline'）
      expect(ledger(db).find((r) => r.name === COL_ENTRY)?.note).toBeNull()
      expect(ledger(db).find((r) => r.name === IDX_ENTRY)?.note).toBeNull()
    })

    // 探针的**价值面**：库里已有该列但台账无记录（手工 SQL 补过 / 台账上船前的历史遗留）
    // ——`ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，没有探针就是永久拒启。
    it('探针路径：列已存在（无台账记录）⇒ 跳过执行只登记，**不拒启**；索引条目照常执行', () => {
      const db = makeOldDb() // 当前全量结构（已含 archived_at）+ 无台账
      db.prepare(`DELETE FROM sessions WHERE 0`).run() // no-op：仅为表明不动数据面
      setDb(db)

      expect(() => initDb()).not.toThrow()

      expect(ledger(db).find((r) => r.name === COL_ENTRY)?.note).toBeNull()
      // 关键：探针只跳**自己那条**，不连带跳过索引条目（否则「列在但索引没建」会静默留坑）
      expect(hasObject(db, 'index', 'idx_sessions_active')).toBe(true)
    })

    it('真空性反对照：探针改成恒 true ⇒ 老库上真拒启（探针的结果确实在门控执行）', () => {
      // 反向锁：若探针是个恒真摆设，下面这次启动会「跳过加列 → 索引条目撞 `no such column`
      // → 拒启」。这恰好证明两件事，都是设计要的：
      //   ① 探针返回值真的门控执行（不是装饰）；
      //   ② 两条条目有**顺序依赖**（索引引用列），跳过前一条不会静默产出半套结构——
      //      缺列时响亮拒启，而不是留一个「索引没建上」的静默坑。
      const db = makePreLedgerDb()
      setDb(db)
      expect(() =>
        applyMigrations(
          db,
          MIGRATIONS.map((m) => (m.name === COL_ENTRY ? { ...m, verify: () => true } : m))
        )
      ).toThrow(/idx_sessions_active.*no such column: archived_at/s)
      expect(hasColumn(db, 'sessions', 'archived_at')).toBe(false)
    })

    it('活跃列表查询走部分索引，且临时 B 树排序消失；对照：无过滤查询不变', () => {
      setDb(makeFreshDb())
      initDb()
      const db = getDb()

      // SQL 逐字对应 `repository/sessions.ts` 的 listActiveSessions（下方源断言钉着它没漂）
      const active = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC`
          )
          .all() as Array<{ detail: string }>
      ).map((r) => r.detail)
      expect(active.join('\n')).toContain('idx_sessions_active')
      // ⚠️ 判据是「临时 B 树消失」，**不是**「SCAN 字样消失」：这条查询没有等值约束
      // （列表要全量），正确的计划就是「按索引序扫」——`SCAN … USING INDEX` 不是退化。
      // 这与票 2 三条等值索引的判据形状不同，别照搬 `scansIn()`。
      expect(active.filter((d) => /TEMP B-TREE/i.test(d))).toEqual([])

      // 反面对照：无过滤的 `listAllSessions` 不该被这条部分索引改变计划（它蕴含不了索引谓词）
      const all = (
        db
          .prepare(`EXPLAIN QUERY PLAN SELECT * FROM sessions ORDER BY updated_at DESC`)
          .all() as Array<{ detail: string }>
      ).map((r) => r.detail)
      expect(all.join('\n')).not.toContain('idx_sessions_active')

      // 源断言：仓库里那句 SQL 与上面被测的正文同形（防测试量了个漂走的副本）
      const src = fs.readFileSync(new URL('./repository/sessions.ts', import.meta.url), 'utf8')
      expect(src).toContain(
        `SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC`
      )
      const mig = fs.readFileSync(new URL('./migrations.ts', import.meta.url), 'utf8')
      expect(mig).toContain(
        `CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(updated_at DESC) WHERE archived_at IS NULL`
      )
    })
  })
})

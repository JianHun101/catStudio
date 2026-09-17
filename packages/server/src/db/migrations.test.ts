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

    it('空库跑完整 initDb → 基线 47 件之上追加区净增 2 件，且两列索引已升成三列', () => {
      setDb(makeFreshDb())
      initDb()

      const actual = dumpSchema(getDb())
      const baselineKeys = new Set(BASELINE.map((r) => `${r.type}:${r.name}`))
      const added = actual.filter((r) => !baselineKeys.has(`${r.type}:${r.name}`))
      // 穷举清单（票 2 追加区三条索引迁移的净产出）：
      //   - `idx_messages_session` 是**同名升级**（DROP 旧两列 + 建新三列）⇒ 物体数不变、定义变；
      //   - fix-forward 条目对已齐件的库是 14 个 `IF NOT EXISTS` no-op ⇒ 零产出
      //     （该条**不挂探针**，走的是「真执行 no-op」，见 `migrations.ts` 该条上方注释）；
      //   - 其余两条各 +1。
      // 将来往追加区加迁移**必须来改这里**——否则新物体静默出现，没人知道结构被谁改了。
      expect(added.map((r) => `${r.type}:${r.name}`)).toEqual([
        'index:idx_execution_logs_session_started',
        'index:idx_execution_logs_status',
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

    it('探针清单 = 审计定稿的 3 条（重建类静默失败型），多一条少一条都要改审计结论', () => {
      expect(MIGRATIONS.filter((m) => m.verify !== undefined).map((m) => m.name)).toEqual([
        'widen review_verdicts verdict CHECK (comment)',
        'chunk_vectors distance_metric=cosine (量纲校正)',
        'drop memories chain tables (票辛 旧链下线)',
      ])
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
      // 追加区条目（补建 / 票 2 索引）在任何库上都走增量路径真执行，note 恒空
      // （票 2 起追加区非空，判据必须分面）
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
      expect(
        db.prepare(`SELECT verdict FROM review_verdicts WHERE message_id='m-old'`).get()
      ).toEqual({ verdict: 'suggest' })
      expect(() =>
        db
          .prepare(
            `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict)
             VALUES ('m-new', 's1', 'r1', 'comment')`
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
     * 追加区在**齐件库**上的净增物体数（票 2 起 = 2：`idx_execution_logs_session_started` /
     * `idx_execution_logs_status`；`idx_messages_session` 是同名升级 ⇒ 物体数不变）。
     * 追加区的**权威清单**在「验收 1 · 空库跑完整 initDb → 净增 2 件」那条穷举用例里；
     * 这里只拿它把 ds猫 侧「齐件库 = 47 件」的旧读数换算到追加区上线后的口径。
     */
    const APPENDED_NET_OBJECTS = 2

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
      // 存量面：其余结构在（47 − 14 = 33，实测主库读数即 33；追加区两条索引另计）
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
      for (const expected of BASELINE) {
        // 与基准不同面的两处，都是**追加区对基线的合法演化**（基线集本身一个字节没动）：
        //   - `idx_messages_session`：票 2 的同名升级（两列 → 三列）；
        //   - `messages` 表：票 5 的重建（FK / CHECK / 时间口径）。
        // 两者的判据各自单列在下面——跳过的是「与冻结基准逐字相等」这一条，不是判据本身。
        if (expected.name === 'idx_messages_session' || expected.name === 'messages') continue
        expect(
          byName.get(`${expected.type}:${expected.name}`),
          `${expected.type} ${expected.name}`
        ).toEqual(expected)
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
        const db = makeOldDb()
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
      // 工厂把 createSql 与 sql 钉成**同一个变量** ⇒ createSql === m.sql 结构性成立
      expect(src).toMatch(/name: opts\.name,\s*\n\s*sql: opts\.ddl,/)
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
})

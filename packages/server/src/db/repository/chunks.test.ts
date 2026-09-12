/**
 * chunks 索引表 repository 测试（票己 C1–C8）。
 *
 * 测试面 = **真实迁移路径**：`createTestDb()` 造「老库」（只有旧表，无 chunks）→
 * `initDb()` 跑真实 additive 迁移建三表。不用手搓 DDL——手搓等于把「被判面」
 * 换成测试自己写的代理面（票丁 B9 教训）。
 *
 * 契约期望表（C1/C8 的比对基准）逐列抄自票己正文的契约表，**不是从实现回抄**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../index.js'
import { initRepository } from './index.js'
import { chunks as chunksRepo } from './index.js'
import { vectorToBlob } from '../../memory/index.js'
import { bigramTokenize } from './memories.js'

/** 契约列清单（票己正文「`chunks` 列清单 —— 一次到位（X2）」逐列抄录） */
const CONTRACT_COLUMNS: Array<{
  name: string
  type: string
  notnull: number
  dflt: string | null
}> = [
  { name: 'id', type: 'INTEGER', notnull: 0, dflt: null },
  { name: 'doc_path', type: 'TEXT', notnull: 1, dflt: null },
  { name: 'section_anchor', type: 'TEXT', notnull: 1, dflt: null },
  { name: 'content_hash', type: 'TEXT', notnull: 1, dflt: null },
  { name: 'origin_id', type: 'TEXT', notnull: 1, dflt: null },
  { name: 'type', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'status', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'date', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'evidence', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'supersedes', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'superseded_by', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'valid_from', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'valid_to', type: 'TEXT', notnull: 0, dflt: null },
  { name: 'part_index', type: 'INTEGER', notnull: 1, dflt: null },
  { name: 'part_total', type: 'INTEGER', notnull: 1, dflt: null },
  { name: 'hard_cut', type: 'INTEGER', notnull: 1, dflt: '0' },
  { name: 'body', type: 'TEXT', notnull: 1, dflt: null },
  { name: 'breadcrumb', type: 'TEXT', notnull: 1, dflt: null },
]

interface TableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function tableInfo(table: string): TableInfoRow[] {
  return getDb().pragma(`table_info(${table})`) as TableInfoRow[]
}

function tableNames(): string[] {
  return (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

/** 一片的最小合法入参（身份键可覆盖） */
function chunkInput(over: Partial<Parameters<typeof chunksRepo.upsertChunk>[0]> = {}) {
  return {
    docPath: 'docs/adr/0001-a.md',
    sectionAnchor: '## 决策',
    contentHash: 'h1',
    originId: 'blob-sha-1',
    type: 'adr',
    status: null,
    date: '2026-09-01',
    evidence: ['e1'],
    partIndex: 1,
    partTotal: 1,
    body: '猫咖测试正文',
    breadcrumb: 'docs/adr/0001-a.md > 决策',
    ...over,
  }
}

/** 512 维 one-hot（余弦距离：同位置 0，异位置 1） */
function oneHot(i: number): number[] {
  const v = new Array(512).fill(0)
  v[i] = 1
  return v
}

/** 写 FTS 行（写入侧同步归票庚/票辛，测试侧照 memories.ts 的 bigram 预分词范式手写） */
function writeFtsRow(chunkId: number, text: string): void {
  getDb()
    .prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)')
    .run(chunkId, bigramTokenize(text).join(' '))
}

/** 写向量行（⚠️ vec0 PK 必须传 BigInt——JS number 会被 better-sqlite3 绑成 REAL 而被拒） */
function writeVectorRow(chunkId: number, vec: number[]): void {
  getDb()
    .prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)')
    .run(BigInt(chunkId), vectorToBlob(vec))
}

describe('chunks repo（票己 · 段三索引表）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  // ─── C1 ───────────────────────────────────────────────
  describe('C1 三表建齐', () => {
    it('chunks 列名集合与契约清单逐字一致（含顺序）', () => {
      const names = tableInfo('chunks').map((c) => c.name)
      expect(names).toEqual(CONTRACT_COLUMNS.map((c) => c.name))
    })

    it('chunk_vectors / chunks_fts 存在', () => {
      const names = tableNames()
      expect(names).toContain('chunk_vectors')
      expect(names).toContain('chunks_fts')
    })

    it('chunk_vectors 接受 512 维向量、拒绝非 512 维', () => {
      const id = chunksRepo.upsertChunk(chunkInput())
      expect(() => writeVectorRow(id, oneHot(0))).not.toThrow()
      expect(() => writeVectorRow(id + 1, new Array(511).fill(0))).toThrow()
    })
  })

  // ─── C2 ───────────────────────────────────────────────
  describe('C2 唯一索引生效 / 幂等 upsert', () => {
    it('同身份键 upsert 两次 ⇒ 1 行，且 id 不变、搬运列被覆盖', () => {
      const id1 = chunksRepo.upsertChunk(chunkInput({ partIndex: 1, body: '旧正文' }))
      const id2 = chunksRepo.upsertChunk(chunkInput({ partIndex: 2, body: '新正文' }))
      const rows = getDb().prepare('SELECT * FROM chunks').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(id2).toBe(id1)
      expect(rows[0].body).toBe('新正文')
      expect(rows[0].part_index).toBe(2)
    })

    it('改 content_hash ⇒ 2 行（身份键变了就是新片）', () => {
      chunksRepo.upsertChunk(chunkInput({ contentHash: 'h1' }))
      chunksRepo.upsertChunk(chunkInput({ contentHash: 'h2' }))
      expect(getDb().prepare('SELECT COUNT(*) c FROM chunks').get()).toEqual({ c: 2 })
    })

    it('同 hash 异节锚 ⇒ 2 行（身份键含 section_anchor）', () => {
      chunksRepo.upsertChunk(chunkInput({ sectionAnchor: '## A' }))
      chunksRepo.upsertChunk(chunkInput({ sectionAnchor: '## B' }))
      expect(getDb().prepare('SELECT COUNT(*) c FROM chunks').get()).toEqual({ c: 2 })
    })

    it('已知边界：同节内两片 body 完全相同 ⇒ 幂等合一（丢一个片序号）', () => {
      // 票面「已知边界」判据：合一是确定性行为 ⇒ 重扫 N 次结果不变
      chunksRepo.upsertChunk(chunkInput({ partIndex: 1, partTotal: 2, contentHash: 'same' }))
      chunksRepo.upsertChunk(chunkInput({ partIndex: 2, partTotal: 2, contentHash: 'same' }))
      expect(getDb().prepare('SELECT COUNT(*) c FROM chunks').get()).toEqual({ c: 1 })
    })

    it('重扫三次（同身份键重复写）行数稳定', () => {
      for (let i = 0; i < 3; i++) {
        chunksRepo.upsertChunk(chunkInput({ sectionAnchor: '## A' }))
        chunksRepo.upsertChunk(chunkInput({ sectionAnchor: '## B' }))
      }
      expect(getDb().prepare('SELECT COUNT(*) c FROM chunks').get()).toEqual({ c: 2 })
    })
  })

  // ─── C3 ───────────────────────────────────────────────
  describe('C3 老库幂等', () => {
    it('对已有旧表的库重跑 initDb() 零报错、既有表数据不动', () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')`
      ).run()
      db.prepare(
        `INSERT INTO knowledge (id, content, source, created_at) VALUES ('k1', '旧知识', 'doc', '2026-01-01')`
      ).run()
      const before = {
        agents: db.prepare('SELECT COUNT(*) c FROM agents').get(),
        knowledge: db.prepare('SELECT COUNT(*) c FROM knowledge').get(),
      }

      expect(() => initDb()).not.toThrow()
      initDb()

      expect(db.prepare('SELECT COUNT(*) c FROM agents').get()).toEqual(before.agents)
      expect(db.prepare('SELECT COUNT(*) c FROM knowledge').get()).toEqual(before.knowledge)
      expect(tableNames()).toContain('chunks')
      // ⚠️ 本用例原以 `memories` 代表「旧表」：该表已随票辛 ⑥ 主动 DROP，
      // 不再是「幂等保留」的对象（DROP 面另有专门用例，见 db/index.test.ts）
    })
  })

  // ─── C4 / C6 ──────────────────────────────────────────
  describe('C4 无时间戳/运行态列 & C6 无 text 列', () => {
    it('列名不含 *_at / *_time / *_ts / scanned* / last_seen', () => {
      const names = tableInfo('chunks').map((c) => c.name)
      const offenders = names.filter(
        (n) =>
          /_at$/.test(n) ||
          /_time$/.test(n) ||
          /_ts$/.test(n) ||
          /^scanned/.test(n) ||
          n === 'last_seen'
      )
      expect(offenders).toEqual([])
    })

    it('列名不含 text（可重算字段不落表）', () => {
      expect(tableInfo('chunks').map((c) => c.name)).not.toContain('text')
    })
  })

  // ─── C5 ───────────────────────────────────────────────
  describe('C5 过滤面覆盖全部入口', () => {
    /**
     * 检索入口——**原子型**（自己发 SQL，必带 X4 过滤面）：body 内必须出现过滤字面量。
     * 新增导出函数必须落进「原子检索 ∪ 组合检索 ∪ 非检索」三表之一，否则本测试爆。
     */
    const RETRIEVAL_FUNCS = ['searchChunksByVector', 'searchChunksByKeyword', 'getChunksBySection']
    /**
     * 组合型检索入口（票辛）：自身**不发 SQL**，只编排上面那些原子入口 ⇒ 过滤面由
     * 被调用者承担。断言比原子的弱一档（查它确实调了原子入口），但比把它塞进
     * 「非检索」诚实——它返回的就是召回结果。
     */
    const COMPOSED_RETRIEVAL_FUNCS = ['searchChunksHybrid']
    /**
     * 非检索导出：`setRepoDb` 配置 / `upsertChunk` 身份键裸写口 /
     * `getChunksByOrigin` 扫描器增量比对（**必须见全量行含 superseded**，否则孤儿物理删会漏）/
     * 票庚 写侧四件（三表同步写口 + 全量路径枚举 + 两处物理删）——**写入与删除，不是检索面**，
     * 故不受 X4 过滤面约束（过滤面管的是「召回」，不是「落库」与「物理删」）/
     * `probeChunkVectorCandidates`（票辛）诊断探针——**刻意返回被过滤掉的行**
     * （用途 = W11 分辨「召回空（被状态过滤）」、X5 记阈值前 top-N）。
     * ⚠️ 它的 CASE 里也含 `NOT IN ('superseded','deprecated')` 字面量，故**不许**
     * 挪进 RETRIEVAL_FUNCS——那会让「含字面量」这条子串判据替一个语义相反的
     * 函数背书（向严不向宽：宁可它留在非检索表里被显式说明）。
     */
    const NON_RETRIEVAL_FUNCS = [
      'setRepoDb',
      'upsertChunk',
      'upsertChunkWithIndexes',
      'getChunksByOrigin',
      'listChunkDocPaths',
      'deleteChunksByDocPaths',
      'deleteStaleChunkRows',
      'probeChunkVectorCandidates',
    ]

    function exportFunctionBodies(src: string): Map<string, string> {
      const out = new Map<string, string>()
      const re = /export function\s+(\w+)\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const bodyStart = src.indexOf('{', m.index)
        let depth = 0
        let i = bodyStart
        for (; i < src.length; i++) {
          if (src[i] === '{') depth++
          else if (src[i] === '}') {
            depth--
            if (depth === 0) break
          }
        }
        out.set(m[1], src.slice(bodyStart, i + 1))
      }
      return out
    }

    const SRC = fs.readFileSync(fileURLToPath(new URL('./chunks.ts', import.meta.url)), 'utf8')
    const bodies = exportFunctionBodies(SRC)

    it('导出函数集合 = 原子检索 ∪ 组合检索 ∪ 非检索（无函数逃逸在断言之外）', () => {
      expect([...bodies.keys()].sort()).toEqual(
        [...RETRIEVAL_FUNCS, ...COMPOSED_RETRIEVAL_FUNCS, ...NON_RETRIEVAL_FUNCS].sort()
      )
    })

    it.each(RETRIEVAL_FUNCS)('%s 函数体含硬排除集合 + NULL 放行', (fn) => {
      const body = bodies.get(fn)
      expect(body, `${fn} 未找到`).toBeTruthy()
      expect(body).toContain("NOT IN ('superseded','deprecated')")
      expect(body).toContain('status IS NULL')
    })

    it.each(COMPOSED_RETRIEVAL_FUNCS)('%s 只编排原子检索入口（过滤面由被调用者承担）', (fn) => {
      const body = bodies.get(fn)
      expect(body, `${fn} 未找到`).toBeTruthy()
      const delegated = RETRIEVAL_FUNCS.filter((f) => body!.includes(`${f}(`))
      expect(delegated.length, `${fn} 未调用任何原子检索入口`).toBeGreaterThan(0)
    })

    it('运行时：四态各一条 ⇒ 只召回 NULL 与 active', () => {
      const fixtures: Array<{ status: string | null; text: string }> = [
        { status: 'superseded', text: '猫咖测试甲' },
        { status: 'deprecated', text: '猫咖测试乙' },
        { status: null, text: '猫咖测试丙' },
        { status: 'active', text: '猫咖测试丁' },
      ]
      const ids = fixtures.map((f, i) => {
        const id = chunksRepo.upsertChunk(
          chunkInput({
            sectionAnchor: `## S${i}`,
            contentHash: `h${i}`,
            status: f.status,
            body: f.text,
          })
        )
        writeFtsRow(id, f.text)
        writeVectorRow(id, oneHot(0))
        return id
      })
      const expected = [ids[2], ids[3]]

      const byVector = chunksRepo.searchChunksByVector(vectorToBlob(oneHot(0)), 10, 1.5)
      expect(byVector.map((r) => r.id).sort()).toEqual(expected)

      const byKeyword = chunksRepo.searchChunksByKeyword('猫咖', 10)
      expect(byKeyword.map((r) => r.id).sort()).toEqual(expected)
    })
  })

  // ─── C8 ───────────────────────────────────────────────
  describe('C8 列定义完整性', () => {
    it('type / notnull / dflt_value 与契约表逐列相等', () => {
      const actual = tableInfo('chunks').map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt: c.dflt_value,
      }))
      expect(actual).toEqual(CONTRACT_COLUMNS)
    })
  })

  // ─── C7 ───────────────────────────────────────────────
  describe('C7 测试环境', () => {
    it('跑在 :memory: 且 MEMORY_ENABLED=false', () => {
      expect(getDb().memory).toBe(true)
      expect(process.env.MEMORY_ENABLED).toBe('false')
    })
  })

  // ─── getChunksByOrigin（票庚 增量比对用） ─────────────
  describe('getChunksByOrigin', () => {
    it('按 origin_id 取全量行（含 superseded——扫描器须看得见）', () => {
      const a = chunksRepo.upsertChunk(chunkInput({ originId: 'sha-A', contentHash: 'x1' }))
      chunksRepo.upsertChunk(
        chunkInput({ originId: 'sha-A', contentHash: 'x2', status: 'superseded' })
      )
      chunksRepo.upsertChunk(chunkInput({ originId: 'sha-B', contentHash: 'x3' }))

      const rows = chunksRepo.getChunksByOrigin('sha-A')
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.content_hash).sort()).toEqual(['x1', 'x2'])
      expect(rows.some((r) => r.status === 'superseded')).toBe(true)
      expect(rows[0].id).toBe(a)
    })
  })

  // ─── 票庚 写侧（G1–G5） ───────────────────────────────
  describe('upsertChunkWithIndexes（扫描器唯一写口）', () => {
    const counts = () => ({
      chunks: (getDb().prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c,
      fts: (getDb().prepare('SELECT COUNT(*) c FROM chunks_fts').get() as { c: number }).c,
      vec: (getDb().prepare('SELECT COUNT(*) c FROM chunk_vectors').get() as { c: number }).c,
    })

    it('G1/G2：FTS 行内容 = bigram 预分词串（非原文），rowid = chunks.rowid', () => {
      const { id } = chunksRepo.upsertChunkWithIndexes(chunkInput(), vectorToBlob(oneHot(0)))

      const fts = getDb().prepare('SELECT rowid, content FROM chunks_fts').all() as Array<{
        rowid: number
        content: string
      }>
      expect(fts).toHaveLength(1)
      expect(fts[0].rowid).toBe(id)
      // 原文（含空格）本身不是 bigram 串：断言两者不等 + 是空格 join 的 bigram
      const raw = `${chunkInput().body} ${chunkInput().breadcrumb}`
      expect(fts[0].content).not.toBe(raw)
      expect(fts[0].content).toBe(bigramTokenize(raw).join(' '))
    })

    it('G1 反例：FTS 行写成原文 ⇒ 关键词通道零命中（静默失败）', () => {
      // 手写「照原文写」的错误形态，证明读侧确实依赖 bigram —— 这条用例是
      // 让「G1 地雷」从口头约定变成可复现事实
      const bare = chunksRepo.upsertChunk(chunkInput({ contentHash: 'bare' }))
      getDb()
        .prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)')
        .run(bare, '猫咖测试正文 docs/adr/0001-a.md > 决策')
      expect(chunksRepo.searchChunksByKeyword('猫咖', 10)).toHaveLength(0)
    })

    it('G1：写入后按正文关键词真能命中', () => {
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ body: '扫描器写入侧的关键词命中用例' }),
        vectorToBlob(oneHot(0))
      )
      const hits = chunksRepo.searchChunksByKeyword('关键词', 10)
      expect(hits).toHaveLength(1)
      expect(hits[0].body).toBe('扫描器写入侧的关键词命中用例')
    })

    it('G3：向量行写入后向量通道能召回该片', () => {
      const { id } = chunksRepo.upsertChunkWithIndexes(chunkInput(), vectorToBlob(oneHot(3)))
      const hits = chunksRepo.searchChunksByVector(vectorToBlob(oneHot(3)), 10, 1.5)
      expect(hits.map((r) => r.id)).toEqual([id])
      expect(hits[0].distance).toBeCloseTo(0, 6)
    })

    it('G3 反例：vec0 PK 不传 BigInt ⇒ 写入被拒', () => {
      const { id } = chunksRepo.upsertChunkWithIndexes(chunkInput(), vectorToBlob(oneHot(0)))
      expect(() =>
        getDb()
          .prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)')
          .run(id, vectorToBlob(oneHot(1)))
      ).toThrow(/integer/i)
    })

    it('重写同身份键：id 不变、三表各 1 行、FTS 不残留旧 bigram', () => {
      const first = chunksRepo.upsertChunkWithIndexes(
        chunkInput({ body: '第一版正文' }),
        vectorToBlob(oneHot(0))
      )
      expect(first.created).toBe(true)
      const second = chunksRepo.upsertChunkWithIndexes(
        chunkInput({ body: '第二版正文' }),
        vectorToBlob(oneHot(1))
      )
      expect(second.created).toBe(false)
      expect(second.id).toBe(first.id)
      expect(counts()).toEqual({ chunks: 1, fts: 1, vec: 1 })
      expect(chunksRepo.searchChunksByKeyword('第一版', 10)).toHaveLength(0)
      expect(chunksRepo.searchChunksByKeyword('第二版', 10)).toHaveLength(1)
    })

    it('G4：evidence 传 {kind, ref} 对象数组 ⇒ 落 JSON 文本、读回可解出字段', () => {
      const id = chunksRepo.upsertChunk({
        ...chunkInput({ contentHash: 'ev' }),
        evidence: [
          { kind: 'commit', ref: 'd555732' },
          { kind: 'file', ref: 'AGENTS.md' },
        ],
      })
      const row = getDb().prepare('SELECT evidence FROM chunks WHERE id = ?').get(id) as {
        evidence: string
      }
      const parsed = JSON.parse(row.evidence)
      expect(parsed).toEqual([
        { kind: 'commit', ref: 'd555732' },
        { kind: 'file', ref: 'AGENTS.md' },
      ])
      expect(parsed[0].kind).toBe('commit')
      expect(parsed[0].ref).toBe('d555732')
    })
  })

  describe('孤儿物理删（G5 · 三表齐删）', () => {
    const countAll = () => {
      const c = (sql: string) => (getDb().prepare(sql).get() as { c: number }).c
      return [
        c('SELECT COUNT(*) c FROM chunks'),
        c('SELECT COUNT(*) c FROM chunks_fts'),
        c('SELECT COUNT(*) c FROM chunk_vectors'),
      ]
    }

    it('deleteChunksByDocPaths：chunks / chunks_fts / chunk_vectors 三表归零', () => {
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ docPath: 'docs/adr/gone.md', contentHash: 'g1' }),
        vectorToBlob(oneHot(0))
      )
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ docPath: 'docs/adr/kept.md', contentHash: 'k1' }),
        vectorToBlob(oneHot(1))
      )
      expect(countAll()).toEqual([2, 2, 2])

      expect(chunksRepo.deleteChunksByDocPaths(['docs/adr/gone.md'])).toBe(1)
      expect(countAll()).toEqual([1, 1, 1])
      expect(chunksRepo.listChunkDocPaths()).toEqual(['docs/adr/kept.md'])
    })

    it('deleteChunksByDocPaths：空数组是 no-op（不误删全表）', () => {
      chunksRepo.upsertChunkWithIndexes(chunkInput(), vectorToBlob(oneHot(0)))
      expect(chunksRepo.deleteChunksByDocPaths([])).toBe(0)
      expect(countAll()).toEqual([1, 1, 1])
    })

    it('deleteStaleChunkRows：只删旧代，本次写入的代数保留', () => {
      // 旧代两片
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ originId: 'old', contentHash: 'a', sectionAnchor: '## A' }),
        vectorToBlob(oneHot(0))
      )
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ originId: 'old', contentHash: 'b', sectionAnchor: '## B' }),
        vectorToBlob(oneHot(1))
      )
      // 新代：A 节改了（新 hash），B 节原样（同身份键 ⇒ upsert 刷 origin_id）
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ originId: 'new', contentHash: 'a2', sectionAnchor: '## A' }),
        vectorToBlob(oneHot(2))
      )
      chunksRepo.upsertChunkWithIndexes(
        chunkInput({ originId: 'new', contentHash: 'b', sectionAnchor: '## B' }),
        vectorToBlob(oneHot(3))
      )

      expect(chunksRepo.deleteStaleChunkRows('docs/adr/0001-a.md', 'new')).toBe(1)
      const rows = chunksRepo.getChunksByOrigin('new')
      expect(rows.map((r) => r.content_hash).sort()).toEqual(['a2', 'b'])
      expect(chunksRepo.getChunksByOrigin('old')).toHaveLength(0)
      // 三表同步收缩：被删的那片不留 FTS/向量僵尸行
      expect(countAll()).toEqual([2, 2, 2])
    })
  })

  // ─── 距离量纲（票辛 · 契约对齐）───────────────────────
  describe('chunk_vectors 距离量纲 = cosine（全仓阈值口径）', () => {
    /** 三表行数 [chunks, chunks_fts, chunk_vectors]（与上面孤儿删用例同形） */
    const countAll = () => {
      const c = (sql: string) => (getDb().prepare(sql).get() as { c: number }).c
      return [
        c('SELECT COUNT(*) c FROM chunks'),
        c('SELECT COUNT(*) c FROM chunks_fts'),
        c('SELECT COUNT(*) c FROM chunk_vectors'),
      ]
    }

    /** 与 oneHot(0) 夹角 45° 的**单位**向量 */
    const unit45 = () => {
      const v = new Array(512).fill(0)
      v[0] = Math.cos(Math.PI / 4)
      v[1] = Math.sin(Math.PI / 4)
      return v
    }

    it('DDL 显式声明 distance_metric=cosine', () => {
      const row = getDb()
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'")
        .get() as { sql: string }
      expect(row.sql).toContain('distance_metric=cosine')
    })

    it('运行时：45° 单位向量的距离是余弦 0.2929，不是 L2 0.7654', () => {
      const id = chunksRepo.upsertChunk(chunkInput())
      writeVectorRow(id, unit45())
      const hits = chunksRepo.searchChunksByVector(vectorToBlob(oneHot(0)), 5, 1.5)
      expect(hits).toHaveLength(1)
      // 判据是「落在余弦那一侧」而不是精确值：L2 会是 0.7654（差 0.47），
      // 余弦 0.2929 —— 两位小数足够把两者分开
      expect(hits[0].distance).toBeCloseTo(0.293, 2)
    })

    it('存量库的 L2 量纲在同一次 initDb() 里被校正（且三表同清待重扫）', () => {
      const db = getDb()
      const id = chunksRepo.upsertChunk(chunkInput())
      writeFtsRow(id, '猫咖测试正文')
      writeVectorRow(id, unit45())

      // 造一张「老量纲」的表：模拟票己时期建的 L2 表
      db.exec('DROP TABLE chunk_vectors')
      db.exec(
        `CREATE VIRTUAL TABLE chunk_vectors USING vec0(
           chunk_id INTEGER PRIMARY KEY, embedding float[512]
         )`
      )
      writeVectorRow(id, unit45())
      expect(
        (
          db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'").get() as {
            sql: string
          }
        ).sql
      ).not.toContain('distance_metric=cosine')

      initDb()

      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'")
        .get() as { sql: string }
      expect(row.sql).toContain('distance_metric=cosine')
      // 向量行没了的 chunks 行必须一起清掉，否则扫描器按 origin_id 判「没变」
      // 会永远跳过它们 ⇒ 永久不可召回
      expect(countAll()).toEqual([0, 0, 0])
    })

    it('量纲已对的库：重跑 initDb() 不动索引数据（不误清）', () => {
      const id = chunksRepo.upsertChunk(chunkInput())
      writeFtsRow(id, '猫咖测试正文')
      writeVectorRow(id, oneHot(0))
      initDb()
      expect(countAll()).toEqual([1, 1, 1])
    })
  })
})

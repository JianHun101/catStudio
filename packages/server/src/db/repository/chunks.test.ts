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
    it('对已有旧表的库重跑 initDb() 零报错、旧表行数不变', () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')`
      ).run()
      db.prepare(
        `INSERT INTO memories (id, agent_id, content, created_at) VALUES ('m1', 'agent-1', '旧记忆', '2026-01-01')`
      ).run()
      const before = {
        agents: db.prepare('SELECT COUNT(*) c FROM agents').get(),
        memories: db.prepare('SELECT COUNT(*) c FROM memories').get(),
      }

      expect(() => initDb()).not.toThrow()
      initDb()

      expect(db.prepare('SELECT COUNT(*) c FROM agents').get()).toEqual(before.agents)
      expect(db.prepare('SELECT COUNT(*) c FROM memories').get()).toEqual(before.memories)
      expect(tableNames()).toContain('chunks')
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
    /** 检索入口（必带 X4 过滤面）——新增导出函数必须在此二表之一，否则本测试爆 */
    const RETRIEVAL_FUNCS = ['searchChunksByVector', 'searchChunksByKeyword']
    /**
     * 非检索导出：`setRepoDb` 配置 / `upsertChunk` 写入 /
     * `getChunksByOrigin` 扫描器增量比对（**必须见全量行含 superseded**，否则孤儿物理删会漏）
     */
    const NON_RETRIEVAL_FUNCS = ['setRepoDb', 'upsertChunk', 'getChunksByOrigin']

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

    it('导出函数集合 = 检索入口 ∪ 非检索（无函数逃逸在断言之外）', () => {
      expect([...bodies.keys()].sort()).toEqual([...RETRIEVAL_FUNCS, ...NON_RETRIEVAL_FUNCS].sort())
    })

    it.each(RETRIEVAL_FUNCS)('%s 函数体含硬排除集合 + NULL 放行', (fn) => {
      const body = bodies.get(fn)
      expect(body, `${fn} 未找到`).toBeTruthy()
      expect(body).toContain("NOT IN ('superseded','deprecated')")
      expect(body).toContain('status IS NULL')
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
})

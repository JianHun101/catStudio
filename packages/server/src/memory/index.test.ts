/**
 * 记忆服务测试（票辛 · 段三检索接线）。
 *
 * 被测面 = `chunks` 检索链：混合召回 → 多查询合并 → 按节补齐 → 按节截断 →
 * 首尾各半 → 注入串。夹具走**真实迁移路径**（`createTestDb()` 造老库 →
 * `initDb()` 跑生产同一条迁移建 chunks 三表 + DROP 旧链表），不手搓 DDL
 * ——手搓等于把被判面换成测试自己写的代理面（票丁 B9 教训）。
 *
 * ⚠️ 本文件曾覆盖 `memories` 表检索链（`searchMemories` / `buildMemoryContext` /
 * `MEMORY_HYBRID_ENABLED` 开关）：整条旧链已随票辛 ⑥ 下线，相应用例一并删除。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository, chunks as chunksRepo } from '../db/repository/index.js'
import { bigramTokenize } from '../db/repository/fts.js'
import type { EmbedResult } from './embedding-client.js'

// 扫描器白名单前缀（真源 = scripts/flywheel/scan.mjs；import 而非手抄，防漂移）
// @ts-expect-error —— 该脚本是无类型声明的 .mjs；宁可这里压一条类型错，也不手抄常量
import { SCAN_PREFIXES as SCAN_PREFIXES_RAW } from '../../../../scripts/flywheel/scan.mjs'

/** 白名单前缀（给上面那条 any 补回类型） */
const SCAN_PREFIXES: string[] = SCAN_PREFIXES_RAW

/**
 * 与夹具正文**无 bigram 交集**的查询词 —— 关键词通道必然空手，排序由向量
 * 通道单独决定。排序敏感的用例（W3 首尾各半 / W5 阈值埋点）用它，避免
 * bm25 与 RRF 把「谁最相关」搅成需要推演的噪声。
 */
const Q = '甲乙丙丁戊'

// ─── 夹具 ─────────────────────────────────────────────

/** 512 维向量：与 vecAt(0) 的余弦距离 = 1 - cos(angleDeg) */
function vecAt(angleDeg: number): number[] {
  const v = new Array(512).fill(0)
  const r = (angleDeg * Math.PI) / 180
  v[0] = Math.cos(r)
  v[1] = Math.sin(r)
  return v
}

let seq = 0

/** 写一片 + 两张派生表（写入侧归扫描器，测试侧照票庚同款预分词手写） */
function seedChunk(opts: {
  docPath?: string
  sectionAnchor?: string
  partIndex?: number
  partTotal?: number
  body: string
  status?: string | null
  angle: number
}): number {
  const docPath = opts.docPath ?? 'docs/adr/0001-a.md'
  const sectionAnchor = opts.sectionAnchor ?? '## 决策'
  const breadcrumb = `${docPath} > 决策`
  seq++
  const id = chunksRepo.upsertChunk({
    docPath,
    sectionAnchor,
    contentHash: `h${seq}`,
    originId: 'blob-1',
    type: 'adr',
    status: opts.status ?? null,
    partIndex: opts.partIndex ?? 1,
    partTotal: opts.partTotal ?? 1,
    body: opts.body,
    breadcrumb,
  })
  getDb()
    .prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)')
    .run(id, bigramTokenize(`${opts.body} ${breadcrumb}`).join(' '))
  getDb()
    .prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)')
    .run(BigInt(id), memoryModule.vectorToBlob(vecAt(opts.angle)))
  return id
}

// ─── Mock：嵌入 + 查询改写（其余全真）─────────────────

let embedOk = true

const mockEmbedText = vi.fn(async (_text: string): Promise<EmbedResult> =>
  embedOk ? { ok: true, vector: vecAt(0) } : { ok: false, reason: 'spawn-failed' }
)

const mockIsMemoryEnabled = vi.fn(() => true)

vi.mock('./embedding.js', () => ({
  embedText: mockEmbedText,
  isMemoryEnabled: mockIsMemoryEnabled,
  getEmbeddingStatus: () => ({ ok: false, reason: 'spawn-failed' }),
}))

const mockRewriteRetrievalQueries = vi.fn(async (): Promise<string[]> => [])

vi.mock('./query-rewrite.js', () => ({
  rewriteRetrievalQueries: mockRewriteRetrievalQueries,
}))

let memoryModule: typeof import('./index.js')

/** 注入串里的条目（去掉【相关记忆】头，逐行拆编号） */
function injectedLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ''))
}

describe('memory', () => {
  beforeAll(async () => {
    memoryModule = await import('./index.js')
  })

  beforeEach(() => {
    setDb(createTestDb())
    // 「老库」先有旧链表，再跑迁移 —— 这样 DROP 条目真的被执行到（不是空跑）
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
        embedding BLOB, source_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize='unicode61');
    `)
    initDb()
    initRepository(getDb())
    vi.clearAllMocks()
    embedOk = true
    mockIsMemoryEnabled.mockReturnValue(true)
    mockRewriteRetrievalQueries.mockResolvedValue([])
  })

  afterEach(() => {
    resetDb()
    delete process.env.MEMORY_TOP_K
    delete process.env.MEMORY_MAX_DISTANCE
    delete process.env.MEMORY_CONTEXT_TOKEN_BUDGET
  })

  describe('vectorToBlob / blobToVector', () => {
    it('roundtrip preserves vector values', () => {
      const vec = [1.5, -2.25, 0, 3.125]
      expect(memoryModule.blobToVector(memoryModule.vectorToBlob(vec))).toEqual(vec)
    })

    it('handles 512-dim vectors', () => {
      const vec = new Array(512).fill(0).map((_, i) => i * 0.5)
      expect(memoryModule.blobToVector(memoryModule.vectorToBlob(vec))).toEqual(vec)
    })

    it('handles empty vector', () => {
      expect(memoryModule.blobToVector(memoryModule.vectorToBlob([]))).toEqual([])
    })
  })

  // ─── W1 ───────────────────────────────────────────────
  describe('W1 注入只来自 chunks', () => {
    it('memories / memories_fts 两表已不存在（迁移真 DROP 掉）', () => {
      const names = (
        getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
      expect(names).not.toContain('memories')
      expect(names).not.toContain('memories_fts')
      expect(names).toContain('chunks')
    })

    it('注入条目的 doc_path 全在白名单前缀内', async () => {
      seedChunk({ docPath: 'docs/adr/0001-a.md', body: '猫咖测试甲', angle: 0 })
      seedChunk({
        docPath: 'docs/plans/x.md',
        sectionAnchor: '## 乙',
        body: '猫咖测试乙',
        angle: 30,
      })

      const r = await memoryModule.retrieveMemoryContext('猫咖测试')
      expect(r.reason).toBe('ok')
      expect(r.sections.length).toBeGreaterThan(0)
      for (const s of r.sections) {
        expect(SCAN_PREFIXES.some((p) => s.docPath.startsWith(p))).toBe(true)
      }
      expect(r.text).toContain('猫咖测试甲')
    })

    it('库里只有 memories 数据（chunks 空）⇒ 一条都注入不出来', async () => {
      // 迁移已把该表 DROP，这里**重建一张**模拟「旧链数据还在」的库
      getDb().exec(
        `CREATE TABLE memories (
           id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
           embedding BLOB, source_message_id TEXT, created_at TEXT
         )`
      )
      getDb()
        .prepare(
          `INSERT INTO memories (id, agent_id, content, source_message_id, created_at)
           VALUES ('m1', 'a1', '旧链遗留内容猫咖', 'msg-1', '2026-01-01')`
        )
        .run()

      const r = await memoryModule.retrieveMemoryContext('猫咖测试')
      expect(r.text).toBe('')
      expect(r.reason).toBe('no-hit')
    })
  })

  // ─── W4 / W11 ─────────────────────────────────────────
  describe('W4 + W11 降级态在结果与日志上可区分', () => {
    it('四态各跑一次 ⇒ reason 两两相异', async () => {
      // ① not-enabled
      mockIsMemoryEnabled.mockReturnValue(false)
      const notEnabled = await memoryModule.retrieveMemoryContext(Q)

      mockIsMemoryEnabled.mockReturnValue(true)
      // ② no-hit（库空）
      const noHit = await memoryModule.retrieveMemoryContext(Q)

      // ③ embed-failed（嵌入链坏 + 无关键词命中）
      embedOk = false
      const embedFailed = await memoryModule.retrieveMemoryContext(Q)

      // ④ filtered-empty（候选池被 X4 状态过滤挡光，嵌入是好的）
      embedOk = true
      seedChunk({ body: '猫咖测试被取代版', status: 'superseded', angle: 0 })
      const filteredEmpty = await memoryModule.retrieveMemoryContext(Q)

      const reasons = [notEnabled.reason, noHit.reason, embedFailed.reason, filteredEmpty.reason]
      expect(reasons).toEqual(['not-enabled', 'no-hit', 'embed-failed', 'filtered-empty'])
      expect(new Set(reasons).size).toBe(4)

      // 四态都必须是「空串 + 有痕」
      for (const r of [notEnabled, noHit, embedFailed, filteredEmpty]) {
        expect(r.text).toBe('')
      }
      // 嵌入失败态带上票丁 reason；召回空态带上池子计数（W11：与嵌入坏可分辨）
      expect(embedFailed.stats.embedReason).toBe('spawn-failed')
      expect(filteredEmpty.stats.blockedByStatus).toBe(1)
      expect(notEnabled.stats.queries).toBe(0)
    })

    it('W11 反向：同一库把 status 放行后立刻召回（空 ≠ 嵌入失败）', async () => {
      seedChunk({ body: '猫咖测试放行版', status: null, angle: 0 })
      const ok = await memoryModule.retrieveMemoryContext(Q)
      expect(ok.reason).toBe('ok')
      expect(ok.text).toContain('猫咖测试放行版')
    })
  })

  // ─── W5 ───────────────────────────────────────────────
  describe('W5 埋点可答问（阈值前 top-N 身份 + 距离）', () => {
    it('差一点被阈值挡掉的条目留在埋点里，且与「无命中」可区分', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.1' // 只有距离 0 的能过
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '猫咖测试甲', angle: 0 })
      seedChunk({ docPath: 'docs/adr/0003-c.md', body: '猫咖测试乙', angle: 45 }) // 距离 ≈0.293

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      expect(r.text).toContain('猫咖测试甲')
      expect(r.text).not.toContain('猫咖测试乙')

      // 埋点含阈值前 top-N 的切片身份 + 距离
      const blocked = r.stats.topCandidates.find((c) => c.docPath === 'docs/adr/0003-c.md')
      expect(blocked).toBeTruthy()
      expect(blocked!.sectionAnchor).toBe('## 决策')
      // 余弦口径（vec0 显式 distance_metric=cosine）——L2 会得 0.7654，见 db/index.ts 注
      expect(blocked!.distance).toBeCloseTo(0.293, 2)
      expect(blocked!.passesStatusFilter).toBe(true)
      expect(r.stats.droppedByThreshold).toBeGreaterThanOrEqual(1)

      // 「空手而归」与「被阈值挡掉」可区分：库空时池子为空、两个计数都归零
      getDb().prepare('DELETE FROM chunks').run()
      getDb().prepare('DELETE FROM chunk_vectors').run()
      getDb().prepare('DELETE FROM chunks_fts').run()
      const empty = await memoryModule.retrieveMemoryContext(Q)
      expect(empty.reason).toBe('no-hit')
      expect(empty.stats.topCandidates).toEqual([])
      expect(empty.stats.droppedByThreshold).toBe(0)
      expect(empty.stats.blockedByStatus).toBe(0)
    })
  })

  // ─── W2 ───────────────────────────────────────────────
  describe('W2 按节截断（不是按块）', () => {
    it('超预算 ⇒ 截断落在节边界，同节片不拆开，token ≤ 上限', async () => {
      process.env.MEMORY_CONTEXT_TOKEN_BUDGET = '200'
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '5'

      // 节甲：单节两片（必须同进同退）
      seedChunk({
        docPath: 'docs/adr/0001-a.md',
        body: '猫咖测试甲上',
        angle: 0,
        partIndex: 1,
        partTotal: 2,
      })
      seedChunk({
        docPath: 'docs/adr/0001-a.md',
        body: '猫咖测试甲下',
        angle: 0,
        partIndex: 2,
        partTotal: 2,
      })
      // 节乙：远超预算的巨片
      seedChunk({
        docPath: 'docs/adr/0002-b.md',
        sectionAnchor: '## 乙',
        body: '猫咖测试乙'.repeat(2000),
        angle: 20,
      })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      expect(r.stats.contextTokens).toBeLessThanOrEqual(200)
      expect(r.stats.truncated).toBe(true)
      expect(r.stats.droppedSections).toBe(1)
      // 整节进退：甲的两片都在，乙一片都不在
      expect(r.text).toContain('猫咖测试甲上')
      expect(r.text).toContain('猫咖测试甲下')
      expect(r.text).not.toContain('猫咖测试乙')
    })

    it('预算小到一节都放不下 ⇒ budget-exhausted（不是静默空串）', async () => {
      process.env.MEMORY_CONTEXT_TOKEN_BUDGET = '1'
      seedChunk({ body: '猫咖测试甲', angle: 0 })
      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.text).toBe('')
      expect(r.reason).toBe('budget-exhausted')
      expect(r.stats.droppedSections).toBe(1)
    })
  })

  // ─── W3 ───────────────────────────────────────────────
  describe('W3 首尾各半（Lost in the Middle）', () => {
    it('最相关条目落在注入串首部或尾部，不落正中段', async () => {
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '4'
      seedChunk({ docPath: 'docs/adr/0001-a.md', body: '猫咖测试甲最相关', angle: 0 })
      seedChunk({
        docPath: 'docs/adr/0002-b.md',
        sectionAnchor: '## 乙',
        body: '猫咖测试乙',
        angle: 30,
      })
      seedChunk({
        docPath: 'docs/adr/0003-c.md',
        sectionAnchor: '## 丙',
        body: '猫咖测试丙',
        angle: 45,
      })
      seedChunk({
        docPath: 'docs/adr/0004-d.md',
        sectionAnchor: '## 丁',
        body: '猫咖测试丁',
        angle: 60,
      })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      const lines = injectedLines(r.text)
      expect(lines.length).toBe(4)

      const pos = lines.findIndex((l) => l.includes('猫咖测试甲最相关'))
      expect([0, lines.length - 1]).toContain(pos)

      // ⚠️ 上面这条（= 票面验收 W3 的字面判据）**不足以**判 W2-b「首尾各半」：
      // 只把最相关的放首位也能过，尾部逆不逆序它看不出来。补一条强判据——
      // 后半段的**最相关**那条必须钉在**最后一位**（Lost in the Middle 的尾锚）。
      // 去掉 `slice(half).reverse()` 这条就会红（反例实跑过）。
      expect(lines[lines.length - 1]).toContain('猫咖测试丙')
    })
  })

  // ─── W12 ──────────────────────────────────────────────
  describe('W12 NULL 行真被放行（运行时断言）', () => {
    it('status IS NULL 与 active 被召回，superseded / deprecated 不召回', async () => {
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '10'
      seedChunk({
        docPath: 'docs/adr/0001-a.md',
        body: '猫咖测试未声明状态',
        status: null,
        angle: 0,
      })
      seedChunk({
        docPath: 'docs/adr/0002-b.md',
        sectionAnchor: '## 乙',
        body: '猫咖测试在用中',
        status: 'active',
        angle: 10,
      })
      seedChunk({
        docPath: 'docs/adr/0003-c.md',
        sectionAnchor: '## 丙',
        body: '猫咖测试已被取代',
        status: 'superseded',
        angle: 20,
      })
      seedChunk({
        docPath: 'docs/adr/0004-d.md',
        sectionAnchor: '## 丁',
        body: '猫咖测试已废弃',
        status: 'deprecated',
        angle: 30,
      })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.text).toContain('猫咖测试未声明状态')
      expect(r.text).toContain('猫咖测试在用中')
      expect(r.text).not.toContain('猫咖测试已被取代')
      expect(r.text).not.toContain('猫咖测试已废弃')
    })
  })

  // ─── 检索形态回归 ─────────────────────────────────────
  describe('检索形态回归', () => {
    it('剥离 @mention 再检索', async () => {
      seedChunk({ body: '猫咖测试甲', angle: 0 })
      await memoryModule.retrieveMemoryContext('@某猫 猫咖测试')
      expect(mockEmbedText).toHaveBeenCalledWith('猫咖测试')
    })

    it('纯 @mention 不触发嵌入（empty-query）', async () => {
      const r = await memoryModule.retrieveMemoryContext('@某猫')
      expect(r.reason).toBe('empty-query')
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('改写查询作为额外检索通道', async () => {
      mockRewriteRetrievalQueries.mockResolvedValue(['改写问句'])
      seedChunk({ body: '猫咖测试甲', angle: 0 })
      await memoryModule.retrieveMemoryContext('猫咖测试')
      expect(mockEmbedText).toHaveBeenCalledWith('改写问句')
    })

    it('嵌入失败降级关键词通道：向量超限但关键词命中的片仍被救回', async () => {
      embedOk = false
      process.env.MEMORY_MAX_DISTANCE = '0.1'
      seedChunk({ body: '猫咖测试甲', angle: 90 }) // 向量距离 1.0，必被阈值挡
      const r = await memoryModule.retrieveMemoryContext('猫咖测试')
      expect(r.reason).toBe('ok')
      expect(r.text).toContain('猫咖测试甲')
    })
  })

  // ─── W8 / W10 静态判据（源码面）────────────────────────
  describe('W8 + W10 接线面静态判据', () => {
    const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url)) // packages/server/src/

    /** 递归收集生产源码（跳过 *.test.ts —— 它们有理由提到旧名字） */
    function sourceFiles(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) sourceFiles(p, out)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
      }
      return out
    }
    const FILES = sourceFiles(SRC_ROOT)
    const rel = (f: string) => path.relative(SRC_ROOT, f).replace(/\\/g, '/')

    it('W8 旧链调用面零残留（函数名带括号 + 读写旧表的 SQL 动作）', () => {
      // ⚠️ 判据**不是**票面那句字面 grep（`searchMemoriesHybrid|memories_fts` 零命中）：
      // `DROP TABLE IF EXISTS memories_fts` 必须写出表名才能执行，而落点就在
      // `db/index.ts` ⇒ 字面 grep **不可能**为零。故判据落在「可执行面」：
      // 函数调用（带 `(`，把文档里的名字提及排除掉）+ 读写旧表的 SQL 动作。
      // DROP 语句用的是 `DROP TABLE IF EXISTS`，不在下表的动词里。
      const CALLS = [
        'searchMemoriesHybrid(',
        'searchMemoriesByKeyword(',
        'insertMemory(',
        'insertMemoryBatch(',
        'updateMemory(',
        'deleteMemoriesByAgent(',
        'deleteAllMemories(',
        'findNearestMemory(',
      ]
      const SQL_OLD =
        /\b(FROM|INTO|JOIN|UPDATE)\s+memories(_fts)?\b|\bDELETE\s+FROM\s+memories(_fts)?\b/i
      const bad: string[] = []
      for (const f of FILES) {
        const src = fs.readFileSync(f, 'utf8')
        for (const c of CALLS) if (src.includes(c)) bad.push(`${rel(f)}: ${c}`)
        const m = src.match(SQL_OLD)
        if (m) bad.push(`${rel(f)}: SQL ${m[0]}`)
      }
      expect(bad).toEqual([])
    })

    it('W8 旧链表 DROP 确实在迁移里（写出旧表名的唯一合法位置）', () => {
      const src = fs.readFileSync(path.join(SRC_ROOT, 'db/index.ts'), 'utf8')
      expect(src).toContain('DROP TABLE IF EXISTS memories_fts')
      expect(src).toContain('DROP TABLE IF EXISTS memories')
    })

    it('W10 全仓无 memories_vec 引用；chunks 向量走 vec0 MATCH 而非 BLOB 扫表', () => {
      const all = FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
      expect(all).not.toContain('memories_vec')
      const chunksSrc = fs.readFileSync(path.join(SRC_ROOT, 'db/repository/chunks.ts'), 'utf8')
      expect(chunksSrc).toContain('embedding MATCH ?')
      expect(chunksSrc).not.toContain('vec_distance_cosine')
    })
  })

  // ─── buildKnowledgeContext（知识库链，形态未变）────────
  describe('buildKnowledgeContext', () => {
    const seedKnowledge = (content: string, angle: number, source = 'doc') => {
      getDb()
        .prepare('INSERT INTO knowledge (id, content, embedding, source) VALUES (?, ?, ?, ?)')
        .run(`kb-${content}`, content, memoryModule.vectorToBlob(vecAt(angle)), source)
    }

    it('命中输出独立【知识库】区块', async () => {
      seedKnowledge('知识库条目一', 0)
      const ctx = await memoryModule.buildKnowledgeContext('猫咖测试')
      expect(ctx).toContain('【知识库】')
      expect(ctx).toContain('知识库条目一')
      expect(ctx).not.toContain('【相关记忆】')
    })

    it('无命中返回空串（空表）', async () => {
      expect(await memoryModule.buildKnowledgeContext('猫咖测试')).toBe('')
    })

    it('纯 @mention 不触发嵌入，返回空串', async () => {
      expect(await memoryModule.buildKnowledgeContext('@某猫')).toBe('')
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('嵌入失败降级空串（不抛）', async () => {
      embedOk = false
      seedKnowledge('知识库条目一', 0)
      await expect(memoryModule.buildKnowledgeContext('猫咖测试')).resolves.toBe('')
    })

    it('0.35 检索阈值：同向召回、正交过滤', async () => {
      seedKnowledge('同向知识', 0)
      seedKnowledge('正交知识', 90)
      const ctx = await memoryModule.buildKnowledgeContext('猫咖测试')
      expect(ctx).toContain('同向知识')
      expect(ctx).not.toContain('正交知识')
    })
  })
})

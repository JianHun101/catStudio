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
import { estimateTokens } from '@cat-study/shared'
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

      // 埋点含阈值前 top-N 的切片身份 + 距离。**按 `source='probe'` 取**——
      // 该池的定义就是「阈值/状态过滤**之前**的原始 KNN 池」，而 `candidates`
      // 现在同列承载 `final`（融合 topK，`passedStatusFilter` 恒 null = 不适用）。
      const blocked = r.stats.candidates.find(
        (c) => c.source === 'probe' && c.docPath === 'docs/adr/0003-c.md'
      )
      expect(blocked).toBeTruthy()
      expect(blocked!.sectionAnchor).toBe('## 决策')
      // 余弦口径（vec0 显式 distance_metric=cosine）——L2 会得 0.7654，见 db/index.ts 注
      expect(blocked!.distance).toBeCloseTo(0.293, 2)
      expect(blocked!.passedStatusFilter).toBe(true)
      expect(r.stats.droppedByThreshold).toBeGreaterThanOrEqual(1)

      // 「空手而归」与「被阈值挡掉」可区分：库空时池子为空、两个计数都归零
      getDb().prepare('DELETE FROM chunks').run()
      getDb().prepare('DELETE FROM chunk_vectors').run()
      getDb().prepare('DELETE FROM chunks_fts').run()
      const empty = await memoryModule.retrieveMemoryContext(Q)
      expect(empty.reason).toBe('no-hit')
      expect(empty.stats.candidates).toEqual([])
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

  // ═══ R1（P2）：检索流水采集 ═══════════════════════════════
  //
  // 判据面在**本模块**（映射与降级路径），不在写口——写口只原样存值
  // （见 `db/repository/retrievalEvents.test.ts` 文件头）。
  describe('R1 检索流水（P2 §四）', () => {
    /** 取某 source 的候选，找不到即断言失败（不用 `!` 掩盖「压根没采到」） */
    const candOf = (r: { stats: { candidates: any[] } }, pred: (c: any) => boolean) =>
      r.stats.candidates.find(pred)

    // ─── 验收 13：MemoryContextStats 扩字段 ────────────
    it('验收 13 · 候选明细同时含 probe 与 final 两类，且带 queryIndex / 参数快照 / 耗时', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      process.env.MEMORY_TOP_K = '3'
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '猫咖测试甲', angle: 0 })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')

      const sources = new Set(r.stats.candidates.map((c) => c.source))
      expect(sources).toEqual(new Set(['final', 'probe']))

      // 每一项都能答「它是哪趟召回的」（跨查询合并后仍要能答）
      for (const c of r.stats.candidates) {
        expect(typeof c.queryIndex).toBe('number')
      }
      // 参数快照与耗时
      expect(r.stats.thresholdMaxDistance).toBe(0.6)
      expect(r.stats.paramTopK).toBe(3)
      expect(r.stats.paramProbeN).toBeGreaterThan(0)
      expect(typeof r.stats.retrievalMs).toBe('number')
      expect(r.stats.retrievalMs).toBeGreaterThanOrEqual(0)
      // 逐趟查询流水
      expect(r.stats.queryTraces).toEqual([{ queryIndex: 0, queryText: Q, queryEmbedOk: true }])
    })

    // ─── 验收 16：channel 三值判定（both）──────────────
    it('验收 16 · 同片被两通道命中 ⇒ channel=both，且两位次都带出', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      // 查询词与正文有 bigram 交集 ⇒ 关键词通道必命中；angle=0 ⇒ 向量通道也命中
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '猫咖测试甲', angle: 0 })

      const r = await memoryModule.retrieveMemoryContext('猫咖测试甲')
      const final = r.stats.candidates.find((c) => c.source === 'final')
      expect(final).toBeTruthy()
      expect(final!.channel).toBe('both')
      // 双通道 ⇒ 距离取向量真值（非 NULL），RRF 分是两通道相加
      expect(final!.distance).not.toBeNull()
      expect(final!.rrfScore).toBeGreaterThan(1 / 61)
    })

    // ─── 验收 4 + 5：降级路径与哨兵退休 ────────────────
    it('验收 5 · 某趟嵌入失败 ⇒ 该趟 queryEmbedOk=0，其候选 channel=keyword（非 both）', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.1' // 向量通道够不着（见下）
      // 原话与夹具无 bigram 交集 ⇒ 原话两通道都拿不到它；改写查询独占关键词通道
      const ORIGINAL = '不含乙的词'
      const REWRITE = '贝塔伽马'
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE])
      // 仅改写那趟嵌入失败——「某趟失败、其余成功」的部分降级场景
      mockEmbedText.mockImplementation(async (text: string): Promise<EmbedResult> =>
        text === REWRITE ? { ok: false, reason: 'spawn-failed' } : { ok: true, vector: vecAt(0) }
      )
      // angle=45 ⇒ 距离 ≈0.293 > 0.1：原话的向量通道过滤掉它（但它在阈值前的探针池里）
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '贝塔伽马正文', angle: 45 })

      const r = await memoryModule.retrieveMemoryContext(ORIGINAL)

      // 逐趟流水：两趟，只有改写那趟 ok=0（与候选行 channel 正交）
      expect(r.stats.queryTraces).toEqual([
        { queryIndex: 0, queryText: ORIGINAL, queryEmbedOk: true },
        { queryIndex: 1, queryText: REWRITE, queryEmbedOk: false },
      ])
      expect(r.reason).toBe('ok')

      // 降级那趟产出的候选：keyword（**不是 both**）——判据是「向量通道压根没跑」
      const fromDegraded = r.stats.candidates.find((c) => c.queryIndex === 1)
      expect(fromDegraded).toBeTruthy()
      expect(fromDegraded!.channel).toBe('keyword')
      // 验收 4：纯关键词命中写 NULL，不写 maxDistance 哨兵
      expect(fromDegraded!.distance).toBeNull()
      // R1-b §三 补分后此处**不再是 null**：降级路径按同一条 RRF 公式有分
      // （`1/(RRF_K + 关键词位次 + 1)`，本行位次 0 ⇒ 1/61）。填 null 会让它在跨查询
      // 求和时静默当 0/NaN——正是 §三 两条禁令之一。分值的完整性由 R1-b 验收 5 守。
      expect(fromDegraded!.rrfScore).toBeCloseTo(1 / 61, 12)

      // 对照组：同一片在阈值前探针池里**带着真距离**（证明 NULL 是通道转换的结果，
      // 不是「本来就取不到距离」）
      const probeRow = r.stats.candidates.find(
        (c) => c.source === 'probe' && c.contentHash === fromDegraded!.contentHash
      )
      expect(probeRow!.distance).toBeCloseTo(0.293, 2)
      expect(probeRow!.droppedReason).toBe('threshold')
    })

    it('验收 4 · channel=vector 的候选 distance 非空', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '猫咖测试甲', angle: 45 })
      const r = await memoryModule.retrieveMemoryContext(Q) // 无 bigram 交集 ⇒ 纯向量
      const final = r.stats.candidates.find((c) => c.source === 'final')
      expect(final!.channel).toBe('vector')
      expect(final!.distance).toBeCloseTo(0.293, 2)
    })

    // ─── 验收 9：位次与注入面 ──────────────────────────
    it('验收 9 · finalRank 与注入序一致，injected=1 的节集合 == 实际注入的节；渲染位次用首尾重排后的编号', async () => {
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '5'
      // 4 节 ⇒ 首尾重排后渲染序为 [0,1,3,2]（n=4 时 half=2，后半逆序）——
      // 选 4 节是为了让重排**可观测**（n=3 时渲染序恰是恒等，测不出问题）
      const docs = ['a', 'b', 'c', 'd']
      docs.forEach((d, i) =>
        seedChunk({ docPath: `docs/adr/000${i + 1}-${d}.md`, body: `猫咖测试${d}`, angle: i * 5 })
      )

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      expect(r.sections.length).toBe(4)

      const finalRows = r.stats.candidates.filter((c) => c.source === 'final')
      // finalRank 是 ordered 的下标（0-based），与注入序同源
      expect(finalRows.map((c) => c.finalRank)).toEqual([0, 1, 2, 3])

      const injected = finalRows.filter((c) => c.injected)
      const injectedSections = new Set(injected.map((c) => `${c.docPath}\0${c.sectionAnchor}`))
      // 「injected=1 的行数 == 实际注入的节点数」的准确形态：**按节去重**后相等
      // （同一节可能有多个片入选，它们在行面上各占一行但只算一个注入节点）
      expect(injectedSections.size).toBe(r.sections.length)
      expect([...injectedSections].map((k) => k.split('\0')[0]).sort()).toEqual(
        r.sections.map((s) => s.docPath).sort()
      )

      // sectionRank = kept 下标（相关度序）；injectedPosition = 渲染后编号 1..n
      expect(finalRows.map((c) => c.sectionRank)).toEqual([0, 1, 2, 3])
      expect(finalRows.map((c) => c.injectedPosition)).toEqual([1, 2, 4, 3])
    })

    // ─── 验收 15：三条 return 路径全覆盖 ────────────────
    it('验收 15 · 空召回路径也带完整 trace（不是无痕）', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('no-hit')
      expect(r.stats.candidates).toEqual([])
      expect(r.stats.queryTraces).toHaveLength(1)
      // 参数快照与耗时在**每条**返回路径上都带（否则「为什么没召回」无解）
      expect(r.stats.thresholdMaxDistance).toBe(0.6)
      expect(typeof r.stats.retrievalMs).toBe('number')
      expect(r.stats.truncated).toBe(false)
    })

    it('验收 15 · budget-exhausted 路径：truncated=true 且 droppedSections 落账', async () => {
      process.env.MEMORY_CONTEXT_TOKEN_BUDGET = '1'
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      seedChunk({ docPath: 'docs/adr/0002-b.md', body: '猫咖测试甲', angle: 0 })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('budget-exhausted')
      // 全程被预算挡掉却记 truncated=false 是这张表最不该产出的谎账
      expect(r.stats.truncated).toBe(true)
      expect(r.stats.droppedSections).toBeGreaterThan(0)
      // 召回是成功的 ⇒ 候选明细仍在（「召回失败」与「注入失败」是两回事）
      expect(r.stats.candidates.some((c) => c.source === 'final')).toBe(true)
      expect(typeof r.stats.retrievalMs).toBe('number')
    })

    it('验收 15 · not-enabled / empty-query 两条早退路径也带参数快照', async () => {
      mockIsMemoryEnabled.mockReturnValue(false)
      const off = await memoryModule.retrieveMemoryContext(Q)
      expect(off.reason).toBe('not-enabled')
      expect(off.stats.paramTopK).toBe(3)
      expect(off.stats.paramProbeN).toBeGreaterThan(0)

      mockIsMemoryEnabled.mockReturnValue(true)
      const blank = await memoryModule.retrieveMemoryContext('@某猫')
      expect(blank.reason).toBe('empty-query')
      expect(blank.stats.paramTopK).toBe(3)
      expect(blank.stats.queryTraces).toEqual([])
    })

    // ─── 验收 17：越界证明 · 未夹带排序改动 ────────────
    describe('验收 17 · 差分法证明未夹带排序/渲染改动', () => {
      /**
       * 改动**前**的 `renderSections`——逐字抄自
       * `git show 18f0fcd:packages/server/src/memory/index.ts`（该行区间未变）。
       * 只取 `text`：旧实现的 `tokens` 也是 `estimateTokens(text)`，同源。
       */
      function renderSectionsBefore(sections: Array<{ parts: string[] }>): string {
        if (sections.length === 0) return ''
        const half = Math.ceil(sections.length / 2)
        const ordered = [...sections.slice(0, half), ...sections.slice(half).reverse()]
        const lines = ordered.map((s, i) => `${i + 1}. ${s.parts.join('\n')}`)
        return `\n\n【相关记忆】\n${lines.join('\n')}`
      }

      it('真实检索下逐窗口对账：n=1..5 的注入串与改动前旧算法逐字节一致', async () => {
        process.env.MEMORY_MAX_DISTANCE = '1.5'
        process.env.MEMORY_TOP_K = '5'
        // 每次多放一节，把 1..5 个节的全量窗口都跑一遍（topK=5 是上界）
        for (let n = 1; n <= 5; n++) {
          getDb().prepare('DELETE FROM chunks').run()
          getDb().prepare('DELETE FROM chunk_vectors').run()
          getDb().prepare('DELETE FROM chunks_fts').run()
          for (let i = 0; i < n; i++) {
            seedChunk({ docPath: `docs/adr/000${i + 1}-x.md`, body: `猫咖测试${i}`, angle: i * 5 })
          }
          const r = await memoryModule.retrieveMemoryContext(Q)
          expect(r.reason).toBe('ok')
          expect(r.sections).toHaveLength(n)
          // 差分：**实际** sections 喂旧算法，与模块实际输出比——不是重抄一遍公式自证
          expect(r.text).toBe(renderSectionsBefore(r.sections))
          expect(r.stats.contextTokens).toBe(estimateTokens(r.text))
          // 改动前该字段就存在且语义未变
          expect(r.stats.truncated).toBe(false)
        }
      })

      it('空召回路径的输出与改动前一致（空串，零 token）', async () => {
        process.env.MEMORY_MAX_DISTANCE = '0.6'
        const r = await memoryModule.retrieveMemoryContext(Q)
        expect(r.text).toBe(renderSectionsBefore([]))
        expect(r.stats.contextTokens).toBe(0)
      })

      // ⚠️ 本用例的**标题与注释**随 R1-b 改写（断言本身不变）：
      // 改动前它守的是「R1 未夹带跨查询合并改排序」；R1-b 正是那一步，
      // 故「未被夹带」的语义已完成。留下的是另一条仍成立的事实——**单趟查询下
      // 名次序与累加分序重合**（`1/(61+rank+1)` 单调递减），所以这条序不受 R1-b 影响。
      // 跨查询的差异由本文件 R1-b 组的验收 1/2 守。
      it('单趟查询下节序 == 名次序（名次序与累加分序在单趟时重合，R1-b 后仍成立）', async () => {
        process.env.MEMORY_MAX_DISTANCE = '1.5'
        process.env.MEMORY_TOP_K = '5'
        const angles = [30, 0, 45, 15]
        angles.forEach((a, i) =>
          seedChunk({ docPath: `docs/adr/000${i + 1}-x.md`, body: `猫咖测试${i}`, angle: a })
        )
        const r = await memoryModule.retrieveMemoryContext(Q)
        // 序 = 距离升序（angle 越小越相关）
        expect(r.sections.map((s) => s.docPath)).toEqual([
          'docs/adr/0002-x.md',
          'docs/adr/0004-x.md',
          'docs/adr/0001-x.md',
          'docs/adr/0003-x.md',
        ])
      })
    })
  })

  // ═══ R1-b：跨查询合并改按 RRF 分累加（**行为变更**）═══════════
  // 病灶三条叠加（票 §一）：查询级出口被调用方 `topK` 砍（池 12 → 本可 80）+
  // 合并键取「名次」而非「跨查询累加分」。本组守 §六 12 条里**可在此文件判定**的
  // 9 条；`param_pool_n` 迁移与落库（7/8）在 `db/repository/retrievalEvents.test.ts`
  // 与 `execution/reply.test.ts`，全套绿与提交纪律（11/12）不在单测内。
  describe('R1-b 跨查询合并改按 RRF 分累加', () => {
    /** 与夹具正文**无 bigram 交集**的改写查询词 ⇒ 关键词通道必然空手，序由向量定 */
    const REWRITE = '佐藤木野'

    // `vi.clearAllMocks()` **不清实现**（只清 calls），逐个用例里换过的嵌入替身会
    // 串到下一个用例 ⇒ 本组自带还原钩子（钉在 `embedOk` 驱动的默认实现上）。
    afterEach(() => {})

    /**
     * 逐查询给**不同向量**：改写趟 `vecAt(90)`、原话趟 `vecAt(0)`。
     * 两趟的名次因此互为镜像。**查询向量相同 ⇒ 名次恒等**（名次只是「查询向量到各片
     * 距离」的排序），故逐查询给不同向量是构造「同一片在两趟里名次不同」的**必要**
     * 条件——也是本组构造「两趟名次可不同」的基础（默认替身对所有文本返回同一向量）。
     * ⚠️ 只声明**必要**：手段不唯一（若关键词通道逐查询有别，向量相同也能让出口名次不同）。
     */
    function embedMirrored(): void {
      mockEmbedText.mockImplementation(async (text: string): Promise<EmbedResult> =>
        text === REWRITE ? { ok: true, vector: vecAt(90) } : { ok: true, vector: vecAt(0) }
      )
    }

    /** 把替身还原成 `embedOk` 驱动的默认实现（`clearAllMocks` 不清实现，会串场） */
    function restoreEmbedMock(): void {
      mockEmbedText.mockImplementation(async (): Promise<EmbedResult> =>
        embedOk ? { ok: true, vector: vecAt(0) } : { ok: false, reason: 'spawn-failed' }
      )
    }

    /** `renderSections` 的渲染序部分——与模块同序（首尾各半），只取 text/tokens */
    function renderBefore(sections: Array<{ parts: string[] }>): { text: string; tokens: number } {
      if (sections.length === 0) return { text: '', tokens: 0 }
      const half = Math.ceil(sections.length / 2)
      const ordered = [...sections.slice(0, half), ...sections.slice(half).reverse()]
      const lines = ordered.map((s, i) => `${i + 1}. ${s.parts.join('\n')}`)
      const text = `\n\n【相关记忆】\n${lines.join('\n')}`
      return { text, tokens: estimateTokens(text) }
    }

    /**
     * **节级段改动前**的实现（按节补齐 → 整节进退的预算截断 → 渲染），逐字抄自
     * `memory/index.ts` 的 `:448-473` + `:558-564`（R1-b 未动这段，故「改动前」= 现在）。
     * 抄它是为了**差分**：把**实跑出来的** `ordered` 喂进来，与模块真实输出逐字节比
     * （验收 9b），而不是重抄一遍公式自证。
     *
     * ⚠️ **与真实现唯一的一处差异，且是有意的**：真实现取不到同节片时退回**命中片的
     * `body`**；而 `ordered` 是从 `stats.candidates`（流水）还原的，流水不携带完整正文
     * （只有 120 字的 `bodyHead` 截断快照）⇒ 这里退回 `chunk.doc_path`（`parts` 恒非空时
     * 该兜底不可达，故不追求与真实现同值，只求分支可达性声明属实）。该分支只有在
     * 「命中后该节被并发删空」时才可达，本组夹具下 `parts` 恒非空 ⇒ **不影响判定力**，
     * 但**不假装它逐字等价**。
     */
    function sectionLevelBefore(
      ordered: Array<{ doc_path: string; section_anchor: string }>,
      budgetTokens: number
    ): { text: string; keys: string[] } {
      const bySection = new Map<
        string,
        { docPath: string; sectionAnchor: string; parts: string[] }
      >()
      for (const chunk of ordered) {
        const key = `${chunk.doc_path}\0${chunk.section_anchor}`
        if (bySection.has(key)) continue
        const parts = chunksRepo.getChunksBySection(chunk.doc_path, chunk.section_anchor)
        bySection.set(key, {
          docPath: chunk.doc_path,
          sectionAnchor: chunk.section_anchor,
          parts: parts.length > 0 ? parts.map((p) => p.body) : [chunk.doc_path],
        })
      }
      const kept: Array<{ docPath: string; sectionAnchor: string; parts: string[] }> = []
      for (const section of bySection.values()) {
        if (renderBefore([...kept, section]).tokens > budgetTokens) break
        kept.push(section)
      }
      return {
        text: renderBefore(kept).text,
        keys: kept.map((s) => `${s.docPath}\0${s.sectionAnchor}`),
      }
    }

    /** 实跑的 `ordered`——只取节级段消费的三个字段（seq 由 `finalRank` 还原） */
    function orderedRowsOf(r: { stats: { candidates: any[] } }): Array<{
      doc_path: string
      section_anchor: string
    }> {
      return r.stats.candidates
        .filter((c) => c.source === 'final')
        .sort((a, b) => a.finalRank - b.finalRank)
        .map((c) => ({ doc_path: c.docPath, section_anchor: c.sectionAnchor }))
    }

    const finalRows = (r: { stats: { candidates: any[] } }) =>
      r.stats.candidates.filter((c) => c.source === 'final')

    // ─── 验收 1 / 9a：查询级池不再被 topK 砍 ──────────────
    it('验收 1 · 池不再被逐查询 topK 砍：A 趟第 5 名 + B 趟第 2 名的片进入合并并胜出', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      // ⚠️ 这个数必须**小**才测得出池：旧实现把 `topK` 同时当「每查询池」与
      // 「最终注入数」，`topK` 一旦 ≥ 库内片数，两趟各自就都拿全了，池扩不扩看不出。
      process.env.MEMORY_TOP_K = '2'
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE])
      embedMirrored()
      // 夹角决定两趟名次（距离 = 1 - cos(夹角)）：
      //   原话趟 vecAt(0) ：乙0 < c10 < c20 < c30 < 甲45 ⇒ 甲 = **第 5 名**（0-based 4）
      //   改写趟 vecAt(90)：丙90 < 甲45(0.293) < c30(0.5)，其余 >0.6 被阈值挡 ⇒ 甲 = **第 2 名**
      seedChunk({ docPath: 'docs/adr/0001-yi.md', body: '猫咖测试乙片', angle: 0 })
      seedChunk({ docPath: 'docs/adr/0002-c10.md', body: '猫咖测试丙片', angle: 10 })
      seedChunk({ docPath: 'docs/adr/0003-c20.md', body: '猫咖测试丁片', angle: 20 })
      seedChunk({ docPath: 'docs/adr/0004-c30.md', body: '猫咖测试戊片', angle: 30 })
      seedChunk({ docPath: 'docs/adr/0005-jia.md', body: '猫咖测试己片', angle: 45 })
      seedChunk({ docPath: 'docs/adr/0006-bing.md', body: '猫咖测试庚片', angle: 90 })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      // 改动前：每查询池 = `params.topK` = 2 ⇒ A 只交回 {乙, c10}、B 只交回 {丙, 甲}，
      // 按名次排序后注入 {乙, 丙}——**甲连参与合并的资格都没有**（这就是本票的理由）。
      // 改动后：池 = 20/趟 ⇒ 甲凭两趟累加分（1/65 + 1/62）压过所有单趟片而胜出。
      expect(r.sections).toHaveLength(2)
      expect(r.sections[0].docPath).toBe('docs/adr/0005-jia.md')
      const jia = finalRows(r).find((c) => c.docPath === 'docs/adr/0005-jia.md')!
      expect(jia.rrfScore).toBeCloseTo(1 / 65 + 1 / 62, 12)
    })

    // ─── 验收 2：累加生效（只改 sort 不改合并守卫 ⇒ 本用例红）──
    it('验收 2 · 甲片 = 两趟都排第 2，压过只在单趟排第 1 的片', async () => {
      process.env.MEMORY_MAX_DISTANCE = '0.6'
      process.env.MEMORY_TOP_K = '1'
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE])
      embedMirrored()
      // 甲 45°：两趟距离均 ≈0.293 ⇒ 两趟都排第 2（0-based 名次 1）
      // 乙 0° ：原话趟距离 0（第 1），改写趟距离 1.0 > 0.6 被阈值挡掉
      // 丙 90°：改写趟距离 0（第 1），原话趟距离 1.0 被挡掉
      seedChunk({ docPath: 'docs/adr/0001-jia.md', body: '猫咖测试甲片', angle: 45 })
      seedChunk({ docPath: 'docs/adr/0002-yi.md', body: '猫咖测试乙片', angle: 0 })
      seedChunk({ docPath: 'docs/adr/0003-bing.md', body: '猫咖测试丙片', angle: 90 })

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')
      // 甲 = 1/62 + 1/62 = 2/62 > 乙/丙各自的 1/61。改动前按 bestIndex 排 ⇒ 乙(0) 胜出。
      expect(r.sections.map((s) => s.docPath)).toEqual(['docs/adr/0001-jia.md'])
      const jia = finalRows(r)[0]
      expect(jia.rrfScore).toBeCloseTo(1 / 62 + 1 / 62, 12)
      expect(jia.rrfScore).toBeGreaterThan(1 / 61)
    })

    // ─── 验收 3：确定性（同夹具连跑两次逐字段一致）──────
    it('验收 3 · 同一夹具连跑两次 ⇒ 注入序与候选行逐字段一致，无 Map 迭代序抖动', async () => {
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '6'
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE])
      embedMirrored()
      for (let i = 0; i < 6; i++) {
        seedChunk({ docPath: `docs/adr/000${i + 1}-q.md`, body: `猫咖测试第${i}片`, angle: i * 15 })
      }

      const first = await memoryModule.retrieveMemoryContext(Q)
      const second = await memoryModule.retrieveMemoryContext(Q)
      expect(second.sections).toEqual(first.sections)
      expect(second.stats.candidates).toEqual(first.stats.candidates)
      expect(first.sections.length).toBeGreaterThan(1) // 夹具非退化：真的有多节参与排序
    })

    // ─── 验收 3 前半句：跨查询同分 ⇒ 按 bestIndex 升序 tie-break ──
    /**
     * 票 §七 曾断言「同分不可构造」（⇒ tie-break 分支不可达 ⇒ 只落地后半句）。
     * **该断言已被证伪，本用例即反例**：片分是 `Σ 1/(61 + 位次)`（位次 = 该趟
     * `searchChunksHybrid` 出口下标），而四位次多重集 `{2,2,2,16}` 与 `{5,5,5,5}`
     * 在 float64 下**精确同分**——`1/77 + 3/63` 与 `4/66` 的有理值同为 `2/33`，
     * 且两条累加路径的舍入结果也逐位相同（实测 `a === b`，非 `toBeCloseTo`）。
     * 穷举 0..19（池上限 20 ⇒ 下标值域）的**全部 8855 个**四元多重集：**有理值**
     * 同分且 `bestIndex` 不同的构型共 **3 组**（`{2,2,2,16}`/`{5,5,5,5}`、
     * `{2,2,2,17}`/`{4,4,4,9}`、`{2,2,19,19}`/`{9,9,9,11}`）；若再要求「float64
     * 累加后**逐位**相等」，则剩 **2 组**（`{2,2,2,17}` 那组 4!×4! 全试无一命中）。
     * ⇒「唯一一组」只在**复合口径**（**本夹具的累加顺序** + `===`）下成立，
     * **不是全域唯一**——判据口径必须写明。
     *
     * 夹具（纯向量：夹具正文与 `Q` / 三条改写词均无 bigram 交集 ⇒ 关键词通道空手，
     * 出口下标 == 向量名次）：
     *   原话趟 θ=180°：中段 5 片占满第 1~5 名 ⇒ 乙 = 第 6 名（0-based 5）；
     *                  甲（0°，对径）落到**末位**（0-based 16）
     *   三条改写趟 θ=30°：近端 2 片（5°/25°）比甲近 ⇒ 甲 = 第 3 名（0-based 2）；
     *                  乙（100°）仍为第 6 名（0-based 5）
     * ⇒ 甲累加分 `1/77 + 3/63`、乙 `4/66`，**精确相等**；甲 `bestIndex`=2 < 乙 5。
     *
     * 判别力（删掉 tie-break 必红）：`merged` 的插入序里**乙先于甲**（原话趟按名次
     * 遍历，乙在第 5 位、甲在第 16 位），`Array#sort` 自 ES2019 起稳定 ⇒ 只按分排序
     * 时乙保留在前，`finalRank` 判据当场反转。
     */
    it('验收 3 前半句 · 跨查询累加分精确同分 ⇒ 按 bestIndex 升序决定先后（分支可达）', async () => {
      // > 2.0（对径 = 距离上限）⇒ 17 片在四趟里全量进池，名次只由夹角决定
      process.env.MEMORY_MAX_DISTANCE = '2.5'
      // 甲/乙按累加分排在第 6/7 位（0-based 5/6）⇒ 两者都进 `ordered`
      process.env.MEMORY_TOP_K = '7'
      // 三条改写词**互不相同**（⇒ 三趟独立查询），但都拿同一个向量（几何相同）
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE, '林原葵', '桐谷莲'])
      mockEmbedText.mockImplementation(async (text: string): Promise<EmbedResult> =>
        text === Q ? { ok: true, vector: vecAt(180) } : { ok: true, vector: vecAt(30) }
      )
      seedChunk({ docPath: 'docs/adr/0001-jia.md', body: '猫咖测试甲片', angle: 0 })
      seedChunk({ docPath: 'docs/adr/0002-yi.md', body: '猫咖测试乙片', angle: 100 })
      const middle = [140, 150, 160, 170, 180]
      middle.forEach((angle, i) =>
        seedChunk({ docPath: `docs/adr/001${i}-mid.md`, body: `猫咖测试中${i}片`, angle })
      )
      const near = [5, 25]
      near.forEach((angle, i) =>
        seedChunk({ docPath: `docs/adr/002${i}-near.md`, body: `猫咖测试近${i}片`, angle })
      )
      const mid2 = [70, 90]
      mid2.forEach((angle, i) =>
        seedChunk({ docPath: `docs/adr/003${i}-out.md`, body: `猫咖测试外${i}片`, angle })
      )
      const far = [265, 275, 285, 295, 305, 315]
      far.forEach((angle, i) =>
        seedChunk({ docPath: `docs/adr/004${i}-far.md`, body: `猫咖测试远${i}片`, angle })
      )

      const r = await memoryModule.retrieveMemoryContext(Q)
      expect(r.reason).toBe('ok')

      const rows = finalRows(r)
      const jia = rows.find((c) => c.docPath === 'docs/adr/0001-jia.md')!
      const yi = rows.find((c) => c.docPath === 'docs/adr/0002-yi.md')!
      // 前提断言：**精确**同分（夹具一旦漂移，本行先红——不会退化成「测了个近似」）
      expect(jia.rrfScore).toBe(yi.rrfScore)
      expect(jia.rrfScore).toBeCloseTo(1 / 77 + 3 / 63, 15)
      // 判别断言：bestIndex 小者在前。删掉 tie-break ⇒ 稳定序把乙排在甲前 ⇒ 本行红
      expect(jia.finalRank).toBeLessThan(yi.finalRank)

      restoreEmbedMock()
    })

    // ─── 验收 4：注入片数仍由 MEMORY_TOP_K 决定 ───────────
    it('验收 4 · 池变大（20/趟）但最终注入片数仍 == MEMORY_TOP_K', async () => {
      mockEmbedText.mockImplementation(async (): Promise<EmbedResult> => ({
        ok: true,
        vector: vecAt(0),
      }))
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      process.env.MEMORY_TOP_K = '3'
      for (let i = 0; i < 6; i++) {
        seedChunk({ docPath: `docs/adr/000${i + 1}-r.md`, body: `猫咖测试第${i}片`, angle: i * 10 })
      }
      const r = await memoryModule.retrieveMemoryContext(Q)
      // 库里有 6 片、池已放到 20/趟（验收 1 守池），但出口仍被 `MEMORY_TOP_K` 切：
      // `ordered` 与 `finalTraces` 都是切完之后的 3 条（消费面口径不变）
      expect(r.sections).toHaveLength(3)
      expect(finalRows(r)).toHaveLength(3)
    })

    // ─── 验收 5：降级路径有分、且不是 NaN ────────────────
    it('验收 5 · 整趟嵌入挂了 ⇒ 关键词路径候选仍有有限正分，finalRank 序列无 NaN', async () => {
      // 显式钉死替身（不靠 `embedOk` + 还原钩子的时序，避免用例结果随执行序漂移）
      mockEmbedText.mockImplementation(async (): Promise<EmbedResult> => ({
        ok: false,
        reason: 'spawn-failed',
      }))
      process.env.MEMORY_MAX_DISTANCE = '0.1'
      for (let i = 0; i < 3; i++) {
        seedChunk({ docPath: `docs/adr/000${i + 1}-s.md`, body: `猫咖测试第${i}片`, angle: i * 30 })
      }
      const r = await memoryModule.retrieveMemoryContext('猫咖测试')
      expect(r.reason).toBe('ok')

      const finals = finalRows(r)
      expect(finals.length).toBeGreaterThan(1)
      for (const c of finals) {
        expect(typeof c.rrfScore).toBe('number')
        expect(Number.isFinite(c.rrfScore)).toBe(true)
        expect(c.rrfScore).toBeGreaterThan(0)
      }
      // 累加分序与 finalRank 同序（NaN 参与比较时该断言必红——NaN 的比较恒 false）
      const byRank = [...finals].sort((a, b) => a.finalRank - b.finalRank)
      for (let i = 1; i < byRank.length; i++) {
        expect(byRank[i - 1].rrfScore).toBeGreaterThanOrEqual(byRank[i].rrfScore)
      }
    })

    // ─── 验收 9b：节级逻辑对任意片级序**逐字节不变** ──────
    it('验收 9b · 节级段差分：实跑 ordered 喂改动前的节级实现，输出逐字节一致', async () => {
      // 覆盖面故意取两组不同形态的 ordered：多节均质（8 片镜像序）与节集合被预算裁过
      process.env.MEMORY_MAX_DISTANCE = '1.5'
      mockRewriteRetrievalQueries.mockResolvedValue([REWRITE])
      embedMirrored()

      // topK=3 < 片数 ⇒ 片级序**确实被 R1-b 改过**（旧序按名次、新序按累加分），
      // 故这组喂进节级实现的 ordered 是「新口径的输入」，差分才有意义
      process.env.MEMORY_TOP_K = '3'
      for (let i = 0; i < 8; i++) {
        seedChunk({ docPath: `docs/adr/000${i + 1}-t.md`, body: `猫咖测试第${i}片`, angle: i * 10 })
      }
      const full = await memoryModule.retrieveMemoryContext(Q)
      expect(full.reason).toBe('ok')
      expect(full.sections).toHaveLength(3)
      const beforeFull = sectionLevelBefore(orderedRowsOf(full), 8000)
      expect(full.text).toBe(beforeFull.text)
      expect(full.sections.map((s) => `${s.docPath}\0${s.sectionAnchor}`)).toEqual(beforeFull.keys)

      // 第二组：预算把节集合裁掉一部分（`break` 起停路径也走一遍）
      process.env.MEMORY_CONTEXT_TOKEN_BUDGET = '60'
      process.env.MEMORY_TOP_K = '6'
      const cut = await memoryModule.retrieveMemoryContext(Q)
      expect(cut.reason).toBe('ok')
      expect(cut.sections.length).toBeLessThan(6) // 夹具非退化：真的发生了预算截断
      const beforeCut = sectionLevelBefore(orderedRowsOf(cut), 60)
      expect(cut.text).toBe(beforeCut.text)
      expect(cut.sections.map((s) => `${s.docPath}\0${s.sectionAnchor}`)).toEqual(beforeCut.keys)
    })
  })
})

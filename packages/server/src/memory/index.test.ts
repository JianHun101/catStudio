/**
 * Memory tests —— 覆盖**只读面**（票壬后本模块无写口）：
 * 向量 ↔ BLOB 转换 / 检索（单通道、双通道、混合）/ 上下文构建。
 *
 * 入库一律走 `memoriesRepo.insertMemory` 直接构造（本模块不再有写函数）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { memories as memoriesRepo, knowledge as knowledgeRepo } from '../db/repository/index.js'
import type { EmbedResult } from './embedding-client.js'

// Mock embedding — return fake 4-dim vectors（票丁后返回形态为 {ok, vector}）
const mockEmbedText = vi.fn(async (text: string): Promise<EmbedResult> => ({
  ok: true,
  vector: [text.length, text.charCodeAt(0) || 0, 1.0, 0.5],
}))

/** 嵌入不可用的降级结果（票丁：失败 = 带 reason 的对象，不再返回空数组） */
const embedFailure = () => ({ ok: false as const, reason: 'spawn-failed' as const })

const mockIsMemoryEnabled = vi.fn(() => true)

vi.mock('./embedding.js', () => ({
  embedText: mockEmbedText,
  isMemoryEnabled: mockIsMemoryEnabled,
  getEmbeddingStatus: () => ({ ok: false, reason: 'spawn-failed' }),
}))

// Mock 查询改写 — 默认不提供额外查询（降级为仅原话检索）
const mockRewriteRetrievalQueries = vi.fn(async (): Promise<string[]> => [])

vi.mock('./query-rewrite.js', () => ({
  rewriteRetrievalQueries: mockRewriteRetrievalQueries,
}))

describe('memory', () => {
  let memoryModule: typeof import('./index.js')

  beforeAll(async () => {
    memoryModule = await import('./index.js')
  })

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    vi.clearAllMocks()
    mockIsMemoryEnabled.mockReturnValue(true)
    mockRewriteRetrievalQueries.mockResolvedValue([])
  })

  afterEach(() => {
    resetDb()
    delete process.env.MEMORY_MAX_DISTANCE
    delete process.env.MEMORY_HYBRID_ENABLED
  })

  describe('vectorToBlob / blobToVector', () => {
    it('roundtrip preserves vector values', () => {
      const original = [1.0, 2.5, 3.14, -0.5]
      const blob = memoryModule.vectorToBlob(original)
      expect(blob).toBeInstanceOf(Buffer)
      expect(blob.length).toBe(16) // Float32 x 4

      const recovered = memoryModule.blobToVector(blob)
      expect(recovered).toHaveLength(4)
      recovered.forEach((val, i) => {
        expect(val).toBeCloseTo(original[i], 5)
      })
    })

    it('handles 512-dim vectors', () => {
      const original = new Array(512).fill(0).map((_, i) => i * 0.001)
      const blob = memoryModule.vectorToBlob(original)
      expect(blob.length).toBe(512 * 4)
      const recovered = memoryModule.blobToVector(blob)
      expect(recovered).toHaveLength(512)
      expect(recovered[511]).toBeCloseTo(0.511, 3)
    })

    it('handles empty vector', () => {
      const blob = memoryModule.vectorToBlob([])
      expect(blob.length).toBe(0)
      const recovered = memoryModule.blobToVector(blob)
      expect(recovered).toEqual([])
    })
  })

  describe('searchMemories', () => {
    it('returns empty array when memory is disabled', async () => {
      mockIsMemoryEnabled.mockReturnValue(false)
      const results = await memoryModule.searchMemories('query')
      expect(results).toEqual([])
    })

    it('returns empty array when embedding fails', async () => {
      mockEmbedText.mockResolvedValueOnce(embedFailure())
      const results = await memoryModule.searchMemories('query')
      expect(results).toEqual([])
    })

    it('searches globally (no agent_id filter)', async () => {
      const db = getDb()
      // 两条不同来源（不同 agent_id）的记忆——直接入库（本模块已无写函数）
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-2', 'ds猫', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      const { vectorToBlob: toBlob } = memoryModule
      const now = new Date().toISOString()
      // mock embedText('x') = [1,120,1,0.5] ⇒ 两条与查询同向（距离 0，必召回）
      memoriesRepo.insertMemory(
        'mem-a',
        'agent-1',
        '来自店长的记忆',
        toBlob([1, 120, 1, 0.5]),
        'msg-1',
        now
      )
      memoriesRepo.insertMemory(
        'mem-b',
        'agent-2',
        '来自ds猫的记忆',
        toBlob([1, 120, 1, 0.5]),
        'msg-2',
        now
      )

      const results = await memoryModule.searchMemories('x')
      // 全局检索：不同 agent_id 来源的记忆都召回（不按 agent 过滤）
      expect(results.map((r) => r.id).sort()).toEqual(['mem-a', 'mem-b'])
    })
  })

  describe('buildMemoryContext', () => {
    it('returns empty string when no memories found', async () => {
      const ctx = await memoryModule.buildMemoryContext('query')
      expect(ctx).toBe('')
    })

    it('strips @mentions before search', async () => {
      mockEmbedText.mockClear()
      await memoryModule.buildMemoryContext('@店长 你好啊')
      // 应使用清洗后的文本做检索，而非原始含 @mention 文本
      expect(mockEmbedText).toHaveBeenCalledWith('你好啊')
    })

    it('returns empty string when trigger is only @mentions', async () => {
      mockEmbedText.mockClear()
      const ctx = await memoryModule.buildMemoryContext('@店长 @ds猫')
      expect(ctx).toBe('')
      // 纯 @mention 不应该触发嵌入
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('uses rewritten queries as additional retrieval channels', async () => {
      mockEmbedText.mockClear()
      mockRewriteRetrievalQueries.mockResolvedValue(['指代消解后的查询'])
      await memoryModule.buildMemoryContext('@店长 你好啊')
      // 双通道: 原话 + 改写查询都要嵌入
      expect(mockEmbedText).toHaveBeenCalledWith('你好啊')
      expect(mockEmbedText).toHaveBeenCalledWith('指代消解后的查询')
      expect(mockRewriteRetrievalQueries).toHaveBeenCalledWith('你好啊')
    })

    it('dedupes rewritten queries identical to the original', async () => {
      mockEmbedText.mockClear()
      mockRewriteRetrievalQueries.mockResolvedValue(['你好啊'])
      await memoryModule.buildMemoryContext('@店长 你好啊')
      // 与原话重复的改写不产生第二次嵌入
      expect(mockEmbedText).toHaveBeenCalledTimes(1)
      expect(mockEmbedText).toHaveBeenCalledWith('你好啊')
    })

    it('filters out memories beyond distance lower bound', async () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      // 手工构造向量直接入库: 一条与 mock 嵌入('x' → [1,120,1,0.5])完全同向(距离 0)，
      // 一条在查询向量无贡献的维度上(距离 ≈ 0.99)
      const { vectorToBlob } = memoryModule
      const now = new Date().toISOString()
      memoriesRepo.insertMemory(
        'mem-near',
        'agent-1',
        '同向的记忆',
        vectorToBlob([1, 120, 1, 0.5]), // == mock embedText('x')
        'msg-1',
        now
      )
      memoriesRepo.insertMemory(
        'mem-far',
        'agent-1',
        '正交的记忆',
        vectorToBlob([0, 0, 1, 0]),
        'msg-2',
        now
      )

      // 严格下限(0.05): 同向记忆被召回，正交记忆被过滤
      process.env.MEMORY_MAX_DISTANCE = '0.05'
      const ctx = await memoryModule.buildMemoryContext('x')
      expect(ctx).toContain('同向的记忆')
      expect(ctx).not.toContain('正交的记忆')
    })
  })

  describe('buildKnowledgeContext', () => {
    afterEach(() => {
      delete process.env.KNOWLEDGE_TOP_K
    })

    /** 插入两条知识条目：同向（距离 0）+ 正交（距离 ≈0.99，0.35 阈值过滤） */
    const insertKnowledgeFixture = () => {
      const { vectorToBlob: toBlob } = memoryModule
      knowledgeRepo.upsertKnowledge(
        'k-near',
        '提交规范：commit 必须带 catstudy [uuid] 标记',
        toBlob([1, 120, 1, 0.5]), // == mock embedText('x')
        'docs/CONTEXT.md',
        ['git']
      )
      knowledgeRepo.upsertKnowledge(
        'k-far',
        '完全无关的知识条目',
        toBlob([0, 0, 1, 0]),
        'docs/roadmap.md',
        ['other']
      )
    }

    it('无命中返回空串（空表）', async () => {
      const ctx = await memoryModule.buildKnowledgeContext('x')
      expect(ctx).toBe('')
    })

    it('纯 @mention 不触发嵌入，返回空串', async () => {
      mockEmbedText.mockClear()
      const ctx = await memoryModule.buildKnowledgeContext('@店长 @ds猫')
      expect(ctx).toBe('')
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('命中输出独立【知识库】区块（与【相关记忆】并列格式）', async () => {
      insertKnowledgeFixture()
      const ctx = await memoryModule.buildKnowledgeContext('x')
      expect(ctx).toContain('【知识库】')
      expect(ctx).toContain('1. 提交规范：commit 必须带 catstudy [uuid] 标记')
      // 区块前缀格式与 buildMemoryContext 同款
      expect(ctx.startsWith('\n\n【知识库】\n')).toBe(true)
      // 独立区块：知识条目不进【相关记忆】
      expect(ctx).not.toContain('【相关记忆】')
    })

    it('剥离 @mention 后检索', async () => {
      insertKnowledgeFixture()
      mockEmbedText.mockClear()
      await memoryModule.buildKnowledgeContext('@店长 提交规范')
      expect(mockEmbedText).toHaveBeenCalledWith('提交规范')
    })

    it('0.35 检索阈值：同向召回、正交过滤（比对话记忆检索更严）', async () => {
      insertKnowledgeFixture()
      const ctx = await memoryModule.buildKnowledgeContext('x')
      expect(ctx).toContain('提交规范')
      expect(ctx).not.toContain('完全无关的知识条目')
    })

    it('嵌入失败降级空串（不抛）', async () => {
      mockEmbedText.mockResolvedValueOnce(embedFailure())
      await expect(memoryModule.buildKnowledgeContext('x')).resolves.toBe('')
    })

    it('KNOWLEDGE_TOP_K 控制返回条数', async () => {
      const { vectorToBlob: toBlob } = memoryModule
      knowledgeRepo.upsertKnowledge('k-a', '条目甲', toBlob([1, 120, 1, 0.5]), 's', ['a'])
      knowledgeRepo.upsertKnowledge('k-b', '条目乙', toBlob([1, 120, 1, 0.5]), 's', ['b'])
      process.env.KNOWLEDGE_TOP_K = '1'
      const ctx = await memoryModule.buildKnowledgeContext('x')
      // topK=1 → 只输出一条
      expect(ctx.match(/^\d+\./gm)).toHaveLength(1)
    })
  })

  describe('hybrid 检索开关', () => {
    /**
     * 夹具：两条记忆（需 FTS 表，beforeEach 自建）：
     * - mem-a "重放机制说明" 向量 [0,0,1,0] → 与 mock embedText('重放') 距离 ≈ 0.99，
     *   纯向量路径被 MEMORY_MAX_DISTANCE(0.6) 过滤；但含关键词"重放" → FTS 通道命中
     * - mem-b "完全无关的其他话题" 向量 [1,120,1,0.5] == mock embedText 同向 → 距离 ≈ 0
     */
    const insertHybridFixture = () => {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize='unicode61')`
      )
      const { vectorToBlob: toBlob } = memoryModule
      const now = new Date().toISOString()
      memoriesRepo.insertMemory('mem-a', 'agent-1', '重放机制说明', toBlob([0, 0, 1, 0]), 'm1', now)
      memoriesRepo.insertMemory(
        'mem-b',
        'agent-1',
        '完全无关的其他话题',
        toBlob([1, 120, 1, 0.5]),
        'm2',
        now
      )
    }

    it('开关默认关（isHybridRetrievalEnabled=false），设 1 开启', () => {
      expect(memoryModule.isHybridRetrievalEnabled()).toBe(false)
      process.env.MEMORY_HYBRID_ENABLED = '1'
      expect(memoryModule.isHybridRetrievalEnabled()).toBe(true)
    })

    it('开关关（默认）：行为与现网一致——向量距离过滤依旧生效，关键词救回不出现', async () => {
      insertHybridFixture()
      const ctx = await memoryModule.buildMemoryContext('重放')
      // mem-a 向量距离超限被过滤（与纯向量路径逐字节一致）
      expect(ctx).not.toContain('重放机制说明')
      expect(ctx).toContain('完全无关的其他话题')
    })

    it('开关开：FTS 关键词通道救回向量距离超限的记忆（RRF 融合生效）', async () => {
      insertHybridFixture()
      process.env.MEMORY_HYBRID_ENABLED = '1'
      const ctx = await memoryModule.buildMemoryContext('重放')
      expect(ctx).toContain('重放机制说明')
      expect(ctx).toContain('完全无关的其他话题')
    })

    it('开关开但 FTS 表缺失：降级纯向量不抛', async () => {
      insertHybridFixture()
      getDb().exec('DROP TABLE IF EXISTS memories_fts')
      process.env.MEMORY_HYBRID_ENABLED = '1'
      await expect(memoryModule.buildMemoryContext('重放')).resolves.toContain('完全无关的其他话题')
    })
  })
})

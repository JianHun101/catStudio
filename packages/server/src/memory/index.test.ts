/**
 * Memory tests — 注意: 测试环境不加载 sqlite-vec 原生扩展，
 * 因此涉及 vec_distance_cosine() 的去重/更新逻辑需要禁用。
 *
 * 共享记忆模式: 检索不再按 agent_id 过滤，存储只写一行。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { memories as memoriesRepo } from '../db/repository/index.js'

// 禁用去重/更新（避免 sqlite-vec vec_distance_cosine 不可用）
process.env.MEMORY_DEDUP_ENABLED = '0'

// Mock embedding — return fake 4-dim vectors
const mockEmbedText = vi.fn(async (text: string) => {
  return [text.length, text.charCodeAt(0) || 0, 1.0, 0.5]
})

const mockIsMemoryEnabled = vi.fn(() => true)

vi.mock('./embedding.js', () => ({
  embedText: mockEmbedText,
  isMemoryEnabled: mockIsMemoryEnabled,
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

  describe('saveMessageMemory', () => {
    it('does nothing when memory is disabled', async () => {
      mockIsMemoryEnabled.mockReturnValue(false)
      await memoryModule.saveMessageMemory('s1', 'hello', 'msg-1', ['agent-1'])
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('does nothing when agentIds is empty', async () => {
      await memoryModule.saveMessageMemory('s1', 'hello', 'msg-1', [])
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('skips gracefully when embedding fails', async () => {
      mockEmbedText.mockRejectedValueOnce(new Error('model not loaded'))
      // Should not throw
      await expect(
        memoryModule.saveMessageMemory('s1', 'hello', 'msg-1', ['agent-1'])
      ).resolves.toBeUndefined()
    })

    it('stores only one row regardless of agent count (shared memory)', async () => {
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      await memoryModule.saveMessageMemory('s1', '我喜欢日料', 'msg-1', [
        'agent-1',
        'agent-2',
        'agent-3',
      ])

      const rows = db.prepare('SELECT * FROM memories').all()
      // 共享模式：只存一行
      expect(rows).toHaveLength(1)
    })

    it('uses first agentId as provenance', async () => {
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      await memoryModule.saveMessageMemory('s1', 'test content', 'msg-1', ['agent-1', 'agent-2'])

      const row = db.prepare('SELECT agent_id FROM memories').get() as { agent_id: string }
      expect(row.agent_id).toBe('agent-1')
    })

    it('strips @mentions before storing content', async () => {
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      await memoryModule.saveMessageMemory('s1', '@店长 我喜欢日料', 'msg-1', ['agent-1'])

      const row = db.prepare('SELECT content FROM memories').get() as {
        content: string
      }
      // @mention 应从存储内容中剥离
      expect(row.content).toBe('我喜欢日料')
      // embedding 应基于清洗后文本生成
      expect(mockEmbedText).toHaveBeenCalledWith('我喜欢日料')
    })

    it('skips when message is only @mentions', async () => {
      await memoryModule.saveMessageMemory('s1', '@店长 @ds猫', 'msg-1', ['agent-1'])
      // 纯 @mention 消息应在嵌入前就跳过
      expect(mockEmbedText).not.toHaveBeenCalled()
    })

    it('filters out one-time task instructions before embedding', async () => {
      await memoryModule.saveMessageMemory('s1', '帮我修一下登录bug', 'msg-1', ['agent-1'])
      // 一次性指令在嵌入前就被筛选拦截
      expect(mockEmbedText).not.toHaveBeenCalled()
      const db = (await import('../db/index.js')).getDb()
      const count = (db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number })
        .cnt
      expect(count).toBe(0)
    })

    it('stores standing preferences (filter allows)', async () => {
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      ).run()

      await memoryModule.saveMessageMemory('s1', '以后都用中文回复', 'msg-1', ['agent-1'])
      expect(mockEmbedText).toHaveBeenCalledWith('以后都用中文回复')
      const row = db.prepare('SELECT content FROM memories').get() as { content: string }
      expect(row.content).toBe('以后都用中文回复')
    })
  })

  describe('searchMemories', () => {
    it('returns empty array when memory is disabled', async () => {
      mockIsMemoryEnabled.mockReturnValue(false)
      const results = await memoryModule.searchMemories('query')
      expect(results).toEqual([])
    })

    it('returns empty array when embedding fails', async () => {
      mockEmbedText.mockRejectedValueOnce(new Error('model error'))
      const results = await memoryModule.searchMemories('query')
      expect(results).toEqual([])
    })

    it('searches globally (no agent_id filter)', async () => {
      const db = (await import('../db/index.js')).getDb()
      // 插入两条不同来源（不同 agent_id）的记忆
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

      await memoryModule.saveMessageMemory('s1', '来自店长的记忆', 'msg-1', ['agent-1'])
      await memoryModule.saveMessageMemory('s1', '来自ds猫的记忆', 'msg-2', ['agent-2'])

      // 全局搜索应该能找到两条（不考虑 distance 排序，只要 count 够）
      const db2 = getDb()
      const count = (db2.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number })
        .cnt
      expect(count).toBe(2)
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
})

/**
 * Memories repo 向量检索测试 — 真实 sqlite-vec（createTestDb 已加载扩展）。
 *
 * 使用手工构造的归一化向量验证距离下限过滤、排序与 top-K。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository } from './index.js'
import { memories as memoriesRepo } from './index.js'
import { vectorToBlob } from '../../memory/index.js'
import { v4 as uuid } from 'uuid'

/** 与 db/index.ts 迁移同构的 FTS 表 DDL（测试环境手搓 schema 需自建） */
const FTS_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tokenize='unicode61'
)`

// 归一化向量: [1,0,0,0] 与 [0,1,0,0] 正交 → 余弦距离 = 1
const V_QUERY = [1, 0, 0, 0]
const V_SAME = [1, 0, 0, 0]
const V_ORTHOGONAL = [0, 1, 0, 0]
const V_RELATED = [0.707, 0.707, 0, 0] // 与查询夹角 45° → 距离 ≈ 0.293

describe('memories repo 向量检索', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    getDb()
      .prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      )
      .run()
    const now = new Date().toISOString()
    memoriesRepo.insertMemory(uuid(), 'agent-1', '完全相同的记忆', vectorToBlob(V_SAME), 'm1', now)
    memoriesRepo.insertMemory(
      uuid(),
      'agent-1',
      '部分相关的记忆',
      vectorToBlob(V_RELATED),
      'm2',
      now
    )
    memoriesRepo.insertMemory(
      uuid(),
      'agent-1',
      '完全无关的记忆',
      vectorToBlob(V_ORTHOGONAL),
      'm3',
      now
    )
  })

  afterEach(() => {
    resetDb()
  })

  it('宽松距离下限召回全部并按距离排序', () => {
    const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 1.5)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.content)).toEqual([
      '完全相同的记忆',
      '部分相关的记忆',
      '完全无关的记忆',
    ])
    expect(rows[0].distance).toBeCloseTo(0, 5)
    expect(rows[1].distance).toBeCloseTo(0.293, 2)
    expect(rows[2].distance).toBeCloseTo(1, 5)
  })

  it('严格距离下限过滤掉低相关记忆', () => {
    // 距离下限 0.5: 只召回"完全相同"(0) 和"部分相关"(≈0.293)
    const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 0.5)
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toBe('完全相同的记忆')
    expect(rows[1].content).toBe('部分相关的记忆')

    // 距离下限 0.1: 只召回"完全相同"
    const strict = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 0.1)
    expect(strict).toHaveLength(1)
    expect(strict[0].content).toBe('完全相同的记忆')
  })

  it('距离下限为 0 时不召回任何记忆', () => {
    const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 0)
    expect(rows).toHaveLength(0)
  })

  it('top-K 截断在距离过滤之后生效', () => {
    const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 2, 1.5)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.content)).toEqual(['完全相同的记忆', '部分相关的记忆'])
  })

  it('返回字段映射完整', () => {
    const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 1, 1.5)
    expect(rows[0]).toMatchObject({
      id: expect.any(String),
      content: '完全相同的记忆',
      source_message_id: 'm1',
      created_at: expect.any(String),
      distance: expect.any(Number),
    })
  })
})

// ─── FTS5 关键词通道 / 混合检索 ────────────────────────

describe('memories FTS5 关键词通道 / 混合检索', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    // 测试环境手搓 schema 无 FTS 表，此处按迁移 DDL 自建（幂等验证并入用例）
    getDb().exec(FTS_TABLE_SQL)
    getDb()
      .prepare(
        `
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
        VALUES ('agent-1', '店长', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
      `
      )
      .run()
    const now = new Date().toISOString()
    memoriesRepo.insertMemory(
      'mem-fts-a',
      'agent-1',
      '重放机制说明',
      vectorToBlob(V_SAME),
      'm1',
      now
    )
    memoriesRepo.insertMemory(
      'mem-fts-b',
      'agent-1',
      '完全无关的内容',
      vectorToBlob(V_ORTHOGONAL),
      'm2',
      now
    )
  })

  afterEach(() => {
    resetDb()
  })

  describe('bigram 分词', () => {
    it('中英混排按相邻两字符切分', () => {
      expect(memoriesRepo.bigramTokenize('猫咖测试abc')).toEqual([
        '猫咖',
        '咖测',
        '测试',
        '试a',
        'ab',
        'bc',
      ])
    })

    it('空串与单字符返回空数组', () => {
      expect(memoriesRepo.bigramTokenize('')).toEqual([])
      expect(memoriesRepo.bigramTokenize('猫')).toEqual([])
    })

    it('孤立代理片段跳过（emoji 半截码元不产生脏 token）', () => {
      // '😺猫' 码元序列: [D83D, DE3A, 猫]——slice(1,3) 是孤立低代理，应被跳过
      expect(memoriesRepo.bigramTokenize('😺猫')).toEqual(['😺'])
    })
  })

  describe('buildFtsQuery', () => {
    it('切分后每个 bigram 短语化（AND 语义）', () => {
      expect(memoriesRepo.buildFtsQuery('重放机制')).toBe('"重放" "放机" "机制"')
    })

    it('查询端过滤停用词，不截断剩余词', () => {
      // "什么样的呢" → 什么/么样/样的/的呢 → 停用"什么""的呢"，剩"么样""样的"
      expect(memoriesRepo.buildFtsQuery('什么样的呢')).toBe('"么样" "样的"')
    })

    it('纯停用词/空查询返回 null（调用方降级纯向量）', () => {
      expect(memoriesRepo.buildFtsQuery('什么')).toBeNull()
      expect(memoriesRepo.buildFtsQuery('')).toBeNull()
    })

    it('含 FTS 特殊字符的 bigram 跳过', () => {
      // "a*b" → a*/ *b 均含 * → 无剩余词
      expect(memoriesRepo.buildFtsQuery('a*b')).toBeNull()
    })
  })

  describe('searchMemoriesByKeyword', () => {
    it('召回含查询词的记忆（bm25 排序）', () => {
      const rows = memoriesRepo.searchMemoriesByKeyword('重放', 10)
      expect(rows.map((r) => r.id)).toEqual(['mem-fts-a'])
      expect(rows[0].content).toBe('重放机制说明')
    })

    it('关键词不命中时返回空数组', () => {
      expect(memoriesRepo.searchMemoriesByKeyword('不存在的词', 10)).toEqual([])
    })

    it('FTS 表缺失时返回空数组（调用方降级纯向量）', () => {
      getDb().exec('DROP TABLE IF EXISTS memories_fts')
      expect(memoriesRepo.searchMemoriesByKeyword('重放', 10)).toEqual([])
    })
  })

  describe('searchMemoriesHybrid', () => {
    it('两通道都命中的记忆排前，纯关键词命中被救回（distance=maxDistance 边界值）', () => {
      // 查询向量=V_QUERY：mem-fts-a 距离 0（向量 rank1）+ 关键词命中 → RRF 双通道分
      // 再插一条：向量正交（被 maxDistance 过滤）、关键词命中"重放" → 纯关键词救回
      const now = new Date().toISOString()
      memoriesRepo.insertMemory(
        'mem-fts-c',
        'agent-1',
        '重放调度逻辑说明',
        vectorToBlob(V_ORTHOGONAL),
        'm3',
        now
      )
      // 关键词通道 bm25：mem-fts-a 短文档分高于 mem-fts-c，双通道命中 → 必排第一
      const rows = memoriesRepo.searchMemoriesHybrid(vectorToBlob(V_QUERY), '重放', 10, 0.6)
      expect(rows[0].id).toBe('mem-fts-a')
      const ids = rows.map((r) => r.id)
      expect(ids).toContain('mem-fts-c')
      const keywordOnly = rows.find((r) => r.id === 'mem-fts-c')
      // 纯关键词命中：distance 填 maxDistance 边界值（语义见 repo 注释）
      expect(keywordOnly!.distance).toBe(0.6)
    })

    it('关键词通道无命中时退化为纯向量 topK（距离真值保留）', () => {
      const rows = memoriesRepo.searchMemoriesHybrid(vectorToBlob(V_QUERY), '无此词', 10, 1.5)
      // mem-fts-a 距离 0 排前；mem-fts-b 正交（距离 1 < 1.5）也被召回
      expect(rows.map((r) => r.id)).toEqual(['mem-fts-a', 'mem-fts-b'])
      expect(rows[0].distance).toBeCloseTo(0, 5)
    })

    it('topK 截断在融合排序后生效', () => {
      const now = new Date().toISOString()
      memoriesRepo.insertMemory(
        'mem-fts-c',
        'agent-1',
        '重放调度逻辑说明',
        vectorToBlob(V_ORTHOGONAL),
        'm3',
        now
      )
      const rows = memoriesRepo.searchMemoriesHybrid(vectorToBlob(V_QUERY), '重放', 1, 0.6)
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('mem-fts-a')
    })
  })

  describe('FTS 双写同步', () => {
    it('插入记忆同步写 FTS 行（rowid 对齐，内容为 bigram 预分词串）', () => {
      const ftsRows = getDb()
        .prepare('SELECT rowid, content FROM memories_fts ORDER BY rowid')
        .all() as Array<{ rowid: number; content: string }>
      expect(ftsRows).toHaveLength(2)
      expect(ftsRows[0].content).toBe('重放 放机 机制 制说 说明')
      // rowid 与 memories 表一致（检索 JOIN 依赖）
      const memRowid = getDb()
        .prepare("SELECT rowid FROM memories WHERE id = 'mem-fts-a'")
        .get() as { rowid: number }
      expect(ftsRows[0].rowid).toBe(memRowid.rowid)
    })

    it('更新记忆后 FTS 行整删重建（新 bigram 生效）', () => {
      const now = new Date().toISOString()
      memoriesRepo.updateMemory('mem-fts-a', '定时重放', vectorToBlob(V_SAME), 'm1-updated', now)
      const ftsRow = getDb()
        .prepare(
          "SELECT content FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = 'mem-fts-a')"
        )
        .get() as { content: string }
      expect(ftsRow.content).toBe('定时 时重 重放')
      // 旧内容 bigram 不再存在
      const old = getDb()
        .prepare("SELECT COUNT(*) as cnt FROM memories_fts WHERE content LIKE '%说明%'")
        .get() as { cnt: number }
      expect(old.cnt).toBe(0)
    })

    it('按 agent 删除记忆同步删 FTS 行', () => {
      memoriesRepo.deleteMemoriesByAgent('agent-1')
      const cnt = getDb().prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as {
        cnt: number
      }
      expect(cnt.cnt).toBe(0)
    })

    it('清空记忆同步清空 FTS 表', () => {
      memoriesRepo.deleteAllMemories()
      const cnt = getDb().prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as {
        cnt: number
      }
      expect(cnt.cnt).toBe(0)
    })

    it('批量插入同步写 FTS 行', () => {
      // 走 repo 清空（裸 DELETE 绕过双写会让 FTS 残留旧 rowid 与新行冲突）
      memoriesRepo.deleteAllMemories()
      const now = new Date().toISOString()
      memoriesRepo.insertMemoryBatch([
        {
          id: 'batch-1',
          agentId: 'agent-1',
          content: '批量记忆甲',
          embeddingBlob: vectorToBlob(V_SAME),
          sourceMessageId: 'b1',
          createdAt: now,
        },
        {
          id: 'batch-2',
          agentId: 'agent-1',
          content: '批量记忆乙',
          embeddingBlob: vectorToBlob(V_ORTHOGONAL),
          sourceMessageId: 'b2',
          createdAt: now,
        },
      ])
      const ftsCnt = getDb().prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as {
        cnt: number
      }
      expect(ftsCnt.cnt).toBe(2)
      // 批量内容可被关键词通道检索到
      const rows = memoriesRepo.searchMemoriesByKeyword('批量', 10)
      expect(rows.map((r) => r.id).sort()).toEqual(['batch-1', 'batch-2'])
    })

    it('FTS 表缺失时双写静默跳过（记忆存储照常）', () => {
      getDb().exec('DROP TABLE IF EXISTS memories_fts')
      const now = new Date().toISOString()
      // 不抛
      memoriesRepo.insertMemory(
        'mem-no-fts',
        'agent-1',
        '无 FTS 表的记忆',
        vectorToBlob(V_SAME),
        'm9',
        now
      )
      memoriesRepo.updateMemory('mem-no-fts', '更新后', vectorToBlob(V_SAME), 'm9', now)
      memoriesRepo.deleteMemoriesByAgent('agent-1')
      memoriesRepo.deleteAllMemories()
      const cnt = getDb().prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }
      expect(cnt.cnt).toBe(0)
    })
  })

  describe('迁移幂等', () => {
    it('FTS 表 DDL 重复执行不炸（同现有迁移 try/catch 幂等语义）', () => {
      expect(() => {
        getDb().exec(FTS_TABLE_SQL)
        getDb().exec(FTS_TABLE_SQL)
      }).not.toThrow()
    })
  })
})

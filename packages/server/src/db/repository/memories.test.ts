/**
 * 检索链共享底座测试 —— bigram 分词 / FTS5 MATCH 表达式 / 向量查询体。
 *
 * ⚠️ 本文件曾覆盖 `memories` 表的写入、关键词通道与混合检索：那张表连同整条旧链
 * 已随段三检索接线下线（票辛 ⑥ 双 DROP），相应用例一并删除。`chunks` 侧的
 * 混合检索 / RRF 用例在 `chunks.test.ts`（票己 + 票辛）。
 *
 * 保留下来的是**与表无关**的两件共享件：bigram 切分（`chunks_fts` 两侧对称的
 * 唯一实现）与 `searchMemoriesByVector` 的参数化查询体（仍服务 `knowledge`）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository } from './index.js'
import { memories as memoriesRepo } from './index.js'
import { vectorToBlob } from '../../memory/index.js'

// 归一化向量: [1,0,0,0] 与 [0,1,0,0] 正交 → 余弦距离 = 1
const V_QUERY = [1, 0, 0, 0]
const V_SAME = [1, 0, 0, 0]
const V_ORTHOGONAL = [0, 1, 0, 0]
const V_RELATED = [0.707, 0.707, 0, 0] // 与查询夹角 45° → 距离 ≈ 0.293

describe('memories repo 共享底座', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
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

  describe('searchMemoriesByVector（knowledge 表）', () => {
    beforeEach(() => {
      const now = new Date().toISOString()
      const insert = getDb().prepare(
        `INSERT INTO knowledge (id, content, embedding, source, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      insert.run('kb-1', '完全相同的知识', vectorToBlob(V_SAME), 'doc-a', now)
      insert.run('kb-2', '部分相关的知识', vectorToBlob(V_RELATED), 'doc-b', now)
      insert.run('kb-3', '完全无关的知识', vectorToBlob(V_ORTHOGONAL), 'doc-c', now)
    })

    it('宽松距离下限召回全部并按距离排序', () => {
      const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 1.5)
      expect(rows.map((r) => r.content)).toEqual([
        '完全相同的知识',
        '部分相关的知识',
        '完全无关的知识',
      ])
      expect(rows[0].distance).toBeCloseTo(0, 5)
      expect(rows[1].distance).toBeCloseTo(0.293, 2)
      expect(rows[2].distance).toBeCloseTo(1, 5)
    })

    it('严格距离下限过滤掉低相关知识', () => {
      const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 0.5)
      expect(rows.map((r) => r.content)).toEqual(['完全相同的知识', '部分相关的知识'])

      const strict = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 0.1)
      expect(strict.map((r) => r.content)).toEqual(['完全相同的知识'])
    })

    it('top-K 截断在距离过滤之后生效', () => {
      const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 2, 1.5)
      expect(rows.map((r) => r.content)).toEqual(['完全相同的知识', '部分相关的知识'])
    })

    it('返回字段映射完整（source → source_message_id 载体列）', () => {
      const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 1, 1.5)
      expect(rows[0]).toMatchObject({
        id: 'kb-1',
        content: '完全相同的知识',
        source_message_id: 'doc-a',
        created_at: expect.any(String),
        distance: expect.any(Number),
      })
    })

    it('默认参数即 knowledge（无需显式传表名）', () => {
      const rows = memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 1, 1.5)
      expect(rows[0].id).toBe('kb-1')
    })

    it('白名单外的表名抛 TypeError（含已下线的 memories）', () => {
      // 票辛 ⑥：`memories` 表已 DROP，若还留在白名单里，默认参数就会变成
      // 「调到就 no such table」的隐形地雷 ⇒ 显式抛类型错，不静默换表
      expect(() =>
        memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 1.5, 'memories' as never)
      ).toThrow(TypeError)
      expect(() =>
        memoriesRepo.searchMemoriesByVector(vectorToBlob(V_QUERY), 10, 1.5, 'messages' as never)
      ).toThrow(TypeError)
    })
  })
})

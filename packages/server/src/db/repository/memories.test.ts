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

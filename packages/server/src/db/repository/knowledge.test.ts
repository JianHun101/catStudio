/**
 * Knowledge repo 测试（知识库 Phase 1）— 真实 sqlite-vec（createTestDb 已加载扩展）。
 *
 * 覆盖：upsert 幂等（ON CONFLICT + COALESCE 嵌入保护）、检索排序/阈值
 * （maxDistance=0.35）、source 列映射、top-K 截断。
 *
 * ⚠️ 表名白名单用例已随机制删除（2026-09-14）：`searchKnowledgeByVector` 原先委托
 * 一个共享底座模块的参数化向量查询体并做表名白名单校验，而白名单只剩 `knowledge`
 * 一个值 ⇒ 参数化表名与 `TypeError` 分支退化为死代码，整体删除（查询体已内联）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository, knowledge as knowledgeRepo } from './index.js'
import { vectorToBlob } from '../../memory/index.js'

// 归一化向量
const V_QUERY = [1, 0, 0, 0]
const V_SAME = [1, 0, 0, 0]
const V_ORTHOGONAL = [0, 1, 0, 0]
const V_RELATED = [0.707, 0.707, 0, 0] // 与查询夹角 45° → 距离 ≈ 0.293

describe('knowledge repo', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    knowledgeRepo.upsertKnowledge('k1', '提交规范知识', vectorToBlob(V_SAME), 'docs/CONTEXT.md', [
      'git',
    ])
    knowledgeRepo.upsertKnowledge('k2', 'MCP 路由知识', vectorToBlob(V_RELATED), 'docs/adr', [
      'mcp',
    ])
    knowledgeRepo.upsertKnowledge(
      'k3',
      '完全无关的知识',
      vectorToBlob(V_ORTHOGONAL),
      'docs/roadmap.md',
      ['other']
    )
  })

  afterEach(() => {
    resetDb()
  })

  it('upsert 幂等：同 id 重插不报错、行数不变', () => {
    knowledgeRepo.upsertKnowledge(
      'k1',
      '提交规范知识（更新版）',
      vectorToBlob(V_SAME),
      'docs/CONTEXT.md',
      ['git']
    )
    const rows = getDb().prepare('SELECT * FROM knowledge').all()
    expect(rows).toHaveLength(3)
    const k1 = getDb().prepare('SELECT content FROM knowledge WHERE id = ?').get('k1') as {
      content: string
    }
    expect(k1.content).toBe('提交规范知识（更新版）')
  })

  it('upsert 嵌入 NULL 不冲掉既有嵌入（COALESCE 保护）', () => {
    // 先有嵌入，后一次嵌入失败（NULL）→ 保留旧嵌入
    knowledgeRepo.upsertKnowledge('k1', '内容更新但嵌入失败', null, 'docs/CONTEXT.md', ['git'])
    const k1 = getDb().prepare('SELECT embedding FROM knowledge WHERE id = ?').get('k1') as {
      embedding: Buffer | null
    }
    expect(k1.embedding).not.toBeNull()
    // 内容仍更新（content 不在 COALESCE 保护内）
    const content = getDb().prepare('SELECT content FROM knowledge WHERE id = ?').get('k1') as {
      content: string
    }
    expect(content.content).toBe('内容更新但嵌入失败')
  })

  it('searchKnowledgeByVector 命中相关文档并按 distance 升序（宽松阈值全召回）', () => {
    const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 10, 1.5)
    expect(rows.map((r) => r.id)).toEqual(['k1', 'k2', 'k3'])
    expect(rows[0].distance).toBeCloseTo(0, 5)
    expect(rows[1].distance).toBeCloseTo(0.293, 2)
  })

  it('默认 maxDistance=0.35 过滤低相关条目（严格阈值）', () => {
    // V_RELATED 距离 ≈ 0.293 < 0.35 → 召回；V_ORTHOGONAL 距离 1 → 过滤
    const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 10)
    expect(rows.map((r) => r.id)).toEqual(['k1', 'k2'])
    // 显式更严阈值：0.2 → 只召回 k1
    const strict = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 10, 0.2)
    expect(strict.map((r) => r.id)).toEqual(['k1'])
  })

  it('top-K 截断生效', () => {
    const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('k1')
  })

  it('source 列映射为结果 source 字段', () => {
    const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 1)
    expect(rows[0]).toMatchObject({
      id: 'k1',
      content: '提交规范知识',
      source: 'docs/CONTEXT.md',
      created_at: expect.any(String),
      distance: expect.any(Number),
    })
  })

  it('距离下限过滤与 top-K 截断的顺序（截断在过滤之后）', () => {
    // 0.5 下限：k3（距离 1）先被挡掉，再从剩下的里取 top-1
    const rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 1, 0.5)
    expect(rows.map((r) => r.id)).toEqual(['k1'])
    const wider = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(V_QUERY), 10, 0.5)
    expect(wider.map((r) => r.id)).toEqual(['k1', 'k2'])
    expect(wider[1].distance).toBeCloseTo(0.293, 2)
  })
})

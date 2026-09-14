/**
 * FTS5 关键词通道底座测试 —— bigram 分词 / FTS5 MATCH 表达式构造。
 *
 * **纯单元**：无 db、无 I/O、无 mock（被测模块是纯函数，不持 db 句柄）。
 * 用例原先在 `memories.test.ts`（一个以已下线的 `memories` 表命名的模块），
 * 该模块 2026-09-14 拆解后随实现搬到本文件，断言逐字未改。
 */
import { describe, it, expect } from 'vitest'
import { bigramTokenize, buildFtsQuery } from './fts.js'

describe('bigram 分词', () => {
  it('中英混排按相邻两字符切分', () => {
    expect(bigramTokenize('猫咖测试abc')).toEqual(['猫咖', '咖测', '测试', '试a', 'ab', 'bc'])
  })

  it('空串与单字符返回空数组', () => {
    expect(bigramTokenize('')).toEqual([])
    expect(bigramTokenize('猫')).toEqual([])
  })

  it('孤立代理片段跳过（emoji 半截码元不产生脏 token）', () => {
    // '😺猫' 码元序列: [D83D, DE3A, 猫]——slice(1,3) 是孤立低代理，应被跳过
    expect(bigramTokenize('😺猫')).toEqual(['😺'])
  })
})

describe('buildFtsQuery', () => {
  it('切分后每个 bigram 短语化（AND 语义）', () => {
    expect(buildFtsQuery('重放机制')).toBe('"重放" "放机" "机制"')
  })

  it('查询端过滤停用词，不截断剩余词', () => {
    // "什么样的呢" → 什么/么样/样的/的呢 → 停用"什么""的呢"，剩"么样""样的"
    expect(buildFtsQuery('什么样的呢')).toBe('"么样" "样的"')
  })

  it('纯停用词/空查询返回 null（调用方降级纯向量）', () => {
    expect(buildFtsQuery('什么')).toBeNull()
    expect(buildFtsQuery('')).toBeNull()
  })

  it('含 FTS 特殊字符的 bigram 跳过', () => {
    // "a*b" → a*/ *b 均含 * → 无剩余词
    expect(buildFtsQuery('a*b')).toBeNull()
  })
})

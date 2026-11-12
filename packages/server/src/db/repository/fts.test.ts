/**
 * FTS5 关键词通道底座测试 —— 分词器 v2（中文 bigram + ASCII 整词）/ OR MATCH 表达式。
 *
 * **纯单元**：无 db、无 I/O、无 mock（被测模块是纯函数，不持 db 句柄）。
 * 用例原先在 `memories.test.ts`（一个以已下线的 `memories` 表命名的模块），
 * 该模块 2026-09-14 拆解后随实现搬到本文件；2026-11-12 分词器 v2 换了切分与查询语义，
 * 断言随之重写（v1 的「跨语言 bigram」与「AND 空格 join」是本次要消除的病）。
 */
import { describe, it, expect } from 'vitest'
import { ftsTokenize, buildFtsQuery, FTS_QUERY_MAX_TERMS } from './fts.js'

describe('ftsTokenize（分词器 v2）', () => {
  it('中文按相邻两字成组（bigram）', () => {
    expect(ftsTokenize('猫咖测试')).toEqual(['猫咖', '咖测', '测试'])
  })

  it('ASCII 标识符整词保留，按下划线/连字符/点/斜杠切', () => {
    expect(ftsTokenize('AGENT_HARD_TIMEOUT_MS')).toEqual(['agent', 'hard', 'timeout', 'ms'])
    expect(ftsTokenize('retrieval_events')).toEqual(['retrieval', 'events'])
    expect(ftsTokenize('docs/adr/0006-vector-memory-retrieval.md')).toEqual([
      'docs',
      'adr',
      '0006',
      'vector',
      'memory',
      'retrieval',
      'md',
    ])
  })

  it('camelCase 再切子词（小写/数字后接大写处断）', () => {
    expect(ftsTokenize('getChunksByOrigin')).toEqual(['get', 'chunks', 'by', 'origin'])
  })

  it('全大写缩写不按单字母拆（AGENT 不切成 a/g/e/n/t）', () => {
    expect(ftsTokenize('AGENT')).toEqual(['agent'])
    expect(ftsTokenize('MS')).toEqual(['ms'])
  })

  it('全小写归一：FooBar 与 foobar 产生同一组词项', () => {
    expect(ftsTokenize('FooBar')).toEqual(['foo', 'bar'])
    expect(ftsTokenize('FOOBAR')).toEqual(['foobar'])
  })

  it('单个 ASCII 字母丢弃（无检索信息量）', () => {
    expect(ftsTokenize('a b c')).toEqual([])
    expect(ftsTokenize('a*b')).toEqual([])
    // 与中文混排时同样丢弃单字母，中文段照常 bigram
    expect(ftsTokenize('猫咖测试abc')).toEqual(['猫咖', '咖测', '测试', 'abc'])
  })

  it('空串与单字符中文返回空数组（不足两字无 bigram）', () => {
    expect(ftsTokenize('')).toEqual([])
    expect(ftsTokenize('猫')).toEqual([])
  })

  it('emoji / 标点作分隔符，不产生脏 token（也不跨分隔符拼 bigram）', () => {
    expect(ftsTokenize('😺猫')).toEqual([])
    expect(ftsTokenize('猫咖😺测试')).toEqual(['猫咖', '测试'])
  })

  it('写入侧不去重（BM25 的 tf 要保留）', () => {
    expect(ftsTokenize('猫咖 猫咖')).toEqual(['猫咖', '猫咖'])
  })
})

describe('buildFtsQuery（OR 语义）', () => {
  it('词项逐个短语化、以 OR 连接', () => {
    expect(buildFtsQuery('重放机制')).toBe('"重放" OR "放机" OR "机制"')
    expect(buildFtsQuery('retrieval_events')).toBe('"retrieval" OR "events"')
  })

  it('查询端过滤停用词，不截断剩余词', () => {
    // "什么样" → 什么/么样 → 停用「什么」，剩「么样」
    expect(buildFtsQuery('什么样')).toBe('"么样"')
  })

  it('词项去重（同一个词只进一次 MATCH）', () => {
    expect(buildFtsQuery('events events')).toBe('"events"')
  })

  it(`词项上限 ${FTS_QUERY_MAX_TERMS}：超出部分截断`, () => {
    const many = Array.from({ length: FTS_QUERY_MAX_TERMS + 10 }, (_, i) => `w${i}`).join(' ')
    const expr = buildFtsQuery(many)
    expect(expr).not.toBeNull()
    expect(expr!.split(' OR ')).toHaveLength(FTS_QUERY_MAX_TERMS)
    expect(expr!.startsWith('"w0"')).toBe(true)
    // 第 64 个（0 基 63）在内、第 65 个在外
    expect(expr).toContain('"w63"')
    expect(expr).not.toContain('"w64"')
  })

  it('纯停用词 / 空串 / 纯单字母 → null（调用方降级纯向量）', () => {
    expect(buildFtsQuery('什么')).toBeNull()
    expect(buildFtsQuery('')).toBeNull()
    expect(buildFtsQuery('a*b')).toBeNull()
  })

  it('FTS 特殊字符不进 MATCH 表达式', () => {
    // 分词器 v2 已不产出含特殊字符的词项；这条钉的是「出现在输入里也不得漏进去」
    const expr = buildFtsQuery('"events" * (test): ^')
    expect(expr).not.toBeNull()
    for (const term of expr!.split(' OR ')) {
      expect(term).toMatch(/^"[^"]*"$/)
    }
    expect(expr).toContain('"events"')
  })
})

/**
 * mcp-server 纯函数单测（知识库 Phase 1 测试三层分治之一）。
 *
 * validateSearchParams 抽为可导出纯函数供单测（mcp-server-utils.mjs——
 * mcp-server.mjs 带 shebang，vitest 模块执行器会把它当非法 token）——
 * 工具面本体保持 spike 留档模式（不做 spawn 子进程级测试）；
 * 端点侧由 internal.test.ts 覆盖。
 */
import { describe, it, expect } from 'vitest'
import { validateSearchParams } from './mcp-server-utils.mjs'

describe('validateSearchParams (search_knowledge)', () => {
  it('合法入参：仅 query → ok，topK 默认 3', () => {
    const r = validateSearchParams({ query: '提交规范' })
    expect(r).toEqual({ ok: true, query: '提交规范', topK: 3 })
  })

  it('合法入参：query + topK 边界 1 和 10 → ok', () => {
    expect(validateSearchParams({ query: 'x', topK: 1 }).ok).toBe(true)
    expect(validateSearchParams({ query: 'x', topK: 10 }).ok).toBe(true)
    expect(validateSearchParams({ query: 'x', topK: 5 }).topK).toBe(5)
  })

  it('query 前后空白裁剪', () => {
    const r = validateSearchParams({ query: '  提交规范  ' })
    expect(r.query).toBe('提交规范')
  })

  it('空 query → 错误文本（含 reason 可纠正）', () => {
    const r = validateSearchParams({ query: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('query')
    expect(r.reason).toContain('非空字符串')
  })

  it('纯空白 query → 错误文本', () => {
    const r = validateSearchParams({ query: '   ' })
    expect(r.ok).toBe(false)
  })

  it('query 非字符串（数字/数组/缺省）→ 错误文本', () => {
    expect(validateSearchParams({ query: 123 }).ok).toBe(false)
    expect(validateSearchParams({ query: ['x'] }).ok).toBe(false)
    expect(validateSearchParams({}).ok).toBe(false)
    expect(validateSearchParams(undefined).ok).toBe(false)
  })

  it('topK 越界：0 / 11 / 负数 → 错误文本', () => {
    for (const bad of [0, 11, -1]) {
      const r = validateSearchParams({ query: 'x', topK: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('1-10')
    }
  })

  it('topK 非整数（小数/字符串/布尔）→ 错误文本', () => {
    expect(validateSearchParams({ query: 'x', topK: 2.5 }).ok).toBe(false)
    expect(validateSearchParams({ query: 'x', topK: '3' }).ok).toBe(false)
    expect(validateSearchParams({ query: 'x', topK: true }).ok).toBe(false)
  })
})

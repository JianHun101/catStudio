/**
 * classify-error 测试 — W1 L1 契约。
 * 七桶映射（关键词）+ unknown 兜底；纯函数无 I/O。
 */
import { describe, it, expect } from 'vitest'
import { classifyError } from './classify-error.js'

describe('classifyError — 七桶映射', () => {
  it('server_restart 精确标记 → server_restart 桶', () => {
    expect(classifyError('server_restart')).toBe('server_restart')
  })

  it('执行超时 → timeout 桶', () => {
    expect(classifyError('执行超时 (1800000s)')).toBe('timeout')
    expect(classifyError('Request timed out after 30s')).toBe('timeout')
    expect(classifyError('network ETIMEDOUT')).toBe('timeout')
  })

  it('上下文超长 → context_overflow 桶', () => {
    expect(classifyError('上下文长度超过模型最大限制')).toBe('context_overflow')
    expect(classifyError("This model's maximum context length is 128000 tokens")).toBe(
      'context_overflow'
    )
  })

  it('迭代上限 → iteration_limit 桶', () => {
    expect(classifyError('iteration limit exceeded')).toBe('iteration_limit')
    expect(classifyError('达到迭代上限')).toBe('iteration_limit')
  })

  it('解析失败 → parse_error 桶', () => {
    expect(classifyError('JSON 解析失败: Unexpected token')).toBe('parse_error')
    expect(classifyError('Invalid JSON response from model')).toBe('parse_error')
    expect(classifyError('parse error at position 42')).toBe('parse_error')
  })

  it('工具调用错误 → tool_error 桶', () => {
    expect(classifyError('MCP tool call failed: connection refused')).toBe('tool_error')
    expect(classifyError('工具调用超限')).toBe('tool_error')
  })

  it('推理失败 → reasoning_error 桶', () => {
    expect(classifyError('reasoning error in chain of thought')).toBe('reasoning_error')
    expect(classifyError('推理失败，请重试')).toBe('reasoning_error')
  })

  it('匹配不到 → unknown 兜底', () => {
    expect(classifyError('something totally unexpected happened')).toBe('unknown')
    expect(classifyError('interrupted')).toBe('unknown')
    expect(classifyError('')).toBe('unknown')
    expect(classifyError(null)).toBe('unknown')
    expect(classifyError(undefined)).toBe('unknown')
  })

  it('关键词大小写不敏感（英文）', () => {
    expect(classifyError('Request Timed Out')).toBe('timeout')
    expect(classifyError('INVALID JSON')).toBe('parse_error')
  })
})

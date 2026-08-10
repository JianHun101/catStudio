/**
 * chatComplete 测试（非流式补全）。
 *
 * 核心覆盖：推理模型配额语义修复的钉死——
 * - 请求体必须含 thinking:{type:'disabled'}（reasoning 吃 max_tokens 预算 →
 *   content 空 + length 截断，2026-08-10 实测 5/5 空响应）
 * - max_tokens 默认 2048（原 1024 可能截断摘要，昨天成功案例 completionTokens 1500+）
 * - 空响应重试 1 次（300ms 退避）再抛错；重试仍空 → 抛错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatComplete } from './complete.js'

const okResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }], usage: null }),
})

const errorResponse = (status: number, text: string) => ({
  ok: false,
  status,
  text: async () => text,
})

describe('chatComplete', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('请求体含 thinking:{type:"disabled"} 与 stream:false（推理模型配额修复）', async () => {
    fetchMock.mockResolvedValue(okResponse('你好'))
    const result = await chatComplete('sys', 'usr', { apiKey: 'k' })
    expect(result).toBe('你好')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.stream).toBe(false)
  })

  it('max_tokens 默认 2048；显式传入时使用该值', async () => {
    fetchMock.mockResolvedValue(okResponse('ok'))
    await chatComplete('sys', 'usr', { apiKey: 'k' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(2048)

    fetchMock.mockClear()
    await chatComplete('sys', 'usr', { apiKey: 'k', maxTokens: 1500 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1500)
  })

  it('空响应 → 重试 1 次（300ms 退避）→ 第二次成功返回内容', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('')).mockResolvedValueOnce(okResponse('第二次成功'))
    const result = await chatComplete('sys', 'usr', { apiKey: 'k' })
    expect(result).toBe('第二次成功')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('重试仍空 → 抛 "empty response" 错误', async () => {
    fetchMock.mockResolvedValue(okResponse(''))
    await expect(chatComplete('sys', 'usr', { apiKey: 'k' })).rejects.toThrow(
      'Chat completion API returned empty response'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('HTTP 错误 → 直接抛错不重试（仅空响应走重试路径）', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, 'rate limited'))
    await expect(chatComplete('sys', 'usr', { apiKey: 'k' })).rejects.toThrow(
      'Chat completion API error 429: rate limited'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

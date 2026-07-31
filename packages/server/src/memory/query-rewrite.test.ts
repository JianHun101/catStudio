/**
 * 查询改写模块测试 — mock LLM 调用边界（chatComplete），
 * 验证解析、去重、截断、降级路径与缓存。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockChatComplete = vi.fn(async () => '')

vi.mock('../llm/complete.js', () => ({
  chatComplete: mockChatComplete,
}))

describe('query-rewrite', () => {
  let rewriteModule: typeof import('./query-rewrite.js')

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.MEMORY_QUERY_REWRITE_ENABLED = '1'
    process.env.DS_KEY = 'sk-test'
    delete process.env.MEMORY_QUERY_REWRITE_MODEL
    delete process.env.MEMORY_QUERY_REWRITE_TIMEOUT_MS
    rewriteModule = await import('./query-rewrite.js')
  })

  afterEach(() => {
    delete process.env.MEMORY_QUERY_REWRITE_ENABLED
    delete process.env.DS_KEY
  })

  describe('开关与降级', () => {
    it('功能关闭时不调用 LLM，返回空数组', async () => {
      process.env.MEMORY_QUERY_REWRITE_ENABLED = '0'
      const result = await rewriteModule.rewriteRetrievalQueries('你好')
      expect(result).toEqual([])
      expect(mockChatComplete).not.toHaveBeenCalled()
    })

    it('未配置 DS_KEY 时不调用 LLM，返回空数组', async () => {
      delete process.env.DS_KEY
      const result = await rewriteModule.rewriteRetrievalQueries('你好')
      expect(result).toEqual([])
      expect(mockChatComplete).not.toHaveBeenCalled()
    })

    it('LLM 调用失败时返回空数组（降级为仅原话检索）', async () => {
      mockChatComplete.mockRejectedValueOnce(new Error('timeout'))
      const result = await rewriteModule.rewriteRetrievalQueries('你好')
      expect(result).toEqual([])
    })
  })

  describe('解析', () => {
    it('解析编号行、去掉包裹引号', async () => {
      mockChatComplete.mockResolvedValueOnce(
        '1. 用户上次推荐的日料店\n2. "寿司喜好"\n3. 不吃辣的口味偏好'
      )
      const result = await rewriteModule.rewriteRetrievalQueries('上次推荐的那家店叫什么')
      expect(result).toEqual(['用户上次推荐的日料店', '寿司喜好', '不吃辣的口味偏好'])
    })

    it('解析 bullet 行并去重', async () => {
      mockChatComplete.mockResolvedValueOnce('- 猫咖营业时间\n• 猫咖营业时间\n- 暹罗猫的习性')
      const result = await rewriteModule.rewriteRetrievalQueries('你们什么时候开门')
      expect(result).toEqual(['猫咖营业时间', '暹罗猫的习性'])
    })

    it('超过 3 条时截断为 3 条', async () => {
      mockChatComplete.mockResolvedValueOnce(['q1', 'q2', 'q3', 'q4', 'q5'].join('\n'))
      const result = await rewriteModule.rewriteRetrievalQueries('原话')
      expect(result).toEqual(['q1', 'q2', 'q3'])
    })

    it('剔除与原话相同的改写', async () => {
      mockChatComplete.mockResolvedValueOnce('原话\n更好的查询')
      const result = await rewriteModule.rewriteRetrievalQueries('原话')
      expect(result).toEqual(['更好的查询'])
    })

    it('改写全部无效时返回空数组', async () => {
      mockChatComplete.mockResolvedValueOnce('原话\n\n原话')
      const result = await rewriteModule.rewriteRetrievalQueries('原话')
      expect(result).toEqual([])
    })
  })

  describe('缓存', () => {
    it('同一文本在 TTL 内只调用一次 LLM', async () => {
      mockChatComplete.mockResolvedValue('q1\nq2')
      await rewriteModule.rewriteRetrievalQueries('你好')
      await rewriteModule.rewriteRetrievalQueries('你好')
      await rewriteModule.rewriteRetrievalQueries('你好')
      expect(mockChatComplete).toHaveBeenCalledTimes(1)
    })

    it('清空缓存后重新调用 LLM', async () => {
      mockChatComplete.mockResolvedValue('q1')
      await rewriteModule.rewriteRetrievalQueries('你好')
      rewriteModule.clearRewriteCache()
      await rewriteModule.rewriteRetrievalQueries('你好')
      expect(mockChatComplete).toHaveBeenCalledTimes(2)
    })

    it('不同文本互不影响缓存', async () => {
      mockChatComplete.mockResolvedValue('q1')
      await rewriteModule.rewriteRetrievalQueries('你好')
      await rewriteModule.rewriteRetrievalQueries('再见')
      expect(mockChatComplete).toHaveBeenCalledTimes(2)
    })

    it('使用便宜模型档位且限制输出 token', async () => {
      mockChatComplete.mockResolvedValue('q1')
      await rewriteModule.rewriteRetrievalQueries('你好')
      expect(mockChatComplete).toHaveBeenCalledWith(expect.any(String), '你好', {
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        maxTokens: 150,
        temperature: 0.3,
        timeoutMs: 5000,
      })
    })
  })
})

/**
 * embed-server.mjs HTTP 层测试 —— 假 embed 注入，**不加载模型**。
 *
 * 被测面：路由 / 输入归一化 / 批量上限 / 就绪门 / 仅本机监听。
 * 不测：真实模型推理（e2e 覆盖，见 embed-server.e2e.mjs）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_BATCH, createEmbedServer, resolveTransformersEntry } from './embed-server.mjs'

/** 假嵌入：维度 3，值 = 文本长度（可断言顺序与内容） */
const fakeEmbed = async (texts) => texts.map((t) => [t.length, 3, 1])

let app
let base

beforeAll(async () => {
  app = createEmbedServer({ embed: fakeEmbed, getModel: () => 'fake-model', getDim: () => 3 })
  const port = await app.listen(0)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.close()
})

const post = (body) =>
  fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('embed-server', () => {
  describe('监听面', () => {
    it('默认只监听 127.0.0.1（不得放宽到 0.0.0.0）', () => {
      expect(app.host).toBe('127.0.0.1')
      expect(app.server.address().address).toBe('127.0.0.1')
    })

    it('import 期不加载模型（本文件全程未加载 transformers 仍可服务）', () => {
      // 能跑到这里本身就是断言：createEmbedServer 不依赖模型
      expect(typeof app.listen).toBe('function')
    })
  })

  describe('依赖入口解析（换壳不换语义）', () => {
    it('取 ESM 构建（.node.mjs），不是 require 条件的 .node.cjs', () => {
      const entry = resolveTransformersEntry()
      expect(entry).toMatch(/transformers\.node\.mjs$/)
      expect(entry).not.toMatch(/\.cjs$/)
      expect(existsSync(fileURLToPath(entry))).toBe(true)
    })
  })

  describe('GET /health', () => {
    it('回报 ready / model / dim', async () => {
      const res = await fetch(`${base}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        ok: true,
        ready: true,
        model: 'fake-model',
        dim: 3,
      })
    })

    it('未就绪 ⇒ ready:false（模型加载中不假装可用）', async () => {
      const cold = createEmbedServer({
        embed: fakeEmbed,
        getReady: () => false,
        getError: () => 'loading',
      })
      const port = await cold.listen(0)
      try {
        const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
        expect(body.ready).toBe(false)
        expect(body.error).toBe('loading')
      } finally {
        await cold.close()
      }
    })
  })

  describe('POST /v1/embeddings', () => {
    it('string input ⇒ 单条向量', async () => {
      const res = await post({ input: 'abcd' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.model).toBe('fake-model')
      expect(body.dim).toBe(3)
      expect(body.data).toEqual([{ index: 0, embedding: [4, 3, 1] }])
    })

    it('array input ⇒ 按 index 对齐，条数一致', async () => {
      const body = await (await post({ input: ['aa', 'bbbb'] })).json()
      expect(body.data.map((d) => d.index)).toEqual([0, 1])
      expect(body.data.map((d) => d.embedding[0])).toEqual([2, 4])
    })

    it(`批量上限 ${MAX_BATCH}：超一条即 400 batch-too-large`, async () => {
      const okBody = await post({ input: Array.from({ length: MAX_BATCH }, () => 'x') })
      expect(okBody.status).toBe(200)

      const res = await post({ input: Array.from({ length: MAX_BATCH + 1 }, () => 'x') })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ reason: 'batch-too-large', limit: MAX_BATCH })
    })

    it('坏 input ⇒ 400 bad-input（空数组 / 空串 / 非字符串）', async () => {
      for (const input of [[], '', ['ok', ''], [1, 2], { a: 1 }, undefined]) {
        const res = await post({ input })
        expect(res.status, `input=${JSON.stringify(input)}`).toBe(400)
        expect((await res.json()).reason).toBe('bad-input')
      }
    })

    it('非 JSON body ⇒ 400 bad-json（不 500）', async () => {
      const res = await post('{not json')
      expect(res.status).toBe(400)
      expect((await res.json()).reason).toBe('bad-json')
    })

    it('模型未就绪 ⇒ 503 model-not-ready', async () => {
      const cold = createEmbedServer({ embed: fakeEmbed, getReady: () => false })
      const port = await cold.listen(0)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'x' }),
        })
        expect(res.status).toBe(503)
        expect((await res.json()).reason).toBe('model-not-ready')
      } finally {
        await cold.close()
      }
    })

    it('未知路径 / 错误方法 ⇒ 404', async () => {
      expect((await fetch(`${base}/v1/other`)).status).toBe(404)
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${base}/v1/embeddings`)).status).toBe(404) // GET ≠ POST
    })
  })
})

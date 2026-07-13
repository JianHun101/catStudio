/**
 * 本地嵌入模块 — 使用 Transformers.js 运行 bge-small-zh-v1.5 模型。
 *
 * 零 API 成本，离线可用。首次调用时自动下载模型（~100MB），之后使用缓存。
 *
 * 环境变量:
 *   MEMORY_ENABLED        — 'false' 禁用全部记忆功能
 *   MEMORY_EMBEDDING_MODEL — 模型名（默认 Xenova/bge-small-zh-v1.5）
 */

import { createLogger } from '../logger.js'

const log = createLogger('memory:embedding')

/** 嵌入是否全局启用 */
export function isMemoryEnabled(): boolean {
  return process.env.MEMORY_ENABLED !== 'false'
}

// ─── 模型单例 ─────────────────────────────────────────────

let pipelinePromise: Promise<any> | null = null

function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const modelName =
        process.env.MEMORY_EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5'
      log.info('加载嵌入模型...', { model: modelName })
      const t0 = Date.now()

      // Transformers.js 动态 import
      const { env, pipeline } = await import('@huggingface/transformers')

      // 仅在显式设置了 HF_ENDPOINT 时切换镜像（否则用默认 huggingface.co）
      const mirror = process.env.HF_ENDPOINT
      if (mirror && mirror !== 'https://huggingface.co') {
        env.remoteHost = mirror.replace(/\/+$/, '') + '/'
        env.remotePathTemplate = '{model}/resolve/{revision}/'
        log.info('使用自定义 HF 端点', { remoteHost: env.remoteHost })
      }

      const pipe = await pipeline('feature-extraction', modelName)
      log.info('嵌入模型加载完成', {
        model: modelName,
        remoteHost: env.remoteHost,
        elapsedMs: Date.now() - t0,
      })
      return pipe
    })()
  }
  return pipelinePromise
}

// ─── 公共 API ─────────────────────────────────────────────

/**
 * 将文本转为向量嵌入（number[]）。
 *
 * 首次调用会触发模型下载（~100MB），后续调用复用缓存的 pipeline。
 * 失败时返回空数组，调用方应降级处理。
 */
export async function embedText(text: string): Promise<number[]> {
  try {
    const pipe = await getPipeline()
    const result = await pipe(text, { pooling: 'mean', normalize: true })
    // result 是 ONNX tensor → 提取为 number[]
    const vec = Array.from(result.data) as number[]
    return vec
  } catch (err: any) {
    log.error('嵌入失败', { error: err.message, textLen: text.length })
    return []
  }
}

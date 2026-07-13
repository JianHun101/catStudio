import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'

/**
 * LLM 适配器接口。每个供应商实现此接口。
 */
export interface LLMAdapter {
  /** 供应商标识 */
  readonly provider: string

  /**
   * 流式对话。返回 AsyncIterable，每次 yield 一个 Chunk。
   * 最后一个 Chunk 的 done = true。
   */
  chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncIterable<Chunk>
}

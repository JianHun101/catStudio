import type { LLMAdapter } from './adapter.js'
import { DeepSeekAdapter } from './deepseek.js'
import { ClaudeAdapter } from './claude.js'
import { OpenAIAdapter } from './openai.js'
import { PiAdapter } from './pi.js'
import { OllamaAdapter } from './ollama.js'
import type { AgentConfig } from '@cat-study/shared'

const adapters = new Map<string, LLMAdapter>()

/**
 * 为 Agent 获取或创建 LLM 适配器实例。
 * 按 apiKey 缓存，同一 key 复用同一适配器。
 */
export function getAdapterForAgent(agent: AgentConfig): LLMAdapter {
  // claude 的 key 含 baseUrl——同一 key 下 DeepSeek 端点与 Kimi 端点必须不同实例，否则缓存串台
  const cacheKey =
    agent.llmProvider === 'claude'
      ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.effortLevel || ''}:${agent.llmBaseUrl || ''}`
      : `${agent.llmProvider}:${agent.llmApiKey}`

  if (adapters.has(cacheKey)) {
    return adapters.get(cacheKey)!
  }

  let adapter: LLMAdapter

  switch (agent.llmProvider) {
    case 'deepseek':
      adapter = new DeepSeekAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
      })
      break
    case 'claude':
      adapter = new ClaudeAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
        effortLevel: agent.effortLevel,
      })
      break
    case 'openai':
      adapter = new OpenAIAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
      })
      break
    case 'pi':
      adapter = new PiAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
      })
      break
    case 'ollama':
      adapter = new OllamaAdapter({
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
      })
      break
    default:
      throw new Error(`Unsupported LLM provider: ${agent.llmProvider}`)
  }

  adapters.set(cacheKey, adapter)
  return adapter
}

/** 清除所有缓存的适配器 */
export function clearAdapterCache(): void {
  adapters.clear()
}

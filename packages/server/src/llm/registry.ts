import type { LLMAdapter } from './adapter.js'
import { DeepSeekAdapter } from './deepseek.js'
import { ClaudeAdapter } from './claude.js'
import { OpenAIAdapter } from './openai.js'
import { PiAdapter } from './pi.js'
import type { AgentConfig } from '@cat-study/shared'

const adapters = new Map<string, LLMAdapter>()

/**
 * 为 Agent 获取或创建 LLM 适配器实例。
 * 按 apiKey 缓存，同一 key 复用同一适配器。
 */
export function getAdapterForAgent(agent: AgentConfig): LLMAdapter {
  const cacheKey =
    agent.llmProvider === 'claude'
      ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.effortLevel || ''}`
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

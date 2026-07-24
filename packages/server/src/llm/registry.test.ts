import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '@cat-study/shared'

// Mock adapter constructors to avoid importing real implementations
// (which import child_process, fetch, etc.)
const mockChatStream = vi.fn()

class MockDeepSeekAdapter {
  readonly provider = 'deepseek'
  chatStream = mockChatStream
  constructor(_opts: unknown) {}
}

class MockClaudeAdapter {
  readonly provider = 'claude'
  chatStream = mockChatStream
  constructor(_opts: unknown) {}
}

class MockOpenAIAdapter {
  readonly provider = 'openai'
  chatStream = mockChatStream
  constructor(_opts: unknown) {}
}

vi.mock('./deepseek.js', () => ({ DeepSeekAdapter: MockDeepSeekAdapter }))
vi.mock('./claude.js', () => ({ ClaudeAdapter: MockClaudeAdapter }))
vi.mock('./openai.js', () => ({ OpenAIAdapter: MockOpenAIAdapter }))

describe('registry', () => {
  let registryModule: typeof import('./registry.js')

  const baseAgent: AgentConfig = {
    id: 'a1',
    name: 'test',
    avatar: '🐱',
    systemPrompt: 'prompt',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-key-1',
    skillModules: [],
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-import to get clean cache
    vi.resetModules()
    registryModule = await import('./registry.js')
  })

  describe('getAdapterForAgent', () => {
    it('returns DeepSeek adapter for deepseek provider', () => {
      const adapter = registryModule.getAdapterForAgent(baseAgent)
      expect(adapter).toBeDefined()
      expect(adapter.provider).toBe('deepseek')
    })

    it('returns Claude adapter for claude provider', () => {
      const agent = { ...baseAgent, llmProvider: 'claude' }
      const adapter = registryModule.getAdapterForAgent(agent)
      expect(adapter.provider).toBe('claude')
    })

    it('returns OpenAI adapter for openai provider', () => {
      const agent = { ...baseAgent, llmProvider: 'openai' }
      const adapter = registryModule.getAdapterForAgent(agent)
      expect(adapter.provider).toBe('openai')
    })

    it('throws for unsupported provider', () => {
      const agent = { ...baseAgent, llmProvider: 'gemini' }
      expect(() => registryModule.getAdapterForAgent(agent)).toThrow('Unsupported LLM provider')
    })
  })

  describe('caching', () => {
    it('returns same instance for same provider+apiKey', () => {
      const a1 = registryModule.getAdapterForAgent(baseAgent)
      const a2 = registryModule.getAdapterForAgent(baseAgent)
      expect(a1).toBe(a2)
    })

    it('returns different instance for different apiKey', () => {
      const a1 = registryModule.getAdapterForAgent(baseAgent)
      const a2 = registryModule.getAdapterForAgent({ ...baseAgent, llmApiKey: 'sk-key-2' })
      expect(a1).not.toBe(a2)
    })

    it('returns different instance for different provider', () => {
      const a1 = registryModule.getAdapterForAgent(baseAgent)
      const a2 = registryModule.getAdapterForAgent({ ...baseAgent, llmProvider: 'claude' })
      expect(a1).not.toBe(a2)
    })
  })

  describe('clearAdapterCache', () => {
    it('clears all cached adapters', () => {
      const a1 = registryModule.getAdapterForAgent(baseAgent)
      registryModule.clearAdapterCache()
      const a2 = registryModule.getAdapterForAgent(baseAgent)
      expect(a1).not.toBe(a2) // new instance after cache clear
    })
  })
})

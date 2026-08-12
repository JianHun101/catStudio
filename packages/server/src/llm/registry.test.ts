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
  constructor(public opts: { baseUrl?: string; effortLevel?: string }) {}
}

class MockOpenAIAdapter {
  readonly provider = 'openai'
  chatStream = mockChatStream
  constructor(_opts: unknown) {}
}

class MockOpencodeAdapter {
  readonly provider = 'opencode'
  chatStream = mockChatStream
  constructor(public opts: { model?: string; envExtra?: Record<string, string> }) {}
}

vi.mock('./deepseek.js', () => ({ DeepSeekAdapter: MockDeepSeekAdapter }))
vi.mock('./claude.js', () => ({ ClaudeAdapter: MockClaudeAdapter }))
vi.mock('./openai.js', () => ({ OpenAIAdapter: MockOpenAIAdapter }))
vi.mock('./opencode.js', () => ({ OpencodeAdapter: MockOpencodeAdapter }))

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

    it('returns Opencode adapter for opencode provider', () => {
      const agent = { ...baseAgent, llmProvider: 'opencode' }
      const adapter = registryModule.getAdapterForAgent(agent)
      expect(adapter.provider).toBe('opencode')
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

    it('returns different instance for different baseUrl (claude, same key+effort)', () => {
      const deepseek: AgentConfig = {
        ...baseAgent,
        llmProvider: 'claude',
        llmApiKey: 'sk-key-1',
        effortLevel: 'high',
      }
      const kimi: AgentConfig = {
        ...deepseek,
        llmBaseUrl: 'https://api.moonshot.ai/anthropic',
      }
      const a1 = registryModule.getAdapterForAgent(deepseek)
      const a2 = registryModule.getAdapterForAgent(kimi)
      expect(a1).not.toBe(a2)
    })

    it('returns different instance for different baseUrl (deepseek, same key)', () => {
      const official: AgentConfig = {
        ...baseAgent,
        llmApiKey: 'sk-key-1',
      }
      const moonshot: AgentConfig = {
        ...official,
        llmBaseUrl: 'https://api.moonshot.cn',
      }
      const a1 = registryModule.getAdapterForAgent(official)
      const a2 = registryModule.getAdapterForAgent(moonshot)
      expect(a1).not.toBe(a2)
    })

    it('passes baseUrl to ClaudeAdapter constructor', () => {
      const agent: AgentConfig = {
        ...baseAgent,
        llmProvider: 'claude',
        llmApiKey: 'sk-kimi-key',
        llmBaseUrl: 'https://api.moonshot.ai/anthropic',
        effortLevel: 'max',
      }
      const adapter = registryModule.getAdapterForAgent(agent) as unknown as MockClaudeAdapter
      expect(adapter.opts.baseUrl).toBe('https://api.moonshot.ai/anthropic')
      expect(adapter.opts.effortLevel).toBe('max')
    })

    it('returns different instance for different model (opencode, apiKey always empty)', () => {
      // opencode 的 apiKey 恒不消费（本地认证）→ 缓存键若不含 model，不同 model 的猫
      // 共享同一实例（构造 model 固定 → 串台）。缓存键 = opencode:<model>，此用例锁住。
      const m1 = { ...baseAgent, llmProvider: 'opencode', llmModel: 'anthropic/claude-sonnet-4-5' }
      const m2 = { ...baseAgent, llmProvider: 'opencode', llmModel: 'openai/gpt-5' }
      const a1 = registryModule.getAdapterForAgent(m1)
      const a2 = registryModule.getAdapterForAgent(m2)
      expect(a1).not.toBe(a2)
    })

    it('returns same instance for same model (opencode)', () => {
      const m1 = { ...baseAgent, llmProvider: 'opencode', llmModel: 'anthropic/claude-sonnet-4-5' }
      const m2 = { ...m1, llmApiKey: 'sk-whatever' } // key 不参与缓存键（不消费）
      const a1 = registryModule.getAdapterForAgent(m1)
      const a2 = registryModule.getAdapterForAgent(m2)
      expect(a1).toBe(a2)
    })

    it('returns different instance for different envExtra (opencode, same model)', () => {
      // 同 model 不同代理 env 必须不同实例——否则共享实例的 envExtra 固定，
      // 第二只猫跑第一只猫的代理（48a0415 串台教训同族：缓存键必须纳入 envExtra 原串）
      const proxy1 = {
        ...baseAgent,
        llmProvider: 'opencode',
        llmModel: 'anthropic/claude-sonnet-4-5',
        llmEnvExtra: '{"HTTPS_PROXY":"http://127.0.0.1:7897"}',
      }
      const proxy2 = {
        ...proxy1,
        llmEnvExtra: '{"HTTPS_PROXY":"http://127.0.0.1:8080"}',
      }
      const a1 = registryModule.getAdapterForAgent(proxy1)
      const a2 = registryModule.getAdapterForAgent(proxy2)
      expect(a1).not.toBe(a2)
    })

    it('returns same instance for same envExtra (opencode)', () => {
      const e1 = {
        ...baseAgent,
        llmProvider: 'opencode',
        llmModel: 'anthropic/claude-sonnet-4-5',
        llmEnvExtra: '{"HTTPS_PROXY":"http://127.0.0.1:7897"}',
      }
      const e2 = { ...e1 } // 同 model 同 envExtra 原串 → 同实例
      const a1 = registryModule.getAdapterForAgent(e1)
      const a2 = registryModule.getAdapterForAgent(e2)
      expect(a1).toBe(a2)
    })

    it('passes parsed envExtra to OpencodeAdapter constructor (宽容：非法 JSON → 空对象不炸)', () => {
      const agent = {
        ...baseAgent,
        llmProvider: 'opencode',
        llmModel: 'anthropic/claude-sonnet-4-5',
        llmEnvExtra: '{"HTTPS_PROXY":"http://127.0.0.1:7897"}',
      }
      const adapter = registryModule.getAdapterForAgent(agent) as unknown as MockOpencodeAdapter
      expect(adapter.opts.envExtra).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7897' })

      // 非法 JSON → 宽容降级空对象（不抛错），构造正常
      const bad = {
        ...baseAgent,
        llmProvider: 'opencode',
        llmModel: 'anthropic/claude-sonnet-4-5',
        llmEnvExtra: 'not-json{{',
      }
      expect(() => registryModule.getAdapterForAgent(bad)).not.toThrow()
      const badAdapter = registryModule.getAdapterForAgent(bad) as unknown as MockOpencodeAdapter
      expect(badAdapter.opts.envExtra).toEqual({})
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

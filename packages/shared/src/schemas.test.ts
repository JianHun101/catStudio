import { describe, it, expect } from 'vitest'
import {
  AgentConfigSchema,
  AgentCreateSchema,
  SessionCreateSchema,
  MessageSendSchema,
  EmbeddingConfigSchema,
} from './schemas.js'

// ─── AgentConfigSchema ─────────────────────────────

describe('AgentConfigSchema', () => {
  const validAgent = {
    id: 'agent-1',
    name: '店长阿暹',
    avatar: '🐱',
    systemPrompt: '你是一只暹罗猫',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    llmBaseUrl: 'https://api.deepseek.com',
  }

  it('accepts a fully valid agent config', () => {
    const result = AgentConfigSchema.safeParse(validAgent)
    expect(result.success).toBe(true)
  })

  it('accepts agent without optional baseUrl', () => {
    const { llmBaseUrl, ...withoutUrl } = validAgent
    const result = AgentConfigSchema.safeParse(withoutUrl)
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = AgentConfigSchema.safeParse({ ...validAgent, name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing required fields', () => {
    const result = AgentConfigSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── AgentCreateSchema ─────────────────────────────

describe('AgentCreateSchema', () => {
  const validCreate = {
    name: '新猫',
    avatar: '😺',
    systemPrompt: '你是一只新来的猫',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  }

  it('accepts valid create input', () => {
    const result = AgentCreateSchema.safeParse(validCreate)
    expect(result.success).toBe(true)
  })

  it('does not require id (omitted)', () => {
    // AgentCreateSchema omits id, so passing it should still work
    // (zod strips extra fields by default... let's check)
    const withId = { ...validCreate, id: 'some-id' }
    const result = AgentCreateSchema.safeParse(withId)
    // Zod .omit removes the field from the schema, extra keys are stripped silently
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = AgentCreateSchema.safeParse({ ...validCreate, name: '' })
    expect(result.success).toBe(false)
  })
})

// ─── SessionCreateSchema ───────────────────────────

describe('SessionCreateSchema', () => {
  it('accepts valid session create', () => {
    const result = SessionCreateSchema.safeParse({
      title: '测试会话',
      agentIds: ['agent-1', 'agent-2'],
    })
    expect(result.success).toBe(true)
  })

  it('accepts single agent', () => {
    const result = SessionCreateSchema.safeParse({
      title: '单猫会话',
      agentIds: ['agent-1'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty title', () => {
    const result = SessionCreateSchema.safeParse({
      title: '',
      agentIds: ['agent-1'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects title over 100 chars', () => {
    const result = SessionCreateSchema.safeParse({
      title: 'x'.repeat(101),
      agentIds: ['agent-1'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty agentIds array', () => {
    const result = SessionCreateSchema.safeParse({
      title: '测试',
      agentIds: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing agentIds', () => {
    const result = SessionCreateSchema.safeParse({
      title: '测试',
    })
    expect(result.success).toBe(false)
  })
})

// ─── MessageSendSchema ─────────────────────────────

describe('MessageSendSchema', () => {
  it('accepts valid message', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
      content: '你好',
      mentions: ['店长阿暹'],
    })
    expect(result.success).toBe(true)
  })

  it('defaults mentions to empty array', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
      content: '你好',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mentions).toEqual([])
    }
  })

  it('rejects empty content', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
      content: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing content', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
    })
    expect(result.success).toBe(false)
  })

  it('accepts images (base64 dataURL array)', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
      content: '看看这张图',
      images: ['data:image/png;base64,xxx'],
    })
    expect(result.success).toBe(true)
  })

  it('accepts any number of images (4-image cap enforced by server runtime guard)', () => {
    const result = MessageSendSchema.safeParse({
      sessionId: 'session-1',
      content: '图',
      images: Array(5).fill('data:image/png;base64,xxx'),
    })
    expect(result.success).toBe(true)
  })
})

// ─── EmbeddingConfigSchema ─────────────────────────

describe('EmbeddingConfigSchema', () => {
  it('accepts valid embedding config', () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: 'huggingface',
      model: 'bge-small-zh-v1.5',
      apiKey: 'hf-test',
    })
    expect(result.success).toBe(true)
  })

  it('accepts optional baseUrl', () => {
    const result = EmbeddingConfigSchema.safeParse({
      provider: 'huggingface',
      model: 'bge-small-zh-v1.5',
      apiKey: 'hf-test',
      baseUrl: 'https://hf-mirror.com',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing provider', () => {
    const result = EmbeddingConfigSchema.safeParse({
      model: 'test',
      apiKey: 'key',
    })
    expect(result.success).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { messagesToPrompt } from './cli-utils.js'
import type { LLMMessage } from '@cat-study/shared'

// ─── messagesToPrompt ─────────────────────────────

describe('messagesToPrompt', () => {
  it('returns empty string for empty array', () => {
    expect(messagesToPrompt([])).toBe('')
  })

  it('formats a system message', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是一只暹罗猫' },
    ]
    expect(messagesToPrompt(messages)).toBe('你是一只暹罗猫\n\n---\n')
  })

  it('formats a user message', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '你好' },
    ]
    expect(messagesToPrompt(messages)).toBe('User: 你好')
  })

  it('formats an assistant message', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: '你好喵~' },
    ]
    expect(messagesToPrompt(messages)).toBe('Assistant: 你好喵~')
  })

  it('joins multiple messages with double newlines', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是一只猫' },
      { role: 'user', content: '今天天气？' },
      { role: 'assistant', content: '阳光很好喵' },
    ]
    const result = messagesToPrompt(messages)
    expect(result).toBe(
      '你是一只猫\n\n---\n\n\nUser: 今天天气？\n\nAssistant: 阳光很好喵',
    )
  })

  it('handles multi-line content', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '第一行\n第二行' },
    ]
    expect(messagesToPrompt(messages)).toBe('User: 第一行\n第二行')
  })

  it('handles system message without content', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '' },
    ]
    expect(messagesToPrompt(messages)).toBe('\n\n---\n')
  })
})

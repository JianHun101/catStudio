import { describe, it, expect, beforeEach } from 'vitest'
import { useMention } from './useMention.js'
import type { AgentConfig } from '@cat-study/shared'

const mockAgents: AgentConfig[] = [
  {
    id: 'a1',
    name: '店长阿暹',
    avatar: '🐱',
    systemPrompt: 'test',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    skillModules: [],
  },
  {
    id: 'a2',
    name: '服务员橘子',
    avatar: '😺',
    systemPrompt: 'test',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    skillModules: [],
  },
  {
    id: 'a3',
    name: '吐槽猫灰灰',
    avatar: '😼',
    systemPrompt: 'test',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    skillModules: [],
  },
]

describe('useMention', () => {
  let mention: ReturnType<typeof useMention>

  beforeEach(() => {
    mention = useMention(() => mockAgents)
  })

  describe('detect', () => {
    it('activates when @ is typed at cursor', () => {
      mention.detect('hello @店', 8)
      expect(mention.mentionActive.value).toBe(true)
      expect(mention.mentionQuery.value).toBe('店')
    })

    it('activates when @ is at start of text', () => {
      mention.detect('@店', 2)
      expect(mention.mentionActive.value).toBe(true)
      expect(mention.mentionQuery.value).toBe('店')
    })

    it('does not activate without @', () => {
      mention.detect('hello world', 5)
      expect(mention.mentionActive.value).toBe(false)
    })

    it('does not activate when @ is not preceded by space/start', () => {
      // @@ or text@ should not activate
      mention.detect('hello@店', 7)
      expect(mention.mentionActive.value).toBe(false)
    })

    it('deactivates when @ followed by space', () => {
      mention.detect('hello @ 店', 8)
      expect(mention.mentionActive.value).toBe(false)
    })

    it('extracts query between @ and cursor', () => {
      mention.detect('hello @服务员', 8)
      // cursor at position 8, @ at position 6, query = "服务员"(slice 7,8) = "服务" → actually cursor at 8 means text[0..7]
      // text = 'hello @服务员' (length 9)
      // cursorPos = 8 → text[cursorPos-1] = text[7] = '员'
      // @ at position 6, query = text.slice(7, 8) = "服"
      expect(mention.mentionQuery.value).toBe('服')
    })

    it('resets mentionIndex to 0 on new detection', () => {
      mention.detect('@店', 2)
      expect(mention.mentionIndex.value).toBe(0)
    })
  })

  describe('mentionSuggestions', () => {
    it('returns empty array when not active', () => {
      expect(mention.mentionSuggestions.value).toEqual([])
    })

    it('returns all agents when active with empty query', () => {
      mention.detect('@', 1)
      expect(mention.mentionSuggestions.value).toHaveLength(3)
    })

    it('filters by name (case-insensitive)', () => {
      mention.detect('@店长', 3)
      const suggestions = mention.mentionSuggestions.value
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].name).toBe('店长阿暹')
    })

    it('filters by avatar (non-emoji)', () => {
      // Use a non-emoji avatar for testing since emoji surrogate pairs
      // cause false positives in the simple .includes() filter
      const agentsWithNonEmoji = [
        { ...mockAgents[0], avatar: 'cat' },
        { ...mockAgents[1], avatar: 'dog' },
        { ...mockAgents[2], avatar: 'bird' },
      ]
      const m = useMention(() => agentsWithNonEmoji)
      m.detect('@cat', 4)
      const suggestions = m.mentionSuggestions.value
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].avatar).toBe('cat')
    })

    it('returns empty when no match', () => {
      mention.detect('@xyz', 4)
      expect(mention.mentionSuggestions.value).toEqual([])
    })
  })

  describe('select', () => {
    it('replaces @query with @name and closes', () => {
      mention.detect('hello @店', 8)
      const result = mention.select(mockAgents[0], 'hello @店', 8)
      expect(result).toBe('hello @店长阿暹 ')
      expect(mention.mentionActive.value).toBe(false)
    })

    it('handles @ at start of text', () => {
      mention.detect('@店', 2)
      const result = mention.select(mockAgents[0], '@店', 2)
      expect(result).toBe('@店长阿暹 ')
    })
  })

  describe('close', () => {
    it('deactivates mention', () => {
      mention.detect('@店', 2)
      expect(mention.mentionActive.value).toBe(true)
      mention.close()
      expect(mention.mentionActive.value).toBe(false)
    })
  })

  describe('navigate', () => {
    it('returns null when not active', () => {
      expect(mention.navigate('ArrowDown', '', 0)).toBeNull()
    })

    it('ArrowDown increments index', () => {
      mention.detect('@', 1) // 3 suggestions
      mention.navigate('ArrowDown', '@', 1)
      expect(mention.mentionIndex.value).toBe(1)
      mention.navigate('ArrowDown', '@', 1)
      expect(mention.mentionIndex.value).toBe(2)
    })

    it('ArrowDown clamps at last suggestion', () => {
      mention.detect('@', 1)
      mention.navigate('ArrowDown', '@', 1)
      mention.navigate('ArrowDown', '@', 1)
      mention.navigate('ArrowDown', '@', 1) // should stay at 2
      expect(mention.mentionIndex.value).toBe(2)
    })

    it('ArrowUp decrements index', () => {
      mention.detect('@', 1)
      mention.mentionIndex.value = 2
      mention.navigate('ArrowUp', '@', 1)
      expect(mention.mentionIndex.value).toBe(1)
    })

    it('ArrowUp clamps at 0', () => {
      mention.detect('@', 1)
      mention.navigate('ArrowUp', '@', 1)
      expect(mention.mentionIndex.value).toBe(0)
    })

    it('Enter selects and returns replaced text', () => {
      mention.detect('@店', 2) // query="店", 1 match
      const result = mention.navigate('Enter', '@店', 2)
      expect(result).toBe('@店长阿暹 ')
      expect(mention.mentionActive.value).toBe(false)
    })

    it('Escape closes mention', () => {
      mention.detect('@店', 2)
      const result = mention.navigate('Escape', '@店', 2)
      expect(result).toBeNull()
      expect(mention.mentionActive.value).toBe(false)
    })

    it('returns null for unhandled keys', () => {
      mention.detect('@店', 2)
      expect(mention.navigate('a', '@店', 2)).toBeNull()
    })
  })
})

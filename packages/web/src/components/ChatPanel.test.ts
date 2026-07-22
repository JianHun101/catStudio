import { describe, it, expect } from 'vitest'
import source from './ChatPanel.vue?raw'

/**
 * Verify ChatPanel.vue's TransitionGroup animation setup.
 *
 * These are static verification tests — they read the SFC source via Vite's
 * `?raw` import to confirm the expected patterns exist. This provides
 * regression protection against accidental removal of TransitionGroup or
 * transition CSS classes.
 */

describe('ChatPanel animation setup', () => {
  it('uses TransitionGroup with name="msg" in template', () => {
    expect(source).toMatch(/TransitionGroup\s+name="msg"/)
  })

  it('defines .msg-enter-active transition class', () => {
    expect(source).toContain('.msg-enter-active')
  })

  it('defines .msg-enter-from transition class', () => {
    expect(source).toContain('.msg-enter-from')
  })

  it('removed the old @keyframes msg-in animation', () => {
    expect(source).not.toContain('@keyframes msg-in')
  })

  it('removed animation property from .message class', () => {
    // The old `animation: msg-in 0.25s ease-out;` should be gone
    // The .message rule should not contain animation
    const messageBlock = source.match(/\.message\s*\{[^}]*\}/s)
    if (messageBlock) {
      expect(messageBlock[0]).not.toContain('animation:')
    }
  })

  it('has box-shadow: none on .message.system .msg-bubble', () => {
    expect(source).toContain('.message.system .msg-bubble')
    const systemBubbleBlock = source.match(/\.message\.system\s+\.msg-bubble\s*\{[^}]*\}/s)
    if (systemBubbleBlock) {
      expect(systemBubbleBlock[0]).toContain('box-shadow: none')
    }
  })
})

describe('ChatPanel input area redesign', () => {
  it('has no border-top on .chat-input-area', () => {
    const areaBlock = source.match(/\.chat-input-area\s*\{[^}]*\}/s)
    expect(areaBlock).toBeTruthy()
    expect(areaBlock![0]).not.toContain('border-top')
  })

  it('has pill-shaped input with border-radius: 24px', () => {
    const inputBlock = source.match(/\.chat-input\s*\{[^}]*\}/s)
    expect(inputBlock).toBeTruthy()
    expect(inputBlock![0]).toContain('border-radius: 24px')
  })

  it('has input box-shadow for floating feel', () => {
    const inputBlock = source.match(/\.chat-input\s*\{[^}]*\}/s)
    expect(inputBlock).toBeTruthy()
    expect(inputBlock![0]).toContain('box-shadow')
  })

  it('has warm glow on input focus', () => {
    const focusBlock = source.match(/\.chat-input:focus\s*\{[^}]*\}/s)
    expect(focusBlock).toBeTruthy()
    expect(focusBlock![0]).toMatch(/rgba\(212,\s*165,\s*116/)
  })

  it('has pill-shaped send button with border-radius: 24px', () => {
    const btnBlock = source.match(/\.btn-send\s*\{[^}]*\}/s)
    expect(btnBlock).toBeTruthy()
    expect(btnBlock![0]).toContain('border-radius: 24px')
  })

  it('has send button with arrow text', () => {
    expect(source).toContain("'发送 →'")
  })

  it('has hover lift on send button', () => {
    const hoverBlock = source.match(/\.btn-send:hover:not\(:disabled\)\s*\{[^}]*\}/s)
    expect(hoverBlock).toBeTruthy()
    expect(hoverBlock![0]).toContain('translateY')
  })

  it('has min-height and field-sizing for auto-resize', () => {
    const inputBlock = source.match(/\.chat-input\s*\{[^}]*\}/s)
    expect(inputBlock).toBeTruthy()
    expect(inputBlock![0]).toContain('min-height: 44px')
    expect(inputBlock![0]).toContain('field-sizing: content')
  })

  it('has JS fallback for field-sizing auto-resize', () => {
    expect(source).toContain("CSS.supports('field-sizing', 'content')")
    expect(source).toContain("ta.style.height = ''")
  })

  it('resets textarea height after send', () => {
    expect(source).toContain("textareaRef.value.style.height = ''")
  })
})

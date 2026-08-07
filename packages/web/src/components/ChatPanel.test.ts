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

describe('ChatPanel markdown table overflow', () => {
  it('table 溢出逃生通道：msg-text table 规则含 overflow-x: auto + max-width: 100%', () => {
    // 回归保护：table 曾因 width:100% 是建议值（长单元格 min-content 撑破气泡）溢出聊天气泡，
    // 修复为 display:block + max-width + overflow-x 滚动（与 pre 代码块同构逃生通道）
    const tableBlock = source.match(/\.chat-panel \.msg-text table\s*\{[^}]*\}/s)
    expect(tableBlock).toBeTruthy()
    // 根因锁：display:block 使 width:100% 从建议值变硬约束、overflow-x 才能创建滚动容器——
    // 只锁 overflow-x/max-width 表征拦不住删 display:block 后的复发（同 10070d1 黑名单断言教训）
    expect(tableBlock![0]).toContain('display: block')
    expect(tableBlock![0]).toContain('overflow-x: auto')
    expect(tableBlock![0]).toContain('max-width: 100%')
  })
})

describe('ChatPanel restart confirm feedback', () => {
  it('pending 态显示 [确认重启][取消] 按钮，点击走 store.confirmRestart', () => {
    expect(source).toContain('store.confirmRestart(msg.id)')
    expect(source).toContain('store.cancelRestart(msg.id)')
  })

  it('confirming 中（store.confirmingRestartMessageId === msg.id）显示「已确认，等待重启…」脉冲样式', () => {
    expect(source).toContain('store.confirmingRestartMessageId === msg.id')
    expect(source).toContain('已确认，等待重启…')
    // 复用 restart-label 脉冲样式（点击即有反馈，无需等服务端）
    expect(source).toMatch(/已确认，等待重启…/)
  })

  it('confirmed 态仍显示「重启中…」restart-label', () => {
    expect(source).toContain('重启中…')
    expect(source).toContain('restart-label')
  })
})

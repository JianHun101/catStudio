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
  it('table 溢出逃生通道：msg-text table 规则含 table-layout:fixed + overflow-x: auto + max-width: 100%', () => {
    // 回归保护：table 曾因 width:100% 是建议值（长单元格 min-content 撑破气泡）溢出聊天气泡，
    // 历史经 display:block 逃生（97eee3b），08-08 实测其把 table 降级为块级元素致 td 按内容收缩、
    // 行分隔线右侧断裂空白带（表格右缘 x=868、行线只到 x=761）——改 table-layout:fixed
    // （width:100% 硬约束的正规实现）+ max-width；超宽内容由 overflow-wrap:anywhere 断行吸收，
    // 不可断内容（nowrap 内联块/pre）刺出容器，滚动需外层包裹容器（table 自身 overflow-x 不建滚动容器）
    const tableBlock = source.match(/\.chat-panel \.msg-text table\s*\{[^}]*\}/s)
    expect(tableBlock).toBeTruthy()
    // 根因双锁：正向锁 table-layout:fixed（width:100% 从建议值变硬约束）、
    // 反向锁 display:block 不复辟（重加 display:block 会复发空白带而正向锁全绿）——
    // 只锁正向表征拦不住删 fixed 后回退 display:block（同 10070d1 黑名单断言教训）
    expect(tableBlock![0]).toContain('table-layout: fixed')
    expect(tableBlock![0]).not.toContain('display: block')
    expect(tableBlock![0]).toContain('overflow-x: auto')
    expect(tableBlock![0]).toContain('max-width: 100%')
    // 漂移锁：box-sizing:border-box 防 content-box 下 width:100% + border 1px 溢出 2px，
    // 触发自身 overflow-x:auto → 右缘漂移 + 滚动区空白（13:21 实证根因）
    expect(tableBlock![0]).toContain('box-sizing: border-box')
  })

  it('文本溢出逃生：msg-text 规则含 overflow-wrap: anywhere，pre 覆盖回 normal，td/th 断行', () => {
    // 回归保护：长无断点串（URL/工具名/hash/路径）在普通段落文本中会撑破气泡——
    // code 已有 word-break:break-all 但裸文本无处理（13:21 实证：40+ 字符工具名串溢出）。
    // anywhere 允许任意字符间断行；pre 必须覆盖回 normal（代码块走 overflow-x 滚动不换行）。
    const msgTextBlock = source.match(/\.msg-text\s*\{[^}]*\}/s)
    expect(msgTextBlock).toBeTruthy()
    expect(msgTextBlock![0]).toContain('overflow-wrap: anywhere')
    const preBlock = source.match(/\.chat-panel \.msg-text pre\s*\{[^}]*\}/s)
    expect(preBlock).toBeTruthy()
    expect(preBlock![0]).toContain('overflow-wrap: normal')
    const tdBlock = source.match(
      /\.chat-panel \.msg-text th,\s*\n\s*\.chat-panel \.msg-text td\s*\{[^}]*\}/s
    )
    expect(tdBlock).toBeTruthy()
    expect(tdBlock![0]).toContain('overflow-wrap: anywhere')
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

describe('ChatPanel skill 提示（SkillLoader 拆除后）', () => {
  it('提示框展示 CLI 原生触发说明（不再是「未找到匹配的技能」空壳）', () => {
    // bf5aab5 拆除 SkillLoader：/api/skills 数据源已删，skill 由 CLI 原生消费
    // （斜杠透传 + 模型自主调用），服务端不再注入——空壳文案改为正确说明
    expect(source).toContain('skill 由 CLI 原生触发')
    expect(source).toContain('服务端不再注入')
    expect(source).toContain('skill-tip')
    expect(source).not.toContain('未找到匹配的技能')
  })

  it('fetchSkills 死调用已清除（端点已删，恒 404 降级空列表）', () => {
    expect(source).not.toContain('fetchSkills')
    expect(source).not.toContain('/api/skills')
  })

  it('补全机制已剥离：无 skillSuggestions 下拉与键盘拦截分支（斜杠消息 Enter 可直发）', () => {
    // 数据源恒空时下拉不可达；keydown 拦截分支曾吞掉斜杠消息的 Enter（preventDefault 后
    // 直达 :493 发送逻辑被短路）——剥离后 Enter 直通 handleSend，CLI 斜杠触发通道保留
    expect(source).not.toContain('skillSuggestions')
    expect(source).not.toContain('skill-dropdown')
  })
})

import { describe, it, expect } from 'vitest'
import source from './SessionList.vue?raw'

/**
 * Verify SessionList.vue's B2 layout changes (新建会话上移 + 去云朵 icon).
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Regression protection for
 * 用户需求：新建会话按钮从底部 footer 移到「会话」标题行右侧（图1「添加成员」范式）；
 * 会话行 💬 云朵 icon 删除、标题占满行宽。
 */

describe('SessionList 新建会话按钮上移（标题行右侧）', () => {
  it('新建按钮在 section-header 内（section-header-right），点击开弹窗', () => {
    expect(source).toMatch(/<div class="section-header">[\s\S]*?class="section-header-right"/)
    expect(source).toContain('class="btn-new-session-header"')
    expect(source).toContain('@click="showCreate = true"')
    expect(source).toContain('<span>新建</span>')
  })

  it('底部 footer 新建按钮已移除（无 panel-footer / btn-new-session）', () => {
    expect(source).not.toContain('panel-footer')
    expect(source).not.toContain('btn-new-session"')
  })

  it('空态提示改为「点击上方按钮创建」', () => {
    expect(source).toContain('点击上方按钮创建')
    expect(source).not.toContain('点击下方按钮创建')
  })
})

describe('SessionList 会话行去云朵 icon', () => {
  it('展开态会话行无 💬 图标（session-icon 类与 emoji 已删），标题占满行宽', () => {
    expect(source).not.toContain('class="session-icon"')
    // 展开态会话行按钮内不再有 emoji 图标（折叠态 collapsed-session-icon 保留——Claude Desktop 图标列模式）
    expect(source).not.toMatch(/session-item[\s\S]{0,200}💬/)
  })

  it('折叠态图标列保留会话 icon（56px 图标条模式，Claude Desktop 范式）', () => {
    expect(source).toContain('class="collapsed-session-icon"')
  })
})

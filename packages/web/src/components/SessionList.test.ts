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
  it('会话行无 💬 图标（session-icon 类与 emoji 已删），标题占满行宽', () => {
    expect(source).not.toContain('class="session-icon"')
    expect(source).not.toMatch(/session-item[\s\S]{0,200}💬/)
  })

  it('折叠态图标列已整支删除（与 .panel-left 的 display:none 同条件 ⇒ DOM 永不可见）', () => {
    expect(source).not.toContain('collapsed')
  })
})

describe('SessionList B·改全局框架：选中态=底色、头行无线', () => {
  it('会话项选中态用 accent 淡底，不再生成左缘竖条 pseudo', () => {
    const activeRule = source.match(/\.session-item\.active\s*\{[\s\S]*?\}/)
    expect(activeRule, '未找到 .session-item.active 规则').toBeTruthy()
    expect(activeRule![0]).toContain('background: var(--accent-soft)')
    expect(source).not.toContain('.session-item.active::before')
  })

  it('会话栏头行不画 border-bottom，改同底色 + sticky（结构线 0 条）', () => {
    const headerRule = source.match(/\.section-header\s*\{[\s\S]*?\}/)
    expect(headerRule, '未找到 .section-header 规则').toBeTruthy()
    expect(headerRule![0]).toContain('position: sticky')
    expect(headerRule![0]).toContain('background: var(--bg-session)')
    expect(headerRule![0]).not.toContain('border-bottom')
  })
})

describe('SessionList 归档入口（票 7，spec §4.1 用户态删除 = 归档）', () => {
  it('会话行有归档按钮，且物理删除按钮已移除（不再提供一键永久删除入口）', () => {
    expect(source).toContain('class="session-archive"')
    expect(source).toContain('handleArchive')
    expect(source).not.toContain('class="session-delete"')
    expect(source).not.toContain('handleDelete')
    // 「永久删除」的措辞随之消失（确认框文案是产品决策最直白的落点）
    expect(source).not.toContain('消息将被永久删除')
  })

  it('按钮语义随归档态二分：归档 ↔ 取消归档', () => {
    expect(source).toContain("s.archivedAt ? '取消归档' : '归档会话'")
    expect(source).toContain('@click="handleArchive(s.id, !s.archivedAt)"')
  })

  it('标题行有「已归档」开关，点击切换 store.setShowArchived', () => {
    expect(source).toContain('class="btn-toggle-archived"')
    expect(source).toContain('@click="store.setShowArchived(!store.showArchived)"')
    expect(source).toContain(':aria-pressed="store.showArchived"')
  })

  it('已归档行有可见标记（不是只靠按钮语义区分）', () => {
    expect(source).toContain('class="session-archived-tag"')
    expect(source).toMatch(/v-if="s\.archivedAt"/)
  })
})

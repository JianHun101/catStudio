import { describe, it, expect } from 'vitest'
import appSource from './App.vue?raw'
import chatPanelSource from './components/ChatPanel.vue?raw'

/**
 * Verify the global settings entry (App.vue 左侧栏底部齿轮 → SettingsView).
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Regression protection for
 * 用户明确决策：设置入口放全局位置（左侧栏底部齿轮，Claude Desktop 模式），
 * 严禁放会话区（ChatPanel）——放会话区会被误解为单会话配置。
 */

describe('App.vue 设置入口（全局位置）', () => {
  it('view 切换状态：showSettings 默认关闭，SettingsView v-if 挂载', () => {
    expect(appSource).toContain('const showSettings = ref(false)')
    expect(appSource).toContain(
      `<SettingsView v-if="showSettings" @close="showSettings = false" />`
    )
    expect(appSource).toContain("import SettingsView from './views/SettingsView.vue'")
  })

  it('齿轮入口在 panel-left 底部（left-sidebar-footer），点击打开设置页', () => {
    // 入口锚定左侧栏（全局导航位），不在会话区
    expect(appSource).toContain('class="left-sidebar-footer"')
    expect(appSource).toContain('class="settings-entry"')
    expect(appSource).toContain('@click="showSettings = true"')
    expect(appSource).toContain('title="设置"')
    expect(appSource).toContain('aria-label="设置"')
    // 设置页与三栏布局互斥（v-else）
    expect(appSource).toMatch(/<SettingsView v-if="showSettings"[\s\S]*?v-else class="app-layout"/)
  })

  it('折叠态（56px 图标条）齿轮照常容纳——图标条模式', () => {
    expect(appSource).toContain('settings-entry-collapsed')
    expect(appSource).toContain('v-if="leftOpen" class="settings-entry-text"')
  })
})

describe('App.vue 两栏布局（B2 删右栏）', () => {
  it('grid 两栏 260px 1fr，折叠态 56px 1fr——无右栏列', () => {
    expect(appSource).toContain('grid-template-columns: 260px 1fr;')
    expect(appSource).toContain('grid-template-columns: 56px 1fr;')
    expect(appSource).not.toContain('300px')
    expect(appSource).not.toContain('right-closed')
  })

  it('panel-right / AgentPanel 已删除（内容迁入设置页猫咪管理），ChatPanel 不再收 right props', () => {
    expect(appSource).not.toContain('panel-right')
    expect(appSource).not.toContain('AgentPanel')
    expect(appSource).not.toContain('right-sidebar-open')
    expect(appSource).not.toContain('toggle-right-sidebar')
  })

  it('左折叠状态/媒体查询保留（仅剩左侧折叠逻辑）', () => {
    expect(appSource).toContain('const leftOpen = ref(true)')
    expect(appSource).toContain('left-closed')
    expect(appSource).toContain('max-width: 650px')
    // 右栏专属的 narrow 查询（1000px）已随右栏删除
    expect(appSource).not.toContain('1000px')
  })
})

describe('ChatPanel 会话区无设置入口残留', () => {
  it('旧 QQ 绑定弹窗入口已移除（无 btn-bindings / showBindings / ConnectorBindingsModal 引用）', () => {
    expect(chatPanelSource).not.toContain('btn-bindings')
    expect(chatPanelSource).not.toContain('showBindings')
    expect(chatPanelSource).not.toContain('ConnectorBindingsModal')
  })
})

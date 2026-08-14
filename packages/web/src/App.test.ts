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
    // 设置页与三栏布局互斥：app-layout 用 v-show 保活（切回零重建），设置/评估页仍 v-if/v-else-if 互斥
    expect(appSource).toMatch(/<div v-show="!showSettings && !showEval" class="app-layout"/)
  })

  it('折叠态（56px 图标条）齿轮照常容纳——图标条模式', () => {
    expect(appSource).toContain('settings-entry-collapsed')
    expect(appSource).toContain('v-if="leftOpen" class="settings-entry-text"')
  })
})

describe('App.vue 评估中心入口（E4-B 全局位置）', () => {
  it('view 切换状态：showEval 默认关闭，EvaluationView v-else-if 挂载（与设置页互斥）', () => {
    expect(appSource).toContain('const showEval = ref(false)')
    expect(appSource).toContain(`<EvaluationView v-else-if="showEval" @close="showEval = false" />`)
    expect(appSource).toContain("import EvaluationView from './views/EvaluationView.vue'")
  })

  it('评估入口在 panel-left 底部（left-sidebar-footer 设置按钮上方），点击打开评估中心', () => {
    // 入口锚定左侧栏底部全局导航位（与设置同列，评估在上）
    expect(appSource).toContain('title="评估中心"')
    expect(appSource).toContain('aria-label="评估中心"')
    expect(appSource).toContain('@click="showEval = true"')
    expect(appSource).toContain('<span v-if="leftOpen" class="settings-entry-text">评估</span>')
    // 两个入口同属 left-sidebar-footer（纵向排列）
    const footerStart = appSource.indexOf('left-sidebar-footer')
    const evalIdx = appSource.indexOf('title="评估中心"')
    const settingsIdx = appSource.indexOf('title="设置"')
    expect(footerStart).toBeGreaterThan(-1)
    expect(evalIdx).toBeGreaterThan(footerStart)
    expect(settingsIdx).toBeGreaterThan(evalIdx)
  })
})

describe('App.vue 三栏布局（B1 恢复右栏——clowder-ai 精简评估面板）', () => {
  it('grid 三栏 260px 1fr 300px，左折叠态 56px 1fr 300px（右栏保持）', () => {
    expect(appSource).toContain('grid-template-columns: 260px 1fr 300px;')
    expect(appSource).toContain('grid-template-columns: 56px 1fr 300px;')
  })

  it('panel-right 挂 SessionAgentsPanel（评估面板非旧运行控制台），ChatPanel 不接收 right props', () => {
    expect(appSource).toContain('class="panel-right"')
    expect(appSource).toContain('import SessionAgentsPanel')
    expect(appSource).toContain('<SessionAgentsPanel />')
    // ChatPanel 保持纯左 props（停止按钮归气泡，无右栏联动）
    expect(appSource).not.toContain('right-sidebar-open')
    expect(appSource).not.toContain('toggle-right-sidebar')
  })

  it('右栏窄窗（<1000px）媒体查询隐藏——rightOpen 驱动 right-closed（与左侧折叠同构）', () => {
    expect(appSource).toContain('const rightOpen = ref(true)')
    expect(appSource).toContain("window.matchMedia('(max-width: 1000px)')")
    expect(appSource).toContain('right-closed')
  })

  it('窄窗媒体查询同步收窄 grid 列——300px 空轨道不占位（display:none 的 item 不参与布局但显式 track 仍占位）', () => {
    expect(appSource).toContain('@media (max-width: 1000px)')
    expect(appSource).toContain('grid-template-columns: 260px 1fr;')
    expect(appSource).toContain('grid-template-columns: 56px 1fr;')
  })

  it('左折叠状态/媒体查询保留', () => {
    expect(appSource).toContain('const leftOpen = ref(true)')
    expect(appSource).toContain('left-closed')
    expect(appSource).toContain('max-width: 650px')
  })
})

describe('ChatPanel 会话区无设置入口残留', () => {
  it('旧 QQ 绑定弹窗入口已移除（无 btn-bindings / showBindings / ConnectorBindingsModal 引用）', () => {
    expect(chatPanelSource).not.toContain('btn-bindings')
    expect(chatPanelSource).not.toContain('showBindings')
    expect(chatPanelSource).not.toContain('ConnectorBindingsModal')
  })
})

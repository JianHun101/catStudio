import { describe, it, expect } from 'vitest'
import appSource from './App.vue?raw'
import chatPanelSource from './components/ChatPanel.vue?raw'

/**
 * Verify the global settings entry (App.vue 52px 图标轨道齿轮 → SettingsView).
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Regression protection for
 * 用户明确决策：设置入口放全局位置（左侧 52px 图标轨道底部齿轮），
 * 严禁放会话区（ChatPanel）——放会话区会被误解为单会话配置。
 *
 * T1 改版位移：入口从「会话栏底部 footer」上移到「图标轨道」——理由是**会话栏可整栏
 * 收起，轨道不能**，入口放会话栏会在收起后消失。断言随之改锚，意图（全局位、非会话区）不变。
 */

describe('App.vue 设置入口（全局位置）', () => {
  it('view 切换状态：showSettings 默认关闭，SettingsView v-if 挂载', () => {
    expect(appSource).toContain('const showSettings = ref(false)')
    expect(appSource).toContain(
      `<SettingsView v-if="showSettings" @close="showSettings = false" />`
    )
    expect(appSource).toContain("import SettingsView from './views/SettingsView.vue'")
  })

  it('齿轮入口在 52px 图标轨道（全局导航位），点击打开设置页', () => {
    // 入口锚定图标轨道（全局导航位），不在会话区
    expect(appSource).toContain('class="app-rail"')
    expect(appSource).toContain('class="rail-btn"')
    expect(appSource).toContain('@click="showSettings = true"')
    expect(appSource).toContain('title="设置"')
    expect(appSource).toContain('aria-label="设置"')
    // 设置页与三栏布局互斥：app-layout 用 v-show 保活（切回零重建），设置/评估页仍 v-if/v-else-if 互斥
    expect(appSource).toMatch(/<div v-show="!showSettings && !showEval" class="app-layout"/)
  })

  it('轨道恒在——会话栏收起（left-closed）只收会话栏，轨道不受影响', () => {
    // 入口不再有折叠态分支（旧 settings-entry-collapsed / v-if="leftOpen" 文本形态已随位置变更退役）
    expect(appSource).not.toContain('settings-entry-collapsed')
    // 收起态只对会话栏生效：轨道 track 恒为 52px，会话栏 track 归零
    expect(appSource).toContain('grid-template-columns: 52px 0 1fr 300px;')
    expect(appSource).toContain('.app-layout.left-closed .panel-left')
  })
})

describe('App.vue 评估中心入口（E4-B 全局位置）', () => {
  it('view 切换状态：showEval 默认关闭，EvaluationView v-else-if 挂载（与设置页互斥）', () => {
    expect(appSource).toContain('const showEval = ref(false)')
    expect(appSource).toContain(`<EvaluationView v-else-if="showEval" @close="showEval = false" />`)
    expect(appSource).toContain("import EvaluationView from './views/EvaluationView.vue'")
  })

  it('评估入口在同一图标轨道内（设置按钮上方），点击打开评估中心', () => {
    // 入口锚定图标轨道全局导航位（与设置同列，评估在上）
    expect(appSource).toContain('title="评估中心"')
    expect(appSource).toContain('aria-label="评估中心"')
    expect(appSource).toContain('@click="showEval = true"')
    // 两个入口同属 app-rail，且评估在设置之前（纵向排列）
    const railStart = appSource.indexOf('class="app-rail"')
    const evalIdx = appSource.indexOf('title="评估中心"')
    const settingsIdx = appSource.indexOf('title="设置"')
    expect(railStart).toBeGreaterThan(-1)
    expect(evalIdx).toBeGreaterThan(railStart)
    expect(settingsIdx).toBeGreaterThan(evalIdx)
  })
})

describe('App.vue 布局骨架（T1：52px 轨道 + 会话栏 + 主区 + 右栏）', () => {
  it('grid 四栏 52px 236px 1fr 300px，收起会话栏 52px 0 1fr 300px（轨道与右栏保持）', () => {
    expect(appSource).toContain('grid-template-columns: 52px 236px 1fr 300px;')
    expect(appSource).toContain('grid-template-columns: 52px 0 1fr 300px;')
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
    expect(appSource).toContain('grid-template-columns: 52px 236px 1fr;')
    expect(appSource).toContain('grid-template-columns: 52px 0 1fr;')
  })

  it('左折叠状态/媒体查询保留', () => {
    expect(appSource).toContain('const leftOpen = ref(true)')
    expect(appSource).toContain('left-closed')
    expect(appSource).toContain('max-width: 650px')
  })

  it('轨道内容：logo 爪印 + 对话/追踪/评估 + 底部齿轮；执行追踪是 T2 的展示位', () => {
    expect(appSource).toContain('class="rail-logo"')
    expect(appSource).toContain('aria-label="主导航"')
    // 执行追踪按钮本票不接行为（T2 落地）——disabled + 说明性 title
    expect(appSource).toContain('aria-label="执行追踪（随 T2 落地）"')
    expect(appSource).toContain('<div class="rail-sp"></div>')
  })
})

describe('ChatPanel 会话区无设置入口残留', () => {
  it('旧 QQ 绑定弹窗入口已移除（无 btn-bindings / showBindings / ConnectorBindingsModal 引用）', () => {
    expect(chatPanelSource).not.toContain('btn-bindings')
    expect(chatPanelSource).not.toContain('showBindings')
    expect(chatPanelSource).not.toContain('ConnectorBindingsModal')
  })
})

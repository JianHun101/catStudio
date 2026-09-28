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
 *
 * T4 再位移：轨道从 `.app-layout` 内部提到**根级常驻**——理由是三个覆盖层（设置/追踪/评估）
 * 原本是 `fixed inset 0` 的全屏模态，打开即把轨道整条盖掉，用户看到「设置页的导航栏跟
 * 主聊天界面不一样」。断言随之改锚两处：①grid 四栏 → 三栏（52px 轨道不再占 track，改由
 * `.app-rail` 定宽）；②入口从行内 `showSettings = true` → 互斥开关 `openSettings()`。
 * 意图（轨道全视图常驻、入口在全局导航位、聊天页列宽不变）一条不减。
 */

describe('App.vue 设置入口（全局位置）', () => {
  it('view 切换状态：showSettings 默认关闭，SettingsView v-if 挂载', () => {
    expect(appSource).toContain('const showSettings = ref(false)')
    // T4：`@close` 处理器随 ✕ 退役——设置页不再是模态，回聊天靠轨道 💬
    expect(appSource).toContain(`<SettingsView v-if="showSettings" />`)
    expect(appSource).toContain("import SettingsView from './views/SettingsView.vue'")
  })

  it('齿轮入口在 52px 图标轨道（全局导航位），点击打开设置页', () => {
    // 入口锚定图标轨道（全局导航位），不在会话区
    expect(appSource).toContain('class="app-rail"')
    expect(appSource).toContain('class="rail-btn"')
    // T4：入口从行内 `showSettings = true` 改走互斥开关（开一个关其余 + 幂等）
    expect(appSource).toContain('@click="openSettings()"')
    expect(appSource).toContain('title="设置"')
    expect(appSource).toContain('aria-label="设置"')
    // 全屏页与三栏布局互斥：app-layout 用 v-show 保活（切回零重建），三个全屏页
    // 走同一条 v-if/v-else-if 链。判据绑 `anyOverlayOpen` 单源——逐个列布尔的话
    // 加第四个 view 时这里仍是绿的（漏改不报错），正是复述面分叉的老形态。
    expect(appSource).toMatch(/<div v-show="!anyOverlayOpen" class="app-layout"/)
  })

  it('轨道恒在——会话栏收起（left-closed）只收会话栏，轨道不受影响', () => {
    // 入口不再有折叠态分支（旧 settings-entry-collapsed / v-if="leftOpen" 文本形态已随位置变更退役）
    expect(appSource).not.toContain('settings-entry-collapsed')
    // 收起态只对会话栏生效：会话栏 track 归零
    expect(appSource).toContain('grid-template-columns: 0 1fr 300px;')
    expect(appSource).toContain('.app-layout.left-closed .panel-left')
    // T4：轨道改由根级 `.app-rail` 定宽（`flex:none` 防被 flex 压缩），
    // 不再随 app-layout 的任何态变化（既不进 grid track，也没有折叠分支）
    const rail = appSource.match(/\.app-rail\s*\{[\s\S]*?\}/)
    expect(rail, '未找到 .app-rail 规则').toBeTruthy()
    expect(rail![0]).toContain('width: 52px')
    expect(rail![0]).toContain('flex: none')
  })
})

describe('App.vue 评估中心入口（E4-B 全局位置）', () => {
  it('view 切换状态：showEval 默认关闭，EvaluationView v-else-if 挂载（与设置页互斥）', () => {
    expect(appSource).toContain('const showEval = ref(false)')
    expect(appSource).toContain(`<EvaluationView v-else-if="showEval" />`)
    expect(appSource).toContain("import EvaluationView from './views/EvaluationView.vue'")
  })

  it('评估入口在同一图标轨道内（设置按钮上方），点击打开评估中心', () => {
    // 入口锚定图标轨道全局导航位（与设置同列，评估在上）
    expect(appSource).toContain('title="评估中心"')
    expect(appSource).toContain('aria-label="评估中心"')
    expect(appSource).toContain('@click="openEval()"')
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
  it('grid 三栏 236px 1fr 300px，收起会话栏 0 1fr 300px（T4：52px 轨道归根级，不再占 track）', () => {
    expect(appSource).toContain('grid-template-columns: 236px 1fr 300px;')
    expect(appSource).toContain('grid-template-columns: 0 1fr 300px;')
    // 旧四栏形态必须清零：留着任何一处「52px 起头」的 track，轨道就会被算两次
    expect(appSource).not.toContain('grid-template-columns: 52px')
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
    expect(appSource).toContain('grid-template-columns: 236px 1fr;')
    expect(appSource).toContain('grid-template-columns: 0 1fr;')
  })

  it('左折叠状态/媒体查询保留', () => {
    expect(appSource).toContain('const leftOpen = ref(true)')
    expect(appSource).toContain('left-closed')
    expect(appSource).toContain('max-width: 650px')
  })

  it('轨道内容：logo 爪印 + 对话/追踪/评估 + 底部齿轮；执行追踪已接线（T2）', () => {
    expect(appSource).toContain('class="rail-logo"')
    expect(appSource).toContain('aria-label="主导航"')
    // 执行追踪入口（T2 起**接行为**）：轨道按钮开追踪页，不预选任何一条执行
    expect(appSource).toContain('aria-label="执行追踪"')
    expect(appSource).toContain('@click="openTrace()"')
    expect(appSource).toContain('<div class="rail-sp"></div>')
  })

  it('三个全屏 view 互斥且底层布局保活（T2 的追踪页并入同一条 v-else-if 链）', () => {
    // 互斥：后开的那个把前面两个关掉（openTrace 显式清另外两个）
    expect(appSource).toMatch(/function openTrace[\s\S]*?showSettings\.value = false/)
    expect(appSource).toMatch(/function openTrace[\s\S]*?showEval\.value = false/)
    // 保活：底层三栏用 v-show 且以 `anyOverlayOpen` 为准（少一个 view 就会在追踪页
    // 打开时露出底下的聊天区——三个 view 是同一个布尔面的三个分支）
    expect(appSource).toContain('const anyOverlayOpen = computed(')
    expect(appSource).toContain('v-show="!anyOverlayOpen"')
    expect(appSource).toMatch(
      /anyOverlayOpen = computed\(\s*\(\) => showSettings\.value \|\| showEval\.value \|\| showTrace\.value/
    )
  })

  it('气泡 ⚙ 跳回时：关追踪页 + 必要时切会话 + 把焦点交给 ChatPanel', () => {
    expect(appSource).toMatch(/function onTraceJump[\s\S]*?showTrace\.value = false/)
    expect(appSource).toContain('store.joinSession(sessionId)')
    expect(appSource).toContain('store.requestFocusMessage(messageId)')
  })
})

describe('App.vue T4 全局轨道统一（票面 docs/run/ui-redesign/T4-global-rail.md）', () => {
  // 病灶：T1 把 52px 轨道做进了 `.app-layout` **内部**，而三个覆盖层是 `fixed inset 0`
  // 的全屏模态——打开设置/追踪/评估时 `.app-layout` 被 v-show 隐藏，整条轨道随之消失，
  // 三个视图各自靠「页头 + ✕」返回（用户原话：「设置页左侧导航栏跟原型不一样」）。
  // 验收靶子一句话：**四个视图下轨道都在，`.on` 跟着当前视图走。**

  it('轨道在根级、在 .app-main 之外——覆盖层打开时它不会被 v-show 带走', () => {
    expect(appSource).toContain('class="app-root"')
    expect(appSource).toContain('class="app-main"')
    const rail = appSource.indexOf('class="app-rail"')
    const main = appSource.indexOf('class="app-main"')
    const layout = appSource.indexOf('class="app-layout"')
    expect(rail, '未找到 app-rail').toBeGreaterThan(-1)
    expect(main, 'app-main 应在轨道之后').toBeGreaterThan(rail)
    expect(layout, 'app-layout 应在 app-main 之内（之后）').toBeGreaterThan(main)
    // 「四视图常驻」的全部机制：轨道元素自身没有任何显隐绑定
    const railBlock = appSource.match(/class="app-rail"[\s\S]*?<\/nav>/)
    expect(railBlock, '未找到 .app-rail 元素').toBeTruthy()
    expect(railBlock![0]).not.toContain('v-show')
    expect(railBlock![0]).not.toContain('v-if')
  })

  it('根容器 / 内容区两栏 flex：轨道定宽 + 内容区 flex:1 min-width:0', () => {
    const root = appSource.match(/\.app-root\s*\{[\s\S]*?\}/)
    expect(root, '未找到 .app-root 规则').toBeTruthy()
    expect(root![0]).toContain('display: flex')
    const main = appSource.match(/\.app-main\s*\{[\s\S]*?\}/)
    expect(main, '未找到 .app-main 规则').toBeTruthy()
    expect(main![0]).toContain('flex: 1')
    expect(main![0]).toContain('min-width: 0')
  })

  it('激活态单源：currentView 四值派生，四个按钮各挂 .on + aria-current', () => {
    expect(appSource).toMatch(
      /const currentView = computed<'chat' \| 'trace' \| 'eval' \| 'settings'>\(/
    )
    // 硬编码激活态已退役——留着它，打开设置页时 💬 仍是亮的
    expect(appSource).not.toContain('class="rail-btn on"')
    for (const v of ['chat', 'trace', 'eval', 'settings']) {
      expect(appSource, v).toContain(`:class="{ on: currentView === '${v}' }"`)
      expect(appSource, v).toContain(`:aria-current="currentView === '${v}' ? 'page' : undefined"`)
    }
  })

  it('互斥开关联：openSettings/openEval 各关另两个，且幂等（点当前视图无操作）', () => {
    const cases: Array<[string, string, string[]]> = [
      ['openSettings', 'showSettings', ['showEval', 'showTrace']],
      ['openEval', 'showEval', ['showSettings', 'showTrace']],
    ]
    for (const [fn, self, others] of cases) {
      const body = appSource.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`))
      expect(body, `未找到 ${fn}`).toBeTruthy()
      expect(body![0], `${fn} 缺幂等守卫`).toContain(`if (${self}.value) return`)
      for (const o of others) expect(body![0], `${fn} 未关 ${o}`).toContain(`${o}.value = false`)
    }
    // 💬 = 关掉全部覆盖层——✕ 退役后这是唯一的返回手段
    const chat = appSource.match(/function openChat\(\)[\s\S]*?\n\}/)
    expect(chat, '未找到 openChat').toBeTruthy()
    for (const o of ['showSettings', 'showEval', 'showTrace']) {
      expect(chat![0], `openChat 未关 ${o}`).toContain(`${o}.value = false`)
    }
  })

  it('覆盖层不再自带关闭按钮：App.vue 里一个 @close 都不剩', () => {
    // 三个覆盖层的 ✕ 与各自 SFC 里的 `close` emit 同批退役
    // （「✕ 清零 / 弹窗级关闭按钮保留」由三个视图自己的静态断言覆盖）
    expect(appSource).not.toContain('@close')
  })
})

describe('ChatPanel 会话区无设置入口残留', () => {
  it('旧 QQ 绑定弹窗入口已移除（无 btn-bindings / showBindings / ConnectorBindingsModal 引用）', () => {
    expect(chatPanelSource).not.toContain('btn-bindings')
    expect(chatPanelSource).not.toContain('showBindings')
    expect(chatPanelSource).not.toContain('ConnectorBindingsModal')
  })
})

import { describe, it, expect } from 'vitest'
import source from './SettingsView.vue?raw'

/**
 * Verify SettingsView.vue — 全屏设置中心（左侧栏底部齿轮进入）。
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Migration from three
 * components (ConnectorBindingsModal / ConnectorNapCatPanel /
 * NapcatPathPicker) into one settings page — all behavioral assertions
 * carried over, plus new autoStart 开关 / 入站状态只读 assertions.
 * Contract (店长钉死): autoStart 缺省 true（旧配置无字段 = 自动拉起），
 * 开关初始态跟随 GET 响应，保存时 POST 全量带 { napcatPath, autoStart }。
 */

describe('SettingsView 结构（QQ 接入 / NapCat 双 tab）', () => {
  it('全屏设置中心：fixed inset 0 + 关闭按钮 → emit close', () => {
    expect(source).toContain('settings-view')
    expect(source).toContain('position: fixed')
    expect(source).toContain('inset: 0')
    expect(source).toContain('@click="emit(\'close\')"')
  })

  it('tab 状态与切换按钮：activeTab 默认 qq，两 tab 文案齐全', () => {
    expect(source).toContain("const activeTab = ref<'qq' | 'napcat'>('qq')")
    expect(source).toContain('QQ 接入')
    expect(source).toContain('NapCat')
    expect(source).toContain("activeTab === 'qq'")
    expect(source).toContain("activeTab === 'napcat'")
  })

  it('Tab1 内容 v-show 保持挂载；Tab2 面板 v-if 进入才挂载', () => {
    expect(source).toContain(`v-show="activeTab === 'qq'"`)
    expect(source).toContain(`v-if="activeTab === 'napcat'"`)
  })

  it('挂载即拉齐三份数据：绑定列表 + OneBot 状态 + NapCat 配置', () => {
    expect(source).toContain('onMounted(() => {')
    expect(source).toContain('loadBindings()')
    expect(source).toContain('refresh()')
    expect(source).toContain('loadConfig()')
  })
})

describe('SettingsView 入站状态只读（QQ 接入 Tab）', () => {
  it('QQ Tab 展示 enabled / apiBase / token 掩码（只读，token 不出 server）', () => {
    expect(source).toContain('inbound-card')
    expect(source).toContain('入站启用')
    expect(source).toContain("status?.enabled ? '是' : '否'")
    expect(source).toContain('status?.apiBase')
    expect(source).toContain('status?.tokenMasked')
    expect(source).toContain(`status?.tokenConfigured ? status?.tokenMasked : '未配置'`)
  })
})

describe('SettingsView 绑定管理（ConnectorBindingsModal Tab1 迁移）', () => {
  it('externalId validates as pure digits before sending (backend contract)', () => {
    // Must be /^\d+$/ — matches normalizeExternalId in routes/connectors.ts.
    // A frontend gap here would surface as a 400 round-trip for every typo.
    expect(source).toMatch(/\/\^\\d\+\$\/\.test\(externalId\.value\.trim\(\)\)/)
  })

  it('sessionId required — blocks submit with readable message', () => {
    expect(source).toContain('请选择要绑定的会话')
    expect(source).toMatch(/!sessionId\.value/)
  })

  it('create goes through api.createConnectorBinding with camelCase contract fields', () => {
    // API boundary converts snake_case (DB rows) to camelCase — must send
    // externalType/externalId/sessionId, not external_type.
    expect(source).toContain('await api.createConnectorBinding({')
    expect(source).toContain('externalType: externalType.value')
    expect(source).toContain('externalId: externalId.value.trim()')
  })

  it('delete goes through api.deleteConnectorBinding with snake_case binding row fields', () => {
    // Binding rows come back snake_case from GET (no camelCase mapping at
    // this API boundary) — delete must read external_type/external_id.
    expect(source).toContain('await api.deleteConnectorBinding({')
    expect(source).toContain('externalType: binding.external_type')
    expect(source).toContain('externalId: binding.external_id')
  })

  it('maps external_type to 群聊/私聊 labels', () => {
    expect(source).toContain('typeLabel(b.external_type)')
    expect(source).toContain("'群聊'")
    expect(source).toContain("'私聊'")
  })

  it('session title joins via store.sessions with raw-id fallback', () => {
    // 派活单：session_id 用 getSessions() join 出标题，查不到显示原始 id。
    // store.sessions is the GET /api/sessions result — same source, no extra request.
    expect(source).toMatch(/store\.sessions\.find\(\(s\) => s\.id === id\)\?\.title \|\| id/)
  })

  it('delete uses two-step confirm keyed by binding.id (uuid PK, not external_id)', () => {
    // 行键必须用 binding.id：后端唯一约束是 (platform, external_type, external_id)，
    // 同平台同号不同 external_type 可共存——external_id 作行键会让双行共享确认态，
    // 未 arm 的行被「第一步」手势单次点击即删（两步确认失效）。
    expect(source).toMatch(/confirmDeleteId\.value !== binding\.id/)
    expect(source).toContain('confirmDeleteId.value = binding.id')
    expect(source).toContain('确认删除？')
    // 模板判定（:class + 文案）也必须全部切到 b.id——external_id 残留即共享确认态回归
    expect(source).toContain('confirmDeleteId === b.id')
    expect(source).not.toContain('confirmDeleteId === b.external_id')
  })

  it('loads bindings on mount and refreshes after add/delete', () => {
    expect(source).toContain('await loadBindings() // POST 成功后刷新列表')
    expect(source).toContain('await loadBindings() // DELETE 成功后刷新列表')
  })
})

describe('SettingsView NapCat 生命周期（ConnectorNapCatPanel 迁移）', () => {
  it('状态卡渲染：运行中/已停止 + API 地址', () => {
    expect(source).toContain('api.getOneBotStatus()')
    expect(source).toContain('运行中')
    expect(source).toContain('已停止')
    expect(source).toContain('status?.apiBase')
  })

  it('启停按钮 → POST control → 3s × 最多 10 次轮询等 running 翻转（契约 30s 上限）', () => {
    expect(source).toContain('api.napcatControl(action)')
    expect(source).toContain('setTimeout(r, 3000)')
    expect(source).toContain('i < 10')
    expect(source).toContain('st.running === target')
    expect(source).toContain(`handleAction('start')`)
    expect(source).toContain(`handleAction('stop')`)
  })

  it('未配置启动命令 → 引导文案；start 按钮禁用条件含 launchReady', () => {
    expect(source).toContain('launchCmdConfigured')
    expect(source).toContain('NAPCAT_LAUNCH_CMD')
    expect(source).toContain('未配置启动命令')
    expect(source).toContain('!status?.launchReady') // 按钮禁用以「命令就绪」为准（含占位符未配路径也禁用）
  })

  it('组件卸载后停止轮询（disposed 标志防写已卸载组件的 ref）', () => {
    expect(source).toContain('let disposed = false')
    expect(source).toContain('onUnmounted')
    expect(source).toContain('if (disposed) return false')
    expect(source).toContain('if (!disposed) acting.value = false')
  })
})

describe('SettingsView autoStart 开关（新功能）', () => {
  it('开关初始态跟随 GET 响应：undefined 兜底按 true（缺省 true 语义）', () => {
    expect(source).toContain('const autoStart = ref(true)')
    expect(source).toContain('autoStart.value = cfg.autoStart !== false')
    expect(source).toContain('旧配置无 autoStart 字段')
  })

  it('开关变化立即保存：POST 全量带 { napcatPath, autoStart } + 保存失败回滚', () => {
    expect(source).toContain('v-model="autoStart"')
    expect(source).toContain('@change="saveAutoStart"')
    expect(source).toContain('autoStart: autoStart.value')
    expect(source).toContain('autoStart.value = !autoStart.value')
  })

  it('路径保存同样全量带开关（不覆盖 autoStart 状态）', () => {
    expect(source).toContain(
      'autoStart: autoStart.value, // 全量带开关——路径保存不覆盖 autoStart 状态'
    )
    expect(source).toContain('已保存，点「启动 NapCat」立即生效')
  })

  it('开关文案说明旧配置行为：默认开启可在设置页关闭', () => {
    expect(source).toContain('dev 启动时自动拉起')
    expect(source).toContain('旧配置无该字段 = 默认开启（可在设置页关闭）')
  })
})

describe('SettingsView 启动路径配置（ConnectorNapCatPanel 路径段迁移）', () => {
  it('进入设置页 → GET config 回填路径输入框', () => {
    expect(source).toContain('api.getNapcatConfig()')
    expect(source).toContain('napcatPath.value = cfg.napcatPath')
    expect(source).toContain('loadConfig()')
  })

  it('保存失败（400 路径不存在）→ 错误显示', () => {
    expect(source).toContain('pathError')
    expect(source).toContain("err.message || '保存失败'")
  })

  it('手动填写说明——浏览器无法选择本地文件路径（安全沙箱）', () => {
    expect(source).toContain('浏览器无法直接选择本地文件路径')
    expect(source).toContain('.exe /') // 换行拆开（.exe / .bat），断言前缀即可
  })

  it('占位符未配路径 → 引导「请在下方填写路径」', () => {
    expect(source).toContain('{NAPCAT_PATH}')
    expect(source).toContain('请在下方')
    expect(source).toContain('!status.launchReady')
  })
})

describe('SettingsView 路径浏览选择器（NapcatPathPicker 内联迁移）', () => {
  it('「浏览…」→ openPicker 打开内联弹窗并加载盘符列表（load(null)）', () => {
    expect(source).toContain('浏览…')
    expect(source).toContain('pickerOpen.value = true')
    expect(source).toContain('function openPicker(): void')
    expect(source).toContain('load(null)')
    expect(source).toContain('选择磁盘')
  })

  it('盘符列表层 entry.name 即完整路径（currentDir 为 null 时直接回填）', () => {
    expect(source).toContain(
      `currentDir.value ? joinPath(currentDir.value, selected.value) : selected.value`
    )
  })

  it('目录条目点击进入 → openEntry 用 joinPath 拼完整路径', () => {
    expect(source).toContain('function openEntry(entry: NapcatBrowseEntry): void')
    expect(source).toContain(
      `load(currentDir.value ? joinPath(currentDir.value, entry.name) : entry.name)`
    )
    expect(source).toContain("e.type === 'dir' ? openEntry(e) : selectFile(e)")
  })

  it('↑ 上级 → goUp 用后端返回的 parentDir（盘符根 parent=null 回到盘符层）', () => {
    expect(source).toContain('parentDir.value = res.parent')
    expect(source).toContain('function goUp(): void')
    expect(source).toContain('load(parentDir.value)')
    expect(source).toContain('↑ 上级')
  })

  it('可执行文件高亮（executable 徽标「可执行」）+ 点选选中态', () => {
    expect(source).toContain('exec-badge')
    expect(source).toContain('可执行')
    expect(source).toContain("e.type === 'file' && e.executable")
    expect(source).toContain("entry-selected': selected === e.name")
  })

  it('确定 → confirmPick 直接写回路径输入框并关闭；无选中时确定禁用', () => {
    expect(source).toContain('function confirmPick(): void')
    expect(source).toContain('napcatPath.value = full')
    expect(source).toContain(':disabled="!selected"')
    expect(source).toContain('closePicker()')
  })

  it('关闭路径：overlay 点击自身 / 关闭按钮 → closePicker', () => {
    expect(source).toContain('@click.self="closePicker"')
  })

  it('错误态/空态/加载态展示', () => {
    expect(source).toContain('browseError')
    expect(source).toContain('（空目录）')
    expect(source).toContain('加载中…')
  })
})

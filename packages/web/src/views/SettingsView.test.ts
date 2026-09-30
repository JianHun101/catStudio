import { describe, it, expect } from 'vitest'
import source from './SettingsView.vue?raw'
import designTokens from '../../index.html?raw'

/**
 * Verify SettingsView.vue — 全屏设置中心（左侧栏底部齿轮进入，左右分栏经典结构）。
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. 重构（单 B1）：左侧大类导航
 * （猫咪管理 / IM 接入 / 系统配置）+ 右侧详情区；AgentPanel 卡片内容复制迁入
 * 「猫咪管理」（原组件等 B2 删除）；系统配置 = context 阈值表单（单 A 契约）。
 * 既有 IM 接入子 Tab 断言全部保留（内容平移零改动）。
 */

describe('SettingsView 左右分栏结构（猫咪管理 / IM 接入 / 系统配置）', () => {
  it('设置视图 = 内容区弹性块（T4：不再是 fixed 全屏模态），页头/✕ 退役', () => {
    // T4 改锚：轨道提到根级常驻后本视图从 `position: fixed; inset: 0` 改为内容区里的
    // 弹性块——仍是 fixed inset 0 的话会把常驻轨道整条盖住（用户报的「设置页导航栏
    // 跟原型不一样」，原型 v6 是轨道 + 大类导航 + 卡片列三层）。仍是全屏视图语义。
    const root = source.match(/\.settings-view\s*\{[\s\S]*?\}/)
    expect(root, '未找到 .settings-view 规则').toBeTruthy()
    expect(source).toContain('class="settings-view" aria-label="设置"')
    expect(root![0]).toContain('flex: 1')
    expect(root![0]).not.toContain('position: fixed')
    expect(root![0]).not.toContain('inset: 0')
    // 页头（标题 + ✕）整体退役 + `close` emit 退役；死 CSS 同批删除（留着会让后人
    // 以为页头仍在）。注意：弹窗级 `.btn-close`（浏览 NapCat 路径）保留——
    // 「✕ 清零」清的是视图级页头，不是模态弹窗的关闭手段。
    expect(source).not.toContain('settings-header')
    expect(source).not.toContain('settings-title')
    expect(source).not.toContain('settings-icon')
    expect(source).not.toContain('defineEmits')
    expect(source).not.toContain("emit('close')")
    expect(source).toContain('@click="closePicker"')
  })

  it('左侧大类导航：三大类文案 + 选中态高亮 + 点击切换', () => {
    expect(source).toContain("const activeCategory = ref<'cats' | 'im' | 'system'>('im')")
    // T5 改锚：导航壳换成共享组件 SubNav（148px 竖排）。激活态高亮与点击切换由它承担
    // （见 SubNav.test.ts），本视图的契约是「三个大类绑上它的 items + v-model 写回」。
    expect(source).toContain('<SubNav')
    expect(source).toContain('v-model="activeCategory"')
    expect(source).toContain(':items="settingsNavItems"')
    expect(source).toContain('猫咪管理')
    expect(source).toContain('IM 接入')
    expect(source).toContain('系统配置')
    // 三个 item 的 key 与 activeCategory 的值域一一对应——点击切换就是拿 key 写回这个 ref
    for (const key of ['cats', 'im', 'system']) {
      expect(source, key).toContain(`key: '${key}'`)
    }
  })

  it('默认大类 = IM 接入（子 Tab QQ 接入）——打开设置页行为与迁移前一致', () => {
    // 迁移前默认展示 QQ 接入 tab；重构后默认大类落在 IM 接入 + 子 Tab QQ 接入，零行为变化
    expect(source).toContain("const activeCategory = ref<'cats' | 'im' | 'system'>('im')")
    expect(source).toContain("const activeTab = ref<'qq' | 'napcat'>('qq')")
  })

  it('大类内容 v-show 保持挂载；IM 接入内 QQ 子 Tab v-show、NapCat 子 Tab v-if', () => {
    expect(source).toContain(`v-show="activeCategory === 'cats'"`)
    expect(source).toContain(`v-show="activeCategory === 'im'"`)
    expect(source).toContain(`v-show="activeCategory === 'system'"`)
    // 子 Tab 挂载语义与迁移前一致（v-show 常驻 / v-if 进入才挂载）
    expect(source).toContain(`v-show="activeTab === 'qq'"`)
    expect(source).toContain(`v-if="activeTab === 'napcat'"`)
  })

  it('挂载即拉齐数据：绑定列表 + OneBot 状态 + NapCat 配置 + context 阈值 + 摘要配置', () => {
    expect(source).toContain('onMounted(() => {')
    expect(source).toContain('loadBindings()')
    expect(source).toContain('refresh()')
    expect(source).toContain('loadConfig()')
    expect(source).toContain('initCtxConfig()')
    expect(source).toContain('loadSummaryConfig()')
  })
})

describe('SettingsView 入站状态只读（IM 接入 · QQ 接入 子 Tab）', () => {
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

describe('SettingsView 猫咪管理（B2 改静态配置——会话动态信息迁右侧边栏）', () => {
  it('agent 卡片渲染：头像/名字/模型徽章', () => {
    expect(source).toContain('v-for="agent in store.agents"')
    expect(source).toContain('agent.avatar')
    expect(source).toContain('agent.llmProvider')
    expect(source).toContain('agent.llmModel')
  })

  it('静态配置网格：Effort / Max Tokens / 温度 / API Key 掩码 / Base URL / 系统提示摘要', () => {
    expect(source).toContain('static-grid')
    expect(source).toContain('staticMaxTokens(agent)')
    expect(source).toContain('staticTemperature(agent)')
    expect(source).toContain('maskApiKey(agent.llmApiKey)')
    expect(source).toContain('promptSummary(agent.systemPrompt)')
    expect(source).toContain('agent.effortLevel')
    expect(source).toContain('agent.llmBaseUrl')
  })

  it('静态字段缺省与 DB 列默认一致（2048/0.7）；apiKey 掩码与提示摘要截断', () => {
    expect(source).toContain('(agent as StaticAgent).llmMaxTokens ?? 2048')
    expect(source).toContain('(agent as StaticAgent).llmTemperature ?? 0.7')
    expect(source).toContain('key.slice(0, 3)}***${key.slice(-4)}')
    expect(source).toContain('p.length > 60')
    expect(source).toContain('未配置')
  })

  it('会话动态信息已迁出：无 token 条 / 调度队列 / 停止按钮 / 状态点', () => {
    // B2 契约：动态信息迁右侧边栏（SessionAgentsPanel 承接），迁走不复制——
    // 断言锚定实现符号（注释措辞不算）
    expect(source).not.toContain('token-bar')
    expect(source).not.toContain('tokenRatio')
    expect(source).not.toContain('agentQueue')
    expect(source).not.toContain('queue-section')
    expect(source).not.toContain('interruptAgent')
    expect(source).not.toContain('btn-stop-agent')
    expect(source).not.toContain('statusDot(')
    expect(source).not.toContain('agentStateList')
    expect(source).not.toContain('contextTokensFor(')
  })

  it('新建表单 + 编辑弹窗（AgentEditModal 复用不迁）', () => {
    expect(source).toContain("import AgentEditModal from '../components/AgentEditModal.vue'")
    expect(source).toContain('editingAgent = agent')
    // 挂载标签断言：仅 import 不实例化会导致编辑功能静默失效（d74a9e3 遗漏，审查抓回）
    expect(source).toContain('<AgentEditModal :agent="editingAgent" @close="closeEdit" />')
    expect(source).toMatch(/function handleCreate[\s\S]*api\.createAgent/)
    expect(source).toContain('showCreate')
    expect(source).toContain('同名猫咪已存在，请换一个名字')
  })

  it('创建表单含 provider 选择器 + 模型输入框（店长追加派活——添加猫一步到位，provider/model 不再写死）', () => {
    // 创建表单 UI 绑定 newAgentForm.llmProvider/llmModel（提交数据早已有键，只缺 UI）
    expect(source).toContain('v-model="newAgentForm.llmProvider"')
    expect(source).toContain('v-model="newAgentForm.llmModel"')
    expect(source).toContain('v-for="p in providerOptions"')
    // 下拉含 OpenCode 项（与 AgentEditModal 同款八项）
    expect(source).toContain("{ value: 'opencode', label: 'OpenCode (CLI)' }")
    // 下拉含 dsh 项（对齐后端 registry 已支持，前端枚举补同步）
    expect(source).toContain("{ value: 'dsh', label: 'DeepSeek Harness (CLI)' }")
    // 下拉含 ollama 项（对齐后端 registry 已支持 + NO_API_KEY_PROVIDERS 白名单，key 留空）
    expect(source).toContain("{ value: 'ollama', label: 'ollama' }")
    // key 可留空提示（opencode 本地认证）
    expect(source).toContain('OpenCode 本地认证可留空')
  })

  it('加载/错误/空状态三态渲染', () => {
    expect(source).toContain('store.waitingForServer')
    expect(source).toContain('store.loading')
    expect(source).toContain('store.dataError')
    expect(source).toContain('还没有 Agent')
  })
})

describe('SettingsView 系统配置（context 阈值——单 A 契约 GET/POST /api/config/context）', () => {
  it('默认值 0.8/0.9 + 窗口上限只读回显', () => {
    expect(source).toContain('const warnThreshold = ref(0.8)')
    expect(source).toContain('const handoffThreshold = ref(0.9)')
    expect(source).toContain('const maxContextTokens = ref(128000)')
    expect(source).toContain('ctxMaxDisplay()')
  })

  it('C8 收敛：表单草稿从 store.contextConfig 初始化（store 未就绪经 store.fetchContextConfig 拉取）', () => {
    // C8 病根修复：SettingsView 不再直接 api.getContextConfig——store 是唯一拉取源，
    // store.contextConfig 即 ChatPanel 横幅 live 读的那份（保存后同源同步，横幅即刷）。
    expect(source).toContain('initCtxConfig')
    expect(source).toContain('!store.dataReady')
    expect(source).toContain('await store.fetchContextConfig()')
    expect(source).toContain('store.contextConfig.warnThreshold')
    expect(source).not.toContain('api.getContextConfig()')
    expect(source).not.toContain('loadContextConfig()')
    expect(source).not.toContain('ctxDisabled')
  })

  it('保存 → 经 store.saveContextConfig POST 全量带两阈值；校验 0<t<1 且 warn≤handoff（不通过不发请求）', () => {
    // C8：保存经 store 单点（POST → 写回 store.contextConfig → 返回更新值回写表单草稿）
    expect(source).toContain('await store.saveContextConfig({')
    expect(source).toContain('warnThreshold: warnThreshold.value')
    expect(source).toContain('handoffThreshold: handoffThreshold.value')
    expect(source).toMatch(/warnThreshold\.value > 0 && warnThreshold\.value < 1/)
    expect(source).toMatch(/handoffThreshold\.value > 0 && handoffThreshold\.value < 1/)
    expect(source).toContain('告警阈值不能高于交接阈值')
  })

  it('保存成功 → 响应回写最新全量 + 提示（新阈值立即生效）', () => {
    expect(source).toContain('res.maxContextTokens')
    expect(source).toContain('ctxSaved')
    expect(source).toContain('已保存——新阈值立即生效')
  })
})

describe('SettingsView 系统配置（摘要配置——单 A 契约 GET/POST /api/config/summary）', () => {
  it('摘要模型/API Key 渲染：默认模型 + 掩码占位符（key 不出 server）', () => {
    expect(source).toContain("const summaryModel = ref('deepseek-v4-flash')")
    expect(source).toContain('summaryApiKeyMasked')
    expect(source).toContain('summaryKeyPlaceholder')
    expect(source).toContain('未配置（默认复用 DS_KEY')
    expect(source).toContain('当前：')
    expect(source).toContain('type="password"')
    expect(source).toContain('摘要模型')
    expect(source).toContain('摘要 API Key')
  })

  it('GET 失败 → 默认值 + 禁用态提示，不白屏（API 未就绪兜底）', () => {
    expect(source).toContain('api.getSummaryConfig()')
    expect(source).toMatch(/sumError[\s\S]*已使用默认值（deepseek-v4-flash）/)
    expect(source).toContain('sumDisabled.value = true')
    expect(source).toContain(':disabled="sumDisabled || sumSaving"')
  })

  it('保存 → POST：模型必填校验；key 留空不传字段（保持现状），填写新值才覆盖', () => {
    expect(source).toContain('await api.saveSummaryConfig(payload)')
    expect(source).toContain('const payload: { summaryModel?: string; summaryApiKey?: string }')
    expect(source).toContain('if (summaryApiKey.value.trim()) {')
    expect(source).toContain('payload.summaryApiKey = summaryApiKey.value.trim()')
    expect(source).toContain('摘要模型不能为空')
  })

  it('保存成功 → 提示重启后生效（needsRestart 语义）；回写掩码并清空输入框', () => {
    expect(source).toContain('已保存——重启后生效')
    expect(source).toContain('summaryHasKey.value = res.hasKey')
    expect(source).toContain('summaryMasked.value = res.summaryApiKeyMasked')
    expect(source).toContain("summaryApiKey.value = ''")
  })

  it('表单行对齐：.frow 定宽网格（148px 右对齐 label + 1fr 控件列）', () => {
    // T3（票面 §二）**推翻了本文件旧 pin**：原 `.config-item` 的 justify-content:center
    // 是用户报的「有些框都没对齐」的根因——label 宽度随文案长短变化、整行又居中，
    // 于是每行控件的左缘各不相同。新规格 = label 定宽 148px 右对齐，所有控件从同一条
    // 垂直线起跑（验收 2「控件左缘 x 全等」的判据来源）。
    // 旧 pin 的另一半意图（不做两端撑满）继续保留为负向断言。
    const frowBlock = source.match(/\.frow\s*\{[\s\S]*?\}/)
    expect(frowBlock).toBeTruthy()
    expect(frowBlock![0]).toContain('display: grid')
    expect(frowBlock![0]).toContain('grid-template-columns: 148px 1fr')
    expect(frowBlock![0]).not.toContain('space-between')
    // 居中的 flex 布局不得回潮到表单行（另有两处 justify-content:center 属其他组件，
    // 故只钉 .frow 块内）
    expect(frowBlock![0]).not.toContain('justify-content: center')
  })
})

describe('SettingsView 系统配置（铁律可编辑——GET/POST /api/iron-laws）', () => {
  it('铁律卡片：开发铁律 / 审查铁律两个 textarea + 保存按钮 + 挂载即拉取', () => {
    expect(source).toContain('api.getIronLaws()')
    expect(source).toContain('loadIronLaws()')
    expect(source).toContain('ironLawsLoading')
    expect(source).toContain('ironLawsError')
    expect(source).toContain('开发铁律')
    expect(source).toContain('审查铁律')
    expect(source).toContain('v-model="ironLawsCoder"')
    expect(source).toContain('v-model="ironLawsReviewer"')
    expect(source).toContain('ironLawsSaving')
    expect(source).toContain('保存铁律')
  })

  it('可编辑可保存：POST 全量带 trim 后内容，保存中禁用，成功提示「下一轮回复即生效」', () => {
    expect(source).toContain('api.putIronLaws({')
    expect(source).toContain('coder: ironLawsCoder.value.trim()')
    expect(source).toContain('reviewer: ironLawsReviewer.value.trim()')
    expect(source).toContain(':disabled="ironLawsSaving"')
    expect(source).toContain('已保存——下一轮回复即生效（无需重启）')
  })

  it('前端校验对齐后端契约（trim 非空）——不通过不发请求', () => {
    expect(source).toMatch(/!ironLawsCoder\.value\.trim\(\)/)
    expect(source).toMatch(/!ironLawsReviewer\.value\.trim\(\)/)
    expect(source).toContain('开发铁律不能为空')
    expect(source).toContain('审查铁律不能为空')
  })

  it('保存成功 → 响应回写最新全量 + 提示；失败显示错误', () => {
    expect(source).toContain('res.coder')
    expect(source).toContain('res.reviewer')
    expect(source).toContain("err.message || '保存失败'")
  })

  it('铁律全文容器：textarea 等宽字体 + 垂直可调整（不撑爆卡片）', () => {
    const taBlock = source.match(/\.iron-law-textarea\s*\{[\s\S]*?\}/)
    expect(taBlock).toBeTruthy()
    expect(taBlock![0]).toContain('resize: vertical')
    expect(taBlock![0]).toContain('font-family: var(--font-mono)')
  })
})

describe('SettingsView 系统配置区布局（三卡统一间距 + 每卡统一标题）', () => {
  // 病灶（用户反馈「观感割裂」）：三张 .ctx-card 无间距、后两张紧贴，且只有第一张有
  // .section-title——另外两张卡片看起来「挂」在上一张下面。修法为每卡包一层
  // .config-section（标题 + 卡片），间距由 .system-pane 的 flex gap 统一给。

  /** 系统配置区模板切片（pane 起点到 <style> 之间） */
  function systemPaneTemplate(): string {
    const start = source.indexOf('class="system-pane"')
    const end = source.indexOf('<style')
    expect(start, '未定位到 .system-pane 模板').toBeGreaterThan(-1)
    expect(end, '未定位到 <style> 起点').toBeGreaterThan(start)
    return source.slice(start, end)
  }

  /**
   * 取 CSS 规则（选择器文本 + 规则体），用 feature 在候选里二次筛选。
   * 同一选择器可能出现在多条规则中——`.system-pane` 既有 `.im-pane,` 并列的限宽规则，
   * 又有独立的 flex 布局规则，只按选择器取会命中错误的一条。
   */
  function cssRule(
    selector: string,
    feature: string
  ): { selectorText: string; body: string } | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`([^{}]*${escaped}[^{}]*)\\{([^{}]*)\\}`, 'g')
    const hit = [...source.matchAll(re)].find((m) => m[2].includes(feature))
    return hit ? { selectorText: hit[1], body: hit[2] } : null
  }

  it('三张卡片各包一层 config-section——标题与卡片一一对应，数量不匹配即布局回退', () => {
    const pane = systemPaneTemplate()
    // 三者必须同数：任一为 0 或数量不等，说明有卡片漏包 / 有标题游离在层外
    expect(pane.match(/class="config-section"/g)).toHaveLength(3)
    expect(pane.match(/class="ctx-card"/g)).toHaveLength(3)
    expect(pane.match(/class="section-title"/g)).toHaveLength(3)
  })

  it('每层的标题先于卡片且文本对应（上下文阈值配置 / 摘要配置 / 铁律）', () => {
    const chunks = systemPaneTemplate().split('class="config-section"').slice(1)
    expect(chunks).toHaveLength(3)
    const expectedTitles = ['上下文阈值配置', '摘要配置', '铁律']
    chunks.forEach((chunk, i) => {
      const titleIdx = chunk.indexOf('class="section-title"')
      const cardIdx = chunk.indexOf('class="ctx-card"')
      // 标题与卡片必须同层且标题在前——标题挂错层（游离在层外）正是原病灶
      expect(titleIdx, `第 ${i + 1} 层未见标题`).toBeGreaterThan(-1)
      expect(cardIdx, `第 ${i + 1} 层未见卡片`).toBeGreaterThan(-1)
      expect(titleIdx, `第 ${i + 1} 层标题未在卡片之前`).toBeLessThan(cardIdx)
      expect(chunk.slice(titleIdx, chunk.indexOf('</div>', titleIdx))).toContain(expectedTitles[i])
      // 每层恰一标题一卡片，不多不少
      expect(chunk.match(/class="section-title"/g)).toHaveLength(1)
      expect(chunk.match(/class="ctx-card"/g)).toHaveLength(1)
    })
  })

  it('三卡间距来自 .system-pane 的 flex gap 26px', () => {
    const paneLayout = cssRule('.system-pane', 'flex-direction')
    expect(paneLayout, '.system-pane 未见 flex 布局规则').not.toBeNull()
    expect(paneLayout!.body).toContain('display: flex')
    expect(paneLayout!.body).toContain('flex-direction: column')
    expect(paneLayout!.body).toContain('gap: 26px')
  })

  it('flex 布局只作用于 .system-pane，未并入 pane 并列选择器（IM 接入区布局不受影响）', () => {
    const paneLayout = cssRule('.system-pane', 'flex-direction')
    expect(paneLayout).not.toBeNull()
    expect(paneLayout!.selectorText).not.toContain('.im-pane')
    // T3：限宽规则从 680px 提到 720px（票面 §二「右侧 720px 卡片列」），且并列面从
    // 两个 pane 扩到三个——.agent-panel 也要同宽同左缘，否则它的表单行从另一个 x 起跑
    // （验收 2 是全页判据，不是单 pane 判据）。flex 属性仍不在这条并列规则里。
    const shared = source.match(/(\.im-pane\s*,[^{}]*)\{([^{}]*)\}/)
    expect(shared, '未找到 pane 并列的限宽规则').not.toBeNull()
    expect(shared![1], '并列面应含 .agent-panel').toContain('.agent-panel')
    expect(shared![2]).toContain('max-width: 720px')
    expect(shared![2]).not.toContain('flex-direction')
  })

  it('标题间距归零限定在 .config-section 内——裸 .section-title 覆盖会波及 IM 接入区三个标题', () => {
    const scoped = cssRule('.config-section .section-title', 'margin-bottom: 0')
    expect(scoped, '未见 .config-section .section-title 规则').not.toBeNull()
    // 基础 .section-title 仍是 0 0 10px（IM 接入区「入站状态 / QQ 绑定 / 添加绑定」依赖它）
    const base = cssRule('.section-title', 'margin: 0 0 10px')
    expect(base, '基础 .section-title 规则被改动').not.toBeNull()
    expect(base!.selectorText.trim()).toBe('.section-title')
    expect(base!.body).not.toContain('margin-bottom: 0')
    // 多个标题相邻时的分隔规则保留（IM 接入区内同层多标题靠它撑开）
    expect(source).toContain('.section-title + .section-title')
  })

  it('OQ-2 证伪：既有 pin 与 IM 接入区锚点均在场', () => {
    // 改为 section 包裹后，QQ 接入区三个标题 + 入站卡仍在
    expect(systemPaneTemplate()).not.toContain('inbound-card')
    expect(source).toContain('inbound-card')
    expect(source).toContain('QQ 绑定')
    expect(source).toContain('添加绑定')
    // 既有 pin（另有两个 describe 各自独立断言）：块级行的顶部对齐变体 + textarea 可调整。
    // T3 起 `.config-item` 的居中 pin 已由 `对齐` 规格取代（见上一条 it），此处改钉新形态。
    const frowTop = cssRule('.frow-top', 'align-items: start')
    expect(frowTop, '.frow-top 顶部对齐变体缺失').not.toBeNull()
    const textarea = cssRule('.iron-law-textarea', 'resize: vertical')
    expect(textarea, '.iron-law-textarea pin 被破坏').not.toBeNull()
    expect(textarea!.body).toContain('font-family: var(--font-mono)')
  })
})

describe('SettingsView T3 设置页对齐改版（票面 §二 规格）', () => {
  // 票面：docs/run/ui-redesign/T3-settings-alignment.md
  // 用户原话病灶两条：「有些框都没对齐」「莫名的换行文字」——下面每条都钉住
  // 一个防复发点，摘掉任一条，对应症状就会回来。

  it('左侧导航图标列：线框 SVG 图标（不再是 emoji），宽度单源在 SubNav', () => {
    // T5 改锚：`188px` 那条规则随导航迁进 components/SubNav.vue（票面 §二A 收窄到 148px），
    // 宽度断言改在 SubNav.test.ts 钉。本用例保留 T3 的防复发意图——导航图标是线框 SVG，不是 emoji。
    expect(source).toContain('class="nav-icon"')
    expect(source).not.toContain('<span class="nav-icon">')
    // 图标经 SubNav 的具名 slot 传入（不是把 SVG 塞进 props 字符串——那得走 v-html）
    expect(source).toContain('<template #icon="{ item }">')
    // 图标尺寸 14px（票面 §二A）写在 svg 自身属性上
    expect(source).toContain('width="14"')
  })

  it('T5 贴左：.settings-layout 不再居中（宽屏左空白的根因）', () => {
    // 病灶：`margin: 0 auto` 让整页（导航 + 内容）在轨道右侧居中 ⇒ 轨道与导航之间
    // 随视口变宽空出数百 px。贴左后导航锚定 52px 轨道。
    const layout = source.match(/\.settings-layout\s*\{[\s\S]*?\}/)
    expect(layout, '未找到 .settings-layout 规则').toBeTruthy()
    expect(layout![0]).not.toContain('margin: 0 auto')
    expect(layout![0]).toContain('margin: 0;')
  })

  it('T6 摘帽：.settings-layout 不得再有限宽（内容居中的参照系 = 轨道右侧整个剩余区）', () => {
    // 病灶：整页宽度帽把「导航 148 + 内容区」钉死在轨道右侧的固定宽度内 ⇒ 720 卡片列
    // 只在帽内居中，1920 屏下视觉重心偏左数百 px、右侧留大片空白。摘帽后卡片列的
    // `margin: 0 auto` 直接在「轨道右缘 → 视口右缘」里居中，不需要新居中机制。
    // 本断言同时是**防回退否定断言**：把宽度帽加回来即红。
    const layout = source.match(/\.settings-layout\s*\{[\s\S]*?\}/)
    expect(layout, '未找到 .settings-layout 规则').toBeTruthy()
    expect(layout![0], '整页宽度帽不得回潮').not.toContain('max-width')
    // 贴左裁决（T5）不因摘帽回退：仍是 `margin: 0`，不是 `margin: 0 auto`
    expect(layout![0]).toContain('margin: 0;')
    // 承载 720 卡片列的元素仍是唯一居中容器（三个 pane 同一条规则）
    const col = source.match(/\.im-pane,\s*\.system-pane,\s*\.agent-panel\s*\{[\s\S]*?\}/)
    expect(col, '未找到卡片列限宽规则').toBeTruthy()
    expect(col![0]).toContain('margin: 0 auto')
  })

  it('T6 父标题：设置页给 SubNav 传 title="设置"（评估页不传，见 SubNav.test.ts）', () => {
    // 设置页三个大类是平级结构、无分组语义，故取单父标题作视觉锚（票面 OQ-1）。
    // 断言钉在「本视图传了这个 prop」上——渲染三态归 SubNav.test.ts。
    expect(source).toContain('title="设置"')
    const subnav = source.match(/<SubNav[\s\S]*?>/)
    expect(subnav, '未找到 SubNav 标签').toBeTruthy()
    expect(subnav![0]).toContain('title="设置"')
  })

  it('控件统一 34px 高 + border-box：治「莫名换行」的溢出根因', () => {
    // content-box 下 .input 的 width:100% 会叠加 padding+border 溢出 flex 容器，
    // 把同行后续元素挤到下一行——这是「莫名的换行文字」的机制，不是文案问题。
    const input = source.match(/\.input\s*\{[\s\S]*?\}/)
    expect(input, '未找到 .input 规则').toBeTruthy()
    expect(input![0]).toContain('height: 34px')
    expect(input![0]).toContain('box-sizing: border-box')
    // 多行控件不吃定高，否则 textarea 被压成一行
    expect(source).toContain('textarea.input')
    // 同一控件规格在本文件被复述了三遍（.input / .path-input / create-body .input），
    // 只改其中一处 = 换行与高矮不齐换个地方复发
    const pathInput = source.match(/\.path-input\s*\{[\s\S]*?\}/)
    expect(pathInput![0], '.path-input 未同口径').toContain('height: 34px')
    const createInput = source.match(/\.agent-panel \.create-body \.input\s*\{[\s\S]*?\}/)
    expect(createInput![0], 'create-body .input 未同口径').toContain('height: 34px')
  })

  it('focus 态 = border-focus 边框 + 3px accent-glow 光晕', () => {
    const focus = source.match(/\.input:focus\s*\{[\s\S]*?\}/)
    expect(focus).toBeTruthy()
    expect(focus![0]).toContain('border-color: var(--border-focus)')
    expect(focus![0]).toContain('box-shadow: 0 0 0 3px var(--accent-glow)')
  })

  it('.ctl 弹性容器 nowrap：控件与提示文字永远同行（不折到下一行）', () => {
    const ctl = source.match(/\.frow \.ctl\s*\{[\s\S]*?\}/)
    expect(ctl, '未找到 .frow .ctl 规则').toBeTruthy()
    expect(ctl![0]).toContain('display: flex')
    expect(ctl![0]).toContain('flex-wrap: nowrap')
    expect(source).toContain('class="ctl"')
    // 长文案不能塞进 nowrap 的 .hint（会溢出卡片），走可折行的 .hint-wrap
    const hintWrap = source.match(/\.frow \.hint-wrap\s*\{[\s\S]*?\}/)
    expect(hintWrap, '未找到 .hint-wrap 规则').toBeTruthy()
    expect(hintWrap![0]).toContain('white-space: normal')
  })

  it('只读项走 kv 行（右对齐键 + mono 值 + 来源徽章），不与可编辑表单混排', () => {
    const kv = source.match(/\.kv\s*\{[\s\S]*?\}/)
    expect(kv, '未找到 .kv 规则').toBeTruthy()
    expect(kv![0]).toContain('grid-template-columns: 148px 1fr auto')
    expect(source).toContain('class="kv"')
    expect(source).toContain('class="src"')
  })

  it('每张配置卡带「什么时候生效」副标题（三卡各一条）', () => {
    expect(source.match(/class="card-sub"/g)).toHaveLength(3)
    expect(source).toContain('保存后立即生效，重启后仍保持。')
    expect(source).toContain('保存后需重启 server 才生效（写 .env）。')
    expect(source).toContain('保存后下一轮回复即生效，无需重启。')
  })

  it('验收 2 的结构前提：卡片内缩量统一 + 滚动条槽常驻', () => {
    // 前提一：表单行都得在卡片容器里——卡片自带 border 1px + padding 16px（=17px 内缩）。
    // 裸放在 pane 上的行会少这 17px，左缘就与卡片内的行对不齐（实测 536 vs 553）。
    const card = source.match(/\.ctx-card,\s*\.form-card\s*\{[\s\S]*?\}/)
    expect(card, '.form-card 未与 .ctx-card 同规格').toBeTruthy()
    expect(card![0]).toContain('padding: 14px 16px')
    expect(card![0]).toContain('border: 1px solid var(--border-subtle)')
    // 前提二：滚动条槽常驻——三个 pane 内容长短不一，滚动条时有时无会让限宽内容区的
    // 可用宽度跳变，居中后左缘随之漂移（实测约 5px）
    expect(source).toContain('scrollbar-gutter: stable')
    // 「添加绑定」与 autoStart 两组表单行已包进卡片
    expect(source.match(/class="form-card"/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('色板零新增：引用的 CSS 变量都在 index.html 有定义', () => {
    // 原型 v6 用 --text-faint，本仓 index.html 没有这个变量——引用它不报错、不告警，
    // 只静默失效（颜色回落继承值）。照抄原型最易踩的暗坑，故做通用守卫。
    const defined = new Set([...designTokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    const missing = [...used].filter((v) => !defined.has(v))
    expect(missing, `引用了 index.html 未定义的 CSS 变量：${missing.join(', ')}`).toEqual([])
  })
})

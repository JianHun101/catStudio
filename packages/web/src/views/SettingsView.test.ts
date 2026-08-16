import { describe, it, expect } from 'vitest'
import source from './SettingsView.vue?raw'

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
  it('全屏设置中心：fixed inset 0 + 关闭按钮 → emit close', () => {
    expect(source).toContain('settings-view')
    expect(source).toContain('position: fixed')
    expect(source).toContain('inset: 0')
    expect(source).toContain('@click="emit(\'close\')"')
  })

  it('左侧大类导航：三大类文案 + 选中态高亮 + 点击切换', () => {
    expect(source).toContain("const activeCategory = ref<'cats' | 'im' | 'system'>('im')")
    expect(source).toContain('settings-nav')
    expect(source).toContain('猫咪管理')
    expect(source).toContain('IM 接入')
    expect(source).toContain('系统配置')
    expect(source).toContain(':class="{ active: activeCategory === \'cats\' }"')
    expect(source).toContain(':class="{ active: activeCategory === \'im\' }"')
    expect(source).toContain(':class="{ active: activeCategory === \'system\' }"')
    expect(source).toContain("activeCategory = 'cats'")
    expect(source).toContain("activeCategory = 'im'")
    expect(source).toContain("activeCategory = 'system'")
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
    expect(source).toContain('loadContextConfig()')
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
    // 下拉含 OpenCode 项（与 AgentEditModal 同款七项）
    expect(source).toContain("{ value: 'opencode', label: 'OpenCode (CLI)' }")
    // 下拉含 dsh 项（对齐后端 registry 已支持，前端枚举补同步）
    expect(source).toContain("{ value: 'dsh', label: 'DeepSeek Harness (CLI)' }")
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

  it('GET 失败 → 默认值 + 禁用态提示，不白屏（API 未就绪兜底）', () => {
    expect(source).toContain('api.getContextConfig()')
    expect(source).toMatch(/ctxError[\s\S]*已使用默认值（告警 80% \/ 交接 90%）/)
    expect(source).toContain('ctxDisabled.value = true')
    expect(source).toContain(':disabled="ctxDisabled || ctxSaving"')
  })

  it('保存 → POST 全量带两阈值；校验 0<t<1 且 warn≤handoff（不通过不发请求）', () => {
    expect(source).toContain('await api.saveContextConfig({')
    expect(source).toContain('warnThreshold: warnThreshold.value')
    expect(source).toContain('handoffThreshold: handoffThreshold.value')
    expect(source).toMatch(/warnThreshold\.value > 0 && warnThreshold\.value < 1/)
    expect(source).toMatch(/handoffThreshold\.value > 0 && handoffThreshold\.value < 1/)
    expect(source).toContain('告警阈值不能高于交接阈值')
  })

  it('保存成功 → 响应回写最新全量 + 提示', () => {
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

  it('config-item 居中显示：justify-content: center（QQ 接入与系统配置区同一 class 一处生效）', () => {
    // 用户需求：配置页详情居中显示，替代 space-between 两端撑满的割裂观感；
    // 块内负向断言——space-between 在 SettingsView 其他选择器仍存在（6 处），不能全文件断言
    const configItemBlock = source.match(/\.config-item\s*\{[\s\S]*?\}/)
    expect(configItemBlock).toBeTruthy()
    expect(configItemBlock![0]).toContain('justify-content: center')
    expect(configItemBlock![0]).not.toContain('space-between')
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

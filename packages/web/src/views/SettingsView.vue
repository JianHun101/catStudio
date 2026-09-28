<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { AgentConfig } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'
import {
  api,
  type ConnectorBinding,
  type NapcatBrowseEntry,
  type OneBotStatus,
} from '@/composables/useApi'
import AgentEditModal from '../components/AgentEditModal.vue'
import SubNav from '../components/SubNav.vue'
import { createLogger } from '@/utils/logger'

/**
 * 全屏设置中心（左侧栏底部齿轮进入，无 vue-router 的 App 级 view 切换）。
 * 左右分栏「经典结构」（参考图1：左侧大类导航 + 右侧详情）：
 *   - 猫咪管理：AgentPanel.vue 展开态内容复制迁入（B2 删除原组件后本区为唯一实现）
 *   - IM 接入：QQ 接入 / NapCat 子 Tab（原双 tab 内容整体平移）
 *   - 系统配置：context 阈值（80% 告警 / 90% 交接，GET/POST /api/config/context）
 * 契约（店长钉死）：autoStart 缺省 true——旧配置无字段 = 自动拉起；开关初始态跟随
 * GET 响应，保存时 POST 全量带 { napcatPath, autoStart }。
 *
 * T4：页头（标题 + ✕）整体退役——轨道在全视图常驻后，「回聊天」由轨道 💬 承担，
 * 本视图不再有 `close` emit，也不再是模态（`role="dialog"`/`aria-modal` 已摘）。
 */
const log = createLogger('SettingsView')
const store = useChatStore()

// ─── 左右分栏：左侧大类 + 右侧详情 ─────────────────
// 默认大类 = IM 接入（子 Tab QQ 接入）——打开设置页显示 QQ 接入，与迁移前行为一致
const activeCategory = ref<'cats' | 'im' | 'system'>('im')

/**
 * T5：三个大类搬进 SubNav 的 items——文案/顺序的**唯一表述点**。
 * 图标不进这里：它们是多元素 SVG（circle + path），走 SubNav 的 `#icon` slot
 * （传字符串就得 v-html，是新的注入面）。
 */
const settingsNavItems = [
  { key: 'cats', label: '猫咪管理' },
  { key: 'im', label: 'IM 接入' },
  { key: 'system', label: '系统配置' },
]

// ─── IM 接入子 tab：QQ 接入 / NapCat ─────────────────
const activeTab = ref<'qq' | 'napcat'>('qq')

// ─── OneBot 入站状态（QQ Tab 只读展示 + NapCat Tab 生命周期卡共用一份）─────
const status = ref<OneBotStatus | null>(null)
const loading = ref(true)
const error = ref('')
/** 组件卸载（设置页关闭）后停止轮询——防写已卸载组件的 ref */
let disposed = false

// ─── 绑定列表 ─────────────────────────────
const bindings = ref<ConnectorBinding[]>([])
const listLoading = ref(false)
const listError = ref('')
/** 删除两步确认：存 binding.id（uuid PK 行级唯一——external_id 在 (platform, external_type, external_id) 复合键下可共存，作行键会让同号双行共享确认态） */
const confirmDeleteId = ref<string | null>(null)

// ─── 添加表单 ─────────────────────────────
const platform = ref('qq')
const externalType = ref<'group' | 'private'>('group')
const externalId = ref('')
const sessionId = ref('')
const saving = ref(false)
const formError = ref('')

const platformOptions = [{ value: 'qq', label: 'QQ (OneBot)' }]
const typeOptions = [
  { value: 'group', label: '群聊' },
  { value: 'private', label: '私聊' },
]

/** 会话标题 join（store.sessions 即 GET /api/sessions 的结果，同源数据零额外请求）；查不到显示原始 id */
function sessionTitle(id: string): string {
  return store.sessions.find((s) => s.id === id)?.title || id
}

function typeLabel(type: string): string {
  return type === 'group' ? '群聊' : '私聊'
}

async function loadBindings(): Promise<void> {
  listLoading.value = true
  listError.value = ''
  try {
    const res = await api.getConnectorBindings()
    bindings.value = res.bindings
  } catch (err: any) {
    listError.value = err.message || '加载绑定列表失败'
  } finally {
    listLoading.value = false
  }
}

/** 表单校验对齐后端契约（externalId 纯数字、会话必选）——不通过不发请求 */
function validateForm(): boolean {
  if (!/^\d+$/.test(externalId.value.trim())) {
    formError.value = 'QQ 号/群号必须是纯数字'
    return false
  }
  if (!sessionId.value) {
    formError.value = '请选择要绑定的会话'
    return false
  }
  return true
}

async function handleAdd(): Promise<void> {
  formError.value = ''
  if (!validateForm()) return
  saving.value = true
  try {
    await api.createConnectorBinding({
      platform: platform.value,
      externalType: externalType.value,
      externalId: externalId.value.trim(),
      sessionId: sessionId.value,
    })
    externalId.value = ''
    await loadBindings() // POST 成功后刷新列表
  } catch (err: any) {
    // 后端 400（契约校验）/ 404（会话不存在）错误同样显示
    formError.value = err.message || '添加失败'
  } finally {
    saving.value = false
  }
}

/** 删除两步确认：第一次点变红，第二次执行（AgentEditModal 同款范式） */
async function handleDelete(binding: ConnectorBinding): Promise<void> {
  if (confirmDeleteId.value !== binding.id) {
    confirmDeleteId.value = binding.id
    return
  }
  formError.value = ''
  try {
    await api.deleteConnectorBinding({
      platform: binding.platform,
      externalType: binding.external_type,
      externalId: binding.external_id,
    })
    confirmDeleteId.value = null
    await loadBindings() // DELETE 成功后刷新列表
  } catch (err: any) {
    formError.value = err.message || '删除失败'
  }
}

// ─── NapCat 生命周期（ConnectorNapCatPanel 迁入）──────────────
// 职责边界：NapCat 是独立程序，server 永不 spawn——本页只做两件事：
// ①GET /api/connectors/onebot/status 只读渲染（env 值 + 端口可达性探测）；
// ②启停按钮 → POST control 写 .napcat-request → dev.js 轮询执行。
// TOKEN 只展示服务端脱敏掩码，完整 token 不出 server。
const acting = ref(false)
const actionError = ref('')

// ─── 启动路径配置（.napcat-config.json）─────────────────
// 浏览器 file input 拿不到本地绝对路径（安全沙箱，只能拿 C:\fakepath\…），故页面是
// 路径输入框 + server stat 存在性校验，不是文件选择器。保存后 dev.js 拉起时动态读，
// 无需重启任何进程即生效。
const napcatPath = ref('')
const savingPath = ref(false)
const pathError = ref('')
const pathSaved = ref('')
/** 路径浏览选择器（内联弹窗）——浏览器拿不到本地路径，选择器走 server 只读导航 */
const pickerOpen = ref(false)

// ─── autoStart 开关（缺省 true：服务端 GET 决定，undefined 视为 true）─────
const autoStart = ref(true)

async function loadConfig(): Promise<void> {
  try {
    const cfg = await api.getNapcatConfig()
    if (disposed) return
    napcatPath.value = cfg.napcatPath || ''
    // 旧配置无 autoStart 字段 → 服务端缺省 true；前端 undefined 兜底同样按 true
    autoStart.value = cfg.autoStart !== false
  } catch {
    // 配置读取失败不阻塞面板主体渲染（状态卡/启停照常）——输入框留空即可
  }
}

async function savePath(): Promise<void> {
  pathError.value = ''
  pathSaved.value = ''
  savingPath.value = true
  try {
    const res = await api.saveNapcatConfig({
      napcatPath: napcatPath.value,
      autoStart: autoStart.value, // 全量带开关——路径保存不覆盖 autoStart 状态
    })
    napcatPath.value = res.napcatPath
    pathSaved.value = '已保存，点「启动 NapCat」立即生效'
    await refresh() // 路径就绪可能翻转 launchReady → 刷新启停按钮态
  } catch (err: any) {
    pathError.value = err.message || '保存失败'
  } finally {
    if (!disposed) savingPath.value = false
  }
}

/** 开关变化立即保存（全量带路径 + autoStart，无独立保存按钮） */
async function saveAutoStart(): Promise<void> {
  pathError.value = ''
  pathSaved.value = ''
  savingPath.value = true
  try {
    await api.saveNapcatConfig({
      napcatPath: napcatPath.value,
      autoStart: autoStart.value,
    })
    pathSaved.value = autoStart.value
      ? '已开启——下次 dev 启动将自动拉起 NapCat'
      : '已关闭——下次 dev 启动不再自动拉起 NapCat'
  } catch (err: any) {
    pathError.value = err.message || '保存失败'
    // 保存失败回滚开关到服务端状态，避免本地显示与配置脱节
    autoStart.value = !autoStart.value
  } finally {
    if (!disposed) savingPath.value = false
  }
}

async function refresh(): Promise<void> {
  try {
    status.value = await api.getOneBotStatus()
    error.value = ''
  } catch (err: any) {
    error.value = err.message || '状态查询失败'
  } finally {
    loading.value = false
  }
}

/** 启停后轮询等待状态翻转（3s × 最多 10 次，接口契约：最多等 30s） */
async function waitForRunning(target: boolean): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    if (disposed) return false
    try {
      const st = await api.getOneBotStatus()
      status.value = st
      if (st.running === target) return true
    } catch {
      // 网络抖动继续轮询
    }
  }
  return false
}

async function handleAction(action: 'start' | 'stop'): Promise<void> {
  actionError.value = ''
  acting.value = true
  try {
    await api.napcatControl(action)
    const ok = await waitForRunning(action === 'start')
    await refresh()
    if (!ok && !disposed) {
      actionError.value =
        action === 'start'
          ? '启动超时——请检查 .env 的 NAPCAT_LAUNCH_CMD 是否正确，或 NapCat 是否自行退出'
          : '停止超时——NapCat 未在预期时间内停止，请检查其进程'
    }
  } catch (err: any) {
    actionError.value = err.message || '操作失败'
  } finally {
    if (!disposed) acting.value = false
  }
}

// ─── 路径浏览选择器（NapcatPathPicker 内联迁入）──────────────
// 浏览器 file input 拿不到本地绝对路径（安全沙箱，只能拿 C:\fakepath\…）→ 选择器走
// server 只读目录导航（GET /api/connectors/napcat/browse，零 spawn）：盘符列表 →
// 目录逐层（双击进入 / 上级返回）→ 点选文件高亮 → 确定回填。选中任意文件均可回填
// （.exe/.bat/.cmd 带「可执行」标记便于识别），路径合法性校验在保存时由 server stat 兜底。
/** 当前浏览目录——null = 盘符列表层 */
const currentDir = ref<string | null>(null)
/** 上级目录（盘符根为 null）——「↑ 上级」按钮目标 */
const parentDir = ref<string | null>(null)
const entries = ref<NapcatBrowseEntry[]>([])
const selected = ref('')
const browseLoading = ref(true)
const browseError = ref('')

async function load(dir: string | null): Promise<void> {
  browseLoading.value = true
  browseError.value = ''
  try {
    const res = await api.browseNapcatDir(dir ?? undefined)
    currentDir.value = res.dir
    parentDir.value = res.parent
    entries.value = res.entries
    selected.value = ''
  } catch (err: any) {
    browseError.value = err.message || '目录读取失败'
  } finally {
    browseLoading.value = false
  }
}

/** 打开选择器（每次打开回到盘符列表层重新加载，避免旧导航残留） */
function openPicker(): void {
  pickerOpen.value = true
  load(null)
}

function closePicker(): void {
  pickerOpen.value = false
}

function openEntry(entry: NapcatBrowseEntry): void {
  if (entry.type !== 'dir') return
  load(currentDir.value ? joinPath(currentDir.value, entry.name) : entry.name)
}

/** 上级返回——盘符根（parent=null）时回到盘符列表层 */
function goUp(): void {
  load(parentDir.value)
}

function selectFile(entry: NapcatBrowseEntry): void {
  if (entry.type !== 'file') return
  selected.value = entry.name
}

/** 拼接完整路径（盘符列表层 entry.name 本身就是完整路径） */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('\\') ? dir + name : dir + '\\' + name
}

/** 确定回填（原 emit('select') 内联为直接写回路径输入框） */
function confirmPick(): void {
  if (!selected.value) return
  const full = currentDir.value ? joinPath(currentDir.value, selected.value) : selected.value
  napcatPath.value = full
  pathSaved.value = ''
  closePicker()
}

// ─── 猫咪管理（B2 改静态配置——会话动态信息已迁右侧边栏 SessionAgentsPanel）──
// 契约（店长钉死）：猫咪管理只显示 agent 静态运行配置（模型/provider/effort/maxTokens/
// 温度/apiKey 掩码/baseUrl/系统提示摘要）；token 用量条/调度队列/停止按钮迁出至
// 右侧边栏（B1 SessionAgentsPanel 承接），迁走不复制。
const editingAgent = ref<AgentConfig | null>(null)
const showCreate = ref(false)

/** 单 A 契约新增字段（shared AgentConfig 类型由单 A 扩展——B2 交叉类型先行消费，
 *  单 A 落地后类型自动对齐，无冲突） */
type StaticAgent = AgentConfig & { llmMaxTokens?: number; llmTemperature?: number }

/** 静态配置字段缺省与 DB 列默认一致（llm_max_tokens DEFAULT 2048 / llm_temperature DEFAULT 0.7） */
function staticMaxTokens(agent: AgentConfig): number {
  return (agent as StaticAgent).llmMaxTokens ?? 2048
}

function staticTemperature(agent: AgentConfig): number {
  return (agent as StaticAgent).llmTemperature ?? 0.7
}

/** apiKey 掩码展示（完整密钥不出页面；sk-***last4 格式） */
function maskApiKey(key: string): string {
  if (!key) return '未配置'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 3)}***${key.slice(-4)}`
}

/** 系统提示摘要（长文截断，评估一眼可读） */
function promptSummary(p: string): string {
  if (!p) return '未设置'
  return p.length > 60 ? `${p.slice(0, 60)}…` : p
}

function openCreate(): void {
  showCreate.value = true
}

function closeEdit(): void {
  editingAgent.value = null
  store.fetchData(true) // 编辑 Agent 后刷新列表（force：dataReady 已就绪，不 force 会静默失效）
}

const newAgentForm = ref({
  name: '',
  avatar: '🐱',
  systemPrompt: '',
  llmProvider: 'claude',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: '',
  llmBaseUrl: '',
})
/** 创建表单 provider 下拉（与 AgentEditModal.providerOptions 同款八项）——opencode/ollama 本地认证 key 可留空 */
const providerOptions = [
  { value: 'deepseek', label: 'DeepSeek (HTTP API)' },
  { value: 'claude', label: 'Claude Code (CLI)' },
  { value: 'opencode', label: 'OpenCode (CLI)' },
  { value: 'dsh', label: 'DeepSeek Harness (CLI)' },
  { value: 'ollama', label: 'ollama' },
  { value: 'openai', label: 'Codex (CLI)' },
  { value: 'pi', label: 'Pi (SDK)' },
  { value: 'custom', label: '自定义' },
]
const createError = ref('')
const creating = ref(false)

async function handleCreate(): Promise<void> {
  if (!newAgentForm.value.name.trim()) return
  creating.value = true
  createError.value = ''
  try {
    await api.createAgent({
      name: newAgentForm.value.name.trim(),
      avatar: newAgentForm.value.avatar,
      systemPrompt: newAgentForm.value.systemPrompt,
      llmProvider: newAgentForm.value.llmProvider,
      llmModel: newAgentForm.value.llmModel,
      llmApiKey: newAgentForm.value.llmApiKey,
      llmBaseUrl: newAgentForm.value.llmBaseUrl || undefined,
    })
    showCreate.value = false
    newAgentForm.value = {
      name: '',
      avatar: '🐱',
      systemPrompt: '',
      llmProvider: 'claude',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: '',
      llmBaseUrl: '',
    }
    await store.fetchData(true) // 创建 Agent 后刷新列表（force：dataReady 已就绪，不 force 会静默失效）
  } catch (err: any) {
    log.error('create agent failed', { error: String(err) })
    // 解析后端返回的友好错误信息，否则用通用中文提示
    let msg = err?.body?.message || err?.body?.error || err.message || ''
    if (msg.includes('UNIQUE constraint') || msg.includes('已存在')) {
      msg = '同名猫咪已存在，请换一个名字'
    } else if (msg.includes('API key') || msg.includes('apiKey')) {
      msg = 'API Key 无效或缺失，请检查后重试'
    } else if (!msg || msg.includes('Internal Server Error')) {
      msg = '服务器内部错误，请查看后端日志'
    }
    createError.value = msg || '创建失败'
  } finally {
    creating.value = false
  }
}

// ─── 系统配置：context 阈值（80% 告警 / 90% 交接）──────────────
// 契约（单 A 钉死）：GET /api/config/context 缺文件返回默认 {0.8, 0.9, maxContext}；
// POST 收 { warnThreshold?, handoffThreshold? }（未传 → 默认），校验 0<t<1 且 warn≤handoff
// 否则 400；maxContextTokens 从 env 读只读回显。C8 收敛：store.contextConfig 是唯一事实源
// （ChatPanel 横幅 live 读它）——表单草稿从 store 初始化、保存经 store 单点（POST 后写回 store，
// 横幅即刷）。失败回退默认值，不白屏。
const warnThreshold = ref(0.8)
const handoffThreshold = ref(0.9)
const maxContextTokens = ref(128000)
const ctxLoading = ref(true)
const ctxSaving = ref(false)
const ctxSaved = ref('')
const ctxFormError = ref('')

function ctxMaxDisplay(): string {
  return maxContextTokens.value > 0 ? `${(maxContextTokens.value / 1000).toFixed(0)}k tokens` : '—'
}

/** 表单草稿从 store.contextConfig 初始化——store 是 context 阈值唯一事实源（ChatPanel 横幅 live 读它）。
 *  store 未就绪（fetchData 未跑/失败）→ 经 store.fetchContextConfig 拉权威值；已就绪直接读 store，
 *  不重复 GET。编辑草稿态保留：本地 ref 不直接绑 store，保存成功才推 store（避免编辑到一半横幅乱跳）。 */
async function initCtxConfig(): Promise<void> {
  ctxLoading.value = true
  try {
    if (!store.dataReady) {
      await store.fetchContextConfig() // store 内部静默回退默认 0.8/0.9——失败不白屏
    }
    if (disposed) return
    warnThreshold.value = store.contextConfig.warnThreshold
    handoffThreshold.value = store.contextConfig.handoffThreshold
    maxContextTokens.value = store.contextConfig.maxContextTokens
  } finally {
    if (!disposed) ctxLoading.value = false
  }
}

/** 前端校验对齐后端契约（0<t<1、warn≤handoff）——不通过不发请求 */
function validateCtxForm(): boolean {
  if (!(warnThreshold.value > 0 && warnThreshold.value < 1)) {
    ctxFormError.value = '告警阈值必须是 0~1 之间的小数（如 0.8 = 80%）'
    return false
  }
  if (!(handoffThreshold.value > 0 && handoffThreshold.value < 1)) {
    ctxFormError.value = '交接阈值必须是 0~1 之间的小数（如 0.9 = 90%）'
    return false
  }
  if (warnThreshold.value > handoffThreshold.value) {
    ctxFormError.value = '告警阈值不能高于交接阈值'
    return false
  }
  return true
}

async function saveCtxConfig(): Promise<void> {
  ctxFormError.value = ''
  ctxSaved.value = ''
  if (!validateCtxForm()) return
  ctxSaving.value = true
  try {
    // 保存经 store 单点：POST → 写回 store.contextConfig（ChatPanel 横幅响应式刷新）→ 返回更新值回写表单草稿
    const res = await store.saveContextConfig({
      warnThreshold: warnThreshold.value,
      handoffThreshold: handoffThreshold.value,
    })
    warnThreshold.value = res.warnThreshold
    handoffThreshold.value = res.handoffThreshold
    maxContextTokens.value = res.maxContextTokens
    ctxSaved.value = '已保存——新阈值立即生效（告警横幅与交接触发线同步刷新）'
  } catch (err: any) {
    ctxFormError.value = err.message || '保存失败'
  } finally {
    ctxSaving.value = false
  }
}

// ─── 系统配置：摘要配置（SUMMARY_MODEL/SUMMARY_API_KEY——写 .env 行级 patch，重启生效）────────
// 契约（单 A 钉死）：GET /api/config/summary 返回 { summaryModel, summaryBaseUrl,
// summaryApiKeyMasked, hasKey, needsRestart:false }；POST 收 { summaryModel?, summaryApiKey? }
// （未传保持现状；空串=清空回退 DS_KEY）→ 返回 { ..., needsRestart:true }。
// key 只回显服务端掩码（sk***last4，完整 key 不出 server）；GET 失败 → 默认值 + 禁用态不崩。
const summaryModel = ref('deepseek-v4-flash')
const summaryApiKey = ref('')
const summaryBaseUrl = ref('')
const summaryHasKey = ref(false)
const summaryMasked = ref('')
const sumLoading = ref(true)
const sumError = ref('')
const sumDisabled = ref(false)
const sumSaving = ref(false)
const sumSaved = ref('')

/** key 输入框占位符：回显当前掩码/未配置提示（留空=保持现状，不传字段避免误清空） */
const summaryKeyPlaceholder = computed(() =>
  summaryHasKey.value
    ? `当前：${summaryMasked.value}（留空保持现状）`
    : '未配置（默认复用 DS_KEY，留空保持现状）'
)

async function loadSummaryConfig(): Promise<void> {
  sumLoading.value = true
  try {
    const cfg = await api.getSummaryConfig()
    if (disposed) return
    summaryModel.value = cfg.summaryModel
    summaryBaseUrl.value = cfg.summaryBaseUrl
    summaryHasKey.value = cfg.hasKey
    summaryMasked.value = cfg.summaryApiKeyMasked
  } catch {
    if (!disposed) {
      // API 未就绪（单 A 未落地/网络失败）→ 默认值 + 禁用态提示，不白屏
      sumError.value =
        '摘要配置读取失败——服务端接口未就绪，已使用默认值（deepseek-v4-flash），保存已禁用'
      sumDisabled.value = true
    }
  } finally {
    sumLoading.value = false
  }
}

async function saveSummaryConfig(): Promise<void> {
  sumError.value = ''
  sumSaved.value = ''
  const model = summaryModel.value.trim()
  if (!model) {
    sumError.value = '摘要模型不能为空'
    return
  }
  sumSaving.value = true
  try {
    // 密钥留空不传字段（保持现状）；填写新值才覆盖——避免误清空导致摘要不可用
    const payload: { summaryModel?: string; summaryApiKey?: string } = { summaryModel: model }
    if (summaryApiKey.value.trim()) {
      payload.summaryApiKey = summaryApiKey.value.trim()
    }
    const res = await api.saveSummaryConfig(payload)
    summaryModel.value = res.summaryModel
    summaryBaseUrl.value = res.summaryBaseUrl
    summaryHasKey.value = res.hasKey
    summaryMasked.value = res.summaryApiKeyMasked
    summaryApiKey.value = ''
    sumSaved.value = '已保存——重启后生效（.env 已写入，需重启 server 加载）'
  } catch (err: any) {
    sumError.value = err.message || '保存失败'
  } finally {
    sumSaving.value = false
  }
}

// ─── 系统配置：铁律编辑（开发铁律 + 审查铁律——GET/POST /api/iron-laws）────────────
// 契约（店长派活单）：铁律从「seed 期烘焙」升级为「运行期注入的全局策略」（settings 表
// 优先、seed-data.ts 常量兜底）；两个 <textarea> + 保存按钮，POST 校验在服务端
// （必填/非空/≤20000）；保存后下一轮回复即生效（无需重启）。GET 失败 → 提示 + 不崩。
const ironLaws = ref<{ coder: string; reviewer: string } | null>(null)
const ironLawsLoading = ref(true)
const ironLawsError = ref('')
const ironLawsCoder = ref('')
const ironLawsReviewer = ref('')
const ironLawsSaving = ref(false)
const ironLawsSaved = ref('')
const ironLawsFormError = ref('')

async function loadIronLaws(): Promise<void> {
  ironLawsLoading.value = true
  try {
    const res = await api.getIronLaws()
    if (disposed) return
    ironLaws.value = res
    ironLawsCoder.value = res.coder
    ironLawsReviewer.value = res.reviewer
  } catch (err: any) {
    if (!disposed) {
      ironLawsError.value = err.message || '铁律读取失败'
    }
  } finally {
    ironLawsLoading.value = false
  }
}

/** 前端校验对齐后端契约（trim 非空）——不通过不发请求 */
function validateIronLawsForm(): boolean {
  if (!ironLawsCoder.value.trim()) {
    ironLawsFormError.value = '开发铁律不能为空'
    return false
  }
  if (!ironLawsReviewer.value.trim()) {
    ironLawsFormError.value = '审查铁律不能为空'
    return false
  }
  return true
}

async function saveIronLaws(): Promise<void> {
  ironLawsFormError.value = ''
  ironLawsSaved.value = ''
  if (!validateIronLawsForm()) return
  ironLawsSaving.value = true
  try {
    const res = await api.putIronLaws({
      coder: ironLawsCoder.value.trim(),
      reviewer: ironLawsReviewer.value.trim(),
    })
    ironLawsCoder.value = res.coder
    ironLawsReviewer.value = res.reviewer
    ironLawsSaved.value = '已保存——下一轮回复即生效（无需重启）'
  } catch (err: any) {
    ironLawsFormError.value = err.message || '保存失败'
  } finally {
    ironLawsSaving.value = false
  }
}

onMounted(() => {
  // 设置页为常驻视图（v-show 切类保持挂载）——一次拉齐五份数据
  loadBindings()
  refresh()
  loadConfig()
  initCtxConfig()
  loadSummaryConfig()
  loadIronLaws()
})
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <div class="settings-view" aria-label="设置">
    <div class="settings-layout">
      <!-- 左侧大类导航（T5：SubNav 共享组件 148px；图标走 #icon slot 供线框 SVG） -->
      <SubNav v-model="activeCategory" :items="settingsNavItems" label="设置大类" title="设置">
        <template #icon="{ item }">
          <svg
            v-if="item.key === 'cats'"
            class="nav-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="9" cy="8" r="3" />
            <path
              d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3 3 0 0 1 0 7M21 20c0-2.8-1.9-5.1-4.5-5.8"
            />
          </svg>
          <svg
            v-else-if="item.key === 'im'"
            class="nav-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.7-1.7"
            />
          </svg>
          <svg
            v-else
            class="nav-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </template>
      </SubNav>

      <!-- 右侧详情区 -->
      <div class="settings-content">
        <!-- 猫咪管理：AgentPanel 展开态内容复制迁入 -->
        <div v-show="activeCategory === 'cats'" class="agent-panel">
          <div class="panel-header">
            <div class="header-left">
              <h3>猫咪 Agent</h3>
              <span class="header-count" v-if="store.agents.length">{{ store.agents.length }}</span>
            </div>
            <button class="btn-add" title="添加 Agent" @click="openCreate">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>

          <!-- Agent Cards（静态运行配置——会话动态信息已迁右侧边栏） -->
          <div class="agent-cards">
            <div
              v-for="agent in store.agents"
              :key="agent.id"
              class="agent-card"
              @click="editingAgent = agent"
            >
              <div class="card-top">
                <span class="agent-avatar">{{ agent.avatar }}</span>
                <div class="agent-info">
                  <span class="agent-name">{{ agent.name }}</span>
                  <div class="agent-meta">
                    <span class="provider-badge">{{ agent.llmProvider }}</span>
                    <span class="model-name">{{ agent.llmModel }}</span>
                  </div>
                </div>
              </div>

              <!-- 静态配置网格（运行参数——maxTokens/温度契约见单 A，缺省 2048/0.7） -->
              <div class="static-grid">
                <div class="static-item">
                  <span class="static-label">Effort</span>
                  <span class="static-value">{{ agent.effortLevel || '—' }}</span>
                </div>
                <div class="static-item">
                  <span class="static-label">Max Tokens</span>
                  <span class="static-value mono">{{ staticMaxTokens(agent) }}</span>
                </div>
                <div class="static-item">
                  <span class="static-label">温度</span>
                  <span class="static-value mono">{{ staticTemperature(agent) }}</span>
                </div>
                <div class="static-item">
                  <span class="static-label">API Key</span>
                  <span class="static-value mono">{{ maskApiKey(agent.llmApiKey) }}</span>
                </div>
                <div v-if="agent.llmBaseUrl" class="static-item static-item-wide">
                  <span class="static-label">Base URL</span>
                  <span class="static-value mono">{{ agent.llmBaseUrl }}</span>
                </div>
                <div class="static-item static-item-wide">
                  <span class="static-label">系统提示</span>
                  <span class="static-value">{{ promptSummary(agent.systemPrompt) }}</span>
                </div>
              </div>
            </div>

            <!-- 等待服务器启动 -->
            <div v-if="store.waitingForServer" class="agent-status">
              <span class="status-spinner"></span>
              <p>等待服务器…</p>
            </div>

            <!-- 数据加载中 -->
            <div v-else-if="store.loading" class="agent-status">
              <span class="status-spinner"></span>
              <p>加载中…</p>
            </div>

            <!-- 数据加载失败 -->
            <div v-else-if="store.dataError" class="agent-status agent-status-error">
              <span class="status-icon">⚠️</span>
              <p>数据加载失败</p>
              <p class="hint">{{ store.dataError }}</p>
              <button class="btn-retry-sm" @click="store.fetchData(true)">重试</button>
            </div>

            <!-- 空状态 -->
            <div v-else-if="store.agents.length === 0" class="agent-empty">
              <span class="empty-icon">🐈</span>
              <p>还没有 Agent</p>
              <p class="hint">点击右上角 + 创建第一只猫咪</p>
            </div>
          </div>

          <!-- Quick Create Form -->
          <div v-if="showCreate" class="create-section">
            <div class="create-header">
              <h4>新建 Agent</h4>
              <button class="btn-close-sm" @click="showCreate = false">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M3 3l8 8M11 3l-8 8"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="create-body">
              <div class="frow">
                <label class="label">名字</label>
                <div class="ctl">
                  <input v-model="newAgentForm.name" class="input" placeholder="猫咪名字" v-focus />
                </div>
              </div>
              <div class="frow">
                <label class="label">Provider</label>
                <div class="ctl">
                  <select v-model="newAgentForm.llmProvider" class="input">
                    <option v-for="p in providerOptions" :key="p.value" :value="p.value">
                      {{ p.label }}
                    </option>
                  </select>
                </div>
              </div>
              <div class="frow">
                <label class="label">模型</label>
                <div class="ctl">
                  <input
                    v-model="newAgentForm.llmModel"
                    class="input input-mono"
                    placeholder="模型（如 deepseek-v4-pro）"
                  />
                </div>
              </div>
              <div class="frow">
                <label class="label">API Key</label>
                <div class="ctl">
                  <input
                    v-model="newAgentForm.llmApiKey"
                    class="input input-mono"
                    type="password"
                    placeholder="API Key (sk-…，OpenCode 本地认证可留空)"
                  />
                </div>
              </div>
              <div class="frow frow-top">
                <label class="label">角色设定</label>
                <div class="ctl">
                  <textarea
                    v-model="newAgentForm.systemPrompt"
                    class="input"
                    rows="3"
                    placeholder="角色设定…"
                  ></textarea>
                </div>
              </div>
            </div>
            <div class="create-footer">
              <span v-if="createError" class="error-text">{{ createError }}</span>
              <button class="btn btn-cancel" @click="showCreate = false">取消</button>
              <button class="btn btn-confirm" :disabled="creating" @click="handleCreate">
                {{ creating ? '…' : '创建' }}
              </button>
            </div>
          </div>

          <!-- Edit Modal（与已删的 AgentPanel.vue 编辑弹窗同款挂载——editingAgent 状态必须有弹窗消费，
               否则卡片点击静默失效；测试锚定 SettingsView.test.ts 挂载断言） -->
          <AgentEditModal :agent="editingAgent" @close="closeEdit" />
        </div>

        <!-- IM 接入：QQ 接入 / NapCat 子 Tab（原双 tab 内容整体平移） -->
        <div v-show="activeCategory === 'im'" class="im-pane">
          <div class="settings-subtabs">
            <button
              class="tab-btn"
              :class="{ active: activeTab === 'qq' }"
              @click="activeTab = 'qq'"
            >
              QQ 接入
            </button>
            <button
              class="tab-btn"
              :class="{ active: activeTab === 'napcat' }"
              @click="activeTab = 'napcat'"
            >
              NapCat
            </button>
          </div>

          <!-- Tab1：QQ 接入（v-show 保持挂载，onMounted 行为零改动） -->
          <div v-show="activeTab === 'qq'">
            <div class="section-title">入站状态</div>
            <div class="inbound-card">
              <div class="kv">
                <span class="k">入站启用</span>
                <span class="v">{{ status?.enabled ? '是' : '否' }}</span>
                <span class="src">env</span>
              </div>
              <div class="kv">
                <span class="k">API 地址</span>
                <span class="v">{{ status?.apiBase || '—' }}</span>
                <span class="src">env</span>
              </div>
              <div class="kv">
                <span class="k">鉴权 Token</span>
                <span class="v">{{
                  status?.tokenConfigured ? status?.tokenMasked : '未配置'
                }}</span>
                <span class="src">env</span>
              </div>
            </div>

            <div class="section-title">QQ 绑定</div>
            <div v-if="listLoading" class="list-hint">加载中…</div>
            <div v-else-if="listError" class="error-msg">{{ listError }}</div>
            <div v-else-if="bindings.length === 0" class="list-hint">
              暂无绑定——添加后对应 QQ 群/私聊的消息才会接入 CatStudio
            </div>
            <div v-else class="binding-list">
              <div
                v-for="b in bindings"
                :key="`${b.platform}-${b.external_type}-${b.external_id}`"
                class="binding-row"
                :class="{ confirming: confirmDeleteId === b.id }"
              >
                <div class="binding-info">
                  <span class="binding-type">{{ typeLabel(b.external_type) }}</span>
                  <span class="binding-id">{{ b.external_id }}</span>
                  <span class="binding-session" :title="sessionTitle(b.session_id)">
                    {{ sessionTitle(b.session_id) }}
                  </span>
                </div>
                <button
                  class="btn-delete"
                  :class="{ 'btn-delete-confirm': confirmDeleteId === b.id }"
                  @click="handleDelete(b)"
                >
                  {{ confirmDeleteId === b.id ? '确认删除？' : '删除' }}
                </button>
              </div>
            </div>

            <div class="section-title">添加绑定</div>
            <div class="form-card">
              <div class="frow">
                <label class="label">平台</label>
                <div class="ctl">
                  <select v-model="platform" class="input">
                    <option v-for="p in platformOptions" :key="p.value" :value="p.value">
                      {{ p.label }}
                    </option>
                  </select>
                </div>
              </div>

              <div class="frow">
                <label class="label">类型</label>
                <div class="ctl">
                  <select v-model="externalType" class="input">
                    <option v-for="t in typeOptions" :key="t.value" :value="t.value">
                      {{ t.label }}
                    </option>
                  </select>
                </div>
              </div>

              <div class="frow">
                <label class="label">QQ 号/群号</label>
                <div class="ctl">
                  <input
                    v-model="externalId"
                    type="text"
                    inputmode="numeric"
                    class="input input-mono"
                    placeholder="纯数字"
                    v-focus
                    @keydown.enter="handleAdd"
                  />
                </div>
              </div>

              <div class="frow">
                <label class="label">绑定会话</label>
                <div class="ctl">
                  <select v-model="sessionId" class="input">
                    <option value="" disabled>选择会话…</option>
                    <option v-for="s in store.sessions" :key="s.id" :value="s.id">
                      {{ s.title }}
                    </option>
                  </select>
                </div>
              </div>

              <div v-if="formError" class="error-msg">{{ formError }}</div>

              <div class="form-actions">
                <button class="btn btn-create" :disabled="saving" @click="handleAdd">
                  {{ saving ? '添加中…' : '添加绑定' }}
                </button>
              </div>
            </div>
          </div>

          <!-- Tab2：NapCat（v-if 进入才挂载；设置页挂载时已统一拉取状态） -->
          <div v-if="activeTab === 'napcat'">
            <div class="status-card">
              <div class="status-line">
                <span class="badge" :class="status?.running ? 'badge-running' : 'badge-stopped'">
                  <span class="dot" />
                  {{ status?.running ? '运行中' : '已停止' }}
                </span>
                <span class="status-text">OneBot v11 HTTP 服务（NapCat）</span>
              </div>
              <div class="config-grid">
                <div class="kv">
                  <span class="k">API 地址</span>
                  <span class="v">{{ status?.apiBase || '—' }}</span>
                  <span class="src">env</span>
                </div>
                <div class="kv">
                  <span class="k">入站启用</span>
                  <span class="v">{{ status?.enabled ? '是' : '否' }}</span>
                  <span class="src">env</span>
                </div>
                <div class="kv">
                  <span class="k">鉴权 Token</span>
                  <span class="v">{{
                    status?.tokenConfigured ? status?.tokenMasked : '未配置'
                  }}</span>
                  <span class="src">env</span>
                </div>
              </div>
            </div>

            <!-- autoStart 开关：dev 启动时自动拉起 NapCat（缺省 true——旧配置无字段行为不变） -->
            <div class="form-card">
              <div class="frow frow-top">
                <span class="label">dev 启动时自动拉起</span>
                <div class="ctl ctl-top">
                  <label class="switch">
                    <input
                      type="checkbox"
                      v-model="autoStart"
                      :disabled="savingPath"
                      @change="saveAutoStart"
                    />
                    <span class="switch-slider"></span>
                  </label>
                  <span class="hint-wrap">
                    开启后 <code>pnpm dev</code> 会自动启动 NapCat；关闭后需手动点「启动 NapCat」。
                    旧配置无该字段 = 默认开启（可在设置页关闭）
                  </span>
                </div>
              </div>
            </div>

            <div v-if="loading" class="list-hint">加载中…</div>
            <div v-else-if="error" class="error-msg">{{ error }}</div>

            <div v-else-if="status && !status.launchCmdConfigured" class="launch-hint">
              未配置启动命令——请在 <code>.env</code> 中设置
              <code>NAPCAT_LAUNCH_CMD</code>（完整启动命令行，或含
              <code>{NAPCAT_PATH}</code> 占位符的模板）并重启 dev 服务，才能通过此面板启动 NapCat
            </div>

            <div
              v-else-if="status && status.launchCmdConfigured && !status.launchReady"
              class="launch-hint"
            >
              启动命令使用 <code>{NAPCAT_PATH}</code> 占位符——请在下方「NapCat 启动路径」填写本机
              NapCat 可执行文件完整路径并保存
            </div>

            <div class="path-card">
              <div class="frow">
                <span class="label">NapCat 启动路径</span>
                <div class="ctl">
                  <input
                    v-model="napcatPath"
                    class="path-input mono"
                    placeholder="C:\NapCat\napcat.exe"
                    :disabled="savingPath"
                    spellcheck="false"
                  />
                  <button class="btn-save" :disabled="savingPath" @click="openPicker">浏览…</button>
                  <button class="btn-save" :disabled="savingPath" @click="savePath">
                    {{ savingPath ? '保存中…' : '保存' }}
                  </button>
                </div>
              </div>
              <div class="path-hint">
                浏览器无法直接选择本地文件路径——点「浏览…」逐层选择，或手动填写完整路径（.exe /
                .bat）；保存后点「启动 NapCat」立即生效，无需重启
              </div>
              <div v-if="pathError" class="error-msg">{{ pathError }}</div>
              <div v-if="pathSaved" class="ok-msg">{{ pathSaved }}</div>
            </div>

            <div class="actions">
              <button
                class="btn btn-start"
                :disabled="acting || !status?.launchReady || status?.running"
                @click="handleAction('start')"
              >
                {{ acting ? '操作中…' : '启动 NapCat' }}
              </button>
              <button
                class="btn btn-stop"
                :disabled="acting || !status?.running"
                @click="handleAction('stop')"
              >
                停止 NapCat
              </button>
            </div>

            <div v-if="actionError" class="error-msg">{{ actionError }}</div>
          </div>
        </div>

        <!-- 系统配置：context 阈值（80% 告警 / 90% 交接） -->
        <div v-show="activeCategory === 'system'" class="system-pane">
          <section class="config-section">
            <div class="section-title">上下文阈值配置</div>
            <div class="card-sub">保存后立即生效，重启后仍保持。</div>
            <div class="ctx-card">
              <div class="ctx-info">
                上下文窗口用量达到「告警阈值」时页面顶部横幅提示；达到「交接阈值」时自动交接到新会话。
                两个阈值同时作用于 token 用量条色阶（告警起黄色、交接起红色）。
              </div>

              <div v-if="ctxLoading" class="list-hint">加载中…</div>

              <template v-else>
                <div class="frow">
                  <span class="label">告警阈值（warn）</span>
                  <div class="ctl">
                    <input
                      v-model.number="warnThreshold"
                      type="number"
                      min="0.01"
                      max="0.99"
                      step="0.05"
                      class="input input-ctx"
                      :disabled="ctxSaving"
                    />
                  </div>
                </div>
                <div class="frow">
                  <span class="label">交接阈值（handoff）</span>
                  <div class="ctl">
                    <input
                      v-model.number="handoffThreshold"
                      type="number"
                      min="0.01"
                      max="0.99"
                      step="0.05"
                      class="input input-ctx"
                      :disabled="ctxSaving"
                    />
                  </div>
                </div>
                <div class="kv">
                  <span class="k">上下文窗口上限</span>
                  <span class="v">{{ ctxMaxDisplay() }}</span>
                  <span class="src">env</span>
                </div>

                <div class="ctx-hint">
                  取值 0~1 之间的小数（如 0.8 = 80%），且告警阈值 ≤ 交接阈值。「窗口上限」由服务端
                  env 决定，只读回显；保存后立即生效，重启后仍保持。
                </div>

                <div v-if="ctxFormError" class="error-msg">{{ ctxFormError }}</div>
                <div v-if="ctxSaved" class="ok-msg">{{ ctxSaved }}</div>

                <div class="form-actions">
                  <button class="btn btn-create" :disabled="ctxSaving" @click="saveCtxConfig">
                    {{ ctxSaving ? '保存中…' : '保存阈值' }}
                  </button>
                </div>
              </template>
            </div>
          </section>

          <section class="config-section">
            <div class="section-title">摘要配置</div>
            <div class="card-sub">保存后需重启 server 才生效（写 .env）。</div>
            <!-- 摘要配置：交接摘要/记忆改写模型（SUMMARY_MODEL/SUMMARY_API_KEY 写 .env，重启生效） -->
            <div class="ctx-card">
              <div class="ctx-info">
                交接摘要与记忆查询改写使用独立模型配置（写 .env 的 SUMMARY_MODEL /
                SUMMARY_API_KEY）。 密钥留空 = 保持现状（未配置时默认复用 DS_KEY）；填写新值 =
                覆盖。保存后重启生效。
              </div>

              <div v-if="sumLoading" class="list-hint">加载中…</div>

              <template v-else>
                <div class="frow">
                  <span class="label">摘要模型</span>
                  <div class="ctl">
                    <input
                      v-model="summaryModel"
                      type="text"
                      class="input input-ctx"
                      :disabled="sumDisabled || sumSaving"
                    />
                  </div>
                </div>
                <div class="frow">
                  <span class="label">摘要 API Key</span>
                  <div class="ctl">
                    <input
                      v-model="summaryApiKey"
                      type="password"
                      class="input input-ctx"
                      :disabled="sumDisabled || sumSaving"
                      :placeholder="summaryKeyPlaceholder"
                    />
                  </div>
                </div>

                <div class="ctx-hint">
                  密钥只在此回显掩码（{{
                    summaryMasked || '—'
                  }}），完整密钥不出服务器。模型变更重启后生效。
                </div>

                <div v-if="sumError" class="error-msg">{{ sumError }}</div>
                <div v-if="sumSaved" class="ok-msg">{{ sumSaved }}</div>

                <div class="form-actions">
                  <button
                    class="btn btn-create"
                    :disabled="sumDisabled || sumSaving"
                    @click="saveSummaryConfig"
                  >
                    {{ sumSaving ? '保存中…' : '保存摘要配置' }}
                  </button>
                </div>
              </template>
            </div>
          </section>

          <section class="config-section">
            <div class="section-title">铁律</div>
            <div class="card-sub">保存后下一轮回复即生效，无需重启。</div>
            <!-- 铁律编辑：开发铁律 + 审查铁律（运行期注入——settings 表优先、常量兜底） -->
            <div class="ctx-card">
              <div class="ctx-info">
                铁律是全局共享的运营规则（运行期注入到各猫 systemPrompt，settings 表优先、seed
                常量兜底）。保存后下一轮回复即生效，无需重启；需填非空内容（空串保存会报错）。
              </div>

              <div v-if="ironLawsLoading" class="list-hint">加载中…</div>
              <div v-else-if="ironLawsError" class="error-msg">{{ ironLawsError }}</div>
              <template v-else-if="ironLaws">
                <div class="frow frow-top iron-law-block">
                  <span class="label">开发铁律</span>
                  <div class="ctl">
                    <textarea
                      v-model="ironLawsCoder"
                      class="input iron-law-textarea"
                      rows="8"
                      :disabled="ironLawsSaving"
                      spellcheck="false"
                    ></textarea>
                  </div>
                </div>
                <div class="frow frow-top iron-law-block">
                  <span class="label">审查铁律</span>
                  <div class="ctl">
                    <textarea
                      v-model="ironLawsReviewer"
                      class="input iron-law-textarea"
                      rows="8"
                      :disabled="ironLawsSaving"
                      spellcheck="false"
                    ></textarea>
                  </div>
                </div>

                <div class="iron-law-hint">
                  若需恢复 seed 默认内容，请到 <code>packages/server/src/seed-data.ts</code> 查 看
                  IRON_LAWS_CODER / IRON_LAWS_REVIEWER 常量原文后手动粘贴覆盖。
                </div>

                <div v-if="ironLawsFormError" class="error-msg">{{ ironLawsFormError }}</div>
                <div v-if="ironLawsSaved" class="ok-msg">{{ ironLawsSaved }}</div>

                <div class="form-actions">
                  <button class="btn btn-create" :disabled="ironLawsSaving" @click="saveIronLaws">
                    {{ ironLawsSaving ? '保存中…' : '保存铁律' }}
                  </button>
                </div>
              </template>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 路径浏览选择器（内联弹窗：盘符列表 → 目录逐层 → 确定回填） -->
    <div v-if="pickerOpen" class="picker-overlay" @click.self="closePicker">
      <div class="picker" role="dialog" aria-modal="true" aria-label="浏览 NapCat 路径">
        <div class="picker-header">
          <h3>浏览 NapCat 路径</h3>
          <button class="btn-close" @click="closePicker">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M4 4l10 10M14 4l-10 10"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <div class="picker-body">
          <div class="picker-bar">
            <button class="btn-up" :disabled="!currentDir || browseLoading" @click="goUp">
              ↑ 上级
            </button>
            <span class="picker-dir mono">{{ currentDir ?? '选择磁盘' }}</span>
          </div>

          <div v-if="browseLoading" class="list-hint">加载中…</div>
          <div v-else-if="browseError" class="error-msg">{{ browseError }}</div>
          <div v-else-if="entries.length === 0" class="list-hint">（空目录）</div>
          <div v-else class="entry-list">
            <div
              v-for="e in entries"
              :key="e.name"
              class="entry-row"
              :class="{
                'entry-dir': e.type === 'dir',
                'entry-selected': selected === e.name,
                'entry-exec': e.type === 'file' && e.executable,
              }"
              @click="e.type === 'dir' ? openEntry(e) : selectFile(e)"
            >
              <span class="entry-icon">{{ e.type === 'dir' ? '📁' : '📄' }}</span>
              <span class="entry-name mono">{{ e.name }}</span>
              <span v-if="e.type === 'file' && e.executable" class="exec-badge">可执行</span>
            </div>
          </div>
        </div>

        <div class="picker-footer">
          <span v-if="selected" class="pick-preview mono">{{
            currentDir ? joinPath(currentDir, selected) : selected
          }}</span>
          <span v-else class="pick-preview hint">选择要启动的可执行文件（.exe / .bat / .cmd）</span>
          <button class="btn btn-cancel" @click="closePicker">取消</button>
          <button class="btn btn-ok" :disabled="!selected" @click="confirmPick">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ─── 设置视图（内容区里的普通视图）────────── */

.settings-view {
  /* T4：从「根级固定定位铺满视口」改为内容区弹性块——轨道在内容区之外常驻，
     若仍铺满视口会把轨道整条盖住（这正是「设置页导航栏跟原型不一样」的机制）。
     原先的高 z-index 与三栏布局争层叠，现在同处内容区已不需要，故一并摘除。 */
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}

/* 页头（图标 + 标题 + ✕）已随 T4 整体退役，其三条样式规则同批删除——
   留着会让后人以为页头仍在。下面的 `.btn-close` 仍被「浏览 NapCat 路径」弹窗
   （模态级）消费，故保留：清的是视图级页头，不是弹窗的关闭手段。 */
.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: all var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* ─── 左右分栏布局（参考图1：左侧窄条大类导航 + 右侧宽区详情） ──── */

.settings-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  /* T5：贴左（原先左右各一个 auto 边距，把整页推向居中）——整页居中是
     「导航左边空出数百 px」的根因：轨道 52px 与导航之间那条空白随视口变宽而变宽
     （1920 屏约 380px）。贴左后导航锚定轨道；卡片列仍在剩余区内居中（见下方 720px 列）。
     注：本注释不写那条旧声明的字面量——下方测试用**全串否定断言**钉它，
     写了就会被自己的注释喂成假红（本仓复发过的坑）。
     T6：整页宽度帽已摘除（内容居中诉求）——贴左裁决不回退，变的只是卡片列的居中
     参照系：从「帽内那个固定宽的内容区」变为「导航右缘 → 视口右缘」的整个剩余区
     （即 `.settings-content` 本身）。摘帽后不需要任何新居中机制：下方 720px 列自带的
     水平自动边距在新参照系里自行居中。实测 1920 视口：卡片列中心 1055 vs 内容区中心
     1060，偏 5px（半个滚动条宽，见下条注释）。
     注：这里同样不复述那条自动边距的字面量——理由同上一条，写了会被同一条断言命中。 */
  margin: 0;
}

/* 导航本体（148px / 图标列 / 激活态高亮）见 components/SubNav.vue —— T5 起设置与评估
   共用同一份规则；本视图只负责把它放进分栏并钉住图标行为。 */

.nav-icon {
  /* 线框 SVG 图标（原型 v6 成品）——尺寸写在图标自身上，此处只钉不参与收缩。
     T5：本规则命中 SubNav `#icon` slot 传入的 svg（slot 内容带本组件的 scope id）。 */
  flex-shrink: 0;
  display: block;
}

.settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 28px 32px;
  /* T3：滚动条槽常驻——三个 pane 内容长短不一，滚动条时有时无会让限宽内容区的
     可用宽度跳变，居中后 frow 左缘随之漂移（实测约 5px）。预留槽位后恒定。
     T6：摘掉整页宽度帽后本元素成为唯一的居中容器，槽位常驻的代价显形为「居中轴
     偏半个滚动条宽（约 8px）」——原型 v6 的 `.set-body` 同形态，接受；验收 1 的
     ≤10px 容差正是为它留的。 */
  scrollbar-gutter: stable;
}

/* 详情区限宽居中（表单行不长，避免贴满整行）——T3：680 → 720px 卡片列（票面 §二）。
   三个 pane 同宽同左缘是验收 2「所有 .frow 控件左缘 x 全等」的前提：
   任一 pane 漏掉限宽，它的表单行就从另一个 x 起跑。 */
.im-pane,
.system-pane,
.agent-panel {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}

/* 系统配置：三张卡片统一间距（每卡一个 config-section，标题贴近所属卡） */
.system-pane {
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.config-section .section-title {
  margin-bottom: 0;
}

/* ─── IM 接入子 Tab ─────────────────────── */

.settings-subtabs {
  display: flex;
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 20px;
}

.tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  padding: 8px 14px;
  cursor: pointer;
  transition: all var(--ease-out);
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--accent-text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.section-title + .section-title {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

/* ─── 入站状态只读卡 ───────────────────── */

.inbound-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 22px;
}

/* ─── Binding list ─────────────────────── */

.binding-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.binding-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  transition: all var(--ease-out);
}

.binding-row.confirming {
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.06);
}

.binding-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.binding-type {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  background: var(--accent-tint);
  border: 1px solid var(--accent-hint-border);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.binding-id {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}

.binding-session {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-muted);
}

.btn-delete {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 3px 10px;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-delete:hover {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.08);
}

.btn-delete-confirm {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
  font-weight: 600;
}

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

/* ─── Form ─────────────────────────────── */

.input {
  /* T3：box-sizing 是「莫名换行」的根治之一——content-box 下 width:100% 会叠上
     padding+border 溢出 flex 容器，把同行后续元素挤下去 */
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 11px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--ease-out),
    box-shadow var(--ease-out);
}

/* 多行控件不吃 34px 定高（rows 属性说了算）——否则 textarea 被压成一行 */
textarea.input {
  height: auto;
  min-height: 34px;
  padding: 8px 11px;
}

.input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.input-mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

select.input {
  cursor: pointer;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

/* ─── 生命周期状态卡 ────────────────────── */

.status-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid;
}

.badge-running {
  color: #3ecf8e;
  border-color: rgba(62, 207, 142, 0.4);
  background: rgba(62, 207, 142, 0.08);
}

.badge-stopped {
  color: var(--text-muted);
  border-color: var(--border-default);
  background: var(--bg-surface);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.status-text {
  font-size: 12px;
  color: var(--text-muted);
}

.config-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ─── T3 表单行网格（票面 §二）─────────────────────────
   病灶（用户反馈「有些框都没对齐 / 莫名的换行文字」）两个根因：
     ① 原 .config-item 是 flex + justify-content:center——label 宽度随文案长短变化、
        整行又居中 ⇒ 每行控件左缘各不相同，视觉上就是「框没对齐」；
     ② 全局无 box-sizing:border-box，.input 的 width:100% 叠加 padding+border 后
        溢出 flex 容器 ⇒ 把同行后续元素挤到下一行，即「莫名的换行」。
   修法：定宽网格（label 148px 右对齐 + 控件列 1fr）+ .ctl 弹性容器（nowrap）+
   控件 border-box。三点缺一，上面两个症状就会回来。 */
.frow {
  display: grid;
  grid-template-columns: 148px 1fr;
  gap: 14px;
  align-items: center;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.frow:last-child {
  border-bottom: none;
}

/* 块级控件行（铁律 textarea）：label 与内容顶部对齐——textarea 高 180px+，
   沿用 center 会让 label 悬在正中间 */
.frow-top {
  align-items: start;
}

.frow .label {
  font-size: 12.5px;
  color: var(--text-secondary);
  text-align: right;
  line-height: 1.4;
}

/* 顶部对齐变体才需要把 label 压下来，与 textarea 首行文字对齐 */
.frow-top .label {
  padding-top: 8px;
}

/* 控件弹性容器：nowrap 是「莫名换行」的正面判据——控件与提示文字永远同行 */
.frow .ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: nowrap;
}

.frow .hint {
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* 顶部对齐的弹性容器：控件与多行说明并排时，控件贴首行 */
.frow .ctl-top {
  align-items: flex-start;
}

/* 长文案提示：允许文字内部折行——.frow .hint 的 nowrap 只适合短语，长句会溢出卡片。
   换行只发生在文字内部，仍在 .ctl 内与控件同行（不把控件挤到下一行）。 */
.frow .hint-wrap {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.5;
  white-space: normal;
  min-width: 0;
}

.frow .hint-wrap code {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* ─── 只读 kv 行（票面 §二）：右对齐键 + mono 值 + 来源徽章 ───
   与可编辑表单行同网格，故左缘天然对齐；第三列 auto 放来源徽章。 */
.kv {
  display: grid;
  grid-template-columns: 148px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.kv:last-child {
  border-bottom: none;
}

.kv .k {
  font-size: 12.5px;
  color: var(--text-secondary);
  text-align: right;
}

.kv .v {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
  min-width: 0;
}

/* 来源徽章：值从哪来（常量 / env / 活库）——只读项的必要元信息 */
.kv .src {
  font-size: 10.5px;
  color: var(--text-muted);
  background: var(--bg-base);
  padding: 1px 7px;
  border-radius: 99px;
  border: 1px solid var(--border-subtle);
  white-space: nowrap;
}

/* 卡片副标题：一句「这页改了什么时候生效」——紧贴卡片标题 */
.card-sub {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.5;
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* ─── 开关（autoStart 等；T3 起嵌在 .frow 的控件列里，不再自带卡片）─────── */

.switch {
  position: relative;
  display: inline-block;
  width: 42px;
  height: 24px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--border-default);
  border-radius: 999px;
  transition: background var(--ease-out);
  cursor: pointer;
}

.switch-slider::before {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform var(--ease-out);
}

.switch input:checked + .switch-slider {
  background: var(--accent);
}

.switch input:checked + .switch-slider::before {
  transform: translateX(18px);
}

.switch input:disabled + .switch-slider {
  opacity: 0.5;
  cursor: default;
}

/* ─── 启动路径配置卡 ────────────────────── */

.path-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.path-input {
  flex: 1;
  box-sizing: border-box;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  transition:
    border-color var(--ease-out),
    box-shadow var(--ease-out);
}

.path-input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.path-input:disabled {
  opacity: 0.6;
}

.btn-save {
  box-sizing: border-box;
  height: 34px;
  padding: 0 18px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-save:hover:not(:disabled) {
  color: var(--accent-text);
  border-color: var(--accent-text);
}

.btn-save:disabled {
  opacity: 0.4;
  cursor: default;
}

.path-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
}

.ok-msg {
  background: rgba(62, 207, 142, 0.08);
  color: #3ecf8e;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  border: 1px solid rgba(62, 207, 142, 0.25);
}

/* ─── Hints & actions ──────────────────── */

.launch-hint {
  background: rgba(242, 184, 74, 0.08);
  border: 1px solid rgba(242, 184, 74, 0.25);
  color: var(--text-secondary);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.6;
}

.launch-hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-text);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
}

.actions {
  display: flex;
  gap: 10px;
}

.btn {
  /* T3：统一 34px——与同行 input/select 等高。border-box 让 .btn-stop 这类带边框的
     变体与 .btn-start 这类不带边框的等高（content-box 下两者差 2px） */
  box-sizing: border-box;
  height: 34px;
  padding: 0 22px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-start {
  background: var(--accent);
  color: var(--text-on-accent);
}

.btn-start:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-stop {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}

.btn-stop:hover:not(:disabled) {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.08);
}

.btn-create {
  background: var(--accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.btn-create:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-create:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ─── Error ────────────────────────────── */

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin-top: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}

/* ─── 系统配置：context 阈值卡 ────────────── */

/* .form-card = 无标题的通用表单卡（表单行的容器）。与 .ctx-card 同规格：
   border 1px + padding 16px 是「卡片内 frow 左缘」的固定内缩量，也是验收 2 里
   所有 pane 的表单行能对齐到同一条垂直线的依据——裸放在 pane 上的行会少这 17px。 */
.ctx-card,
.form-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ctx-info {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.ctx-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
}

.input-ctx {
  width: 180px;
  font-family: var(--font-mono);
  font-size: 12px;
  flex-shrink: 0;
}

/* ─── 铁律编辑块（textarea 全文——settings 表优先、seed 常量兜底） ─── */

/* 铁律全文块：T3 起与其它表单行同网格（label 148px 右对齐 + textarea 占满控件列），
   故左缘与上方所有控件对齐；垂直方向走 .frow-top 顶部对齐变体。
   注意别再给这里加 display —— 它会盖掉 .frow 的 grid（两者特异性相同，靠源码顺序决胜）。 */
.iron-law-block .ctl {
  align-items: flex-start;
}

/* 多行控件在弹性容器里撑满控件列（textarea 的 width:100% 在 flex 项上会被 shrink 吃掉） */
.frow .ctl > textarea {
  flex: 1;
  min-width: 0;
}

.iron-law-textarea {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.iron-law-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

/* ─── 路径浏览选择器（内联弹窗） ──────────── */

.picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.picker {
  width: 520px;
  max-width: 92vw;
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.picker-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.picker-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.picker-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-up {
  box-sizing: border-box;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-up:hover:not(:disabled) {
  color: var(--accent-text);
  border-color: var(--accent-text);
}

.btn-up:disabled {
  opacity: 0.4;
  cursor: default;
}

.picker-dir {
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  padding: 4px;
}

.entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--ease-out);
}

.entry-row:hover {
  background: var(--bg-hover);
}

.entry-dir {
  color: var(--text-primary);
}

.entry-selected {
  background: rgba(96, 165, 250, 0.12);
  outline: 1px solid var(--accent);
}

.entry-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.entry-name {
  flex: 1;
  font-size: 12px;
  word-break: break-all;
}

.exec-badge {
  font-size: 10px;
  font-weight: 600;
  color: #3ecf8e;
  border: 1px solid rgba(62, 207, 142, 0.4);
  border-radius: 999px;
  padding: 1px 8px;
  background: rgba(62, 207, 142, 0.08);
  flex-shrink: 0;
}

.picker-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-subtle);
}

.pick-preview {
  flex: 1;
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.pick-preview.hint {
  color: var(--text-muted);
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}

.btn-cancel:hover:not(:disabled) {
  color: var(--text-primary);
}

.btn-ok {
  background: var(--accent);
  color: var(--text-on-accent);
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}

/* ─── 猫咪管理（AgentPanel.vue 展开态样式复制迁入，前缀 .agent-panel 防与设置页同名类冲突） ── */

.agent-panel {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* ─── Header ────────────────────────────── */

.agent-panel .panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 16px 12px;
}

.agent-panel .header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-panel .panel-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: -0.2px;
}

.agent-panel .header-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 1px 7px;
  border-radius: 10px;
}

.agent-panel .btn-add {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border-default);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.agent-panel .btn-add:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
}

/* ─── Agent Cards ───────────────────────── */

.agent-panel .agent-cards {
  flex: 1;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-panel .agent-card {
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: all var(--ease-out);
}

.agent-panel .agent-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-sm);
  background: var(--bg-hover);
}

.agent-panel .card-top {
  display: flex;
  gap: 10px;
  align-items: center;
}

.agent-panel .agent-avatar {
  font-size: 32px;
  flex-shrink: 0;
  line-height: 1;
}

.agent-panel .agent-info {
  flex: 1;
  min-width: 0;
}

.agent-panel .agent-name {
  font-size: 14px;
  font-weight: 600;
  display: block;
}

.agent-panel .agent-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}

.agent-panel .provider-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  background: var(--accent-soft);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.agent-panel .model-name {
  font-size: 10px;
  color: var(--text-muted);
  /* 长模型名（如 deepseek-v4-flash）单行不换行：
     换行会撑高 agent-meta 行 → provider-badge 被 stretch 拉高 → 徽章文字贴顶 */
  white-space: nowrap;
}

/* ─── 静态配置网格（B2：运行参数展示——动态信息已迁侧边栏） ── */

.agent-panel .static-grid {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 14px;
}

.agent-panel .static-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.agent-panel .static-item-wide {
  grid-column: 1 / -1;
}

.agent-panel .static-label {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 600;
  flex-shrink: 0;
}

.agent-panel .static-value {
  font-size: 11px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-panel .static-value.mono {
  font-family: var(--font-mono);
  font-size: 10px;
}

/* ─── Agent Status (loading/error) ───────── */

.agent-panel .agent-status {
  text-align: center;
  padding: 24px 16px;
  color: var(--text-muted);
  font-size: 12px;
}

.agent-panel .agent-status .status-spinner {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 8px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-panel .agent-status .status-icon {
  font-size: 22px;
  display: block;
  margin-bottom: 6px;
}

.agent-panel .agent-status .hint {
  font-size: 10px;
  opacity: 0.7;
  margin-top: 3px;
}

.agent-panel .agent-status-error {
  color: var(--accent-red);
}

.agent-panel .agent-status-error .hint {
  color: var(--text-muted);
  max-width: 180px;
  margin: 2px auto 8px;
  word-break: break-all;
}

.agent-panel .btn-retry-sm {
  padding: 4px 14px;
  border: 1px solid var(--accent-text);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.agent-panel .btn-retry-sm:hover {
  background: var(--accent);
  color: var(--text-on-accent);
}

/* Empty */
.agent-panel .agent-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
}

.agent-panel .agent-empty .empty-icon {
  font-size: 32px;
  display: block;
  margin-bottom: 8px;
  opacity: 0.5;
}

.agent-panel .agent-empty p {
  font-size: 13px;
}

.agent-panel .agent-empty .hint {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 4px;
}

/* ─── Quick Create ──────────────────────── */

.agent-panel .create-section {
  /* T3：水平 margin 归零 + 内容 padding 对齐 16px——本卡片的 .frow 要与另两个 pane 的
     表单行从同一条垂直线起跑（验收 2）。原 margin:0 12px 会让它整列右移 11px */
  margin: 0 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  overflow: hidden;
}

.agent-panel .create-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.agent-panel .create-header h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.agent-panel .btn-close-sm {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: color var(--ease-out);
}

.agent-panel .btn-close-sm:hover {
  color: var(--text-primary);
}

.agent-panel .create-body {
  /* 水平 16px 与 .ctx-card / .inbound-card / .status-card / .path-card 同口径 */
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.agent-panel .create-body .input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--ease-out),
    box-shadow var(--ease-out);
}

/* 多行控件不吃 34px 定高（与 .input 同口径） */
.agent-panel .create-body textarea.input {
  height: auto;
  min-height: 34px;
  padding: 7px 10px;
}

.agent-panel .create-body .input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.agent-panel .create-body textarea.input {
  resize: vertical;
  line-height: 1.5;
}

.agent-panel .input-mono {
  font-family: var(--font-mono);
  font-size: 11px !important;
}

.agent-panel .create-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-subtle);
}

.agent-panel .error-text {
  font-size: 11px;
  color: var(--accent-red);
  margin-right: auto;
}

.agent-panel .btn {
  box-sizing: border-box;
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.agent-panel .btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.agent-panel .btn-cancel:hover {
  background: var(--bg-raised);
  color: var(--text-primary);
}

.agent-panel .btn-confirm {
  background: var(--accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.agent-panel .btn-confirm:hover:not(:disabled) {
  background: var(--accent-hover);
}

.agent-panel .btn-confirm:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

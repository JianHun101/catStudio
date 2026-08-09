<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import {
  api,
  type ConnectorBinding,
  type NapcatBrowseEntry,
  type OneBotStatus,
} from '@/composables/useApi'

/**
 * 全屏设置中心（左侧栏底部齿轮进入，无 vue-router 的 App 级 view 切换）。
 * 由三个弹窗组件合并而成（避免双入口双实现）：
 *  - ConnectorBindingsModal Tab1（QQ 绑定管理）
 *  - ConnectorNapCatPanel（NapCat 生命周期 + 启动路径 + autoStart 开关）
 *  - NapcatPathPicker（路径浏览选择器，内联弹窗）
 * 契约（店长钉死）：autoStart 缺省 true——旧配置无字段 = 自动拉起；开关初始态跟随
 * GET 响应，保存时 POST 全量带 { napcatPath, autoStart }。
 */
const emit = defineEmits<{ close: [] }>()
const store = useChatStore()

// ─── 双 tab：QQ 接入 / NapCat ─────────────────
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

onMounted(() => {
  // 设置页为常驻视图（v-show 切 tab 保持挂载）——一次拉齐三份数据
  loadBindings()
  refresh()
  loadConfig()
})
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <div class="settings-view" role="dialog" aria-modal="true" aria-label="设置">
    <header class="settings-header">
      <div class="settings-title">
        <span class="settings-icon">⚙️</span>
        <h2>设置</h2>
      </div>
      <button class="btn-close" @click="emit('close')">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4 4l10 10M14 4l-10 10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <div class="settings-tabs">
      <button class="tab-btn" :class="{ active: activeTab === 'qq' }" @click="activeTab = 'qq'">
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

    <div class="settings-body">
      <!-- Tab1：QQ 接入（v-show 保持挂载，onMounted 行为零改动） -->
      <div v-show="activeTab === 'qq'">
        <div class="section-title">入站状态</div>
        <div class="inbound-card">
          <div class="config-item">
            <span class="label">入站启用</span>
            <span class="value">{{ status?.enabled ? '是' : '否' }}</span>
          </div>
          <div class="config-item">
            <span class="label">API 地址</span>
            <span class="value mono">{{ status?.apiBase || '—' }}</span>
          </div>
          <div class="config-item">
            <span class="label">鉴权 Token</span>
            <span class="value mono">{{
              status?.tokenConfigured ? status?.tokenMasked : '未配置'
            }}</span>
          </div>
        </div>

        <div class="section-title">QQ 绑定</div>
        <div v-if="listLoading" class="list-hint">加载中…</div>
        <div v-else-if="listError" class="error-msg">{{ listError }}</div>
        <div v-else-if="bindings.length === 0" class="list-hint">
          暂无绑定——添加后对应 QQ 群/私聊的消息才会接入猫咖
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
        <div class="form-group">
          <label>平台</label>
          <select v-model="platform" class="input">
            <option v-for="p in platformOptions" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </select>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label>类型</label>
            <select v-model="externalType" class="input">
              <option v-for="t in typeOptions" :key="t.value" :value="t.value">
                {{ t.label }}
              </option>
            </select>
          </div>
          <div class="form-group flex-1">
            <label>QQ 号/群号</label>
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

        <div class="form-group">
          <label>绑定会话</label>
          <select v-model="sessionId" class="input">
            <option value="" disabled>选择会话…</option>
            <option v-for="s in store.sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
          </select>
        </div>

        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <div class="form-actions">
          <button class="btn btn-create" :disabled="saving" @click="handleAdd">
            {{ saving ? '添加中…' : '添加绑定' }}
          </button>
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
            <div class="config-item">
              <span class="label">API 地址</span>
              <span class="value mono">{{ status?.apiBase || '—' }}</span>
            </div>
            <div class="config-item">
              <span class="label">入站启用</span>
              <span class="value">{{ status?.enabled ? '是' : '否' }}</span>
            </div>
            <div class="config-item">
              <span class="label">鉴权 Token</span>
              <span class="value mono">{{
                status?.tokenConfigured ? status?.tokenMasked : '未配置'
              }}</span>
            </div>
          </div>
        </div>

        <!-- autoStart 开关：dev 启动时自动拉起 NapCat（缺省 true——旧配置无字段行为不变） -->
        <div class="switch-card">
          <div class="switch-info">
            <div class="switch-title">dev 启动时自动拉起</div>
            <div class="switch-hint">
              开启后 <code>pnpm dev</code> 会自动启动 NapCat；关闭后需手动点「启动 NapCat」。
              旧配置无该字段 = 默认开启（可在设置页关闭）
            </div>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              v-model="autoStart"
              :disabled="savingPath"
              @change="saveAutoStart"
            />
            <span class="switch-slider"></span>
          </label>
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
          启动命令使用 <code>{NAPCAT_PATH}</code> 占位符——请在下方「NapCat 启动路径」填写本机 NapCat
          可执行文件完整路径并保存
        </div>

        <div class="path-card">
          <div class="path-title">NapCat 启动路径</div>
          <div class="path-row">
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
/* ─── 全屏设置中心 ──────────────────────── */

.settings-view {
  position: fixed;
  inset: 0;
  z-index: 600; /* 低于 error-toast(9999)，高于三栏布局 */
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.settings-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-title h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.settings-icon {
  font-size: 18px;
}

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

/* ─── Tabs ─────────────────────────────── */

.settings-tabs {
  display: flex;
  gap: 4px;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
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
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* ─── Body ─────────────────────────────── */

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 32px;
  max-width: 680px;
  width: 100%;
  margin: 0 auto;
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
  color: var(--accent);
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

.form-row {
  display: flex;
  gap: 14px;
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 5px;
}

.flex-1 {
  flex: 1;
}

.input {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.input:focus {
  border-color: var(--accent);
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

.config-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.config-item .label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  flex-shrink: 0;
}

.config-item .value {
  font-size: 12px;
  color: var(--text-primary);
  text-align: right;
  word-break: break-all;
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* ─── autoStart 开关卡 ─────────────────── */

.switch-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.switch-info {
  min-width: 0;
}

.switch-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.switch-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
  margin-top: 3px;
}

.switch-hint code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
}

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

.path-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.path-row {
  display: flex;
  gap: 8px;
}

.path-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.path-input:focus {
  border-color: var(--accent);
}

.path-input:disabled {
  opacity: 0.6;
}

.btn-save {
  padding: 8px 18px;
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
  color: var(--accent);
  border-color: var(--accent);
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
  color: var(--accent);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
}

.actions {
  display: flex;
  gap: 10px;
}

.btn {
  padding: 8px 22px;
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
  color: var(--bg-deep);
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
  color: var(--bg-deep);
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
  padding: 5px 12px;
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
  color: var(--accent);
  border-color: var(--accent);
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
  color: var(--bg-deep);
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}
</style>

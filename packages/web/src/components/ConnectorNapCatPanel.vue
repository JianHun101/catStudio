<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, type OneBotStatus } from '@/composables/useApi'

/**
 * NapCat 生命周期面板（连接器配置弹窗 Tab2）。
 * 职责边界：NapCat 是独立程序，server 永不 spawn——本面板只做两件事：
 * ①GET /api/connectors/onebot/status 只读渲染（env 值 + 端口可达性探测）；
 * ②启停按钮 → POST control 写 .napcat-request → dev.js 轮询执行。
 * TOKEN 只展示服务端脱敏掩码，完整 token 不出 server。
 */
const status = ref<OneBotStatus | null>(null)
const loading = ref(true)
const error = ref('')
const acting = ref(false)
const actionError = ref('')
/** 组件卸载（弹窗关闭）后停止轮询——防写已卸载组件的 ref */
let disposed = false

// ─── 启动路径配置（.napcat-config.json）─────────────────
// 浏览器 file input 拿不到本地绝对路径（安全沙箱，只能拿 C:\fakepath\…），故页面是
// 路径输入框 + server stat 存在性校验，不是文件选择器。保存后 dev.js 拉起时动态读，
// 无需重启任何进程即生效。
const napcatPath = ref('')
const saving = ref(false)
const pathError = ref('')
const pathSaved = ref('')

async function loadConfig(): Promise<void> {
  try {
    const cfg = await api.getNapcatConfig()
    if (disposed) return
    napcatPath.value = cfg.napcatPath || ''
  } catch {
    // 配置读取失败不阻塞面板主体渲染（状态卡/启停照常）——输入框留空即可
  }
}

async function savePath(): Promise<void> {
  pathError.value = ''
  pathSaved.value = ''
  saving.value = true
  try {
    const res = await api.saveNapcatConfig({ napcatPath: napcatPath.value })
    napcatPath.value = res.napcatPath
    pathSaved.value = '已保存，点「启动 NapCat」立即生效'
    await refresh() // 路径就绪可能翻转 launchReady → 刷新启停按钮态
  } catch (err: any) {
    pathError.value = err.message || '保存失败'
  } finally {
    if (!disposed) saving.value = false
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

onMounted(() => {
  refresh()
  loadConfig()
})
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <div class="napcat-panel">
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
          :disabled="saving"
          spellcheck="false"
        />
        <button class="btn-save" :disabled="saving" @click="savePath">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
      <div class="path-hint">
        浏览器无法直接选择本地文件路径，请手动填写完整路径（.exe / .bat）；保存后点「启动
        NapCat」立即生效，无需重启
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
</template>

<style scoped>
.napcat-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ─── Status card ─────────────────────── */

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
  flex: 1;
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

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}
</style>

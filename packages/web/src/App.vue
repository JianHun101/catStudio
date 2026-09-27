<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import SessionAgentsPanel from './components/SessionAgentsPanel.vue'
import SettingsView from './views/SettingsView.vue'
import EvaluationView from './views/EvaluationView.vue'
import TraceView from './views/TraceView.vue'
import { useChatStore } from '@/stores/chat'

const store = useChatStore()

/** 全屏设置页 view 切换（无 vue-router，App 级布尔状态）——入口在左侧栏底部齿轮 */
const showSettings = ref(false)

/** 全屏评估中心 view 切换（E4-B，照 SettingsView 同款模式）——入口在左侧栏底部（设置上方） */
const showEval = ref(false)

/** 全屏执行追踪 view 切换（T2）——入口在轨道 ⚙，另有气泡 footer ⚙ 带预选进入 */
const showTrace = ref(false)

/** 气泡 ⚙ 进来时预选的执行 id（轨道直接进来为 null = 只看列表不预选） */
const tracePreselect = ref<string | null>(null)

/** 打开执行追踪。三个全屏 view 互斥（同款语义：`v-else-if` 链 + `app-layout` 的 v-show） */
function openTrace(executionId: string | null = null): void {
  tracePreselect.value = executionId
  showTrace.value = true
  showSettings.value = false
  showEval.value = false
}

/** 「跳到该回复气泡 ↗」：关掉追踪页、必要时切到该会话、把焦点消息交给 ChatPanel 滚动。
 *  切会话走 store 既有动作（它会拉数据），滚动由 `focusMessageId` 这条单向信号驱动。 */
function onTraceJump(messageId: string, sessionId: string): void {
  showTrace.value = false
  if (sessionId && sessionId !== store.activeSessionId) store.joinSession(sessionId)
  store.requestFocusMessage(messageId)
}

/** 任何全屏 view 开着时，底层三栏布局不显示（保活靠 v-show——切回来零重建） */
const anyOverlayOpen = computed(() => showSettings.value || showEval.value || showTrace.value)

/** User manually toggled the left sidebar — once set, auto-hide on narrow windows
 *  respects explicit choice and won't auto-show when the window widens again. */
const leftOpen = ref(true)
const userToggledLeft = ref(false)

function toggleLeft(): void {
  leftOpen.value = !leftOpen.value
  userToggledLeft.value = true
}

// Media queries: 左侧折叠（650px）+ 右栏窄窗隐藏（1000px）
let mobileMq: MediaQueryList | undefined
let narrowMq: MediaQueryList | undefined

/** 窄窗（<1000px）自动隐藏右栏（评估面板在窄屏无空间，媒体查询模式与左折叠同构） */
const rightOpen = ref(true)
const userToggledRight = ref(false)

function onMobile(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledLeft.value) {
    leftOpen.value = !e.matches
  }
}

function onNarrow(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledRight.value) {
    rightOpen.value = !e.matches
  }
}

onMounted(() => {
  mobileMq = window.matchMedia('(max-width: 650px)')
  narrowMq = window.matchMedia('(max-width: 1000px)')

  onMobile(mobileMq)
  onNarrow(narrowMq)

  mobileMq.addEventListener('change', onMobile)
  narrowMq.addEventListener('change', onNarrow)
})

onUnmounted(() => {
  mobileMq?.removeEventListener('change', onMobile)
  narrowMq?.removeEventListener('change', onNarrow)
})
</script>

<template>
  <!-- Error toast -->
  <Transition name="toast">
    <div v-if="store.errorMessage" class="error-toast" role="alert">
      <span class="error-toast-icon">⚠️</span>
      <span class="error-toast-text">{{ store.errorMessage }}</span>
      <button class="error-toast-close" @click="store.dismissError" title="关闭">✕</button>
    </div>
  </Transition>

  <SettingsView v-if="showSettings" @close="showSettings = false" />

  <EvaluationView v-else-if="showEval" @close="showEval = false" />

  <!-- `:key` 绑预选 id：同一次会话里连点两条气泡的 ⚙ 要重新挂载，否则
       `onMounted` 只跑一次、第二次预选不生效（症状是「点了没反应」）。 -->
  <TraceView
    v-else-if="showTrace"
    :key="tracePreselect ?? 'trace'"
    :preselect-execution-id="tracePreselect"
    @close="showTrace = false"
    @jump-to-message="onTraceJump"
  />

  <!-- app-layout 用 v-show 保活：切设置/评估/追踪页不卸载、切回零重建（SessionList 不重跑 onMounted、ChatPanel 不重建）；
       三个全屏页仍 v-if/v-else-if 互斥。副作用是设计内收益：追踪页打开期间 socket 事件仍进 store（消息实时进缓存）。 -->
  <div v-show="!anyOverlayOpen" class="app-layout" :class="{ 'left-closed': !leftOpen }">
    <!-- 52px 图标轨道（改版新增，最左）：logo + 会话/追踪/评估 + 底部设置。
         全局入口从旧「会话栏底部 footer」上移到此处——会话栏可整栏收起，轨道不能，
         故入口放轨道才「收起后仍在」。 -->
    <nav class="app-rail" aria-label="主导航">
      <div class="rail-logo" title="CatStudio" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <ellipse cx="12" cy="16.6" rx="4.7" ry="3.7" />
          <ellipse cx="5.6" cy="11.2" rx="1.9" ry="2.5" />
          <ellipse cx="9.5" cy="8" rx="2" ry="2.7" />
          <ellipse cx="14.5" cy="8" rx="2" ry="2.7" />
          <ellipse cx="18.4" cy="11.2" rx="1.9" ry="2.5" />
        </svg>
      </div>
      <button class="rail-btn on" title="对话" aria-label="对话" aria-current="page">💬</button>
      <!-- 执行追踪（T2）：从轨道直接进来 = 只看列表，不预选任何一条执行 -->
      <button class="rail-btn" title="执行追踪" aria-label="执行追踪" @click="openTrace()">
        ⚙
      </button>
      <button class="rail-btn" title="评估中心" aria-label="评估中心" @click="showEval = true">
        📊
      </button>
      <div class="rail-sp"></div>
      <button class="rail-btn" title="设置" aria-label="设置" @click="showSettings = true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </nav>

    <aside class="panel-left">
      <div class="panel-inner">
        <SessionList :collapsed="!leftOpen" @expand="leftOpen = true" />
      </div>
    </aside>

    <main class="panel-center">
      <div class="center-content">
        <ChatPanel
          :left-sidebar-open="leftOpen"
          @toggle-left-sidebar="toggleLeft"
          @open-trace="openTrace"
        />
      </div>
    </main>

    <!-- 右侧评估面板（clowder-ai 精简模式——会话成员/tokens/统计/队列/配置，非旧版运行控制台） -->
    <aside class="panel-right" :class="{ 'right-closed': !rightOpen }">
      <SessionAgentsPanel />
    </aside>
  </div>
</template>

<style scoped>
/* ─── Error Toast ─────────────────────────── */

.error-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: #3d1f1f;
  border: 1px solid rgba(224, 85, 106, 0.35);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  max-width: 480px;
  font-size: 13px;
  color: #f0c0c0;
  pointer-events: auto;
}

.error-toast-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.error-toast-text {
  flex: 1;
  line-height: 1.45;
}

.error-toast-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #d4a0a0;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}
.error-toast-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #f0c0c0;
}

/* Toast transition */
.toast-enter-active {
  transition:
    opacity 0.25s ease-out,
    transform 0.25s ease-out;
}
.toast-leave-active {
  transition:
    opacity 0.2s ease-in,
    transform 0.2s ease-in;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-12px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}

/* ─── Layout Grid ────────────────────────── */

.app-layout {
  display: grid;
  /* 四栏：52px 图标轨道 | 236px 会话栏 | 主区 | 300px 成员栏。
     轨道恒在（全局入口落点），会话栏才是可收起的「第二级」。 */
  grid-template-columns: 52px 236px 1fr 300px;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  /* grid-template-columns animation disabled —
 * browsers step integer track sizes, causing layout recalc on every frame
 * which produces vertical jitter in contained content.
 * If smooth animation is desired later, use the View Transitions API
 * (document.startViewTransition) which interpolates snapshots on the
 * compositor without triggering layout. */
}

/* 收起会话栏：轨道保留、会话栏整栏收起（只剩轨道）。
 * 轨道 0 宽 + display:none 双管——display:none 的 item 不参与布局，但显式 track 仍占位
 * （下方窄窗注释同款理由），故 track 必须同步归零，否则聊天区被无形压缩。 */
.app-layout.left-closed {
  grid-template-columns: 52px 0 1fr 300px;
}

.app-layout.left-closed .panel-left {
  display: none;
}

/* 窄窗（<1000px）右栏自动隐藏时同步收窄列——display:none 的 item 不参与布局，
 * 但显式 300px track 仍占位，若不收窄则聊天区被无形压缩（与 narrowMq 同断点） */
@media (max-width: 1000px) {
  .app-layout {
    grid-template-columns: 52px 236px 1fr;
  }
  .app-layout.left-closed {
    grid-template-columns: 52px 0 1fr;
  }
}

/* ─── Panels ─────────────────────────────── */

.panel-left {
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--border-subtle);
}

.panel-center {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-deep);
}

.center-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* 右侧评估面板（300px 低密度分区——clowder-ai 精简模式） */
.panel-right {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
  border-left: 1px solid var(--border-subtle);
}

.panel-right.right-closed {
  display: none;
}

/* Panel inner — always flex, collapsed mode handled by child component */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

/* ─── 52px 图标轨道 ──────────────────────── */

.app-rail {
  background: var(--bg-base);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0 12px;
  gap: 6px;
  overflow: hidden;
}

/* logo：极简平涂爪印——accent 实底圆角块 + 深色剪影（单边两色，不拟物） */
.rail-logo {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  display: grid;
  place-items: center;
  margin-bottom: 10px;
  background: var(--accent);
  color: var(--bg-deep);
}

.rail-logo svg {
  width: 19px;
  height: 19px;
}

.rail-btn {
  width: 36px;
  height: 36px;
  flex: none;
  /* ::before 的 3px 激活竖条要贴轨道左缘——定位锚点 */
  position: relative;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  font-family: inherit;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all var(--ease-out);
}

.rail-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* 激活态：accent-soft 高亮块 + 左缘 3px 竖条 */
.rail-btn.on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.rail-btn.on::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}

.rail-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

/* 撑开中段：底部设置按钮沉到轨道底 */
.rail-sp {
  flex: 1;
}
</style>

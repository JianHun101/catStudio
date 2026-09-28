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

/** 全屏设置页 view 切换（无 vue-router，App 级布尔状态）——入口在根级轨道齿轮 */
const showSettings = ref(false)

/** 全屏评估中心 view 切换（E4-B，照 SettingsView 同款模式）——入口在根级轨道（设置上方） */
const showEval = ref(false)

/** 全屏执行追踪 view 切换（T2）——入口在根级轨道 ⚙，另有气泡 footer ⚙ 带预选进入 */
const showTrace = ref(false)

/** 气泡 ⚙ 进来时预选的执行 id（轨道直接进来为 null = 只看列表不预选） */
const tracePreselect = ref<string | null>(null)

/** 轨道四按钮的激活态单源：无覆盖层 = 聊天。`.on` 与 `aria-current` 都读它——
 *  两处各判一次的话，加第五个视图时必有一处漏改且不报错（复述面分叉老形态）。 */
const currentView = computed<'chat' | 'trace' | 'eval' | 'settings'>(() => {
  if (showSettings.value) return 'settings'
  if (showEval.value) return 'eval'
  if (showTrace.value) return 'trace'
  return 'chat'
})

/** 打开执行追踪。三个全屏 view 互斥（同款语义：`v-else-if` 链 + `app-layout` 的 v-show）。
 *  T4：已在追踪页且无新预选 = 无操作——轨道 ⚙ 必须幂等，否则点一下会把气泡带来的预选清掉。 */
function openTrace(executionId: string | null = null): void {
  if (showTrace.value && executionId === null) return
  tracePreselect.value = executionId
  showTrace.value = true
  showSettings.value = false
  showEval.value = false
}

/** 打开设置页（T4：轨道齿轮）。互斥与幂等同 `openTrace`。 */
function openSettings(): void {
  if (showSettings.value) return
  showSettings.value = true
  showEval.value = false
  showTrace.value = false
}

/** 打开评估中心（T4：轨道 📊）。 */
function openEval(): void {
  if (showEval.value) return
  showEval.value = true
  showSettings.value = false
  showTrace.value = false
}

/** 回聊天（轨道 💬）：关掉全部覆盖层——这就是「轨道即导航」的返回手段（✕ 已退役）。
 *  `app-layout` 是 v-show ⇒ 切回零重建；顺带清预选，使「轨道进追踪页」恒为只看列表。 */
function openChat(): void {
  showSettings.value = false
  showEval.value = false
  showTrace.value = false
  tracePreselect.value = null
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

  <div class="app-root">
    <!-- 52px 图标轨道（T4：从 .app-layout 内部提到根级常驻）：logo + 会话/追踪/评估 + 底部设置。
         全局入口从旧「会话栏底部 footer」上移到此处——会话栏可整栏收起，轨道不能；
         T4 起设置/追踪/评估打开时轨道同样常驻（原型 v6：**轨道就是导航**，故 ✕ 关闭按钮已退役）。
         当前视图的按钮挂 `.on`（accent-soft 底 + 左缘 3px 竖条）。 -->
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
      <button
        class="rail-btn"
        :class="{ on: currentView === 'chat' }"
        :aria-current="currentView === 'chat' ? 'page' : undefined"
        title="对话"
        aria-label="对话"
        @click="openChat()"
      >
        💬
      </button>
      <!-- 执行追踪（T2）：从轨道直接进来 = 只看列表，不预选任何一条执行 -->
      <button
        class="rail-btn"
        :class="{ on: currentView === 'trace' }"
        :aria-current="currentView === 'trace' ? 'page' : undefined"
        title="执行追踪"
        aria-label="执行追踪"
        @click="openTrace()"
      >
        ⚙
      </button>
      <button
        class="rail-btn"
        :class="{ on: currentView === 'eval' }"
        :aria-current="currentView === 'eval' ? 'page' : undefined"
        title="评估中心"
        aria-label="评估中心"
        @click="openEval()"
      >
        📊
      </button>
      <div class="rail-sp"></div>
      <button
        class="rail-btn"
        :class="{ on: currentView === 'settings' }"
        :aria-current="currentView === 'settings' ? 'page' : undefined"
        title="设置"
        aria-label="设置"
        @click="openSettings()"
      >
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

    <!-- 内容区：三个覆盖层与三栏布局同处此列（v-if/v-else-if 链 + app-layout 的 v-show 互斥）。
         轨道在这一层**之外** ⇒ 打开覆盖层不再吃掉轨道（T4 病灶）。
         覆盖层从 fixed inset 0 改为本列的弹性块（各自根元素 flex:1），故它们不再盖住轨道。 -->
    <div class="app-main">
      <SettingsView v-if="showSettings" />

      <EvaluationView v-else-if="showEval" />

      <!-- `:key` 绑预选 id：同一次会话里连点两条气泡的 ⚙ 要重新挂载，否则
           `onMounted` 只跑一次、第二次预选不生效（症状是「点了没反应」）。 -->
      <TraceView
        v-else-if="showTrace"
        :key="tracePreselect ?? 'trace'"
        :preselect-execution-id="tracePreselect"
        @jump-to-message="onTraceJump"
      />

      <!-- app-layout 用 v-show 保活：切设置/评估/追踪页不卸载、切回零重建（SessionList 不重跑 onMounted、ChatPanel 不重建）；
           三个全屏页仍 v-if/v-else-if 互斥。副作用是设计内收益：追踪页打开期间 socket 事件仍进 store（消息实时进缓存）。 -->
      <div v-show="!anyOverlayOpen" class="app-layout" :class="{ 'left-closed': !leftOpen }">
        <aside class="panel-left">
          <div class="panel-inner">
            <SessionList />
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
    </div>
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

/* ─── 根级：轨道常驻 + 内容区（T4） ──────── */

/* 根容器 = 52px 轨道（常驻，不吃 v-show）+ 内容区。轨道在这一层定宽，
   故设置/追踪/评估打开时它仍在——覆盖层只是内容区里换一个孩子。 */
.app-root {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

/* 内容区：覆盖层（v-if/v-else-if）与三栏布局（v-show）同处此列、互斥显示。
   min-width:0 防长内容把这一列撑破（flex item 默认 min-width:auto）。 */
.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ─── Layout Grid ────────────────────────── */

.app-layout {
  display: grid;
  /* 三栏：236px 会话栏 | 主区 | 300px 成员栏。
     T4：52px 轨道已提到根级 `.app-rail`，不再占这里的 track——视觉列宽与 T1 的四栏
     完全一致（轨道 + 会话栏 + 主区 + 右栏），只是轨道归根级管。 */
  grid-template-columns: 236px 1fr 300px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  /* grid-template-columns animation disabled —
 * browsers step integer track sizes, causing layout recalc on every frame
 * which produces vertical jitter in contained content.
 * If smooth animation is desired later, use the View Transitions API
 * (document.startViewTransition) which interpolates snapshots on the
 * compositor without triggering layout. */
}

/* 收起会话栏：轨道保留、会话栏整栏收起。
 * 「不占位」的全部机制是 track 归零——显式 track 照常占位，与 item 可不可见无关；
 * 故收起态必须把首列也写成 0，否则聊天区被无形压缩。
 * `display:none` 是另加的：它顺带把收起态内容移出 a11y 树与 Tab 序。但它同时把
 * item 移出了 grid，自动放置因而错位——列位显式钉死见下。 */
.app-layout.left-closed {
  grid-template-columns: 0 1fr 300px;
}

.app-layout.left-closed .panel-left {
  display: none;
}

/* 三栏列位一律**显式钉死**，不依赖 grid 自动放置。
 *
 * 病灶：`display:none` 的 item 不再是 grid item，自动放置会把后继 item 整体前移一格——
 * left-closed 态下 `.panel-center` 被放进 0 宽首列，主区塌 0。塌陷后 ChatPanel 的
 * 展开按钮跟着挤到 0 宽，中心点落到邻近元素上 ⇒ **点不回去**，是单向死锁不只是难看。
 * （真机读数：1440 宽收起态 center=0 / 右栏吃掉整条 1fr=1088 / 展开钮中心点命中
 * `.panel-head`；窄窗 900 更彻底——center=right=0，整屏空白。）
 * 位移只在**消失的不是末栏**时发生：右栏 `right-closed` 消失的是末栏，自动放置不位移，
 * 它留下的是另一形态——`grid-template-columns` 里那条 300px track 照旧占位成空列。
 * 那条当前不可达（右栏只能被窄窗媒体查询关掉，而该断点只有两条 track），故本笔不动它。
 *
 * 钉死列位后「哪一栏在哪一列」与该态下有几栏可见解耦——不必给每个隐藏态各写一份列位。
 * 窄窗断点（两条 track）同理成立：右栏在该断点恒为 `right-closed`（`display:none`），
 * `grid-column: 3` 落在不存在的 track 上对不可见元素无副作用，不会生成隐式列。 */
.panel-left {
  grid-column: 1;
}
.panel-center {
  grid-column: 2;
}
.panel-right {
  grid-column: 3;
}

/* 窄窗（<1000px）右栏自动隐藏时同步收窄列——display:none 的 item 不参与布局，
 * 但显式 300px track 仍占位，若不收窄则聊天区被无形压缩（与 narrowMq 同断点） */
@media (max-width: 1000px) {
  .app-layout {
    grid-template-columns: 236px 1fr;
  }
  .app-layout.left-closed {
    grid-template-columns: 0 1fr;
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

/* Panel inner — always flex；左栏收起由 `.panel-left` 的 display:none 承担，
   子组件（SessionList）不再有折叠态分支 */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

/* ─── 52px 图标轨道（根级常驻）──────────── */

.app-rail {
  /* 定宽不吃 flex 伸缩：`flex: none` + 显式宽度。box-sizing 全局 border-box，
     故 1px 右边框含在 52px 内——与 T1 grid track 的列宽逐像素一致。 */
  flex: none;
  width: 52px;
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

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import SessionAgentsPanel from './components/SessionAgentsPanel.vue'
import SettingsView from './views/SettingsView.vue'
import EvaluationView from './views/EvaluationView.vue'
import { useChatStore } from '@/stores/chat'

const store = useChatStore()

/** 全屏设置页 view 切换（无 vue-router，App 级布尔状态）——入口在左侧栏底部齿轮 */
const showSettings = ref(false)

/** 全屏评估中心 view 切换（E4-B，照 SettingsView 同款模式）——入口在左侧栏底部（设置上方） */
const showEval = ref(false)

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

  <!-- app-layout 用 v-show 保活：切设置/评估页不卸载、切回零重建（SessionList 不重跑 onMounted、ChatPanel 不重建）；
       设置/评估页仍 v-if/v-else-if 互斥。副作用是设计内收益：设置页打开期间 socket 事件仍进 store（消息实时进缓存）。 -->
  <div v-show="!showSettings && !showEval" class="app-layout" :class="{ 'left-closed': !leftOpen }">
    <aside class="panel-left">
      <div class="panel-inner">
        <SessionList :collapsed="!leftOpen" @expand="leftOpen = true" />
      </div>
      <!-- 全局入口（Claude Desktop 图标条模式）：评估中心（E4-B）+ 设置——均为全局视图，
           严禁放会话区（ChatPanel）——会话区入口会被误解为单会话配置 -->
      <div class="left-sidebar-footer">
        <button
          class="settings-entry"
          :class="{ 'settings-entry-collapsed': !leftOpen }"
          title="评估中心"
          aria-label="评估中心"
          @click="showEval = true"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2.5 13.5V9M6 13.5V6M9.5 13.5v-5M13 13.5V3"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          <span v-if="leftOpen" class="settings-entry-text">评估</span>
        </button>
        <button
          class="settings-entry"
          :class="{ 'settings-entry-collapsed': !leftOpen }"
          title="设置"
          aria-label="设置"
          @click="showSettings = true"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3" />
            <path
              d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <span v-if="leftOpen" class="settings-entry-text">设置</span>
        </button>
      </div>
    </aside>

    <main class="panel-center">
      <div class="center-content">
        <ChatPanel :left-sidebar-open="leftOpen" @toggle-left-sidebar="toggleLeft" />
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
  grid-template-columns: 260px 1fr 300px;
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

/* Collapsed: 56px icon column（参考 Claude Desktop 图标条）——右栏保持 */
.app-layout.left-closed {
  grid-template-columns: 56px 1fr 300px;
}

/* 窄窗（<1000px）右栏自动隐藏时同步收窄列——display:none 的 item 不参与布局，
 * 但显式 300px track 仍占位，若不收窄则聊天区被无形压缩（与 narrowMq 同断点） */
@media (max-width: 1000px) {
  .app-layout {
    grid-template-columns: 260px 1fr;
  }
  .app-layout.left-closed {
    grid-template-columns: 56px 1fr;
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

/* ─── 左侧栏底部设置入口 ─────────────────── */

.left-sidebar-footer {
  flex-shrink: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--border-subtle);
  /* 评估中心 + 设置两个入口纵向排列 */
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-entry {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.settings-entry:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 折叠态（56px 图标条）：仅图标居中（Claude Desktop 模式） */
.settings-entry-collapsed {
  width: 40px;
  margin: 0 auto;
  justify-content: center;
  padding: 8px 0;
}
</style>

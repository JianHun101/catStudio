<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
import { useChatStore } from '@/stores/chat'

const store = useChatStore()

/** User manually toggled sidebars — once set, auto-hide on narrow windows respects
 *  explicit choice and won't auto-show when the window widens again. */
const leftOpen = ref(true)
const rightOpen = ref(true)
const userToggledLeft = ref(false)
const userToggledRight = ref(false)

function toggleLeft(): void {
  leftOpen.value = !leftOpen.value
  userToggledLeft.value = true
}

function toggleRight(): void {
  rightOpen.value = !rightOpen.value
  userToggledRight.value = true
}

// Media queries for responsive auto-collapse
let narrowMq: MediaQueryList | undefined
let mobileMq: MediaQueryList | undefined

function onNarrow(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledRight.value) {
    rightOpen.value = !e.matches
  }
}
function onMobile(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledLeft.value) {
    leftOpen.value = !e.matches
  }
}

onMounted(() => {
  narrowMq = window.matchMedia('(max-width: 1000px)')
  mobileMq = window.matchMedia('(max-width: 650px)')

  onNarrow(narrowMq)
  onMobile(mobileMq)

  narrowMq.addEventListener('change', onNarrow)
  mobileMq.addEventListener('change', onMobile)
})

onUnmounted(() => {
  narrowMq?.removeEventListener('change', onNarrow)
  mobileMq?.removeEventListener('change', onMobile)
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

  <div class="app-layout" :class="{ 'left-closed': !leftOpen, 'right-closed': !rightOpen }">
    <aside class="panel-left">
      <div class="panel-inner">
        <SessionList :collapsed="!leftOpen" @expand="leftOpen = true" />
      </div>
    </aside>

    <main class="panel-center">
      <div class="center-content">
        <ChatPanel
          :left-sidebar-open="leftOpen"
          :right-sidebar-open="rightOpen"
          @toggle-left-sidebar="toggleLeft"
          @toggle-right-sidebar="toggleRight"
        />
      </div>
    </main>

    <aside class="panel-right">
      <div class="panel-inner">
        <AgentPanel :collapsed="!rightOpen" @expand="rightOpen = true" />
      </div>
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
  transition: grid-template-columns 0.2s ease;
}

/* Collapsed: 56px icon column（参考 Claude Desktop 图标条） */
.app-layout.left-closed {
  grid-template-columns: 56px 1fr 300px;
}
.app-layout.right-closed {
  grid-template-columns: 260px 1fr 56px;
}
.app-layout.left-closed.right-closed {
  grid-template-columns: 56px 1fr 56px;
}

/* ─── Panels ─────────────────────────────── */

.panel-left,
.panel-right {
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-left {
  border-right: 1px solid var(--border-subtle);
}

.panel-right {
  border-left: 1px solid var(--border-subtle);
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

/* Panel inner — always flex, collapsed mode handled by child component */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>

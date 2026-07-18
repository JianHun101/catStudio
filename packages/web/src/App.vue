<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import AgentPanel from './components/AgentPanel.vue'

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
  <div class="app-layout" :class="{ 'left-closed': !leftOpen, 'right-closed': !rightOpen }">
    <aside class="panel-left" :class="{ closed: !leftOpen }">
      <div class="panel-inner">
        <SessionList />
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

    <aside class="panel-right" :class="{ closed: !rightOpen }">
      <div class="panel-inner">
        <AgentPanel />
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ─── Layout Grid ────────────────────────── */

.app-layout {
  display: grid;
  grid-template-columns: 260px 1fr 300px;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  transition: grid-template-columns 0.25s ease;
}

.app-layout.left-closed {
  grid-template-columns: 0px 1fr 300px;
}

.app-layout.right-closed {
  grid-template-columns: 260px 1fr 0px;
}

.app-layout.left-closed.right-closed {
  grid-template-columns: 0px 1fr 0px;
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
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  overflow: hidden;
}

/* Panel inner — hidden when closed */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.panel-left.closed .panel-inner,
.panel-right.closed .panel-inner {
  display: none;
}
</style>

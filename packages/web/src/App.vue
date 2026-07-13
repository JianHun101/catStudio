<script setup lang="ts">
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
</script>

<template>
  <div class="app-layout">
    <aside class="panel-left">
      <SessionList />
    </aside>
    <main class="panel-center">
      <ChatPanel />
    </main>
    <aside class="panel-right">
      <AgentPanel />
    </aside>
  </div>
</template>

<style scoped>
.app-layout {
  display: grid;
  grid-template-columns: 260px 1fr 300px;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.panel-left {
  background: var(--bg-base);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.panel-center {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-deep);
}

.panel-right {
  background: var(--bg-base);
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
</style>

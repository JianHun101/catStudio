<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Agent 状态标签叶子组件——把 ChatPanel 顶层的 1s 平滑 tick 隔离到此处。
 *
 * 根因（回归修复 Part 1）：ChatPanel 顶层 `now` ref 每秒变一次 → 整个 ChatPanel 重渲
 * → v-for 满屏消息的 renderMarkdown 全部重算（CPU 密集、无记忆化）。把每秒变化的 ref
 * 收敛进这个叶子组件后，tick 只重渲这一个 span，消息列表不再被 1s tick 拖着重渲。
 */
const props = defineProps<{
  entry: { status: string; startedAt?: number; lastBeatAt?: number }
}>()

// ─── 回复中运行时长（平滑 + liveness）────────────────────────
// 本地 1s tick：now 每秒更新驱动「回复中 · 已 N 秒」重算（服务端心跳 10s 一跳太粗，
// 用户真机反馈「10 秒动一下」要平滑——反转上单「省一个 timer」取舍，代价是必须正确
// 管理 timer 生命周期，onUnmounted 必 clear）。now 用 ref 而非 label 里直接 Date.now()，
// tick 更新 now.value 触发响应式重渲染。
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
// 心跳失联阈值：2×10s 服务端间隔 + 5s 余量。超过仍未收到 replying 心跳 → 判定 server
// 已死，停止递增、显示「无响应」——本地时钟不能掩盖进程死亡（liveness 语义不能丢）。
const HEARTBEAT_STALE_MS = 25_000

onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (nowTimer) {
    clearInterval(nowTimer)
    nowTimer = null
  }
})

const label = computed<string>(() => {
  switch (props.entry.status) {
    case 'queued':
      return '已收到'
    case 'thinking':
      return '思考中'
    case 'replying':
      // headless 黑盒适配器（dsh 等）整轮不 yield chunk，AGENT_TYPING 全程空转。
      // 带 startedAt 时算运行时长：服务端 10s 心跳重发 MESSAGE_AGENT_STATUS 只负责
      // 刷新 lastBeatAt（liveness 锚点），秒数由本地 1s tick 的 now 重算——每秒平滑
      // 递增（反转上单「10s 一跳」取舍）。
      if (props.entry.startedAt != null) {
        // 心跳失联：replying 心跳（10s 间隔）超阈值未到 → server 已死，停止递增、
        // 显示「无响应」——不能靠本地时钟把死进程显示成「还在跑」。
        if (
          props.entry.lastBeatAt != null &&
          now.value - props.entry.lastBeatAt > HEARTBEAT_STALE_MS
        ) {
          return '无响应'
        }
        const secs = Math.max(0, Math.floor((now.value - props.entry.startedAt) / 1000))
        return `回复中 · 已 ${secs} 秒`
      }
      return '回复中'
    case 'done':
      return '完成'
    default:
      return props.entry.status
  }
})
</script>

<template>
  <span class="status-label">{{ label }}</span>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Agent 状态标签叶子组件——把用户消息状态行上的 1s 平滑 tick 隔离到此处。
 *
 * 根因（回归修复 Part 1）：ChatPanel 顶层 `now` ref 每秒变一次 → 整个 ChatPanel 重渲
 * → v-for 满屏消息的 renderMarkdown 全部重算（CPU 密集、无记忆化）。把每秒变化的 ref
 * 收敛进这个叶子组件后，tick 只重渲这一个 span，消息列表不再被 1s tick 拖着重渲。
 *
 * 口径变更（Agent 回复计时上气泡）：**秒数不再由本组件显示**——计时唯一权威位是
 * Agent 自己的气泡 footer（`ReplyElapsed.vue`），A2A / headless 执行没有用户消息状态行，
 * 挂在这里就漏一半。本组件只留状态文字与停止按钮；tick 保留是因为「无响应」翻转
 * 仍要按秒推进（10s 心跳失联 25s 后要自动从「回复中」翻成「无响应」，不能等下一次事件）。
 */
const props = defineProps<{
  entry: { status: string; lastBeatAt?: number }
}>()

// 本地 1s tick：驱动「无响应」翻转（心跳失联超阈值需要按秒判定，服务端事件不再到来）
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
// 心跳失联阈值：2×10s 服务端间隔 + 5s 余量。超过仍未收到 replying 心跳 → 判定 server
// 已死，显示「无响应」——本地时钟不能掩盖进程死亡（liveness 语义不能丢）。
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
      // 心跳失联：replying 心跳（10s 间隔）超阈值未到 → server 已死；不能靠本地时钟
      // 把死进程显示成「还在跑」。时长不在此显示——见气泡 footer 的 ReplyElapsed。
      if (
        props.entry.lastBeatAt != null &&
        now.value - props.entry.lastBeatAt > HEARTBEAT_STALE_MS
      ) {
        return '无响应'
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

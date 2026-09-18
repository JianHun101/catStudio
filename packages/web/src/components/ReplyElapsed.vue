<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Agent 回复计时叶子组件——气泡 footer 的「回复中 · 已 N 秒」。
 *
 * 为什么要独立成叶子（渲染纪律，与 `AgentStatusLabel` 同源）：计时每秒变一次，
 * 若把这份响应式状态放在 ChatPanel 顶层，整个面板每秒重渲 → 满屏历史消息的
 * markdown 全部重算。把每秒变化的 `now` 收敛进本组件后，tick 只重渲这一个 span。
 * `ChatPanel.test.ts` 有静态断言守门（顶层不得出现每秒变化的 ref）。
 *
 * 数据来源：`store.replyTimers`（agentId 键控）——`startedAt` 是**服务端**给的执行起点，
 * 不是本地首次渲染时刻。因此刷新页面 / 切会话回来时，下一个心跳（10s 内）到达即恢复
 * 原秒数，不会归零。
 *
 * liveness 语义照抄 `AgentStatusLabel`：心跳（10s 一跳）失联超阈值 → 停走并显示
 * 「无响应」——本地时钟不能把已经死掉的进程显示成「还在跑」。
 */
const props = defineProps<{
  /** 执行起点时间戳（epoch ms，服务端执行入口取值） */
  startedAt: number
  /** 最后一次收到执行事件的客户端接收时刻（epoch ms，liveness 锚点） */
  lastBeatAt: number
}>()

// 本地 1s tick：服务端心跳 10s 一跳太粗（用户真机反馈「10 秒动一下」要平滑），
// 秒数由本地 tick 重算。now 用 ref 而非 label 里直接 Date.now()，否则不触发重渲染。
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
// 心跳失联阈值：2×10s 服务端间隔 + 5s 余量（与 AgentStatusLabel 同值）。
const HEARTBEAT_STALE_MS = 25_000

onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  // timer 生命周期是「每秒平滑」取舍的代价，必须显式清（组件随气泡卸载）
  if (nowTimer) {
    clearInterval(nowTimer)
    nowTimer = null
  }
})

/** 心跳失联 = server 已死（或 socket 断），停止递增 */
const stale = computed(() => now.value - props.lastBeatAt > HEARTBEAT_STALE_MS)

/** 时长文案：<60s「N 秒」；≥60s「M:SS」（用户拍板——192 秒不如 3:12 好读） */
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs} 秒`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const label = computed<string>(() => {
  if (stale.value) return '无响应'
  const secs = Math.max(0, Math.floor((now.value - props.startedAt) / 1000))
  return `回复中 · 已 ${formatElapsed(secs)}`
})
</script>

<template>
  <span class="reply-elapsed" :class="{ stale }">{{ label }}</span>
</template>

<style scoped>
/* 与 .streaming-indicator / .msg-footer-info 同视觉层级；tabular-nums 防秒数跳动时抖动 */
.reply-elapsed {
  font-size: 10px;
  color: var(--accent);
  opacity: 0.8;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 心跳失联：红字 + 提高对比（无响应是告警，不该继续以弱化色呈现） */
.reply-elapsed.stale {
  color: var(--accent-red);
  opacity: 1;
}
</style>

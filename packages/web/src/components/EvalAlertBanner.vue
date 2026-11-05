<script setup lang="ts">
/**
 * 全局评估告警横幅（自包含、无 props）。
 *
 * 数据源 = `GET /api/eval/l1-metrics` 的 `breaches`（服务端已按样本门分档）。
 * **不落会话、不读 messages**——旧「每会话播报一条系统消息」已退役，本横幅是
 * 评估告警唯一的用户可见面。挂载拉一次 + 60s 轮询 + 回前台补拉；卸载全清。
 *
 * 关闭语义是「按签名关闭」：签名 = 每条破线的 key + 数值（3 位小数）。数值变了
 * 签名就变，横幅会重新出现——关掉一次不等于永久静音。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, type ThresholdBreach } from '@/composables/useApi'

const emit = defineEmits<{ (e: 'open-eval'): void }>()

const DISMISS_KEY = 'catstudy.eval-alert.dismissed'
const POLL_MS = 60_000

/** 破线项的静态指引——不查库、不做归因；更精确的归因是另一张票的事 */
const GUIDANCE: Record<ThresholdBreach['key'], string> = {
  successRate: '看失败执行的 error_type，定位失败集中在哪只猫或哪条链。',
  timeoutRate: '看耗时分布，确认超时是否集中在个别长任务。',
  reworkRate: '去链路 tab 看返工集中在哪几条链。',
}

const breaches = ref<ThresholdBreach[]>([])
/** 已关闭的签名（null = 没关过） */
const dismissedSignature = ref<string | null>(readDismissed())
let timer: ReturnType<typeof setInterval> | null = null
let disposed = false

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY)
  } catch {
    // 隐私模式 / 禁用存储：当作没关过，横照样显示
    return null
  }
}

function writeDismissed(sig: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, sig)
  } catch {
    // 写不进去不影响本次关闭（内存态已生效）
  }
}

function signatureOf(items: ThresholdBreach[]): string {
  return items.map((b) => `${b.key}:${b.value.toFixed(3)}`).join('|')
}

const signature = computed(() => signatureOf(breaches.value))
const visible = computed(
  () => breaches.value.length > 0 && signature.value !== dismissedSignature.value
)

async function refresh(): Promise<void> {
  try {
    const res = await api.getEvalL1Metrics()
    if (disposed) return
    breaches.value = Array.isArray(res.breaches) ? res.breaches : []
  } catch {
    // 横幅是旁路：读失败保持现状，不弹错误、不白屏
  }
}

function dismiss(): void {
  const sig = signature.value
  dismissedSignature.value = sig
  writeDismissed(sig)
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') void refresh()
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  disposed = true
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div v-if="visible" class="eval-alert" role="status">
    <div class="eval-alert-main">
      <span class="eval-alert-title">📊 评估告警</span>
      <div class="eval-alert-items">
        <div v-for="b in breaches" :key="b.key" class="eval-alert-item">
          <span class="eval-alert-text">{{ b.text }}</span>
          <span class="eval-alert-guide">{{ GUIDANCE[b.key] }}</span>
        </div>
      </div>
    </div>
    <div class="eval-alert-actions">
      <button class="eval-alert-open" @click="emit('open-eval')">去评估中心</button>
      <button class="eval-alert-close" title="关闭" aria-label="关闭评估告警" @click="dismiss">
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
.eval-alert {
  position: fixed;
  top: 8px;
  left: 64px;
  right: 16px;
  z-index: 70;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--bg-elevated, #fff);
  border: 1px solid var(--status-warn, #e0a800);
  box-shadow: 0 6px 20px rgb(0 0 0 / 12%);
  font-size: 12.5px;
  color: var(--text-primary, #222);
}

.eval-alert-main {
  flex: 1;
  min-width: 0;
}

.eval-alert-title {
  display: inline-block;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--status-warn, #b07a00);
}

.eval-alert-items {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.eval-alert-item {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.eval-alert-text {
  font-weight: 500;
}

.eval-alert-guide {
  color: var(--text-secondary, #666);
  font-size: 12px;
}

.eval-alert-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.eval-alert-open {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--status-warn, #e0a800);
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.eval-alert-open:hover {
  background: var(--accent-soft, #fff6e0);
}

.eval-alert-close {
  border: none;
  background: transparent;
  color: var(--text-secondary, #888);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
}

.eval-alert-close:hover {
  color: var(--text-primary, #222);
}
</style>

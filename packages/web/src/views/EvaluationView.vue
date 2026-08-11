<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  api,
  type EvalScoreRow,
  type ScoreAggregate,
  type PendingReviewScore,
  type EpisodeStats,
} from '@/composables/useApi'

/**
 * 全屏评估中心（E4-B，左侧栏底部入口进入，无 vue-router 的 App 级 view 切换）。
 * 双 tab（用户看得懂是硬要求）：
 *   - 观察：评分列表 + 按猫聚合卡片 + 任务结局分布（episodes 7 类计数 + 办成率）
 *   - 回标：低分样本卡（回复全文 + 上下文折叠 + 1-5 分单选 + 评语）→ 提交移出待回标 + 角标减一
 * 契约：消费 E4-A 后端四接口 + episode-stats（契约缺口裁决补充的只读路由）；
 * 办成率口径店长钉死：(success + corrected_success) / Σ(uRoot 已分类)，open 不计分母。
 * 纯展示 + 回标写入，零 LLM 调用。
 */
const emit = defineEmits<{ close: [] }>()

const activeTab = ref<'observe' | 'review'>('observe')

// ─── 观察 tab ─────────────────────────────
const scores = ref<EvalScoreRow[]>([])
const aggregates = ref<ScoreAggregate[]>([])
const stats = ref<EpisodeStats | null>(null)
const observeLoading = ref(true)
const observeError = ref('')

// ─── 回标 tab ─────────────────────────────
const pending = ref<PendingReviewScore[]>([])
const pendingLoading = ref(true)
const pendingError = ref('')
/** 每张样本卡独立的评分/评语状态（共享会串卡——A 卡选的分数显示到 B 卡） */
const reviewState = ref<Record<string, { score: number; comment: string }>>({})
const submittingId = ref<string | null>(null)
const submitError = ref('')

/** 组件卸载（评估中心关闭）后停止写 ref——防写已卸载组件的警告 */
let disposed = false

// ─── 任务结局（E2/E3 规格 §4：U 根任务结局 7 类全集）─────────
const OUTCOME_LABELS: Record<string, string> = {
  success: '成功',
  corrected_success: '修正后成功',
  needs_investigation: '需调查',
  harness_fix_needed: '机制需修',
  routing_failure: '路由失败',
  abandoned: '放弃',
  unclassified: '未分类',
}
const OUTCOME_ORDER = [
  'success',
  'corrected_success',
  'needs_investigation',
  'harness_fix_needed',
  'routing_failure',
  'abandoned',
  'unclassified',
]

/** U 根已分类任务总数（open 不计入——未定论任务不算成败，店长裁决口径） */
const totalClassified = computed(() => {
  const s = stats.value
  if (!s) return 0
  return OUTCOME_ORDER.reduce((sum, k) => sum + (s.uRoot[k] || 0), 0)
})

/** 办成率 %：(success + corrected_success) / Σ uRoot 已分类；无已分类任务 → null（不显示） */
const doneRate = computed(() => {
  const s = stats.value
  if (!s || totalClassified.value === 0) return null
  const done = (s.uRoot['success'] || 0) + (s.uRoot['corrected_success'] || 0)
  return Math.round((done / totalClassified.value) * 100)
})

/** 结局条形分段宽度（相对已分类总数） */
function outcomePct(key: string): string {
  const s = stats.value
  if (!s || totalClassified.value === 0) return '0%'
  const cnt = s.uRoot[key] || 0
  return `${Math.round((cnt / totalClassified.value) * 100)}%`
}

const pendingBadge = computed(() => pending.value.length)

/** 样本卡独立状态惰性初始化 */
function stateFor(id: string): { score: number; comment: string } {
  if (!reviewState.value[id]) {
    reviewState.value[id] = { score: 3, comment: '' }
  }
  return reviewState.value[id]
}

function scoreLabel(n: number): string {
  return ['很差', '较差', '一般', '不错', '很好'][n - 1] || String(n)
}

function sampleReasonLabel(r: string): string {
  const map: Record<string, string> = { low_score: '低分样本', user_feedback: '已回标' }
  return map[r] || r
}

function timeShort(ts: string): string {
  return ts.length >= 16 ? ts.slice(0, 16).replace('T', ' ') : ts
}

/** 观察 tab 三份数据并行拉取（Promise.all——互不依赖，失败任一 → 整区错误态） */
async function loadObserve(): Promise<void> {
  observeLoading.value = true
  observeError.value = ''
  try {
    const [scoresRes, aggRes, statsRes] = await Promise.all([
      api.getEvalScores(50),
      api.getEvalAggregates(),
      api.getEvalEpisodeStats(),
    ])
    if (disposed) return
    scores.value = scoresRes.scores
    aggregates.value = aggRes.aggregates
    stats.value = statsRes.stats
  } catch (err: any) {
    if (!disposed) observeError.value = err.message || '评估数据加载失败'
  } finally {
    if (!disposed) observeLoading.value = false
  }
}

async function loadPending(): Promise<void> {
  pendingLoading.value = true
  pendingError.value = ''
  try {
    const res = await api.getEvalPending()
    if (disposed) return
    pending.value = res.pending
  } catch (err: any) {
    if (!disposed) pendingError.value = err.message || '待回标样本加载失败'
  } finally {
    if (!disposed) pendingLoading.value = false
  }
}

/** 提交回标 → 成功即从列表移除（角标自动减一），失败保留样本卡 + 错误提示 */
async function submitReview(id: string): Promise<void> {
  submitError.value = ''
  submittingId.value = id
  try {
    const st = stateFor(id)
    await api.submitEvalReview(id, {
      score: st.score,
      comment: st.comment.trim() || undefined,
    })
    pending.value = pending.value.filter((p) => p.id !== id)
    delete reviewState.value[id]
  } catch (err: any) {
    submitError.value = err.message || '回标提交失败'
  } finally {
    submittingId.value = null
  }
}

onMounted(() => {
  loadObserve()
  loadPending()
})
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <div class="eval-view" role="dialog" aria-modal="true" aria-label="评估中心">
    <header class="eval-header">
      <div class="eval-title">
        <span class="eval-icon">📊</span>
        <h2>评估中心</h2>
      </div>
      <button class="btn-close" title="关闭" aria-label="关闭" @click="emit('close')">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4 4l10 10M14 4l-10 10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <div class="eval-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'observe' }"
        @click="activeTab = 'observe'"
      >
        观察
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'review' }"
        @click="activeTab = 'review'"
      >
        回标
        <span v-if="pendingBadge > 0" class="tab-badge">{{ pendingBadge }}</span>
      </button>
    </div>

    <!-- ─── 观察 tab ─────────────────────── -->
    <div v-show="activeTab === 'observe'" class="eval-pane">
      <div v-if="observeLoading" class="list-hint">
        <span class="status-spinner"></span> 加载中…
      </div>
      <div v-else-if="observeError" class="error-msg">
        {{ observeError }}
        <button class="btn-retry-sm" @click="loadObserve">重试</button>
      </div>
      <template v-else>
        <div class="section-title">聚合统计</div>
        <div v-if="aggregates.length === 0" class="list-hint">
          暂无评分数据——评估采样开启后这里会出现每只猫的评分统计
        </div>
        <div v-else class="agg-grid">
          <div v-for="a in aggregates" :key="a.agent_id || '?'" class="agg-card">
            <span class="agg-name">{{ a.agent_name || '未知猫' }}</span>
            <div class="agg-stats">
              <span class="agg-item">样本 {{ a.count }}</span>
              <span class="agg-item">均分 {{ a.avg_score }}</span>
              <span class="agg-item" :class="{ 'agg-bad': a.low_score_rate > 0 }">
                低分率 {{ Math.round(a.low_score_rate * 100) }}%
              </span>
            </div>
          </div>
        </div>

        <div class="section-title">任务结局分布</div>
        <div v-if="totalClassified === 0 && !stats?.open" class="list-hint">暂无已分类任务</div>
        <div v-else class="outcome-card">
          <div class="outcome-bar">
            <div
              v-for="k in OUTCOME_ORDER"
              :key="k"
              class="outcome-seg"
              :class="`outcome-${k}`"
              :style="{ width: outcomePct(k) }"
              :title="`${OUTCOME_LABELS[k]} ${stats?.uRoot[k] || 0}`"
            />
          </div>
          <div class="outcome-legend">
            <span v-for="k in OUTCOME_ORDER" :key="k" class="legend-item">
              <i class="legend-dot" :class="`dot-${k}`"></i>
              {{ OUTCOME_LABELS[k] }} {{ stats?.uRoot[k] || 0 }}
            </span>
            <span class="legend-item legend-open">
              <i class="legend-dot dot-open"></i> 未定论 {{ stats?.open || 0 }}
            </span>
          </div>
          <div v-if="doneRate !== null" class="done-rate">
            办成率 <b>{{ doneRate }}%</b>
            <span class="hint">（成功 + 修正后成功）/ 已分类任务，未定论不计入</span>
          </div>
        </div>

        <div class="section-title">最近评分</div>
        <div v-if="scores.length === 0" class="list-hint">暂无评分记录</div>
        <div v-else class="score-list">
          <div v-for="s in scores" :key="s.id" class="score-row">
            <span class="score-name">{{ s.agent_name || '未知猫' }}</span>
            <span class="score-num" :class="{ 'score-low': s.score <= 2 }">{{ s.score }}</span>
            <span class="score-reason">{{ sampleReasonLabel(s.sample_reason) }}</span>
            <span class="score-time">{{ timeShort(s.created_at) }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- ─── 回标 tab ─────────────────────── -->
    <div v-show="activeTab === 'review'" class="eval-pane">
      <div v-if="pendingLoading" class="list-hint">
        <span class="status-spinner"></span> 加载中…
      </div>
      <div v-else-if="pendingError" class="error-msg">
        {{ pendingError }}
        <button class="btn-retry-sm" @click="loadPending">重试</button>
      </div>
      <div v-else-if="pending.length === 0" class="list-hint">
        没有待回标样本——低分样本经人工回标后移出此列表
      </div>
      <div v-else class="pending-list">
        <div v-for="p in pending" :key="p.id" class="sample-card">
          <div class="sample-head">
            <span class="score-name">{{ p.agent_name || '未知猫' }}</span>
            <span class="score-num score-low">{{ p.score }} 分</span>
            <span class="score-time">{{ timeShort(p.reply_created_at) }}</span>
          </div>
          <div class="sample-reply">{{ p.reply_content }}</div>
          <details class="sample-context">
            <summary>查看上下文（{{ p.context.length }} 条）</summary>
            <div v-for="c in p.context" :key="c.id" class="ctx-line">
              <span class="ctx-role">{{ c.role === 'user' ? '用户' : '猫' }}</span>
              <span class="ctx-text">{{ c.content }}</span>
            </div>
          </details>
          <div class="sample-actions">
            <div class="score-picker" role="radiogroup" :aria-label="`评分 ${p.id}`">
              <button
                v-for="n in 5"
                :key="n"
                type="button"
                class="score-btn"
                :class="{ active: stateFor(p.id).score === n }"
                :aria-checked="stateFor(p.id).score === n"
                role="radio"
                @click="stateFor(p.id).score = n"
              >
                {{ n }}
              </button>
              <span class="score-label">{{ scoreLabel(stateFor(p.id).score) }}</span>
            </div>
            <input
              v-model="stateFor(p.id).comment"
              class="input"
              placeholder="评语（可选）"
              @keydown.enter="submitReview(p.id)"
            />
            <button
              class="btn-submit"
              :disabled="submittingId === p.id"
              @click="submitReview(p.id)"
            >
              {{ submittingId === p.id ? '提交中…' : '提交回标' }}
            </button>
          </div>
        </div>
        <div v-if="submitError" class="error-msg">{{ submitError }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ─── 全屏评估中心 ──────────────────────── */

.eval-view {
  position: fixed;
  inset: 0;
  z-index: 600; /* 低于 error-toast(9999)，与设置页同层 */
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}

.eval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.eval-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.eval-title h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.eval-icon {
  font-size: 18px;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: all var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* ─── Tab 栏 ────────────────────────────── */

.eval-tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.tab-btn {
  position: relative;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  padding: 10px 14px;
  cursor: pointer;
  transition: all var(--ease-out);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* 待回标角标（提交成功样本移出 → 角标减一） */
.tab-badge {
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg-deep);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.eval-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px 32px;
  max-width: 860px;
}

/* ─── 通用区块 ──────────────────────────── */

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.section-title + .section-title {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

.status-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: -3px;
  margin-right: 6px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin-top: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.btn-retry-sm {
  padding: 4px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-retry-sm:hover {
  background: var(--accent);
  color: var(--bg-deep);
}

/* ─── 聚合卡片 ──────────────────────────── */

.agg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}

.agg-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agg-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.agg-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.agg-item {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 2px 9px;
}

.agg-bad {
  color: var(--accent-red);
  border-color: rgba(224, 85, 106, 0.3);
}

/* ─── 任务结局分布 ──────────────────────── */

.outcome-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 22px;
}

.outcome-bar {
  display: flex;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-surface);
}

.outcome-seg {
  height: 100%;
  transition: width var(--ease-out);
}

.outcome-success {
  background: #3ecf8e;
}
.outcome-corrected_success {
  background: #67c6a0;
}
.outcome-needs_investigation {
  background: #f2b84a;
}
.outcome-harness_fix_needed {
  background: #e8794a;
}
.outcome-routing_failure {
  background: #e0556a;
}
.outcome-abandoned {
  background: #9a8ab0;
}
.outcome-unclassified {
  background: #6b7a8f;
}

.outcome-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: #6b7a8f;
}

.dot-success {
  background: #3ecf8e;
}
.dot-corrected_success {
  background: #67c6a0;
}
.dot-needs_investigation {
  background: #f2b84a;
}
.dot-harness_fix_needed {
  background: #e8794a;
}
.dot-routing_failure {
  background: #e0556a;
}
.dot-abandoned {
  background: #9a8ab0;
}
.dot-unclassified {
  background: #6b7a8f;
}
.dot-open {
  background: var(--border-default);
}

.done-rate {
  font-size: 12px;
  color: var(--text-secondary);
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}

.done-rate b {
  font-size: 15px;
  color: #3ecf8e;
  margin: 0 4px;
}

.done-rate .hint {
  font-size: 10px;
  color: var(--text-muted);
}

/* ─── 评分列表 ──────────────────────────── */

.score-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.score-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
}

.score-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}

.score-num {
  font-size: 12px;
  font-weight: 700;
  color: #3ecf8e;
  flex-shrink: 0;
  min-width: 22px;
}

.score-low {
  color: var(--accent-red);
}

.score-reason {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  padding: 1px 8px;
  border-radius: 999px;
}

.score-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ─── 回标样本卡 ────────────────────────── */

.pending-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sample-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sample-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sample-reply {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}

.sample-context {
  font-size: 12px;
  color: var(--text-secondary);
}

.sample-context summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 0;
}

.ctx-line {
  display: flex;
  gap: 8px;
  padding: 5px 0;
  border-top: 1px dashed var(--border-subtle);
}

.ctx-role {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
  min-width: 28px;
}

.ctx-text {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-word;
  line-height: 1.5;
}

.sample-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.score-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 3px;
  background: var(--bg-surface);
}

.score-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.score-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.score-btn.active {
  background: var(--accent);
  color: var(--bg-deep);
}

.score-label {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 0 6px;
}

.sample-actions .input {
  flex: 1;
  min-width: 140px;
  padding: 7px 11px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.sample-actions .input:focus {
  border-color: var(--accent);
}

.btn-submit {
  padding: 7px 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--bg-deep);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-submit:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-submit:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

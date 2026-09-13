<script setup lang="ts">
/**
 * 单条历史消息的气泡（消息列表的渲染边界）。
 *
 * 抽出的唯一目的：**把「一个流式 chunk 重渲染 N 条历史消息」变成 O(1)**。Vue 的更新
 * 传播是组件粒度——父组件重渲染时本组件 props 未变则整棵子树跳过。因此契约是硬性的：
 * **所有依赖整个消息数组或下标的判定（分组、日期分隔、是否最新用户消息、发送者/头像/
 * 模型名/token 文案/撤回与重启态）都由 ChatPanel 算成标量传入**；本组件内若再做一次
 * `activeMessages.filter(...)`，抽取即失效。
 *
 * 两处结构性优化与抽取同源：
 * · **折叠块收起时不渲染内容体**（受控 open 态 + v-if 门控）——`<details :open="false">`
 *   的内容过去照样进 DOM、照样 parse，是「历史 thinking 全量重算」的第二大来源。
 * · **markdown 走 computed**（依赖追踪自带缓存）——取代父组件过去手写的
 *   `markdownCache` Map（键拼整条正文、无淘汰、无界增长）。
 */
import { computed, ref } from 'vue'
import type { Message, ToolCallInfo } from '@cat-study/shared'
import { useChatStore, type AgentStatusEntry } from '@/stores/chat'
import { renderMarkdown } from '@/utils/markdown'
import { resolveDisplayPlaceholders } from '@/utils/rolePlaceholders'
import { isAgentStoppable, toolAreaSummary } from '@/utils/tools'
import DiffViewer from './DiffViewer.vue'
import AgentStatusLabel from './AgentStatusLabel.vue'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  msg: Message
  /** 与前一条消息合并显示（同发送者 + 2 分钟内）——由父组件按下标算出 */
  grouped: boolean
  /** 是否本会话最后一条用户消息（撤回按钮显隐） */
  isLatestUser: boolean
  avatar: string
  senderName: string
  /** footer：{模型} · {n}k/{m}k tokens 文案（父组件已格式化） */
  modelName: string
  tokensText: string
  /** footer 用量色阶（阈值来自配置，父组件判定） */
  contextLevel: 'critical' | 'warn' | ''
  /** footer 执行元数据文案（execution_logs 落库稳定值；无则 null） */
  execMetaText: string | null
  /** footer 耗时兜底文案（durationMs 瞬态广播；无则 null） */
  durationText: string | null
  /** 时间文案（父组件已格式化） */
  timeText: string
  /** 本条消息触发/关联的 agent 状态行（父组件从 messageStatus 取） */
  statusEntries: AgentStatusEntry[]
  restartState: 'pending' | 'confirmed' | 'none'
  restartConfirming: boolean
  retractConfirming: boolean
}>()

const emit = defineEmits<{
  previewImages: [images: string[], index: number]
  retract: [msgId: string]
  stopAgent: [agentId: string]
  confirmRestart: [msgId: string]
  cancelRestart: [msgId: string]
}>()

const store = useChatStore()

// ─── 折叠块受控开合（L2：收起时不渲染内容体）──────────
/** 历史折叠块默认收起；展开态由本组件持有（父组件零参与） */
const foldOpen = ref(false)

/** 原生 details 的 toggle → 同步受控态（用户点 summary、或程序改 open 属性都会触发，幂等） */
function onFoldToggle(e: Event): void {
  foldOpen.value = (e.target as HTMLDetailsElement).open
}

/**
 * 正文内容：新消息（segments 落库）取最后一个 text 段（= 最终回复，其余 text 段由
 * foldEntries 收进折叠块）；无 segments 老消息退化渲染整列 content。
 */
function finalTextContent(msg: Message): string {
  if (msg.segments?.length) {
    for (let i = msg.segments.length - 1; i >= 0; i--) {
      const s = msg.segments[i]
      if (s.kind === 'text') return s.content
    }
  }
  return msg.content
}

/** 正文 html——内容或 store/reviewer 角色名变化才重算（占位符替换依赖后者） */
const bodyHtml = computed(() =>
  renderMarkdown(resolveDisplayPlaceholders(finalTextContent(props.msg), store.agents))
)

/** 老消息退化路径的思考 blob html（[思考] 前缀仅旧库数据带，含前缀才剥） */
const thinkingHtml = computed(() => {
  const tc = props.msg.thinkingContent ?? ''
  const raw = tc.includes('[思考]') ? tc.replace(/\[思考\]\s*/g, '') : tc
  return renderMarkdown(raw)
})

// ─── 历史折叠块交错还原（segments 落库后）──────────────────
// 生成期前端看到的时间交错顺序（thinking 推理 ↔ 工具执行）在落库前只有 segments 数组持有——
// 此前 insertAgentMessage 只写 thinking_content/tool_content 两独立列、交错序落库即丢，
// 历史折叠块只能「思考 blob + 工具列表」两块堆叠。segments 落库后历史渲染按它还原生成期
// 顺序；老消息无 segments 走 thinkingContent+toolContent 退化路径。

/** 折叠块内条目：thinking 段直接透传（纯思考文本）；tool 段按 id join msg.toolContent
 *  补 io（流式 segments 里 tool 轻量仅 id/name/status，io 只进落库的 tool_content，
 *  防 typing socket 膨胀）。text 段由 msg-text 外层渲染，折叠块内跳过。
 *  判别式 union——模板 v-if/v-else 分支窄化后 vue-tsc 可验证属性访问。 */
type StoredFoldEntry = { kind: 'thinking'; content: string } | { kind: 'tool'; tool: ToolCallInfo }

/**
 * 有 msg.segments（新消息）→ 返回按时间序交错的条目；无 segments（老消息）→ null
 * （模板退化 thinking blob + tool 列表两块）。tool_content 与 segments tool 段保持
 * 同序（upsertTool/mergeToolSegment 均按首次出现位归并），按 id join 不回退乱序。
 */
function computeStoredFoldEntries(msg: Message): StoredFoldEntry[] | null {
  if (!msg.segments?.length) return null
  const byId = new Map<string, ToolCallInfo>()
  // id 缺失的工具（上游缺 id 罕见场景）：按 name 与首现序 fallback 取 io，避免
  // 「有 io 却永远展开不了」——同一 name 多次调用时 id 恒在，fallback 实际不可达
  const idlessByName: ToolCallInfo[] = []
  for (const t of msg.toolContent ?? []) {
    if (t.id != null) byId.set(t.id, t)
    else idlessByName.push(t)
  }
  // 点1：最后一个 text 段（= 最终回复）由外层 msg-text 渲染，其余 text 段（中间叙述）
  // 按 thinking 收进折叠框——与 buildStreamItems 的"只留最后 text"判定保持一致
  let lastTextIndex = -1
  for (let i = 0; i < msg.segments.length; i++) {
    if (msg.segments[i].kind === 'text') lastTextIndex = i
  }
  const entries: StoredFoldEntry[] = []
  for (let i = 0; i < msg.segments.length; i++) {
    const seg = msg.segments[i]
    if (seg.kind === 'text') {
      if (i === lastTextIndex) continue // 最后一个 text 段（最终回复）由外层 msg-text 渲染
      if (!seg.content) continue
      entries.push({ kind: 'thinking', content: seg.content })
      continue
    }
    if (seg.kind === 'thinking') {
      if (!seg.content) continue
      entries.push({ kind: 'thinking', content: seg.content })
    } else if (seg.kind === 'tool' && seg.tool) {
      const t = seg.tool
      let full: ToolCallInfo | undefined
      if (t.id != null) {
        full = byId.get(t.id)
      } else {
        const ni = idlessByName.findIndex((x) => x.name === t.name)
        if (ni >= 0) full = idlessByName.splice(ni, 1)[0]
      }
      entries.push({ kind: 'tool', tool: full ?? t })
    }
  }
  return entries.length > 0 ? entries : null
}

/** 折叠块渲染条目：thinking 段的 markdown 在此算成 html（含 computed 缓存，不随重渲染重算） */
type FoldEntryView = { kind: 'thinking'; html: string } | { kind: 'tool'; tool: ToolCallInfo }

const foldEntries = computed<FoldEntryView[] | null>(() => {
  const entries = computeStoredFoldEntries(props.msg)
  if (!entries) return null
  return entries.map((e) =>
    e.kind === 'thinking' ? { kind: 'thinking' as const, html: renderMarkdown(e.content) } : e
  )
})

/** 折叠块 header 工具摘要（有工具才显示） */
const toolSummary = computed(() => toolAreaSummary(props.msg.toolContent ?? []))

// ─── 用户消息状态行 ─────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case 'queued':
      return '📨'
    case 'thinking':
      return '🤔'
    case 'replying':
      return '⌨️'
    case 'done':
      return '✅'
    default:
      return '⏳'
  }
}

/**
 * 停止按钮显隐信号（逗号串，primitive——值不变则不触发本组件重渲染）。
 * 这是本组件唯一直接读 store 实时态的地方：判据 `!typingStates.has(agentId)` 逐 chunk 变化，
 * 上移父组件会让所有历史消息随 chunk 重渲染（正是本次要拆掉的劣化链），
 * 故下沉为叶子自持的细粒度依赖——只有带状态行的用户消息会重算，历史气泡零成本。
 */
const stopSignal = computed(() =>
  props.statusEntries
    .filter(
      (s) =>
        !store.typingStates.has(s.agentId) && isAgentStoppable(store.currentStateFor(s.agentId))
    )
    .map((s) => s.agentId)
    .join(',')
)

function canStop(agentId: string): boolean {
  return stopSignal.value.split(',').includes(agentId)
}
</script>

<template>
  <div class="message" :class="[msg.role, { grouped }]">
    <div v-if="!grouped" class="msg-avatar">{{ avatar }}</div>
    <div v-else class="msg-avatar msg-avatar-hidden">{{ avatar }}</div>

    <div class="msg-body">
      <div v-if="msg.role === 'agent' && !grouped" class="msg-sender">{{ senderName }}</div>
      <div class="msg-bubble">
        <!-- 思考+工具单折叠块（思考框内嵌工具，对齐用户「对外只露正文+思考框」）：
             thinking+tool 唯一折叠容器（无独立 tool-area）。内容体两路径：
             · 新消息（msg.segments 落库）→ 按 segments 时间序交错还原生成期顺序
               （思考文本与工具行嵌在实际发生位置，镜像 clowder 有序块数组——不再
               「思考一块+工具一块」收拢）；tool 行按 id join tool_content 补 io
             · 老消息（无 segments）→ thinking blob + tool 列表两块堆叠（退化现行为）
             受控 open 态：默认收起且**收起时不渲染内容体**（v-if 门控）——历史上
             `<details :open="false">` 的内容照样进 DOM 照样 parse，是长会话里
             「每条历史 thinking 都重算 markdown」的来源 -->
        <details
          v-if="msg.thinkingContent || msg.toolContent?.length"
          class="thinking-block stored-thinking"
          :open="foldOpen"
          @toggle="onFoldToggle"
        >
          <summary class="thinking-summary">
            <span class="thinking-icon">🐾</span>
            <span class="thinking-label">思考过程</span>
            <span v-if="msg.toolContent?.length" class="thinking-tool-hint" :title="toolSummary">
              {{ toolSummary }}
            </span>
            <span class="thinking-chevron">▶</span>
          </summary>
          <template v-if="foldOpen">
            <!-- 新消息（segments 落库）：折叠块内 thinking/tool 时间序交错——
                 思考段 markdown（fold-thinking）、工具段有 io 展开行 / 无 io name+status 行；
                 text 段由 computeStoredFoldEntries 跳过（正文已在外层 msg-text 渲染） -->
            <div v-if="foldEntries" class="stream-fold-body">
              <template v-for="(e, ei) in foldEntries" :key="ei">
                <div v-if="e.kind === 'thinking'" class="fold-thinking" v-html="e.html"></div>
                <ToolRow v-else :tool="e.tool" />
              </template>
            </div>
            <!-- 老消息（无 segments）：思考 blob + 工具列表两块堆叠（退化现行为，零回归） -->
            <template v-else>
              <div v-if="msg.thinkingContent" class="thinking-content" v-html="thinkingHtml"></div>
              <div v-if="msg.toolContent?.length" class="fold-tool-list">
                <!-- 工具行（有 io → details 可展开 / 无 io → 纯行）共用 ToolRow partial -->
                <template v-for="(t, ti) in msg.toolContent" :key="ti">
                  <ToolRow :tool="t" />
                </template>
              </div>
            </template>
          </template>
        </details>
        <div v-if="msg.images && msg.images.length" class="msg-images">
          <img
            v-for="(src, i) in msg.images"
            :key="i"
            :src="src"
            class="msg-image"
            :alt="`图片${i + 1}`"
            :title="`点击查看大图${msg.images.length > 1 ? `（${i + 1}/${msg.images.length}）` : ''}`"
            @click="emit('previewImages', msg.images!, i)"
          />
        </div>
        <div class="msg-text" v-html="bodyHtml"></div>
        <!-- 对话内 diff 展示：extra.rich.blocks 存在才渲染（服务端采集附加，
             永不进 LLM 上下文）；旧消息/无 extra → 纯文本回退与现网一致 -->
        <DiffViewer v-if="msg.extra?.rich?.blocks?.length" :blocks="msg.extra.rich.blocks" />
        <!-- 重启确认按钮组：pending 显示 [确认重启][取消]（点击后 confirming 中显示「已确认，等待重启…」）；confirmed 显示「重启中…」；取消/过期/none 隐藏 -->
        <div v-if="msg.messageType === 'restart_request'" class="restart-actions">
          <template v-if="restartState === 'pending'">
            <span v-if="restartConfirming" class="restart-label"> 已确认，等待重启… </span>
            <template v-else>
              <button class="btn-restart" @click="emit('confirmRestart', msg.id)">确认重启</button>
              <button class="btn-restart btn-restart-cancel" @click="emit('cancelRestart', msg.id)">
                取消
              </button>
            </template>
          </template>
          <span v-else-if="restartState === 'confirmed'" class="restart-label"> 重启中… </span>
        </div>
        <!-- 气泡 footer：agent 消息每条带 {模型} · {n}k/{m}k tokens——
             分组消息同样渲染（用户要求同 agent 连续回复每条都有模型与用量）；
             停止按钮不在此处（B2 重定位：streaming 气泡 / 用户消息状态行） -->
        <div v-if="msg.role !== 'system'" class="msg-footer">
          <span
            v-if="msg.role === 'agent' && msg.agentId"
            class="msg-footer-info"
            :class="contextLevel"
          >
            {{ modelName }} · {{ tokensText
            }}<span v-if="execMetaText" class="msg-duration"> · {{ execMetaText }}</span
            ><span v-else-if="durationText" class="msg-duration"> · {{ durationText }}</span>
          </span>
          <span class="msg-footer-right">
            <time class="msg-time" :datetime="msg.createdAt">{{ timeText }}</time>
          </span>
        </div>
        <time v-else class="msg-time" :datetime="msg.createdAt">{{ timeText }}</time>
      </div>
    </div>

    <!-- Agent status indicators (on user messages) -->
    <div v-if="msg.role === 'user' && statusEntries.length > 0" class="msg-agent-status">
      <div v-for="s in statusEntries" :key="s.agentId" class="agent-status-row">
        <span class="status-emoji">{{ statusEmoji(s.status) }}</span>
        <span class="status-avatar">{{ s.agentAvatar }}</span>
        <span class="status-name">{{ s.agentName }}</span>
        <AgentStatusLabel :entry="s" />
        <!-- 停止按钮（B2 重定位）：busy 但无流式内容时挂用户消息状态行承载——
             streaming 中（typingStates 有该 agent）按钮在 streaming 气泡上；
             边界明示：agent 被 agent 回复触发（广播模式）无用户消息状态行，
             仅 streaming 气泡覆盖——窗口期短，不追求全覆盖 -->
        <button
          v-if="canStop(s.agentId)"
          class="btn-stop-agent"
          title="停止思考并清空队列"
          aria-label="停止"
          @click.stop="emit('stopAgent', s.agentId)"
        >
          停止
        </button>
      </div>
      <button
        v-if="isLatestUser"
        class="btn-retract"
        :class="{ 'btn-retract-confirm': retractConfirming }"
        :aria-label="retractConfirming ? '确认撤回消息' : '撤回消息'"
        @click="emit('retract', msg.id)"
      >
        {{ retractConfirming ? '确认撤回？' : '撤回' }}
      </button>
    </div>
  </div>
</template>

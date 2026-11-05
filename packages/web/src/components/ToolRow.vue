<script setup lang="ts">
import type { ToolCallInfo } from '@cat-study/shared'

/**
 * 单条工具行渲染（思考折叠框内工具的共享 partial）。
 *
 * 抽取前 ChatPanel.vue 里「流式 fold 交错 entries / 历史 segments 交错路径
 * (storedFoldEntries) / 历史退化路径 (fold-tool-list)」各自复制了一份 ~50 行的
 * tool 行渲染（name/status/io 展开），未来工具行改动需同步多处——本组件收拢为
 * 一份。样式随组件 scoped 自持（不依赖 ChatPanel 的 data-v），工具行类名/DOM
 * 结构与抽取前逐字等价。
 *
 * io 展开行为保持抽取前语义（560ef47 起单一思考折叠块）：
 * · toolHasIo（input/output 任一非 null）→ <details> 可展开行 + 行级 io；
 * · 无 io → 纯 name/status 行（tool-row-head-plain，无 chevron）；
 * · plain（流式）→ 恒 plain 行——流式 wire 只承载轻量 id/name/status，io 只进
 *   落库 tool_content，即使上游未来给 tool 段带 io 也不展开（与抽取前一致）。
 *
 * class 等 attr 经 $attrs 落到实际渲染根节点（多根组件不自动透传），流式传
 * class="stream-tool-row" 即沿用抽取前的 stream 特有类。
 */
defineProps<{
  tool: ToolCallInfo
  /** 恒渲染 plain 行（不按 io 展开）——流式 fold 工具段专用 */
  plain?: boolean
}>()

const TOOL_STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  completed: '完成',
  error: '失败',
}
/** 工具状态 → 中文标签（与 server 端 TOOL_STATUS_LABELS 同源口径；未知状态原样透出） */
function toolStatusLabel(status: string | undefined): string {
  if (!status) return ''
  return TOOL_STATUS_LABELS[status] ?? status
}
/** 工具调用展示文案：name + 状态（卡片 title/降级文本共用） */
function toolLabel(t: ToolCallInfo): string {
  return t.status ? `${t.name} · ${toolStatusLabel(t.status)}` : t.name
}

/** 行是否有可展开的 io 快照（历史 tool_content 落库结果级；流式轻量段无 io → 不可展开） */
function toolHasIo(t: ToolCallInfo): boolean {
  return t.input != null || t.output != null
}

/** io 快照展示文本：字符串原样，结构化对象/数组 JSON 美化 */
function toolIoText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** 工具行视觉类：推进中左缘高亮（当前活工具），失败左缘标红 */
function toolRowClass(t: ToolCallInfo): string {
  if (t.status === 'running' || t.status === 'pending') return 'tool-row-active'
  if (t.status === 'error') return 'tool-row-error'
  return ''
}

/**
 * 工具类型 → 色带档位（B·改：边框退场，左缘 3px 圆头色带 + 同色相淡底承担类型编码）。
 *
 * 四档对应原型：读=蓝灰 / 搜=紫 / 执行=琥珀 / 编辑=绿；其余工具落到中性色带
 * （CSS 里的 `--tk` 缺省值）。匹配按小写子串，大小写与命名风格（Read / read_file /
 * NotebookEdit）都能归到同一档。
 */
function toolKindClass(t: ToolCallInfo): string {
  const n = (t.name || '').toLowerCase()
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('fetch')) {
    return 'tk-search'
  }
  if (n.includes('bash') || n.includes('shell') || n.includes('terminal') || n.includes('task')) {
    return 'tk-run'
  }
  if (n.includes('edit') || n.includes('write') || n.includes('patch')) {
    return 'tk-write'
  }
  if (n.includes('read') || n.includes('view') || n === 'ls' || n.endsWith('_ls')) {
    return 'tk-read'
  }
  return ''
}
</script>

<template>
  <!-- io 快照齐全且非 plain → <details> 可展开行（行级 input/output，header 附 chevron） -->
  <details
    v-if="!plain && toolHasIo(tool)"
    class="tool-row"
    :class="[toolRowClass(tool), toolKindClass(tool)]"
    :title="toolLabel(tool)"
    v-bind="$attrs"
  >
    <summary class="tool-row-head">
      <span class="tool-status-glyph" :class="`tool-status-${tool.status}`">
        <span v-if="tool.status === 'running'" class="tool-spinner"></span>
        <template v-else-if="tool.status === 'completed'">✓</template>
        <template v-else-if="tool.status === 'error'">✕</template>
        <template v-else-if="tool.status === 'pending'">○</template>
      </span>
      <span class="tool-card-icon">🛠</span>
      <span class="tool-card-name">{{ tool.name }}</span>
      <span v-if="tool.truncated" class="tool-card-truncated" title="工具输入/输出超限已截断"
        >…</span
      >
      <span v-if="tool.status" class="tool-card-status" :class="`tool-status-${tool.status}`">{{
        toolStatusLabel(tool.status)
      }}</span>
      <span class="tool-row-chevron">▶</span>
    </summary>
    <div class="tool-row-io">
      <div v-if="tool.input != null" class="tool-io-block">
        <div class="tool-io-label">输入</div>
        <pre class="tool-io-value">{{ toolIoText(tool.input) }}</pre>
      </div>
      <div v-if="tool.output != null" class="tool-io-block">
        <div class="tool-io-label">输出</div>
        <pre class="tool-io-value">{{ toolIoText(tool.output) }}</pre>
      </div>
      <div v-if="tool.truncated" class="tool-io-truncated">
        ⚠️ 输入/输出超限已截断——完整快照存于服务端 tool_content（query_db 可查）
      </div>
    </div>
  </details>
  <!-- 无 io（或 plain 强制）→ 纯 name/status 行（tool-row-head-plain，无 chevron 不可展开） -->
  <div
    v-else
    class="tool-row"
    :class="[toolRowClass(tool), toolKindClass(tool)]"
    :title="toolLabel(tool)"
    v-bind="$attrs"
  >
    <div class="tool-row-head tool-row-head-plain">
      <span class="tool-status-glyph" :class="`tool-status-${tool.status}`">
        <span v-if="tool.status === 'running'" class="tool-spinner"></span>
        <template v-else-if="tool.status === 'completed'">✓</template>
        <template v-else-if="tool.status === 'error'">✕</template>
        <template v-else-if="tool.status === 'pending'">○</template>
      </span>
      <span class="tool-card-icon">🛠</span>
      <span class="tool-card-name">{{ tool.name }}</span>
      <span v-if="tool.truncated" class="tool-card-truncated" title="工具输入/输出超限已截断"
        >…</span
      >
      <span v-if="tool.status" class="tool-card-status" :class="`tool-status-${tool.status}`">{{
        toolStatusLabel(tool.status)
      }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 工具行（B·改）：边框退场，改「类型色带 + 同色相淡底」。
   行与行之间靠色块边界分开（容器 gap 4px），不靠线；颜色同时承担类型编码。
   `--tk` 是色带色，`--tk-bg` / `--tk-bg-hover` 是同色相淡底（8% / 14%）。 */
.tool-row {
  position: relative;
  border: none;
  border-radius: 6px;
  background: var(--tk-bg, rgba(60, 48, 40, 0.035));
  padding: 5px 8px 5px 11px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  overflow: hidden;
}

/* 左缘 3px 圆头色带（上下各内缩 4px）——类型的视觉编码位 */
.tool-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 999px;
  background: var(--tk, #8f887c);
}

.tool-row:hover {
  background: var(--tk-bg-hover, rgba(60, 48, 40, 0.055));
}

/* 四档类型色（浅色主题） */
.tool-row.tk-read {
  --tk: #6b7fa8;
  --tk-bg: rgba(107, 127, 168, 0.08);
  --tk-bg-hover: rgba(107, 127, 168, 0.14);
}
.tool-row.tk-search {
  --tk: #8a7bd8;
  --tk-bg: rgba(138, 123, 216, 0.08);
  --tk-bg-hover: rgba(138, 123, 216, 0.14);
}
.tool-row.tk-run {
  --tk: #c89840;
  --tk-bg: rgba(200, 152, 64, 0.09);
  --tk-bg-hover: rgba(200, 152, 64, 0.16);
}
.tool-row.tk-write {
  --tk: #5a8f6e;
  --tk-bg: rgba(90, 143, 110, 0.08);
  --tk-bg-hover: rgba(90, 143, 110, 0.14);
}

/* 深色主题：同一套层级，色带提亮、淡底加深（与原型深色态一致） */
[data-theme='dark'] .tool-row.tk-read {
  --tk: #8fa3cc;
  --tk-bg: rgba(143, 163, 204, 0.12);
  --tk-bg-hover: rgba(143, 163, 204, 0.18);
}
[data-theme='dark'] .tool-row.tk-search {
  --tk: #a99ce8;
  --tk-bg: rgba(169, 156, 232, 0.12);
  --tk-bg-hover: rgba(169, 156, 232, 0.18);
}
[data-theme='dark'] .tool-row.tk-run {
  --tk: #d9b062;
  --tk-bg: rgba(217, 176, 98, 0.12);
  --tk-bg-hover: rgba(217, 176, 98, 0.18);
}
[data-theme='dark'] .tool-row.tk-write {
  --tk: #7fb894;
  --tk-bg: rgba(127, 184, 148, 0.12);
  --tk-bg-hover: rgba(127, 184, 148, 0.18);
}
[data-theme='dark'] .tool-row {
  --tk-bg: rgba(230, 221, 208, 0.045);
  --tk-bg-hover: rgba(230, 221, 208, 0.07);
}

/* 状态压过类型色：推进中蓝、失败红（色带同一位置表达）。
   双类选择器 + 深色同名规则，确保压得住类型档（含 0,3,0 的深色规则）。 */
.tool-row.tool-row-active {
  --tk: #4a9eff;
}
.tool-row.tool-row-error {
  --tk: #ff6b6b;
}
[data-theme='dark'] .tool-row.tool-row-active {
  --tk: #4a9eff;
}
[data-theme='dark'] .tool-row.tool-row-error {
  --tk: #ff6b6b;
}

.tool-row-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  cursor: pointer;
  list-style: none; /* hide native <details> marker */
}
.tool-row-head::-webkit-details-marker {
  display: none;
}
.tool-row-head-plain {
  cursor: default;
}

/* 状态 glyph：running 转圈 / completed ✓ / error ✕ / pending ○（复用 tool-status-* 色） */
.tool-status-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  font-size: 11px;
  line-height: 1;
}
.tool-status-glyph.tool-status-running {
  color: #4a9eff;
}
.tool-status-glyph.tool-status-completed {
  color: #58c97b;
}
.tool-status-glyph.tool-status-error {
  color: #ff6b6b;
}
.tool-status-glyph.tool-status-pending {
  color: var(--text-muted);
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: toolSpin 0.8s linear infinite;
}
@keyframes toolSpin {
  to {
    transform: rotate(360deg);
  }
}

.tool-row-chevron {
  font-size: 10px;
  opacity: 0.5;
  transition: transform var(--ease-out);
}
.tool-row[open] .tool-row-chevron {
  transform: rotate(90deg);
}

.tool-row-io {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px 8px;
  border-top: 1px dashed rgba(130, 170, 220, 0.25);
  background: rgba(130, 170, 220, 0.05);
}
.tool-io-label {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.85;
}
.tool-io-value {
  margin: 0;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}
.tool-io-truncated {
  font-size: 11px;
  color: var(--accent-red, #ff6b6b);
  opacity: 0.8;
}

.tool-card-icon {
  font-size: 13px;
  line-height: 1;
  opacity: 0.9;
}

.tool-card-name {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  word-break: break-all;
}

.tool-card-status {
  font-size: 11px;
  white-space: nowrap;
  opacity: 0.9;
}

.tool-card-status.tool-status-running {
  color: #4a9eff;
}

.tool-card-status.tool-status-completed {
  color: #58c97b;
}

.tool-card-status.tool-status-error {
  color: #ff6b6b;
}

.tool-card-truncated {
  font-size: 11px;
  opacity: 0.55;
}
</style>

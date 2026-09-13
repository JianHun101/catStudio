<script setup lang="ts">
/**
 * 对话内 diff 展示 — 富文本块渲染。
 * 输入：RichBlock[]（服务端从 git 采集，每文件一块），渲染文件标题 +
 * 行级 unified diff（增绿/删红着色 + 新旧行号）。
 * 版本校验：v !== 1 的块整体丢弃；无 blocks 时组件不渲染（父级 v-if 已挡，
 * 此处再过滤一层兜底）。零新依赖——解析器见 utils/diff.ts。
 */
import { computed } from 'vue'
import type { RichBlock } from '@cat-study/shared'
import { parseUnifiedDiff, DIFF_TRUNCATED_MARKER } from '@/utils/diff'

const props = defineProps<{
  blocks: RichBlock[]
}>()

/**
 * 版本契约：只渲染 v===1 的 diff 块（v 升级时旧块整体丢弃，前端不猜格式）。
 * 元素形状防御：filePath/diff 缺失（畸形 block）整体过滤——parseUnifiedDiff(undefined)
 * 会在 .trim() 抛 TypeError 崩掉整个消息列表（Vue 无 errorCaptured 兜底），
 * 一行类型收窄成本换渲染链路稳定性。
 */
const validBlocks = computed(() =>
  props.blocks.filter(
    (b) =>
      b.kind === 'diff' && b.v === 1 && typeof b.filePath === 'string' && typeof b.diff === 'string'
  )
)

/**
 * 行解析结果按块缓存：`parseUnifiedDiff` 过去直接写在模板 v-for 里，父级每次重渲染
 * 都把每块 diff 重解析一遍（消息列表重渲染的下游开销）。移入 computed——props.blocks
 * 引用不变则不重算。
 */
const parsedBlocks = computed(() =>
  validBlocks.value.map((block) => ({ block, lines: parseUnifiedDiff(block.diff) }))
)

function lineClass(line: { type: string; text: string }): string {
  if (line.text === DIFF_TRUNCATED_MARKER) return 'diff-line diff-truncated'
  switch (line.type) {
    case 'add':
      return 'diff-line diff-add'
    case 'del':
      return 'diff-line diff-del'
    case 'hunk':
      return 'diff-line diff-hunk'
    case 'meta':
      return 'diff-line diff-meta'
    default:
      return 'diff-line diff-ctx'
  }
}
</script>

<template>
  <div class="diff-viewer">
    <div v-for="{ block, lines } in parsedBlocks" :key="block.id" class="diff-block">
      <div class="diff-file-header">
        <span class="diff-file-icon">📄</span>
        <code class="diff-file-path">{{ block.filePath }}</code>
      </div>
      <div class="diff-lines">
        <div v-for="(line, i) in lines" :key="`${block.id}-${i}`" :class="lineClass(line)">
          <span class="diff-line-num">{{ line.oldLine ?? '' }}</span>
          <span class="diff-line-num">{{ line.newLine ?? '' }}</span>
          <span class="diff-line-text">{{ line.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  margin: 8px 0 2px;
  border: 1px solid var(--border-subtle, #333);
  border-radius: var(--radius-sm, 8px);
  overflow: hidden;
}

.diff-file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bg-hover, #222);
  font-size: 12px;
}

.diff-file-icon {
  font-size: 11px;
}

.diff-file-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-primary, #e6e6e6);
  word-break: break-all;
}

.diff-lines {
  max-height: 320px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.diff-line {
  display: flex;
  white-space: pre;
  min-height: 18px;
}

.diff-line-num {
  flex-shrink: 0;
  width: 42px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary, #888);
  user-select: none;
  background: var(--bg-surface, #1c1c1c);
  border-right: 1px solid var(--border-subtle, #333);
}

.diff-line-text {
  flex: 1;
  padding: 0 8px;
  overflow-wrap: anywhere;
}

.diff-add {
  background: rgba(46, 160, 67, 0.16);
}

.diff-del {
  background: rgba(248, 81, 73, 0.16);
}

.diff-hunk {
  background: var(--bg-hover, #222);
  color: var(--accent, #58a6ff);
}

.diff-meta {
  color: var(--text-secondary, #888);
}

.diff-truncated {
  font-style: italic;
  color: var(--accent-red, #f85149);
}
</style>

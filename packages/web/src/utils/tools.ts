import type { ToolCallInfo } from '@cat-study/shared'

/**
 * 消息渲染共用的纯判定（无 I/O、无响应式依赖）。
 *
 * 历史消息（MessageItem.vue）与流式气泡（ChatPanel.vue）两处消费同一套工具区
 * 摘要/停止按钮判据——单源收在这里，避免两处各写一份后漂移（同 ToolRow.vue
 * 「行级 io/status 渲染单源」的既有约定）。
 */

/** 工具是否推进中（running/pending）——驱动工具区自动展开与 header 摘要 */
export function isToolActive(t: { status?: string }): boolean {
  return t.status === 'running' || t.status === 'pending'
}

/** 工具区状态摘要：有推进中 → 运行中；有失败 → N 失败；否则 → 完成 */
export function toolAreaStatusWord(tools: ToolCallInfo[]): string {
  if (tools.some(isToolActive)) return '运行中'
  const errs = tools.filter((t) => t.status === 'error').length
  if (errs) return errs === tools.length ? '失败' : `${errs} 失败`
  if (tools.length) return '完成'
  return ''
}

/** 工具区 header 摘要文案：N 个工具 · 状态（历史/流式共用） */
export function toolAreaSummary(tools: ToolCallInfo[]): string {
  const word = toolAreaStatusWord(tools)
  return `${tools.length} 个工具${word ? ` · ${word}` : ''}`
}

/**
 * 是否可停止：回复中（busy）或有排队任务（AGENT_INTERRUPT 一个按钮覆盖两场景）。
 * 入参是 AgentRuntimeState 的结构窄化（只读 status/queueLength），不依赖 store 类型。
 */
export function isAgentStoppable(state?: { status?: string; queueLength?: number }): boolean {
  return state?.status === 'busy' || (state?.queueLength ?? 0) > 0
}

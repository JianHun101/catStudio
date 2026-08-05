import type { AgentConfig } from '@cat-study/shared'

/**
 * 渲染层角色占位符 → 真名（纯显示层，零数据写入）。
 *
 * 与 server resolveRolePlaceholders（socketio.ts:1466-1481）逐规则对齐——
 * 渲染层只读副本，规则变更需双处同步（防漂移）：
 * - @架构师 → store 角色 agent 名（角色存在才替换，缺失保留字面）
 * - @审查者 → reviewer 角色 agent 名（同上）
 * - @作者 → 不替换：前端无触发者上下文（用户可见消息旁就有触发者，
 *   保留字面语义准确），且替换规则涉及运行时消息作者，超出纯显示函数职责
 *
 * 替换只发生在纯文本层（renderMarkdown 之前），不写任何数据——
 * 落库契约（content 保留 LLM 原文，974159e 断言④ 防伪设计）不受影响。
 * 正则只匹配 @ 前缀，"是项目架构师" 这类无 @ 的叙述不受影响。
 */
export function resolveDisplayPlaceholders(content: string, agents: AgentConfig[]): string {
  let result = content
  const architect = agents.find((a) => a.role === 'store')
  if (architect) {
    result = result.replace(/@架构师/g, `@${architect.name}`)
  }
  const reviewer = agents.find((a) => a.role === 'reviewer')
  if (reviewer) {
    result = result.replace(/@审查者/g, `@${reviewer.name}`)
  }
  return result
}

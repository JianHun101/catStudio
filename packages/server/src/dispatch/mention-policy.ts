/**
 * A2A mention 白名单策略 — 角色→允许@的 Agent 角色边表。
 *
 * 纯函数模块，无外部依赖，可单独测试。
 *
 * 设计背景（A2A 风暴治理，B 方案，店长架构定稿）：
 * 猫咖的 Agent 通过回复中的行首 @ 相互触发（A2A 路由），但任何猫都能
 * @ 任何猫会让触发链失去控制（风暴）。白名单按角色约束 @ 的合法范围：
 * - store（店长）→ 任意：架构裁决者，允许被任何人 @ 也允许 @ 任何人
 * - implementer（实施猫）→ {store, reviewer}：只对店长（求助/汇报）和
 *   审查者（审查链）喊话；且每条回复最多 @ 1 个 agent（防多线触发风暴）
 * - reviewer（审查猫）→ {store, implementer} ∪ 本次触发消息作者：审查结论分流——
 *   ✅可合并/💬仅评论（非阻断）→ @架构师（收口信号直接到位）；⚠️/❌ → @作者（要改的才回作者）。
 *   implementer 边是收口链的必要边：白名单原先只有「触发者」概念、没有「作者」，
 *   而触发者常是用户或店长 → ⚠️/❌ 永远投不回作者（结论静默悬空，2026-09-09 实证）
 * - vision（图测猫）→ {store}：视觉评审专用，只响应店长派活
 *
 * 关键语义：角色未知/缺失（老库迁移默认 'unknown'）→ 发送者放行不拦截、
 * 目标放行——误杀审查链的代价远大于漏拦一条 @（店长边界）。
 */

import type { AgentRole } from '@cat-study/shared'

/** 实施猫每条回复最多允许的 agent mention 数——超出的剥除（防多线触发） */
export const IMPLEMENTER_MAX_MENTIONS_PER_REPLY = 1

/** 角色 → 允许@的 Agent 角色列表。'any' = 不限制 */
const ROLE_ALLOWED_MENTIONS: Record<AgentRole, 'any' | AgentRole[]> = {
  store: 'any',
  implementer: ['store', 'reviewer'],
  reviewer: ['store', 'implementer'],
  vision: ['store'],
}

/** 发送者上下文 */
export interface MentionPolicyFrom {
  role?: AgentRole
  /** 本次触发消息的作者名（agent 消息时非空）——reviewer 可 @ 回请求人 */
  triggerAuthorName?: string
}

/** 被 @ 的目标（agent） */
export interface MentionPolicyTarget {
  name: string
  role?: AgentRole
}

/** 被剥除的 mention 及原因 */
export interface BlockedMention {
  name: string
  reason: 'role-not-allowed' | 'count-limit'
}

/**
 * 按发送者角色过滤 @ 目标列表。
 *
 * 泛型保留完整目标对象类型（如 AgentConfig）——调用方拿到 allowed 后
 * 可直接继续使用（写回 DB / dispatch），无需二次查找。
 *
 * @returns allowed 保留的合法目标；blocked 被剥除的目标及原因（发送者
 *   需要系统提示说明——点名违规与正确规则）
 */
export function filterAllowedMentions<T extends MentionPolicyTarget>(
  from: MentionPolicyFrom,
  targets: T[]
): { allowed: T[]; blocked: BlockedMention[] } {
  // 发送者角色未知（undefined 或不在边表中，如老库默认 'unknown'）→ 全放行
  const rule = from.role ? ROLE_ALLOWED_MENTIONS[from.role] : undefined
  if (!rule) {
    return { allowed: [...targets], blocked: [] }
  }

  const allowed: T[] = []
  const blocked: BlockedMention[] = []
  for (const t of targets) {
    if (isRoleAllowed(from, rule, t)) {
      allowed.push(t)
    } else {
      blocked.push({ name: t.name, reason: 'role-not-allowed' })
    }
  }

  // 计数限制：仅实施猫生效——合法目标中最多保留 1 个（每条回复 ≤1 个 agent mention）。
  // 保留策略：reviewer 必保（审查链是 A2A 生命线——剥掉审核请求会让流程无声卡死，
  // 比丢一条汇报代价大得多）；无 reviewer 才保传入顺序第一个（parseMentionsFromReply
  // 的返回顺序是 session 注册顺序，与回复文本里的 @ 书写顺序无关）。
  if (from.role === 'implementer' && allowed.length > IMPLEMENTER_MAX_MENTIONS_PER_REPLY) {
    const reviewerIdx = allowed.findIndex((t) => t.role === 'reviewer')
    const keepIdx = reviewerIdx >= 0 ? reviewerIdx : 0
    const keep = [allowed[keepIdx]]
    const extra = allowed.filter((_, i) => i !== keepIdx)
    blocked.push(...extra.map((t) => ({ name: t.name, reason: 'count-limit' as const })))
    return { allowed: keep, blocked }
  }

  return { allowed, blocked }
}

function isRoleAllowed(
  from: MentionPolicyFrom,
  rule: 'any' | AgentRole[],
  t: MentionPolicyTarget
): boolean {
  if (rule === 'any') return true
  // 目标角色未知（老库未配）→ 放行——无法判定边表时误杀风险大于漏拦
  if (!t.role) return true
  if (rule.includes(t.role)) return true
  // reviewer 特殊边：可 @ 回本次触发消息作者（若为 agent）——审查结论回请求人
  if (from.role === 'reviewer' && from.triggerAuthorName === t.name) return true
  return false
}

/** 生成"当前角色可 @ 谁"的规则描述——违规系统提示里点名正确规则用 */
export function allowedTargetsDescription(role?: AgentRole): string {
  switch (role) {
    case 'store':
      return '任意猫'
    case 'implementer':
      return `店长、吐槽猫（每条回复最多 ${IMPLEMENTER_MAX_MENTIONS_PER_REPLY} 个 @）`
    case 'reviewer':
      return '店长或实施猫'
    case 'vision':
      return '店长'
    default:
      return '任意猫'
  }
}

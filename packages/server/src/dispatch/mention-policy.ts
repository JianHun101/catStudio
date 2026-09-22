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
 *   审查者（审查链）喊话
 * - reviewer（审查猫）→ {store, implementer} ∪ 本次触发消息作者：审查结论分流——
 *   ✅可合并/💬仅评论 → @架构师 请收口（不 @实施猫）；⚠️/❌ → @作者。一条回复只 @ 一个目标，由结论唯一决定。
 *   implementer 边是收口链的必要边：白名单原先只有「触发者」概念、没有「作者」，
 *   而触发者常是用户或店长 → ⚠️/❌ 永远投不回作者（结论静默悬空，2026-09-09 实证）
 * - vision（图测猫）→ {store}：**已于 2026-09-13 退役**（模型已能原生看图，外部视觉
 *   旁路整链删除）——该键已从边表移除，老库残留的 `role='vision'` 行因此落到下面
 *   那条「角色不在边表 → 放行不拦截」兜底上，这与退役前的目标侧行为一致、不倒退。
 *
 * 单目标闸（票乙，2026-09-20）：**每条回复最多 @ 1 个 agent**，作用域 = 实施猫
 * 与审查猫两条边（原先只对 implementer 生效，reviewer 双 @ 零拦截——审查猫一条
 * 回复同时 @ 架构师与作者会让收口链与返工链**同时**被唤起，正是本闸要堵的形态）。
 * **store 刻意不在闸内**（见 `COUNT_LIMITED_ROLES` 注释）。「超出时留谁」按角色
 * 分表：implementer 保审查者（审查链必达），reviewer 保「审查结论对应的那一个」
 * （见 pickKeepIndex）。
 *
 * 关键语义：角色未知/缺失（老库迁移默认 'unknown'；含已退役的 'vision' 残留行）
 * → 发送者放行不拦截、目标放行——误杀审查链的代价远大于漏拦一条 @（店长边界）。
 */

import type { AgentRole } from '@cat-study/shared'

/** 每条回复最多允许的 agent mention 数——超出的剥除（防多线触发）。
 *  原名 `IMPLEMENTER_MAX_MENTIONS_PER_REPLY`：当时只对实施猫生效；票乙把
 *  reviewer 纳入同一上限后改名——**名字里的角色前缀正是这处遗漏的来源**。
 *  作用域**不是**「所有角色」：见 COUNT_LIMITED_ROLES。 */
export const MAX_MENTIONS_PER_REPLY = 1

/**
 * 单目标闸的作用域——**只有这两条边**受「每条回复 ≤1 个 @」约束。
 *
 * store 刻意在外：架构裁决者一条回复合法地要同时 @ 多只猫（派活单一次点名多只
 * 实施猫、收口时同唤作者与审查者），把它也限成 1 个会直接改掉 `store → 任意`
 * 这条既有边表的语义。票乙的原话是「计数上限从 implementer **扩到 reviewer**」，
 * 不是「扩到所有角色」——写成本列表是为了让这个边界在代码里可读，而不是靠
 * `from.role === 'implementer'` 的一处历史条件留在读者脑补里。
 */
const COUNT_LIMITED_ROLES: AgentRole[] = ['implementer', 'reviewer']

/**
 * 审查结论——reviewer 单目标优先级表的输入。
 *
 * **本模块自持联合类型**，不 import `eval/verdict-parser` 的 `ReviewVerdict`：
 * 后者是落库契约（四档语义定义在那边），而本模块的性质是「零外部依赖纯函数」
 * （见文件头），一旦 import 就把 eval 整条链拖进 dispatch 层。取值与四档一一
 * 对应，漂移由接线处（`execution/serial.ts`）的类型检查兜住。
 */
export type ReviewerVerdict = 'approve' | 'comment' | 'suggest' | 'reject'

/** 角色 → 允许@的 Agent 角色列表。'any' = 不限制 */
const ROLE_ALLOWED_MENTIONS: Record<AgentRole, 'any' | AgentRole[]> = {
  store: 'any',
  implementer: ['store', 'reviewer'],
  reviewer: ['store', 'implementer'],
  // vision 键已随角色退役移除（2026-09-13，单A）——**不是**为了让老库 vision 行
  // 落到这里，而是角色本身不该再存在于边表；残留行靠下方 `!rule` 兜底放行。
}

/** 发送者上下文 */
export interface MentionPolicyFrom {
  role?: AgentRole
  /** 本次触发消息的作者名（agent 消息时非空）——reviewer 可 @ 回请求人 */
  triggerAuthorName?: string
  /**
   * 本次回复的审查结论——**仅 reviewer 有值**，决定超上限时保留哪个目标。
   * 不可得（非 reviewer / 正文无行首标记 / 格式漂移）时留空，走兜底优先级。
   */
  verdict?: ReviewerVerdict
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
  // 发送者角色未知（undefined 或不在边表中：老库默认 'unknown'、**已退役角色的残留行**
  // 如 `role='vision'`）→ 全放行。退役后这条兜底多承接了一类输入，故显式点名它：
  // 残留 vision 行不因退役而被拦死，行为与退役前一致。
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

  // 单目标闸：合法目标超上限 → 只留一个，其余按 count-limit 剥除（每条回复
  // ≤1 个 agent mention）。作用域见 COUNT_LIMITED_ROLES——留谁按角色分表
  // （pickKeepIndex）。未在边表的角色上面已 return，够不到本段。
  const senderRole = from.role
  if (
    senderRole &&
    COUNT_LIMITED_ROLES.includes(senderRole) &&
    allowed.length > MAX_MENTIONS_PER_REPLY
  ) {
    const keepIdx = pickKeepIndex(from, allowed)
    const keep = [allowed[keepIdx]]
    const extra = allowed.filter((_, i) => i !== keepIdx)
    blocked.push(...extra.map((t) => ({ name: t.name, reason: 'count-limit' as const })))
    return { allowed: keep, blocked }
  }

  return { allowed, blocked }
}

/** 目标匹配谓词——优先级表的一格 */
type TargetMatcher = (from: MentionPolicyFrom, t: MentionPolicyTarget) => boolean

const isStore: TargetMatcher = (_from, t) => t.role === 'store'
const isImplementer: TargetMatcher = (_from, t) => t.role === 'implementer'
const isReviewer: TargetMatcher = (_from, t) => t.role === 'reviewer'
/** 本次触发消息的作者（请求人）。无触发作者（用户触发）时恒不命中 */
const isRequester: TargetMatcher = (from, t) =>
  !!from.triggerAuthorName && t.name === from.triggerAuthorName

/**
 * reviewer 超上限时的保谁优先级——**按审查结论分档**，从左到右取首个命中；
 * 全不命中则保传入顺序第一个（`parseMentionsFromReply` 的返回顺序是 session
 * 注册顺序，与文本里的 @ 书写顺序无关）。
 *
 * 键含 `'unknown'`：结论不可得（正文无行首标记 / 格式漂移 / 非 reviewer 传了
 * 该字段）时走它。**不可得档偏实施侧是店长裁决（2026-09-20）**：与「架构类
 * 问题在实施猫这层出现、由实施猫反馈给架构师」同向——架构师单槽位是瓶颈，
 * 误落到作者时作者按实施铁律 `行首@架构师 请收口` 能把链补回去（兜底路径已在
 * 跑）；反之误落架构师就是直接堵派活。
 */
const REVIEWER_KEEP_PRIORITY: Record<ReviewerVerdict | 'unknown', TargetMatcher[]> = {
  // 非阻断结论 = 收口信号 → 直达架构师
  approve: [isStore, isRequester],
  comment: [isStore, isRequester],
  // 要返工 → 回请求人（实施侧）
  //
  // ⚠️ 已知局限（票丙挂账转代码记录，**行为不动**）：`@作者` 的运行期定义就是
  // 「本次触发消息作者」（`execution/hints.ts` 的 `resolveRolePlaceholders`），故保
  // 「请求人」与 prompt 面的占位符语义逐字一致。但**架构师代发起审查**时请求人
  // = store，返工结论会落到架构师而不是真实代码作者，下游 verdict-parser 取不到
  // 非 store 目标 ⇒ `subject=null` + `no_subject`（审查 P3-2 探针实证）。
  // 这是既有语义、非本笔引入（socketio.test.ts:2075 早已建模该态）。
  // reopen 条件（满足任一即重裁本格，而不是就地改）：
  //   ① 实测出现「代发起审查 → 返工」链且架构师未按铁律 `行首@架构师 请收口`
  //      把链转回作者 —— 即兜底路径被证伪；
  //   ② `no_subject` 被下游统计当失败计入 —— 该格就从「既有语义」变成了指标污染源。
  //      **当前即为真**（2026-09-20 实测）。原括注指名的两头都不消费它：
  //      `execution/flow-advance.ts` grep `failure` 零命中；`eval/attribution.ts` 的
  //      `failures` 是 episode 链的局部变量。唯一读方是 `eval/l1-aggregator.ts` 的
  //      `aggregateMetrics`（`parseFailureRate` 的取数查询）——其窗口条件
  //      `verdictWindowCond` 只按 `created_at` 过滤、**不按 reason 过滤**，
  //      `no_subject` 与 `bad_verdict` 一视同仁进分子。活库实有 7 行
  //      （最近 2026-09-12T16:21:22Z，均早于本格引入；`bad_verdict` 27 行）。
  //      ⇒ 本格已处于「应重裁」态：重裁归架构师，裁决下来前行为不动。
  suggest: [isRequester, isImplementer],
  reject: [isRequester, isImplementer],
  unknown: [isRequester, isImplementer, isStore],
}

/**
 * 超上限时保留哪一个（返回 `allowed` 下标）。
 *
 * implementer 的旧语义原样保留：reviewer 必保（审查链是 A2A 生命线——剥掉审核
 * 请求会让流程无声卡死，比丢一条汇报代价大得多）；无 reviewer 才保顺序第一个。
 */
function pickKeepIndex<T extends MentionPolicyTarget>(
  from: MentionPolicyFrom,
  allowed: T[]
): number {
  const priority: TargetMatcher[] =
    from.role === 'reviewer' ? REVIEWER_KEEP_PRIORITY[from.verdict ?? 'unknown'] : [isReviewer]
  for (const matches of priority) {
    const idx = allowed.findIndex((t) => matches(from, t))
    if (idx >= 0) return idx
  }
  return 0
}

function isRoleAllowed(
  from: MentionPolicyFrom,
  rule: 'any' | AgentRole[],
  t: MentionPolicyTarget
): boolean {
  if (rule === 'any') return true
  // 目标角色未知（老库未配）→ 放行——无法判定边表时误杀风险大于漏拦。
  // 注意已退役角色的残留目标**不走这里**（t.role='vision' 是真值）——它落到
  // `rule.includes` 失败而被拦，与退役前同——目标侧行为未变。
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
      return `店长、吐槽猫（每条回复最多 ${MAX_MENTIONS_PER_REPLY} 个 @）`
    case 'reviewer':
      return `店长或实施猫（每条回复最多 ${MAX_MENTIONS_PER_REPLY} 个 @）`
    default:
      return '任意猫'
  }
}

/**
 * 超上限（`count-limit`）时给发送者的**补救方向**——单一维护面。
 *
 * 两个消费路径（票丙收敛）：文本路径 `execution/serial.ts` 的即时系统提示、
 * MCP 路径 `routes/internal.ts` 的 422 reason。原先两处各写各的措辞（前者按
 * 角色内联三元、后者写死「请收敛到一个目标重投」），改一处漂一处。
 *
 * **reviewer 与其余角色的补救方向本来就不同**，这不是措辞差异：
 * reviewer 的 @ 目标由**审查结论唯一决定**（`REVIEWER_KEEP_PRIORITY`），叫它
 * 「拆条分别 @」等于把它引回双 @ 老路（正是单目标闸要堵的形态）；它该做的是
 * 回到结论本身。故只描述规则、**不复述** verdict→目标映射表——那张表已有两处
 * 维护面（seed-data 伪铁律 / 本模块优先级表），第三处必漂。
 */
export function mentionLimitRemedy(role?: AgentRole): string {
  return role === 'reviewer' ? '请只 @ 结论对应的那一个目标' : '请拆条分别 @'
}

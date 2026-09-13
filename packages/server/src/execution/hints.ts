/**
 * Execution — 提示构建与消息格式化（备菜组，纯函数/DB 只读）。
 *
 * 从 connectors/socketio.ts 迁出（第 1 刀，零行为变化）：
 * - 受众标签 / Agent 消息 / 用户消息格式化
 * - 动态上下文指令聚合（审查循环 / 交接补填 / 触发聚焦）
 * - system prompt 角色占位符解析
 */

import { agents as agentsRepo } from '../db/repository/index.js'
import {
  REVIEW_VERDICT_MARKERS,
  escapeRegExpLiteral,
  reviewMarkerLabel,
} from '../eval/review-verdict-markers.js'
import type { ReviewVerdict, ReviewVerdictMarker } from '../eval/review-verdict-markers.js'
import { getLatestChainVerdict } from '../eval/chain-verdicts.js'

/**
 * 取**最后出现**的判词标记（审查结论总在消息末尾，正文可能引用/讨论这些标记）。
 *
 * 匹配**语义**与 `eval/verdict-parser.ts` 的行首锚定 + A/B 分级**不同源**
 * （既有裁决，勿再按同语义对齐）——此处只有「最后出现者胜」一条规则。
 * 共享的只是**字符串集**（`review-verdict-markers.ts`，T-L）。
 *
 * emoji 与后缀之间允许空白：`⚠️ 建议修改` 与 `⚠️建议修改` 视觉同形必须同判
 * （T-L 根因——带空格时此处 `lastIndexOf` 落空，静默降级为「未给出明确结论」）。
 */
function findLastVerdictMarker(content: string): ReviewVerdictMarker | null {
  let last: { pos: number; marker: ReviewVerdictMarker } | null = null
  for (const marker of REVIEW_VERDICT_MARKERS) {
    const re = new RegExp(
      `${escapeRegExpLiteral(marker.emoji)}\\s*${escapeRegExpLiteral(marker.suffix)}`,
      'g'
    )
    for (let m = re.exec(content); m !== null; m = re.exec(content)) {
      // 严格大于：位置相同时保持标记表顺序（与旧 lastIndexOf 比较口径一致）
      if (!last || m.index > last.pos) last = { pos: m.index, marker }
    }
  }
  return last?.marker ?? null
}

/**
 * 计算用户消息的受众标签。
 *
 * 纯函数，无副作用。
 *
 * @param mentions 消息中 @mention 的 agent 名列表
 * @param agentName 当前 agent 名称
 * @returns '对你' 当 agent 在 mentions 中，否则 '对大家'
 */
export function formatAudienceTag(mentions: string[], agentName: string): string {
  return mentions.includes(agentName) ? '对你' : '对大家'
}

/**
 * 格式化其他 agent 的消息为 LLM 上下文字符串。
 *
 * 使用强信号格式，让 LLM 明确知道这是来自另一个 Agent 的直接消息，
 * 而非用户在引用或转述。灵感来源：clowder-ai 的 D2 消息模板。
 *
 * 纯函数，无副作用。
 *
 * @param name    消息发送者的 agent 名称
 * @param content 消息内容
 * @param mentions 该消息中 @mention 的 agent 名列表（即接收方应回复给谁）
 * @param model   发送者使用的 LLM 模型（可选，提供上下文透明度）
 * @returns 格式为 "Direct message from name [model]; reply to mentions\n\ncontent"
 */
export function formatAgentMessage(
  name: string,
  content: string,
  mentions: string[] = [],
  model?: string
): string {
  const headerParts = [`Direct message from ${name}`]
  if (model) headerParts.push(` [${model}]`)
  if (mentions.length > 0) headerParts.push(`; reply to ${mentions.join(', ')}`)
  return `${headerParts.join('')}\n\n${content}`
}

/**
 * 审查循环检测：当审查者给出非通过结论时，向被审查的 agent 注入系统指令，
 * 确保修正后 @审查者 继续循环。
 *
 * 角色判断基于 agents 表 role 字段（而非硬编码名称/ID/skillModules）：
 *   - role === 'reviewer' → 审查者
 *   - 其他 role（store/implementer/unknown）→ coder（需要被审查）
 *
 * 结论判断（T-G §7 根修）：
 *   - ✅可合并 / 💬仅评论 → 通过，循环结束（💬 非阻断 = 不要求返工，故不注入
 *     循环指令；T-C 判词三档）
 *   - ⚠️建议修改 / ❌需重做 → 需要继续循环
 *
 * 归属判据（T-N）：判词 `subject_agent_id` 为空 = **归属不明** → 不注入（fail-closed）。
 * 与 T-L「向严不向宽」同口径：归属判不出来时宁可漏注入也不误注入（定向闸一旦缺失
 * 就是静默死循环，正是本 hint 的病灶本身）。
 *
 * **判据**（不写裸数字——数字会漂，判据不会）：走到本档的**只有** suggest/reject，
 * 因为 approve/comment 的 subject 恒为 null 是**设计**（`verdict-parser.ts` 恒置 null），
 * 且下方已先把这两档 return 掉。故该档不存在「其实是我」的信息，放行只会把只投给
 * 店长的结论注入到无关实施猫。复核 SQL（真库只读，测量时刻 2026-09-10 23:05）：
 *   SELECT v.verdict, m.mentions FROM review_verdicts v
 *     JOIN messages m ON m.id = v.message_id
 *    WHERE v.verdict IN ('suggest','reject') AND v.subject_agent_id IS NULL;
 * 实测：该档 4 行，`mentions` **4/4 全部**为 `["店长"]`（clause 里压根没有非 store 目标）。
 * 判据与 SQL 在本文件内**只此一处**，别在别处复述数字。
 *
 * **域一致性**（T-N 修复，2026-09-10）：本函数比的是 `agent.id`，故 `subject_agent_id`
 * 必须存 **id**。原写侧落的是 `subject.name`（名字）⇒ 读写两侧不同域，「subject 非空且
 * == 本猫」在生产上**恒不成立**、权威路径从不注入（真库实测：`agents.id` 是 uuid，
 * 而该列非空值只有 `'ds猫'` 这个**名字**）。修法取**写侧改落 id**
 * （`verdict-parser.ts` → `subject.id` + `serial.ts` 投影补 `id`），本函数不动。
 *
 * **权威路径 = 按链锚查最新判词**（`eval/chain-verdicts.ts`）。原实现只看
 * 「可见窗口里最近一条审查者消息」——而 ✅/💬 按分流规则只投店长，进不了实施猫的
 * 窗口 ⇒ 唯一能进窗口的那条陈旧 ⚠️（对象 `94742a2`，早已修于 `a1200a7`）被**无限重放**，
 * 实施猫修完后仍被持续要求「逐项处理反馈」，直到它自然老出窗口才停。
 * 窗口是近似值，判词的权威在库里，按锚查才对得上「这条链现在还有没有待返工」。
 *
 * 降级路径（无判词行 = 无锚存量链 / 审查回复未解析出标记）：退回窗口扫描。
 * 保留它是为了不把「审查者没打标记」的链判成「无需返工」——那条链仍需循环指令。
 * 两条路径共用同一个指令模板（`loopInstruction`），且测试断言「同输入下两路径输出逐字相等」。
 *
 * @param chain 链上下文：`anchor` = 触发本轮的链锚（`messages.task_id`，缺省 = 存量无锚）；
 *   `sessionId` = 会话（判词查询作用域）
 * @returns 系统指令字符串，不需要时返回 null
 */
export function buildReviewLoopHint(
  agent: { id?: string; name: string; role?: string },
  relevantMessages: Array<{
    role: string
    agent_id: string | null
    content: string
    mentions: string | null
  }>,
  chain: { anchor: string | undefined; sessionId: string }
): string | null {
  // 审查者自己不需要被注入（role === 'reviewer' 的 agent 是审查者）
  if (agent.role === 'reviewer') return null

  // ① 权威路径：按锚查该链**最新**判词
  const latest = getLatestChainVerdict(chain.anchor, chain.sessionId)
  if (latest) {
    // 归属判据（T-N）：**subject 为空 = 归属不明 → 不注入**（fail-closed）。
    // 原实现按「可能是我」放行；判据与复核 SQL 见文件头「归属判据」段（单处维护）。
    if (!latest.subject_agent_id) return null
    // 判词对象明确不是本猫 → 这条结论不该驱动本猫。
    // `subject_agent_id` 存 **id**（T-N 修复后写侧统一域），故与 `agent.id` 同域可比。
    if (agent.id && latest.subject_agent_id !== agent.id) return null
    if (latest.verdict === 'approve' || latest.verdict === 'comment') return null
    const reviewerName = agentsRepo.getAgentNameById(latest.reviewer_agent_id) ?? '审查者'
    return loopInstruction(reviewerName, verdictLabel(latest.verdict))
  }

  // ② 降级路径：窗口扫描（语义与原实现一致）
  for (let i = relevantMessages.length - 1; i >= 0; i--) {
    const m = relevantMessages[i]
    if (m.role !== 'agent' || !m.agent_id) continue

    // 检查发送者是否是审查者（基于 role 字段）
    const senderRow = agentsRepo.getAgentById(m.agent_id)
    if (!senderRow) continue
    if (senderRow.role !== 'reviewer') continue

    const mentions: string[] = m.mentions ? JSON.parse(m.mentions) : []
    if (!mentions.includes(agent.name)) continue

    // 找到审查者的消息。取**最后出现**的判词标记作为实际结论——
    // 审查正文可能引用/讨论这些标记，但审查结论总在消息末尾。
    const marker = findLastVerdictMarker(m.content)

    // 审查通过（✅ 明确通过 / 💬 非阻断观察项，均不要求返工）→ 不注入循环指令
    if (marker && (marker.verdict === 'approve' || marker.verdict === 'comment')) return null

    // 审查未通过（⚠️建议修改 / ❌需重做 / 无明确结论）→ 注入循环指令
    return loopInstruction(senderRow.name, marker ? reviewMarkerLabel(marker) : '未给出明确结论')
  }

  return null
}

/** 判词枚举 → 规范显示形态（走标记表，不另立字面量；表外值保留原始枚举名） */
function verdictLabel(verdict: ReviewVerdict): string {
  const marker = REVIEW_VERDICT_MARKERS.find((m) => m.verdict === verdict)
  return marker ? reviewMarkerLabel(marker) : verdict
}

/** 循环指令正文（两条路径共用同一模板——口径分叉会变成下一个分歧点） */
function loopInstruction(reviewerName: string, verdict: string): string {
  return [
    `[系统指令] ${reviewerName} 的审查结论为 ${verdict}。`,
    `你必须逐项处理反馈，修正完成后在行首独占一行 @${reviewerName} 继续审查循环。`,
    `只有收到 ✅可合并 时才能结束回复。`,
  ].join(' ')
}

/**
 * 交接文档触发检测：当 trigger 消息是 handoff-gen 投递的补填请求时，
 * 注入 system 指令确保 agent 补填完成后 @吐槽猫 发起审查。
 *
 * 一次 LLM 调用只产生一条回复，agent 在回复中同时完成补填和 @mention。
 */
export function buildHandoffTriggerHint(triggerContent: string): string | null {
  if (!triggerContent.startsWith('@店长 请补填以下交接文档')) return null

  const allAgents = agentsRepo.listAllAgents()
  const reviewer = allAgents.find((a) => a.role === 'reviewer')
  if (!reviewer) return null

  return [
    `[系统指令] 你收到了一份交接文档补填请求。`,
    `补填完 Why/Tradeoff/Open Questions 后，在回复末尾行首独占一行 @${reviewer.name} 发起代码审查。`,
  ].join(' ')
}

/**
 * 触发消息聚焦提示：明确「本轮要回复的是最后一条消息」。
 *
 * 陈旧上下文重复回答失败模式（2026-08-13 实证）的对治——luna 重启后首跑
 * 上下文含 3 条历史派活单 + 旧图消息 + 她自己的旧回复，模型选了最显眼的旧
 * 图题重复回答而非最新派活单。该 hint 每轮注入：让模型把注意力钉在最后一条
 * 触发消息上（含前 120 字截取作为锚点），其余历史不重复回答。
 *
 * 不 mutate 消息内容，纯注入指令。
 *
 * @param triggerContent 触发本轮执行的消息内容
 * @returns 系统指令字符串，内容为空时返回 null
 */
export function buildTriggerFocusHint(triggerContent: string): string | null {
  if (!triggerContent) return null
  const preview = triggerContent.length > 120 ? `${triggerContent.slice(0, 120)}…` : triggerContent
  return [
    `[系统指令] 本轮需要你回复的是最后一条消息：${preview}`,
    `其余消息是历史上下文，不要重复回答其中已回复过的问题。`,
  ].join(' ')
}

/**
 * 将 system prompt 中的角色占位符解析为实际 agent 名。
 *
 * 纯函数，无副作用（listAllAgents 为 DB 查询——调用点在 runAgentReply，
 * 该处执行栈内数据库始终就绪）。
 *
 * 占位符语义（全链路角色化设计——prompt 不写死猫名，运行时注入真名）：
 * - @作者 → 本次触发者名（triggerAuthorName 存在才替换，保留旧语义；
 *   用户消息触发时无作者，字面保留与历史行为一致）
 * - @架构师 → store 角色 agent 名；@审查者 → reviewer 角色 agent 名
 *   （角色存在才替换，缺失保留字面——与现状等价，零回归）
 *
 * 注入只发生在 prompt 层：mention 解析（a2a-mentions.ts）保持严格精确匹配，
 * LLM 输出真名后解析自然命中——占位符不替换 = 解析落空 = 静默不触发
 * （b542d24 审查结论分流断链事故根因：吐槽猫输出字面 @架构师，匹配不到
 * 任何会话 agent 名，收口信号从未投递）。正则只匹配 @ 前缀，prompt 中
 * "是项目架构师" 这类无 @ 的叙述不受影响。
 */
export function resolveRolePlaceholders(prompt: string, triggerAuthorName?: string): string {
  let result = prompt
  if (triggerAuthorName) {
    result = result.replace(/@作者/g, `@${triggerAuthorName}`)
  }
  const allAgents = agentsRepo.listAllAgents()
  const architect = allAgents.find((a) => a.role === 'store')
  if (architect) {
    result = result.replace(/@架构师/g, `@${architect.name}`)
  }
  const reviewer = allAgents.find((a) => a.role === 'reviewer')
  if (reviewer) {
    result = result.replace(/@审查者/g, `@${reviewer.name}`)
  }
  return result
}

/**
 * 聚合所有动态上下文指令。
 *
 * 每个 hint 检查一个场景，返回要注入的 system 指令或 null。
 * 新场景只需加一行调用，无需改动 runAgentReply 主流程。
 */
export function buildDynamicHints(
  agent: { id?: string; name: string; role?: string },
  triggerContent: string,
  relevantMessages: Array<{
    role: string
    agent_id: string | null
    content: string
    mentions: string | null
  }>,
  chain: { anchor: string | undefined; sessionId: string }
): string[] {
  return [
    buildReviewLoopHint(agent, relevantMessages, chain),
    buildHandoffTriggerHint(triggerContent),
    buildTriggerFocusHint(triggerContent),
  ].filter((h): h is string => h !== null)
}

/**
 * 格式化用户消息为 LLM 上下文字符串。
 *
 * 纯函数，无副作用。
 *
 * @param content 消息内容
 * @param mentions @mention 的 agent 名列表
 * @param audience 受众标签（'对你' / '对大家'）
 * @param isLast 是否为最后一条消息（决定是否携带受众标签）
 * @returns 格式化后的用户消息字符串
 */
export function formatUserMessage(
  content: string,
  mentions: string[],
  audience: string,
  isLast: boolean
): string {
  const tagged = mentions.length > 0 ? `（@了${mentions.join('、')}）` : ''
  if (isLast) {
    return `【当前待回复】用户${tagged}${audience}：${content}`
  }
  return `用户${tagged}：${content}`
}

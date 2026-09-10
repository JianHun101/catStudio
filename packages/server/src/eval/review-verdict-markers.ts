/**
 * 审查判词标记表 — **字符串集的单一来源**（T-L，2026-09-10 店长裁决）。
 *
 * 两个消费方各自的**匹配语义不同源**（既有裁决，勿再按「同语义」对齐）：
 * - `eval/verdict-parser.ts`：**行首锚定** + A/B 候选分级（只有结论行才算数）
 * - `execution/hints.ts`：全文取**最后出现者**（审查结论总在消息末尾，正文可能引用）
 * 本模块只统一「emoji / 后缀 / 判词」三元组这一**字符串集**，不含任何匹配逻辑。
 *
 * 为什么需要：两处各自维护字面量时，改一处漏一处 = **视觉同形不同判**。
 * T-L 根因即此——emoji 与后缀之间多一个空格（`⚠️ 建议修改`），两侧都零容忍，
 * 实测 3/5 样本判词丢失（该返工的没返工、该收口的收不了）。
 */

export type ReviewVerdict = 'approve' | 'comment' | 'suggest' | 'reject'

export interface ReviewVerdictMarker {
  emoji: string
  suffix: string
  verdict: ReviewVerdict
}

/**
 * 标记三元组（顺序 = 同级冲突取最严时的稳定遍历序，勿随意重排）。
 *
 * ⚠️ `suffix` **不含** emoji 与后缀之间的空白：真实审查输出两种形态并存
 * （`⚠️ 建议修改` 带空格 / `⚠️建议修改` 不带），视觉同形必须同判
 * ⇒ 两个消费方各自在 emoji 与后缀之间放宽 `\s*`，而**行尾判据不放宽**
 * （`✅可合并了` 后接汉字仍须拒绝，那道闸不得因放宽空白而失效）。
 */
export const REVIEW_VERDICT_MARKERS: readonly ReviewVerdictMarker[] = [
  { emoji: '✅', suffix: '可合并', verdict: 'approve' },
  { emoji: '💬', suffix: '仅评论', verdict: 'comment' },
  { emoji: '⚠️', suffix: '建议修改', verdict: 'suggest' },
  { emoji: '❌', suffix: '需重做', verdict: 'reject' },
]

/** 行首结论 emoji 类（bad_verdict 防御面）——由标记表派生，不另立字面量 */
export const REVIEW_VERDICT_EMOJI_RE = new RegExp(
  `^[${REVIEW_VERDICT_MARKERS.map((m) => m.emoji).join('')}]`,
  'u'
)

/** 标记的规范显示形态（`⚠️建议修改`）——仅用于注入文案，不参与匹配 */
export function reviewMarkerLabel(marker: ReviewVerdictMarker): string {
  return `${marker.emoji}${marker.suffix}`
}

/** 正则字面量转义（当前 emoji/后缀无特殊字符，但表变动时不该靠「碰巧」） */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

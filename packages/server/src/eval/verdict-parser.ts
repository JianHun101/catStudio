/**
 * W3 L3 审查结论解析器 — 从 reviewer 回复中提取结构化审查结论。
 *
 * 纯函数 parseReviewVerdict 无 I/O（可单独测试）；recordReviewVerdict 是
 * 解析 + 落库包装（socketio.ts 钩子调用点），内部每个写操作独立 try/catch，
 * DB 异常静默丢弃——审查链主流程零阻塞（契约边界钉死）。
 *
 * 标记锚定**行首**（归一化后——允许前导空白、markdown 装饰、「结论：」类标签
 * 前缀）：✅可合并 / ⚠️建议修改 / ❌需重做。
 * 防正文复述误命中——"这个方案 ✅可合并" 出现在句中不算结论（装饰剥离只做
 * 行首/行尾，句中复述仍不匹配）。
 * 多标记并存的取舍见下方「候选分级」段（A 级优先 + 同级取最严）——**不取
 * 「最后出现者」**。注意 hints.ts 的 buildReviewLoopHint 仍是 lastIndexOf 语义，
 * 两者已不同源，勿再按「同语义」对齐。
 *
 * 候选分级（2026-09-09 店长裁决，治吐槽猫 ⚠️ 主项 2）：**A 级**=带标签前缀的
 * 标记（可带装饰），**B 级**=无标签、行首独占的裸标记；A 级优先于 B 级。
 * **一律排除**引用块行（`> `——引用按定义是转述）与列表项中的无标签标记
 * （`- ✅` 多为检查清单描述）；否则一条 ⚠️ 审查会因末尾引用了一行 ✅ 被误判
 * approve（契约③ 错误推进到 closed，不可逆）。同级冲突取最严（❌ > ⚠️ > ✅）——
 * 解析错误代价不对称：漏判只多一轮，误判 approve 会错误收口。
 */

import { insertReviewVerdict, insertReviewParseFailure } from '../db/repository/verdicts.js'

export type ReviewVerdict = 'approve' | 'suggest' | 'reject'

export type VerdictParseFailureReason = 'no_subject' | 'bad_verdict'

/** subject 候选目标（调用方传 role 判定 store——纯函数不做 DB 查询） */
export interface VerdictTarget {
  name: string
  isStore: boolean
}

const VERDICT_MARKERS: Array<{ emoji: string; suffix: string; verdict: ReviewVerdict }> = [
  { emoji: '✅', suffix: '可合并', verdict: 'approve' },
  { emoji: '⚠️', suffix: '建议修改', verdict: 'suggest' },
  { emoji: '❌', suffix: '需重做', verdict: 'reject' },
]

/** 归一化后行首三个结论 emoji 之一（bad_verdict 防御：有 emoji 但非标准 marker） */
const VERDICT_EMOJI_RE = /^[✅⚠️❌]/

/** 行首通用装饰：空白 / markdown 标题 / 强调开 */
const LEADING_DECOR_RES: RegExp[] = [/^\s+/, /^#{1,6}\s+/, /^(\*\*|__)/]

/** 引用块前缀——**一律排除**（引用按定义是转述他人结论，不是本消息判定） */
const QUOTE_PREFIX_RE = /^\s*>\s?/

/** 列表项前缀——无标签的列表标记排除（实测本会话 8 行 `- ✅`/`- ⚠️` 是检查清单描述） */
const LIST_PREFIX_RE = /^\s*[-*+]\s+/

/** 行尾装饰：空白 / 强调闭 */
const TRAILING_DECOR_RES: RegExp[] = [/\s+$/, /(\*\*|__)$/]

/** 行首标签前缀——真实审查输出的常见形态（`结论：⚠️建议修改`）；
 *  容忍标签与冒号之间夹强调闭（`- **结论**：⚠️建议修改`）。
 *  长标签在前（`结论判定` 必须早于 `结论`——alternation 匹配 `结论` 后遇 `判`
 *  会整体回溯失败，不再试后面的分支；循环剥离也救不了，实测确认）。 */
const LABEL_PREFIX_RE = /^(?:审查结论|复审结论|结论判定|结论|判定)\s*(?:\*\*|__)?\s*[:：]\s*/

/** 归一化后的单行 + 候选分级信息 */
interface VerdictLine {
  /** 剥净装饰/标签/块级前缀后的文本 */
  text: string
  /** 带标签前缀（`结论：`/`审查结论：`/`判定：`）→ A 级候选 */
  hasLabel: boolean
  /** 引用块行，或列表项中的无标签标记 → 一律排除 */
  excluded: boolean
}

/**
 * 归一化单行：剥块级前缀（引用/列表）+ 循环剥行首装饰 + 标签前缀 + 行尾装饰。
 *
 * 为什么需要：真实审查输出是 `**结论：⚠️建议修改**——续写正文` 这类带 markdown
 * 装饰与标签前缀的写法，旧实现只允许前导空白 → 既不匹配 marker、也不记
 * bad_verdict，静默 no-marker（2026-09-09 实证：本会话 review_verdicts 零行）。
 * 规范层（cat-roles.md）只要求「标记独立成行」，没要求「裸标记」。
 * 剥离只做行首/行尾——句中复述仍不匹配，保留防误命中的初衷。
 * 循环上限 8：装饰与标签交错时（`**结论：✅可合并**`）需两轮，正常 1 轮收敛。
 *
 * excluded 判定见文件头：引用块行一律排除；列表项只在**带标签**时算候选
 * （`- **结论**：⚠️建议修改` 是真实形态，`- ✅` 是清单描述）。
 */
function normalizeVerdictLine(line: string): VerdictLine {
  let s = line
  const quoted = QUOTE_PREFIX_RE.test(s)
  if (quoted) s = s.replace(QUOTE_PREFIX_RE, '')
  const listed = LIST_PREFIX_RE.test(s)
  if (listed) s = s.replace(LIST_PREFIX_RE, '')
  let hasLabel = false
  for (let i = 0; i < 8; i++) {
    let next = s
    for (const re of LEADING_DECOR_RES) next = next.replace(re, '')
    const stripped = next.replace(LABEL_PREFIX_RE, '')
    if (stripped !== next) {
      hasLabel = true
      next = stripped
    }
    for (const re of TRAILING_DECOR_RES) next = next.replace(re, '')
    if (next === s) break
    s = next
  }
  return { text: s, hasLabel, excluded: quoted || (listed && !hasLabel) }
}

/**
 * 标记匹配：`^<emoji><suffix>` 且后接**非字母数字**（空白 / 行尾 / 强调闭 / 标点）。
 *
 * 为什么要「非字母数字」而非旧的 `(?=\s|$)`：真实审查输出是
 * `**结论：⚠️建议修改**——方向正确，但 3 点需处理。`——强调闭合 `**` 与破折号
 * 紧贴标记，旧 lookahead 遇 `*` 不匹配 → 整条结论静默 bad_verdict（2026-09-09
 * 吐槽猫实测：本会话 14 条真实审查消息仅 2 条落 verdict）。
 * 仍拒绝 `✅可合并了`（后接汉字）——那是句中复述/格式漂移，记 bad_verdict。
 */
function matchesMarker(line: string, marker: (typeof VERDICT_MARKERS)[number]): boolean {
  const escaped = marker.emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}${marker.suffix}(?=\\s|$|[^\\p{L}\\p{N}])`, 'u').test(line)
}

/** 结论严重度——同级冲突取最严（错误代价不对称，见文件头） */
const VERDICT_SEVERITY: Record<ReviewVerdict, number> = { approve: 0, suggest: 1, reject: 2 }

/**
 * 从归一化行中选出结论：A 级（带标签）优先于 B 级（裸标记）；
 * 同级冲突取最严（❌ > ⚠️ > ✅），无冲突即该标记本身。
 */
function pickVerdict(lines: VerdictLine[]): ReviewVerdict | null {
  const candidates: Array<{ level: 'A' | 'B'; verdict: ReviewVerdict }> = []
  for (const line of lines) {
    if (line.excluded) continue
    for (const marker of VERDICT_MARKERS) {
      if (matchesMarker(line.text, marker)) {
        candidates.push({ level: line.hasLabel ? 'A' : 'B', verdict: marker.verdict })
      }
    }
  }
  if (!candidates.length) return null
  const labeled = candidates.filter((c) => c.level === 'A')
  const pool = labeled.length ? labeled : candidates
  return pool.reduce<ReviewVerdict>(
    (worst, c) => (VERDICT_SEVERITY[c.verdict] > VERDICT_SEVERITY[worst] ? c.verdict : worst),
    pool[0].verdict
  )
}

export type VerdictParseResult =
  /** 无行首标记 → 钩子不落库不记录 */
  | { kind: 'no-marker' }
  /** 合法结论。suggest/reject 且无 subject 时 failure='no_subject'（双写 failure 表） */
  | {
      kind: 'verdict'
      verdict: ReviewVerdict
      subject: string | null
      failure: VerdictParseFailureReason | null
    }
  /** 行首是结论 emoji 但非标准 marker（格式漂移防御）→ 只写 failure 表 */
  | { kind: 'failure'; reason: VerdictParseFailureReason }

/** 剥代码块 + 行内代码后的纯文本（a2a-mentions.ts stripCode 同款剥离逻辑，
 *  不跨模块复用——解析器独立无外部依赖，防两处剥离规则漂移） */
function stripCode(content: string): string {
  const noCodeBlocks = content.replace(/```[\s\S]*?```/g, '')
  return noCodeBlocks
    .split('\n')
    .map((line) => line.replace(/`[^`]*`/g, ''))
    .join('\n')
}

/**
 * 解析审查结论。
 *
 * @param content reviewer 回复全文
 * @param targets 作用域 allowedNames 对应的目标（含 store 角色判定）——
 *   subject = 首个非 store 目标；suggest/reject 时无非 store 目标 → null + no_subject
 */
export function parseReviewVerdict(content: string, targets: VerdictTarget[]): VerdictParseResult {
  const text = stripCode(content)

  // 逐行分级：A 级（带标签）优先于 B 级（裸标记）；引用块 / 无标签列表项排除
  const lines = text.split('\n').map(normalizeVerdictLine)
  const verdict = pickVerdict(lines)

  if (!verdict) {
    // 无标准 marker：**参与判定的行**归一化后行首是结论 emoji 但格式漂移 →
    // bad_verdict（不静默）。排除行（引用/列表描述）的 emoji 记 failure 是噪音。
    const hasStrayEmoji = lines.some((line) => !line.excluded && VERDICT_EMOJI_RE.test(line.text))
    if (hasStrayEmoji) {
      return { kind: 'failure', reason: 'bad_verdict' }
    }
    return { kind: 'no-marker' }
  }

  if (verdict === 'approve') {
    // approve 恒置 null（即使 @ 了店长——subject 语义只对需要返工的结论有意义）
    return { kind: 'verdict', verdict: 'approve', subject: null, failure: null }
  }

  const subject = targets.find((t) => !t.isStore)
  if (!subject) {
    return {
      kind: 'verdict',
      verdict,
      subject: null,
      failure: 'no_subject',
    }
  }
  return { kind: 'verdict', verdict, subject: subject.name, failure: null }
}

/**
 * 解析 + 落库包装（socketio.ts 钩子调用点）。
 * 每个写操作独立 try/catch——DB 异常静默丢弃（写入包 try/catch 契约），
 * 函数永不抛，审查链主流程零阻塞。
 *
 * @returns 落盘的审查结论（approve/suggest/reject）；无有效结论（no-marker/failure）
 *   返回 null——供契约③状态机（flow-advance）判断是否推进，null 则不推进。
 */
export function recordReviewVerdict(opts: {
  messageId: string
  sessionId: string
  reviewerAgentId: string
  content: string
  targets: VerdictTarget[]
}): ReviewVerdict | null {
  const result = parseReviewVerdict(opts.content, opts.targets)
  if (result.kind === 'no-marker') return null

  if (result.kind === 'failure') {
    try {
      insertReviewParseFailure({
        messageId: opts.messageId,
        reason: result.reason,
        raw: opts.content,
      })
    } catch {
      // DB 异常静默丢弃
    }
    return null
  }

  try {
    insertReviewVerdict({
      messageId: opts.messageId,
      sessionId: opts.sessionId,
      reviewerAgentId: opts.reviewerAgentId,
      subjectAgentId: result.subject,
      verdict: result.verdict,
    })
  } catch {
    // DB 异常静默丢弃
  }
  if (result.failure) {
    try {
      insertReviewParseFailure({
        messageId: opts.messageId,
        reason: result.failure,
        raw: opts.content,
      })
    } catch {
      // DB 异常静默丢弃
    }
  }
  return result.verdict
}

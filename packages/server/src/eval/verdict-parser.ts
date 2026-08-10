/**
 * W3 L3 审查结论解析器 — 从 reviewer 回复中提取结构化审查结论。
 *
 * 纯函数 parseReviewVerdict 无 I/O（可单独测试）；recordReviewVerdict 是
 * 解析 + 落库包装（socketio.ts 钩子调用点），内部每个写操作独立 try/catch，
 * DB 异常静默丢弃——审查链主流程零阻塞（契约边界钉死）。
 *
 * 标记锚定**行首**（允许前导空白）：✅可合并 / ⚠️建议修改 / ❌需重做。
 * 防正文复述误命中——"这个方案 ✅可合并" 出现在句中不算结论。
 * 多标记取最后出现者（与 buildReviewLoopHint 同语义：结论总在消息末尾）。
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

/** 行首三个结论 emoji 之一（bad_verdict 防御判定：有 emoji 但非标准 marker） */
const VERDICT_EMOJI_RE = /^\s*[✅⚠️❌]/

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

  // 行首精确匹配标准 marker，取最后出现者（结论在末尾语义）
  let last: { marker: (typeof VERDICT_MARKERS)[number]; line: string } | null = null
  for (const line of text.split('\n')) {
    for (const marker of VERDICT_MARKERS) {
      const escaped = marker.emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // (?=\s|$) 行尾必须是空白或行尾——防 ✅可合并了 这类前缀误命中
      if (new RegExp(`^\\s*${escaped}${marker.suffix}(?=\\s|$)`, 'm').test(line)) {
        // 同行使多个 marker 时后者胜（正则按行测，取整行最后一次循环结果）
        last = { marker, line }
      }
    }
  }

  if (!last) {
    // 无标准 marker：行首是结论 emoji 但格式漂移 → bad_verdict（不静默）
    const hasStrayEmoji = text.split('\n').some((line) => VERDICT_EMOJI_RE.test(line))
    if (hasStrayEmoji) {
      return { kind: 'failure', reason: 'bad_verdict' }
    }
    return { kind: 'no-marker' }
  }

  if (last.marker.verdict === 'approve') {
    // approve 恒置 null（即使 @ 了店长——subject 语义只对需要返工的结论有意义）
    return { kind: 'verdict', verdict: 'approve', subject: null, failure: null }
  }

  const subject = targets.find((t) => !t.isStore)
  if (!subject) {
    return {
      kind: 'verdict',
      verdict: last.marker.verdict,
      subject: null,
      failure: 'no_subject',
    }
  }
  return { kind: 'verdict', verdict: last.marker.verdict, subject: subject.name, failure: null }
}

/**
 * 解析 + 落库包装（socketio.ts 钩子调用点）。
 * 每个写操作独立 try/catch——DB 异常静默丢弃（写入包 try/catch 契约），
 * 函数永不抛，审查链主流程零阻塞。
 */
export function recordReviewVerdict(opts: {
  messageId: string
  sessionId: string
  reviewerAgentId: string
  content: string
  targets: VerdictTarget[]
}): void {
  const result = parseReviewVerdict(opts.content, opts.targets)
  if (result.kind === 'no-marker') return

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
    return
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
}

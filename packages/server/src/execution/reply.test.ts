/**
 * reply.ts 测试 — 同锚历史回捞上界（T-G 验收④）。
 *
 * 只覆盖 `selectTaskHistory` 这个**纯函数**截取器（`runAgentReply` 主流程需 LLM 适配器，
 * 不在本文件范围）。回捞病灶实测：单锚名下 20 条 / 7.7 万字符，原实现**无任何上限**
 * ⇒ 整段并入上下文。
 *
 * 计数口径（`estimateTokens`，@cat-study/shared）：`汉字数 × 1.5 + 非汉字数 × 0.25`，
 * 本文件每条再叠加 50 的 role 前缀开销 ⇒ n 个汉字的条目 = `ceil(n*1.5) + 50` token。
 */

import { describe, it, expect } from 'vitest'
import {
  selectTaskHistory,
  TASK_HISTORY_MAX_MESSAGES,
  TASK_HISTORY_BUDGET_TOKENS,
} from './reply.js'

/** 生成一条同锚历史（数组下标越小越旧） */
function msg(i: number, hanChars: number): { id: string; content: string } {
  return { id: `m${i}`, content: '汉'.repeat(hanChars) }
}

describe('execution/reply — selectTaskHistory（T-G 验收④ 回捞上界）', () => {
  it('超 token 预算 → 丢**最旧**、保最新（旧实现无上限，断言必红）', () => {
    // 每条 1000 汉字 = 1550 token；预算 3200 ⇒ 只留最新 2 条
    const rows = [msg(1, 1000), msg(2, 1000), msg(3, 1000)]
    const kept = selectTaskHistory(rows, new Set(), 3200)
    expect(kept.map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('单条即超预算 → 仍保该条（宁超预算不丢最新，与 summary 层同款启发式）', () => {
    const rows = [msg(1, 100), msg(2, 50000)]
    const kept = selectTaskHistory(rows, new Set(), 3200)
    expect(kept.map((m) => m.id)).toEqual(['m2'])
  })

  it('已在近期窗口内的消息（excludeIds）不重复注入，且不占预算', () => {
    // 每条 100 汉字 = 200 token；预算 450 只够两条 ⇒ 被排除的 m3 不占额度
    const rows = [msg(1, 100), msg(2, 100), msg(3, 100)]
    const kept = selectTaskHistory(rows, new Set(['m3']), 450)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(kept.map((m) => m.id)).not.toContain('m3')
  })

  it('输出保持**时间正序**（并入上下文时旧在前、新在后）', () => {
    const rows = [msg(1, 10), msg(2, 10), msg(3, 10)]
    const kept = selectTaskHistory(rows, new Set(), TASK_HISTORY_BUDGET_TOKENS)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('上界常量钉死（单位：条 / token）——上限一旦被摘掉本组用例即红', () => {
    expect(TASK_HISTORY_MAX_MESSAGES).toBe(30)
    expect(TASK_HISTORY_BUDGET_TOKENS).toBe(12_000)
  })
})

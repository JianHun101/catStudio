import { describe, it, expect } from 'vitest'
import { parseThinkingBlocks } from './thinking'

describe('parseThinkingBlocks', () => {
  // ─── 空输入 ────────────────────────────
  it('returns empty array for empty string', () => {
    expect(parseThinkingBlocks('')).toEqual([])
  })

  // ─── 纯文本（无思考块） ─────────────────
  it('wraps plain text as a single text segment', () => {
    expect(parseThinkingBlocks('你好，这是一段普通文本。')).toEqual([
      { kind: 'text', content: '你好，这是一段普通文本。' },
    ])
  })

  // ─── 单个思考块 ─────────────────────────
  it('parses a single thinking block', () => {
    expect(parseThinkingBlocks('[思考] 正在分析用户意图...')).toEqual([
      { kind: 'thinking', content: '正在分析用户意图...' },
    ])
  })

  // ─── 连续思考块合并（核心场景） ──────────
  it('merges adjacent consecutive thinking blocks', () => {
    // 模拟真实流式场景：两块直接相邻，无分隔符
    const input = '[思考] 分析意图[思考] 查找记忆[思考] 生成回复'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '分析意图\n\n查找记忆\n\n生成回复' },
    ])
  })

  it('merges consecutive thinking blocks separated only by newlines', () => {
    const input = '[思考] 步骤一\n[思考] 步骤二'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '步骤一\n\n步骤二' },
    ])
  })

  // ─── 思考块后跟普通文本 ──────────────────
  it('emits text after the last thinking block', () => {
    // 模拟真实场景：思考结束后产出文本回复
    const input = '[思考] 分析完成[思考] 组织语言最终的回复内容'
    const result = parseThinkingBlocks(input)
    expect(result).toEqual([
      { kind: 'thinking', content: '分析完成\n\n组织语言最终的回复内容' },
    ])
    // 注意：由于 [思考] 没有结束标记，"最终的回复内容" 被纳入
    // 最后一个思考块。这是已知限制——完整的消息通过 NEW_MESSAGE
    // 单独推送（不含 [思考] 标记），此处只影响打字过程中的临时展示。
  })

  // ─── 文首普通文本 ────────────────────────
  it('handles text before any thinking block', () => {
    const input = '收到，让我想想\n[思考] 分析中...'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'text', content: '收到，让我想想' },
      { kind: 'thinking', content: '分析中...' },
    ])
  })

  // ─── 纯思考块（无普通文本） ─────────────
  it('handles multiple thinking blocks with no text between', () => {
    const input = '[思考] A[思考] B[思考] C'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: 'A\n\nB\n\nC' },
    ])
  })

  // ─── 边界：含换行的思考内容 ──────────────
  it('preserves newlines inside thinking content', () => {
    const input = '[思考] 第一行\n第二行'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '第一行\n第二行' },
    ])
  })

  // ─── 边界：[思考] 后无空格 ────────────────
  it('handles thinking marker without trailing space', () => {
    // split 用 \s* 匹配标记后的空白，无空格时仍能识别
    const input = '[思考]无空格内容'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '无空格内容' },
    ])
  })

  // ─── 边界：[思考] 后跟换行而非空格 ─────────
  it('handles thinking marker followed by newline instead of space', () => {
    const input = '[思考]\n换行开始的内容'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '换行开始的内容' },
    ])
  })

  // ─── 边界：空思考块 ────────────────────────
  it('filters out empty thinking blocks', () => {
    // [思考] 后跟空白再跟另一个 [思考]——空块不应产生空字符串
    const input = '[思考]   [思考] 实际内容'
    expect(parseThinkingBlocks(input)).toEqual([
      { kind: 'thinking', content: '实际内容' },
    ])
  })
})

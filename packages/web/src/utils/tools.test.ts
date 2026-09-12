import { describe, it, expect } from 'vitest'
import { isAgentStoppable, isToolActive, toolAreaStatusWord, toolAreaSummary } from './tools'
import type { ToolCallInfo } from '@cat-study/shared'

/**
 * 消息渲染共用判定的纯单元测试。
 * 这些判据原先只长在 ChatPanel.vue 里，抽 MessageItem 后变成「历史气泡 + 流式气泡」
 * 两处消费——单源收在这里，行为必须与抽取前逐条一致（流式侧原断言见
 * ChatPanel.test.ts「停止按钮重定位」）。
 */

describe('isToolActive', () => {
  it('running / pending 为推进中，其余（含 undefined）为否', () => {
    expect(isToolActive({ status: 'running' })).toBe(true)
    expect(isToolActive({ status: 'pending' })).toBe(true)
    expect(isToolActive({ status: 'completed' })).toBe(false)
    expect(isToolActive({ status: 'error' })).toBe(false)
    expect(isToolActive({})).toBe(false)
  })
})

describe('toolAreaStatusWord / toolAreaSummary', () => {
  const tool = (status: string): ToolCallInfo => ({ name: 'Bash', status })

  it('有推进中 → 运行中（优先于失败计数）', () => {
    expect(toolAreaStatusWord([tool('running'), tool('error')])).toBe('运行中')
  })

  it('无推进中且有失败 → 全失败显示「失败」、部分失败显示「N 失败」', () => {
    expect(toolAreaStatusWord([tool('error')])).toBe('失败')
    expect(toolAreaStatusWord([tool('error'), tool('completed')])).toBe('1 失败')
  })

  it('全部完成 → 完成；空列表 → 空串（header 摘要不显示空词）', () => {
    expect(toolAreaStatusWord([tool('completed')])).toBe('完成')
    expect(toolAreaStatusWord([])).toBe('')
  })

  it('摘要文案：N 个工具 · 状态（无状态词时不拼尾巴）', () => {
    expect(toolAreaSummary([tool('completed'), tool('completed')])).toBe('2 个工具 · 完成')
    expect(toolAreaSummary([])).toBe('0 个工具')
  })
})

describe('isAgentStoppable（B2 停止按钮判据：busy 或有排队）', () => {
  it('busy → 可停', () => {
    expect(isAgentStoppable({ status: 'busy' })).toBe(true)
  })

  it('空闲但有排队任务 → 可停（AGENT_INTERRUPT 一个按钮覆盖两场景）', () => {
    expect(isAgentStoppable({ status: 'idle', queueLength: 2 })).toBe(true)
  })

  it('空闲无排队 / 状态缺失 → 不可停', () => {
    expect(isAgentStoppable({ status: 'idle', queueLength: 0 })).toBe(false)
    expect(isAgentStoppable(undefined)).toBe(false)
  })
})

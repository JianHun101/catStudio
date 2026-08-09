import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@cat-study/shared'
import { resolveDisplayPlaceholders } from './rolePlaceholders'

/** 测试用 agent 构造器（必填字段补齐） */
function makeAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    name: '店长',
    avatar: '🐱',
    systemPrompt: '',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'test',
    ...overrides,
  }
}

describe('resolveDisplayPlaceholders', () => {
  const agents: AgentConfig[] = [
    makeAgent({ id: 'store', name: '店长', role: 'store' }),
    makeAgent({ id: 'reviewer', name: '吐槽猫', role: 'reviewer' }),
  ]

  it('@架构师 → store 角色 agent 名', () => {
    expect(resolveDisplayPlaceholders('@架构师 请收口。', agents)).toBe('@店长 请收口。')
  })

  it('@审查者 → reviewer 角色 agent 名', () => {
    expect(resolveDisplayPlaceholders('@审查者 请审核。', agents)).toBe('@吐槽猫 请审核。')
  })

  it('同串多占位符同时替换', () => {
    expect(resolveDisplayPlaceholders('@架构师 与 @审查者 都要看。', agents)).toBe(
      '@店长 与 @吐槽猫 都要看。'
    )
  })

  it('角色缺失 → 保留字面（老库零回归）', () => {
    const noStore = agents.filter((a) => a.role !== 'store')
    expect(resolveDisplayPlaceholders('@架构师 请收口。', noStore)).toBe('@架构师 请收口。')
    const noReviewer = agents.filter((a) => a.role !== 'reviewer')
    expect(resolveDisplayPlaceholders('@审查者 请审核。', noReviewer)).toBe('@审查者 请审核。')
  })

  it('@作者 保留字面（前端无触发者上下文）', () => {
    expect(resolveDisplayPlaceholders('@作者 继续。', agents)).toBe('@作者 继续。')
  })

  it('无 @ 前缀叙述（"是项目架构师"）不受影响', () => {
    expect(resolveDisplayPlaceholders('你是项目架构师，负责整体设计。', agents)).toBe(
      '你是项目架构师，负责整体设计。'
    )
  })

  it('空 agents → 原样返回（加载时序天然降级）', () => {
    const content = '@架构师 请收口。'
    expect(resolveDisplayPlaceholders(content, [])).toBe(content)
  })
})

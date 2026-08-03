/**
 * seed-data.ts（buildDemoAgents）单元测试。
 *
 * 验证 agent system prompt 的内容完整性：共享角色边界、反镜像规则、
 * 开发/审查铁律、@作者 占位符、精简后无冗余 markdown 格式。
 * 原 socketio-context.test.ts 中 prompts 段归并于此（测试跟随被测模块）。
 */

import { describe, it, expect } from 'vitest'
import { buildDemoAgents } from './seed-data.js'

describe('agent system prompts', () => {
  const agents = buildDemoAgents()

  it('所有 agent 的 systemPrompt 包含共享角色边界（视觉专用猫豁免）', () => {
    for (const agent of agents) {
      if (agent.role === 'vision') continue // 图测猫是视觉指令 prompt，非角色扮演
      expect(agent.systemPrompt).toContain('只扮演自己的角色')
      expect(agent.systemPrompt).toContain('禁止代写或预判其他 Agent')
    }
  })

  it('所有 agent 的 systemPrompt 以共享前置声明开头（视觉专用猫豁免）', () => {
    for (const agent of agents) {
      if (agent.role === 'vision') continue
      expect(agent.systemPrompt).toMatch(/^你是一只拥有人工智能的猫/)
    }
  })

  it('店长和手下（ds猫/flash猫）的 systemPrompt 包含反镜像规则', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('用自己的话表达')
    }
  })

  it('店长和手下的 systemPrompt 包含开发铁律关键词', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('出口检查')
      expect(agent.systemPrompt).toContain('依赖安装')
    }
  })

  it('店长的 systemPrompt 包含角色标识', () => {
    const agent = agents.find((a) => a.name === '店长')!
    expect(agent.systemPrompt).toContain('暹罗猫')
    expect(agent.systemPrompt).toContain('温和从容')
  })

  it('吐槽猫的 systemPrompt 包含审查铁律关键词', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('依赖审查')
    expect(tucao.systemPrompt).toContain('Review指南')
  })

  it('吐槽猫的 systemPrompt 包含审查员角色', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('英短蓝猫')
    expect(tucao.systemPrompt).toContain('Code Reviewer')
  })

  it('精简后的 prompt 不应包含冗余 markdown 格式符', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).not.toContain('**出口检查**')
      expect(agent.systemPrompt).not.toContain('**代码审查**')
      expect(agent.systemPrompt).not.toContain('**依赖安装**')
      expect(agent.systemPrompt).not.toContain('## 开发铁律')
      expect(agent.systemPrompt).not.toContain('## 审查铁律')
    }
  })

  it('精简后的 prompt 不应包含 markdown 列表序号', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).not.toMatch(/\d\.\s+(必要性|安全性|影响)/)
    }
  })

  // ═══ @作者 占位符验证 ═══
  // @作者 在 seed-data 中是字面占位符，运行时由 runAgentReply 替换为实际触发者名字

  it('吐槽猫的 systemPrompt 包含 @作者 占位符', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('@作者')
    // 应该有 2 处：出口检查 + 代码审查
    const matches = tucao.systemPrompt.match(/@作者/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('店长和手下的 systemPrompt 不含 @作者（只有吐槽猫有）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('@作者')
    }
  })

  it('@作者 替换正则能正确替换为实际 agent 名', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    const replaced = tucao.systemPrompt.replace(/@作者/g, '@店长')
    // 替换后不应再有 @作者
    expect(replaced).not.toContain('@作者')
    // 应该有 @店长 出现（原来 @作者 的位置）
    expect(replaced).toContain('@店长')
    // 原来的 @引用 规则不应受影响
    expect(replaced).toContain('@猫名 必须行首独占一行')
  })

  // ═══ 精简后 prompt 关键规则完整性 ═══

  it('精简后的 IRON_LAWS_CODER 仍包含所有出口检查+审查+依赖+引用规则', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('出口检查')
      expect(agent.systemPrompt).toContain('自问')
      expect(agent.systemPrompt).toContain('行首@对方')
      expect(agent.systemPrompt).toContain('@吐槽猫')
      expect(agent.systemPrompt).toContain('依赖安装')
      expect(agent.systemPrompt).toContain('禁止直接安装')
      expect(agent.systemPrompt).toContain('行首独占一行')
    }
  })

  it('店长 prompt 重启规则为嵌中契约（任意位置触发，旧行首限制已移除）', () => {
    const boss = agents.find((a) => a.name === '店长')!
    expect(boss.systemPrompt).toContain('嵌在回复任意位置均可触发')
    expect(boss.systemPrompt).toContain('不必独占消息开头')
    expect(boss.systemPrompt).toContain('原因：')
    // 4b5f6c2 旧限制（必须单独一条消息/行首开头）与 9371c09 放宽契约矛盾，已移除
    expect(boss.systemPrompt).not.toContain('必须单独发一条消息')
    expect(boss.systemPrompt).not.toContain('禁止嵌在长汇报中间')
  })

  it('店长和手下的 prompt 含防复述约束（不完整复述重启请求格式）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('不要完整复述')
      expect(agent.systemPrompt).toContain('误触发请求文件')
    }
  })

  it('实施猫 prompt 含收口链指令（✅可合并 → 行首@店长 请收口）', () => {
    // 按 role 找而非按名字找——未来新增实施猫自动覆盖；店长是"被请收口"方不含此指令
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      expect(agent.systemPrompt).toContain('请收口')
      expect(agent.systemPrompt).toContain('行首')
      expect(agent.systemPrompt).toContain('不自行合并')
    }
  })

  it('精简后的 IRON_LAWS_REVIEWER 仍包含所有审查铁律', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('出口检查')
    expect(tucao.systemPrompt).toContain('结论清晰吗')
    expect(tucao.systemPrompt).toContain('代码审查')
    expect(tucao.systemPrompt).toContain('Checklist')
    expect(tucao.systemPrompt).toContain('可合并')
    expect(tucao.systemPrompt).toContain('建议修改')
    expect(tucao.systemPrompt).toContain('需重做')
    expect(tucao.systemPrompt).toContain('依赖审查')
    expect(tucao.systemPrompt).toContain('必要性')
    expect(tucao.systemPrompt).toContain('安全性')
    expect(tucao.systemPrompt).toContain('影响')
    expect(tucao.systemPrompt).toContain('审查维度')
    expect(tucao.systemPrompt).toContain('边界与安全')
  })
})

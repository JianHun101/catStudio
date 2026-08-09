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
      expect(agent.systemPrompt).toContain('@审查者')
      expect(agent.systemPrompt).toContain('依赖安装')
      expect(agent.systemPrompt).toContain('禁止直接安装')
      expect(agent.systemPrompt).toContain('行首独占一行')
    }
  })

  it('依赖审批【安装请求】块格式已并入铁律（操作层 md 拆除后行为规则进铁律）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('【安装请求】')
      expect(agent.systemPrompt).toContain('包名: <package-name>')
      expect(agent.systemPrompt).toContain('用途: <为什么需要这个包>')
      expect(agent.systemPrompt).toContain('替代: <有没有可以不装的方案>')
      expect(agent.systemPrompt).toContain('严禁声明和安装出现在同一轮回复中')
    }
  })

  it('IRON_LAWS_CODER 含 worktree 模式段（禁 --no-verify + 收口归店长 + push 失败预期）', () => {
    // worktree 定稿后派活规范：实施猫在 worktree 干活时受约束——绕过 .push-gate = 未审查分支上远端
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('Worktree 模式')
      expect(agent.systemPrompt).toContain('git -C')
      // 三条核心约束：禁绕过门禁 / 收口归店长 / push 失败是预期
      expect(agent.systemPrompt).toContain('绝不')
      expect(agent.systemPrompt).toContain('--no-verify')
      expect(agent.systemPrompt).toContain('收口归店长')
      expect(agent.systemPrompt).toContain('必失败是预期')
      expect(agent.systemPrompt).toContain('多轮审查')
    }
  })

  it('规则语境写死猫名零残留——三猫 prompt 不含 @ 形态的写死名（@审查者/@架构师 角色化）', () => {
    // 身份语境（裸名自我介绍/手下名单）保留；@ 前缀是 mention 形态，属规则语境必须角色化
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('@吐槽猫')
      expect(agent.systemPrompt).not.toContain('@店长')
      expect(agent.systemPrompt).not.toContain('@ds猫')
      expect(agent.systemPrompt).not.toContain('@flash猫')
    }
  })

  it('吐槽猫 prompt 规则语境无 @店长 写死（示例已改 @作者 占位符）', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).not.toContain('@店长')
    expect(tucao.systemPrompt).not.toContain('@吐槽猫')
    expect(tucao.systemPrompt).not.toContain('@ds猫')
    expect(tucao.systemPrompt).not.toContain('@flash猫')
  })

  it('吐槽猫 prompt 含审查结论分流规则（✅→@架构师 / ⚠️❌→@作者）', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    // 分流核心：✅可合并 收口信号直接到位（不@实施猫）；⚠️/❌ 才回作者（要改的才回）
    expect(tucao.systemPrompt).toContain('按结论分流')
    expect(tucao.systemPrompt).toContain('✅可合并 → 行首@架构师')
    expect(tucao.systemPrompt).toContain('⚠️建议修改/❌需重做 → 行首@作者')
    // 分流只改@投递目标，结论内容仍归请求人（细节在消息正文完整给出）
    expect(tucao.systemPrompt).toContain('内容仍归请求人')
    expect(tucao.systemPrompt).toContain('收口信号直接到位')
  })

  it('店长 prompt 重启规则为工具教法（request_user_action，文本格式不再教学）', () => {
    const boss = agents.find((a) => a.name === '店长')!
    // 结构化触发是主路径：教工具不教格式（格式漂移事故链 6231ec9/9371c09/2026-08-07 根治）
    expect(boss.systemPrompt).toContain('request_user_action')
    expect(boss.systemPrompt).toContain("type:'restart'")
    expect(boss.systemPrompt).toContain('等待用户批准')
    // 文本格式字样不再出现——复述抢占从源头根除（模型不再被教格式）
    expect(boss.systemPrompt).not.toContain('重启请求格式为')
    expect(boss.systemPrompt).not.toContain('『重启请求』')
    expect(boss.systemPrompt).not.toContain('嵌在回复任意位置均可触发')
  })

  it('店长和手下的 prompt 教工具而非文本格式（不教『重启请求』格式字样）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('request_user_action')
      expect(agent.systemPrompt).toContain('禁止自行 kill 或重启 server')
      // 旧格式教学字样（含防复述句）全部移除
      expect(agent.systemPrompt).not.toContain('重启请求格式为')
      expect(agent.systemPrompt).not.toContain('不要完整复述')
      expect(agent.systemPrompt).not.toContain('误触发请求文件')
    }
  })

  it('实施猫 prompt 含收口链指令（✅可合并 → 行首@架构师 请收口）', () => {
    // 按 role 找而非按名字找——未来新增实施猫自动覆盖；架构师是"被请收口"方不含此指令
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      expect(agent.systemPrompt).toContain('请收口')
      expect(agent.systemPrompt).toContain('行首')
      expect(agent.systemPrompt).toContain('不自行合并')
      expect(agent.systemPrompt).toContain('@架构师')
      expect(agent.systemPrompt).toContain('@审查者')
    }
  })

  it('实施猫 prompt 含审查链条件化措辞（无需主动跟进 + 收到✅兜底请收口）', () => {
    // 分流后实施猫不再被 ✅ 通知——条件化防「分流后永不触发的指令」认知悬置
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      // 主路径：提交后等待审查链自动收口、无需主动跟进
      expect(agent.systemPrompt).toContain('无需主动跟进')
      expect(agent.systemPrompt).toContain('先改再复申')
      expect(agent.systemPrompt).toContain('❌需重做')
      // 兜底路径：若收到 ✅（分流失败时原链仍通）→ 请收口指令保留
      expect(agent.systemPrompt).toContain('兜底路径')
      expect(agent.systemPrompt).toContain('✅可合并 → 行首@架构师 请收口')
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

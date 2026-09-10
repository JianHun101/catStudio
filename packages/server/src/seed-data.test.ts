/**
 * seed-data.ts（buildDemoAgents）单元测试。
 *
 * 验证 agent system prompt 的内容完整性：共享角色边界、反镜像规则、
 * 开发/审查铁律、@作者 占位符、精简后无冗余 markdown 格式。
 * 原 socketio-context.test.ts 中 prompts 段归并于此（测试跟随被测模块）。
 */

import { describe, it, expect } from 'vitest'
import {
  buildDemoAgents,
  buildDemoKnowledge,
  COMMON_IRON_LAWS,
  IRON_LAWS_CODER,
  IRON_LAWS_REVIEWER,
} from './seed-data.js'

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

  it('店长和手下（ds猫/flash猫）的 systemPrompt 不再烘焙反镜像规则（共通铁律层承载）', () => {
    // 反镜像规则（"用自己的话表达"）在 COMMON_IRON_LAWS 共通层——seed 已解除烘焙，
    // 铁律改由运行期按 role 注入（ironLawForRole），base prompt 不再内含
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('用自己的话表达')
    }
  })

  it('店长和手下的 systemPrompt 不再烘焙开发铁律关键词（运行期注入承载）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('出口检查')
      expect(agent.systemPrompt).not.toContain('依赖安装')
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

  // ═══ @作者 占位符验证（seed 解除烘焙后：占位符随铁律转运行期注入） ═══
  // @作者 在铁律常量中是字面占位符，seed 不再烘焙进 systemPrompt——运行期由
  // runAgentReply 按 role 注入铁律后再统一 resolveRolePlaceholders 替换为实际名字。

  it('吐槽猫的 systemPrompt 不再烘焙 @作者 占位符（占位符随铁律转运行期注入）', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).not.toContain('@作者')
  })

  it('店长和手下的 systemPrompt 不含 @作者', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('@作者')
    }
  })

  it('审查铁律常量（运行期注入源）含 @作者 占位符，替换正则能正确替换为实际 agent 名', () => {
    // 占位符从 seed prompt 移入 IRON_LAWS_REVIEWER 常量——替换能力由常量承载，
    // 运行时注入铁律后 resolveRolePlaceholders 仍能命中（@作者→实际触发者）
    const replaced = IRON_LAWS_REVIEWER.replace(/@作者/g, '@店长')
    expect(IRON_LAWS_REVIEWER).toContain('@作者')
    expect(replaced).not.toContain('@作者')
    expect(replaced).toContain('@店长')
  })

  // ═══ 精简后 prompt 关键规则完整性 ═══

  it('共通铁律层随 IRON_LAWS_CODER 注入——出口检查/投递/依赖安装/@引用/重启/结论先行齐全', () => {
    // 共通铁律层单源定义、组合进开发铁律（运行期注入源缺省兜底）——内容完整性仍须保证
    expect(IRON_LAWS_CODER).toContain('出口检查')
    expect(IRON_LAWS_CODER).toContain('自问')
    expect(IRON_LAWS_CODER).toContain('投递下一棒')
    expect(IRON_LAWS_CODER).toContain('@审查者')
    expect(IRON_LAWS_CODER).toContain('依赖安装')
    expect(IRON_LAWS_CODER).toContain('行首独占一行')
    expect(IRON_LAWS_CODER).toContain('结论先行')
    expect(IRON_LAWS_CODER).toContain('重启审批')
  })

  it('T2 铁律层承载——出口检查段含「未结束必须产出结构化投递信号」（硬信号，非软思考）', () => {
    // 承载物=铁律层出口检查段（ADR 0014 用户拍板取代「结尾思考」软触发）：流程未结束
    // 必须产出结构化投递信号 {targets,intent,ref} → post_message/行首 @。触发锚点从 skill
    //（软、字面死）迁移到铁律层（硬、可解析、每回复在场）。
    expect(COMMON_IRON_LAWS).toContain('未结束必须产出结构化投递信号')
    expect(COMMON_IRON_LAWS).toContain('{targets, intent, ref}')
    expect(COMMON_IRON_LAWS).toContain('post_message')
    expect(COMMON_IRON_LAWS).toContain('commit_sha')
  })

  it('共通铁律层单源——CODER 与 REVIEWER 都注入同一段共通控制流，且不跨角色重复', () => {
    // 共通控制流（出口检查/投递/重启审批等）单源到 COMMON_IRON_LAWS：每个角色常量
    // 各含一次、不各自复制改写——改一处共通规则，两角色同步生效
    expect(COMMON_IRON_LAWS).toContain('出口检查')
    expect(COMMON_IRON_LAWS).toContain('重启审批')
    expect(COMMON_IRON_LAWS).toContain('@引用规则')
    expect(COMMON_IRON_LAWS).toContain('结论先行')
    expect(COMMON_IRON_LAWS).toContain('投递下一棒')
    for (const law of [IRON_LAWS_CODER, IRON_LAWS_REVIEWER]) {
      expect(law.split('出口检查').length - 1).toBe(1)
      expect(law.split('重启审批').length - 1).toBe(1)
      expect(law.split('@引用规则').length - 1).toBe(1)
      expect(law.split('投递下一棒').length - 1).toBe(1)
    }
  })

  it('共通铁律层非命令式收敛——禁令堆砌不在铁律常量出现（对照 Pi 判据清单语气）', () => {
    // 派活单对照 Pi：把 禁止/必须/严禁 密集堆砌收敛为「什么情况该做什么」的判据语气。
    // 硬性 git 门禁保留单条「绝不 --no-verify」；一般禁令措辞改用正向行为描述。
    expect(IRON_LAWS_CODER).not.toContain('禁止直接安装')
    expect(IRON_LAWS_CODER).not.toContain('严禁声明和安装出现在同一轮回复中')
    expect(IRON_LAWS_CODER).not.toContain('禁止自行 kill 或重启 server')
    // 「必须」在共通层放宽：单处 T2 规格强制（未结束必须产出结构化投递信号）——是
    // 正向行为指令（必须做 X），非禁令堆砌；严禁/禁止/绝不 仍全查、hard 门禁仍保留
    expect(COMMON_IRON_LAWS.split('必须').length - 1).toBe(1) // 仅一处强制信号，不堆砌
    expect(COMMON_IRON_LAWS).not.toContain('严禁')
    expect(COMMON_IRON_LAWS).not.toContain('禁止')
    expect(COMMON_IRON_LAWS).not.toContain('绝不') // 硬性门禁在 CODER_DUTIES（Worktree 段），不在共通层
    expect(IRON_LAWS_CODER).toContain('绝不 --no-verify')
  })

  it('店长和手下的 systemPrompt 不再烘焙 IRON_LAWS_CODER 内容（出口检查/依赖安装/@审查者）', () => {
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('出口检查')
      expect(agent.systemPrompt).not.toContain('禁止直接安装')
      expect(agent.systemPrompt).not.toContain('行首独占一行')
    }
  })

  it('【安装请求】块格式并入共通铁律层（seed prompt 不再烘焙）', () => {
    // 行为规则进共通铁律层（操作层 md 拆除后）——内容随 CODER/REVIEWER 注入，base prompt 不烘焙
    expect(IRON_LAWS_CODER).toContain('【安装请求】')
    expect(IRON_LAWS_CODER).toContain('包名: <package-name>')
    expect(IRON_LAWS_CODER).toContain('用途: <为什么需要这个包>')
    expect(IRON_LAWS_CODER).toContain('替代: <有没有可以不装的方案>')
    expect(IRON_LAWS_CODER).toContain('声明与安装分两轮')
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('【安装请求】')
    }
  })

  it('IRON_LAWS_CODER 常量含 worktree 模式段（禁 --no-verify + 收口归店长 + push 失败预期）', () => {
    // worktree 定稿后派活规范：实施猫在 worktree 干活时受约束——绕过 .push-gate = 未审查分支上远端
    expect(IRON_LAWS_CODER).toContain('Worktree 模式')
    expect(IRON_LAWS_CODER).toContain('git -C')
    // 三条核心约束：禁绕过门禁 / 收口归店长 / push 失败是预期
    expect(IRON_LAWS_CODER).toContain('绝不')
    expect(IRON_LAWS_CODER).toContain('--no-verify')
    expect(IRON_LAWS_CODER).toContain('收口归店长')
    expect(IRON_LAWS_CODER).toContain('必失败是预期')
    expect(IRON_LAWS_CODER).toContain('多轮审查')
    expect(IRON_LAWS_CODER).toContain('createPr 开 PR')
    // seed prompt 不再烘焙 worktree 约束
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('Worktree 模式')
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

  it('吐槽猫 base prompt 不再烘焙审查结论分流规则（占位符随铁律转运行期注入）', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    // 分流规则在 IRON_LAWS_REVIEWER 铁律层（运行期注入）——base prompt 不再内含
    expect(tucao.systemPrompt).not.toContain('按结论分流')
    expect(tucao.systemPrompt).not.toContain('✅可合并 → 行首@架构师')
  })

  it('店长 prompt 不再烘焙重启规则为工具教法（共通铁律层承载）', () => {
    const boss = agents.find((a) => a.name === '店长')!
    // 重启审批规则在 COMMON_IRON_LAWS 共通层（随开发铁律注入）——base prompt 不再内含
    expect(boss.systemPrompt).not.toContain('request_user_action')
    expect(boss.systemPrompt).not.toContain("type:'restart'")
  })

  it('店长/吐槽猫 systemPrompt 不再烘焙共通控制流（投递/出口判断——共通铁律层承载）', () => {
    // 共通控制流（投递/出口判断/重启审批/安装请求/结论先行）单源到 COMMON_IRON_LAWS，
    // 角色 systemPrompt 只留「我是谁 + 特有这批活怎么干」——共通层由 runAgentReply 按 role 注入
    const boss = agents.find((a) => a.name === '店长')!
    expect(boss.systemPrompt).not.toContain('投递下一棒')
    expect(boss.systemPrompt).not.toContain('post_message')
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).not.toContain('出口检查')
    expect(tucao.systemPrompt).not.toContain('投递下一棒')
    expect(tucao.systemPrompt).not.toContain('post_message')
  })

  it('店长和手下的 prompt 不再烘焙重启审批工具教法（共通铁律层承载）', () => {
    // 工具教法在 COMMON_IRON_LAWS 共通层中（随 CODER/REVIEWER 注入）——内容完整性仍须保证
    expect(IRON_LAWS_CODER).toContain('request_user_action')
    expect(IRON_LAWS_CODER).toContain('不自 kill')
    for (const name of ['店长', 'ds猫', 'flash猫']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('request_user_action')
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
      // 主路径：投递审查请求后无需主动跟进（漏投有兜底：回复没投出审查者时服务端在收尾补投）
      expect(agent.systemPrompt).toContain('无需主动跟进')
      expect(agent.systemPrompt).toContain('先改再复申')
      expect(agent.systemPrompt).toContain('❌需重做')
      // T-C 三档：作者侧也要认 💬（非阻断 → 同走收口，不返工）
      expect(agent.systemPrompt).toContain('💬仅评论')
      // 兜底路径：若收到 ✅（分流失败时原链仍通）→ 请收口指令保留
      expect(agent.systemPrompt).toContain('兜底路径')
      expect(agent.systemPrompt).toContain('✅可合并 → 行首@架构师 请收口')
    }
  })

  it('实施猫 prompt 明确实施完成回复不 @审查者（补填交接文档是唯一审查触发）', () => {
    // 病灶：旧文案「结束回复，post-commit 自动投递，@审查者 审查」把 @审查者 挂到结束回复上，
    // 实施猫读成「实施完成就该 @审查者」，同一 commit 多路审查信号（反复确认根因）
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      expect(agent.systemPrompt).toContain('实施完成回复不 @审查者')
      expect(agent.systemPrompt).toContain('唯一审查触发')
      // 回归护栏：旧歧义表述不再出现
      expect(agent.systemPrompt).not.toContain('结束回复，post-commit 自动投递，@审查者 审查')
    }
  })

  it('审查猫 prompt 含 💬仅评论 档 + 向严不向宽边界（T-C 生产者侧贯通）', () => {
    // 病灶：T-C 的 💬 只落在 verdict-parser / flow-advance / hints 三个**消费方**，
    // 生产者侧（审查猫自己的 prompt 与它读的 refs）零落点 → 「机器认 💬、猫从不发 💬」，
    // T-C 的全部改动不可达（T-D 复审必改 2）。本断言把「猫能发 💬」钉成契约防卷回。
    expect(IRON_LAWS_REVIEWER).toContain('💬仅评论')
    expect(IRON_LAWS_REVIEWER).toContain('向严不向宽')
    const reviewers = agents.filter((a) => a.role === 'reviewer')
    expect(reviewers.length).toBeGreaterThanOrEqual(1)
    for (const agent of reviewers) {
      expect(agent.systemPrompt).toContain('💬仅评论')
    }
  })

  it('实施猫 prompt 指向 request-review、不再写钩子自动触发（T-D 文案对齐）', () => {
    // T-A 把 post-commit 改成「有归属则静默」后，「提交后钩子自动投递」不再成立。
    // 铁律仍写自动触发 → 猫会等一个不会发生的投递（T-D 要关的正是这个窗口）。
    expect(IRON_LAWS_CODER).toContain('request-review')
    expect(IRON_LAWS_CODER).not.toContain('自动触发')
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      expect(agent.systemPrompt).toContain('request-review')
      expect(agent.systemPrompt).not.toContain('post-commit 自动投递审查链')
      expect(agent.systemPrompt).not.toContain('自动触发审查')
    }
  })

  it('实施猫 prompt 提交 uuid 取环境变量（$CATSTUDY_TRIGGER_MSG_ID）+ 缺失禁止编造（uuid 幻觉根治）', () => {
    // uuid 幻觉根因：触发消息 id 未注入 CLI 环境 → 猫编造合法格式 uuid 交差 → 反查 404 →
    // 审查链静默漏投。铁律明确「uuid 取环境变量 + 缺失禁止编造、报告环境未注入」
    const implementers = agents.filter((a) => a.role === 'implementer')
    expect(implementers.length).toBeGreaterThanOrEqual(1)
    for (const agent of implementers) {
      expect(agent.systemPrompt).toContain('$CATSTUDY_TRIGGER_MSG_ID')
      expect(agent.systemPrompt).toContain('服务端注入的真实触发消息 id')
      expect(agent.systemPrompt).toContain('禁止编造合法格式 uuid 交差')
      expect(agent.systemPrompt).toContain('报告环境未注入')
    }
  })

  it('知识条目【提交规范】提交 uuid 取环境变量 + 缺失禁止编造（uuid 幻觉根治）', () => {
    const doc = buildDemoKnowledge().find((d) => d.tags.includes('提交规范'))!
    expect(doc.content).toContain('$CATSTUDY_TRIGGER_MSG_ID')
    expect(doc.content).toContain('服务端注入的真实触发消息 id')
    expect(doc.content).toContain('禁止编造合法格式 uuid 交差')
    expect(doc.content).toContain('报告环境未注入')
  })

  it('IRON_LAWS_REVIEWER 常量仍包含所有审查铁律（运行期注入源）', () => {
    // 常量是运行期注入源（getIronLaws 缺省兜底）——内容完整性仍须保证
    expect(IRON_LAWS_REVIEWER).toContain('出口检查')
    expect(IRON_LAWS_REVIEWER).toContain('结论清晰吗')
    expect(IRON_LAWS_REVIEWER).toContain('代码审查')
    expect(IRON_LAWS_REVIEWER).toContain('Checklist')
    expect(IRON_LAWS_REVIEWER).toContain('可合并')
    expect(IRON_LAWS_REVIEWER).toContain('建议修改')
    expect(IRON_LAWS_REVIEWER).toContain('需重做')
    expect(IRON_LAWS_REVIEWER).toContain('依赖审查')
    expect(IRON_LAWS_REVIEWER).toContain('必要性')
    expect(IRON_LAWS_REVIEWER).toContain('安全性')
    expect(IRON_LAWS_REVIEWER).toContain('影响')
    expect(IRON_LAWS_REVIEWER).toContain('审查维度')
    expect(IRON_LAWS_REVIEWER).toContain('边界与安全')
  })

  it('吐槽猫 base prompt 不再烘焙审查铁律内容（依赖审查/审查维度等随铁律转运行期注入）', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).not.toContain('审查维度')
    expect(tucao.systemPrompt).not.toContain('边界与安全')
    expect(tucao.systemPrompt).not.toContain('结论清晰吗')
  })
})

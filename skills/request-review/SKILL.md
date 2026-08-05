---
name: request-review
description: 打包完成的工作并发送审查请求。使用 refs/review-request-template.md 模板，按照审查配对规则选择审查者。Use when work is complete and verified, quality-gate passed, and a review is needed. Not for reviewing code yourself (use review), receiving feedback (use receive-review), or requesting before quality-gate passes. Output a review request document in template format, @mentioning the paired reviewer.
---

# request-review

打包完成的工作，按审查配对规则发送给对应的审查者。

## 前置条件（必须全部满足）

- [ ] `/quality-gate` 已通过（PASS）
- [ ] `pnpm test` 全部通过
- [ ] `pnpm lint` 无新增错误
- [ ] 有明确的 diff（git 有变更）
- [ ] 新依赖（如有）已获批准

## 何时使用

- quality-gate 通过后
- 用户明确要求 "review" 或 "审查"
- 完成一个功能模块后

## 不使用的情况

- quality-gate 未通过
- 无代码变更（纯对话）
- 自己审查自己（违反铁律 P1）

## 执行步骤

### 步骤 1：收集原始需求

回顾对话历史，提取：

- 用户/任务最初的需求（5 行以内的原文引用）
- 需求来源（对话轮次或 issue 链接）

### 步骤 2：生成审查请求

使用 `refs/review-request-template.md` 模板，填写：

- **What**：按文件列出改动
- **Why**：关键设计决策
- **Tradeoff**：放弃的方案
- **Architecture Ownership**：影响哪个模块、边界变化
- **Open Questions**：不确定的点
- **Reviewer Checklist**：需要审查者确认的检查项
- **Self-Check Evidence**：quality-gate 报告摘要 + 测试结果

### 步骤 3：选择审查者

按照 `refs/shared-rules.md` 中的审查配对规则：

| 你的角色 | 首选审查者 | 降级审查者       |
| -------- | ---------- | ---------------- |
| 架构师   | 审查者     | 实施猫           |
| 实施猫   | 审查者     | 架构师           |
| 审查者   | 架构师     | 无（架构师兜底） |

规则：

1. 首选审查者（专职 Reviewer）
2. 审查者不可用 → 降级到对应实施猫/架构师（角色→真名由运行时 agents 表 role 字段动态确定）
3. 不能自己审自己
4. 在审查请求末尾 @选定的审查者

### 步骤 4：发送审查请求

输出完整的审查请求文档。

## 输出

审查请求文档（按模板格式），包含所有必填字段，末尾 @审查者。

## 衔接

- 发送后 → 等待审查者 `/receive-review`
- 被拒绝 → 修复后从 quality-gate 重新开始

## Common Mistakes

| 错误                                            | 正确做法                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Why/Tradeoff/Open Questions 留 TODO 空段就发    | 全字段补填；Tradeoff 没有就写「无」，Open Questions 没有也写「无」——空段让审查者分不清忘了还是真没有 |
| 一条消息里 @审查者 又 @架构师                   | 一条回复只 @ 一个 agent，两个动作拆两条消息                                                          |
| 自查没过就发审查请求                            | quality-gate PASS + 测试/lint 全绿是硬前置条件                                                       |
| Open Questions 不点名文件，丢给审查者全 diff 找 | 每条 OQ 点名具体文件/符号，把搜索空间缩到点名的位置                                                  |

## 与其他 skill 区别

| skill          | 区别                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| handoff        | 审查请求是完成工作的质量闸门；handoff 是跨会话/跨 agent 的上下文交接文档，与审查流程无关 |
| review         | request-review 是发起审查（打包工作+选择审查者）；review 是执行双轴代码审查              |
| receive-review | 互为对端：request-review 发出请求，receive-review 处理返回的反馈                         |
| quality-gate   | request-review 的前置条件，PASS 后才能发起                                               |

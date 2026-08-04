---
name: catstudy-request-review
description: >
  向审查者发送 review 请求。按审查配对规则把改动送到吐槽猫面前（代码质量 + 安全全面核实）。
  Use when: 自检通过后准备请审查者 review。
  Not for: 收到 review 结果（用 catstudy-receive-review）、自检（用 catstudy-quality-gate）。
  Output: Review 请求信 + 审查反馈。
triggers:
  - '请 review'
  - '帮我看看'
  - 'request review'
  - '审查'
---

# Request Review

把改动送到审查者面前，让审查者花时间在重点上——不是基础检查上。

## 核心知识

### 前置条件（三项都要满足才能发请求）

| 条件                         | 检查方式           | 未满足时                     |
| ---------------------------- | ------------------ | ---------------------------- |
| `catstudy-quality-gate` 通过 | 有本轮 gate report | BLOCKED — 先跑 quality-gate  |
| 测试全绿                     | 附测试命令输出     | BLOCKED — 修到绿灯再发       |
| 原始需求可引用               | 用户原话 + 来源    | BLOCKED — 审查者有权拒绝审查 |

### 审查者匹配规则

catStudy 是真实多 agent 协作（店长架构 + ds猫/flash猫 实施 + 吐槽猫审查）。跨猫审查通过 **真实审查链** 执行：

```
审查链：
1. 作者完成改动 + 测试全绿 → 提交（带 catstudy [uuid] 标记）
2. post-commit 自动生成交接文档并投递 → @吐槽猫
3. 吐槽猫审查（全面核实：代码质量 + 安全 + 契约一致性）
4. ✅可合并 → 行首@店长 请收口；⚠️建议修改 → 先改再复申
```

**铁律**：不审查自己的代码。审查必须由非作者的猫（吐槽猫）执行。

### 审查 sub-agent 创建规范

```
正确做法 ✅：
  使用 Skill 工具调用现有技能：
    /code-review      → 审查 diff 找 bug + 简化/复用机会
    /security-review  → 安全审查
    /review           → 完整 PR 风格审查（规范 + 正确性）

错误做法 ❌：
  Agent(subagent_type="claude", prompt="帮我审查这段代码...")
  → 这是手写 prompt 绕过已有技能，审查质量不可控
```

## 流程

```
BEFORE 发 review 请求:

1. 确认 quality-gate 已通过（有本轮 gate report）
2. 确认测试全绿（附这次真实运行的输出）
3. 找到用户原始需求 + 摘录关键诉求
4. 用 ../refs/review-request-template.md 模板写 review 请求
5. 确定审查维度（代码质量 / 安全 / 综合）
6. 选择审查方式：
   - 首选：调用 /review、/code-review、/security-review 等现有技能
   - 这些技能内部会用合适的 agent 类型和 prompt 执行审查
7. 收集审查反馈
```

## Review 请求

**使用 `../refs/review-request-template.md` 模板**。

关键字段提醒：

- **Original Requirements**: 必填，用户原话 + 来源，并请审查者对照判断
- **Quality Gate 自检证据**: 附 gate report 摘要 + 测试命令输出
- **Review Focus**: 告诉审查者重点关注什么（不要让他从零开始读代码）
- **Tradeoff**: 已知的取舍，让审查者判断取舍是否合理

### 审查方式速查

| 场景          | 推荐技能           | 说明                         |
| ------------- | ------------------ | ---------------------------- |
| 通用改动      | `/review`          | 两轴审查（规范 + 正确性）    |
| 找 bug + 清理 | `/code-review`     | 审查 diff 找 bug + 简化/复用 |
| 安全敏感改动  | `/security-review` | XSS、注入、输入验证          |
| 只要代码清理  | `/simplify`        | 只做简化/复用/效率           |

## Block 场景

**❌ 没有 quality-gate 报告**

```
⚠️ BLOCKED — 缺少 quality-gate 自检报告

请先运行 catstudy-quality-gate skill，确认：
- 原始需求逐项对照
- 测试/lint/build 全绿
- 有本轮输出证据

再发 review 请求。
```

**❌ 没有原始需求摘录**

```
⚠️ BLOCKED — 缺少原始需求

请附上用户原话 + 来源。
审查者不只审代码质量，还要判断"这是用户要的吗？"
没有原始需求 = 审查者无法做愿景验证 = 有权拒绝审查。
```

**❌ 测试未通过**

```
⚠️ BLOCKED — 测试未全绿

请先修复，再发请求：
  pnpm test → 必须 0 failures

审查者不应该是第一个发现测试失败的人。
```

## 和其他 skill 的区别

| Skill                                   | 关注点                  | 时机                 |
| --------------------------------------- | ----------------------- | -------------------- |
| `catstudy-quality-gate`                 | 自检（需求对照 + 证据） | review **之前**      |
| **catstudy-request-review（本 skill）** | 把改动送到审查者面前    | 自检通过**之后**     |
| `catstudy-receive-review`               | 处理审查者的反馈        | 收到 review **之后** |

## 下一步

Review 请求发出后 → 等审查反馈 → **直接加载 `catstudy-receive-review`** skill 处理反馈。不要停下来问用户。

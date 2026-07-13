---
name: catstudy-receive-review
description: >
  处理审查者反馈：Red→Green 修复 + 技术论证（禁止表演性同意）。
  Use when: 收到 review 结果、审查者提了 P1/P2、需要处理反馈。
  Not for: 发 review 请求（用 catstudy-request-review）、自检（用 catstudy-quality-gate）。
  Output: 逐项修复确认。
triggers:
  - "review 结果"
  - "review 意见"
  - "审查者说"
  - "fix these"
  - "处理反馈"
---

# Receive Review

处理审查者反馈的完整流程。核心原则：**技术正确性 > 社交舒适，验证后再实现，禁止表演性同意。**

## 核心知识

### 两类反馈，处理方式不同

| 类型 | 特征 | 处理 |
|------|------|------|
| **代码级** | bug / edge case / 性能 / 命名 | Red→Green 修复流程 |
| **愿景级** | "这不是用户要的" / "缺了关键功能" / "交互不可用" | STOP → 回读用户原始需求 → 升级确认 |

> **愿景级反馈不能用代码 patch 修补设计问题。**

### 禁止的响应（表演性同意）

```
❌ "You're absolutely right!"    ❌ "Great point!"
❌ "Excellent feedback!"         ❌ "Thanks for catching that!"
❌ "让我现在就改"（验证之前）
```

行动说明一切——直接修复，代码本身证明你听到了反馈。

### Push Back 标准

当以下情况时**必须** push back，用技术论证，不是防御性反应：

- 建议会破坏现有功能
- 审查者缺少完整上下文
- 违反 YAGNI（过度设计）
- 与架构决策/用户需求冲突
- 建议会让实现**更偏离**用户原始需求

如果你 push back 了但你错了：陈述事实然后继续，不要长篇道歉。

**Review 有零分歧 = 走过场。真正的 review 需要技术争论。**

## 流程

```
WHEN 收到 review 反馈:

1. READ   — 完整读完，不要边读边反应
2. CLASSIFY — 区分愿景级 vs 代码级；按 P1/P2/P3 分优先级
3. CLARIFY — 有不清晰的问题先全部问清，再动手
4. VERIFY — 审查者说的问题真的存在吗？（见下方三道门）
5. FIX   — 通过验证的问题 Red→Green 修复
6. CONFIRM — 修完回给审查者确认
```

### VERIFY 三道门（少一道不准照改）

对每条 review 意见，改代码之前必须过三道门：

1. **Spec Gate** — 这条意见和现有需求冲突吗？
   - 冲突 → pushback，附需求原文
   - 不冲突 → 进下一道
2. **Mechanism Gate** — 审查者说"这不行"的证据是什么？
   - 有失败用例 / 真实边界条件 → 进下一道
   - 只是"不优雅"/"理论上不安全"但拿不出失败路径 → pushback 要求证据
3. **Feature Gate** — 按建议改完后，核心用户路径还活着吗？
   - 改完跑一遍最关键的用户路径（不是只跑测试）
   - 功能死了 → 回滚，审查建议作废

**修复顺序**：P1（阻塞）→ P2（必须修）→ P3（当场修或放下，不记 BACKLOG）

## Red→Green 修复流程

对每个 P1/P2 问题：

```
1. 理解问题
2. 写失败测试（Red）
3. 运行测试，确认红灯
4. 修复代码
5. 运行测试，确认绿灯（Green）
6. 运行完整测试套件，确认无 regression
```

**例外**：如果无法稳定自动化复现，提供最小手工复现步骤 + 说明原因，但不能跳过验证结论。

## 修复后确认

**修复完成 ≠ 可以合入。必须回到审查者确认。**

```markdown
## 修复确认

| # | 问题 | 严重度 | 状态 | Red→Green |
|---|------|--------|------|-----------|
| 1 | {描述} | P1 | ✅ | {test}: FAIL → PASS |
| 2 | {描述} | P2 | ✅ | {test}: FAIL → PASS |

测试结果：pnpm test → {N} passed, 0 failed
Commit: {sha} — {message}

请确认修复。
```

## 升级规则

**≥3 轮同型 finding**：同一状态对象的 finding 连续 ≥3 轮出现 → 不是你修得不对，是 plan/spec 层欠状态机的边。停手，回到设计阶段补状态转移和不变量。

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 边读边改，没读完 | 读完整反馈，分类后再动手 |
| 有不清晰的问题但先改清晰的 | 全部澄清后再统一动手 |
| 没写 Red 测试直接改代码 | 先写失败测试，确认红灯，再修 |
| 修完自判"对了"直接合入 | 必须回给审查者确认 |
| 全盘接受，零 push back | 有技术理由必须说出来 |
| 愿景级问题用代码 patch | STOP，回读需求，升级确认 |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `catstudy-quality-gate` | 自己检查自己（需求 + 证据） | 提 review 之前 |
| `catstudy-request-review` | 发出 review 请求 | 自检通过之后 |
| **catstudy-receive-review（本 skill）** | 处理审查者的反馈 | 收到 review 之后 |

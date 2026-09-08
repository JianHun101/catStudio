---
name: catstudy-quality-gate
description: >
  开发完成后的自检门禁：愿景对照 + spec 合规 + 测试/lint/build 验证。
  Use when: 开发完了准备提 review、声称完成了、准备交付。
  Not for: 收到 review 反馈（用 catstudy-receive-review）。
  Output: Quality Gate 合规报告。
triggers:
  - '开发完了'
  - '准备 review'
  - '自检'
  - 'quality gate'
  - '质量门'
---

# Quality Gate（质量门）

开发完成到提 review 之间的自检关卡：对照需求自检 + 用真实命令输出证明声明。

## 核心知识

**两条铁律合一**：

1. **与需求对齐**：回读用户原始需求，再逐项验收
2. **承诺需要证据**：没有运行命令、没看到输出，就不能说"通过了"

> 铁律：`NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`
>
> 自问："我是这次真的运行了命令并看到输出，还是只是相信它能工作？"

## 流程

```
BEFORE 声称完成 / 提 review:

Step 0: VISION CHECK（愿景核对）
  ① 回读用户原始需求（对话记录）
  ② 读核心诉求："我要..."、"我不想..."
  ③ 问自己：用户实际使用这个功能时，体验是什么样的？
  ④ 需求是否完整覆盖了用户的原始意图？
     → 如有遗漏，先确认再继续

Step 1: FIND — 找 spec/plan 文档
  - 相关的 feature spec 或实现计划
  - 设计讨论和架构决策记录

Step 2: CREATE — 建检查清单
  - 列出每一个功能点 / 边界条件
  - 列出用户描述的使用场景

Step 3: VERIFY — 逐项检查
  - 代码在哪？有测试覆盖？边界处理了吗？
  - 前端改动 → 有截图/录屏证据吗？
  - markdown/v-html 相关改动 → XSS 防护到位吗？

Step 4: RUN — 运行验证命令（必须这次真实运行）
  pnpm test              # 必须全部通过
  pnpm lint              # 0 errors
  pnpm build             # exit 0

Step 5: READ — 完整读输出，看 exit code，数失败数

Step 6: REPORT — 输出合规报告 + 证据
```

## Quick Reference

| Claim     | 需要                     | 不够用                  |
| --------- | ------------------------ | ----------------------- |
| 测试通过  | 这次运行输出：0 failures | "上次跑过"、"应该通过"  |
| lint 干净 | lint 输出：0 errors      | 部分检查、推断          |
| 构建成功  | build 命令：exit 0       | lint 通过不代表编译通过 |
| Bug 修了  | 原症状复现测试           | 代码改了，以为修了      |
| 需求满足  | 逐项打勾                 | 测试通过就完事          |

**合规报告模板**：

```markdown
## Quality Gate Report

原始需求: {用户原话}
检查时间: YYYY-MM-DD HH:MM

### 愿景覆盖（Step 0）

| #   | 用户原始需求 | 覆盖？ | 实现？ |
| --- | ------------ | ------ | ------ |
| 1   | "我要 XXX"   | AC#3   | ✅     |

### 功能验收

| #   | 要求 | 状态 | 代码位置    | 测试覆盖     |
| --- | ---- | ---- | ----------- | ------------ |
| 1   | XXX  | ✅   | file.ts:L10 | test.spec.ts |

### 验证命令输出（必须是这次真实运行）

pnpm test → {N}/{N} pass ✅
pnpm lint → 0 errors ✅
pnpm build → exit 0 ✅

### Open Questions

- {如果有未解决的问题，在这里列出}
- {全部解决才能提 review}
```

## Common Mistakes

| 错误                      | 正确做法                          |
| ------------------------- | --------------------------------- |
| 只检查 AC，没回读原始需求 | Step 0 先读用户原始需求           |
| "上次跑测试是通过的"      | 这次重新跑，看输出，再声明        |
| "应该没问题"              | Run the command. Read the output. |
| 测试通过就声称完成        | 还要对照需求逐项检查              |
| 前端功能没有截图证据      | 附上截图/录屏 + 映射表            |

**Red flags — 立刻 STOP**：

- 用 "should"、"probably"、"seems to"
- 表达满足感（"好了！"、"完成！"）时还没运行命令
- 信任 subagent 的 "success" 报告而没独立验证

## 和其他 skill 的区别

| Skill                        | 关注点               | 时机             |
| ---------------------------- | -------------------- | ---------------- |
| **quality-gate（本 skill）** | 对照需求 + 证据验证  | 提 review 之前   |
| `catstudy-receive-review`    | 处理 reviewer 的反馈 | 收到 review 之后 |

一句话：quality-gate 是"你自己检查自己"，receive-review 是"你处理审查者的意见"。

## 下一步

Quality Gate 通过后 → 提交代码，post-commit hook 自动触发审查（code-review 承担）。不要停下来问用户"要不要继续"。

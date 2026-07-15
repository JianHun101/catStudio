# CatStudy Skills

店长（暹罗猫）的开发工作流技能。参照 clowder-ai 的 `cat-cafe-skills/` 架构设计。

## 目录结构

```
catstudy/
├── README.md                    # 本文件 — 架构说明 + 索引
├── quality-gate/                # 质量门 — 开发完成后的自检
│   └── SKILL.md
├── request-review/              # 发起审查 — 把改动送到审查者面前
│   └── SKILL.md
├── receive-review/              # 接收审查 — 处理审查者的反馈
│   └── SKILL.md
└── refs/                        # 共享参考文件
    ├── shared-rules.md          # 开发协作规则（单一真相源）
    ├── cat-roles.md             # 猫角色定义 + 审查配对规则
    ├── review-standards.md      # P1/P2/P3 严重度标准
    └── review-request-template.md # Review 请求信模板
```

## 工作流

```
用户需求
  → 店长设计 + 写代码
  → /catstudy-quality-gate    （自检：需求对照 + 测试 + lint + build）
  → /catstudy-request-review   （发起审查：调用 /review、/code-review、/security-review）
  → /catstudy-receive-review   （处理反馈：Red→Green 修复）
  → 合入
```

## 与 clowder-ai 的差异

| 维度 | clowder-ai | catStudy |
|------|-----------|----------|
| 猫数量 | 3 只真正的 Claude Code agent | 1 只（店长），2 只 app 角色 |
| 审查方式 | 跨猫互审（Ragdoll ↔ Maine Coon ↔ Siamese） | 不同 Claude 模型的 sub-agent 模拟跨模型审查 |
| 技能位置 | `cat-cafe-skills/` → `~/.claude/skills/`（符号链接） | `.claude/skills/catstudy/`（项目内） |
| manifest | `manifest.yaml`（1324 行路由配置） | 轻量 manifest（~92 行，仅 4 技能 + pipeline + 铁律） |
| SOP 定义 | `sop-definitions/development.yaml` | 无（规模不需要） |
| merge-gate | 完整 PR 流程 + remote review | 简单合入（单猫开发无 PR 冲突） |

## 为什么没有 merge-gate

catStudy 只有店长一只猫在开发，没有 PR 冲突场景，没有 cloud review 需求。quality-gate → request-review → receive-review 三步已经覆盖了从自检到修复的完整循环。

## 技能命名

所有 catStudy 技能以 `catstudy-` 前缀命名，与 mattpocock 的通用技能区分：
- `/catstudy-quality-gate`
- `/catstudy-request-review`
- `/catstudy-receive-review`

用户也可以说"自检"、"请 review"、"处理反馈"等自然语言触发。

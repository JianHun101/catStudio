# CatStudy Skills

架构师角色的开发工作流技能。参照 clowder-ai 的 `cat-cafe-skills/` 架构设计。

## 目录结构

```
catstudy/
├── README.md                    # 本文件 — 架构说明 + 索引
├── quality-gate/                # 质量门 — 开发完成后的自检
│   └── SKILL.md
├── receive-review/              # 接收审查 — 处理审查者的反馈
│   └── SKILL.md
└── refs/                        # 共享参考文件
    └── cat-roles.md             # 猫角色定义 + 审查配对规则（角色词典）
    # shared-rules / review-standards / review-request-template 已随 refs 双套合并
    # 迁至顶级 skills/refs/（单源，此处不维护副本）
    # 投递型定制层（handoff/request-review）已按 ADR-0014 §3 移除，内容并入基础技能
```

## 工作流

```
用户需求
  → 架构师设计 + 派活
  → 实施猫落地
  → /catstudy-quality-gate    （自检：需求对照 + 测试 + lint + build）
  → 提交 → 补填交接文档 + 由作者发起审查请求（request-review）
  → /catstudy-receive-review   （处理反馈：Red→Green 修复）
   → 审查者审查 ✅ → 架构师收口（ff-only 合并 → 发起 push 审批，用户批准才推）
```

## 与 clowder-ai 的差异

| 维度       | clowder-ai                                           | catStudy                                                            |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 猫数量     | 3 只真正的 Claude Code agent                         | 4 只真正的 Claude Code agent（1 架构师 + 2 实施 + 1 审查者）        |
| 审查方式   | 跨猫互审（Ragdoll ↔ Maine Coon ↔ Siamese）           | 真实跨猫审查链（提交 → post-commit 投递 → 审查者审查 → 架构师收口） |
| 技能位置   | `cat-cafe-skills/` → `~/.claude/skills/`（符号链接） | `skills/` 单源 + `.claude/skills` junction 挂载                     |
| manifest   | `manifest.yaml`（1324 行路由配置）                   | `skills/manifest.yaml`（40/40 全覆盖 + pipeline + 铁律）            |
| SOP 定义   | `sop-definitions/development.yaml`                   | 无（规模不需要）                                                    |
| merge-gate | 完整 PR 流程 + remote review                         | 无 PR 流程：审查 ✅ 后由架构师 ff-only 收口                         |

## 为什么没有 PR 流程

catStudy 没有 PR 冲突场景：提交后由作者补填交接文档并发起审查请求，quality-gate → （request-review 发起）→ receive-review 覆盖从自检、生成交接文档、审查到修复的完整循环，审查 ✅ 后由架构师收口（ff-only 合并 → 更新 .push-gate → 发起 push 审批，用户批准才推）。

## 技能命名

所有 catStudy 技能以 `catstudy-` 前缀命名，与 mattpocock 的通用技能区分：

- `/catstudy-quality-gate`
- `/catstudy-receive-review`

用户也可以说"自检"、"交接"、"请 review"、"处理反馈"等自然语言触发。

# CatStudy Skills 注册表（BOOTSTRAP）

单源 `skills/` 的注册表。本文件 + `manifest.yaml` 是技能治理的两份登记：
manifest 管路由/来源/衔接，本文件管「技能是什么、从哪来、挂到哪」。

## 挂载拓扑

```
skills/（唯一真相源）
  └── .claude/skills （junction/symlink → skills/，Claude Code 一期）
      Kimi / Codex / Gemini 挂载位二期按需启用
```

- 挂载位不入库（.gitignore）；新 clone 环境跑 `node scripts/skills-bootstrap.mjs` 重建
- 挂载状态看板：`node scripts/skills-check-mount.mjs`
- 三方一致校验（阻塞）：`node scripts/skills-check-manifest.mjs`
- 失效链接清理：`node scripts/skills-clean-stale.mjs`

## 注册表（40 顶级 + 4 定制层）

来源：`self` = 猫咖自研 / `mattpocock` = mattpocock 系 / `external` = 其他第三方（provenance 追踪）

### 自研（self，4）

| skill          | 说明                                               |
| -------------- | -------------------------------------------------- |
| quality-gate   | 提交审查前自查门（审查链入口）                     |
| request-review | 发起审查请求（审查链）                             |
| receive-review | 处理审查反馈（审查链）                             |
| vision-assist  | 项目 qwen3.5:9b 视觉管线（模型无法原生看图时路由） |

### mattpocock 系（mattpocock，20）

ask-matt · decision-mapping · edit-article · grill-me · grill-with-docs · handoff ·
implement · improve-codebase-architecture · loop-me · prototype · setup-matt-pocock-skills ·
teach · to-issues · to-prd · triage · ubiquitous-language · writing-beats ·
writing-fragments · writing-great-skills · writing-shape

（session-summary 亦来自 mattpocock/skills，见 manifest；disable-model-invocation 为判定特征）

### 其他第三方（external，15）

codebase-design · design-an-interface · diagnosing-bugs · domain-modeling ·
git-guardrails-claude-code · grilling · migrate-to-shoehorn · obsidian-vault · qa ·
request-refactor-plan · resolving-merge-conflicts · review · scaffold-exercises ·
setup-pre-commit · tdd

### 项目定制层（catstudy/，4，self）

catstudy-quality-gate · catstudy-handoff · catstudy-request-review · catstudy-receive-review

参照 clowder-ai 的 `cat-cafe-skills/` 架构设计的先行试验（README 为设计文档）。
随迁保留但**一期不切路由**（manifest 仍路由顶级通用版），转正评估列二期。
内容已同步为当前 4 猫团队结构（审查链：实施 → post-commit 投递 → 吐槽猫审查 → 店长收口）。

## 同步溯源

第三方 skill 的同步来源/版本记录在 `skills/.sync-provenance.json`
（gitignore 不入库，机器生成：source/commit/secret_scan 结果）。
新增第三方 skill 准入：无来源登记 → `skills-check-manifest.mjs` 红示拦截。

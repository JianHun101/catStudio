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

## 注册表（27 顶级 + 4 定制层）

来源：`self` = 猫咖自研 / `mattpocock` = mattpocock 系 / `external` = 其他第三方（provenance 追踪）

### 自研（self，7）

| skill               | 说明                                                   |
| ------------------- | ------------------------------------------------------ |
| quality-gate        | 提交审查前自查门（审查链入口）                         |
| request-review      | 发起审查请求（审查链）                                 |
| receive-review      | 处理审查反馈（审查链，拒绝表演性同意 + P1/P2/P3 分级） |
| vision-assist       | 项目 qwen3.5:9b 视觉管线（模型无法原生看图时路由）     |
| on-site-project     | 驻场外部项目全流程方法论（集中+持久工作区）            |
| break-tunnel-vision | 跳出牛角尖排障方法论                                   |
| session-summary     | 生成 CatStudy 五段式会话总结（v1.1 起归自研维护）      |

### mattpocock 系（mattpocock，12）

grill-me · grill-with-docs · handoff · implement · improve-codebase-architecture ·
prototype · to-spec · to-tickets · triage · wayfinder · writing-great-skills · code-review

（v1.1 主线：`grill-with-docs → to-spec → to-tickets → implement → code-review`；
`to-spec`=旧 `to-prd` 改名、`to-tickets`=旧 `to-issues` 改名+并 `to-plan`、`wayfinder` 全新、`code-review` 取代旧 `review`）

### 其他第三方（external，8）

codebase-design · diagnosing-bugs · domain-modeling · git-guardrails-claude-code ·
grilling · resolving-merge-conflicts · setup-pre-commit · tdd

### 项目定制层（catstudy/，4，self）

catstudy-quality-gate · catstudy-handoff · catstudy-request-review · catstudy-receive-review

参照 clowder-ai 的 `cat-cafe-skills/` 架构设计的先行试验（README 为设计文档）。
随迁保留但**一期不切路由**（manifest 仍路由顶级通用版），转正评估列二期。
内容已同步为当前角色化团队结构（审查链：实施猫 → post-commit 投递 → 审查者审查 → 架构师收口；真名映射由 agents 表 role 字段动态确定）。

## 同步溯源

第三方 skill 的同步来源/版本记录在 `skills/.sync-provenance.json`
（gitignore 不入库，机器生成：source/commit/secret_scan 结果）。
新增第三方 skill 准入：无来源登记 → `skills-check-manifest.mjs` 红示拦截。

本次 v1.1 对齐：上游 `mattpocock/skills` tag `v1.1.0`；丢弃集 17（ask-matt · decision-mapping ·
edit-article · obsidian-vault · design-an-interface · qa · request-refactor-plan ·
ubiquitous-language · loop-me · migrate-to-shoehorn · review · scaffold-exercises ·
setup-matt-pocock-skills · teach · writing-beats · writing-fragments · writing-shape）已删除。

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

## 注册表（28 顶级 + 2 定制层）

来源：`self` = 猫咖自研 / `mattpocock` = mattpocock 系 / `external` = 其他第三方（provenance 追踪）

### 自研（self，7）

| skill               | 说明                                                       |
| ------------------- | ---------------------------------------------------------- |
| spec-gate           | 需求进实施前自查门（可证伪 + 契约锁定，对称 quality-gate） |
| quality-gate        | 提交审查前自查门（审查链入口）                             |
| request-review      | 发起审查请求的门槛与轮次规则（作者自行发起，非 hook 投递） |
| receive-review      | 处理审查反馈（审查链，拒绝表演性同意 + P1/P2/P3 分级）     |
| on-site-project     | 驻场外部项目全流程方法论（集中+持久工作区）                |
| break-tunnel-vision | 跳出牛角尖排障方法论                                       |
| session-summary     | 生成 CatStudy 五段式会话总结（v1.1 起归自研维护）          |

### mattpocock 系（mattpocock，12）

grill-me · grill-with-docs · session-handoff · implement · improve-codebase-architecture ·
prototype · to-spec · to-tickets · triage · wayfinder · writing-for-agents · code-review

（v1.1 主线：`grill-with-docs → to-spec → to-tickets → implement → code-review`；
`to-spec`=旧 `to-prd` 改名、`to-tickets`=旧 `to-issues` 改名+并 `to-plan`、`wayfinder` 全新、`code-review` 取代旧 `review`）

### 其他第三方（external，9）

codebase-design · design-taste-frontend · diagnosing-bugs · domain-modeling ·
git-guardrails-claude-code · grilling · resolving-merge-conflicts · setup-pre-commit · tdd

（`design-taste-frontend` 来源 `Leonxlnx/taste-skill`（非 mattpocock 系）——
上游 `skills/taste-skill/SKILL.md` 逐字 vendor；版本锚点见 `skills-lock.json` 该条目
（`source` / `skillPath` / `computedHash`），vendor 口径见本档「同步溯源」）

### 项目定制层（catstudy/，2，self）

catstudy-quality-gate · catstudy-receive-review

参照 clowder-ai 的 `cat-cafe-skills/` 架构设计的先行试验（README 为设计文档）。
随迁保留但**一期不切路由**（manifest 仍路由顶级通用版），转正评估列二期。
内容已同步为当前角色化团队结构（审查链：实施猫 → 自行发起审查请求 → 审查者审查 → 架构师收口；真名映射由 agents 表 role 字段动态确定）。

## 同步溯源

第三方 skill 的 provenance 真相源是 **`skills-lock.json`**：`source`（上游仓库）+
`skillPath`（上游路径）+ `computedHash`（按 LF 归一化内容的 sha256）三字段可对账；
`manifest.yaml` 的 `source` 字段标来源类别（`self` / `mattpocock` / `external`）。

**新增第三方 skill 准入无自动拦截**：`skills-check-manifest.mjs` 只校验 `source` 取值
合法性（`self` / `mattpocock` / `external`），**不校验来源真实性**——是否合规靠审查人
比对 lock 条目。（不另引运行时 provenance json：那会造出第二个真相源，两份漂移后没有
裁决依据；真要准入闸，正确形态是「check-manifest 校验 lock 条目完整性」，属另一票。）

**逐字 vendor 的外部技能正文目录必须进 `.prettierignore`**：prettier 会重排 markdown
表层（表格对齐 / `*` 列表符 → `-` / `*强调*` → `_强调_` / 补空行），使内容与上游不再
逐字节一致——而这类目录的验收判据正是「与上游 sha256 一致」。

本次 v1.1 对齐：上游 `mattpocock/skills` tag `v1.1.0`；丢弃集 17（ask-matt · decision-mapping ·
edit-article · obsidian-vault · design-an-interface · qa · request-refactor-plan ·
ubiquitous-language · loop-me · migrate-to-shoehorn · review · scaffold-exercises ·
setup-matt-pocock-skills · teach · writing-beats · writing-fragments · writing-shape）已删除。

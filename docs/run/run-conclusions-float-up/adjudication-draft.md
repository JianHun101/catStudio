# 段 2 裁决稿（37 目录收拢版 · 待用户裁决）

> 用法：逐块看「店长推荐」，同意即批、不同意改字。可整块批。
> 数据源：`inventory.md`（段 1，吐槽猫 ✅ 收口 PR #205）。收拢时发现清单内部两处成员归属不一致，已在 §二 勘正，以行级详目为准。
> 裁决完店长派段 3；本稿是工作文件，裁决后留档不删。

## 一、三个结构性卡点（先裁，决定后面所有批次怎么走）

### 卡点 1：本活与 `docs-run-status-gate`（G2/G3）、`lessons-first-batch` 的关系

- 背景：G2 待上浮批基于 09-19 基线只覆盖 10/37 目录，本活 inventory 是全量新鲜版；`lessons-first-batch` 首批 10 卡已落，其 D2「须排在 G2 前」的约束随 G2 作废自然消解。
- **店长推荐：①本活取代 G2/G3**——在 `docs-run-status-gate` 票面登记「G2/G3 由 run-conclusions-float-up 承接」；G4（pre-push 硬闸）是独立价值，不动、仍留票。
- 裁：______

### 卡点 2：上浮出口的合法值域（口径乙）

- 背景：`CONTEXT.md` 钉死「上浮到 `docs/plans/`（点名，不二选一）」，但实测多数结论的落点本来就在手册面（AGENTS/CONTEXT/CODING_STANDARDS/CONTRIBUTING）与 lessons/adr。强行只落 plans 会造出「为上浮而上浮」的拼凑文档。
- **店长推荐：合法化四落点**（plans / lessons / adr / 手册面），同批扫 5 处复述文本统一口径（`AGENTS.md` Pointers 段、`CONTEXT.md` 位置约定段+判据表行+收口链段、`docs/run/README.md`「什么时候清」段）。
- 裁：______

### 卡点 3：`eval-system/` 目录去留

- 背景：有你「保留已关票」的在档裁决（证据链互引、删了造死链）。
- **店长推荐：先上浮、后议清**——新建 `docs/plans/eval-system.md`（七节大纲 inventory §三-B 已给），目录本体保留；「保留惯例要不要成文写进 AGENTS.md」另议，不随本活。
- 裁：______

## 二、批次裁决

> 收拢勘正（inventory §〇 汇总表与 §二 行级判定两处不一致，以行级为准）：
> ① `left-closed-collapse` §〇 误列「判弃·可清」，行级与 §三-C 均为「上浮→lessons」；
> ② `lessons-first-batch` §〇 误列「上浮」，行级为「floated·清（产物就是 10 张卡）」。
> 两处互换后总数不变：上浮 13 / 判弃清 12 / 留 10 / 在飞 1 / 待裁 1 = 37。

### 批次 A：上浮批（13 目录 → 1 ADR 转正 + 4 plans 新建 + 1 plans 并入 + lessons 卡 + 1 手册条）

| 落点                                 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                           | 来源目录                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `docs/adr/0015` 转正                 | 隔离模型 + fan-in 四要件；⚠️ 同批改三处（D1 命名=catSlug 中文猫名 / D3 形态=审查者树集成分支 / §7-2 状态）+ 扫 `cat8` 复述面 5 处                                                                                                                                                                                                                                                                                              | `multi-cat-isolation`                                                       |
| `docs/plans/` 新建 ×4                | `eval-system.md`（七节，最大出口）/ `execution-tail-concurrency.md` / `precommit-gate-scoping.md` / `skill-discovery-injection.md`                                                                                                                                                                                                                                                                                             | `eval-system` / `dispatch-deferral` / `precommit-scope` / `skill-discovery` |
| `docs/plans/memory-flywheel.md` 并入 | 检索归因三桶结论 + 墓碑机制                                                                                                                                                                                                                                                                                                                                                                                                    | `retrieval-attribution` / `retired-docs-tombstone`                          |
| `docs/lessons/` 新卡                 | ① restart-verdict-by-live-instance（跨目录族，**另建议同时落 `AGENTS.md` Gotchas**——每票收口都用的判据，两手册实测零承载）② family-boundary-by-failure-mechanism ③ distance-threshold-cannot-separate-relevance ④ display-none-grid-item-breaks-autoplacement ⑤ listen0-can-land-on-fetch-blocked-ports ⑥ hook-inherits-git-dir-hijack ⑦ criterion-blind-spot-looks-like-truth ⑧ correction-note-only-protects-its-own-section | 见 inventory §三-C                                                          |
| 候选 5 卡（合并同类后定数）          | a2a env 布尔默认侧 / frontend-perf 阈值分辨力 / ui-redesign 注释字面量静态断言（T6 已裁未产出的那张）/ skill-discovery-errata pnpm 引擎门 / taste-skill 外部判据映射                                                                                                                                                                                                                                                           | 同上                                                                        |

- **店长推荐**：8 卡全批 + 候选 5 卡合并同类项后与上批一起落，总新卡数控制在 ≤10（现有 10 张，防碎片化）；`line-endings` 行级判「上浮」但 §三-C 漏列，段 3 补上（§B 两条反直觉实测）。
- 前置：`dispatch-deferral` 的 V4 取数未闭——取一次读数或你明文豁免后才清目录。
- 裁：______

### 批次 B：判弃·可清（12 目录，结论均已在别处承载）

`agent-reply-timer` / `docs-single-writer` / `probe-no-resume` / `hook-marker-fail-open` / `eval-dir-cleanup` / `fixture-hook-leak-live-session` / `sessionlist-collapsed-dead-code` / `skill-delivery-decoupling` / `vision-retire` / `m1-refs-link-timing` / `ui-redesign`（T6 教训卡产出后）/ `lessons-first-batch`（先闭两条验收：重启后查活库 chunks + 清两处旧句子）

- **前置（清前改悬空引用，否则上浮变断链）**：`precommit-scope`→`CONTEXT.md` 括号引用 + 两脚本头注；`docs-single-writer`→`closeout-dupcheck.mjs` 头注；`flaky-precommit`→`embed-server.test.js` 根因出处；`test-git-env-pollution`→`.husky/pre-commit`+测试（须等 lessons 卡先落）。
- **店长推荐**：整批批准，前置条件照 inventory §四 执行。
- 裁：______

### 批次 C：留（10 目录，active/挂账，未闭项随票带走）

`db-schema-governance` / `autocommit-blocking` / `commit-uuid-gate` / `docs-run-status-gate` / `hook-p3-followups` / `a2a-memory-gate` / `frontend-perf` / `taste-skill` / `test-git-env-pollution`（卡上浮、目录留）/ `closeout-gate`（见单点 2）

- **店长推荐**：整批留；inventory §四 的 12 条未闭项逐条转挂账或随票，不随清蒸发。
- 裁：______

## 三、单点裁决（逐条）

1. **`hook-fallback-delivery` 保留条件算不算兑现**：票面条件是「G1 兑现或单独立票」，实际 G1 根因被旁票（R7 归属校验）除根。店长推荐：**算兑现 → 清**（根因已除、无残留动作）。裁：______
2. **`closeout-gate` 三选一**：零夹带正判据是本仓独有实测结论、实现零命中、09-16 立票未派。店长推荐：**先把判据表上浮 plans 再清**（判弃须先证被现有收口链取代，举证成本高）。裁：______
3. **status 位回填（G3）是否随本活做**：37 目录仅 5 个带 `status:`，其中 1 个是值域外中文「在飞」。店长推荐：**顺带回填**，值域依赖卡点 2 裁决。裁：______
4. **`CONTRIBUTING.md` 补进 `AGENTS.md` Pointers**：提交规范/审查链落点存在但索引不可见。店长推荐：**补**。裁：______
5. **`retrieval-attribution` 报告 §6 六条建议无承接票**：店长推荐：**立一张「记忆检索改进」承接票**，把已讨论的启发式跳过门并进去。裁：______
6. **`retrieval-attribution/appendix.json` 去留**：数据附录是报告的承重证据。店长推荐：**随报告核心结论上浮时迁移保留**（不作孤本随目录清掉）。裁：______
7. **`hook-p3-followups` 处置**：F3/F4 本身就是上浮动作（lessons 卡 + AGENTS.md 夹具卫生条）。店长推荐：**F3/F4 并入本活段 3** 随批次 A 一起落；F1/F2（代码面：前缀收紧一行 + e2e 前置注释）留原票派 ds猫 走审查链。裁：______

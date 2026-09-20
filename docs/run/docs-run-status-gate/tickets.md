---
status: active
---

# 票：docs/run 状态硬闸（「上浮 or 判弃」钉成收口链机械闸）

> 立票 2026-09-19 · 店长 · 用户裁决「2 立」（P1-D 遗留三件之二）。
> 来源：`docs/run/retired-docs-tombstone/run-inventory.md` §五 全文（P1-D 产物，flash猫 勘察）。⚠️ 源报告住在 `retired-docs-tombstone/`，该活收口即清 ⇒ 本票**自包含**抄入 §五 全部判据与先例，不依赖源报告存活。
> frontmatter `status:` 即本票自己的 dogfood——新目录从立票第一天就带状态位。

## 一、架构裁决（店长拍板，本票契约面）

**D1 形态甲（推荐，硬闸）· 声明式状态字段 + pre-push 挂载**

**① 判据前置**——给 `docs/run/<slug>/tickets.md` 加 frontmatter 状态位（当前完全缺失的那一格）：

```yaml
---
status: active | pending-float | floated | dropped
floated_to: docs/plans/xxx.md # status ∈ {pending-float, floated} 时必填
---
```

- 沿用既有闸形态，不发明新词：`docs/plans/` 与 `docs/adr/` 已在用 `status:`；`scripts/flywheel/scan.mjs:72` 的 `PLAN_STATUS_CRYSTALLIZED`（`{'final','closed'}`）在 `:271` 已实施同型 fail-closed 准入闸（status 不达标 ⇒ 拒入库）。**值域为英文**（2026-09-20 全仓统一，权威表见 `CONTEXT.md` 文档约定段）——中文旧词是值域外，不是兼容别名。
- 四档必要性：只有「`active`/`floated`」两档时，10 个「活已收口但未上浮」的目录没有诚实可填的值——填 `active` 是假话，填 `floated` 会立刻触发门禁。四档让回填第一天就能诚实。

**② 挂载点**——`.husky/pre-push`，与既有审查门禁同一判据面（本次推送的逐行 refspec；判据面 = 执行面，不读 stdin 等于换了判据面）。

判据（对被推的每个 sha，取其 `merge-base(dev, sha)..sha` 的 diff 面）：

| 情形                                                                 | 判定                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| 本分支**新建**了 `docs/run/<slug>/` 而 tickets.md 无 `status`        | **拦**（fail-closed，与既有门禁「绝不 fail-open」同调） |
| `status: floated` 或 `dropped`，而该目录**仍在树里**                 | **拦**（应清未清——本次事件的直接止血点）                |
| `status ∈ {pending-float, floated}` 而 `floated_to` 指向的文件不存在 | **拦**（悬空落点）                                      |
| `status: active` / `pending-float`                                   | **放行**                                                |

**③ 判 diff 面而不判全树**（形态能否活的关键）：全树判会把别的会话的存量目录连坐进来——存量目录会让每一次推送全红；门禁一旦常态误拦合法推送，压力就把人推向 `--no-verify`（既有 pre-push 注释里已写明的判断）。diff 面天然限定在「本分支自己动过的目录」。

**④ 零持久化状态**：判据完全由 git 对象导出（被推 sha 的树 + frontmatter），不落任何盘 ⇒ 不触发「状态落盘键控二向」（共享/隔离、允不允许依赖常驻进程）。这是它相对「记计数器/维护账本」形态的结构性优势。

**D2 形态乙（补充，非阻断）· 存量陈旧度可见性**

形态甲只能拦「声明过」的——存量目录从没声明过，甲对它零效力（除回填后的新提交）。补一条可见性：

- `node scripts/run-docs-stale.mjs --days N`：打印「未清 且 末次提交距今 > N 天」的 `docs/run/<slug>/` 清单（含末次提交 sha / 日期 / 距今天数）。
- **挂载点**：`packages/server/src/llm/session-closeout.ts:351` 的 `closeoutSession` preflight 段（`step:'preflight'`），每次收口打印。
- **不判 `pending-float`**：待上浮是合法待办，拦它 = 拦合法推送（同 D1③ 的误拦论证）。
- **它是可见性不是闸**：`CONTEXT.md:129` 定死「清理 commit 必须落在 PR 承载的那个分支上」，而 `closeoutSession` 跑在 PR 合并之后 ⇒ 那时已无法回溯补 commit。价值 = 把积压从「几个月后靠人翻」变成「每次收口都打一次数」。
- 首次基线（P1-D 实测，2026-09-19）：末次提交距今 ≥6 天 6 个、≥4 天 9 个；后三个恰是「判弃候选 + 待上浮」同批——陈旧度与「该清没清」高度重合。

**D3 不采纳的形态**（附理由，§5.3 原文）：

| 形态                             | 否决理由                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 只把纪律写进 `CONTEXT.md`        | 已被证伪——`closeout-dupcheck` 就是这么做的，零机械挂载，`mapping.md` 的 phase-2 也因此从未启动 |
| 独立 MCP 工具 / 常驻服务         | 门禁类**不允许依赖常驻进程活着**（进程死了退化成静默放行）；且纯抽取优先于新造形态（ADR 0007） |
| 全树扫描（非 diff 面）           | 连坐误拦，见 D1③                                                                               |
| 让门禁自动改 status / 自动删目录 | 判定「活结束了吗/上浮到哪」是**架构判断**，归店长；门禁只能执行已作出的判定，不能代作判断      |

**D4 正反先例**（本仓实测，§5.0）：`scripts/precommit-scope.mjs` 挂 `.husky/pre-commit:12` = **活的**（每笔提交都过）；`scripts/closeout-dupcheck.mjs` 零机械挂载 = **退化成纪律**。⇒ 每条都点名挂在哪个文件哪一行。

## 二、票单（定序 = §5.4，前置关系是硬的）

**硬闸不能先于上浮落地**：形态甲对「无 status」fail-closed ⇒ 回填（G3）之前挂闸，全仓每一次推送都被拦。故 G1/G2/G3 是 G4 的硬前置。

### 票 G1 · 存量前置清理（最小批，可先做）

- (a) ~~判弃 `docs-run-cleanup/`~~ **✅ 已完成 2026-09-19**（mapping.md 标判弃 + `flaky-precommit` §5.3 引用改指 + 2 条票面冲突修文，同批 commit）。
- (b) `docs-single-writer/` 前置：`CONTEXT.md:133` 的括号引用（现指 `docs/run/precommit-scope/closeout.md` §四）改指上浮后落点，否则清目录时引用悬空。
- (c) ~~补一行收口段 + `docs/plans/agent-reply-elapsed-timer.md:3` 的 `status` 改「已收口」~~ **✅ 已完成 2026-09-20**（收口段已补；status 按同日统一后的英文值域落 **`closed`**，非旧词「已收口」）。
  ⚠️ **原句归因错误（2026-09-20 实测更正）**：原写「该 status 触发 `scan.mjs:243` 准入闸 ⇒ 该 plan 进不了检索索引」。实测 `classifyDocument` 的判据**顺序**是 `type` → **`evidence`（`:265`）** → `status`（`:271`）——该 plan **根本没有 `evidence` 字段**，落 `empty-evidence`，**在 status 判据之前就被拒**。故：① 改 status **不会**让它入库（改后仍 `empty-evidence`）；② 它的 `status: 在飞` 出值域是**另一处独立缺陷**，不是索引卡点。补 `evidence` 与否（= 语料 19→20 文档）**✅ 已由「飞轮跳过面收敛」票执行**（2026-09-20，已审 sha `c956c8f`，PR #158 merge `1411983`）：该 plan 补 3 笔 commit evidence ⇒ 分类面实测 **21 候选 / 20 入索引**、`empty-evidence` 归零，本句**不再待裁**。
- **边界**：(b)(c) 触及 `CONTEXT.md` / `docs/plans/`——**不在免审白名单（`docs/run/**`）内，须走审查链**。
- **验收**：引用不悬空（grep 目标存在）；plan status 改后重扫可入库；两目录 `floated` 可清前置清零。

### 票 G2 · 待上浮批（10 目录，可再拆子票）

- 清单与「上浮必须带走」逐目录见 P1-D 盘点 §二 B 表（#3–#12，本票收口前以抄录为准）：`eval-system`、`multi-cat-isolation`、`db-schema-governance`、`precommit-scope`、`flaky-precommit`、`frontend-perf`、`commit-uuid-gate`、`line-endings`、`skill-delivery-decoupling`、`vision-retire`。
- **上浮是净新增工作，不是搬字**：5 个落点文件不存在（`plans/eval-system-v1.md`、`adr/0015-*.md`、`plans/precommit-gate-scoping.md`、`plans/frontend-render-decoupling.md`、`plans/vision-retire.md`）；`plans/review-chain-anchor.md` 存在但零相关内容。
- **前置待裁口径**（承判弃件 `mapping.md` §三，用户裁，G2 开工前必须到位）：
  - **口径甲 · 「未闭项」判准**：建议 = 「有无钉死的触发条件」，而非「有没有写下来」——带触发条件的观察项可随上浮带走，不带的不行。
  - **口径乙 · 上浮出口能否是手册**：`line-endings`（仓级行尾策略）与 `vision-retire`（角色注册表）的结论天然属 `AGENTS.md`/`CONTEXT.md`；但 `CONTEXT.md:95` 钉死「上浮 = `docs/plans/` 点名，不二选一」。**此口径同时决定形态甲 `floated_to` 的合法值域**（悬空落点检查的白名单），故 G4 开工前也必须到位。
- **验收**：10 目录各自 frontmatter `status: floated` + `floated_to` 实指存在文件 → 目录物理删除（上浮落点文与删目录同 PR 两笔 commit，`CONTEXT.md:129`）。

### 票 G3 · 回填 status（G2 后存量全目录，诚实四档）

- 对 G2 后仍存的目录逐目录回填 frontmatter（`active`/`pending-float`/`dropped` 如实填）。
- **验收**：`ls -d docs/run/*/` 每目录 tickets.md 均有合法 status；`status ∈ {pending-float, floated}` 者 floated_to 无悬空。

### 票 G4 · 形态甲挂闸（`.husky/pre-push`）

- **边界**：新增 `scripts/run-docs-gate.mjs`（判据实现 + 测试）+ `.husky/pre-push` 挂载一行。**不改**会话侧代码。
- **契约**：D1 判据表四行逐字即契约；fail-closed（解析失败/缺字段 = 拦）；判据面 = 被推 sha 的 diff 面（`merge-base(dev, sha)..sha`）。
- **验收**（含反对照）：
  1. 夹具分支新建无 status 的 run 目录 ⇒ push 被拦（报错含目录名）；
  2. `status: dropped` 目录未删 ⇒ 拦；删除后 ⇒ 放行；
  3. `floated_to` 悬空 ⇒ 拦；
  4. **反对照**：不动 `docs/run` 的分支 ⇒ 零拦截（判据面外零效力）；
  5. 存量目录（本分支未动）⇒ 不连坐。
- **重启面**：无（pre-push 是本地钩子）。
- **落地当日同批动作（2026-09-20 店长补）**：`CONTEXT.md:100` 现写「`docs/run/` 侧的对应闸 = 本票 **G4，待挂载**，今天无机器执行面」——该限定**在 G4 落地当日即过期**，须与挂闸**同一批**删掉。迟一步改，手册会继续断言一个已不成立的「无机器执行面」，读手册的人会据此以为本闸不存在。

### 票 G5 · 形态乙可见性（非阻断，可与 G4 并行）

- **边界**：新增 `scripts/run-docs-stale.mjs` + `packages/server/src/llm/session-closeout.ts:351` preflight 段挂载打印。**含 server 源码 ⇒ 收口需重启审批**（归店长发起）。
- **验收**：`--days 6` 输出与手工 `git log -1 --format=%ci -- docs/run/<slug>` 逐目录核对一致；closeout preflight 日志含陈旧清单；**反对照**：全目录均新 ⇒ 输出空清单且不报错。

## 三、与 P1 链的关系

- P1-C（R9 修集 + 重跑基线）按用户 2026-09-19 裁决「3 等硬闸票定了再动」——**本票定稿（Gate PASS）即 P1-C 开工前提**，不依赖 G1–G5 落地。
- 生命周期警告已兑现：`run-inventory.md` §五 全文已抄入本票，`retired-docs-tombstone/` 收口清理不丢判据。

## Gate Report

### Gate A · 需求照准

✅ 全部可证伪：G4 验收 1–5 直接观察 push 拦截行为；G5 验收逐目录对表；G1–G3 以文件存在性/引用不悬空为 oracle。

### Gate B · 契约锁定

✅ 边界：G4/G5 各自写明「不动什么」；契约：status 四档字面量 + D1 判据表 + 挂载点行号钉死；验收：每票逐条可执行含反对照。

### Gate C · 反向证明

✅ 「docs/run 只涨不清」根因 = 契约缺判据位（`run-inventory.md` §〇-3：没有字段承载「已收口活」的判定）⇒ D1 状态位补位 + pre-push 机械挂载止血；存量拦不住 ⇒ D2 可见性补；连坐误拦 ⇒ diff 面判据防；落盘键控 ⇒ 零持久化形态规避。无漏网需求。

### Gate Result

✅ PASS → 票已立。**开工时机归用户授权**（裁决≠派活授权）：口径甲/乙裁决到位后可派 G2；G1(b)(c) 最小批与 G5 可随时放行。

## 决策留痕

- 跳 grilling：形态与判据由 P1-D 盘点报告 §五 逐条给出（含正反先例与不采纳形态），用户「2 立」即采纳该形态，需求无模糊点可压测。
- D1 采「声明式 + diff 面 + fail-closed」而非「全树扫描」：防连坐误拦 ⇒ 防 `--no-verify` 逃逸（D1③）。
- 口径甲/乙不由店长代裁：乙与 `CONTEXT.md:95`（用户级约定）直接冲突；甲影响 `745535c`「零未闭项才删」先例判据 ⇒ 均留用户。
- G4 与 G5 拆票而非合并：G5 含 server 代码有重启面，G4 没有——拆开则 G4 不被重启排期绑架。
- **值域统一英文（2026-09-20，用户裁「统一字段规范，都采用英文状态」）**：`docs/plans/` 与 `docs/run/` 的 `status:` 中英混用会让闸只能逐个枚举词形，漏一个即静默放行（`docs/plans/` 侧真实发生过：`在飞` 件因不在白名单而掉出检索索引，见 G1(c)）。权威表落 `CONTEXT.md` 文档约定段；本票全部词形（含 G2/G3/G4 验收里的字面量）同批改完——**迟一步改，这几个闸的验收条件会拿旧词去写新代码**。

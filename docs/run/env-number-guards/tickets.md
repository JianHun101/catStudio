---
status: pending-float
floated_to: CODING_STANDARDS.md
---

# 票：env 数值读取 —— 回归守卫补齐 + 规范立条

> 立票 2026-09-23 · 店长 · 用户指令「1 **补** / 2 为什么会产生这种代码，跟规范有关吗，如果有，**相关内容写进 `CODING_STANDARDS.md`**」。
> 前置：OQ-6 票（`docs/run/eval-system/OQ-6-env-threshold-nan.md`）已收口（实施 `925e8d0b` → PR #140 merge `99e13fa1`）。本票处理它**未覆盖的回归面**，不重开那一票。

## 一、问题（ds猫 2026-09-23 逐键实核，本票不重复取证）

OQ-6 消灭的是**运行时**的坏值静默；**回归面**的同类静默原样还在：

`env-number.test.ts` 用专用假键名 `CATSTUDY_TEST_ENV_NUMBER` 测 helper 本体——覆盖坏值，但**不触达任何一处真实接线点**。9 个 `envNumber` 接线点里 8 个的入库断言钉的全是**合法值**（实测 `git grep stubEnv`：`MEMORY_TOP_K='4'` / `HANDOFF_THRESHOLD='0.9'|'0.8'` / `EVAL_CHAIN_SLOW_MS='600000'` / `EVAL_LABEL_MIN_COUNT='50'`），喂给改前表达式逐条同值。

⇒ **任一处回退到 `parseFloat/parseInt(process.env.X || '默认')`，全仓不会红**。三个 `EVAL_ALERT_*` 键连一处 env 级测试都没有。唯一有守卫的是 `AGENT_HARD_TIMEOUT_MS`（`add63fb1` 加的两条）。

## 二、根因（回答「为什么会产生这种代码」，均已实核）

1. **解析点全都早于统一入口**。`git log --diff-filter=A` 实测：`env-number.ts` 生于 2026-09-20（`925e8d0b`），裸解析点首建于 2026-07-13 ~ 08-25。它们不是「违反已知规范」，是**写在一个既无规范也无入口的年代**。
2. **入口诞生后零新增裸写**。`git log -S "parseInt(process.env"` 自 2026-09-20 起唯一命中 `add63fb1`，方向是**移除**裸写并轨。⇒ 缺的是条文本身，不是纪律。
3. **族边界按模式扫，不按失效机制扫**。OQ-6 票面自记：「本次搜的是 `parseFloat`，`parseInt` 天然不在面上」。同机制（NaN 静默穿透）的站点被留在族外——这不是手滑，是**定族方法**缺陷。

⇒ **规范面确有缺口**：`CODING_STANDARDS.md` 全文无一条关于 env 数值读取的条文（§8 只有「`.env.example` 同步更新」，§5 只管外部依赖的降级与超时）。故立组件 A（用户第 2 条指令）。

## 三、架构裁决（契约面 · 实施者不得改形状）

### 组件 A · `CODING_STANDARDS.md` 新增一节，正文**逐字落盘**

```markdown
## 9. 环境变量

- [ ] **数值读取唯一入口**：数值型环境变量一律经 `envNumber(name, fallback)`（`packages/server/src/env-number.ts`）读取，不得在调用点裸用 `parseInt` / `parseFloat` / `Number(process.env.X)` 自行解析
- [ ] **坏值语义**：未设置 / 空串 / 纯空白 ⇒ 静默回退 `fallback`（那是 `env.ts` `??=` 的正常兜底面）；解析后**非有限数**（`NaN` / `±Infinity`）⇒ 打一条 warn（变量名 + 原始串 + 回退值）+ 回退 `fallback`
- [ ] **禁用「部分可解析」形态**：`parseInt` / `parseFloat` 对 `5abc` 静默取前缀值（`parseInt('5abc', 10) === 5`），**不产生 NaN** ⇒ 永远走不到 warn 分支。严格解析归 `Number()`
- [ ] **不在入口加区间钳位**：`0` / 负数原样生效；需要钳制的调用点在**调用点**显式做（如 `Math.trunc`）——钳位本身会改语义
- [ ] **每个数值键至少一条坏值回归断言**：断言须打在**真实接线点**（真键名 + 消费函数），`X=abc` ⇒ 消费点读到 `fallback`。在 helper 本体用**假键名**做单测**不构成**这些键的守卫
- [ ] **存量**：改动触碰到的裸解析点同批处置——并轨到 `envNumber`，或显式保留并在注释写明理由（部分站点现行语义是 fail-loud，并轨反而降级）
```

### 组件 B · 补齐 8 个（键, 接线点）对的坏值回归断言

口径：`git grep -n "envNumber(" -- packages scripts`（非测试），共 9 个接线点；除 `AGENT_HARD_TIMEOUT_MS` 外余 8 个：

| #   | 文件                                        | 键                        | 消费面                         |
| --- | ------------------------------------------- | ------------------------- | ------------------------------ |
| 1   | `packages/server/src/routes/eval.ts`        | `EVAL_CHAIN_SLOW_MS`      | `/api/eval/chains` 的 `slowMs` |
| 2   | `packages/server/src/eval/l1-aggregator.ts` | `EVAL_ALERT_SUCCESS_RATE` | L1 告警阈值                    |
| 3   | 同上（同接线点）                            | `EVAL_ALERT_TIMEOUT_RATE` | 同上                           |
| 4   | 同上（同接线点）                            | `EVAL_ALERT_REWORK_RATE`  | 同上                           |
| 5   | `packages/server/src/handoff/index.ts`      | `HANDOFF_THRESHOLD`       | 交接触发阈值                   |
| 6   | `packages/server/src/memory/index.ts`       | `MEMORY_TOP_K`            | 检索注入片数                   |
| 7   | 同上（同函数）                              | `MEMORY_MAX_DISTANCE`     | 检索距离阈值                   |
| 8   | `packages/server/src/routes/eval.ts`        | `EVAL_LABEL_MIN_COUNT`    | 判官标注最小样本               |

**边界**：

- **零生产代码改动**（除非断言暴露真缺陷 ⇒ 报 OQ，**不顺手修**）
- 测试**co-located**：`routes/eval.test.ts` / `eval/l1-aggregator.test.ts` / `handoff/index.test.ts` / `memory/index.test.ts` **均已存在**，不新建测试目录、不新建集中目录
- 不改 `envNumber` 本体、不改默认值 / 阈值语义、不动 `env.ts` 的 `??=`
- **不扩面**：`parseInt` 族**不在本票实施边界**（见 OQ-1）；实施时若撞见别处裸解析点，**只列清单不修改**
- 不重启 server；本票无 server 行为改动

## 四、验收（可证伪）

1. **逐键坏值断言**：8 个（键, 接线点）对每对至少一条：`X=abc` ⇒ 消费点读到 `fallback`（不是 `NaN`、不是 `0`）；`X=`（空串）⇒ 同值且**不产生 warn**。给出逐键测试名清单。
2. **反对照（承重）**：每条断言都要**能红**——把该接线点的解析**临时**换回改前表达式（`parseFloat(process.env.X || '默认')` / 裸 `parseInt`），断言必须失败；给出一条实跑读数为证，跑完恢复原状。
3. **断言打在真实面上**：逐条说明「真键名 + 真消费函数」。**只在 helper 本体加假键名测试不算完成本票**（那正是本票要补的缺口）。
4. `pnpm test` 全量绿（**剥环境注入变量**：`MEMORY_TOP_K` 等会让 `reply.test.ts` 恒红，属环境假红）+ `pnpm lint` 三包绿；给出实跑读数（files / passed）。
5. **组件 A 逐字对账**：落盘的节与 §三 正文**逐字一致**（含标点）；给出 `git diff` 片段。
6. `CODING_STANDARDS.md` **不在免审前缀内** ⇒ 本票必审；提交走 `git add <路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`，**不得 `--only` / `-A`**。

## 五、Open Questions（回报逐条答，不得留空）

- **OQ-1**：`parseInt` 族实测**非测试面 21 处**（口径 `git grep -n "parseInt(process.env" -- packages scripts` 排除 `*.test.*`；19 在 `packages/server/src`，2 在 `scripts/`）。**但族收敛不是机械替换**：实测 `PORT=abc` ⇒ `parseInt` 得 `NaN` ⇒ `listen(NaN)` **抛 `ERR_SOCKET_BAD_PORT`**（node 实跑），**现行语义是 fail-loud**——并轨到 `envNumber` 会把它**降级**成 warn + 回落 3200。**逐键给出「该 fail-loud 还是 fail-safe」的读数与判断**，不预设全并。本项**不在本票实施边界**，只出清单与判断。
- **OQ-2**：`EVAL_ALERT_*` 三键连一处 env 级测试都没有——补测时实际怎么接（该三键的消费函数是否可单独驱动）？给出接法。
- **OQ-3**：断言放进消费模块既有的 co-located 测试，会不会与该文件既有 `beforeEach`/`afterEach` 的环境复位冲突（本仓栽过 `vi.stubEnv` 泄漏）？给出处理。

## 六、决策留痕

- **2026-09-23 店长（立票，用户授权「1 补」+ 第 2 问）**：组件 A 正文由店长拍板（实施者逐字落盘、不得改形状）；组件 B 为纯测试补齐，零生产代码改动。
- **本票不含**：`parseInt` 族收敛（未授权，见 OQ-1）、`envNumber` 本体改动、阈值语义改动、重启审批（无 server 行为变更）。

## 七、收口记录（2026-09-23）

**实施** ds猫 `e58b67ec`（父 `4b50c64c` = 派活时 dev HEAD，单笔 linear commit）· **审查** 吐槽猫 ✅ 可合并（零 P1/P2）· **收口** 店长 · **PR** base=`dev` ← `closeout/env-number-guards`。

**店长独立复跑**（审查回执本身不是证据，收口读数自己取）：

| 探测     | 读数                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ |
| 全量测试 | `pnpm test` → **157 files / 3449 passed / 0 failed**（39.7s，主仓库 dev）                        |
| 类型检查 | `pnpm lint` → 三包（shared / server / web）全绿                                                  |
| 改动面   | `git diff --name-status 4b50c64c e58b67ec` = 5 文件                                              |
| 生产代码 | `--numstat` 去 `*.test.ts` + `CODING_STANDARDS.md` 后 → **0 行**（承重：票面「零生产代码改动」） |

**重启面**：**无**。改动面虽落在 `packages/server/` 下，但**全部是 `.test.ts`**（不被运行实例 import）+ 文档 —— 按「重启判定看运行实例而非改动面」，运行实例不受影响，不发重启审批。

**票面 §四 验收逐条对账**：

| #   | 验收                                           | 结论          | 依据                                                                                                         |
| --- | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | 逐键坏值断言（8 对）                           | ✅            | 4 个 co-located 测试文件 diff；审查者逐条核「真键名 + 真消费链」                                             |
| 2   | **反对照（承重）**：接线点换回改前表达式须能红 | ✅ **凭读数** | 一次性实跑（8 条全红、其余 151 不动），读数载 `e58b67ec` commit message；**无仓库载体** —— 见 OQ-5 裁定      |
| 3   | 断言打在真实面上（非 helper 假键名）           | ✅            | 8 对全走 HTTP 端点 / `alertThresholds()` / `shouldHandoff()` / `currentRetrievalParams()`                    |
| 4   | `pnpm test` + `pnpm lint` 全绿                 | ✅            | 店长独立复跑（上表），非转抄                                                                                 |
| 5   | 组件 A 逐字对账                                | ✅            | 审查者独立 node 脚本逐字节比对票面 §三 vs 提交后 blob → `BYTE-IDENTICAL: true`（提交后 prettier 跑过仍逐字） |
| 6   | 必审 + 提交流程                                | ✅            | 本票不在免审前缀 ⇒ 审查链已走；提交走暂存区核对 + 裸 commit                                                  |

**OQ-5 裁定（店长）**：**不要求「反对照」有仓库内可复现载体。**
理由：反对照的本质是「临时把生产代码改坏 → 证明断言能红 → 还原」；把它固化成仓库里的可执行物，等于常态化「改生产代码来测试测试」，代价大于收益，且会被后续读者误当正式用例。替代口径：**同类票把反对照读数留在 commit message**（不可变载体）—— 本票已做到。

**OQ-4 复核（店长独立复跑；读数与 ds猫 部分不一致，如实两存）**：

| 口径                           | ds猫 读数                      | 店长 读数                                            |
| ------------------------------ | ------------------------------ | ---------------------------------------------------- |
| 整文件单跑 `socketio.test.ts`  | 「去掉 `-t` 单跑整文件同样红」 | **167/167 全绿**（**未复现**）                       |
| `-t "验收9"` 筛选单跑          | 稳定红 3/3                     | **红，复现**（报错见下）                             |
| 干净树对照（stash 掉本票改动） | 同样红 ⇒ 与本票无关            | 本票**未触碰**该文件（`--name-status` 实测）⇒ 同结论 |

筛选口径实跑报错：`TypeError: Cannot read properties of null (reading 'executeAgentsSerial')` —— `getExecutionEngine()!` 返回 `null`。根因是**同文件用例次序耦合**（执行引擎由**前序用例的钩子**注册，`-t` 过滤后那些钩子被跳过），不是产品缺陷。影响面：全量与整文件单跑均绿 ⇒ **不进 CI**；只影响「用 `-t` 定位单条用例」这一开发动作（调试时拿到误导性的 null 报错）。挂 §八。

## 八、未闭项（本票已收口，但目录**不清** —— 判据「零未闭项才删」）

| #   | 未闭项                                                                                  | 钉死的触发条件                     | 落点                                                              |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| 1   | `parseInt` 族非测试面 **21 处 / 13 键**：逐键裁「保留 fail-loud」vs「并轨 `envNumber`」 | **用户授权开工**                   | 另立票；键面见下方抄录                                            |
| 2   | `socketio.test.ts`「验收9」**用例次序耦合**（`-t` 筛选即可复现）                        | 顺手搭下次该文件改动，或单独立小票 | ——                                                                |
| 3   | 上浮出口**口径乙**（能否是手册）未裁 —— 本页 `floated_to` 即按用户指令填了手册          | 用户裁决                           | `docs/run/docs-run-status-gate/tickets.md` §二 G2「前置待裁口径」 |

**`parseInt` 族键面抄录**（口径 `git grep -n "parseInt(process.env" -- packages scripts` 去 `*.test.*`；2026-09-23 店长独立重跑，与 ds猫/审查者读数**三方一致** = 21 处 / 13 键）：

`MAX_CONTEXT_TOKENS`×8（`execution/reply.ts`×4 / `routes/config.ts` / `routes/agents.ts` / `handoff/index.ts` / `connectors/socketio.ts`）、`PORT`×2（`packages/server/src/index.ts` / `scripts/dev.js`）、`LLAMA_SERVER_PORT`、`LLAMA_SERVER_PROBE_INTERVAL_MS`、`LLAMA_SERVER_READY_TIMEOUT_MS`、`CLI_IDLE_TIMEOUT_MS`、`CATSTUDY_SUPERVISOR_PARENT_PID`、`SUMMARY_INTERVAL`、`SUMMARY_COMPRESS_LIMIT`、`MEMORY_QUERY_REWRITE_TIMEOUT_MS`、`KNOWLEDGE_TOP_K`、`ONEBOT_FETCH_TIMEOUT_MS`、`EMBED_SIDECAR_PORT`。

**逐键判定不得机械并轨**（票面 OQ-1 原话）：`PORT=abc` ⇒ `parseInt` 得 `NaN` ⇒ `listen(NaN)` **抛 `ERR_SOCKET_BAD_PORT`**，现行语义是 **fail-loud**；并轨到 `envNumber` 会把它**降级**成 warn + 回落 3200。

**上浮检查**（用户指令「收口同时检查是否有可上浮信息」）：

- **`docs/plans/` 面：无新增上浮内容。** 本票的规范结论已落在其自然载体 `CODING_STANDARDS.md` §9（用户指令指定落点），不构成规格。
- **`docs/lessons/` 面：1 条候选** —— 「**定族必须按失效机制扫，不按模式扫**」（§二 根因 3：OQ-6 按 `parseFloat` 扫 ⇒ 同机制的 `parseInt` 站点全留在族外）。属 `docs/run/lessons-first-batch/` §D1 明写允许增补的「新近收口票的教训段」；**该票已立·未派活，故此处不擅自写入**。

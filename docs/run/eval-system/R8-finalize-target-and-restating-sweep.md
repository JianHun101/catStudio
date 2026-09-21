# R8 — 收口定位补 sessionId（OQ-1）+ 复述文本族修（OQ-5 触发条件已到）

**出处**：R7 审查回执 OQ-1（吐槽猫 与 ds猫 **各自独立**确认，非转述）+ R7 票面 §四 OQ-5（触发条件 = 「R7 收口后」，**现已满足**：R7 已收口 `e46a51c6`）。

**基点**：`e46a51c6`（dev HEAD）。两个 § 都落在 `packages/server/**` ⇒ 落地需重启。

---

## §A — `finalizeExecutionLog` 的定位面缺 `sessionId`

**是什么**（R7 修的是「该不该收口」，这是正交的第二层：「收**哪一行**」）：

`packages/server/src/db/repository/executionLogs.ts:409` 的 UPDATE：

```sql
WHERE agent_id = ? AND status = 'running'
ORDER BY started_at DESC LIMIT 1
```

**没有 `session_id`、没有 `execution_id`** ⇒ 命中「该 agent 最新一条 running」。同一只猫跨会话并行时（A 会话的执行还在跑，B 会话又起一次），**A 的收口会写到 B 的行上**：错标 `completed/failed`、错写 `ended_at`、错擦 `message_id`。

**为什么现在要修**：R7 的归属校验挡住了「收错槽位」，但收口落库这一层仍是「agent + 最新 running」——R7 收口后这条路径**成为唯一的错行入口**（R7 之前它被槽位误收口的噪声掩盖）。仓库自己的注释（`executionLogs.ts:404-407`）已明写这个洞存在，只是没治。

> **订正（2026-09-19 R12 收口时，店长）**：本句「收口落库这一层仍是『agent + 最新 running』」**写下时即已失实**——`finalizeExecutionLog` / `updateExecutionLogDiagnostics` 两处的 `session_id` 已由 `dce2bc9`（本票基点 `4ea1a65` 的祖先）补上，立票时真正缺 `session_id` 的只有第三处 `getRunningExecutionCommitHash`（吐槽猫 R12 审查 §四 独立扫出，ds猫 交付时已按此订正执行）。存证加注，不改原句。

**抓手（已核，不必再找）**：`session_id` 列在表内存在；唯一调用点是 `packages/server/src/execution/serial.ts:1608`，位于 `completeExecution` 体内（实现 `serial.ts:1592`），而 `sessionId` 就是该函数的第二个形参（`EngineCtx` 声明在 `serial.ts:197`）⇒ **在作用域内，不需要动接口**。

**改哪**：

- `packages/server/src/db/repository/executionLogs.ts`（`finalizeExecutionLog` 增参 + WHERE）
- `packages/server/src/execution/serial.ts:1608`（调用点传 `sessionId`）
- co-located 测试（`executionLogs.test.ts` 若不存在则新建；`serial.*.test.ts` 就近）

**必判（不许想当然）**：`session_id` 为 NULL / 空串的**存量行**与恢复路径（`recovery.ts` 重调度后的收口）会不会因此**收不到**——先 `query_db` 读存量分布再定形态；若存量有 NULL 行 ⇒ 需给出「NULL 也命中」的兜底写法并写进理由，**不得**用「应该没有」过关。

**验收**：

- **A1** 构造同 agent 双会话并行（B 后启且 started_at 更晚）⇒ A 收口**只动 A 的行**，B 行仍 `running`
- **A2** 单会话路径零回归（既有 `serial.*.test.ts` 全绿）
- **A3 真空性反对照**：摘掉 `sessionId` 判据 ⇒ A1 **必须变红**（红点须钉在「B 行被错写」这一危害面）
- **A4** `node scripts/lint.js` + 全量绿

**停手条件**：要动 `EngineCtx.completeExecution` 签名、或要改 `recovery.ts` 语义 ⇒ **报店长**，不自行扩面。

---

## §B — 复述文本族修（R6/R7 语义变更的扫尾）

**实锤（`git grep -n` 字节路径）**：`packages/server/src/execution/serial.crash-diagnostic.test.ts:8` 仍写

> 「本文件用 `chatStream` 抛非 Error 驱动，**这是全库 19 次 `execute crash` 同源族里可经公开 API 稳定复现的那条**」

**真相**（R6 §A 追因 + R7 除根）：那 19 行 `error_message = 'execute crash'` 是 `executeRun` finally **误收口**的历史存量，`catch` 路径**从未触发过**；R7 已加归属校验除根、该词退役。⇒ 该句把「误收口存量」说成了「catch 路径的崩溃族」——**是假话，且正是本票族修要扫的形态**（改机制语义只改点名处 = 必留假话）。

> **订正（2026-09-19 收口时，店长）**：`19` 为 R6 时点的 dev 库读数；R8 收口时吐槽猫 / ds猫 各自独立直查活库，实测 = **18 行**（全为字面量 `execute crash`，无变体）。两读数差 = 库与时点不同，非计数错误。活代码注释侧的计数由 R12 统一去计数化，本票面存证不改。

**要求**：

1. 给**全仓扫描命令**（`packages/**` + `docs/**` + `scripts/**`）+ 命中清单
2. 逐条判「改 / 不改」+ 理由（历史文档里的追因叙述如属**当时事实**可不改，但须逐条说明）
3. 统一真相词：「19 行是 R7 之前 finally 误收口的历史存量，catch 路径从未触发；R7 已除根，不再新增」
4. **不得**只改点名的那一行——扫到的同型复述必须一并处置（族修纪律）

**验收**：B1 扫描命令与命中清单（含不改项理由）；B2 `git grep` 复核改动后无残留失实句；B3 lint + 全量绿。

---

## 行号纪律（R7 实证有效，本票沿用）

**先 prettier 落盘 → 再 `git grep -n` 字节路径复核 → 提交后对 `HEAD` 再核一遍**。
（R6 §A 那次的漂移根因 = 先 grep、后 pre-commit prettier 重排；「提交前 grep 一遍」这条纪律**必然漏**。）

## 交付形态

- 两个 commit：`R8-*` 代码 commit（§A）+ 复述文本 commit（§B）——**都过审查**（含测试改动）
- 交接文档按 `request-review` 门槛补填（What / Why / Original Req / Tradeoff / Architecture Ownership / OQ / Reviewer Checklist / Self-Check Evidence）

## 禁入

- `serial.ts` 的 finally 归属校验段（R7 已审产物，本票不动）
- `.husky/**`、`.push-gate`、既有断言（不许改断言迁就实现）

---

## 附：店长收口复核补入（2026-09-17，基点 `5124ac2`）

收口 R6 §B 清单订正 + R7 §A 时独立复算 OQ-1，补三条**判据面增量**，并订正票面两处行号。**§A/§B 主体不动。**

### 订正 · 票面两处行号偏一（`git grep -n` 字节路径实测）

| 位置                   | 票面写           | 实测                         | 说明                                                                                      |
| ---------------------- | ---------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| §A「唯一调用点」       | `serial.ts:1608` | **`serial.ts:1609`**         | `git grep -n "execLogsRepo.finalizeExecutionLog("` 唯一命中                               |
| §A「实现」             | `serial.ts:1592` | **`serial.ts:1593`**         | `:1592` 是空行；`:1593` 起 `async function completeExecution(`                            |
| §A「`EngineCtx` 声明」 | `serial.ts:197`  | **接口 `:181`，成员 `:198`** | `:197` 是该成员的**文档注释行**；`sessionId` 确为 `completeExecution` 第二形参（`:1595`） |

> 行号纪律本票自己写着（§行号纪律），故落笔前先钉。**其余行号（`:409` / `:421` / `:446` / `:207`）实测无误。**

### 补 1 · 可达性从「断言」升级为「实测链」

§A 说「同一只猫跨会话并行时」——这不是纸面担忧，逐环有行号：

| #   | 环节                                                                               | 位置                                                    |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | 槽位容器按 **agent × session** 二级键控                                            | `serial.ts:184` `slots: Map<string, Map<string, Slot>>` |
| 2   | 取槽位要 `(agentId, sessionId)` 两键 ⇒ 同 agent 两会话 = **两个槽**                | `serial.ts:1529` `getSlotInternal`                      |
| 3   | 引擎**全局单例**：`createExecutionEngine` 全仓仅此一处调用，全会话共用一份 `slots` | `socketio.ts:166`                                       |

⇒ 同 agent 双会话并行是**设计允许的常态**，不是边角情形。危害面同时含「A 行残留 running」。

### 补 2 · 同型 WHERE 不是一处，是**三处** —— 必须逐处处置

`git grep -n "WHERE agent_id = ? AND status = 'running'"` → **命中 3 行**：

| #   | 函数                            | 定义                   | WHERE  | 调用点           |
| --- | ------------------------------- | ---------------------- | ------ | ---------------- |
| 1   | `finalizeExecutionLog`          | `executionLogs.ts:409` | `:421` | `serial.ts:1609` |
| 2   | `updateExecutionLogDiagnostics` | `executionLogs.ts:427` | `:446` | `reply.ts:1308`  |
| 3   | `getRunningExecutionCommitHash` | `executionLogs.ts:203` | `:207` | T-A 收尾兜底判据 |

**验收追加 A5**：三处**逐处**处理，或**逐处**给出「不改」理由 —— 第 3 处若判不改，须写明「误命中为何无害」（它只读 `commit_hash`，误命中会把别人的 commit 挂到本 agent 的兜底判据上，**不是零后果**）。**只改第 1 处 = 族修只改点名处**，正是 R6/R7 连续两票栽过的形态。

### 补 3 · 与票面 §A「必判」交叉

§A 已要求先 `query_db` 读 `session_id` 存量 NULL 分布 —— **该结论三处共用**（同一列语义），做一次判定、三处同口径，别重复读也别各判各的。

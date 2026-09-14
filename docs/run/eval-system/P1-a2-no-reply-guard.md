# P1-A2 追补：`no_reply` 加 running 守卫

> 来源：P1-A 审查（吐槽猫，commit `51170dc`，结论 💬 仅评论）上报 OQ-1 / OQ-3。
> 店长裁决于 2026-09-13。**P1-A 本体已收口**（PR #72，dev `8b3fc712`），本票是读侧纯函数的独立追补，**不重开 P1-A 的审查面**。

## 一、Why：这不是推演出来的风险，是库里正躺着的两条活证据

`toHop()` 在同一行里说两件互斥的事：

- `chain-query.ts:110-112` 用「段算全 null」声明**这一段尚未结束**（`ended_at` 为 null）；
- `chain-query.ts:123` 却在 flags 里断言 **「没有回复」**。

于是前端 `EvaluationView.vue:604` 会把 `statusLabel(h.status)`（`running → '进行中'`）与 `no_reply → '无回复'` **并排渲染在同一行**——自相矛盾直接摆给用户看。

**实测证据（dev 库，本裁决时刻）**：`status='running'` 共 **2 行**，两行都会被误标 `no_reply`。

| exec id    | 猫      | started_at (UTC) | 真相                                         |
| ---------- | ------- | ---------------- | -------------------------------------------- |
| `ebbccf54` | 店长    | `15:55:15`       | 本次执行，正在写回复                         |
| `30f7ebd8` | flash猫 | `15:45:29`       | **已提交 `5ec2b3e`**（P1-B），正在写完工报告 |

两行都是**当下在飞的活跳**，不是残留。用户看「卡在哪一跳」，看到的是「无回复」，真相是「正在回复」。

## 二、契约变更（唯一一处）

```ts
// before（chain-query.ts:123）
if (row.message_id === null || row.reply_chars === 0) flags.push('no_reply')

// after
if (row.status !== 'running' && (row.message_id === null || row.reply_chars === 0))
  flags.push('no_reply')
```

**判据理由（三重，缺一不可）**：

1. **语义自洽**——`no_reply` 与 `no_data` 应当对称：两者都描述「**已结束的跳**的缺失」。当前不对称（`no_data` 有 `status === 'completed'` 守卫，`no_reply` 没有）是契约笔误，不是设计选择。
2. **同一行不得自相矛盾**——段算已声明「未结束」，flags 不得断言「没回复」。
3. **在飞 ≠ 无回复**——在飞跳的 `message_id` 必为 null 是**结构性必然**（回复还没产生），拿它当「无回复」的证据是拿「尚未」当「没有」。

## 三、边界（明写不做）

- **只动读侧纯函数**：`chain-query.ts` 判据一行 + `chain-query.test.ts`。**不碰采集**（`executionLogs.ts` 一个字节都不动）。
- **不碰 DDL、不碰前端、不引依赖。**
- **不加 `Chain.runningCount` 等新字段**——前端已在跳级渲染 `hops[].status`，链级聚合是便利字段非必需，避免契约膨胀。
- **不改 `spanMs` 算法**——它算的是「链内已见的最晚结束时刻 − 最早开始时刻」，定义本身正确（含在飞跳时为下界）。在飞链通常刚启动，跨度本就短，排名不受实质影响。

## 四、验收标准（行为可验证）

1. **running 跳不标 `no_reply`**：构造 `status='running'`、`message_id=null`、`ended_at=null` 的行 → 断言 `flags` **不含** `no_reply`。
2. **已结束但无回复的跳仍标**（防过度修正）：`status='failed'` / `reply_chars=0` → 断言**仍含** `no_reply`；`status='completed'` 且 `message_id=null` → **仍含**。
3. **既有断言零回归**：四 flag 正例 + `no_data` 负例 + `hops.length === hopCount` + 孤儿桶 + `totals` 不受 `limit` 影响，全部保持绿。
4. **真机复核（非单测）**：直连 dev 库跑 `buildChains`，
   - 2 条 `running` 行 → `flags` 不含 `no_reply`；
   - `failed` 行 → 仍带 `no_reply`（修复前该数 = 71 − 2 = 69，修复后 **应仍为 69**，仅 running 那 2 条退出）。
5. **全量测试 + lint 全绿**；commit message 带 `catstudy [$CATSTUDY_TRIGGER_MSG_ID]`，行号 grep 复核。

## 五、决策留痕

**OQ-1 裁决 = 加守卫。** 判据见上「三重理由」；关键是它**报假数**（主动错标），而非欠报（不完整）——评估系统的全部价值建立在「不骗人」上。

**OQ-3 撤销：ds猫 报的「幽灵 running（8 小时未收口）」实证不成立。**
它报「两条 started_at 都是 15:45:29、至今 8 小时」。实测：一条是 `15:55:15`（不是 15:45:29），另一条距今 **8 分钟**而非 8 小时。
**根因**：手工 SQL 对账时把 UTC 时间戳当成本地时间读——**正是它在 `chain-query.ts:97-99` 亲手写下的警告**（不补 `Z` 差 8 小时）。代码里做对了，对账时踩了自己立的规矩。
**保留的观察**：它顺带发现「在飞跳所在链 `spanMs` 排名 165/482、被 `limit=20` 截掉」——该观察**成立**，但根因是排序契约（跨度降序）而非幽灵；按本票第三节，`spanMs` 定义正确，不改。

**OQ-6 单开一票，不阻塞本票。** `parseFloat(env || '默认')` 在 env 为 `abc` 时得 `NaN`，`totalMs > NaN` 恒 false ⇒ `slow` 静默全不标。既有四处阈值同病（`l1-aggregator.ts:32` 等），本票只是同款携带。整族加 `Number.isFinite` 回退另立一票。

**教训（记一笔）**：实施者在自己写下时区警告的同一文件里，手工对账时踩了那个坑——**警告写在代码注释里，不会自动传导到临时脚本**。凡「手工 SQL 对账」结论，落库前必须先确认时区口径。

## 六、Resolution（ds猫，commit `0ca73cf`，2026-09-13 16:07 UTC）

**改动面**（2 文件，`+44 −3`，零范围蔓延——未碰采集 / DDL / 前端 / 依赖）：

| 文件                       | 位置                              | 改动                                          |
| -------------------------- | --------------------------------- | --------------------------------------------- |
| `eval/chain-query.ts`      | `:126` 判据 + `:121-125` 注释     | `no_reply` 加 `row.status !== 'running'` 守卫 |
| `eval/chain-query.test.ts` | `:118` / `:136` / `:147`（+3 例） | 验收 1 / 验收 2 负例 / 守卫方向向严           |

**守卫为何写成 `!== 'running'` 而非白名单 `=== 'failed' | 'completed'`**：方向向严——将来新增结束态 status 时，宁可多标（可被看见）也不静默漏标（消失）。已在 `:147` 用例里钉死该方向。

### 验收逐条留痕

| #   | 验收项                   | 结果 | 证据                                                                   |
| --- | ------------------------ | ---- | ---------------------------------------------------------------------- |
| 1   | running 跳不标           | ✅   | 单测 `:118`；真机 2 条 running（`6701eb89` / `4bb3b039`）`flags=[]`    |
| 2   | 已结束仍标（防过度修正） | ✅   | 单测 `:136`；真机 `failed` 69 条**全部**仍带 `no_reply`                |
| 3   | 既有断言零回归           | ✅   | 本文件 33 → 36 例全绿                                                  |
| 4   | 真机复核                 | ✅   | 见下表——旧规则 71 → 新规则 **69**，净差 2 **恰等于** running 跳数      |
| 5   | 全量测试 + lint          | ✅   | `npx vitest run` → **112 files / 2239 passed**；`pnpm lint` → 3 包通过 |

**验收 4 真机对账**（`tsx` 直连 dev 库 `cat-study-dev.db`，SQL 与 `executionLogs.ts:256-270` 逐字同一段）：

```
原始行 / 变换后跳数: 1093 / 1093 | 丢失: 0
链 / 孤儿跳: 484 / 28
status 分布: {completed:1022, failed:69, running:2}
running 跳数: 2 | 其中被标 no_reply: 0
failed  跳数: 69 | 其中带 no_reply: 69
旧规则 no_reply 总数: 71   新规则: 69   净差: 2 (== running 跳数)
```

**「71 → 69」与票单预测逐位吻合**，`failed` 那 69 条一条没退——这正是「防过度修正」闸要挡的反面。

**一个自指的巧合**：两条 running 里的 `6701eb89` **就是写这个修复的执行本身**（`af5f13a4` 触发）。写守卫的那次执行，正是守卫要保护的证据行。

### 上报两件事（不阻塞本票）

1. **`$CATSTUDY_TRIGGER_MSG_ID` 与票单「诱饵」标记冲突——以环境变量真值为准。**
   票单第五节（承店长上轮叙述）把 `af5f13a4…` 标为「诱饵不用」。实证推翻：该 id **命中 dev 库**，归属到恰好 1 条执行（`6701eb89`，本会话，`running`，`started_at 16:04:26`）——即本次执行。pre-commit 门禁亦判「命中 dev 库 → 放行」并将 `commit_hash` 写回该 running 行。**规律**：uuid 逐轮不同（`d4c52ec4` → `bcb8dd2f` → `9cf7d7be` → `af5f13a4`），票单里写死的那一个是**写票那轮**的值，不是实施轮的值——实施一律取当时的 `$CATSTUDY_TRIGGER_MSG_ID`。
2. **临时复核脚本删不掉**：`packages/server/data/eval/p1a2-check.ts` 残留（`rm` 被权限规则拒绝，未绕过）。该目录在 `.gitignore` 内，**不进任何提交**（`git status` 无此文件，已实证）；收口时可顺手清。
   **收口时复核：已清空**（`packages/server/data/eval/` 目录存在但为空，`git status` 干净）。

## 七、收口（店长，2026-09-13 16:13 UTC）

| 项            | 值                                                                              |
| ------------- | ------------------------------------------------------------------------------- |
| 审查结论      | 💬 仅评论（吐槽猫）——无必须修项，实施猫未返工                                   |
| 收口 PR       | #74 `closeout/p1a2-0ca73cf`（base=dev）                                         |
| 收口方式      | 隔离分支 pin 已审 sha 字面量 `0ca73cf`（**未整推 session 分支**）+ merge commit |
| merge commit  | `6812375c`                                                                      |
| 落 dev 后对账 | `dev = origin/dev = .push-gate = 6812375c` ✅                                   |
| 随行 docs     | `48374c9`（P1-B 票单回填）、`5e8897c`（P1-A 追补票单）——均 `docs/run/**` 免审   |
| 分支清理      | 本地 `-D` + 远端随 PR delete-branch；`ls-remote` 复核为 0                       |

**生效条件（未满足）**：本票是 **server 代码**，跑着的 server 仍是旧代码 ⇒ `/api/eval/chains` 端点里 `running` 跳**仍会被标 `no_reply`**。需重启才生效——与 P1-A 的 `latency_ms` 采集修复（`51170dc`，PR #72）**同一批**。

**收口时实测（两处独立证据）**：

1. `.restart-request` 仍为 `state: "pending"`、`expiresAt 2026-09-13T16:14:26Z` 到期——**用户未点确认，重启未发生**；
2. `execution_logs.latency_ms` 非空 **0 / 1095**——P1-A 的采集修复同样未生效，**数据窗口仍闭着**。

**已知滞留（记录≠真相，记一笔）**：§六 Resolution 由 `6172653` 引入，**未随本 PR 落 dev**——它是 `0ca73cf` 的**后代**而非祖先，隔离分支只 carry 已审 sha 及其祖先。⇒ **dev 上的本文件缺 §六、呈「未解决」态**。按既有惯例（纯 `docs/run/**` 提交从不单独开 PR），随下一次**代码类**收口一并带入。

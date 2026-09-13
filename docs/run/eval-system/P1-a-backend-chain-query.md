# P1-A 票单：采集修复 + 链路查询端点 + L1 口径端点

<!-- label: wayfinder:ticket -->
<!-- 上游地图: map.md（Destination + Decisions so far） -->
<!-- 免审白名单: 本文件在 docs/run/** 内；但本票的**代码改动进审查链** -->

Claimed by: _（认领时填）_
Blocked by: 无 —— 可立即开工

## 目标

把「哪条链耗时最长、卡在哪一跳」从**算不出来**变成**两个端点能答**。
本票只做后端（采集 + 读接口），不碰前端（前端是 P1-B）。

## 一、根因（店长实测，非转述）

`execution_logs.latency_ms` **dev 库 1084 行 100% NULL**（`SELECT COUNT(*) WHERE latency_ms IS NOT NULL` = **0**）。

**不是没采集，是被擦除**——同一个 agent 的最新 running 行，先写后擦：

| 步  | 位置                                 | 动作                                                                                                     |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | `execution/reply.ts:207`             | `const t0 = Date.now()`（在 `runAgentReply` 内）                                                         |
| 2   | `execution/reply.ts:900`             | `latencyMs = Date.now() - t0`                                                                            |
| 3   | `execution/reply.ts:1077`            | `updateExecutionLogDiagnostics` → `SET latency_ms = ?`（`db/repository/executionLogs.ts:295`）**写成功** |
| 4   | `execution/serial.ts:257`            | `finalizeRun` → `completeExecution`，**opts 里没有 latencyMs**                                           |
| 5   | `execution/serial.ts:1245` impl      | `opts?.latencyMs ?? null` → **null**                                                                     |
| 6   | `db/repository/executionLogs.ts:275` | `finalizeExecutionLog` 的 `SET latency_ms = ?` → **把 null 盖上去**                                      |

铁证：同一条 UPDATE 的兄弟列有值（`prompt_tokens` / `reply_chars` 各 ~1011 行非空）——它确实跑过。
连带 `eval/l1-aggregator.ts:82` 的 `AVG(CASE WHEN status='completed' THEN latency_ms END)` 恒 null → `L1Metrics.avgLatencyMs`（`:123`）永远是 null。

## 二、改动点（三处，边界写死）

### ① `packages/server/src/db/repository/executionLogs.ts:275` —— 一行

```sql
latency_ms = COALESCE(?, latency_ms),
```

**为什么是 COALESCE 而不是「把 latencyMs 一路穿到 completeExecution」**（架构裁决，别改成穿线）：

1. 穿线要动 `EngineCtx.completeExecution` 接口（`serial.ts:169-178`——**该接口类型里根本没有 `latencyMs`**，而 impl `:1250` 有，类型与实现已不一致）、`runAgentReply` 返回类型、`finalizeRun`（`serial.ts:249`）opts、以及 3 个调用点（`:257` / `:1378` / `dispatch/index.ts:156`）。面大且每处都可能再漂。
2. **COALESCE 顺带修了一个穿线会放大的错配**：`finalizeExecutionLog` 按 `agent_id + 最新 running` 定位（**WHERE 里没有 sessionId**）。同一只猫跨会话并行时存在两条 running 行，穿线会把 A 执行的 latency 写到 B 行上；COALESCE 只保留行内已有值，不会串行。
3. 语义：**finalize 永不擦除已记录的耗时**。传 null + 行内已有值 → 保留；传 null + 行内 null → 仍 null（失败跳就该是 null，不是 0）。

> ⚠️ **存量 1084 行不回填**。值真丢了，回填就是编数据。修复只对新执行生效——这是本票**唯一不可逆**的部分，也是它必须最先落地的原因。

### ② 新建 `packages/server/src/eval/chain-query.ts` —— 纯函数，零 I/O

**组件边界**：只做「原始行 → 链结构」的纯变换，**不碰 DB、不碰 Fastify**。这样能脱离 SQLite 全量单测分组 / 段算 / 排序 / 截断。

```ts
export interface ExecHopRow {
  // repo 产出的原始行（形状见 ③）
  execution_log_id: string
  agent_id: string
  agent_name: string
  status: string
  error_type: string | null
  started_at: string | null
  ended_at: string | null
  latency_ms: number | null
  reply_chars: number | null
  message_id: string | null
  triggered_by_message_id: string
  chain_id: string | null
}

export interface ChainHop {
  /* 见契约 */
}
export interface Chain {
  /* 见契约 */
}
export interface ChainQueryResult {
  /* 见契约 */
}

/** 纯函数：分组 + 段算 + flags + 排序 + 截断。opts.slowMs 来自 env。 */
export function buildChains(
  rows: ExecHopRow[],
  opts: { slowMs: number; limit: number }
): ChainQueryResult
```

**段算必须精确（这是本票最容易做错的地方）**：

- `totalMs = (ended_at − started_at)` 毫秒。两列都是 `datetime('now')` 写进去的 **UTC 字符串、精度 1 秒** ⇒ `totalMs` 是 1000 的整数倍，**不是毫秒精度**。注释里要写明。
- `replyMs = latency_ms`（毫秒精度，进程内 `Date.now()` 算的）。
- `nonReplyMs = replyMs === null ? null : Math.max(0, totalMs - replyMs)`。
- `segmentClamped = replyMs !== null && totalMs !== null && totalMs - replyMs < 0` —— 秒级舍入会造成负值，**钳位但显式暴露**，不静默。
- `ended_at` 为 null（`status='running'`，正在跑的那一跳）⇒ `totalMs = null`、`nonReplyMs = null`、`segmentClamped = false`。**该跳必须保留在 `hops[]` 里**——正在跑的就是当前卡点。

> 🚫 **命名禁用词**：字段名**不得**叫 `lockWaitMs` / `等锁段`。
> 实测 `t0` 在 `reply.ts:207`（`runAgentReply` **内部**），而 token 获取在 `serial.ts:431`，**在 `runAgentReply` 之前**。所以：
>
> - `replyMs` = 上下文过滤 + 记忆检索 + LLM 流式 + 落库（**不只是 LLM**）
> - `nonReplyMs` = **等 token 锁 + 编排收尾 + 建行开销**（等锁是主要成分，**但店长未实测占比**）
>
> 把它叫「等锁段」会让端点报假数。要拿纯等锁数字需新增列 = **P2 动表**，P1 不动表结构（可逆性裁决）。
> 注释与字段名一律用中性词（`reply` / `nonReply`）。

**卡点判据（P1 裁决 = 全标，不筛选）**——每跳带 `flags: string[]`，四值互不排斥：

| flag       | 判据                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `failed`   | `status === 'failed'`                                                                                                       |
| `no_reply` | `message_id === null` 或 `reply_chars === 0`（**失败的跳压根不产生消息行**——这正是「按消息行分组会吞掉卡点」的由来）        |
| `slow`     | `totalMs !== null && totalMs > opts.slowMs`                                                                                 |
| `no_data`  | `status === 'completed' && latency_ms === null`（有回复却无耗时——正是修复前全表的形态；修复后新数据不再出现，存量行会显示） |

**为什么 P1 不筛选**：地图的「Not yet specified」里挂着「四者算几个、阈值取多少」。现在选是拍脑袋——**先把四种都摆在页面上，用户看过真实分布再定阈值**。这比先选一个再改便宜。

**截断契约**：`limit` **只截链、不截跳**——整链返回或整链不返回，**绝不出现半条链**（半条链会伪造出错误的「链长」和「跨度」）。`totals` **永远基于未截断的全窗口**计算。

**排序**：`chains[]` 按 `spanMs` 降序（回答「哪里耗时最长」）；`spanMs` 并列时按 `chainId` 升序——**保证分页/重复请求不抖动**。

### ③ `packages/server/src/routes/eval.ts` —— 加两个路由

**DB 访问**放 repo 层（新函数加在 `db/repository/executionLogs.ts`），**纯变换**放 ②，路由只做「取数 → 调纯函数 → 返回」。别把 SQL 写进路由。

新增 repo 函数（建议名 `getExecutionHopsWithChainAnchor`）：

```sql
SELECT el.id AS execution_log_id, el.agent_id, a.name AS agent_name,
       el.status, el.error_type, el.started_at, el.ended_at,
       el.latency_ms, el.reply_chars, el.message_id,
       el.triggered_by_message_id,
       COALESCE(rm.task_id, tm.task_id) AS chain_id
FROM execution_logs el
JOIN agents a ON a.id = el.agent_id
LEFT JOIN messages rm ON rm.id = el.message_id                  -- 回复消息（finalize 写回 message_id）
LEFT JOIN messages tm ON tm.id = el.triggered_by_message_id     -- 触发消息
WHERE el.started_at >= datetime('now', '-N days')
```

链锚口径**已裁死**（地图 Decisions）：`COALESCE(回复消息.task_id, 触发消息.task_id)`，覆盖率 97.4%。
单用触发侧丢 32.5%、单用回复侧丢 7.5%——**别改回单侧**。时间窗口径与 `l1-aggregator.ts` 同（`started_at >= datetime('now','-N days')`）。

#### 路由 1：`GET /api/eval/l1-metrics`

暴露**已有**的 `aggregateMetrics()`（`eval/l1-aggregator.ts:65`）——当前无 HTTP 端点（只被 `:225` 的 `runL1Aggregation` 内部消费）。

- 路径**必须**是 `l1-metrics`：`/api/eval/aggregates`（`routes/eval.ts:47`）**已被 L2 按猫评分聚合占用**，撞名会静默覆盖。
- **纯读**：只调 `aggregateMetrics()`，**不得**触发 `runL1Aggregation()` 的滞回状态机与告警投递（那是定时任务的事，被一次 GET 顺带触发 = 假告警）。

```json
{
  "windowDays": 30,
  "successRate": 0.87,
  "timeoutRate": 0.02,
  "avgLatencyMs": 198800,
  "totalTokens": 12345,
  "suggestRate": 0.1,
  "rejectRate": 0.05,
  "parseFailureRate": 0.01,
  "infraFailures": 3,
  "sampleTotal": 1010
}
```

（即 `L1Metrics` 原样 + `windowDays`；`avgLatencyMs` 修复后在有 completed 样本时**非 null**。）

#### 路由 2：`GET /api/eval/chains?limit=20&windowDays=30`

`limit` 默认 20、上限 100（越界钳位，不报错）；`windowDays` 默认 30。

```json
{
  "windowDays": 30,
  "anchor": "coalesce(reply.task_id, trigger.task_id)",
  "slowMs": 300000,
  "totals": {
    "chains": 482,
    "hops": 1084,
    "orphanHops": 28,
    "avgHopsPerChain": 2.19,
    "maxHops": 26
  },
  "chains": [
    {
      "chainId": "9b4509e7-…",
      "startedAt": "2026-09-01 10:00:00",
      "endedAt": "2026-09-01 11:04:06",
      "spanMs": 3846000,
      "hopCount": 25,
      "completedCount": 21,
      "failedCount": 4,
      "hops": [
        {
          "executionLogId": "…",
          "agentId": "…",
          "agentName": "ds猫",
          "status": "completed",
          "errorType": null,
          "startedAt": "2026-09-01 10:00:00",
          "endedAt": "2026-09-01 10:02:00",
          "totalMs": 120000,
          "replyMs": 118500,
          "nonReplyMs": 1500,
          "segmentClamped": false,
          "flags": [],
          "triggerMessageId": "…",
          "replyMessageId": "…"
        }
      ]
    }
  ],
  "orphanChain": { "chainId": null, "hopCount": 28, "hops": [/* 同上形状 */] }
}
```

- `orphanChain` **恒在**（无孤儿时 `hopCount: 0, hops: []`）——**不得省略字段、不得静默丢弃**。dev 库实测 28 行（2.6%）。
- `chains[]` 里的链**不含**孤儿跳；孤儿跳只出现在 `orphanChain`。
- `startedAt`/`endedAt` 直接透传 SQLite 的 UTC 字符串（`YYYY-MM-DD HH:MM:SS`），**不做时区转换**——转换归前端。

### env

新增 `EVAL_CHAIN_SLOW_MS`（默认 `300000` = 5 分钟），按 `l1-aggregator.ts:33-40` 同款写法 `parseFloat(process.env.X || '300000')`，并登记进 `.env.example`。

## 三、验收标准（行为可验证）

1. **采集修复**：改完后跑**一次真实执行**（哪怕一条短消息），该行 `latency_ms` **非 NULL**。
   复核 SQL：`SELECT id, status, latency_ms FROM execution_logs ORDER BY started_at DESC LIMIT 3`
   —— 注意**存量 1084 行仍为 NULL 是正确的**，别拿存量行验收。
2. **不擦除**：单测直接造行——先 `updateExecutionLogDiagnostics` 写 1234，再 `finalizeExecutionLog(..., null, ...)`，断言 `latency_ms === 1234`。
   反向用例：**没写过** diagnostic 的行 finalize 后仍 NULL（**不得变成 0**——0 是「瞬间完成」，与「无数据」是两回事）。
3. `GET /api/eval/l1-metrics` 返回 200 且 `avgLatencyMs` 非 null（有 completed 样本时）；**不通** L1 告警路径（无告警消息落库）。
4. `GET /api/eval/chains?limit=1` 返回 200；`totals.chains` / `totals.hops` / `maxHops` 与直连 dev 库手工 SQL 一致（**快照值会漂**，以当时实测为准，不写死 482/26）。
5. `totals.orphanHops` 与 `SELECT COUNT(*) … WHERE COALESCE(rm.task_id,tm.task_id) IS NULL` 一致（dev 库当时 = 28）。
6. 单测覆盖（`eval/chain-query.test.ts`，纯函数、无 DB）：
   - `segmentClamped`：构造 `latency_ms > totalMs` 的行 → 断言 `nonReplyMs === 0` 且 `segmentClamped === true`
   - `running` 行（`ended_at` null）→ `totalMs/nonReplyMs === null`，**仍在 `hops[]` 里**
   - 四类 flag 各一条正例 + **一条 `no_data` 负例**（completed 且有 latency → 无 flag）
   - **半链不出现**：`limit` 截断后，返回的每条链 `hops.length === hopCount`
   - 孤儿跳全部落进 `orphanChain`，且 `chains[]` 里不含它们
   - `totals` 不受 `limit` 影响（截断前后 `totals` 相同）
7. `pnpm lint` 通过；`pnpm test:server` 全绿。

## 四、边界（**不做**）

- **不改表结构**（不加列、不加表）——`retrieval_events` / span 表是 **P2**，本票一个字节都不碰 DDL。
- **不回填存量 1084 行**（值已丢，回填 = 编数据）。
- **不做前端**（P1-B 的活）。
- **不碰** `recall_events` / `chunks` / 记忆检索链路 / dispatch 派发链路。
- **不改** `/api/eval/aggregates`（L2 占用中）、不改 `aggregateMetrics()` 的 SQL 口径（本票只是给它开个门）。
- **不引入新依赖**。

## 五、提交规范

- **worktree**：本票在会话 worktree `D:/Game/ai/catStudy-sessions/0eb66b63` 内干活，git 一律 `git -C D:/Game/ai/catStudy-sessions/0eb66b63 <cmd>`。
- **限定路径**：`git add packages/server/src/... .env.example`（**显式路径**）。p 猫并行时**禁止 `git add -A`**——会扫走别人未提交的文件。
- **uuid 标记**：commit message 带 `catstudy [<uuid>]`，uuid 取 **`$CATSTUDY_TRIGGER_MSG_ID`**（本会话 = `d4c52ec4-e909-4f53-93a6-6108a3aa3e2a`）。
  ⚠️ **不是 `$CATSTUDY_MSG_ID`**——那是个诱饵变量，用了会被 uuid 门禁挡下。
- **禁 `--no-verify`**；push 归店长，实施者不自行收口。

## 决策留痕

- 跳 grilling：因 需求经 wayfinder 地图收敛（T1+T2 双票已关）+ 用户 2026-09-13 批「开工」，无新歧义待压测 → 故本单不单跑 grill
- Gate B 契约：[边界=只做后端三处（一行 SQL / 一个新纯函数模块 / 两个路由 + 一个 env），**不碰 DDL、不碰前端、不回填存量** / 契约=两端点 JSON 字段级冻结 + 链锚 `coalesce(reply,trigger)` 已裁死 / 验收=7 条可执行项，含直连 dev 库 SQL 复核与纯函数单测] 已钉死
- 架构裁决①：`finalizeExecutionLog` 用 **SQL COALESCE** 而非「把 latencyMs 穿到 completeExecution」——理由见二①（穿线面大 + 会放大 finalize 无 sessionId 的错配）
- 架构裁决②：段命名用 `replyMs` / `nonReplyMs`，**禁 `lockWaitMs`**——`t0`（`reply.ts:207`）在 token 获取（`serial.ts:431`）**之后**，残余段不等于等锁
- 卡点判据：P1 裁决 = **四类全标不筛选**，`slow` 阈值 env 化；待真实分布再定阈值（把地图「Not yet specified」该项毕业）
- 可逆性排序：本票是 P1 里**唯一不可逆**的部分（采集窗口持续丢），故排在读接口/展示之前

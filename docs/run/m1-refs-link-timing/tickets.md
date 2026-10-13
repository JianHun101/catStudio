---
status: active
---

# 票：M1 缺陷修复 —— 最新回复短暂显示「未检索」（连线排在广播之后）

> 立票 2026-09-26 · 店长 · 用户拍板「按你说的做」（方案甲）。
> 母票：`docs/run/eval-system/M1-memory-refs-display.md`（已收口，PR #173）。本票是其遗留缺陷单。

## 一、缺陷与根因（已逐行核码）

**现象**：最新一条回复底部的记忆行会短暂显示「未检索」（约 100ms 窗口），且前端不再重查，假态一直挂到刷新。

**根因**：广播跑在连线前面。

1. `packages/server/src/execution/reply.ts` 的 `runAgentReply` 顺序：回复落库（`insertAgentMessage`）→ `bus.emitMessage(finalMsg)`（NEW_MESSAGE 广播）→ 返回 msgId。
2. `execution_logs.message_id`（回复与检索流水的关联环）要等回到 `serial.ts` 成功路径的 `finalizeRun` → `finalizeExecutionLog` 才写。
3. 前端收到 NEW_MESSAGE 立刻批量请求 `/memory-refs`，路由查询第一环 JOIN 就是 `execution_logs.message_id`——此刻仍是 NULL ⇒ 查无流水 ⇒ 渲染「未检索」。

## 二、修法（方案甲，架构裁决）

DB 层把窗口关死，**不动广播契约、不动前端**：

1. **连线提到广播之前**：`reply.ts` 在 `bus.emitMessage(finalMsg)` 之前，复用 `recordRetrievalTrace` 的既有定位口径（按触发消息找本轮 running 执行行：`getLogsByTriggerMessage` + agent/session/running 过滤），新增 repo 函数 `linkReplyMessage(executionId, messageId)` 提前写 `execution_logs.message_id`。失败只 warn 不阻塞回复（与本模块「记忆面故障不杀回复」的硬约束一致）。
   - 不变量保持：message_id 只在回复行已存在后才写——「message_id 非空即已回复」的重启恢复语义（`execution/recovery.ts`）不动。
2. **`finalizeExecutionLog` 防擦**：`message_id = ?` 改为 `message_id = COALESCE(?, message_id)`，照 latency_ms 的 P1 先例（见 `executionLogs.test.ts` 的「finalizeExecutionLog 不擦除耗时」组）。成功路径写同值（幂等）；理论上的「广播后异常走 failed 收口」不会把已连的线擦回 NULL。

**被否方案乙**（refs 挂进广播载荷）：省一次 REST，但要在 shared Message 类型 + web store 各开一条消费面，refs 真相裂成两份（载荷 + DB）；M1 票面裁定的读口形态就是「按 message_id 批量取」，乙等于把读口劈成两条路。

## 三、边界

- 只改：`packages/server/src/execution/reply.ts`（约 15 行）、`packages/server/src/db/repository/executionLogs.ts`（新函数 + 一处 COALESCE）、两侧测试（`reply.test.ts` / `executionLogs.test.ts`，必要时 `serial.test.ts` 配对链）。
- **不改**：广播载荷形状（shared 类型）、前端任何文件、`/memory-refs` 路由、恢复语义。
- 架构异议走审查链提，不中途改设计。

## 四、验收（行为可验证）

1. **窗口关死（组装式）**：捕获 bus，在 NEW_MESSAGE emit 那刻直查 DB——`execution_logs.message_id` 已等于回复 id。给出测试名与实跑输出。
2. **防擦（repo 测试）**：`finalizeExecutionLog` 传 replyMessageId=null 落在已有 message_id 的行上 ⇒ 值保留。照「finalizeExecutionLog 不擦除耗时」组同款写法。
3. **读口端到端**：广播时刻调 `/memory-refs` 返回 injected 态（有注入时），不是 not-retrieved。
4. **回归**：失败路径（无回复产出）message_id 仍为 NULL；`execution/recovery.ts` 的重启恢复兜底语义不变（既有恢复测试全绿即证）。
5. `pnpm test` + `pnpm lint` 全绿（剥环境注入变量，口径见 AGENTS.md 测试段先例）。

## 五、Open Questions（回报时逐条答）

- **OQ-1**：`recordRetrievalTrace` 的定位口径（`getLogsByTriggerMessage` + running 过滤）在「广播前」这个更早的时点是否同样命中唯一行？若可能命中零行（如无检索的回复），`linkReplyMessage` 应是 no-op 还是报错？给出实测与取舍。
- **OQ-2**：`linkReplyMessage` 失败（warn 不阻塞）时，窗口退化为原状（100ms 假态）——该退化是否可接受？若不可接受，备选是什么？

## 六、决策留痕

- **2026-09-26 店长（立票）**：用户在 M1 收口后确认缺陷存在（最新回复短暂「未检索」），拍板「按你说的做」= 方案甲。根因三跳（reply.ts 广播序 / serial.ts 连线点 / 前端立即请求）均已核码，锚点用可 grep 唯一名，不锚行号。
- **重启提示**：本票含 server 代码 ⇒ 合并收口后走共通层重启审批（店长发起，用户批准）。

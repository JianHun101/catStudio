---
type: plan
status: closed
evidence:
  - kind: commit
    ref: 33b6028
  - kind: commit
    ref: 7c5a6fa
  - kind: commit
    ref: ac66e6d
---

# Agent 回复计时上气泡（v1）

> 需求来源：用户会话内逐轮拍板（2026-09-18）。原型评审两轮到定稿：
> 成员卡方案（「太难看 + 挤压右侧 token 展示」）被否决 → 气泡 footer 方案拍板。
> 派活链：spec-gate → to-tickets（`docs/run/agent-reply-timer/tickets.md`）→ implement。

## Problem Statement

Agent 回复计时目前挂在**触发它的用户消息**的状态行上（`MessageItem.vue` → `AgentStatusLabel.vue`，数据源 `MESSAGE_AGENT_STATUS`）。A2A（猫 @ 猫）触发的执行没有对应的用户消息可附着，运行时长完全不可见——用户无法观察「这个 Agent 回复这个问题已经运行了多久」。

## Solution

计时绑定在 **Agent 自己的聊天气泡 footer**：

- 流式气泡现有的静态「回复中…」指示升级为「回复中 · 已 N 秒」，逐秒递增；
- 无流式期间（headless 适配器整轮 / 首个 chunk 前 / A2A 触发）补同款**虚线占位气泡**：正文思考动点，footer 带计时与停止按钮；
- 数据源**复用现有 `MESSAGE_AGENT_STATUS`**（按 agentId 键控消费），server 仅把 `startedAt` 锚点从「replying 才带」提前到「thinking 也带」；
- 秒数由 web 叶子组件本地 1s tick 自增，server 零额外流量（既有 10s 心跳只做 liveness 锚点 + 刷新自愈）；
- 用户消息状态行**保留状态文字与停止按钮，不再显示秒数**（计时唯一权威位 = 气泡 footer）。

## User Stories

1. 作为用户，当猫 A @ 猫 B 触发执行时，我要在 B 的气泡上看到已运行秒数逐秒递增，以便知道这次 A2A 执行跑了多久。
2. 作为用户，当 headless 适配器（如 dsh）整轮无流式输出时，我要看到占位气泡与计时，以便确认进程还活着、跑了多久。
3. 作为用户，在首个 chunk 到达前（上下文组装/思考阶段），我要看到占位气泡与计时，而不是聊天区毫无动静。
4. 作为用户，执行超过一分钟时，我要看到「已 3:12」而不是「已 192 秒」，以便快速读懂量级。
5. 作为用户，当 server 心跳失联时，我要看到计时停走并显示「无响应」，以便区分「还在跑」与「进程死了」。
6. 作为用户，刷新页面或切会话后回来，我要在执行中心跳（10s）内恢复计时显示且秒数不归零，以便观察不中断。
7. 作为用户，执行完成 / 被我停止 / 超时后，计时与占位气泡要消失，不留「无响应」僵尸。
8. 作为用户，我的消息状态行仍保留状态文字与停止按钮，但不再显示秒数。
9. 作为用户，排队状态沿用现有成员卡「队列 N 条」表达；气泡计时只计执行时长，不含排队。

## Implementation Decisions

1. **数据源复用 `MESSAGE_AGENT_STATUS`，不改 `AgentRuntimeState`、不加新事件。** 原方案是给 `AgentRuntimeState` 加 `startedAt`/`lastBeatAt` 走 `AGENT_STATUS` 通道；实读后发现 `MESSAGE_AGENT_STATUS` 已对**全部执行（含 A2A）**广播 `replying` + `startedAt`（`reply.ts` 执行入口一次取值），且自带 10s 心跳重发同 `startedAt`——心跳同时解决 liveness 与刷新自愈（刷新后 ≤10s 重收锚点，秒数不归零）。改走 `AGENT_STATUS` 反而要新搭 per-agent 心跳通道，改动更大收益为零。
2. **计时锚点 = 执行起点（thinking 时刻）。** server 把 `startedAt` 提前：`thinking` 事件（执行入口，上下文组装前）与后续 `replying`/心跳共享同一次 `Date.now()` 取值（hoist 到函数前部）。与 trace 根段 `invoke_agent` 起点同口径。shared 类型 `MessageAgentStatusPayload.startedAt` 的注释从「仅 replying」改为「thinking/replying」——纯注释，wire 形状不变。
3. **web store 新增 agentId 键控计时表** `replyTimers: Map<agentId, { startedAt, lastBeatAt }>`，在现有 `MESSAGE_AGENT_STATUS` handler 内维护：`thinking`/`replying` → 写入（`startedAt` 取新旧较小者做防御，`lastBeatAt` = 客户端接收时刻）；`done` → 删除；`AGENT_STATUS` `idle` → 删除（覆盖 abort/timeout 等无 `done` 的终止路径）；切会话时与 `typingStates` 同点清空。单 agent 单槽位串行 ⇒ 一猫至多一条，无并发冲突。
4. **新叶子组件 `ReplyElapsed.vue`**：props `{ startedAt, lastBeatAt }`；本地 1s tick 驱动重算（`onUnmounted` 必 clear）；文案 `回复中 · 已 N 秒`（N<60）/ `回复中 · 已 M:SS`（≥60s，用户拍板）；`lastBeatAt` 距今 >25s（`HEARTBEAT_STALE_MS` 同值）→ 红字「无响应」停走。liveness 语义照抄 `AgentStatusLabel.vue` 既有实现。
5. **ChatPanel 流式气泡 footer**：静态「回复中…」替换为 `ReplyElapsed`（数据 `replyTimers.get(agentId)`）。停止按钮不动。
6. **占位气泡**：对「`replyTimers` 有、`typingStates` 无」的 agent 渲染 streaming 同款气泡（虚线边框 = 现有 `.message.streaming` 视觉语言，零新增容器样式）；正文 = 思考动点（与流式思考折叠块 header 动点同款，用户拍板）；footer = 停止按钮（`canStopAgent`）+ `ReplyElapsed`。首个 chunk 到达（`typingStates` 有条目）后自然切换为流式气泡——计时同源不重置。
7. **用户消息状态行去秒**：`AgentStatusLabel` 的 `replying` 分支不再输出「· 已 N 秒」，保留 已收到/思考中/回复中/完成/无响应 与停止按钮。组件内 1s tick 保留（驱动「无响应」翻转），但不再驱动秒数。
8. **渲染纪律**：每秒变化的响应式状态只允许存在于叶子组件（`ReplyElapsed` / `AgentStatusLabel`）；ChatPanel 顶层不得引入任何每秒变化的 ref（`ChatPanel.test.ts` 既有静态断言守门，新增断言覆盖本单）。

## Testing Decisions

- 只测外部行为，不测实现细节；co-located 测试跟随被测模块。
- server：扩展现有 heartbeat 测试块（`connectors/socketio.test.ts`「stream 未结束时推进 fake timer」一带）——断言 `thinking` 事件带 `startedAt` 且与 `replying`/心跳同值。
- web store：`chat.test.ts` —— `replyTimers` 写入 / 较早 `startedAt` 保留 / `lastBeatAt` 刷新 / `done` 删除 / `AGENT_STATUS idle` 删除 / 切会话清空。
- web 组件：静态源断言（`?raw`，`ChatPanel.test.ts` 范式）——tick 只在 `ReplyElapsed`；ChatPanel 顶层无每秒 ref；`MessageItem` 状态行文案无秒数。`ReplyElapsed` 行为测试用 fake timer 断言 N 秒 / m:ss / 无响应 三态。
- prior art：`AgentStatusLabel` 的 tick + liveness 实现、`ChatPanel.test.ts` 顶层 tick 静态断言、`socketio.test.ts` 心跳 fake timer 块。

## Out of Scope

- 成员卡（`SessionAgentsPanel`）计时——原型评审已被用户否决（「太难看 + 挤压 token 展示」）。
- 排队时长 / 「含排队总时长」——排队由现有成员卡「队列 N 条」表达；trace 的 `dispatch.queue_wait` 段起点时间戳已存在，二期如需直接透出即可，本单不做。
- `AgentRuntimeState` 加字段、新 socket 事件、DB 变更、调度逻辑变更——均不做。
- 适配器内部进度（工具级计时）——不做。

## Further Notes

- 设计原型：高保真 HTML 原型（真实主题变量 + 卡片/气泡样式取自源码），一次性产物放 TEMP 目录，不落仓库；用户已按原型拍板形态。
- 桌面端既有行为不变：`MESSAGE_AGENT_STATUS` 的 messageId 键控消费（`messageStatus` Map、消息 lifecycle 推进）原样保留，本单只是**新增**一条 agentId 键控的消费支路。

## 决策留痕

- 跳 grilling：需求经会话内逐轮拷问成型（展示位两轮评审：成员卡方案被用户否决；「排队中」展示位被用户指出与成员卡序号冗余后由店长主动撤回；trace 复用方向经实码证伪后改道），全部拍板项已落地 → 故本单不单跑 grill。
- Gate B 契约：[边界 = 见 Out of Scope ／ 契约 = `MESSAGE_AGENT_STATUS` 按 agentId 键控复用 + `thinking` 补 `startedAt`（与 `replying` 同值）+ `ReplyElapsed` props 形状 ／ 验收 = User Stories 1-9 ↔ tickets 验收项] 已钉死。
- 用户拍板记录：①展示位 = Agent 聊天气泡 footer（否决成员卡）；②超 60s 转 m:ss = 采纳；③占位气泡正文 = 思考动点 = 采纳；④用户消息状态行 = 保留状态与停止按钮、不显示时间；⑤计时锚点 = 执行起点（与 trace 根段 `invoke_agent` 同口径）。
- 数据源改道留痕：原方案（`AgentRuntimeState` 加字段走 `AGENT_STATUS`）在实读 `reply.ts` 心跳实现后被「复用 `MESSAGE_AGENT_STATUS`」替代——依据 = 既有心跳已覆盖 liveness + 刷新自愈，`AGENT_STATUS` 路径需新建 per-agent 心跳，改动更大收益为零。

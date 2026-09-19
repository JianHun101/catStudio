---
type: decision
date: 2026-07-13
status: accepted
evidence:
  - kind: file
    ref: packages/server/src/execution/serial.ts
  - kind: file
    ref: packages/server/src/dispatch/index.ts
  - kind: file
    ref: packages/server/src/execution/registry.ts
---

# ADR 0004: 单槽位 Agent + FIFO 调度

> **实现现状**：槽位实际状态仅 `idle` / `busy`（`dispatch/index.ts`）。`thinking` 仅在 TypeScript 类型定义中存在，前端通过连接器层 `MESSAGE_AGENT_STATUS` 事件独立展示"思考中"。超时采用两层防御：CLI 空闲超时 20 分钟 + Dispatch 硬超时 30 分钟（通过 `AGENT_HARD_TIMEOUT_MS` 环境变量配置）。
>
> **实现现状（续 · 2026-09-19 核验，**本条改写了正文的粒度声称**）**：槽位键已从「agentId」扩为 **`(agentId, sessionId)`**（`execution/serial.ts:185` `slots: Map<string, Map<string, Slot>>`）——多会话并行落地后**同一 Agent 可同时持多个槽位**（每会话一个），正文「每个 Agent 只有一个执行槽位。同时最多处理一件事。」在**跨会话**维度上已不成立。**保留下来的不变量**是**同会话同 Agent** 的那一条：自带 FIFO 队列、串行执行、不并发（`serial.ts:162-163`）——即「对话内不被并行打断」的决策意图原样存活，变的是槽位粒度。读本 ADR 时请以本注的粒度理解正文。
> **C1 v3 补充**：槽位与其 FIFO 队列已收进 `createExecutionEngine` 闭包（原 `dispatch/` 模块级 `agentSlots` + `agentQueues`），`dispatch/index.ts` 只留兼容 shim 与只读 accessor。

每个 Agent 只有一个执行槽位。同时最多处理一件事。槽位忙时新请求进入该 Agent 私有的 FIFO 队列。Agent 回复是 FIFO 串行的——先被 @ 的 Agent 先回复，后者看到前者的回复后再回应，保证对话连贯性。

## Considered Options

- **并行执行**：多个 Agent 同时推理，同时回复。响应快但 Agent 之间不感知对方的发言，缺乏真实群聊的"承接感"。
- **FIFO 串行**（选中）：Agent 相互看到前序回复。像人类群聊——后面说话的人看到了前面人说了什么。
- **Agent 自主决策**：Agent 自行判断要不要插话。最自然但每条消息都要过所有 Agent 的 LLM——token 消耗随 Agent 数量线性增长，成本爆炸。

## Consequences

- Token 节省——不是每条消息都驱动所有 Agent 推理。只有被 @ 或广播指定的 Agent 才被唤醒。
- 延迟可感知——@ 3 个 Agent 时，用户要等 3 次 LLM 推理的总时间。可通过流式输出抵消焦虑。
- Agent 不会主动说话——空闲冷场时没有自发暖场行为。这是明确的 trade-off。
- 超时保护——单槽位意味着槽位卡死会永久阻塞后续排队。采用两层超时防御：CLI 空闲超时 20 分钟 + Dispatch 硬超时 30 分钟（`AGENT_HARD_TIMEOUT_MS`）。

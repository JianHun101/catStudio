# ADR 0005: Redis Pub/Sub 消息总线

> **实现现状**：Redis 实际为可选依赖（连接失败静默降级，见 `packages/server/src/db/redis.ts`）。三频道中仅 `agent:{id}:status` 被实际发布；`session:{id}:messages` 和 `session:{id}:agent:{name}` 频道已在 `shared/src/events.ts` 定义但未投产，预留未来多进程扩展。QQ Bot 适配器尚未实现。核心消息分发实际通过 Socket.IO 房间广播完成。

多 Agent 实时通信使用 Redis Pub/Sub 而非纯 WebSocket 应用层广播。采用方案 A 的三频道设计：

```
session:{id}:messages      — 消息流（所有参与者订阅）
session:{id}:agent:{name}  — 调度指令（指定 Agent 订阅）
agent:{id}:status        — Agent 状态变更（全系统订阅）
```

## Why not WebSocket-only?

WebSocket 只解决"服务端 ↔ 浏览器"的单向通道。当 QQ Bot 适配器作为独立进程运行时，它无法直接收到 Server 进程内的 WebSocket 广播——必须有外部消息中间件。Redis Pub/Sub 天然跨进程，Server 和 QQ Bot 各订阅相关频道即可。

## Why separate status channels?

Agent 数量少（~5-10 个），独立的 `agent:{id}:status` 频道方便后续扩展——监控面板、日志审计、健康检查只需订阅 `agent:*:status` 模式，不需要在 inbox 频道里过滤消息类型。

## 状态频道 key 与 payload 形状（修订）

状态频道统一按 `agentId` 命名（`agent:{id}:status`）——id 是稳定标识（name 可改、可撞，且 `updateQueueState` 手里只有 id）。原契约按 `agentName`（`events.ts` 的 `Channels.agentStatus`），与 `dispatch/index.ts` 中 `updateQueueState` 用 `agentId` 的调用点不一致，属潜伏错配（全仓库无订阅者期间静默无害，未来加跨进程订阅者会错配）。

两处发布点的 payload 形状不同——`publishAgentStatus`（busy/idle 快照）vs `updateQueueState`（sessionId + queueLength）——为已知观察项，暂不拆频道；待有真实订阅者时再定频道语义。

## Consequences

- Redis 当前为可选依赖——连接失败时系统自动降级为纯 Socket.IO 模式。
- Socket.IO 负责 Server ↔ Web 前端的实时通道，Redis Pub/Sub 负责 Server 内部和跨进程通道。两者分工明确不重叠。

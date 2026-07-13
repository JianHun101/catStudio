# ADR 0005: Redis Pub/Sub 消息总线

多 Agent 实时通信使用 Redis Pub/Sub 而非纯 WebSocket 应用层广播。采用方案 A 的三频道设计：

```
session:{id}:messages      — 消息流（所有参与者订阅）
session:{id}:agent:{name}  — 调度指令（指定 Agent 订阅）
agent:{name}:status        — Agent 状态变更（全系统订阅）
```

## Why not WebSocket-only?

WebSocket 只解决"服务端 ↔ 浏览器"的单向通道。当 QQ Bot 适配器作为独立进程运行时，它无法直接收到 Server 进程内的 WebSocket 广播——必须有外部消息中间件。Redis Pub/Sub 天然跨进程，Server 和 QQ Bot 各订阅相关频道即可。

## Why separate status channels?

Agent 数量少（~5-10 个），独立的 `agent:{name}:status` 频道方便后续扩展——监控面板、日志审计、健康检查只需订阅 `agent:*:status` 模式，不需要在 inbox 频道里过滤消息类型。

## Consequences

- Redis 成为系统运行的必要依赖（非可选）。
- Socket.IO 负责 Server ↔ Web 前端的实时通道，Redis Pub/Sub 负责 Server 内部和跨进程通道。两者分工明确不重叠。

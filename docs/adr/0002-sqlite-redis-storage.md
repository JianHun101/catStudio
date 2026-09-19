---
type: decision
date: 2026-07-13
status: deprecated
verdict: SQLite + Redis 双存储方案已废弃——Redis 部分整体不做（2026-09-01 拆除），现为 SQLite 单存储
evidence:
  - kind: file
    ref: packages/server/src/db/index.ts
  - kind: file
    ref: packages/server/src/connectors/socketio.ts
  - kind: file
    ref: packages/server/src/db/migrations.ts
---

# ADR 0002: SQLite + Redis 双存储

> **实现现状**：Redis 已退役（2026-09-01）——消息总线整体拆除，系统消息分发完全由 Socket.IO 房间广播承担，SQLite 仍是主持久化。本文档 Redis 部分保留作历史记录。

**Status**: deprecated（Redis 部分已退役 2026-09-01；SQLite 半仍成立、继续在用）

SQLite（better-sqlite3）做主持久化——Agent 配置、对话历史、记忆向量（sqlite-vec 扩展）。Redis（ioredis）做消息总线——Agent 间实时 Pub/Sub 通信和状态广播。

## Considered Options

- **SQLite only**：MVP 足够，但 Agent 间实时通信只能用 WebSocket 应用层广播。当接入 QQ Bot 等多渠道时，WebSocket 无法跨进程——QQ Bot 适配器和 Web Server 是不同进程，需要外部消息中间件才能共享 Agent 回复。
- **SQLite + Redis**（选中）：SQLite 管持久化，Redis 管实时消息。Redis 是可选的——单机 Web 场景不装 Redis 也能跑（用内存 Pub/Sub 兜底），但多渠道场景必须上。

## Consequences

- 部署依赖增加：需要 Redis Server（>=7.0）进程。对"下载即用"的场景增加了一步配置。
- WAL 模式确保意外关闭不丢 SQLite 数据。备份用 `VACUUM INTO` 导出干净单文件。

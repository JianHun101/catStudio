# CatStudy — 猫咖多 Agent 对话系统

面向终端用户的本地多 Agent 对话平台。用户创建会话，与一组具有持久身份和长期记忆的拟人化 Agent 进行群聊。支持 Web 界面接入。

## Language

### Agent（猫咪角色）

一个具有固定身份、长期记忆和对话能力的 AI 实体。每个 Agent 独立配置 LLM 供应商和 API key。Agent 不自主插话——只在被调度时回复。
_Avoid_: Bot, 机器人, AI 助手

### Session（会话）

一个独立的多人对话线程。用户创建 Session 后加入一组 Agent，对话在 Session 内隔离。用户可同时打开多个 Session。
_Avoid_: 聊天室, 房间, 线程

### Slot（槽位）

Agent 的执行能力单元。每个 Agent 只有一个 Slot，同一时刻最多处理一件事。Slot 状态：`idle`（可接任务）、`busy`（执行中）。忙时新请求进入 FIFO 队列。Agent 开始推理时，前端会先显示 `thinking` 状态（连接器层发送的展示事件，非槽位状态）。
_Avoid_: 通道, 并发数

### Message（消息）

对话中的单条发言。`role` 区分 `user`（人类）、`agent`（猫咪角色）、`system`（系统通知）。Message 携带 `mentions` 列表——被 @ 的 Agent 标识——用于调度路由。
_Avoid_: 记录, 日志, 发言

### Memory（记忆）

Agent 对过往对话的一条持久化记录，以嵌入向量的形式存储，支持语义相似度检索。每次 Agent 被调度回复时触发检索，匹配的记忆注入 Agent 的推理上下文。
_Avoid_: 历史, 缓存, 上下文片段

### Embedding（嵌入向量）

文本语义的固定维度数值表示。由全局独立配置的嵌入模型在本地生成，与各 Agent 的 LLM 供应商解耦——所有记忆共享同一向量空间。
_Avoid_: 特征向量, 语义编码

### Mention（提及）

用户消息中对特定 Agent 的显式引用（@Agent名）。Mention 是调度系统的输入——被提及的 Agent 的 Slot 被检查，决定立即执行还是排队。
_Avoid_: 点名, @标记

### Dispatch Queue（调度队列）

当 Agent 槽位忙碌时，新请求按 FIFO 顺序排队等待。队列是按 Agent 独立的——每个 Agent 有自己的等待队列。
_Avoid_: 待处理列表, 任务队列

### Connector（渠道适配器）

连接外部消息平台和 CatStudy 消息总线的适配器。Web Connector 通过 Socket.IO 连接浏览器。Connector 只做消息格式转换和路由，不包含业务逻辑。未来可扩展 QQ 等渠道。
_Avoid_: 插件, 桥接, 前端

### Message Bus（消息总线）

消息分发机制。核心通过 Socket.IO 房间广播实现实时消息推送。Redis Pub/Sub 作为可选补充（`agent:{name}:status` 频道用于跨进程 Agent 状态同步），Redis 不可用时系统自动降级为内存模式。频道设计预留 `session:{id}:messages` 和 `session:{id}:agent:{name}` 用于未来多进程扩展。
_Avoid_: 事件总线, 队列

### Execution Log（执行日志）

Agent 每次回复的完整执行记录。包含触发消息、开始时间、结束时间、最终状态。用于调试和审计。
_Avoid_: 日志, 请求记录

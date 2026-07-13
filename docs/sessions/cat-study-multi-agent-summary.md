# CatStudy 多 Agent 对话可视化框架搭建

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `CONTEXT.md` | 新建，领域术语表。定义 Agent、Session、Slot、Message、Memory、Dispatch Queue 等 10 个核心术语 |
| `docs/adr/0001-pnpm-monorepo.md` | 新建，架构决策：pnpm workspace monorepo 结构（packages/server / web / shared），与 Clowder AI 同架构 |
| `docs/adr/0002-sqlite-redis-storage.md` | 新建，存储决策：SQLite (better-sqlite3 + sqlite-vec) 做主持久化，Redis (ioredis) 做消息总线 Pub/Sub |
| `docs/adr/0003-per-agent-llm-adapter.md` | 新建，LLM 决策：每个 Agent 独立配置供应商和 API key，同一 Session 内不同 Agent 可用不同模型 |
| `docs/adr/0004-single-slot-fifo-scheduling.md` | 新建，调度决策：单槽位模型 + FIFO 串行执行。Agent 被 @ 才唤醒，不自主插话 |
| `docs/adr/0005-redis-pubsub-message-bus.md` | 新建，消息总线决策：三频道设计（消息流 / 调度指令 / 状态变更） |
| `docs/adr/0006-vector-memory-retrieval.md` | 新建，记忆决策：embedding 向量检索（sqlite-vec），全局独立 Embedding 配置 |
| `packages/shared/` | 新建，共享包。types.ts（AgentConfig、SessionConfig、Message、Memory、Slot 等类型）、schemas.ts（Zod 校验）、events.ts（Socket.IO 事件名 + Redis 频道模式常量） |
| `packages/server/` | 新建，后端包。Fastify + Socket.IO + better-sqlite3 + ioredis |
| `packages/server/src/db/index.ts` | 新建，SQLite 数据库初始化（WAL 模式），5 张表：agents / sessions / messages / memories / execution_logs |
| `packages/server/src/db/redis.ts` | 新建，Redis 客户端封装。支持连接失败降级运行，不阻塞服务启动 |
| `packages/server/src/llm/adapter.ts` | 新建，LLMAdapter 统一接口定义（chatStream 返回 AsyncIterable<Chunk>） |
| `packages/server/src/llm/deepseek.ts` | 新建，DeepSeek 适配器。走 Anthropic Messages API 格式，system prompt 放在顶层 `system` 字段，messages 只含 user/assistant，兼容 Anthropic event 和 OpenAI data 两种 SSE 格式 |
| `packages/server/src/llm/registry.ts` | 新建，按 apiKey 缓存适配器实例，支持 provider 字段路由到对应适配器 |
| `packages/server/src/dispatch/index.ts` | 新建，调度引擎。单槽位模型 + FIFO 队列，executeAgent / completeExecution / publishAgentStatus |
| `packages/server/src/connectors/socketio.ts` | 新建，Socket.IO 连接器。消息收发、历史加载（camelCase 转换）、Agent 串行执行、上下文过滤（每个 Agent 只看和自己相关的消息） |
| `packages/server/src/routes/agents.ts` | 新建，Agent REST API（CRUD） |
| `packages/server/src/routes/sessions.ts` | 新建，Session REST API（创建/列表/详情/删除） |
| `packages/server/src/seed.ts` | 新建，种子数据。3 只演示猫咪（店长阿暹 / 服务员橘子 / 吐槽猫灰灰），强角色 system prompt，API key 从环境变量 DS_KEY 读取 |
| `packages/server/src/index.ts` | 新建，服务入口。Fastify listen → attach Socket.IO → 注册路由 → 优雅关闭 |
| `packages/web/` | 新建，前端包。Vue 3 + Vite + Pinia + Socket.IO Client |
| `packages/web/src/App.vue` | 新建，三面板网格布局（240px | 1fr | 280px） |
| `packages/web/src/components/SessionList.vue` | 新建，左侧面板。从 API 加载会话列表，选中加入，新建会话弹窗 |
| `packages/web/src/components/ChatPanel.vue` | 新建，中间面板。消息气泡 + @提及自动补全（输入 @ 弹出 Agent 下拉，键盘导航 Enter/Tab 选中，按名过滤）+ 流式 typing 指示器 |
| `packages/web/src/components/AgentPanel.vue` | 新建，右侧面板。Agent 状态卡片（空闲/回复中）+ 点击编辑弹窗 + 快速新建 Agent + 调度队列显示 |
| `packages/web/src/components/AgentEditModal.vue` | 新建，Agent 编辑弹窗。修改名字/头像/供应商/模型/API Key/system prompt |
| `packages/web/src/components/SessionCreateModal.vue` | 新建，新建会话弹窗。多选 Agent 参与 |
| `packages/web/src/stores/chat.ts` | 新建，Pinia 状态管理。fetchData / joinSession / sendMessage / createSession / updateAgent / deleteAgent + Socket.IO 事件绑定 |
| `packages/web/src/composables/useSocket.ts` | 新建，Socket.IO 单例 |
| `packages/web/src/composables/useApi.ts` | 新建，REST API 封装（agents / sessions 的 CRUD） |
| `packages/web/src/composables/useMention.ts` | 新建，@提及自动补全逻辑。光标位置检测、Agent 过滤、键盘导航、文本替换 |
| `pnpm-workspace.yaml` | 新建，pnpm workspace 配置，含 native build 白名单 |

## 2. Why — 为什么这样做

### 核心架构：单体后端 + 适配器解耦

后端统一调度所有 Agent 的 LLM 推理。前端只做展示，API key 不暴露到浏览器。QQ Bot 等外部渠道通过 Redis Pub/Sub 适配器接入，不碰核心调度逻辑。

```
用户输入(@店长) → Socket.IO → Fastify → dispatch() 检查槽位
                                        → idle → getAdapterForAgent()
                                        → DeepSeek SSE 流式
                                        → Chunk 推送前端 typing
                                        → 完成 → completeExecution()
                                        → 检查 FIFO 队列 → 下一只猫
```

### 上下文过滤而非 Prompt 限制

每个 Agent 只看到和自己相关的消息——被 @ 的消息、广播消息、自己的历史回复。其他 Agent 的对话完全不可见。这比在 system prompt 里写"不要替别人说话"更可靠：LLM 根本不知道别人的对话存在。

```
过滤规则:
  ✅ 用户 @ 了本 Agent → 可见
  ✅ 用户广播（无 @）→ 可见
  ✅ 本 Agent 自己的历史回复 → 可见
  ❌ 用户 @ 别人 → 丢弃
  ❌ 其他 Agent 的回复 → 丢弃
```

### Anthropic Messages API 格式

DeepSeek 的 `/anthropic/v1/messages` 端点要求 system prompt 在顶层 `system` 字段，messages 数组只能含 `user`/`assistant` 角色。`role: "system"` 放在 messages 里会报 `missing field 'content'`。

### 字段对齐：DB snake_case ↔ 前端 camelCase

SQLite 列名是 `snake_case`（`llm_api_key`、`created_at`），前端 TypeScript 类型用 `camelCase`。后端在 API 响应和 Socket.IO 历史推送时统一转换，前端永远接触不到 snake_case。

### 单槽位 FIFO 串行

每个 Agent 只有一个槽位。@ 多人时按顺序依次执行——前面的回复成为后面的上下文。这比并行执行更像真人聊天（后面说话的人听到了前面的内容），且 token 消耗只限于被 @ 的 Agent，不会每条消息都过所有 LLM。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| Agent 自主决定是否插话（每条消息都过 LLM） | Token 消耗随 Agent 数量线性增长。改为调度驱动：@ 才唤醒，不 @ 不推理 |
| 纯 WebSocket 广播 | 无法跨进程——QQ Bot 适配器和 Web Server 是不同进程，必须有 Redis Pub/Sub 做中间件 |
| Next.js 全栈方案 | 前端已定 Vue 3，Next.js 绑死 React。改为 Fastify 后端 + Vue 3 前端独立 |
| NestJS | 学习曲线陡，better-sqlite3 无官方驱动需自包装。Fastify 更轻量，Clowder AI 也在用 |
| 全量对话历史注入 LLM | Context 膨胀导致延迟和成本线性增长。改为向量检索记忆（sqlite-vec），接口已预留 |
| 前端状态用 props 层层传递 | 三面板布局跨组件状态多，直接上 Pinia |
| System prompt 做角色隔离 | LLM 不总是遵守 prompt 指令。改用代码层过滤上下文，Agent 看不到其他角色的对话，从根本上杜绝"一人分饰多角" |
| 并行执行多 Agent | 响应快但 Agent 互相不感知前后文，缺乏聊天承接感。FIFO 串行更拟人 |
| 文件存储 JSON | 多 Session 并发写入冲突，数据多了查询慢。SQLite 单文件零运维，WAL 模式防崩溃丢数据 |
| 使用 `createServer(app.server)` 包装 | Fastify 5 的 `app.server` 已是 HTTP Server 实例，再包装导致请求无法路由。直接用 `app.listen()` + `app.server` |

## 4. Open Questions — 不确定的点

- **DeepSeek 角色沉浸度**：v4-pro 模型有较强的"助手本性"，即使 system prompt 写"你不是 AI"，偶尔也会暴露。当前通过强角色 prompt + 上下文过滤双重约束，效果待更多测试
- **Redis 降级运行的完整性**：~~当前 Redis 不可用时静默降级，Agent 间 Pub/Sub 通信完全走内存。单机使用无影响，但 QQ Bot 适配器需要 Redis 才能工作~~ **已解决**：2026-06-27 通过 `winget install Redis.Redis` 安装 Redis 3.0.504，服务端日志确认 `[redis] connected to redis://localhost:6379`
- **sqlite-vec 编译**：当前项目未安装 sqlite-vec 扩展（记忆检索模块预留了接口），编译该扩展需要额外的 C 工具链
- **Anthropic API 端点的稳定性**：DeepSeek 的 `/anthropic/v1/messages` 端点非官方文档标注，未来可能变更格式或下线
- **Session 重建后 ID 变更**：seed 脚本每次运行生成新的 Agent/Session UUID，前端需要刷新才能重新加载。后续可改为 upsert 模式
- **流式 SSE 的中文编码**：和之前 `cat-cafe-summary.md` 中记录的 curl 方案中文乱码不同，MCP/HTTP 方案走 JSON 序列化，暂未遇到编码问题

## 5. Next Action — 希望做什么

- 测试多 Agent 同时 @ 场景（`@店长 @服务员 @吐槽猫 今天天气怎么样`），验证 FIFO 串行和上下文接力
- ✅ ~~安装 Redis 并验证 Pub/Sub 消息总线~~（2026-06-27 完成：winget 安装 Redis 3.0.504，服务端已连接）
- 安装 sqlite-vec 扩展，实现 embedding 记忆检索模块
- 为 Claude 和 OpenAI 供应商编写 LLM 适配器
- 编写 QQ Bot 适配器（通过 Redis Pub/Sub 桥接）
- 将 seed 改为 upsert 模式（按 name 去重），避免每次运行创建重复数据
- ✅ ~~前端增加 Session 删除~~（2026-06-27 完成：Session 列表增加删除按钮，含确认对话框和外键约束修复）
- 加入消息持久化备份（VACUUM INTO 定时导出）

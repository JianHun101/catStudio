# CatStudy 开发体验打磨与记忆系统修复

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/events.ts` | 新增 `SESSION_DELETED: 'session-deleted'` 事件常量 |
| `packages/server/src/db/index.ts` | 未修改（仅读取验证 agents 表 `name UNIQUE` 约束） |
| `packages/server/src/memory/embedding.ts` | HF 镜像逻辑改为可选：仅在显式设置了 `HF_ENDPOINT` 且非 huggingface.co 时才切换 `env.remoteHost`，否则用默认直连 |
| `packages/server/src/memory/index.ts` | `saveMessageMemory()` 新增去重检测（余弦距离 < 阈值跳过存储）；去重默认阈值从 0.15 调整为 0.20；新增 `MEMORY_DEDUP_ENABLED` / `MEMORY_DEDUP_THRESHOLD` 环境变量并更新文档注释 |
| `packages/server/src/connectors/socketio.ts` | 新增模块级 `_io` 引用和 `getIO()` 导出函数，`createSocketIO()` 时存储实例 |
| `packages/server/src/routes/sessions.ts` | DELETE 成功后通过 `getIO().emit(SESSION_DELETED)` 广播删除事件给所有客户端 |
| `packages/server/src/seed.ts` | 重构：从"删光重建"改为 upsert 模式。`uuid.v5()` 生成确定性 Agent ID，`INSERT ... ON CONFLICT(name) DO UPDATE` 按名去重；Session 同样 `ON CONFLICT(id) DO UPDATE`；新增 `--reset` 参数保留旧行为 |
| `packages/server/src/index.ts` | 移除强制 `HF_ENDPOINT=https://hf-mirror.com` 默认值，改为注释说明 |
| `packages/web/src/stores/chat.ts` | 新增 `SESSION_DELETED` 事件监听：删除会话时自动从本地列表移除，若为当前活跃会话则切换到下一个 |
| `packages/web/src/components/AgentEditModal.vue` | 新增 Agent 删除按钮（两步确认：点击→红色"确认删除？"，再次点击执行）；`watch` 切换 Agent 时重置确认状态；footer 改为 justify-between 布局 |

## 2. Why — 为什么这样做

### Seed upsert：从"删光重建"到"幂等写入"

```
旧行为:
  seed.ts → DELETE FROM agents → INSERT 3 只猫 → 每次生成新 UUID
  → Session 引用过期 ID → 手动查 DB 替换 → 体验极差

新行为:
  seed.ts → ON CONFLICT(name) DO UPDATE → Agent ID 固定（uuid.v5）
  → Session 引用始终有效 → 多次运行 = 幂等刷新配置
  → --reset 参数保留全量重建能力
```

核心推理：`agents.name` 已有 `UNIQUE` 约束，且 seed 数据的三只猫名字固定——这是天然的 upsert key。用 `uuid.v5(name, namespace)` 生成确定性 ID，确保多次运行、多台机器上 Agent ID 一致（namespace 相同的前提下）。Session 也基于固定 ID upsert，不再每次创建重复会话。

`--reset` 放在命令行参数而非环境变量：重置是操作行为，不是配置行为。`process.argv.includes('--reset')` 比 `RESET_SEED=true` 更符合直觉。

### 记忆去重：存储前检测而非存储后合并

```
用户发消息 "我超级喜欢吃日料，特别是生鱼片"
  → embedText() → 512 维向量
  → vec_distance_cosine(query_blob, 已有记忆) → 找最近邻
  → 距离 0.12 < 阈值 0.20 → 跳过存储（"这个我已经知道了"）
  → 距离 0.35 > 阈值 0.20 → INSERT 新记忆
```

选择"存储前检测"而非"存储后合并"的理由：
- **存储前检测**：简单，一条 SELECT + 条件判断，失败不影响已有数据
- **存储后合并**（更新旧记忆内容/合并两条为一条）：需要处理"合并后的 embedding 怎么算"——重新嵌入？加权平均？引入更多复杂度
- 去重目的是**减少冗余存储**，不是**精确保留所有信息**。跳过足够相似的消息是合理的近似

阈值从 0.15 调到 0.20 的依据：全链路测试中，语义相关但不同的消息距离约 0.42-0.44，同主题近义改写约在 0.12-0.18。0.20 是合理的中间值——足够近才跳过（避免丢信息），又不至于太松。

### Agent 删除确认：两步点击而非原生 confirm()

SessionList 的删除用的是 `confirm()` 弹窗——简单但割裂（浏览器原生 UI 突兀地插入自定义主题）。

AgentEditModal 采用了内联两步确认：第一次点击显示红色"确认删除？"，第二次才执行。两步都在弹窗内部完成，不打破视觉连续性。`deleteConfirm` 状态在切换/关闭弹窗时自动重置，避免残留。

### HuggingFace 模型下载：不强制镜像

```
旧: HF_ENDPOINT = 'https://hf-mirror.com'  (强制)
  → hf-mirror.com 308 redirect → huggingface.co
  → 多一次跳转 → transformers 内部 fetch 可能失败

新: HF_ENDPOINT 未设置 → 直连 huggingface.co  (默认)
  设置 HF_ENDPOINT=https://hf-mirror.com → 走镜像
```

之前的问题是镜像本身不可靠（返回 308 重定向而非直接托管文件），但 `@huggingface/transformers` 的 `env.remoteHost` 设置会改写所有模型文件请求的 host。一旦镜像不稳定，模型下载就失败。当前网络环境直连 HuggingFace 可达（`curl huggingface.co` 返回 200），不需要镜像。保留 `HF_ENDPOINT` 作为逃生舱——用户在自己的网络环境需要镜像时，设环境变量即可。

### 多 tab session-deleted 同步：全局广播而非房间内广播

session 删除的接收方可能是任何 tab——不限于当前在 session 房间内的连接。所以用 `io.emit()` 全局广播而非 `io.to(session:${id}).emit()` 房间内广播。

```
DELETE /api/sessions/:id
  → 删 DB 行（外键顺序: execution_logs → messages → sessions）
  → io.emit('session-deleted', { sessionId })
  → 所有客户端收到 → 过滤本地 sessions 列表
```

`getIO()` 函数解决了一个架构问题：session 删除走 REST API（Fastify route），但 Socket.IO 实例在 Fastify 启动后才创建。模块级 `_io` 引用 + getter 函数避免了循环依赖，也避免了把 io 实例塞进 Fastify decorator 的侵入式改动。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| Seed upsert 用 `INSERT OR REPLACE`（无 ON CONFLICT 子句） | `REPLACE` = DELETE + INSERT，会触发外键级联删除、重置 `created_at`。`ON CONFLICT(name) DO UPDATE` 只更新指定列，保留 `created_at` |
| Seed 用环境变量 `RESET_SEED` 替代 `--reset` | 环境变量是配置，重置是操作。命令行参数更显式，且 `process.argv.includes` 零依赖 |
| 记忆去重用"存储后合并"方案 | 合并后的 embedding 需要重新计算（加权平均？重新嵌入？），复杂度远超收益。跳过足够相似的记忆已经达到减冗余目的 |
| 记忆去重阈值保持 0.15 | 测试中同主题近义改写距离约 0.12-0.18，0.15 的边界体验不佳（该跳过的没跳过）。0.20 是经验调优值 |
| Agent 删除确认沿用 SessionList 的 `confirm()` | 浏览器原生弹窗在暖色自定义主题中视觉割裂。内联两步确认保持 UI 一致性 |
| session-deleted 用房间广播 `io.to()` | 删除时客户端可能不在任何房间内（未 join session），房间广播覆盖不全。全局 `io.emit()` 确保所有 tab 收到 |
| io 实例通过 Fastify decorator 传递 | 侵入 Fastify 类型定义，且 decorator 在 `app.listen()` 前无法设置。`_io` 模块级变量更轻量 |
| 强制使用 `hf-mirror.com` 镜像 | 当前网络环境直连 HuggingFace 可达，镜像反而多一次 308 跳转。改为可选，直连为默认 |

## 4. Open Questions — 不确定的点

- **去重阈值 0.20 的通用性**：基于 bge-small-zh-v1.5 的三条测试消息调试得出。不同嵌入模型（如 bge-large-zh 1024 维）的余弦距离分布可能不同，0.20 不一定适用。当前通过环境变量可调，但默认值可能需要更多实际对话数据验证
- **seed upsert 的 avatar 覆盖行为**：`ON CONFLICT DO UPDATE` 会覆盖 avatar——如果用户手动改了猫咪头像，再次运行 seed 会重置。不确定应该"始终覆盖"还是"不覆盖已有 Agent 的 avatar/system_prompt"（当前选择覆盖，因为 seed 的 system prompt 更新也应该同步到已有 Agent）
- **`session-deleted` 事件的竞态**：如果用户在 tab A 删除 session 的同时 tab B 正在该 session 中发送消息，`SEND_MESSAGE` handler 可能访问已删除的 session（DB 返回 null）。当前 handler 有 `if (!sessionRow)` 保护，但体验上 tab B 会在发送后收到"Session not found"错误——时序上可以接受但不够优雅
- **`getIO()` 返回 null 的时机**：sessions route 的 DELETE handler 在 `getIO()` 返回 null 时静默跳过广播。正常流程中 `createSocketIO()` 在 `app.listen()` 后立即调用，所以 DELETE 请求到达时 io 已存在。但在极端的启动早期（listen 完成但 io 未创建的那几毫秒）理论上可能为 null——概率极低，后果极微（少一次广播，数据已正确删除）

## 5. Next Action — 希望做什么

- ✅ ~~Seed upsert 模式~~（完成：确定性 UUID + ON CONFLICT DO UPDATE + --reset 参数）
- ✅ ~~记忆去重检测~~（完成：存储前余弦距离检测，阈值 0.20）
- ✅ ~~Agent 删除确认弹窗~~（完成：两步点击确认，内联 UI）
- ✅ ~~多 tab session-deleted 同步~~（完成：共享事件 + getIO + 前端监听）
- ✅ ~~HuggingFace 模型下载修复~~（完成：不强制镜像，直连 HF 可达，模型已缓存）
- 为 Session 增加"清空消息"功能（保留 Session 和 Agent 配置，仅清空 `messages` 和 `execution_logs`）
- 在 AgentEditModal 中根据 provider 显示动态提示（claude → "需安装 Claude Code CLI"，openai → "需安装 Codex CLI + codex-proxy"）
- 广播模式下自动减少历史消息条数（100 → 50），缓解上下文膨胀
- 测试多 Agent 同时 @ 场景（`@店长 @服务员 @吐槽猫 一句话评价咖啡`），验证 FIFO 串行的上下文接力质量
- ~~安装 Redis 并验证 Pub/Sub~~（2026-06-27 完成）

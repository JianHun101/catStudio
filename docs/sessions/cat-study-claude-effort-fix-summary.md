# Claude Code 启动修复 + 推理深度前端可控

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | `AgentConfig` 新增 `effortLevel?: 'low' \| 'medium' \| 'high' \| 'max'` 字段 |
| `packages/shared/src/schemas.ts` | `AgentConfigSchema` 新增 `effortLevel` 可选枚举校验 |
| `packages/server/src/db/index.ts` | 新增 migration `ALTER TABLE agents ADD COLUMN effort_level TEXT` |
| `packages/server/src/test-helpers.ts` | 测试 schema 的 agents 表新增 `effort_level TEXT` |
| `packages/server/src/llm/cli-supervisor.mjs` | 修复：移除 TypeScript 类型注解 `: boolean`，Node.js ESM 无法解析导致 supervisor 崩溃 |
| `packages/server/src/llm/cli-utils.ts` | `parseClaudeCodeOutput` 新增产出 `type: "thinking"` 块（前缀 `[思考]`），让前端在推理阶段看到流式进度 |
| `packages/server/src/llm/claude.ts` | `CLAUDE_CODE_EFFORT_LEVEL` 从硬编码 `'max'` 改为三级优先级：Agent 配置 > 环境变量 > 默认 `'high'`；构造函数存储 `effortLevel` 私有字段 |
| `packages/server/src/llm/registry.ts` | `ClaudeAdapter` 构造传入 `effortLevel`，缓存 key 对 claude provider 加入 effortLevel 维度 |
| `packages/server/src/routes/agents.ts` | `toAgentConfig`、PATCH 字段映射、POST INSERT 支持 `effortLevel` |
| `packages/server/src/connectors/socketio.ts` | `rowToAgent` 支持 `effortLevel` 映射 |
| `packages/server/src/seed.ts` | upsert SQL 新增 `effort_level` 列 |
| `packages/server/src/seed-data.ts` | `DemoAgent` 接口新增 `effortLevel?: string` |
| `packages/server/src/index.ts` | 自动种子 upsert SQL 新增 `effort_level` 列 |
| `packages/web/src/stores/chat.ts` | `NEW_MESSAGE` 处理器新增去重逻辑（`messages.value.some(m => m.id === msg.id)`），防止 Socket 重连时历史消息重复 |
| `packages/web/src/AgentEditModal.vue` | 新增推理深度下拉框（仅在 `llmProvider === 'claude'` 时可见），四个选项 low/medium/high/max 带中文标签 |
| `packages/web/src/composables/useApi.ts` | `createAgent`/`updateAgent` 类型新增 `effortLevel?: string` |
| `.env.example` | 新增 `CLAUDE_CODE_EFFORT_LEVEL` 配置说明 |
| `packages/server/src/memory/index.ts` | Agent（店长）自动修复：记忆存储/检索时剥离 @mention，保持向量语义空间一致 |
| `packages/server/src/memory/index.test.ts` | Agent（店长）自动新增：4 个 @mention 剥离相关测试 |

## 2. Why — 为什么这样做

### Supervisor 语法错误是 Claude Code "无法启动"的根因

`cli-supervisor.mjs` 是 Node.js 直接执行的 ESM 文件，`function isParentAlive(): boolean` 中的 TypeScript 类型注解在 Node.js 运行时是非法的。supervisor 在 spawn 瞬间崩溃，导致 Claude Code CLI 从未被启动。修复后端到端验证通过：supervisor → claude CLI → DeepSeek API → 回复 "Hello"。

### 思考阶段零流式输出导致"Agent 卡住了"的错觉

```
修复前：
Claude Code (effort=max)          前端
  │                                │
  │ thinking... 60s ──────────── │ 状态："思考中"，零字节内容
  │ thinking... 80s ──────────── │ 用户以为卡住了
  │ text "我来分析..." ──────── │ 突然出现大量文字
  │
修复后：
Claude Code (effort=high)         前端
  │                                │
  │ thinking "先读代码" ──────── │ [思考] 先读代码
  │ thinking "检查依赖" ──────── │ [思考] 检查依赖
  │ text "修改完成" ──────────── │ 修改完成
```

`parseClaudeCodeOutput` 原先只产出 `type: "text"` 块，跳过 `type: "thinking"` 块。Claude Code 在 `effort=max` 下推理阶段可达 60-100+ 秒，期间前端收不到任何流式内容。修复后产出 thinking 块并前缀 `[思考]`，用户可实时看到推理进度。

### 消息重复的根因是重连时 JOIN_SESSION 无去重

```
客户端                                服务器
  │ 已连接，消息列表: [msg1, msg2]       │
  │ ⚡ 断连                               │
  │ ⚡ 重连                               │
  │ connect → JOIN_SESSION ──────────→ │ 发送全部历史 [msg1, msg2]
  │ push(msg1) ← 重复！               │
  │ push(msg2) ← 重复！               │
```

修复：`NEW_MESSAGE` 处理器加 `if (messages.value.some(m => m.id === msg.id)) return`，无论什么场景导致重复下发都能正确去重。

### 推理深度从环境变量提升为 Agent 可配置项

```
数据流：
AgentEditModal.vue (下拉框)
  → useApi.ts (PATCH /api/agents/:id)
  → agents.ts (body.effortLevel → effort_level 列)
  → SQLite (effort_level TEXT)
  → socketio.ts rowToAgent() (effort_level → effortLevel)
  → registry.ts (new ClaudeAdapter({ effortLevel }))
  → claude.ts buildEnv() (this.effortLevel || process.env.CLAUDE_CODE_EFFORT_LEVEL || 'high')
```

优先级链：Agent 显式配置 > 环境变量（全局默认）> 硬编码 `'high'`。不同 Agent 可以有不同的推理深度——reviewer Agent 可以用 `max` 深度检查代码，闲聊 Agent 用 `low` 快速响应。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 用 `didInitialJoin` 标志位区分首次连接和重连，阻止重发 JOIN_SESSION | 存在竞态条件：`joinSession` 可能在 socket 连接之前被调用，标志位无法覆盖所有时序。消息 ID 去重更稳健且覆盖所有重复场景 |
| `effort_level` 列设 `NOT NULL DEFAULT 'high'` | 测试中 Agent 创建不传 effortLevel 时 Zod 解析为 `undefined`，路由传 `null` 触发 NOT NULL 约束失败。改为可空，默认值在适配器层应用，保持 "Agent 未配置 → 走全局默认" 的语义清晰 |
| 在快速新建表单也暴露推理深度 | 快速新建表单保持简洁（名字 + API Key + system prompt），推理深度是高级调优参数，仅在完整编辑弹窗中暴露，与 Base URL 仅在 custom provider 显示的渐进式复杂度模式一致 |
| 将 effortLevel 放在 `ChatOptions`（每请求参数）而非 `AgentConfig`（持久化） | 推理深度是 Agent 级别的偏好，不是每次发消息都要改的参数。走持久化链路（AgentConfig → DB → 适配器构造函数）比每请求传参更合理 |

## 4. Open Questions — 不确定的点

- **thinking 块的前端展示**：当前 thinking 内容与正式回复混在同一个气泡里，前缀 `[思考]` 做区分。理想情况是 thinking 内容折叠显示或单独样式，但需要前端改动较大。当前方案能解决"看起来卡住了"的核心问题，UI 优化可后续迭代。
- **effortLevel 对其他适配器的适用性**：当前只有 Claude adapter 读取 `effortLevel`。DeepSeek 和 OpenAI 适配器的 effort 概念不同（或不存在），如果未来需要支持，`AgentConfig.effortLevel` 的语义可能需要扩展或每个适配器独立字段。
- **Agent 自动修改代码的行为边界**：店长在回复"测试一下"时自动修改了 `memory/index.ts` 并新增测试。这符合 system prompt 中的开发者角色设定，但用户可能没有预期简单的测试消息会触发代码修改。未来可能需要在前端区分"对话模式"和"开发模式"。
- **`CLAUDE_CODE_EFFORT_LEVEL` 环境变量的兜底角色**：当前 `buildEnv()` 的优先级是 `Agent 配置 > 环境变量 > 'high'`。如果用户改环境变量期望影响所有 Agent，但某个 Agent 已配置了 effortLevel，环境变量对该 Agent 不生效——这符合预期但可能需要文档说明。

## 5. Next Action — 希望做什么

- ✅ ~~修复 cli-supervisor.mjs TypeScript 语法错误~~
- ✅ ~~修复 Socket.IO 重连消息重复~~
- ✅ ~~修复思考阶段无流式输出~~
- ✅ ~~前端新增推理深度下拉框~~
- 重启服务器使所有修复生效（`pnpm stop && pnpm dev`）
- 在编辑弹窗中将 Agent 的 effortLevel 设为 `low` → 发送消息验证回复速度是否明显变快
- 清理 `cat-study.db` 中旧的 `status='running'` 执行日志（重启时 StartupReconciler 会自动标记为 failed）
- 评估是否在消息气泡中对 `[思考]` 内容做折叠/淡化样式处理
- 考虑在 ChatPanel 中区分"对话"和"开发任务"两种消息模式，避免简单测试消息触发代码修改

# Agent 长生命周期 + 交接文档 + Review 流程实现

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | Message 接口新增 `taskId?: string`；DispatchCommand 新增 `taskId?: string` |
| `packages/shared/src/schemas.ts` | MessageSendSchema 新增可选字段 `taskId` |
| `packages/server/src/db/index.ts` | messages 表 schema 新增 `task_id TEXT` 列；migration 中新增 `task_id on messages` 条目 |
| `packages/server/src/test-helpers.ts` | 测试 schema 的 messages 表同步新增 `task_id TEXT` |
| `packages/server/src/llm/claude.ts` | 修复 3 个静默失败路径：收集 stderr 用于错误报告、检查 `hasOutput` 在进程退出时产出错误 chunk、覆盖 `exitCode` 为 null（ENOENT）场景、移除未使用的 `attachExitError` 导入 |
| `packages/server/src/connectors/socketio.ts` | 核心改动：① `runAgentReply()` 返回 `{ content, msgId }` ② 上下文构建时根据 `taskId` 额外拉取完整任务历史（跨 LIMIT 100 限制）③ `executeAgentsSerial()` 支持 Agent 间 @mention 调度：检测回复中的 @mention → 递归 dispatch → 深度限制（MAX=10）+ 单 Agent 被 @ 次数限制（MAX=3）+ mentionCounts 清理 ④ `SEND_MESSAGE` handler 类型标注新增 `taskId` ⑤ 历史消息推送时透传 `taskId` ⑥ `parseMentionsFromReply()` 工具函数 |
| `packages/server/src/seed-data.ts` | 新增 `HANDOFF_FORMAT` 常量（五段式交接文档模板），注入三只种子猫咪的 system prompt；吐槽猫追加 reviewer 角色和 review 风格指令 |
| `.claude/skills/session-summary/SKILL.md` | 新增规则 6：输出路径 `docs/sessions/`；更新 Context 引用和 Post-generation 提示 |
| `docs/sessions/cat-study-*-summary.md` (x8) | 从根目录移入 `docs/sessions/` |
| `CLAUDE.md` | **新建**。项目入口文档：命令、monorepo 结构、架构概览、关键约定、测试模式、Windows 注意事项 |
| `docs/sessions/cat-study-docs-claude-fix-summary.md` | 文档体系重构 + CLAUDE.md 创建 + Claude CLI 修复的会话总结 |
| `docs/sessions/cat-study-agent-review-handoff-summary.md` | 本次总结 |

## 2. Why — 为什么这样做

### 核心架构：taskId 串联多轮 Agent 交互

CatStudy 原本的 Agent 是完全被动的：用户 @ 它才回复，回复完就失忆。要实现"写代码 → 找同事 review → 改 → 再 review"的工作流，需要三个能力：

1. **跨轮次记忆** — Agent 第二次被 @ 时还记得第一次在做什么
2. **Agent 间调度** — Agent A 能主动 @ Agent B，系统自动触发 B 执行
3. **交接标准** — 两个 Agent 之间有共同的语言描述"我在做什么、需要你看什么"

```
用户: "@店长 写登录页面"
  │  taskId = "task-001"
  ▼
店长写代码 → 回复末尾: "@吐槽猫 review"
  │              │
  │  taskId 继承  │ parseMentionsFromReply() 检测到 @吐槽猫
  ▼              ▼
(detect @)──→ dispatch(吐槽猫) → executeAgentsSerial(depth+1)
                │
                ▼
              吐槽猫 context 包含:
              ├─ 最近 100 条消息
              ├─ taskId="task-001" 的完整历史 (跨 LIMIT)
              └─ system prompt 注入的 reviewer 角色 + 交接文档格式
```

### taskId 的设计：最小的语义单元

`taskId` 不是 `traceId`。一个 `traceId` 对应一次用户消息触发的整条调度链；一个 `taskId` 对应一个用户意图的完整生命周期——可能跨多次用户消息、跨多个 Agent 的交互。

```
traceId: 每次 SEND_MESSAGE 事件生成一个（UUID）
taskId:  用户意图的标识，跨多轮 Agent 交互保持不变
  ├─ 由前端在首次 SEND_MESSAGE 时传入
  ├─ Agent 间调度时继承（agentTrigger.taskId = triggerMsg.taskId || traceId）
  └─ 如果没有传入（旧客户端兼容），退化为 traceId
```

选择 `taskId` 而非自动生成的理由：用户可能有多个并发任务在同一 session 中（"写登录页"和"重构数据库"同时进行），各自需要独立的上下文隔离。`traceId` 的粒度太细（每次发消息都变），`sessionId` 的粒度太粗（所有任务混在一起）。

### 为什么是递归调度而非事件循环

Agent 间调度的两种实现方式：

```
方案 A: 递归（选中）
  executeAgentsSerial(agents, depth=0)
    → runAgentReply(AgentA)
    → 检测 @AgentB → dispatch(AgentB)
    → executeAgentsSerial([AgentB], depth=1)
      → runAgentReply(AgentB)
      → 检测 @AgentA → dispatch(AgentA)
      → executeAgentsSerial([AgentA], depth=2)
        → ...直到深度耗尽或自然终止

方案 B: 事件循环
  executeAgentsSerial → 完成 → 发事件
  event listener → 检测 @mention → 重新触发 executeAgentsSerial
```

选中递归的理由：
- **调用栈即终止条件**：depth 参数天然限制深度，不需要额外状态机
- **await 即同步语义**：reviewer 的回复在 coder 继续之前完成，保证对话顺序
- **共享 taskId 和 traceId**：递归调用直接继承局部变量，不需要跨事件传递

代价是深度限制内 agent 间调度是串行的——如果 @ 了 3 个 reviewer，他们会依次而非并行 review。但这个限制是故意的：后 review 的人应该看到前一个 reviewer 的意见。

### 交接文档格式：为什么嵌入 system prompt 而非独立模块

交接文档的格式规范（What/Why/Tradeoff/Open Questions/Checklist）有两种落地方式：

1. **独立模块**：在 dispatch 层检测到 Agent 间 @mention 时，自动生成或附加交接文档
2. **System prompt 指令**（选中）：在 Agent 的 system prompt 中写清楚"当你需要 review 时，请按此格式输出"

选 system prompt 的理由：
- Agent 最了解自己做了什么——AI 生成的交接文档比机械拼接准确
- 不同 Agent 可以有不同的交接风格（店长温和、吐槽猫犀利）
- 不引入新的代码模块，不变更 dispatch 引擎逻辑
- 格式演进只需改 seed data 或 Agent 配置，不需要部署代码

### Claude CLI 适配器修复：静默失败的本质

CLI adapter 的复杂度不在流式解析，而在进程状态机的错误处理。spawn 子进程有三个独立的失败通道（error 事件、非零 exit code、stderr），原代码只监听不产出——generator 的 `yield` 是唯一能把错误信息传递给用户的路由，任何不经过 `yield` 的错误都是静默的。

```
修复前的错误路由:
  error 事件  →  log.error() → 消失在日志
  close 事件  →  log.error() → 消失在日志
  stderr 流   →  丢弃

修复后:
  三个通道统一汇入 generator:
    hasOutput=false + exitCode≠0 → yield error chunk
    hasOutput=false + exitCode=null → yield "无法启动"
    stderr → 拼接到 error chunk 中
```

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 用 `traceId` 代替 `taskId`（不新增字段） | `traceId` 每次 SEND_MESSAGE 都重建，无法跨多轮用户消息共享上下文。用户可能说"改一下"让 Agent 修改上次的代码——此时是新的 traceId 但应该共享 taskId |
| Agent 间调度用事件循环而非递归 | 事件循环需要额外的状态机管理"谁在等谁"，且无法利用调用栈自然限制深度。递归的 `depth` 参数和 `await` 语义更简单直接 |
| 交接文档格式做独立模块（dispatch 层自动生成） | dispatch 层不知道 Agent 具体做了什么，生成的文档必然是模板化的，不如让 Agent 自己写。且新增模块增加维护成本 |
| 在 dispatch 层做 mention 检测（修改 `dispatch/index.ts`） | dispatch 的职责是槽位管理，不应关心"消息内容是否包含 @mention"。检测放在 connector 层（socketio.ts）更符合单一职责 |
| Agent 回复的 `mentions` 字段用正则提取而非内容匹配 | 正则需要处理中文名、emoji 名、标点边界，复杂度高。用 `content.includes('@name')` 遍历 session 内 Agent 名更可靠且足够 |
| 限制 task 历史加载数量与当前消息数相同（100） | task 历史可能分散在更早的消息中，200 条能覆盖更多跨轮次场景，且 SQLite 查询几乎无额外成本 |
| `.claude/memory/` 知识库立即建立 | 需要从 8 个 session summary + 6 个 ADR 中提炼知识点，工作量大且需要人工判断哪些值得纳入。先完成核心功能实现，memory 作为下步 |

## 4. Open Questions — 不确定的点

- **`mentionCounts` 的 Map 清理策略是否足够**：当前在 `depth === 0` 时按 `traceId` 前缀清理。但 `executeAgentsSerial` 在 SEND_MESSAGE handler 中是不 await 的（允许用户连续发消息时交错执行）。如果同一 traceId 的两个分支并发运行（理论上不会——同一消息只触发一次 dispatch），清理可能提前删除对方还在用的计数。目前的设计保证了一个 traceId 只有一个调用树，所以安全。但如果未来改了并发模型，这里需要重访。

- **taskId 的前端生成策略**：当前 taskId 由前端可选传入（`MessageSendSchema.taskId`）。前端如何决定"这是一个新任务还是旧任务"？一个实用约定：前端检测用户消息中是否 @ 了同一个 Agent 且消息较短（如"改一下"）——如果是，沿用上一次的 taskId 而非生成新的。但这个逻辑在前端，如果前端不传 taskId，后端的 task 历史加载就失效。需要在前端 UI 中体现"当前任务"的概念。

- **`parseMentionsFromReply` 的误匹配风险**：`String.includes('@店长')` 会把否定句（"不用@店长"）也匹配进去。目前 LLM 生成的文本中这种模式极少出现，但未来如果 Agent 变得更"聪明"且开始讨论"要不要 @ 谁"，就会出现假阳性。可考虑让 Agent 用结构化标记（如 `<mention>店长</mention>`）代替自由文本 @。

- **HANDOFF_FORMAT 的长度对 token 消耗的影响**：每个 Agent 的 system prompt 多了 ~500 字符。在当前 3 个 Agent 的场景下影响不大，但如果 session 中 Agent 数量增长（10+），每个 Agent 的 system prompt 都在吃上下文窗口。可考虑按 Agent 角色选择性注入（仅 coder/reviewer 角色需要）。

- **Agent 间调度的测试覆盖**：新增的递归调度逻辑（~30 行）没有自动化测试。现有测试 mock 了 LLM 适配器，无法触发真实的 `runAgentReply` → `parseMentionsFromReply` → 递归 dispatch 链路。需要一个集成测试：让 Agent 回复中包含 `@otherAgent`，验证 `executeAgentsSerial` 的递归行为。

## 5. Next Action — 希望做什么

- ✅ ~~session-summary skill 输出路径改为 `docs/sessions/`~~
- ✅ ~~8 个 summary 文件从根目录移入 `docs/sessions/`~~
- ✅ ~~创建 `CLAUDE.md`~~
- ✅ ~~修复 Claude CLI 适配器的静默失败~~
- ✅ ~~`taskId` 字段：shared types → DB schema → 查询透传~~
- ✅ ~~task 历史上下文加载（`runAgentReply` 中拉取同 taskId 消息）~~
- ✅ ~~Agent 间 @mention 调度（`executeAgentsSerial` 递归 + 深度/次数限制）~~
- ✅ ~~交接文档格式注入 Agent system prompt（`seed-data.ts`）~~
- ✅ ~~代码审查：修复 4 个 bug（agentTrigger.id 合成、mentionCounts 泄漏、task 历史无 LIMIT、类型标注缺失）~~
- 前端：实现 taskId 生成策略（检测"改一下"等简短跟进消息 → 沿用上次 taskId）
- 前端：Agent 面板增加"当前任务"状态显示（从 active taskId 推断）
- 集成测试：Agent 间调度的端到端验证（mock LLM 返回含 @mention 的回复 → 验证递归 dispatch）
- 从 ADR 和 session summary 提炼关键知识点，创建 `.claude/memory/` 知识库
- 评估是否需要文档向量索引：用项目已有的 embedding → sqlite-vec 管线索引 `docs/` 目录

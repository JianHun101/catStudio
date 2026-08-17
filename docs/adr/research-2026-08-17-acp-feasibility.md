# 调研笔记：ACP（Agent Client Protocol）直接上可行性调研

> 调研日期：2026-08-17
> 执行猫：flash猫
> 触发消息：025aa4c9-e03a-4bf8-973d-41a00df6d305（店长派活单：ACP 可行性调研，用户拍板方向「直接上 ACP」）
> 性质：调研笔记（非 ADR 定稿）。店长收口后据此汇总正式 ADR 立项单，过 ADR 0007 四步检查单。
> 边界遵守：未改生产代码（opencode.ts / registry.ts / dispatch 零触碰）；实测全部在 `%TEMP%` 完成；未装第三方包。
> 对标 ADR 0007：能力对账前置 / 假设标红 + 实测对称 / 简单形态默认复杂举证倒置 / 决策留痕。

## 0. 背景与问题定义

用户拍板「直接上 ACP」，核心问题是「**能否直接上、覆盖哪些 backend、分几步**」。本调研回答店长派活单六项验收：①供应商覆盖表 ②协议能力映射表 ③接口契约判定 ④调度替换等价性 ⑤迁移两案对照 ⑥结论。

**关键前置事实**（上一轮 opencode-32k 调研 §5 遗留）：`opencode acp` 握手/会话/文本流已实测，但**工具执行循环**标 🔴 未实测、**fork/resume 语义**未实测——本调研重点补齐这两处。

## 1. 供应商覆盖表（按 backend 形态分）

### 1.1 必查项：dsh headless 有无 ACP —— **无，实证三源**

| 证据源                                        | 输出                                                                                                          | 结论                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `dsh --help`（0.1.0-rc.6 本地）               | Commands 仅 `web`（--profile web 别名）+ `plugin`（pnpm 转发）；无 acp                                        | 顶层无 ACP 命令                  |
| `dsh --profile headless --help`               | `Usage: dsh --profile headless [options] [task...]`，仅 `task` positional + `-h/--help`                       | headless 纯 positional，零子命令 |
| `dsh --profile headless --dump-config` 插件树 | 全树 90+ 插件（dsh-agent-loop / dsh-llm / dsh-mcp-client 等），**grep acp/AgentClient/session/prompt 零命中** | 无 ACP 插件                      |
| 官方架构文档（deepseek-harness.github.io）    | `dsh-headless` = "一次性运行器，且完全不带服务器"；`dsh-web-app` 才"增加浏览器应用"                           | headless 设计上就无服务器形态    |

**结论**：dsh headless **没有 ACP server**——ACP 是「编辑器 ↔ 长驻 agent 服务」协议，headless 是"跑完即退"的一次性形态，两者设计哲学冲突。若走 ACP 全覆盖路线，dsh 这一路要么自起 ACP server（在 headless 上包一层 acp 服务，开发量大），要么继续用现有 headless 直连形态（ACPI 并存）。

### 1.2 claude —— 有 ACP，但非 CLI 原生子命令

| 证据源                                                           | 输出                                                                                                                | 结论                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `claude --help`（2.1.186 本地）                                  | Commands：agents/auth/auto-mode/doctor/install/mcp/plugin/project/setup-token/ultrareview/update；**无 acp 子命令** | 无 `claude acp` 入口                                             |
| `claude acp --help`                                              | 回退到全量 help（acp 被当 prompt 处理）                                                                             | 确认无该子命令                                                   |
| ACP 官方 Agents 页（agentclientprotocol.com/get-started/agents） | **Claude Agent**（via [Zed's SDK adapter](https://github.com/zed-industries/claude-agent-acp)）                     | Claude 的 ACP 走 **SDK 适配器**（claude-agent-acp），非 CLI 原生 |

**结论**：claude 的 ACP 化路径 = 通过 `zed-industries/claude-agent-acp`（Claude Agent SDK 包装）暴露 ACP server——claude.ts 现有 CLI 子进程形态无法直接"加个 acp 参数"切换，需引入 SDK adapter 或第三方包装。

### 1.3 opencode —— 有 ACP，原生子命令（已实测）

`opencode acp` 1.18.18 原生支持（握手/会话/工具循环/fork/resume 全部实测，见 §3）。

### 1.4 deepseek（直连 API 型）—— 无 CLI/ACP

deepseek.ts 是 HTTP SSE 直连形态（非 CLI），无 ACP server 可言。ACP 化只能靠「包在某 ACP agent 的 provider 里」（如 opencode 挂 deepseek provider）。

### 1.5 覆盖表汇总

| backend  | 形态       | ACP server 有无 | 证据               | ACP 化路径                                |
| -------- | ---------- | --------------- | ------------------ | ----------------------------------------- |
| opencode | CLI 子进程 | ✅ 原生         | 本地实测（§3）     | `opencode acp` 直连                       |
| claude   | CLI 子进程 | ⚠️ 经 SDK       | ACP 官方 Agents 页 | claude-agent-acp SDK 包装                 |
| dsh      | CLI 子进程 | ❌ 无           | §1.1 三源实证      | headless 无 ACP；需自起 server 或保持直连 |
| deepseek | 直连 API   | ❌ 无           | 形态如此           | 经 ACP agent 的 provider（间接）          |

## 2. 协议能力映射表（我们需要的原语 × ACP 能力）

| 原语                           | ACP 能力                                                                                               | 证据等级                  | 说明                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------- |
| 流式打字（文本）               | `session/update` → `agent_message_chunk`                                                               | ✅ 实测（文本流逐 chunk） | opencode 1.18.18 实测                       |
| 流式思考                       | `agent_thought_chunk`                                                                                  | ✅ 实测                   | 上一轮 §5.3 实测                            |
| 工具调用                       | `tool_call` → `tool_call_update`（pending/in_progress/completed/failed）+ `session/request_permission` | ✅ **实测（本轮补齐）**   | §3.1 完整事件链                             |
| MCP 工具面挂载                 | `session/new` 的 `mcpServers[]`（stdio 必支持，HTTP/SSE 可选）                                         | ✅ 实测                   | §3.1 catstudy MCP server 挂载 + env 透传    |
| 会话隔离                       | `session/new` 的 `cwd` + 独立 sessionId                                                                | ✅ 实测                   | cwd 已实测（会话 worktree 概念等价）        |
| slot 调度（单 agent 单活跃）   | 每 agent 一个长驻 ACP session + `session/prompt` 单轮                                                  | ⚠️ 需设计                 | §4 调度替换等价性                           |
| 硬超时（30min）                | `session/close` 中断进行中 prompt → `stopReason:"cancelled"`                                           | ✅ 实测                   | §3.3；`session/cancel` **未实现**（-32601） |
| 一轮一进程语义                 | ❌ ACP 是长驻服务                                                                                      | 🔴 冲突                   | ADR 0007「一轮一进程 > 长驻服务」默认       |
| 上下文传递（全量 messages）    | `session/prompt` 的 `prompt` 数组（JSON body）                                                         | ✅ 实测                   | 上一轮 §5.3；绕 32K 天然成立                |
| 每轮不同 model                 | `session/set_config_option`（configId: model）                                                         | ✅ 实测                   | §3.4                                        |
| 会话分支（子任务不污染主会话） | `session/fork`                                                                                         | ✅ 实测                   | §3.2                                        |
| 崩溃恢复（跨进程续）           | `session/resume` + `session/list`                                                                      | ✅ 实测                   | §3.2                                        |

## 3. 本轮实测补全（原 🔴 转 ✅）

### 3.1 acp 工具执行循环（原 🔴，实测转绿）

**测试构件**（%TEMP%/opencode/acp-research/）：

- `acp-tool-loop.mjs`：spawn `opencode acp` → initialize → `session/new`（挂 `mcpServers: [{name:'catstudy', command:'node', args:[mcp-echo.mjs], env:[6 个 CATSTUDY_*]}]`）→ `session/prompt` 要求调用 `catstudy_echo_env` 工具并报告 CATSTUDY_TRIGGER_MSG_ID。

**实测输出原文（关键行）**：

```
session/update: {"sessionUpdate":"tool_call","toolCallId":"call_696cea0d58d140a0a5d6ffd3","title":"catstudy_echo_env","kind":"other","status":"pending"}
session/update: {"sessionUpdate":"tool_call_update","toolCallId":"call_696cea0d...","status":"in_progress"}
session/update: {"sessionUpdate":"tool_call_update","toolCallId":"call_696cea0d...","status":"completed","content":[{"type":"content","content":{"type":"text","text":"echo_env 收到 CATSTUDY_* 变量（7 个）:\n{\n  \"CATSTUDY_AGENT_ID\": \"flash-cat\",...\"CATSTUDY_TRIGGER_MSG_ID\": \"3692797d-ddbb-41f5-b479-b8025a2e760a\"...}","rawOutput":{...}}}}
id:3 result: {"stopReason":"end_turn",...}
```

**结论**：ACP 内**工具执行循环完整跑通**——`tool_call`(pending) → `tool_call_update`(in_progress) → `tool_call_update`(completed) → 工具结果回传 → 模型继续 → `end_turn`。且 `mcpServers[].env` 数组的 6 个 `CATSTUDY_*` 环境变量**全部透传到 MCP server 子进程**（含 CATSTUDY_TRIGGER_MSG_ID，正是猫提交 commit uuid 的变量）——**与 dsh/opencode 本地 MCP 的 env 透传语义一致**，猫的 commit shell 仍能读到。stderr 日志可见 `evaluated permission=catstudy_echo_env pattern=* action.permission=* action.action=allow`（permission 自动放行，headless 化可行）。

### 3.2 session fork / resume 语义（原未实测，实测转绿）

**fork 实测**（acp-fork-test.mjs）：session/new → prompt「记住秘密标记 FLASH_FORK_42_ABXY 不要说出」→ `session/fork`（新 sessionId）→ fork 会话 prompt「标记是什么」→ **fork 会话答出 FLASH_FORK_42_ABXY**（事件流 agent_message_chunk 含该标记）→ `end_turn`。

**resume 跨进程实测**（acp-resume-test.mjs）：进程1 session/new + prompt「记住标记 RESUME_77_KITTY 不要说出」→ kill 进程1 → 进程2 `session/list` 列出持久化会话 → `session/resume` 恢复同一 sessionId → prompt「标记是什么」→ **进程2 模型记得指令并拒绝说出**（"不要说出来，所以我不会透露"——记忆继承，遵守原始指令）→ `end_turn`。

**结论**：fork 提供「从既有会话分支出新会话、不污染原会话」；resume 提供「跨进程/跨重连恢复会话上下文」——**调度等价性的两个核心原语都实测可用**。

### 3.3 取消语义（原未实测，实测发现协议缺口）

- `session/cancel`：**opencode 1.18.18 未实现**——`{"id":4,"error":{"code":-32601,"message":"\"Method not found\": session/cancel"}}`
- `session/close`：**等价取消**——prompt 进行中发 close，原 prompt 返回 `{"id":3,"result":{"stopReason":"cancelled","usage":{"inputTokens":0,"outputTokens":0}}}`，close 本身返回 `{}`。

**结论**：硬超时/停止按钮的 ACP 映射走 **session/close**（协议文档声明 close = cancel 进行中工作 + 释放资源），`session/cancel` 是协议 v1 的规范方法但 opencode 未实现——**适配器必须用 close 而非 cancel**，这是与 claude-agent-acp 等其它实现的行为差异点（需在适配器层做兼容分支或统一用 close）。

### 3.4 每轮 model 切换（契约：socketio.ts:2742 传 options.model）

`session/set_config_option` 实测：`{sessionId, configId:'model', value:'deepseek/deepseek-v4-flash'}` → 返回完整 configOptions，`currentValue` 变为目标 model → 后续 prompt 走该 model。

**结论**：每轮不同 agent 的 llmModel 可通过 set_config_option 切换——但注意 configOptions 的 model select 列表来自 opencode 本地 models（deepseek-v4-flash/pro/chat/reasoner 都在列），与注册表 agent.llmModel 的取值域需对齐（实施时校验）。

## 4. 接口契约判定：`chatStream(messages, options) → AsyncIterable<Chunk>`

### 4.1 契约要点（socketio.ts:2741-2767 调用点）

```
adapter.chatStream(llmMessages, {
  model, signal, maxTokens?, temperature?,
  cwd: ensureSessionWorktree(sessionId) ?? undefined,   // 会话隔离
  context: { sessionId, agentId, msgId, token, traceId, triggerAuthorName, triggerMsgId },
})
→ AsyncIterable<Chunk>  // {content, done, kind?: 'text'|'thinking'}
```

### 4.2 ACP client 实现契约的映射方案

| chatStream 侧                       | ACP 侧                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| messages（全量上下文）              | `session/prompt` 的 prompt 数组（JSON body，天然绕 32K——**不需要 -f/保尾砍历史**） |
| options.model                       | `session/set_config_option`（每轮切换）                                            |
| options.signal.abort（硬超时/停止） | `session/close`（实测 stopReason:"cancelled"）                                     |
| options.cwd（会话 worktree 隔离）   | `session/new` 的 cwd                                                               |
| options.context（MCP env 透传）     | `session/new` 的 `mcpServers[].env`（实测 6 变量全透传）                           |
| Chunk{content, kind:'text'}         | `agent_message_chunk`                                                              |
| Chunk{content, kind:'thinking'}     | `agent_thought_chunk` → `[思考]` 前缀（对齐 opencode.ts:402）                      |
| 工具反馈 chunk                      | `tool_call`/`tool_call_update` → `[工具]` 前缀（对齐 opencode.ts:404-425）         |
| done:true                           | `stopReason:"end_turn"` 后 yield done                                              |

**判定：ACP client 可以实现 `chatStream → AsyncIterable<Chunk>` 契约，dispatch 层（slot/FIFO/context filtering/记忆注入）零改动**——只需新增一个 ACP 适配器（如 acp.ts），实现同一个 LLMAdapter 接口。

### 4.3 但「长驻进程」管理是新增复杂度

- 现有 CLI 适配器（claude/opencode/dsh）都是 **chatStream 内 spawn 子进程、用完即退**——进程生命周期在单次调用内封闭。
- ACP 适配器是**长驻连接**（一个 opencode acp 进程服务多个 session/prompt 轮次）——进程生命周期跨多次 chatStream 调用。需引入：
  - **连接池/复用**：每 backend 一个长驻 acp 进程（或全局一个），chatStream 内借用/归还
  - **session 生命周期**：每轮 chatStream = 新 session（fork 自 agent 基会话）或复用——fork 语义让「每轮独立、可追溯、不污染」成立
  - **崩溃恢复**：acp 进程死 → 重连 + session/list + resume 恢复进行中会话
  - **并发安全**：dispatch 是单 agent 单活跃 FIFO，但多 agent 共享一个 acp 进程时需串行化 session/prompt（JSON-RPC id 对齐）

## 5. 调度替换等价性：fork/resume 能否承载「单 agent 单活跃 FIFO」

### 5.1 结论：**能承载，且 fork 是关键原语**

- **slot/FIFO 保持**：dispatch 的 agentSlots + agentQueues（dispatch/index.ts）是**纯内存调度结构**，不依赖底层是 CLI 子进程还是 ACP 连接。`executeAgent` 调 `runAgentReply` → `adapter.chatStream` 的接缝不变。
- **单 agent 单活跃**：每个 agent 一个长驻 acp session（或每轮 fork 出新 session）。dispatch 保证同一 agent 同时只有一个 chatStream 活跃 → 一个 agent 的 acp session 不会被并发 prompt 打进——**FIFO 语义由 dispatch 层维持，ACP 层零并发暴露**。
- **每轮上下文隔离**：`session/fork` 从 agent 基会话分支出每轮独立 session——本轮 prompt 的上下文变更不污染下轮（等价「一轮一进程」的隔离效果，fork 是显式分支语义）。
- **崩溃恢复**：`session/resume` 跨进程恢复会话上下文（实测）——server 重启后进行中 agent 的会话可续。

### 5.2 证伪面（ADR 0007 举证倒置）

「一轮一进程 > 长驻服务」默认下，上长驻 ACP 必须证伪简单形态：

- run/-f（opencode.ts 现有形态）**为什么不可行**？——绕 32K 已解决（-f 实测），但**多供应商统一**（claude/dsh/deepseek 各自形态）未解决——这是「直接上 ACP」的唯一硬理由：**ACP 是唯一有行业共识的多供应商收敛点**（opencode/claude/Codex/Gemini/Copilot 均声明支持，ACP 官方 Agents 页列 30+ 实现）。
- 但 dsh 无 ACP（§1.1）→ 全覆盖目标下 dsh 一路仍需折中。

## 6. 迁移两案对照

| 维度               | 直接全换                                                                   | connector 并存                                                        |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 范围               | claude/opencode/dsh/deepseek 四适配器全换 ACP                              | 新增 acp.ts，registry 按需启用，旧适配器保留                          |
| 回滚路径           | 需整体回退（serve 适配器 d555732 先例：保留为回滚路径）                    | 每 backend 独立切回（registry 改配置即回滚）                          |
| 风险               | 一次切换牵动全部猫；dsh 无 ACP 直接暴露全覆盖缺口                          | 增量验证；dsh/deepseek 可暂留现状                                     |
| ACP 协议版本稳定性 | v1 已稳定（session/close/fork/list/resume 等均 stabilized）；v2 draft 在案 | 同左，但并存降低单点依赖                                              |
| 建议               | —                                                                          | **connector 并存**（与 ADR 0007 serve 先例同款：增量 + 保留回滚路径） |

## 7. 结论（供店长汇总 ADR）

1. **「直接上 ACP」可行，但分步走**：新增 ACP 适配器（acp.ts）实现既有 `chatStream` 契约，**dispatch 零改动**；按 backend 逐个接入，**connector 并存**而非全换。
2. **覆盖面不全**：opencode 原生 ✅、claude 需 SDK 包装 ⚠️、**dsh 无 ACP** ❌（§1.1 三源实证）、deepseek 无 CLI。用户「直接上 ACP」要落地全覆盖，dsh 一路必须给出折中方案（headless 保持直连 + ACP 并存的混合形态，或 dsh 侧自起 ACP server 另立项）。
3. **接口契约成立**：`chatStream → AsyncIterable<Chunk>` 可由 ACP client 实现，六项原语全映射（§4.2），dispatch 层零改动。
4. **调度等价性成立**：fork（每轮分支隔离）+ resume（崩溃恢复）+ dispatch slot/FIFO 维持 → 「单 agent 单活跃」等价（§5）。
5. **协议缺口两处**：① `session/cancel` opencode 未实现，取消走 `session/close`（§3.3）；② configOptions model 列表来自 opencode 本地 models，需与注册表 llmModel 取值域对齐（§3.4）。
6. **建议采纳序**：第一步 acp.ts + opencode 单 backend 试点（工具循环/取消/fork 已实测）→ 第二步 claude 经 SDK adapter + deepseek 经 opencode provider → 第三步 dsh 折中方案（另议，因 headless 无 ACP）。每步 connector 并存，registry 可回滚。

## 8. 假设标红清单

| 假设                             | 状态        | 说明                                                                                  |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| opencode acp 工具执行循环可用    | ✅ 实测     | tool_call 事件链完整 + env 透传 + end_turn（§3.1）                                    |
| session/fork 上下文继承          | ✅ 实测     | fork 会话答出原会话秘密标记（§3.2）                                                   |
| session/resume 跨进程恢复        | ✅ 实测     | 进程2 记住进程1 的指令并遵守（§3.2）                                                  |
| session/cancel 可用              | 🔴 证伪     | opencode 1.18.18 返回 -32601 Method not found；改用 session/close（§3.3）             |
| claude 有 ACP                    | ⚠️ 官方声明 | 无 CLI 子命令；走 zed-industries/claude-agent-acp SDK adapter（§1.2），SDK 行为未实测 |
| dsh headless 有 ACP              | 🔴 证伪     | 三源实证无 ACP 命令/插件/服务器形态（§1.1）                                           |
| 多 agent 共享 acp 进程的并发安全 | 🔴 待验证   | 单 agent 单活跃下 dispatch 已串行化；多 agent 共享进程时 JSON-RPC id 对齐需实施验证   |

## 9. 实测产物位置（%TEMP%，不在主仓库）

- `%TEMP%/opencode/acp-research/acp-tool-loop.mjs`（工具循环实测）
- `%TEMP%/opencode/acp-research/acp-fork-test.mjs`（fork 实测）
- `%TEMP%/opencode/acp-research/acp-resume-test.mjs`（resume 跨进程实测）
- `%TEMP%/opencode/acp-research/acp-close-test.mjs`（close 等价取消实测）
- `%TEMP%/opencode/acp-research/acp-model-test.mjs`（set_config_option 切换 model 实测）
- `%TEMP%/opencode/acp-research/mcp-echo.mjs`（回显 MCP server，复用上一轮）

## 10. 三源证据索引

- ACP 官方协议：agentclientprotocol.com/protocol/v1/{prompt-turn, tool-calls, session-setup, session-config-options}.md
- ACP Agents 页：agentclientprotocol.com/get-started/agents.md（Claude Agent via SDK adapter）
- ACP fork RFD：agentclientprotocol.com/rfds/session-fork.md
- opencode ACP 文档：opencode.ai/docs/acp/（"OpenCode works the same via ACP as it does in the terminal. All features are supported"）
- dsh 官方架构文档：deepseek-harness.github.io/deepseek-harness/reference/（headless = 无服务器一次性形态）

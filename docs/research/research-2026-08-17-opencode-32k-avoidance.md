# 调研笔记：opencode 规避 32K 命令行限制（-f / --variant / 本地 MCP / acp 四路实测）

> 调研日期：2026-08-17
> 执行猫：flash猫
> 触发消息：773f82a1-bace-4248-a7ff-1c17e2e1a7cc（店长派活单）
> 性质：调研笔记（非 ADR 定稿）。店长收口后据此汇总正式 ADR 立项单，过 ADR 0007 四步检查单。
> 边界遵守：未改生产代码（opencode.ts / registry.ts 零触碰）；实测全部在 `%TEMP%` 完成；未装第三方包。

## 0. 背景与问题定义

opencode `run` 以 positional `[message..]` 传 prompt，Windows CreateProcess 命令行总长限 32K（Node spawn 实测 `ENAMETOOLONG`）。生产适配器（opencode.ts:43 `PROMPT_ARG_MAX = 30000`）超限时 `messagesToPromptBounded` 保尾砍旧历史——内容截断导致传输不完全（用户观察到的 `{"promptLen":45101,"max":30000}` 日志即此兜底）。目标：找到规避方案，最好与 dsh 侧统一（统一候选 = MCP 工具面外置）。

**对标 ADR 0007 检查单**：本次为调研（选项探测），每项标「假设 / 实测 / 结论」，三源证据（`--help` / 官方文档 / 实测输出）。

## 1. 能力对账前置（`--help` 原文 + 官方文档）

### 1.1 opencode run --help（1.18.18，本地实测）

```
-f, --file   file(s) to attach to message   [array]
--variant    model variant (provider-specific reasoning effort, e.g., high, max, minimal)
--command    the command to run, use message for args
--attach     attach to a running opencode server
-s, --session  session id to continue
-m, --model  model to use in the format of provider/model
--thinking   show thinking blocks
```

### 1.2 opencode acp --help（1.18.18，本地实测）

```
opencode acp — start ACP (Agent Client Protocol) server
--port    port to listen on   [default: 0]
--hostname  hostname to listen on   [default: "127.0.0.1"]
--mdns / --mdns-domain / --cors / --cwd
```

### 1.3 opencode 官方 CLI 文档（https://opencode.ai/docs/cli/）

- acp：**"This command starts an ACP server that communicates via stdin/stdout using nd-JSON."** —— stdio 通道为官方声明
- run：`--file` "File(s) to attach to message"
- 两源对 acp 通道有出入：官方文档声明 **stdio**，但 `--help` 含 `--port/--hostname`（暗示 HTTP 亦可）。实测锚定见 §4。

### 1.4 opencode 官方 MCP 文档（https://opencode.ai/docs/mcp-servers/）

- 本地 MCP 形态：`mcp.<name>.type="local"` + `command: [array]` + `environment: {}` + `cwd` + `timeout`（默认 5000ms）
- MCP 工具命名 `mcp__<serverName>__<toolName>`（与 claude/dsh 链一致）
- 官方提示：MCP 工具面会加 context 开销，需谨慎开

## 2. 实测1：`-f/--file` 绕 32K

**假设 A**：`-f` 文件内容完整进 prompt；**假设 B**：argv 只传文件路径 → 绕 32K；**假设 C**：仍一轮一进程。

### 2.1 实测（裸 run，非 agent 模式——排除工具读文件混淆）

```
$env:TEMP/opencode/acp-research/big50k.txt  （53,731 bytes，末尾带 UNIQUE_MARKER_8f3a2b）
opencode run --format json -m deepseek/deepseek-v4-flash "附加文件末尾的独特标记是什么" -f big50k.txt
```

**实测输出原文（关键行）**：

```
{"type":"step_start",...}
{"type":"text","part":{"type":"text","text":"UNIQUE_MARKER_8f3a2b",...}}
{"type":"step_finish","part":{"tokens":{"total":12591,"input":10601,"output":13,"reasoning":57,...
```

**结论**：模型答出文件末尾标记 `UNIQUE_MARKER_8f3a2b`，input 10601 tokens ≈ 53KB **完整进入上下文**——假设 A ✅。argv 只含 `-f big50k.txt`（短路径），CreateProcess 32K 无从触发——假设 B ✅。事件流 `step_start → text → step_finish` 单进程一轮——假设 C ✅。

### 2.2 对照组：positional 传 50KB argv（证明 32K 是真限制）

**实测输出原文**：

```
Error: spawn ENAMETOOLONG
    at ChildProcess.spawn (node:internal/child_process:421:11)
```

**结论**：50KB positional argv → spawn ENAMETOOLONG（CreateProcess 32K 的 Node 表现）。`-f` 路径 argv 只含路径故不触发——对照实锤 32K 限制真实存在，`-f` 天然规避。

### 2.3 实测（--agent build --auto，生产适配器同款形态）

```
opencode run --agent build --auto --format json -m deepseek/deepseek-v4-flash "…末尾标记…" -f big50k.txt
```

**实测输出原文**：`{"type":"text","text":"UNIQUE_MARKER_8f3a2b",...}`（agent 模式同样答对）

**结论**：agent 模式（生产 `--agent build --auto` 同款）下 `-f` 同样完整注入——适配器换 `-f` 通道时**零形态冲突**。注意：opencode.ts:173-176 注释记录 `-f` 是贪婪选项、须排在 prompt 之后——实施时须遵守该参数序。

## 3. 实测2：`--variant` 思考深度旋钮

**假设**：`--variant high/max` 对 deepseek provider 生效、真改思考深度。

### 3.1 能力对账：models.dev 元数据（opencode models deepseek --verbose）

```
deepseek/deepseek-v4-flash: "variants": {"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}
deepseek/deepseek-v4-pro:   "variants": {"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}
deepseek/deepseek-chat:     "variants": {}
deepseek/deepseek-reasoner: "variants": {}
```

**结论**：`--variant` 是 provider-specific 的——**deepseek-chat/reasoner 的 `variants` 为空对象，传 `--variant` 静默忽略**；deepseek-v4-flash/pro 有 `variants` 映射到 `reasoningEffort`。本仓库用 deepseek-v4-flash/pro 的猫可受益。

### 3.2 实测（deepseek-v4-flash，1+1 简单题）

```
opencode run --format json --variant high -m deepseek/deepseek-v4-flash "1+1=? 只回答数字。"
→ step_finish tokens: {"total":7603,"input":5665,"output":2,"reasoning":16,...}   (cost 0.0008)
opencode run --format json -m deepseek/deepseek-v4-flash "1+1=? 只回答数字。"
→ step_finish tokens: {"total":7587,"input":33,"output":2,"reasoning":0,...}     (cost 0.00003)
```

**结论**：`--variant high` 下 reasoning 16 tokens vs 默认 0——**确真改变推理行为**（简单题也产生思考）。但 input 差异巨大（5665 vs 33）可疑——疑似 variant 切换后 system prompt/上下文膨胀，不能排除缓存副作用。结论：**生效证据成立但幅度待对称复测**（店长立项时建议用鸡兔同笼对照）。实测过程中发现**两轮 input 差异**，可能是 opencode 会话缓存（cache.read 1920/7552）。

### 3.3 实测（deepseek-chat，variants:{} model 传 variant）

```
opencode run --format json --variant high -m deepseek/deepseek-chat "1+1=? 只回答数字。"
→ {"type":"text","text":"2",...}  step_finish reasoning:0   (EXIT_OK=True)
```

**结论**：无 variants 元数据的 model 传 `--variant` **不报错、静默忽略**（reasoning 0）——不会崩，但也不生效。

## 4. 实测3：本地 MCP 挂载 + environment 注入（统一方案候选）

**假设 A**：opencode 本地 MCP 工具可见；**假设 B**：`environment` 注入的 `CATSTUDY_*` 到达 MCP server 子进程；**假设 C**：prompt 短传 + 工具拉历史可行。

### 4.1 测试构件（%TEMP%，不污染主仓库）

- `mcp-echo.mjs`：原生 JSON-RPC stdio MCP server（零依赖），`echo_env` 工具回显 `process.env` 中 `CATSTUDY_*` 变量
- `opencode-mcp-test.jsonc`：`mcp.catstudy` = local + `command:["node", mcp-echo.mjs]` + `environment:{CATSTUDY_SESSION_ID, CATSTUDY_TRIGGER_MSG_ID, CATSTUDY_AGENT_ID, CATSTUDY_MSG_ID, CATSTUDY_SIGNAL_TOKEN, CATSTUDY_SERVER_URL}`
- 以 `OPENCODE_CONFIG=<jsonc>` 注入，不改全局配置

### 4.2 实测输出原文（关键行）

```
{"type":"tool_use","tool":"catstudy_echo_env","state":{"status":"completed","output":"echo_env 收到 CATSTUDY_* 变量（6 个）:
{
  "CATSTUDY_AGENT_ID": "flash-cat",
  "CATSTUDY_MSG_ID": "msg_test_999",
  "CATSTUDY_SERVER_URL": "http://127.0.0.1:3200",
  "CATSTUDY_SESSION_ID": "ses_test_1234",
  "CATSTUDY_SIGNAL_TOKEN": "tok_test_abc",
  "CATSTUDY_TRIGGER_MSG_ID": "3692797d-ddbb-41f5-b479-b8025a2e760a"
}"}}}
```

**结论**：假设 A ✅ `catstudy_echo_env` 工具被模型发现并调用（status completed）；假设 B ✅ **6 个 `CATSTUDY_*` environment 全部透传到 MCP server 子进程**（含 `CATSTUDY_TRIGGER_MSG_ID`，正是 dsh 猫提交 uuid 需要的变量）；假设 C ✅ prompt 只传短指令、工具拉数据——工具面外置可行。

### 4.3 与 dsh 统一性

- dsh 已挂 `mcp-catstudy`（`@deepseek-ai/dsh-mcp-client` → `node scripts/mcp-server.mjs`），工具面 `mcp__catstudy__*` 命名与 opencode 实测一致
- opencode 可挂**同一个** `scripts/mcp-server.mjs`（本地 MCP `command:["node", scripts/mcp-server.mjs]`）——**统一方案 = MCP 工具面外置**（两边同通道同 server 同工具）
- 注意差异：opencode 的 `environment` 是静态配置（非每 spawn 动态生成 .mcp.json）；dsh 走 per-spawn patch overlay。实施时须把「每轮动态 env（sessionId/agentId/msgId/token）」适配到 opencode 形态（如 opencode.jsonc 用 `{env:...}` 引用或 spawn 时注入 OPENCODE_CONFIG 内容）

## 5. 实测4：acp 通道（Agent Client Protocol）

**假设**：acp 是 JSON-RPC stdio；`session/new` + `session/prompt` 方法；`session/update` 事件流；prompt 经 JSON body（不经 argv）→ 绕 32K。

### 5.1 握手与 capabilities（实测输出原文）

```
opencode acp（spawn，stdio pipe）
→ {"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,
   "mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},
   "sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
   "agentInfo":{"name":"OpenCode","version":"1.18.18"}}}
```

**结论**：ACP 握手成功。`mcpCapabilities:{http,sse}` + `--help` 的 `--port` 说明 acp 可 HTTP；但官方文档声明默认 stdio（"communicates via stdin/stdout using nd-JSON"）。**通道双模**：stdio（默认，编辑器场景）与 HTTP（--port 起服务）皆可。JSON-RPC 2.0 行协议确认。

### 5.2 session/new（实测输出原文）

```
{"id":2,"result":{"sessionId":"ses_ff258fe75ffe03vyWafyd24Hep",
  "configOptions":[{...model select 全量 33 模型...},{...mode: build/plan...}]}}
```

**注意**：`session/new` 需要 `cwd` 与 `mcpServers` 字段（首次传 `directory` 被拒：`"cwd":{"_errors":["Invalid input: expected string"]}`、`"mcpServers":{"_errors":["expected array"]}`）——schema 与 zed ACP 客户端默认参数一致。

### 5.3 session/prompt（实测输出原文——流式事件）

```
→ {"method":"session/update","params":{"sessionId":"ses_...","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The user is asking..."}}}}
→ {"method":"session/update","params":{"...","sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"2"}}}
→ {"method":"session/update","params":{"...","sessionUpdate":"usage_update","used":8150,"size":200000,...}}
→ {"id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":7126,"outputTokens":4,"totalTokens":8177,"thoughtTokens":23}}}
```

**结论**：`session/prompt` 后 `session/update` 事件流推送 `agent_thought_chunk`（思考流）+ `agent_message_chunk`（文本流）+ `usage_update`，`result.stopReason:"end_turn"` 收束——**schema 完整实测**。`prompt` 为**对象数组**（`[{type:"text",text:...}]`，非字符串）——JSON body 传输，**argv 零接触，天然绕 32K**。

### 5.4 工具执行模型（证据等级）

- 实测 session/new 返回 `mcpCapabilities:{http,sse}`——acp 会话可挂 MCP server（`mcpServers` 数组参数）
- 工具循环能力官方文档（/docs/acp/）："Built-in tools, MCP servers configured, Agents and permissions system" 全部支持
- 但**本轮实测未实际触发工具调用**（只验证了文本对话流）——「acp 内工具执行循环」证据等级 = **官方声明 + 握手能力声明**，缺「实测跑通工具循环」一条。店长汇总时须对称实测（dsh 侧已实测工具循环）。

## 6. 方案矩阵

| 方案                 | 绕 32K                            | 保一轮一进程                     | 工具面可用                                 | 开发量                                                              | 与 dsh 统一                                    | 证据等级                   |
| -------------------- | --------------------------------- | -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------- | -------------------------- |
| `-f/--file` 文件外置 | ✅ 实测（argv 只含路径）          | ✅ 实测（裸 run + agent 双实测） | ✅（agent build 工具循环原生）             | 低（适配器内：超阈值 prompt 落盘 + `-f` 传路径，改 promptArg 分支） | 否（dsh 无对应）                               | 三源实锤（help/文档/实测） |
| 本地 MCP 工具面外置  | ✅ 实测（prompt 短传 + env 注入） | ✅ 实测（run 形态不破坏）        | ✅ 实测（catstudy_echo_env 调用成功）      | 中（opencode.jsonc 挂 mcp + 动态 env 适配 + 会话历史工具）          | ✅ **统一候选**（同一 scripts/mcp-server.mjs） | 三源实锤                   |
| acp 通道             | ✅ 实测（prompt 走 JSON body）    | ❌ 长驻服务（非一轮一进程）      | ⚠️ 官方声明 + 握手能力声明，未实测工具循环 | 高（新适配器：会话管理 + 事件流重映射 + MCP 挂载）                  | ❌（dsh 无 acp）                               | 通道实测、工具面待对称复测 |
| serve（对照）        | ✅（HTTP body）                   | ❌ 长驻服务                      | ✅ 实测过（serve 适配器存留 d555732）      | 已回退（ADR 0007 背景）                                             | ❌                                             | 历史实证 + ADR 0007        |

## 7. 结论（供店长汇总 ADR）

1. **`-f` 是「一轮一进程」约束下的最优解**：argv 只传文件路径天然绕 32K，内容完整进 prompt（53KB 实测无损），agent 模式零形态冲突，开发量最低（只改 opencode.ts promptArg 分支）。**但**「prompt 保尾砍旧历史」语义要迁移：超阈值时把**砍剩下的 prompt 落盘**给 `-f`，argv 只留短指令。
2. **MCP 工具面外置 = 与 dsh 的统一方案**：同一 `scripts/mcp-server.mjs`、同一 `mcp__catstudy__*` 工具命名、`environment` 注入实测透传 `CATSTUDY_TRIGGER_MSG_ID`。opencode 侧形态差异（静态 environment vs dsh per-spawn patch）需适配。可作为**中期统一演进**候选。
3. **acp 是长驻形态**，违反 ADR 0007「一轮一进程 > 长驻服务」默认——要上必须附「run/-f/MCP 外置为什么不可行」的证伪举证。当前实测证据不足以推翻简单形态。
4. **`--variant` 与 32K 无关**，但发现它确真生效于 deepseek-v4-flash/pro（reasoningEffort 映射）——独立于本调研议题，是否启用另立议题。
5. 建议采纳序：**近期 `-f` 兜底（低风险快解）→ 中期 MCP 外置统一（与 dsh 同轨）**；acp 仅当多客户端 attach 需求出现再评估。

## 8. 假设标红清单

| 假设                                           | 状态        | 说明                                                                                                        |
| ---------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `-f` 内容完整进 prompt 且绕 32K                | ✅ 已验证   | 53KB 无损 + ENAMETOOLONG 对照                                                                               |
| `-f` 在 agent 模式可用                         | ✅ 已验证   | --agent build --auto 答对标记                                                                               |
| `--variant` 对 deepseek 生效                   | ⚠️ 部分验证 | v4-flash/pro 有 variants 元数据且 reasoning 变化；deepseek-chat/reasoner 静默忽略；幅度受缓存干扰待对称复测 |
| opencode 本地 MCP + environment 透传           | ✅ 已验证   | 6 变量全量到达子进程                                                                                        |
| acp 为 JSON-RPC stdio                          | ✅ 已验证   | 官方文档 + 握手 + 行协议；HTTP 亦可用（双模）                                                               |
| acp 内工具执行循环                             | 🔴 待验证   | 官方声明 + 握手能力声明，未实测跑通工具调用                                                                 |
| opencode 的 MCP environment 支持动态 per-spawn | 🔴 待验证   | 静态配置形态 vs dsh per-spawn patch，实施时须适配                                                           |

## 9. 实测产物位置（%TEMP%，不在主仓库）

- `%TEMP%/opencode/acp-research/big50k.txt`（53KB 测试文件）
- `%TEMP%/opencode/acp-research/mcp-echo.mjs`（回显 MCP server）
- `%TEMP%/opencode/acp-research/opencode-mcp-test.jsonc`（临时 MCP 配置）
- `%TEMP%/opencode/acp-research/acp-prompt-test3.mjs`（acp 会话实测脚本）

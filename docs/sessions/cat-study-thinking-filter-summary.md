# 思考内容过滤 + 前端折叠展示 + 测试类型修复

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | `Chunk` 接口新增 `kind?: 'text' \| 'thinking'` 字段，区分 LLM 输出的文本内容和内部推理 |
| `packages/server/src/llm/cli-utils.ts` | `parseClaudeCodeOutput` 产出思考块时标记 `kind: 'thinking'`，普通文本标记 `kind: 'text'` |
| `packages/server/src/connectors/socketio.ts` | `runAgentReply` 中拆分为两个变量：`displayContent`（含思考，流式推前端）和 `fullContent`（纯文本，存 DB + agent-to-agent 上下文）；流式气泡也改用 `displayContent` 推送 |
| `packages/web/src/components/ChatPanel.vue` | 新增 `parseThinkingBlocks()` 解析函数，拆分 `[思考]` 标记块和普通文本段；新增流式气泡实时渲染 agent 输出（不再只显示光标）；`[思考]` 块默认折叠在 `<details>` 面板中 |
| `packages/web/src/components/ChatPanel.test.ts` | 废弃 `fs`/`path`/`__dirname`，改用 Vite 的 `?raw` 导入源码，消除 `@types/node` 缺失导致的 TS 错误 |
| `packages/web/src/stores/chat.ts` | `state.slotState` → `state.status`，对齐 `AgentRuntimeState` 类型的实际属性名 |
| `packages/web/src/utils/markdown.test.ts` | `Window` 类型断言改为从 `dompurify` 导入的 `WindowLike` 类型；`jsdom` 模块声明补入 `env.d.ts` |
| `packages/web/env.d.ts` | 新增 `declare module 'jsdom'`，解决 jsdom v29 无内置类型声明的问题 |

## 2. Why — 为什么这样做

### 根因：思考内容膨胀导致 agent-to-agent review 链断裂

日志 `traceId=dc2d767a` 完整记录了一条 review 链的崩溃过程：

```
用户消息 (@店长)
  └─ 店长 Claude CLI 回复 25,462 字符（含大量 [思考] 内容）→ @吐槽猫 review
       └─ 吐槽猫 Claude CLI 回复 13,797 字符 → @店长
            └─ 店长第二次触发，上下文累至 41,749 字符
               └─ ❌ spawn ENAMETOOLONG — 超过 Windows CreateProcess 32K 命令行限制
```

Claude Code CLI 的 `-p` 参数将整个 prompt 作为命令行参数传递。Supervisor 再中转一次 `node cli-supervisor.mjs -- claude -p "<prompt>"`，总长超过 32,767 字符则直接失败。

### 双管线分离：展示 vs 存储

```
LLM 输出流
    │
    ├── Chunk { kind: 'text', content: "..." }
    │     ├── displayContent +=  ✅ 前端流式展示
    │     └── fullContent +=     ✅ 存入 messages 表
    │                            ✅ 参与 agent-to-agent 上下文
    │
    └── Chunk { kind: 'thinking', content: "[思考] ..." }
          ├── displayContent +=  ✅ 前端流式展示（折叠）
          └── fullContent  跳过  ✅ 不存库 ✅ 不参与上下文
```

核心设计原则：**思考内容是给人看的进度指示，不是给其他 Agent 看的上下文**。其他 Agent 不需要读别猫的内心独白。

### 前端折叠而非隐藏

思考内容在 Agent 长时间推理时提供进度感（避免用户以为卡死），所以不能完全丢弃。默认折叠 + 点击展开是标准 UX 模式（与 ChatGPT、Claude Chat 的 thinking 折叠一致）。

### 流式气泡从无到有

此前 `AGENT_TYPING` 事件的 content 只在 store 里存着，前端只拿它判断"有没有在打字"来显示闪光标。现在把 `displayContent` 实时解析渲染到聊天气泡中，用户能看到 Agent 逐字输出，体验类似 ChatGPT。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 方案 A：通过 stdin 传 prompt 而非 `-p` 命令行参数 | 绕过了 `ENAMETOOLONG`，但没有解决上下文膨胀的根本问题。思考内容仍在堆叠，后续会撞到模型 context window 限制，且推理越来越慢（店长首轮 7.7 分钟）。另外还需改动 Supervisor 的 stdio 管道、处理背压和 EPIPE 错误。 |
| 方案 B：在 `messagesToPrompt` 中对超长上下文做截断 | 粗暴截断会丢失 review 链中的关键信息，降低 review 质量。且"截多少"是另一个需要调的参数。 |
| 方案 C：完全丢弃思考内容，前端也不展示 | 用户看不到 Agent 的推理进度，长时间等待时无法区分"在思考"还是"卡死了"。 |
| 后端做 `[思考]` 文本解析再分离 | 文本解析（正则匹配 `[思考]` 前缀）是脆弱的——如果 Agent 回复内容本身包含 `[思考]` 两个字就会被误判。现在后端用结构化的 `kind` 字段（从 NDJSON `type: "thinking"` 直接映射），不做字符串匹配。前端解析 `[思考]` 前缀只用于展示层，不影响存储。 |

## 4. Open Questions — 不确定的点

- **DeepSeek 适配器是否有 reasoning/thinking 块**：当前只在 Claude CLI 适配器（`parseClaudeCodeOutput`）做了 `kind` 标记。DeepSeek API 的 Chat Completions 响应中可能也有 `reasoning_content` 字段，需要确认是否需要同样过滤，防止从 DeepSeek 适配器路径也出现上下文膨胀。
- **折叠面板在流式渲染时的体验**：思考内容实时追加时 `<details>` 面板打开/关闭状态可能抖动。当前默认 `open="false"` 每次重新渲染都会折叠回去，如果用户在查看思考内容时新 chunk 到达，面板会被收起。后续可能需要记住用户的展开状态。
- **`declare module 'jsdom'` 是空声明**：所有从 jsdom 导入的类型都退化为 `any`。如果后续 markdown 测试需要更精确的类型检查，需要安装 `@types/jsdom` 或等待 jsdom 内置类型。

## 5. Next Action — 希望做什么

- [ ] 确认 DeepSeek API 适配器是否需要同样的 thinking 过滤（检查 `/anthropic/v1/messages` 响应中是否含 `reasoning_content`）
- [ ] 流式气泡的 `<details>` 面板在内容追加时保持用户手动设置的展开/折叠状态
- [ ] 考虑在前端对过长的思考内容做滚动容器（`max-height` + `overflow-y: auto`），避免一个超大思考块撑爆聊天气泡
- [ ] 确认 OpenAI Codex CLI 适配器是否需要同样的 `kind` 标记（`parseCodexOutput` 目前未区分文本/思考）

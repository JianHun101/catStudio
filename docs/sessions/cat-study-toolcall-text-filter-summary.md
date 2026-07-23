# Claude Code CLI 工具描述过滤 + Agent 消息强信号格式

## 1. What — 具体改动

| 文件                                                      | 改动                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/llm/cli-utils.ts`                    | `parseClaudeCodeOutput` 重构：text 块不再立即产出，改为暂存到 buffer；遇 `tool_use` 则清空 buffer；到 `result` 事件时才产出 buffer 中剩余内容                                                        |
| `packages/server/src/connectors/socketio.ts`              | `formatAgentMessage` 签名扩展为 `(name, content, mentions?, model?)`，格式从含糊的 `吐槽猫：` 改为强信号 `Direct message from 吐槽猫 [deepseek-v4-pro]; reply to 店长`；调用方传入 mentions 和 model |
| `packages/server/src/connectors/socketio-context.test.ts` | 更新 `formatAgentMessage` 测试用例：基本格式、mentions、model、完整组合、回退名                                                                                                                      |

## 2. Why — 为什么这样做

### 根因：两层噪音导致 Agent 无法理解其他猫的回复

在"debug"会话中追踪到一条完整的 agent-to-agent review 链断裂：

```
用户 @店长 修
  └─ 店长 改代码 → @吐槽猫 review
       └─ 吐槽猫 Claude Code CLI 输出 6008 字符
            ├─ "让我逐项审查所有改动。"        ← 工具调用前导描述
            ├─ "让我继续查看撤回 handler。"     ← 工具调用前导描述
            ├─ "让我再看 runAgentReply。"       ← 工具调用前导描述
            ├─ （多次 Read / Grep 工具调用）
            └─ "## 代码审查\n✅ 可以合并。\n@店长 过。"  ← 真正的回复
                                                              ↓
            └─ 6008 字符全部写入 fullContent → 存入 DB → 进入店长的 LLM 上下文
                                                              ↓
            格式化为: "User: Direct message from 吐槽猫; reply to 店长\n\n
                       让我逐项审查所有改动。让我继续查看…（6008 字符）…@店长 过。"
                                                              ↓
店长回复: "看起来消息只发了 @店长 没有具体内容"  ← LLM 理解偏差
```

**两层问题**：

1. **内容噪音**：6008 字符中前 200+ 字符是工具调用独白，DeepSeek 被噪音裹挟
2. **信号模糊**：原格式 `User: 吐槽猫：` 无法区分"这是一条来自吐槽猫的直接消息"和"用户在引用吐槽猫的话"

### 改动 1：工具调用前导描述过滤

通过实时捕获 Claude Code CLI v2.1.186 的 `stream-json` 输出，确认了事件序列结构：

```
assistant [thinking]  "…"                             ← 实时流式产出 ✅
assistant [text]      "好的，按顺序来。先读文件。"      ← 暂存到 buffer
assistant [tool_use]  Read(package.json)               ← 清空 buffer
user      [tool_result] ...                            ← 工具结果
assistant [thinking]  "…"                             ← 实时流式产出 ✅
assistant [text]      "第1步完成，继续读 tsconfig。"    ← 暂存到 buffer
assistant [tool_use]  Read(tsconfig.json)              ← 清空 buffer
user      [tool_result] ...
assistant [thinking]  "…"                             ← 实时流式产出 ✅
assistant [text]      "第2步完成，项目是…"              ← 暂存到 buffer
result                                                   ← 产出 buffer 剩余
```

关键发现：

- 每个 `assistant` 事件只含一种 content block 类型，不是混合的
- `--verbose` 在 v2.1.186 中不产生累积快照（与旧版协议文档描述不同）
- `text` 块出现在 `tool_use` 之前的 → 工具描述；出现在最后的 → 真正回复

过滤策略：

```
LLM NDJSON 流
    │
    ├── thinking 块 → 立即 yield（实时流式进度）  ← 不变
    │
    ├── text 块 → 推入 textBuffer                 ← 改：暂存
    │
    ├── tool_use 块 → textBuffer.length = 0       ← 新增：清空
    │
    └── result 事件 → 遍历 textBuffer，逐条 yield ← 新增：产出剩余
```

### 改动 2：Agent 消息强信号格式

参考 clowder-ai 的 D2 消息模板：当其他 Agent 的回复进入当前 Agent 的 LLM 上下文时，需要在消息体中注入明确的元信息——谁发的、用的什么模型、应该回复给谁。

```
改前: 吐槽猫：额外发现：marker 内存泄漏…@店长 过。

改后: Direct message from 吐槽猫 [deepseek-v4-pro]; reply to 店长

       额外发现：marker 内存泄漏…@店长 过。
```

为什么不在 `messagesToPrompt` 的 `User:` 层面改：`User:` 前缀是角色标签（"这是输入给你的"），而 `Direct message from` 是消息内部的元信息头（"这条输入来自谁"）。两者职责不同，各自独立。如果混在一起（比如 `User (from 吐槽猫):`），会让 `messagesToPrompt` 承担不属于它的语义分发职责。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                                   | 原因                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 方案 A：用文本启发式（正则匹配 `让我.*。` 等模式）过滤工具描述         | 语言相关、模式脆弱。DeepSeek 可能用不同的措辞（"我先看看"、"开始审查"等），英文模型输出完全不同。维护成本高。                                                    |
| 方案 B：去掉 `--verbose`，只用 `--include-partial-messages`            | `--include-partial-messages` 产生 `stream_event` 增量事件，解析逻辑完全不同且更复杂。`--verbose` 还提供 thinking 块（前端进度指示），去掉后用户体验下降。        |
| 方案 C：在 `runAgentReply` 的 `fullContent` 拼接处过滤                 | 太晚——此时已经从 NDJSON 解析完，只能靠字符串启发式区分工具描述和回复，回到方案 A 的问题。在解析层做过滤是结构化的、确定性的。                                    |
| text buffer 不清空，而是跟踪 `lastToolUseIndex` 在 result 时按索引截断 | 需要额外维护全局索引计数器，且 `textBuffer` 只增不减。清空策略更简单直观，内存占用也更低（工具描述被丢弃而非堆积）。                                             |
| 在 `messagesToPrompt` 层统一改 `User:` 角色前缀，而非在消息内容里加头  | `User:` / `Assistant:` 是通用的角色标签，不应耦合 Agent 身份信息。把身份信息放在消息内容中保持了解耦：`messagesToPrompt` 只管角色，`formatAgentMessage` 管身份。 |
| 每次调用 `formatAgentMessage` 时查 DB 拿 model                         | `agentsRepo.getAgentById()` 是内存哈希表查找（已缓存），不是磁盘 I/O。成本极低，且 model 信息对下游 Agent 理解消息来源有实际价值。                               |

## 4. Open Questions — 不确定的点

- **异常退出时 buffer 丢弃**：如果 Claude Code CLI 崩溃或被 kill（没有 `result` 事件），`textBuffer` 中的内容会随 generator 结束而丢失。当前这个场景极少发生（正常退出必有 `result`），且即使发生，丢失的也只是工具描述而非回复。
- **Sub-agent 多路复用**：Claude Code CLI 的 sub-agent 会在同一 stdout 产生交错的事件流。当前按全局事件序列处理，sub-agent 的 `tool_use` 也会清空主 agent 的 `textBuffer`。需要观察实际场景中是否出现"主 agent 的回复被 sub-agent 的工具调用意外清空"的情况。
- **`--verbose` 行为可能随版本变化**：当前 v2.1.186 不产生累积快照，但协议文档描述旧版有累积行为。如果未来版本恢复累积快照，`textBuffer` 会收到重复内容，需要在 push 前做去重。
- **`Direct message from` 对 DeepSeek 的实际效果**：格式灵感来自 clowder-ai 的设计（模板 `d2-direct-message.md`），但未在 DeepSeek V4 Pro 上做过 A/B 对比。如果效果不明显，可能需要进一步强化（比如在 system prompt 中教 LLM 如何解析这条头信息）。
- **mentions 为空时缺少路由信号**：当吐槽猫的回复 `mentions` 为 `[]`（用户直接 @ 吐槽猫，没有 agent-to-agent dispatch），`formatAgentMessage` 不会输出 `reply to`。这意味着其他 Agent 在非广播模式下仍然看不到这条消息——但这是 `parseMentionsFromReply` + `authorName` 的问题，不是消息格式的问题。

## 5. Next Action — 希望做什么

- [ ] 在实际多 Agent 协作场景中验证：吐槽猫 review 店长改动后，店长能否正确读取吐槽猫的回复
- [ ] 确认 sub-agent 场景：如果吐槽猫 spawn 了 sub-agent 读文件，sub-agent 的 `tool_use` 事件是否会错误清空吐槽猫的回复 buffer
- [ ] 修复 `authorName` 在用户触发路径的空白问题——用户在消息中 @吐槽猫 时，`authorName` 为 `undefined`，`@作者` 占位符未替换，吐槽猫输出 `@用户` 而非 `@店长`，导致 mentions 为空
- [ ] 确认极端路径：Agent 中途被 kill（无 `result` 事件）时，buffer 丢弃是否会导致信息丢失

# CatStudy A2A Review 链修复：上下文过滤 + @mention 解析 + 提示词强化

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/server/src/connectors/a2a-mentions.ts` | **新增**：从 `socketio.ts` 提取 `parseMentionsFromReply` 为独立纯函数模块，改为行首匹配 + 代码块剥离 |
| `packages/server/src/connectors/a2a-mentions.test.ts` | **新增**：19 个测试覆盖行首匹配、代码块剥离、行内代码剥离、边界情况、综合场景 |
| `packages/server/src/connectors/socketio.ts` | 引入 `a2a-mentions.ts`；上下文过滤新增规则：其他 Agent 回复中 @mention 了当前 Agent 时保留该回复 |
| `packages/server/src/seed-data.ts` | 三个规则集（`HANDOFF_FORMAT`、`DEVELOPMENT_RULE`、`REVIEW_RULE`）增加出口检查、强制 review 措辞、@mention 格式要求与示例 |
| `packages/web/src/stores/chat.ts` | `NEW_MESSAGE` 和 `AGENT_STATUS(idle)` 事件中清除 `typingStates`，修复对话完成后闪烁光标不消失的问题 |

## 2. Why — 为什么这样做

### 核心问题：Agent 写完代码后 Review 链完全断裂

日志分析 93 次 Agent 回复，仅 1 次触发 agent-to-agent dispatch。即使在唯一触发的那次，Reviewer（吐槽猫）的 `relevantMessages=0`，只拿到了 82 字符的 system prompt。两层问题叠加：

```
店长写完代码 → 回复中含 @吐槽猫 + 交接文档
                │
    ┌───────────┴───────────┐
    │ 问题 1: 上下文过滤     │  ← P0：交接文档被丢弃
    │ 非广播模式下，其他     │     relevantMessages=0
    │ Agent 回复一律丢弃    │
    └───────────┬───────────┘
                │ (即使 P0 已修)
    ┌───────────┴───────────┐
    │ 问题 2: LLM 不 @mention │  ← P1：93 次回复中 92 次
    │ 提示词措辞弱          │     没触发 agent-to-agent dispatch
    │ "如果需要"给了退路     │
    └───────────────────────┘
```

### P0 修复：上下文过滤新增 @mention 可见规则

```
修复前 (socketio.ts):
  if (m.role === 'agent') {
    if (isBroadcastMode) → 保留          // 广播模式
    else if (自己发的)    → 保留          // 自己的历史
    // 其他 Agent 回复 → 丢弃（包括交接文档）
  }

修复后:
  if (m.role === 'agent') {
    if (isBroadcastMode)        → 保留
    else if (自己发的)          → 保留
    else if (mentions 含本 Agent 名) → 保留  ← 新增
    // 其他 Agent 无关回复 → 丢弃
  }
```

效果：店长的交接文档（`mentions: ["吐槽猫"]`）→ 吐槽猫可见 ✅；吐槽猫 review 完毕 @店长 → 店长可见 ✅。

### P1-1：@mention 解析从"宽松 includes"改为"行首匹配 + 代码剥离"

参考 Cat Café 项目 `docs/lessons/04-a2a-routing.md` 的设计原则：用户消息用宽松匹配，Agent 回复用严格行首匹配，因为 Agent 输出经常在代码注释、文档示例中出现其他 Agent 名字。

```
解析流水线:
  原始文本
    → 剥离代码块 (```...```)     ← 防止代码注释 @吐槽猫 误触发
    → 剥离行内代码 (`...`)       ← 防止 `@吐槽猫` 误触发
    → 行首正则 ^\s*@name(?=\s|$) ← 只匹配独占一行的 @mention
```

关键设计：用 `(?=\s|$)` 而非 `\b` 做词边界——JavaScript 的 `\w` 不包含中文字符，`\b` 在中文字符间不会匹配。

### P1-2：提示词四层强化

参照 Cat Café 的"出口检查 + Q1 短路"模式：

| 层级 | 内容 | 注入位置 |
|------|------|----------|
| 出口检查 | "这条回复发完后，工作流程到我这结束了吗？不是→行首 @对方" | `DEVELOPMENT_RULE`、`REVIEW_RULE` |
| 强制措辞 | "如果**需要** review" → "不管改动大小，**必须** review" | `DEVELOPMENT_RULE` |
| 格式指导 | 正确示例 `@吐槽猫`（行首） vs 错误示例 `请 @吐槽猫 review`（句中无效） | 三个规则集 |
| Q1 短路 | "对方需要采取行动？→ 是 → 直接 @" | 隐含于出口检查中 |

### 前端闪烁光标修复

`typingStates` Map 只在 `AGENT_TYPING` 事件中 set，从未 delete。修复：`NEW_MESSAGE`（agent 完成回复）和 `AGENT_STATUS(slotState='idle')`（超时/中止）时清除。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 在 `socketio.ts` 内联保留 `parseMentionsFromReply` 并用 `__test_` 导出 | 测试需 mock 整个 socketio.ts 的依赖链（DB、Socket.IO、LLM adapter），复杂度高。提取为独立纯函数模块后零依赖即可测试 |
| 保留原来的 `includes()` 宽松匹配 | Agent 回复中的代码注释/文档引用会误触发路由。Cat Café 项目也走过这条路并最终改为行首匹配 |
| 把 @mention 格式改为固定分隔符（如 `---REVIEW---`） | 增加用户认知负担，不如 `@name` 自然。提示词中说明格式要求后，LLM 可以理解并遵守 |
| 在 worklist 层面做强制工作流节点切换（硬编码"写完→必须 review"） | 灵活场景下硬编码工作流过于僵化。Prompt 引导 + 上下文过滤修复是更低成本的方案，且 Cat Café 的四层设计证明 prompt 引导能达到"偶尔漏 @"的可接受状态 |
| @mention 解析中不剥离行内代码 | 测试发现 `\`@吐槽猫\`` 这种行内代码引用会绕过行首正则（在代码块剥离后仍可能存在于纯文本中），增加一层剥离成本极低 |
| 用 `\b` 做词边界 | JavaScript 的 `\w` 不包含中文字符，`\b` 在中文字符边界始终不匹配。改用 `(?=\s\|$)` 适配中文 Agent 名称 |

## 4. Open Questions — 不确定的点

- **行首匹配是否过度严格**：当前设计要求 `@name` 独占一行行首。如果 Agent 写 `✅ @店长 继续`（emoji 前缀），emoji 后的 `@` 不是严格行首，不会触发。当前用提示词引导 Agent 把 @mention 放行首，但如果 LLM 不遵守，会导致漏触发。备选方案：允许行首有非字母字符前缀（如 `^\s*[^\w]*@name`），需要评估是否引入新的误触发

- **上下文过滤新规则是否影响非 review 场景**：当 Agent A 的回复中 `mentions` 包含 Agent B 的名字时，Agent B 就能看到该回复。这在 review 场景中是正确的，但如果 Agent A 在普通讨论中 @mention 了 Agent B 只是提及而非请求行动，Agent B 也会看到。目前确认的是：review 链工作需要这个行为；普通讨论中多看到一条提及自己的消息，影响有限

- **`taskId` 传播是否需要在 server 端做强制性检查**：当前 `taskId` 通过 `triggerMsg.taskId` 传播，依赖 LLM 的行为。如果某次 agent-to-agent dispatch 中 `taskId` 丢失（比如 db 写入了 null），后续 task history 加载就失效。server 端可以在 dispatch 时强制继承 `taskId`，但当前没有做

- **A2A 链全局取消**：当前 `retractionRequests` 只按 `triggerMsg.id` 查找。如果用户在 review 链中间撤回原始消息，后续 agent 不会感知。按 `taskId` 传播撤回信号（P2 建议）需要验证 `taskId` 是否在所有路径上正确传播

## 5. Next Action — 希望做什么

- [ ] 验证 P0 上下文过滤修复：启动 dev 环境，@店长 写代码 → 观察吐槽猫是否能正确看到交接文档内容（观察日志中 `relevantMessages` 字段是否 > 0）
- [ ] 验证 P1 @mention 解析：让 Agent 生成包含代码块 + 行尾 @吐槽猫 的回复，确认只有行首的 @mention 触发路由
- [ ] 修改 `SERVER_AGENT_NAMES` 或环境变量支持从 DB 动态读取 Agent 名称列表（当前 `parseMentionsFromReply` 的 `sessionAgentNames` 来自 DB 查询，需确认与 seed 数据一致）
- [ ] 实现 P2：`retractionRequests` 按 `taskId` 查找，使 A2A 链中撤回能传播到子 agent
- [ ] 评估是否需要 `mentionRoutingFeedback`：Agent @mention 了不存在的猫或被深度限制拦截时，将反馈注入下一次执行的上下文
- [ ] 在真实 DeepSeek 模型上验证提示词改动：出口检查是否真的让 Agent 更频繁 @mention 其他猫（需要运行几次完整对话并统计 agent-to-agent dispatch 频率）

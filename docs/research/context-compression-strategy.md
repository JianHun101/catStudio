# 上下文压缩策略研究

> 研究日期：2026-07-19
> 作者：店长
> 目标：在节省 token 的同时支持更长的连续对话

---

## 一、现状分析

### 1.1 当前上下文构建流程

```
消息入库 → LIMIT 100 + taskId LIMIT 200
         → 消息过滤（按 Agent 维度）
         → 角色映射（user/assistant）+ 前缀包装
         → 拼 system prompt（铁律 + 动态技能 + 向量记忆）
         → 发给 LLM
```

关键文件：

- `packages/server/src/connectors/socketio.ts:720-1074` — `runAgentReply()` 上下文构建主函数
- `packages/server/src/memory/index.ts` — 向量记忆的存储/检索/注入
- `packages/server/src/llm/cli-utils.ts:98-116` — CLI 适配器的 `messagesToPrompt()` 纯文本转换
- `packages/server/src/llm/deepseek.ts:26-151` — DeepSeek HTTP API 适配器
- `packages/server/src/seed-data.ts:42-86` — 铁律（IRON_LAWS）定义

### 1.2 Token 消耗瓶颈（按严重程度排序）

| 瓶颈                   | 位置                     | 浪费原因                                                                                                | 预估占比 |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- | -------- |
| **铁律 system prompt** | `seed-data.ts:42-86`     | 每次 LLM 调用都完整重复，约 800-1200 字符                                                               | ~15%     |
| **旧消息逐字保留**     | `socketio.ts:755-764`    | 超过 50 轮的旧消息对当前对话几乎无价值，但仍占用 token                                                  | ~40%     |
| **角色前缀包装**       | `socketio.ts:854-887`    | 每条消息加 `【某某】说：`、`用户（@了X）对你说：` 前缀，短消息场景下开销占比高                          | ~10%     |
| **向量记忆去重不充分** | `memory/index.ts:76-120` | 仅按余弦距离去重，不检查语义重复，可能注入相似记忆                                                      | ~5%      |
| **无 token 计数**      | 全局                     | 用 `content.length`（字符数）替代 token 计数，误差 3-5 倍（中文每个字 0.5-2 token），无法准确的窗口管理 | N/A      |

### 1.3 现有保护措施

| 措施                    | 类型     | 效果                                    |
| ----------------------- | -------- | --------------------------------------- |
| `LIMIT 100` 消息        | 硬截断   | 粗暴，旧消息直接丢弃而非压缩            |
| `LIMIT 200` taskId 历史 | 硬截断   | 同上                                    |
| 消息过滤（按 @mention） | 维度过滤 | 减少无关 Agent 的消息，但不过滤时间维度 |
| 向量记忆检索 (topK=3)   | 注入     | 跨会话召回，但不压缩当前会话内容        |

**结论：当前系统只有"截断"没有"压缩"。旧消息要么全员保留，要么全部丢弃。**

---

## 二、压缩策略方案

### 策略 A：渐进式摘要（Progressive Summarization）

**思路**：对话超过 N 轮后，将旧消息压缩为摘要，仅保留最近 M 轮原文。

```
┌─────────────────────────────────────────────┐
│ System Prompt（铁律 + 技能 + 记忆）          │
├─────────────────────────────────────────────┤
│ 【对话摘要】（自动生成，持续更新）            │
│   用户和店长讨论了XX项目的上下文压缩方案。     │
│   关键决策：采用渐进摘要 + Token 窗口混合。   │
│   待办：实现 tiktoken 计数。                  │
├─────────────────────────────────────────────┤
│ 第 97 轮：用户说"..."（原文）                │
│ 第 98 轮：店长说"..."（原文）                │
│ 第 99 轮：服务员说"..."（原文）               │
│ 第 100 轮：用户说"..."（原文）← 当前          │
└─────────────────────────────────────────────┘
```

**实现要点**：

1. 新增 `conversation_summaries` 表，按 session 维度存储
2. 每 K 轮（建议 20 轮）触发摘要更新：用 LLM 将新完成的 K 轮合并到旧摘要
3. 注入位置：system prompt 之后、消息历史之前
4. 摘要提示词设计：
   - 保留关键决策、未完成事项、用户偏好
   - 丢弃闲聊、重复确认、已解决的问题
   - 用 3-5 句话概括每段

**优点**：渐进式、不丢信息、摘要质量可控
**缺点**：额外 LLM 调用成本（但可复用便宜模型）；首次实现复杂

### 策略 B：Token 感知滑动窗口（Token-Aware Sliding Window）

**思路**：根据实际 token 计数动态调整窗口大小，而非硬编码 LIMIT 100。

```
设定 MAX_CONTEXT_TOKENS = 8000

for 每条消息（从新到旧）:
    tokens = countTokens(message)
    if totalTokens + tokens > MAX_CONTEXT_TOKENS:
        break  // 停止添加
    prepend(message)
```

**实现要点**：

1. 引入 token 计数：对 CLI 适配器用字符估算，对 DeepSeek HTTP 适配器用 tiktoken
   - 字符估算公式：`chineseChars * 0.75 + nonChinese * 0.25`（±15% 精度，配合 70% 安全余量）
   - Claude CLI 必须用字符估算——Anthropic tokenizer 与 tiktoken 不兼容，用错比不计数更危险
2. 新增 `MAX_CONTEXT_TOKENS` 环境变量，默认 6000
3. 倒序累加消息 token 直到超限
4. 边界处理：至少保留最后一条用户消息（避免没有上下文）

**优点**：实现简单、无额外 LLM 调用、跨模型通用
**缺点**：旧消息直接丢弃（同现状）、不区分消息重要性

### 策略 C：语义选择窗口（Semantic Selection）

**思路**：不用时间窗口，用向量相似度选择与当前话题最相关的消息。

```
用户新消息 → embedText()
          → 与历史消息的 embedding 做 cosine 相似度
          → 选 top-K 最相关 + 最近 N 条
          → 按时间排序后发送
```

**实现要点**：

1. 消息入库时异步生成 embedding（复用现有 `embedText()`）
2. `messages` 表新增 `embedding BLOB` 列
3. 检索时：取最近 N 条 + 向量检索 top-M 条，合并去重排序
4. 配置项：`CONTEXT_RECENT_N`（默认 20）、`CONTEXT_SEMANTIC_M`（默认 10）

**优点**：跨时间窗口召回相关信息、"大海捞针"能力强
**缺点**：每条消息都要 embed（存储 + 计算成本）；可能丢失时序逻辑

### 策略 D：混合方案（推荐）

**思路**：组合策略 A + B + C 的优点。

```
┌──────────────────────────────────────────────┐
│ Layer 1: System Prompt (铁律 + 技能)          │  ~1000 tokens
├──────────────────────────────────────────────┤
│ Layer 2: 渐进摘要 (A)                         │  ~500 tokens
│   - 跨会话记忆（向量检索）                    │
│   - 当前会话历史摘要（超过窗口部分）           │
├──────────────────────────────────────────────┤
│ Layer 3: Token 窗口原文 (B)                   │  ~4000 tokens
│   - 最近 N 条消息原文                         │
│   - 按 token 预算动态截断                     │
├──────────────────────────────────────────────┤
│ Layer 4: 语义召回 (C, 可选)                   │  ~500 tokens
│   - 当前话题相关但超出窗口的旧消息             │
├──────────────────────────────────────────────┤
│ Total budget: ~6000 tokens                    │
└──────────────────────────────────────────────┘
```

**相比纯截断的预期节省**：

| 场景             | 当前 (LIMIT 100)     | 混合方案                 | 节省           |
| ---------------- | -------------------- | ------------------------ | -------------- |
| 短对话 (<20 轮)  | ~2000 tokens         | ~2000 tokens             | 0%（无需压缩） |
| 中对话 (50 轮)   | ~5000 tokens         | ~3500 tokens             | ~30%           |
| 长对话 (100+ 轮) | ~8000+ tokens (截断) | ~5500 tokens (摘要+窗口) | ~30%+          |

---

## 三、推荐实施路径

### 阶段一：Token 计数基础（优先级最高，1-2 天）

这是所有后续策略的基础，没有它就无法做任何精确的窗口管理。

**任务**：

1. 在 `packages/shared/src/` 新增 `token-counter.ts`
   - 对 HTTP 适配器（DeepSeek）：用 `tiktoken` 或 DeepSeek 兼容的 tokenizer
   - 对 CLI 适配器（Claude/Codex）：用字符估算 `Math.ceil(chineseChars * 0.75 + nonChinese * 0.25)`
   - 导出 `countTokens(text: string): number` 和 `countMessagesTokens(messages: LLMMessage[]): number`
2. 替换 `socketio.ts:895` 和 `socketio.ts:998` 中的 `content.length` 为 `countTokens()`
3. 新增环境变量：`MAX_CONTEXT_TOKENS`（默认 6000）、`CONTEXT_TOKEN_WARN_THRESHOLD`（默认 0.8）

### 阶段二：Token 感知滑动窗口（优先级高，2-3 天）

在 token 计数基础上实现最基本的窗口管理。

**任务**：

1. 新增 `packages/server/src/context/window.ts`
   - `buildTokenWindow(messages, maxTokens): LLMMessage[]` — 倒序遍历，累加 token，截断
   - 保证最后一条用户消息不被截断（`MIN_KEEP_LAST = 1`）
2. 在 `runAgentReply()` 中，消息过滤后、角色映射前调用
3. 日志记录截断信息（截断了多少条、节省了多少 token）

### 阶段三：渐进摘要（优先级中，3-5 天）

**任务**：

1. 新增 `conversation_summaries` 表：
   ```sql
   CREATE TABLE conversation_summaries (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     summary_text TEXT NOT NULL,
     covered_until_message_id TEXT,  -- 摘要覆盖到哪条消息
     token_count INTEGER,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     FOREIGN KEY (session_id) REFERENCES sessions(id)
   );
   ```
2. 新增 `packages/server/src/context/summarizer.ts`
   - `summarizeMessages(messages, existingSummary?): string` — 调用 LLM 生成摘要
   - `incrementalSummarize(sessionId, newMessages): void` — 增量更新摘要
   - 使用便宜模型（如 deepseek-chat）做摘要，降低额外成本
3. 摘要触发条件：每 20 轮或累计 token 超过阈值
4. 注入位置：在 `llmMessages` 中 system prompt 后添加 `{role: 'system', content: '【对话摘要】...'}`

### 阶段四：语义选择增强（优先级低，可选）

在前三个阶段稳定后，作为锦上添花。

---

### 各阶段验收标准

每个阶段完成后必须验证，不能靠感觉。

| 阶段   | 验收项         | 判定标准                                                                                |
| ------ | -------------- | --------------------------------------------------------------------------------------- |
| 阶段一 | Token 计数精度 | 取 10 次真实 LLM 调用的 `usage.prompt_tokens` 与 `countTokens()` 估算值对比，偏差 < 15% |
| 阶段一 | 边界情况覆盖   | 纯中文、纯英文、中英混合、纯代码块、emoji、空字符串——全部有单元测试                     |
| 阶段二 | Token 节省效果 | 50+ 轮对话 token 消耗相比改造前减少 20%+，`socketio.ts` 日志可查                        |
| 阶段二 | 功能无回归     | 现有测试全部通过；手动验证多 Agent @mention 场景（至少 3 个 Agent 交替对话）            |
| 阶段三 | 摘要质量       | 人工抽查 10 个样本，关键信息保留率 > 90%（决策、待办、偏好不丢失）                      |
| 阶段三 | 摘要成本       | 摘要 LLM 调用成本不超过主对话成本的 5%                                                  |

### 测试策略

`token-counter.ts` 必须覆盖的边界：

| 场景          | 示例                       | 断言                                |
| ------------- | -------------------------- | ----------------------------------- |
| 纯中文        | "你好世界"                 | > 0 且 < `text.length`              |
| 纯英文        | "hello world"              | > 0 且 < `text.length`              |
| 中英混合      | "我叫店长，a siamese cat"  | 中文部分贡献比例更大                |
| 空字符串      | ""                         | 返回 0                              |
| 纯代码块      | ` ```js\nconst x=1;\n``` ` | 不应崩溃（代码中可能混有中文注释）  |
| emoji         | "好的👍没问题🎉"           | emoji 算 1 token 左右，不应估算为 0 |
| 超长消息      | 10000 字符                 | 不应 OOM，执行时间 < 10ms           |
| 只有标点/空白 | " \n\n"                    | 返回 0 或极小值                     |

阶段二窗口截断后，还需额外验证：**多 Agent @mention 场景下，窗口截断是否会导致某条被 @mention 的消息丢失，使后续回复缺少上下文**。当前消息过滤基于 `mentions` 字段，不依赖消息顺序，但需确认截断后 Agent 仍能看到自己被 @ 的完整上下文。

---

## 四、风险与注意事项

| 风险                               | 缓解措施                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| **摘要丢失关键信息**               | 摘要 prompt 明确要求保留决策、待办、偏好；可配置摘要详细程度                       |
| **摘要 LLM 调用成本**              | 使用便宜模型（deepseek-chat）；每 20 轮才触发一次；摘要缓存复用                    |
| **Token 计数不准确（CLI 适配器）** | 接受估算误差（±20%），在阈值上留余量（如 `MAX_CONTEXT_TOKENS` 设为实际限制的 70%） |
| **摘要与向量记忆重复**             | 摘要侧重"时序"，记忆侧重"语义"；摘要不含跨会话内容                                 |
| **多 Agent 场景摘要归属**          | 按 session 维度存一份共享摘要，不按 Agent 切分（降低复杂度）                       |

---

## 五、配置项设计

```bash
# .env 新增配置
MAX_CONTEXT_TOKENS=6000           # 上下文窗口 token 上限
SUMMARIZE_ENABLED=true            # 是否启用渐进摘要
SUMMARIZE_INTERVAL_ROUNDS=20      # 每 N 轮触发一次摘要
SUMMARIZE_MODEL=deepseek-chat     # 摘要用模型（应比主模型便宜）
SUMMARIZE_MAX_TOKENS=500          # 摘要文本长度上限
CONTEXT_WINDOW_RECENT=30          # 窗口内保留原文的最近轮数
CONTEXT_SEMANTIC_RECALL=0         # 语义召回额外条数（0=关闭）
```

---

## 六、未决问题

1. **摘要用哪个模型？** — 当前所有 Agent 都用 `deepseek-v4-pro`，摘要不需要这么强的模型，`deepseek-chat` 足够。但需要在 adapter 层面支持摘要专用模型配置。

2. **摘要何时触发？** — 逐条触发太频繁，每 N 轮触发可能在"刚好需要摘要"的时候造成延迟。可考虑异步触发 + 上次摘要缓存。

3. **CLI 适配器的 messagesToPrompt 如何适配压缩？** — 当前 `messagesToPrompt()` 直接拼接所有消息。压缩后需要新增摘要注入点。

4. **是否需要前端展示摘要？** — 用户可能想知道"系统看到了什么"，但摘要主要是技术优化，不需要展示。

5. **窗口截断后 @mention 过滤逻辑是否会受影响？** — 当前过滤基于 `mentions` 字段和 `agentName`，不依赖消息顺序。但如果窗口截断了某条被 @mention 的消息，后续回复可能缺少上下文。需要在窗口实现时验证多 Agent 交替对话场景（已纳入阶段二验收标准）。

6. **阶段三摘要异步触发的竞态问题** — 摘要生成需要 LLM 调用（秒级延迟），如果摘要还没生成完下一条消息就来了，是等还是跳过？等会阻塞对话，跳过会导致摘要覆盖不全。建议阶段三设计时优先考虑：生成期间用旧摘要缓存，完成后原子替换。

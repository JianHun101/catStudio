# CatStudy 向量记忆检索实现与适配器端到端验证

## 1. What — 具体改动

| 文件                                         | 改动                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types.ts`               | 已存在 — `MemoryEntry` 接口（`id`, `agentId`, `content`, `embedding: number[]`, `sourceMessageId`, `createdAt`），本次未修改                                                                                                                                                                                                    |
| `packages/shared/src/schemas.ts`             | 已存在 — `EmbeddingConfigSchema`（`provider`, `model`, `apiKey`, `baseUrl`），本次未修改                                                                                                                                                                                                                                        |
| `packages/server/src/db/index.ts`            | 修改，导入 `sqlite-vec` 并在 `initDb()` 中调用 `sqliteVec.load(db)` 注册向量函数（`vec_distance_cosine` 等）                                                                                                                                                                                                                    |
| `packages/server/src/memory/embedding.ts`    | 新建，本地嵌入模块。动态 import `@huggingface/transformers` → `pipeline('feature-extraction')` 加载 `Xenova/bge-small-zh-v1.5`（512 维中文模型），惰性单例 + 首次下载后缓存。暴露 `embedText(text: string): Promise<number[]>` 和 `isMemoryEnabled()`                                                                           |
| `packages/server/src/memory/index.ts`        | 新建，记忆服务。`saveMessageMemory()`（用户消息 → 嵌入 → BLOB 写入 `memories` 表，每 Agent 一行）、`searchMemories()`（sqlite-vec `vec_distance_cosine` 余弦相似度搜索 top-K）、`buildMemoryContext()`（检索结果格式化为 system prompt 文本块）。辅助函数 `vectorToBlob()`/`blobToVector()`（number[] ↔ Float32Array ↔ Buffer） |
| `packages/server/src/llm/openai.ts`          | 修改，Codex CLI 适配器编码修复。Windows 下 PowerShell 管道中文 UTF-8 编码问题经多种方案尝试（临时文件 + `Get-Content -Encoding UTF8`、`cmd.exe type` 管道、直接传参），最终还原为原始方案                                                                                                                                       |
| `packages/server/src/connectors/socketio.ts` | 修改，两处注入 + 超时保护。注入点 A（第 128 行后）：用户消息写入后调用 `saveMessageMemory()`，异步不阻塞；注入点 B（`runAgentReply` 中 `llmMessages` 构建后）：`Promise.race(buildMemoryContext(), 10s timeout)` → 匹配记忆注入 `llmMessages[0].content`。超时或失败时静默跳过，不影响 LLM 回复                                 |
| `packages/server/src/index.ts`               | 修改，入口处设置 `process.env.HF_ENDPOINT = 'https://hf-mirror.com'`（HuggingFace 镜像，解决中国大陆模型下载问题）                                                                                                                                                                                                              |
| `packages/server/package.json`               | 修改，新增 `sqlite-vec`、`@huggingface/transformers`、`sharp` 三个依赖                                                                                                                                                                                                                                                          |
| `pnpm-workspace.yaml`                        | 修改，`allowBuilds` 新增 `sqlite-vec: true`、`protobufjs: true`、`sharp: true`、`onnxruntime-node: true`                                                                                                                                                                                                                        |
| `CONTEXT.md`                                 | 修改，领域模型整理。Memory 定义收紧（移除实现细节）、Memory Retrieval 移除（合并进 Memory）、Embedding（嵌入向量）新增为独立术语                                                                                                                                                                                                |

## 2. Why — 为什么这样做

### 三层适配器端到端验证

本轮首先对上一轮构建的三个 LLM 适配器执行了完整的端到端测试（Socket.IO 连接 → 消息发送 → dispatch → LLM 推理 → 流式输出 → 消息落库），验证了每条链路的真实可用性：

```
适配器    │ 驱动方式       │ 延迟     │ 中文  │ 状态
──────────┼────────────────┼──────────┼───────┼──────
deepseek  │ HTTP fetch     │ 2.6s     │ ✅    │ 主力方案
claude    │ spawn CLI      │ 4.3s     │ ✅    │ 备选
openai    │ spawn CLI      │ 6.0s     │ ❌    │ 实验（Windows 中文编码待解决）
```

DeepSeek HTTP 适配器是明确的主力方案：延迟低、零额外依赖、中文完美。Claude Code CLI 适配器额外开销 1.6s（spawn + system prompt 21K tokens），角色风格准确（"本店长叫阿暹，暹罗猫的暹，记住了喵~"）。Codex CLI 适配器基础连通性 OK（英文 prompt 正常），但 Windows PowerShell `$input | & codex.cmd` 管道对 UTF-8 中文编码转换有问题，经 `Get-Content -Encoding UTF8` + 临时文件、`cmd.exe type` 管道、直接传参三种方案尝试均未完全解决，保留原始实现待后续专项处理。

### 本地嵌入模型抉择

实现记忆检索的第一步是选嵌入方案。本轮首先尝试了 DeepSeek embedding API：

```
POST https://api.deepseek.com/v1/embeddings  → 404
GET  https://api.deepseek.com/v1/models      → 只有 deepseek-v4-pro/flash
```

DeepSeek 不提供 embedding 端点。转而尝试 `@xenova/transformers` v2.17.2 → sharp@0.32.0 原生二进制缺失 → 升级到 `@huggingface/transformers` v4.2.0 + sharp@0.33.5 + onnxruntime-node，所有原生模块安装成功。模型选用 `Xenova/bge-small-zh-v1.5`（512 维，中文优化，~100MB 首次下载后缓存），比通用英文模型（`all-MiniLM-L6-v2` 384 维）更适合本项目的中文对话场景。

核心设计决策：

- **本地模型而非 API**：零网络成本、离线可用、无 rate limit
- **全局独立配置**：Embedding 模型与 LLM 供应商解耦（ADR 0006），所有 Agent 共享同一向量空间
- **惰性加载 + 单例**：模型只在首次 `embedText()` 调用时下载加载，不阻塞服务启动；pipeline 实例全局复用
- **降级优先**：嵌入失败 → 静默跳过 → LLM 正常回复。记忆功能是增强，不是依赖

### 记忆生命周期

```
用户发消息 → socketio.ts SEND_MESSAGE handler
  ├─ [存储] saveMessageMemory() — 即发即弃
  │     → embedText(content) → Float32Array → BLOB → INSERT memories (每 Agent 一行)
  │
  └─ [调度] dispatch() → executeAgentsSerial()
        └─ runAgentReply()
              ├─ buildMemoryContext() — 10s 超时
              │     → embedText(triggerMsg.content)
              │     → vec_distance_cosine(embedding, query_blob) → top-3
              │     → 格式化为 【相关记忆】\n{CITATION_MARKER_INSTRUCTION}\n1. xxx\n2. yyy
              │
              ├─ llmMessages[0].content += memoryContext  (注入 system prompt)
              └─ adapter.chatStream(llmMessages)
```

**存储**是"即发即弃"的——失败只记日志，不阻塞消息流。**检索**有 10 秒超时保护——嵌入模型首次下载可能耗时较长（模型 ~100MB），`Promise.race` 确保超时后 LLM 正常回复，不带记忆上下文。

### 记忆上下文注入位置

将检索到的记忆拼接到 system prompt（而非 user/assistant 消息）的理由：

- System prompt 是 Agent 的"背景知识"，记忆本质上是 Agent 对过往对话的认知
- 不改变对话结构——Agent 仍然看到"用户说 X → 我回复 Y"，不会把记忆误认为对话内容
- 与 broadcast 模式下的 `【名字】说：` 格式隔离——记忆是 agent 自己的认知，不是其他猫的发言

### 领域模型整理

Memory 和 Memory Retrieval 两个条目严重重叠——前者描述"是什么"的同时混入了检索流程，后者完全重复了检索逻辑。本轮：

- Memory 收紧为："一条持久化记录，以嵌入向量形式存储"——只定义是什么
- Memory Retrieval 移除——检索过程是 Memory 的固有行为，不是独立概念
- Embedding 新增——"全局独立配置的本地模型生成，与 LLM 供应商解耦"是该项目的关键设计特征

## 3. Tradeoff — 放弃了什么方案

| 放弃                                       | 原因                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek embedding API（`/v1/embeddings`） | 返回 404，DeepSeek 只提供 chat 模型无 embedding 端点                                                                                                                        |
| `@xenova/transformers` v2.x                | 依赖 sharp@0.32.0，该版本在 Windows 中文用户路径下原生二进制构建失败。v4.2.0 + sharp@0.33.5 预构建二进制正常                                                                |
| Codex CLI 中文编码全面修复                 | 三种方案（PowerShell UTF-8 编码设置、临时文件 + `Get-Content`、`cmd.exe type` 管道）均未完全解决。根因是 Windows 下 `codex.cmd` 的 stdin 管道编码行为不稳定，保留为已知限制 |
| 记忆检索用 FTS5 全文搜索替代向量           | ADR 0006 已排除——FTS5 缺乏语义理解（"寿司"匹配不到"生鱼片"），对中文自然语言效果差                                                                                          |
| 嵌入模型用 `all-MiniLM-L6-v2`（英文）      | 384 维英文模型对中文语义匹配效果弱。`bge-small-zh-v1.5` 512 维专门为中文优化                                                                                                |
| 记忆上下文注入 user 消息而非 system prompt | 会改变对话结构，Agent 可能把记忆误认为用户发言。system prompt 是语义上正确的"背景知识"位置                                                                                  |
| 不设检索超时                               | 嵌入模型首次下载 ~100MB 可能耗时数分钟，无限等待会阻塞所有 Agent 回复                                                                                                       |

## 4. Open Questions — 不确定的点

- **HuggingFace 模型下载网络可达性**：`hf-mirror.com` 主页可达(200)，但 ONNX 模型文件的解析/下载在 `@huggingface/transformers` 内部 `fetch` 调用中失败。当前通过 10s 超时保护兜底——LLM 不带记忆正常回复。模型文件约 100MB，首次下载后本地缓存（`~/.cache/huggingface/`），后续启动无需网络。如果该网络环境长期无法下载，需考虑手动下载模型文件并配置 `localModelPath`
- **嵌入维度一致性**：当前硬编码 `bge-small-zh-v1.5`（512 维）。如果将来切换嵌入模型，旧记忆的向量维度不匹配，`vec_distance_cosine` 会报错。本版未做版本检测，假设模型固定不变
- **记忆膨胀**：当前每条用户消息都存储为一条记忆，无去重或合并逻辑。同一话题的多次发言会产生高度相似的冗余记忆。后续可考虑相似度阈值过滤——如果新消息与已有记忆的余弦距离 < 阈值，跳过存储或更新旧记忆
- **记忆检索的 Agent 隔离**：当前检索只按 `agent_id` 过滤——Agent A 看不到 Agent B 的记忆。但如果用户跟店长聊过"日料"后又跟服务员聊"寿司"，服务员的记忆库中没有相关条目。跨 Agent 记忆共享是否有价值？目前保持隔离，符合"每只猫有自己的记忆"的直觉
- **`sharp@0.33.5` 版本锁定**：`@huggingface/transformers` 的图片处理依赖 sharp，本项目只用文本嵌入。sharp 是间接依赖（由 transformers 引入），版本由 pnpm lockfile 锁定。如果 transformers 升级后不再需要 sharp，应及时移除

## 5. Next Action — 希望做什么

- 在可访问 HuggingFace 的网络环境中启动服务端，完成模型首次下载并缓存在本地，之后该环境即可离线运行
- 手动下载 `Xenova/bge-small-zh-v1.5` 的 ONNX 模型文件（`model.onnx` + `tokenizer.json` + `config.json`），放入 `~/.cache/huggingface/` 目录，绕过自动下载
- 测试记忆检索的全链路效果：发送偏好消息 → 确认记忆写入 `memories` 表 → 发送相关但不同措辞的查询 → 验证 Agent 回复引用了之前的偏好
- 为记忆存储加入重复检测——新消息与已有记忆的余弦距离 < 阈值时跳过存储；同一消息的变体重述（"我喜欢寿司" vs "我爱吃刺身"）应更新而非新增
- 考虑在 Agent 编辑弹窗中显示记忆统计（条数、最近更新时间），让用户感知记忆系统的工作状态
- ✅ ~~DeepSeek HTTP 适配器端到端验证~~（完成：全链路 2.6s 延迟，流式输出正常）
- ✅ ~~Claude Code CLI 适配器端到端验证~~（完成：spawn + NDJSON 解析正常，角色风格准确）
- ✅ ~~`sqlite-vec` 扩展加载~~（完成：`sqliteVec.load(db)` 在 `initDb()` 中注册向量函数）
- ✅ ~~领域术语表整理~~（完成：Memory 收紧、Memory Retrieval 移除、Embedding 新增）

# ADR 0006: 向量检索记忆系统

> **实现现状**：Embedding 实际使用本地 Transformers.js 模型（`Xenova/bge-small-zh-v1.5`，512 维），非外部 API。模型可通过 `MEMORY_EMBEDDING_MODEL` 环境变量更换，通过 `HF_ENDPOINT` 切换下载镜像。检索时机为 Agent 被调度回复时（`buildMemoryContext()`），非用户发言后立即触发。

Agent 记忆采用 embedding 向量检索而非全文搜索（FTS5）或纯摘要方案。Agent 被调度回复时触发检索：消息 → embedding 向量 → 余弦相似度搜索 `memories` 表 → top-K 相关记忆注入推理 prompt。

## Considered Options

- **全文搜索（SQLite FTS5）**：零 API 成本，关键词匹配。但"那家寿司店"匹配不到"筑地市场的铃木寿司"——缺乏语义理解，对中文自然语言效果差。
- **纯摘要记忆**：定期将对话要点合并成摘要文本。无需 embedding 但检索粒度粗——要么全量注入（吃 token），要么依赖关键词命中（不准）。
- **向量检索**（选中）：语义匹配，对变体表达（"好吃的日本料理" ↔ "寿司"）有效。代价是依赖 embedding API 和 sqlite-vec 扩展。

## Consequences

- 引入 sqlite-vec 原生扩展——需要在安装时编译 Node.js 原生模块。
- Embedding 由本地模型在进程内生成（Transformers.js），与 LLM 供应商解耦。确保所有记忆向量维度一致（512 维），跨 Agent 记忆可检索。

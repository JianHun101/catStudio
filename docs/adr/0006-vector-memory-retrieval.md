# ADR 0006: 向量检索记忆系统

Agent 记忆采用 embedding 向量检索而非全文搜索（FTS5）或纯摘要方案。用户每次发言后触发检索：消息 → embedding 向量 → 余弦相似度搜索 `memories` 表 → top-K 相关记忆注入推理 prompt。

## Considered Options

- **全文搜索（SQLite FTS5）**：零 API 成本，关键词匹配。但"那家寿司店"匹配不到"筑地市场的铃木寿司"——缺乏语义理解，对中文自然语言效果差。
- **纯摘要记忆**：定期将对话要点合并成摘要文本。无需 embedding 但检索粒度粗——要么全量注入（吃 token），要么依赖关键词命中（不准）。
- **向量检索**（选中）：语义匹配，对变体表达（"好吃的日本料理" ↔ "寿司"）有效。代价是依赖 embedding API 和 sqlite-vec 扩展。

## Consequences

- 引入 sqlite-vec 原生扩展——需要在安装时编译 Node.js 原生模块。
- Embedding 供应商全局独立配置，与 LLM 供应商解耦。确保所有记忆向量维度一致，跨 Agent 记忆可检索。

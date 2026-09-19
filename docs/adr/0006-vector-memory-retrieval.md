---
type: decision
date: 2026-07-13
status: accepted
evidence:
  - kind: file
    ref: packages/server/src/memory/index.ts
  - kind: file
    ref: packages/server/src/db/repository/chunks.ts
  - kind: file
    ref: scripts/flywheel/embed-server.mjs
---

# ADR 0006: 向量检索记忆系统

> **实现现状（2026-09-19 核验重写，**本条是本 ADR 的主链变更注**）**：**「向量检索 vs FTS5 vs 纯摘要」这条选型决策原样成立**（向量 + 关键词 RRF 混合检索，`chunks.ts:468`；sqlite-vec + cosine，512 维）。以下三处与正文不同：
>
> 1. **检索引擎换链**：原主链（对话原话实时嵌入 `memories` 表）**已整体退役**——写口与 `memories` 表双删（migration `drop memories chain tables`）。现检索语料是**白名单 MD 文档**（`docs/adr/` `docs/lessons/` `docs/plans/`，`scan.mjs:60`）的切片，进 `chunks` 三表；**MD 是唯一写入口**。正文「消息 → 向量 → 搜索 `memories` 表 → top-K 注入」这句描述的管线已不存在，**不要照它找 `memories`**。
> 2. **入口与时机**：检索入口为 `retrieveMemoryContext()`（`memory/index.ts`，正文与旧注写的 `buildMemoryContext()` **已不存在**）。检索时机**不变**——仍是 Agent 被调度回复时（`execution/reply.ts:755`），非用户发言后立即触发。
> 3. **Embedding 落在独立进程**：模型仍是本地 Transformers.js（`Xenova/bge-small-zh-v1.5`，512 维），可经 `MEMORY_EMBEDDING_MODEL` 更换、`HF_ENDPOINT` 切换镜像；但**跑在独立 sidecar 进程**（`scripts/flywheel/embed-server.mjs`，随 server 启停、只监听 `127.0.0.1`，主进程经 HTTP 调用）——正文 Consequences 里「Embedding 由本地模型**在进程内**生成」已失实，模型不进主进程内存。

Agent 记忆采用 embedding 向量检索而非全文搜索（FTS5）或纯摘要方案。Agent 被调度回复时触发检索：消息 → embedding 向量 → 余弦相似度搜索 `memories` 表 → top-K 相关记忆注入推理 prompt。

## Considered Options

- **全文搜索（SQLite FTS5）**：零 API 成本，关键词匹配。但"那家寿司店"匹配不到"筑地市场的铃木寿司"——缺乏语义理解，对中文自然语言效果差。
- **纯摘要记忆**：定期将对话要点合并成摘要文本。无需 embedding 但检索粒度粗——要么全量注入（吃 token），要么依赖关键词命中（不准）。
- **向量检索**（选中）：语义匹配，对变体表达（"好吃的日本料理" ↔ "寿司"）有效。代价是依赖 embedding API 和 sqlite-vec 扩展。

## Consequences

- 引入 sqlite-vec 原生扩展——需要在安装时编译 Node.js 原生模块。
- Embedding 由本地模型在进程内生成（Transformers.js），与 LLM 供应商解耦。确保所有记忆向量维度一致（512 维），跨 Agent 记忆可检索。

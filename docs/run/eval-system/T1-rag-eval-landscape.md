<!-- wayfinder:research (AFK) -->
<!-- parent: map.md -->

# T1 RAG 检索评估生态与落地路径

Claimed by: ds猫
Blocked by: —

## Question

记忆库的**召回率 / 精确率今天算不出来**——不是算法问题，是缺两样：检索埋点不落库、全仓零标注集/评测 fixture。
（现状补充：RRF 融合分在出口被丢弃；纯关键词命中用哨兵距离冒充距离。）

调研市面成熟的 RAG 评估开源件，回答三件事：

1. **指标语义分档**：`context_recall` / `context_precision` / hit-rate / MRR / NDCG / faithfulness / answer-relevancy 这些指标，**哪些必须有 ground truth、哪些无标注可算**？重点标出「立刻能用上的那批」。
2. **候选件对账**：RAGAS / DeepEval / TruLens / continuous-eval / Arize Phoenix evals 及其他你认为该看的——许可证、维护活跃度、自托管成本、**能否旁路跑**。
   硬约束：我们是 **TS/Node + SQLite + 本地 `bge-small-zh-v1.5`（512 维）**。评估若走 Python，必须能读同一份 SQLite 或导出 JSONL 离线批处理；若某件只能 SaaS 托管，明说。
3. **最省力落点**：要拿到「记忆库召回率/精确率 + 改动前后对比」，我们**最少**新增什么——依赖、标注量估算（几条 query 起才有统计意义）、埋点必须落哪些字段。

## Verification

- 候选件的能力断言须给**出处**（官方文档 / 仓库 README / 实测版本号），注明信息日期；查不到就写「未证实」，不许用印象填
- 「必须标注 / 无标注可算」这一分类是本文的核心结论，须逐条给出依据
- 结论要能直接回答「我们下一步该动哪张表、加哪个依赖」

## Resolution

**资产**：[RAG 检索评估：生态对账与最省力落点](research-rag-eval.md)（401 行；53 条出处 URL；14 处显式「未证实」标记）
**状态**：已解（2026-09-13，ds猫）

### 三条结论

**1. 我们问错了名字——「召回率/精确率」在 RAG 圈有两个所指，选错一个会白做。**
IR 口径 `recall@k`/`precision@k`（给定相关性标注，纯集合运算，回答「检索器找没找对」）vs RAGAS 口径 `context_recall`/`context_precision`（LLM 数事实覆盖，回答「内容够不够回答」，**不知道库里有哪些文档**）。我们要「记忆库哪里可以优化」⇒ 需要**前者**。
补充打击面：RAGAS 的 `context_precision` 其实是 **Average Precision**（rank-aware），不是 IR precision@k；且该名字在 RAGAS 版本间**语义漂移过**（≤0.1 的 reference-free 版在 ≥0.2 被改名为 `context_utilization`）。

**2. 不加任何依赖——而且不是偏好，是排除。**
对账 **13 件**外部工具（RAGAS / DeepEval / Phoenix / TruLens / continuous-eval / Opik / Langfuse / promptfoo / LlamaIndex / Giskard / RAGChecker / autoevals + 社区 TS 包）后：**没有一件提供 IR 口径的检索指标**。Langfuse 官方明说没有内置 Precision@K/Recall@K（discussion #5215）；其余各家的「context precision/recall」**全部要求参考答案**。
最强的反面候选是 **DeepEval 官方 TS 端口**（Apache-2.0、v0.9.15、高频维护、Vitest 原生）——它本可推翻「TS 生态不成熟」的论断，但它的检索指标要 `expected_output`。**排除它是因为口径，与维护度/许可证/语言都无关。**
两条顺带风险：`Arize Phoenix evals` 是 **Elastic-2.0**（非 OSI 开源）；Opik ~10 容器、Langfuse 6 容器 + 强制 ClickHouse。

**3. 起步量：100–150 条 query，人工成本可压到 ~1 小时。**
配对设计（同一批 query 跑改前/改后）公式 `n = 7.85·σ_d²/Δ²`，检测 10pp 差异：σ_d=0.30 → 71 条；非配对则要 293 条/组（已发表算例）。**必须先用 30–50 条小样本试跑估 σ_d**——没有万能 N（Sakai）。n<30 的读数 ±17pp，没有分辨力。
人工压到近零的两条路：**合成查询自举**（从 117 个节反向生成 query，真值由构造保证）+ **真实 query + LLM 判官**（117 节的语料小到两段式判定只需 100×30 = 3000 次，UMBRELA 已被 TREC 2024 全部 301 topic 实际采用）。**人工锚 20–30 条必留**，用来量判官可信度（用 Cohen's κ）。

### 对本仓库的直接落点

- **动哪张表**：新增 `retrieval_events`（一行 = 一次检索的一条候选）。三处必须一次做对：① 纯关键词命中的 `distance` 写 **NULL** 不写哨兵；② `rank`/`rrf_score` 必须在 `chunks.ts:404-407` 出口前取出（那里是唯一存在处）；③ 身份键用 `(doc_path, section_anchor, content_hash)` 三元组，**不用 `chunks.id`**。
- **加哪个依赖**：**零**。IR 指标纯数学；LLM 判官复用 `eval/scorer.ts`；离线批跑照抄 `eval/phase0.ts` 双形态。
- **评测集放哪**：**进 git**（它是定义指标的真值资产，静默变化会让全部历史对比失效）；运行报告走已 gitignore 的 `data/eval/`。

### 两个改变指标定义形态的本地实测发现

1. `MEMORY_TOP_K` 默认 **3** ⇒ 节级 precision 只能取 {0, 1/3, 2/3, 1}，**评测必须在可配置 K 上跑**，不能拿生产 K=3 当输入。
2. 注入单位是**节**不是片 ⇒ 指标分母单位应当是节（`doc_path`+`section_anchor`），这也顺带缓解 `content_hash` 重扫漂移。

### 留给后续的线头

- **eRAG**（arXiv 2404.13781）：用下游任务真值给检索结果打相关性标签，无人工标注却锚在真值上 —— **我们的 L4 episode 就是那个下游真值**，是把既有资产接进检索评估的桥，建议第 3 步试。
- 未证实项 14 条已逐条登记在资产 §5（含 Phoenix/Opik/Langfuse 确切版本、continuous-eval 休眠日期、Giskard `ee/LICENSE` 条款），**均不影响本期选型**。
- Python 侧若将来要做**生成质量**（非检索质量）评估：TS 侧首选 `deepeval` npm，Python 侧注意 **RAGAS 已停更约 8 个月**（v0.4.3 / 2026-01-13，Snyk 评 INACTIVE）。

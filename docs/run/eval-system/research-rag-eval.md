# RAG 检索评估：生态对账与最省力落点

<!-- wayfinder:research asset · parent: T1-rag-eval-landscape.md -->
<!-- 调研日期: 2026-09-13 -->

**事实分级**（全文每个断言都带一个）：
**【实测】** = 本仓库代码/数据实证，附 `文件:行号`；**【出处】** = 外部来源附 URL；**【未证实】** = 查不到，留空不填印象。

---

## 0. 结论先行

**① 我们问错了名字——「召回率/精确率」在 RAG 圈有两个所指，选错一个会白做。**

|                        | IR 口径 `recall@k` / `precision@k`       | RAGAS 口径 `context_recall` / `context_precision` |
| ---------------------- | ---------------------------------------- | ------------------------------------------------- |
| 怎么算                 | 给定「哪些节相关」的标注，**纯集合运算** | LLM 把参考答案拆成事实，数检索文本覆盖了几条      |
| 回答什么               | 检索器**找没找对该文档**                 | 检索到的**内容够不够回答**                        |
| 能告诉你「漏了哪篇」吗 | **能**                                   | **不能**（它不知道库里有哪些文档）                |
| 成本                   | 零 LLM 调用                              | 每条 query × 每个 context 一次 judge              |

对「记忆库检索**哪里可以优化**」这个问题，需要的是**前者**。后者的名字里也有 recall，但答的是另一个问题——**这是本调研最大的坑**。

**② 不加任何依赖。** 本轮共对账 **13 件外部工具**（RAGAS / DeepEval / Phoenix / TruLens / continuous-eval / Opik / Langfuse / promptfoo / LlamaIndex / Giskard / RAGChecker / autoevals + 若干社区 TS 包），**没有一件提供我们要的 IR 口径检索指标**——Langfuse 官方明说没有内置 Precision@K/Recall@K；其余各家的「context precision/recall」无一例外是 RAGAS 派生的事实覆盖口径，**都要参考答案、都不回答「漏了哪一篇」**。
而我们真正需要的 IR 指标是**纯数学**；我们需要的 LLM 判官**仓库里已经有了**（`eval/scorer.ts`）。→ 结论：自建 ~50 行集合运算 + 复用既有判官，**新增依赖 = 0**。

**③ 标注量 100–150 条 query 起**，且可用**合成查询自举**把人工标注压到接近零（§4.3 有算式）。

**④ 一个结构性好消息**：语料只有 **117 个节锚、10.3 万字符**（§1.3），小到可以**全量判定**——直接绕开 TREC pooling 那套「未判定即不相关」的近似与偏差。

---

## 1. 本地实况

### 1.1 检索链七段【实测】

1. `retrieveMemoryContext(triggerContent)` — `packages/server/src/memory/index.ts:177`
2. 剥离 `@mention` → 查询改写 `rewriteRetrievalQueries` → queries = [原话, ...改写] 去重 — `memory/index.ts:183-194`
3. 逐条 query：嵌入 → `searchChunksHybrid(blob, q, topK, maxDistance)` — `db/repository/chunks.ts:380`
4. 混合 = 向量通道 top-20（vec0 KNN）+ 关键词通道 top-20（FTS bigram/bm25）→ **RRF k=60** 融合 — `chunks.ts:386-402`
5. **融合后按 RRF 分排序 → 截 topK → 只返回行，分数被丢弃** — `chunks.ts:404-407`
6. 多 query 合并：按 `bestIndex`（出现在哪条 query 的第几位）排序取 topK — `memory/index.ts:231-234`；**跨 query 不再融合**，只按「最早出现」取胜
7. 按节补齐 `getChunksBySection`（小块检索、整节返回）→ 按节截断进 8000 token 预算 → 首尾各半渲染 — `memory/index.ts:270-294`

### 1.2 三个直接决定指标定义的坑【实测】

**(a) 生产 K 太小，精确率被量化到没有分辨力。**
`MEMORY_TOP_K` 默认 **3**（`memory/index.ts:186`）。节级精确率的分母最大是 3 ⇒ 单条 query 的 precision 只能取 `{0, 1/3, 2/3, 1}`。
⇒ **评测必须在可配置 K 上跑**（如 K=20 出 Recall@k 曲线），不能拿生产 K=3 的结果当评测输入。这同时正好回答「topK 调大一点会不会更好」——本期评测的副产品。

**(b) 纯关键词命中的 `distance` 是哨兵，不是距离。**
`chunks.ts:400` 给纯关键词命中填 `distance = maxDistance`（默认 0.6）。若拿 `distance` 当相关性分做指标，会把「向量通道命中」与「关键词通道救回」两类混为一谈。
⇒ **埋点必须带 `channel` 字段**（`vector` / `keyword` / `both`）。

**(c) 埋点的身份是「片」，注入的单位是「节」。**
指标的分母单位应当是**节**（`doc_path` + `section_anchor`）——那正是猫实际读到的东西（`RetrievedSection`，`memory/index.ts:61-69`）。这顺带缓解 `content_hash` 漂移：节锚在内容被编辑后仍然稳定，`content_hash` 不会。

> 附注：`memory/index.ts:273` 用**字面 NUL 字节**做 `doc_path` 与 `section_anchor` 的拼接分隔符，导致该文件被 grep 判定为 binary——对该文件做 grep 需加 `-a`。不是缺陷，是给后续埋点实现者的一个绊子。

### 1.3 语料规模：小到可以全量判定【实测】

| 项           | 值                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 白名单目录   | `docs/adr/`、`docs/lessons/`、`docs/plans/`（`scripts/flywheel/scan.mjs:53`）                                                                                                 |
| MD 文件数    | **19**（adr 13 / lessons 1 / plans 5）                                                                                                                                        |
| 正文字符     | **102,804**                                                                                                                                                                   |
| H2 / H3 节锚 | **91 / 26 = 117**                                                                                                                                                             |
| 估算片数     | **≤ ~230**（上界：102,804 ÷ 450。切片器有 L1/L2/L3 三级回退且不变式为 `text.length ≤ 450`（含面包屑+锚），短节 = 1 片 ⇒ 实际更少）【实测：`memory/flywheel/segment.ts:64,9`】 |

**这个量级最关键的含义**：TREC 式 pooling 的固有偏差在我们这里**不适用**。有实测研究指出，池化判定下 33.5% 的检索结果未被判定、按「不相关」处理，不同池构成会让 MAP 差 2.7%【出处：[TREC 34 Overview](https://trec.nist.gov/pubs/trec34/papers/Overview.pdf)、[LLMs Can Patch Up Missing Relevance Judgments (arXiv 2405.04727)](https://ar5iv.labs.arxiv.org/html/2405.04727)】。而我们有 **117 个节，全部判定是承受得起的**——能拿到**真值**而非估计值，也就没有「新系统因为找到未判定的相关项而被低估」这类系统性坑。

### 1.4 已有基建：三件可复用，不用重造【实测】

1. **判官通道** — `packages/server/src/eval/scorer.ts`：G-Eval 三件套（任务+上下文+回复）+ `getAdapterForAgent` 缓存实例（`scorer.ts:17,290`）+ Kimi 参数已钉死（`KIMI_JUDGE_OPTIONS`，含 `temperature=1`/`maxTokens=65536` 等 Phase 0 实测值）。
   ⇒ RAG 评估需要的 LLM 判定能力**零新增依赖**。
2. **离线批跑骨架** — `packages/server/src/eval/phase0.ts`：CLI 双形态（`--collect` 收样本到 JSON / `--run` 批跑出报告，`phase0.ts:11-13`）、纯统计函数导出供 co-located 测试、产物落 `packages/server/data/eval/`。
   ⇒ 检索评估照抄这个形态即可，**不需要新框架**。
3. **L1 聚合器** — `packages/server/src/eval/l1-aggregator.ts`：八口径聚合 + 滞回告警状态机。⇒ 检索指标的告警可挂同一状态机，不另起一套。

### 1.5 埋点缺口（逐条）【实测】

现状：检索面台账**只进日志、不进库**——`execution/reply.ts:643`（命中）与 `:664`（空结果）两条 `log.info`，字段其实相当全（`topCandidates` / `blockedByStatus` / `droppedByThreshold` / `sections`）。

**信息不缺，缺的是落点。** 要算指标，需要补的是：

| #      | 缺什么                             | 为什么必须有                                                                                                                                                           |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **落库**（现只在 `cat-study.log`） | 日志会滚、不能 SQL 聚合、做不了时序对比                                                                                                                                |
| **G2** | **排名 `rank`**                    | `ordered` 的位次与 RRF 分在 `chunks.ts:407` 被 `.map(s => s.row)` 丢掉。没有 rank 就算不出 **MRR / NDCG**，也无法回答「第几名开始错」                                  |
| **G3** | **通道标记 `channel`**             | 见 1.2(b)，哨兵距离不可分辨                                                                                                                                            |
| **G4** | **query 级明细**                   | 现在只有 `queries: number` 一个计数（`memory/index.ts:250`），看不出是原话还是哪条改写召回的——多 query 合并的效果无法归因                                              |
| **G5** | **K 可配置的评测入口**             | 见 1.2(a)                                                                                                                                                              |
| **G6** | **语料代际 `origin_id`**           | `chunks.origin_id` 就是扫描时该 MD 的 git blob SHA（`chunks.ts:40`）。埋点带上它，就能判「这次改动前后**语料本身**变没变」——否则无法区分「检索变好了」与「文档被改了」 |

---

## 2. 指标语义分档（核心结论）

### 2.1 名词撞车表

| 名字                            | 谁的叫法        | 需要什么输入                          | 能回答「漏了哪篇」       |
| ------------------------------- | --------------- | ------------------------------------- | ------------------------ |
| `recall@k`                      | IR 通用         | **相关性标注**（哪些节相关）          | ✅                       |
| `precision@k`                   | IR 通用         | **相关性标注**                        | ✅                       |
| `hit_rate@k` / `success@k`      | IR 通用         | **相关性标注**（只要 1 条命中即通过） | 部分                     |
| `MRR` / `MAP` / `NDCG@k`        | IR 通用         | **相关性标注**（NDCG 还需分级相关性） | ✅（含名次信息）         |
| `context_recall`                | RAGAS           | **参考答案**（不是相关性标注）        | ❌                       |
| `context_precision`             | RAGAS           | **参考答案**                          | ❌                       |
| `faithfulness` / `groundedness` | RAGAS / TruLens | 无需参考（LLM 判）                    | ❌（管的是生成不是检索） |
| `answer_relevancy`              | RAGAS           | 无需参考（LLM 判）                    | ❌                       |

**【出处】** RAGAS 侧已核到官方文档与源码级证据（见 §3.1）。关键判据：RAGAS 的 `LLMContextPrecisionWithReference` / `LLMContextRecall` 的 `_required_columns` 显式含 `reference`；DeepEval 的 `ContextualPrecisionMetric` / `ContextualRecallMetric` 文档显式要求 `expected_output`【出处：[ragas context_precision 文档](https://docs.ragas.io/en/v0.4.2/concepts/metrics/available_metrics/context_precision/)、[deepeval metrics-contextual-recall](https://deepeval.com/docs/metrics-contextual-recall)】。
**两家在这一点上完全一致，且都明说了**：参考型指标用于开发期，无参考指标用于生产流量。

> **对本项目的直接含义**：`context_recall`/`context_precision` **不能跑在无标注的真实流量上**。而我们要的恰是「在真实 query 上量检索质量」——这一条就足以判它们出局，不需要再比别的。

### 2.2 分档总表：哪些必须有 ground truth

**A 档 — 必须有 ground truth（我们需要的）**

| 指标                       | 需要的标注                    | 需要分级？ | 需要**完整**相关集？     |
| -------------------------- | ----------------------------- | ---------- | ------------------------ |
| `recall@k`                 | 每个 (query, 节) 的二元相关性 | 否         | ✅ **要**（分母是全集）  |
| `precision@k`              | **只要 top-k 内**的二元相关性 | 否         | ❌ 不要                  |
| `hit_rate@k` / `success@k` | **只要一条**相关节落在 top-k  | 否         | ❌ 不要                  |
| `MRR` / `MRR@k`            | **第一条**相关节的**名次**    | 否         | ❌ 不要                  |
| `MAP`                      | 全排名上的二元相关性          | 否         | ✅ **要**（判定量最大）  |
| `NDCG@k`                   | **分级**相关性（如 0/1/2/3）  | ✅ **要**  | ✅ 要（IDCG 来自判定池） |

**【出处】** 定义与标注需求：Manning/Raghavan/Schütze _Introduction to Information Retrieval_ Ch.8【[Stanford CS276 lecture 8](https://stanford.edu/class/cs276/handouts/lecture8-evaluation_2014-six-per-page.pdf)】；`recall.`/`P.`/`map`/`recip_rank` 语义【[trec_eval README](https://github.com/thunlp/EmbeddingEntityRetrieval/blob/f7299e7b5c6e0e90e571c6b4f7e27c22b80243d8/trec_eval.8.1/README#2)、[pytrec_eval README](https://github.com/eXascaleInfolab/pytrec_eval/blob/master/README.md)】；MRR 原始出处 = Voorhees, TREC-8 QA Track Report (1999)【[Wikipedia MRR 存档](http://web.archive.org/web/20221220054620/https://en.wikipedia.org/wiki/Mean_reciprocal_rank)】；NDCG 原始出处 = Järvelin & Kekäläinen, ACM TOIS 2002【[DOI 10.1145/582415.582418](https://doi.org/10.1145/582415.582418)】。

> ⚠️ **NDCG 公式有两大流派，同一批分级数据会算出不同数**：经典指数型 `(2^rel−1)/log2(i+1)`（IR 文献主流）vs **线性型 `rel/log2(i+1)`（scikit-learn 实际实现的就是这个）**【出处：[sklearn `ndcg_score`](https://scikit-learn.org/1.6/modules/generated/sklearn.metrics.ndcg_score.html)、[sklearn PR #32172](https://github.com/scikit-learn/scikit-learn/pull/32172)】。自建时**必须二选一并写进文档**，否则与外部数字无法对照。
> 另有实现陷阱：`trec_eval -q` 输出的 per-query 值叫 `map` 但实际是 **AP**，不是 MAP。

**关键取舍**：如果标注预算只能做一件事，做 **「每 query 一条金标准节」**——它一次性解锁 `MRR` / `MRR@k` / `HitRate@k`，是整个指标族里**标注成本最低**的一组；而 `recall@k` / `MAP` 要求判定**全库**，成本高一个量级【出处同上，Manning Ch.8 明言 MAP「requires many relevance judgments」】。

**B 档 — 无标注可算（立刻能用，零 LLM）**

| 信号           | 怎么算                                                                                                                                | 回答什么                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **改写一致性** | `rewriteRetrievalQueries` 已经产出改写查询（`memory/index.ts:193`）——测「原话召回的节」与「各条改写召回的节」的**重叠度 / Kendall τ** | 检索对**同义改写**稳不稳。**零新增基建，参数已经在手**。学术界叫 **PRSM**（paraphrase ranking stability）：全局 = 各改写排名两两 Spearman 均值，局部 `PRSM(k)` = top-k 重合率【出处：[PRSM 综述页](https://www.emergentmind.com/topics/paraphrase-ranking-stability-metric-prsm)（**二手来源**，未取到原始论文）】 |
| **通道增益**   | 对比 `searchChunksHybrid` vs 纯向量 / 纯关键词三条路的 top-k 差异                                                                     | 关键词通道到底救回了多少、有没有帮倒忙                                                                                                                                                                                                                                                                             |
| **分数间隔**   | top-1 与 top-k 的 `distance` 落差、命中与阈值的距离分布                                                                               | 检索「有多确信」，阈值 0.6 定得松还是紧                                                                                                                                                                                                                                                                            |
| **阈值敏感度** | 扫 `MEMORY_MAX_DISTANCE` 从 0.3→0.9，看召回集怎么变                                                                                   | 阈值调参**不需要标注**就能做                                                                                                                                                                                                                                                                                       |
| **K 敏感度**   | 扫 K=1..20 看覆盖率增长                                                                                                               | 「topK 调大有没有用」——同样不需要标注                                                                                                                                                                                                                                                                              |
| **空手率**     | `reason` 分布（`no-hit` / `filtered-empty` / `budget-exhausted` / `embed-failed`）随时间变化                                          | 线上健康度，`stats` 里现成                                                                                                                                                                                                                                                                                         |

> ⚠️ **两条必须写进实现注释的坑**：
>
> 1. **改写重合率低不一定是坏事**——有研究明确指出改写查询经常召回**不重叠**的文档集【出处：[Group Similarity Rewards, NeurIPS 2025](https://www.semanticscholar.org/reader/044341fd9ec5e03dd6234c249ba3b3e61ad2922c)】。⇒ 这项只作**相对趋势**读，别设绝对阈值。
> 2. **「相似度分 ≠ 置信度分」**，且**绝对阈值不可跨嵌入模型迁移**——换嵌入模型后所有阈值都要重标【出处：QPP 文献综述，见 [Unsupervised QPP, SIGIR 2023](https://scite.ai/reports/unsupervised-query-performance-prediction-for-n632GGRk)】。⇒ `distance` 分布只当**监控**信号，别当可跨版本的指标。

**C 档 — 无标注可算但需 LLM（判官）**

| 指标                            | 形态                                                    | 复用                                         |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| **context relevance**           | 逐条「检索到的节 vs query」打相关性分，**无需参考答案** | 直接复用 `scorer.ts` 的判官通道              |
| **faithfulness / groundedness** | 回复是否被检索内容支撑                                  | 同上；注意这是**生成侧**指标，别混进检索评估 |

> ⚠️ **判官自身有已知偏差，必须治理**（这些不是理论担忧，是有实测的）：**位置偏差**——仅调换顺序就能让 Vicuna-13B 在 80 题里赢 ChatGPT 66 题【出处：[arXiv 2305.17926](https://arxiv.org/abs/2305.17926)】；**自我偏好**——GPT-4 开箱识别自己文本 73.5%，自偏好随识别能力**线性上升**【出处：[arXiv 2404.13076](https://arxiv.org/abs/2404.13076)】；**冗长偏差**——重复列表填充攻击骗过 Claude-v1/GPT-3.5 约 91%【出处：[arXiv 2306.05685](https://arxiv.org/abs/2306.05685)】。
> 治理手段（成本由低到高）：判词里写明「长度不是质量指标」→ 同一判定跑两次**交换顺序**取一致 → 用**跨家族**判官面板 → 用 100–300 条人工标注校准，且**用 Cohen's κ 而不是原始一致率**（后者会掩盖分歧）【出处：[Judging the Judges, arXiv 2406.12624](https://arxiv.org/abs/2406.12624)】。

**C+ 档 — 无标注、但锚在真值上（值得单独拎出来）**

**eRAG**：对每条召回的节 `d`，让下游 LLM **只拿 `d`** 去回答，用下游任务的真值（准确率 / EM）给 `d` 打一个**相关性标签**，再喂进任意标准指标（Precision/Recall/MAP/MRR/NDCG）。它**无人工标注**、却**锚在真值上**，与下游 RAG 表现的 Kendall τ 优于人工 provenance 标签（提升 0.168–0.494），且比端到端评估**快 2.468×**、显存最多省 50×【出处：[Salemi & Zamani, SIGIR 2024, arXiv 2404.13781](https://ar5iv.labs.arxiv.org/html/2404.13781)】。
⇒ 对我们：下游「任务真值」就是**猫有没有把活干对**（L4 episode 已有！）。**这是把已有 L4 资产接进检索评估的桥**——性价比可能高于纯人工标注路线，值得在第 3 步试。

**D 档 — 必须有参考答案（本轮不做）**
`context_recall` / `context_precision` / `answer_correctness`（RAGAS 口径）。它们的答案已经由 A 档的 IR 指标以更低成本覆盖，**本期不需要**。

### 2.3 一句话判据

> **凡是问「检索器找没找对」→ A 档，纯集合运算，要标注、不要 LLM。**
> **凡是问「找回来的内容够不够好」→ C 档，要 LLM、不要标注。**
> **两者别混在一个数字里。**

---

## 3. 候选件对账

### 3.1 Python 侧主力两件（RAGAS / DeepEval）【出处】

|                  | **RAGAS**                                                                                                                                                                                                                         | **DeepEval**                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 许可证           | **Apache-2.0**（无 open-core 陷阱，无换证史）【[LICENSE 镜像](https://github.com/vibrantlabsai/ragas/blob/b928239d3c03956acb9e911be60f9ae81298a11e/LICENSE)、[Snyk](https://security.snyk.io/package/pip/ragas)】                 | **Apache-2.0**（`pyproject.toml` 声明）【[pyproject.toml](https://github.com/confident-ai/deepeval/blob/main/pyproject.toml)】；配套 SaaS（Confident AI）**另行商业授权，但完全可选**                                                                      |
| 最新版本         | **v0.4.3，2026-01-13**                                                                                                                                                                                                            | **v4.2.2，2026-09-06**                                                                                                                                                                                                                                     |
| 维护状态         | ⚠️ **停更**：距上版 ~8 个月、~6 个月无 commit，Snyk 评 **INACTIVE**；仍 pre-1.0 且旧 API 待删【[v0.4.3 release](https://github.com/vibrantlabsai/ragas/releases/tag/v0.4.3)、[Snyk](https://security.snyk.io/package/pip/ragas)】 | ✅ **高频活跃**：月均多次发版，官方 TS 端口同步发（同日 0.9.15）                                                                                                                                                                                           |
| 体量             | ~15k stars / ~1.41M 月下载                                                                                                                                                                                                        | ~17–18k stars / ~4.0M 月下载                                                                                                                                                                                                                               |
| **官方 TS 端口** | ❌ **没有**（只有两个无据社区包）                                                                                                                                                                                                 | ✅ **有**：npm 包名 `deepeval`，**v0.9.15 / 2026-09-06**，**Vitest 原生**（`deepeval/vitest` 注册 `toPass()`），~47 个指标【[TS monorepo 公告](https://deepeval.com/blog/typescript-in-deepeval-monorepo)、[npm](https://www.npmjs.com/package/deepeval)】 |
| TS 端口缺口      | —                                                                                                                                                                                                                                 | RAGAS 包装器、合成器、benchmarks、red teaming **未移植**                                                                                                                                                                                                   |
| 离线可跑         | 可以，但**每个默认值都要覆盖**（默认指向 OpenAI）；小模型判官（<7B）常吐不出结构化 JSON                                                                                                                                           | 可以，**原生 Ollama 集成**（`deepeval set-ollama` / `OllamaModel`），无需账号                                                                                                                                                                              |

**决定性的那一条**：两家的「context precision / context recall」——也就是名字上最像我们要的东西——**都要求参考答案**。RAGAS 在 `_required_columns` 里硬校验，DeepEval 文档写死 `expected_output`。⇒ **两者都无法跑在无标注的真实流量上**，而我们要的正是这个。

**顺带一条对选型有影响的发现**：**RAGAS 本身已停更约 8 个月**。即便将来要走 RAGAS 口径，把它当依赖也需要重新评估。

### 3.1b 评测平台侧候选【出处，逐条】

| 件                       | 许可证                                                                                                                                                                                                                                                                                                                                                         | 自托管成本                                                                                       | 离线批跑                                                             | TS 面                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| **Arize Phoenix evals**  | ⚠️ **Elastic-2.0（ELv2）——不是 OSI 开源许可**，禁止把软件作为托管服务提供、禁止绕过 license-key 功能【[LICENSE](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)、[phoenix-evals pyproject.toml](https://github.com/Arize-ai/phoenix/blob/8f30dafc/packages/phoenix-evals/pyproject.toml)】。注：`arize-phoenix-otel`（仅 OTel 包装）是 Apache-2.0，别混 | evals = 纯 pip/npm；server = 1 容器 + 默认 SQLite                                                | `evaluate_dataframe`（pandas）；**无 JSONL 一等支持**                | ✅ 一方 TS 包（Node ≥22.12）              |
| **TruLens**              | MIT【[LICENSE](https://github.com/truera/trulens/blob/trulens-2.3.0/LICENSE)】                                                                                                                                                                                                                                                                                 | pip + 本地 SQLite + Streamlit 看板，**无服务端**                                                 | ✅ `BatchEvaluator`（DataFrame / list-of-dicts），**结果仅内存态**   | ❌ Python only                            |
| **continuous-eval**      | Apache-2.0【[pyproject](https://github.com/relari-ai/continuous-eval/blob/main/pyproject.toml)】                                                                                                                                                                                                                                                               | 一个 pip 包，**零基础设施**                                                                      | ✅ **JSONL 是它的原生数据集格式**（同类最佳）                        | ❌ Python only                            |
| **Opik**（Comet）        | Apache-2.0 全平台【[LICENSE](https://github.com/comet-ml/opik/blob/main/LICENSE)】                                                                                                                                                                                                                                                                             | ⚠️ **重：~9–10 个容器**（MySQL + ClickHouse + ZooKeeper + Redis + MinIO + backend×2 + frontend） | ✅ 可**免服务端**逐行 `metric.score()`                               | ✅ 一方 npm 包                            |
| **Langfuse**             | MIT 核心 + `ee/` 商业区（企业外围：SSO/RBAC/审计，**不含** tracing/eval/datasets）【[LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE)】                                                                                                                                                                                                        | ⚠️ **重：最少 6 容器**，**ClickHouse ≥25.12 强制**（v4）                                         | 可以（本地 evaluator 函数），**但仍需一个可达实例**；无 JSONL 批量口 | ✅ `@langfuse/*` v5                       |
| **promptfoo**            | MIT【[package.json](https://raw.githubusercontent.com/promptfoo/promptfoo/0.122.0/package.json)】                                                                                                                                                                                                                                                              | **CLI = 一个 npm 包 + 本地 SQLite，近零成本**                                                    | ✅ **JSONL 进、JSONL 出**；确定性断言**完全不需要 LLM**              | ✅ **TS 原生**（Node ≥22.22）             |
| **LlamaIndex eval**      | MIT                                                                                                                                                                                                                                                                                                                                                            | pip only                                                                                         | ✅ `aevaluate_response_strs`                                         | ❌ **LlamaIndex.TS 已于 2026-04-30 归档** |
| **Giskard**              | Apache-2.0 + `ee/` 割裂；Hub 商业                                                                                                                                                                                                                                                                                                                              | OSS = pip（Python 3.12+）                                                                        | ✅ RAGET testset 存 JSONL，**但稳定 RAG 路径冻结在已停维护的 v2 线** | ❌ Python only                            |
| **RAGChecker**（Amazon） | Apache-2.0                                                                                                                                                                                                                                                                                                                                                     | pip + spaCy 模型                                                                                 | ✅ 批 CLI，**JSON 非 JSONL**（要写适配）                             | ❌ Python only                            |

**贯穿全表的一条硬事实——这才是决定性的：**

> **没有任何一件外部工具提供我们要的 IR 口径检索指标。**
> Langfuse 官方 discussion 里明确答复：**没有内置 Precision@K / Recall@K**【出处：[langfuse discussion #5215](https://github.com/orgs/langfuse/discussions/5215)】。
> 它们提供的「context precision/recall」**无一例外**是 RAGAS 派生口径——fact 覆盖（`continuous-eval` 的 `LLMBasedContextCoverage`、`promptfoo` 的 `context-recall`、`RAGChecker` 的 `claim_recall`）或 LLM 判官打分，**全部需要 ground truth，全部不回答「漏了哪一篇」**。
> 换句话说：**这些平台是「收 span + 展示 + 生成侧判官」的工具，它们的检索相关指标不是检索器的度量，是生成质量的度量。**

**两条对本项目有直接影响的风险**：

1. **许可证**：`Arize Phoenix evals` 是 **ELv2**——不是「开源」，商业使用有约束。若有人后续提议引入，这是必须先过的关。
2. **依赖重量**：Opik ~10 容器、Langfuse 6 容器 + ClickHouse。我们已有一个 embed sidecar 先例，但那是 1 个，不是 6 个。

**唯一值得留在桌面上的外部件是 `promptfoo`**：MIT、TS 原生、JSONL 进 JSONL 出、确定性断言零 LLM、CLI 近零成本。**但它同样不给 IR 指标**，且它的 RAG 断言是 RAGAS 派生。⇒ 它可以作为**将来做生成质量评估 / CI 门禁**的载体，**不是本期的答案**。

### 3.2 TS/Node 原生件【出处，逐条】

| 件                               | 许可                                                                                               | 维护/采纳                                                                                                                                                                                                                             | 关键指标是否落地                                                          | 判定                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`deepeval`**（官方 TS 端口）   | **Apache-2.0**                                                                                     | ✅ **最活跃**：v0.9.15 / 2026-09-06，与 Python 侧同步发版；npm 周下载 ~9k（Socket）                                                                                                                                                   | 有 `ContextualPrecision`/`ContextualRecall`，**但要求 `expected_output`** | **排除（本阶段）**：能力与维护都没问题，卡在**口径**——它要参考答案、算的是 LLM 语义对齐，不是 IR 集合口径，**跑不了无标注真实流量**（§3.1）。若将来做「生成质量」评估，它是 TS 侧首选 |
| **`autoevals`**（Braintrust）    | **许可存疑**：npm 页标 MIT，另有来源标 Apache-2.0 → **未证实**，用前须读仓库 LICENSE               | **活跃**：npm 周下载 ~356k，维护者 2 人，最近更新 2026-06【出处：[socket.dev](https://socket.dev/npm/package/autoevals)、[GitHub](https://github.com/braintrustdata/autoevals)】；star 数各源不一致（~811 / ~841 / ~975），**未证实** | 有 `ContextPrecision`/`ContextRecall` 等 RAGAS 派生评估器                 | **能力可用但口径不对**：同上是 RAGAS 事实覆盖口径（§2.1）。且我们不需要它的 LLM 编排层                                                                                                |
| **`raglens`**                    | MIT【出处：[Snyk](https://security.snyk.io/package/npm/raglens)】                                  | **v0.1.0，单作者，无可核验的 GitHub 仓库**——npm 与 Snyk 页均未给出仓库链接                                                                                                                                                            | ❌ **context precision/recall 明确列在 v0.2 路线图，v0.1 未实现**         | **排除**                                                                                                                                                                              |
| **`rageval`**（`@rageval/eval`） | **未证实**（未读到 LICENSE）                                                                       | **未证实**——star / 下载量均查不到                                                                                                                                                                                                     | 有 context recall/precision（LLM 判）                                     | **排除**：采纳度无据 + 需要 `ANTHROPIC_API_KEY` + 是 RAGAS 口径                                                                                                                       |
| **`@genkit-ai/evaluator`**       | Apache-2.0【出处：[JSPM 包页](https://jspm-packages.deno.dev/package/@genkit-ai/evaluator@1.7.0)】 | 依附 Genkit 框架                                                                                                                                                                                                                      | RAGAS 评估器「ported to Typescript」                                      | **排除**：为用它得引入整个 Genkit 框架，与「不新增依赖」相悖                                                                                                                          |
| **`@reaatech/rag-eval-metrics`** | 未证实                                                                                             | **未证实**（pre-1.0）                                                                                                                                                                                                                 | 有 context precision（MAP/NDCG）+ 启发式，号称无 LLM                      | **排除**：采纳度无据                                                                                                                                                                  |

**TS 生态的整体判断**：RAGAS 的 TS 移植**普遍停在不成熟的 v0.x**，且它们移植的是 **RAGAS 的 LLM 事实覆盖口径**——**恰好不是我们要的那个口径**。而真正常用的 IR 指标（recall@k / MRR / NDCG）在任何语言里都是**几十行集合运算**，没有任何引入依赖的理由。

### 3.3 结论

**不加依赖，自建。** 四条理由，前三条是「不需要」，第四条是「反面已排除」：

1. **我们要的 A 档（IR 口径）指标是纯数学**——引框架不如写 50 行，框架还要吃它的数据契约。
2. **我们要的 C 档（LLM 判定）能力，仓库已有**（`scorer.ts`），且参数是按我们自己的判官模型实测钉死的——引外部框架反而要重做这层适配。
3. **我们的数据在 SQLite**，外部件默认走 DataFrame/JSON 内存模型，**边界转换本身就是成本**。票据约束已明示「若走 Python 必须能离线读同一份 SQLite 或导出 JSONL」——**结论是不必走这条路**。
4. **最强的那个外部选项已经被口径排除，不是被偏好排除。** 唯一「TS 原生 + Apache-2.0 + 高频维护 + 官方端口」的候选是 **DeepEval TS**（`deepeval` npm，v0.9.15）——它本可以推翻「TS 生态不成熟」这个论断。但它与 RAGAS 一样，**检索指标要求参考答案**（`expected_output`），跑不了无标注真实流量。⇒ 排除它的理由是**它答的是另一个问题**，与维护度、许可证、语言都无关。

> **一句话给后续留路**：如果将来要评的是**生成质量**（回复是否忠实、是否切题）而不是**检索质量**，`deepeval` TS 端口是首选——那时它是「能力对得上」的。本期不选它，只因口径。

**顺带的风险提示**：`raglens` / `rageval` / `@ikrigel/ragas-lib-typescript` 这类社区 TS 包，普遍**无可核验的仓库、无下载量数据、关键指标停在路线图**。任何情况下都不建议引入——供应链风险与收益完全不成比例。

---

## 4. 最省力落点

### 4.1 动哪张表

**新增一张检索埋点表**（名字建议 `retrieval_events`，与 `execution_logs` / `eval_scores` 同级、additive `CREATE TABLE IF NOT EXISTS`，照 `db/index.ts` 既有迁移形态）。

关键设计点（每条都对着 §1.5 的缺口）：

```
-- 一行 = 一次检索里的一条候选（片级）
query_id        TEXT     -- 本次检索的关联键（同一轮的多条 query 共用一个）
trace_id        TEXT     -- 当轮执行 id（注意：不是链锚，见 map.md Notes）
task_id         TEXT     -- 链锚，用于把检索接回 trace
agent_id        TEXT
raw_query       TEXT     -- 剥离 @mention 后的原话
rewritten_query TEXT     -- 改写查询（NULL = 本行来自原话）
query_rank      INTEGER  -- 这条 query 是第几条（0 = 原话）—— 补 G4
doc_path        TEXT     -- ┐
section_anchor  TEXT     -- ├ 身份键三元组，补 §1.2(c)
content_hash    TEXT     -- ┘
origin_id       TEXT     -- 语料代际，补 G6
channel         TEXT     -- 'vector' | 'keyword' | 'both'，补 G3
rank            INTEGER  -- 融合后位次，补 G2
rrf_score       REAL     -- 现在被丢掉的融合分，补 G2
distance        REAL     -- 向量通道真实距离（纯关键词命中为 NULL，不再填哨兵）
injected        INTEGER  -- 是否最终进了 prompt（0/1，预算截断后）
created_at      TEXT
```

**三处必须做对、否则返工**：

1. **`distance` 对纯关键词命中写 NULL，别写哨兵**——哨兵一旦落库就永久污染（§1.2(b)）。
2. **`rank` 与 `rrf_score` 必须在 `chunks.ts:404-407` 出口前取出**——那里是它们唯一存在的地方。
3. **身份键用三元组，不用 `chunks.id`**——`chunks` 是可重建投影，重扫换 id（`map.md` Notes 已钉）。

**评测集本身不要放 `data/eval/`**：那个目录是 gitignored（`.gitignore:78`），放运行产物合适；但**评测集是定义指标的真值资产**——它一旦静默变化，所有历史对比全部失效。⇒ 评测集进 git（JSON fixture），运行报告走 `data/eval/`。

### 4.2 加哪个依赖

**零。** 见 §3.3。需要的三块能力全部已在仓库内：IR 指标（新写 ~50 行纯函数）、LLM 判官（复用 `scorer.ts`）、离线批跑骨架（照抄 `phase0.ts`）。

### 4.3 标注量估算

**(a) 统计门槛——配对设计能把门槛砍掉一个量级**

我们要做的是「改动前 vs 改动后」的比较，这天然是**配对**设计（同一批 query 跑两个版本），功效远高于两组独立样本。

**非配对**（两个版本各用一批不同 query）：
`n per group = [z_{α/2}·√(2p̄(1−p̄)) + z_β·√(p₁(1−p₁)+p₂(1−p₂))]² / δ²`
**已发表算例：70% → 80%（δ=0.10）、95% 置信、80% 功效 ⇒ 每组 293 条**【出处：[AJR 1992 样本量算例](https://www.ajronline.org/doi/pdf/10.2214/ajr.159.3.1503041)】。（我按 p=0.5 最坏情况实算同一 δ 得 393——**引用时用 293 这个已发表值**。）

**配对**（同一批 query，两系统跑两遍）：`n = 7.85 · σ_d² / Δ²`
其中 `σ_d` = **逐 query 配对差值的标准差**，`Δ` = 想检测的平均差异，`7.85 = (1.96 + 0.842)²`【出处：[Cambridge MRC-CBU 统计 wiki](https://lsr-wiki-01.mrc-cbu.cam.ac.uk/statswiki/FAQ/power/onesamp?action=raw)】。

以 `Δ = 0.10`（检测 10 个百分点）为例：

| 假定 `σ_d` | 所需 query 数 |
| ---------- | ------------- |
| 0.20       | **31**        |
| 0.30       | **71**        |
| 0.45       | **159**       |
| 0.60       | **283**       |

⚠️ **这里没有「万能 N」**——`σ_d` 依指标而变（Sakai 的核心发现），**必须先用 30–50 条小样本试跑估出 `σ_d`**，再决定评测集最终多大【出处：[Sakai, "Topic set size design", IRJ 19:256–283, 2016](https://link.springer.com/article/10.1007/s10791-015-9273-z)】。

**单系统读数本身的精度**（决定「一个数字能不能信」；`SE = √(p(1−p)/n)`，95% CI ≈ `±1.96·SE`）：

| n       | recall≈0.5 的 95% CI | recall≈0.7 的 95% CI |
| ------- | -------------------- | -------------------- |
| 20      | ±21.9 pp             | ±20.1 pp             |
| 30      | ±17.9 pp             | ±16.4 pp             |
| 50      | ±13.9 pp             | ±12.7 pp             |
| **100** | **±9.8 pp**          | **±9.0 pp**          |
| 150     | ±8.0 pp              | ±7.3 pp              |

⇒ **建议 100–150 条 query**：单系统读数能压到 ±8–10 pp，配对对比能测出 10 pp 级改动。**n<30 的评测集不要看**——±17 pp 的噪声会把任何结论都吞掉；文献里 n≈30 只是「均值可近似正态」的下限，**不是能分辨真实差异的目标**【出处：[Zobel, SIGIR 1998](https://www.semanticscholar.org/paper/How-reliable-are-the-results-of-large-scale-Zobel/150a31a1d38d90acefb560c2a42efed1ae67f7f7)】。
（注：正态近似的二项 CI 会**系统性低估** recall 的覆盖，极端 prevalence 下尤其明显，严谨做法用 beta-binomial 后验【出处：[Webber, "Approximate Recall Confidence Intervals", arXiv 1202.2880](https://ar5iv.labs.arxiv.org/html/1202.2880)】。上表够用于**量级判断**。）

**一笔隐藏成本：判定噪声会让你付第二遍样本量。** `n′ = n · (1/(2λ−1))²`，`λ` = 单条判定被正确测出的概率。例：效应量 h=0.4、n=50，在噪声下退化为 h′=0.24 时，需要 **138 次**才能保住同样功效【出处：[Carterette et al., "Hypothesis testing with incomplete relevance judgments", CIKM 2007](https://dl.acm.org/doi/10.1145/1321440.1321530)】。
⇒ **浅池化与 LLM 判官都会推高这里的 `n`**——它们不是「省了钱」，是把成本挪到了样本量上。

**一个不需要公式的粗判据（符号检验）**：α=0.05、80% 功效要求效应量 h ≥ 0.35，也就是**更好的系统要在约 68% 的 query 上赢**；只要 60% 功效则 h ≥ 0.25【出处同上】。
⇒ 如果改动前后只在约 55% 的 query 上分胜负，**先别宣布改进**。

**为什么选「多 query、少判定」**：Carterette 等证明**用更多 query + 每 query 更少判定**，比反过来更省，总评估人力可降约 **95%** 而不显著增加评估误差【出处：[Carterette et al., "Evaluation over thousands of queries", SIGIR 2008](https://dl.acm.org/doi/10.1145/1480506.1480527)（**注：95% 这个数字经两条二手记录确认，未取到论文正文**）】。
⇒ 这直接支撑我们下面的「100–150 条 query × 每条只判 top-30 节」设计。

**(b) 标注量怎么进一步压到接近零——两条路**

**路线 1：合成查询自举（省掉「query 从哪来」）**
从库里已有的节**反向生成** query（「这一节能回答什么问题」），**该节就是天然 ground truth**——标注由构造保证，零人工。
RAGAS 的 `TestsetGenerator` 正是这个思路的产品化：从文档建知识图 → 生成多跳/单跳问题 → 输出 `user_input` / `reference_contexts` / `reference` 三元组【出处：[RAGAS Testset Generation 官方文档](https://docs.ragas.io/en/v0.1.21/getstarted/testset_generation.html)、[TestsetGenerator 架构](https://deepwiki.com/vibrantlabsai/ragas/7.1-testsetgenerator-architecture)（第三方 wiki）】。
**我们不需要引 RAGAS**——117 个节的规模，一个 prompt（「读这一节，生成 3 个这节能回答的、但**不要照抄原文措辞**的问题」）跑一遍就有 300+ 条带真值的 query。
⚠️ **必须声明的偏差**：合成 query 的用词与源节天然重叠，会**系统性高估**召回率。⇒ 合成集只做**回归信号**（改动前后对比），**不能当作绝对召回率读数**。

**路线 2：真实 query 免费拿，只买「判定」**
query 侧其实**不用造**——`messages` 表里全是真实用户消息。缺的只是「这条 query 该召回哪几节」。

- **全量判定可行**：117 个节，100 条真实 query → 11,700 次判定。用**两段式**降到可承受：先用向量粗筛出该 query 的 top-30 候选节（几乎不可能漏掉真相关项），只判这 30 个 → **100 × 30 = 3,000 次 LLM 判定**，批量跑一次判官即可。
- 研究显示 LLM 补齐相关性判定与真值排序的相关性能到 **Kendall τ 0.87–0.92**，即使只保留 10% 判定【出处：[LLMs Can Patch Up Missing Relevance Judgments (arXiv 2405.04727)](https://ar5iv.labs.arxiv.org/html/2405.04727)】——**LLM 当标注员是站得住的**。
- 更硬的先例：**UMBRELA** 用零样本 GPT-4o 直接产 0–3 分级 qrels，run 级 Kendall τ **0.80–0.90** vs 人工，**被 TREC 2024 RAG 全部 301 个 topic 实际采用**【出处：[UMBRELA, arXiv 2406.06519](https://www.alphaxiv.org/overview/2406.06519v1)、[TREC 2024 RAG qrels 公告](https://trec-rag.github.io/annoucements/umbrela-qrels/)】。
- **但必须留一个小的人工锚**：抽 **20–30 条**真实 query 人工判一遍，量出「LLM 判官 vs 人」的一致率。不是为了省钱，是为了知道上面那 3,000 次判定**可不可信**。
  - ⚠️ 用 **Cohen's κ**，别只看原始一致率——后者会掩盖分歧【出处：[Judging the Judges, arXiv 2406.12624](https://arxiv.org/abs/2406.12624)】。
  - ⚠️ 有研究明确警告：LLM 判定的 run 级相关够用，但**逐 topic 相关性更低**，且「人在环路」的变体**提升不足以justify其成本**【出处：[Upadhyay et al., arXiv 2411.08275](https://ar5iv.labs.arxiv.org/html/2411.08275)】。⇒ 人工锚是**校准用**，不是**扩量用**。
  - 参考量级：ARES 用 **~150 条**人工标注即可给出统计上无偏的估计【出处：[ARES, arXiv 2311.09476](https://browse.arxiv.org/abs/2311.09476v2)】。我们取 20–30 条是**最小可用锚**。

**(c) 落成一句话的预算**

| 项                   | 量                         | 说明                           |
| -------------------- | -------------------------- | ------------------------------ |
| 真实 query（人工锚） | **20–30 条**               | 量判官可信度，人工成本 ~1 小时 |
| 真实 query（LLM 判） | **100–150 条** × top-30 节 | 批量判官，一次跑完             |
| 合成 query           | **200–400 条**（自动）     | 回归信号，零人工               |
| 合计人工             | **~1 小时**                | 其余全自动                     |

### 4.4 建议的三步走

| 步    | 做什么                                                                                                          | 依赖             | 产出                                    |
| ----- | --------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------- |
| **1** | 落 `retrieval_events` 表 + 在 `chunks.ts:404-407` 出口取 `rank`/`rrf_score`、补 `channel`。**先只落库不算指标** | 0                | 有了历史序列的原料（解决「无时序」）    |
| **2** | 写 IR 指标纯函数 + 合成查询生成脚本 + 批跑 CLI（照抄 `phase0.ts` 双形态）                                       | 0 新依赖         | 召回曲线 / MRR / 通道增益，改动前后可比 |
| **3** | 「人工锚 + LLM 判官」补真实 query 的相关性判定                                                                  | 复用 `scorer.ts` | 可对外引用的**绝对**召回率/精确率       |

**第 1 步的副产品**：`retrieval_events` 落库后，「哪里耗时最长」的检索段耗时也能顺带进来（与 T2 的 span 模型可对接）。

---

## 5. 未证实 / 待核（不许拿印象补）

| #      | 事项                                                                                        | 状态                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ~~U1~~ | ~~RAGAS 当前确切版本号与发布日~~                                                            | ✅ **已核实**：v0.4.3 / 2026-01-13（多源一致，个位日差）                                   |
| ~~U2~~ | ~~「需 `reference`」的一手出处~~                                                            | ✅ **已核实到源码/官方文档级**：RAGAS `_required_columns`、DeepEval 文档 `expected_output` |
| U3     | RAGAS LICENSE 当前 HEAD 的著作权人字样（Exploding Gradients vs Vibrant Labs）               | **未证实**（只读到镜像，未读 HEAD 原始字节）；不影响 Apache-2.0 结论                       |
| U4     | `deepeval` **npm 包**的 license 字段                                                        | **未证实**（Python 侧 `pyproject.toml` 已确认 Apache-2.0；TS 包 license 未直接读到）       |
| U5     | `autoevals` 的确切许可证（npm 标 MIT，另有源标 Apache-2.0）                                 | **冲突未决**，用前须读仓库 LICENSE                                                         |
| U6     | `rageval` / `@ikrigel/ragas-lib-typescript` / `@reaatech/rag-eval-metrics` 的许可证与采纳度 | **未证实**（star / 下载量均查不到）                                                        |
| U7     | `promptfoo` 于 2026-03 被 OpenAI 收购的传闻                                                 | **未证实**，勿据此决策                                                                     |
| U8     | IR 指标定义的 **URL 级**一手出处（pytrec_eval / ranx / sklearn 官方页）                     | **未取到 URL**；定义本身无争议                                                             |
| ~~U9~~ | ~~TruLens / Phoenix / Opik / Langfuse / continuous-eval 的逐条对账~~                        | ✅ **已完成**，见 §3.1b（含许可证、自托管成本、离线批跑、TS 面四轴）                       |
| U10    | `arize-phoenix` / `opik` / `langfuse` 在 2026-09-13 的**确切最新版本号**                    | **未证实**（聚合源互相冲突，无 GitHub API 直读）——**不影响选型**                           |
| U11    | `continuous-eval` 的最后提交日与 v0.3.5 发布日                                              | **未证实**：活跃度追踪源自相矛盾（「516 天前」vs「1 周前」）；**不归档但疑似休眠**         |
| U12    | `Giskard` 的 `ee/LICENSE` 具体条款、当前 PyPI 版本                                          | **未证实**；其 Hub 基础设施细节来自 fork 而非官方文档                                      |
| U13    | `promptfoo` 被 OpenAI 收购是否**正式交割**（2026-03-09 宣布）                               | **未证实**；**代码两侧都是 MIT，不影响许可证结论**                                         |
| U14    | `RAGChecker` 的非 LLM 蕴涵判定默认模型                                                      | **未证实**（只追到 RefChecker 的 HF 模型引用）                                             |

---

## 附：本文件与其他资产的关系

- 父票：[T1 RAG 检索评估生态与落地路径](T1-rag-eval-landscape.md)
- 地图：[map.md](map.md)
- 相关但**不重叠**：[T2 Trace 可观测性与评测平台](T2-trace-observability.md)（T2 管 span/耗时/卡点，本文管检索质量）

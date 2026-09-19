# 检索跑批基线 2026-09-19

> 生成：`scripts/eval/retrieval-baseline.mjs`（R10）。指标定义见 `docs/run/eval-system/R10-retrieval-eval-baseline.md` §一；
> 被测出口 = **全链最终注入节集**，从**冻结改写**出发（跳过改写器）。真实组与构造组各自出分，不合成总分（D4）。

## 一、跑批参数与语料快照

| 项 | 值 |
| --- | --- |
| 报告 schema | 1 |
| 库路径 | `D:\Game\ai\catStudy\packages\server\data\cat-study-dev.db` |
| chunks 行数 / doc_path 数 | 395 / 13 |
| 黄金集 | `D:\Game\ai\catStudy-sessions\2cfcc0f3-ds猫\docs\eval\retrieval-golden.json`（version=1，entries=40：real=12 / constructed=23 / negative=5） |
| 黄金集冻结基点 | `44c1d3ba368dc606c908454defa9e6752e2aa763` |
| 语料新鲜度（golden-check） | liveDocs=13，rotten=0 |
| 索引新鲜度（`chunks.origin_id` vs 工作树 `git hash-object`） | 13/13 份同步（stale=0） |
| MEMORY_MAX_DISTANCE | 0.6 |
| MEMORY_TOP_K | 3 |
| 探针池 MAX_PROBE_N | 20 |
| 嵌入模型 / 维度 | Xenova/bge-small-zh-v1.5 / 512 |
| 嵌入供给形态 | 独立 sidecar、动态端口（`EMBED_SIDECAR_PORT=0`，避开活 server 的固定端口） |

## 二、总分（两组分开报，D4）

| 组 | 条数 | 应命中锚点 | 命中 | **recall（集均）** | recall（合计） | **阈值前命中率（集均）** | 阈值前命中数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| real | 12 | 12 | 7 | **0.5833** | 0.5833 | **0.0000** | 0 |
| constructed | 23 | 23 | 19 | **0.8261** | 0.8261 | **0.0000** | 0 |

> 「集均」= 各条算术平均（票面 §一 口径）；「合计」= 总命中 / 总应命中（micro，防长条目被短条目稀释）。阈值前命中率 = `expect` 里出现在探针池、且被距离阈值（0.6）挡掉的节占比 —— 它答的是「阈值该不该松」。

## 三、逐条明细 — real

| id | reason | 应命中 | 命中 | recall | 阈值前命中 | 未进注入集的锚点（归因） |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | ok | 1 | 1 | 1.0000 | 0 | — |
| G02 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 2. 主链形态（七段，逐段钉死） > 2.6 检索（`searchChunksHybrid`）（not_topk） |
| G03 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 4. 票单全表（14 张，全部收口）（not-recalled） |
| G04 | ok | 1 | 1 | 1.0000 | 0 | — |
| G05 | ok | 1 | 1 | 1.0000 | 0 | — |
| G06 | ok | 1 | 1 | 1.0000 | 0 | — |
| G07 | ok | 1 | 1 | 1.0000 | 0 | — |
| G08 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/episode-evaluation-v2.md :: 6. 实施拆活（审 ✅ 后派）（not-recalled） |
| G09 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/episode-evaluation-v2.md :: 4. closure 状态机 + 改进闭环（not_topk） |
| G10 | ok | 1 | 1 | 1.0000 | 0 | — |
| G11 | ok | 1 | 1 | 1.0000 | 0 | — |
| G12 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/review-chain-anchor.md :: 三、用户故事（not_topk） |

## 四、逐条明细 — constructed

| id | reason | 应命中 | 命中 | recall | 阈值前命中 | 未进注入集的锚点（归因） |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | ok | 1 | 1 | 1.0000 | 0 | — |
| C02 | ok | 1 | 1 | 1.0000 | 0 | — |
| C03 | ok | 1 | 1 | 1.0000 | 0 | — |
| C05 | ok | 1 | 0 | 0.0000 | 0 | docs/adr/0009-multimodal-knowledge-base.md :: 两条不变量（扩展性论证核心） > 不变量 2：跨模态向量子空间分离（not_topk） |
| C06 | ok | 1 | 1 | 1.0000 | 0 | — |
| C07 | ok | 1 | 1 | 1.0000 | 0 | — |
| C08 | ok | 1 | 1 | 1.0000 | 0 | — |
| C09 | ok | 1 | 1 | 1.0000 | 0 | — |
| C10 | ok | 1 | 1 | 1.0000 | 0 | — |
| C11 | ok | 1 | 0 | 0.0000 | 0 | docs/adr/0013-c3-outbound-bus-not-adopted.md :: 决策：C3 降级为不做（status） |
| C12 | ok | 1 | 1 | 1.0000 | 0 | — |
| C13 | ok | 1 | 1 | 1.0000 | 0 | — |
| C14 | ok | 1 | 1 | 1.0000 | 0 | — |
| C15 | ok | 1 | 1 | 1.0000 | 0 | — |
| C16 | ok | 1 | 1 | 1.0000 | 0 | — |
| C18 | ok | 1 | 1 | 1.0000 | 0 | — |
| C19 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/episode-evaluation-v2.md :: 3. episodes 表结构（not_topk） |
| C20 | ok | 1 | 1 | 1.0000 | 0 | — |
| C21 | ok | 1 | 1 | 1.0000 | 0 | — |
| C23 | ok | 1 | 1 | 1.0000 | 0 | — |
| C24 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 2. 主链形态（七段，逐段钉死） > 2.3 扫描器（`scripts/flywheel/scan.mjs`）（not_topk） |
| C26 | ok | 1 | 1 | 1.0000 | 0 | — |
| C27 | ok | 1 | 1 | 1.0000 | 0 | — |

## 五、负例判红清单

| id | 判定 | expect 命中 | forbid 命中项 |
| --- | --- | --- | --- |
| N01 | 🔴 判红 | 0/1 | docs/adr/0011-execution-engine-extraction.md :: 决策 |
| N02 | 🔴 判红 | 1/1 | docs/adr/0012-session-closeout-and-push-approval.md :: 决策（push 审批部分——已退役 2026-09-01） |
| N03 | ✅ 未命中 | 0/1 | — |
| N04 | 🔴 判红 | 0/1 | docs/plans/review-chain-anchor.md :: 三、用户故事 |
| N05 | 🔴 判红 | 1/1 | docs/plans/db-schema-governance.md :: 四、B 范围决策（设计定稿，实施票缓拆） > 4.3 sessions.agent_ids 拆表（⑥，已拍板） |

> 负例共 5 条，判红 4 条。判红的含义：`forbid`（刻意标注的「误读路径」节）被注入了 prompt。「expect 命中」列一并列出——它把「**标错了**」（正解没进来）与「**尺子太宽**」（正解进来了、误读路径也进来了）分开，两者的药方不同。

## 六、canary（测量工具真空性，B2）

| canary | 期望 | query | reason | recall | 判 |
| --- | --- | --- | --- | --- | --- |
| CANARY-HIT | full | 2. 结局分类：7 类 + 判定优先级（含第四轮修正） > G2 拍板（第五轮重写）：U 根 episode 的 suc… | ok | 1.0000 | ✅ |
| CANARY-MISS | zero | 如何给南极科考站的柴油发电机做低温启动预热与燃油防凝 | no-hit | 0.0000 | ✅ |

> 必中条目的 query **原文照抄某节标题**；必不中条目是语料外话题，对**同一锚点**判零分。两条钉在同一把尺上，恒绿与恒红各由一条兜住——任一不符则本报告不出（见脚本 B2 硬闸）。

## 七、未召回归因汇总

| 归因 | 锚点数 | 药方 |
| --- | --- | --- |
| status | 2 | 查该节状态（死知识/废弃） |
| not_topk | 8 | 调 topK 或看排序（过闸了，但没进融合 topK） |
| not-recalled | 2 | 既不在注入集、也不在探针池、也不在融合 topK —— **覆盖洞**，或「只在改写查询里被召回却排不进 topK」（后者因合并后只留 topK 而不可观测） |

> 未召回归因合计 12 个锚点（全部落在已登记值域内）。**口径**：含负例条目的 `expect` 锚点——§ 三 的两张明细表只列 real / constructed，故两张表的未命中数之和会小于本表的合计（差额 = 负例的未命中）。


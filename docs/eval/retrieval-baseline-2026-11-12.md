# 检索跑批基线 2026-11-12

> 生成：`scripts/eval/retrieval-baseline.mjs`（R10）。指标定义见 `docs/run/eval-system/R10-retrieval-eval-baseline.md` §一；
> 被测出口 = **全链最终注入节集**，从**冻结改写**出发（跳过改写器）。真实组与构造组各自出分，不合成总分（D4）。

## 一、跑批参数与语料快照

| 项 | 值 |
| --- | --- |
| 报告 schema | 1 |
| 库路径 | `D:\Game\ai\catStudy\packages\server\data\cat-study-dev.db` |
| chunks 行数 / doc_path 数 | 771 / 45 |
| 黄金集 | `D:\Game\ai\catStudy\docs\eval\retrieval-golden.json`（version=1，entries=59：real=17 / constructed=37 / negative=5） |
| 黄金集冻结基点 | `0dc33fbb9012b543a23a775129fe9630732ed375` |
| 语料新鲜度（golden-check） | liveDocs=45，rotten=0 |
| 索引新鲜度（`chunks.origin_id` vs 工作树 `git hash-object`） | 45/45 份同步（stale=0） |
| MEMORY_MAX_DISTANCE | 0.6 |
| TOP_K（生效值 / 来源） | 5 / env |
| 探针池 MAX_PROBE_N | 20 |
| 嵌入模型 / 维度 | Xenova/bge-small-zh-v1.5 / 512 |
| 嵌入供给形态 | 独立 sidecar、动态端口（`EMBED_SIDECAR_PORT=0`，避开活 server 的固定端口；实测已握手） |

## 二、总分（两组分开报，D4）

| 组 | 条数 | 应命中锚点 | 命中 | **recall（集均）** | recall（合计） | **阈值前命中率（集均）** | 阈值前命中数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| real | 17 | 20 | 12 | **0.5588** | 0.6000 | **0.0000** | 0 |
| constructed | 37 | 37 | 31 | **0.8378** | 0.8378 | **0.0000** | 0 |

> 「集均」= 各条算术平均（票面 §一 口径）；「合计」= 总命中 / 总应命中（micro，防长条目被短条目稀释）。阈值前命中率 = `expect` 里**被距离阈值（0.6）挡下**的节占比，来源 = 探针池 + 逐查询重搜补测（探针池只取**首个嵌入成功的查询**，光靠它看不见改写查询那条路上的阈值拦截）。

> **未召回锚点读数**（「阈值该不该松」的直接证据；本次逐查询重搜覆盖 **15** 条条目，另对未命中锚点做**宽向量召回 top-200**）：未进注入集 **15** 处，其中 **15** 处取到真实向量距离（流水自带 8 处 + 重搜补测 3 处 + 宽召回补测 4 处，后两者取其各查询池内的**最小**距离 = 它最好的一次机会）、**最大 0.4998**（出处见明细行 `dist=` / `bestDist=`）。距离 ≥ 阈值的有 **0** 处（不含池外条目）⇒ **阈值一条都没杀**——瓶颈不在阈值，本次也**没有真覆盖洞**（`corpus-absent` 0 处）：全部未命中都是排序/名额截断（池外 4 处）——补语料救不了。

| 状态 | 处数 | bestRank | bestDist | windowN |
| --- | --- | --- | --- | --- |
| outside-window | 4 | 23 / 151 / 43 / 28 | 0.4998 / 0.3881 / 0.4848 / 0.4448 | 20 |
| corpus-absent | 0 | — | — | — |

> **池外 ≠ 覆盖洞**：`outside-window` = 该节**在库**、`bestDist` 在阈值内（或窗口是更紧的约束），但全库 `bestRank` ≥ `windowN`（每查询融合池出口 = `HYBRID_POOL_PER_QUERY` 片）——补语料救不了它，要先改排序，或把池/名额扩到覆盖它的名次。`corpus-absent` = `chunks` 表按 `(doc_path, section_anchor)` **查无此节**，才是真覆盖洞。`bestRank` 是宽向量召回列表的**下标（0 起）**，与重搜的 `rank` 同口径；`>N` = 宽召回边界外（名次只会更后，仍属池外）；「宽召回未返回」= 该锚点没出现在宽召回结果里（超过 top-N 或最小距离 ≥ 宽召回阈值），此时**不给名次**。

## 三、逐条明细 — real

| id | reason | 应命中 | 命中 | recall | 阈值前命中 | 未进注入集的锚点（归因） | 池外读数（bestRank / bestDist / windowN） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G02 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 2. 主链形态（七段，逐段钉死） > 2.6 检索（`searchChunksHybrid`）（outside-window dist=0.4998） | 23 / 0.4998 / 20 |
| G03 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 4. 票单全表（14 张，全部收口）（outside-window dist=0.3881） | 151 / 0.3881 / 20 |
| G04 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G05 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G06 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G07 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G08 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/episode-evaluation-v2.md :: 6. 实施拆活（审 ✅ 后派）（outside-window dist=0.4848） | 43 / 0.4848 / 20 |
| G09 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/episode-evaluation-v2.md :: 4. closure 状态机 + 改进闭环（outside-window dist=0.4448） | 28 / 0.4448 / 20 |
| G10 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/review-chain-anchor.md :: 一、问题陈述 > 一个时序事实（决定了兜底放哪）（below_topk q1 rank=4 dist=0.3913） | — |
| G11 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G12 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/review-chain-anchor.md :: 三、用户故事（not_topk dist=0.2920） | — |
| G41 | ok | 2 | 2 | 1.0000 | 0 | — | — |
| G42 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| G43 | ok | 1 | 0 | 0.0000 | 0 | docs/lessons/silent-no-op-changes.md :: 形态③：配置写在了已不消费的键位上（not_topk dist=0.4968） | — |
| G44 | ok | 2 | 2 | 1.0000 | 0 | — | — |
| G45 | ok | 2 | 1 | 0.5000 | 0 | docs/plans/eval-system.md :: 4. 记忆检索的采集：三表（not_topk dist=0.4551） | — |

## 四、逐条明细 — constructed

| id | reason | 应命中 | 命中 | recall | 阈值前命中 | 未进注入集的锚点（归因） | 池外读数（bestRank / bestDist / windowN） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C02 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C03 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C05 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C06 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C07 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C08 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C09 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C10 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C11 | ok | 1 | 0 | 0.0000 | 0 | docs/adr/0013-c3-outbound-bus-not-adopted.md :: #tombstone（not_topk dist=0.4504） | — |
| C12 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C13 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C14 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C15 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C16 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C18 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C19 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C20 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C21 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C23 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C24 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/memory-flywheel.md :: 2. 主链形态（七段，逐段钉死） > 2.3 扫描器（`scripts/flywheel/scan.mjs`）（below_topk q1 rank=3 dist=0.4662） | — |
| C26 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C27 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C41 | ok | 1 | 0 | 0.0000 | 0 | docs/lessons/distance-threshold-cannot-separate-relevance.md :: 正解（not_topk dist=0.3942） | — |
| C42 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C43 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C44 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C45 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C46 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C47 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C48 | ok | 1 | 0 | 0.0000 | 0 | docs/lessons/family-boundary-by-failure-mechanism.md :: 机制（not_topk dist=0.4513） | — |
| C49 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C50 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C51 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C52 | ok | 1 | 0 | 0.0000 | 0 | docs/lessons/criterion-blind-spot-looks-like-truth.md :: 通则（not_topk dist=0.3923） | — |
| C53 | ok | 1 | 1 | 1.0000 | 0 | — | — |
| C54 | ok | 1 | 0 | 0.0000 | 0 | docs/plans/eval-system.md :: 6. 检索评估尺：黄金集与跑批（below_topk q3 rank=1 dist=0.3902） | — |

## 五、负例判红清单

| id | 判定 | expect 命中 | forbid 命中项 |
| --- | --- | --- | --- |
| N01 | 🔴 判红 | 1/1 | docs/adr/0011-execution-engine-extraction.md :: 决策 |
| N02 | 🔴 判红 | 1/1 | docs/adr/0012-session-closeout-and-push-approval.md :: 决策（push 审批部分——已退役 2026-09-01） |
| N03 | 🔴 判红 | 0/1 | docs/adr/0014-skill-delivery-decoupling.md :: 5. Consequences |
| N04 | 🔴 判红 | 1/1 | docs/plans/review-chain-anchor.md :: 三、用户故事 |
| N05 | 🔴 判红 | 1/1 | docs/plans/db-schema-governance.md :: 四、B 范围决策（设计定稿，实施票缓拆） > 4.3 sessions.agent_ids 拆表（⑥，已拍板） |

> 负例共 5 条，判红 5 条。判红的含义：`forbid`（刻意标注的「误读路径」节）被注入了 prompt。「expect 命中」列一并列出——它把「**标错了**」（正解没进来）与「**尺子太宽**」（正解进来了、误读路径也进来了）分开，两者的药方不同。

## 六、canary（测量工具真空性，B2）

| canary | 期望 | query | reason | recall | 判 |
| --- | --- | --- | --- | --- | --- |
| CANARY-HIT | full | 2. 结局分类：7 类 + 判定优先级（含第四轮修正） > G2 拍板（第五轮重写）：U 根 episode 的 suc… | ok | 1.0000 | ✅ |
| CANARY-MISS | zero | 如何给南极科考站的柴油发电机做低温启动预热与燃油防凝 | no-hit | 0.0000 | ✅ |

> 必中条目的 query **原文照抄某节标题**；必不中条目是语料外话题，对**同一锚点**判零分。两条钉在同一把尺上，恒绿与恒红各由一条兜住——任一不符则本报告不出（见脚本 B2 硬闸）。

## 七、未召回归因汇总

| 归因 | 处数 | 药方 |
| --- | --- | --- |
| not_topk | 8 | 调 topK 或看排序/池深（距离已过闸，但没进融合 topK 或每查询融合池——探针池与宽召回两个发现路径同药方） |
| below_topk | 3 | 调 topK 或调池深（被某条查询召回过、也过了阈值，输在跨查询合并后的 topK 截断——与 not_topk 同药方，只是发现路径不同） |
| outside-window | 4 | **池外**（该节在库、`bestDist` 在阈值内或窗口更紧，但全库 `bestRank` ≥ 池窗口 `HYBRID_POOL_PER_QUERY`）——补语料救不了；改排序，或把池/名额扩到覆盖它的名次 |

> 未召回归因合计 15 **处**（全部落在已登记值域内）。**口径**：含负例条目的 `expect` 锚点——§ 三 的两张明细表只列 real / constructed，故两张表的未命中数之和会小于本表的合计（差额 = 负例的未命中）。计数单位 = **(条目, 锚点) 对**，去重后 15 个不同锚点。


# 评估体系 — Wayfinder 地图

<!-- label: wayfinder:map -->
<!-- tracker: 本地 markdown（仓库未接外部 issue tracker，按 skills/wayfinder 回落） -->
<!-- 物理约定: 地图=本文件；票单=同目录 <id>-<slug>.md；认领写 "Claimed by:" 行；阻塞写 "Blocked by:" 行 -->
<!-- 建图: 2026-09-13 -->

## Destination

<!-- 收敛于 2026-09-13（T1+T2 双票关后）；形态已解决，范围待用户点头。 -->

一套能回答四个问题的评估体系：

1. RAG（记忆库）检索**哪里可以优化**——`recall@k` / `precision@k` 算得出、改动前后可比
2. Trace 过程中的**卡点**在哪里——链锚 = `messages.task_id`，每跳可拆段
3. 哪个环节**耗时最长**——按环节 / 按猫 / 按链三个切面
4. 回复质量与系统性能**是否变好了**——指标有历史序列，可前后对比

**形态（T1/T2 收敛，非偏好）**：**自建，零新依赖。**

- 13 件 RAG 评估工具**无一件**提供不含参考答案的 `recall@k`/`precision@k`（「漏了哪一篇」这个信息只能靠标注）
- 六家 trace 平台（Langfuse / Phoenix / LangSmith / promptfoo / Weave / Braintrust）**全是查看器**——价值在「收 span + 画瀑布」，而缺口 100% 在**产出 span**，换平台省不掉最重那块；且**无一做卡点检测**，宣称「自动异常检测」的一律归商业版

表按 `gen_ai.*` **语义命名**——当词汇表，不当运行时依赖：今天零新进程零新依赖，将来接 OTLP 退化成「加一个导出器」，不必重新埋点。

## Notes

- 每轮会话先读本文件，再取一张 frontier 票；**一轮只解一张票**
- 术语坑：`trace_id` 是**当轮执行** id，链锚是 `messages.task_id`——凡说「整条 trace」一律指链锚，不指 `trace_id`。实测不等率 **主库 18.8%（219/1164）/ dev 库 21.7%（235/1081）**（`trace_id <> 触发消息.task_id`）。⚠️ 本图早先记的「958 条中 73.7%」**已无法复现**（用 NULL 宽容的 `IS NOT` 也只到 53.2%），改用上述可复现口径——**结论方向不变（不等率非零），量级下调约 3.5 倍**
- `chunks` 是可重建派生投影，重扫会换 `content_hash` / chunk id → 标注键必须用身份键 `(doc_path, section_anchor, content_hash)`
- 免审白名单：`docs/run/**`（含本目录）改动不进审查链
- 已有基建别重造：L1 八口径已接线（缺端点/时序）、L2 判官打分已通、L4 episode 已通
- **[已修 · P1-A `51170dc`，2026-09-14 重启生效；存量 1096 行按裁决不回填]** **`execution_logs.latency_ms` 全表 100% NULL**（店长实测 dev 库 1080/1080，completed/failed/running 全中）。不是没采集——同一条 UPDATE 的兄弟列有值（`prompt_tokens` / `reply_chars` 各 1007 行非空，铁证它跑过）；是 `reply.ts:1077` 写入后被 `serial.ts:1261` 的 `finalizeExecutionLog` 以 `opts?.latencyMs ?? null` 覆盖，而调用点（`serial.ts:389` 等）**不传 latencyMs**。连带 L1 `avgLatencyMs` 恒 null（`l1-aggregator.ts:82`）。**修它一行，白得两段耗时**：`replyMs` = `latency_ms`、`nonReplyMs` = `ended_at − started_at − latency_ms`
  - ⚠️ **两段的命名边界（店长 2026-09-13 实测纠正，早先写的「LLM 段 / 前置等锁段」是错的）**：`t0` 在 `reply.ts:207`（`runAgentReply` **内部**），而 token 获取在 `serial.ts:431`，**在 `runAgentReply` 之前** ⇒ `replyMs` = 上下文过滤 + 记忆检索 + LLM 流式 + 落库（**不只是 LLM**）；`nonReplyMs` = **等 token 锁 + 编排收尾 + 建行开销**（等锁是主要成分，**占比未实测**）。**禁用 `lockWaitMs`/「等锁段」这类字段名与文案——会把假数报成真数**；纯等锁数字需新增列 = P2 动表
- **`/api/eval/aggregates` 已被 L2 按猫评分聚合占用**（`routes/eval.ts:47`）——L1 八口径端点须另起名
- **链锚取法已定（见 Decisions）：`coalesce(回复消息.task_id, 触发消息.task_id)`**。单用触发侧会丢 **32.5%（351/1081）**——用户消息 564 条里 **342 条没有 `task_id`**（agent 消息 0 条缺失）；单用回复侧丢 **7.5%**（其中 70 行是失败跳，根本没有回复消息可 join）；coalesce 后仅剩 **28 行（2.6%）无锚**，这 28 行必须显式呈现为**孤儿跳**、不得静默丢弃
- 「链长」= **执行跳数**（不是消息行数）：coalesce 口径下 **479 条链 / 均 2.20 跳 / 最长 26 跳**。早先记录的 15 / 25 / 27 三个数全是口径不统一的产物，作废

## Decisions so far

<!-- 已关票一行一条：[票名](票单) — 一句话结论 -->

- [T2 Trace 可观测性与评测平台](T2-trace-observability.md) — **自建 span 表，不自托管**：六家平台全是查看器，价值在「收 span + 画瀑布」，而缺口 100% 在「产出 span」，换平台省不掉最重那块；自建表**按 `gen_ai.*` 语义命名**（词汇表，非运行时依赖）。顺手挖出 `execution_logs.latency_ms` **全表 100% NULL**（被 `finalizeRun` 覆盖清空，一行可修）与 `trace_id`↔链锚**同名不同义**陷阱。资产：[research-trace-observability.md](research-trace-observability.md)
- [T1 RAG 检索评估生态与落地路径](T1-rag-eval-landscape.md) — **不加任何依赖，自建 IR 口径指标**：对账 13 件外部工具，**无一件提供 `recall@k`/`precision@k` 这类含「漏了哪一篇」信息的检索指标**（Langfuse 官方确认无内置 P@K/R@K；其余各家的 context precision/recall 一律要参考答案）——所以不加依赖是**排除**不是偏好。判官复用 `eval/scorer.ts`、离线批跑照抄 `eval/phase0.ts`。起步 **100–150 条 query**（配对设计 `n=7.85·σ_d²/Δ²`，先用 30–50 条试跑估 σ_d；合成查询自举 + LLM 判官可把人工压到 ~1 小时）。落点 = 新增 `retrieval_events` 表 + 在 `chunks.ts:404-407` 出口取回被丢弃的 `rank`/`rrf_score`；`MEMORY_TOP_K=3` 会把 precision 量化到 {0,⅓,⅔,1} ⇒ 评测须在可配置 K 上跑。资产：[research-rag-eval.md](research-rag-eval.md)

- **【店长裁决 · 链锚口径与观察单位】**（2026-09-13，非票单）— **观察单位 = 执行跳（`execution_logs` 行），链锚 = `coalesce(回复消息.task_id, 触发消息.task_id)`**。依据三条实测（dev 库 1081 行）：① **失败的跳不产生消息行**——头号链 `9b4509e7` 27 消息行 / 25 执行跳 / `completed 21 + failed 4`，4 条失败跳 `reply_chars=0`；按消息行分组会**静默吞掉卡点本身**（页面显示"27 行都回了"，实际 4 跳死了）② 耗时/瀑布只能从 `execution_logs` 的 `started_at`/`ended_at` 算，两张表分组口径不一致会导致「页面显示 27 跳、瀑布只画 25 条」的自相矛盾 ③ 触发侧链锚覆盖 67.5%、回复侧 92.5%、coalesce **97.4%**。**该链跨度 3846 秒（64 分钟）**，是「耗时最长」切面的真实样本

- **【店长裁决 · P1 范围与理由】**（2026-09-13，用户批准开工）— **P1 = 一行采集修复 + 两个只读端点 + 一个 tab，不碰表结构**。依据**可逆性**这把尺子：① `latency_ms` **持续写入且不可回填**（值丢了就是丢了，全表无第二列能反推）⇒ 唯一「越晚做越亏」的一项，必须最先落地；② 读接口与展示是叶子节点（无模块 import），改口径是加法不是改；③ **表结构（DDL）全部推到 P2**——那才是「后面一改就返工」的一层。**推论：把可逆的活压在不可逆的活后面 = 顺序反了。** 另收回一条早先建议：「把 `TelemetryGap` 式缺失状态显式化并进 P1」——若落在**写入侧**（新列/新枚举）就是锁表，属「后面可能改」那类 ⇒ **只做在读侧**（端点把「无数据」与「值为 0」分开推导），价值照拿，表不动

- **【店长裁决 · P1 收口与通电实证】**（2026-09-14，非票单）— P1 三票（A / A2 / B）全部并入 `dev`，三方对齐 `dev = origin/dev = .push-gate = 6812375c`。**用户 2026-09-14 重启后，整批代码首次真机生效**，逐条实证：
  - **进程换血**：server PID `159684` 创建于 `16:37:38Z`（tsx 直跑 `packages/server/src/index.ts`，主仓库在 `dev@6812375c`）；侧车 PID `255024` 于 `16:37:46Z` 随之重生（`127.0.0.1:3210` 监听）。
  - **采集修复在位**：工作区源码 `db/repository/executionLogs.ts:316` = `latency_ms = COALESCE(?, latency_ms)`（**注意行号已从票单写的 :275 漂移到 :316**）。
  - **两端点真机 200**：`/api/eval/l1-metrics` 返回 8 口径（`avgLatencyMs: null` —— 存量不可回填，符合预期）；`/api/eval/chains` 返回 485 链 / 1096 跳 / 孤儿 28 / 均 2.20 / 最长 26，锚串 `coalesce(reply.task_id, trigger.task_id)` 原样回传。
  - **P1-A2 守卫真机生效（硬证据）**：`limit` 上限 100 导致在飞跳被排序挤出窗口，改用 `windowDays=1` 收窄窗口使其进入返回面 —— running 跳 `1b86d535` 的 `flags: []`（修复前必被标 `no_reply`），同窗口 `no_reply` 3 条**全部 `status=failed`**（防过度修正闸通过）。
  - **幽灵 running 已清**：全表唯一 `status='running'` 行 = 当轮店长执行本身，重启前的残留行均已被 recovery 收口。
  - **前端视觉自证（解 P1-B 「门槛 #5 真机联调」）**：playwright 驱动真实浏览器，L1 六卡 + 窗口/样本 + 说明文案齐；概览五要素齐；列表按跨度降序、失败徽章带文字、`失败 0` 灰显；孤儿区恒显示「28 跳 触发/回复消息均无 task_id，无法归入任何链」；**`平均耗时 —` 而非 `0`**（null≠0 契约肉眼确认）；**零 console error**。
  - **仍未验的（诚实挂账）**：`latency_ms` 首个非空真值须等**一次执行收尾**（本轮执行 `1b86d535` 收尾时写入）——下一轮复核；若仍为 NULL 则 P1-A 未真生效，须返工。

- **【店长裁决 · P2 表形态：拆三表】**（2026-09-14，用户裁决）— `retrieval_events`（检索级 14 列）/ `retrieval_queries`（查询级 5 列）/ `retrieval_candidates`（候选级 20 列），合计 **39 列**。用户判据原话：「**表需要具有代表性，主要代表某类东西**」。**单表 37 列方案作废**——那条路线上 15 列标 ✅ 冗余，其中 **11 列的病根正是「三种粒度压进一张表」**（检索级 10 + 查询级 1 被复制到每个候选行，一次检索约 23 遍）；拆开后它们各归其位、**不再冗余**，初版那条「冗余列一律全行写」的反向纪律**整条失效**。另有三列凭空消失（join / `COUNT` 可派生）：`query_total`、候选行上的 `query_index`、以及**曾追着用户要过两轮签字**的 `queries_embedded`——那个「36 还是 37」的选择题不是被回答，是**不存在了**。见 [P2 设计票](P2-design-retrieval-events.md)
- **【店长裁决 · R1 范围：只采不改】**（2026-09-14，用户裁「拆」）— R1 = **采集层**（`chunks.ts:396-407` 出口带通道身份 + `memory/index.ts:216-234` 采 `final_rank` 与「该趟是否走混合通道」），**不含跨查询合并改排序**（`:217` 传参、`:406` 的 `slice` 参数、`:234` 合并键从 `bestIndex` 换 RRF 分累加）——那一步动的是**猫实际读到的记忆**，属行为变更，与「写库失败绝不抛」的低风险 R1 混在一起验收面会糊，拆出另票。
- **【店长核查 · 老记忆链残留】**（2026-09-14，用户要求「核查老记忆知识库、删无用代码与表」）— 实测三点：① **表已经干净了**（`memories` / `memories_fts` 在 `cat-study.db` 与 `cat-study-dev.db` 均 `no such table`），残留全在**代码 / 配置 / 命名**；② `memory/index.ts:273` 含**字面 NUL 字节**（`a0624c6` 提交进仓库，全仓唯一）⇒ `file` 判为 `data`、**grep 默认跳过该文件且不报错**——而它正是 R1 要改的文件（本会话首次核查 `MEMORY_TOP_K` 时已被它骗过一次，差点把活配置判成死配置，加 `-a` 才见 40 行）；③ `eval/phase0.ts:363-367` 的**判分基准** `ext-06` 在教已作废的 `MEMORY_DEDUP_THRESHOLD`——**校准集把死知识编码成了 ground truth**（模型背死旋钮得满分、说真话反判错）。立 [C1](C1-legacy-memory-chain-cleanup.md)，**R1 的前置**（两票改同一批文件，并行必冲突，故串行落）。
- **【店长收口 · C1 落地 + README Redis 死面归属】**（2026-09-14）— C1 审查 ✅（吐槽猫，四条 OQ 独立实测）→ PR **#75** → merge `4a33553`；收口方式 = 隔离分支 `closeout/c1-43670d8` pin **已审 sha 字面量**（未整推 session 分支）。落 dev 后对账 `dev = origin/dev = .push-gate = 4a33553` ✅。**含 `packages/server/**` ⇒ 需重启生效**。
  **同批补回一笔跨轮滞留**：P1-A2 的 §六 Resolution（`6172653`）与 §七 收口留痕（`6595f75`）**从未落 dev**——它们当年是隔离分支只 carry 已审 sha 及其祖先的**必然产物**（票面 `P1-a2-no-reply-guard.md` §七 自己记了这笔账，写明「随下一次**代码类**收口一并带入」）。C1 正是那次收口，但两条 commit 在 `session/0eb66b63` 上、不在收口分支的祖先链里，**该惯例第一次执行就漏了**。已 cherry-pick 落 dev（`8e48564` / `12ab58f`，均 `docs/run/**` 免审）。
  **裁决 · README Redis 死面（C1 §六 待裁项）= 并入 R1，独立 commit + 独立验收项**。判据是**是否改行为**，不是是否同主题——同一把尺子把 R1-b 拆了出去（它改猫实际读到的记忆）。本项 **6 处 / 8 行纯删除、零行为、零依赖**，判据可机械复核，省下一整轮 spec-gate + 审查。**前置已实测**：`db/redis.ts` 不存在、`redis`/`ioredis` 连 `package.json` 都没声明、`REDIS_URL` 零消费方。**明写不做**：`:369`/`:372` ADR 表两行是历史记录，不动。

- **【店长裁决 · R1-b / F1 两票立票，含两处我拍的板】**（2026-09-14，执行用户已批顺序「R1 → 止血单（并行）→ R2 设计 → OQ-6 → P3」）— 立 [R1-b](R1-b-crossquery-merge-rerank.md) 与 [F1](F1-embedding-failure-visibility.md)。**两处需要用户知悉的架构裁决（均由我拍板，可驳）**：
  1. **R1-b 含一条 additive 迁移 `ALTER TABLE retrieval_events ADD COLUMN param_pool_n INTEGER`**——依据 P2 设计票 §一 推论一「凡事后无法可靠重算的值，一律冗余进表」：R1-b 引入新的可调常量 `HYBRID_POOL_PER_QUERY`，无快照则历史行不可解释。**独立 commit + 独立验收项**（沿用 C1 §六 Redis 死面范式）。⚠️ 这动的是 `retrieval_events` 的 DDL（用户此前对列数问题追问过三轮），故显式上浮。**现已不是「35/36/37 列」那类选择题**：加列实测 **0.10 ms**、O(1)、不重建表，`db/index.ts` 已有 10+ 条 `ADD COLUMN` 先例。
  2. **R1-b 的分数统一口径**：`chunks.ts:333` 的 `ChunkKeywordSearchResult = ChunkRow` **没有分数字段**，而合并改按分累加后纯关键词降级路径必须也有分 ⇒ 统一为 **Σ(各通道 `1/(RRF_K + rank_in_channel + 1)`)**——这不是新公式，**混合路径今天就是这么算的**（`chunks.ts:397` / `:400-403`）。**明写禁止**填 `NULL`（JS 里当 0 或 NaN，都不抛）或填不同量纲的值。
  - 另：**R1-b 的 `final_rank` 与 R1 段同名不同义**（旧=名次最小 / 新=累加分最大）⇒ 两段数据不可比，须按 `created_at` 或 `param_pool_n IS NULL` 切窗口。**本仓已有同型前科（`trace_id` ↔ 链锚同名不同义）。**

## Not yet specified

<!-- 看得见但还说不清的问题，随 frontier 推进毕业成票 -->

- 评测集从哪来、标注成本谁承担（黄金标注集是整张图里最贵的一块）
  → **已裁（2026-09-14）**：**P3 标注集暂不启动**，第一期只留挂载点。⚠️ 「暂缓」与「未定」在本文件里必须写成可区分的两种形态——本条早先以「未定」形态挂着，下一个人读不出是「没想过」还是「想过、暂不做」
- 服务对象的最终形态：人看板 / 调参判据 / CI 门禁
  → **已裁（2026-09-14，补录）**：**先做人看板**（消费者 = 用户）；评测集后置、但第一期留挂载点。⚠️ 本条裁决此前**只活在会话里、零书面落点**（map / 各票 / 两份 research 全 grep 过）——这正是本项目反复栽的「裁决埋进暗知识」
- ~~trace 看板的形态——**粒度已定**（执行跳 + coalesce 链锚，见 Decisions）；**卡点判据仍未定**：失败跳 / 超阈值跳 / 等锁时长 / 无回复跳，四者是否都算，阈值取多少~~
  → **已裁（P1，2026-09-13）**：**四类全标、不筛选**，每跳带 `flags: failed|no_reply|slow|no_data`（互不排斥）。`slow` 阈值 env `EVAL_CHAIN_SLOW_MS` 默认 300000。**先看真实分布再定阈值**——现在选是拍脑袋。见 [P1-A](P1-a-backend-chain-query.md)
- ~~**孤儿跳**（28 行 = 2.6%，既无回复、触发消息也无 `task_id`）在链路视图里怎么呈现~~
  → **已做（P1-B `5ec2b3e`）**：孤儿区默认收起、数量恒显示（`28 跳 触发/回复消息均无 task_id，无法归入任何链`）、带解释文案。见 [P1-B](P1-b-web-chain-tab.md)
- L2 判官自身可不可信——判官分与人工回标的一致性怎么度量
  → **仍未定，且无人认领**。这是评测体系的**自指环**：判官是 P3 人工标注的替代品，它不可信则 P3 没有退路。真缺口，无票
- 除记忆库外，调度 / token 池 / CLI 适配器要不要各自建口径
  → **归并进 R2**：span 表就是「全链路各段口径」的载体，不该独立排期（与 R2 字段设计是同一个问题）
- 指标序列的留存策略（保留多久、降采样与否）
  → 量级已实测（约 2.5 万候选行/月 ≈ 7–8 MB/月，一年约 90 MB），P2 §六 **只留口不实现**。不卡后续，但需要一个裁决位

## Out of scope

（空）

## Tickets

- ~~**T1 票单：RAG 检索评估生态与落地路径** — `T1-rag-eval-landscape.md`~~ ✅ **已关票**（2026-09-13，见 Decisions so far）
- ~~**T2 票单：Trace 可观测性与评测平台** — `T2-trace-observability.md`~~ ✅ **已关票**（2026-09-13，见 Decisions so far）

### P1（用户 2026-09-13 批准开工）— ✅ **全部关票（2026-09-13/14）**

- ~~**P1-A：采集修复 + 链路查询端点 + L1 口径端点** — `P1-a-backend-chain-query.md`~~ ✅ 已关票（`51170dc`，PR #72 merge `8b3fc712`）
- ~~**P1-B：评估中心「链路」tab** — `P1-b-web-chain-tab.md`~~ ✅ 已关票（`5ec2b3e`，PR #73 merge `ba49c60b`）
- ~~**P1-A2：no_reply 加 running 守卫**（OQ-1 裁决产物）— `P1-a2-no-reply-guard.md`~~ ✅ 已关票（`0ca73cf`，PR #74 merge `6812375c`）

**P1 不做**：表结构改动（`retrieval_events` / span 表 = P2）、存量回填、RAG 检索指标（P2）。

### 待排（P1 审查挂账）

- **OQ-6：env 阈值解析 NaN 族** — `OQ-6-env-threshold-nan.md`（真 bug 但需 env 配错才触发；**未派活**）。⚠️ 原写「等与 P2 一并排期」——**P2 已开工，本条已到期**。

### P2（用户 2026-09-14 批准开工）

**执行顺序（用户裁「按你建议的走」）**：**R1 → 止血单（并行）→ R2 设计 → OQ-6 → P3**。

- ~~**C1：老记忆链残留核查与清除** — `C1-legacy-memory-chain-cleanup.md`~~ ✅ **已关票**（2026-09-14，PR #75 / merge `4a33553`；含 server 代码 ⇒ 需重启生效）
- **R1：`retrieval_*` 三表 + 采集接线** — 设计见 [P2 设计票](P2-design-retrieval-events.md)（**已派活**）。**动 DDL（不可逆）**，形态已定稿。**随票尾巴**：C1 §六 的 README Redis 死面（6 处 / 8 行，独立 commit + 独立验收项，与 R1 主体无依赖）
- **R1-b：跨查询合并改排序**（自 R1 拆出，**行为变更**）— [R1-b-crossquery-merge-rerank.md](R1-b-crossquery-merge-rerank.md)（2026-09-14 立票，**未派活**；**依赖 R1 出口形状，串行**）
- **F1 止血单**（与 R1 并行，零依赖）— [F1-embedding-failure-visibility.md](F1-embedding-failure-visibility.md)（2026-09-14 立票，**未派活**）：① `embedding-client.ts:337-340` 失败只读 status **不读 body**（根因就在同一响应的 `embed-server.mjs:161` 里，`res.json()` 只在成功路径 `:344` 被调）；② `child.stderr` **从 spawn 出来无人接管**（`:596` 是 `stdio:['pipe','pipe','pipe']`，全文件 `stderr` 只出现在 `:137` 接口声明——**且管道写满会阻塞子进程**）；③ 测试与生产**写同一个日志文件**，且 `packages/server/vitest.config.ts:20` 的 `LOG_LEVEL:'error'` **是死的**（`setLogLevel` 全仓只在 `index.ts:122` 调用，测试不 import 它）
  - ⚠️ **更正**：本行原写「实测 **26 次** bad-status 全落在测试窗口内」。**两个数都不准，且结论过强**——现测当前日志 `bad-status` **15 行** / 轮转件 `catStudy.log.1` **75 行**；抽样窗口（`16:28:40` 夹具段 → 9 秒后 `16:28:49`）**能证明测试条目与生产条目同文件交错，但「全部是测试造的」既证不出也证不伪**（两个来源在文件里无任何可分标记）。**后者才是 F1-c 的立论，且更强**：不是「日志脏」，是「生产上嵌入挂没挂过——答不出来」
- **R2：span 表** — 设计同源、实施另票，**但字段设计本体尚不存在**（票 §八 只有「为什么这么排」的理由，一个字段都没设计）。**这是当前最大的洞**，可与三表并行推进

> **纠偏（原第 95 行的说法）**：早先写「`retrieval_events` 表 → 记忆库 `recall@k` / `precision@k`」——**这句把 P2 说大了**。R1 落的是**原料**（候选 / 位次 / 通道 / 分数），不是指标本身；`recall@k` / `precision@k` 必须人工标注（13 件外部工具无一件能不靠参考答案给出此数），属 P3。

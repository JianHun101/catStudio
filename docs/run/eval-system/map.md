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
- **`execution_logs.latency_ms` 全表 100% NULL**（店长实测 dev 库 1080/1080，completed/failed/running 全中）。不是没采集——同一条 UPDATE 的兄弟列有值（`prompt_tokens` / `reply_chars` 各 1007 行非空，铁证它跑过）；是 `reply.ts:1077` 写入后被 `serial.ts:1261` 的 `finalizeExecutionLog` 以 `opts?.latencyMs ?? null` 覆盖，而调用点（`serial.ts:389` 等）**不传 latencyMs**。连带 L1 `avgLatencyMs` 恒 null（`l1-aggregator.ts:82`）。**修它一行，白得两段耗时**：LLM 段 = `latency_ms`、前置等锁段 = `ended_at − started_at − latency_ms`
- **`/api/eval/aggregates` 已被 L2 按猫评分聚合占用**（`routes/eval.ts:47`）——L1 八口径端点须另起名
- **链锚取法已定（见 Decisions）：`coalesce(回复消息.task_id, 触发消息.task_id)`**。单用触发侧会丢 **32.5%（351/1081）**——用户消息 564 条里 **342 条没有 `task_id`**（agent 消息 0 条缺失）；单用回复侧丢 **7.5%**（其中 70 行是失败跳，根本没有回复消息可 join）；coalesce 后仅剩 **28 行（2.6%）无锚**，这 28 行必须显式呈现为**孤儿跳**、不得静默丢弃
- 「链长」= **执行跳数**（不是消息行数）：coalesce 口径下 **479 条链 / 均 2.20 跳 / 最长 26 跳**。早先记录的 15 / 25 / 27 三个数全是口径不统一的产物，作废

## Decisions so far

<!-- 已关票一行一条：[票名](票单) — 一句话结论 -->

- [T2 Trace 可观测性与评测平台](T2-trace-observability.md) — **自建 span 表，不自托管**：六家平台全是查看器，价值在「收 span + 画瀑布」，而缺口 100% 在「产出 span」，换平台省不掉最重那块；自建表**按 `gen_ai.*` 语义命名**（词汇表，非运行时依赖）。顺手挖出 `execution_logs.latency_ms` **全表 100% NULL**（被 `finalizeRun` 覆盖清空，一行可修）与 `trace_id`↔链锚**同名不同义**陷阱。资产：[research-trace-observability.md](research-trace-observability.md)
- [T1 RAG 检索评估生态与落地路径](T1-rag-eval-landscape.md) — **不加任何依赖，自建 IR 口径指标**：对账 13 件外部工具，**无一件提供 `recall@k`/`precision@k` 这类含「漏了哪一篇」信息的检索指标**（Langfuse 官方确认无内置 P@K/R@K；其余各家的 context precision/recall 一律要参考答案）——所以不加依赖是**排除**不是偏好。判官复用 `eval/scorer.ts`、离线批跑照抄 `eval/phase0.ts`。起步 **100–150 条 query**（配对设计 `n=7.85·σ_d²/Δ²`，先用 30–50 条试跑估 σ_d；合成查询自举 + LLM 判官可把人工压到 ~1 小时）。落点 = 新增 `retrieval_events` 表 + 在 `chunks.ts:404-407` 出口取回被丢弃的 `rank`/`rrf_score`；`MEMORY_TOP_K=3` 会把 precision 量化到 {0,⅓,⅔,1} ⇒ 评测须在可配置 K 上跑。资产：[research-rag-eval.md](research-rag-eval.md)

- **【店长裁决 · 链锚口径与观察单位】**（2026-09-13，非票单）— **观察单位 = 执行跳（`execution_logs` 行），链锚 = `coalesce(回复消息.task_id, 触发消息.task_id)`**。依据三条实测（dev 库 1081 行）：① **失败的跳不产生消息行**——头号链 `9b4509e7` 27 消息行 / 25 执行跳 / `completed 21 + failed 4`，4 条失败跳 `reply_chars=0`；按消息行分组会**静默吞掉卡点本身**（页面显示"27 行都回了"，实际 4 跳死了）② 耗时/瀑布只能从 `execution_logs` 的 `started_at`/`ended_at` 算，两张表分组口径不一致会导致「页面显示 27 跳、瀑布只画 25 条」的自相矛盾 ③ 触发侧链锚覆盖 67.5%、回复侧 92.5%、coalesce **97.4%**。**该链跨度 3846 秒（64 分钟）**，是「耗时最长」切面的真实样本

## Not yet specified

<!-- 看得见但还说不清的问题，随 frontier 推进毕业成票 -->

- 评测集从哪来、标注成本谁承担（黄金标注集是整张图里最贵的一块）
- 服务对象的最终形态：人看板 / 调参判据 / CI 门禁
- trace 看板的形态——**粒度已定**（执行跳 + coalesce 链锚，见 Decisions）；**卡点判据仍未定**：失败跳 / 超阈值跳 / 等锁时长 / 无回复跳，四者是否都算，阈值取多少
- **孤儿跳**（28 行 = 2.6%，既无回复、触发消息也无 `task_id`）在链路视图里怎么呈现——是单列一组，还是并入"未归属"
- L2 判官自身可不可信——判官分与人工回标的一致性怎么度量
- 除记忆库外，调度 / token 池 / CLI 适配器要不要各自建口径
- 指标序列的留存策略（保留多久、降采样与否）

## Out of scope

（空）

## Tickets

- ~~**T1 票单：RAG 检索评估生态与落地路径** — `T1-rag-eval-landscape.md`~~ ✅ **已关票**（2026-09-13，见 Decisions so far）
- ~~**T2 票单：Trace 可观测性与评测平台** — `T2-trace-observability.md`~~ ✅ **已关票**（2026-09-13，见 Decisions so far）

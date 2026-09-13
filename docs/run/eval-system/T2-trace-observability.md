<!-- wayfinder:research (AFK) -->
<!-- parent: map.md -->

# T2 Trace 可观测性与评测平台

Claimed by: flash猫
Blocked by: —

## Question

用户要能回答「**卡点在哪**」「**哪里耗时最长**」。现在的障碍不是没数据，是数据没有 span 结构：`execution_logs` 是扁平行，`messages.task_id` 才是链锚（`trace_id` 是当轮执行 id，73.7% 与链锚不等）。

调研 trace / 可观测性侧，回答三件事：

1. **span 数据模型**：OpenTelemetry GenAI semantic conventions 现在长什么样（span 类型、父子关系、`gen_ai.*` 属性键名、有没有覆盖流式首 token 延迟 / 工具调用 / 重试）？Langfuse / Arize Phoenix / LangSmith / promptfoo / W&B Weave / Braintrust 各自的数据模型与它对齐到什么程度？
2. **耗时分解能力**：哪些工具能天然拆出「排队等待 → 上下文组装 → 记忆检索 → LLM 首 token → 流式输出 → 工具调用 → 落库」，哪些只给总时长？**卡点的定义**别家用什么判据（超时？重试？空回复？无进展？）
3. **接入代价**：哪些能**离线 ingest**（我们从 SQLite 导出喂给它，而不是改造线上链路）、哪些必须实时埋点；TS SDK 有没有；自托管要几个进程/容器（我们已有一个 embed sidecar 先例）；许可证。

## Verification

- OTel GenAI semconv 以**官方规范当前版本**为准，给出属性键名的真实字面量，不要二手转述
- 平台的能力断言给官方文档出处 + 信息日期
- 必须产出一张**映射缺口清单**：`{messages, execution_logs, dispatch_state}` → 目标 span 模型，缺哪些字段
- 明确回答：「自建一张 span 表」vs「自托管 Langfuse/Phoenix」哪个更省，理由要对得上我们的栈（TS/SQLite/本地）

## Resolution

**状态：已解决（2026-09-13 · flash猫）** · 资产：[research-trace-observability.md](research-trace-observability.md)

### 三问的答案

**1. span 数据模型** —— OTel GenAI semconv **已搬家**：核心仓库 v1.42.0 起弃用 `gen_ai.*`，`opentelemetry.io/docs/specs/semconv/gen-ai/` 与 `semantic-conventions/main/docs/gen-ai/` **都已是搬迁存根**（后者正文仅 396 字节）；现役唯一出处是 `open-telemetry/semantic-conventions-genai`（无 tag，引用只能给 commit）。属性键名、18 个 `gen_ai.operation.name` 枚举值、分桶阈值**已字节级核实**（本机直取官方 raw 原文，非转述）。映射到我们：一次执行 = `invoke_agent`，子 span = `retrieval`(记忆/知识库) + `execute_tool` + `chat`。
流式**基本是规范空白**：`### Streaming chunks` 一节正文**全文只有一个词 `TODO`**；可用仅 4 样——`gen_ai.request.stream`、`gen_ai.response.time_to_first_chunk`（span 属性，即我们的 TTFT）、`gen_ai.client.operation.time_to_first_chunk` / `time_per_output_chunk`（直方图）。**无流式 span 类型、无逐 chunk span。**
两个**无标准键**处：**排队等待**（规范里的 `queued` 指 provider 侧，非调度队列）与**重试**（注册表零重试属性）。

**2. 耗时分解能力** —— **六家平台没有一家做卡点检测**，全部是查看器（瀑布/时间线/图视图）；「哪里是瓶颈」在任何一家都得你自己先从 span 里算。凡宣称「自动异常检测」的都归属商业版（Arize AX / Braintrust Enterprise）。我们的六级（排队→上下文→记忆→首 token→流式→工具）**今天一级都拆不出**，已产出完整缺口清单（资产 §3.2）。

**3. 接入代价** —— 许可证**全部字节级核实**：promptfoo MIT / Langfuse 核心 MIT Expat（`ee/` 商业，版权方 ClickHouse, Inc.）/ **Phoenix 是 ELv2**（非 OSI，官方自称 "fully open-source" 不实）/ 其余平台本体闭源。**promptfoo 是唯一与栈同构的**（TS + 本地 SQLite + 零容器，其 `SpanData` 含 `spanId/parentSpanId/startTime/endTime/statusCode`，已直读源码确认）；**Phoenix 最轻但是 Python 进程**（`pip install arize-phoenix` + `phoenix serve`，直读 README 确认），对 pnpm/TS 仓是新增运行时。

### 决定

**自建一张 span 表，不自托管。** 决定性理由：平台的价值全在「收 span + 画瀑布」，而我们的缺口 100% 在「产出 span」——**换平台一分钱都省不掉最重的那块工作**；且 1079 次/30 天的量级用 SQLite 单表足矣。
**纪律**：自建表按 `gen_ai.*` 语义命名（当词汇表，不当运行时依赖），将来接 OTLP 退化为「写一个导出器」，不必重新埋点。

### 两个必须上报的发现

1. **`execution_logs.latency_ms` 全表 100% NULL**（1079/1079，[实测]）。机制已定位：`reply.ts:1077` 的诊断 UPDATE **写值成功**，随后 `finalizeRun`（`serial.ts:249`，opts 类型 `:253` 无 `latencyMs`）→ `finalizeExecutionLog` 以 `null` **覆盖同一列**（`executionLogs.ts:272-278` WHERE `status='running'` 仍命中）。连带 **L1 的 `avgLatencyMs` 永远返回 null**（`l1-aggregator.ts:123`）。**修它只需一行**，且一次白得两段耗时（LLM 段 + 等 token/持锁段）。
2. **命名陷阱**：我们的 `execution_logs.trace_id` 是**当轮执行 id**，OTel 的 `trace_id` 语义对应**链锚** `messages.task_id`。同名搬运会把整条链碎成互不相干的 trace。链锚不等率本次复核：1068 行中 235 条不等、340 条 `task_id` 为空。

### 顺带确认（不需新平台即可得）

近 30 天 completed 1008 次：均值 **198.8 s**、最长 **1317 s**、**80% 超 60 s**；按猫 flash猫 358 s / ds猫 334 s / 店长 167 s / 吐槽猫 167 s；最长链 **15 跳**。**「哪里耗时最长」的粗粒度版今天就能答**——缺的只是端点与页面。

### 留给 `map.md` 的接口

- 资产在 `docs/run/**`，**不在飞轮扫描白名单**（`scan.mjs:53` 白名单 = `docs/adr/` `docs/lessons/` `docs/plans/`）——要成为可检索记忆须上浮到 `docs/plans/`。
- **候选毕业票（不自行开票，归店长）**：①「修 `latency_ms` + L1 端点 + 链路 tab」——**不阻塞在任何决策上，可立即开工**；②「span 表结构定稿」——可与 T1 的表结构决定合并（同为「一次做对」性质）；③ 形态拍板（人看板/调参判据/CI 门禁）——**本票不能代答，地图 Destination 仍是草案**。
- 「Not yet specified」里「trace 看板的粒度与形态」一条已被本票specifiable（链视图 + 耗时瀑布 + 自定义排队 span），**graduation 交店长**。

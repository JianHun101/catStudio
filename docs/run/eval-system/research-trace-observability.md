# T2 调研资产：Trace 可观测性与评测平台

<!-- 票单: T2-trace-observability.md | 认领: flash猫 | 日期: 2026-09-13 -->
<!-- 证据等级：**[字节级]** = 本机直取官方仓库原文；**[实测]** = 本仓代码/数据库实测；**[二手]** = 检索层转述（未直读页面）；**[未证实]** = 查不到 -->

## 结论先行

**自建一张 span 表，不自托管 Langfuse / Phoenix / LangSmith。** 关键理由不是「它们不好」，而是：

> **调研六家平台后，没有一家的核心价值落在我们真正缺的那一半上。**
> 平台的全部价值 = 「**收 span + 画瀑布图**」。而我们的缺口 100% 在「**产出 span**」这一半——六级耗时一级都拆不出来。选哪家平台，都省不掉这块最重的工作。

三条支撑：

1. **落地成本差一个量级。** Langfuse 自托管是 web + worker + Postgres + ClickHouse + Redis + MinIO **六件套**（[二手]，见 §2 注）；Phoenix 最轻但**是 Python 进程**（`pip install arize-phoenix` + `phoenix serve`，**[字节级]**）——本仓是 pnpm/TS，现有唯一的常驻 sidecar 是 Node（`scripts/flywheel/embed-server.mjs`），引入 Python 运行时是新增运维面。自建 = 一张 SQLite 表 + 一个 REST 端点 + 一个前端 tab。
2. **量级根本不需要列存。** 近 30 天 **1079 次执行 / 1008 次完成 [实测]**。这个规模 SQLite 单表聚合毫秒级返回，ClickHouse 换不来任何东西。
3. **有些平台我们已经在重复造了。** Langfuse/Phoenix 的评测能力（LLM-as-judge、人工回标）对应我们的 L2/L4，已经接线并在前端可见。

**但推荐的形态有个关键限定：自建表，按 OTel 语义命名。**

不是「照着 OTel SDK 接一遍」——是用 `gen_ai.*` 的字面量当**字段词汇表**，不当**运行时依赖**。这样今天零新依赖、零新进程，将来若真要接 OTLP 汇聚端，写一个导出器即可，**不需要重新埋点**。这是自建方案唯一需要守住的纪律，也是它不成为技术债的全部理由。

**以及一个必须先修的地基问题（本次调研最意外的发现）：**

> **`execution_logs.latency_ms` 在库里是 100% NULL——1079 行无一例外 [实测]。**
> 不是没采集，是**采集后被覆盖清空**。这条列正是「哪里耗时最长」唯一现成的答案，现在读出来永远是空。L1 八口径里的 `avgLatencyMs` 因此永远返回 null。
> 修它**只需一行**，且一次修好白得两段耗时（§4.2）。

---

## §1 OTel GenAI semconv 现状（字节级核实）

> **取证方式**：本机 `node fetch` 直取官方仓库 raw 文件全文（`gen-ai-spans.md` 120734 字节、`gen-ai-metrics.md` 98206 字节、`model/gen-ai/registry.yaml` 43067 字节）。下列字面量均为原文逐字拷贝，非转述。

### 1.1 先纠正一个会踩的坑：规范已经搬家

`https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/` 与核心仓库 `semantic-conventions/main/docs/gen-ai/gen-ai-spans.md` **都已是搬迁存根**——后者正文全文仅 396 字节，写着 "This page has moved and is no longer maintained in this repository"（**[字节级]**）。

**现役规范唯一出处**：`https://github.com/open-telemetry/semantic-conventions-genai`（`gen_ai.*` 在核心仓库 v1.42.0 起弃用）。该仓库**无 tag 发布**，引用只能给 commit hash 或 `main`。

### 1.2 span 类型与命名

Inference span 命名（**[字节级]**，原文）：`**Span name** SHOULD be `{gen_ai.operation.name} {gen_ai.request.model}``，span kind SHOULD be `CLIENT`。

`gen_ai.operation.name` 的**完整闭集**（registry.yaml 逐条拷贝，共 18 个）：

```
chat · generate_content · text_completion · embeddings · retrieval · fetch_response
create_agent · invoke_agent · execute_tool · invoke_workflow · plan
search_memory · create_memory · update_memory · upsert_memory · delete_memory
create_memory_store · delete_memory_store
```

**映射到我们**：一次执行 = `invoke_agent`，子 span = `retrieval`（记忆库 + 知识库各一）、`execute_tool`（工具调用）、`chat`（LLM 推理）。

### 1.3 我们要用的属性键（逐字）

| 我们的字段                         | OTel 键（逐字）                                              | 要求级别               |
| ---------------------------------- | ------------------------------------------------------------ | ---------------------- |
| `agents.llm_provider`              | `gen_ai.provider.name`                                       | Required               |
| `agents.llm_model`                 | `gen_ai.request.model`                                       | Conditionally Required |
| `agents.llm_max_tokens`            | `gen_ai.request.max_tokens`                                  | Recommended            |
| `agents.llm_temperature`           | `gen_ai.request.temperature`                                 | Recommended            |
| `agents.effort_level`              | `gen_ai.request.reasoning.level`（值 `low`/`medium`/`high`） | Recommended            |
| `agents.name` / `agents.id`        | `gen_ai.agent.name` / `gen_ai.agent.id`                      | Conditionally Required |
| `session_id`                       | `gen_ai.conversation.id`                                     | Conditionally Required |
| `execution_logs.prompt_tokens`     | `gen_ai.usage.input_tokens`                                  | Recommended            |
| `execution_logs.completion_tokens` | `gen_ai.usage.output_tokens`                                 | Recommended            |
| `execution_logs.error_type`        | `error.type`                                                 | Conditionally Required |
| 工具名 / 工具调用 id               | `gen_ai.tool.name` / `gen_ai.tool.call.id`                   | Required / Recommended |
| 检索 top-K                         | `gen_ai.retrieval.top_k`                                     | Recommended            |

**注意**：`gen_ai.usage.prompt_tokens` / `completion_tokens` 是**已弃用**的旧名，现役是 `input_tokens` / `output_tokens`（**[字节级]**，registry 中旧名保留为 deprecated 别名）。我们库里叫 `prompt_tokens`，导出时需换名。

`error.type` 是这堆里**唯一 Stable 的属性**，其余 `gen_ai.*` 全部 Development。

### 1.4 流式：规范这块基本是空的

这是本次调研**最有价值的负面结论**，逐条如下：

- 规范里有一节叫 `### Streaming chunks`，正文**全文只有一个词：`TODO`**（**[字节级]**，`gen-ai-spans.md:1356-1358`）。流式的分块语义**尚未定义**。
- 流式能用的只有**四样**（都是平的属性/直方图，无 span 结构）：
  - `gen_ai.request.stream`（boolean，"If and only if the request is streaming"）
  - `gen_ai.response.time_to_first_chunk`（double，秒，**是 inference span 上的属性**，原文："Time to first chunk in a streaming response, measured from request issuance"）——**这正是我们要的 TTFT**
  - `gen_ai.client.operation.time_to_first_chunk`（Histogram，`s`，分桶 `[0.01 … 81.92]`）
  - `gen_ai.client.operation.time_per_output_chunk`（Histogram，`s`，同桶）
- **不存在**流式专用 span 类型、**不存在**逐 chunk 的 span/event。chat span 仍覆盖整段流。
- `gen_ai.server.time_to_first_token`（Histogram）是**服务端**指标，不是 span 属性；第三方把它当 span 属性用属于非规范实践。

**含义**：TTFT 有标准键可用（`gen_ai.response.time_to_first_chunk`），但「流式期间的停顿/卡顿」**没有标准建模**——真要抓得靠 `time_per_output_chunk` 的分布，或自定义属性。这块是规范空白，不是我们没找对键。

### 1.5 时长指标与分桶（可直接抄）

| 指标                               | 单位 | ExplicitBucketBoundaries                                                                                                                                                        |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.client.operation.duration` | `s`  | `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]`                                                                                      |
| `gen_ai.invoke_agent.duration`     | `s`  | 同上（原文：「end-to-end duration of a single in-process agent invocation, from the moment the invocation starts until the agent emits the last chunk of its final response」） |
| `gen_ai.execute_tool.duration`     | `s`  | 同上                                                                                                                                                                            |
| `gen_ai.invoke_workflow.duration`  | `s`  | `[1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200]`                                                                                                                           |

`gen_ai.invoke_agent.duration` 的定义与我们的 `execution_logs` **一对一吻合**——它就是「一次 agent 调用从开始到吐出最后一 chunk」。

**分桶选型建议**：我们 30 天均值 198.8 s、最长 1317 s **[实测]**。client.operation 那组桶（最大 81.92 s）**会把我们几乎所有样本压进最后一个桶，等于没有分辨率**。要抄就抄 `invoke_workflow.duration` 的 `[1,5,10,30,60,120,300,600,1800,3600,7200]`。

### 1.6 两个我们**没有标准键可用**的地方

1. **排队等待（本仓调度队列）**：规范里的 `queued` 指的是 **provider 侧**——`gen_ai.response.status` 的取值 `queued`「The response has been accepted by the provider but generation has not started yet」（**[字节级]**）。我们的 FIFO 槽位排队、token 池等待**没有对应概念**，只能自定义属性。
2. **重试**：`gen_ai.*` 注册表里**没有任何重试属性**（无 `retry_count` / `attempt`）。规范唯一的表述是时序层面的：「If a transient issue happened and the request was retried automatically, the corresponding span SHOULD cover the duration of the logical operation with all retries.」（**[字节级]**）——即重试不单独建 span，合并进父 span 时长。我们无重试（失败即失败），此条无影响。

---

## §2 平台对账

### 2.1 许可证（**全部字节级核实**，直读各仓库 LICENSE / package.json）

| 平台              | 许可证（实测）                                                                                                                          | 核实方式          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **promptfoo**     | **MIT**（`package.json` `"license": "MIT"`，版本 0.123.0）                                                                              | 直读 package.json |
| **Langfuse**      | 核心 **MIT Expat**；`ee/`、`web/src/ee/`、`worker/src/ee/` 走 `ee/LICENSE` 商业许可。版权行：`Copyright (c) 2023-2026 ClickHouse, Inc.` | 直读 LICENSE 全文 |
| **Arize Phoenix** | **Elastic License 2.0 (ELv2)** —— 原文首行即是。**非 OSI 认证**，属 source-available                                                    | 直读 LICENSE 全文 |
| W&B Weave         | Apache-2.0（SDK 仓库）                                                                                                                  | GitHub API        |
| Braintrust SDK    | Apache-2.0（SDK 仓库；**平台本身闭源 SaaS**）                                                                                           | GitHub API        |
| OpenLLMetry       | Apache-2.0                                                                                                                              | GitHub API        |
| LangSmith SDK     | MIT（**仅 SDK**；平台后端闭源）                                                                                                         | GitHub API        |

**注意两处易被营销话术带偏的地方**：Phoenix 官方自称 "fully open-source"，**实际是 ELv2**（禁止把它作为托管服务转售）；LangSmith/Braintrust 的 SDK 是开源的，但**平台不是**，SDK 的许可证不能推广到平台。

活跃度（GitHub API，2026-09-13 取样）：promptfoo ★25057 / 最近推送 2026-09-13；Langfuse ★34527 / 2026-09-13；Phoenix ★11435 / 2026-09-12；OpenLLMetry ★7427 / 2026-08-10。**六家都活跃**，维护度不构成区分度。

### 2.2 自托管 footprint 与 ingest

| 平台          | 自托管组件数                                                                                                              | OTLP ingest                                                                                              | TS SDK                       | 旁路离线喂历史数据                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| **promptfoo** | **0**（本地 CLI/库，**trace store 是本地 SQLite**）                                                                       | 内置接收器 `:4318/v1/traces`，收 JSON + protobuf                                                         | `promptfoo`                  | ✅ 最省                                   |
| **Phoenix**   | **1**（但**是 Python 进程**：`pip install arize-phoenix` + `phoenix serve` **[字节级]**；默认 SQLite，生产建议 Postgres） | `:6006/v1/traces`（protobuf）+ gRPC `:4317`                                                              | `@arizeai/phoenix-otel`      | ✅ 次之                                   |
| **Langfuse**  | **6**（web / worker / Postgres / ClickHouse / Redis / MinIO）[二手]                                                       | `/api/public/otel/v1/traces`，**HTTP only 无 gRPC**；另有纯 JSON 批量 API `/api/public/ingestion` [二手] | `langfuse` 等                | ✅ 但重                                   |
| LangSmith     | ~10 [二手]                                                                                                                | OTLP + 非 OTLP JSON 批量 API                                                                             | `langsmith`                  | ⚠️ 自托管需 Enterprise 授权 + beacon 外联 |
| Braintrust    | 多（Brainstore 三节点等）[二手]                                                                                           | OTLP                                                                                                     | `braintrust`                 | ⚠️ 控制面仍是 SaaS，自托管需 Enterprise   |
| Weave         | K8s + MySQL + Redis + ClickHouse [二手]                                                                                   | OTLP protobuf                                                                                            | `weave`                      | ⚠️ 需 W&B Server 商业授权                 |
| OpenLLMetry   | **N/A（无后端，只是埋点库）**                                                                                             | **只发不收**                                                                                             | `@traceloop/node-server-sdk` | ❌ 无 store                               |

**P0 事实核查（我唯一直接验证过 store 实现的一家）**：promptfoo 的 trace store 确实是本地库——`src/tracing/store.ts` 直读：定义 `SpanData { spanId, parentSpanId?, name, startTime, endTime?, attributes?, statusCode?, statusMessage? }`，底层是 `@libsql/client` + drizzle（SQLite 系），**[字节级]**。这是全场**与本仓技术栈最接近**的一家：TS/Node + 本地 SQLite + MIT + 零容器。

**统一的负面结论（六家一致）**：

> **没有任何一家做「卡点检测」。** 全部是**查看器**（瀑布图 / 时间线 / 图视图）。「哪里是瓶颈」在每一家都是**你自己算出来的**——前提是你先吐出了带时长的 span。凡宣称「自动异常检测」的，都归属其**商业版**（Arize AX / Braintrust Enterprise）。
> 这一条直接决定了 §5 的结论：**换平台解决不了我们的问题，因为我们缺的不是查看器。**

---

## §3 映射缺口清单：`{messages, execution_logs, dispatch_state}` → 目标 span 模型

### 3.1 我们已有的（[实测]，`db/index.ts` 建表 + 迁移链）

`execution_logs` = 天然的 turn span：`id` / `session_id` / `agent_id` / `triggered_by_message_id` / `message_id` / `status` / `trace_id` / `started_at` / `ended_at` / `latency_ms` / `error_message` / `error_type` / `prompt_chars` / `reply_chars` / `prompt_tokens` / `completion_tokens` / `commit_hash` / `packages_installed`。

`messages`：`id` / `task_id`（**链锚**）/ `dispatch_state`（`queued`|`running`|`done`）/ `created_at` / `segments` / `tool_content`。

### 3.2 缺口

| 目标 span 字段         | 今天 | 缺什么                                                                                                                                  |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| turn span 身份         | ✅   | `execution_logs.id` 直接可用                                                                                                            |
| **父指针**             | ❌   | 表内**无 `parent_span_id` 列**；链只能靠 JOIN `messages.task_id` 反推                                                                   |
| span 起止              | ⚠️   | `started_at`/`ended_at` 是**秒级字符串**；`latency_ms` 本可给毫秒但**已死**（§4.1）                                                     |
| **排队等待**           | ❌   | `dispatch_state` 是**可变当前值、无时间戳**——入队/出队时刻落库即丢。只能用 `messages.created_at → started_at` 代理，对重放/恢复路径不准 |
| **等 token 池**        | ❌   | `tokenPool.acquire()`（`serial.ts:431`）无埋点。窗口 = `started_at` → `runAgentReply` 的 `t0`，今天算不出                               |
| **上下文组装**         | ❌   | `getRecentMessages` + 过滤 + token 估算（`reply.ts:228` 起）无埋点                                                                      |
| **记忆检索**           | ❌   | `retrieveMemoryContext` 有 10 s 超时兜底（`reply.ts:625`）但无耗时埋点；命中身份只在 `log.info` 里，**不落库**                          |
| **知识库检索**         | ❌   | `buildKnowledgeContext` 同上                                                                                                            |
| **首 token 延迟**      | ❌   | **全仓零埋点**——`grep -rn "firstToken\|ttft\|TTFT\|timeToFirst"` 在 `packages/{server,shared,web}/src` **零命中** [实测]                |
| **流式输出时长**       | ❌   | 整个 `for await (const chunk of stream)` 循环无计时                                                                                     |
| **工具调用时长**       | ❌   | `ToolCallInfo`（`shared/src/types.ts:259`）只有 `id/name/status/input/output/isError/truncated`，**无任何时间字段**                     |
| **落库 / auto-commit** | ❌   | 均无埋点                                                                                                                                |
| 错误分类               | ✅   | `error_type`（69 行有值）                                                                                                               |
| token 用量             | ✅   | `prompt_tokens`/`completion_tokens`（1006/1079 有值）                                                                                   |
| 重试                   | —    | 无重试概念，无需求                                                                                                                      |

**一句话**：今天是「**一次执行一个总时长**」，且这个总时长**还是坏的**。六级拆分——排队、上下文、记忆、首 token、流式、工具——**一级都拿不到**。

### 3.3 ⚠️ 命名陷阱：我们的 `trace_id` ≠ OTel 的 `trace_id`

`execution_logs.trace_id` 是**当轮执行 id**；链锚是 `messages.task_id`（实测 1068 条执行行中 **235 条两者不等、340 条 `task_id` 为空** [实测，本次复核]）。

而 OTel 的 `trace_id` 指的是**整条分布式调用链**的 id——语义上对应我们的**链锚**，不是当轮执行 id。

**导出到任何 OTLP 汇聚端时，`execution_logs.trace_id` 必须映射为 span 身份（spanId 一侧），链锚 `task_id` 才是 OTel `trace_id`。** 直接同名搬运会让整条链碎成互不相干的 trace。这个坑现在不碰，但**表结构命名时要留出正确的位置**，否则将来要动数据。

---

## §4 实测：今天的库能回答什么

> 数据源：`packages/server/data/cat-study-dev.db`，只读打开（服务器在跑，WAL 只读无干扰）。窗口 2026-08-28 ~ 2026-09-13。

### 4.1 `latency_ms` 被覆盖清空的机制

```
latency_ms   非空 : 0 / 1079
prompt_tokens 非空: 1006 / 1079     ← 同一条 UPDATE 写的，它活着
```

`prompt_tokens` 与 `latency_ms` 由**同一条 UPDATE** 写入（`db/repository/executionLogs.ts:282` `updateExecutionLogDiagnostics`）。所以「诊断函数没跑」解释不了——**它跑了、写进去了、然后被抹掉**。

抹掉它的是紧跟着的 `finalizeExecutionLog`：

1. `reply.ts:1077` `updateExecutionLogDiagnostics(agent.id, { latencyMs, … })` —— 此刻行仍是 `status='running'` → **UPDATE 命中，写值成功**
2. 回复返回 → `finalizeRun`（`serial.ts:249`）→ `completeExecution`（`serial.ts:1261`）→ `finalizeExecutionLog(agentId, 'completed', `opts?.latencyMs ?? null`, …)`
3. `finalizeRun` 的 opts 类型里**根本没有 `latencyMs`**（`serial.ts:253`），函数体也从不传 → 实参即 `null`
4. 该 UPDATE（`executionLogs.ts:272-278`）的 WHERE 是 `agent_id=? AND status='running' ORDER BY started_at DESC LIMIT 1` —— **行此刻仍是 running，命中**，把好值**覆盖成 NULL**

**结论**：`latency_ms` 由成功路径的 `finalize` 自我清空，1008 行无一幸免。失败路径同理（`finalize` 同样不传）。

**连带后果**：L1 八口径的 `avgLatencyMs`（`eval/l1-aggregator.ts:123` 赋值、`:170` 报告行）**永远返回 null**。它不在告警阈值里（阈值只有 successRate/timeoutRate/reworkRate），所以没人发现。口径接好了，数永远是空的。

### 4.2 修一行，白得两段耗时

把 `latencyMs` 从 `finalizeRun` 透传下去（或让 `finalizeExecutionLog` 用 `COALESCE(?, latency_ms)`），立刻得到：

- **LLM 段耗时** = `latency_ms`——`t0` 打在 `runAgentReply` 开头（`reply.ts:207`），跑到流结束。**含上下文组装 + 记忆检索 + 知识库检索 + LLM 流**（所以它本身仍是一个合并段，但比现在什么都没有强得多）
- **前置开销** = `(ended_at - started_at) - latency_ms` ≈ **等 token 池 + 等 claude 锁 + finalize/drain**（秒级精度，够定位）

两段一分开，「卡点在哪」立刻从「这次执行 5 分钟」变成「等 token 等了 4 分钟」这类**可行动**结论。**这是整条路上性价比最高的一刀，而且它是 bug 修复，不是新项目。**

### 4.3 即使带病，粗粒度数字今天就能算

用 `ended_at - started_at` 代替，近 30 天 completed **1008** 次：

| 指标        | 值                          |
| ----------- | --------------------------- |
| 平均墙钟    | **198.8 s**                 |
| 最短 / 最长 | 2 s / **1317 s**（≈22 min） |
| ≥ 60 s      | 807 次（**80%**）           |
| ≥ 5 min     | 192 次                      |
| ≥ 10 min    | 54 次                       |

按猫（近 30 天 completed）：

| 猫      | 次数 | 平均        | 最长   |
| ------- | ---- | ----------- | ------ |
| flash猫 | 61   | **358.2 s** | 1222 s |
| ds猫    | 124  | **334.4 s** | 1317 s |
| 店长    | 631  | 166.6 s     | 1280 s |
| 吐槽猫  | 192  | 166.5 s     | 839 s  |

链长分布（按 `task_id` 归链）：单跳 113 条，3 跳以上约 96 条，**最长链 15 跳**。

**意义**：这证明「哪里耗时最长」**不需要先上外部平台**——数据已经在库里，缺的只是一个端点 + 一个页面。

---

## §5 决定：自建 span 表 vs 自托管 —— **自建**

### 5.1 决策依据

| 判据                                | 自建          | 自托管                                     |
| ----------------------------------- | ------------- | ------------------------------------------ |
| 是否省掉「产出 span」这块最重的工作 | —             | **否，一分都不省**（六家都是查看器）       |
| 新增运行时/进程                     | 0             | 1（Phoenix，Python）~ 6 容器（Langfuse）   |
| 新增依赖                            | 0             | npm 包 + 可能的 Python 工具链              |
| 许可证风险                          | 无            | Phoenix = ELv2（source-available，非 OSI） |
| 与现有 L2/L4 评测重叠               | 无            | 有（judge / 回标能力重复）                 |
| 我们的量级（1079 次/30 天）         | SQLite 毫秒级 | 列存无收益                                 |
| 未来若要换/扩                       | 写导出器      | —                                          |

**唯一对自托管的有利点**：现成的瀑布图 UI、成本追踪、社区生态。但瀑布图的前端工作量本身不大（我们已有 `EvaluationView` 双 tab 的先例），而**它依赖的 span 数据我们反正得先造出来**。

### 5.2 但守住一个纪律：**字段用 OTel 语义命名**

自建最容易变成技术债的地方是**自造一套私有词汇**，将来想接标准工具就得重新埋点。规避方式：

- span 名用 `gen_ai.operation.name` 的**闭集值**（`invoke_agent` / `retrieval` / `execute_tool` / `chat`）
- 属性键照 §1.3 的逐字表落进 `attributes` JSON
- `status` / `error_type` 对齐 `error.type` 的取值习惯（`timeout` 等低基数标识）
- 分桶阈值抄 `gen_ai.invoke_workflow.duration` 的 `[1,5,10,30,60,120,300,600,1800,3600,7200]`（**别抄 client.operation 那组，最大 81.92 s，对我们等于无分辨率**）
- §3.3 的 `trace_id` 语义陷阱按正确映射预留

做到这些，「将来接 OTLP」就退化成**写一个导出器**，而不是重做一遍。

### 5.3 什么情况下该推翻这个决定

诚实标注边界：

- 若**用户要的是「现成看板，今天就能点开看」**，而非「数据可得」——自建的 UI 需要几天，Phoenix 起一个容器当天就有瀑布图。**这是形态选择，不是技术选择**，归 Destination 那次拍板（地图上仍是草案）。
- 若未来要接**多机/多服务**的分布式追踪，自建表的价值会快速衰减——那时该直接上 OTLP。
- 若 Span 量涨到**百万级**（当前 1079/月，差三个数量级），SQLite 单表开始吃力。

---

## §6 落地建议（最小改动集）

按性价比排序，**前两步几乎零成本**：

**第 0 步（bug 修复，1 行）**：`finalizeRun` 透传 `latencyMs`，或 `finalizeExecutionLog` 用 `COALESCE(?, latency_ms)`。立刻复活 `latency_ms` + L1 的 `avgLatencyMs` + §4.2 的两段拆分。

**第 1 步（端点 + 页面，零新表）**：`GET /api/eval/traces?session_id=&limit=` 聚合 `execution_logs`，前端 `EvaluationView` 加第三个 tab「链路」。**只解决「哪里耗时最长」的粗粒度版**，且立刻可用——§4.3 的数字今天就能画出来。
注意：`/api/eval/aggregates` 这个路径**已被 L2 按猫评分聚合占用**（`routes/eval.ts:47`），L1 八口径要另起路径（如 `/api/eval/l1-metrics`），别撞名。

**第 2 步（建 span 表 + 六级埋点）**：新表 `spans`，字段照 §5.2 的 OTel 语义。埋点六处，全部是 `performance.now()` 差值，不引入任何依赖：

| 埋点位置                                              | 产出 span                                      |
| ----------------------------------------------------- | ---------------------------------------------- |
| `serial.ts:431` `tokenPool.acquire()` 前后 + 入队时刻 | `dispatch.wait`（自定义，规范无此概念）        |
| `reply.ts:228` 上下文组装前后                         | `context.assemble`（自定义）                   |
| `reply.ts:625` `retrieveMemoryContext` 前后           | `retrieval`（记忆库）                          |
| `reply.ts:678` `buildKnowledgeContext` 前后           | `retrieval`（知识库）                          |
| 适配器 `chatStream` 首个 chunk                        | `chat` + `gen_ai.response.time_to_first_chunk` |
| `reply.ts:854` `mergeToolSegment` 处                  | `execute_tool`                                 |

**第 3 步（可选）**：给 `ToolCallInfo` 加 `startedAt`/`durationMs`——工具耗时目前**完全没有落点**（`shared/src/types.ts:259`）。

**不建议现在做**：引入 `@opentelemetry/*` SDK 或自托管任何平台（理由见 §5.1）。若确要走 SDK 路线，需先走【安装请求】流程。

---

## §7 未证实清单（诚实标注）

**未能完成的验证**：票单要求「以官方规范当前版本为准，给出属性键名的真实字面量」。§1 的键名/桶值/枚举**已字节级核实**（本机直取官方仓库原文）。但 **§2 的组件数、OTLP 端点路径、各平台内部能力**中，除许可证外**均未直读官方页面**——本环境的 `WebFetch` 不可用、`curl` 被权限拒绝，检索层返回的是摘要而非原文。以下条目**明确标为未证实**，落地前需直读：

- Langfuse 自托管「6 容器」的**具体构成**（[二手]，来源为检索摘要；许可证侧已字节级确认 `ee/` 边界与 ClickHouse 版权行）
- Langfuse OTLP 端点路径 `/api/public/otel/v1/traces` 与「仅 HTTP 无 gRPC」（[二手]）
- Phoenix「单容器」——**但已字节级确认它是 Python 进程**（README 原文 `pip install arize-phoenix` / `phoenix serve`），这一点足以支撑 §5.1 的运行时判断
- Phoenix `/v1/traces` 是否接受 `application/json`（[未证实]；文档只写 protobuf）
- LangSmith / Braintrust / Weave 的组件数与端点路径（[二手]）
- 各平台「是否内置异常检测」的否定结论（基于检索摘要；但**六家一致**，且与「平台本体是收 span + 展示」的产品定位自洽）

**一处需要复核的外部事实**：检索层称 promptfoo 已被 OpenAI 收购（2026-03-09）并承诺保持 MIT。我字节级确认了**当前** `package.json` 是 `"license": "MIT"`、版本 0.123.0，**但未能核实收购本身**。「MIT 是对现有代码的现状描述，不构成对未来版本的保证」——若 promptfoo 进入选型，此条须独立复核。

**方法说明**：本报告凡标 **[字节级]** 处，均为本机 `node fetch` 直取官方仓库 raw 文件后逐字拷贝，可复现。凡标 **[二手]** 处，来自检索层摘要，未直读页面。

---

## §8 与地图的接口（交给 `map.md`）

- **本资产是 `docs/run/**`，不在飞轮扫描白名单**（`scripts/flywheel/scan.mjs:53` 白名单 = `docs/adr/` `docs/lessons/` `docs/plans/`）——**结论若要成为可检索记忆，须上浮到 `docs/plans/`**。
- **下一票候选（供店长收敛时取舍）**：
  1. 「修 `latency_ms` 覆盖 + L1 端点 + 链路 tab」——**可独立成票，且不阻塞在任何决策上**（第 0/1 步，§6）
  2. 「span 表结构定稿」——依赖 §5.2 的 OTel 语义纪律，可与 T1 的表结构决定**合并成一张票**（两张表都是「一次做对」性质）
  3. 「形态拍板：人看板 / 调参判据 / CI 门禁」——**仍是地图 Destination 的草案，本票不能代答**

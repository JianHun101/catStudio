# R2 设计票：span 表（一次执行的段分解）

> 归属：评估体系 P2 的 R2。**本票只定设计（表形态 + 字段 + 段名闭集 + 埋点落点），不含实施。**
> 实施另开票——理由见 P2 设计票 §八（采集点落在 token 池 / serial 事故密集区，一票一风险面）。
> 基线：`dev @ 310eb07`（R1 三表已建成、R1-b 已落地）。

## 结论先行

1. **R2 不是「再建一张表」，是给已经存在的两级时间轴补中间层。** 今天的两端是 `execution_logs`（一次执行一个总时长，秒级、且 `latency_ms` 采集带病）与 `retrieval_events`（一次检索，毫秒级）。**中间十级全部不存在**。
2. **表形态：窄骨架 + 类型详情表**——`spans`（15 列，时间轴骨架）+ `span_llm`（9 列，LLM 段详情）。与 R1 同源（R1 的 `retrieval_events` **就是**第一张详情表），但**同源不同形**：R1 拆表是因为有三类粒度不同的东西，R2 不拆到底是因为**段与段是同类东西**（start / duration / parent / name），只有 LLM 段的属性富到值得独立成表。
3. **`gen_ai.*` 语义纪律约束的是导出面，不是存储面。** 故本表**不设 `trace_id` 列**——本仓 `execution_logs.trace_id` 已是「当轮执行 id」，而 OTel 的 `traceId` 语义对应**链锚**。新表用 `chain_id`（本仓既有词汇，见 `executionLogs.ts:263` 的 COALESCE 别名），导出时映射 OTLP `traceId`。
4. **`dispatch.queue_wait` 与 `dispatch.token_wait` 是本票最高价值的两个段**——它们今天**零观测**，且正是「猫没动静 / 幽灵 running / token 池死锁」这类事故的所在。
5. **TTFT 有标准键可用**（`gen_ai.response.time_to_first_chunk`），是全仓零埋点里唯一能对上规范的一项；流式期间的「停顿」规范未建模，本票不假装能抓。

---

## 一、R2 要回答什么

诉求③「哪里耗时最长」今天答不出，因为**一次执行只有一个总时长，且这个总时长还是坏的**（`latency_ms` 曾被 `finalizeRun` 覆盖清空，P1 修了采集但覆盖率仍在爬：实测 dev 库 **41 / 1138**）。

| 今天的观测面                           | 粒度 | 状态                                                                                                                                     |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `execution_logs.started_at → ended_at` | 秒   | 含 token 等待，但把 E 与 F 糊在一起                                                                                                      |
| `execution_logs.latency_ms`            | 毫秒 | 只覆盖 `runAgentReply` 内部（E1–E10），**不含 D（token 等待）**；且**从不传给 `completeExecution`** ⇒ `execution completed` 日志零次打印 |
| `retrieval_events.retrieval_ms`        | 毫秒 | ✅ R1，仅记忆检索一段                                                                                                                    |

**缺的是中间十级**。R2 的交付物就是这十级。

---

## 二、设计依据：前置勘察（实测，非读注释）

来源：flash猫 的 R2 前置勘察（纯只读，零文件改动）。关键结论我逐条抽验成立：

| 抽验项                                          | 我的实测                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `execution_logs` 18 列、**仅 PK 自增索引**      | ✅ `PRAGMA table_info` + `sqlite_master` 实跑                                                                      |
| `completeExecution` 的 `latencyMs` 无调用方传入 | ✅ `git grep -n latencyMs -- serial.ts` 只命中函数自身（`1250/1264/1276/1279`），5 个 `finalizeRun` 调用点无一传入 |
| `serial.ts` / `token-pool.ts` **零计时**        | ✅ 两文件 `Date.now()` + `performance.now()` 合计 **0** 命中                                                       |
| `Chunk` 无时间戳字段                            | ✅ `shared/src/types.ts:276` 只有 `content/done/kind/tool`                                                         |
| 适配器层无流式计时                              | ✅ `llm/` 下 `Date.now()` 全部属 CLI 空闲看门狗 / 就绪轮询，无一属流式                                             |
| `retrieval_events` 15 列含 `param_pool_n`       | ✅                                                                                                                 |

**两个必须写进设计的发现：**

1. **`gitCommit` 是 3 次连续 `execSync`**（`git-utils.ts:167/168/173`）——阻塞**整个 Node 事件循环**，不止本执行。对「哪里耗时最长」而言这是一段跨执行的隐藏停顿，且今天只有一条 `auto commit` 日志、无耗时。
2. **`dispatch.queue_wait`（H 段）在数据里不存在**——`execution_logs` 只在真正开始执行时 `insertExecutionLog`。命令在 `slot.queue` 里等的这段时间**没有任何行**。

---

## 三、表形态裁决

### 3.1 为什么不拆成三张（与 R1 的对照）

R1 拆表（`retrieval_events` / `queries` / `candidates`）的判据是**三类粒度不同的东西**：一次检索 / 一趟查询 / 一个候选片，是 1:N:N 的嵌套，各自有独立身份。

**R2 的所有行是同一类东西**：`{span_id, parent_span_id, name, start_at, duration_ms, status}`。层级靠 `parent_span_id` 自引用表达，**不是粒度不同的表**。

⇒ **判据是「一类东西」，不是「一律拆」或「一律不拆」。** 同一条判据在两张票上给出不同答案，因为被问的对象不同。

### 3.2 为什么不把属性全塞进骨架

段与段的**属性面差异极大**：`llm.chat` 有 model / provider / tokens / TTFT，`dispatch.token_wait` 什么属性都没有（**它的时长本身就是全部数据**）。塞进一张表 = 一堆类型专属列对多数行恒为 NULL——即用户已否决的「把多个字段堆起来」的列形态。

⇒ **骨架只放「每一行都有」的字段；类型专属属性进详情表。**

### 3.3 详情表只有一张（v1 为何只建 `span_llm`）

| 段                                                   | 类型专属属性                                                                    | 处置                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `llm.chat`                                           | provider / model / input_tokens / output_tokens / ttft_ms / stream / max_tokens | **建 `span_llm`**（属性最富、标准键最多、诉求③的主段） |
| `memory.retrieval`                                   | 阈值 / top_k / 23 条候选明细                                                    | **已有 `retrieval_events`（R1）**，直接复用            |
| `dispatch.queue_wait` / `dispatch.token_wait`        | **无**（区分靠段名）                                                            | 骨架即可                                               |
| `context.assemble` / `context.compress`              | 条数 / token 量                                                                 | 骨架即可（v1：`item_count` 通用列）                    |
| `knowledge.retrieval`                                | 命中数 / top_k                                                                  | 骨架即可（v1：`item_count`）                           |
| `diff.collect` / `reply.persist` / `git.auto_commit` | **无**                                                                          | 骨架即可                                               |
| `tool.execute`                                       | tool_name / tool_call_id                                                        | **v1 不做**——需动 `shared` 类型 + 各适配器（见 §八）   |

**关键点**：`retrieval_events` **就是**第一张详情表，R1 已经把这个模式建成并验证过了（三表同事务、绝不抛、窄口径挂 `execution_id`）。R2 不是发明新模式，是**接着用**。

---

## 四、DDL

### 4.1 `spans`（骨架，15 列）

```sql
CREATE TABLE IF NOT EXISTS spans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id        TEXT NOT NULL UNIQUE,
  parent_span_id TEXT REFERENCES spans(span_id),
  chain_id       TEXT,
  execution_id   TEXT NOT NULL,
  session_id     TEXT,
  agent_id       TEXT,
  name           TEXT NOT NULL,
  operation_name TEXT,
  start_at       TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  status         TEXT NOT NULL,
  error_type     TEXT,
  error_message  TEXT,
  item_count     INTEGER
)
```

| #     | 列                             | 语义                                                                                                                     | 可空性            |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 1     | `id`                           | 自增主键（行身份）                                                                                                       | NOT NULL          |
| 2     | `span_id`                      | **span 身份**，`randomBytes(16).toString('hex')`（本仓既有 idiom，见 `reply.ts:847`）。导出时映射 OTLP `spanId`          | NOT NULL / UNIQUE |
| 3     | `parent_span_id`               | 自引用 → `spans(span_id)`；**NULL = 该执行的根 span**。见下方「自引用为何可加 FK」                                       | 可空              |
| 4     | `chain_id`                     | **链锚** = `messages.task_id`。导出时映射 OTLP `traceId`。**注意本仓 `execution_logs.trace_id` 是当轮执行 id，不是此物** | 可空（孤儿跳）    |
| 5     | `execution_id`                 | 挂 `execution_logs.id`——与 R1 同款挂载点                                                                                 | NOT NULL          |
| 6-7   | `session_id` / `agent_id`      | 身份面冗余（看板免 join）                                                                                                | 可空              |
| 8     | `name`                         | **段名**，闭集见 §五                                                                                                     | NOT NULL          |
| 9     | `operation_name`               | OTel `gen_ai.operation.name` 字面量。**NULL = 规范无此概念**（自定义段）                                                 | 可空              |
| 10    | `start_at`                     | ISO 8601 UTC 带毫秒（`2026-09-14T13:20:00.000Z`），与 R1 `retrieval_events.created_at` **同形态**。取 `Date.now()` 生成  | NOT NULL          |
| 11    | `duration_ms`                  | 段时长                                                                                                                   | NOT NULL          |
| 12    | `status`                       | `ok` / `error` / `timeout` / `skipped`                                                                                   | NOT NULL          |
| 13-14 | `error_type` / `error_message` | 复用 `execution_logs` 的分类口径                                                                                         | 可空              |
| 15    | `item_count`                   | **通用**产出计数（上下文条数 / 命中数 / 工具结果条数）；无产出概念的段留 NULL                                            | 可空              |

> **为什么没有 `created_at`**：R1 的 `retrieval_events.created_at` 是「这次检索发生的时刻」——因为那次检索自己没有起止。span 有 `start_at`，**它本身就是时间轴**；再加一个「写入时刻」会造出**两个时间列、语义近似而不同**的混淆面。**一条时间真相。**

> **自引用为何可加 FK**：`PRAGMA foreign_keys = ON`（`db/index.ts:27`）且 SQLite 是**即时检查** ⇒ 同事务内按**拓扑序**插入（根先、子后）即可满足，不需要延迟约束。收益是堵住「父子指向不存在的 span」（原先只靠单测兜）。**`parent_span_id` 与 `span_llm.span_id` 两处 FK 形态由此对称。**

> **为什么时间列用 ISO TEXT 而不是 epoch INTEGER**（实测两向转换均可，故不是可逆性判据）：
>
> - **同库同形态**：R1 的 `retrieval_events.created_at` 已是 ISO TEXT 且已上线有数据；再加一种 epoch INTEGER 会让本库出现**第三种时间形态**（`datetime('now')` 秒级 / ISO 毫秒 / epoch 毫秒）。
> - **自描述**：epoch 毫秒是不可直读的数（`1757856000000`），排查时要先换算。
> - **字典序 = 时间序**（同精度定长、同 UTC 同格式），排序与范围比较照常走索引。
> - 代价：算术（时间差）需 `julianday()` 换算，或由应用层算好写进 `duration_ms`——**本表已有 `duration_ms`，故该代价实际不付**。
> - **与 `execution_logs` 比较注意精度**：那边是 `datetime('now')`（**秒级**，`YYYY-MM-DD HH:MM:SS`），字典序与 ISO 可比，但时间差有亚秒舍入。

> **`item_count` 的定位**：它是骨架上的**通用量**（「这段工作产出/消费了多少个东西」），不是类型专属属性——故不进详情表。判据与 R1 §一 的「外部可变状态快照」同族：它是**写入当时的事实**，事后无法可靠重算。

### 4.2 `span_llm`（LLM 段详情，9 列）

```sql
CREATE TABLE IF NOT EXISTS span_llm (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id       TEXT NOT NULL UNIQUE REFERENCES spans(span_id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  ttft_ms       INTEGER,
  stream        INTEGER NOT NULL,
  max_tokens    INTEGER
)
```

| 列              | OTel 键（逐字）                       | 备注                                                                 |
| --------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `provider`      | `gen_ai.provider.name`                | Required                                                             |
| `model`         | `gen_ai.request.model`                | **快照**——`agents.llm_model` 可变，历史 span 必须自持                |
| `input_tokens`  | `gen_ai.usage.input_tokens`           | 旧名 `prompt_tokens` 已弃用，存储面用新名                            |
| `output_tokens` | `gen_ai.usage.output_tokens`          | 同上                                                                 |
| `ttft_ms`       | `gen_ai.response.time_to_first_chunk` | 规范单位是**秒**（double），本仓存**毫秒**（与全表一致），导出时换算 |
| `stream`        | `gen_ai.request.stream`               | 0/1                                                                  |
| `max_tokens`    | `gen_ai.request.max_tokens`           | 快照                                                                 |

> `provider` / `model` / `max_tokens` 三者都是**快照列**，判据同 R1 §一：`agents` 表是运行态权威且**可变**，事后 join 会拿到「今天的配置」而非「当时的配置」。

### 4.3 索引（4 条）

```sql
CREATE INDEX idx_spans_execution ON spans(execution_id);   -- 看板主路径：按执行取全段时间轴
CREATE INDEX idx_spans_chain     ON spans(chain_id);       -- 与 P1 链锚对齐，跨执行串链
CREATE INDEX idx_spans_start     ON spans(start_at);       -- 时间窗取数
CREATE INDEX idx_spans_name      ON spans(name);           -- 按段聚合（「哪段最耗时」）
```

> `(execution_id, start_at)` 复合索引**不建**——v1 每次执行约 8–12 行，单列索引已足够；建成复合是在为一个不存在的规模付代价。

### 4.4 与 `retrieval_events` 的挂载

**R2 v1 不动 `retrieval_events`**（R1 已发布、已有数据窗口）。记忆检索段的 linkage 走 `execution_id`：

```sql
-- 一次执行的完整时间轴（这是 R2 存在的理由：一条查询回答诉求③）
SELECT s.name, s.start_at, s.duration_ms, s.status,
       (SELECT COUNT(*) FROM retrieval_events r WHERE r.execution_id = s.execution_id) AS has_detail
FROM spans s WHERE s.execution_id = ? ORDER BY s.start_at
```

**为何本次不加 `span_id` 到详情表**：现阶段 `execution_id` 对记忆检索**唯一**（实测 `buildKnowledgeContext` 不写 `retrieval_events`）。若将来知识库检索也落 `retrieval_events`，届时再加 `span_id`（增列 O(1)，见 §九 第 9 条）——**additive 的事不提前付**。

### 4.5 一处必须写明的双写

`spans` 的 `memory.retrieval` 行与 `retrieval_events` 各有一个耗时列。**处置：两者由同一变量、同一次写库写入**（不是两处独立测量）。查询口径：

- `start_at >= <R2 上线时刻>`：取 `spans.duration_ms`
- 跨窗口：`COALESCE(spans.duration_ms, retrieval_events.retrieval_ms)`

R1 窗口的历史行没有 span，**这是唯一不需要编造数据的切法**（同 R1-b 用 `param_pool_n IS NULL` 切窗口的范式）。

---

### 4.6 两表靠什么关联 + id 形态（用户提问后钉死，防实施者自行发挥）

**关联键：`span_llm.span_id` → `spans.span_id`**——不是 `id`。`spans.id` / `span_llm.id` 是**各自表内的行身份**，跨表**没有一条 join 走它们**。

本票**两个身份列的分工**（实测，非设计意图）：

| 列                         | 形态                       | 谁生成                                         | 作用                                                             |
| -------------------------- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `spans.id` / `span_llm.id` | `INTEGER PK AUTOINCREMENT` | **SQLite**                                     | 行身份。表内唯一、仅此而已。当前**零消费方**（无任何 FK 指向它） |
| `spans.span_id`            | `TEXT UNIQUE`（32 hex）    | **应用层** `randomBytes(16)`                   | 业务身份 + 导出面 OTLP `spanId`                                  |
| `spans.execution_id`       | `TEXT`                     | 应用层 `uuid()`（`serial.ts:1232` 的 `logId`） | 挂 `execution_logs.id`                                           |

**为什么自增 id 不会在关联上出问题**（用户担心「多写 / 数据合并容易冲突」）：

1. **关联一律走 TEXT 列**——`execution_id` 挂的 `execution_logs.id` 实测是 `TEXT PRIMARY KEY`，由 `uuid()` 生成（非自增整数）。`span_id` 是 128 位随机数。**合并两个库时这两列天然不撞**。
2. **自增 id 只在表内消费**——`spans.id` 无外键指向，跨库合并时行身份碰撞**不会破坏任何关系**（没有任何 join 依赖它）。
3. **同执行多写不冲突**——同一次执行的 8–12 行在 `finalizeRun` **同一事务**内插入；并发批内 3 个执行体各自成事务，`AUTOINCREMENT` 保证不重复。

> **一处该记的不对称**（不阻塞，防后人照抄困惑）：R1 的三表用 `INTEGER PK AUTOINCREMENT` 做**业务身份**且**互有 FK 指向它**（`retrieval_queries.retrieval_id → retrieval_events(id)`）。R2 用随机 TEXT 做业务身份、`id` 纯行身份。**若将来 R1 三表也需要跨库合并，那处才是真风险点**（两库各自从 1 自增，`retrieval_id` 会串线）——R2 反过来天然免疫。**本票不改 R1**（R1 已上线有数据），仅记此账。

## 五、段名闭集（`spans.name`）

**闭集，实施时不得自由增名。** 新增段名 = 改本表 + 补验收。

| `name`                | `operation_name` | 覆盖段                                      | v1             |
| --------------------- | ---------------- | ------------------------------------------- | -------------- |
| `invoke_agent`        | `invoke_agent`   | 根：一次完整执行（= `execution_logs` 一行） | ✅             |
| `dispatch.queue_wait` | NULL             | H：槽位 FIFO 排队                           | ✅             |
| `dispatch.token_wait` | NULL             | D：token 池等待                             | ✅             |
| `context.assemble`    | NULL             | E1：上下文构建                              | ✅             |
| `context.compress`    | NULL             | E2：压缩 + 软截断                           | ✅             |
| `memory.retrieval`    | `retrieval`      | E3：记忆检索（详情表 = `retrieval_events`） | ✅             |
| `knowledge.retrieval` | `retrieval`      | E5：知识库检索                              | ✅             |
| `llm.chat`            | `chat`           | E7：LLM 流式（详情表 = `span_llm`）         | ✅             |
| `diff.collect`        | NULL             | E9：diff 采集（5s 超时）                    | ✅             |
| `reply.persist`       | NULL             | E8：回复落库                                | ✅             |
| `git.auto_commit`     | NULL             | G2/G3：auto-commit（`execSync`）            | ✅             |
| `tool.execute`        | `execute_tool`   | 工具调用                                    | ❌ 延后（§八） |
| `dispatch.a2a`        | `invoke_agent`   | F6：A2A 子树派发                            | ❌ 延后（§八） |

**判据：`operation_name` 为 NULL 的三个段（queue_wait / token_wait）正是规范 §1.6 认定的「无标准键」区**——本仓的 FIFO 排队在 OTel 里没有对应概念（`gen_ai.response.status='queued'` 指的是 **provider 侧**）。**把「有无标准键」做成一个列值，而不是表结构差异——这就是对勘察里「不是三个口径，是三种段类型」那条结论的落地。**

---

## 六、命名纪律：为什么本表没有 `trace_id`

研究底稿 §3.3 已实测：`execution_logs.trace_id` 是**当轮执行 id**，与 OTel 的 `traceId`（整条调用链）**不是一回事**——真实库里 1068 条执行行中 **235 条两者不等、340 条 `task_id` 为空**。

三条路：

| 方案                                                | 判定                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 建 `trace_id` 列，装 OTel 语义（链锚）              | ❌ **同名不同义**——同一个库里 `trace_id` 将有两个意思。本仓已栽过两次（`chainRole`/`chainType`、R1-b 的 `final_rank` 同名不同义），不制造第三次 |
| 建 `trace_id` 列，装 `execution_logs.trace_id` 同款 | ❌ 那不是 OTel 的 traceId，导出时要把整条链碎开（底稿原话）                                                                                     |
| **建 `chain_id` 列**                                | ✅ 本仓**既有词汇**——`executionLogs.ts:263` 的 `COALESCE(rm.task_id, tm.task_id) AS chain_id` 就是链锚                                          |

**纪律**：OTel 语义纪律（底稿 §5.2）约束的是**导出面**——OTLP 的 `traceId` 从 `chain_id` 取值、`spanId` 从 `span_id` 取值。**存储面服从本仓词汇**，否则「字段用 OTel 语义命名」这条纪律本身会变成同名不同义的制造机。

---

## 七、埋点落点表

**`duration_ms` 全部为 `Date.now()` 差值；`start_at` 取 `Date.now()` 的 ISO 形态。零新依赖。**

> **不要用 `performance.now()`**：它是**进程启动以来的毫秒数、不是 epoch**——重启归零、跨进程不可比，`idx_spans_start` 的时间窗查询会直接废掉，且「新数据 / 旧数据」无从区分。实测 `performance.now()` 在本仓非测试代码**零命中**（是凭空引入的新 idiom），`Date.now()` 有 41 处。

符号定位（本仓新规矩：票面引用一律 `文件:符号`，不用行号）。

> **形态提示（别照抄第 13 行的写法）**：`duration_ms` 与 `item_count` 是 **INTEGER**，`start_at` 是 **TEXT**——§七 表格里逐行看列名，不要因为「都在同一张表」就统一按数字处理。

| 段                    | 入口符号 → 出口符号                                                                           | 写入时机 |
| --------------------- | --------------------------------------------------------------------------------------------- | -------- |
| 根                    | `serial.ts:executeOneAgent` 入口 → `finalizeRun`                                              | 收尾     |
| `dispatch.queue_wait` | `serial.ts:execute` 的 `slot.queue.push(cmd)` 处**打 `queuedAt`** → `drainQueuedCommand` 取出 | 收尾     |
| `dispatch.token_wait` | `token-pool.ts:ProviderTokenPool.acquire` 前后                                                | 收尾     |
| `context.assemble`    | `reply.ts:runAgentReply` 的 `messagesRepo.getRecentMessages` 段前后                           | 收尾     |
| `context.compress`    | 摘要替代 / 软截断块前后                                                                       | 收尾     |
| `memory.retrieval`    | `reply.ts` 的 `retrieveMemoryContext` race 块前后                                             | 收尾     |
| `knowledge.retrieval` | `reply.ts` 的 `buildKnowledgeContext` race 块前后                                             | 收尾     |
| `llm.chat`            | `reply.ts` 的 `adapter.chatStream` 调用 → `for await` 循环结束；**首 chunk 处取 `ttft_ms`**   | 收尾     |
| `diff.collect`        | `git/diff-collector.ts:collectCommitDiffs` 前后                                               | 收尾     |
| `reply.persist`       | `messagesRepo.insertAgentMessage` 前后                                                        | 收尾     |
| `git.auto_commit`     | `llm/git-utils.ts:gitCommit` 前后                                                             | 收尾     |

### 三个硬点（照抄，别自由发挥）

1. **`dispatch.queue_wait` 的时刻必须在 `slot.queue.push` 当场打**（`serial.ts:1453` 一带）——存进队列条目本身（内存态，无需落库）。**事后用 `messages.created_at → started_at` 代理是错的**：对重放/恢复路径不准（底稿 §3.2 已判）。
2. **写库放在 `finalizeRun` 收尾，一次执行一个事务**——与 R1 三表同事务同款。**写库失败绝不抛**（它在关键路径上）。
3. **`llm.chat` 的 `start_at` 取 `chatStream` 调用前一刻**，不是 `for await` 进入时刻——否则 TTFT 的分母错了。

### 一条如实声明的残余风险

一次执行一个事务写 ⇒ **进程崩溃时该执行的 span 全丢**（与 R1 `retrieval_events` 同款风险，已接受）。注意：30min 硬超时 / 20min CLI 空闲超时 / 35min token 超时**都走失败漏斗进 `finalizeRun`**，**不丢**；只有进程级崩溃丢。真要为崩溃保住半截时间轴，得改成逐段落盘——**那是拿关键路径延迟换崩溃可见性，v1 不换**。

---

## 八、边界（明写不做）

1. **不建 `span_tool` 表、不采 `tool.execute`**——需给 `ToolCallInfo`（`shared/src/types.ts:259`）加时间字段 + 动各适配器，跨包改动，另开票。
2. **不采 `dispatch.a2a`**——A2A 递归派发（`serial.ts:executeAgentsSerialImpl` 的 `depth+1`）要穿线子树上下文，另开票。
3. **不引入 `@opentelemetry/*` SDK、不自托管任何平台**（底稿 §5.1 已决）。**不导出 OTLP**——本票只落库。
4. **不改 `execution_logs`**——包括不删 `latency_ms`、不给它加列。它是 turn span 的既有载体，R2 与它**并存**（`spans.execution_id` 挂上去）。
5. **不动 `retrieval_events` 任何列**（§4.4）。
6. **不改任何检索行为、不改任何常量值**（R1-b §五 同款纪律）。
7. **不做前端**——链路 tab 归 L1 端点票。
8. **不建 `spans` 的 retention / 降采样**（地图 §留存策略 那条仍是开放裁决位，别顺手实现）。
9. **不改 `deferred` 的两段以外的段名闭集**（§五 是闭集）。

---

## 九、验收标准（行为可验证）

| #   | 判据                                                                                                                                          | 验收方式                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | 全新库 + 老库重跑 `initDb` 均建出两表四索引                                                                                                   | `createTestDb` 造老库 → `initDb`，断言表与索引存在  |
| 2   | 一次执行写出的 span 满足：**恰一个 `parent_span_id IS NULL`**，其余 parent 均指向本次执行内的 span                                            | 单测：跑一次执行，SQL 断言                          |
| 3   | `span_id` 全局唯一（UNIQUE 约束生效）                                                                                                         | 注入重复 `span_id` → 断言报错                       |
| 4   | **写库失败绝不抛**：mock 写口抛错，执行仍成功收尾、槽位仍释放                                                                                 | 单测（对照 R1 同款用例）                            |
| 5   | **一次执行一个事务**：mock 第二张表抛错 ⇒ `spans` / `span_llm` **零残留**                                                                     | 单测                                                |
| 6   | `dispatch.queue_wait` **在排队路径上有行**（今天整段无行）                                                                                    | 单测：构造入队 → 断言 span 存在且 `duration_ms > 0` |
| 7   | `dispatch.token_wait` 在池满时 `duration_ms > 0`，池空时仍写行（`duration_ms` 可为 0）                                                        | 单测                                                |
| 8   | `llm.chat.ttft_ms` **< `duration_ms`** 且首 chunk 即记（非整段结束才记）                                                                      | 单测：mock 流式两 chunk 间隔                        |
| 9   | `chain_id` == 该执行的链锚（`coalesce(回复.task_id, 触发.task_id)`）                                                                          | 单测 + **真机对账**（用 `/api/eval/chains` 抽一条） |
| 10  | `memory.retrieval` 行的 `duration_ms` == 同行 `retrieval_events.retrieval_ms`（同源同值）                                                     | 单测                                                |
| 11  | `operation_name` 对 `memory.retrieval` / `knowledge.retrieval` / `llm.chat` 分别为 `retrieval`/`retrieval`/`chat`；对两个 wait 段为 NULL      | 单测                                                |
| 12  | `item_count` 在 `knowledge.retrieval` 上 == 实际命中数                                                                                        | 单测                                                |
| 13  | **一条 SQL 出全段时间轴**（§4.4 那条查询原样跑通，按 `start_at` 升序）                                                                        | 单测 + 真机                                         |
| 14  | 时间轴**覆盖已知段**：一次正常执行至少产出 `invoke_agent` + `dispatch.token_wait` + `context.assemble` + `memory.retrieval` + `llm.chat` 五行 | 单测                                                |
| 15  | `start_at` 是**毫秒精度**（同一次执行内两段的 `start_at` 可区分，非秒级对齐；格式 `...THH:MM:SS.mmmZ`）                                       | 静态 + 单测                                         |
| 16  | `spans` 表**无 `trace_id` 列**（§六 纪律防回退）                                                                                              | 静态源断言                                          |
| 17  | 边界证明：`git grep -n "otlp\|opentelemetry\|exporter" -- packages/` **零命中**；`shared/src/types.ts` 的 `ToolCallInfo` **未增时间字段**     | 静态源断言                                          |
| 18  | 全套 `vitest run` 全绿 + `node scripts/lint.js` 三包通过                                                                                      | 门禁复跑                                            |

---

## 十、待拍板

| #   | 事项                                                        | 我的建议                                                       | 可逆性                             |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| 1   | **表形态**：窄骨架 + 详情（§三）vs 单表宽列                 | 窄骨架 + 详情                                                  | **不可逆**（建表形态），故先要点头 |
| 2   | **v1 段范围**：§五 标 ✅ 的 11 段 vs 砍到 5 段              | 11 段一起做（同一处收尾写库，分批反而是多轮返工）              | 可逆（段少了可加）                 |
| 3   | **实施票拆分**：一张票 vs 按风险面拆两张（串行段 / LLM 段） | **一张票**——所有落点共享同一处收尾写库，拆开要改两遍同一个写口 | 可逆                               |

**已裁（用户 2026-09-14）**：时间列形态取 **ISO TEXT `start_at`**（不取 epoch INTEGER `start_ms`）——用户口径「两种转换方便就用哪种」；实测两向转换均可、均为单条 SQL 无损无重建，故**转换便利性不构成判据**，改按「与 R1 同库同形态」定裁。随此裁一并落 §4.1 三处修订（`start_at` / `parent_span_id` FK / 弃 `performance.now()`）与新增 §4.6。

**派活时机我另问一次**——形态裁决不等于开工授权。**题 1（表形态）仍未裁**，不点头则派不了活。

---

## 决策留痕

- **D1** 表形态取**窄骨架 + 详情表**，否决单表宽列。判据：段与段是同类东西（不能用 R1 的「三类粒度」判据），但属性面差异极大；塞进一张表 = 用户已否决的「把多个字段堆起来」的列形态。
- **D2** **不建 `trace_id` 列**，链锚列名取 `chain_id`。判据：本仓 `execution_logs.trace_id` 已是当轮执行 id；OTel 语义纪律约束导出面而非存储面。**这是防第三次「同名不同义」。**
- **D3** `retrieval_events` **复用不改**（R1 已发布、已有数据窗口）；linkage 走 `execution_id`。判据：现阶段该键对记忆检索唯一，additive 的事不提前付。
- **D4** 一次执行**一个事务**在 `finalizeRun` 写全部 span。判据：与 R1 同款；超时三条路径均走失败漏斗进 `finalizeRun`，只有进程崩溃丢——**不为崩溃可见性牺牲关键路径延迟**。
- **D5** `dispatch.queue_wait` 的时刻在 `slot.queue.push` 当场打（内存态）。否决「用 `messages.created_at → started_at` 代理」——对重放/恢复路径不准。
- **D6** `tool.execute` / `dispatch.a2a` **v1 不做**——跨包类型改动 / 递归穿线，各自另票。
- **D7** 骨架**不设 `created_at`**。判据：span 的 `start_at` 本身就是时间轴，再加「写入时刻」会造两个语义近似的时间列——**一条时间真相**（本仓反复栽在「同一事实两处存储」上）。
- **D7b**（用户问「所有表都该有 created_at 吧」后补）**时间列取 ISO TEXT `start_at`，不取 epoch INTEGER `start_ms`**。判据：与 R1 `retrieval_events.created_at` 同库同形态；epoch 不可直读；字典序 = 时间序。**两向转换实测均可**（见 §4.1 引注），故此项**不是**可逆性判据，纯粹是形态一致性选择。
- **D7c**（同上）**`parent_span_id` 补 FK → `spans(span_id)`**。判据：`span_llm.span_id` 已有 FK，两处不对称；SQLite FK 即时检查，同事务拓扑序插入即可满足。**原票「不加 FK」的理由（怕插入顺序冲突）不成立**——拓扑序插入本来就要求父行先落。
- **D7d**（同上）**`performance.now()` 一律不用**，改 `Date.now()`。原文 §七「全部为 `performance.now()` 差值」与 §4.1「epoch 毫秒」**自相矛盾**——前者是进程相对时刻，后者是墙钟。实测该 idiom 在本仓非测试代码零命中。
- **D8** 计数与命名纪律：本票一切计数（14 列 / 9 列 / 4 索引 / 11 段）**均为实测或逐条点数**，不凭印象。行号一律改用符号引用（R1-b 教训）。

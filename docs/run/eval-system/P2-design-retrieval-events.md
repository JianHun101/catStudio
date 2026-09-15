# P2 设计票：`retrieval_*` 记忆检索流水表（三表）

> 来源：用户 2026-09-14 认可 P2 方向，要求「讲清具体实现 + 定表字段」，并明示**「有些字段可以冗余一下」**。
> 后续裁决（同日）：用户裁 **拆三表**（题干「表需要具有代表性，主要代表某类东西」），并裁 **R1 实施范围**（第 1、2 步进 R1，第 3 步跨查询合并改排序**拆出另票**）。
> 状态：**设计定稿（三表），已收口进 dev（`90553f7`，2026-09-14）**。落 `docs/run/`（免审、可逆）。
> **R1 已过两轮 spec-gate（Gate C 两轮各补漏，共 18 条验收）⇒ 可开工。**
> 本票只关 **R1（`retrieval_*` 三表）**；R2（span 表）设计同源但**实施另票**，见 §八。

## 一、Why 冗余：一条判据，两条推论

用户提的「冗余」不是风格偏好，它有一条硬判据：

> **凡「事后无法可靠重算」的值，一律冗余进表。**

推论一（**参数快照必须冗余**）：`.env` 改一次 `MEMORY_MAX_DISTANCE`，全部历史行的可解释性当场归零——你再也分不清某片被挡掉，是因为它离得远，还是因为当时阈值是 0.5。**「阈值该调到哪」这个问题，在改过阈值之后就永远答不了了**——而它正是 P2 要回答的头号问题。故 `threshold_max_distance` / `param_top_k` / `param_probe_n` 三个参数必须落盘。

推论二（**人类可读字段必须冗余**）：`chunks` 是可重建的派生表（重扫一次 `id` 全变、`status`/`body` 被覆盖），MD 文档会改名。三种情况都会让历史行变成一串读不懂的锚点。故 `breadcrumb` / `body_head` / `status_at_query` 冗余——**让数据自解释，不依赖回翻源码与文件**。

### 原「反向纪律」已随拆表消失

初版设计（单表 35 列）另立过一条反向纪律：「冗余列一律全行写，禁止稀疏写」。**拆三表后此纪律整条失效，本票不再保留。**

理由：那条纪律是为了看住「三种粒度压进一张表」造成的裂缝——粗粒度事实（检索级 10 列 + 查询级 1 列）被复制到每个候选行上，共约 23 遍。拆开后这些值**各自只有一行**（`retrieval_events` / `retrieval_queries` 自己的行），按定义不可能稀疏。

剩下的 4 个 ✅ 列（`chunk_id` / `breadcrumb` / `body_head` / `status_at_query`）性质不同：它们是**外部可变状态的快照**，逐候选行各不相同，本来就不存在「该写哪一行」的歧义。

> **通则**：一致性该由结构保证，不该由纪律看住。本项目的反复病灶是「靠规矩不靠结构」，本票的拆表就是把这 11 列从「靠纪律」搬到「靠结构」。

## 二、实证发现：三处需纠正既有说法

设计前逐处复核源码（本会话纪律：不转述文档），三条需要纠正：

**① 初版说的「`distance === maxDistance` 二义」不成立——但真二义在别处。**

初版把「向量命中恰好卡在阈值」列为可能情形，据此判定等值判别有二义。**实测被 `chunks.ts:306` 的严格小于排除**：

```
chunks.ts:306    AND v.distance < ?      ← 严格小于
chunks.ts:400    scores.set(hit.id, { score: kwScore, row: { ...hit, distance: maxDistance } })
```

真向量命中恒 `distance < maxDistance`，故 `distance === maxDistance` **只能**来自哨兵。这条分支不可达，初版那句要撤。

**但结论不变，只是理由要换**，真正的两条是：

- **脆弱性**：该不变量寄居在一个 SQL 比较操作符上。谁把 `<` 改成 `<=`（看起来无关紧要的一行），等值判别当场失效，**且不报错、不告警**，直接把「关键词捞回的片」报成「贴着阈值边界的向量命中」——阈值松紧这个头号问题的读数就废了。
- **真二义（票里没写）**：哨兵有**两个产地**，行面完全同形——
  - `chunks.ts:400`：混合路径内，关键词通道救回；
  - `memory/index.ts:223`：**该趟查询嵌入挂了**，走 `:218` 的纯关键词通道，`isVectorHitRow` 守卫为假才补哨兵。

  两者填同一个值。要区分只能靠 `blobs.length` 这个**查询级**全局量，而 `MemoryContextStats` 只记了 `queries` 条数（`memory/index.ts:250`）、**没记嵌入成功的条数**——「4 趟里 2 趟嵌入成功」在埋点里是隐形的。

**判决**：`channel` 列不是「顺手加个字段」，是把这条隐式约定升级成显式契约——**退休 `distance === maxDistance`**。理由换成上面两条（脆弱性 + 真二义）。

**② 只改 `chunks.ts` 拿不到最终位次。** `memory/index.ts:231-234` 在 `chunks.ts` 出口之后**又合并了一次**（跨查询按 `bestIndex` 取最小 → 排序 → `slice(topK)`）。「谁最终进了 prompt、排第几」是这里定的。且注入单位是**节**不是片（Decisions 14，`memory/index.ts:270-294`）——片级位次与节级位次是两套序，都要取。

**③ `reason` 值域是 9 种，不是 7 种（初版写错）。**

初版 §四G 写「本次检索的全局 reason（7 种枚举，已穷尽）」。但**真正落台账的 reason 不是记忆模块那 7 个**——`reply.ts:667` 在模块枚举之外还叠了两个：

```
reply.ts:667    reason: memoryTimeout ? 'timeout' : (memoryResult?.reason ?? 'error')
```

即 `timeout` / `error` **不在** `MemoryRetrievalReason` 那 7 个里（`memory/index.ts:72-79`：`ok`/`not-enabled`/`empty-query`/`embed-failed`/`filtered-empty`/`no-hit`/`budget-exhausted`）。**值域是 9**。

这条不是文字问题：**超时那一次检索恰是最该记录的一次**（检索最慢），而它发生时 `memoryResult === null`——若 R1 照初版只写 `memoryResult.reason`，超时路径要么写 NULL 要么抛。R1 必须照抄 `reply.ts:667` 的三元式取 reason。

## 三、实现：数据从哪来、写到哪去

### 数据流（三段，缺一段就答不了问题）

```
① chunks.ts:380-407        融合 RRF —— 目前 .map(s => s.row) 把 rrf_score/rank 丢掉
② memory/index.ts:220-234  跨查询二次合并 —— 决定 final_rank
③ memory/index.ts:270-311  按节补齐 + 预算截断 —— 决定 injected / section_rank / dropped_reason
```

### 落点（文件级）

| 文件:行                                                         | 动什么                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/db/index.ts:511` 附近（migrations 数组）   | 加一条 additive 迁移建**三张表** + 索引。数组范式是 `CREATE TABLE IF NOT EXISTS`，**老库重跑零副作用**                                                                       |
| `packages/server/src/db/repository/chunks.ts:396-407`           | 出口带出通道身份：`existing` 命中 ⇒ `both`；else ⇒ `keyword`；`vectorHits.forEach` 建的 ⇒ `vector`。**同时把 `rrfScore` / 通道内位次带出**（现状被 `.map(s => s.row)` 丢弃） |
| `packages/server/src/memory/index.ts:216-234`                   | 采集 `finalRank`（**只改 chunks.ts 拿不到**）+ 把「该趟是否走了混合通道」带进 `merged`（填 `query_embed_ok`）                                                                |
| `packages/server/src/memory/index.ts:90-110`                    | `MemoryContextStats` 扩字段：候选明细从「只有 probe 池」扩到「probe 池 + 融合 topK」，并补 `queryIndex`/`retrievalMs`                                                        |
| `packages/server/src/memory/index.ts:249-313`                   | 三处 return 路径（空结果 `:258-268` / budget-exhausted `:296-298` / ok `:300-313`）都要带完整 trace——**空结果路径必须也带**，否则「为什么没召回」变成盲区                    |
| **新建** `packages/server/src/db/repository/retrievalEvents.ts` | 写口（**三表同事务**批量 INSERT）+ 行类型。同目录同名前缀测试                                                                                                                |
| `packages/server/src/execution/reply.ts:635` 之后               | 埋点写库。**位置关键，见下**                                                                                                                                                 |

### 埋点位置（一条易错的硬要求）

写库**必须放在 `reply.ts` 的 10s `Promise.race` 之外**——具体落点是 **`:635` 之后**（try/catch 之后、`const memoryContext = ...` 之前），此处 `memoryResult` 与 `memoryTimeout` 两个变量都已就绪。

理由：写进 race 内，一是写库耗时算进检索超时预算、二是**race 超时会把写库整个丢掉**——恰好在检索最慢（最值得记录）的那一次丢数据。

**且必须写在 `:637` 的 `if (memoryContext)` 之外**：那一分支只在注入成功时走，写在里面会让「空手而归」和「超时」两条路径无痕。

### 硬约束

1. **三表同事务写入，禁止半写完**：`retrieval_events` → `retrieval_queries` → `retrieval_candidates` 三张表必须在**同一个 `db.transaction()`** 内落盘，不许出现「有 event 没 queries」「有 query 没 candidates」。这是拆表新引入的风险面（单表时代不存在），单表下「写失败绝不抛」只要一句 try/catch 就够，拆表后要防的是**写了一半**。
2. **写库失败绝不抛**：事务整体 try/catch 吞掉 + 记一次痕。它在关键路径上，抛了会杀死本轮注入。
3. **不改变任何现有行为**：纯新增写口。最坏情况 = 写失败被吞、检索照跑（**这是 R1 低风险的根据**）。
4. **不回填**：原始数从未落库，回填就是编数据。同 P1 裁决。

### 本票范围：只采不改（用户 2026-09-14 裁决）

用户裁「拆」。R1 只做**采集**（上表第 1、2 步），**跨查询合并改排序拆出另票**——那一步动的是猫实际读到的记忆，属行为变更，与「写库失败绝不抛」的低风险 R1 混在一起会让验收面糊掉。拆出的票单独做，可逆、随时能做。

具体**不在 R1** 的三处（记在此处防漂）：`chunks.ts:406` 的 `slice(topK)` 参数换成独立池常数、`memory/index.ts:217` 的传参、`memory/index.ts:220-234` 的合并键从 `bestIndex` 换成 RRF 分累加。

## 四、字段表（三表定稿）

**拆表判据：一张表只代表一类东西。** 三表不是流水线先后，是**归属**——检索 → 查询 → 候选，一层套一层（一 event 含 N query，一 query 含 N candidate）。

### 表 1 `retrieval_events` — 一次记忆检索（检索级，14 列）

| 列                       | 类型                     | 为什么                                                                                                                              |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | INTEGER PK AUTOINCREMENT |                                                                                                                                     |
| `execution_id`           | TEXT NOT NULL            | 挂到哪次执行（对 `execution_logs`）                                                                                                 |
| `session_id`             | TEXT                     |                                                                                                                                     |
| `agent_id`               | TEXT                     |                                                                                                                                     |
| `task_id`                | TEXT                     | **链锚**，口径与 P1 完全一致（`coalesce(reply.task_id, trigger.task_id)`）。不冗余这列，P2 的数据与「链路」tab 就是两张互不相干的表 |
| `created_at`             | TEXT NOT NULL            | ISO UTC                                                                                                                             |
| `threshold_max_distance` | REAL NOT NULL            | 参数快照（§一 推论一）                                                                                                              |
| `param_top_k`            | INTEGER NOT NULL         | 参数快照                                                                                                                            |
| `param_probe_n`          | INTEGER                  | 参数快照（现为源码常量 `MAX_PROBE_N`，常量也会变）                                                                                  |
| `reason`                 | TEXT NOT NULL            | 本次检索全局 reason，**值域 9**（7 枚举 + `timeout` + `error`，见 §二③）                                                            |
| `retrieval_ms`           | INTEGER                  | 本次检索总耗时。诉求③性能面                                                                                                         |
| `context_tokens`         | INTEGER                  | 注入文本 token 数                                                                                                                   |
| `budget_tokens`          | INTEGER                  | 本次预算。与 `context_tokens` 合看答「预算够不够」                                                                                  |
| `truncated`              | INTEGER                  | 是否发生预算截断                                                                                                                    |

### 表 2 `retrieval_queries` — 一趟查询（查询级，5 列）

| 列               | 类型                                                                 | 为什么                                                               |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`             | INTEGER PK AUTOINCREMENT                                             |                                                                      |
| `retrieval_id`   | INTEGER NOT NULL REFERENCES `retrieval_events(id)` ON DELETE CASCADE | 归属                                                                 |
| `query_index`    | INTEGER NOT NULL                                                     | 0 = 原话，1+ = 改写。**没有它答不了「改写值不值」**                  |
| `query_text`     | TEXT NOT NULL                                                        | 当时那一趟查的是什么。查询文本事后无从复现（消息会变、改写模型会换） |
| `query_embed_ok` | INTEGER NOT NULL                                                     | **这趟查询的向量通道有没有跑**（0/1）。填法见下                      |

**约束**：`UNIQUE(retrieval_id, query_index)`——一趟查询在一 event 内唯一。

#### `query_embed_ok` 的填法与理由

它**不是**从候选行上算出来的，而是**当趟查询的黑白事实**——在 `memory/index.ts:207` 那个 `if` 上本来就是已知的布尔，只是今天没往外传：

```ts
const embedded = await embedText(q)              // index.ts:206
if (embedded.ok && embedded.vector.length > 0) { // index.ts:207  ← 这个布尔
  blob = vectorToBlob(embedded.vector)
}
const rows = blob ? searchChunksHybrid(...) : searchChunksByKeyword(...)  // index.ts:216-218
```

填法 = 把这个布尔顺手带出去。**拆表后「与 `query_index` 同源同趟」由结构自动保证**——两者在同一行（`retrieval_queries`），物理上不可能不同趟。这是拆表相对单表的又一笔收益：单表时代这条得写成纪律。

**为什么必须与 `channel` 正交、不能把 `channel` 值域扩成 `keyword-degraded`**——降级路径产出的行，行面与「关键词救回」完全同形：

| 组合                         | 含义                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `channel='keyword'` + `ok=1` | 向量通道**跑了但没要它**（超阈值 / 不在 KNN top-20 里）⇒ **真·关键词救回** |
| `channel='keyword'` + `ok=0` | 向量通道**压根没跑**（该趟嵌入挂了）⇒ **不是救回，是降级**                 |

两类都写 `distance=NULL`，光靠 `channel` **分不出**这个 NULL 是「向量排序把它挤掉了」还是「向量通道根本没开」。阈值该松还是紧，是这两个截然相反的结论。两问不同面（`channel` 答「这片怎么进来的」，`query_embed_ok` 答「这趟查询环境好不好」），塞一列里就是重新制造隐式规则。

### 表 3 `retrieval_candidates` — 一个候选片（候选级，20 列）

| 列                     | 类型                                                                  | 为什么                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | INTEGER PK AUTOINCREMENT                                              |                                                                                                                                    |
| `query_id`             | INTEGER NOT NULL REFERENCES `retrieval_queries(id)` ON DELETE CASCADE | 归属（**取代候选行上的 `query_index`**）                                                                                           |
| `source`               | TEXT NOT NULL                                                         | `final`（融合后 topK 候选）/ `probe`（阈值前 KNN 池）                                                                              |
| `channel`              | TEXT                                                                  | `vector` / `keyword` / `both`。**判「关键词通道是救场还是白给」的唯一依据**，也是 §二① 写 NULL 的判别键                            |
| `doc_path`             | TEXT NOT NULL                                                         | 身份三元组，**不用 `chunks.id`**——派生表 id 重扫即变                                                                               |
| `section_anchor`       | TEXT NOT NULL                                                         | 同上                                                                                                                               |
| `content_hash`         | TEXT NOT NULL                                                         | 同上                                                                                                                               |
| `chunk_id`             | INTEGER                                                               | ✅ **诊断专用，非身份、绝不作 join 键**。唯一用途：回查「现在的 `chunk_id` 还是不是同一片」——**这本身就是「重扫是否漂移」的探针**  |
| `breadcrumb`           | TEXT                                                                  | ✅ 让历史行自解释（`chunks` 重扫后该列会被覆盖）                                                                                   |
| `body_head`            | TEXT                                                                  | ✅ 片段正文前 120 字。**截断快照，非全文**。回答「这条召回到底是什么」                                                             |
| `status_at_query`      | TEXT                                                                  | ✅ 该片**当时**的 status。不冗余则「`superseded` 是不是在挡活片」在重扫后无解                                                      |
| `distance`             | REAL NULL                                                             | 余弦距离。**纯关键词命中的写 NULL，不写哨兵**（见 §二①，需靠 `channel` 转换）                                                      |
| `rank`                 | INTEGER                                                               | 该查询在所属通道内的位次                                                                                                           |
| `rrf_score`            | REAL                                                                  | RRF 融合分（现状在 `chunks.ts:407` 被丢弃，要捞回）                                                                                |
| `final_rank`           | INTEGER                                                               | 跨查询二次合并后的位次（`memory/index.ts:220-234`）                                                                                |
| `passed_status_filter` | INTEGER                                                               | X4 状态过滤是否放行（probe 行用）                                                                                                  |
| `injected`             | INTEGER NOT NULL                                                      | **口径明写：该片所属的「节」最终进了 prompt**（注入单位是节，Decisions 14）                                                        |
| `section_rank`         | INTEGER                                                               | 所属节在注入序列里的序                                                                                                             |
| `injected_position`    | INTEGER                                                               | **渲染后编号 1..n**。`renderSections` 会做首尾重排（Lost in the Middle）——「这条记忆最终出现在猫读到的第几条」是位置效应的直接变量 |
| `dropped_reason`       | TEXT                                                                  | `threshold` / `status` / `not_topk` / `budget` / `section_dup`（同节已有更优片代表）                                               |

**`injected` + `dropped_reason` 必须分开，不能糊成一个「没进」**：「被阈值挡掉」和「被预算截断」是**两个相反的药方**——松 `MEMORY_MAX_DISTANCE` vs 加 `MEMORY_CONTEXT_TOKEN_BUDGET`。糊了就永远分不出来。

### 拆表干掉的三列

| 原列                       | 现在怎么来                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `query_total`              | `SELECT COUNT(*) FROM retrieval_queries WHERE retrieval_id = ?`                        |
| 候选行上的 `query_index`   | 由 `query_id` 派生                                                                     |
| `queries_embedded`（拟加） | `SELECT COUNT(*) FROM retrieval_queries WHERE retrieval_id = ? AND query_embed_ok = 1` |

> 第三行值得记一笔：`queries_embedded` 是单表方案下**追着用户要了两轮签字**的一列（「36 还是 37」）。拆表后它**不是被回答，是不存在了**——那个选择题本身是补丁思维的产物。同理 `query_total`。

### 索引

| 表                     | 索引                                | 服务什么                                 |
| ---------------------- | ----------------------------------- | ---------------------------------------- |
| `retrieval_events`     | `(execution_id)`                    | 挂链路                                   |
| `retrieval_events`     | `(created_at)`                      | 时间窗取数                               |
| `retrieval_events`     | `(task_id)`                         | 与 P1 链锚对齐                           |
| `retrieval_queries`    | `UNIQUE(retrieval_id, query_index)` | 约束即索引，无需另建                     |
| `retrieval_candidates` | `(query_id)`                        | 按查询取候选（看板主查询路径）           |
| `retrieval_candidates` | `(content_hash)`                    | **同一片的历次召回序列**（改前改后对比） |

> `content_hash` 索引从单表的 `(content_hash, created_at)` 收窄为单列：`created_at` 已上移到 `retrieval_events`，时间窗变成跨表条件（join 后过滤）。

### 仍然存在的粒度混装（明写，不在本票解决）

`injected` / `section_rank` / `injected_position` 的**严格粒度是「节」，不是「片」**——票面口径自己写的是「该片**所属的节**最终进了 prompt」。同一节的每个候选片都把这几个值抄一遍，与 `query_text` 在单表里的病同型。

**本票不做第四张节表。** 理由不是它不对，是**可逆性**：建新表是 additive、随时能加，**不需要动已有表的行**——这与「给已有行加约束就再也加不上」是相反的两件事，成本低一个数量级。等三表跑起来、看到真实的节级读数，再决定拆不拆。

## 五、这套表能回答什么（分两类，防错配期待）

**A 类：不需要标注，R1 落地即可算**

| 问题                                   | 靠哪些列                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| 阈值该松还是紧？                       | `dropped_reason='threshold'` + 那批的 `distance` 分布——**看被挡掉的离阈值差多远** |
| 关键词通道是救场还是白给？             | `channel` **联** `query_embed_ok`（缺后者分不出「救回」与「降级」，见 §四表 2）   |
| `superseded`/`deprecated` 在挡活片吗？ | `passed_status_filter` / `dropped_reason='status'`                                |
| 改写查询值不值得留？                   | `query_index`（0 vs 1+ 的命中率对比）                                             |
| 「空手而归」是没命中还是被挡掉？       | `reason` 枚举（9 值）                                                             |
| 检索本身耗时多少？                     | `retrieval_ms`                                                                    |
| 部分降级有没有发生？                   | `COUNT(query_embed_ok=1)` vs `COUNT(*)` on `retrieval_queries`                    |

**B 类：必须人工标注（P3，整张图最贵的一块）**

`recall@k` / `precision@k`——「该被召回的那篇有没有被召回」只能靠人标注。T1 对账 13 件外部工具，无一件能不靠参考答案给出此数。

> **纠偏**：`map.md:95` 写「`retrieval_events` 表 → 记忆库 `recall@k`/`precision@k`」——**这句把 P2 说大了**。R1 落的是**原料**（候选/位次/通道/分数），不是指标本身。R1 收口时一并修这行。

## 六、量级与留存

- **列数**：三表合计 **39 列**（14 + 5 + 20），比单表方案的 37 列多 2 列，**多出来的全是主键/FK**，信息量不增。
- **量级**：每次检索约 23 行（融合 topK 3 + 探针 20；纯关键词降级时探针为空 ⇒ 约 3 行），但**拆到三张表**：1 行 event + 1~4 行 queries + 约 23 行 candidates。按 1096 次执行/月估 **约 2.5 万候选行/月**，含 `body_head` 约 300 B/行 ⇒ **约 7–8 MB/月**。SQLite 无压力。
- **留存**：本票**只留口不实现**（`map.md:70`「指标序列留存策略」仍开着）。表设计不依赖留存策略，两者解耦。

## 七、边界（明写不做）

- **不改前端**——R1 只落数据，评估中心第三个 tab「链路」原样不动。检索面读接口/展示是后续叶子节点。
- **不建 span 表**——见 §八。
- **不建节表**——理由见 §四末。
- **不改检索排序**——跨查询合并键改造**已拆出另票**（用户 2026-09-14 裁决，见 §三）。
- **不动 `memories` 表**——该表已随旧写口退役**并已 DROP**（两库实测均无 `memories` / `memories_fts`）；本票只碰 `chunks` 侧。
- **不实现留存/降采样/清理任务**。

## 八、R2（span 表）：设计同源，实施另票

**为什么设计必须一起做**：两张表命名纪律同源（OTel `gen_ai.*` 语义当词汇表），且**采集点在物理上同一处**（检索段）。分两次设计必然打架。

**为什么实施必须分开**：R2 要动 `packages/server/src/execution/serial.ts:431`（token 获取点）与 `reply.ts` 六处——**这一带是事故密集区**（token 池死锁、幽灵 running 都出在这）。按 P1 验证过的切片原则，一张票一个风险面。

**R2 的独立价值**：`retrieval` span = 检索耗时（本票 `retrieval_ms` 已给粗粒度版）；其余 span 给 LLM 段 / 等 token 段拆分——诉求③的性能面。

> **状态（2026-09-14）**：R2 目前**只有「为什么这么排」的理由，一个字段都没设计**。这是当前最大的洞，与 §四的三表形态无关，可独立推进。

## 九、验收标准（行为可验证）

1. **三表已建**：老库重启后 `retrieval_events` / `retrieval_queries` / `retrieval_candidates` 均存在，且**既有各表行数一行不变**（additive 证明）。
2. **写入成立**：跑一次真实检索，三表行数分别按「1 / 1~~4 / 3~~23」增加；`execution_id` 能对上 `execution_logs`。
3. **同事务，无半写完**（§三 硬约束 1）：**mock 第三张表（`retrieval_candidates`）插入抛错，断言前两张表也没有留下任何行**。这是拆表新引入的风险面，必须有用例。
4. **NULL 转换正确**（§二①）：`channel='keyword'` 的行 `distance IS NULL`；`channel IN ('vector','both')` 的行 `distance` 非空。**这是本票最容易写错的一处，必须有用例**。
5. **`query_embed_ok` 正确**：构造「某趟嵌入失败、其余成功」的场景，断言该 `retrieval_queries` 行 `query_embed_ok=0`，同 event 其余行为 1；且**该趟产出的候选行 `channel='keyword'`**（不是 `both`）。
6. **`reason` 值域覆盖超时**（§二③）：mock 检索超时（`memoryResult===null`），断言落库行 `reason='timeout'` 而非 NULL/抛错。
7. **空结果路径也落盘**：构造一次空召回，确认仍有行落库且 `reason` 正确。**不许出现「返回空且无痕」**。
8. **写失败不致命**（硬约束 2）：mock 写口抛错，检索仍正常返回、注入不受影响、本轮无未捕获异常。
9. **位次正确**（§二②）：多查询场景下 `final_rank` 与 `memory/index.ts` 实际注入序一致；`injected=1` 的行数 == 实际注入的节点数。
10. **FK 与唯一约束生效**：`db/index.ts:27` 已开 `foreign_keys = ON`；用例断言「插入不存在的 `retrieval_id` 被拒」+「同 `(retrieval_id, query_index)` 插两次被拒」。
11. **参数快照**：改 `MEMORY_MAX_DISTANCE` 后新行 `threshold_max_distance` 随之改变，旧行不变。
12. 全套 `npx vitest run` 绿 + `node scripts/lint.js` 通过。
13. **`MemoryContextStats` 扩字段生效**（§三 落点表第 4 行）：断言候选明细**同时含两类**——`source='probe'`（阈值前 KNN 池）与 `source='final'`（融合 topK）；且每项带 `queryIndex` / `retrievalMs`。_（Gate C 补：该落点在 §三 有行、此前无验收项）_
14. **链锚口径与 P1 一致**（§四 表 1 的 `task_id`）：落库行的 `task_id` == 同次执行的 `coalesce(回复消息.task_id, 触发消息.task_id)`；**真机对账**——用 `/api/eval/chains` 返回的同一锚串核。_（Gate C 补：票面把「不冗余这列，P2 数据与链路 tab 就是两张互不相干的表」当成强理由，却没有一条断言守它）_
15. **三条 return 路径全覆盖**（§三 落点表第 5 行）：空召回 / **budget-exhausted** / ok **各构造一次**，断言三条都有行落库、`reason` 与 `truncated` 各自正确。_（Gate C 补：原第 7 条只覆盖「空结果」，`:296-298` 那条路径无覆盖——它恰是「预算够不够」这个头号问题的载体）_
16. **`channel` 三值判定**：构造「同片被向量与关键词双通道命中」场景，断言该候选行 `channel='both'`。_（Gate C 补：原第 4/5 条只覆盖 `keyword` / `vector` 两值）_
17. **越界证明 · R1 未夹带排序改动**（守 §七 的第一条边界，也是 R1 / R1-b 的分界线）：同输入下 `retrieveMemoryContext` 的返回（节序 / 正文 / `contextTokens`）与改动前**逐字段一致**——用与 C1 §二 同款的差分法（同进程同夹具，跑改动前后两份实现）。**这条抓的正是用户裁「拆」时要防的那件事**。
18. **README Redis 死面清理**（C1 §六 尾巴，店长 2026-09-14 裁决并入本票，独立 commit）：`grep -in redis README.md` 命中**仅剩 2 行**，且两行**均在 ADR 表内**（`:369` `0002` / `:372` `0005` — 历史记录，明写不动）；`db/redis.ts` 字样归零。**与 R1 主体无依赖——R1 若因 DDL 返工，本条可独立先落。**

### 真机对账留痕（2026-09-15 · 店长实测，非转述）

**验收 14 的「真机对账」半条 —— ✅ 通过**（该半条即 map.md T-122 记的「审查者移交待办：归店长收口动作、重启后做」，本条将其关闭）。

对账口径按验收 14 原文，逐行比 `retrieval_events.task_id` 与该执行的链锚 `coalesce(回复消息.task_id, 触发消息.task_id)`：

| 项       | 实测                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 抽样对账 | **8/8 MATCH**（含 `4f97d22c…` 一链 6 跳锚串一致、`a661b2bd…`、`70520adc…`）                                                                                                              |
| 全表守卫 | **29 行，`task_id` 为空 0 行**（无一行为空即「口径一致」的前提未被破坏）                                                                                                                 |
| 三处交叉 | 执行 `755742f9` 的锚串经 `retrieval_events.task_id` / `/api/eval/chains` / `spans.chain_id` **三处同值**——即用户裁「拆表」时要防的「P2 数据与链路 tab 成两张互不相干的表」，真机上不成立 |

**三表真机在写**：`retrieval_events` **29** / `retrieval_queries` **103** / `retrieval_candidates` **667**（统计时刻 2026-09-15，dev 库）。

## 十、已裁决（原「待用户拍板」两条均已关闭）

1. ~~字段表按 §四 定稿？35 列？~~ → **用户裁：拆三表**。单表 37 列方案作废，理由见 §一「反向纪律已随拆表消失」与 §四末「拆表干掉的三列」。
2. ~~R1 先实施还是等 R2 设计完？~~ → **用户裁：R1 先做**，顺序 = R1 → 止血单（并行）→ R2 设计 → OQ-6 → P3。
3. **R1 范围**（新）→ **用户裁：拆**。第 1、2 步（出口带通道身份 + `query_embed_ok`）进 R1；第 3 步（跨查询合并改排序）拆出另票。见 §三「本票范围」。

## 决策留痕

- **跳 grilling**：因本票是**逐轮与用户对账压出来的**——三轮问答（哨兵用途 → 通道判别 → 表形态）里每一条结论都带源码实证与行号，用户已就形态、范围、顺序逐项裁决 → 故本单不单跑 grill。
- **Gate A 需求照准**：本票是**设计票**，需求 = 「三表 DDL + 采集点 + 验收」；§九 **十八条**验收均可机械判定（行数增量 / `distance IS NULL` 断言 / mock 抛错后无残留行 / `reason='timeout'` / grep 字样归零）。
- **Gate B 契约锁定**：边界 = §七（明写不做：不改前端、不建 span 表、不建节表、不改排序、不实现留存）；契约 = §四 三表 39 列逐个钉死 + §三 落点表逐文件钉死；验收 = §九。
- **Gate C 反向证明**：逐条对账后**补了两处**——① §二③ 发现 `reason` 值域是 9 不是 7，补验收第 6 条（超时路径必须落 `timeout` 而非 NULL）；② 拆三表新引入「半写完」风险面，补验收第 3 条（mock 第三张表抛错，断言前两张表无残留行）。
- **Gate C 第二轮（派活前，2026-09-14 店长复查）**：**又补 6 条**（13~~18）。_这是同一张票第二次被抓 Gate C 漏网——第一次是关票前，第二次是派活前。_ 漏网形态两类：
  - **有落点无验收**：§三 落点表的 7 行里有 3 行没有任何验收项守它——`MemoryContextStats` 扩字段（→ 13）、三条 return 路径只覆盖了「空结果」而漏 `budget-exhausted`（→ 15）、`both` 通道值无断言（→ 16）。
  - **有强理由无断言**：票面把「`task_id` 不冗余则 P2 数据与链路 tab 是两张互不相干的表」写成核心卖点，却没有一条断言守它（→ 14）；用户裁「拆」的分界线（第 3 步不得夹带）只有一句边界、无越界证明（→ 17）。
  - **教训**：**Gate C 不是一次性动作**。它在「设计当时」对账一遍、在「派活当时」必须再对一遍——因为**验收项是随设计增补而失配的**：§三 落点表后补一行、§七 边界后补一条，都不会自动长出对应验收。**判据：落点表每一行、边界每一条，各要能指到一个验收编号**；指不到的就是漏网。
- **本票与 C1 的次序**：C1 前置（两票改同一批文件，`memory/index.ts:273` 与 R1 的 `:249-313` 改动区间**直接重叠**，并行必冲突）→ 见 [C1](C1-legacy-memory-chain-cleanup.md)。**C1 已于 2026-09-14 关票（PR #75 / merge `4a33553`）⇒ R1 可开工。**

## 十一、R1 实施留痕（2026-09-14）

### 11.1 改动面（行号为实施后实测，`grep` 复核）

| 落点                               | 实施位置                                                                                                         | 内容                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `db/index.ts`                      | `:642` / `:677` / `:696`                                                                                         | 三表 DDL + 4 条索引，additive（`CREATE TABLE IF NOT EXISTS`）      |
| `db/repository/retrievalEvents.ts` | **新建**（`insertRetrievalTrace:123`，读侧 `:224`/`:244`）                                                       | 三表同事务写口 + 行类型（**契约唯一真相源**）                      |
| `db/repository/chunks.ts`          | `:374`(`CANDIDATE_BODY_HEAD_CHARS`) / `:394`(`ChunkHybridHit`) / `:414`(`searchChunksHybrid`) / `:491`(探针扩列) | 出口带出通道身份 + RRF 分 + 两位次；探针补身份三元组与 `body_head` |
| `memory/index.ts`                  | `:149`(`currentRetrievalParams`) / `:290`(`queryTraces`) / `:414`(`candidates`) / `:536`(`renderOrder`)          | 采集流水；注入面回填                                               |
| `execution/reply.ts`               | `:214`(`recordRetrievalTrace`) / `:706`(`memoryT0`) / `:729`(调用点)                                             | 埋点写库（race 外、`if` 外）                                       |
| `README.md`                        | 8 行                                                                                                             | Redis 死面清理（**独立 commit**，见 §九 18）                       |

### 11.2 §九 十八条验收 → 证据（逐条）

| #   | 落点                                        | 用例                                                                                         |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `retrievalEvents.test.ts`                   | 验 1：老库塞既有行 → 再跑迁移 → 三表在、三表行数不变                                         |
| 2   | `reply.test.ts` + `retrievalEvents.test.ts` | 验 2（组装）/ 验 2（写口）：`execution_id` JOIN 回 `execution_logs` 对上                     |
| 3   | `retrievalEvents.test.ts`                   | 验 3：注入 `content_hash=null` 真错 → **前两张表零残留**                                     |
| 4   | `memory/index.test.ts`                      | 验 4 ×2：`keyword`→NULL（对照同片 probe 行距离 0.293）/ `vector`→非空                        |
| 5   | `memory/index.test.ts`                      | 验 5：仅改写那趟嵌入失败 → 该行 `queryEmbedOk=0`，其候选 `channel='keyword'` 非 `both`       |
| 6   | `reply.test.ts`                             | 验 6 ×2：`memoryTimeout` → `'timeout'`；抛错 → `'error'`                                     |
| 7   | `memory/index.test.ts` + `reply.test.ts`    | 验 15 空召回 + 超时路径：行仍在、reason 正确                                                 |
| 8   | `retrievalEvents.test.ts` + `reply.test.ts` | 验 8 + 找不到执行行：均不抛、返回 undefined / 不落盘                                         |
| 9   | `memory/index.test.ts`                      | 验 9：`finalRank=[0,1,2,3]`、`injected` 节集合 == `r.sections`、`injectedPosition=[1,2,4,3]` |
| 10  | `retrievalEvents.test.ts`                   | 验 10：FK 拒（query/候选两处）+ UNIQUE 拒 + CASCADE 删                                       |
| 11  | `retrievalEvents.test.ts` + `reply.test.ts` | 验 11：两行不同阈值互不影响；超时路径参数快照仍带                                            |
| 12  | 全套                                        | `npx vitest run` **113 文件 / 2268 用例全绿**；`node scripts/lint.js` 三包通过               |
| 13  | `memory/index.test.ts`                      | 验 13：`sources == {final, probe}`、每项带 `queryIndex`、参数快照 + `retrievalMs`            |
| 14  | `reply.test.ts`                             | 验 14 ×2：带锚 → 锚；无锚 → `traceId`（与回复侧 `\|\| traceId` 同构）                        |
| 15  | `memory/index.test.ts`                      | 验 15 ×3：`no-hit` / `budget-exhausted` / `not-enabled`+`empty-query`                        |
| 16  | `memory/index.test.ts`                      | 验 16：同片双通道 → `both`，`rrfScore > 1/61`（两通道相加）                                  |
| 17  | `memory/index.test.ts`                      | 验 17 ×3：n=1..5 逐窗口「实际 sections 喂旧算法」逐字节比对 + 节序仍由 `bestIndex` 决定      |
| 18  | `README.md`                                 | `grep -in redis` 命中 **2 行**且均在 ADR 表内（`0002`/`0005`）；`redis.ts` 字样归零          |

> **票面行号漂移**：§九 18 写「`:369` `0002` / `:372` `0005`」，实测在 **`:358` / `:361`**（差 11 行）。判据按**内容**（ADR 表内两行）成立，行号系票面写作时的快照，已在提交前 grep 复核。

### 11.3 偏离与自主决策（**请审查重点看这一节**）

1. **`execution_id` 的来源票面未钉死**（§三 落点表只列 `reply.ts:635`，但 `logId` 是 `serial.ts:1232` 的局部量，隔 3 个函数帧）。**取法选了查库**（`getLogsByTriggerMessage` 按 (会话, 猫, 触发消息) + `status='running'` 窄定位），**没有在 serial 穿线**——理由：① 票 §八 自己把 `serial.ts` 划为「事故密集区、另票一个风险面」，穿线要改 4 个签名；② 与同文件 `updateExecutionLogDiagnostics`（实施后实测 `:1180`）既有的「按 agent + running 定位」同款，只是多带两个条件、错挂面更小。**未命中时不编 `execution_id`、直接跳过并记 warn**（不违反 NOT NULL、也不编数据）。_这是契约缺口，若店长要穿线版，改动量 = 4 签名。_
2. **`truncated` 在 `budget-exhausted` 路径由 `false` 改判 `true`**（声明的微修正）：该路径按定义就是「预算截断发生」（`bySection` 非空却一节没进），原值落成 `EMPTY_STATS` 的默认 `false` —— 与 ok 路径同口径（`kept.length < bySection.size` ⇒ `0 < N` ⇒ true）后修正。**不动会让这张表在「预算够不够」这个头号问题上产出反向读数。**
3. **流水类型合并到写口契约**：`memory/index.ts` 原本另写了一份 `MemoryCandidateTrace` / `MemoryQueryTrace` 字段表（与写口 20 列重复），已改为 `type = RetrievalCandidateInput` 别名。理由：两处各写一份，改一处漏一处**没有编译期信号**——**合并当场抓出一处真错**（测试里写的 `passesStatusFilter` vs 契约的 `passedStatusFilter`，旧名来自 C1 前的 memory 侧）。
4. **`renderSections` 改为复用 `renderOrder`**（唯一真相源）：`injectedPosition` 要答「猫读到的第几条」，与渲染序必须同源；两份各写会**静默**漂移。行为不变，由 §九 17 的差分用例守（n=1..5 全窗口逐字节）。
5. **埋点整段加 try/catch**（票 §三 硬约束 2 的本意）：原实现只包了写口内部，**查执行行 / 取参数快照 / 组装**三段在外——实测被 5 个测试替身（partial `vi.mock` factory 缺 `currentRetrievalParams`）打中，`runAgentReply` 整条中断、**87 个用例连片失败**。修法是双管：① 整段兜底 + `log.warn`；② **5 个替身补上该导出**（替身必须镜像真模块被消费的导出面）。
6. **顺手清一处死 import**：`memory/index.ts` 的 `ChunkRow`（`isVectorHitRow` 删除后零消费方），A5 同病灶。
7. **超时路径的 `retrieval_ms` 取外侧计时**：有 `memoryResult` 时取模块内测值（同一趟），超时/抛错无内测值才退到 `reply.ts` 外侧计时。两把尺子的分界写死在代码注释里。

### 11.4 行号审计（改完全仓复核，本仓反复病灶）

§十一 11.1 的行号是**实施后实测**（`grep` 复核过）。但审计中发现**我自己引入了一处行号漂移**：`reply.ts` 的埋点注释写「（`insertAgentMessage`，下方 `:911`）」——`:911` 是**改动前**的地址，我往该文件插了约 100 行后实际在 `:1006`。

**修法不是改成 `:1006`，而是换成符号引用**（「本文件下方『写入完整消息』段」）——绝对行号会被下一次编辑再次打漂，符号不会。同批核过的引用：`db/index.ts:642/677/696`、`chunks.ts:374/394/414/491`、`memory/index.ts:149/290/414/536`、`reply.ts:214/706/729`、`serial.ts:1232`、`updateExecutionLogDiagnostics` 实施后 `:1180`（本票 11.3 原写 `:1077`，同为改动前地址，已更正）。

**教训**：设计票里的行号是「写下那一刻」的快照，实施后必然全体漂移。**实施留痕给实测号；代码注释给符号**——两者混用就是本仓记过多次的「记录≠真相」。

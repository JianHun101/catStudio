---
type: plan
date: 2026-09-17
status: 已定稿
evidence:
  - kind: file
    ref: packages/server/src/db/index.ts
  - kind: file
    ref: packages/server/src/db/repository/messages.ts
  - kind: file
    ref: packages/server/src/db/repository/sessions.ts
  - kind: file
    ref: packages/server/src/routes/internal.ts
---

# 数据库结构治理：迁移机制立闸（P0）+ 约束 / 时间口径 / 成员表（B 范围定稿）

> 一份文档两个层面：**P0（迁移机制 + 索引）本轮实施**；**B 范围（FK/删除策略/CHECK、时间口径统一、session_agents 拆表）设计定稿、实施票缓拆**——范围 A 决策，2026-09-17 用户拍板。
> 写者：店长（架构师）。grilling 全程用户逐条拍板，拍板留痕见 §八。

## 一、愿景

本地单进程猫咖的库结构管理处于「裸奔」态：迁移无台账，每次启动全量重跑靠 `catch {}` 全吞维持幂等；CREATE TABLE 独立块与迁移数组双路径维护；重建类迁移的失败是静默的。本活给库结构上闸——**P0 立迁移台账 + 补索引**，让「改结构」从此是一条可信路径；并把审查发现的结构病灶（FK 缺口、CHECK 缺口、时间口径两套、`agent_ids` JSON 反范式）的设计一次谈死（B 范围），实施票等 P0 落地验证后再拆，避免「迁移机制本身还没可信，就用它跑重建表级迁移」的叠床架屋。

## 二、需求（用户故事）

1. 作为维护者，我要每次启动时迁移「已登记的跳过、未登记的按序执行、登记后被改的拒启」，以便结构演进可信。
2. 作为维护者，我要迁移失败 = 启动失败且带迁移名与原始错误，以便问题当天发现而不是运行时炸。
3. 作为维护者，我要全新库从空库重放基线集得到与现行代码一致的结构，以便新环境零考古。
4. 作为用户，我要本机老库升级后基线补登记、不重复执行，以便平稳上船。
5. 作为维护者，我要静默失败型（重建类）迁移挂探针、效果缺失才真执行，以便历史债被兜住。
6. 作为维护者，我要主查询路径 `EXPLAIN QUERY PLAN` 无全表扫，以便查询性能有索引兜底。
7. 作为用户，我要「删除会话」= 归档（数据保留、列表清爽），以便数据价值不丢。
8. 作为用户，我要删除一只仍在会话里的猫时被明确拦住并告知它在哪些会话，以便走显式路径而不是留下悬空引用。
9. 作为维护者，我要记录时间全库单一口径、由 repository 统一生成，以便口径永不分裂。
10. 作为维护者，我要会话成员关系是一张表（有序、防重、引用完整），而不是 JSON 字符串。

## 三、P0 契约（本轮实施）

### 3.1 迁移机制（②四个子决策 + SQL 形态，全部已拍板）

**SQL 形态**：迁移数组抽到独立模块 `db/migrations.ts`，维持 TS 数组，不提 `.sql` 文件。条目形状：

```ts
{ name: string; sql: string; verify?: (db) => boolean }
```

**台账 `schema_migrations`**：`name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, note TEXT`。

- `checksum` = SQL 原文 sha256，**不做空白归一化**——落地迁移一个字节都不许改，格式化也不行。
- `applied_at` 直接写 ISO 8601 UTC 毫秒（预采用 ⑤-a 目标格式，不给自己造⑤的债）。
- `note='baseline'` 标记老库补登行。

**②-a 压扁重放**：趁版本表未上船（这是最后一个能合法改写历史迁移的窗口），把现有 61 条历史迁移一次性压扁成基线集——每张表一条 CREATE TABLE（直接写最新形状，`widenReviewVerdictsCheck` 的 CHECK 放宽誊进 `review_verdicts` 基线）、索引各归其位，约 20 条，以誊写产出为准。

- **新库**：空库 → 按序重放基线集 → 全部登记。CREATE TABLE 独立块删除，**迁移数组成为唯一 schema 真相源**。
- **老库**：走 ②-b 补登，不真跑。
- **未来迁移**：append-only，新旧库同一条增量路径。

**②-b 老库 baseline 补登 + verify 探针**：

- 判定：有用户表且无 `schema_migrations` → 老库 → 基线条目逐条**只登记、不执行**（依据：旧机制每次启动全量重跑，效果缺失早以故障形式暴露，补登是高置信推断）。
- **探针钩子**：条目可携带 `verify(db)`，仅 baseline 补登时调用——探针报「效果缺失」→ 该条破例真执行（矫正路径）再登记。只给静默失败型（重建类）迁移挂探针；实施时审计全部历史迁移定清单，已知候选 `widenReviewVerdictsCheck` 与 `ensureChunkVectorCosineMetric` 两处守卫。
- 残余风险明写：探针未覆盖的静默失效会被补登吞掉，恢复路径 = 手工 SQL 或追加矫正迁移。

**②-c catch 全收窄**：每条迁移一个事务（`BEGIN IMMEDIATE` / `COMMIT`），失败 `ROLLBACK` + **拒绝启动**，错误信息带迁移名 + SQLite 原错。零吞咽、零「预期错误」白名单——版本表接管了「跳过」，baseline 接管了「老库」，catch 再无任何合法存在理由。

**②-d checksum + append-only 纪律**：启动时先校验已登记条目的 checksum，不符 → 拒启 + 明示「该迁移落地后被修改，请用新迁移 fix-forward」。数组 append-only；改结构只能追加新迁移；压扁窗口关闭后无例外。

**边界语义（grilling 澄清，定稿）**：迁移未登记但目标表不存在 → SQL 报错 → 事务回滚 → 拒启（正确行为：库状态对不上任何已知历史路径，停下等人看）；迁移已登记但表后被删 → 台账管历史不管现状，启动拦不住、运行时暴露，台账 + sqlite_master 对账可精确诊断。两种情形都**不自动重建**。

### 3.2 索引（③三条，已拍板）

原则：**只补有查询证据的索引，不预防性乱建**——每个索引都是写放大。

| 索引                                               | 服务的查询                     | 备注                                                                          |
| -------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `messages(session_id, created_at, id)`             | 会话历史拉取 + 游标 tie-break  | 现有 `(session_id, created_at)` 两列版升级                                    |
| `execution_logs(session_id, started_at)`           | 会话级日志查询、恢复路径       | 该表当前零二级索引；列名 `started_at`（2026-09-17 笔误勘正，原写 created_at） |
| `execution_logs(status)` 或 `(session_id, status)` | running 计数（重启判据主查询） | 实施时对照实际 SQL 定形：查询总带 session_id 则用复合                         |

不动的表：agents / sessions 行数小、主键查询为主，不补；chunks 三表有 sqlite-vec 自有索引，content_hash 唯一键存在性实施时核对。

**落地形态**：三条索引作为压扁后数组的**首批 append 迁移**——不许进基线集（老库补登不真执行，进基线 = 索引永远建不上）。这也是 append-only 路径的首次实战。

### 3.3 P0 验收标准

1. **新库**：空库重放基线集后 `sqlite_master` 全量 dump 与现行代码产物**逐表一致**（压扁誊写校验，不一致即誊写错误、测试拦住）；台账全登记。
2. **老库**（本机 `cat-study.db` / `cat-study-dev.db`）：升级启动 → 基线补登 `note='baseline'`、不重复执行；探针审计结果留痕。
3. 注入一条失败迁移 → 拒启 + 错误带迁移名与 SQLite 原错。
4. 篡改已登记迁移 SQL → 拒启 + fix-forward 提示。
5. 三条索引就位，其服务的查询 `EXPLAIN QUERY PLAN` 无 `SCAN`；索引只建清单内的，新增任何一条须在票单举出查询证据。
6. 既有 server 测试全绿（`:memory:` + `setDb/resetDb` 路径兼容）。

## 四、B 范围决策（设计定稿，实施票缓拆）

### 4.1 FK / 删除策略 / CHECK（④修订版，已拍板）

- **PRAGMA**：`foreign_keys = ON` **已在**（`index.ts:27`）——本项从「新增」更正为「保持」，列为不变量（每个连接路径都须开，含测试注入路径）。
- **FK 补齐**：核心引用链补齐（已存在：messages→sessions、execution_logs→sessions/agents、session_read_state→sessions CASCADE、episode_attributions→episodes、retrieval 系、spans 系；已知缺口：messages.agent_id→agents、review_verdicts 各引用、connector_bindings.session_id、episodes 各引用、flow_states/flow_state_events.session_id——实施时逐表审计定稿）。**已登记松耦合一律不加**：chunks 派生投影、retrieval_candidates.chunk_id（仅诊断）、eval_scores / user_feedback。
- **前置孤儿审计**：重建加 FK 会校验存量——先对各候选关系跑「子表 LEFT JOIN 父表 IS NULL」出孤儿报告（量级 + 样本），只读可重复。
- **孤儿处理（用户拍板）**：审计先行，报告出来用户拍板，**默认倾向删除**（开发阶段、疑似没删干净的残渣）；若量大或涉核心资产（如 messages），回收容所方案（占位父行，一行不丢）。报告留痕。
- **删除策略**：物理删除全 **RESTRICT**；CASCADE 仅纯成员关系行（session_agents）。**用户态「删除」= 归档**：sessions 加 `archived_at`（NULL=活跃），`ALTER TABLE ADD COLUMN` 轻迁移 + 部分索引；前端列表默认过滤 + 「显示已归档」开关；**归档不动记忆检索**（归档会话照常可被记忆系统检索）。
- **删除被拦的行为契约**：删被引用的 agent → repository **先查后删**（先查引用，命中则不执行 DELETE，抛领域错误并携带会话清单）→ API 返回 **409 + 结构化错误体**（非 500）→ 前端引导「先从会话移除，或归档」。验收：删除被引用 agent 返回 409 + 会话清单；无引用时正常成功。
- **CHECK**：封闭枚举才 CHECK（判据：取值集合封闭、由代码常量定义；代价是扩容须重建表）。已存在：messages.role、execution_logs.status、review_verdicts.verdict、review_parse_failures.reason、eval_scores.sample_reason、connector_bindings.external_type、episodes 三列、episode_attributions 两列；已知缺口：messages.dispatch_state。清单实施时对照代码常量定稿。

### 4.2 时间口径统一（⑤，已拍板）

- **目标口径（⑤-a）**：ISO 8601 UTC 字符串、毫秒精度（`2026-09-17T08:30:00.123Z`）。定宽格式字典序 = 时间序，索引/排序/比较正确；JS 全栈 `new Date().toISOString()` 零转换；SQLite `datetime()` 原生可吃。
- **存量迁移（⑤-b）**：秒级 → ISO **无损单向**（毫秒位补 `.000`），随 rebuildTable 同批转换，转换后抽样比对。**铁律：同一张表的所有结构变更（FK/CHECK/时间列/删列）一次重建做完**，不重建第二次。前置审计：逐列实测格式分布，转换 SQL 按实测写。
- **生成纪律（⑤-c 修订版）**：**记录时间**（created_at / updated_at）由 repository 层统一 helper 生成，调用方不许传；**事件时间**（语义是「事情发生时刻」，如 started_at / finished_at）允许调用方显式传入，命名必须体现事件语义，评审检查例外是否名副其实。不使用数据库 DEFAULT 生成（SQLite `datetime('now')` 仅秒级，精度降档）。
- **连带改造点（读码钉死）**：全仓 SQL 侧 `datetime('now')` 写入口与比较点须随迁移同批切到新格式——已知面：agents / sessions / executionLogs / flowStates / knowledge / sessionReadState / settings 各 repository 的写入，messages 超时窗 `datetime('now', ?)` 与游标比较（`messages.ts:127` 有「时间戳归一」注释依赖秒级格式）。**格式混比会错序，必须同批切换，不留半套。**
- 现状分布（实测）：DB 记录时间几乎全为 SQL 侧 `datetime('now')`（秒级 UTC）；事件时间 `spans.start_at` 为 ISO 毫秒；文件态 JSON（重启请求等）为 ISO。

### 4.3 sessions.agent_ids 拆表（⑥，已拍板）

```sql
CREATE TABLE session_agents (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  position   INTEGER NOT NULL,   -- 注册序：JSON 数组顺序的迁移载体
  joined_at  TEXT NOT NULL       -- ISO 毫秒（记录时间，repo 层生成）
  PRIMARY KEY (session_id, agent_id)
);
-- agent_id 单列索引（FK 子表索引纪律：按猫反查会话）
```

- **position 不可省**：`internal.ts:820` 注释钉死「JSON 数组顺序 = 注册序」被成员解析端点消费；迁移时数组下标直接落为 position，信息零损失。复合主键数据库层防重复成员。
- **迁移路径（顺序不能反）**：① 建 session_agents + 遍历 sessions 解析 JSON 灌入；② 重建 sessions（删 agent_ids 列 + 时间口径 + 约束，同批一次）。悬空引用（JSON 引用已删 agent）灌入时被 FK 拦住 → 先进孤儿审计清单，随 ④ 流程用户拍板。
- **读取路径**：全部改走新表，对外 API 形状不变（`agentIds: string[]` 按 position 序组装），前端零感知。
- **隐藏行为保留（验收项）**：`updateSessionAgentIds` 整组替换时仍 touch `sessions.updated_at`——成员变更影响会话列表「最近活跃」排序，丢了就是静默回归。
- **删除策略**：删 session → CASCADE 删成员行；删 agent → RESTRICT。行为变更点：`internal.ts` 的「悬空 agent 补 null」降级路径从「正常可能触发」变为「防御性死代码」——代码保留作防御，正常路径不再触发；agent 退出舞台的正路 = 从会话移除成员 / 未来 agent 归档。

### 4.4 B 范围实施纪律（随决策定稿）

1. 实施顺序：孤儿审计报告（只读，第一张票）→ 用户拍板孤儿处置 → 结构重建批。
2. rebuildTable 通用 helper 是 B 范围重建批的前置。
3. 每张文重建 = 一次事务，含数据拷贝与校验。
4. 前端归档入口（归档操作 + 显示开关）随 sessions 重建票交付。

## 五、测试决策

- **只测外部行为，不测内部实现**：启动结果（拒启/放行）、台账内容、sqlite_master 结构、查询计划。
- **seam**：`initDb()` 启动序列是唯一 seam——`:memory:` SQLite + `setDb/resetDb` 既有钩子直接复用，不设新 seam。
- **P0 测试面**：
  - 压扁誊写校验：空库跑 initDb → `sqlite_master` dump 与现行代码产物逐表一致（静态源断言有先例：`spans.test.ts` 用源码 slice 断言 DDL）。
  - 老库模拟：先以旧 DDL 建库（无 schema_migrations）→ 再跑 initDb → 断言补登 `note='baseline'`、未重复执行、数据原样。
  - 探针：模拟 widen 未生效的老库 → 断言该条真执行且效果补齐。
  - 拒启：注入失败迁移 → 启动抛错带迁移名；篡改已登记迁移 SQL → 拒启。
  - 索引：对三条索引服务的查询断言 `EXPLAIN QUERY PLAN` 无 `SCAN`。
- **既有测试零回归**：`index.test.ts` 及全部 repository 测试在 :memory: 路径下保持绿。
- B 范围测试面随实施票再定，方向：孤儿审计报告断言、归档读写路径、拆表后 touch 行为保留、409 契约。

## 六、Out of Scope

- **B 范围全部实施票**——设计已定稿，票等 P0 落地验证后拆（范围 A 决策）。
- **运维项**：api_key 加密存储、数据保留策略、备份机制、DB 路径配置化——与 schema 解耦，后续单开。
- **agent 归档**：仅登记方向（sessions `archived_at` 先例），不在本批。
- **SQLite 单写入者天花板**：本地单进程定位下接受，不处理。

## 七、过程决策留痕

- **grilling 全程跑**（2026-09-17，用户逐条拍板），无跳过。
- **范围裁决**：A——P0 实施 + B 设计定稿票缓拆（用户拍板，消息 7d04f1ff）。
- **Gate B 契约**：[边界=P0 迁移机制+索引本轮实施 / B 范围只定稿不拆票 / 运维项不在范围；契约=迁移条目形状与台账结构、压扁重放与 baseline 补登语义、探针钩子、checksum 纪律、索引三条、④⑤⑥ 全量决策；验收=§3.3 六项 + §四各决策内嵌验收点] 已钉死。
- **②-a 压扁重放 / ②-c 全收窄 / ②-d checksum+append-only**：用户拍板（b72a9e15）；**②-b 保留 + SQL 形态 `db/migrations.ts`**：用户拍板（8e283645）。
- **③ 索引三条**：用户拍板（8e283645）。
- **④ 修订版**（RESTRICT+归档 / FK 核心链 / 封闭枚举 CHECK）：用户拍板（fa3a129e 轮）；**孤儿处理**改「审计先行→报告出来用户拍板，默认倾向删除」（用户修订，32478863）。
- **⑤-a ISO 毫秒 / ⑤-b 无损单向**（7bd79b87 轮同意）+ **⑤-c 修订版**（记录时间收口 / 事件时间例外，用户确认 36ca4f26）。
- **⑥ 四个子决策 + joined_at + 删除被拦 409 契约**：用户拍板（a65b2697）。
- **读码校正**（2026-09-17，spec 落笔前）：PRAGMA 已在（④-a 改「保持」）；FK/CHECK 已存在清单与真实缺口如 §4.1；messages 已有两列索引（③第一条为升级）；时间口径真实分布如 §4.2；迁移数组 61 条。以上均收紧事实、不翻任何决策。

## 八、架构决策留痕

- 候选 ADR：**迁移机制形态**（压扁重放 + baseline 补登 + checksum + append-only）——跨会话重建「为什么这么设计」的关键，P0 落地时单开 ADR。
- 候选 ADR：**「删除 = 归档」数据观**（物理删除 RESTRICT 封死、用户态删除唯一形态是归档、归档不动记忆检索）——产品哲学级，可与上条并开或单开，P0 收口时定。

## 九、验收结果

状态：**待收口后回填**。

P0 实施自检对照（实施猫交付时逐项确认）：

- [ ] `db/migrations.ts` 独立模块，条目形状 `{name, sql, verify?}`，数组 append-only
- [ ] `schema_migrations` 台账（name / checksum / applied_at ISO / note）
- [ ] 空库重放 `sqlite_master` dump 与现行产物逐表一致（测试）
- [ ] 老库 baseline 补登 + 探针矫正（测试 + 本机两库实测）
- [ ] 迁移失败拒启带迁移名 + 原错（测试）；checksum 篡改拒启（测试）
- [ ] CREATE TABLE 独立块已删，迁移数组为唯一 schema 真相源
- [ ] 索引三条作为首批 append 迁移落地，EXPLAIN QUERY PLAN 无 SCAN
- [ ] server 测试全绿，无 B 范围改动混入

# 票：数据库结构治理 P0（迁移机制立闸 + 索引三条）

> **状态：票 1 三轮审查 ✅ 已收口（`3f7cab1` + `d90ebed` + `694a859` 合入 dev）；票 2 已解锁（索引三条 + OQ4 播报措辞——OQ1 fix-forward 已由 ds猫 以 `694a859` 随票 1 收口，**退出票 2 票面**），在 flash猫 手中。**
> 定稿规格：`docs/plans/db-schema-governance.md`（下称 spec，commit `e5daf7a`）。票单不复制 spec 全文，只钉执行面；与 spec 冲突以 spec 为准。
> 范围裁决：A——P0 本轮实施，B 范围（FK/CHECK/时间口径/session_agents 拆表）设计已定稿、**票缓拆**，等 P0 落地验证后再拆。

## 票 1 · 迁移机制立闸（派 ds猫，走 worktree）

### 交付物

启动时迁移「已登记的跳过、未登记的按序执行、登记后被改的拒启、执行失败的拒启」可信；CREATE TABLE 独立块删除，迁移数组成为唯一 schema 真相源。

### 改哪些文件

| 文件                                                                          | 动作                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/db/migrations.ts`                                        | **新建**。迁移数组独立模块，条目形状 `{ name: string; sql: string; verify?: (db) => boolean }`。内容 = 压扁后的基线集：现有 61 条历史迁移一次性誊成每表一条 CREATE TABLE（直接写最新形状，`widenReviewVerdictsCheck` 的 CHECK 放宽誊进 `review_verdicts` 基线）、既有索引各归其位，约 20 条 |
| `packages/server/src/db/index.ts`                                             | **改**。删 CREATE TABLE 独立块与 61 条迁移数组；建 `schema_migrations` 台账（`name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, note TEXT`）；runner：checksum 校验 → baseline 判定补登（带探针）→ 差集逐条事务执行；失败拒启带迁移名 + SQLite 原错                  |
| `packages/server/src/db/migrations.test.ts`（或按 co-located 约定挂主模块旁） | **新建**。spec §五 P0 测试面全部落地                                                                                                                                                                                                                                                        |

### 契约（不得擅改，spec §3.1）

- **checksum** = SQL 原文 sha256，**不做空白归一化**；启动先校验已登记条目，不符 → 拒启 + fix-forward 提示。
- **applied_at** 写 ISO 8601 UTC 毫秒（预采用 ⑤-a 目标格式）。
- **②-b baseline 补登**：判定「有用户表且无 schema_migrations」→ 老库 → 基线逐条只登记（`note='baseline'`）不执行；条目可携 `verify(db)` 探针，仅补登时调用，探针报效果缺失 → 该条破例真执行再登记。探针只挂静默失败型（重建类）迁移——**实施时审计全部 61 条定清单**，已知候选 `widenReviewVerdictsCheck`、`ensureChunkVectorCosineMetric`，审计结论留痕进提交说明。
- **②-c 全收窄**：每条迁移一个事务（`BEGIN IMMEDIATE`），失败 ROLLBACK + 拒启。零吞咽、零「预期错误」白名单。
- **append-only**：数组只许追加；压扁窗口关闭后无例外。
- **边界语义**：迁移未登记但目标表不存在 → 报错回滚拒启（正确行为）；已登记但表后被删 → 启动拦不住、运行时暴露。两种情形都不自动重建。

### 边界（不做什么）

- **不做三条新索引**——那是票 2，且必须以 append 迁移身份进数组（不许混进基线集，否则老库补登不执行、索引永远建不上）。
- 不动 B 范围一切：FK 补齐、CHECK、时间口径统一、session_agents 拆表、归档列——一律不碰。
- 不动 repository 层、不动 PRAGMA（`foreign_keys = ON` 已在 `index.ts:27`，保持）。
- 不引入新依赖。

### 验收标准（行为可验证，spec §3.3 对应项）

1. **压扁誊写校验**：空库跑 initDb → `sqlite_master` 全量 dump 与**改动前**现行代码产物逐表一致（先跑旧码留 dump 作 fixture，再跑新码比对；不一致即誊写错误，测试拦住）。
2. **老库模拟**：先以旧 DDL 建库（无 schema_migrations）→ 跑 initDb → 断言基线补登 `note='baseline'`、未重复执行、预置数据原样；探针用例：模拟 widen 未生效的老库 → 断言该条真执行且效果补齐。
3. **拒启**：注入一条失败迁移 → 启动抛错带迁移名 + SQLite 原错；篡改已登记迁移 SQL → 拒启 + fix-forward 提示。
4. 既有 server 测试全绿（`:memory:` + `setDb/resetDb` 路径兼容，`MEMORY_ENABLED=false` 约定不变）。
5. CREATE TABLE 独立块已删，迁移数组为唯一 schema 真相源（静态源断言或等价检查）。

### 流程

走 worktree；完成后过 quality-gate 自查 → request-review 投吐槽猫；不自行合并、不自行 push（push 门禁会拦，预期行为）。

---

## 票 2 · 索引三条 + OQ4 播报措辞（派 flash猫，blocked by 票 1 → **已解锁**）

> **票面修订（2026-09-17，收口 `694a859` 时）**：OQ1 fix-forward 原终裁「随票 2 落地」，但 ds猫 已在票 1 分支直接实现（`694a859`）并经第三轮审查 ✅——为不重复造轮子、让主库保护早上船，**fix-forward 改随票 1 收口，退出本票票面**。本票只剩索引三条 + OQ4。

### 交付物

spec §3.2 三条索引作为 `APPENDED_MIGRATIONS` 追加条目落地（append-only 路径首次实战），外加 OQ4 播报措辞打磨。

### 改哪些文件

| 文件                                   | 动作                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/server/src/db/migrations.ts` | **append 三条**（追加区尾部追加，不改既有条目一个字节；均不带 `baseline` 标记） |
| `packages/server/src/db/index.ts`      | **OQ4**：汇总播报补「N 条新增迁移真执行」计数（与 repair 单行列并存）           |
| 测试（co-located）                     | 对三条索引服务的查询断言 `EXPLAIN QUERY PLAN` 无 `SCAN`；老库 append 真执行用例 |

### 契约（spec §3.2 + OQ1 裁决）

**索引三条**（同原票单）：

| 索引                                               | 服务的查询                     | 备注                                                                      |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `messages(session_id, created_at, id)`             | 会话历史拉取 + 游标 tie-break  | 现有 `(session_id, created_at)` 两列版升级                                |
| `execution_logs(session_id, created_at)`           | 会话级日志查询、恢复路径       | 该表当前零二级索引                                                        |
| `execution_logs(status)` 或 `(session_id, status)` | running 计数（重启判据主查询） | **对照实际 SQL 定形**：查询总带 session_id 则用复合，定形依据写进提交说明 |

- 只建清单内三条；想新增任何一条，先在票单举出查询证据回架。
- 不动的表：agents / sessions（行数小、主键查询为主）；chunks 三表（sqlite-vec 自有索引，content_hash 唯一键存在性顺手核对即可）。

**fix-forward 补建迁移（OQ1 终裁，2026-09-17；已由 ds猫 以 `694a859` 落地，随票 1 收口，退出票 2 票面）**：主库实测缺 14 件物体（retrieval_* 三表 + spans 两表 + 9 索引，双源实测确认）——旧机制时代静默失败的残骸。实现要点（`694a859` 落地形态，供后续参照）：

- **正文按名取自基线条目**（`MAIN_DB_REPAIR_ENTRY_NAMES` 14 个名字 → `baselineEntrySql` 查 `BASELINE_MIGRATIONS`），零抄写、零平行真相源；引用不存在的名字模块加载即抛；
- 14 条全是 `CREATE ... IF NOT EXISTS` ⇒ 已完整的库 no-op、缺件的库才真建；**不挂 verify 探针**（纯 `IF NOT EXISTS` 条目挂不挂探针行为相同，探针清单维持审计定稿的 3 条）；
- 顺序 = 建表依赖序（FK 目标先建），单事务执行；
- 无探针的语义后果：对已齐件的库，该条真执行 14 个 no-op 并登记为普通 append（`note` 空）——「真执行 no-op」与「探针 true 只登记」终态相同，符合 ②-a「同一把尺子」。

### 验收标准

1. 三条索引就位，其服务的查询 `EXPLAIN QUERY PLAN` 无 `SCAN`（逐条贴查询计划进报告）。
2. 老库路径实测：append 迁移在老库（票 1 补登过的库）上真执行、索引真建上——这是 append 路径存在的意义，必须实测不推断。
3. ~~fix-forward 用例~~（已随票 1 `694a859` 落地并审 ✅，退出本票）。
4. 既有测试全绿；迁移数组既有条目零改动（checksum 纪律自查）；OQ4 播报在「0 条真执行 / N 条真执行」两种情形下措辞均与实际一致。

### 流程

同票 1：worktree → quality-gate → request-review 投吐槽猫；不自行收口。

---

## 串行依赖与后续

- 票 2 向票 1 创建的 `migrations.ts` 追加条目，**必须票 1 收口合入 dev 后开工**（并行必撞，且 append 路径要在闸立起来之后走）。
- B 范围票（孤儿审计 → FK/CHECK/归档 → 时间口径 → 拆表）等 P0 两票落地验证后按 spec §4.4 纪律拆。

---

## 票 1 审查回执（2026-09-17，吐槽猫 ⚠️ 建议修改 → 店长裁决）

**被审 commit**：`3f7cab1`（分支 `session/54c4de25-ds猫`）。验收 1 基准经审查者用真旧码独立复算（47 行一致，非自证）；验收 2/3 逐条核对过；验收 4/5 因 worktree 环境限制降级采信（tsc 绿 + 2685 绿工作树证据）。

**必须修 1 项（runner 语义偏差，店长复核属实）**：老库分支的 register-only 作用到整个数组而非基线集——`execute = !probeSaysDone && (!isOldDb || m.verify !== undefined)` 使无 `verify` 的 append 迁移在无台账老库上被记 `note='baseline'` 且永不执行（跳版本升级路径上的静默缺表 + 假历史）。spec §3.1 ②-b 原文是「**基线**条目逐条只登记」，此为 spec 符合性修正，不改契约。
**修法**：基线条目显式标记（`baseline: true` 元数据或常量清单）；isOldDb 的 register-only 只认基线条目；非基线未登记条目任何库上都真执行。补用例：「无台账老库 + 数组含 append 迁移 → append 真执行、不记 baseline」。

*_OQ1 裁决（主库缺 14 件物体：retrieval__ 三表 + spans 两表 + 9 索引，双源实测确认）**：**采纳 ② fix-forward**——数组末尾追加一条补建迁移（`IF NOT EXISTS`，14 件物体）。落在 spec 既定恢复路径内（「手工 SQL 或追加矫正迁移」取后者），append-only 合法、进台账可审计可测试。否决 ①（基线挂存在性探针——推翻 ②-b 补登依据）；③（认账手工 SQL）为次选。**前置：先落 runner 修正**，否则该迁移在无台账老库上会被老库分支自己吞掉。

小观察（不要求返工，采信）：`probeSaysDone` 事务外调用（单进程无害）；探针语义收紧（全新库也调探针）合理，新库靠它避开「先建好再白重建」。

**票 2 维持阻塞**，等票 1 返工收口合入 dev 后开工。

---

## 票 1 复审回执（2026-09-17，吐槽猫 ✅ 可合并）

**被审 commit**：`d90ebed`（`3f7cab1` 的修正子提交，拓扑已核：3f7cab1 为其祖先，审的链一致）。审查者独立复跑 `src/db` 210 例全绿 + Node 精确行号比对（134/135、140/321 等声称行号全部属实，此前 PowerShell 编码读数有误、以 Node 为准）。

**修正项核对（店长抽核 diff 采信）**：register-only 收窄到基线条目（`baseline === true` 标记由 `BASELINE_MIGRATIONS` 拼接点结构性统一盖，不靠 41 处手写）；note/计数面同步收窄（审查首轮只点了执行面，标注面的假历史另一半是 ds猫顺着判据自推的，属实）；`APPENDED_MIGRATIONS` 为空 ⇒ 生产行为本轮零漂移；四条新用例非自证（`:301` 用「真执行必撞 duplicate column」使「不抛」成为硬证据）。

**判据之争裁定（店长）**：**采纳 ds猫 实现，吐槽猫正式收回「非基线未登记条目一律真执行」的字面表述**。要保的不变量是「追加迁移不因『老库』身份被静默跳过」——实现保住了：带探针的追加条目探针 true 只登记，记的是「效果经验证已存在」的真事实，不是身份推断的假历史；若强制真执行，已被手工 SQL 提前做掉的库会永远撞 duplicate column 拒启，方向与本票相反。

**OQ1 终裁（店长，2026-09-17）**：fix-forward **随票 2 落地，不重开票 1**。理由：① `d90ebed` 复审 ✅ 是干净状态，为一条追加条目重开审查轮不划算；② fix-forward 的形态（`APPENDED_MIGRATIONS` 追加 + 存在性探针）与票 2 的索引追加完全同构，本就是「向追加区写迁移」的活；③ 票 2 尚未派活，扩票面零返工成本；④ 红利：fix-forward 在主库首启时实跑的正是本轮修正的「老库撞带探针追加条目」路径——生产环境对修复点的首次实测就挂在票 2 验收上。
**安全窗口说明**：若用户在票 2 上船前以票 1 代码启动主库，baseline 补登会把 14 件缺失物体也登记掉（无探针覆盖），但 fix-forward 到达后首启探针 false → 真执行补建，**自愈、无永久损伤**；主库缺 retrieval 表期间记忆检索报错是既有状况，非本次引入。

**遗留观察项（不阻塞，登记随 B 范围或后续单）**：无新增；首轮两条小观察（probeSaysDone 事务外调用 / DDL 文本归位）维持不要求返工。

---

## 票 1 裁决二复审回执（2026-09-17，吐槽猫 ✅ 可合并 → 店长收口 `694a859`）

**被审 commit**：`694a859`（fix-forward 补建迁移，ds猫 对 OQ1 终裁的实现；父提交 = `d90ebed` 已入 dev，单提交干净增量）。审查者逐项核对 + 独立复跑 `src/db` 214 例全绿。

**店长独立抽核（不盲信回执）**：

- 拓扑：`d90ebed..694a859` 恰一条提交，diff 仅 `migrations.ts`（+63）与 `migrations.test.ts`（+132），`BASELINE_MIGRATIONS` 零字节改动（checksum 纪律守住）✅；
- 14 个修复名字与基线条目**逐一实比对上**、条条 `IF NOT EXISTS`（Node 字节级探针亲跑，14/14 通过）✅；
- 测试面非自证：夹具用「从数组摘条目」造「从未发生」形态（非建好再 DROP），并有夹具自证用例 ✅；
- 新增 4 用例：主库形态自检 / 14 件建回 + 形状逐行一致 + 存量原样 / 正文恰好 14 件且依赖序 / 完整库 no-op。

**裁决二实现形态的两点偏离说明（店长知情批准）**：① 实现未挂存在性 verify 探针（吐槽猫候选②原话「带探针」）——审查者论证并裁定：纯 `IF NOT EXISTS` 条目挂不挂探针终态相同，不挂则探针清单维持审计定稿 3 条，**批准**；② 对已齐件的库，该条真执行 14 个 no-op 而非「探针 true 只登记」——「真执行 no-op」记的是真实发生的事，比「登记为已发生但实际是 no-op」更诚实，符合 ②-a 同一尺子，**批准**。

**OQ1 终裁的执行归属修订**：终裁原文「fix-forward 随票 2 落地」，但 ds猫 已在票 1 分支直接实现并经审 ✅——**改随票 1 收口**：不重复造轮子、主库保护早上船；票 2 相应收窄为索引三条 + OQ4 播报措辞。安全窗口论证（终裁时留下）依旧成立且更优：fix-forward 先于索引上船，主库首启即补建，索引追加随后以普通 append 真执行，两不干扰。

**遗留（不阻塞）**：OQ4 汇总播报在「0 条真执行」时措辞像「什么也没修」（repair 有单列日志兜底）——登记随票 2 顺手改；OQ2（checksum 耦合）审查者已论证不新增失败类（改基线正文会先撞该条目自身 checksum 拒启）；OQ3（note 空分不出补建）够用，显式来源列归票 2+ 台账 schema 变更时再议。

---

## 票 2 实施回执（2026-09-17，flash猫，**第二轮 · 票面收窄后重做**）—— 待审查

**分支**：`session/54c4de25-flash猫`；**被审 commit**：见交接文档。基线 = dev `5bcf8e79`（已含 `694a859`）。

**⚠️ 上一轮 `6bd2c19` 已被本轮取代，不作为交付面**：那一轮按**收窄前**票面实施，除三条索引外自带一条 fix-forward（名 `fix-forward 补建 retrieval/spans 缺失物体 (OQ1)`、带存在性探针、配套 `FIX_FORWARD_OBJECTS` / `baselineSqlOf` / `objectExists`）。收窄后它与 ds猫 的 `694a859`（名 `…五表九索引（票 1 OQ1）`、不带探针）**功能重复且两套 helper 并行**——本轮**让位删除**（条目 + 全部配套符号一并移除），只留 ds猫 那一条。收口时**只 carry 本轮被审 commit**。

`APPENDED_MIGRATIONS` 终态 = **4 条**（ds猫 补建 1 + 票 2 索引 3）。

### 交付物

| #   | 条目                                                        | 说明                                                                                                                                                                   |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `idx_messages_session upgrade (session_id, created_at, id)` | `DROP INDEX IF EXISTS` + 同名重建三列。**必须 DROP**：留着两列同名索引，`CREATE INDEX IF NOT EXISTS` 会在老库/dev 库/新库**三者全体**静默 no-op，升级永不发生          |
| 2   | `idx_execution_logs_session_started`                        | 落 `(session_id, started_at)`，理由见「偏离 1」                                                                                                                        |
| 3   | `idx_execution_logs_status`                                 | **定形依据 = 实测调用面**：三条 running 判据查询（`scripts/dev.js:183`、`index.ts:136`、`repository/executionLogs.ts:18`）**都不带 session_id** ⇒ 复合版一条都服务不到 |
| 4   | （ds猫 `694a859`，非本轮新增）                              | 本轮只做合流对账，零改动                                                                                                                                               |

`db/index.ts` —— **OQ4**：runner 汇总播报补一行 `[db] 追加区迁移真执行：N 条`（与老库补登那行**并存**；**每次启动都播报**，0 条即 0 条，两种情形措辞均与实际一致；计数含 `IF NOT EXISTS` 的 no-op 条目——它们确实执行过）。

### 验收对账（票面 4 条）

| #   | 验收项                                               | 结果 | 证据                                                                                                                                                                                                 |
| --- | ---------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 三条索引服务的查询 `EXPLAIN QUERY PLAN` 无 `SCAN`    | ✅   | 真库副本逐条计划见下                                                                                                                                                                                 |
| 2   | 老库路径 append 真执行                               | ✅   | 真库副本端到端见下（两库 `idx_messages_session` 实升三列、两库台账 4 条普通 append）                                                                                                                 |
| 3   | ~~fix-forward 双态~~（已随票 1 退出）                | —    | —                                                                                                                                                                                                    |
| 4   | 既有测试全绿 + 数组既有条目零改动 + OQ4 两态措辞一致 | ✅   | 全 4 project **134 文件 / 2703 用例全绿**；`lint` 绿；`migrations.ts` vs dev 的 diff **仅头部注释 + 3 条追加**（`BASELINE_MIGRATIONS` 与 `694a859` 条目零字节改动）；OQ4 两态各有用例 + 真空性反对照 |

**EXPLAIN QUERY PLAN（在真库副本上读，主库全程只读）**

| 查询                  | 计划                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| messages 游标         | `SEARCH messages USING INDEX idx_messages_session (session_id=?)`                     |
| execution_logs 会话级 | `SEARCH execution_logs USING INDEX idx_execution_logs_session_started (session_id=?)` |
| running 计数          | `SEARCH execution_logs USING COVERING INDEX idx_execution_logs_status (status=?)`     |

升级前对照：两条 execution_logs 查询均为 `SCAN`；messages 游标查询带 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`（升级的增量价值 = 末列 `id` 把 tie-break 收进索引）。

**真库副本端到端（源库只被 read/copy，`mtime 未变 = true`）**

| 库               | 物体    | messages 行 | 台账                        | 本轮新增物体                           |
| ---------------- | ------- | ----------- | --------------------------- | -------------------------------------- |
| dev（齐件 47）   | 47 → 49 | 2524 → 2524 | 41 baseline + 4 普通 append | **恰 2 件** = 两条 execution_logs 索引 |
| 主库（缺 14 件） | 33 → 49 | 1825 → 1825 | 41 baseline + 4 普通 append | **16 件** = 14 补建 + 2 索引           |

### 偏离与待裁

**偏离 1（上一轮实测，未变）**：`execution_logs` **没有 `created_at` 列**（时间列是 `started_at`/`ended_at`），spec §3.2 按字面实现当场 `no such column` → 拒启（实测）。落 `(session_id, started_at)`，形状用途不变。**请求店长收口时更正 spec §3.2 该行**（定稿规格面不由实施猫单方面改）。仓内同口径佐证三处：`repository/query.ts:15`、`eval/l1-aggregator.ts:68`、`routes/internal.test.ts:864`。

**偏离 2 / OQ（待裁，上一轮实测，未变）**：三列索引把**同秒平局的隐含判据由 `rowid`（插入序）换成 `id`（UUID）**。

- 影响面 = 7 个按 `created_at` **单列排序**的读口：`getRecentMessages`（猫上下文 `execution/reply.ts:340`）、`getSessionHistory`（UI `socketio.ts:190`）、`getAllSessionMessages`（派发扫描 `dispatch/index.ts:82`）、`getContextBefore`（`routes/eval.ts:243`）、`getTaskHistory`、`getLatestUserMessageId`（撤回判据 `socketio.ts:378`）、`getAgentRepliesAfter`。游标查询不受影响（它显式按 `(created_at, id)` 排序，是受益方）。
- 量级（两库实测）：平局覆盖 **1.5%** 消息行，位次真变 **0.6%(dev) / 1.1%(主库)**。
- 候选：①**接受 + 记录**（推荐：旧 rowid 判据本就非契约，`VACUUM` 可能重编 rowid；B 范围 ⑤-a 毫秒时间戳后平局基本消失）；②给上述查询补显式 `, rowid`（保插入序语义，代价是回落临时排序）；③补显式 `, id`（零排序，但同样是 UUID 序）。
- **本轮处置**：未动任何既有查询（触及共享读层，超票面「只建清单内三条」边界）；押在平局判据上的两处既有用例（`routes/eval.test.ts`、`connectors/socketio.test.ts`）改为**不依赖平局**，另在 `db/migrations.test.ts` 增「行为变更记录」用例把新判据钉住。

**本轮新增偏离（仅测试判据面，未降强度）**：追加区上线使「齐件库物体数」47 → 49，ds猫 侧 3 处硬编码 `BASELINE.length` / `33` 的断言按新口径换算（新增 `APPENDED_NET_OBJECTS` 常量，并注明权威清单在「验收 1 · 空库跑完整 initDb 净增 2 件」那条穷举用例）；全量 dump 逐表比对中 `idx_messages_session` 单列（同名升级，定义本就该变，其升级判据单列断言）。

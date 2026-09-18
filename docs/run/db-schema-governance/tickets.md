# 票：数据库结构治理 P0（迁移机制立闸 + 索引三条）

> **状态：P0 双票已收口（dev `7e5478b`，重启后实机验证 ✅）。B 范围：票 3 ✅、票 4 ✅、票 5 ✅、**票 6 批一 ✅**、票 7 ✅ —— 五票均入 dev（尖 `d0c7c35`）。D1–D4 已拍板（2026-09-17）。**
>
> **待办**：① **重启未获批** —— 票 6 批一 + 票 7 的迁移尚未生效，重启请求已发（`.restart-request`，含真库副本预演读数）；② 票 6 **批二**（episodes / retrieval_events / spans 三张过程式重建）+ **票 8**（拆表 + sessions 重建）均已解锁待派；③ **根治单待用户拍板**（见文末「收口后待裁」）。
>
> **审查链三次墙（均已拆，三种根因）**：墙#1 = 实施侧基线带旧票单（`39cc4b4` 修）；墙#2 = 审查侧 review-view 快照陈旧（`3c5815b` 修）；墙#3 = **同一冲突被解两遍**——`734d302`（店长在审查分支手工解）与 `bbc7a8e`（ds猫 在自家分支独立解）互为非祖先，两份「解过的记录」下次合并必撞（`git reset --hard 0cc6b72` 归零审查分支）。**教训：解冲突的产物留在审查分支上，就是下一轮的对撞物**——审查分支必须是纯内容快照。
>
> **合并态解法定型（收口第二票时复用）**：票 6 与票 7 都要进 dev，先到者 ff-only 干净，后到者必在追加区撞同一处。店长已在审查分支 `734d302` 预解并验证（全量 2812 例绿），收口时按此复用：① `migrations.ts` 追加区双保留按票号序（票 6 八条在前、票 7 两条接后），头注计数「十五条」；② `migrations.test.ts` 取 `BASELINE_SHAPE_DIVERGENCE` 白名单机制并补 `table:sessions`（票 7 的 `ADD COLUMN` 改形 sessions 建表原文，不收必红）；③ 票 6 测试切片补上界 `T6_END`（锚票 7 首条）——**原 `slice(T6_START)` 切到数组末尾，票 7 接后实得 10 条 vs 断言 8 条**，属叠加冲突的语义残留（git 不报冲突、跑测试才露），该修复只在「两票并存」的树上成立，故只能落在 dev 收口笔或审查分支，**不在任一猫分支内**。
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

| 索引                                               | 服务的查询                     | 备注                                                                          |
| -------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `messages(session_id, created_at, id)`             | 会话历史拉取 + 游标 tie-break  | 现有 `(session_id, created_at)` 两列版升级                                    |
| `execution_logs(session_id, started_at)`           | 会话级日志查询、恢复路径       | 该表当前零二级索引；列名 `started_at`（2026-09-17 笔误勘正，原写 created_at） |
| `execution_logs(status)` 或 `(session_id, status)` | running 计数（重启判据主查询） | **对照实际 SQL 定形**：查询总带 session_id 则用复合，定形依据写进提交说明     |

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

## 票 2 审查回执（2026-09-17，吐槽猫 ✅ 可合并，两轮：6bd2c19 → 修正 a2cde1a）

**被审 commit**：`a2cde1a`（修正轮合并提交，取代首轮 `6bd2c19`；首轮被点是重复实现 fix-forward——票 1 裁决二修订后票面收窄，flash猫 让位删净重投）。

**店长独立抽核（不盲信回执）**：

- 拓扑：`dev`（`5bcf8e7`）是 `a2cde1a` 祖先 ✅；diff 面 4 文件（migrations.ts / index.ts / migrations.test.ts / tickets.md），无票外物体 ✅；
- 基线区段零字节改动：Node 复算 dev 与 `a2cde1a` 的 `BASELINE_MIGRATIONS`→`APPENDED_MIGRATIONS` 切片 sha256 一致（`c483788f1d1e`）✅；
- 追加区终态 4 条（ds猫 `694a859` 的 fix-forward 原文零改动 + 3 条索引），fix-forward 让位残留 0 ✅；
- 索引列名按实际代码落 `started_at`——spec §3.2 / 本票单契约表格原写 `created_at` 系笔误（该表无此列，按字面建会拒启），**店长已勘正两文档**。

**审查者要点采信**：测试口径换算（47→49）未降强度，权威判据钉在「空 initDb 净增穷举 = 恰 2 条索引」用例；同名升级 `idx_messages_session` 单列判据；eval/socketio 平局判据修正是「错开秒/显式 created_at」非删断言，同秒平局行为用留痕用例钉住；EXPLAIN 验收测试化且静态断言钉生产 SQL 同句；老库双形态用例（无台账 / 票 1 补登形态 = 主库真实升级路径）；OQ4 两态 + 真空性反对照。独立复跑 16 文件 420 例全绿 + lint 3 包绿。

**遗留两项（均不阻塞，店长处置）**：

1. ~~spec §3.2 列名勘正~~——已随本回执落地（spec + 票单双勘正）；
2. **同秒平局判据（rowid→UUID 三候选）裁决：不另立单，随 B 范围 ⑤ 走**。理由：现行 `(created_at, id)` tie-break 与 messages 既有查询路径一致、新索引即按此三列建，且留痕用例已钉住现状行为；⑤-a/⑤-b 落地（毫秒精度 + helper 收口）后同秒平局概率近零，属同一改造的连带收敛；UUIDv7 翻案已录 spec（绑定换引擎决策点），不在本轮重复裁决。

**票 2 收口动作**：见店长收口汇报（合入 dev + flash猫 worktree 清理 + 重启判定）。

---

## 票 2 收口汇报（2026-09-17，店长）

- **文档复审**：`db49cee`（spec §3.2 列名勘正 `created_at`→`started_at`，纯文档 1 文件 5 行，与 session 分支 `aee7821` 同文经吐槽猫 Node 字节级核验）✅ 可合并。
- **独立核现场**：工作树干净、`db49cee` 为 closeout 分支尖、全 sha `db49ceea1083cfee30f0c181f275d62a608e908d`、diff 面恰 1 文件纯文档（与回执一致）。
- **收口链**：`.push-gate` 置全 sha → 推 `closeout/db-indexes-t2` → PR [#111](https://github.com/JianHun101/catStudio/pull/111)（base=dev）→ GitHub merge `7e5478b` → 本地 dev ff 同步 → **三方对齐：dev = origin/dev = .push-gate = `7e5478b`**。
- **清理**：主仓库切回 dev；closeout 分支本地+远端已删（refspec 删 + ls-remote 复核）；ds猫 / flash猫 worktree 已清（工作树干净、无未合入提交——ds猫 分支两笔 docs 提交与 session 分支同尖、无遗失；flash猫 `a2cde1a` 已入 dev；会话无远端分支）。剩余本会话 worktree：会话本体 + 吐槽猫（审查侧，留待 B 范围）。
- **重启判定：不发**。新索引 / OQ4 播报 / 补建迁移只在下次启动 initDb 时生效，运行中实例不受影响（判定看运行实例而非改动面）。**下次 server 重启时一并激活：票 1 迁移闸 + 主库 14 件缺失物体自动补建 + 票 2 索引三条。**
- **下一步**：B 范围（④ FK/CHECK、⑤ 时间口径、⑥ 拆表）按 A 范围决策「票缓拆」——待 server 重启后 P0 实机验证（迁移闸首启 + 主库补建播报 + EXPLAIN 无 SCAN 抽查）通过，再拆 B 票。验证清单已备，重启后可直接执行。

---

# B 范围票单（2026-09-17 拆，P0 实机验证 ✅ 后）

> 定稿决策全部在 spec §4，票面只钉执行面。**流程新规则（本轮起）**：实施猫的回执/交接**不进本票单**（防 review-view 快照带进分歧连停审查链——见 09-17 吐槽猫连停 4 轮事件）——报告与回执走投递正文/commit message，票单权威状态由店长统一写。
> 并行策略：票 3（只读审计）与票 4（helper）**无互赖，同时开工**；票 5–8 等票 3 报告出来、用户拍板孤儿处置后再派。

## 票 3 · 存量审计（只读报告，派 ds猫，无 worktree）

### 交付物

两份只读审计报告（**主库** `packages/server/data/cat-study.db` + **dev 库** `cat-study-dev.db`，两个库都要出数），投递正文回架，由店长落票单。

- **面 A · 孤儿审计**（spec §4.1 前置）：对每条候选 FK 关系跑「子表 LEFT JOIN 父表 WHERE 父 IS NULL」，输出：关系名、库、孤儿行数、样本前 5 行（关键列）。
  候选链（spec §4.1）：`messages.agent_id→agents`、`review_verdicts` 各引用（逐列查 DDL 定）、`connector_bindings.session_id→sessions`、`episodes` 各引用、`flow_states.session_id`、`flow_state_events.session_id`；已有 FK 的链（messages→sessions、execution_logs 两链、session_read_state）抽样验证即可。
- **面 B · 时间格式分布**（spec §4.2 前置）：全库每张表每个时间列实测格式分布（秒级 UTC `YYYY-MM-DD HH:MM:SS` vs ISO 毫秒 `...T...Z`），输出：表.列、格式 → 行数分布、异常样本。含 `messages.created_at` 同秒多行的密度（⑤ 改造面大小评估）。

### 纪律

- **只读铁律**：两库一律 `new Database(path, { readonly: true, fileMustExist: true })`（better-sqlite3 只读模式），库文件绝对路径、绝不可写；不写任何代码进仓库、不动 worktree。
- 报告可重复跑：SQL 留进投递正文，店长复核可直接重放。

### 验收

报告覆盖 spec §4.1 全部候选链 + §4.2 全部时间列，无「假设」式结论——每个数字都有 SQL 可复算。店长复核重放抽样一致即过。

### 完成记录（2026-09-17，✅ 报告已投递，待拍板项 D1–D4）

店长对账：dev 库 messages 2486（报告 2485，+1 = 审计后活流量新行）、execution_logs 1392（+1 = 本消息派发的 running 行）、sessions 30 ✅——三处一致，报告可信。

**面 A 要点**：核心资产（messages.agent_id、agents、sessions 本体）**零孤儿**。孤儿大头全是「会话/消息被删后的连带残渣」，且父行**两库皆无**（非分叉，是真删除）：episodes 系 3 链（main 249/201/249 行，占 23–29%；dev 203/196/203）、dev `spans.session_id` 480 行（仅涉 1 个父 id）、dev `retrieval_events.session_id` 53、flow 系 41、dev `review_verdicts` message/session 各 26、`review_parse_failures.message_id` 20、dev `episode_attributions.delivery_message_id` 23、dev execution_logs 两列 11/14、`sessions.summary_msg_id` ≤5。
**面 B 要点**：待转换面 = main 16 列 / dev 19 列（全 `YYYY-MM-DD HH:MM:SS`）；`spans.start_at`、dev `retrieval_events.created_at`、台账 `applied_at` 已 ISO 毫秒（不转）；messages 同秒密度仅 ~1.5%。

**三个计划外发现**：

1. **两库 messages 列序不同**（第 7/8 位 `task_id`/`created_at` 互换，老库 ALTER 追加列产物）→ 票 4 helper 硬约束见该票 addendum；
2. **`review_verdicts.subject_agent_id` 写猫名非 id**（main 6 行 / dev 4 行，可按 `agents.name` 唯一解析还原；写入口 `verdict-parser.ts:50` 注释自称外键语义与实现不符）→ 票 6 重建前需 name→id 归一迁移（D3）；
3. **只读审计的 WAL 边车副作用**：主库被只读连接生成 `cat-study.db-shm`(32KB) + `cat-study.db-wal`(0 字节)，清理被权限拒、未重试；数据文件 mtime 未变，无害（D4）。

**CHECK 值域读数**（票 5/6 定枚举用）：`messages.role` 三值闭合；`dispatch_state` 含 `running` 中间态 + 大量 NULL（main 746 / dev 1156——SQLite CHECK 对 NULL 放行，语义成立）；`execution_logs.status` 含 `running`（dev 有 2 行 running 脏存量，票 6 处置）；`flow_state_events.to_state` 四值；dev `review_verdicts.verdict` 含 `comment`（widen 成果，归基线集）。

**D1–D4 已拍板（2026-09-17，用户「按建议走」）**：D1 孤儿处置 = **删除**——票 5/6/8 重建迁移逐链带 DELETE，审计 SQL 留痕可复算；D2 九条同族链 = **全部纳 FK**（八条随票 6 逐表清单按需补重建条目，`sessions.summary_msg_id` 随票 8；agent_id 两链零孤儿纯防御）；D3 subject_agent_id 归一 = **并入票 6**（该票约束面③）；D4 WAL 边车 = **不清理**（0 字节，server 停着时想清手删）。票 8 另有悬空成员引用 4 条（main 2 会话指向 dev 猫 id，按 name 归一）随票 8 处置。

---

## 票 4 · rebuildTable 通用 helper（派 flash猫，走 worktree，与票 3 并行）

### 交付物

`packages/server/src/db/rebuild.ts`（+ co-located `rebuild.test.ts`）：通用表重建 helper，B 范围重建批的公共工具（spec §4.4 纪律 2）。

### 契约

- 形状：`rebuildTable(db, { table, createSql, columnMap?, } )`——读 `sqlite_master` 当前形状，单事务执行：建新表 → 按 columnMap 拷数据（缺省同名映射；类型/格式变更显式给转换表达式——时间列秒级→ISO 转换表达式是头号用例）→ 校验行数一致 → 删旧表 → 改名 → 按 createSql 重建索引/约束。
- **行数一致是硬校验**：拷贝前后计数不符 → ROLLBACK + 抛错，不留半成品。
- 通用、**不带任何真实表形状**——各表 DDL 在各自重建票里定，helper 只提供机制。

### 契约补充（2026-09-17，票 3 发现①，实施中途追加，属验收的一部分）

两库 `messages` **列序不同**（main：`…created_at,task_id…`；dev：`…task_id,created_at…`，第 7/8 位互换——老库 ALTER 追加列的历史产物；14 列同名同类型）。结论：

- helper 拷贝**必须按列名显式映射，禁 `SELECT *` / 位置对齐**——位置对齐在两库间会**静默错列**，而行数校验查不出来（行数一致）。
- 建议机制：helper 从 `PRAGMA table_info` 双侧取列名，显式构造 `INSERT INTO new (cols…) SELECT cols… FROM old`；新旧列名交集外的列（旧表有而新表删的列，如票 8 的 `agent_ids`）→ 显式声明丢弃，否则抛错，**不许静默丢数据**。
- 测试加**双列序用例**：故意以乱序列序建旧表，断言数据按列名落对列。

### 边界

不跑真实迁移、不动 `migrations.ts` 数组（B 重建票才 append）、不动 repository 层、不引入新依赖。

### 验收

`:memory:` 往返：建旧形表 → 插数据 → rebuild（含一次时间列转换 + 一次列改名映射）→ 断言数据原样/格式已转/新约束生效；行数校验注入失败 → 回滚、旧表原样。既有测试全绿。

### 流程

worktree（从 dev `7e5478b` 建分支 `session/54c4de25-flash猫`）；`node node_modules/vitest/vitest.mjs run` 跑测试（pnpm test 会被 junction 拒）；quality-gate → request-review 投吐槽猫；不自行合并、不 push。

### 完成记录（2026-09-17，✅ 复审可合并 → 店长收口）

**实现两笔**：`9f050d3`（helper 本体）+ `2b357ca`（契约补充：丢列须 `allowDroppedColumns` 显式点名否则抛错、通配守卫只锚 convert 唯一入口、双列序用例）；分支尖 `f167351` = `2b357ca` × dev `39cc4b4`（合并拆审查链结构性墙——根因是 dev 基线携带票 2 时代旧票单，仲裁裁 B：店长在 dev 落 `39cc4b4` 同步权威票单）。

**复审（吐槽猫，`ca576c9` review-view）**：净差异恰 2 文件 +870/−0（`repository/` 与 docs 零骑入）；135 文件 / 2726 用例独立复跑全绿 + lint 3 包绿。行序用例判别力经审查者亲手复测成立（无 `ORDER BY rowid` 时连 TEXT PK 的 autoindex 都会顶掉插入序）。**✅可合并**。

**OQ 裁决（随收口落盘）**：

| OQ                                                 | 裁决                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ1 allowDroppedColumns 是静默后门？               | **否**——须逐列点名 + `report.droppedColumns` 留痕 + 用例钉放行路径                                                                                                                                                                                                                    |
| OQ2 FK 体检只查出向 → 重建动被引用列时子表悬空不拦 | **限制成立，不入 helper**（全库体检归属审计面）——**票 8 验收硬条款：重建后全库 `PRAGMA foreign_key_check` 零违规**（已落 spec §4.4 纪律 6，各重建票同执行）                                                                                                                           |
| OQ3 rowid 隐性依赖                                 | **复审新发现比实施自查深**：`chunks` 双重耦合——`chunks_fts.rowid = chunks.rowid`（dev 375 行活 JOIN 零孤儿）+ vec0 `chunk_vectors_rowids` BLOB 内嵌。chunks 不在票 5/6 清单——审计若论证需动 chunks 投影先回架等专项设计（重建须同批重建 FTS 索引 + vec0 映射），已落 spec §4.4 纪律 5 |
| OQ4 守卫盲区（CHECK/UNIQUE 来自调用方 createSql）  | 真实但固有，P3 记录——缓解靠调用方比对两侧 `sqlite_master.sql`                                                                                                                                                                                                                         |
| OQ5 验收第 2 条替代                                | 满足本意：行数校验是防未来改动护栏，函数直测 + UNIQUE 撞数据端到端回滚两路都钉                                                                                                                                                                                                        |

**P3 观察项（不拦，留痕）**：① `convert` 里的标量子查询（如 `(SELECT * FROM other …)`）不在通配正则射程内——调用方显式表达式、作用域非旧表直拷，契约本意未破；② `CODING_STANDARDS.md` §7 幂等迁移与 spec §3.1 零吞咽的张力（flash猫 自曝）——归标准文档更新单。

---

## 票 5 · messages 重建（派 flash猫，走 worktree；blocked 已解除 2026-09-17）

一次重建合并全部变更（spec §4.2 铁律）：FK `agent_id→agents` RESTRICT、CHECK `dispatch_state`、created_at 秒级→ISO 毫秒、**连带切换**（spec §4.2 连带改造点）：`messages.ts:127` 游标比较逻辑与超时窗 `datetime('now', ?)` 同批切新格式——**格式混比会错序，不留半套**。时间列转换表达式用票 4 helper 的 columnMap 机制，拷贝按列名显式映射（票 4 契约，禁 `SELECT *`）。迁移以 append 身份进 `APPENDED_MIGRATIONS`。孤儿处置按 D1：messages 各链零孤儿（票 3 面 A），FK RESTRICT 直接落，无存量清理。

**约束面（随票 4 复审落盘）**：① 重建后全库 `PRAGMA foreign_key_check` 零违规（spec §4.4 纪律 6）；② 本票不动 chunks 系——若实施中发现必须动 chunks 投影，先回架（chunks ↔ FTS/vec0 rowid 耦合，spec §4.4 纪律 5）。

**CHECK 值域更正（2026-09-17，票 5 开工前真库读数）**：`dispatch_state` 真实值域 = `'queued' | 'running' | 'done'`（`repository/messages.ts` 类型签名；两库实测 `done` 1079/1342、`completed`/`failed` 零行）——本票面初稿 `completed/failed` 系笔误，照字面落 CHECK 会让 fire-and-forget 的 `setDispatchState` 静默失效。定稿 `CHECK (dispatch_state IN ('queued','running','done'))` + NULL 放行；spec §4.1 已同步更正。

**机制改动并入本票（2026-09-17 店长裁决，方案 A）**：票 5/6 开工前两猫独立发现 runner 恒包事务 × rebuildTable 拒事务内调用的接线缺口（ds猫 实测：三张表现状下要么拒启要么静默清 9723 行）。裁决 = spec §4.4 纪律 7 过程式通道：`Migration` 加可选 `run?: (db, record) => void`，带 `run` 条目 runner 不包事务；`sql` 仍必填 = 新表 DDL（checksum 正文 + `createSql` 源）；静态断言钉「hook 只许调 rebuildTable 且 `createSql === m.sql`」。**本票负责把该机制落地**（`migrations.ts` 接口 + `index.ts` runner 分支 + 测试），票 6 批二与票 8 只做消费方。

**收口（2026-09-18，店长）**：交付 `95e4d4c` + `326e958`（22 文件 +798/−89，全在 `packages/server/src`），复审 **✅可合并**（吐槽猫独立复核：全量 2754 复跑绿 + lint 3 包过 + 行号抽核全真 + 静态断言绕过构造三连未破 + 族修补刀——「第四处跨形态比较点」挑战**扫完无漏网**，生产代码比较点全集 9 处逐一核清）。随收口四件落盘：① spec §4.2 ⑤-c DEFAULT 勘注（OQ1 有条件接受——判据是精度降档，`strftime('%f')` 已消解）；② spec §4.4 已知窗口留痕（OQ3 接受「已知窗 + 重跑幂等自愈」，危害有界）；③ OQ4 留痕——未来某票需求面变化时可补「双路径形态一致（新库产物 == 老库升级产物）」表征，不阻塞本票；④ P3 观察项三条（下轮票面参考）：`review_verdicts` 归一迁移的 `replace(created_at,' ','T')` 无 `Z` 后缀（该表本身秒级，非回归）——**票 6 迁该表时与 `toIsoDb` 合并回单口径**，勿留永久双口径；`sessions.ts:308` `toSessionConfig` 的秒级形态转换（未迁，正确现状）——**票 8 迁 sessions 同批切**；`messages.ts:68-70` 注释「SQLite datetime 是秒级精度」已随本票过时（逻辑本身仍对）——下批碰 messages 顺手改。OQ5 台账名接受（全角字符在 TEXT 主键无解析面风险；**落地后不可改名**）；OQ6 时区偏移透传不补（函数职责 = 统一形态非时区换算，生产面无实证调用方）。

## 票 6 · 小表重建批（派 ds猫，走 worktree；blocked 已解除 2026-09-17）

**审查链插曲（2026-09-17，店长仲裁）**：批一交付 `dce2bc9` 后审查 prep 撞合并墙未开审——根因是审查分支的 review-view 快照陈旧（不含 `c9c61f4`），与票 4 的墙同型不同根（上次长在实施侧基线，这次长在审查侧快照）。店长已在吐槽猫分支落仲裁笔 `3c5815b`（票单整文件取 session 权威版），实测 flash 分支合入 0 冲突；**但 ds猫 分支合入仍卡 3 处代码冲突**（`migrations.ts` / `migrations.test.ts` / `eval/chain-verdicts.ts`，票 5 代码与批一同改追加区所致）。**返工指令（先于一切）**：ds猫 在自家 worktree merge dev `c9c61f4` → 按「票 5 侧已审权威、批一新增全保留」解三处冲突 → 全量测试复跑 → 以新尖重投吐槽猫审查（ref 换 new tip，旧 ref `dce2bc9` 废弃）。语义拿不准的冲突点回架，不硬解。

execution_logs / flow_states / flow_state_events / connector_bindings / episodes 系 / review_verdicts 的重建：**逐表先审计留痕**（现有 FK/CHECK/时间列实测 vs spec §4.1 缺口清单——**含 D2 九条同族链**，一张表一份结论），时间口径全转 ISO（`spans.start_at`、dev `retrieval_events.created_at`、台账 `applied_at` 已 ISO 不转，按票 3 面 B 实测），FK/CHECK 按审计定稿补。清单以审计报告为准，票开时逐表列；九链中未列入重建的表按需补重建条目。

**D1/D3 落盘（2026-09-17 拍板）**：D1 孤儿 = 删除——逐链 DELETE 进各自重建迁移，数字与样本见票 3 面 A，审计 SQL 留痕可复算；D3 `review_verdicts.subject_agent_id` 猫名→id 归一迁移（main 6 行 + dev 4 行按 `agents.name` 解析）必须先于此表 FK 重建落地。**D3 范围勘正（ds猫 逐行复核）**：写入口不改——写入路径取 `subject.id`、调用方 `serial.ts` 的 `reviewedTargets` 也取 `a.id`，注释与实现一致，库中猫名是修复前历史行；D3 = 纯数据归一。dev `execution_logs.status` 的 2 行 running 脏存量（重启卡死的 in-flight 残骸）按改判 `failed` 处置，理由留痕进逐表审计。

**拆两批（2026-09-17 店长裁决，方案 A 配套）**：批一（不依赖机制改动，现在开工）= **7 张纯 SQL 表**——execution_logs / flow_states / flow_state_events / connector_bindings / episode_attributions / review_verdicts / review_parse_failures 的重建 + 各自 D1 孤儿 DELETE + D3 归一迁移 + running 脏存量改判。批二（票 5 机制合入 dev 后追加）= **3 张过程式重建**——episodes（子表 episode_attributions 挡 DROP）、retrieval_events（CASCADE 子表，静默清空风险实测）、spans（自引用 + CASCADE 子表），按 spec §4.4 纪律 7 走 `run` 通道消费 rebuildTable。**审计结论照准**：flow_states/flow_state_events 不加 CHECK（`isOnMainChain()` 证明值域非封闭，与 spec「封闭枚举才 CHECK」判据一致）；episodes `task_id`/`chain_task_id` 不加 FK（链锚非唯一列，物理不可行）。顺序无关性：批一先合会带上 FK→messages，但票 5 的 messages 重建走 FK-OFF 通道，无顺序炸弹（纪律 7 裁决的附带效果）。

**约束面（随票 4 复审落盘）**：① 重建后全库 `PRAGMA foreign_key_check` 零违规（spec §4.4 纪律 6）；② 本票清单不含 chunks 系——逐表审计若论证需动 chunks 投影，先回架等专项设计（FTS/vec0 rowid 耦合须同批重建，spec §4.4 纪律 5）；③ `review_verdicts.subject_agent_id` 猫名→id 归一迁移（票 3 发现②，D3）必须先于此表 FK 重建落地。

**审查回执（2026-09-18，吐槽猫 ⚠️ 建议修改 —— 墙拆后首轮实审）**：批一 `20b2cfb`（41 文件 +1779/−251）大部分面独立核过并采信：8 条纯 SQL 条目逐条核清（RESTRICT/CHECK 封闭枚举判据/时间列去 DEFAULT 走 `toIsoMs`/D1 孤儿 DELETE/D3 归一用 COALESCE 解析不到**原样保留**让 FK 响亮拒启/running 脏存量改判带 `error_type='server_restart'` 单独桶）；「批一走纯 SQL 而非 `run` 通道」的接线论证成立（7 张叶子表无子表引用，纪律 7 的 `run` 留给批二）；`finalizeExecutionLog` 加 sessionId 维度是真修复（毫秒可辨后旧「agent + 最新 running」跨会话并行会写错行）；dispatch 用例竞态修复正确；族修抽核 5 处全实况；纪律 6 硬验收双路（老库升级 + 新库）有测试兜底；店长仲裁的 `T6_END` 上界修复在位且注释如实。

**⚠️ 必修（P2 一处）——`nowIso()` 双真相源**：`repository/time.ts:36`（票 5，「记录时间生成点」）与 `repository/clock.ts:19`（票 6，「记录时间的**唯一生成点**」）各有一份实现逐字相同的 `new Date().toISOString()`。今天零行为分歧，但：① spec §4.2 ⑤-c 契约措辞就是「由 repository 层**统一 helper** 生成」——两个「唯一生成器」并存本身违反该已定稿契约；② 消费面已分叉（`clock.js` 4 个 repository + eval 侧；`time.js` 服务 messages），票 8 迁 sessions 时「顺手选错」全看运气；③ 正是纪律 7 要消灭的「平行真相源」形态，只是落在 helper 层。**修法**：`clock.ts` 的 `nowIso` 改为 re-export `time.ts` 的（**方向判据：动未审文件**——`time.ts` 是票 5 已收口进 dev 的已审面，改它会把票 6 的 diff 骑进已审代码；`clock.ts` 是票 6 自己的新文件，动它零额外成本），两文件合并后只留一个生成点。

**P3 观察（随本轮回工顺手改，不改不拦但成本极低）**：① `clock.ts` 头注「⑤-b 起**全库**时间列已是 ISO 毫秒」与同文件下一段「sessions / agents 等仍是秒级」自相矛盾——前句改「⑤-b **目标**口径」（「复述文本未经实测就上生产注释」的轻微复发，清单本身经测属实，是总起句写宽了）；② `clock.ts::normalizeIsoMs` 与 `time.ts::toIsoDb` 职责相近——**留票 8 收口时一并审**「要不要合并回单口径」，勿留永久双 helper（本票只在票单留痕，不改代码）。

**返工指令（第二轮，2026-09-18 店长）**：① **先对齐基线**——worktree 内 `git merge dev`（dev 尖 = `15a2efa`，已含票 7）；**预期撞追加区与测试切片，这是已知墙不是新问题**——票 7 已进 dev，与批一的 `migrations.ts` 追加区 + `migrations.test.ts` 的 `T6_START/T6_NAMES` 切片叠加，解法定型**已在店长仲裁笔 `734d302` 上验证过并落票单**：追加区**双保留、按票号序**（票1→票2→票5→票6→票7），测试切片补上界 `T6_END`（锚票 7 首条）——**照抄该定型，不重新发明**；`APPENDED_NET_OBJECTS` 等「落在自动合并区」的常数**必须亲手核**（git 不报冲突 ≠ 值对，跑测试才露）。② 修 P2（`nowIso` re-export）+ 顺手 P3-1 头注。③ 全量测试 + lint 复跑。④ 以**新尖**重投吐槽猫（ref 换 new tip，旧 ref `20b2cfb` 废弃）；交接文档按「fix-forward 一小笔」写，不必重述全部。语义拿不准的冲突点回架，不硬解。

**合并态解法定型（2026-09-18，店长仲裁 `734d302`，供后续所有「票 6 × 票 7 并存」场景复用）**：① `migrations.ts` 追加区——双保留、按票号序；② 头注计数与清单同步（十五条 = 票1 修1 + 票2 三 + 票5 一 + 票6 八 + 票7 二）；③ `migrations.test.ts`——取 `BASELINE_SHAPE_DIVERGENCE` 白名单机制（比内联 `continue` 判据强：表真丢了也不会假绿），补 `table:sessions`（票 7 的 `ADD COLUMN` 会改 sessions 建表原文，白名单必须收它）；④ **语义冲突（git 不报、只有跑测试才露）**：`T6_NAMES = MIGRATIONS.slice(T6_START)` 切到数组末尾——票 7 接在后面就多出 2 条，断言红；补上界 `T6_END`（锚票 7 首条）。这一型是本活第三次拆墙的产物，**第四型根因（追加区共享追加点）**，根治单（`worktree-fanin` prep 对 `docs/run/**` 免合并 + 追加区结构改造）留待 B 范围收口后立票。

**收口（2026-09-18，店长）**：交付 `0cc6b72`（返工轮，47 行：`clock.ts` 改纯 re-export + 特征化测试钉住与 `toIsoDb` 的识别面分歧），复审 **✅可合并**（吐槽猫：nowIso 单实现独立复核——全分支 `function|const nowIso` 仅 `time.ts:36` 一处；批一四表写口同口径；重建 DDL 零时间 DEFAULT；server 2026 用例 + web 438 用例实测全绿）。合入 dev：ff-only `15a2efa..0cc6b72` → PR **#112** 合并 → 尖 `d0c7c35`，被审 sha 未被 rebase 改写（仍是 dev 祖先）。

**店长收口补验（票面「需新环境才验」的硬条款，`:memory:` 单测覆盖不到）**：在**真库副本**上预演了重启后实际会跑的迁移路径（`VACUUM INTO` 副本 → `applyMigrations`），dev 库与 main 库（老库补登 ②-b 路径）**两条都过**：

| 判据                              | dev 库（带台账，46 条）           | main 库（无台账，②-b 补登 41 条） |
| --------------------------------- | --------------------------------- | --------------------------------- |
| `applyMigrations` 抛错            | null                              | null                              |
| 全库 `PRAGMA foreign_key_check`   | 0 → 0（此前无 FK 声明，0 是空真） | 0 → 0                             |
| D3 猫名残留 → 0                   | 4 → 0                             | 6 → 0                             |
| `execution_logs.status='running'` | 1 → 0                             | 0 → 0                             |
| messages / sessions 行数          | 2561/31 **不变**                  | 1825/23 **不变**                  |
| 追加区真执行 / 台账               | 10 条 / 46→56                     | 15 条 / 0→56                      |
| 幂等复跑（第二次）                | **真执行 0 条**，数据面无变化     | —                                 |

D1 孤儿删除量级（与票 3 审计面一致）：execution_logs 1440→1417、flow_states 219→208、flow_state_events 415→385、episode_attributions 82→59、review_verdicts 130→104、review_parse_failures 53→33；`connector_bindings` 1→1 无损。**P3 一条**（吐槽猫）：`isoDaysAgo(days, from = Date.now())` 默认参数与 `nowIso()` 是两个取时点，跨毫秒边界可致同写路径内「ended_at 早于 started_at 一毫秒」；窗口比较场景无实害，留观察。

---

## 收口后待裁（2026-09-18，店长提案，**等用户拍板**）

**① 解冲突结果必须回流实施分支**（纪律，改动成本 ≈ 0）：审查分支不得承载独有编辑，永远是纯内容快照。墙#3 之所以循环，根因是「谁解冲突」与「谁承载内容」是两条分支——每解一次就制造一份「只有审查分支有」的文本，供下次对撞。

**② 消灭追加区的争用热点**（结构改造，建议排票 6 批二之后）：给每条迁移加 `ticket` 字段，测试改用 `MIGRATIONS.filter(m => m.ticket === 'T6')` 取代 `T6_START`/`T6_END` 下标锚点；同时删掉头注里「当前挂着十五条」这类**每次追加都要改的计数**（数量已被 `toHaveLength` 断言钉死，纯冗余）。**下标锚点本身就是墙#2/#3 的结构性来源**——两票并行时各加各的条目，不再抢同一片注释。

sessions `ADD COLUMN archived_at TEXT`（NULL=活跃）+ 部分索引 `WHERE archived_at IS NULL` + repository 读写 + API + 前端最小入口（归档操作 + 「显示已归档」开关）。**验收（spec §4.1）**：归档后数据全在、列表默认过滤、**归档会话照常可被记忆检索**。

**收口（2026-09-18，店长）**：交付 `15a2efa`（16 文件 +894/−42），复审 **✅可合并**（吐槽猫独立复核：全量 137 文件 2812 用例复跑绿 + lint 3 包过）。四条验收全过：归档后数据全留 / 列表默认过滤 + 开关 / **归档不动记忆检索**（源码断言 + 行为测试双证）/ 部分索引计划可见（`SCAN sessions USING INDEX idx_sessions_active`）。**OQ1 裁决不退票**：前端 🗑️ 物理删除入口被归档按钮**取代**是用户故事 7 的产品形态（「删除」的唯一用户态形态 = 归档），后端 `DELETE /api/sessions/:id` 未动，RESTRICT/409 契约归票 8。**OQ2 裁决接受并记为第三类失败形态**：`ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS` ⇒ 「状态已正确但未登记」会永久拒启，加挂 `verify` 探针把该路径收敛为「跳过 + 登记」，与既有探针同一把尺子（`migrations.ts` 头注已如实改写）。已合入 dev（ff-only `c9c61f4..15a2efa`），三方对齐 `15a2efa`。P3 两条（`routes/sessions.ts` includeArchived 解析的 `raw !== false` 永假分支；`onDelete` 内联）无必改项，留档。

## 票 8 · session_agents 拆表 + sessions 重建（blocked by 票 3 + 票 4 + 票 7）

内部顺序（spec §4.3，不能反）：① 建 `session_agents` + 解析 JSON 灌入（数组下标→position，悬空引用按拍板处置）；② **sessions 一次重建**：时间口径 + 删 `agent_ids` 列 + **保留票 7 的 archived_at** + 约束；③ 读取路径全改走新表（对外 API 形状不变，`agentIds` 按 position 组装）；④ 隐藏行为保留：成员变更仍 touch `sessions.updated_at`（验收项）；⑤ 删 session → CASCADE 成员行；删 agent → RESTRICT + **409 契约**：repository 先查后删、命中抛领域错误带会话清单、API 409 + 结构化错误体（spec §4.1 行为契约）。

**验收硬条款（随票 4 复审落盘）**：收尾全库 `PRAGMA foreign_key_check` 零违规（spec §4.4 纪律 6——sessions 是被引用大父表，重建后体检是防子表悬空的唯一兜）。

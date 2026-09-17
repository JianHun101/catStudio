# 票：数据库结构治理 P0（迁移机制立闸 + 索引三条）

> **状态：P0 双票已收口（dev `7e5478b`，重启后实机验证 ✅：台账 45 行、追加区 4 条真执行、EXPLAIN 三路径全 SEARCH）。B 范围票 3–8 已拆（2026-09-17 用户拍板「现在拆」），票 3（ds猫）/ 票 4（flash猫）已并行派出。**
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

**待拍板**：D1 孤儿处置（店长建议默认删除，依据充分）/ D2 spec 未点名同族链（A-3 九条）是否纳入 FK / D3 subject_agent_id 归一（建议并入票 6）/ D4 WAL 边车（建议不清理）。D1–D2 拍板后派票 5/6；票 8 另有悬空成员引用 4 条（main 2 会话指向 dev 猫 id，建议按 name 归一）随票 8 处置。

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

---

## 票 5 · messages 重建（blocked by 票 3 拍板 + 票 4）

一次重建合并全部变更（spec §4.2 铁律）：FK `agent_id→agents` RESTRICT、CHECK `dispatch_state`、created_at 秒级→ISO 毫秒、**连带切换**（spec §4.2 连带改造点）：`messages.ts:127` 游标比较逻辑与超时窗 `datetime('now', ?)` 同批切新格式——**格式混比会错序，不留半套**。时间列转换表达式用票 4 helper 的 columnMap 机制。孤儿 messages 按票 3 报告 + 用户拍板处置。

## 票 6 · 小表重建批（blocked by 票 3 + 票 4）

execution_logs / flow_states / flow_state_events / connector_bindings / episodes 系 / review_verdicts 的重建：**逐表先审计留痕**（现有 FK/CHECK/时间列实测 vs spec §4.1 缺口清单，一张表一份结论），时间口径全转 ISO，FK/CHECK 按审计定稿补。清单以审计报告为准，票开时逐表列。

## 票 7 · 归档（轻量 ALTER，可与票 5/6 并行，blocked by 无）

sessions `ADD COLUMN archived_at TEXT`（NULL=活跃）+ 部分索引 `WHERE archived_at IS NULL` + repository 读写 + API + 前端最小入口（归档操作 + 「显示已归档」开关）。**验收（spec §4.1）**：归档后数据全在、列表默认过滤、**归档会话照常可被记忆检索**。

## 票 8 · session_agents 拆表 + sessions 重建（blocked by 票 3 + 票 4 + 票 7）

内部顺序（spec §4.3，不能反）：① 建 `session_agents` + 解析 JSON 灌入（数组下标→position，悬空引用按拍板处置）；② **sessions 一次重建**：时间口径 + 删 `agent_ids` 列 + **保留票 7 的 archived_at** + 约束；③ 读取路径全改走新表（对外 API 形状不变，`agentIds` 按 position 组装）；④ 隐藏行为保留：成员变更仍 touch `sessions.updated_at`（验收项）；⑤ 删 session → CASCADE 成员行；删 agent → RESTRICT + **409 契约**：repository 先查后删、命中抛领域错误带会话清单、API 409 + 结构化错误体（spec §4.1 行为契约）。

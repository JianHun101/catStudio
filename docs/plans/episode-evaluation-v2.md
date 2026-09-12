---
type: plan
date: 2026-08-11
status: 已定稿
evidence:
  - kind: commit
    ref: 8352116
  - kind: commit
    ref: a0ade7d
---

# v2 episode 评估设计（评任务结局）

> 状态：已定稿 ✅（2026-08-11 第九轮复核通过，G5/N8/N9 修正到位）。已合并 main=dev=8352116；E1 判定引擎已实施（a0ade7d，25 测试全绿 + server 852 全绿），E2 归因分流 + E3 接线拆活进行中。
> 背景：v1 评单条回复（G-Eval 相关性/忠实度/完整性），评不出「回复好但任务结果差」。v2 改为评任务生命周期（episode）结局。

## 1. 锚定方案（已审定）

- **episode 锚点 = 根触发消息上溯链终点**：从触发执行链的最末 execution_log 沿 `trigger_message_id` 上溯，终点为 `role='user'` 的消息（用户原始提问，或交接消息 H）。
- **双根语义（P4，已审定）**：
  - **U 根**：用户原始任务消息（真实用户任务锚点）。
  - **H 根**：交接审查链根（A2A 交接文档投递链锚点）。
  - 两者都是合法 episode 根，各自独立成 episode；`root_triggered_by` 列区分。
- **辅助键**：`task_id`（U 根自身值，客户端传入，可为 NULL——ingest.ts:102 `taskId || null`）仅作 episode 归组辅助键，**不作结局判定的承重键**（覆盖率不足已降级）。结局判定的关联键是**执行链 trace_id 抄录的 chain_task_id**（锚定源钉死见 G2 第六轮：取 execution_logs.trace_id，不取 messages.task_id）。

## 2. 结局分类：7 类 + 判定优先级（含第四轮修正）

按优先级从上到下判定（同一 episode 链内）：

```
1. 存在 running 行（status='running' 的 execution_log）→ in_progress
   在途检测：EXISTS 一条 SQL（P3 修正已审定），closure 状态机不动作，skip。

2. 存在 completed 行 → 按 reject/suggest 时序判结局（关联键 chain_task_id，见 G2 第六轮）：
   - success ⟺ 同 chain_task_id 无「后序 reject/suggest」审查结论
   - corrected_success ⟺ 同 chain_task_id 存在 reject/suggest 且
     completed 行 created_at > 最近一次 reject/suggest 的 created_at
     （N1 明写：比较对象 = 最近一次 reject/suggest 审查时间，打回后重做完成）
   - completed 之后仍有 reject/suggest（完成又被打回）→ needs_investigation

3. 无 completed 行 且 存在非重启失败行
   （failed 且 COALESCE(error_type,'unknown') != 'server_restart'）→ needs_investigation /
   harness_fix_needed（按 error_type 归因；routing_failure 特殊：同 triggered_by
   全部执行行均失败，路由整体失败）

4. 无 completed 行 且 无非重启失败行 且
   （存在 failed(COALESCE(error_type,'unknown')='server_restart') 行 或 卡态超 30min 无任何执行行）
   → abandoned
   零执行分支的 episode 产生路径见 G2-N5（第六轮）：无 execution_log 可锚定，
   chain_task_id = NULL，abandoned 判定不依赖 verdict 关联，逻辑自洽。

> N3 口径（第五轮修）：error_type 裸比较遇 NULL 存量行（pre-migration failed 行）
> SQL 中 `NULL != 'server_restart'` 为假 → 既不算非重启失败也不算重启失败 → 落
> unclassified。改用 COALESCE 对齐 L1 既有契约（l1-aggregator.ts:80
> `COALESCE(error_type, 'unknown') != 'server_restart'`）：NULL 存量行 → 'unknown'
> → 属非重启失败 → 走判定 3 needs_investigation，不再落 unclassified。

5. 其他 → unclassified
```

### G1 修正：abandoned 判定补守卫（第四轮）

**修正前**（P3 半成品）：`无 running 行 且（存在 failed(error_type='server_restart') 行 或 卡态超 30min）→ abandoned`

**修正后**：`无 running 行 且 无 completed 行 且 无非重启失败行 且（存在 failed(error_type='server_restart') 行 或 卡态超 30min）→ abandoned`

- **反例场景**：重启打断首跑 → fixStuck 标 `failed/server_restart`（executionLogs.ts:237，双写 error_message + error_type）→ 恢复重跑成功插 `completed` 新行（dispatch/index.ts:181 恢复路径 insertExecutionLog）。修正前「存在 failed(server_restart)」即判 abandoned，**办成的任务误判放弃**。
- **正确语义来源**：镜像 socketio.ts:1512 恢复机制的「仅 server_restart 记录」判据（`serverRestartLogs` 只筛 `failed && error_message === 'server_restart'` 且不混入其他状态行）。
- **N2 覆盖**：`[failed(server_restart), failed(timeout)]` 混合失败因含非重启失败行（timeout），走判定 3 归因，不再被「存在 server_restart」吸进 abandoned——守卫自然覆盖，无需额外规则。

### G2 拍板（第五轮重写）：U 根 episode 的 success 跨链范围——执行链 task_id 关联

**拍板（计数归属不变，第四轮已定）：U 根参与 success 计数；success 计数唯一归属 U 根，H 根不双计。**

理由：

1. v2 核心指标是「真实用户任务办成率」，U 根是用户任务锚点。若 U 不参与 success 计数（方案 A），无审查链的日常任务（绝大多数）结局全落 unclassified，主指标口径塌。
2. 双计消除：**任务结局（success/corrected_success 等 7 类）只统计在 U 根 episode 上**；H 根（审查链）episode 只统计审查链元指标（verdict 分布、审查轮数、打回率），不参与任务结局计数。

**关联机制重写**（第四轮方案有洞，吐槽猫复核实锤：① review_verdicts 无 task_id 列（db/index.ts:242-249），「同 task_id」须经 join 且路径未写；② U 根 task_id 可为 NULL（ingest.ts:102 `taskId || null`），直接比 U 根 task_id 时 `task_id = NULL` 永不匹配 →「无后序 reject/suggest」恒真 → **被 reject 的任务误判 success**，正砸在 G2 想防的核心指标错误上。第六轮再修两个残留洞，见 G2-残留 A/B）：

- **关联键 = chain_task_id，锚定源钉死 = 链末 execution_log.trace_id（G2-残留 A 修）**：不取 messages.task_id——`messages.task_id` 与 `execution_logs.trace_id` 是两个值不同的列：用户自带 taskId 的链（如 `task-123`）链内消息 task_id = 用户值，而 E3 反查（commit_hash → execution_logs → trace_id）与审查链投递拿到的都是 trace_id。若从 messages.task_id 抄录 → JOIN `m.task_id = chain_task_id` 永不匹配 → 被 reject 的任务误判 success（G2-B 原 bug 复现）。**从 execution_logs.trace_id 抄录（insertExecutionLog 每行写 traceId，db/index.ts:113）与 E3 反查同源，两值必一致**。
- **episodes 表新增列 `chain_task_id TEXT`（允许 NULL，仅零执行场景，见 G2-N5）**：锚定时从链末 execution_log.trace_id 抄录。
- **G2-残留 B 修：持久化层接线小改（E3 项）**：socketio.ts:2297 agent 回复落库 `insertAgentMessage(..., triggerMsg.taskId || null, ...)` 改为 `|| traceId`（与瞬态层 1060 `taskId = triggerMsg.taskId || traceId` 同构，一行）。原因：1060 只出现在 A2A 递归派发的瞬态 agentTrigger 上，真正落库路径是 2297 且为 `|| null`（messages 表无 trace_id 列可兜底，db/index.ts:70-78）——第五轮「链内 agent 回复 100% 非空」依据有误。补 `|| traceId` 后：投递带 taskId → 审查回复落库 = 源链 trace_id，JOIN 匹配；投递缺失（老版本已知噪声）→ 落库 = 审查链自身 trace_id，仍关联不到任务链，噪声记录在案。

U 根 success 判定规格：

```
U 根 episode 结局 = success
  ⟺ 本链存在 completed 行
  且 同 chain_task_id 无「后序 reject/suggest」审查结论
「后序」定义：review_verdicts.created_at > U 根消息 created_at
（任务生命周期内的打回才算数；任务开始前的历史打回不计）

检查 SQL（经 messages join，review_verdicts 无需加列；N6 第六轮：加 session_id 限定防跨会话 task_id 复用泄漏）：
  SELECT v.verdict FROM review_verdicts v
  JOIN messages m ON m.id = v.message_id
  WHERE m.task_id = <chain_task_id>
    AND m.session_id = <episode.session_id>   -- N6：用户 taskId 跨会话复用时不泄漏 verdict
    AND v.created_at > <U 根 created_at>
    AND v.verdict IN ('reject','suggest')
  → 无行 = success；有行 = completed 晚于最近打回 → corrected_success；
    完成之后仍有打回 → needs_investigation
  chain_task_id 为 NULL（零执行 episode）时跳过本查询——abandoned 判定不依赖 verdict
```

> **G4 已知局限（第八轮明写）**：session 限定是双刃剑——跨会话审查（交接后新会话里 review 旧任务链，verdict 经 E3 payload 带同 chain_task_id）的 verdict 会被 session 过滤排除 →「无后序 reject/suggest」恒真 → 被 reject 的任务误判 success（G2 原 bug 在跨会话场景复现）。取舍：agent 互 @ 依赖会话成员，审查通常同会话、跨会话低频；而跨会话 task_id 复用泄漏是更高频脏数据——**保留 session 限定，明写局限：跨会话审查的 verdict 不参与 U episode 判定，统计口径显式声明该局限，记观察项**（待实际出现跨会话审查场景再评估放宽，不阻塞本期）。

**前置保证（E3 接线项，机制小改 ×2）**：审查请求 / 交接文档的投递消息必须携带源链 task_id——post-commit hook 投递 payload 加 `taskId`（经 commit_hash → execution_logs → trace_id 反查被提交消息的链 task_id，与 chain_task_id 锚定同源）、handoff-gen 投递同样携带。ingest 已支持 taskId 字段（ingest.ts:39 `taskId?: string`）；审查回复经 socketio.ts:1060 继承、落库经 socketio.ts:2297（E3 补 `|| traceId` 后）持久化，verdict 消息与任务链共享 task_id，JOIN 匹配成立。

- **缺失时的已知噪声（明写承重）**：投递未带 taskId（老版本行为）→ verdict 消息 task_id = 新 traceId，关联不到任务链 → 该 U episode 按「无后序打回」计 success，噪声记录在案（与 P5 承重假设同款显式声明）。
- **U/H 同任务共享 task_id 时的语义**：H 链 verdict 与 U 链 verdict 同属本任务审查结论，U 的检查看到全部审查结论——本应如此；H episode 不参与任务结局计数（计数归属不变），无双计。

approve（审查 ✅）与 U 判定的关系：approve 落地 = 无后序 reject/suggest（收口链语义，审查 ✅ 后自动收口不再打回）；有 reject/suggest 后补 completed 晚于打回 = corrected_success。两者覆盖「审查通过」的全部形态，U 端无需直接查 approve verdict。

### G2-N5：零执行 episode 的产生路径与 chain_task_id NULL 分支（第六轮拍板）

**冲突**：判定 4「无任何执行行 + 卡态超 30min」（落库未调度静默丢场景）无 execution_log 可上溯，`chain_task_id NOT NULL` 无法填充；episode 锚定路径（从最末 execution_log 上溯）本身依赖至少一条执行日志。

**拍板**：

- **chain_task_id 允许 NULL**，仅零执行场景可达。有执行行的 episode（判定 2/3 能到达的）必有 execution_log 且每行写 traceId → 抄录必非空；判定 4 的 abandoned 不依赖 verdict JOIN——NULL 分支与判定逻辑自洽，无二义。
- **零执行 episode 产生路径**（E1 实现）：周期性扫描 `messages` 中 `role='user'` 且 `created_at` 距今 > 30min、且无任何 `execution_log.triggered_by_message_id` 引用其 id 的消息 → 生成 episode（`chain_task_id=NULL`）。此路径独立于执行链上溯，专门兜「落库未调度」静默丢。
- **H 根判定（G3 第八轮修）**：零执行扫描命中消息一律标 `root_triggered_by='U'` 有洞——H 根（交接消息）也走 ingestUserMessage（routes/messages.ts:98）同为 role='user'，被静默丢的交接消息若生成 U 根 episode 判 abandoned，计入「真实用户任务办成率」旗舰指标失败 → **核心指标被假失败污染**（正是 16:09 / 02:24 同款静默丢缺口）。判定顺序：
  1. 命中消息 task_id 非 NULL 且已有 episode 的 chain_task_id = 该 task_id（交接延续：交接投递携带源链 task_id，E3 接线后与既有 episode 匹配）→ `root_triggered_by='H'`
  2. 命中消息带交接文档内容特征（N9 第九轮钉死 = handoff-gen 精确前缀 `@<猫名> 请补填以下交接文档`，buildHandoffMessage 唯一生成源 handoff-gen.mjs:765，e2e 断言形态 `@ds猫 请补填以下交接文档`；role='user' 的 H 根仅此一种来源——审查请求是 agent 回复非 user 消息、performHandoff 会话交接不插消息表；socketio.ts:1740 既有 `startsWith('@店长 请补填以下交接文档')` 先例）→ `root_triggered_by='H'`
  3. 无法区分（G5 第九轮修：task_id **为空或无匹配 episode** 且无内容特征）→ 记已知噪声（与存量空串 trace_id 同款显式声明），按 `root_triggered_by='U'` 生成，统计口径显式声明含该噪声
     - 原「task_id NULL」字面有洞：task_id 非 NULL 但无匹配 episode（用户带 task_id 新任务被静默丢）时判定 1 不成立（无匹配 episode）、判定 2 不成立（无内容特征）、判定 3 原字面也不成立 → 漏出判定阶梯**不生成 episode**，旗舰指标漏记 abandoned——这正是零执行扫描的核心目标场景
- **存量空串 trace_id**（P0 之前，`DEFAULT ''`）：锚定抄录时按已知噪声记案，不参与 verdict 关联（与 P5 承重假设同款显式声明）。

## 3. episodes 表结构

```
episodes:
  id                          TEXT PK
  root_trigger_message_id     TEXT UNIQUE    -- 锚定主键
  root_triggered_by           TEXT           -- 'U' | 'H'（双根语义）
  root_message_id             TEXT           -- 实际锚定消息（task_id 辅助时指原始消息）
  task_id                     TEXT           -- 归组辅助键（U 根自身值，可 NULL，不承重）
  chain_task_id               TEXT           -- 结局判定关联键（= 链末 execution_log.trace_id 抄录；NULL 仅零执行场景，G2-N5）
  session_id                  TEXT           -- 根消息所在会话（N6：verdict JOIN 的 session 限定键）
  outcome                     TEXT NULL      -- 7 类结局之一，未定 = NULL
  episode_state               TEXT           -- closure 状态机（open → classified → closed）
  classification_ver          TEXT           -- 判定规则版本号（P5 全量重评承重）
  created_at / updated_at     TEXT           -- ISO 8601 UTC
```

- **UNIQUE(root_trigger_message_id) + ON CONFLICT DO UPDATE upsert**：项目成熟模式，五处先例（agents.ts:111 / knowledge.ts:69 / sessionReadState.ts:24 / connectorBindings.ts:36 / sessions.ts:128）。
- **P5 全量重评承重**：schema/判定规则升级时带新 `classification_ver` 全量 upsert 重评，幂等；重评期间旧值被覆盖，显式声明「重评结果覆盖历史结局」承重假设。

## 4. closure 状态机 + 改进闭环

```
open（在途/未定）--归因--> classified（结局落定 + 失败归因）--分流--> 既有动作通道
   ▲                                                              |
   └---------------- 复验确认（closure）<--------------------------┘
```

- **归因**：非 success 结局 → 定位根因（error_type / verdict / 路由信息）→ 分流到既有动作通道（L1 告警、审查链、harness 修复单、路由修复单）。
- **closure 复验**：动作完成后复验确认结局成立（如修复合入后重跑验证 corrected_success），确认后 episode_state → closed。
- **在途检测**：running 行 EXISTS 即 open/skip，不重复归因（单条 SQL，P3 已审定）。

## 5. 验收标准

| #        | 场景                                                                                                                                               | 断言                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ①        | 在途窗口（有 running 行）                                                                                                                          | closure 状态机 skip，不归因                                                                                                  |
| ①'       | **恢复重跑成功（G1 补）**：同 triggered_by 存在 `[failed(server_restart), completed]` 两行、无 running                                             | 判 success，**非 abandoned**                                                                                                 |
| ②        | 正常完成无打回                                                                                                                                     | success                                                                                                                      |
| ②'       | **U→H→approve 完整链（G2 补）**：U 根 + H 根两 episode，H 链最终 approve                                                                           | U episode 结局 = success；H episode 不计任务结局（不双计）                                                                   |
| ②''      | **U 根 task_id NULL + 链内有 reject（G2 第五轮补）**：U 根无 task_id，投递带 taskId 机制生效、执行链内存在 reject verdict                          | 判 corrected_success / needs_investigation，**非 success**（NULL 根不误判）                                                  |
| ②'''     | **用户 taskId vs traceId 双值（G2-残留 A 第六轮补）**：U 根带用户 taskId（`task-123`）+ 实现链单层 + 审查链带 traceId                              | chain_task_id = trace_id（**非 task-123**，从 execution_logs 抄录），断言仍关联到 reject verdict（防双值漂移致误判 success） |
| ②''''    | **零执行 episode（G2-N5 第六轮补）**：根消息落库 > 30min、无任何 execution_log 引用                                                                | 生成 episode（chain_task_id = NULL）判 abandoned，**root_triggered_by='U'**，不炸 NOT NULL、不误判 success                   |
| ②'''''   | **零执行 H 根（G3 第八轮补）**：交接 H 消息落库 > 30min、被静默丢无 execution_log 引用、task_id 匹配已有 episode 的 chain_task_id                  | 扫描生成 episode 判 **root_triggered_by='H'**（非 'U'），不计入 U 根任务结局计数                                             |
| ②''''''  | **零执行 U 根·task_id 无匹配（G5 第九轮补）**：用户带 task_id（非 NULL）新任务被静默丢，task_id 无匹配 episode、无内容特征                         | 仍生成 episode（chain_task_id=NULL）判 abandoned（root_triggered_by='U'），**不漏出判定阶梯**                                |
| ②''''''' | **零执行 H 根·内容特征（N8 第九轮补）**：零执行 H 根、**无 task_id**（E3 接线前现状，handoff-gen 当前投递不带 taskId）、带交接文档精确前缀内容特征 | 判 root_triggered_by='H'（非 'U'），不计入 U 根任务结局计数（覆盖 E3 前承重路径——判定 2 是今天就能工作的一条）               |
| ③        | 有 suggest + completed 晚于最近 suggest                                                                                                            | corrected_success                                                                                                            |
| ③'       | **时序反转（N1 补）**：completed 早于 suggest                                                                                                      | 非 corrected_success（走 needs_investigation）                                                                               |
| ④        | 重启打断未恢复（仅 server_restart 行）                                                                                                             | abandoned                                                                                                                    |
| ④'       | `[failed(server_restart), failed(timeout)]` 混合失败（N2）                                                                                         | 非 abandoned，按 timeout 归因 needs_investigation                                                                            |
| ⑤        | 同 triggered_by 全量失败                                                                                                                           | routing_failure                                                                                                              |
| ⑥        | upsert 幂等：同根重复归因                                                                                                                          | 覆盖更新不炸、不产生重复行                                                                                                   |

## 6. 实施拆活（审 ✅ 后派）

- **E1**：episodes 表迁移 + closure 状态机 + 判定优先级实现（含 ①'②'②''②'''②''''②'''''②''''''②'''''''③'④' 测试）+ 零执行 episode 扫描路径（G2-N5 + G3 H 根判定 + G5 判定 3 补全「task_id 为空或无匹配 episode」+ N9 内容特征钉死精确前缀）——**✅ 已实施（a0ade7d，25 测试全绿）**
- **E2**：归因 → 分流到既有动作通道 + closure 复验闭环
- **E3**：P5 全量重评脚本（classification_ver 驱动）+ 双根语义接线（root_triggered_by 落位）+ 投递消息携带源链 task_id（post-commit hook / handoff-gen payload 加 taskId，与 chain_task_id 同源反查）+ socketio.ts:2297 补 `|| traceId`（持久化层与瞬态 1060 同构，一行）

## 7. 关联

- 判定用到的执行状态四态：`CHECK (status IN ('queued','running','completed','failed'))`（db/index.ts:112）
- 交接消息走 ingestUserMessage（routes/messages.ts:98），H 根是 role='user' 消息
- 恢复重跑插 completed 新行：dispatch/index.ts:181（P0 队列持久化 insertExecutionLog）
- 「仅 server_restart」恢复判据：socketio.ts:1512（`serverRestartLogs` 只筛 `failed && error_message === 'server_restart'`）
- fixStuck 双写 failed/server_restart：executionLogs.ts:237-248（error_message + error_type 同 UPDATE）
- A2A 瞬态 agentTrigger taskId 继承（traceId 兜底，不落库）：socketio.ts:1060（`taskId = triggerMsg.taskId || traceId`）
- agent 回复落库 task_id（`|| null`，E3 改 `|| traceId`）：socketio.ts:2297（insertAgentMessage）；messages 表无 trace_id 列：db/index.ts:70-78
- chain_task_id 锚定源：execution_logs.trace_id（insertExecutionLog 每行写 traceId）：db/index.ts:113；零执行 episode 扫描依赖 execution_logs.triggered_by_message_id
- U 根 task_id 可 NULL：ingest.ts:102（`taskId || null`）
- 用户消息 taskId 字段入口：ingest.ts:39
- 交接文档内容特征（判定 2 钉死，N9）：buildHandoffMessage 精确前缀 `@<猫名> 请补填以下交接文档`（handoff-gen.mjs:765）；socketio.ts:1740 既有 `startsWith('@店长 请补填以下交接文档')` 先例
- handoff-gen 投递 POST body 当前不含 taskId（handoff-gen.mjs:933-941 仅 sessionId/content/mentions），E3 接线项（②''''''' 依赖 E3 后判定 1，E3 前走判定 2 内容特征）

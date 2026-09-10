# T-G 强制 failure-mode audit（五面横扫）

**范围**：T-G 本票改动面及其测试文件——`eval/episodes.ts`、`eval/chain-verdicts.ts`（新建）、
`execution/flow-advance.ts`、`execution/recovery.ts`、`execution/reply.ts`、`execution/hints.ts`
及各自 `.test.ts`。

**口径**：行号一律 grep/sed 复核后落笔（本批已现 blob/工作区双行号）；计数一律写明单位。
**范围内发现范围外的缺陷 → 只记不修（见 §F）**。

**贯穿实测（本 audit 一切数字的来源，真库 `cat-study-dev.db` 只读）**：

| 量                                 | 值                     | 单位                                       |
| ---------------------------------- | ---------------------- | ------------------------------------------ |
| `execution_logs` 行数              | 958                    | 执行行                                     |
| 其中 `trace_id = 触发消息.task_id` | 252                    | 执行行                                     |
| 其中 `trace_id ≠ 触发消息.task_id` | 706                    | 执行行（73.7%）                            |
| 其中触发消息 `task_id IS NULL`     | 456                    | 执行行                                     |
| 链 `f352c2e7`（锚 `28aa26c4`）     | 链长 4 / 尾 `38512c2b` | 执行行                                     |
| 该锚名下消息                       | 17                     | 消息行（`task_id='28aa26c4'`）             |
| 尾 trace 名下消息                  | **0**                  | 消息行（`task_id='38512c2b'`）← 现状恒空集 |
| 该锚名下 reject/suggest 判词       | **1**                  | 判词行 ← 修复后应命中                      |

→ 一次实测就把「锚 ≠ 尾 trace」从推断变成事实：**73.7% 的执行行上两者不等**，
且存在真实链（`f352c2e7`）现状查 0 行、按锚查 1 行。

---

## A. 面① 判据（守卫/闸门的谓词是否恒真或恒假）

| #   | file:line                                                                               | 判定                                                                                                | 处置                         |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- |
| A1  | `eval/episodes.ts:150` `if (verdicts.length === 0) return 'success'`                    | **恒真侧 fail-open**：「查询打偏」与「确实无打回」同判 `success`                                    | 本票修（bug A）              |
| A2  | `execution/hints.ts:127` `if (marker && (approve\|\|comment)) return null` → 其余全注入 | **恒真侧 fail-open**：「查不到标记」「消息已陈旧」全落进「必须返工」分支                            | 本票修（消费方 5）           |
| A3  | `execution/flow-advance.ts:201` `if (advanced)`                                         | **恒假侧 fail-closed**：`advanced` 与「该不该提醒」不共真值——已 closed ⇒ 提醒永不投、只留 info 日志 | 本票修（bug B 后半）         |
| A4  | `execution/recovery.ts:413` `hasAgentReplyByTaskId(session_id, task_id)`                | **链级存在性当消息级判据**：`LIMIT 1` 任意一条同锚回复即让本条永久跳过                              | 本票收窄为「同锚且晚于本条」 |
| A5  | `execution/reply.ts:193-206` 回捞无任何上限                                             | 非假谓词，但**无界**（见 C2 计数）                                                                  | 本票加条数 + 字符预算        |

## B. 面② 注释（与代码是否一致）

| #   | file:line                                                                                                      | 判定                                                                              | 处置                                     |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| B1  | `eval/episodes.ts:9`、`:110` 「chain_task_id 从链末 execution_log.trace_id 抄录（G2：不取 messages.task_id）」 | 与代码一致，但**前提已被 T-E 推翻**（锚 = `messages.task_id`；实测 706/958 不等） | 本票改注释                               |
| B2  | `execution/flow-advance.ts:22-23`、`:42` 「messages.task_id（**= 源链 trace_id**）」                           | 等式为假（同上实测）                                                              | 本票改注释 + 交规格（§F2）               |
| B3  | `execution/recovery.ts:409-411` 「同 task_id 已有 agent 回复 → 消息**事实上已被执行**」                        | 「事实上」过强，见 A4                                                             | 本票改注释                               |
| B4  | `db/repository/verdicts.ts:49` 同一失实等式「task_id = 链末 execution_log.trace_id」                           | 同 B2                                                                             | **范围外**（`db/` 归 flash猫）→ 只记不修 |

## C. 面③ 计数（数过没、单位写明没）

| #   | file:line                                                                             | 判定                                                                                                                             | 处置                 |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| C1  | `execution/flow-advance.test.ts:86` `expect(events.length).toBeGreaterThanOrEqual(3)` | 计数**不钉死、无单位**；主干道四步（quality-gate→request-review→receive-review→closed）下「≥3」对旧实现也恒真 ⇒ **不构成区分性** | 本票补精确断言       |
| C2  | `execution/reply.ts:191-206` 回捞                                                     | 病灶实测：单锚名下 **20 条 / 7.7 万字符**（店长派活单实测值）；本票新增上限后须写明单位（条 / 字符）                             | 本票加常量并注明单位 |

## D. 面④ 谓词（「不存在 X」类断言是否先钉死 X）

| #   | file:line                                                                       | 判定                                                                                 | 处置                                                                                                                                           |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `eval/episodes.ts:136-150`                                                      | 断言「该链不存在打回」，但 **X（该链在 `messages` 表有行）未先钉死**——查询打偏即恒真 | 本票修：先钉锚、再查、查空要能区分「无锚」与「有锚无命中」                                                                                     |
| D2  | `eval/episodes.ts:135`（改后 `:161`）「chain_task_id 为空 → 跳过 verdict 关联」 | 空锚（存量噪声）与「有锚查不到」行为同归 `success`，不可分辨                         | 本票区分：区分落在**库内**（`chain_task_id` NULL vs 有值）+ 代码注释裁明「锚为空只可能是链上无执行行」——不落日志（该分支是常态，落日志即噪声） |
| D3  | `execution/hints.ts:119-131`                                                    | 「最近一条 @我的审查者消息」是**窗口近似值**，未钉死「这条结论是否仍是该链最新判词」 | 本票改为按锚查最新判词                                                                                                                         |

## E. 面⑤ 自我指涉 / 验证面 ≠ 被判面

| #   | 位置                                 | 判定                                                                                                                                                                                                   | 处置                                                                                                                                                                                                  |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 本票新增测试                         | 判据查 DB（`episodes` / `review_verdicts`）⇒ 断言必须查 DB；判据扫 content ⇒ fixture 必须用真 content 形状。**不得**用「grep 工作区文件」验证一个扫消息 `content` 的判据（T-J 第二例实证：恒真假绿门） | 本票新用例逐条按此写                                                                                                                                                                                  |
| E2  | `eval/episodes.test.ts` 既有 fixture | **已核并实测**：改锚后 `episodes.test.ts` 一次红 **9** 例——全部是「fixture 把判词消息的 `task_id` 写成链末 `trace_id`」的用例（旧模型自洽、新模型下查不到），旧测试全绿正是这么来的                    | 本票：9 例中 8 例走**存量降级路径**后自然恢复（不必改断言），只改真正编码了旧裁决的 1 例（`②'''`，断言从「= trace-B」翻成「= anchor-A」并升级为区分性用例）；新增 fixture 一律**刻意让锚 ≠ 尾 trace** |
| E3  | 本文件自身                           | 「零命中 / 未复现」类断言的高危载体                                                                                                                                                                    | 本文件不含无 scope 的零命中断言：§贯穿实测 的每个数都带表名 + 单位 + 口径                                                                                                                             |

## F. 范围外（只记不修，报店长）

1. **`db/repository/verdicts.ts:60` `hasClosedVerdictByTaskId` 是「链级曾出现闭环档」而非「最新判词是闭环档」**——
   `LIMIT 1` 任意命中即真。T-C 后 ✅/💬 均入闭环档，故「先 ✅ 后新 commit 再 ⚠️」的链会**恒真**（补填请求不再投）。
   归 `db/`，本票不碰。**判定**：与 A4 同族（存在性当判据），影响面待实测。
2. **`db/repository/executionLogs.ts:124` `getCommitHashByTraceId` 1 trace→1 commit 假设**——
   即 T-G 票面「收口提醒指错 sha」半条。需改该文件（本轮归 flash猫 独占）⇒
   **本票只交精确修法规格，不落码**（验收② 因此本轮不可达，见交付说明 OQ-1）。
   **精确修法规格（下一轮直接落码）**：
   - **新函数**（`db/repository/executionLogs.ts`）：`getCommitHashByAnchor(anchor: string): string | undefined`
     ```sql
     SELECT el.commit_hash
     FROM execution_logs el
     JOIN messages m ON m.id = el.triggered_by_message_id
     WHERE m.task_id = ? AND el.commit_hash IS NOT NULL
     ORDER BY el.started_at DESC, el.id DESC
     LIMIT 1
     ```
     —— 把「锚」从**执行行的 trace_id 列**换到**触发消息的 task_id 列**（与 T-I 的
     `/executor` 同款一跳 JOIN），`id` 做同秒 tie-break（库内 started_at 为秒精度）。
   - **调用点**（`execution/flow-advance.ts:59`）：`getCommitHashByTraceId(meta.task_id)`
     → `getCommitHashByAnchor(meta.task_id)`；旧函数**保留**（`/api/handoff/verdict`
     的判据链仍按 `commit_hash → trace_id → review_verdicts` 用它，别顺手删）。
   - **消歧决策（架构已裁）**：同一锚名下多行 `commit_hash` 时**不得猜**——本规格仍带
     `ORDER BY … LIMIT 1`，是因为「一条链挂多 commit」的正确答案是**按被审轮次**取，
     而这需要 `review_verdicts` 那一侧的信息；**先落本规格（消掉 73.7% 的错锚），
     多 commit 的消歧与 T-M「不得猜」同批裁决**，不在此处私自定义 tie-break 语义。
   - **区分性验收**：造一条链，根消息 `task_id = A`、两次执行 `trace_id = T1/T2`（≠A）
     且各挂 `commit_hash = C1/C2`；判词消息 `task_id = A`。旧实现按 `trace_id = A` 查
     → **0 行**（`flow-advance` 整段跳过，`flow_states` 无记录）⇒ 新实现必须命中；
     断言 `getFlowState(session, C2)?.state === 'closed'`（旧实现下 `undefined`，**必红**）。
3. **`db/repository/messages.ts:475` `getUndispatchedUserMessagesOlderThan` 硬过滤 `role='user'`**——
   `role='agent'`（A2A 静默丢）与 `role='system'` 永不在扫描面内 ⇒ 丢派不自愈。
   归 `db/` + 店长已并入 T-K 分析面。本票不碰。
4. **`db/repository/messages.ts:201` `hasAgentReplyByTaskId` 无时间界**——A4 的收窄在本票用
   「同锚消息 + 时间比较」在 `recovery.ts` 调用侧实现（用既有 repo 函数），未改 repo 本身。

---

## G. 件5｜§8 / §9 评估（只评估不修；两处落点均在 `scripts/`，本轮归 flash猫）

### G1｜refs 守卫的 `catstudy/` 枚举盲区（T-H N-c）

**落点**：`scripts/mcp-server.test.js:705-708`——`readdirSync(SKILLS_ROOT)` 只读**一层**且显式
`d.name !== 'refs' && d.name !== 'catstudy'` ⇒ `skills/catstudy/**` 整体在枚举面外。

**实测（推翻原判的一半）**：

| 断言                                                                      | 实测                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skills/catstudy/quality-gate/SKILL.md`、`receive-review/SKILL.md` 无 `@` | ✓（原判成立）                                                                                                                                                                  |
| 「今天零实害」对**整棵子树**成立                                          | ✗ **不成立**：`skills/catstudy/refs/cat-roles.md:27` **含 `@`**（`…投递 @审查者…`）——它同样在枚举面外，且若被纳入枚举，`expect(text).not.toContain('@')` 会**直接红**          |
| 引 `catstudy/refs/cat-roles.md` 会去读不存在的顶层路径                    | ✓：正则会捕获 `cat-roles.md` → `readSkillsFile('refs','cat-roles.md')` → `skills/refs/cat-roles.md` **不存在**（顶层 refs 实测 5 个文件，无此名）→ ENOENT = **响的**（可接受） |

**判定**：盲区成立；「零实害」只对两处 SKILL.md 成立，对整棵 `catstudy/` 子树**不成立**
（已存在一条 `@`）。但**真害仍未发生**——那条 `@` 所在的 ref 没有任何 SKILL.md 引用它
（实测：全仓 SKILL.md 的 refs 引用只有 `receive-review → refs/review-standards.md` 与
`request-review → refs/review-request-template.md` 两处），故枚举放宽**不会**立刻把它拉进来。

**修法形状（几句话，供店长裁立不立单）**：

1. 枚举面改 `skills/**/SKILL.md` 递归（或显式加入 `catstudy/*/SKILL.md`），枚举空判据保留；
2. 同时把 `catstudy/refs/*.md` 纳入 refs 扫描面——**须先裁决**：`cat-roles.md` 里的
   `@审查者` 是**正当领域内容**（角色约定文档本就该写 @谁）还是违 §3 不变量？
   若前者，则守卫要按**路径**分档（顶层 `refs/` 严、`catstudy/refs/` 宽），而不是一律禁 `@`；
3. `readSkillsFile` 的根硬编码（顶层 `skills/refs/`）加一句「引用必须写顶层相对路径」的断言，
   把 ENOENT 从「崩在读取」变成「带说明的判红」。

### G2｜剥注释只剥整行 `//`（T-H N-d）

**落点**：`scripts/handoff-gen.test.js:238`——`source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'')`。

**实测**：

| 断言                                                                  | 实测                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 「当前不误报（唯一那处恰是整行注释）」                                | ✓ **逐字核实**：`scripts/handoff-gen.e2e.mjs` 里 `join(ROOT, ` 恰 **1** 次命中，在 `:85`，形态是**整行** `//` 注释 ⇒ 被剥掉、守卫绿 |
| 尾注释未剥 → false-positive 方向（会红不会哑）                        | ✓ 成立（`^\s*//.*$` 只吃整行）                                                                                                      |
| `.replace(/\/\*[\s\S]*?\*\//g,'')` 会剥掉**字符串里**的 `/*` → 哑方向 | ✓ 成立；且**当前未触发**：实测该文件**没有任何**字符串字面量含 `/*`                                                                 |

**判定**：两条都成立，且**当前均无实害**（一侧无尾注释命中、一侧无字符串 `/*`）。危险方向是
第二条第 3 行——**哑方向**（守卫被剥瞎 → 恒绿）。它与本票主线的「恒真假绿门」同族。

**修法形状（几句话）**：

1. 最省事且够用：把 `expect(code).not.toContain('join(ROOT, ')` 改成**逐行判据**——
   先剥注释、再按行匹配并**报出命中行号**，让「残留是代码还是注释」在失败信息里可见；
2. 更稳：改用 AST 级判据（`node --experimental-strip-types` 无法直接用；务实做法是
   用 `acorn` 之类解析后查字面量）——**收益不足以引入依赖**，建议走 1；
3. 若只做一件事：把 `/* */` 那条替换限定为**行首**（`/^\s*\/\*[\s\S]*?\*\//gm`），
   与 `//` 同口径——立刻消掉「字符串里 `/*` 把守卫剥瞎」这个哑方向，代价是行尾块注释不剥
   （属 false-positive 方向，会红不会哑，可接受）。

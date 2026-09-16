# R6 票：崩溃标签正名（OQ-1）+ 诊断取值边界收窄（OQ-3）

> 归属：评估体系（`map.md`）。**立票 2026-09-16**（用户原话：「OQ-1 OQ-3 开修」）。
> 基点：`59d1a2e`（dev = origin/dev = .push-gate；R5 全链 §A+§B 已并入）。
> 出处：R5 §B 审查回执的 OQ-1 / OQ-3。

## 结论先行

1. **§A（`execution/serial.ts`，ds猫）** = OQ-1：`'execute crash'` 这个字面量**没崩也落**——给它正名 + 追因「executeOneAgent 返回了但槽位仍 busy」。
2. **§B（全仓，flash猫）** = OQ-3：同型诊断取值点**按边界收窄**改走 `messageOf` 单源——**不做全量 134 处机械扫**（裁决见 §三.2）。
3. 两 § 文件面**零重叠**（§A 独占 `serial.ts`，§B 禁入该文件），可并行。
4. 两 § 均含 `packages/server/**` ⇒ 落地后需重启生效。

## 一、事实（店长独立实测，命令 + 原始读数，非转述）

### 1.1 OQ-1：`'execute crash'` 对本票 19 条是**谎报**

| #   | 事实                                                                                                                          | 位置 / 命令                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `executeRun` 的 `finally` 在槽位仍 `busy` 时**无条件**写兜底词                                                                | `serial.ts:1706` 定义 / `:1729` `if (s && s.status === 'busy')` / `:1735` `errorMessage: messageOf(execError) ?? 'execute crash'`                |
| 2   | `execError` **只**在 `catch`(`:1717`) 赋值 ⇒ 不抛则 `undefined` ⇒ 落 `'execute crash'`                                        | 同上                                                                                                                                             |
| 3   | 该 `catch` 的伴生日志 `execute crashed — releasing slot in finally`(`:1719`) 在**活日志 0 条**                                | 跨 `packages/server/data/cat-study.log` + `.log.1`，node **JSON 解析只认带 `ts` 的行**（`grep -c` 在本文件给假读数——混着注入 prompt 的记忆文本） |
| 4   | 对照：`post-execution error — releasing slot` **5 条**、`agent execution failed` **8 条**                                     | 同上 ⇒ catch 机制本身会触发，唯独 `executeRun` 这条从未触发                                                                                      |
| 5   | ⇒ **全库 19 条 `execute crash` 全部来自 `execError === undefined` 路径**                                                      | 即「**无异常抛出、但槽位仍 busy**」                                                                                                              |
| 6   | 19 条读数：`status=failed`、`message_id` 全空、`latency_ms` 全空、跨 4 只猫、`ended_at` 已置                                  | `execution_logs` where `error_message LIKE 'execute crash%'`                                                                                     |
| 7   | `executeOneAgent`(`:448`) 自带外层 catch(`:1094`→`:1105` `'post-execution error'`)，**跑完会调 `completeExecution` 释放槽位** | ⇒「返回了但槽位仍 busy」是一条**漏收口**路径，不是常态                                                                                           |

**结论**：`'execute crash'` 当前**同时**背负「真崩」与「没崩但槽位没收口」两种情形——对 19 条它是谎。R5 §B 之后这个字面量**只剩一个出处**（`:1735` 的 `??` 兜底），正是正名时机。

## 二、§A 契约（ds猫）—— 正名 + 追因

**改哪些文件**：`packages/server/src/execution/serial.ts`（**独占**）+ co-located 测试。
**边界**：§B 禁入本文件；不改既有断言（补可以）；不动 `error_message` 的 DB 列语义；不动 `utils.ts:42` 的 `messageOf` 本体。

两件事**分开做、分开报**：

### A-1 正名（必做）

`:1735` 的 `?? 'execute crash'`，在 `execError === undefined` 时改落**可区分**的词。

- 建议字面量：`'slot busy after executeOneAgent returned'`（英文，与 `'post-execution error'` / `'unknown error'` 同风格）
- 若 A-2 追因拿到更精确的成因，**可改字面量**，但须在交接文档写明理由
- **语义边界**：`messageOf(execError)` 为真值时**零回归**；`??` 保留，**不得换 `||`**（`Error('')` 会静默改行为）

### A-2 追因（必做，产物是报告不是代码）

`executeOneAgent`(`:448`) 的**所有返回路径**里，哪条会 return 而**不**收口槽位（不调 `completeExecution`）？

- 给**路径清单**（函数内位置 + 触发条件）
- 能给复现最好；不能则给「代码上可达 / 当前无实测触发」的**诚实**结论
- ⚠️ **停手条件**：若追因发现是**真缺陷**（确有一条路径漏收口）⇒ **停手报我**，不自行扩大改动面——那是另一票
- 已知线索（交你，不替你判）：`completeExecution`(`:1591`) 用 `getSlotInternal(agentId, sessionId)` 取槽；`:1604` 的 `finalizeExecutionLog` **不带 `executionId`**——「谁写了那 19 行的 `ended_at`」值得顺手核一眼

### 验收（§A）

| #   | 判据                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------- |
| A1  | 新测试构造「`executeOneAgent` 正常返回但槽位仍 busy」⇒ 落库 `error_message` = 新词，**且 ≠ `'execute crash'`** |
| A2  | `throw new Error('x')` 路径 ⇒ `error_message === 'x'`（**零回归**，逐字一致）                                  |
| A3  | **真空性反对照（必做）**：把新词还原成 `'execute crash'` ⇒ A1 **必须变红**，报红点数 + 断言名                  |
| A4  | 追因报告（A-2）进交接文档；含路径清单 +「未复现」的如实声明（若有）                                            |
| A5  | `pnpm lint` + 全量 `pnpm test` 全绿                                                                            |

## 三、§B 契约（flash猫）—— 同型点边界收窄

**改哪些文件**：全仓**除** `packages/server/src/execution/serial.ts`（§A 独占；该文件 R5 §B 已全族覆盖，残留 0 处代码点，仅剩 1 行注释）。
**边界**：禁入 `serial.ts`；不动 `.husky/**`；不改既有断言；不动 `messageOf` 本体（要改先报我）。

### 3.1 筛面读数（同一正则，非散文数字）

```
git grep -nE "\b(err|e|error|execError|parseError|ex|reason|caught)\??\.message\b" \
  -- 'packages/**/*.ts' 'scripts/**/*.mjs' 'scripts/**/*.js' ':!*test*' | wc -l
→ 135
（同命令 `-l | wc -l` → 45 文件；含 `serial.ts` 1 行注释 ⇒ 实际代码点 134）
```

逐文件前十：`index.ts` 13 / `execution/reply.ts` 9 / `llm/git-utils.ts` 8 / `memory/embedding-client.ts` 7 / `llm/pi.ts` 7 / `llm/opencode.ts` 7 / `execution/recovery.ts` 7 / `llm/session-closeout.ts` 6 / `git/create-pr.ts` 5 / `routes/internal.ts` 4。

> **计数以命令为准**。§B 实施猫上轮报「~35 文件 / ~110 处」——口径差异在我这条正则多收了 `ex` / `reason` / `caught` 等变量名，**不是谁的错**。

### 3.2 档位裁决（店长拍板，实施者不得自行改判）：**边界收窄，不做全量扫**

**改**（catch 能接住**非本仓来源**的值）：

1. 子进程 `spawn` / `execFileSync` / `execSync`
2. HTTP `fetch` / 第三方 SDK
3. `JSON.parse` / DB 驱动
4. EventEmitter `'error'` / 第三方回调
5. 客户端不可信入参（Socket.IO handler / REST handler 边界）

**不改**（catch 体内只调本仓函数、抛出物只可能是我方 `throw new Error`）：留挂账。

**理由**：R5 §B 已实证「非 Error 抛出物真实可达」——但可达面集中在**跨边界**处（实测落点 `:636` 走的是 `chatStream` 边界）。对 134 处一律机械改，是拿一整轮审查预算买「本仓函数自己也 throw 字符串」这种无证据的可能性。

**必报清单（我复核的判据面）**：改哪些（`文件:行`）+ 判不改哪些 + 每档理由。**漏报 = 返工。**

⚠️ **停手条件**：收窄后若仍 **> 60 处** ⇒ 停手报我，我拆票。别一口气交一个 130 点的 diff 给审查。

### 3.3 交付形态：**两 commit**

1. `docs/run/eval-system/R6-diag-inventory.md` —— 分档清单（`docs/run/**` 免审前缀）
2. 代码 commit —— 只含清单里判「改」的那批

### 验收（§B）

| #   | 判据                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- |
| B1  | 被改点**逐点**走 `packages/server/src/utils.ts:42` 的 `messageOf`，**不得**各造第二实现        |
| B2  | 至少覆盖 3 类边界的**判别性**测试：`throw 'string'` ⇒ 落出 `'string'`（非 `undefined` / 非空） |
| B3  | `throw new Error('x')` ⇒ `'x'`（零回归）                                                       |
| B4  | **真空性反对照（必做）**：回退任一被改点 ⇒ 对应断言变红，报红点数 + 断言名                     |
| B5  | 清单完整：改/不改两档逐条可复核（我抽 3 处「不改」核其 catch 体确实只调本仓函数）              |
| B6  | `pnpm lint` + 全量 `pnpm test` 全绿                                                            |
| B7  | 一切计数**附命令 + 原始读数**（本仓纪律：散文数字的复核面 = 再写一遍散文）                     |

## 四、共用纪律

- 提交 `catstudy [uuid]`（uuid 必须是 `messages` 表**真实存在**的触发消息 id）；`git add <具体路径>` → `git diff --cached --name-only` 核对 → 裸 commit
- **行号一律 `git grep -n`（字节路径）复核**；**取证/读写一律用主仓绝对路径**——worktree HEAD 落后会读到另一棵树，行号整片漂
- **CRLF 陷阱**：工作区 SFC 是 CRLF、仓库 blob 是 LF ⇒ 静态源断言假红；撞上先确认，**不得改断言绕过**
- **真空性反对照是硬纪律**：绿不是判据
- 卡住或票面自相矛盾 ⇒ 报我裁，**不自行改判**
- 完工把审查请求投**吐槽猫**（`post_message`）

## 五、不做什么

- 不修那 19 条历史行的存量数据
- 不改 `classifyError` 的既有分类
- 不在本票面处理 R5 §B 交接文档里的 OQ-2 / OQ-4 / OQ-5

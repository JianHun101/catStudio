# R7 票：`finally` 槽位收口无归属校验（R6 §A 追因产物）

> 归属：评估体系（`map.md`）。**立票 2026-09-17**（用户原话：「OQ-1 OQ-3 开修」，本票是 R6 §A 追因的必然延伸）。
> 基点：`666ab2c`（dev = origin/dev = .push-gate；R6 §A 已并入，PR #104）。
> 出处：R6 §A 审查回执（吐槽猫，审 `1ce9e0e`）的 OQ-1 + OQ-3。

## 结论先行

1. **R6 §A 只做了「正名」，没除根。** 新注释白纸黑字写「本帧无权收口」，`:1730` 的代码**照样收**——注释与实现当场矛盾。
2. 真缺陷：`executeRun` 的 `finally`(`:1729`) 见槽位 busy 就收，**不校验这个 busy 槽位是不是本帧的**。
3. 后果不是「诊断难看」，是**把另一笔正在跑的执行收口掉**：误标 idle + 误写 `failed` 日志 + 误弹队列。
4. 存量 19 行 `execute crash` = 19 次误收口，**不是** 19 次崩溃（R6 §A 已证 catch 从未触发）。
5. 修法有抓手：`Slot.currentTriggerMessageId`(`:169`) 现成，归属可判。

## 一、事实（店长独立实测，行号 + 原始代码，非转述）

### 1.1 竞态链（逐环有行号）

| #   | 环节                                                                                     | 位置                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `executeRun` 帧内正常路径**已自收口**：`finalizeRun` → `completeExecution` → 槽位 `idle` | `serial.ts:806`                                                                             |
| 2   | 紧随其后有一个 **await 窗口**：`await Promise.all([drainP, dispatchP])`                  | `serial.ts:1093`                                                                            |
| 3   | 此窗内控制权让出 ⇒ 新触发 B 走 `execute` 决策段，见槽位 `idle` ⇒ 标 `busy` 开跑          | `serial.ts:1772`（决策段）/ `executeAgentCommand`（标 busy + 写 `currentTriggerMessageId`） |
| 4   | 帧 A 的 await 结束 → `return` → **`finally` 执行**                                       | `serial.ts:1729`                                                                            |
| 5   | `if (s && s.status === 'busy')` —— 此时 busy 的是 **B 的槽位**                           | `serial.ts:1730`                                                                            |
| 6   | **无任何归属校验**，直接 `completeExecution(cmd.agentId, cmd.sessionId, false, …)` 收口  | `serial.ts:1731`                                                                            |

### 1.2 归属抓手现成

```ts
// serial.ts:164-170
interface Slot {
  agentId: string
  sessionId: string
  status: 'idle' | 'busy'
  queue: DispatchCommand[]
  currentTriggerMessageId: string | null // :169 ← 本帧 vs 他人，比这个就能分
}
```

### 1.3 为什么 R6 §A 的注释是「半句真话」

新注释写「槽位是**别人的**，本帧无权收口」——**判断正确**，但代码紧接着就收了。R6 §A 票面只授权「正名 + 追因」，追因查实后按停手条件上报，**处置正确**；除根是另一票，即本票。

## 二、契约

**改哪些文件**：`packages/server/src/execution/serial.ts` + co-located 测试（新建 `serial.slot-ownership.test.ts` 或扩充既有）。

**边界**：

- 不改 `completeExecution` 签名（要改 = 停手报我）
- 不动 `error_message` 的 DB 列语义
- 不动 `utils.ts` 的 `messageOf` 本体
- **禁入** `serial.crash-diagnostic.test.ts`（R5 §B 已审产物，且 flash猫 §B 并行同类面——见 §四裁决）

### 2.1 修法（给方向，不给死答案）

两条候选，**实施前先核完 `executeOneAgent` 的收口路径完整性再选**：

- **甲（首选）· 归属校验**：`finally` 收口前比对 `s.currentTriggerMessageId === cmd.triggerMessageId`，不等 ⇒ **不收口**，只落 warn 日志（`errorMessage` 不写 `failed` 行）。
  - 优点：不依赖「正常返回必已自收口」这个假设
  - 风险：若真存在「正常返回但漏收口」路径，加校验后槽位会永久卡死 ⇒ 必须用 2.2-B2 兜住
- **乙 · 条件收窄**：仅 `execError !== undefined` 时才兜底收口（正常返回 ⇒ 必然已自收口）。
  - 优点：一行改动，直击本质
  - 风险：把正确性押在「`executeOneAgent` 所有 return 路径都收口」上——**R6 §A 的追因要给这条背书**，没背书不许用乙

**甲、乙可并用**（归属校验 + `execError` 决定诊断词），实施猫按追因结论定。选定理由**必须写进交接文档**。

### 2.2 验收

| #   | 判据                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | 构造「本帧 await 窗口内他人接管槽位」⇒ 本帧 `finally` **不得**收口：断言**他人**的 `execution_logs` 未被写成 `failed`、槽位仍 `busy` |
| B2  | 「本帧真抛错且槽位仍 busy」⇒ 仍**兜底收口**（不得因加校验而卡死；这是 `finally` 存在的原意）                                         |
| B3  | **真空性反对照（必做）**：把归属校验摘掉 ⇒ B1 **必须变红**，报红点数 + 断言名                                                        |
| B4  | `errorMessage` 语义：本帧真抛 ⇒ `messageOf(execError)` 原样；他人接管 ⇒ **不落 `failed` 行**（warn 日志留痕即可）                    |
| B5  | `pnpm lint` + 全量测试绿；提交 `catstudy [uuid]`，行号 `git grep -n` 复核                                                            |

### 2.3 停手条件

- 修复需改 `completeExecution` 签名、或需动 `dispatch/` 模块 ⇒ **报我**
- 追因发现「正常返回但漏收口」路径**真实存在** ⇒ **报我**（那说明乙不可用，且现状比想象的更糟）

## 三、OQ-3 并入本票（不阻塞修复）

R6 §A 审查回执的 OQ-3：19 行里「3 行同 trace 未解释」（审查者读数：13/16 异 trace）。

- 处置：**作为本票追因项**——修 B1 的过程中顺手核这 3 行是否落在同一 `traceId` 内（同 trace 意味着「同一条链自己收自己」，与 §1.1 的异 trace 竞态不同型）
- 不阻塞 B1~B5；拿到结论写进交接文档即可

## 四、OQ-5 裁决：挂账

`serial.crash-diagnostic.test.ts:8` 复述文本仍称「19 次 = 同源族」，与 R6 §A 追因结论冲突（真相 = 误收口，非崩溃族）。

**裁决：挂账，本票不改。**

理由：① 该文件是 R5 §B **已审**产物，改它要重走审查；② flash猫 §B 正在并行改同型面，此刻动它有撞车风险；③ 它是**测试注释**，无运行影响。

**触发条件（钉死，防静默遗忘）**：本票 R7 收口后，由店长立「复述文本族修」票一并处理——与 flash猫 §B 收口同批。

## 五、重启

本票含 `packages/server/**`（`serial.ts`）⇒ 落地后需重启生效。与 flash猫 §B 合并发一次。

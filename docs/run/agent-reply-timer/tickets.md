# Tickets: Agent 回复计时上气泡

计时从「用户消息状态行」迁到「Agent 自己的气泡 footer」，A2A 执行时长可见。
Spec：`docs/plans/agent-reply-elapsed-timer.md`（决策留痕见其尾部）。

Work the **frontier**：票①完成后票②解锁（纯串行链，从上到下）。

## 票① server：thinking 事件补 startedAt 锚点

**What to build:** `MESSAGE_AGENT_STATUS` 的 `thinking` 事件携带 `startedAt`，与同一执行后续 `replying`/心跳事件的 `startedAt` 是同一次取值——计时锚点从「LLM 流开始」前移到「执行起点」（上下文组装前），与 trace 根段 `invoke_agent` 同口径。

**Blocked by:** None — can start immediately。

**改动面（契约级）：**

- `packages/server/src/execution/reply.ts`：`startedAt = Date.now()` 一次取值提前到 `thinking` emit 之前；`thinking` 载荷补 `startedAt`；`replying` 与心跳沿用同一常量（现值不变）。
- `packages/shared/src/types.ts`：`MessageAgentStatusPayload.startedAt` 注释「仅 'replying'」改为「'thinking'/'replying'」——纯注释，wire 形状不变。
- 测试：扩展 `connectors/socketio.test.ts` 既有 heartbeat 测试块（fake timer 范式），断言 `thinking` 带 `startedAt` 且与 `replying` 各次同值。

- [ ] AC1：一次执行内 `thinking`、`replying`（首发）、`replying`（心跳重发）三种事件的 `startedAt` 全等（测试断言，非目测）
- [ ] AC2：`pnpm test:server` 与 `pnpm test:shared` 全绿，`pnpm lint` 全绿
- [ ] AC3：不新增事件、不改 `AgentRuntimeState`、不动调度与 DB（diff 自证）

## 票② web：计时上气泡 footer + 占位气泡 + 状态行去秒

**What to build:** 用户在任何执行（含 A2A、headless 适配器）期间，都能在被触发 Agent 的气泡 footer 看到「回复中 · 已 N 秒」（≥60s 转 m:ss）逐秒递增；心跳失联 >25s 停走并显示「无响应」；执行终止（完成/停止/超时）后计时消失。用户消息状态行保留状态与停止按钮、不再显示秒数。

**Blocked by:** 票①（thinking 锚点——占位气泡在上下文组装阶段的计时依赖它；票①未落时本票降级为「thinking 阶段显示静态思考中、replying 起计时」，但交付口径以票①已落为准）。

**改动面（契约级）：**

- `packages/web/src/stores/chat.ts`：新增 `replyTimers: Map<agentId, { startedAt, lastBeatAt }>`；`MESSAGE_AGENT_STATUS` handler 内维护（thinking/replying 写入——`startedAt` 取新旧较小者、`lastBeatAt` = 接收时刻；done 删除）；`AGENT_STATUS` idle 时删除（覆盖 abort/timeout 无 done 路径）；切会话与 `typingStates` 同点清空。
- 新叶子组件 `packages/web/src/components/ReplyElapsed.vue`：props `{ startedAt, lastBeatAt }`；本地 1s tick（`onUnmounted` 必 clear）；`回复中 · 已 N 秒` / ≥60s `回复中 · 已 M:SS`；`lastBeatAt` 距今 >25s → 红字「无响应」停走。liveness 语义照抄 `AgentStatusLabel.vue`。
- `packages/web/src/components/ChatPanel.vue`：流式气泡 footer 的静态「回复中…」替换为 `ReplyElapsed`；新增占位气泡——「`replyTimers` 有、`typingStates` 无」的 agent 渲染 streaming 同款虚线气泡（复用 `.message.streaming` 样式），正文思考动点，footer 停止按钮（`canStopAgent`）+ `ReplyElapsed`；首个 chunk 到达后自然切换流式气泡，计时同源不重置。**顶层不得引入每秒变化的响应式状态**（既有静态断言守门）。
- `packages/web/src/components/AgentStatusLabel.vue`：`replying` 分支去掉「· 已 N 秒」，保留 已收到/思考中/回复中/完成/无响应；1s tick 保留（驱动无响应翻转）。
- 测试：`chat.test.ts`（replyTimers 六条路径）；`ChatPanel.test.ts` / `MessageItem.test.ts` 静态断言（tick 只在 ReplyElapsed、状态行无秒数）；`ReplyElapsed` 行为测试（fake timer：N 秒 / m:ss / 无响应三态）。

- [ ] AC1：A2A 触发（消息 `mentions` 他猫）的执行，被触发猫气泡 footer 显示逐秒递增计时（store 层模拟事件序列可验）
- [ ] AC2：全程无 `AGENT_TYPING` 的执行（headless 场景），占位虚线气泡全程在，计时递增，停止按钮可用
- [ ] AC3：占位气泡 → 流式气泡切换时 `startedAt` 同源，秒数不重置（同一 map 条目驱动）
- [ ] AC4：≥60s 显示 `已 M:SS` 格式（fake timer 推进断言）
- [ ] AC5：`lastBeatAt` 停滞 >25s → 显示「无响应」且秒数停走（fake timer 断言）
- [ ] AC6：`done` 与 `AGENT_STATUS idle` 两条路径都清计时；abort/timeout（无 done）走 idle 路径同样清——无僵尸「无响应」
- [ ] AC7：用户消息状态行保留状态文字与停止按钮，不出现秒数（静态断言 + 行为测试）
- [ ] AC8：刷新/切会话后，执行中的计时在下一个 10s 心跳到达时恢复且不归零（`startedAt` 来自 server 载荷而非本地计时——store 测试模拟「中途收到首个 replying」断言 `startedAt` 取载荷值）
- [ ] AC9：`ChatPanel` 顶层无每秒变化的 ref/reactive（静态断言）；tick 只在 `ReplyElapsed`（与既有 `AgentStatusLabel`）内
- [ ] AC10：`pnpm test:web`、`pnpm test:shared`、`pnpm lint` 全绿

## 收口（2026-09-20 补记 · 店长票 A G1(c)）

> 本段为**事后补记**：票①② 落地时代码已进 dev，但票面缺收口段（`docs/run/docs-run-status-gate/tickets.md` G1(c) 点名此缺）。只登记**可实测**的事实；审查结论原文不在本票面，未转述。

| 项       | 值                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 票① 代码 | `663f9b3`（server：`thinking` 事件补 `startedAt`，计时锚点前移到执行起点）                               |
| 票② 代码 | `7c5a6fa`（web：气泡 footer 计时 + 占位气泡 + 状态行去秒；含 `ReplyElapsed.vue`）                        |
| 入库判据 | 两笔均为 `dev` 祖先（`git merge-base --is-ancestor <sha> dev` = YES）；`ReplyElapsed.vue` 在 `dev` 树    |
| carrier  | PR **#124** → merge `44c1d3b`                                                                            |
| 上浮落点 | `docs/plans/agent-reply-elapsed-timer.md`（`status: closed`——2026-09-20 由旧词「在飞」改为统一英文值域） |
| 本 run   | **未清**——G1(c) 只补收口段；目录物理清理归 `docs/run/docs-run-status-gate/` 票 G2                        |

## 票③ fix：计时表补会话维度（跨会话幽灵计时）

**症状（用户实报 2026-09-21 22:45，附真机截图）**：在会话「简历更新」视图里出现一枚**不属于本会话**的占位气泡——店长头像、footer「回复中 · 已 23 秒」逐秒递增；同一时刻右侧成员卡该猫**无橙灯**、队列「暂无排队任务」。用户补充：「一直在走，右侧没灯」「也是偶尔才会触发」，并要求「计时的维度问题也一起修下」。

**取证（店长，活库 + 源码）**：

- 截图归属核对：截图内已完成的店长消息 = `messages.id 0909e164`（`created_at 07:09:47Z`），其 `session_id = b0be526e`（简历更新）。该会话**自 07:09:47 起无任何执行**（`execution_logs` 最后一行 completed），即那枚计时不可能来自本会话。
- 同时段 `execution_logs` 有**跨会话并行执行**：店长 `11bbf854` 在 `afe16ea2`（14:39:39→14:46:53）、ds猫 `1564934c` 在 `c625465e`（14:42:16→running）、吐槽猫 `e0764bc7` 在 `afe16ea2`（14:46:53→running）。同一只猫跨会话并行是本系统的常态，不是异常场景。
- 根因链：`replyTimers` 是 **agentId 单键表**（`chat.ts:124`），载荷 `MessageAgentStatusPayload` **不带 sessionId**（`bus.ts:30` 自述「载荷无 sessionId」；`types.ts:340-354` 字段清单确认），渲染侧唯一过滤是 `activeSession.agentIds`（`ChatPanel.vue:279`）——**每会话成员恒为同样 5 只猫 ⇒ 该过滤恒真，等于没有**。唯一防线是切会话时整体清空（`chat.ts:377`），而清空是同步动作、心跳帧是异步到达：**在途帧在清空之后落表即重新写入条目** ⇒ 幽灵计时。这正是票② 审查留痕的「切会话竞态」观察项，本次取证把它的**结构面**(少一维) 与**触发面**(在途帧) 分开了。
- 对照面：右侧成员面板早已按 (agent, session) 收敛——`storeAgentState` 键为 `sessionId ?? ''`（`chat.ts:239-247`）、读取走 `currentStateFor(agentId)`（`chat.ts:251`），所以面板**正确地**显示空闲（=用户说的「右侧没灯」）。计时表是唯一漏掉这一维的消费面。
- 附带后果：幽灵气泡上的停止按钮走的是**当前会话**（`AGENT_INTERRUPT` 带 `sessionId` = 你正在看的会话），`socketio.ts:584-589` 找不到该 (agent, session) 槽位即幂等 no-op——用户点它停不掉任何东西。

**What to build:** 给计时表补上会话维度，使「当前会话视图里渲染出别的会话的执行计时」在结构上不可能；幽灵气泡与「右侧没灯」的不一致随之消失。

**改动面（契约级）**：

1. `packages/shared/src/types.ts`：`MessageAgentStatusPayload` 补 **`sessionId: string`（必填）**——全部发射点都已握有该值（`bus.ts:31` 是显式首参），加字段向后兼容。`AgentRuntimeState.sessionId` 已存在（`types.ts:43`），不动。
2. server 发射点补齐 `sessionId`：`execution/reply.ts` 四处（`:342` thinking / `:984` replying / `:1068` 心跳 / `:1356` done，函数内已有 `sessionId` 形参）+ `connectors/ingest.ts:390`（queued，用 `effectiveSessionId`）。`bus.ts:30` 的「载荷无 sessionId」注释改为如实描述。
3. web `stores/chat.ts`：`replyTimers` 键改 **`${sessionId}:${agentId}`**（导出/私有 helper `replyTimerKey(sessionId, agentId)`，读写只走它）。写入用 `data.sessionId`；**载荷缺 `sessionId`（旧 server / 乱序）⇒ 不建条目**（宁可无计时，不可错位）。清理三路各用其 sessionId：`done` → `data.sessionId`；`AGENT_STATUS` idle → `state.sessionId ?? ''`；`NEW_MESSAGE` agent 回复 → `msg.sessionId`。切会话整体清空**保留**为兜底（不再承担隔离职责）。
4. web `components/ChatPanel.vue`：`replyTimerFor(agentId)` 改为按 `store.activeSessionId` 取键；`placeholderTimers` 从「遍历全表 + `agentIds` 过滤」改为按当前会话取（**不得再遍历全表渲染**）。
5. **族修扫复述文本**（本单硬要求）：全仓扫「载荷无 sessionId」「无 sessionId 维度」「切会话与 typingStates 同点清空（因载荷无维度）」等**复述该断言的注释/文档**并逐条更新。已知点（不限于）：`execution/bus.ts:30`、`stores/chat.ts:121-122`、`stores/chat.ts:375-376`、`components/ChatPanel.vue:274-275`、`components/ReplyElapsed.vue:12`、`docs/plans/agent-reply-elapsed-timer.md` 实现决策 3/6。

**Out of Scope（不做的）**：不改广播房间路由（`room(sessionId)` 本身是对的）；不给 `AGENT_STATUS`/成员卡加计时；不加新 socket 事件；不改「在途帧」竞态本身（清空保留兜底）；不动 DB/调度。

**验收**：

- [ ] AC1：store 层——注入 `sessionId` ≠ `activeSessionId` 的 `thinking`（带 `startedAt`）帧：`replyTimers` 不产生**当前会话键**的条目，且渲染面 0 个 `.reply-elapsed` / 0 个占位气泡。**须做真空性反对照**：同载荷仅把 `sessionId` 换成当前会话 → 必须渲染（证明断言测的是维度而非「什么都不渲染」）。
- [ ] AC2：store 层——会话 A 与 B 的**同一 agent** 两条 entry 并存；B 的 `done` / `AGENT_STATUS idle` **不删** A 的 entry（跨会话清理不误伤）。
- [ ] AC3：载荷缺 `sessionId` 时不建条目（用 `as` 构造缺字段载荷断言 `replyTimers.has(...) === false`），注释写明理由。
- [ ] AC4：既有 6 条 replyTimers 路径测试（A2A 计时 / m:ss / 无响应 / 切会话清空 / done 删 / idle 删）在改键后**全部更新且全绿**；「切回会话后 ≤10s 心跳恢复原秒数不归零」不回归。
- [ ] AC5：复述文本清单——回执里给出**扫到的文件:行号 + 改后措辞**（店长逐条核对）。
- [ ] AC6：`pnpm test`（全量）+ `pnpm lint` 全绿；`git diff --stat` 自证改动面仅在 shared/server/web 三包 **+ `docs/plans/agent-reply-elapsed-timer.md`**（族修第 5 条要求的规格面订正，属本单应改面）内，无其他越界。〔2026-09-21 订正：原措辞「仅三包内」与族修第 5 条自相矛盾——spec 在记忆白名单里会切片注入每只猫的 prompt，改断言必须连带改文档，否则等于留一份假话在检索面；实施猫按族修优先执行，此处补正票面〕
- [ ] AC7（店长收口验证，实施者不做）：真机 Playwright 合成注入跨会话帧 → 当前会话 0 计时；同帧换本会话 → 计时出现。

**提交**：`catstudy [<40 位真 uuid>] fix(timer): ...`；提交后按 `request-review` 发起审查，收口归店长。

## 收口（2026-09-21 · 票③）

| 项       | 值                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 票③ 代码 | `6d22560`（基点 `4d2abb72`；13 文件 +256/−65——`shared` 载荷补 `sessionId` + server 五处发射点 + web 键控改 `${sid}:${agentId}`） |
| 入库判据 | `git merge-base --is-ancestor 6d22560 dev` = **YES**；`replyTimerKey` 在 `dev` 树（`stores/chat.ts:103`）                        |
| carrier  | PR **#169** → merge `30599dbc`（closeout 隔离分支 carry 已审 sha 字面量，dev 已前进故 ff-only 不可行）                           |
| 上浮落点 | `docs/plans/agent-reply-elapsed-timer.md`（本票新增**决策 9**：计时键 = `sessionId:agentId` 二元组）                             |
| AC7 状态 | **未验**——本票含 `shared`/`server` 改动，须重启运行实例后才可做真机合成注入验证；归收口重启后由店长补做                          |
| 本 run   | **未清**——目录物理清理归 `docs/run/docs-run-status-gate/` 票 G2                                                                  |

**族修边界订正（审查留痕）**：`docs/run/eval-system/R12-dce2bc9-restating-family-sweep.md:52` 把 `bus.ts:30` 归为「**另一语义**（stream/abort 遗留兼容），不属族B」——该归类**自本票起过时**：`bus.ts:30` 恰是本票族修的家族成员之一，现已改为「载荷内另有同值 sessionId 供前端会话键控」。属 R12 那份**历史审计记录**的时点性陈述，不改写历史文档，仅在此留痕；后续同类族修扫描时勿再据该行排除 `bus.ts`。

## 收口（2026-09-21 · A单 / C单：env 派生断言钉值）

同一族的两单，均为**测试文件**改动（无运行时代码，**不需要重启**），修的是「断 env 派生默认值」这种假绿门。

| 项       | A单                                                                                                  | C单                                                     |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 已审 sha | `43b90d5a`（`reply.test.ts` +14/−4）                                                                 | `4d543cd4`（`routes/eval.test.ts` +12/−2）              |
| 真源     | `memory/index.ts:174 currentRetrievalParams()` 现读 env                                              | `eval.ts:272` / `eval.ts:561` `envNumber(...)` 现读 env |
| 入库判据 | `git merge-base --is-ancestor 43b90d5a dev` = **YES**                                                | `git merge-base --is-ancestor 4d543cd4 dev` = **YES**   |
| carrier  | PR **#167** → merge `4d2abb7`（closeout 隔离分支 carry 已审 sha 字面量；dev 已前进，ff-only 不可行） | PR **#170** → merge `13c4c96c`（同范式）                |

**机制订正（审查者点名入账，两种不同巧合，比 A单 更隐蔽）**：

- A单 的失效是「**外部值真偏离默认**」——`.env:50 MEMORY_TOP_K=5` vs 真源默认 `3`，改值即红，**现行红**（一度卡死全仓提交口）。
- C单 的两处是**潜伏**，且各自靠一种巧合才没红：
  - `EVAL_LABEL_MIN_COUNT` —— 靠「**未设回落**」（本机未设该变量 ⇒ `envNumber` 回落到与断言相等的默认值 30）；
  - `EVAL_CHAIN_SLOW_MS` —— 靠「**预设值恰等于默认**」（`env.ts:140` 的 `process.env.EVAL_CHAIN_SLOW_MS ??= '300000'` 预设值刚好等于真源默认 300000）。
- 共同教训：**「断默认值」在现读 env 的真源面前不是断言，是巧合**。钉**非默认值**（A单 4/0.7、C单 600000/50）才能区分「读 env」与「写死默认」两种实现——审查者以负向对照（临时写死真源 → 必红）逐条复现坐实。

**未改并说明**：`eval.test.ts:1266` `expect(limit).toBe(30)` —— 真源是 `eval.ts:441` `parseBoundedInt(rawLimit, 30, 1, 200)` 的**编译期字面量**，非 env 派生，改 env 打不红 ⇒ 不属本族（店长派活前横扫 `eval.ts` 全部 env 读取点，实核只有 `:272`/`:561` 两处）。

**OQ 裁决（店长）**：两单审查者均提「用例内 `vi.stubEnv` vs 块级 `beforeEach`」——**维持用例内写法**，不立文件内约定：stub 紧贴断言自文档化，且把一个「本用例依赖 env」的事实留在代码里，块级 stub 会把它抹掉。

**给后续的提醒**：`.env.example:97/:106` 恰好注释着 `EVAL_CHAIN_SLOW_MS` / `EVAL_LABEL_MIN_COUNT` 的示例值——下次谁照着解开就是本轮路障的重演；A单/C单 修完后两条通道（普通终端手跑 / 猫链继承 `.env`）均已免疫（审查者以敌意 ambient 实测两单各自全绿）。

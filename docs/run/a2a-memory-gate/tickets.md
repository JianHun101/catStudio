# T-1 `a2a-memory-gate` —— a2a 时不检索【相关记忆】

**基线**：`session/15f84dfe @ 3bbe3f4`（店长派活单实测行号）；**实施基线** = `dev @ 4fc7a5f`
（worktree `feat/a2a-memory-gate`）。两基线之间 `serial.ts` 已有 37 行增量，故行号以本
worktree 实测为准（下表 `::` 后为本分支实测值，非票面原值）。

**派活单来源**：店长直投本猫的路由信号（`73275887-a07a-4ce4-b4ae-d09a5a62eb22` 为触发消息）。

---

## 一、需求（两条，均可证伪）

① a2a 触发（触发者是猫）时，`retrieveMemoryContext` **零调用**；
② 用户触发时照常调用（现状不变）。

**范围裁决**（用户）：【相关记忆】**关**；【知识库】**保持注入不动**（a2a 高频场景正是审查与
实施，ADR/规范等权威数据仍要查）。

## 二、契约（店长拍板项，实施未改）

1. **判据唯一**：`triggerMsg.fromAgent`，来源 = DB `messages.role === 'agent'`。
   **禁止**用 `authorName` 真值推断（该字段被 `resolveRolePlaceholders` 复用，语义会漂）。
2. **门控行为**：`fromAgent && !MEMORY_A2A_ENABLED` → 跳过检索 + 跳过改写，不写索引。
3. **不许静默**：跳过必须留痕——`retrieval_events` 落一行 `reason='skipped-a2a'`，
   结果形状与其它空结果同构。`retrieval_events.reason` 是 `TEXT NOT NULL` 无 CHECK ⇒ 零迁移。
4. **span 不许撒谎**：`memory.retrieval` 段 status 必须是 `'skipped'`（不许 `'ok'`／`'error'`）。
5. **不加签名参数**：`retrieveMemoryContext` / `buildKnowledgeContext` 签名不动。

## 三、边界（Out of Scope）

- 不动知识库链路；不改记忆模块内部逻辑；不动用户侧行为；`retrieval_events` 表零改动。
- **不覆盖**：经 ingest 投递、以 `user` 身份落库的猫间消息 ⇒ 实测结果见 §六。

## 四、改动文件（本分支实测行号）

| 文件                                                 | 改动                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `execution/serial.ts::158-188`                       | `AgentTriggerMsg` 加 `fromAgent: boolean`（**必填**）                                |
| `execution/serial.ts::190`                           | 新增并导出**唯一判据** `isAgentAuthoredTrigger(role)`                                |
| `execution/serial.ts::321-337`                       | `buildTriggerMsg` 填 `fromAgent: isAgentAuthoredTrigger(triggerRow?.role)`           |
| `execution/serial.ts::435-452`                       | `drainQueuedCommand` 的 `queuedTrigger` 同判据填值（**第二权威构造点**，见 §五）     |
| `execution/serial.ts::1141`                          | A2A 递归 `{ ...agentTrigger, authorName, fromAgent: true }`（类型完整性，非判据）    |
| `execution/reply.ts::302`                            | `runAgentReply` 内联 `triggerMsg` 形状加 `fromAgent: boolean`（必填）                |
| `execution/reply.ts::206` / `:766`                   | 值域注释 9 → **10**；「六种 reason」→ **七种**                                       |
| `execution/reply.ts::770-812`                        | a2a 门 + 跳过走同套 span/落库/日志                                                   |
| `execution/recovery.ts::102` / `:362` / `:509`       | `executeAgentsSerial` 入参补 `fromAgent`（类型必填所致，非判据面）                   |
| `connectors/ingest.ts::301` / `:400`                 | 同上（`msg.role` 恒 `'user'` ⇒ 恒 false）                                            |
| `db/repository/retrievalEvents.ts::121`              | `reason` 列注释值域 9 → **10**                                                       |
| `memory/index.ts::105` / `:244` / `:258`             | 枚举加 `'skipped-a2a'`；新增导出 `isA2aMemoryEnabled()` / `skippedRetrievalResult()` |
| `.env.example`                                       | 加 `MEMORY_A2A_ENABLED`（默认**关**，只有 `'1'` 才开）                               |
| `docs/run/eval-system/P2-design-retrieval-events.md` | 值域复述订正（保留 P2 历史读数 + 加 2026-09-20 订正注）                              |
| 11 个 `.test.ts` 的 `memory/index.js` partial 替身   | 补镜像两个新导出（否则 `fromAgent:true` 时调用点 TypeError）                         |
| 88 个测试 `triggerMsg` 字面量                        | 补 `fromAgent: false`（验收 9）                                                      |
| **新增** `execution/serial.a2a-memory-gate.test.ts`  | 七条用例：门开合、span status、流水 reason、参数快照、知识库不受波及                 |
| **新增** `memory/index.test.ts` 末段                 | `MEMORY_A2A_ENABLED` 读法矩阵 + 跳过结果形状                                         |

## 五、越出票面的两处（均为类型必填的机械后果，非契约变更）

1. **`AgentTriggerMsg` 的构造点不止票面说的两处**，实测 **5 处**：
   `buildTriggerMsg`（权威）、`drainQueuedCommand` 的 `queuedTrigger`（**第二权威**——
   drain 直接调 `executeOneAgent`、**不经** `execute()`，reply 侧读到的就是这一份）、
   A2A 递归、`recovery.ts` 恢复路径字面量、`ingest.ts`/`recovery.ts` 三处传 `msg`。
   后四处填值语义正确但**不进 `makeCmd`**，不承担判据职责。
   ⇒ 据此新增 `isAgentAuthoredTrigger()` 单点判据，避免同一条规则写多份而分叉。
2. **`recovery.ts` / `ingest.ts` 不在票面文件表内**：`fromAgent` 必填 ⇒ 编译器逐点报错。
   首轮 lint 共 **89 处**（88 处在测试的 `triggerMsg` 字面量、1 处在 `serial.ts::461`
   的 drain 构造点；`recovery.ts` / `ingest.ts` 的补值先于该次 lint 完成，故不在读数里）。
   按 D15 同款理由（忘标要变成编译错误）全部补实值，未改任何控制流。

## 六、实测回报（店长点名要看的那条）

**问**：经 ingest 投递的猫间消息，落库 `role` 是什么？

**答**：`role='user'` —— 与 `origin` 无关。源码单点：`connectors/ingest.ts:301`
`role: 'user' as const`（注释：DB role 有 CHECK 约束，类型不落库）；而
`routes/messages.ts:233` 对 REST 注入**显式**传 `origin: 'agent'`。

**dev 活库读数**（`cat-study-dev.db`，只读打开）：

| 消息类别                                     | role='agent' | role='user' |
| -------------------------------------------- | ------------ | ----------- |
| 含「请审查」（审查请求）                     | **145**      | 0           |
| 含「请补填以下交接文档」（handoff-gen 投递） | 6            | **111**     |

⇒ **审查请求全部落在门内**（它就是猫的回复本体，`role='agent'`）；**handoff-gen 投递的
补填提醒 111 条落在门外**，仍会注入【相关记忆】。按派活单要求**只回报、未自行扩判据**。

## 七、验收对账

| #   | 判据                                          | 落地                                                                                                                                                                                                        |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fromAgent:true` + env 关 → 不调用            | `serial.a2a-memory-gate.test.ts` 验收 1/5                                                                                                                                                                   |
| 2   | `fromAgent:false` → 调用发生                  | 同文件 验收 2/6                                                                                                                                                                                             |
| 3   | `fromAgent:true` + env 开 → 调用发生          | 同文件 验收 3；`memory/index.test.ts` env 矩阵                                                                                                                                                              |
| 4   | 跳过时 span status === `'skipped'`            | 同文件 验收 4（另断言 `error_type` 为 null）                                                                                                                                                                |
| 5   | 跳过时改写零调用                              | 同文件 验收 1/5（真 `retrieveMemoryContext` + 改写器替身）                                                                                                                                                  |
| 6   | `buildTriggerMsg` 真 DB 行判据                | **改为经引擎实测**（真落 `role='agent'` / `'user'` 行 → 观察门开合），比直测映射更强；见 §八 偏差 1                                                                                                         |
| 7   | 扫复述文本                                    | 见 §四 最后三行；另扫到 `scripts/eval/retrieval-baseline.mjs` 的 `LEGIT_EMPTY_REASONS`——**刻意不改**（`skipped-a2a` 不由 `runRetrievalChain` 产出，进不了那条路径；改白名单反而削弱其「值域外即拒」的设计） |
| 8   | `pnpm test` + `pnpm lint` 全绿                | 151 文件 / 3273 用例全过；lint 三包全过                                                                                                                                                                     |
| 9   | 字面量补 `fromAgent: false`，字段不降级为可选 | 88 处补值；字段在 `AgentTriggerMsg` 与 reply 内联形状**两处均为必填**                                                                                                                                       |

## 八、实施偏差与真空性对照

1. **验收 6 由「直测 `buildTriggerMsg`」改为「经引擎 + 真 DB 行实测」**：`buildTriggerMsg`
   未导出（导出要动模块公开面），而经引擎实测覆盖的是**整条生产路径**（DB 行 → 反查 →
   门 → span/流水），严格强于直测映射。同时保留一条反向对照：入参 `fromAgent` 恒 `false`
   而 DB 行 `role='agent'` ⇒ 若实现改成读入参，该用例当场变红。
2. **真空性反对照（已实测，非断言）**：把门临时改成恒 `false` 后重跑，新文件 **7 过 4 红**
   —— 红的正是验收 1/4/契约 3/验收 6 四条，绿的正是用户侧 / env 开 / 知识库三条。探针
   非恒绿。改回后 7/7 全过。
3. **`skippedRetrievalResult()` 的 `retrievalMs` 取 0**（非调用点实测耗时）：那是「检索跑了
   多久」的读数，而这次没有跑；填真实微秒数会把「跳过」渲染成「极快的一次检索」。
   span `duration_ms` 与 `retrieval_events.retrieval_ms` 因此同源为 0（双写同源不破）。
4. **`buildTriggerMsg` 反查不到行时 `fromAgent=false`（fail-open）**，与 `authorName` 现状
   同向。理由：这一侧的失效形态是「多注入一段记忆」；反向 fail-closed 会把一次 DB 抖动
   静默翻译成「本条是 a2a」，把读库失败变成行为改变。

## 九、Open Questions（留给收口/后续裁决）

- **OQ-1**：handoff-gen 的 111 条「补填提醒」落在门外（§六）。要不要把判据从「DB role」
  扩到「`origin==='agent'`」（该值今天在 ingest 入口就有、只是不落库）？扩判据 = 契约变更，
  本猫不自行改。
- **OQ-2**：`skipped-a2a` 落进 `retrieval_events` 后，`episodeStats` / 看板类消费面若按
  `reason` 分组统计，需要把这一档与「空手而归」分开读（本单未动任何消费面）。

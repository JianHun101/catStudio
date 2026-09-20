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
| ~~`execution/serial.ts::190`~~ → `execution/row.ts`  | 新增并导出**唯一判据** `isAgentAuthoredTrigger(role)`（**F1 后搬家**，见 §十）       |
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
| `.env.example`                                       | 加 `MEMORY_A2A_ENABLED`（默认**关**；读法订正为 `1`/`true` 两种拼法——F2，见 §十）    |
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

## 十、审查返工（吐槽猫 ⚠️，F1–F4 逐条处置）

### F1（阻断，已修）· 本笔新引入 2 个模块环

审查者用环检测器实测：父提交 **0 环** → 本分支 **2 环**，两条都经 `ingest.ts` 新增的
`import { isAgentAuthoredTrigger } from '../execution/serial.js'` 闭合：
`serial→flow-advance→ingest→serial` 与 `worktree-fanin→ingest→serial→reply→worktree-fanin`。

**修法照审查者给的方案**：函数搬到 `execution/row.ts`（叶模块，只有两个 `import type`）
——`serial.ts` / `ingest.ts` / `recovery.ts` 三方**本来就都在 import 本文件**，一条新边
都不用加。`row.ts` / `ingest.ts` 文首都加了「别搬回去 / 别加值导入」的理由，防复发。

**本猫自写检测器三版对称实测**（不转述审查者读数）：

| 版本                      | 值导入边 | 环                  |
| ------------------------- | -------- | ------------------- |
| 父提交 `4fc7a5f`（基线）  | 309      | **0**               |
| 被审 `c94eac8`（F1 未修） | 310      | **1 个 5 节点 SCC** |
| 工作树（F1 修后）         | **309**  | **0**               |

计数口径要对齐：审查者报的「2 环」是**圈（elementary cycle）**口径，本表是**强连通分量
（SCC）**口径——同**一处**缺陷，两个单位，不是两个缺陷。被审那 1 个 SCC 的成员 =
`{serial, flow-advance, ingest, reply, worktree-fanin}`，审查者列的两条圈正是它内部的
两条回路。值导入边回到**恰好 309**（与父提交同数）——搬走的是一条边、没添新边。

**顺带订正两处被这条改动证伪的复述文本**（验收 7 的同一把尺子）：

- `AgentTriggerMsg.fromAgent` 的类型注原写「**只有一个权威构造点**」——错，drain 是
  **同权的第二处**；且它列的「不承担判据职责」名单里没有 drain，读者会以为 drain 不权威。
- `isAgentAuthoredTrigger` 的文档注原写「两个真实构造点（`buildTriggerMsg` 与 **recovery**
  的恢复路径）」——也错：recovery 走 `executeAgentsSerial` → `execute()` → `executeRun`，
  reply 侧读到的是 `buildTriggerMsg` 重建的那一份，**recovery 不是构造点**，真第二处是 drain。
  两处现统一为「判据面恰两条：`buildTriggerMsg` + `drainQueuedCommand` 的 `queuedTrigger`」。

### F2（观察，**已采纳**，改法与审查者预设方向不同）

原实现 `=== '1'`，`MEMORY_A2A_ENABLED=true` 会被静默读成「关」。**没有**改用全仓宽松惯例
`!== 'false'`——实核发现那条更糟：它会让 `.env.example` 已写明的 `=0`（关闭）**反转为启用**。
改为收 `1` / `true` 两种拼法（trim + 大小写不敏感），其余一律落默认关（fail-closed）。
同步改 `.env.example` 行、`memory/index.test.ts` 读法矩阵。

**这个读法不是新造的**：`scripts/handoff-gen.mjs` 的 `isForceDeliver` 逐字同款
（`String(raw ?? '').trim().toLowerCase()` + `v === '1' || v === 'true'`），连理由都一样
——该函数注释写着「不做『非空即真』，否则 `CATSTUDY_FORCE_DELIVER=0` 这种手滑会静默变成
『强制投递』」。同一个失效形状，照抄在仓先例。审查者建议的 `!== 'false'` 那条惯例**不能照抄
到本处**：本开关的默认侧是「关」且 `.env.example` 明写 `0=关闭`，宽松惯例会把 `=0` 反转成
启用——惯例要按**默认侧方向**选，不能按字符串长相选。

### F3（观察，**未改**，报判断请裁）

`MEMORY_ENABLED=false` 时 a2a 轮次记成 `skipped-a2a`（未记 `not-enabled`）。判断：**是真
问题但很窄**——记忆整体关的场景只出现在测试环境（生产 `MEMORY_ENABLED` 为开），该组合下
`skipped-a2a` 只影响流水口径分析。**不自行改的理由**：① 它落在**契约 3/4 的语义面**（reason
优先级 / span status），要改得先问店长；② 正确修法要在调用点读全局开关 ⇒ `memory/index.js`
**新增第三个被消费导出**，正是审查者 OQ-4 点名的 partial 替身镜像面（现 11 个文件手工镜像
两个导出，加第三个就多 11 处可漏点）。**建议修法**：`a2aMemorySkipped` 加一个
`isMemoryEnabled()` 合取项，让 `not-enabled` 优先。等裁决。

### F4（建议同批补，**已补**，且第一版是错的——见下）

新增第 8 条用例：三条命令抢同一槽位（head 直跑 + **两条**入队），head 收口时
`drainQueuedCommand` 补执行第二条、第二条收口时再 drain 第三条。两条被 drain 的触发
**一 `role='user'`（对照）一 `role='agent'`（判据）**，两组断言因此都打在 drain 这个构造点上。
另加**结构见证**：`execute` 决策段全同步 ⇒ 三行 `engine.execute(cmd)` 返回时立即断言
`getSlot().queueLength === 2`，证明后两条真的走了入队→drain，不是三条直跑。

**第一版写错了，探针抓出来的**（留痕，别照旧抄）：初版只放「一条直跑对照 + 一条入队判据」，
并在文档里断言「两半都断」。**探针 2（把 drain 的 `fromAgent` 写死 `true`）跑出来是绿的**
——因为直跑的那条走 `execute() → executeRun → buildTriggerMsg`，**根本不经过 drain**，
它当对照组等于没对照，用例退化成单侧。改成「两条都在 drain 上」后重跑：
探针 1（写死 `false`）红在判据组（`expected 'embed-failed' to be 'skipped-a2a'`）、
探针 2（写死 `true`）红在对照组（`expected 'skipped-a2a' not to be 'skipped-a2a'`），
7 绿 1 红、两侧各中一次。**教训**：写了「两半都断」就**必须两半各探一次**——
只探一半的探针会把「对照组走的是另一条路径」这种结构性空转放行。

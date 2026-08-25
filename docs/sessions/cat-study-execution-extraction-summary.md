# cat-study-execution-extraction Summary

## What

候选 1「Connector 成了业务核心」的实施：把 3014 行的 `connectors/socketio.ts` 拆成薄传输层 + `packages/server/src/execution/` 执行引擎。**1-4 刀 + DB 分离全部完成**（每刀独立 commit、全绿、可回滚）：

| 刀       | commit  | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 决策留痕 | a188f21 | CONTEXT.md 新增 **Execution（执行引擎）** 词条 + Message Bus 补注；ADR 草稿 `docs/adr/draft-execution-engine-extraction.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 第 1 刀  | 86341bb | 纯函数组（提示构建/上下文过滤/摘要压缩）→ `execution/hints.ts` + `execution/context.ts`；45 个测试 co-located 迁入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 第 2 刀  | 02766c5 | `runAgentReply` → `execution/reply.ts`（8 处 emit 换 bus、performHandoff 收窄、状态 accessor）；`execution/bus.ts`（EngineBus 6 方法 + HandoffBus 2 方法纯类型）+ `execution/state.ts`；shared 新增 MessageAgentStatus 联合 + 5 个载荷类型；`createSocketBus(io)` 适配器落 connector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 第 3 刀  | e0b202e | 执行循环（executeOneAgent/executeAgentsSerial/drainQueuedCommand）→ `execution/serial.ts`（含执行常量、AgentTriggerMsg、agentHasUsableApiKey、`createExecutionEngine(bus)` 工厂）；`execution/row.ts`（rowToAgent）；state.ts 扩充（activeAborts/锁/mention 配额/M1 频控）；socketio.ts 1110 行（构造注入 `_engine` + **executeAgentsSerial 兼容包装**，55 处测试与 ingest/恢复路径零改动）                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.5 刀   | 8d0b405 | **模块态 → 实例态**：state.ts 6 个 Map/计数收进 `createEngineState()` 工厂实例字段（run 注册表合并 activeAborts+activeStreams、撤回标记、锁引用计数、M1 频控、mention 配额跨 run 存活）；`finalizeRun` 统一五处 completeExecution 收口（endRun 单点清理幂等）；reply/serial 经 `state: EngineState` 参数消费；connector 经引擎 accessor 委托（internal.ts 零改动）；createSocketIO **单例 fail-fast**（热重启双注册表防护 + `__test_resetEngine` 测试复位）；**假 bus 形态 a 测试 8 例落地** `execution/serial.test.ts`（真实 SQLite + 真实 dispatch + 假 bus——配对链首次真实测试）                                                                                                                                                                                                               |
| 第 4 刀  | e9928d2 | **断环收口**：ingest/index/eval 断 connector 依赖——`execution/registry.ts` 单例注册表（set/get ExecutionEngine + ExecutionBus）+ `execution/recovery.ts` 三条恢复路径迁入（bus 注入 + 引擎经注册表）；bus.ts `emitAgentMessage`→`emitMessage`（ingest 与 agent 回复共用）+ HandoffBus 增 `emitSessionHandoffToRoom`；ingest 广播/执行经 registry 寻址（守卫 `if (io)`→`if (bus)`，rowToAgent 走 execution/row.js）；attribution `runEpisodeAttribution(bus)` 返回 needReplay 由 index.ts 消费（triggerReplayCheck 删除）；l1-aggregator 改 bus.emitSystemNotice；socketio.test.ts 52 处 executeAgentsSerial 改引擎 accessor + 26 处恢复调用改 bus（connector spy 穿 createSocketBus 零重写）；messages/connectors 测试 vi.mock 改 registry、attribution/l1 测试 io 夹具改假 bus + needReplay 断言 |
| DB 分离  | 923725f | ADR 决策 9 落地（独立 commit）：dev.js `--mode production` → NODE_ENV=production（spawn 注入，undefined 不进 env）；db/index.ts 按 NODE_ENV 选库（production → cat-study.db 主库 / 其他 → cat-study-dev.db 实验库）；dev.js 执行保护窗 DB_FILE 同源切库；package.json 增 `pnpm start`；CLAUDE.md 命令表补双库说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**当前 socketio.ts 状态**：**609 行**（原 3014）——纯传输层（handlers/bridges/restart 广播）+ 兼容委托/re-export；恢复区已迁 execution/recovery.ts、executeAgentsSerial 兼容包装已删。socketio.test.ts 6096 行（未瘦身，ADR 决策 8 挂后续单）。

## Why

- 两份独立走查（本 review + opencode 报告）收敛于「拆 socketio god-module」
- 「dispatch 标 busy → connector 执行」的配对仅靠注释维持，事故史实锤（卡死槽位/幽灵 running）
- socketio.test.ts 5902 行 mock 掉全部接线——真实链路从未被测；搬完后 connector 的 spy 天然穿过 bus，测试零改动即覆盖新链路

## Tradeoff

- **bus 注入（design B 主体 + A 适配器嫁接）**：引擎窄化视图 6 方法发不出未类型化事件；否掉 C（事件流）——「必 drain」是注释契约，与仓库注释契约失败史同型
- **兼容包装**：第 3 刀保留 `executeAgentsSerial(io, ...)` 旧签名委托引擎（第 4 刀删）——55 处测试调用点零改动，换来切片可独立审查
- **测试策略微调**（相对原计划）：connector 侧 mockIo 的 `to().emit` spy 穿过 createSocketBus，现有 145 用例零改动覆盖新链路；假 bus 形态 a 单元测试随 3.5 刀工厂落地
- **搬家零行为变化**：日志通道沿用 'socketio'、控制流零重排；暴露的真 bug 记观察项不混入搬家刀
- **未做**：SESSION_HANDOFF 整体房间化（ADR 待确认）；socketio.test.ts 瘦身（ADR 决策 8，挂后续单）

## Open Questions

1. ADR 编号（收口时分配；0010 可能已留给知识库二期）
2. SESSION_HANDOFF 整体房间化裁决：ingest 重定向路径已房间化（emitSessionHandoffToRoom）；handoff performHandoff 的全局 emit 未动——两形态并存记录在 bus.ts，是否整体房间化待裁决
3. ~~3.5 刀 + 第 4 刀派活拆分~~ → 已定：未拆单，本线连续推进完成（每刀独立 commit 等效可独立审查）

## Next Action

### 必须知道的操作细节（新 token 直接继承）

1. **提交必须带环境覆盖**（否则 pre-commit 钩子的全量测试被本机 env 漂移打挂）：
   ```bash
   ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash git commit -m "..."
   ```
   根因：本机 Windows 注册表两个用户环境变量是 `deepseek-v4-flash[1m]`，`npx` 经 `.cmd` 垫片 → cmd.exe 从注册表重注入；`env -u` 拦不住。claude buildEnv 测试断言代码默认 'deepseek-v4-flash'。（实测：带上环境覆盖后该测试转绿。）
2. **两个间歇性 flake**（已记 ADR 观察项，根修另开单）：摘要压缩组（验收3 等）+ 并发重叠测试。提交时钩子偶挂，重试即可；单跑也可能挂一次、再跑即绿——**判定 flake 的方法：重跑一次看是否转绿**。
3. 测试命令：`cd packages/server && npx vitest run`；lint：仓库根 `pnpm lint`。
4. **新测试文件**：`execution/serial.test.ts` 已 `git add` 进 3.5 刀 commit；后续新文件记得先 add 再 `commit --only`（untracked 文件不在 --only pathspec 内会报错）。
5. post-commit hook 未投递 handoff-draft 属正常（无 uuid 标记），`.handoff-draft.md` 已 gitignore，不扫入提交。

### 3.5 刀（模块态 → 实例态）✅ 已收口（8d0b405）

- state.ts 6 个 Map/计数收进 ExecutionEngine 实例字段（createEngineState 工厂）；finalizeRun 统一五处收口；run 注册表合并 activeAborts+activeStreams；mentionCounts 跨 run 存活
- 单例 fail-fast 断言（createSocketIO 重复调用抛错 + `__test_resetEngine` 测试复位——socketio.test.ts 5 处 createSocketIO 前加复位）
- 假 bus 形态 a 测试 8 例落地（真实 SQLite + 真实 dispatch + 假 bus）

### 第 4 刀（恢复路径 + 断环）✅ 已收口（e9928d2）+ DB 分离（923725f）

> 收口时点：待续清单 1-11 全部执行完毕；socketio.ts 3014 → **609 行**；全量 server
> 1185/1185（env 覆盖）+ lint 三包全绿。提交前曾按用户要求停手移交一次（中途态交接
> 记录保留在下节「第 4 刀进行中交接档案」）。

- 断环收口：ingest/index/eval 零 connector 依赖（registry 单例寻址 + bus 注入 + rowToAgent 走 execution/row.js）；非测试 import socketio 仅剩 index.ts（createSocketIO）/internal.ts（getActiveStream）/sessions.ts（getIO）三处合理委托
- attribution 返回 `{dispatched, resolved, needReplay}`，index.ts 消费触发 replayStuckUserMessages；attribution.test.ts 补 needReplay 双面断言（replay 分流 true / 幂等轮 false）
- socketio.test.ts：52 处 executeAgentsSerial 改引擎 accessor + 26 处恢复调用改 bus（实际 9+8+9=26）；mockIo 的 to().emit spy 穿 createSocketBus 零重写
- DB 分离（ADR 决策 9，独立 commit 923725f）：dev.js `--mode production` → NODE_ENV（undefined 不进 env）；db/index.ts 按 NODE_ENV 选库；dev.js 保护窗 DB_FILE 同源切库；`pnpm start` 入 package.json + CLAUDE.md；实测双模式开库正确
- ADR 草稿复核：决策 2/8/9 与实施差异回写（emitMessage 更名、测试未瘦身挂后续单、DB 分离完成）；flake/buildEnv 两观察项仍开

### 第 4 刀进行中交接档案（历史记录，已完结）

> 交接时点：3.5 刀已收口（8d0b405 + ea0d859）；第 4 刀动了一半后按用户要求停手移交。
> 后续 token 已按「待续（按序执行）」1-11 全部收口（e9928d2 + 923725f），本节留档备查。

#### 已完成（工作树内，未提交）

1. `execution/bus.ts`：`emitAgentMessage` → **`emitMessage`** 更名（ingest 用户消息与 agent 回复共用完整 Message 通道，role 由载荷决定）；HandoffBus 新增 **`emitSessionHandoffToRoom(sessionId, e)`**（ingest 重定向房间广播——与 handoff 全局形态并存，OQ2 房间化裁决独立进行）
2. `execution/registry.ts`（新文件）：`setExecutionEngine/getExecutionEngine/setExecutionBus/getExecutionBus/__test_reset`——进程内单例注册表（getIO 同款服务定位惯例），断开 ingest↔socketio ESM 循环的锚点；双注册表防护仍由 createSocketIO fail-fast 承担
3. `execution/recovery.ts`（新文件）：三条恢复路径从 socketio.ts 迁入，签名 `(bus: EngineBus & HandoffBus)`，engine 经 `getExecutionEngine()!` 取（引擎未初始化时 TypeError——与旧 `_engine!` 同语义）；`REPLAY_STUCK_WINDOW_MINUTES` 随迁；打断告警广播改 `bus.emitSystemNotice`
4. `execution/reply.ts` + `execution/serial.test.ts`：emitMessage 更名跟进
5. `connectors/socketio.ts`（617 行）：createSocketIO 注册 registry（setExecutionBus/setExecutionEngine）、fail-fast 改经 `getExecutionEngine()`、5 处 handler 改经 `getExecutionEngine()!`、启动恢复改调 recovery 导入函数（传 `getExecutionBus()!`）、createSocketBus 补 emitMessage + emitSessionHandoffToRoom、**executeAgentsSerial 兼容包装已删、恢复区已删**。⚠ **未清未用 import**（executeAgentCommand/DispatchCommand/initAgentSlot/AgentConfig/rowToAgent 本地导入/SessionRow/AgentRow 等）——tsc 未跑

#### 待续（按序执行）

1. socketio.ts 清未用 import → `npx tsc --noEmit` 收敛到「仅 ingest/attribution/index 断链错」
2. **ingest.ts 断环**：`import { getIO, rowToAgent, executeAgentsSerial } from './socketio.js'` → rowToAgent 从 `'../execution/row.js'`、getExecutionEngine/getExecutionBus 从 `'../execution/registry.js'`；三处 io 广播（NEW_MESSAGE 用户消息 / SESSION_HANDOFF 重定向 / MESSAGE_AGENT_STATUS queued）改 `bus.emitMessage` / `bus.emitSessionHandoffToRoom(sessionId, ...)` / `bus.emitAgentMessageStatus(sessionId, ...)`；执行改 `getExecutionEngine()!.executeAgentsSerial(...)`；守卫 `if (io)` → `if (bus)`
3. **index.ts**：`replayStuckUserMessages + REPLAY_STUCK_WINDOW_MINUTES` import 改自 `'./execution/recovery.js'`；replay 定时器 `replayStuckUserMessages(getExecutionBus()!)`；l1/episode 定时器 `runL1Aggregation(bus)` / `runEpisodeAttribution(bus)`
4. **eval/attribution.ts**：删除 `import { replayStuckUserMessages } from '../connectors/socketio.js'`（断 eval→socketio 环）；`runEpisodeAttribution(io)` → `(bus)`（dispatchAction 广播改 `bus.emitSystemNotice`）；返回 `{dispatched, resolved, needReplay}`（内部 triggerReplayCheck 调用删除，needReplay 由 index.ts 消费 → replayStuckUserMessages(bus)）
5. **eval/l1-aggregator.ts**：`runL1Aggregation(io)` → `(bus)`，broadcastAlert 改 `bus.emitSystemNotice`
6. **socketio.test.ts 调用点迁移**：
   - 顶部加 `import { getExecutionEngine, getExecutionBus } from '../execution/registry.js'` + `import { recoverInterruptedExecutions, recoverQueuedMessages, replayStuckUserMessages } from '../execution/recovery.js'`
   - 52 处 `mod.executeAgentsSerial(` + 次行 `mockIo as any,` → `getExecutionEngine()!.executeAgentsSerial(`（删 mockIo 行）
   - 25 处 `mod.recoverXxx(mockIo as any)` → `recoverXxx(getExecutionBus() as any)`
   - fail-fast 用例 `expect(() => mod.createSocketIO(httpServer)).toThrow(...)` 不变
7. **messages.test.ts / connectors.test.ts**：`vi.mock('../connectors/socketio.js', ...)` → `vi.mock('../execution/registry.js', ...)`（getExecutionBus/getExecutionEngine 返回 null → ingest 广播/执行跳过，与旧 getIO→null 同语义）；rowToAgent 改走真实 execution/row.js（connectors.test.ts AC2-1 断言 `['agent-ds']` 应保持成立）
8. **attribution.test.ts / l1-aggregator.test.ts**：`const io = { to: ... }` 夹具改假 bus（`emitSystemNotice: (n) => roomEmit(Events.NEW_MESSAGE, {...n, role: 'system'})`，镜像 createSocketBus）
9. 全绿（env 覆盖下）+ lint + 提交（新文件先 add；commit 用 `--only` 限定路径）
10. **DB 分离**（ADR 决策 9，可独立 commit）：dev.js 加 `--mode production` → NODE_ENV；db/index.ts 按 NODE_ENV 选库（production → cat-study.db / 其他 → cat-study-dev.db）；日常真实使用跑 `pnpm start`
11. 收尾：ADR 观察项复核、socketio.ts 最终行数核验（目标 ~1100 行，当前已 617）

### 候选池剩余（本轮未动）

候选 2（dispatch 配对结构化 + 实例态深化）、候选 3（wire 契约 shared 化）、候选 4（三套摘要系统）、候选 5（Memory 泄漏 repo 词汇）、候选 6（web store Connector seam）、候选 7（展示契约重复）、候选 8（DB 单例 ×14 + schema ×2，含测试库文件化）、opencode 报告 #2（LLM adapter spawn 生命周期）、#4（行映射收口）。另挂：socketio.test.ts 瘦身（ADR 决策 8）、两族 flake 根修、SESSION_HANDOFF 整体房间化裁决。

### 工作区状态

- 用户未提交改动勿碰：`packages/web/src/components/AgentEditModal.vue`、`packages/web/src/views/SettingsView.vue`
- 第 4 刀 + DB 分离已全部提交（e9928d2 + 923725f）；工作树仅剩本文档改动（未提交）
- 运行时提示：dev 模式现在用实验库 cat-study-dev.db（`pnpm dev` 首次启动自举 seed）；日常真实使用改跑 `pnpm start`（主库 cat-study.db，记忆延续）

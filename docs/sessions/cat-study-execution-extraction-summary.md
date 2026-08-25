# cat-study-execution-extraction Summary

## What

候选 1「Connector 成了业务核心」的实施：把 3014 行的 `connectors/socketio.ts` 拆成薄传输层 + `packages/server/src/execution/` 执行引擎。**已完成 1-3 刀**（每刀独立 commit、全绿、可回滚）：

| 刀       | commit  | 内容                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 决策留痕 | a188f21 | CONTEXT.md 新增 **Execution（执行引擎）** 词条 + Message Bus 补注；ADR 草稿 `docs/adr/draft-execution-engine-extraction.md`                                                                                                                                                                                                                                                                 |
| 第 1 刀  | 86341bb | 纯函数组（提示构建/上下文过滤/摘要压缩）→ `execution/hints.ts` + `execution/context.ts`；45 个测试 co-located 迁入                                                                                                                                                                                                                                                                          |
| 第 2 刀  | 02766c5 | `runAgentReply` → `execution/reply.ts`（8 处 emit 换 bus、performHandoff 收窄、状态 accessor）；`execution/bus.ts`（EngineBus 6 方法 + HandoffBus 2 方法纯类型）+ `execution/state.ts`；shared 新增 MessageAgentStatus 联合 + 5 个载荷类型；`createSocketBus(io)` 适配器落 connector                                                                                                        |
| 第 3 刀  | e0b202e | 执行循环（executeOneAgent/executeAgentsSerial/drainQueuedCommand）→ `execution/serial.ts`（含执行常量、AgentTriggerMsg、agentHasUsableApiKey、`createExecutionEngine(bus)` 工厂）；`execution/row.ts`（rowToAgent）；state.ts 扩充（activeAborts/锁/mention 配额/M1 频控）；socketio.ts 1110 行（构造注入 `_engine` + **executeAgentsSerial 兼容包装**，55 处测试与 ingest/恢复路径零改动） |

**当前 socketio.ts 剩余**：传输层（handlers/bridges/restart 广播）+ 三条恢复路径 + 兼容 re-export（第 4 刀迁移后收敛）。

## Why

- 两份独立走查（本 review + opencode 报告）收敛于「拆 socketio god-module」
- 「dispatch 标 busy → connector 执行」的配对仅靠注释维持，事故史实锤（卡死槽位/幽灵 running）
- socketio.test.ts 5902 行 mock 掉全部接线——真实链路从未被测；搬完后 connector 的 spy 天然穿过 bus，测试零改动即覆盖新链路

## Tradeoff

- **bus 注入（design B 主体 + A 适配器嫁接）**：引擎窄化视图 6 方法发不出未类型化事件；否掉 C（事件流）——「必 drain」是注释契约，与仓库注释契约失败史同型
- **兼容包装**：第 3 刀保留 `executeAgentsSerial(io, ...)` 旧签名委托引擎（第 4 刀删）——55 处测试调用点零改动，换来切片可独立审查
- **测试策略微调**（相对原计划）：connector 侧 mockIo 的 `to().emit` spy 穿过 createSocketBus，现有 145 用例零改动覆盖新链路；假 bus 形态 a 单元测试随 3.5 刀工厂落地
- **搬家零行为变化**：日志通道沿用 'socketio'、控制流零重排；暴露的真 bug 记观察项不混入搬家刀
- **未做**：DB 分离（pnpm dev/start --mode，ADR 决策 9）、SESSION_HANDOFF 房间化（ADR 待确认）

## Open Questions

1. ADR 编号（收口时分配；0010 可能已留给知识库二期）
2. SESSION_HANDOFF 房间化是否随第 4 刀顺手修（handoff/index.ts 全局 emit vs ingest 房间广播不对称，design B 提议房间化实为修 bug）
3. 3.5 刀 + 第 4 刀派活拆分（每刀一单）或继续由本线推进

## Next Action

### 必须知道的操作细节（新 token 直接继承）

1. **提交必须带环境覆盖**（否则 pre-commit 钩子的全量测试被本机 env 漂移打挂）：
   ```bash
   ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash git commit -m "..."
   ```
   根因：本机 Windows 注册表两个用户环境变量是 `deepseek-v4-flash[1m]`，`npx` 经 `.cmd` 垫片 → cmd.exe 从注册表重注入；`env -u` 拦不住。claude buildEnv 测试断言代码默认 'deepseek-v4-flash'。
2. **两个间歇性 flake**（已记 ADR 观察项，根修另开单）：摘要压缩组（验收2/9/10/11）+ 并发重叠测试。提交时钩子偶挂，重试即可；单跑稳定绿。
3. 测试命令：`cd packages/server && npx vitest run`；lint：仓库根 `pnpm lint`。

### 3.5 刀（模块态 → 实例态，独立刀）

- state.ts 的 6 个 Map/计数收进 ExecutionEngine 实例字段：finalizeRun 统一四份失败漏斗、run 注册表合并 activeAborts+activeStreams、mentionCounts 跨 run 存活（engine 级字段）
- 单例 fail-fast 断言（tsx watch 热重启双注册表防护）
- 假 bus 形态 a 单元测试在此刀落地（真实 SQLite + 真实 dispatch + 假 bus）
- 该区域是事故史最密集处——独立 commit + 专门测试，不混入其他刀

### 第 4 刀（恢复路径 + 断环，最后也是最大的一刀）

1. 三条恢复路径（recoverInterruptedExecutions/recoverQueuedMessages/replayStuckUserMessages，socketio.ts ~640-1110）→ `execution/recovery.ts`（`REPLAY_STUCK_WINDOW_MINUTES` 随迁；index.ts 定时器改 import）
2. 断环：ingest.ts 改从 `execution/` 导入（executeAgentsSerial 直接调 engine、rowToAgent、getIO 循环处理）；eval/attribution 返回 `needReplay` 旗标由 index.ts 消费；l1-aggregator 广播走 bus
3. 删除 socketio.ts 的 executeAgentsSerial 兼容包装，更新 55 处测试调用点（`mod.executeAgentsSerial(mockIo as any, ...)` → `mod.executeAgentsSerial('session-1', ...)` 或 engine 直调）
4. DB 分离（ADR 决策 9）可随本刀或独立 commit：dev.js 加 `--mode production` → NODE_ENV；db/index.ts 按 NODE_ENV 选库（production → cat-study.db / 其他 → cat-study-dev.db）；日常真实使用跑 `pnpm start`
5. 收尾：ADR 观察项复核、socketio.ts 最终行数核验（目标 ~1100 行）

### 候选池剩余（本轮未动）

候选 2（dispatch 配对结构化 + 实例态深化）、候选 3（wire 契约 shared 化）、候选 4（三套摘要系统）、候选 5（Memory 泄漏 repo 词汇）、候选 6（web store Connector seam）、候选 7（展示契约重复）、候选 8（DB 单例 ×14 + schema ×2，含测试库文件化）、opencode 报告 #2（LLM adapter spawn 生命周期）、#4（行映射收口）。

### 工作区状态

- 用户未提交改动勿碰：`packages/web/src/components/AgentEditModal.vue`、`packages/web/src/views/SettingsView.vue`
- 本文件未提交（新 token 先读它再动手；可自行提交）

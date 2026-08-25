# ADR（草稿，编号待收口分配）: Execution 执行引擎抽取——Connector 回归传输层

> **Status**: draft（2026-08-25 店长终审通过后投审查链；编号在收口时分配）
> **实施进度**：第 1-3 刀 + 3.5 刀 + 第 4 刀 + DB 分离全部落地（86341bb/02766c5/e0b202e/8d0b405/e9928d2/923725f），socketio.ts 3014 → 609 行；每刀全绿独立 commit。
> **背景链**：`/improve-codebase-architecture` 全库走查 → 候选 1「Connector 成了业务核心」→ grilling 九问定稿 → design-it-twice 四案对比 → 本文档留痕。

## 背景与摩擦（证据段）

- **契约 vs 现实**：CONTEXT.md 规定 Connector「只做消息格式转换和路由，不包含业务逻辑」——实际 `connectors/socketio.ts` 3014 行承载全部回复管线（上下文过滤、摘要压缩、记忆注入、handoff、重启检测、A2A 策略、三条恢复路径）。
- **两份独立走查收敛**：本审查候选 1 与 opencode 独立报告 #1 同题同结论（拆 socketio god-module）；opencode #3/#5/#7 分别对应本审查候选 2/3/8——独立收敛是方向正确的强信号。
- **事故史**：卡死 busy Slot、幽灵 running 状态——「dispatch 标 busy → connector 执行」的配对仅靠三条「配对执行」注释维持（socketio.ts:255、1720、1837），注释契约已反复失效。
- **测试盲区**：socketio.test.ts（5902 行）mock 掉 dispatch/memory/summarizer/handoff 全部边界——真实接线从未被测；代码内自认「mock 泄漏盲区」（socketio.ts:1029）。
- **先例**：dispatch 的 `setAgentStateBridge`/`setSystemMessageBridge`（注入式 seam）与 `getIO`（服务定位）——本 ADR 沿用同款习惯，非新发明。
- **emit 点清点**（design-it-twice 实测）：引擎侧 17 处 io 引用、5 个事件族（NEW_MESSAGE ×9+、AGENT_TYPING ×2、MESSAGE_AGENT_STATUS ×4 形态、MESSAGE_UPDATED ×1、CONTEXT_WINDOW_STATS ×1）；connector 独占事件（RESTART_STATUS/ERROR/SESSION_HISTORY 等）不进引擎。

## 决策

1. **目标形态**：独立 `packages/server/src/execution/` 模块；socketio.ts 变薄传输层（预计 3014 → ~1100 行；**实际收口 609 行**）；dispatch 维持 slot/FIFO 不动（37KB 测试零重写）。
2. **输出 seam**：初始化注入 **MessageBus**（类型化方法，design B 主体）；引擎窄化视图 6 方法（`emitMessage`（第 4 刀由 emitAgentMessage 更名——ingest 用户消息与 agent 回复共用完整 Message 通道）/`emitSystemNotice`/`emitTyping`/`emitAgentMessageStatus`/`emitMessageUpdated`/`emitContextWindowStats`）——引擎物理上发不出未类型化事件（无逃生口）；HandoffBus 第 4 刀增 `emitSessionHandoffToRoom`（ingest 重定向房间广播，与全局形态并存）；`createSocketBus(io)` 内部用判别联合 + exhaustive switch（design A 嫁接，编译器强制每个事件被处理）；引擎目录零 socket.io 引用。
3. **payload 类型落 shared**（wire-contract 方向）：新增 `MessageAgentStatus`（'queued'/'thinking'/'replying'/'done'——与 SlotStatus 两域解耦，刻意不复用）、`TypingUpdatePayload`、`SystemNoticePayload`（9+ 处手搭 system 通知收敛）、`MessageUpdatedPayload`、`HandoffFailedPayload`；补 `ALL_AGENT_STATES`/`GET_AGENT_STATES` 常量；死常量 `QUEUE_UPDATE` 清理。
4. **成员原则**：emit 点逐一对账；不预留没有生产者的口子（设计层兼容靠 seam 本身 + 加成员不破坏调用者；无落点预留会腐烂——QUEUE_UPDATE 标本）。
5. **搬家清单**：四组全搬——备菜（上下文过滤/压缩/提示构建）→ 炒菜（runAgentReply）→ 点单管理（executeOneAgent/executeAgentsSerial/drainQueuedCommand + 随身状态）→ 善后（三条恢复路径）。
6. **切片**：第 1 刀纯函数 → 第 2 刀 runAgentReply → 第 3 刀执行循环+状态 → **3.5 刀模块态→实例态**（独立刀：finalizeRun 统一 + run 注册表 + 单例断言；不混进搬家刀——该区域是事故史密集区）→ 第 4 刀恢复路径+断环。每刀全绿 + 独立 commit 可独立审查回滚；搬家不顺手改行为，暴露的真 bug 记观察项另开单。
7. **eval 环**：依赖单向 `execution → eval`（纯函数侧）；attribution 返回 `needReplay` 旗标由 index.ts 消费；l1-aggregator 广播走 bus；attribution 参数从 `io` 缩窄为 bus——eval 彻底不认识传输层。
8. **测试形态**：真实 SQLite（`:memory:`）+ 真实 dispatch + 假 bus + 边界 mock（memory/summarizer/handoff/LLM adapter）——配对链首次被真实测试；断言打类型化数组（杀死 `any[]` 嗅探模式）。**socketio.test.ts 瘦至 ~1500 行未随刀进行**（零改动迁移优先：connector spy 天然穿过 createSocketBus，测试调用点仅做机械迁移；现 6096 行）——瘦身挂后续单。
9. **DB 分离（脚本即配置）✅ 已落地 923725f**：`pnpm dev` → `data/cat-study-dev.db`（空库自举，自动 seed 同款猫——实验场）；`pnpm start`（`--mode production`）→ `data/cat-study.db`（主库，日常真实使用，记忆延续）；vitest → `:memory:`；`--mode` 由 dev.js 设 NODE_ENV（Windows 无内联 env 语法，零新依赖）；测试库文件化（temp-file）挂候选 8（与 schema 派生同单）。
10. **`.agent-busy` 锁保留**：真实职责 = dev.js 重启保护窗（用户确认重启时若 Agent 在推理则等待），与 worktree 无关；主判据是 execution_logs running 计数，锁是 DB 不可读时的退化兜底。引用计数随第 3 刀搬入 execution/（3.5 刀收进实例字段），**锁文件本身保留**（server↔dev.js 跨进程信号，实例状态替代不了），dev.js 一行不动。

## Considered Options（design-it-twice 四案）

| 方案             | 总线形状                                          | 裁决                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 最小接口面     | 1 方法 `broadcast(判别联合)`                      | 深度最大，但 payload 类型松（`role` 联合、`extra: unknown`），漂移风险集中在类型；**保留其判别联合 + exhaustive switch 作为适配器内部形态**                                                       |
| B 强类型领域总线 | 13 方法 + 引擎 6 方法窄化视图                     | **选中为主体**——「发不出未类型化事件」值回票价；顺带收窄 handoff/attribution/ingest 三个 io 消费方                                                                                                |
| C 事件流输出     | 0 方法（execute 返回 AsyncIterable<EngineEvent>） | **否**——「每次 execute 必须恰好被 drain」是注释契约，与仓库注释契约失败史同型（配对执行三注释没防住卡死槽位）；且消费侧三调用点全部变形状。其 forwardToIO 映射表思想已包含在 B 的 createSocketBus |
| D 生命周期对象   | 1 个 roomEmit + 实例状态                          | 状态吸收（12+ Map → 6 实例字段）最优；**实例化不进搬家刀**，以独立 3.5 刀落地，并作为候选 2（dispatch 生命周期）的输入                                                                            |

## Consequences

- **涟漪清单**：handoff `performHandoff(sessionId, io)` → `performHandoff(sessionId, handoffBus)`（1 文件 2 调用点）；attribution 返回 `needReplay`；ingest 改从 execution/ 导入（顺带解开自认的 ESM 循环，ingest.ts:8-10 注释）；internal.ts 经委托函数零改动；index.ts 恢复/重放定时器改调引擎。
- **后续挂靠**：候选 2（dispatch 配对结构化 + 实例态深化）、候选 8（schema 派生 + 测试库文件化）、候选池新增 opencode #2（LLM adapter spawn 生命周期）与 #4（行映射收口）。
- **风险点**：3.5 刀区域（失败漏斗/run 注册表）是事故史最密集处——独立刀 + 专门测试；tsx watch 热重启需引擎单例 fail-fast 断言（双注册表是仓库没吃过的新失败类）。
- **已知观察项**：SESSION_HANDOFF 全局广播 vs 房间广播不对称（handoff/index.ts:222 `io.emit` vs ingest 房间）——design B 提议房间化（实为修 bug），是否本单修留审查链裁决。

## 待确认

- [ ] ADR 编号（收口时分配；0010 可能已留给知识库二期）
- [ ] SESSION_HANDOFF 房间化裁决：ingest 重定向路径已房间化（emitSessionHandoffToRoom，第 4 刀）；handoff performHandoff 的全局 emit 未动——是否整体房间化仍待裁决（两形态并存记录在 bus.ts）
- [x] 四刀 + 3.5 刀的派活单拆分方式 —— **未拆单，由本线连续推进完成**（每刀独立 commit 全绿，等效可独立审查）
- [ ] 实施观察项（与搬家无关，另开单处置）：
  - 摘要压缩集成测试（验收9/10/11 等）+ 并发重叠测试存在低频时序 flake（waitFor 边界，10s 级超时暴露）；HEAD 与修改后均有观察窗口，单跑稳定复现不了——判定法：重跑一次看是否转绿
  - claude buildEnv 测试受本机 Windows 用户环境变量 `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m]` 影响恒失败（cmd.exe 经 npx .cmd 垫片从注册表重注入；`env -u` 只对直接子进程生效）——测试断言代码默认 'deepseek-v4-flash'，与机器 env 漂移。处置权归用户（unset / 改断言 / 改代码默认）；本线提交用环境覆盖绕过
- [ ] socketio.test.ts 瘦身（6096 → ~1500 行，ADR 决策 8 未随刀进行）——挂后续单

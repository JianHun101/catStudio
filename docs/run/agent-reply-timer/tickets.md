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

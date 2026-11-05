---
status: active
---

# 票单：会话交接产生同名重复框（双框/幽灵框）

- 立项：2026-10-13，用户报「90% 上下文交接后前端出现两个同名会话框，刷新后变成一个」（触发消息 `0443c12c`）
- 派工：flash猫（server 为主 + web 一处），走 worktree；审查链 → 店长收口
- **含 server 代码 ⇒ 收口时需重启审批**（与票③同类，合并时统一发起）

## 根因（实证链，逐环已钉死）

1. 交接是 fire-and-forget（`execution/reply.ts:934`/`:1142`，返回值不消费只 catch）；触发交接的回复落在**旧**会话，新子会话诞生时必然 0 消息——**空壳是设计，不是异常**。
2. 旧会话 token 不减少仍 >90%，后续每次执行都再过 `shouldHandoff` → 再调 `performHandoff`。
3. `performHandoff` step2（`handoff/index.ts:173`）调 `deleteEmptyHandoffChildren`（`db/repository/sessions.ts:175-184`）——**无年龄谓词**，0 消息即删；刚交接的新壳被当「前端切换失败的孤儿」误杀。
4. step3 去重守卫 `getHandoffChild`（`sessions.ts:160-168`）只认 **≥1 消息**的子会话 ⇒ 新壳被杀后守卫不挡 → step4 重建新会话 + `bus.emitSessionHandoff`（`handoff/index.ts:223`）。每次还白花一次摘要 LLM 调用（step「3. 生成全量总结」在重建前）。
5. 前端判重按 `newSession.id`（`stores/chat.ts:1159-1162`），两次交接 id 不同 ⇒ 判重失效又 unshift 一条；同名是因为 `nextHandoffTitle(oldSession.title)` 的输入（旧标题）恒不变。
6. 被删的壳**无任何广播**（纯 DB DELETE）⇒ 前端那条框成幽灵；刷新后 `fetchData` 以 DB 为准 ⇒ 收敛为一个。逐字对上用户现象。

**生产实证**（2026-10-13，会话 `4c7fde77`「rag系统优化（1）」，dev 库 + server 日志）：14:03:31 / 14:13:35 / 14:22:18 三次 `handoff session created`，夹两次 `removed empty handoff children removed=1`（14:13:29、14:22:12）——20 分钟交接三次，误杀两个新壳。

## 改动面（契约级）

### ① `packages/server/src/db/repository/sessions.ts`

- `deleteEmptyHandoffChildren(parentSessionId, olderThanSeconds)`：
  - 加年龄谓词 `AND s.created_at < datetime('now', ?)`，modifier 传 `'-600 seconds'` 形态——**同库 UTC 秒级口径，禁止拿 JS ISO 串与 `datetime('now')` 产物比**（格式不同面）。
  - 返回值 `number` → `string[]`（被删 id 列表，广播用）。**签名破坏变更**：调用方仅 `handoff/index.ts:173`，测试 `sessions.test.ts:77-113` 同改。
- 新增 `getEmptyHandoffChild(parentSessionId): { id: string } | undefined`——0 消息子会话（不限年龄；调用点在窗内清理**之后**，幸存者必在窗内，语义自洽）。

### ② `packages/server/src/handoff/index.ts`

- 新常量 `HANDOFF_EMPTY_SHELL_GRACE_SECONDS = 600`（固定常量，**不进 env、不进 settings 表**——避免 seed-shadow 类坑）。
- step2：带窗清理；被删 id 逐个 `bus.emitSessionDeleted(id)`。
- **step2.5（新，本单核心）**：`getEmptyHandoffChild` 命中 ⇒ `log.info('handoff dedup: reusing fresh empty child', …)` + `return null`——**不再生成摘要（省下重复 LLM 调用）、不重建、不 emit**。调用方 fire-and-forget（`reply.ts:934`/`:1142` 实测），返回 null 与「已交接」分支（`:180-183`）同语义，安全。
- step3（`getHandoffChild` ≥1 消息守卫）**不动**；`resolveHandoffTarget` 链追**不动**；`nextHandoffTitle` **不动**。

### ③ `packages/server/src/execution/bus.ts` + `connectors/socketio.ts`

- `HandoffBus` 加 `emitSessionDeleted(sessionId: string): void`；socketio 实现 `io.emit(Events.SESSION_DELETED, { sessionId })`——**全局广播**，与 `routes/sessions.ts:415` 同语义（会话列表是全局 UI 态，非房间态）。
- **族修扫面（硬要求）**：`HandoffBus` 字面量 mock 全仓枚举并补齐新方法的回执清单。已知站点（grep 实测）：`ingest.test.ts:149`、`dispatch/index.test.ts:132`、`reply.test.ts:506`/`:709`、`handoff/index.test.ts:314`/`:391`、`serial.*.test.ts` 十余处（多为 `as any`，类型不断但**也要列入清单**——逐站标注「as any 不受影响 / 已补」）。

### ④ `packages/web/src/stores/chat.ts`（SESSION_HANDOFF handler，:1141-1175）

- unshift 前先剔除陈旧条目：`s.handoffFrom === data.oldSessionId && s.id !== data.newSessionId` ⇒ 同一旧会话的重复交接事件，列表只留最新一条（幽灵框即消）。
- **前置实核**：会话列表 / `getSession` 的 API 载荷是否暴露 `handoffFrom`（snake→camel 转换层实测）；不暴露则在 API 层补（属本单边界），回执写明实测结论与补法。

## 边界（Out of Scope）

- 不改 `getHandoffChild` 的「≥1 消息」语义；不改 `resolveHandoffTarget`；不改 `ingest.ts:346` 重定向路径；不改标题编号逻辑；不引入新事件类型（复用既有 `SESSION_DELETED`）。
- 「交接后旧会话 token 仍 >90% 反复触发」本身**不修**——那是触发频率问题，本票修的是「重复触发不得产生用户可见的重复产物」。

## 验收（行为可验）

- **AC1（窗内不误杀）**：构造 0 消息子会话（created_at = now）→ `performHandoff` 后：子会话行仍在、无新会话行、`emitSessionHandoff` 未被调、`generateFullSummary` 未被调（mock 断言）、返回 null、日志含 dedup 行。
- **AC2（窗外仍清 + 广播）**：构造 0 消息子会话（created_at = now − 601s）→ 子会话行被删、`emitSessionDeleted` 带该 id 被调一次、随后全流程重建（新会话行 + `emitSessionHandoff`）。
- **AC3（真实交接守卫不回归）**：子会话 ≥1 消息 → 两个 repo 函数均不碰它，`performHandoff` 走既有「已交接」早退。
- **AC4（窗边界）**：repo 单测构造 created_at 窗内 1s（留）/ 窗外 1s（删）两分支。
- **AC5（web 幂等）**：同一 `oldSessionId`、两个不同 `newSessionId` 的 SESSION_HANDOFF 先后到达 ⇒ 列表只含最新那条（陈旧条目被剔除）。
- **AC6**：全量测试 + `node scripts/lint.js` 全绿；回执附 HandoffBus mock 站点清单（含 as any 站点的处置标注）。
- **AC7（真机，收口时店长做）**：重启后下次自然交接，查 server 日志 dedup/reuse 行 + 前端会话列表单框。观察性验收，不强行构造 90% 上下文。

## 提交

- 走 worktree；`catstudy [0443c12c-a0de-4123-8bb6-e42e9bbbc1d1] fix(server): …`（40 位真 uuid，即本票触发消息）。
- 提交后按 `request-review` 发起审查；收口归店长。

---

## 收口留痕（2026-10-13，店长）

**状态：✅ 已入 dev**——PR #212（closeout/handoff-double-frame，载体 = 已审 sha `1ff5588c` 字面量）→ merge commit `01a59424`。三方对账齐：dev = origin/dev = `.push-gate` = `01a59424`。

**审查链**：吐槽猫 R1 ✅可合并——五条真空性对照（4 条变异 + 1 条 tsc）逐条亲手复现零附带红；全量 3 轮独立复跑 `165 files / 3778 passed, 0 failed`；`HandoffBus` 17 个站点用兄弟成员扫面独立验证无遗漏；年龄谓词承重前提（`sessions.created_at` 秒级空格分隔）在活库实测成立。

**AC7（真机）**：约定为重启后叠「可构造读数」（dev 库阈值调低 → 触发一次真交接 → 看 dedup 日志行 + 浏览器单框），随重启审批窗一并做。

**P3 ×6 留痕（均不阻断，归后续裁量）**：

1. 交接文档自报计数两处与实测不符（`execution/*.test.ts` 10→实 12；「15 处」实为文件数、§6 清单 17 行）——§6 权威清单本身完整正确。
2. 「新增 `any` ×0」不实：新增 5 处（4 测试 + 1 生产 `handoff/index.ts` 的 `catch (emitErr: any)`，与文件既有 3 处同款 ⇒ 非缺陷）。
3. `getEmptyHandoffChild` docstring 的确定性声称过头：`created_at` 秒级，同秒并列时行序仍不定（真要严格得 `ORDER BY s.created_at DESC, s.id DESC`；实际影响≈0）。
4. web 剔除分支缺「被剔的正是当前活跃会话」的兜底（可达性极窄：须列表已有同父两条且活跃的是被顶替那条）。
5. OQ6：删的壳可能正是用户眼前会话 → 前端跳 `sessions[0]`——本单**新引入可达**的用户可见行为变更（旧代码删壳无广播，用户留在幽灵框；判可接受，触发需「停在壳里 10 分钟不说话 + 期间旧会话再触发交接」）。
6. flash猫 实施中 `replace_all` 误删原有 9 处 `unmount`（已完整复原，绿测试曾掩盖）——经验「批量替换须限定上下文 + 核 diff 删除面」建议上浮 lessons，待裁。

**重启**：含 server 代码（`handoff/index.ts` / `sessions.ts` / `bus.ts` / `socketio.ts` 均在主进程 import 面），需重启审批生效。

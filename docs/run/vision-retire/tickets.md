# Tickets: vision 退役（外部视觉旁路整链删除）

实现 `docs/plans/review-chain-anchor.md` **用户故事 15 / D7 / §六 第一条**（2026-09-13 触发）。
触发条件：Read 工具实证能原生渲染图片（店长 120×60 左红右蓝探针图实测），
`skills/vision-assist/SKILL.md:8` 的立命断言「本环境模型无法原生看图（Read 返回 `[Unsupported Image]`）」
被推翻。

> **锚点更正（实施者留痕）**：店长派活单写「这是 `review-chain-anchor.md` D15 的落地」——
> **D15 是 `IngestInput.origin` 改必填，与视觉无关**（`docs/plans/review-chain-anchor.md:218`）。
> 本单的正确锚点是用户故事 15（`:80`）/ D7（`:202`）/ §六 第一条（`:188`），三处均已标落地。

Work the **frontier**：本活只有一张票。

## T1 · vision 退役（唯一票）

**What to build:** 删掉「模型看不了图 → 走外部视觉旁路」的整条链：技能、角色类型、seed 猫、
全部描述与文档口径。

**Blocked by:** None — can start immediately.

- [x] 删 `skills/vision-assist/`（整目录）
- [x] 删 `skills/manifest.yaml` 的 `vision-assist` 登记 + `skills/BOOTSTRAP.md` 注册表行（自研 8→7）
- [x] `packages/shared/src/types.ts` 的 `AgentRole` 联合类型删 `'vision'` 成员
- [x] `dispatch/mention-policy.ts` 边表删 `vision` 键 + `allowedTargetsDescription` 删 case + 退役兜底注释
- [x] `seed-data.ts` 删图测猫条目 + `DemoAgent.role` 注释改口径
- [x] 去人格化注释（**只改字不改逻辑**）：`env.ts` / `serial.ts` / `sampler.ts` / `phase0.ts` / `iron-laws.ts` / `hints.ts` / `reply.ts`
- [x] `scripts/mcp-server-utils.mjs` 的 `list_session_members` 工具描述删 `vision=视觉验收`
- [x] 测试改写（见下「测试改写口径」）
- [x] 文档对齐：`CONTEXT.md` / `README.md` / `docs/plans/review-chain-anchor.md`

**不复用 `role:'vision'` 的负向 fixture 替换口径（硬约束）：** 替换后必须仍是一个
**真正不在边表里**的角色，否则负向用例变恒真假绿。本单逐处核过：

| 原 fixture                                                    | 被谁的边表拦           | 替换为                             | 为什么仍非边表角色                                             |
| ------------------------------------------------------------- | ---------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `图测猫/vision` @ serial.test                                 | reviewer               | `副审查猫/reviewer`                | reviewer 边表 = {store, implementer}，reviewer 自身不在其中    |
| `图测猫/vision` @ internal.test 1a/1c                         | reviewer               | `副审查猫/reviewer`                | 同上（1a 正例走 triggerAuthorName 例外边）                     |
| `图测猫/vision` @ socketio.test                               | implementer            | `flash猫/implementer`              | implementer 边表 = {store, reviewer}，implementer 自身不在其中 |
| `图测猫/vision` @ mention-policy.test（含 store「任意」正例） | implementer / reviewer | `dsh猫/implementer`；reviewer 自身 | 同上                                                           |

**测试改写口径（两处「删除」而非「替换」，按同一分支去重、覆盖未降）：**

- `mention-policy.test.ts`「implementer 不可 @ vision」：implementer 边表只剩 {store, reviewer}，
  唯一非白名单角色是 implementer 自身——同文件「implementer 互 @ 被拦」覆盖同一分支同一断言。
- `mention-policy.test.ts` `describe('vision → {store}')` 整块：边表已无该键，该角色不再有「允许集」，正向用例无被测对象。
- `iron-laws.test.ts` / `socketio.test.ts` 的 `'vision'` 分档：`ironLawForRole` 只有 reviewer / store|implementer / 其余
  三分支，`'unknown'` 覆盖的正是同一个「其余」分支。

## 三条不变量（店长硬边界）与落地

| #   | 不变量                                  | 落地                                                                                           | 验证                                                             |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | 历史消息 / 记忆零丢失                   | 退役动作**零 SQL**，不删任何 `messages` / `execution_logs` / `sessions` 行                     | `git show --stat` 无 `.db` / 无 `db/` 改动；主库清理归店长       |
| 2   | 老库残留 `role='vision'` 继续 fail-open | `mention-policy.ts` 的 `!rule` 兜底 + 双条退役不变量测试                                       | `mention-policy.test.ts`「已退役角色（vision）残留行的两向行为」 |
| 3   | 排除 ollama 猫的评估逻辑保留            | `sampler.ts:40` / `phase0.ts` 的 `llmProvider === 'ollama'` 与模型族判据**一字未动**，只改注释 | 该段 diff 仅注释行                                               |

**不变量 2 的一处如实更正**：店长把发送者侧与目标侧一并描述为「保住既有兜底」。
**发送者侧不是「保住」而是「放宽」**——退役前 `vision` 键在边表里，vision 发送者被限到 `{store}`；
删键后该值落 `!rule` 才变成全放行。目标侧行为不变（`t.role='vision'` 是真值 → `rule.includes` 失败 → 仍被拦）。
两向已被一对测试钉死。放宽只作用于已不存在的角色、实害为零，但「描述成守恒」与「实际放宽」必须分开记。

## 不在本单范围（店长收口窗口）

- 主库 `cat-study.db` 里图测猫那行（`0ac78872-80ad-4bfa-84ad-3bc0c0d05a1e`）的清理——**不动任何 DB**
- `packages/server/src/ui-review.ts` / `scripts/ui-screenshot.mjs`（挂观察项）
- ollama 适配器
- `packages/web` 渲染代码

## 顺手清掉的一处（超出派活清单，如实标注）

`packages/web/.tmp-image-send.mjs` 是**已入库的一次性调试脚本**（发一条 @图测猫 的带图消息再退出），
违 `vision-assist` 自己的「用完即删」硬规则，且 A1 grep 要求包内无角色语义命中——已删。
不在店长改动清单里，故在此显式列出。

## Gate Report（实施者自填）

| 项                                                                               | 结果                                | 证据                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 `grep -rn "vision" packages/ skills/ CONTEXT.md README.md` 无 role/agent 语义 | ⚠️ **按字面未通过，残余已逐条分类** | 残余分四类：①真命中「退役墓碑」（类型/注释/回归断言，**故意留**）②`break-tunnel-vision`（另一 skill，店长点名保留）③`VISION CHECK`（quality-gate 的「需求对齐」，语义无关）④子串假阳性（`revision` / `provisioning`）。**无一条是活着的角色注册**。详见交接文档 OQ-A1   |
| A2 `pnpm lint` 三包全绿                                                          | ✅                                  | shared/server/web 三包 tsc/vue-tsc 通过                                                                                                                                                                                                                                 |
| A3 `pnpm test` 全绿                                                              | ✅                                  | 108 files / 2149 tests passed。**口径**：本 worktree 基线是 dev `f43ae0f`，**不含**本会话 T1 的 `d96d3f8`——与 T1 交接里的「2171 passed」不是同一基线，不可直接比。本单净删 2 个 `it`（同分支去重 + 无被测对象的正向块），净增 3 个 `it`（退役残留两向 + seed 反向断言） |
| A4 空库 seed → agents 5 只、无图测猫                                             | ✅                                  | `pnpm seed` 于 worktree 独立 DB：店长/ds猫/flash猫/吐槽猫/dsh猫 = 5；`role='vision'` 行数 = 0；session `agent_ids` 5 项                                                                                                                                                 |
| A5 文档对齐                                                                      | ✅                                  | `CONTEXT.md` / `README.md` / `review-chain-anchor.md`（用户故事 15 + §六 + D7 三处标落地）                                                                                                                                                                              |

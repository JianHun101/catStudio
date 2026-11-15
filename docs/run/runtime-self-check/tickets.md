---
status: active
---

# 票 B · 唤醒自检（运行时实例读数随每次唤醒注入）

**与票 A 配对**：票 A（`server_boots` 启动账本）管**写**进程身份，本票管**把身份在唤醒时送到猫眼前，并给出「自你上次发言以来有没有重启」的判定**。

**源起（2026-11-15 本会话）**：用户已重启 server，店长仍在说「等你批准重启」。用户原话：「我早就重启了。我们应该学习 `D:\Game\ai\clowder-ai` 项目，agent 一唤醒先测下有没有重启过。」

**外部参照**：clowder-ai `cat-cafe-skills/debugging/SKILL.md` 的 **Runtime Preflight Gate** —— 涉及 runtime 行为时，未拿到「监听 PID / 进程启动时间 / HEAD / 目标 commit / 该 PID 的日志证据」之前，**唯一允许说的话是「我还没查清」**；禁止无证据断言「没更新 / 没编译 / 没重启 / 还是旧代码」。同仓 `cat-cafe-skills/refs/shared-rules.md` §16a 把这条定为硬规则（理由：无证据说「没重启」= 把用户的操作当成自己 bug 的替罪羊）。

**差别**：clowder 那道门靠**手动 bash 三件套**（人要记得跑）；catStudy 已有 `server_boots`（每次启动落一行身份），可以把同一判据做成**机械注入**——猫不需要记得去测，唤醒上下文里就有读数。这就是本票要学的那一半：**判据机械化，不靠记忆**。

## Why

对话记忆不是运行时状态的证据。这次事故的机制是：

1. 店长把「重启申请已发出、等用户批准」写进了会话，没落任何系统状态；
2. 用户重启了实例，`server_boots` 多了一行，但**没有任何通道把这行送到下一次唤醒**；
3. 下一次唤醒时，店长只能读自己的对话记忆，于是继续等一个已经发生过的事件。

同理可推：猫无证据说「还没重启 / 重启没生效 / 改动没上线」时，用户无法分辨这是读数的结论还是记忆的复述。本票把读数塞进唤醒路径，让「说重启状态」这件事**先有数**。

## What（契约）

### 契约 A · 实例注册表（当前进程身份的唯一读点）

新模块 `packages/server/src/runtime-instance.ts`：

```ts
export interface RuntimeInstance {
  bootId: string // 启动账本主键，UUID
  startedAt: string // ISO 毫秒 UTC，与 server_boots.started_at 逐字相同
  gitSha: string | null // 采集面拿不到就是 null，不写空串
  gitDirty: number | null // 0/1；采集失败是 null（未知 ≠ 干净）
}
export function setRuntimeInstance(instance: RuntimeInstance): void
export function getRuntimeInstance(): RuntimeInstance | null
export function __test_resetRuntimeInstance(): void
```

- **写入点唯一**：`packages/server/src/index.ts` 在 `insertServerBoot` 成功后立刻 `setRuntimeInstance(...)`。同一处已在 `try/catch` 里 fail-soft，采集失败则不注册（读侧拿 `null`）。
- **`startedAt` 由写入层产出**：`insertServerBoot` 的返回值从 `string` 改为 `{ bootId: string; startedAt: string }`（现有唯一调用点 + 测试同批改）。理由：`started_at` 由写入层的 `nowIso()` 生成，注册表若自己再取一次时间，两个值会在毫秒级分叉，`server_boots` 与注入行不再是同一份读数。
- **`startedAt` 必须只取一次**：写入层先 `const startedAt = nowIso()`，同一个变量同时用于 `.run(...)` 与返回值；**不能**在 `.run()` 的参数里再调一次 `nowIso()`——两次调用会产生两个值，A2 的「逐字相等」当场失效。
- **`index.ts` 的注册与日志同批改**：`const { bootId, startedAt } = insertServerBoot(bootInfo)` → `setRuntimeInstance({ bootId, startedAt, gitSha: bootInfo.git_sha, gitDirty: bootInfo.git_dirty })` → 现有 `log.info('server boot', { boot_id: bootId, ...bootInfo })` 里的 `boot_id` 取解构出的 `.bootId`。返回对象后若沿用旧写法，日志会把整个对象写成 `boot_id`。
- 读侧**不查库**：注入行取注册表内存值。理由是「当前进程是谁」只有运行中的进程自己知道；查 `server_boots` 最新行会读到副本库/他人进程的账。

### 契约 B · 对比锚点 = 本会话中本猫最近一条发言

`packages/server/src/db/repository/messages.ts` 新增：

```ts
/** 本会话该 agent 最近一条回复的 created_at（原始值，不归一化）；无则 null */
export function getLastAgentMessageAt(sessionId: string, agentId: string): string | null
```

SQL：`SELECT created_at FROM messages WHERE session_id = ? AND agent_id = ? AND role = 'agent' ORDER BY created_at DESC, id DESC LIMIT 1`（走既有 `idx_messages_session`；`id` 同毫秒 tie-break 与列表排序同口径）。

- **`id` 是 UUID v4，不是时间序**：`ORDER BY created_at DESC, id DESC` 给的是**稳定** tie-break，不是插入序。同毫秒两条本猫消息时「最近一条」由 UUID 字典序决定——测试不要断言「最后插入的那条」，A3 必须错开 `created_at`。
- **为什么不用上下文里的消息数组**：`relevantMessages` 是可见性过滤 + 折叠压缩后的窗口，长会话里本猫的上一条发言可能已不在窗口内——而那恰是「等重启」最常发生的位置。锚点必须查库。
- **为什么锚在「本猫发言」而不是「本会话上一条消息」**：要回答的是「自**你**上次说话以来，世界变了没有」。用触发消息做锚时，用户重启后再发消息的场景会恒判「未重启」，恰好错过本票要治的那次事故。

### 契约 C · 判定与文案（纯函数）

`packages/server/src/execution/hints.ts` 新增导出：

```ts
export function buildRuntimeSelfCheck(
  instance: RuntimeInstance | null,
  lastOwnMessageAt: string | null
): string | null
```

- `instance === null` → 返回 `null`（不注入）。测试进程、CLI 兜底路径、启动采集失败都走这条。
- 比较前两侧都过既有 `normalizeIsoMs`（`db/repository/clock.ts` 导出），再 `Date.parse`；任一侧 `NaN` → 退化到下面「无法判定」文案，**不猜**。
- **严格大于才算重启**：`bootStartedAt > lastOwnMessageAt` → 已重启；相等或更早 → 未重启。
- `lastOwnMessageAt === null` → 无法判定文案（会话里本猫还没发过言，或这行历史不在库里）。

三档文案（逐字契约，实现照写；`boot` 取 `bootId` 前 8 位，`git` 取 12 位，`null` 写「未知」，`工作树` 三态见下）：

```
[运行时自检] 进程 boot=<8位>，启动于 <ISO>，代码 git=<12位>，工作树=<干净|有改动|未知>。你上次在本会话发言于 <ISO>——之后进程已重启过。上一轮所见的进程状态可能已失效：在说「还没重启 / 要重启 / 重启没生效」之前先按本行核对；若你在等重启批准，视为已生效。
[运行时自检] 进程 boot=<8位>，启动于 <ISO>，代码 git=<12位>，工作树=<干净|有改动|未知>。你上次在本会话发言于 <ISO>——之后未重启。
[运行时自检] 进程 boot=<8位>，启动于 <ISO>，代码 git=<12位>，工作树=<干净|有改动|未知>。本会话没有你更早的发言，或时间取不到/无法解析，无法判定是否重启。
```

- **第三档同时覆盖「无锚点」「查询失败」「解析失败」**：`lastOwnMessageAt === null`（没发过言 / 历史不在库里）、`getLastAgentMessageAt` 抛错后 fail-soft 得到的 `null`、以及任一侧过 `normalizeIsoMs` 后 `Date.parse` 为 `NaN`（非时间串）都落这一档。文案写「没有你更早的发言，或时间取不到/无法解析」——不能只说「没有发言」（查询失败不是没发过言），也不能只说「无法解析」（抛错不是格式坏），否则文案在对应分支上说假话。
- **`工作树` 三态固定出现，不是可选后缀**：`gitDirty === 0` → `工作树=干净`；`=== 1` → `工作树=有改动`；`=== null` → `工作树=未知`。三档文案都带这个字段——`null`（采集失败）与 `0`（干净）**不得同形**；`gitDirty === 1` 但判定为「未重启 / 无法判定」时脏树也必须可见。
- **`normalizeIsoMs` 只归一空格整秒**：它只把 `YYYY-MM-DD HH:MM:SS` 补成 `...T...000Z`；空格+毫秒（`YYYY-MM-DD HH:MM:SS.SSS`）与省略毫秒的 ISO 串都**原样透传**，不要当已归一的形态用。A5 只用它认的那一档；混入别的形态会把时区差误判成时间差。
- 文案里**不出现运行时长/相对时间**（如 "已运行 3 小时"）：那会让同一进程内每轮注入串都不同，prompt 快照与缓存每轮失效。

### 契约 D · 注入位置

`packages/server/src/execution/reply.ts`：在 `knowledgeContext` 注入之后、`recordTraceDetails` / `llm.chat` 之前，以 `\n\n` 连接把自检行追加到 `llmMessages[0].content` 尾部。真实顺序：

`finalSystemPrompt` → `llmMessages[0]` → `injectSummaryIntoSystem`（前缀拼接）→ `memoryContext` 追加 → `knowledgeContext` 追加 → **自检行追加** → 最终 token 复核 → `recordTraceDetails` → `llm.chat`。

- **不在 `finalSystemPrompt` 组装处插**：同一函数后面还有 `memoryContext` / `knowledgeContext` 两段追加，插在那里自检行就不在 system 内容结尾，A6 的「以自检段结尾」只在关记忆的测试装配里绿——正是要防的假绿。
- **不坐 `dynamicHints`**：`hints.ts` 里已写明该位置有「超限时被当最旧先丢」的观察项（CLI 截断止血单）；常驻证据不能坐可被丢掉的位置。
- 取锚点的查询失败 = `null`（fail-soft），不阻塞本次执行。
- **进 T2 快照**：自检行进了 `llmMessages[0].content`，而快照口径是「各节并集 = `llmMessages[0].content` 的构成成分」，不进节就破坏并集不变量。故 `TRACE_SECTION_KEYS` 新增 `runtimeSelfCheck: 'runtime_self_check'`，`TRACE_SECTION_LABELS` 加展示名，`TRACE_SECTION_ORDER` 排在 `knowledge` 之后，`recordTraceDetails` 的 `sections` 追加 `traceSection(TRACE_SECTION_KEYS.runtimeSelfCheck, runtimeSelfCheckSection)`。理由与 churn 裁决见「决策留痕 · OQ-3」。
- **第九节的 content 取 `buildRuntimeSelfCheck` 返回值原文**（不含连接用的 `\n\n`）；`instance === null` / 返回 `null` 时传空串，`traceSection` 记为 `empty`。未注册实例的用例里第九节仍存在、只是 `empty`——不要写成「没有第九节」。
- **承重用例必须先注册实例**：`'★承重★ 八节落库…'`（改名「九节」）在 `run()` 前 `setRuntimeInstance(...)`，在 `finally` 或该 `describe` 的 `afterEach` 里 `__test_resetRuntimeInstance()`（二者任选，但必须在该用例结束后必然执行），`section_key` 精确数组从八项加到九项，承重 `for (const key of [...])` 循环加入 `'runtime_self_check'`。**不注册实例时 `buildRuntimeSelfCheck` 返回 `null`、第九节是空串，循环里的 `if (content !== '')` 会直接跳过**——只加 key 照样全绿，自检行没被「快照内容逐字节出现在真注入串里」覆盖。注册写进用例本身，不依赖外层用例残留的实例。该用例的 `seedT2()` 不插入本猫历史回复，`getLastAgentMessageAt` 返回 `null`，第九节落「无法判定」档——仍非空、仍进承重循环；「已重启 / 未重启」两档的逐字文案由 A4 覆盖，承重用例不需要另造锚点。
- **「未注册实例」拆成独立用例**：不在承重用例里混跑，单独构造「不注册实例」的装配，断言 `llmMessages[0].content` 不含 `[运行时自检]` 且既有 system prompt 内容一字不变（追加式）；注册路径的 A6 主判据另用一条。
- **落点硬点组加先后锚**：`reply.test.ts` 的 T2 快照套件里「落点硬点（静态源断言）」组（与 `recordTraceDetails` 写口调用点同组的那一个，不是 M1 那个同名组）补一条——`SRC.indexOf('${runtimeSelfCheck}')` < `SRC.indexOf('const finalStats = estimateMessageTokens(llmMessages)')`，两个锚各自全文件唯一。否则「自检行在最终 token 复核之前」只是说明文字，实施者把追加挪到复核之后仍全绿；同时自检追加变量固定命名 `runtimeSelfCheck`，让这条静态断言有可 grep 的唯一锚。
- **既有断言只动两处**：承重 `section_key` 数组（八→九）与承重循环（加 `runtime_self_check`）。新增用例（未注册拆分、落点先后锚）不算改动既有断言。另**必须改 `reply.ts` 分节注释里的「八节」为「九节」**（`TRACE_SECTION_KEYS` 上方的注释：「八节互不重叠、并集 = `llmMessages[0].content`」）——这是第三处允许动的既有文本，漏改会留一句假话。

## 改哪些文件（边界）

- `packages/server/src/runtime-instance.ts`（新建）+ `runtime-instance.test.ts`
- `packages/server/src/db/repository/serverBoots.ts`（返回值形状）+ `serverBoots.test.ts`
- `packages/server/src/db/repository/messages.ts`（`getLastAgentMessageAt`）+ `messages.test.ts`
- `packages/server/src/execution/hints.ts`（`buildRuntimeSelfCheck`）+ `hints.test.ts`
- `packages/server/src/execution/reply.ts`（追加入口）+ `reply.test.ts`
- `packages/server/src/index.ts`（注册调用，一行）
- `AGENTS.md`（Gotchas 加一条唤醒自检规则；本票已由店长先落）
- 对应 `*.test.ts` 同目录 co-located

**不做什么（Out of scope）**：

- 不动 `.restart-request` / `.restart-done` 状态机，不做「重启申请落库 + 启动收账」——那是另一半（见 OQ-2），本票只保证唤醒时**看得到实例读数**。
- 不加 MCP 工具、不改 `query_db`、不改前端、不碰 probe 模式。
- 不改任何 agent 的 persona / `seed-data` 系统提示词。
- 不做定时提醒、不做跨会话广播。

## 验收（行为可验证）

- [ ] A1 **注册表**：`setRuntimeInstance` 后 `getRuntimeInstance` 返回同一对象；`__test_resetRuntimeInstance` 后返回 `null`。
- [ ] A2 **启动账本返回双值**：`insertServerBoot` 返回 `{ bootId, startedAt }`，且 `startedAt` 与落库行 `started_at` 逐字相等；`bootId` 与落库行 `boot_id` 逐字相等。测试断言取 `.bootId` / `.startedAt`；**禁止用 `not.toBe` 判两次返回的对象**（对象引用必然不同，断言恒真）——要判两次启动的主键不同就显式比 `.bootId`。
- [ ] A3 **锚点取数**：同一会话内本猫多条回复 + 其他猫回复 + 用户消息混合，`getLastAgentMessageAt` 只取本猫最近一条；无本猫回复返回 `null`；不返回其他猫的时间。测试必须显式错开各条的 `created_at`（`id` 是 UUID v4，同毫秒下 `id DESC` 不是插入序）。
- [ ] A4 **三档文案**：`buildRuntimeSelfCheck` 对「已重启 / 未重启 / 无锚点」分别产出契约 C 的逐字文案；三档均带 `工作树=` 字段，`gitDirty` 的 `0` / `1` / `null` 各断言一次（`null` 不得写成「干净」）；其中**至少一条是「未重启 + `gitDirty === 1`」**——只按「已重启+1 / 未重启+0 / 无锚点+null」最小组合测不到契约 C 的「未重启 / 无法判定档也必须看见脏树」。`instance === null` 返回 `null`。
- [ ] A5 **边界不误判**：`bootStartedAt === lastOwnMessageAt` → 未重启；秒级 `YYYY-MM-DD HH:MM:SS` 与 ISO 毫秒同一时刻 → 未重启（走 `normalizeIsoMs`）；任一侧非时间串 → 无法判定档，不抛错。
- [ ] A6 **注入落点**：注册实例后跑 `runAgentReply` 的既有测试装配（其 `beforeEach` 已 mock 非空记忆与知识库），`llmMessages[0].content`（system）以 `[运行时自检]` 段结尾。**未注册实例的断言拆成独立用例**（独立装配，不与注册跑法混）：`llmMessages[0].content` 不含该段，且既有 system prompt 内容一字不变（追加式）。注册路径另断言 `recordTraceDetails` 的 `sections` 含 `runtime_self_check` 节（九节）且 content 非空。
- [ ] A7 **不阻塞**：`getLastAgentMessageAt` 抛错时该次执行照常进行（自检行退化为无法判定档，不冒泡）。
- [ ] A8 **既有测试零回归**：`hints.test.ts` / `reply.test.ts` / `messages.test.ts` / `serverBoots.test.ts` 及 server 全量绿。唯一允许动的既有断言是契约 D 点名的两处（八→九节数组、承重循环加 `runtime_self_check`）；其余既有断言零改动，新增用例不算回归。
- [ ] A9 **复述面**：`git grep -n '进程 boot='` 除 `docs/run/**` 外，**非测试的实现文件**只允许命中 `packages/server/src/execution/hints.ts`（三档文案的唯一来源）；`*.test.ts` 允许以断言形式出现（`hints.test.ts` / `reply.test.ts` 都会引期望串）。这是「有没有第二份文案」的判别式——注释里的解释性提及不会误伤，测试断言不算第二份文案。`git grep -n '运行时自检'` 除 `docs/run/**` 外允许出现在 `AGENTS.md`、`hints.ts`、`hints.test.ts`、`reply.test.ts`，以及 `reply.ts` / `runtime-instance.ts` / `runtime-instance.test.ts` 的**注释**（解释性提及不计为第二份文案）。`runtime-instance.ts` / `reply.ts` 只要求符号引用 `buildRuntimeSelfCheck`，不要求字面。无残留旧口径（「每次先 query_db 查 boot」一类）。

## OQ（裁决记录，2026-11-15 店长）

- OQ-1 「已重启」判定在**本猫下次发言后自动失效**（锚点前移）。这是有意的：自检回答的是「你上一轮之后有没有重启」，不是「本进程被重启过几次」。若需要后者，读 `server_boots`。
- OQ-2 重启申请本身仍是文件态 + 内存信号（`.restart-request`），启动后由写方/读方清理，**没有落库的回执**。本票的自检行能让猫看见「已重启」，但看不见「你那条申请被执行了」。要不要补 `restart_requests` 落库 + 启动收账，另票裁决。
- OQ-3 **已裁决：进 T2 快照**（见「决策留痕 · OQ-3」）。原文字的「是否进入快照」不再开放；churn 取舍同时裁决为接受。

## 决策留痕

- 跳 grilling：需求来自用户一条明确指令 + 一个已发生的故障现场，判据（clowder-ai Runtime Preflight Gate）已在外部仓落地，无需再 grill 出需求 → 本单不单跑 grill。
- Gate A 契约：每条需求都有可观察结果（A1–A9 逐条对应契约 A–D 的一个可执行断言），无「更好用」「尽量」类措辞。
- Gate B 边界：双向钉死——做 A–D 四契约 + AGENTS.md 一条规则；不做重启申请落库、不做 MCP 工具、不碰前端与 persona。
- Gate C 反向证明：A1–A9 全绿 ⇒ 唤醒上下文必含当前进程身份 + 「自上次发言以来是否重启」判定；用户无需再回答「我早重启了」。
- 选型裁决（店长）：**机械注入**而非「让猫每轮自己 query_db」——后者正是本票要消灭的「靠记得」形态；也不是 clowder 那种手动 preflight，因为 catStudy 的唤醒路径在 server 手里。
- **OQ-3 裁决（店长，2026-11-15）：自检行进 T2 快照，加 `runtime_self_check` 第九节。** 不进快照就破坏 `TRACE_SECTION_KEYS` 注释写明的「各节并集 = `llmMessages[0].content` 的构成成分」——快照是「真进模型的那条串」的分节投影，自检行在串里却不在任何节里，回查时会说「模型没看到」而实际看到了。代价（`reply.test.ts` 八节断言改九节、`TRACE_SECTION_ORDER`/`LABELS` 各加一项）是纯增量，前端 `TraceView` 按节清单动态渲染、不硬编码八节。churn 取舍：**接受**——同一会话内锚点随本猫发言前移，「未重启」档的 `<ISO>` 逐轮变，但快照本就是「那一轮的真值」，逐轮不同是正确而非噪声；去掉锚点时间会让「未重启」档失去可核信息，不取。
- **OQ-4 裁决**：`normalizeIsoMs` 只认空格整秒，契约 C 已写明边界；A5 只用该档，不借 `toIsoDb` 的识别面。
- **OQ-5 裁决**：新旧两条重启规则不合并，`AGENTS.md` 新条末尾加互指——同节「判要不要重启看跑着的那个进程行为」条目判「要不要」，本条判「有没有」。A9 只扫字面、扫不到沿用旧判据的复述，列为人工评审项。

## Gate Report

### Gate A · 需求照准

✅ 全部可证伪：核心需求「唤醒时能看到当前进程身份 + 自上次发言以来是否重启」由 A2（身份逐字一致）、A4（三档文案）、A6（注入落点）三条覆盖；失败形态（拿不到读数却说状态）由 A9 复述面与 AGENTS.md 规则覆盖。

### Gate B · 契约锁定

✅ 边界/契约/验收已钉死：注册表接口、锚点 SQL 口径、严格大于判据、三档逐字文案（含 `工作树` 三态）、注入位置（`knowledgeContext` 之后、`llm.chat` 之前，第一条 system message 尾）与不坐 `dynamicHints` 的理由均已写死；快照第九节与八→九节断言同列；Out of scope 四项同列。

### Gate C · 反向证明

✅ 验收通过能反证 Gate A：A1–A9 全绿 ⇒ 注册表可读写、身份与账本同源、锚点取本猫最近发言、三档判定正确、注入在 system prompt 且追加式、失败不阻塞。无未被验收覆盖的需求项。

### Gate Result

✅ PASS → 可进 implement（server 侧单猫实施）

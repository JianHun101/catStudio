# CatStudy 审查链锚统一 + 投递权回归 Agent

> 收口日期：2026-09-10 ｜ 票单 T-A…T-O（**十五票**）全部落地 dev
> 来源规格：`docs/plans/review-chain-anchor.md`（spec-gate PASS，commit `e759788`）
> 本文件是 `docs/run/review-chain-anchor/`（`tickets.md` 842 行 + `tg-audit.md` 161 行）的**收口上浮**——原目录已随收口删除。
> **未落码的规格未随目录丢失**：T-G audit §F2 的修法规格照录于本文 §5（`execution/flow-advance.ts:26-29` 的注释引用了它）。

## 1. Why — 为什么做这一轮

### 1.1 原始痛点：commit 与「审查投递」硬绑定

post-commit hook 每见一个 commit 就投一条审查请求。返工每出一个新 sha 就**叠一条新链**：审查者拿到的是没有历史、彼此无关的请求；实施猫也拿不到上一轮的判词上下文。代价是无效消耗 + 判词归属混乱。

### 1.2 根因不是「hook 太吵」，是**链没有身份**

hook 判「该不该投」用的是**提交本身**（sha / HEAD），而「这是同一笔活的第几轮」是**链**的属性。
用提交判链 ⇒ 任何多 commit 的活必然分叉。故靶心是给链一个**身份**（锚），再把投递判据挂到锚上。

### 1.3 投递权为什么交回 Agent

hook 是**无状态触发器**：commit 时刻它没有「猫是否已经投过」的答案——猫的回复此刻尚未产生。Agent 在**执行收尾**时两样都有（commit 已发生 + 回复内容已定）。故：

- hook **降级为标记者**：只做 commit ↔ 执行归属写回，不再投递；
- 投递由 Agent 按 `request-review` 自行发起；
- 漏投由**执行收尾侧**兜底（判据：本执行有 commit 且其回复 `mentions` 不含审查者）。

## 2. 关键决策口径

### 2.1 三个钉死的词

| 词            | 值                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------ |
| **锚**        | `messages.task_id`，值 = **首轮** `trace_id`。表既有列——**不新增字段、不引入消息 id 别名** |
| **chainType** | `first \| followup`，**对账位**（不参与链归属裁决）                                        |
| **审查者**    | 本仓库当前 = 吐槽猫                                                                        |

驳回「消息 id 当锚」：它是 `task_id` 的**下游派生**（同一张表同一列），用下游校验上游救不了任何东西。

### 2.2 十五票各一句

| 票      | 口径                                                                                                                                                                                                                                                                                                                                                                            | 落地 commit                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **T-A** | 钩子不再每 commit 投一条。判定点必须在**两个时刻、不能合并**：commit 时刻（钩子，判「有无归属执行」）与执行收尾（判「回复 mentions 是否含审查者」）；任一步判据查不动 → **一律投递**，不静默吞                                                                                                                                                                                  | `60fe720`（复审 `c8245f8` / `ad8af8b`）                                                               |
| **T-B** | `request-review` 技能回流（ADR 0014 §5 反转——该条前提「hook 机械投递」正是本轮拆掉的）；技能正文**零路由**（不含 `@谁` / `请谁审查`），静态源断言守住                                                                                                                                                                                                                           | `94742a2`（复审 `a1200a7`）                                                                           |
| **T-C** | 判词三档 ✅/⚠️/💬`COMMENT`。💬 **不阻断收口、不起新链、不触发返工**；**向严不向宽**——不得把已判定的 ⚠️ 因「问题不大」改判 💬                                                                                                                                                                                                                                                    | `b2ce1b0`                                                                                             |
| **T-D** | 全仓「post-commit 自动触发审查」表述改「Agent 自行投递」。并纠正一处机制误解：铁律（运行期注入）与 DB 角色块是**叠加**不是覆盖，`reply.ts` 的防重复注入守卫实测**恒真**                                                                                                                                                                                                         | `6cb3327`（复审 `42340a9` / `a418ef3`）                                                               |
| **T-E** | 锚贯通：首轮由 `ingest.ts` 显式写入（值 = 该轮 `trace_id`），链内每跳原样继承。`\|\| traceId` 从「漏带逃生舱」降级为「首轮生成」                                                                                                                                                                                                                                                | `7dd0e14`                                                                                             |
| **T-F** | 审查类投递必须带 **锚 + chainType**，缺 → **入口 400**；`IngestInput.origin` 改**必填**（原默认 `'human'` 在生产是静默放行侧）；**语义次闸划掉**（主闸落地后不可达，落进提示词即「文档说保留、其实不存在」）                                                                                                                                                                    | `3c95a0b`（返工 `65ab358`、必改 `40a5b83`）                                                           |
| **T-G** | **五消费方**按锚对齐（评估归档 / 收口推进 / 重放跳过 / 上下文回捞 / 判词提示）。修两条 live bug：① 链末 trace 在 `messages` 0 行 → verdict 空集 → 评估**恒判 `success`**；② `flow_states` 按 (session, sha) exactly-once → 第二条判词撞已 close → **真提醒永久不投且不报错**                                                                                                    | `0b91170`                                                                                             |
| **T-H** | 归属判据改「**存在任一状态执行行 → 有归属**」（原只数 `running` 行，把「执行已终态」误判成手动提交 → 多投）。一执行多 commit **显式接受「只看 HEAD」**——按 uuid 回溯成段曾实现，**实测否决**（「一条消息 @ 两只猫」是常态，回溯会把兄弟票的文件混进 diff）                                                                                                                      | `d17eeca`（更正笔 `f7f3249`）                                                                         |
| **T-I** | `/executor` 回传值从 `execution_logs.trace_id` 改为该消息的 `messages.task_id`（一跳 JOIN）。否则返工轮**换锚 → 开新链**——主闸只保证「锚非空」，不保证「链内不变」                                                                                                                                                                                                              | `b4c7421`                                                                                             |
| **T-J** | 交接去重判据不再被正文对 marker 的**引用**击穿：marker 从裸串收窄为**行首锚定注释形态**；`Commit: <sha>` 裸匹配改判**文档体**（长度 + `## ` 小节结构 + 三个固定小节名）。marker 集**只覆盖 §2–§4**——§5 兜底降级文案是**正常降级**，纳入会让它触发补填                                                                                                                           | `fd3cf48`                                                                                             |
| **T-K** | A2A 配额拦截抬 **warn**（原为 info，观感=派活凭空消失）+ 阈值 `MAX_MENTIONS_PER_AGENT` **可配**（每次判据处读 env）。**双计是刻意的并发互斥**（调度点预留 + 完成处各计一次 ⇒ 实际轮次 ≈ `limit/2`），本轮**不翻**，只把代价写进注释与 `.env.example`                                                                                                                            | `fa418fb`                                                                                             |
| **T-L** | 两侧对「emoji 后多一个空格」零容忍 ⇒ `✅ 可合并` 落 `bad_verdict`、**approve 直接丢失**（该收口的收不了）。架构裁决=**字符串表同源、匹配语义不同源**（行首锚定 vs 全文 `lastIndexOf` 各自保留）                                                                                                                                                                                 | `b21e660`                                                                                             |
| **T-M** | 归属反查**消歧失败不得猜**：读侧跨 agent 多行 → `undefined`（判据取 **distinct agent** 而非行数——同猫多行是重试、执行者确定）；写侧两条路径跨 agent 拒写（`changes:0` + `skippedAmbiguous` + warn）。`/executor` 新增 `matchedBy`/`ambiguous`，**「有行但指不出人」回 200 不是 404**——404 在 `probeAttribution` 语义里是「无归属 ⇒ 钩子兜底投递」，会把**有归属的**提交多投一轮 | `4f5a899`                                                                                             |
| **T-N** | `hints` 守卫改 **subject 为空即不注入**（fail-closed）。定性更正：approve/comment 的 subject 恒空是**设计使然**（且被下一行 `if (verdict==='approve'\|\|'comment') return null` 挡掉），真实触发面只有 suggest 的 4 行，其 clause 里**没有非 store 目标** ⇒ 「写侧补 subject」不成立                                                                                            | `792ce85` → `5adf4b9`（判据域失配：写侧原落 `subject.name`、读侧比 `agent.id`，改写侧落 `agents.id`） |
| **T-O** | pre-push 门禁改**逐 refspec 校验**（git stdin 传的才是本次要推的清单），修「只看 `git rev-parse HEAD`」+「无祖先关系 `exit 0`」两处 fail-open。**情形③ 记为新增显式判据「已审历史的子集放行」**——不是「旧行为延续」                                                                                                                                                             | `36f4548` → `c338b2b` + `5b90e2d` + `9a11a35`                                                         |

### 2.3 三条跨票口径（收口时最容易被问到的）

1. **收口一律 carry 已审 sha 字面量，禁 `commit-tree` 造等价 sha。** T-O ④ fail-closed 后，合成 sha 与 `.push-gate` 两边无祖先关系 ⇒ 必被拒；绕道就是 `--no-verify`，正是 T-O 要止住的形态。
2. **验证面必须与被判面同面。** 判据扫消息 `content` 却 grep 工作区文件 = **恒真的假绿门**（T-J 实证）；e2e 基线挂在**会被自己移动的 `HEAD`** 上 = 交付物自带一套在 HEAD 上跑红的测试（T-O 必改 1 实测 19/24）。
3. **fail-closed，向严不向宽。** T-N 守卫、T-M 拒写、T-O ④ 同口径。存量错域值**不回填**，靠 fail-closed 自然退化（只漏注入、无误注入）。

## 3. 实证读数

### 3.1 汇总读数（**收口前本机复跑**，非转述）

| 项                                                   | 读数                                 | 说明                                                                        |
| ---------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| pre-push 门禁 e2e（`scripts/pre-push-gate.e2e.mjs`） | **32 passed / 0 failed**             | 12 场景 × legacy/current 双跑 + 近因对照。首版曾 **19/24**（基线挂 `HEAD`） |
| handoff-gen e2e（`scripts/handoff-gen.e2e.mjs`）     | **175 passed / 0 failed**            |                                                                             |
| 全量 vitest                                          | **97 files / 1936 passed, 0 failed** |                                                                             |

### 3.2 区分性读数（口径 = 「旧实现下该断言必红」）

> **出处交代**：下列各条是**审查链上各票自己的实测记录**（票单与判词原文），**本收口笔未复跑**——唯一例外是 pre-push 那条（随 §3.1 那一跑同时产出）。要引用其数字请回对应 commit 的测试文件，**不要引本文件当一手证据**。

- **pre-push**：**5 条**场景 legacy 与 current **结论全部相反**（场景 3 / 4 / 5 / 8 / 11）。
- **T-O 必改 2**：T-O 首版（blob `64ab61e6`，含回落 bug）= **拦** / 本笔 = **放行**。
- **T-M**：把 `HEAD` 版 `executionLogs.ts` **逐字复制**为 legacy 模块、同 fixture 同断言跑出 `A=2 / D=ds猫 / C=3`，与旧读数**逐个吻合**（跑完即删）。
- **T-L**：正则与查表**逐字取自真源码**，唯一自变量 = emoji 后那一个空格 ⇒ 真源码跑 5 条真实判词样本，**3 翻转 / 2 对照稳定**。
- **T-J**：回归样本的 marker 引用放在**过程叙述行行中且带注释符**（`0319b7f3`：`<!--` 偏移 799、裸串 804）⇒ 「只收窄到注释形态、不加行首锚定」的实现下**仍红**。
- **T-N**：删掉守卫那一行 → `hints` 测试 **1 红**；三轮回退下阴性对照照常绿。

## 4. 挂后续清单

### 4.1 有实害（建议立单）

| #   | 项                                                                   | 关键事实                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`.husky/pre-commit` 无 `set -e`** ⇒ `pnpm lint` 失败被**静默吞掉** | 实测 `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH` exit 1，提交照样通过（收口批次即实证）。**顺序**：先修 worktree 的 node_modules 符号链接，**再**决定要不要 `set -e`——直接加会阻断所有 worktree 提交 |
| 2   | **pre-push 门禁 warn 误报**                                          | **每次合法 carry 都打**「审查记录与当前历史不一致（可能 reset/rebase）」。判据应从「`gate ≠ HEAD`」收窄为「gate 与**推送 sha** 无祖先关系」                                                    |
| 3   | **T-G audit §F2 规格未落码**                                         | `getCommitHashByTraceId` 的 **1 trace→1 commit** 假设（实测 1:N，**706/958 = 73.7%** 的执行行上锚 ≠ `trace_id`）。规格见 §5                                                                    |
| 4   | **worktree node_modules 符号链接**致 `pnpm lint` 恒失败              | 是第 1 条的前置；另有「junction 解析到主仓库旧源码致类型报错」的既有形态                                                                                                                       |

> **⚠️ 第 3 条的连带**：`packages/server/src/execution/flow-advance.ts:26-29` 的注释指向 `docs/run/review-chain-anchor/tg-audit.md` §F2，**该目录已随本收口删除** ⇒ 注释现为**悬空指针**，需一并改指本文件 §5。（本次未改：属 `server/` 代码面，不在本单边界内。）

### 4.2 覆盖缺口

- `query_db` 白名单缺 `episodes` / `review_verdicts`（本轮取证只能绕 node 直连）。
- pre-push e2e 的两条 blob 基线是**可达性依赖**：当前仓**无 CI** 故今天无害；将来接 CI 若用 `actions/checkout` 默认 `fetch-depth: 1`，`git show <blob>` 必失败 → e2e `exit 1`（需 `fetch-depth: 0`）。
- **`db/repository/verdicts.ts:60` `hasClosedVerdictByTaskId`** 是「链级**曾出现**闭环档」而非「最新判词是闭环档」（`LIMIT 1` 任意命中即真）⇒「先 ✅ 后新 commit 再 ⚠️」的链会恒真。
- **`db/repository/messages.ts:475` `getUndispatchedUserMessagesOlderThan` 硬过滤 `role='user'`** ⇒ `role='agent'`（A2A 静默丢派）与 `role='system'` 永不在扫描面内，丢派不自愈。
- **`scripts/mcp-server.test.js` refs 守卫**：① `catstudy/` 子树在枚举面外（`skills/catstudy/refs/cat-roles.md:27` 含 `@`，若纳入枚举会直接红——**待裁**：该 `@审查者` 是正当领域内容还是违 §3 不变量）；② 剥注释只剥整行 `//`，且 `/\*[\s\S]*?\*/` 会剥掉**字符串里**的 `/*`（哑方向）。
- **`hints` 侧没有后闸**：`✅可合并了`（后接汉字）在 hints 判「通过、不注入」，而 parser 判 `bad_verdict`。两侧语义**本就不同源**（已裁决各自保留）⇒ **统一字符串表时不要把 parser 的后闸一并移植进 hints**（会改 hints 既有行为，属另一票）。
- **`eval/phase0.ts:361`** ext-05 金标仍写「post-commit hook 据此自动投递审查链」——**有意未改**（金标是已收口基线，改会扰动 judge 校准的历史可比性；且它不注入任何猫的 prompt）。

### 4.3 口径 / P3

- **`shortHash` 前缀比对**：生产侧写 7 位（`scripts/handoff-gen.mjs:355` `> Commit: ${shortHash}`），消费侧按**等长精确子串**比对（`packages/server/src/dispatch/index.ts:86`）。**裁决归消费侧**改「提取 + 前缀比对」，生产侧格式不动（短 sha 是给人读的，且 `shortHash` 还供别处复用）。当前**无 live bug**（生产路径两侧同源等长；不一致时 fail-open 向**多余工作**，不是静默丢弃）。
- commit message 例外行号漂移（`:1405`/`:1448` → `:1409`/`:1452`）。
- `gatedPostBodies` 注释与 push/判闸次序不符（`:170` 注释说「经镜像闸**放行**」，实际 `:188` 先 push、`:189` 才判闸 ⇒ 被拒载荷同样在数组里；方向**更严不是更松**，但埋了一个将来陷阱：若有人故意往已接闸分支发无锚载荷断言 400，该载荷会进数组 → 全局不变式误红）。
- `handoff-gen.e2e.mjs` 组 14/15 走 `startAttributionStub` 的**内联闸**、载荷不进 `gatedPostBodies` ⇒ 该数组末尾的三条不变式**不覆盖**组 14/15。
- **行号是快照，不是真相源**——本批已现「blob 行号 vs 工作区行号」双行号（`tickets.md:205` vs 工作区 `:248`，差 43）。定位一律用**锚文本**。

### 4.4 用户后置（明示）

- 视觉统一（全猫换 flash + 删图测猫 / vision-assist）。
- 两行 `task_id` 交叉互换脏数据的成因（2/882，可能旧 build 写入）——挂受控复现小单，**不当定案依据**。

## 5. 附：T-G audit §F2 规格（未落码，随收口上浮照录）

> 原 `docs/run/review-chain-anchor/tg-audit.md` §F2 交的是**精确修法规格**（未落码），因 `db/repository/executionLogs.ts` 那一轮归另一只猫独占。为免规格随目录删除而丢失，原文照录于下。
> **调用点**：`packages/server/src/execution/flow-advance.ts:59`。
> **旧函数保留**：`getCommitHashByTraceId` **别顺手删**——`/api/handoff/verdict` 的判据链仍按 `commit_hash → trace_id → review_verdicts` 用它。

**缺陷**：`db/repository/executionLogs.ts:124` `getCommitHashByTraceId` 假设 1 trace→1 commit，实测 1:N ⇒ 恒取最新 ⇒ 收口提醒写错 sha。需把「锚」从**执行行的 `trace_id` 列**换到**触发消息的 `task_id` 列**。

**新函数**（`db/repository/executionLogs.ts`）：`getCommitHashByAnchor(anchor: string): string | undefined`

```sql
SELECT el.commit_hash
FROM execution_logs el
JOIN messages m ON m.id = el.triggered_by_message_id
WHERE m.task_id = ? AND el.commit_hash IS NOT NULL
ORDER BY el.started_at DESC, el.id DESC
LIMIT 1
```

—— 与 T-I 的 `/executor` 同款**一跳 JOIN**；`id` 做同秒 tie-break（库内 `started_at` 为秒精度）。

**调用点**（`execution/flow-advance.ts:59`）：`getCommitHashByTraceId(meta.task_id)` → `getCommitHashByAnchor(meta.task_id)`。

**消歧决策（架构已裁）**：同一锚名下多行 `commit_hash` 时**不得猜**——本规格仍带 `ORDER BY … LIMIT 1`，是因为「一条链挂多 commit」的正确答案是**按被审轮次**取，而这需要 `review_verdicts` 那一侧的信息；**先落本规格（消掉 73.7% 的错锚），多 commit 的消歧与 T-M「不得猜」同批裁决**，不在此处私自定义 tie-break 语义。

**区分性验收**：造一条链，根消息 `task_id = A`、两次执行 `trace_id = T1/T2`（≠A）且各挂 `commit_hash = C1/C2`；判词消息 `task_id = A`。旧实现按 `trace_id = A` 查 → **0 行**（`flow-advance` 整段跳过、`flow_states` 无记录）⇒ 新实现必须命中；断言 `getFlowState(session, C2)?.state === 'closed'`（**旧实现下 `undefined`，必红**）。

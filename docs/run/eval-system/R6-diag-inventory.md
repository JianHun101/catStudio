# R6 §B 分档清单：同型诊断取值点按边界收窄

> 归属票：`R6-crash-label-and-diag-sweep.md` §B（OQ-3）。实施：flash猫。**本文件是 §B 的 commit 1**（`docs/run/**` 免审前缀）。
> 结论：**店长裁决「方案甲拆票 + 三条判据边界改判」后，实测 59 处已全部落地**；本文件是逐条可复核的判据面。

## 一、读数（命令 + 原始值，两树逐行一致）

```bash
# 筛面：票面 §3.1 原命令，逐字未改
git grep -nE "\b(err|e|error|execError|parseError|ex|reason|caught)\??\.message\b" \
  -- 'packages/**/*.ts' 'scripts/**/*.mjs' 'scripts/**/*.js' ':!*test*' | wc -l
→ 135
# 同命令 -l | wc -l
→ 45 文件
```

两树交叉核对（防「worktree HEAD 落后读到另一棵树」）：

```
diff <(cd /d/Game/ai/catStudy && git grep -nE '<同正则>' -- <同路径集>) \
     <(cd <本 worktree> && git grep -nE '<同正则>' -- <同路径集>)
→ 空（IDENTICAL）
```

主仓 `HEAD = 59d1a2e3baca8bd3dda6f68d1a010b4bb0c70b85`；两树源文件面零差异 ⇒ 行号可直接互引。

### 1.1 135 的构成

| 类别                             | 处数 | 明细                                                                                                                                 |
| -------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------ |
| §A 独占（`execution/serial.ts`） |    1 | `:37` 注释（R5 §B 后该文件残留 0 处代码点，与票面 §3 一致）                                                                          |
| §B 面**注释**（非代码点）        |    6 | `git/create-pr.ts:82`、`llm/opencode.ts:441`、`llm/opencode.ts:518`、`utils.ts:28`、`logger.ts:20`、`memory/embedding-client.ts:687` |
| §B 面**单源本体**                |    1 | `utils.ts:44`（`messageOf` 函数体，票面 §三 边界：不动本体）                                                                         |
| §B 面**可判代码点**              |  127 | 见 §二 / §三                                                                                                                         |
| **合计**                         |  135 | 1 + 6 + 1 + 127 = 135 ✅                                                                                                             |

## 二、判据（唯一规则）

- **改**：受保护体（`catch` 体 / 事件回调体）里存在一条路径，其抛出物来自**本仓之外**；
- **不改**：受保护体只调本仓函数，且这些函数**自身已捕获**外部错误（吞掉 / 转成返回值），或**只抛我方 `throw new Error`**。

落到可复核粒度 =「受保护体内触达外部的那一处是否裸上抛」：

| 档       | 判据                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **改**   | 受保护体内**直接**出现子进程 / 网络 / 第三方 SDK / `node:fs` / `JSON.parse` / DB 驱动；**或**经本仓「裸上抛薄封装」触达上述之一（薄封装 = 不吞错、不包裹、原样上抛） |
| **不改** | 受保护体只调本仓函数，且被调方**已在其内部收口**该外部错误，或抛出的恒为我方 `throw new Error`                                                                       |

**已穷举的本仓「裸上抛薄封装」**（判定「不改」时须逐个排除）：`runGit`（三处）、`execFileP`、`listCatBranches` / `worktreeMap`、`createRestartRequest`、`this.request` / `this.requestUrl`。

**已核实「不算边界」的本仓封装**（这些站点因此判「不改」）：`resolveBin` / `resolveJsEntry` / `ensureProxy` / `awaitHandshake` / `ensureLive` / `performHandoff` / `collectCommitDiffs` / `insertRetrievalTrace` / `fanInCatBranches`（其**入参前置** `listCatBranches` 是裸 `runGit` ⇒ `session-closeout.ts:162` 仍判**改**）/ `removeSessionWorktree`。

## 三、店长裁决（2026-09-17）与重算

### 3.1 三条判据边界改判

| #   | 边界                               | 裁决         | 理由（店长原文要点）                                                                              |
| --- | ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| 1   | `node:fs`                          | **维持判改** | fs 错误常以 `code`/`errno` 存在，正是 `messageOf` 会取空的形态，划出去等于把最会丢诊断的一档放生  |
| 2   | `child.on('error')`（11 处）       | **改判不改** | Node 的 `'error'` 事件恒派发 `Error`，非 Error 兜底零收益；且它是回调体不是 `catch`               |
| 3   | 已自带 `\|\| String(err)` 的 11 处 | **改判不改** | 诊断已经不归零，改它们只有单源化收益——那是另一个目标，且 web/scripts 两处要先迁 `shared` 才能单源 |

### 3.2 重算（命令读数，非散文数字）

```bash
git grep -nE "on\('error'" -- 'packages/**/*.ts' 'scripts/**/*.mjs' 'scripts/**/*.js' ':!*test*' | wc -l
→ 13            # 全仓 on('error') 总数
                # 其中落在 §B 可判面（回调体里用了 `.message`）的 = 11 处，全在档 1
git grep -nE "\?\?\s*String\((err|e|error|ex)\)|\|\|\s*String\((err|e|error|ex)\)" -- <同路径集>
→ 13 行         # 扣掉 web/stores/chat.ts:23（已在「不改」档）⇒ 命中「改」档的 = 11 处
```

| 档                                  | 原判 | 扣减   | 改判后 |
| ----------------------------------- | ---: | ------ | -----: |
| 档 1（子进程 / 回调 / 网络薄封装）  |   38 | −11 −1 | **26** |
| 档 2（网络 / 第三方 SDK）           |   15 | −5 −2  |  **7** |
| 档 3（`JSON.parse` / DB 驱动）      |   17 | −1 −1  | **15** |
| 档 4（客户端不可信入参 / 框架入口） |    5 | —      |  **5** |
| 档 5（`node:fs`）                   |    7 | −1     |  **6** |
| **合计**                            |   82 | −22    | **59** |

> **与店长「约 62」的差异如实记账**：店长按我上轮报告的「`child.on('error')` 9 处」推算 ⇒ 82 − 9 − 11 = 62。**实测是 11 处不是 9 处**（全仓 `on('error')` 13 处，落在可判面的 11 处），故重算为 **82 − 11 − 11 = 60**。
> ⇒ **严格按闸值：60 不 > 60，不触发停手闸**。但店长已裁决拆票且明示「直接开工，不必再来回」，故**按裁决执行拆票**。

### 3.3 一处同型同判改判（实施者判，报备）

`scripts/flywheel/embed-server.e2e.mjs:78` 原在档 2 判「改」。**改判「不改」**，理由与清单已判「不改」的 `scan.mjs:488` **完全同型**：`.mjs` 脚本无法 import TS 单源（跨包）⇒ 强行改 = 各造第二实现 = **违反验收 B1**。B1 与本点不可兼得时，B1 优先（票面 §三 边界明令「不得各造第二实现」）。

⇒ `scripts/**` 侧最终零改动（另票：`.mjs` 单源化需先出 CJS/JSON 形态）。

### 3.4 最终拆票面

| 票   | 档           | 处数 | 文件 |
| ---- | ------------ | ---: | ---- |
| §B1  | 档 1 + 档 4  |   31 | 12   |
| §B2  | 档 2 + 3 + 5 |   28 | 20   |
| 合计 |              |   59 |      |

> **「两票文件面零重叠」不成立（如实报告）**：按档切而非按文件切，`llm/git-utils.ts` / `llm/session-closeout.ts` / `memory/embedding-client.ts` / `connectors/ingest.ts` **四个文件同时出现在两票里**。同 worktree 串行做完后，拆两个自洽 commit 需逐 hunk 拆 patch、且中间态不自洽（§B1 commit 时 §B2 的行未改）⇒ 收益低于风险，**两票合成一个代码 commit**（票面 §3.3 只要求「清单 + 代码」两 commit）。审查按本清单逐档核，或按档筛行。

## 四、落地记录（commit 2 内容）

### 4.1 改动（59 处，23 文件）

**§B1（31 处）**

| 文件:行（改前）                           | 受保护体内的外部调用                     |
| ----------------------------------------- | ---------------------------------------- |
| `index.ts:105`                            | `catch` 直包 `spawn(process.execPath,…)` |
| `llm/git-utils.ts:196,210`                | `execSync`（git reset / clean）          |
| `llm/git-utils.ts:363,475,492,821`        | `execFileSync`（link/branch/worktree）   |
| `llm/worktree-fanin.ts:185,376,392`       | `runGit`                                 |
| `llm/session-closeout.ts:162,188,208,283` | `runGit` / 裸 `listCatBranches`          |
| `git/create-pr.ts:88,121,133,149`         | `execFileP`（gh/git 子进程）             |
| `git/diff-collector.ts:148,172`           | `runGit`                                 |
| `execution/review-fallback.ts:181`        | `spawn`（补投子进程）                    |
| `eval/sampler.ts:55`                      | `scoreReply` fire-and-forget（走 LLM）   |
| `execution/reply.ts:1246,1268`            | DB 驱动 / `createRestartRequest`         |
| `memory/embedding-client.ts:339,432`      | `this.request`(fetch) / `spawnFn`        |
| `routes/connectors.ts:439`                | REST webhook + OneBot 第三方事件         |
| `connectors/socketio.ts:462`              | Socket.IO handler 外层 catch             |
| `index.ts:217,222,223`                    | Fastify `setErrorHandler`（全局出口）    |

**§B2（28 处）**

| 文件:行（改前）                        | 受保护体内                                   |
| -------------------------------------- | -------------------------------------------- |
| `llm/opencode-serve.ts:462,572`        | `fetch` + SSE 事件流                         |
| `memory/embedding-client.ts:355`       | `await res.json()`                           |
| `connectors/onebotOutbound.ts:105`     | `fetch`（OneBot 出站）                       |
| `memory/query-rewrite.ts:110`          | LLM 适配器调用                               |
| `summarizer/index.ts:152`              | LLM 适配器调用                               |
| `ui-review.ts:211`                     | `main().catch()`（内部 fetch/spawn）         |
| `llm/registry.ts:30`                   | `JSON.parse(llmEnvExtra)`                    |
| `memory/embedding.ts:114`              | `getDb().prepare(sql).get()`                 |
| `db/repository/chunks.ts:363`          | `db.prepare(…).all()`（判据式取值）          |
| `db/repository/spans.ts:139`           | `db.prepare(…).run()`                        |
| `db/repository/retrievalEvents.ts:228` | `db.prepare(…).run()`                        |
| `routes/internal.ts:340,341,445,446`   | DB 驱动（**客户端可见面**：`reason`）        |
| `routes/agents.ts:48,51`               | DB UNIQUE 违例（REST handler 边界）          |
| `connectors/ingest.ts:102,275,324`     | DB 驱动 / `createRestartRequest`             |
| `eval/l1-aggregator.ts:211`            | `messagesRepo.insertMessage`                 |
| `eval/attribution.ts:177`              | `messagesRepo.insertMessage`                 |
| `llm/git-utils.ts:733,774`             | `rmdirSync`/`unlinkSync`/`rmSync`            |
| `llm/session-closeout.ts:254`          | `readFileSync`/`writeFileSync`(`.push-gate`) |
| `llm/opencode.ts:145`                  | `mkdtemp`/`writeFile`（+ 客户端图片入参）    |
| `shutdown-request.ts:48`               | `unlinkSync`                                 |

**取值形态**：全部 `import { messageOf } from '<相对路径>/utils.js'`（server 内单源，零第二实现）；
模板串处用 `${messageOf(err) ?? '未知错误'}` 保持原「非空输出」语义；日志字段直接落 `messageOf(err)`。

### 4.2 判「不改」的 67 处（45 原判 + 11 `child.on('error')` + 11 已自带 `String(err)` 兜底）

原 45 处逐条理由见上轮清单（`index.ts` 8 处定时器兜底 / `reply.ts` 7 处只调本仓 / `recovery.ts` 7 处 / `flow-advance.ts` 2 处 / `handoff/index.ts` 2 处 / 各 `resolveBin` 类 6 处 / `probes/*` 6 处非 catch 字段读取 / `web/stores/chat.ts` 跨包 / `scan.mjs:488` 跨包 等），本处不减。

### 4.3 判别性测试（验收 B2 / B3 / B4）

三类边界各一条，全部构造 `throw '<string>'`（非 Error 抛出物）：

| #   | 边界类    | 测试文件:用例                                                                            | 断言                           |
| --- | --------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | 子进程    | `execution/review-fallback.test.ts` › `spawnReviewFallback — 子进程边界的诊断取值单源`   | `reason === 'boom from spawn'` |
| 2   | DB 驱动   | `db/repository/chunks.test.ts` › `R6 §B2 档3：驱动抛非 Error（字符串）…降级 []`          | 返回 `[]` 而非上抛             |
| 3   | REST 入口 | `routes/agents.test.ts` › `R6 §B2 档3：UNIQUE 违例以非 Error（字符串）抛出 → 同样落 409` | `statusCode === 409`           |

**B3 零回归**：既有用例 `gh 未安装（ENOENT，stderr 空）→ not-authed 兜底 err.message 不静默`（`create-pr.test.ts`）与全量 2639 条一并绿。

**B4 真空性反对照（实测）**——逐点回退三个被改取值点：

```bash
git checkout <回退：chunks.ts:366 / agents.ts:49 / review-fallback.ts:182 改回 err.message>
node node_modules/vitest/vitest.mjs run <三个测试文件>
→ Test Files  3 failed (3)
  Tests  3 failed | 81 passed (84)
```

红点数 **3**，断言名（一一对应，无多余红）：

1. `review-fallback.test.ts > spawnReviewFallback — 子进程边界的诊断取值单源（R6 §B2 档1） > spawn 同步抛非 Error（字符串）→ reason 落原串，不退化成兜底词`
2. `agents.test.ts > Agent Routes > POST /api/agents > R6 §B2 档3：UNIQUE 违例以非 Error（字符串）抛出 → 同样落 409，不误升 500`
3. `chunks.test.ts > chunks repo（票己 · 段三索引表） > upsertChunkWithIndexes（扫描器唯一写口） > R6 §B2 档3：驱动抛非 Error（字符串）时诊断单源可判「FTS 缺表」⇒ 降级 []，不误上抛`

回退后已按备份原样恢复，恢复点逐行 `grep` 核验（`messageOf(err)` 三处俱在）。

### 4.4 如实报告：一处「改」判据下**不可判别**的落点

`git/create-pr.ts` 的 4 处改动的**行为差异不可观测**，理由是实现事实而非推断：

`execFileP`（`create-pr.ts:37`）在回调里对 err **赋属性**：

```ts
if (err) {
  err.stdout = String(stdout) // ← 若 err 是非 Error（字符串），这一行抛 TypeError
  err.stderr = String(stderr)
  reject(err)
}
```

Node 的 `execFile` 恒以 `Error` 拒绝 ⇒ 非 Error 分支在真实路径上不可达；即便人为构造，`execFileP` 也会先把原串**替换**成 `TypeError: Cannot create property 'stdout' on string '…'`（实测：首版测试断言 `error === 'boom from gh'`，实收该 TypeError 文案）。

⇒ 这 4 处的收益是**单源化**（消除 `extractErr` 这个同义第二实现，B1 判据），**不是**「诊断不归零」。已在该处 `extractErr` 保留 `|| 'unknown error'`（不换成 `??`）以守住原有「归一成非空串」契约。首版那条测试因不可判别已删除——不拿恒真断言凑账面。

## 五、验收对照（票面 §3.3 表）

| #   | 判据                                                                   | 结果                                                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| B1  | 被改点逐点走 `utils.ts:42` 的 `messageOf`，不得各造第二实现            | ✅ 59 处全走单源 import                                                            |
| B2  | ≥3 类边界的**判别性**测试（`throw 'string'` ⇒ 落出该串，非 undefined） | ✅ 子进程 / DB 驱动 / REST 入口 三类                                               |
| B3  | `throw new Error('x')` ⇒ `'x'`（零回归）                               | ✅ 全量 2639 条绿                                                                  |
| B4  | 真空性反对照：回退任一被改点 ⇒ 对应断言变红，报红点数 + 断言名         | ✅ 红 3 / 断言名见 §4.3                                                            |
| B5  | 清单完整：改/不改两档逐条可复核                                        | ✅ §4.1 / §4.2                                                                     |
| B6  | `pnpm lint` + 全量 `pnpm test` 全绿                                    | ✅ `[lint] ✅ 类型检查通过（3 个包）`；`Test Files 129 passed / Tests 2639 passed` |
| B7  | 一切计数附命令 + 原始读数                                              | ✅ §一 / §3.2                                                                      |

## 六、边界与未尽事项

- 未动 `execution/serial.ts`（§A 独占）、未动 `.husky/**`、未动 `messageOf` 本体、未改任何既有断言。
- `scripts/**` 侧零改动（`.mjs` 无法 import TS 单源，见 §3.3）；`web/stores/chat.ts:23` 同类（跨包）——两者合起来是**「单源化前置：`messageOf` 出 CJS/JSON 形态或迁 `shared`」**一票的素材，挂账。
- 未改的 67 处（§4.2）留挂账。

# R6 §B 分档清单：同型诊断取值点按边界收窄

> 归属票：`R6-crash-label-and-diag-sweep.md` §B（OQ-3）。实施：flash猫。**本文件是 §B 的 commit 1**（`docs/run/**` 免审前缀）。
> 结论：**收窄后判「改」82 处 > 票面停手闸 60 处 ⇒ 停手，代码未动**。见 §五。

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

### 1.1 135 的构成（票面 §3.1 只记了 `serial.ts` 那 1 行注释）

| 类别                             | 处数 | 明细                                                                                                                                 |
| -------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------ |
| §A 独占（`execution/serial.ts`） |    1 | `:37` 注释（R5 §B 后该文件残留 0 处代码点，与票面 §3 一致）                                                                          |
| §B 面**注释**（非代码点）        |    6 | `git/create-pr.ts:82`、`llm/opencode.ts:441`、`llm/opencode.ts:518`、`utils.ts:28`、`logger.ts:20`、`memory/embedding-client.ts:687` |
| §B 面**单源本体**                |    1 | `utils.ts:44`（`messageOf` 函数体，票面 §三 边界：不动本体）                                                                         |
| §B 面**可判代码点**              |  127 | 见 §二 / §三                                                                                                                         |
| **合计**                         |  135 | 1 + 6 + 1 + 127 = 135 ✅                                                                                                             |

> 票面 §3.1 写「含 `serial.ts` 1 行注释 ⇒ 实际 134」。方向对，但**只扣了 1 处**——§B 面另有 6 处注释共 7 处非取值点。**127 才是本票的可判面**。

## 二、判据（本清单采用的唯一规则）

票面 §3.2 的定义是「catch 能接住**非本仓来源**的值」，并给了两条操作性谓词：

- **改**：受保护体（`catch` 体 / 事件回调体）里存在一条路径，其抛出物来自**本仓之外**；
- **不改**：受保护体只调本仓函数，且这些函数**自身已捕获**外部错误（吞掉 / 转成返回值），或**只抛我方 `throw new Error`**。

把这条谓词落到可复核的粒度，本清单按「**受保护体内触达外部的那一处是否裸上抛**」判：

| 档       | 判据                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **改**   | 受保护体内**直接**出现子进程 / 网络 / 第三方 SDK / `node:fs` / `JSON.parse` / DB 驱动；**或**经本仓「裸上抛薄封装」触达上述之一（薄封装 = 不吞错、不包裹、原样上抛） |
| **不改** | 受保护体只调本仓函数，且被调方**已在其内部收口**该外部错误，或抛出的恒为我方 `throw new Error`                                                                       |

**已穷举的本仓「裸上抛薄封装」**（判定「不改」时须逐个排除，否则结论不成立）：

| 封装                               | 位置                                                                              | 为何算边界                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `runGit`                           | `llm/worktree-fanin.ts:61`、`llm/session-closeout.ts:85`、`git/diff-collector.ts` | 直包 `execFileSync('git', …)`，无 catch，错误原样上抛                                   |
| `execFileP`                        | `git/create-pr.ts:36`                                                             | `promisify(execFile)`，gh/git 错误原样 reject                                           |
| `listCatBranches` / `worktreeMap`  | `llm/worktree-fanin.ts`                                                           | 内部走裸 `runGit`（对照：`tryGit`(`:71`) 才是吞错版）                                   |
| `createRestartRequest`             | `restart-request.ts`                                                              | 直调 `writeFileSync`，无 catch                                                          |
| `this.request` / `this.requestUrl` | `memory/embedding-client.ts`                                                      | 内部 `fetch` → 超时转 `embedError`（我方），**其余 `throw err` 原样上抛**（`:559-562`） |

**已核实「不算边界」的本仓封装**（这些站点因此判「不改」）：

| 封装                                                       | 只抛我方 Error 的依据                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `resolveBin`(`llm/cli-utils.ts:45`)                        | 内部两处 `execSync` 各自 `catch`，末尾 `throw new Error('无法找到 …')`                                                              |
| `resolveJsEntry`(`llm/cli-utils.ts:107`)                   | 同上                                                                                                                                |
| `ensureProxy`(`llm/cli-utils.ts:226`)                      | `spawn` 是异步（错误走 `'error'` 事件），函数体只抛我方 Error                                                                       |
| `awaitHandshake`(`memory/embedding-client.ts:453`)         | reject 恒为 `new Error(…)`（`:456`/`:485`）                                                                                         |
| `ensureLive`(`memory/embedding-client.ts:405`)             | 拒绝值经 `embedError` / 上面的 `awaitHandshake` 收口                                                                                |
| `performHandoff`(`handoff/index.ts`)                       | 自带 `catch`(`:238`) 吞掉并 `return null`                                                                                           |
| `collectCommitDiffs`(`git/diff-collector.ts`)              | 两处 `runGit` 各自 `catch` 后 `return null`                                                                                         |
| `insertRetrievalTrace`(`db/repository/retrievalEvents.ts`) | 自带 `catch`(`:222`) 吞掉                                                                                                           |
| `fanInCatBranches`(`llm/worktree-fanin.ts`)                | 内部 `tryGit`/局部 catch 覆盖；但 `fanInCats` 的**入参前置** `listCatBranches` 是裸 `runGit` ⇒ `session-closeout.ts:162` 仍判**改** |
| `removeSessionWorktree`(`llm/git-utils.ts:804`)            | 内部 `execFileSync` 有 catch(`:820`)、`cleanupWorktreeResidue` 有 catch(`:773`)                                                     |

## 三、分档清单（127 个可判点；判「改」的 82 处分布在 **37 个文件**）

### 3.1 「改」82 处

按受保护体触达的外部形态分档（拆票即按此档切）。

**档 1｜子进程 + EventEmitter `'error'`（票面 §3.2 类 1 / 类 4）— 38 处**

| 文件:行                                                | 受保护体内的外部调用                                        |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/server/src/index.ts:85`                      | `child.on('error')`（spawn 飞轮扫描器）                     |
| `packages/server/src/index.ts:105`                     | `catch` 直包 `spawn(process.execPath, …)`                   |
| `packages/server/src/llm/git-utils.ts:196`             | `execSync('git reset --hard HEAD~1')`                       |
| `packages/server/src/llm/git-utils.ts:210`             | `execSync('git checkout -- .')` / `git clean -fd`           |
| `packages/server/src/llm/git-utils.ts:363`             | `execFileSync('cmd'\|'ln', …)`                              |
| `packages/server/src/llm/git-utils.ts:475`             | `execFileSync('git', ['branch', …])`                        |
| `packages/server/src/llm/git-utils.ts:492`             | `execFileSync('git', ['worktree','add',…])`                 |
| `packages/server/src/llm/git-utils.ts:821`             | `execFileSync('git', ['worktree','remove',…])`              |
| `packages/server/src/llm/opencode.ts:353`              | `child.on('error')`                                         |
| `packages/server/src/llm/opencode.ts:354`              | 同上                                                        |
| `packages/server/src/llm/opencode-serve.ts:270`        | `child.on('error')`                                         |
| `packages/server/src/llm/dsh.ts:296`                   | `child.on('error')`                                         |
| `packages/server/src/llm/dsh.ts:297`                   | 同上                                                        |
| `packages/server/src/llm/openai.ts:132`                | `child.on('error')`                                         |
| `packages/server/src/llm/claude.ts:253`                | `child.on('error')`                                         |
| `packages/server/src/llm/worktree-fanin.ts:185`        | `runGit(cwd, ['merge', …])`                                 |
| `packages/server/src/llm/worktree-fanin.ts:376`        | `runGit(cwd, ['worktree','remove',…])`                      |
| `packages/server/src/llm/worktree-fanin.ts:392`        | `runGit(cwd, ['branch','-D',…])`                            |
| `packages/server/src/llm/session-closeout.ts:162`      | `fanInCatBranches` → 前置 `listCatBranches` 裸 `runGit`     |
| `packages/server/src/llm/session-closeout.ts:188`      | `reclaimCatBranches` → `listCatBranches` 裸 `runGit`        |
| `packages/server/src/llm/session-closeout.ts:208`      | `runGit(mainRoot, ['merge','--ff-only',…])`                 |
| `packages/server/src/llm/session-closeout.ts:283`      | `runGit(mainRoot, ['branch','--show-current'])`             |
| `packages/server/src/git/create-pr.ts:88`              | `extractErr`：gh/git 子进程错误的取值点（**同义第二实现**） |
| `packages/server/src/git/create-pr.ts:121`             | `execFileP('gh', ['auth','status'])`                        |
| `packages/server/src/git/create-pr.ts:133`             | `execFileP('git', ['ls-remote', …])`                        |
| `packages/server/src/git/create-pr.ts:149`             | `execFileP('gh', ['pr','create', …])`                       |
| `packages/server/src/git/diff-collector.ts:148`        | `runGit(['log', '--all', …])`                               |
| `packages/server/src/git/diff-collector.ts:172`        | `runGit(['show', …])`                                       |
| `packages/server/src/execution/review-fallback.ts:166` | `child.on('error')`（补投子进程）                           |
| `packages/server/src/execution/review-fallback.ts:181` | `catch` 直包 `spawn(process.execPath, …)`                   |
| `packages/server/src/ui-review.ts:89`                  | `child.on('error')`（`ollama serve`）                       |
| `packages/server/src/eval/sampler.ts:55`               | `scoreReply(…)` fire-and-forget（内部走 LLM 适配器）        |
| `scripts/flywheel/scan.mjs:540`                        | `child.on('error')`（拉起 tsx）                             |
| `packages/server/src/execution/reply.ts:1246`          | `messagesRepo.updateMessageExtra` → DB 驱动裸上抛           |
| `packages/server/src/execution/reply.ts:1268`          | `createRestartRequest` → `writeFileSync` 裸上抛             |
| `packages/server/src/memory/embedding-client.ts:432`   | `this.opts.spawnFn(scriptPath)`（sidecar spawn 注入点）     |
| `packages/server/src/memory/embedding-client.ts:339`   | `this.request` → `fetch`（非超时路径 `throw err` 裸上抛）   |
| `packages/server/src/memory/embedding-client.ts:505`   | `this.requestUrl` → `fetch`（同上）                         |

> 档 1 里 4 条严格说跨了「网络」而非「子进程」（最后 3 行 + `sampler.ts:55`），**归此档只是为了拆票时不再切碎**，理由列在右列。

**档 2｜网络 / 第三方 SDK（票面 §3.2 类 2）— 15 处**

| 文件:行                                                | 受保护体内的外部调用                                   |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `packages/server/src/llm/pi.ts:197`                    | `session.abort()`（pi SDK promise）                    |
| `packages/server/src/llm/pi.ts:217`                    | `session.prompt(…)`（pi SDK promise）                  |
| `packages/server/src/llm/pi.ts:257`                    | 整段 pi 事件流外层 `catch`                             |
| `packages/server/src/llm/pi.ts:259`                    | 同上（用户可见面）                                     |
| `packages/server/src/llm/pi.ts:271`                    | `session.dispose()`（pi SDK）                          |
| `packages/server/src/llm/opencode-serve.ts:462`        | `fetch` + SSE 事件流                                   |
| `packages/server/src/llm/opencode-serve.ts:572`        | `fetch` + SSE 事件流（外层）                           |
| `packages/server/src/memory/embedding-client.ts:355`   | `await res.json()`（WHATWG `Response`，第三方/运行时） |
| `packages/server/src/connectors/onebotOutbound.ts:105` | `fetch`（OneBot 出站）                                 |
| `packages/server/src/memory/query-rewrite.ts:110`      | LLM 适配器调用（查询改写）                             |
| `packages/server/src/summarizer/index.ts:152`          | LLM 适配器调用（摘要生成）                             |
| `packages/server/src/ui-review.ts:211`                 | `main().catch()`（内部 fetch / spawn）                 |
| `scripts/flywheel/embed-server.mjs:138`                | 第三方 `pipeline('feature-extraction', …)` promise     |
| `scripts/flywheel/embed-server.mjs:191`                | HTTP server handler（`createServer` 回调）             |
| `scripts/flywheel/embed-server.e2e.mjs:78`             | `fetch('/health')`                                     |

**档 3｜`JSON.parse` / DB 驱动（票面 §3.2 类 3）— 17 处**

| 文件:行                                                    | 受保护体内                                     |
| ---------------------------------------------------------- | ---------------------------------------------- |
| `packages/server/src/llm/registry.ts:30`                   | `JSON.parse(llmEnvExtra)`                      |
| `packages/server/src/llm/pi.ts:370`                        | `JSON.parse(fs.readFileSync(…))`               |
| `packages/server/src/memory/embedding.ts:114`              | `getDb().prepare(sql).get()`                   |
| `packages/server/src/db/repository/chunks.ts:363`          | `db.prepare(…).all()`                          |
| `packages/server/src/db/repository/spans.ts:139`           | `db.prepare(…).run()`                          |
| `packages/server/src/db/repository/retrievalEvents.ts:228` | `db.prepare(…).run()`                          |
| `packages/server/src/routes/internal.ts:340`               | `knowledgeRepo.searchKnowledgeByVector` → 驱动 |
| `packages/server/src/routes/internal.ts:341`               | 同上（**客户端可见面**：`reason` 回传）        |
| `packages/server/src/routes/internal.ts:445`               | `queryRepo.queryTable` → 驱动                  |
| `packages/server/src/routes/internal.ts:446`               | 同上（客户端可见面）                           |
| `packages/server/src/routes/agents.ts:48`                  | DB UNIQUE 违例（REST handler 边界）            |
| `packages/server/src/routes/agents.ts:51`                  | 同上                                           |
| `packages/server/src/connectors/ingest.ts:102`             | `messagesRepo.hasMessagesByTaskId` → 驱动      |
| `packages/server/src/connectors/ingest.ts:275`             | `messagesRepo.insertMessage` → 驱动（FK 违例） |
| `packages/server/src/eval/l1-aggregator.ts:211`            | `messagesRepo.insertMessage` → 驱动            |
| `packages/server/src/eval/attribution.ts:177`              | `messagesRepo.insertMessage` → 驱动            |
| `scripts/flywheel/retire-message-memory.mjs:143`           | better-sqlite3 直调                            |

**档 4｜客户端不可信入参 / 框架入口（票面 §3.2 类 5）— 5 处**

| 文件:行                                          | 入口                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| `packages/server/src/index.ts:217`               | Fastify `setErrorHandler`（全局错误出口）                |
| `packages/server/src/index.ts:222`               | 同上（`statusCode < 500` 时把 `err.message` 回传客户端） |
| `packages/server/src/index.ts:223`               | 同上                                                     |
| `packages/server/src/routes/connectors.ts:439`   | REST webhook handler + OneBot 第三方事件                 |
| `packages/server/src/connectors/socketio.ts:462` | Socket.IO handler 外层 catch                             |

**档 5｜`node:fs`（票面 §3.2 五类**未列**，判为「非本仓来源」归此档，请店长复核）— 7 处**

| 文件:行                                           | 受保护体内                                       |
| ------------------------------------------------- | ------------------------------------------------ |
| `packages/server/src/llm/git-utils.ts:733`        | `rmdirSync` / `unlinkSync`（残留链接删）         |
| `packages/server/src/llm/git-utils.ts:774`        | `rmSync(wtPath, {recursive:true})` 等            |
| `packages/server/src/llm/session-closeout.ts:254` | `readFileSync` / `writeFileSync`（`.push-gate`） |
| `packages/server/src/llm/pi.ts:379`               | `fs.rmSync(dir, …)`                              |
| `packages/server/src/llm/opencode.ts:145`         | `mkdtemp` / `writeFile`（+ 客户端图片入参）      |
| `packages/server/src/shutdown-request.ts:48`      | `unlinkSync(SHUTDOWN_REQUEST_FILE)`              |
| `packages/server/src/connectors/ingest.ts:324`    | `createRestartRequest` → `writeFileSync`         |

### 3.2 「不改」45 处（留挂账）

| 文件:行                                                                      | 理由                                                                                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/index.ts:260,269,283,294,303,309,320,329`（8）          | 受保护体 = 本仓定时器函数（`runL1Aggregation` / `classifyEpisodes` / `runEpisodeAttribution` / `replayStuckUserMessages`），其内部逐条自捕获                    |
| `packages/server/src/execution/reply.ts:279`（1）                            | 本仓 `insertRetrievalTrace`，内部 `catch`(`retrievalEvents.ts:222`) 已收口                                                                                      |
| `packages/server/src/execution/reply.ts:483,522`（2）                        | 本仓 `generateFullSummary`（summarizer 内部自捕获，`summarizer/index.ts:149`）                                                                                  |
| `packages/server/src/execution/reply.ts:711,891`（2）                        | 本仓 `performHandoff`，内部 `catch`(`handoff/index.ts:238`) 吞掉并 `return null`                                                                                |
| `packages/server/src/execution/reply.ts:756`（1）                            | 本仓 `retrieveMemoryContext`（记忆模块自带 reason 台账，抛错前已转返回值）                                                                                      |
| `packages/server/src/execution/reply.ts:1221`（1）                           | 本仓 `collectCommitDiffs`，内部两处 `runGit` 各自 `catch` → `return null`                                                                                       |
| `packages/server/src/execution/recovery.ts:132,171,175,363,368,498,502`（7） | 受保护体 = 本仓 `executeAgentsSerial` / `insertMessage`+`emitSystemNotice`（per-session 防御，外层兜底）                                                        |
| `packages/server/src/execution/flow-advance.ts:154,239`（2）                 | 本仓 `ingestUserMessage` / `resolveCommitChain`+`flowStatesRepo.*`                                                                                              |
| `packages/server/src/llm/opencode.ts:38`（1）                                | `resolveBin` 只抛我方 `throw new Error('无法找到 …')`                                                                                                           |
| `packages/server/src/llm/opencode.ts:520`（1）                               | **非 catch**：第三方事件载荷的字段读取（`event.error?.data?.message ?? …`），无抛出物可归因，`messageOf` 不适用                                                 |
| `packages/server/src/llm/opencode-serve.ts:27`（1）                          | `resolveBin`，同上                                                                                                                                              |
| `packages/server/src/llm/dsh.ts:31`（1）                                     | `resolveJsEntry`，同上                                                                                                                                          |
| `packages/server/src/llm/openai.ts:29`（1）                                  | `resolveBin`，同上                                                                                                                                              |
| `packages/server/src/llm/openai.ts:79`（1）                                  | `ensureProxy` 只抛我方 Error（`spawn` 错误走异步 `'error'` 事件）                                                                                               |
| `packages/server/src/llm/claude.ts:104`（1）                                 | `resolveBin`，同上                                                                                                                                              |
| `packages/server/src/memory/embedding-client.ts:327`（1）                    | `ensureLive` 拒绝值经 `embedError`/`awaitHandshake` 收口                                                                                                        |
| `packages/server/src/memory/embedding-client.ts:437`（1）                    | `awaitHandshake` reject 恒为 `new Error(…)`(`:456`/`:485`)                                                                                                      |
| `packages/server/src/llm/session-closeout.ts:226`（1）                       | 本仓 `removeSessionWorktree`，内部 `execFileSync` 有 catch                                                                                                      |
| `packages/server/src/connectors/ingest.ts:396`（1）                          | 本仓 `executeAgentsSerial`（`.catch` 兜底未处理拒绝）                                                                                                           |
| `packages/server/src/handoff/index.ts:241,244`（2）                          | 受保护体 = 本仓 `insertSession` / `bus.emitSessionHandoff`（DB 经 repo 且此处为交接收尾兜底）                                                                   |
| `packages/web/src/stores/chat.ts:23`（1）                                    | **跨包**：web 侧无法 import server 的 `utils.ts`；且取值面是 HTTP body 字段（`err.body.message`）非 catch 抛出物 ⇒ 单源化需先迁 `messageOf` 到 `shared`（另票） |
| `scripts/flywheel/scan.mjs:488`（1）                                         | `msgOf` 是**同义第二实现**，但 `.mjs` 脚本无法 import TS 单源（跨包）；`scripts` 侧要单源化需先出 CJS/JSON 形态（另票）                                         |
| `scripts/probes/dsh-acp-probe.e2e.mjs:142,270,279,283,292,296`（6）          | **非 catch**：JSON-RPC 响应体字段读取（`res.error.message` 等），与 `req`/`res` 同层，无抛出物                                                                  |
| `packages/server/src/utils.ts:44`（1，**本体**）                             | `messageOf` 函数体本身，票面 §三 边界明令不动                                                                                                                   |

### 3.3 §A 面（不计入 §B）

| 文件:行                                      | 说明                               |
| -------------------------------------------- | ---------------------------------- |
| `packages/server/src/execution/serial.ts:37` | 注释（R5 §B 后该文件代码点残留 0） |

## 四、合计

| 档             |    处数 |
| -------------- | ------: |
| 改             |  **82** |
| 不改           |  **45** |
| 非本族（注释） |       6 |
| 单源本体       |       1 |
| §A 独占        |       1 |
| **合计**       | **135** |

改 82 / 可判 127 = **64.6%**——收窄只削掉约三分之一。

## 五、停手（触发票面 §3.2 停手闸）

票面 §3.2：**「收窄后若仍 > 60 处 ⇒ 停手报我，我拆票」**。本清单读数 **82 > 60** ⇒ **代码一行未改，停手待裁**。

### 5.1 为什么收窄削不动（如实记账，供店长改判据）

票面 §3.2 的五类（子进程 / HTTP / `JSON.parse`·DB / 第三方回调 / 客户端入口）在**本仓的错误处理里就是绝大多数**——本仓的内层 `catch` 几乎全部落在某个外部调用的紧邻处（这是好设计，不是巧合）。真正「只调本仓函数且被调方已自捕获」的只有 §3.2 那 45 处，其中 8 处还是 `index.ts` 的定时器兜底同一个形状。

### 5.2 拆票建议（二选一，店长点一个即可开工）

- **方案甲（按档拆，推荐）**：
  - `§B1` = 档 1（子进程 / 回调，38 处）+ 档 4（客户端入口，5 处）= **43 处**
  - `§B2` = 档 2（网络 / 第三方 SDK，15 处）+ 档 3（DB·JSON，17 处）+ 档 5（fs，6 处）= **38 处**
  - 两票文件面零重叠、可并行；每票 < 60，均落在一个审查预算内。
- **方案乙（按包拆）**：`§B1` = `packages/server/src/llm/**` + `packages/server/src/git/**`（约 45 处）；`§B2` = 其余（约 37 处）。

### 5.3 三条待店长裁的判据边界（本次按「从严」判，改判即改清单）

1. **`node:fs` 归不归边界**：票面 §3.2 五类**未列 `fs`**，但 `fs` 确属「非本仓来源」。本清单按定义判**改**（档 5，6 处）。若不改 ⇒ 该 6 处转「不改」。
2. **`child.on('error')` 算不算「catch 能接住」**：它是回调体不是 `catch`，但票面 §3.2 类 4 明列 `EventEmitter 'error'`。本清单判**改**（9 处）。实测上 Node 的 `'error'` 事件恒派发 `Error` ⇒ 若按「抛出物必为 Error」判，该 9 处可降级为「不改」（此时总数 82 → 73，**仍 > 60**）。
3. **已自带 `|| String(err)` 兜底的站点**（`pi.ts` 7 处、`embedding-client.ts:505`、`scripts/flywheel/*` 3 处，共 11 处）：它们**已经**能吃住非 Error 抛出物、诊断不归零，改它们只为**单源化**（B1）。本清单按判据判**改**；若「只改会丢诊断的点」，可降 11 处（此时总数 82 → 71，**仍 > 60**）。

> 三条全按最宽口径扣减后为 **71 处**，**仍越 60 闸** ⇒ 无论怎么裁，方案甲/乙的拆票都需要。

## 六、交付状态

- **本文件 = §B commit 1**（`docs/run/**` 免审前缀），已提交。
- **§B commit 2（代码）未做**——停手闸触发，等店长裁决拆票或改判据。
- 未动 `serial.ts`（§A 独占）、未动 `.husky/**`、未动 `messageOf` 本体、未改任何既有断言。

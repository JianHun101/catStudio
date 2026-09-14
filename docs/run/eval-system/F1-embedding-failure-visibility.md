# F1 止血单：嵌入 sidecar 故障可见性（读 body / 接 stderr / 日志分文件）

> 来源：用户 2026-09-14 裁「顺序按你建议的走」——在执行顺序 **R1 → 止血单（并行）→ R2 设计 → OQ-6 → P3** 里，本单是那个「与 R1 并行、零依赖」的止血项。
> 定位：**零依赖**。三条改动都不依赖 R1 的 DDL，也不改检索行为 ⇒ **可与 R1 并行**（冲突面见 §六）。
> 状态：**票单已立，未派活**。
> **为什么叫「止血」而不是「埋点」**：在不知道故障长什么样之前设计更多列，是给一个看不见的病加更多仪表盘。本单先让**病可见**，再加仪表。

## 一、一句话结论

**嵌入链坏了，系统知道、日志不知道。** 三条病灶各断一层，合起来的效果是：**「生产上嵌入到底挂没挂过」在现状下不可判定。**

## 二、病灶三条（均实测）

### F1-a 失败分支只读 status，根因在 20 行之前被扔掉

```
embedding-client.ts:337-340
    if (!res.ok) {
      this.dropSidecar()
      return this.failAll(texts.length, 'bad-status', `POST /v1/embeddings → HTTP ${res.status}`)
    }
```

`detail` **只含状态码**。而 sidecar **已经把根因写进 body 了**：

```
embed-server.mjs:161
      sendJson(res, 500, { ok: false, reason: 'internal', detail: err?.message || String(err) })
```

`res.json()` 只在**成功路径**上被调用（`embedding-client.ts:344`，位于 `:337` 的早退之后）⇒ 非 2xx 时 **body 从未被读过**。

**实测落痕**（`packages/server/data/cat-study.log`）：

```json
{
  "level": "error",
  "module": "memory:embedding-client",
  "msg": "嵌入不可用，记忆链降级",
  "reason": "bad-status",
  "detail": "POST /v1/embeddings → HTTP 500"
}
```

**根因信息量为零**——而它就在同一个 HTTP 响应里，一行之前。

### F1-b `child.stderr` 从 spawn 出来**无人接管**

```
embedding-client.ts:594-598
const defaultSpawn: SpawnSidecar = (scriptPath) =>
  spawn(process.execPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],     // ← stderr 是管道
    windowsHide: true,
  })
```

- 整个 `embedding-client.ts`（651 行）里 **`stderr` 只出现 1 次**：`:137` 的接口声明 `stderr: NodeJS.ReadableStream | null`。**没有任何 `.on('data')`。**
- **对照**：五个 CLI 适配器全接了——
  - `llm/claude.ts:244` `child.stderr?.on('data', ...)`（`:258` 退出时落 `log.error`）
  - `llm/cli-utils.ts:460`（超时 timer 的 bump）+ `:495-500`（分级落痕，截断 500 字符）

**两重害**：

1. **诊断全丢**：模型加载失败 / OOM / 端口占用 / Python 异常栈，全在 stderr 上，一条没留；
2. **管道未被消费 ⇒ 子进程可能写阻塞**：`stdio` 是 `'pipe'` 而读者不存在，OS 管道缓冲（Windows 约 64 KB）写满后，**sidecar 写日志会阻塞**。这是**挂死**而不是报错——表现为探活超时，而根因在几秒前就被自己堵死了。

### F1-c 测试与生产**写同一个日志文件**，且 `LOG_LEVEL` 隔离是死的

**路径来源**（无 env 覆盖）：

```
logger.ts:22-23
const LOG_DIR = path.join(__dirname, '..', 'data')
const LOG_FILE = path.join(LOG_DIR, 'cat-study.log')
logger.ts:169      fs.appendFileSync(LOG_FILE, formatLine(...) + '\n')
```

`__dirname` 恒为 `packages/server/src` ⇒ **dev / prod / 测试三者写同一个 `packages/server/data/cat-study.log`**（实测该文件 856 KB，另有 10.4 MB 轮转件 `cat-study.log.1`）。

**实测证据（测试夹具与生产条目逐行交错在同一文件）**——`2026-09-14T16:28:40` 窗口：

```json
{"msg":"flow transition recorded","sessionId":"session-a","commitSha":"aaaa...aaaa","state":"quality-gate"}
{"msg":"eval scoring failed (fire-and-forget)","messageId":"m-1","sessionId":"s-1","agentName":"实施猫"}
{"msg":"session worktree ready","sessionId":"wt-iso-b-0002","branch":"session/wt-iso-b","wtPath":"C:\\...\\Temp\\catStudy-sessions\\wt-iso-b"}
{"msg":"test supervisor 启动","bin":"opencode","parentPid":27412}
{"msg":"清理了陈旧的关停请求文件","file":"...\\node_modules\\.cache\\restart-test-shutdown\\.shutdown-request"}
```

9 秒后 `16:28:49` 的 6 条 `bad-status` **即由该测试轮产生**。

> **活体实证（2026-09-14 16:46，本票落盘后第一次提交时现场采集）**：该次 commit 的 lint-staged 跑批（`112 passed / 2233 passed`）**在跑批过程中又往生产日志写了 2 条**——
>
> ```
> 16:46:29.322 ERROR memory:embedding-client 嵌入不可用，记忆链降级 {"reason":"bad-status","detail":"POST /v1/embeddings → HTTP 500"}
> 16:46:29.511 ERROR memory:embedding-client 嵌入不可用，记忆链降级 {"reason":"bad-status","detail":"POST /v1/embeddings → HTTP 500"}
> ```
>
> **这不是历史样本，是写这票时新产生的**——同一次跑批还同时验证了 F1-a 的病灶：`detail` 仍然只有 `HTTP 500`，根因（`embed-server.mjs:161` 写进 body 的那个）依旧没被读出来。

**而且隔离手段已经写了、但没生效**：

```
packages/server/vitest.config.ts:20      LOG_LEVEL: 'error',
```

这条**是死的**——`setLogLevel` 全仓只在**一个地方**被调用：

```
index.ts:122-124
  if (process.env.LOG_LEVEL) {
    setLogLevel(process.env.LOG_LEVEL as LogLevel)
  }
```

测试**不 import `index.ts`**（直接 import 被测模块）⇒ `minLevel` 保持模块初值 `'debug'`（`logger.ts:38` `let minLevel: LogLevel = 'debug'`）⇒ **vitest 配置里写的 `error` 从未被应用**。硬证据：`2026-09-14T00:42:02.612` 落了一条 `"level":"debug"` 的嵌入降级行，**而它所在的测试轮配置里写着 `LOG_LEVEL=error`**。

> ⚠️ **更正我在地图里写的一条**（`map.md` 的 F1 条目）：原文写「实测 **26 次** bad-status 全落在测试窗口内」。现在更正为——**抽样窗口能证明测试条目与生产条目同文件交错，但「全部是测试造的」这个结论既证不出、也证不伪**，因为两个来源在文件里**没有任何可分标记**。这正是 F1-c 要治的病，而不是它的前提。（计数本身也不准：现测当前日志 `bad-status` **15 行**、轮转件 `cat-study.log.1` **75 行**。）

## 三、修法（三条，逐一钉死）

### F1-a 非 2xx 时读一次 body

在 `embedding-client.ts:337` 的早退分支里，**先尝试读 body**，把它并入 `detail`：

- **必须不抛**——它在失败路径上，抛了会把「嵌入失败」升级成「未捕获异常」；
- **必须有上限**——截断（建议 500 字符，与 `cli-utils.ts:498` 同款）；
- **非 JSON / body 为空 / 读失败** ⇒ **回落**到现有文案 `POST /v1/embeddings → HTTP ${status}`，**不新增失败态**；
- 取 `payload.detail`（`embed-server.mjs:161` 的字段名），可选带 `payload.reason`。

### F1-b 接管 `child.stderr`

`defaultSpawn` 返回的 child 上挂 `stderr.on('data', ...)`，按 `cli-utils.ts:495-500` 的形态落痕（截断 + 分级）。

**注意**：`SidecarChild` 接口（`:134-137`）已声明 `stderr`，**接口不用改**；改的是 `defaultSpawn` 里没人调它。

**已知缺口（本票如实申报，不解决）**：`stderr` 现在是**按需 spawn**、失败即杀（票丁 P3-1）。要在 `defaultSpawn` 里挂监听，监听器**必须在 `spawn` 返回后立即挂上**——不能等 `ensureLive()` 返回，否则冷启动期的 stderr 会漏。

### F1-c 测试日志与生产日志分文件（**照抄本仓已有范式**）

本仓**已经有这个模式**，不需要新设计：

```
packages/server/vitest.config.ts:26-28
      // 重启机制文件隔离——测试跑批的 afterEach 清理（socketio.test.ts unlinkSync）只会碰
      // 该隔离目录，不再删除运行时真实 .restart-request/.restart-done（17:38 事故根因）
      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',
```

**同一个病（测试碰运行时真实文件）、同一个药（env 变量把路径重定向到 `node_modules/.cache/`）、同一个事故形态（17:38 那次是删掉真实的关停文件）**。照做：

- **c1（分文件）**：`logger.ts:23` 的 `LOG_FILE` 支持 env 覆盖（建议 `LOG_FILE`；若担心太泛，用 `CATSTUDY_LOG_FILE`），vitest `test.env` 指到 `node_modules/.cache/test-logs/cat-study-test.log`；
- **c2（让 `LOG_LEVEL` 真的生效）**：让 `logger.ts` 模块初始化时读一次 `process.env.LOG_LEVEL`（`let minLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'debug'`）。**生产语义不变**（`index.ts:122` 仍会再设一次），测试则第一次真正拿到 `error` 级。

**c1 与 c2 都要**：c1 分开文件，c2 才让测试轮不再往任何文件里灌 debug 噪声——只做 c1 的话测试文件里仍会有大量 debug 行。

## 四、验收标准（行为可验证）

1. **F1-a 根因可见**：mock 一个返回 `500` + `{ ok:false, reason:'internal', detail:'模型加载失败: xxx' }` 的 sidecar，断言落痕的 `detail` **包含 `模型加载失败: xxx`**（改前只含 `HTTP 500`）。
2. **F1-a 不新增失败态**：mock 返回 `500` + **非 JSON**（纯文本 / 空 body）⇒ `reason` 仍为 `bad-status`、`detail` 回落到 `HTTP 500` 文案、**本轮无未捕获异常**。
3. **F1-a 不抛**：mock body 读取本身抛错（流被中断）⇒ 同上，一律回落。
4. **F1-b stderr 有痕**：stub 一个往 stderr 写 `boom` 的假 sidecar，断言日志出现该内容（截断到上限内）。
5. **F1-b 不阻塞**：stub 一个连续往 stderr 写 **> 1 MB** 的假 sidecar，断言探活/请求**仍能完成**（改前会在管道写满后阻塞）。**这条是本票唯一能证明「第二重害」的用例**。
6. **F1-c 分文件**：跑**全套** `npx vitest run` 之后，`packages/server/data/cat-study.log` 的**行数增量为 0**（改前会新增）。
7. **F1-c `LOG_LEVEL` 生效**：测试进程内断言 `minLevel`（或等效可观察面）为 `error`；且测试轮产生的 debug 行**不出现在任何日志文件里**。
8. **生产语义不变**：`.env` 不设 `LOG_LEVEL` 时生产仍输出 debug（`logger.ts` 默认值不变）；`.env` 设 `LOG_LEVEL=info` 时行为与改前一致。
9. `node scripts/lint.js` 通过；全套 `npx vitest run` 绿（用例数**只增不减**）。
10. 提交 `catstudy [uuid]`；提交前 grep 复核行号（本仓纪律；本票行号均为 2026-09-14 实测，落地前须复核漂移）。

## 五、边界（明写不做）

- **不改 `EmbedFailureReason` 的值域**——不加新枚举、不改现有 **6 个**值（`embedding-client.ts:92-98`：`spawn-failed` / `health-timeout` / `request-timeout` / `bad-status` / `dim-mismatch` / `not-enabled`）。那是**行为面**，属 R1 的 `query_embed_ok`。
- **不改重试 / 熔断策略**——`RETRYABLE_REASONS`、`refusalReason()`、30 秒冷却（`:43`）、`dropSidecar()` 时机**一律原样**。
- **不改降级行为**——嵌入挂了仍然降级到纯关键词通道，**这是对的设计**（关键词通道正是为短词召回设计的）。
- **不把降级暴露到所有消费面**——「让 keyword-only 时 `reason` 不再是 `ok`」是 R1 的活（`query_embed_ok` 列），**本票不做**，避免与 R1 抢同一段代码。
- **不动 R1 / R1-b 的改动面**（见 §六）。
- **不做 `db/index.ts:641-647` 的 `catch {}`**——C1 §三 已明写另立一票，本票不捆。
- **不引入第三方日志库**——`logger.ts` 是自研单文件，本票只改它的**路径来源**与**级别初值**。

## 六、依赖与并行（与 R1 的关系）

| 文件                                                                       | F1 动       | R1 动                    | R1-b 动 | 冲突面                     |
| -------------------------------------------------------------------------- | ----------- | ------------------------ | ------- | -------------------------- |
| `memory/embedding-client.ts`                                               | F1-a / F1-b | —                        | —       | **无**                     |
| `logger.ts`                                                                | F1-c        | —                        | —       | **无**                     |
| `vitest.config.ts`（server）                                               | F1-c        | 新增测试文件（不改配置） | 同      | **低**（配置 vs 测试文件） |
| `db/repository/chunks.ts` / `memory/index.ts` / `db/index.ts` / `reply.ts` | —           | 主战场                   | 主战场  | **无**                     |

**结论：F1 与 R1 可并行**，冲突面仅「R1 新增测试文件」与「F1 改 vitest `test.env`」——两者改的不是同一个键，**真冲突概率极低**，若撞上按 R1 优先、F1 重跑一次即可。

**F1 对 R1 的正向作用**：F1-a / F1-b 让 R1 上线后能立刻分辨「嵌入失败的原因是什么」——否则 `query_embed_ok=0` 只是一个**光秃秃的布尔**，知道「没跑向量通道」但不知道**为什么**。

## 决策留痕

- **跳 grilling**：本单三条病灶均来自**用户逐轮追问触发的实测**（「为什么会有压根没跑向量通道的情况」那一轮），每条都带源码行号 + 日志样本 → 无待澄清的需求分歧，故不单跑 grill。
- **Gate A 需求照准**：需求 = 「让嵌入链的故障在生产日志里可见」；§四 10 条均可机械判定（`detail` 含根因串 / 非 JSON 回落 / >1MB stderr 不阻塞 / 生产日志行数增量 0 / 测试 debug 行归零）。
- **Gate B 契约锁定**：边界 = §五（明写不做：不改枚举值域、不改重试熔断、不改降级行为、不做 `query_embed_ok`、不引第三方日志库）；契约 = §三 三条改法逐个钉死 + F1-c 明确「照抄 `RESTART_FILES_DIR` 范式」；验收 = §四。
- **Gate C 反向证明·逐条对账后补了三处**：
  1. **F1-b 补「监听器必须在 spawn 返回后立即挂」**——初稿只写「挂 `stderr.on('data')`」，没写挂的**时机**；按需 spawn + 失败即杀的模型下，挂在 `ensureLive()` 之后会漏掉冷启动期的 stderr（**恰是最可能出根因的那一段**）；
  2. **F1-c 从「分文件」扩成 c1+c2**——初稿只想到重定向文件，**漏了 `LOG_LEVEL` 在测试里是死的**（`setLogLevel` 只在 `index.ts:122` 调用，测试不 import 它）。只做 c1 的话测试日志文件里仍会有大量 debug 行，「隔离」只做了一半；
  3. **§二 F1-c 补「更正地图里的说法」**——地图原写「26 次 bad-status 全落在测试窗口内」是个**过强的断言**（同型错误本仓已犯过一次：把「证明不存在」写宽）。更正为「抽样证实同文件交错；全部归因**不可判定**」——**后者才是本票的立论，且它更强**（不是「日志脏」，是「这些问题答不出来」）。
- **本单为何不并入 R1**：R1 的判据是「不改行为、纯新增采集」，F1-a / F1-b / F1-c **全都是改行为**（多了 body 读取、多了 stderr 消费、日志去向变了）。按「是否改行为」这把尺子——**与把 R1-b 拆出去同一把尺**——不并入。
- **落盘后逐条 grep 复核行号，抓到两处实质错误（2026-09-14，提交前）**——本仓纪律「提交前 grep 复核行号」在这次**确实拦住了东西**，不是礼仪：
  1. **「现有 12 个值」→ 实测 6 个**（`embedding-client.ts:92-98`：`spawn-failed` / `health-timeout` / `request-timeout` / `bad-status` / `dim-mismatch` / `not-enabled`）。行号区间也从「`:87-96` 一带」修正为精确的 `:92-98`（原区间起点 `:85` 是 `RETRYABLE_REASONS`，**不是类型定义**）。
     **根因同 D12**：凭印象写计数、没数。**这是同一病灶在本会话的第二次复发**——D12 记的是「13 处 / 5 处」两套单位混用，这次是「12 个」按哪种口径都不存在。**规矩重申**：票面一切计数必须实测，且写明口径。
  2. **`logger.ts:33` → 实测 `minLevel` 在 `:38`**（`:33` 是 `LEVEL_ORDER` 里的 `warn: 2`）。偏 5 行，另加 `:40` 的 `setLogLevel` 定义。
  - **复核方式**：`grep -on "<file>:[0-9-]*" <票面>` 取全部引用 → 逐条 `sed -n` 对源。**本票共 19 处行号引用，2 处错**（错因均为「凭印象」而非漂移：源文件当日未改动）。

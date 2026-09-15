# 修复留痕：`listen(0)` 撞 WHATWG 禁用端口黑名单（测试侧 + 生产侧）

> 归属：`docs/run/flaky-precommit/`（本票实施轮）。
> 依据：`finding-2026-09-16.md`（根因）+ `tickets.md`（票面）。
> 复跑：`node node_modules/vitest/vitest.mjs run <path>`（仓外零依赖；worktree 内 `pnpm test` 会被
> `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH` 挡住，与 pnpm 自身有关，非本票引入）。

---

## 结论先行

4 处 `listen(0)` 落点全部加固：**绑定后按真实 oracle（`fetch`）校验可达性**，命中黑名单即换端口重来；
生产侧若端口是显式指定的，则**启动即报错**（不静默换端口——客户端按固定端口对接，换了就是骗人）。

**判据不是「抄一份黑名单」。** 那份表随 undici 版本漂移，抄一份就是把同一个 bug 换成「下次静默复发」。
故改为**真的 fetch 一次**：TCP 层判不出来（实测同一端口 `CONNECT-OK` 与 `bad port` 并存），`fetch` 是唯一 oracle。

---

## 一、修复面（4 处落点）

| #   | 落点                                                               | 处置                                               | 行            |
| --- | ------------------------------------------------------------------ | -------------------------------------------------- | ------------- |
| 1   | `packages/server/src/memory/embedding-client.test.ts` `startStub`  | `listen(0)` → `listenFetchable(server)`            | `:175`        |
| 2   | 同上，`STUB_SIDECAR_SRC`（**子进程**假 sidecar）                   | 内联探针 + 有界重取（独立进程拿不到 test-helpers） | `:733`–`:751` |
| 3   | `scripts/flywheel/scan.test.js` `startEmbedStub`                   | `listen(0)` → `listenFetchable(server)`            | `:652`        |
| 4   | `scripts/flywheel/embed-server.mjs` `createEmbedServer().listen()` | 绑定后校验；OS 分配态重取、pin 态抛错              | `:259`–`:285` |

**共享载体**：`packages/server/src/test-helpers.ts`（`isFetchReachable:249` / `listenFetchable:271` /
`withFetchablePort:289` / `closeServer:307`）——这是仓内**既有的**跨包测试辅助（`scan.test.js` 本来就
从这里引 `createTestDb`），故不新增边界。

**落点 4 的覆盖面比看上去大**：`embed-server.test.js` 的 3 处 `app.listen(0)`、生产 `main()`、
以及 `scan.mjs:575` 强制 `EMBED_SIDECAR_PORT='0'` 的扫描器 sidecar，**都走这一个函数**。

---

## 二、验收逐条（F1–F6）

| #   | 判据                      | 读数                                                                                                                                                      |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 先复现                    | **确定性复现**（比原「偶发」更强的形态）：把 stub 强制绑到 1719 ⇒ 客户端用例成片 **10s 超时红**（V3，见 §三）。原始偶发复现见 `finding-2026-09-16.md` §二 |
| F2  | 确定性根因 + 最小改动     | 根因=端口分配（非时序竞态）；改动只碰端口分配与一处守卫，**未动任何被测逻辑**                                                                             |
| F3  | 单文件重复跑 ≥20 次全绿   | **20/20 全绿**（`embedding-client.test.ts` + `scan.test.js`，每次 68 测试）                                                                               |
| F4  | 全量跑 ≥3 次全绿          | **3/3 全绿**（每次 **120 文件 / 2421 测试**）                                                                                                             |
| F5  | 反向对照：注入 ⇒ 必须变红 | **V1 + V3 两组变异，全部如期变红**（见 §三）                                                                                                              |
| F6  | 全量闸绿                  | `pnpm lint` 3 包 ✅（shared/server/web）；全量测试 2421 ✅                                                                                                |

基线 119 文件 / 2413 测试 → 现 **120 文件 / 2421 测试**。增量 = 新增 `test-helpers.test.ts` 4 例，
加上 `embed-server.test.js` 新增 4 例。

---

## 三、变异验证（真跑，非写在测试里的对照）

### V1 —— 判据恒真（防「校验空转」）

把两处 `isFetchReachable` 的 `catch` 改成 `return true`（模拟「校验写了但没用」）：

```
× 服务真在监听、但端口在黑名单 ⇒ false        （server 侧）
× 同一份代码、同一种「服务在听」…⇒ true（正控）（server 侧）
× isFetchReachable 非恒真亦非恒假             （scripts 侧）
× 显式端口落在黑名单 ⇒ 启动即报错              （scripts 侧）
Test Files 2 failed | Tests 4 failed | 19 passed
```

红的**正是**判别力那几条 ⇒ 加固不是空转。

### V3 —— 注入原始故障态（防「靠放宽断言过关」）

把 `listenFetchable` 改为**强制绑 1719**（黑名单端口）并旁路校验：

```
embedding-client.test.ts → 成片 10s 超时红
（`spawn → 握手 → 探活 → 嵌入`、`重试有界`、`spawn 分支：status().port = 握手真实端口` …）
```

即：**票面记录的 `Test timed out` 失败签名被确定性复现**，且客户端侧断言一条没松——加固不是靠改弱判据换来的。
两组变异均已还原（`grep -c MUTATION` = 0）。

---

## 四、口径与缺口自陈（请重点看）

### 1. F3/F4 的证据力**弱**，别把它当主证

本根因是**概率性**的（命中概率 ≈ 15/13977 ≈ 0.1%/次分配）：

| 跑法       | 「若未修复则会撞上」的概率 |
| ---------- | -------------------------- |
| 单文件 ×20 | ≈ **2%**                   |
| 全量 ×3    | ≈ **0.3%**                 |

⇒ F3/F4 全绿**几乎不构成证据**，它们只证明「没引入新问题」。**本票真正的证据是 V3**——它把
「偶发」变成「确定性」，这才是可证伪的对照。票面把 F3/F4 写成主判据是**立票时根因未知**的产物。

### 2. 票面 §四 与本轮范围不一致（**文档漂移**，未擅自改票面）

`tickets.md` §四写生产侧「**须另立单并报店长**，不在本票范围」；店长派活单则明确「**两笔独立提交**：
测试侧 + 生产侧」。我按**派活单**执行（红线 4 的意图「别不吭声改生产代码」已由上报+授权满足），
但**票面未同步** —— 属既有文档债，按纪律只报不改。

### 3. 未被端到端复现的分支

`withFetchablePort` 的**重取分支**只由**注入判据**覆盖（`test-helpers.test.ts`），真机上「OS 恰好分到
黑名单端口 ⇒ 真的换一个」这条链**没有端到端复现**（要等 ~13977/15 次分配）。判据本身的分辨力已由
V1/V3 证明，故这不是假绿，但**这条链的端到端行为属未验面**。

### 4. 探针语义的一处放宽（有意）

`isFetchReachable` 判的是「**任何** fetch 失败 ⇒ 不可达」，不比对错误串。好处是零漂移；代价是
极罕见的 localhost 抖动会触发**一次无谓换端口**（有界、无害，且换来的端口仍要过同一判据）。

### 5. 生产侧的两处行为变更（非纯等价重构）

| 变更                                  | 前                         | 后                                                                              |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `EMBED_SIDECAR_PORT` 显式值落在黑名单 | 静默起来、主进程永久连不上 | **启动即抛错**（`embed-server.mjs:284` 分支）                                   |
| `close()`                             | 只 `server.close()`        | 追加 `closeAllConnections()`（防 keep-alive 池里的空闲 socket 拖住 close 回调） |

### 6. 未做（票面红线与 Out of Scope）

- **未改 `.husky/pre-commit` 门禁形态**（红线 1）
- **未删/放宽任何既有断言、未加 retry**（红线 2）——V3 反证了这一点
- 未碰 `core.autocrlf` / 未做「pre-commit 全量收窄为受影响包」（票面 §三另议）

---

## 五、复跑命令

```bash
# 闸
node node_modules/vitest/vitest.mjs run            # 120 文件 / 2421 测试
pnpm lint                                          # 3 包

# 反向对照（本票承重面）
node node_modules/vitest/vitest.mjs run \
  packages/server/src/test-helpers.test.ts \
  scripts/flywheel/embed-server.test.js           # 含黑名单端口 ⇒ false 的判别力对照
```

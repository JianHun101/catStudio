# 门取证 · 形态 D 的四条并发安全性

> 范围：**只读取证，未动一行代码**（`git status --porcelain` 干净；本文件是唯一产物）
> 基线：`6da3f4a`（我的猫树已 ff 到 dev，`serial.ts` 与 dev 逐字节相同 —— `git diff HEAD dev -- packages/server/src/execution/serial.ts` 为空）
> 对象：`docs/run/dispatch-deferral/tickets.md` §五-2 派活第一道门

## 结论先行

**四条并发安全性全部不被推翻 ⇒ D 的并发前提成立。**

但取证过程另得 **3 条边界/行为变更**（§六），其中 2 条票面未声明 —— **不是阻断项，但须随 D 一并落进契约**。

| #   | 判据                                             | 结论        | 主证据                                         |
| --- | ------------------------------------------------ | ----------- | ---------------------------------------------- |
| Q1  | `acquireLock`/`releaseLock` 是引用计数非互斥     | ✅ **成立** | `state.ts:220-237`；`serial.ts:436-437`        |
| Q2  | mention 配额「检查+预留」原子段并发下仍原子      | ✅ **成立** | `serial.ts:963-967` 全同步；`state.ts:252-258` |
| Q3  | 两子树并发时 SQLite(WAL) 写与 bus 事件序可接受   | ✅ **成立** | `db/index.ts:26`；**当日实测跨猫并发峰值 2**   |
| Q4  | 结构性判据：drain 命令的 agent 与 A2A 目标恒不同 | ✅ **成立** | `serial.ts:689`/`:710` 双自重排除；理论+实测   |

---

## Q1 · 锁是引用计数 ⇒ PASS

`state.ts:109` `let lockRefCount = 0`；`:220-237`：

```
acquireLock() { lockRefCount++; if (lockRefCount === 1 && !existsSync(LOCK_FILE)) { writeFileSync(...) } }
releaseLock() { if (lockRefCount <= 0) { warn; return } lockRefCount--; if (lockRefCount === 0) unlinkSync(...) }
```

**计数 0→1 才建文件、1→0 才删**，中间态并存 ⇒ 两个子树同时持锁得到 `lockRefCount === 2`，无互斥、无互踢。调用点 `serial.ts:532`（acquire）/ `:1113`（finally release）成对。

**且这不是新用法**：`serial.ts:436-437` 的设计约束明写「并发批内多个 Claude 执行体同时持有（计数 1→2→…），归零才删」——批内并发（Q3）今天就跑在这条路径上。

**连带确认**：`dev.js` 的重启保护（`.agent-busy` 文件语义）在 D 下不弱化 —— 只要任一子树在跑，文件就在。

---

## Q2 · 配额原子段 ⇒ PASS（附一条行为变更，§六-1）

`serial.ts:961-967`：

```
const limit = resolveMentionLimit()
for (const a of policy.allowed) {
  const count = state.getMentionCount(traceId, a.id)   // 检查
  if (count >= limit) continue
  state.setMentionCount(traceId, a.id, count + 1)      // 预留
  limitedAgents.push(a)
}
```

**循环体内零 `await`** —— 检查与预留同处一个同步块。`getMentionCount`/`setMentionCount` 是纯 `Map` 读写（`state.ts:252-258`，键 `${traceId}:${agentId}`），无 I/O、无异步。Node 单线程 ⇒ 该块相对任何其他 async 续体**不可分割**，与 drain 子树是否在跑无关。**原子性不因 D 而改变。**

---

## Q3 · SQLite WAL + bus 事件序 ⇒ PASS

**WAL**：`db/index.ts:26` `db.pragma('journal_mode = WAL')` —— 读写不互斥，且本仓 DB 访问是同步 API（better-sqlite3），不产生跨 `await` 的写交错。

**关键论据：跨 agent 并发今天已经在跑。** `serial.ts:1208` `await Promise.allSettled(batch.map((agent) => ctx.execute(...)))`，批大小 `CONCURRENT_AGENTS_PER_MESSAGE = 3`（`serial.ts:126`）。D 没有引入新的并发**种类**，只是把「drain 子树」与「A2A 子树」这一对从串行改成并行 —— 而这两者在更深层本来就会各自 `Promise.allSettled`。

**实测（当日 `cat-study-dev.db`，只读）**：

| 读数                        | 值                                                         |
| --------------------------- | ---------------------------------------------------------- |
| 当日 `execution_logs` 行数  | 52                                                         |
| 涉及 agent 数               | 4                                                          |
| **同 agent 时间区间重叠数** | **0**（`ended_at` 为 NULL 的仍在跑行按开区间计入，不放过） |
| **跨 agent 并发峰值**       | **2**                                                      |

⇒ ① 生产上跨 agent 并发是**既成事实**；② 「每 agent 单槽位」在含并发批的真实流量下**实测零违反**。

**bus 事件序**：`emitSystemNotice` / `emitMessageUpdated` / `NEW_MESSAGE` 均为房间广播，无跨事件耦合的读改写。D 下的顺序变化 = 完成顺序变化，与 `serial.ts:123-125` 已声明的既有语义（「前端显示顺序 = 完成顺序」）同款。

---

## Q4 · 结构性判据「恒不同」⇒ PASS

**命题**：drain 命令的 agent ≠ 任一 A2A 目标 agent。

**① drain 命令的 agent = 执行者自己（不是别的猫）**：`drainQueuedCommand(ctx, agent, queuedCmd, ...)`（`serial.ts:362-367` 签名）内部 `executeOneAgent(ctx, ..., agent, ...)` —— 传的就是调用方的 `agent`。它的命令来自 `finalizeRun(ctx, agent.id, ...)`（`:798`）弹出的**该 agent 自己的**队列。

**② A2A 目标集合里不可能含执行者自己**：`routeNames = [...new Set([...mentionedNames, ...signalNames])]`（`:711`），而两个来源**各自显式自排除**：

- `mentionedNames` → `:689` `.filter((name) => name !== agent.name) // 排除自己 @ 自己`
- `signalNames` → `:710` `.filter((name) => name !== agent.name)`

⇒ `policy.allowed ⊆ routeNames 解析出的猫` 且 `agent.name ∉ routeNames` ⇒ **恒不同成立**。

**③ 更深一层（票面未问，我补证）**：drain **子树**在跑自己的 A2A 链时，可能与父帧的 A2A 派发**指向同一只猫 X**。这**不是**「同 agent 并发执行」—— `execute(cmd)` 的决策段是同步的（`serial.ts:1737` 「决策段（同步，无 await——单线程原子，防批内双执行）」），先到者同步标 busy，后到者见 `slot.status === 'busy'` 走入队/合并（`:1738` 起），**不产生第二个执行体**。

且这类碰撞**今天就已存在**（批内 3 只猫各自派发、嵌套 A2A 交叉），实测零重叠（§Q3 表）⇒ D 不引入新的碰撞类。

---

## 五 · 一处票面行号复核（无误）

§五-2 引用的 `:813-815`（drain）、`:963-967`（配额）、`:1020-1047`（A2A 派发）、`:531-532` / `:1113`（锁）、四个 `drainQueuedCommand` 调用点 `:514` / `:635` / `:1102` / `:1714` —— **逐条 `git grep -n` 复核，全部命中**（:813 是注释、:814 是调用行；块首 `:1020` = `if (limitedAgents.length > 0) {`、`:1038-1047` = `claudeRan` 合并）。

---

## 六 · 三条须随 D 声明的边界（不阻断）

### 六-1（新发现）配额末位竞争：从确定变不确定

今天 drain 子树整条跑完才轮到父帧的配额预留 ⇒ **drain 子树先占**，是确定的。D 之后两条路径交错，**当 `limit` 将好耗尽时，最后一个名额归谁变得不确定**。

- 影响面：仅在配额触顶时改变「哪只猫被拦」，不改变「有没有被拦」；被拦路径本就有 `warn` + 收发双方系统提示（`:969-1013`），是**已可见**的路径。
- 严重度：低。但票面「已知行为变更」段目前只写了落库顺序，**建议把这条一并写进去**。

### 六-2（新发现）`PROVIDER_TOKEN_CAP=1` 时 D 退化为串行

token 池默认 cap=2（`execution/token-pool.ts:31`，`0=不限`）。D 之后 drain 子树的 LLM 段与 A2A 目标的 LLM 段**首次**成为同时的 token 竞争者：

- cap ≥ 2 ⇒ 双方各拿一个，D 的并行收益成立；
- **cap = 1 ⇒ 后到者在池上等前者释放 token**，两个子树重新串行 —— 即 D 在主路径上**退化回现状**。

**不是回归**（退化后 = 今天的行为），但「D 生效」隐含依赖 `cap ≥ 2`。建议写进边界。

### 六-3（票面已声明，此处只确认）落库顺序可能交错

票面 §五-2 已写「drain 命令的回复与 A2A 目标的回复落库顺序可能交错」。**确认属实且无额外影响** —— 见 §Q3 的 bus 事件序论证。

---

## 七 · 我没证到的（覆盖边界，不许当已证）

1. **单进程假设**：Q1 的引用计数是**进程内**闭包变量（`state.ts:109`）。同仓库起两个 server 实例时它不成立 —— 但那是既有形态的问题，非 D 引入，本票未测。
2. **Q4 只证了「恒不同」这一条命题**，未做真实并发压测；§Q4-③ 的「决策段守卫」是**代码读数 + 当日零重叠的实测相关**，不是「构造同目标并发并观察只跑一个」的直接实验。
3. **§六-2 未实跑**：`PROVIDER_TOKEN_CAP=1` 下 D 的退化是**推理**（池语义是读了 `token-pool.ts` 的，但没跑对照）。
4. **未跑任何真实并发场景**：本报告全部实测读数取自**当日既有流量**（52 条执行），没有为四条判据构造专门的并发用例 —— 那是第 2 笔（动码）该做的事。
5. **`needsLock` 的取值时机**（`:532`）未细查是否所有并发路径都成对 —— 只验了报数路径的 acquire/release 配对存在。

---

## 八 · 结论与停点

四条判据 **0 条被推翻** ⇒ 票面「任一被推翻即停下报店长、退形态 A」的**退路未触发**，形态 D 的并发前提成立。

**但按派活单「先回取证报告，我再裁是否动码」，我停在此处未动码。** 等店长裁：

- 裁「开工」⇒ 我按 §五-2「动什么」落第 2 笔（含 §六-1/六-2 两条边界写进契约与报告）；
- 裁「退 A」⇒ 本报告作为形态判据留痕。

ref：无 commit 关联本报告之外的改动；触发消息 id `d67d3019-3d34-4f6a-b240-87605f22ba64`。

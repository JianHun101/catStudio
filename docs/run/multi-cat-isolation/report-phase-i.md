# 报告：T-2 一猫一 worktree 隔离 —— Phase I 接线

> 票面：`docs/run/multi-cat-isolation/tickets-t2-phase-i.md`
> 提交：**第 1 笔** `9cd5b28`（前锋笔·命名 + 所有权标记，inert）；**第 2 笔** `ed6a3b0`（接线）；
> **第 3 笔** —— **OQ1 裁 A·集成分支补建**（票面「补笔：第 3 笔」），见**本文件的承载提交**。
> （第 3 笔的 sha 写不进它自己承载的文件——自指。不用「第 N 笔」占位，以承载关系指认。）
> 审查按「票 = 三笔」审。

---

## 一、结论先行

1. **接线已落地**：CLI cwd 按角色分派（store → 会话 worktree / 其余 → 各自猫 worktree）、
   收尾的 auto-commit 与脏文件清理**逐猫逐棵**、收口链插入 fan-in 与回收两个 step。
2. **票面的「已知未知量」有答案**：取数点 = **`execution_logs.trace_id`**（§三）。
   **不是** in-memory 累计结构——`dispatch 上下文里已有的累计结构` 经全仓排查**不存在**
   （§三-1 逐条排除），故改用既有**持久化**结构上的一条只读查询，**未新增任何跨执行状态**。
3. **交付面比票面多 6 个文件**（7 → 13），全部是**被逼出来的**，无一是自由发挥（§二）：
   新增取数点需要一条 repo 查询；接线后原有测试的断言对象变了（票面只列了其中 2 个测试文件）。
4. **两条待裁事项均已裁、均已落地**（第 3 笔）：
   - **OQ1（结构风险，最重）→ 裁 A（本票内必修）**：`ensureCatWorktree` 在分叉前先
     `ensureSessionWorktree` 补建集成分支。原风险：`session/<sid8>` 接线后**只有店长**会创建 ⇒
     店长没跑过的会话里猫树全建不出 ⇒ 全体降级到 `workspace/`（gitignored，**改动连 git 都看不见**）。
     见 §六-1、§四 V13–V15。
   - **OQ2（票面自相矛盾）→ 追认实现、改票面字**：§2.1 把 `/` 列为「可剔字符」，而 V7 要求
     「含 `/` ⇒ 显式抛错」。**按 V7 实现**（静默剔除会把 `a/b` 与 `ab` 归一到同一棵树），
     店长收口时改票面措辞，实施者不碰。见 §六-2。

---

## 二、交付面（票面 7 文件 → 实际 13 文件）

| #   | 文件                                                                                                   | 票面 | 说明                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/server/src/llm/git-utils.ts`                                                                 | ✅   | 前锋笔：`catSlug` / `catBranch` / `catWorktreePath` / `ensureCatWorktree` + 所有权标记 + `ensureAgentWorktree`                        |
| 2   | `packages/server/src/llm/git-utils.test.ts`                                                            | ✅   | A 组期望随命名更新 + A6/A7/A8                                                                                                         |
| 3   | `packages/server/src/execution/reply.ts`                                                               | ✅   | `:976` cwd 按角色分派                                                                                                                 |
| 4   | `packages/server/src/execution/serial.ts`                                                              | ✅   | 收尾块逐猫提交/清理 + `resolveCommitTargets`                                                                                          |
| 5   | `packages/server/src/llm/session-closeout.ts`                                                          | ✅   | 插 `fanInCats` / `reclaimCats` 两 step                                                                                                |
| 6   | `packages/server/src/llm/session-closeout.test.ts`                                                     | ✅   | 新 step 矩阵（V4/V5/V6）                                                                                                              |
| 7   | `packages/server/src/llm/worktree-fanin.test.ts`                                                       | ✅   | **零改动**：该文件的分支名是自造的 `session/c4xxxxxx-catB` 形态，不经过 `catBranch`，无需跟改（票面写的是「若有… ⇒ 更新」，实际没有） |
| 8   | `packages/server/src/db/repository/executionLogs.ts`                                                   | ➕   | **新增取数点**（§三）：`listExecutorAgentIdsByTrace`                                                                                  |
| 9   | `packages/server/src/db/repository/executionLogs.test.ts`                                              | ➕   | 上条的测试（测试跟随被测主模块）                                                                                                      |
| 10  | `packages/server/src/execution/serial.downgrade.test.ts`                                               | ➕   | T-1 降级矩阵的夹具钉成 `role: 'store'`（保住原语义，见下）                                                                            |
| 11  | `packages/server/src/execution/serial.cat-worktree.test.ts`                                            | ➕   | **新文件**：猫路径的 V1/V2/V3/V7/V9/V10                                                                                               |
| 12  | `packages/server/src/execution/serial.test.ts` · `serial.spans.test.ts` · `serial.flow-wiring.test.ts` | ➕   | mock 工厂补 `ensureAgentWorktree` 键                                                                                                  |
| 13  | `packages/server/src/connectors/ingest.test.ts` · `socketio.test.ts` · `dispatch/index.test.ts`        | ➕   | 同上                                                                                                                                  |

**为什么 10–13 是被逼出来的（不是范围蔓延）**：本仓有 6 个测试文件用**部分导出的
mock 工厂**替身 `llm/git-utils.js`（serial ×3 / connectors ×2 / dispatch ×1），
工厂里只列了被消费的键。本票把 `serial.ts` / `reply.ts` 消费的键从
`ensureSessionWorktree` 换成 `ensureAgentWorktree` ⇒ 六处替身当场 `undefined`、
调用即 TypeError。**这不是新问题，而是那些工厂自己的注释早就点名的形态**
（「本工厂是**部分导出**——漏键 ⇒ 拿到 undefined、调用即 TypeError」），只是这次由本票踩中。

`serial.downgrade.test.ts` 的处理值得单独说：它的 60 余条断言对象是「收尾路径上那棵
worktree」。一猫一 worktree 之后**只有店长**还持会话 worktree（ADR 0015 D2）⇒ 把夹具钉成
`role: 'store'`，该文件**全部格子的语义与 T-1 Phase 2 收窄时逐字一致**（改的是归属、
不是期望）。猫路径另立 `serial.cat-worktree.test.ts`——票面 V1 明写「两格都要读数，不能只测一格」。

---

## 三、已知未知量：取数点 = `execution_logs.trace_id`

票面要求先 `git grep` 找「本调度树执行过的 agent 集合」的取数点，找不到就停下来报，
**不得自造**跨执行累计结构。

### 3.1 排查过、**均不成立**的候选（逐条）

| 候选                                                | 为什么不成立                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`（`:1148` 作用域内）                        | 只有**本条消息**的批次；A2A 子链与队列 drain 都不在里面                                                                                                                            |
| `ctx.state` 的 mentionCounts                        | 键是 `${traceId}:${agentId}`，但**只在 A2A 调度点计数**（depth>0）⇒ 漏掉顶层直接派发的猫与 drain 的猫；且它在 `depth===0` 块的**第一条语句**就被 `clearMentionCountsForTrace` 清空 |
| `ctx.slots`（`Map<agentId, Map<sessionId, Slot>>`） | 引擎级、**跨轮存活**，是「本会话调度过谁」而非「本棵树执行过谁」                                                                                                                   |
| `state.runs`（run 注册表）                          | `finalizeRun` 在**每只猫自己的执行结束时**就 `endRun` 注销了 ⇒ 顶层收尾时已空                                                                                                      |
| `queueArrival`（WeakMap）                           | 只存入队时刻，不存身份                                                                                                                                                             |
| `messages.task_id` 反查                             | 链锚虽同源，但 task 可跨多轮复用 ⇒ 会**收宽**到别的调度树（正是「抢收他猫 WIP」那个方向）；且无 task 的用户触发轮次锚为空                                                          |
| `spans` / `chainId`                                 | 无「按 chain 列 agent」的取数口，且 spans 是观测面不是调度账本                                                                                                                     |

### 3.2 成立的那个：`execution_logs.trace_id`

`execution_logs` 本就是「**按执行落行**」的既有持久化累计结构，一行 = 一次执行。取它而不是
同表另一列，理由是覆盖面：

- **`traceId` 在 A2A 子链上原样继承**（`executeAgentsSerialImpl(…, traceId, depth + 1)`），
  子链的 `makeCmd` 把同一个 traceId 带进 `executeAgentCommand` → `insertExecutionLog`
  ⇒ **一条按 trace 的查询覆盖整棵树**。
- **不能改用 `triggered_by_message_id`**：A2A 子链的触发 id 是**父猫的回复消息 id**
  （`serial.ts` 的 `agentTrigger.id = reply.msgId`），按它查只拿得到顶层那一批。
- 看似唯一的洞（**跨 trace 的队列 drain**）**会自愈**：队列是
  `ensureSlot(agentId, sessionId)` 下设的 **per-(agent, session) FIFO**，drain 传的 `agent`
  恒是同一个 ⇒ 被 drain 的命令其执行者**必然已在父树的集合里**（它正在执行父树的活）。
  改动 `commit_hash` 归属的只是 uuid 的挂靠（既有形态），不影响「该提交哪几棵树」。

### 3.3 因此新增了一条 repo 只读函数

`executionLogs.listExecutorAgentIdsByTrace(traceId)`。**这是交付面扩到 `db/` 的原因**，
也是票面没列的第 8 个文件——它同时是「跨了一个组件边界」的改动，故在报告里点名。

**它不是「自造状态」**：函数只读，零新内存态、零新表列、不牵动 `__test_reset*` 复位钩子
与并发批语义——正是票面禁止的那件事它没做。

### 3.4 兜底：并上本次批次

`resolveCommitTargets` 取「trace 集合 ∪ 本次批次」。查询异常 / DB 写失败时至少不丢本轮
直接派发的猫。并集取宽的理由是**两个方向的代价不对称**：多出来的一棵是零代价 no-op
（`gitCommit` 对无改动树返回 null），少一棵是「改动永远没进过任何地方」（E5）。

---

## 四、验收 V1–V15 逐条读数

| #       | 判据                         | 读数                                                                                                                                                                                                                                                                                                                                   | 载体                                                            |
| ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **V1**  | CLI cwd 分派（**两格**）     | store 格 = `serial.downgrade.test.ts` 全 14 例（夹具 `role:'store'` ⇒ 提交落会话 worktree，主仓库零改动）；猫格 = `serial.cat-worktree.test.ts` V9/V1                                                                                                                                                                                  | 两个真 git 临时仓夹具                                           |
| **V2**  | auto-commit 归属（**最重**） | 猫改 `only-cat1.txt` ⇒ `git cat-file -p session/<sid8>-flash猫:only-cat1.txt` = `A\n`；另一只猫分支上**读不到**该文件；集成分支仍停在分叉点                                                                                                                                                                                            | `serial.cat-worktree.test.ts` V2                                |
| **V3**  | 反向对照（防恒真）           | **已跑，先红后绿**：把 `ensureAgentWorktree` 的 role 分派临时改回 `return ensureSessionWorktree(sessionId)` ⇒ V1/V2/V7/V10 **4 格全红**（`expected null to be 'A\n'`——猫分支空，正是 E5 形态），V3 常驻对照格仍绿；改回后 5 格全绿。**留痕**：常驻对照格（store 的改动落会话分支、不进任何猫分支）已固化进测试，判据不恒真由它长期守着 | 手跑 + 常驻对照格                                               |
| **V4**  | fan-in 内容在场              | `closeoutSession` 后 `git cat-file -p dev:from-暹罗猫.txt` = `暹罗猫 的产出 catf0001`（**读 blob，不看 exit 0**）                                                                                                                                                                                                                      | `session-closeout.test.ts` V4                                   |
| **V5**  | 中断态守卫（**三格**）       | 预置 `MERGE_HEAD` ⇒ `{ok:false, step:'fanin'}`；① `dev` HEAD 未动（merge 未执行）② `.push-gate` 逐字节未变（writeGate 未执行）③ `process.cwd()` 仍在会话 worktree 内（checkoutDev 的 cwd 复位未执行）。猫分支 / 猫树 / 会话 worktree 原样留存                                                                                          | `session-closeout.test.ts` V5                                   |
| **V6**  | 未合不回收                   | 猫分支有超出 dev 的提交 ⇒ `reclaimCats` 返回 ok 且分支与树**留存**（判据是 `isAncestor(cat, dev)`，不是「存在即删」）                                                                                                                                                                                                                  | `session-closeout.test.ts` V6 + `worktree-fanin.test.ts` D2     |
| **V7**  | 命名                         | 中文**原样**产出（`session/abcd1234-暹罗猫`，断言不含 `%` 与 `\`）；`/` 与清洗后为空 ⇒ 抛错且 `branch --list "session/<sid>-*"` 为空、目录不存在                                                                                                                                                                                       | `git-utils.test.ts` A1/A6                                       |
| **V8**  | 同名不同 agent               | 建树写 `branch.<分支>.catAgentId`；换 agentId 同名 ⇒ 抛「所有权冲突」且标记与树均未被改写；同 agentId 复用幂等。另：抹掉标记后复用 ⇒ 抛「无所有权标记」；写回 ⇒ 恢复正常                                                                                                                                                               | `git-utils.test.ts` A7/A8                                       |
| **V9**  | `role` 缺失/未知             | 走猫 worktree、不抛错（夹具用 `'unknown'` = 老库迁移默认值，**不在** `AgentRole` 里）                                                                                                                                                                                                                                                  | `serial.cat-worktree.test.ts` V9/V1                             |
| **V10** | 存量兼容                     | 既有 `session/<sid8>` 与 24 个存量 worktree 不被误伤；`git branch --list 'session/<sid8>*'` **同时命中** `session/<sid8>` 与 `session/<sid8>-<猫名>`。**末句「集成分支不存在 ⇒ 猫树建不出、零提交」已由 V15 反转**（见下行）                                                                                                           | `serial.cat-worktree.test.ts` V15 + `worktree-fanin.test.ts` B1 |
| **V11** | 闸绿                         | `node scripts/lint.js` 3 包通过；`pnpm test` 全量**全绿**（第 3 笔读数见 §五）                                                                                                                                                                                                                                                         | 见 §五                                                          |
| **V12** | 覆盖边界自陈                 | §七                                                                                                                                                                                                                                                                                                                                    | 本文件                                                          |

### 第 3 笔（OQ1 裁 A）新增 / 反转的格子

| #       | 判据                                        | 读数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 载体                                  |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **V13** | 无 store 会话补建（**新格，三格分别断言**） | 前提：`branch --list session/scwt0007` 为空 **且** 会话 worktree 不存在（两条都显式断言）。触发一次非 store 猫执行后：① 适配器实收 `cwd` **逐字等于**猫 worktree 路径 —— **不是**「目录存在」这类旁证（并先断言 `chatStream` **恰好被调 1 次** ⇒ `.at(-1)` 的读数无歧义；不加这格，将来加重试会静默改读另一次调用）；② `git rev-parse session/scwt0007` == 补建前的 `initSha`（fork 点 = 主仓库 HEAD）；③ 写入 `v13.txt` 后 `git cat-file -p session/scwt0007-flash猫:v13.txt` = `补建后有活干\n`。另：猫的提交**不落集成分支**（它仍停在 `initSha`）、主仓库零改动 | `serial.cat-worktree.test.ts` V13     |
| **V14** | 反向对照（防恒真）                          | **已跑，先红后绿**：删掉补建那一行 ⇒ **3 格红 / 27 格绿**（V13、V15、`git-utils.test.ts` A5 —— 恰好是断言补建的三格，其余一格不动 ⇒ 判据可分辨、非恒真）。关键读数：V13 红在 `expected undefined to be '<tmp>/catStudy-sessions/scwt0007-flash猫'` —— 那个 **`undefined` 就是 `workspace/` 降级**（`cwd` 没被传），把「静默不可见」的失败形态直接暴露成读数。改回后 30 格全绿                                                                                                                                                                                       | 手跑（命令与输见下方「V14 复现」）    |
| **V15** | V10 期望反转 + 用例名同步改                 | 集成分支不存在的会话 ⇒ **猫树建得出**（原 `toBeNull()` / `existsSync === false` 反转）、集成分支 fork 点 = 主仓库 HEAD、会话 worktree 一并建出（`ensureSessionWorktree` 单源）；**逐字保留**：主仓库零改动 / 存量集成分支不被误伤 / 通配符同时命中新旧两形态。用例名去掉「建不出」                                                                                                                                                                                                                                                                                  | `serial.cat-worktree.test.ts` V15/V10 |
| **A5**  | `git-utils` 面同型反转（票面「（如需）」）  | 同款反转：集成分支不存在 ⇒ 建得出 + fork 点 = 主仓库 HEAD；「不落主仓库」红线**保留**，改由仍存在的失败形态（空 agent id ⇒ `null`）把守                                                                                                                                                                                                                                                                                                                                                                                                                             | `git-utils.test.ts` A5                |

**V14 复现**（补建行 = `packages/server/src/llm/git-utils.ts:608`
`if (!ensureSessionWorktree(sessionId)) return null`）。反例态是**删掉该行**（不是改条件、
不是改返回），备份 → 删 → 跑 → 还原：

```bash
cd <worktree>
cp packages/server/src/llm/git-utils.ts /tmp/git-utils.bak.ts
node -e "
const fs=require('fs');const p='packages/server/src/llm/git-utils.ts';
let s=fs.readFileSync(p,'utf8');
const old='  if (!ensureSessionWorktree(sessionId)) return null\n\n  const ready = ensureWorktreeAt({';
const nw='  const ready = ensureWorktreeAt({';
if(!s.includes(old)){console.error('ANCHOR NOT FOUND');process.exit(1)}
fs.writeFileSync(p,s.replace(old,nw),'utf8');console.log('REVERTED');"
cd packages/server && npx vitest run src/execution/serial.cat-worktree.test.ts src/llm/git-utils.test.ts
#   反例态 → Test Files 2 failed (2) | Tests 3 failed | 27 passed (30)
cd <worktree> && cp /tmp/git-utils.bak.ts packages/server/src/llm/git-utils.ts
#   正例态 → Test Files 2 passed (2) | Tests 30 passed (30)
```

脚本里带 `ANCHOR NOT FOUND` 断言：**锚点不匹配就非零退出**——防「删了个寂寞还报绿」
（该形态会让反向对照变成恒真的假读数）。

**同轮附带的测试卫生修复（非行为改动）**：`git-utils.test.ts` A5 的猫树目录落
`<tmpdir>/catStudy-sessions/`（主仓库**兄弟**目录，**不在** `tmp` 内）⇒ 上一轮跑崩的残留会
走进「已存在 → 复用」并撞所有权校验。**实测踩过**：本次反向对照前的第一轮失败正是被
`<tmpdir>/catStudy-sessions/c1a00099-暹罗猫` 这个残留打红（断言点在上游失败 ⇒ `catDirs.push`
没执行到 ⇒ 残留永久留下、之后每次跑都红）。已按 `serial.cat-worktree.test.ts` 的既有做法
**先登记再前置清理**，使该格不再依赖跑史。

---

## 五、闸读数

| 面                                        | 读数                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npx vitest run`（**全仓全量**，第 3 笔） | **124 文件 / 2514 用例全绿**（第 2 笔时为 124/2513；+1 = 新增的 V13 格） |
| `npx vitest run`（packages/server 面）    | **89 文件 / 1824 用例全绿**                                              |
| `node scripts/lint.js`                    | **3 包通过**                                                             |
| V14 反向对照（第 3 笔）                   | **3 红 / 27 绿**（先红后绿，命令与输见 §四）                             |
| 第 1 笔提交门禁（`9cd5b28`）              | 88 文件 / 1812 用例全绿                                                  |
| 第 2 笔提交门禁（`ed6a3b0`）              | 89 文件 / 1823 用例全绿                                                  |
| 第 3 笔提交门禁                           | 见提交输出（本文件由该笔承载，自指 sha 与门禁读数写不进自己）            |

---

## 六、两条需店长裁

### 6.1 OQ1（结构风险，最重）：集成分支的创建者现在只剩店长 —— **已裁 A、已落地（第 3 笔）**

**裁决**：店长独立复核后**采纳 A 并升级为「本票内必修」**（不是「倾向」）。三条理由：
① 这是**本票引入的回归**（接线前每个 agent 都调 `ensureSessionWorktree`，集成分支总被顺带建出）；
② 失败**比共享目录更重、且不可见**——降级 cwd = `getWorkspaceDir()` = `path.join(process.cwd(),'workspace')`，
而 `.gitignore:38` 正是 `workspace/` ⇒ 猫的改动不是「未提交」而是**不可见**（`git status` 干净、
`git cat-file` 读不到、收口 `listCatBranches` 返 0，全场无人察觉）；
③ **重启经济**：本票落地本就需要一次重启，推到后续单要多付第二次重启，中间窗口缺口是活的。

**实际动什么（第 3 笔，一行）**：`packages/server/src/llm/git-utils.ts` · `ensureCatWorktree`
在 `ensureWorktreeAt({ … startPoint: sessionBranch(shortId) })` **之前**补：

```ts
if (!ensureSessionWorktree(sessionId)) return null
```

用**单源**而非自写 `git branch`：`ensureWorktreeAt` 的建分支段是与会话路径共享的那一份
（该函数头注自陈「复制必然漂移」），自写会造出**第二个**集成分支创建点。
**不违反 ADR D2**：D2 管的是 cwd **持有者**（仍是 store，本笔不改派发逻辑），本笔只让
集成分支**提前存在**；`ensureAgentWorktree` 对 store 仍走原分支 ⇒ store 路径不重复建（幂等复用）。

**验收读数**：§四 V13（三格）/ V14（反向对照 3 红 27 绿）/ V15（V10 反转）。
**回滚**：删这一行即回到原行为（V14 的「先红」态就是它）。

**现象**：`ensureCatWorktree` 的分叉点是 `session/<sid8>`（票面 §2.1 钉死，**不是 dev**）。
旧实现里**任何**猫的 `reply.ts:976` 都会调 `ensureSessionWorktree` 顺带把这条分支建出来；
接线后只有 `role === 'store'` 会调它。⇒ **店长没跑过的会话里，集成分支不存在 ⇒
每只猫的 `ensureCatWorktree` 都返回 null ⇒ 全体降级到 `workspace/`（共享目录）**。

**为什么这是本票的形态**：正是本票要消灭的「多猫共用一个目录」，只是触发条件从
「一直如此」变成「店长没先跑」。

**影响面**：本会话不受影响（店长先跑，`session/4c8acf70` 已在）。风险落在
「用户直接 @ 某只实施猫、店长从未被触发」的会话。

**候选修法（供裁，我不自行选）**：

- **A**：`ensureCatWorktree` 在分叉前先确保集成分支存在（内部调 `ensureSessionWorktree`）。
  代价：非 store 猫的首次执行也会建会话 worktree（对本 ADR 的模型其实是补全）。
- **B**：保持现状，把「店长必须在会话内先跑一次」作为已知前提写进 ADR。
- **C**：`ensureAgentWorktree` 在猫树建不出时**回退到会话 worktree**（不是主仓库）。
  代价：重新引入「多猫共用一棵树」，与 P0 相抵——**我不建议**。

**可逆性**：A/B/C 都只动 `ensureCatWorktree` 一处，可单独回滚。

### 6.2 OQ2：§2.1 与 V7 对 `/` 的要求互斥 —— **已裁：追认实现、改票面字**

店长裁决：**按 V7 抛错是对的**（静默剔除会把 `a/b` 折成 `ab`、与真名共用同一棵树，正是本票靶心）。
落法同票2 §2.2 先例：**改票面字、不改实现**（店长在收口时改 §2.1 的清洗列表措辞，实施者**不碰**）。
以下为送审时的原始分析，保留作决策依据留痕。

**票面 §2.1** 的清洗列表把 `/` 写进「只剔 git ref 非法字符（`/ \ 空格 ~ ^ : ? * [ " .. @{` …）」。
**票面 V7 / `tickets-cat-naming.md` A4** 都要求「猫名含 `/` ⇒ **显式抛错**」。
按 §2.1 剔掉 `/` 则 `catSlug('a/b') === 'ab'`，永不抛错 ⇒ V7 必红。

**我的处置**：按 **V7（验收判据）** 实现——`/` 单列为错误而非可剔字符。
理由：① 验收段是硬判据，§2.1 的列表是代码注释级枚举；② 静默剔除会把 `a/b` 与真名 `ab`
**归一到同一分支 + 同一棵树**，正是本票要消灭的静默共用形态；③ 与本票「不静默」的总基调一致。
**未擅改契约的其余部分**（中文原样、其余非法字符剔除、清洗后为空抛错，逐字实现）。

---

## 七、覆盖边界自陈（V12）

**每条断言证什么、不证什么：**

1. **mock 面的格子证不了「另一棵真树没被动过」**。`socketio.test.ts` 的一组 worktree 用例
   把整个 `llm/git-utils.js` 替身掉 ⇒ 那些格子只证得「调用没发生 / 传参是它」，
   **证不了**「主仓库文件真的没动」。该面由 `serial.downgrade.test.ts` 与
   `serial.cat-worktree.test.ts` 的**真 git 临时仓夹具**补（两文件均不 mock git-utils）。
2. **`resolveCommitTargets` 的「trace 并集取宽」是声明不是证明**。测试里的执行链都是
   单层（无 A2A 子链、无跨 trace drain）⇒ 那两条路径由**代码阅读 + §3.2 的论证**支撑，
   没有真跑读数。要真跑需要构造 A2A 子链 + 并发队列的完整引擎场景，本票未做。
3. **命名面未覆盖的字符**：`catSlug` 的非法字符集按票面枚举实现，**未穷举** git 全部
   ref 规则。已知未覆盖：**`.lock` 结尾**（`session/<sid8>-x.lock` 会被 git 拒 ⇒
   `ensureCatWorktree` 走 null 降级，**不抛错**——与「清洗后为空抛错」不同档）；
   `@{` 之外的重叠序列、Unicode 归一化（NFC/NFD 两种写法会被当成两个猫名 ⇒ 两棵树 +
   所有权标记区分得开，不静默共用，但会各建一棵）。
4. **所有权标记的跨机/跨 clone 面**：`branch.<branch>.catAgentId` 落 `.git/config`，
   **不进任何提交** ⇒ 在别的 clone 里不存在。本仓是单机 worktree 模型，不适用；
   若将来有 clone 形态，第二个 clone 上复用会走「无标记 ⇒ 抛错」，**是 fail-loud 不是静默**。
5. **`ensureWorktreeAt` 的复用分支**：`existsSync(wtPath) && existsSync(wtPath/.git)` ⇒
   `created:false`。这一格的所有权校验只证得「标记在且相等」；**证不了**「这棵树的
   HEAD 真的在该猫分支上」（有人手工 `checkout` 过别的分支时不会被发现）——超出本票。
6. **V5 的「checkoutDev 未执行」判据是 cwd 复位**。`checkoutDev` 在已处于 dev 时是 no-op，
   唯一可观测的副作用就是 cwd 复位 ⇒ 该格以「cwd 仍在会话 worktree 内」为判据。
   若将来 checkoutDev 增加别的副作用，这一格会**漏判**。
7. **`session-closeout.test.ts` 的 `dropWorktrees` 是本文件专属清理**：它按
   `SESSION_IDS` 白名单清同 id 残留（路径只依赖 `tmpdir()`+shortId，跨 run 会撞）。
   **不整目录清扫**——`tmpdir()/catStudy-sessions` 与并行 worker 的同型测试共享，
   扫它等于误伤别人。
8. **第 3 笔的补建不引入并发建树竞态——但这是「进程内」的论证，不是通例**。
   补建让**每一只非 store 猫**的首次执行都可能去创建**同一棵**会话 worktree
   （此前只有 store 会），而批次是 `Promise.allSettled` 并发起来的。
   **证得**：`ensureWorktreeAt` 全程 `execFileSync`（实测 3 处、0 处 `await`/`async`）⇒
   同一进程内调用是**同步原子**的，`git worktree add` 不会被自己打断。
   **证不了**：多**进程**并发（同仓库跑两个 server 实例 / 测试与 server 并行）时该竞态成立；
   本仓是单 server 进程模型（ADR 0015 前提），故不适用。若将来多进程，这一条要重验。
   **另**：V13 断言的是非 store 猫路径；store 路径（`ensureAgentWorktree` 直接走
   `ensureSessionWorktree`）在补建前后**逐字未变**，其行为由 `serial.downgrade.test.ts`
   的 14 例守着（第 3 笔后全绿）。

---

## 八、挂账（本票不做，不新立单，随票面 §六）

| 项                                                       | 状态                                              |
| -------------------------------------------------------- | ------------------------------------------------- |
| D3 审查猫一次性 detached worktree                        | Phase I-b（票面已划）                             |
| `serial.ts:770` 审查兜底 cwd                             | 随 D3                                             |
| `git-utils.ts` catch 不回滚索引（D4 残留）               | 票面 §六已挂                                      |
| 双跑缺陷                                                 | 用户已裁「挂起」                                  |
| ADR 0015 转正                                            | T-2 收口动作，由店长执行                          |
| `worktree-fanin.ts` 注释里的 `<cat8>` 措辞（现已是猫名） | 该文件不在本票交付面 ⇒ **未碰**，留给转正时一并改 |
| **OQ1（集成分支创建者）**                                | ✅ **已裁 A、已落地**（第 3 笔，§6.1）            |
| **OQ2（`/` 的票面自相矛盾）**                            | ✅ **已裁：追认实现、改票面字**（§6.2）           |

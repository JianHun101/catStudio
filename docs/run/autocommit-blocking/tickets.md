# T-1 `autocommit-blocking` —— auto-commit 的同步阻塞止血

**状态**：实施中（worktree `D:/Game/ai/catstudy-autocommit-blocking`，分支 `fix/autocommit-blocking`）

**基线**：`dev @ ebc4650f`（= `origin/dev` = `.push-gate`）

## 一、现象与判据来源

浏览器控制台出现 `ping timeout`（= 客户端 180s 没听到服务端心跳，`socketio.ts:153-154`
配的 60s + 120s，由服务端握手下发）。能判的是**排除了瞬时抖动那一族**（那族 0.0–0.7s 就回来），
剩下的是「断开一段时间」的长断族。店长的两个候选（冻结标签页恢复 / 服务端僵死）在控制台
长得一样，需要服务端侧的 reason 才分得开。

店长实测定档的两条：

| 读数                                                  | 值                       | 结论                           |
| ----------------------------------------------------- | ------------------------ | ------------------------------ |
| `git add -An`（主仓库 / 会话 worktree / 猫 worktree） | 0.114s / 0.151s / 0.133s | 「`git add -A` 慢」**作废**    |
| `git commit`（含钩子）                                | 69–302s（日志读数）      | 停顿落在 `git commit` 这一句里 |

`gitCommit` 当时是 3 次连续 `execSync`，而 `git commit` 会连带跑人类提交门禁
（`.husky/pre-commit` = `npx lint-staged` → `pnpm lint` → `node scripts/precommit-scope.mjs`）。
同步 `execSync` 期间 Node 事件循环被完全占住 ⇒ socket 心跳 / HTTP / 其它会话执行全僵死同长。

## 二、契约（店长拍板，实施不许自行改）

- **C1 锁**：新造按**目标树根**键控的 async 互斥；不同树不互斥；**不复用**执行槽位锁
  （`execution/state.ts` 的 `acquireLock` 语义是「单 agent 不并发执行」，借来当 git 锁
  会让两个语义互相污染）。
- **C2** 不加 `--no-verify`——那会绕过 uuid 门禁，拆掉本仓唯一的归属保证。
- **C3** 提交语义零变化：message 形态 `catstudy [uuid]` 不变、`git add -A` 扫描语义不变、
  span 墙钟口径不变。
- **C4** 返回语义不变：有 commit → sha；无 commit → null。
- **C5** 新起的子进程纳入关停路径。

## 三、格 1 · 定位（分解表）

### 3.1 计量装置

`D:/Game/ai/_probe-autocommit-profile/`（**仓外**，一次性探针，不进仓库）：

- **scratch worktree** `_probe-autocommit-wt`（从 `fix/autocommit-blocking` 分叉，
  四条约 node_modules junction 齐）——不在票的 worktree 里造提交，避免污染分支。
- 钩子目录 `hooks/`：**逐字拷贝** `.husky/pre-commit` 与 `.husky/commit-msg`，
  **故意不拷 `post-commit`**——那份会跑 `handoff-gen.mjs` 投递交接文档，
  一次性探针不该触发投递链。以 `git -c core.hooksPath=<hooks>` 调用。
- **反对照**：`git commit --no-verify`（跳过 pre-commit + commit-msg）——没有它，
  「git commit 慢」是恒真的假读数。

### 3.2 分解表

> ⚠️ **两轮读数，逐行标可用性（见 §3.3）。** 第一轮（`run.mjs`）的 `git commit` 三条读数
> 与店长的测试跑批时间窗重叠，CPU 竞争把读数抬高、并留下 ≈65s 归因不了的残差——
> 未归因的残差会把 OQ 裁决带偏，故重取；第一轮数据保留在
> `_probe-autocommit-profile/report.jsonl` 以便对照。第二轮（`run2.mjs`）的
> `commit-server` 整组**不可用**（钩子中途失败，只量到第一个失败点）。
> 本轮实施猫**未重跑全量**（店长明令）——下表全部是盘上读数的汇总与可用性裁定。

### 3.3 分解表（盘上读数汇总，未重跑）

**A. 装置底噪与对照（round 1 `report.jsonl`，可用）**

| 段                                     | 读数（3 次）                | 备注                                                                                                 |
| -------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `git rev-parse HEAD`（底噪）           | 27 / 23 / 22 ms             |                                                                                                      |
| `git add -An`（dry-run）               | 29 / 28 / 26 ms             | 与店长实测 0.11–0.15s 同量级                                                                         |
| `git add -A`（真实）                   | 29 / 29 / 30 ms             | 「`git add -A` 慢」到此彻底作废                                                                      |
| **`git commit --no-verify`（反对照）** | 126 / 133 / 135 ms          | 跳过 pre-commit + commit-msg                                                                         |
| **`git commit`（真钩子 · 端到端）**    | 138543 / 141497 / 142754 ms | `ok=false`（commit-msg 的 uuid 门禁拒探针消息），但 pre-commit 已完整跑完 ⇒ 这仍是 pre-commit 的全价 |

**B. 钩子分段（round 1 `hook-seg`，可用）**

| 段                                                 | 读数（3 次）                 | 占端到端        |
| -------------------------------------------------- | ---------------------------- | --------------- |
| `npx lint-staged`                                  | 1959 / 1850 / 1808 ms        | ~1.4%           |
| `pnpm lint`（`scripts/lint.js`，三包 tsc/vue-tsc） | 7812 / 7666 / 7541 ms        | ~5.5%           |
| **`node scripts/precommit-scope.mjs`**             | **64127 / 63811 / 62796 ms** | **~46% ← 主犯** |

**C. 主犯的成本本体（report2 / report3，可用）**

| 暂存形态                                           | `precommit-scope` 判定                                          | 实测                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `_probe-touch.txt`（仓根文件）                     | 全量 4 project（命中全量触发项）                                | vitest **152 文件 / 3299 用例 / 61.33s**（另一次 61.39s）             |
| `packages/server/src/_probe-scope.ts`              | 收窄到 packages/server + scripts                                | （探针未单独计时，见下行本轮真提交读数）                              |
| **空 / 不可解析**                                  | **fail-closed 全量 4 project**（`precommit-scope.mjs:169-170`） | 同上                                                                  |
| `git-utils.ts` + `.test.ts`（**本轮格 0 真提交**） | 收窄到 server                                                   | vitest **121 文件 / 2683 用例 / 146.08s**（同跑累计 `tests 669.31s`） |

⇒ **「没东西可提交」反而触发最贵的分支**——格 0 短路的正是这一次。

> ⚠️ 最后一行的读数取自本轮提交格 0 时**真钩子**（不是探针装置），须带着条件读：
> 同一台机器上有**活 server 在跑**，与本猫自查的时间窗相隔约 1 分钟。它与全量档的
> 61.3s / 3302 用例 / 累计 `tests 377.65s` **不同口径**——两次的 worker 并行度不同
> （累计 `tests` 669s vs 378s），**不可直接比大小**。登记它只为一件事：**收窄档并不保证更便宜**，
> 且它是 §F 残差的一个侧证——钩子耗时对机器负载高度敏感。

**D. 不可用读数（如实登记，不许当结论用）**

| 读数                                      | 来源    | 为什么不可用                                                                                             |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `commit-server = 4020 / 4078 / 4141 ms`   | report2 | `ok=false`：`sh pre-commit` 在中途（~3s）失败退出 ⇒ 只量到**第一个失败点**，压根没跑到 `precommit-scope` |
| `hook-e2e-server = 3122 / 2943 / 2999 ms` | report2 | 同上，同一批失败                                                                                         |

**E. 端到端真值（生产日志，决定性）**

`packages/server/data/cat-study.log` 48 条 `auto commit skipped (no changes)` 与其**前一行**日志之间的静默：
中位 **140.1s**、最大 **180.7s**、全天单调增长（16:57 的 109s → 23:54 的 180s）；对照 `agent reply done` 间隔中位 12.6s。

**F. 归因结论与残差（如实声明）**

- **已归因**：全量 vitest ≈61–64s（`precommit-scope`）+ `pnpm lint` ≈7.7s + `lint-staged` ≈1.9s ≈ **74s**。
- **未归因残差 ≈65s**（138.5s − 74s）。店长的诊断是 round 1 与并发测试跑批的 CPU 竞争抬高
  读数，本猫**不能证实**，故不写成结论。一个可检验的候选：standalone 计分段时 `lint-staged`
  无暂存内容 ⇒ 近空跑（1.9s），而真钩子里有暂存内容 ⇒ prettier 全量真跑。
  **判据**：暂存一个文件后单跑 `npx lint-staged` 计时（约 1 分钟，本轮**未做**——
  避免与全量自查并发污染读数，那正是 round 1 栽过的坑）。

## 四、格 2 · 止血（异步 + 显式树锁）

### 4.1 为什么异步化**必须**配套一把锁

旧实现里 `add → commit → rev-parse` 是一个**同步块**：进程内任何别的 JS 都插不进来。
它不是设计出来的锁，但**事实上**就是那把「git 操作串行化」的锁。改异步 = 拆掉它，
而钩子自己也在动 git（`lint-staged` 会 `git add`）⇒ **同一棵树**两笔交错必撞 `index.lock`
（本仓在 `AGENTS.md` 提交约定里记过这个坑）。不补锁地异步化，是用「服务器僵死 1–5 分钟」
换「git 并发踩踏」。

### 4.2 落点

| 文件                  | 改动                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm/git-utils.ts`    | 新增 `runGit`（`execFile` + Promise，不阻塞事件循环）、`pendingGitChildren` 登记表、`stopGitChildren()`、`treeRootKey()`、`withGitTreeLock()`；`gitCommit` 转 async；新增 `gitResetDirtyTree()` |
| `execution/serial.ts` | `await gitCommit(...)`；清理段改 `await gitResetDirtyTree(target.cwd)`；`execSync`/`cleanGitEnv` 两个 import 删除；段 G 每轮留痕（见 §五）；清理段 catch 由**裸忽略**改记 `error`               |
| `index.ts`            | `shutdown()` 里加 `stopGitChildren()`（C5，与 `stopLlamaServerIfSpawned` 等同段）                                                                                                               |

**键的选择（决策留痕）**：键 = `realpathSync.native(resolve(cwd))`（win32 再小写）。
刻意**不**用 `git rev-parse --show-toplevel` / `--git-common-dir` 当键——后者是所有
worktree 共享的 `.git`，会把「每棵树独立提交」退化成一把**全局锁**，正好杀掉一猫一
worktree 的并发（C1 明写「不同树不互斥」）。`cwd` 由**唯一**解析点 `ensureAgentWorktree`
给出，恒为树根。

**清理段搬家的第二个理由**（第一个是同步阻塞）：它**必须与提交共用同一把树锁**——
同树的 `git clean -fd` 会把 `git commit` 刚 `git add` 进去的东西删掉。

### 4.3 提交 message 不再过 shell

`execFile('git', ['commit', '-m', message])` 参数按数组传，不再经 `cmd.exe`，也没有旧实现
手写的 `message.replace(/"/g, '\\"')`（那个对 `$` / 反引号 / 反斜杠是漏的）。落库的 message
原文不变（C3）。

## 五、格 3 · 仪表（「无改动」与「门禁失败」可辨）

旧实现：`git add -A` / `git commit` / `rev-parse` 全在**一个** try 里，catch 只记一句
`auto commit skipped (no changes)`。于是**四种**情况产出同一条日志——真没改动 / pre-commit
被 lint 挡 / uuid 门禁拒绝 / `index.lock` 撞车。读数不可信（`review fallback judged:
本执行无 commit` 是它的下游）。

改法：**判「有没有东西可提交」不用 `git commit` 的退出码**，改用暂存区读数
`git diff --cached --quiet`（0 = 无差异 → `auto commit skipped (no changes)`，info；
1 = 有差异 → 继续提交；≥2 = 出错 → `auto commit failed`，error）。提交失败落 **error**
并带 `error` / `stdout` / `stderr` 尾部；命中 `index.lock` 时额外给 `hint`（显式点名，
不许静默）。`git add -A` 与 `rev-parse HEAD` 各自的失败也各有独立 error 日志。

**段 G 每轮留痕**（验收 6）：`git.auto_commit` 段改为**每轮都写**——真产生 commit → `ok`；
一棵树都没提交 → `skipped`（`deriveErrorType` 对 `skipped` 返回 null，不计 error）。
原验收 26 的措辞是「该段**可**缺」，「可缺」≠「必须缺」，两者不冲突；段缺失时
「没提交」与「没跑」不可区分，正是格 3 要治的那类混淆。

> **落地切分（2026-09-21）**：本格只落「暂存区空 ⇒ 跳过 `git commit`」这条判据
> （+ `git diff --cached --quiet` 出错落 error）。上面其余各条——其余失败面各自的独立
> error 日志、段 G 每轮留痕——**仍属格 3，本轮未落**。故 `adr-0015-draft.md` 那处未提交的
> 订正里「钩子非零退出走独立的 `auto commit failed` 日志」**目前仍是假话**，随格 2/3 一起核。

## 六、验收对账

审查对象 = 分支 `fix/autocommit-blocking` 上**格 0 那一笔**（格 2 改动不在其中，物理隔离见 §十）。

| #   | 验收项                                            | 判据（怎么测的）                                                                                                          | 读数                                                                  | 结论 |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| ①   | 空索引 → 不调 `git commit`                        | 临时真仓库里装「一跑就留痕」的 pre-commit 钩子：无改动时钩子**零执行**、HEAD 不动、返回 null、落既有 `…(no changes)` info | 新用例 1；探针 A = 1 红 26 绿                                         | ✅   |
| ②   | 有改动 → 照调且钩子照跑（**反对照，必做**）       | 同一装置：写一个文件后钩子**必须留痕**、产生 commit、返回 sha                                                             | 新用例 2；探针 B = 5 红 22 绿                                         | ✅   |
| ③   | `git diff --cached --quiet` 出错 → error 且不静默 | 子进程边界注入 `status=128`（真仓里造不出该形态）：落 error、**不落**「没改动」info、不产生 commit                        | 新用例 3；探针 C = 1 红 26 绿                                         | ✅   |
| ④   | 复述面清扫                                        | `git grep` 全仓，命中清单 + 逐条处置                                                                                      | 见 §七（5+1 命中：改 1、留格 2 共 5）                                 | ✅   |
| ⑤   | `pnpm test` + `pnpm lint` 全绿                    | 全量 4 project（detached 跑，旗标收口）；`node scripts/lint.js`                                                           | **152 文件 / 3302 用例全过（rc=0，较格 0 前 3299 +3）**；lint ✅ 三包 | ✅   |
| ⑥   | 票单订正                                          | §3.3 用**盘上**读数填（未重跑）、§六/§七 补齐、记本轮超时与恢复点                                                         | 本文件 §3.3 / §六 / §七 / §十                                         | ✅   |

**真空性反对照（三组探针，各自必须红在相对的那一半）**

| 探针 | 注入                          | 读数                                                                                      | 命中该红的那半 |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| A    | 短路恒不生效（`if (false)`）  | **1 红 26 绿**；红 = 用例①（`expected [] to include 'auto commit skipped (no changes)'`） | ✅             |
| B    | 短路恒生效（`staged >= 0`）   | **5 红 22 绿**；红 = 用例② + 既有 2 条 + worktree 隔离 1 条（全是「该提交却没提交」）     | ✅             |
| C    | ≥2 不落 error（`if (false)`） | **1 红 26 绿**；红 = 用例③（`expected 'a7c7ba41…' to be null`——出错时真去提交了）         | ✅             |

探针跑完工作树已还原（与备份 `diff` **逐字节相同**）。**A 只红在日志断言上**——若只留「钩子留痕」
一条，一个「空索引也走 error 分支返回 null」的实现会全绿 ⇒ 日志判据是**承重的**，不是装饰。

**契约遵守**：C2 全程无 `--no-verify`；C3 三面零变化（message 形态、`git add -A` 扫描语义、
**日志文案**——短路那条与旧 catch 那条逐字相同）；C4 返回语义不变（无 commit → null）；
C1/C5 属格 2，本笔不涉。判据 fail-closed：`-1`（拿不到退出码）与 `≥2` 一律落 error，
**绝不**并入「没差异」。

## 七、复述面清扫（验收 7）

`grep` 口径：描述「`gitCommit` 是 3 次连续 `execSync`（阻塞事件循环）」及其**同族**
（脏文件清理走 execSync / 提交失败与无改动同一条日志）的文本。`git grep` 全仓
（tracked；`packages` `docs` `scripts`）命中 **5 处** + 本票 1 处：

| #   | 位置                                                          | 文本要点                                                         | 格 0 处置                                                                                                                                                                        |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/server/src/llm/git-utils.ts`（原 catch 注释）       | 「没有改动时 `git commit` 会非零退出，这是正常的」               | ✅ **改**——格 0 后「没改动」不再走 catch，原句已成假话。改为「走到 catch = `add`/`commit`/`rev-parse` 出错」，并点名该文案对「钩子拒绝 / `index.lock` 撞车」仍是假读数（属格 3） |
| 2   | `packages/server/src/execution/serial.ts:1356`                | 「`gitCommit` 是 3 次连续 `execSync`（阻塞整个 Node 事件循环）」 | ⬜ **不改，留格 2**——格 0 不改变阻塞属性（仍是同步 `execSync`），该句**承重部分未被证伪**；变的只是调用次数（提交路径 3→4、短路路径 2），而这份文本本就在格 2 的改动集里         |
| 3   | `packages/server/src/execution/serial.downgrade.test.ts:779`  | 同句式（阻塞成本同量级）                                         | ⬜ 同上                                                                                                                                                                          |
| 4   | `packages/web/src/utils/spanLayout.ts:51`                     | 前端段说明「3 次 execSync，阻塞整个事件循环」                    | ⬜ 同上                                                                                                                                                                          |
| 5   | `docs/run/eval-system/prototypes/R3-right-panel-v2.html:1759` | 原型页内嵌同一句说明                                             | ⬜ 同上（原型快照，非活代码）                                                                                                                                                    |
| 6   | `docs/run/eval-system/R2-design-span-table.md:45`             | 设计读数「3 次连续 execSync」                                    | ⬜ 同上——该文件已在格 2 的改动集内                                                                                                                                               |
| 7   | `docs/run/autocommit-blocking/tickets.md:21`                  | 本票「`gitCommit` **当时**是 3 次连续 execSync」                 | ✅ 无需改——已用「当时」限定为历史读数                                                                                                                                            |

**同族扫描（运行期日志文案消费者）**：逐条核过归属，**精确**引用 `auto commit skipped (no changes)`
的只有两处——`docs/run/multi-cat-isolation/adr-0015-draft.md:34`（F1 判「文案恒真」）与
`closeout-phase-ib-1.md:44`。格 0 **刻意不动文案**（C3「日志文案零变化」）⇒ 这两条陈述
**未被证伪**，不改。

> 核归属时纠了一处口径：`report-phase-ib.md:121/152` 引的是**另一条**同族日志
> （`auto commit skipped — worktree unavailable` / 前缀 `auto commit skipped`），与本条不是同一条，
> 格 0 未动它。上一稿把它们并进来是「锚点声称冠错文件」的同型错，已订正。

## 八、边界（不做）

- 不动 `.husky/*` 门禁内容（属 OQ）
- `ensureAgentWorktree`（同步建 worktree）**只登记不修**
- 不动提交 message 形态、不动 a2a / 记忆 / 知识库链路、`retrieval_events` 零改动
- 不新增第三方依赖

## 九、挂账 / 待裁

- **OQ（店长提出，等格 1 分解表）**：auto-commit 要不要继续跑人类提交门禁？
  三候选：① 维持现状（异步止血，代价照付）② 给 auto-commit 一条更窄的门禁路径
  ③ 把 auto-commit 从执行收尾热路径挪成后台任务。分解表见 §3.3（主犯 = `precommit-scope`
  的全量 vitest ≈61–64s，且**空暂存区正是触发它的那条分支**）。
- **格 2（异步 + 树锁）**：店长裁「暂缓」——等格 0 的生产读数出来再定。原 WIP 完整保留在
  `git stash`（`stash@{0}`「ge2-async-wip」，19 文件），本轮未动、未提交。
- **格 3（仪表）**：未落。本轮只落了其中「`git diff --cached --quiet` 出错落 error」一条。
- F7 / G2 / F9 三合一后续票（店长按「先挂着」处理）。

## 十、本轮超时与恢复点（2026-09-20 → 09-21）

**第①轮执行超时（超时，不是卡死）**：23:13:24 → 23:43:24，`status=failed`，
`error_message=执行超时 (1800s)`。死因 = 把 30 分钟预算花在**等自己要测的门禁**上
（探针里每次带钩子提交 60–140s，全量 vitest 跑了两轮各 61s）。
现场核实：**孤儿进程 0**（无残留 tsc / vitest / git）、**`index.lock` 0**（三棵树全扫）。

**恢复点（第②轮入口）**：

| 资产                            | 位置                                                                                  | 状态                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 格 2 WIP（19 文件 / +633 −118） | **分支 `wip/autocommit-async-ge2`**（`git stash` `stash@{0}`「ge2-async-wip」同指向） | 完整，**不在** `fix/autocommit-blocking` 上；`git diff ebc4650f wip/autocommit-async-ge2` 即全量改动面 |
| 探针数据                        | `D:/Game/ai/_probe-autocommit-profile/report{,2,3}.jsonl` + `run{,2,3}.{mjs,log}`     | 完整；§3.3 据此填，**未重跑**                                                                          |
| 票单                            | 本文件                                                                                | 本轮订正并提交                                                                                         |

**为什么给格 2 另起分支而不是只留 stash**：stash 离 `git stash clear` 只有一步，19 文件的工作
不该只挂在一条易失的 ref 上；分支同时满足「不进格 0 这一笔」与「下一轮直接 checkout 续做」。
本轮**只取**格 2 判据的形状（`git diff --cached --quiet`）在同步实现上重写，
**没有**提交格 2 的任何一行代码——格 0 那笔的 diff 里不含异步改造。

**流程订正（本轮已执行）**：>5min 的链路一律 **detached 启动 + 旗标轮询**
（`nohup bash … &` + `*.done` 旗标），前台只读旗标、不拿执行预算等门禁。

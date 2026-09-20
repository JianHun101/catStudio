# 报告：T-2 Phase I-b 第 1 笔 —— 审查面可达性（取证 + 确定项）

> **本文件现承载本票两笔**（第 1 笔 = §一～§十；第 2 笔 = §十一～§十八）。
> 第 2 笔的形态 G 实施与 V17–V22 读数从 **§十一** 起。

> 票面：`docs/run/multi-cat-isolation/tickets-t2-phase-ib.md`（`640da4a`）
> 提交：本笔**一笔**，见**本文件的承载提交**（sha 写不进它自己承载的文件——自指，故以承载关系指认，不用「第 N 笔」占位）。
> 本笔**不实施形态**（票面 §五红线）：§五 的候选代价表交店长裁，第 2 笔另派。

---

## 一、结论先行

1. **票面 §4.2 的核心推断被实测证实，不是推翻**：审查者执行时，其工作区**不含**被审 sha 的改动。
   两把尺子各测一次，方向一致（§三 V16-b）：
   - **结构面**：审查者 cwd 内 `git merge-base --is-ancestor <被审sha> HEAD` = **`not-ancestor`**
   - **可感知面**：审查者 cwd 里 `tracked.txt` **文件在、内容是旧版**（`base\n`），而实施猫树里是
     `base 改过\n` —— 「读不出是旧的」这句不是修辞，是这两行断言之间的差。
2. **判据非恒真已同格对照**：同一探针喂**实施猫自己的树** ⇒ `ancestor`。若探针坏了/恒假，这一格不会成立。
3. **反向对照已跑**（票面 §4.2 必做）：把 V16-b 断言翻成**应然形**（`ancestor`）⇒ 该格必红，
   读数 `expected 'not-ancestor' to be 'ancestor'`，**恰 1 格红、其余 8 格不动**（§三-2）。
   **这一格「审查者看不到被审改动」是预期要修的东西，不是 flaky** —— 后来者请勿据此改绿。
4. **P3-c 两格已补**，且**反向对照暴露了我自己初稿的一处恒真断言**（`existsSync` 单条判不出清理与否，
   成功路径也会「文件还在」），已改成与成功路径分得开的判据（§四-3）。
5. **P3-c-2 的触发形态经实测更正为「规范化碰撞」**：字面的「同名不同 agentId」**不可达**
   （`agents.name` 是 `UNIQUE`，`db/index.ts:159`）；可达的是 `甲 猫` 与 `甲猫` 经 `catSlug` 归一撞车（§四-2）。
6. **实施中发现一条与本笔无关的既有缺陷（F 级，阻断 V17 的可用性）**：本笔所改的测试文件
   **在 `HEAD` 上就是 flaky**（我的改动全部 revert 后实测 **2/8 轮红**），根因已抓到 ——
   `git worktree add` 撞上「目录缺失但注册仍在」的残留态（§七）。**这不是本笔引入的**，
   但它使「全量绿」这一验收读数不可靠，请店长裁是否本票内修（§八-1）。
7. **生产码零改动**：`packages/server/src/llm/git-utils.ts` 逐字节未变（票面 §4.1 只读勘察要求）。

---

## 二、Phase I 活实例首手读数（票面 §4.4，零成本取证）

票面说：Phase I 收口后**尚未被任何非 store 执行行使过**（`cat worktree ready` 全日志 0 次），
**本猫这一轮执行本身就是首次**。三个读数如下（本轮 ds猫 实际执行环境）：

| 读数                              | 值                                           |
| --------------------------------- | -------------------------------------------- |
| `pwd`                             | `D:\Game\ai\catStudy-sessions\4c8acf70-ds猫` |
| `git rev-parse --abbrev-ref HEAD` | `session/4c8acf70-ds猫`                      |
| `git rev-parse HEAD`              | `09e164ad9babf82a8824e1057195929690ceeddd`   |

**判读**：三个读数同时成立 ⇒ 本猫执行在**自己的猫 worktree**内，**不是**会话 worktree
（`…/4c8acf70`）、**不是** `workspace/` 降级。`git worktree list` 亦可见同会话三棵树并存：
`4c8acf70`（会话树，`session/4c8acf70`）、`4c8acf70-ds猫`、`4c8acf70-flash猫`。

> **这是「一猫一 worktree 在活实例上是否真生效」的第一手读数，不是形式主义**：
> 降级形态（`cwd: undefined` → `workspace/`）与正常形态在 `pwd` 上**长得完全不一样**，
> 而 `workspace/` 是 gitignored 的 —— 真降级了，本报告连「改动丢在哪」都指不出来。

**本条证什么、不证什么**：证「非 store 执行确实落到猫树」；**不证** Phase I 的完整闭环
（收口 fan-in / 回收 / 重启恢复未在本笔范围内，票面 §六-4 明写「不当已验证结案」）。

---

## 三、V16 审查面可达性（票面 §4.2）

### 3-1 三格读数（`serial.cat-worktree.test.ts`，用例名 `V16 · …`）

夹具：真 SQLite（`:memory:`）+ 真 git 临时仓。构造：`session/scwt0008` 集成分支存在 →
实施猫 `暹罗猫`（`role: 'implementer'`）在自己树上改**已跟踪文件** `tracked.txt` 并提交 →
审查猫 `吐槽猫`（`role: 'reviewer'`）执行。

| 格               | 断言                                                                            | 读数                             |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| **V16-a 分派**   | 审查者实收 `cwd` == 它自己的猫 worktree（读 `chatStream` 实收的 `cwd`，非旁证） | ✅ 绿                            |
| **V16-b 陈旧性** | 审查者树内 `--is-ancestor <被审sha> HEAD` == `not-ancestor`                     | ✅ 绿（**这一格绿 = 缺口存在**） |
| **V16-c 隔离性** | 集成分支 sha 逐字节不变、实施猫树与分支不受影响、主仓库零改动                   | ✅ 绿                            |

**V16-b 的两条互补判据**（同一格内）：

```
结构面：ancestorState(implSha, 'HEAD', revCwd)      === 'not-ancestor'   ← 缺口
可感知面：readFileSync(revCwd + '/tracked.txt')     === 'base\n'         ← 旧版内容
对照①：ancestorState(implSha, 'HEAD', implWt)       === 'ancestor'       ← 判据非恒真
对照②：ancestorState(implSha, sessionBranch)        === 'not-ancestor'   ← fan-in 前谁都没有
```

对照①是**同格常驻的反恒真闸**：探针若坏掉/恒假，这一格自己就会先红。
`ancestorState` 刻意做成**三态**（`ancestor` / `not-ancestor` / `error`）而非布尔 ——
`git merge-base --is-ancestor` 退出码 0=是、1=否、**其余=出错**；折成布尔会把「探针坏了」
读成「不包含」，而 V16-b 断言的正是「不包含」，那正是本仓反复点名的假绿门形态。

### 3-2 反向对照（票面 §4.2 必做）：**先让它红一次**

把 V16-b 断言由 `'not-ancestor'` 改为应然形 `'ancestor'`（即「审查者**应**看得到被审改动」），
其余一字不动，实跑：

```
× V16 · 审查面可达性：审查者 cwd=自己的猫树；被审提交不在其中（本票靶心）
AssertionError: expected 'not-ancestor' to be 'ancestor' // Object.is equality
Tests  1 failed | 8 passed (9)
```

**恰好 1 格红、其余 8 格不动** ⇒ 该格有分辨力，不是恒绿门。随后已还原为 `'not-ancestor'`。

> ⚠️ **给后来者的交代**：这一格在**第 2 笔（形态实施）落地后应当翻绿**。
> 届时请把那行断言的期望值改成正向、并**同时**保留对照①——
> 不是删掉这一格。删掉 = 把「本票要修的东西」从回归面上抹掉。
>
> **【已兑现 · 第 2 笔】** 期望值已翻正向（`not-ancestor` → `ancestor`）、**两条对照原样保留**、
> 未删格；该格改名为 `V17/V21`（`serial.cat-worktree.test.ts:628`）。读数见下文 §十三。

---

## 四、P3-c 提交期抛错分支（票面 §4.3）

### 4-1 P3-c-1 · 非法猫名

触发形态 = **快照/现状分歧**：执行期用派发批次里的 agent 配置（合法名），提交期
`resolveCommitTargets` 重新读 **DB 当前行**（`getAgentById`）。`agents` 表可变 —— `reply.ts`
已为此把 provider/model 记为快照（注释原文：「事后 join 拿到的是**今天的**配置而非**当时的**配置」），
猫名在两次读之间被改掉即命中本分支（V7 用的是同一形态，本格把它测成行级契约）。

| 面           | 断言                                                                                                           | 读数 |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ---- |
| **留 error** | `log.error('worktree resolve failed — tree skipped', {agentId:'cat-1', agentName:'a/b'})`                      | ✅   |
| **不提交**   | `log.warn('auto commit skipped — worktree unavailable')` + 该猫分支 sha **逐字节 == initSha**                  | ✅   |
| **不清理**   | `log.warn('dirty-file cleanup skipped — worktree unavailable')` + 脏文件仍在 + **树仍是脏的** + **不在分支上** | ✅   |
| 红线锚       | 主仓库 `dev` 停在 `init`、`tracked.txt` 未被碰                                                                 | ✅   |

### 4-2 P3-c-2 · 所有权冲突（**触发形态经实测更正**）

**票面/派活单的字面形态「同名不同 agentId」在本仓 schema 下不可达**：
`agents.name TEXT NOT NULL UNIQUE`（`packages/server/src/db/index.ts:159`）——
两只猫不可能真的重名，写进夹具直接 `UNIQUE constraint failed: agents.name`（实测）。

**可达的形态是「规范化碰撞」**：`catSlug` 会剥掉空白（`.replace(/[\s\\~^:?*\["@{]/g, '')`），
于是 `甲 猫`（dup-1 已占）与 `甲猫`（cat-1 改成）两个**不同的 DB 值**归一到
**同一条分支 + 同一棵树 + 同一目录** —— **DB 的 UNIQUE 拦不住它**，而这正是所有权标记存在的意义。

| 面                   | 断言                                                                          | 读数 |
| -------------------- | ----------------------------------------------------------------------------- | ---- |
| 前提（碰撞是实测的） | `DUP_A.name !== '甲猫'` 且 `catBranch(sid,'甲 猫') === catBranch(sid,'甲猫')` | ✅   |
| **留 error**         | `log.error('worktree resolve failed — tree skipped', {agentName:'甲猫'})`     | ✅   |
| **不提交 / 不清理**  | 共享分支 sha == initSha；脏文件仍在且树仍脏、不在分支上                       | ✅   |
| **该成因独有**       | 所有权标记**仍是 `dup-1`**（没被静默覆写成 cat-1）                            | ✅   |

> 标记不被覆写是这条成因的**全部安全内容**：覆写 = 两只猫共用一棵树且无人察觉。

### 4-3 **反向对照暴露了我自己初稿的一处恒真断言**（如实记录）

对 P3-c-1 跑「成功路径对照」（把 DB 改名那步去掉 ⇒ 解析成功），让断言取应然形，实跑 **9 passed**：

```
logError('worktree resolve failed…')            未被调用      ✅
该猫分支 sha                                     ≠ initSha     ✅（提交真发生了）
git status --porcelain（猫树）                   === ''        ✅（提交后树是干净的）
'auto commit skipped' / 'dirty-file cleanup…'    均未被调用    ✅
fileOnBranch(猫分支, 'dirty.txt')                **非 null**   ✅（脏文件被提交走了）
```

**这份对照把我初稿的 `expect(existsSync(dirty.txt)).toBe(true)` 判成了恒真**：
成功路径会把脏文件 `git add -A` **提交掉**，于是它也「还在」——
**「文件还在」单独一条判不出「清理与否」**，两个世界都成立。

已改成与成功路径分得开的判据（三行合取）：`existsSync` **且** `git status --porcelain` 仍含它
（仍是未跟踪的脏文件）**且** `fileOnBranch(...) === null`（没被提交带走）。
两格同款修正，并把这段反向对照写进用例注释，免得后来者再把它缩回单条。

---

## 五、§三 候选代价表 —— **实测**（非转述店长描述）

### G · 审查者树建出后，把 `listCatBranches()` 结果合入审查者自己的分支

探针：`%TEMP%\phaseib-probe.mjs`（**落在 `os.tmpdir()`，不进仓库**，票面红线），真 git 复现：
`session/S1` 集成分支 + 猫分支 A（改 `src.txt` 第 3 行）+ 猫分支 B（改 `other.txt`）+ 审查者分支 R。

| 测点                  | 读数                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **G-1 fan-in 幂等性** | ✅ **成立**。`listCatBranches()` = `[S1-A, S1-B]`，两次 `merge --no-ff` 都 OK                                                  |
| 　　顺序 R→A→B        | R `MERGED`，A/B **`SKIP(已合)`**（R 已含其提交）；终态 `src.txt=A-CHANGED`、`other.txt=B-CHANGED`                              |
| 　　顺序 A→B→R        | 三条全 `MERGED`；**终态内容与上序逐字节相同**                                                                                  |
| 　　同序重跑          | 三条全 `SKIP(已合)`、`session/S1` sha 不变 ⇒ **幂等**                                                                          |
| **G-2 冲突**          | ⚠️ **真实**。审查者与被审**改同一处**时：`merge A -> R` = **CONFLICT**；对照（审查者只加新文件、与猫不重叠）= **OK（无冲突）** |
| **§二-2 零分支移动**  | ✅ 只动 `session/S1-R`（审查者自己的猫分支）与 `session/S1`（fan-in 目标，本就该动）；`S1-A` / `S1-B` / `dev` **逐字节未变**   |

**判读**：G 的**幂等性代价不存在**（店长的担心方向被实测否掉）；**冲突代价存在且形态明确**
（重叠 ⇒ 冲突、不重叠 ⇒ 干净，两向都有读数）。G 的真实代价落在**「审查者与被审动同一处时的显式停」**，
而该停法在 `fanInCatBranches` 里已有现成范式（`conflict: true` + `recoverd` 语义）。

> **一条本文未实测、标注为推理的**（勿当读数用）：G 之后审查者分支的 `git log` 里混入了实施猫的提交，
> 责任归属面会比现在模糊。**这是推理，本笔没有为它设读数。**

### H · 审查面走 `git show <sha>:path`（零基础设施改动）

**实测：这条路的行为纪律载体今天已经存在，且是机械投递的** ——
`scripts/handoff-gen.mjs:206-209` 往**每一份**交接文档里写：

> `> ⚠️ 审查须知：先通读改动对应的完整 diff（`git show <sha>`），再核对本文档——本文档是作者的声明清单，不是事实本身。`

所以 H 的代价**不是「从零建立纪律」**，而是两条**实测得出**的边界：

1. **它覆盖的是「改动本身」（diff），不是「工作区/上下文」**。审查者要读**未改动的周边**
   （「这个函数的调用方接得住新分支吗」）时，工作区给的仍是**旧版** —— 正是 V16-b 测到的那个形态。
2. **它是文本指令，无强制力**，与票面 §二-1 判据直接冲突（「纪律会失守，结构不会」）。
   本仓已立此规矩（ADR 0015 §4），故 H 大概率不取 —— 列出仅供店长对照。

### X · 投递契约加结构化 `reviewSha`，按它建 detached 树

**实测触点计数**（`git grep` 面，非估算）：信号入口 `llm/route-signals.ts:54`（`consumeRouteSignals`）、
`execution/delivery-signal.ts`、cwd 分派 `execution/reply.ts`、消费侧 `execution/flow-advance.ts` /
`execution/review-fallback.ts`、MCP 工具 schema `scripts/mcp-server.mjs`，外加 `packages/shared` 的类型面
与审查侧技能文本 —— **≥6 个源文件 + 共享类型 + 技能文本**，与店长「跨票、另案」的定性一致。
**本笔不展开**（票面 §六-2 已划出范围）。

---

## 六、闸读数

| 闸                            | 读数                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node scripts/lint.js`        | ✅ **3 包通过**（shared / server / web）                                                                         |
| 本文件单跑                    | ✅ **9 passed (9)**                                                                                              |
| 全量 `npx vitest run` 第 1 轮 | ❌ **5 failed \| 2512 passed（1 failed file / 124）** —— 全部落在 **`src/llm/session-closeout.test.ts`**（见下） |
| 全量 `npx vitest run` 第 2 轮 | ✅ **124 files / 2517 tests 全绿**                                                                               |

**两轮读数必须一起读，单取任一轮都是误导**：

- 第 1 轮红的是 **`session-closeout.test.ts`**，**不是本笔改的文件**（本笔只碰
  `serial.cat-worktree.test.ts` + `docs/`，两文件间无 import 关系）⇒ 该红**不可能由本笔 diff 引起**。
- 可观测的失败：`mergeSession(...)` 返回 `null`（= `!branchRefExists(mainRoot, branch)`，
  `session-closeout.ts:202`），即**夹具里集成分支没被建出来** —— 与 §七 同属
  「git worktree/分支创建在并发负载下偶发失败」一类。
- 第 2 轮同命令**全绿** ⇒ 它是**间歇性**的，不是本笔的稳定红。

**如实记一条我不能排除的**：本笔新增的 3 格会多建几棵树、多跑十几秒。若该间歇缺陷**受负载影响**，
则本笔**可能提高了它的触发概率**。我**没有**做「在途改动全 revert 后跑全量」的对照来排除这一点
（全量一轮 ~4 分钟，且对照本身也要多轮才有统计意义），故此处**只声明不确定，不当结论**。

---

## 七、实施中发现：本笔所改文件的**既有 flaky**（与本笔无关，但挡 V17）

### 7-1 事实：`HEAD` 上就 flaky

把本笔改动**全部 revert**（`git checkout -- packages/server/src/execution/serial.cat-worktree.test.ts`，
确认工作区只剩 HEAD 版）后连跑 8 轮：

```
run 1: Tests 6 passed (6)
run 2: Tests 2 failed | 4 passed (6)     ← 红
run 3: Tests 1 failed | 5 passed (6)     ← 红
run 4..8: 6 passed
```

**⇒ 2/8 轮红，全部落在既有格**（不同轮次分别红在 V2 / V3 / V13 / V15），**不是本笔引入的**。
本笔新增的 V16 / P3-c 骑在同一套夹具上，因此**同样受它影响**。

**同类第二次出现（更强的一条）**：全量第 1 轮红的 **`session-closeout.test.ts`** 是**另一个文件**
（§六），而本笔 diff **碰不到它**（无 import、无共享模块）——
**「不是本笔引入」在这里是可推理的，不依赖对照组**。
两个文件都是 Phase I 引入的 git-worktree 夹具 ⇒ 这一类至少覆盖 2 个文件。

### 7-2 根因（抓到 git 原始 stderr）

`git worktree add` 失败。该调用在 `git-utils.ts:483-487` 是 `stdio: 'ignore'`，
**git 的 stderr 被丢弃**，日志里只剩裸命令 —— 故先临时把 `stdio` 改为捕获、并把 stderr 打进日志
（票面 §4.1 允许「取证需要加日志」，**已 revert，`git diff` 显示 `git-utils.ts` 零改动**，回滚成本 = 0）。
拿到决定性读数：

```
fatal: 'C:/Users/…/AppData/Local/Temp/catStudy-sessions/scwt0002'
       is a missing but already registered worktree;
       use 'add -f' to override, or 'prune' or 'remove' to clear
```

同时刻探针读数：`DIAG_EXISTS=false`（目录确实不存在）、`DIAG_GITMARK=false`（无 `.git` 标记）。
即：**目录已被删、但 git 的 worktree 注册仍在** ⇒ `ensureWorktreeAt` 的 `git worktree add`
必然失败、且**不自愈**（既无 `prune` 也无 `-f`）⇒ 返回 null ⇒ 降级。
降级后 `ensureCatWorktree` 返回 null，用例断言 `toBeTruthy()` 变红。

### 7-3 诚实边界（本笔**没有**证明的部分）

- **未能指认「谁留下的注册残留」**：抓到这行 stderr 后，我装了 worktree-list 诊断想复现并看清注册来源，
  但随后 **6 连跑全绿、未再复现**，诊断期间一次都没抓到。故「残留由 `dropWorktrees` 的 rmSync+prune
  序列产生」是**推断，不是读数** —— 如实声明，不写进结论。
- 频率是**实测区间**（2/8 与 0/6 两段），不是稳定复现率；机器负载可能相关。

### 7-4 为什么这条值得店长看一眼（不只是测试问题）

同一个失败形态在**生产**里也是降级路径：`ensureWorktreeAt` 撞上「missing but already registered」
⇒ 返回 null ⇒ 猫拿不到 worktree ⇒ **回落 `workspace/`（gitignored，改动连 `git status` 都看不见）**。
本仓对这个形态早有认知（`removeStaleWorktreeDir` 的注释整段在讲残留目录），
但守卫只覆盖「**目录还在**且无 `.git` 标记」那一支；**「目录已不在、注册还在」这一支没有守卫**。
§七-1 说明它在真实仓库上确实会被撞到。

**本笔未改**（`git-utils.ts` 是只读勘察面，且修它属 Phase I 核心路径，不在本笔交付面）。

---

## 八、覆盖边界自陈

1. **V16 证的是「审查者工作区不含被审提交」这个后果，不是「审查者一定读错」**。
   审查者若严格照 `git show <sha>` 走（§五 H 那条载荷确实已机械投递），仍可能读对。
   本笔钉的是**结构性不可达**：工作区那条路读到的**一定**是旧版且**看不出**是旧版。
2. **V16 未覆盖「同一会话里审查者重复执行」**：第二次执行时它的猫分支可能已含上一轮的东西。
   本格只构造「首次执行」形态。
3. **P3-c 两格证的是「提交期 catch 的后果」，不证「抛错成因在真实生产中出现的频率」**。
   两格的触发都走**快照/现状分歧**（执行期配置名 vs 提交期 DB 名），
   这是本仓既有形态（V7 同款）但**频率未测**。
4. **P3-c-2 的「规范化碰撞」是可达形态之一，不是唯一形态**。我只证了这一条可达 + 字面同名不可达；
   其它归一化路径（控制字符、`..`、首尾 `.`）**未逐条构造**。
5. **§五 候选表是「G 的代价」实测，不是「G 与 H/X 的对比」实测**：H 只测了纪律载体的存在性与覆盖面，
   X 只测了触点计数；**三者没有在同一夹具上跑过对照**。
6. **§二 的三读数只覆盖 ds猫 一只猫一轮执行**。它证「非 store 落到猫树」，不证并发、不证重启恢复。

---

## 九、待店长裁（不阻断本笔送审）

1. **§七 的既有 flaky 是否本票内修**（我的建议：**另立单**）。
   - 理由：它**不是本笔引入**（HEAD 上 2/8 红），修它要动 `git-utils.ts` 的
     `ensureWorktreeAt`（Phase I 核心路径，本笔交付面明写「只读勘察，不改」）；
   - 但它**挡 V17 的「全量绿」读数** —— 按本票口径，全量红时我无法自证交付面是绿的。
   - 最小修法（供参考，未实施）：`git worktree add` 失败且 stderr 命中 `already registered` 时
     `git worktree prune` 后重试一次；并**把 `stdio` 改成捕获 stderr**（失败成因今天在生产里也是不可见的）。
2. **§五 的形态裁决**（G / H / X）：本笔按票面 §五「第 2 笔先报我裁」停在这里，**未自选形态**。
3. **§三-2 那格在第 2 笔落地后怎么翻**：见 §三-2 的「给后来者的交代」（改期望值、**保留对照①**、不删格）。

---

## 十、挂账（本票不做）

- `serial.ts:770` 的 `?? process.cwd()` 降级路径 —— 票面 §六-1 已实测非 Phase I 回归，另立单。
- 投递契约加 `reviewSha`（候选 X）—— 票面 §六-2，另案。
- 单A（`LOG_FILE` 两处）/ 单B（V14 护栏进 `packages/**` 提交口）—— 另票，不同批。

---

# 报告：T-2 Phase I-b 第 2 笔 —— 形态 G 实施（审查者树 = 集成分支 ∪ 猫分支）

> 票面：`docs/run/multi-cat-isolation/tickets-t2-phase-ib.md` §八（形态裁 G）+ §九（取数点裁定）
> 本笔触及 `reply.ts`（生产）⇒ **落地后需重启**（票面 §八 额外要求）。

## 十一、本树 HEAD（§八 额外要求：归属面可审计）

G 的已知代价是审查者分支混入实施猫提交、归属面变模糊 ⇒「我到底看到了哪份内容」**必须可审计**。
本笔执行环境读数（ds猫，非审查者 ⇒ **本笔的合并逻辑对本树不生效**，下面三个读数是**未合并**的形态）：

| 读数                              | 值                                             |
| --------------------------------- | ---------------------------------------------- |
| `pwd`                             | `D:\Game\ai\catStudy-sessions\4c8acf70-ds猫`   |
| `git rev-parse --abbrev-ref HEAD` | `session/4c8acf70-ds猫`                        |
| `git rev-parse HEAD`              | `8949e89`（本提交**之前**；fork 点）           |
| 会话分支 tip                      | `fd119c6`（本猫树落后 3 笔，全在 `docs/run/`） |
| `dev`                             | `c0383c9`（**零改动**，见 §十六 V21）          |

**审查者落地后的可审计指针**：其树 HEAD = 目标分支上的 merge commit
（`git log -1 --format=%s session/<sid8>-<猫名>` ⇒ `review-view session/<sid8>-<来源猫分支>`），
且每次准备成功都留一条 `review view prepared`（info 级，带 `merged` / `skipped` 计数）。

## 十二、改了什么

| 文件                                    | 动作                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `llm/worktree-fanin.ts:156`             | **抽出 merge 循环核心** `mergeBranchesInto(target, sources, cwd, label)`（全仓唯一一份） |
| `llm/worktree-fanin.ts:138`             | 前置①抽成共用 `refuseIfMergeInProgress`（两入口判据必须一致）                            |
| `llm/worktree-fanin.ts:211`             | `fanInCatBranches` **降为薄 wrapper**：签名与前置②**原样保留**（裁定 §4）                |
| `llm/worktree-fanin.ts:243`             | **新增** `mergeCatBranchesIntoOwnBranch`（审查面入口，前置 = cwd HEAD 须是本会话猫分支） |
| `llm/worktree-fanin.ts:283`             | **新增** `ensureExecutionWorktree`（执行 cwd 单源：建树 → 审查者额外合并）               |
| `execution/reply.ts:986`                | `cwd:` 由 `ensureAgentWorktree` 换成 `ensureExecutionWorktree`（**生产面 1 行**）        |
| `execution/serial.cat-worktree.test.ts` | V16 格 **翻转**成 V17/V21 + 新增 V19 / V20 / V22 三格                                    |
| `execution/serial.test.ts`              | **mock 桩搬家**（见 §十四，**被逼出来的第 5 个文件**）                                   |

**`git-utils.ts` 零改动** —— 与派活单「触及 `reply.ts` / `git-utils.ts`」的字面预期不同，理由见 §十四-1。

## 十三、V17 翻转读数（第 1 笔 V16-b 的应然形）

cell：`serial.cat-worktree.test.ts:628`，`V17/V21 · 审查面可达（第 1 笔 V16-b **翻转**）…`

| 判据                                            | 第 1 笔读数            | 本笔读数                   |
| ----------------------------------------------- | ---------------------- | -------------------------- |
| 结构面 `ancestorState(implSha, 'HEAD', revCwd)` | `not-ancestor`（缺口） | **`ancestor`** ✅          |
| 可感知面 `readFileSync(revCwd/'tracked.txt')`   | `base\n`（旧版）       | **`base 改过\n`** ✅       |
| 对照① `ancestorState(implSha,'HEAD',implWt)`    | `ancestor`             | `ancestor`（**保留**）     |
| 对照② `ancestorState(implSha, sessionBranch)`   | `not-ancestor`         | `not-ancestor`（**保留**） |

**两条对照按票面 §八「只翻期望值，不删格」原样保留** —— 它们才是判据非恒真的常驻闸：
对照②证明**集成分支仍不含**被审提交（fan-in 尚未发生），即本笔**没有**偷偷把内容灌进集成分支；
对照①证明探针没坏。**删掉任一，这格就退化成恒绿门。**

## 十四、V18 反向对照（**先红后绿**）

把 `ensureExecutionWorktree` 里的合并动作去掉（`// V18 REVERSE-CONTROL`，其余一字不动）实跑：

```
× V17/V21 …  AssertionError: expected 'not-ancestor' to be 'ancestor'
× V20 …      AssertionError: expected 1 to be +0          ← chatStream 被调了 1 次（审查者照样开跑）
× V22 …      AssertionError: expected 'not-ancestor' to be 'ancestor'
Tests  3 failed | 9 passed (12)
```

**恰好 3 格红、9 格不动**，且红的三格正是「依赖合并」的全部格子；**V19 在红态下仍绿** ——
这正是它该有的形状：隔离格**不该**依赖合并是否存在，它判的是**范围限定**。
随后还原 ⇒ `12 passed (12)`。

**V19 自己的反向对照**（去掉 `role !== 'reviewer'` 的范围限定 ⇒ 对所有猫都合）：

```
× V19 …  AssertionError: expected 'ancestor' to be 'not-ancestor'
× V2  …  AssertionError: expected 'A\n' to be null          ← 既有 Phase I 格同时被抓红
Tests  2 failed | 10 passed (12)
```

**顺带得到一个不在预期内的读数**：V2（Phase I 既有的「两只猫各改各的」格）**也是**同一条边界上的
独立绊线。⇒ 该边界今天有**两条**互相独立的判据把守，不是孤证。

### 十四-1 五个文件里有一个不是交付面点名过的（**如实自陈**）

派活单预期改 `reply.ts` / `git-utils.ts`；实际 `git-utils.ts` **零改动**，而多出一个 `serial.test.ts`。

1. **为什么不是 `git-utils.ts`**：`git-utils.ts` 的 import 表**只有 node 内置 + `../logger.js`**
   （零内部依赖）—— 它是底层。合并入口需要 `listCatBranches`，若放进去就形成
   `git-utils ⇄ worktree-fanin` 双向依赖。裁定 §4 已定「merge 循环放 `worktree-fanin`」，
   故接线点在 `reply.ts` → `worktree-fanin`，方向单一（`reply → fanin → git-utils`）。
2. **`serial.test.ts` 是被逼出来的**：`reply.ts` 的 execution cwd 解析点从
   `ensureAgentWorktree`（git-utils）搬到了 `ensureExecutionWorktree`（worktree-fanin）。
   该文件的 git-utils 工厂是**部分导出** mock，且 1204/1242 两处 `mockReturnValue` 会**跨用例泄漏**
   （`vi.clearAllMocks()` **清调用不清实现**）⇒ 从 1204 起 `ensureAgentWorktree` 恒返回
   `/tmp/catStudy-sessions/wt-tm*`，真 `worktree-fanin` 会拿这个**不存在的路径跑真 git**。
   实测口径：搬家前 **5 failed**（全是 REVIEWER 为父的格）→ 搬家后 **0 failed**。
   同一处搬家的**先例就在本文件 62-64 行的注释里**（Phase I 把解析点从 `ensureSessionWorktree`
   换成 `ensureAgentWorktree`，「同一处跟改」）。**这是第二次跟着解析点搬家。**

## 十五、V19 / V20 / V22 读数

| 格             | 判据                                                                                      | 读数 |
| -------------- | ----------------------------------------------------------------------------------------- | ---- |
| **V19** `:691` | 非审查者（`role` 缺失）执行后其树 `not-ancestor` + 文件读到旧版                           | ✅   |
| **V20** `:728` | 直接读返回值 `conflict:true` / `recovered:true` / `merged:[]`                             | ✅   |
| 　             | 树回可重跑态**三条独立断言**：分支 sha 未变 + 无 `MERGE_HEAD` + `status --porcelain` 为空 | ✅   |
| 　             | 集成面：冲突时 `chatStream` **一次都不被调用**（审查者不开跑）                            | ✅   |
| 　             | 不静默：`log.error('merge conflict', {label:'review-view', recovered:true})`              | ✅   |
| **V22** `:783` | 两轮审查者执行 ⇒ 分支 sha 与 merge commit 计数均不变，且内容仍在树里                      | ✅   |

**V20 里一条意料外的读数（已写进断言与注释）**：`r.skipped` 的**唯一**成员是
**审查者自己那条分支** —— `listCatBranches` 不排除自身，而 `isAncestor(自, 自)` 为真 ⇒ 自合是 no-op。
初稿我写的是 `expect(r.skipped).toEqual([])`，被实测判掉。这条不是噪声：它同时证明了
**循环停在冲突那个来源上**（`merged` 为空），且排序上 `吐槽猫` 先于 `暹罗猫`
⇒ skipped 的成员构成本身带信息。

**V22 末行「内容仍在」是必需的**：只断言「sha 没变」的话，把 skip 实现成
「第二轮干脆不合并 / 把分支重置回去」也能全绿 —— 那正是本仓反复点名的假绿门形态。

## 十六、V21 零分支移动（折进 V17 格，未单列）

票面 §八 V21「本笔跑完，`session/<sid8>` 与 `dev` 逐字节未变」的断言，与第 1 笔 V16-c
**逐字相同**，已保留在 V17 格内（`:628`）。**折格而非删格**，理由：

- 单列一格只能得到**同一组**读数（集成分支 sha、`dev` 的 `branchHead`、实施猫树与分支、主仓库文件），
  重跑一遍夹具不增加判据，只增加运行时间（每格 ~2s）。
- 「绝不改集成分支 / `dev`」在本实现里是**结构性的**而非约定：`mergeCatBranchesIntoOwnBranch`
  的 merge 目标取自 `symbolic-ref HEAD`（前置②已校验它是本会话猫分支）——
  集成分支与 `dev` 在该函数内**没有任何写入路径**。
- 若你认为该单列，我照办（改一行 cell 名即可）。

## 十七、覆盖边界自陈

1. **冲突 ⇒ 审查者不产出回执（fail-closed 换可用性）**。这是本笔**唯一的行为代价**，
   且是有意选的（票面 §二-3「显式抛错 + error 留痕」+ §八 契约 4「不带着半合并态继续」）。
   另一条路（冲突时照常开跑）会产出一份「审的是旧版且看不出是旧版」的回执 —— 正是本票要消灭的形态。
   **代价是真实的**：冲突场景下该轮审查链停在「没有回执」，需人工/店长介入。
2. **V20 的冲突形态是「审查者自己先改同一处」**，证的是判据在冲突下成立；
   **不证**「实施猫 A 与实施猫 B 互改同一处时审查者会撞上」这条更常见的形态
   （G 把两猫的并集压到审查者树上 ⇒ 那条路径**真的存在**，但本笔没为它设格）。
3. **V22 只跑了两轮**，不证 N 轮的稳定性；也不证「跨进程并发两个审查者」。
4. **本笔全部读数来自单进程、单会话、`os.tmpdir()` 下的临时真仓库**；不证生产多猫并发。
5. **`ensureExecutionWorktree` 的抛错路径没有幂等/重入保证**：抛在 `chatStream` 之前，
   由 `executeAgentsSerial` 的 `Promise.allSettled` 兜住 —— 本笔**没有**为「抛错后本轮的
   `execution_logs` 落什么状态」设格，那是 serial 的既有语义面，不在交付面内。
6. **§十一 的三读数只覆盖 ds猫 一只猫一轮执行**，且本猫**非审查者** ⇒ 它证「本笔的合并对本猫不生效」，
   **不证**审查者路径的活实例形态（那要等下一次真审查者执行，届时看 `review view prepared`）。

## 十八、闸读数

| 闸                             | 读数                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `node scripts/lint.js`         | ✅ **3 包通过**                                                                  |
| `npx vitest run`（全量）       | ✅ **124 文件 / 2537 用例全绿**                                                  |
| 本文件单跑                     | ✅ **12 passed (12)**                                                            |
| 重构后未改测试时的全 server 面 | 1 failed \| 1826 passed（1827）—— **唯一红格即待翻转的 V16**，其余 88 文件零影响 |

**计数口径**：2534（收口基线） + 3（本笔新增 V19/V20/V22） = **2537**。
V17 是既有 V16 格的**翻转**，**不新增用例数** —— 这也是本仓 D12 那条「计数必须写明单位」的规矩。

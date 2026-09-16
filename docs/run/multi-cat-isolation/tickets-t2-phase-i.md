# 票：T-2 一猫一 worktree 隔离 —— Phase I 接线

> 归属：多猫并行隔离（T-2）。设计依据 = `adr-0015-draft.md`（**accepted**，2026-09-15）D1–D5。
> **立票 2026-09-16**（用户指令：「命名合并 Phase I，你看什么时机合适就开工」）。
> **上游**：Phase S ✅（`sim-report.md`，PR #90）→ Phase T ✅（`a00dd17`，原语齐备 / **零调用点**）。
> **下游**：Phase I-b（D3 审查 detached worktree）。
> **开工时机**：**票 `docs-single-writer` 收口之后立刻**——理由见 §七（同一 worktree 一轮只放一只实施猫）。
> **落地后需重启 server 生效**（生产行为变更）⇒ 完成后回报店长，由店长发重启审批。

---

## 结论先行

1. **命名并入本票「前锋笔」，不单独立票。** `ensureCatWorktree` 全仓**零调用点**（Phase T 只交付原语）⇒ 单独落地命名 = **零生产效果、零重启需求**；接线一开，命名与接线共用同一批函数、同一次重启。⇒ 合并成一票两笔。
2. **原子批（本票唯一实施批次）：`D1 接线` 与 `fan-in / 回收接线` 必须同批落地。** 只接线不接 fan-in ⇒ 猫的提交落在猫分支上，而收口器仍只合 `session/<sid8>`（停在分叉点，`--ff-only` 输出 `Already up to date.` 退出码 0）→ 照样删 worktree 与分支 → **猫的提交永远没进过任何地方**（E5 静默丢活，`worktree-fanin.ts` 头注原文）。这不是「更稳妥的增量」，是把 F1 换成 F5。
3. **本票最硬的一处不在 git 层，在 auto-commit 的归属。** 现有自动提交是**会话级**的：`serial.ts:1148` `if (depth === 0)` 收尾时对着 `ensureSessionWorktree(sessionId)` **一棵树** `git add -A`。一猫一 worktree 后这棵树不再是猫干活的地方 ⇒ 猫的改动停在文件系统、猫分支空 ⇒ fan-in 合了个寂寞。**本票必须把提交目标改为「逐猫在其自己的 worktree 提交」**（§二 §三-3）。
4. **店长不动**（ADR D2 + 实测措辞修正）：`role === 'store'` 继续用会话 worktree——它是**唯一** checkout 了 `session/<sid8>` 的地方，即 fan-in 的 cwd。其余 agent（`role !== 'store'`，含审查猫）走各自的猫 worktree。
5. **双跑缺陷不属本票**：用户 2026-09-16 裁「先挂起，不常发生」，§六 记账，**不派活**。

---

## 一、范围

### 1.1 交付面（本票，两笔提交）

| #   | 文件                                               | 动作 | 内容                                                                         |
| --- | -------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| 1   | `packages/server/src/llm/git-utils.ts`             | 改   | `catShortId(agentId)` → `catSlug(catName)` + 所有权标记（命名前锋笔，§二-1） |
| 2   | `packages/server/src/llm/git-utils.test.ts`        | 改   | A 组期望值随命名更新（**改期望，不删断言**）                                 |
| 3   | `packages/server/src/execution/reply.ts`           | 改   | `:976` cwd 选择按角色分派（store → 会话 worktree；其余 → 猫 worktree）       |
| 4   | `packages/server/src/execution/serial.ts`          | 改   | `:1148` 收尾块的提交/清理**目标树**改为逐猫（§三-3）                         |
| 5   | `packages/server/src/llm/session-closeout.ts`      | 改   | `closeoutSession` 插入 fan-in（`:278` 之前）+ 回收（`:281` 之后）两个 step   |
| 6   | `packages/server/src/llm/session-closeout.test.ts` | 扩   | 收口链新 step 的矩阵（§四）                                                  |
| 7   | `packages/server/src/llm/worktree-fanin.test.ts`   | 扩   | 若有按 `<sid8>-<cat8>` 硬写分支名的用例 ⇒ 期望值随命名更新（**不删断言**）   |

**提交形态**：**两笔**。第 1 笔 = 命名（inert，零生产效果）；第 2 笔 = 接线（atomic，含 3–7）。审查按「票 = 两笔」审。**不得压缩成一笔**——第 1 笔是第 2 笔失败时的可回滚底座。

### 1.2 Out of Scope（明确不做）

- **D3 审查猫一次性 detached worktree** → Phase I-b 另票。本票审查猫**暂时**与实施猫同构（各有猫 worktree），F3 未修。
- **`serial.ts:770` 审查兜底 cwd** → 随 D3 一并处理（ADR 已挂观测点）。
- **`git-utils.ts:181-184` catch 不回滚索引**（D4 残留通道）→ 见 §六 挂账。
- **存量 24 个 worktree 不迁移**（D5）。
- **双跑缺陷**（用户已裁挂起）。
- **不动 pre-commit / `precommit-scope.mjs`**（票1 已收口；F1/F2 由隔离结构性解决）。
- **不评估性能**（现建 368ms / 复用 51ms 已有读数）。

---

## 二、接口契约（**本票钉死，实施者不得擅改；与 Phase T §2.1 的差异见下方说明**）

### 2.1 命名（前锋笔）

```ts
/** 猫名清洗：剔 git ref 非法字符（\ 空格 ~ ^ : ? * [ " .. @{ 及控制字符、首尾 .）；
 *  两类**显式抛错**（不得静默降级为 id 或空串）：① 含 `/`；② 清洗后为空。
 *  〖2026-09-16 店长更正〗原句把 `/` 写进「可剔字符」，与 V7「含 `/` ⇒ 显式抛错」互斥。
 *  按 V7 实现：静默剔除会把 `a/b` 折成 `ab`、与真名共用同一棵树（正是本票靶心）。
 *  见票面「补笔」节 —— 改票面字、不改实现。 */
export function catSlug(catName: string): string

export function catBranch(shortId: string, catName: string): string
//   ⇒ `session/${shortId}-${catSlug(catName)}`
export function catWorktreePath(mainRoot: string, shortId: string, catName: string): string
//   ⇒ `${mainRoot}/../catStudy-sessions/${shortId}-${catSlug(catName)}`
export function ensureCatWorktree(
  sessionId: string,
  agentId: string,
  catName: string
): string | null
//   分叉点仍是 `session/<shortId>`（**不是 dev**）；建不出 → null（T-1 已收窄的降级路径，不得回退）
```

**与 Phase T §2.1 的差异（**实施者必须知道，莫当越界**）**：Phase T 契约写的是 `catShortId(agentId) = agentId.slice(0,8)`。本次改名的授权来自**两条既有留痕**：① `tickets-cat-naming.md` 立票（用户指令「带中文猫名，方便观察」）；② Phase T 票面自陈「`cat8` …… **唯一可无痛替换子决策**」。⇒ 属**被授权的契约替换**，不是擅改。`sessionShortId` 的字符过滤正则**绝不可**复用到猫名上（命名票红线 1：复用 ⇒ 中文整串剥成空串 ⇒ `session/<sid8>-` 静默）。

### 2.2 所有权标记（防同名不同 agent 静默共用）

同一 sid8 下两个 agent 若猫名相同 ⇒ `catBranch`/`catWorktreePath` 产出**同一个路径** ⇒ 两只猫在**同一棵树**里干活 —— 正是本票要消灭的形态，且**静默**。

**机制（本票钉死）**：`ensureCatWorktree` 建/复用时写读 **`branch.<完整分支名>.catAgentId`**（`git config`，落在 `.git/config`，**不在工作区内** ⇒ 不参与 `git add -A`、不进任何提交）。

- 建：`git config branch.<branch>.catAgentId <agentId>`。
- 复用：读回比对；**缺失或不等 ⇒ 显式抛错**（不静默复用别人的树）。
- 判据非恒真：反向对照须证「同名不同 id ⇒ 真报错且不产树」。

### 2.3 收口链（`session-closeout.ts`）

`closeoutSession`（`:244`）现有顺序：preflight（onDev 守卫 `:268`）→ `mergeSession`（`:278`）→ `removeWorktree`（`:281`）→ `writeGate`（`:284`）→ `checkoutDev`（`:287`）。

**插入两个 step**：

| 位置        | step                                 | 语义                                                                                                                                                 |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:278` 之前 | `fanInCatBranches(shortId, cwd)`     | `cwd` = **会话 worktree 路径**（`sessionWorktreePath(mainRoot, shortId)`；不存在则先 `ensureSessionWorktree`）。工作区内必须有 `session/<sid8>` 检出 |
| `:281` 之后 | `reclaimCatBranches(shortId, 'dev')` | 回收**已合进 dev** 的猫 worktree + 分支                                                                                                              |

**两条中止判据（缺一即静默丢活）**：

1. `hasMergeInProgress(cwd)` 为真 ⇒ **立即中止收口**（`ok:false, step:'fanin'`），**绝不继续 writeGate / checkoutDev**（半合并态上收口会把仓库留在不可重跑态）。
2. `FanInResult.conflict` 为真 ⇒ **中止并报店长裁决**（冲突仲裁归店长，ADR §5）。`recovered` 只代表回到可重跑态，不代表冲突已解决。
3. `reclaimCatBranches` 的 `integrationRef` 用 **`dev`**（不是 `session/<sid8>`）——回收前提是「这批活**已经落进 dev**」，用集成分支会在 ff 失败时误删。

---

## 三、逐点接线（行号已 `git grep -n` 复核，提交前请自行复核一次）

### 3.1 `reply.ts:976` —— CLI cwd 按角色分派

```ts
// 现：cwd: ensureSessionWorktree(sessionId) ?? undefined
// 新：role === 'store' → ensureSessionWorktree(sessionId)
//     其余           → ensureCatWorktree(sessionId, agent.id, agent.name)
```

`agent: AgentConfig` 在作用域内（`id` / `name` 均非可选，`packages/shared/src/types.ts:20-22`；`role?` 在 `:40`，缺失 ⇒ 按「非 store」处理 = 给猫 worktree，隔离优先）。

**降级**：任一返回 `null` ⇒ 不传 `cwd`（适配器落 `workspace/`），**不落主仓库**（T-1 已收窄，不得回退）。

### 3.2 `session-closeout.ts` —— 见 §二-3

### 3.3 `serial.ts:1148` 收尾块 —— **本票最重的一处**

现状：一个 `if (depth === 0)` 块，`worktreeCwd = ensureSessionWorktree(sessionId)`（`:1167`）提交、`cleanCwd = ensureSessionWorktree(sessionId)`（`:1238`）清理——**都是会话级、一棵树**。

**目标形态**：提交与清理都按**「本调度树内实际执行过的猫」逐棵**做。

- 店长（store）→ 会话 worktree，语义与现状一致。
- 其余 → 各自的猫 worktree（`ensureCatWorktree`）。
- 每棵树的提交仍是 `gitCommit(\`catstudy [${triggerMsg.id}]\`, { cwd })`（**uuid 口径不变**）；某棵树无改动 ⇒ `gitCommit` 返回 null ⇒ 该树跳过（既有语义）。
- 清理（`git checkout -- .` + `git clean -fd`）**逐树同样范围**，`env: cleanGitEnv()` 三条全带（T-1 Phase 2 已交付的对称，不得回退）。

**「哪些猫执行过」的取数点是本票的已知未知量**：现有 `serial.ts` 作用域内只有**本条消息的** `agents` 批次数组，而注释自陈该提交「收的是**整轮**改动」（含 A2A 子链与队列 drain）。**实施者第一步先 `git grep` 找出可靠的「本调度树执行过的 agent 集合」取数点**（如 dispatch 上下文里已有的累计结构）：

- 找到 ⇒ 用它，并在报告中写清取数点与依据。
- **找不到 ⇒ 停下来报店长**，不要自造新状态（新增跨执行累计结构会牵动 `__test_reset*` 复位钩子与并发批语义，属架构改动）。

**若最终必须改成「每次执行各自提交」**，那也是**店长裁决项**，不得由实施者自行选择——它会把 `git.auto_commit` 从「唯一跨执行 span」改成逐执行 span，并牵动 T-M 的 `updateExecutionLogCommitHash` 归属判定（`serial.ts:1195-1211`）与验收 26。

---

## 四、验收（逐条可执行，须逐条留痕）

- **V1 CLI cwd 分派**：store 的执行 cwd = 会话 worktree；实施猫的执行 cwd = 其猫 worktree（两格都要读数，不能只测一格）。
- **V2 auto-commit 归属（**最重**）**：一猫改动后，该改动**出现在该猫的分支上**（`git cat-file` 读实际文件，**不是看 exit 0**）；另一只猫的树**不受影响**。
- **V3 反向对照（防恒真）**：把提交目标改回 `ensureSessionWorktree` ⇒ V2 必须**变红**（证明它测得出「猫分支为空」）。**先让它红一次，再让它绿。**
- **V4 fan-in 内容在场**：收口后 `dev` 上能读到猫改的文件（E5 教训：`exit 0` ≠ 东西进去了）。
- **V5 中断态守卫**：预置 `MERGE_HEAD` ⇒ 收口**中止**、`writeGate` 未执行、`checkoutDev` 未执行（三格分别断言）。
- **V6 未合不回收**：未合进 dev 的猫分支**必须留存**。
- **V7 命名**：`catBranch` 产出含中文猫名原样（无转义/无 `%`/无八进制）；反向对照：猫名含 `/` 或清洗后为空 ⇒ **显式抛错且不产任何分支/目录**。
- **V8 同名不同 agent**：⇒ 显式抛错，不共享 worktree。
- **V9 回归面**：`role` 缺失的 agent 走猫 worktree（隔离优先），且不抛错。
- **V10 存量兼容**：既有 `session/<sid8>` 分支与 24 个存量会话 worktree **不被误伤**；`session/<sid8>-*` 通配能同时命中新旧形态。
- **V11 闸绿**：`pnpm lint` + `pnpm test` 全绿；收口前全量在**合并结果干净快照**上复跑（店长执行）。
- **V12 覆盖边界自陈**：报告写明每条断言**覆盖什么、不覆盖什么**；凡用 mock 协作方断言「没调用」的格子，须注明它**证不了**「另一个真实的树没被动过」。

---

## 五、红线（硬，违一条即停并报店长）

1. **走 worktree 模式**：在 worktree 内干活，`git -C <worktree>`；**不 push、不自行合并**。
2. **提交限定路径**：`git add <具体路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`；**勿 `git add -A`**（本仓已有三次扫走他猫文件的实证）。
3. **提交信息** `catstudy [uuid]`，uuid 取 `messages` 表内**真实存在**的触发消息 id（不得编造）。
4. **不改 `sessionShortId` 的正则**，不复用它做猫名清洗（命名票红线 1）。
5. **不走 `--no-verify`**。卡住或票面自相矛盾 ⇒ **报店长裁，不自行改设计**。
6. 行号提交前用 `git grep -n`（**字节路径**）复核——PowerShell 文本管道在 UTF-8 无 BOM 源码上会给反向错位假读数。

---

## 六、Out of Scope 与挂账

| 项                                                                 | 状态                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **双跑缺陷**（`serial.ts` catch 判死不 kill 进程 → 同 agent 双跑） | **用户 2026-09-16 裁：挂起**（「不常发生」）。本票不碰，不立单；将来真修须先复现两例实证 |
| `git-utils.ts:181-184` catch 不回滚索引（D4 残留）                 | 挂 Phase I-b 或独立小单（F1 的残留通道，隔离后仍会在**单猫范围内**复发）                 |
| `serial.ts:770` 审查兜底 cwd                                       | 随 D3（Phase I-b）                                                                       |
| D3 审查猫一次性 detached worktree                                  | **Phase I-b**，独立票                                                                    |
| ADR 0015 转正（`adr-0015-draft.md` → `docs/adr/0015-*.md`）        | **T-2 收口动作**，Phase I 落地并验证后由店长执行                                         |

---

## 七、为什么开工时机是「票 `docs-single-writer` 收口后」

本票与前序票的串行**不是排期保守，是机制**：

- 会话内**多猫共用一个 worktree**（`git-utils.ts:488` `ensureSessionWorktree` 按 `sessionId` 取路径）——这个前提**正是本票要拆掉的东西**。
- 票1（`precommit-scope`）只解了**测试闸**的跨猫互锁；**没解 auto-commit 的 `git add -A` 扫走他猫 WIP**（本仓已有实证：未提交代码被收进他链、uuid 错挂）。
- ⇒ 拆掉它之前，一轮只派一只实施猫。**Phase I 自己必须先串行一次**——这是本票无法自我豁免的地方。

**前锋笔为什么仍值得单独一笔**：命名是 inert 的（零调用点），它可以把「命名相关的期望值更新 + 反向对照」的风险**隔离在一次提交里**，接线那笔失败时直接回滚这一笔即可。

---

## 决策留痕

### 为什么「命名必须并入接线」而不是先单独落地

命名单独落地**技术上可行且零风险**（inert），但代价是**两次重启**（命名票 §四-4 要求重启才生效、接线也要求重启）与两轮审查。而两者的**触点完全相同**（`catBranch`/`catWorktreePath`/`ensureCatWorktree` 三个函数）。⇒ 并票、分笔，一次重启。

### 为什么店长不建猫 worktree

ADR D2 的原文理由（保住按会话算的既有机制）之外，本轮补一条结构理由：`fanInCatBranches(shortId, cwd)` 的 `cwd` 必须是**唯一** checkout 了 `session/<sid8>` 的地方。让店长继续持有它，收口执行者与集成分支持有者就是同一个进程，**没有第二个需要同步的位置**。若店长也搬进猫 worktree，则「谁持有集成分支」变成一个需要额外机制保证的时序问题（fan-in 时该 worktree 可能已被回收 / 正被别的进程占用）。

---

## 补笔：第 3 笔 —— OQ1 裁 A（集成分支补建）

> **立 2026-09-16**，审查 ✅（`9cd5b28` + `ed6a3b0`）之后，店长对 OQ1 的裁决。
> 审查结论：OQ1 结构性风险属实、倾向 A。店长独立复核后**采纳 A**，并**升级为「必须本票内修」**（理由见下，不是「倾向」而是「回归」）。

### 为什么必须现在修，而不是挂后续单

1. **这是本票引入的回归。** 接线前 `reply.ts:976` **每个** agent 都调 `ensureSessionWorktree`
   ⇒ 集成分支总被顺带建出；接线后只有 `role === 'store'` 调它。同一场景在接线前**不成立**。
2. **失败是静默的，且比「共享目录」更重。** 降级 cwd = `getWorkspaceDir()` =
   `path.join(process.cwd(), 'workspace')`（`llm/cli-utils.ts:29`），而 `.gitignore:38` 正是 `workspace/`
   ⇒ 猫的改动**连 git 都看不见**（不是「未提交」，是「不可见」）。`git status` 干净、`git cat-file` 读不到、
   收口时 `listCatBranches` 返回 0 ⇒ 全场无人察觉。
3. **重启经济（决定性的那条）。** 本票落地本就需要**一次重启**；把 OQ1 推到后续单 ⇒ 修完还要**第二次重启**。
   本票立票时正是以「一次重启代替两次」为理由把命名并进来的 —— 同一条理由在这里同样成立，
   且这次多一个「中间窗口内该缺口是活的」。

### 动什么（一处，一行）

`packages/server/src/llm/git-utils.ts` · `ensureCatWorktree`：在调 `ensureWorktreeAt({ … startPoint: sessionBranch(shortId) })`
**之前**，先确保分叉点存在：

```ts
// 分叉点 = 集成分支。本会话若从未有 store 执行过，它无人创建 ⇒ 猫树全建不出
// ⇒ 全体降级到共享 workspace/（gitignored ⇒ 改动连 git 都看不见）⇒ 静默丢活。
if (!ensureSessionWorktree(sessionId)) return null
```

**为什么用 `ensureSessionWorktree` 而不是「只建分支」**：单源。`ensureWorktreeAt` 的建分支段是它与会话路径
**共享的那一份**（该函数头注自陈「两处调用同一份代码：复制必然漂移——本仓既有教训：建与清的路径清单必须对称」）。
自写一段 `git branch` 会造出**第二个**集成分支创建点。

**为什么这不违反 ADR D2**：D2 管的是**持有者**（cwd 持有者仍是 store，本笔不改派发逻辑）；本笔只让集成分支
**提前存在**。收口时本就需要这棵会话 worktree（`fanInCats` 的 cwd），提前建出是零额外成本，不是新增机制。
`ensureAgentWorktree` 对 store 仍走 `ensureSessionWorktree` 分支 ⇒ **store 路径不重复建**（幂等复用）。

### 验收（编号续 §四）

- **V13 无 store 会话（新格）**：集成分支**不存在**的会话里触发一次**非 store** 猫的执行 ⇒
  ① 拿到**猫 worktree**（不是 `workspace/`）；② 集成分支被补建，fork 点 = 主仓库 HEAD；
  ③ 该猫的改动 `git cat-file` **读得到**（在猫分支上）。三格分别断言。
- **V14 反向对照（防恒真）**：把补建那行去掉 ⇒ **V13 必须变红**（`git cat-file` 读不到 = 改动不可见）。
  **先让它红一次，再让它绿。** 读数写进报告。
- **V15 V10 那格期望反转**：`serial.cat-worktree.test.ts:456`（`V10 降级 · 集成分支不存在 ⇒ 猫树建不出、不提交、不落主仓库`）
  断言的是**旧行为** ⇒ 本笔改为「猫树**建得出**、集成分支被补建、主仓库零改动」，
  **用例名同步改**（名字里留着「建不出」就是本仓点过名的「记录≠真相」）。
  V10 的**其余**格（存量 `session/<sid8>` 与 24 个存量 worktree 不误伤、`session/<sid8>-*` 通配命中新旧两形态）
  **逐字不动**。另：该文件 `:170` / `:184` 两处「让『集成分支不存在』前提失效」的注释与清理逻辑，
  改后**前提仍成立**（补建发生在被测函数内部）—— 若实测不成立，停下来报我，别自行改清理逻辑。
- **V11 复跑**：`pnpm lint` + `pnpm test`（全量）绿。

### 红线（§五 逐条不变，另加一条）

- **本笔只补分叉点**，不新增任何其它行为改动；不动 `ensureSessionWorktree` 自身语义；
  不改 `resolveCommitTargets` 的取数点；不碰 `session-closeout.ts`。

### 另两条审查随带项，店长已裁（**不属本笔，实施者不要动**）

- **OQ2（`/` 的实现）**：**追认实现** —— 按 V7 抛错是对的（静默剔除会把 `a/b` 与 `ab` 归一到同一棵树）。
  落法同票2 §2.2 先例：**改票面字、不改实现**（店长在收口时改 §2.1 的清洗列表措辞）。实施者**不碰**。
- **OQ5（提交期抛错分支无行测试）**：**挂 Phase I-b**，不在本笔补。

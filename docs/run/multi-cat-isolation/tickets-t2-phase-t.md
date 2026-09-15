# 票：T-2 一猫一 worktree 隔离 —— Phase T 仓内原语与测试

> 归属：多猫并行隔离（T-2）。设计依据 = `adr-0015-draft.md`（**accepted**，2026-09-15）。
> **立票 2026-09-15**（用户指令：「Phase T 开」）。
> **上游**：Phase S（模拟勘验）已收口 —— `sim-report.md` + `sim/run-sim.mjs` 落在本目录，12 格 / 68 断言 / exit 0，审查 ✅（PR #90）。
> **下游**：Phase I（接线，本票**不做**）。

---

## 结论先行

1. **本票交付 git 层原语 + 仓内测试，接线留给 Phase I。** 生产行为**零变化**——本票新增的函数**一个调用点都没有**。
2. **本票不采用 T-1 的 `it.fails` 形态**，理由见「决策留痕」——那会在 greenfield 函数上造出「闸绿但测试从未通过」的假绿门。
3. **判据来自 Phase S 实测，不是推演**：§6.4 四条（枚举 / 幂等 / 守卫 / 回收）全部已由 12 格实跑定形，其中 3 条缺口已固化进 ADR。

---

## 一、范围

### 1.1 交付面

| 文件                                             | 动作 | 内容                                                               |
| ------------------------------------------------ | ---- | ------------------------------------------------------------------ |
| `packages/server/src/llm/worktree-fanin.ts`      | 新建 | fan-in 编排：枚举 / 幂等 / 守卫 / 合并 / 回收（§二 契约）          |
| `packages/server/src/llm/git-utils.ts`           | 扩展 | `catBranch` / `catWorktreePath` / `ensureCatWorktree` + 抽共享骨架 |
| `packages/server/src/llm/worktree-fanin.test.ts` | 新建 | fan-in 面测试（§三 矩阵 C/D 组）                                   |
| `packages/server/src/llm/git-utils.test.ts`      | 扩展 | 命名与建立面测试（§三 矩阵 A 组）                                  |

### 1.2 明确不做（Out of Scope）

- **任何调用点接线**：`session-closeout.ts` / `serial.ts` / `reply.ts` / `registry.ts` **一行不改**。fan-in 何时被谁调用 = **Phase I**。
- **不改 `session/<sid>` 语义**：D2 已裁它保留为会话集成分支 + 店长 worktree，本票不动。
- **不做存量迁移**（D5 已裁）。
- **不改 `git add -A` / pre-commit**（F1/F2 由隔离本身结构性解决，本票不碰）。
- **不评估性能**。

---

## 二、接口契约（**本票钉死，Phase I 不得擅改**）

### 2.1 `git-utils.ts` 新增

```ts
/** 猫分支名。连字符——斜杠不可实现（ADR D1 命名修正，E1 实测）。 */
export function catBranch(shortId: string, agentId: string): string
//   ⇒ `session/${shortId}-${agentId.slice(0, 8)}`

/** 猫 worktree 路径。 */
export function catWorktreePath(mainRoot: string, shortId: string, agentId: string): string
//   ⇒ `${mainRoot}/../catStudy-sessions/${shortId}-${agentId.slice(0, 8)}`

/** 建/复用某只猫的 worktree，从集成分支 `session/<shortId>` 分叉（**不是 dev**）。 */
export function ensureCatWorktree(sessionId: string, agentId: string): string | null
```

**骨架抽取（本票唯一触碰既有代码的动作）**：`ensureSessionWorktree`（`:379`）与 `ensureCatWorktree` 的三步判定骨架（目录+`.git` 复用 / 分支不存在才建 / `add` 无 `-b`）**必须抽成共享私有函数**（如 `ensureWorktreeAt(branch, path)`），**不许复制 55 行**——复制必然漂移。

- **硬约束：抽取必须零行为变化**。判据 = `git-utils.test.ts` + `serial.downgrade.test.ts` 既有用例**全绿且未被修改**（若既有断言需要改动才能过，说明抽错了——停下报店长，**不许改测试适配实现**）。

### 2.2 `worktree-fanin.ts` 新建

```ts
export interface FanInResult {
  merged: string[] // 本次真合进去的猫分支短名（按合入顺序）
  skipped: string[] // 已合过 ⇒ 跳过（幂等）
  conflict: boolean // 撞上冲突
  recovered: boolean // 冲突后是否已 abort 回可重跑态
}

/** 枚举某会话的猫分支。
 *  MUST 用通配符 `refs/heads/session/<shortId>-*`——裸前缀命中 0 条且静默（S3-1，阻断级）。
 *  过滤空 cat8（`*` 可匹配空串，S3-5）。返回**已排序**（确定性，防「顺序不定 ⇒ 合并结果不定」）。 */
export function listCatBranches(shortId: string, opts?: { cwd?: string }): string[]

/** 半合并态探测。判据取 MERGE_HEAD 存在性，**不按冲突码枚举**（S3-2：AA/UU 可并存）。 */
export function hasMergeInProgress(opts?: { cwd?: string }): boolean

/** 幂等判据：ancestor 是否已是 descendant 的祖先。 */
export function isAncestor(ancestor: string, descendant: string, opts?: { cwd?: string }): boolean

/** fan-in 主入口：把该会话全部猫分支按序 no-ff 合进集成分支。
 *  **`cwd` 必填**（不是 optional）——见下方「为什么 cwd 必填」。 */
export function fanInCatBranches(shortId: string, cwd: string): FanInResult

/** 回收**已合入**集成分支的猫 worktree + 猫分支。返回被回收的分支短名。 */
export function reclaimCatBranches(
  shortId: string,
  integrationRef: string,
  opts?: { cwd?: string }
): string[]
```

**为什么 `cwd` 必填（安全设计，不是洁癖）**：fan-in 若落在错误的 cwd，就是把 N 条猫分支 **no-ff 合进 dev 主工作区**——正是 ADR §6.3 判死的方案 (b)，后果是**冲突落主工作区 ⇒ 全仓阻塞**。`cwd` 设成 optional + 默认 `process.cwd()` 会把这个灾难变成「忘记传参」就能触发。⇒ 设为**必填**，让编译器挡住。

**`fanInCatBranches` 的前置断言（缺一即显式失败，不静默）**：

1. `hasMergeInProgress(cwd)` 为真 ⇒ **立即返回 `{conflict:true}`，绝不继续**（ADR §6.4-3：绝不在半合并态上跑 writeGate / checkoutDev）。
2. **cwd 的当前 HEAD 必须是 `session/<shortId>`** —— 否则把猫分支合进 dev 的灾难路径。校验失败 ⇒ 显式报错并中止。
3. 空集（无猫分支）⇒ 返回全空结果、`exit` 正常——**这是合法状态**（无猫提交过），但**必须与「枚举写错收 0 条」可区分**：见 §三 C1 的反向对照要求。

**`reclaimCatBranches` 的两条硬前提**：

1. **只回收已合的**（判据 = `isAncestor(cat, integrationRef)` 为真），**未合分支绝不回收**——否则删掉未合的活。
2. **自指守卫**：不得删除当前进程 cwd 所在的 worktree（既有机制先例 `git-utils.ts:587` `isPathInside(wtPath, process.cwd())`）。

---

## 三、测试矩阵（逐格一条 `it`，不得压成「同上」）

> 每格 = 被测函数 + 真实一次性 git 仓 + 断言真状态。**不许 mock git**——被测的就是 git 的组合行为，mock 掉等于没测。

### 组 A · 命名与建立（`git-utils.test.ts`）

| #   | 格         | 断言                                                                                       |
| --- | ---------- | ------------------------------------------------------------------------------------------ |
| A1  | 命名纯度   | `catBranch` 产出连字符形；**断言不含 `/`**（斜杠形建不出来，E1）                           |
| A2  | 建立与共存 | `ensureCatWorktree` 建成后：猫 worktree 与 `session/<sid8>` 分支及其 worktree **同时存活** |
| A3  | 分叉点     | 猫分支的 merge-base = 建时的 `session/<sid8>` tip（**不是 dev**）                          |
| A4  | 重复建幂等 | 第二次调用复用同一路径，**不重建、不报错**                                                 |
| A5  | 失败形态   | 建不出时返回 `null`（**不落主仓库**——T-1 已收窄的降级路径，本票不得回退）                  |

### 组 B · 枚举（`worktree-fanin.test.ts`）

| #   | 格             | 断言                                                  |
| --- | -------------- | ----------------------------------------------------- |
| B1  | 通配前缀命中   | 3 条猫分支全部枚举到（**必须带 `*`**，S3-1）          |
| B2  | 空集           | 无猫提交过 ⇒ 返回 `[]`，**不抛错**                    |
| B3  | 不误收会话分支 | `session/<sid8>` 本身**不在**结果里                   |
| B4  | 不误收旁支     | `session/<sid8>xxx`（前缀像但无连字符）**不在**结果里 |
| B5  | 过滤空 cat8    | `session/<sid8>-`（空后缀）**不在**结果里（S3-5）     |
| B6  | 确定性         | 同一状态下两次调用**结果顺序一致**                    |

### 组 C · fan-in（核心）

| #   | 格           | 断言                                                                                                        |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| C1  | 按序 no-ff   | 两猫分支全部真进集成分支；**逐条验内容在场**（`git cat-file` 读实际文件，不是只看 exit 0）                  |
| C2  | 整链幂等     | 全链**重跑** ⇒ `merged` 为空、`skipped` 含两条、**HEAD 不变**、无新 merge commit（E3 只验单条，此格验整链） |
| C3  | 空合并       | 猫分支 == 分叉点 ⇒ 合它**不造 merge commit**（防每轮收口多一笔垃圾 commit）                                 |
| C4  | 冲突守卫     | 真冲突 ⇒ `conflict:true`；**且**能恢复（`recovered:true` ⇒ 仓库回到可重跑态，`MERGE_HEAD` 消失）            |
| C5  | 半合并态入口 | 预置 `MERGE_HEAD` 后调 `fanInCatBranches` ⇒ **立即失败、不继续合并**                                        |
| C6  | cwd 守卫     | cwd 检出的是 `dev`（或别的分支）⇒ **显式失败**，不把猫分支合进去                                            |

### 组 D · 回收

| #   | 格         | 断言                                                                   |
| --- | ---------- | ---------------------------------------------------------------------- |
| D1  | 回收已合   | 已合猫分支 + 其 worktree 被回收干净；分支 ref 消失                     |
| D2  | 未合不回收 | **未合**猫分支**必须留存**（硬前提，删了就丢活）                       |
| D3  | 孤儿分支   | worktree 已被删、只剩分支 ⇒ 也能枚举到并回收                           |
| D4  | 自指守卫   | cwd 正在被回收的 worktree 内 ⇒ **跳过物理清理**，不把自己的 cwd 树删掉 |

---

## 四、验收判据

- **V1 矩阵齐**：A1–A5 / B1–B6 / C1–C6 / D1–D4 共 **21 格**逐格有实跑读数，无一格压成「同上」或注释。
- **V2 闸绿**：`pnpm lint` + `pnpm test` 全绿；本票**测试用普通 `it`**（不是 `it.fails`）——即**每个判据都真跑通过**。
- **V3 反向对照（防恒真）**：**至少**下列三条须证明判据非恒真（**先让它红一次**）：
  - **B1 枚举**：把实现改成裸前缀（`-` 不带 `*`）⇒ 判据**必须变红**（证明它测得出 S3-1 那种静默空集，而不只是「恰好过了」）。
  - **C1 内容在场**：用一个**已知不在场**的文件名做反对照，证明「在场」判据不是恒真。
  - **D2 未合不回收**：造一条未合分支 ⇒ 判据必须**能测出「被误删」**（先让它红一次）。
- **V4 既有测试零改动**：`git-utils.test.ts` / `serial.downgrade.test.ts` **既有用例的断言一行未改**且全绿（骨架抽取零行为变化的判据）。
- **V5 零接线**：`session-closeout.ts` / `serial.ts` / `reply.ts` / `registry.ts` **一行未动**（`git diff --stat` 自证）。
- **V6 覆盖边界自陈**：报告须写明每格**覆盖什么、不覆盖什么**，并显式声明「本票证不了 Phase I 的接线顺序」。
- **V7 缺口回报**：实现中发现 §二 契约与实际不符 ⇒ **停下报店长**，不自行改契约（改契约 = 改 ADR 面）。

---

## 五、红线（硬，违一条即停并报店长）

1. **测试出 git 必须先剥注入变量**：复用 `git-utils.ts:51` `cleanGitEnv()` 与既有测试的 `beforeAll` 剥法（`serial.downgrade.test.ts:130-134`）。**本仓有前科：`GIT_DIR` 注入把主仓 `core.bare` 写成 `true`（已复发 2 次）。**
2. **临时仓建系统 temp**，**不得建在仓库根或 `catStudy-sessions/` 下**（`handoff-test-*` 被 auto-commit 扫走，复发 2 次）。
3. **不 `git add -A`**：限定路径 add → `git diff --cached --name-only` 核对 → 裸 `git commit`；**不用 `git commit --only`**（`.husky/pre-commit` 会 `unset GIT_INDEX_FILE`）。
4. **不 push**。
5. **不碰任何调用点**（§四 V5）。本票若发现自己需要改调用点才能测 ⇒ **说明契约设计有问题，报店长**。
6. **删 symlink 绝不 recursive 跟随**（本仓实测：跟穿会删掉主仓库 `node_modules`）。
7. **开工前先确认无并发实例**：`git status` + 查 `execution_logs` 同 agent 时间窗。**本会话刚实证过 `execute crash` 判死后原进程仍在写**（同一 agent 两条 CLI 同跑一张票单），并发写会造双提交 + 内容互覆。

---

## 六、产物与提交

| 文件                                             | 说明                                         |
| ------------------------------------------------ | -------------------------------------------- |
| 上述 2 个源文件 + 1 个新测试 + 1 个扩展测试      | 同批提交                                     |
| `docs/run/multi-cat-isolation/phase-t-report.md` | 21 格读数表 + 反向对照 + 覆盖边界自陈 + 缺口 |

- 提交：`git add <具体路径>` → 核对暂存区 → 裸 `git commit`；uuid 取 `messages` 表内**真实存在**的触发消息 id。
- 行号用 `git grep -n`（**字节路径**）复核，**不吃转述**。

---

## 决策留痕

### 为什么本票不采用 T-1 的 `it.fails` 形态（**最重要的一条**）

T-1 的 Phase 1 用 `it.fails` 编码目标行为（`serial.downgrade.test.ts:20` 有记录），本票**不沿用**。差异是结构性的：

|                     | T-1                                               | T-2（本票）                                                                                 |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 被测函数            | **已存在**（`serial.ts` 的调用点，改的是行为）    | **全仓零命中**（新原语，`for-each-ref` 已搜）                                               |
| `it.fails` 为何成立 | 断言对象是「既有实现的错误行为」 ⇒ 实现修对即翻正 | import 一个 stub ⇒ **测试因「函数抛 not implemented」而红**，与断言内容无关                 |
| 假绿风险            | 低                                                | **高**：stub 期间任何断言（哪怕是写错的）都「如期失败」⇒ 闸全绿，但**判据从未被证明可通过** |

**本仓栽过的正是这类门**：判据看起来在测，实际恒真/恒假。`it.fails` 在 greenfield 函数上会造出「**闸绿，但测试从未通过**」——这正是「恒真绿门」的镜像。

⇒ 本票的形态是：**原语实现与测试同批落地，测试用普通 `it`（真跑通过），但零接线（生产行为一行不变）**。「测试先行」要保的**目的**——「别让未验证的实现上生产」——由「无调用点」更强地达成：**代码在仓里、测试在跑，而运行时不碰它**。

### 为什么 Phase I 缩小为「接线」

原票面（`tickets-t2.md:5`）的分段是「Phase T = 仓内测试先行 / Phase I = 生产改动」。本票把**原语实现**拉进 Phase T，Phase I 只剩**接线 + 集成测试**。理由：契约（§二）本身就是设计产出，原语是契约的可执行形式；把「原语实现」与「测试」拆到两个 Phase，中间那一轮**没有任何可验证的产物**（测试红了、实现没来），而拆开的价值仅在于字面工整。

### 为什么 `cwd` 必填而不是 optional

见 §2.2。仓内既有惯例是 `opts?: { cwd?: string }`（`gitCommit` 等），本处**刻意破例**：默认值（`process.cwd()`）指向的正是**最危险的那个落点**。让编译器挡住「忘记传参 ⇒ 合进 dev」这条路径。

### 与其他票的关系

- **Phase S**（`sim-report.md`）已给出全部判据的行为依据，本票**不重跑模拟**，直接把 12 格的行为搬进仓内测试。
- **双跑缺陷**（`execute crash` 判死不杀进程）与本票**无关**——它在调度层（`execution/` + dispatch），本票在 git 层。**T-2 不解决它**，须独立单。

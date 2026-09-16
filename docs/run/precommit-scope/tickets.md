# 票：pre-commit 测试门禁三档收窄（提交口按改动面 + 缓存按 worktree 隔离）

> 归属：多猫协作工程治理。立票 2026-09-16（用户指令「开工1+2」，消息 `0281108f`）。
> 依赖：无。**与 `docs/run/docs-single-writer/` 串行**——T-2 Phase I 未接线前，会话内多猫共用一个
> worktree（`git-utils.ts` `ensureSessionWorktree` 按 `sessionId` 取路径），pre-commit 又是全仓闸，
> 并行的结局是互相拖死（R3 实证：某猫连试 8 次全废）。T-2 落地（Phase I）后此约束自动解除。

---

## 结论先行

1. 本票只做两件事：**提交口按改动面选 project** + **缓存按 worktree 物理隔离**。全量测试挪到
   「请求审查前」那一档是**纪律**（随票2 写进 `CONTEXT.md`），本票不写这部分代码。
2. **缓存隔离是本票的硬前提**——不修这条，收窄是空转：两猫各自的测试仍写同一批**物理**文件
   （worktree 的 `node_modules` 是 junction 指向主仓库）。
3. `pnpm test` 的**全量语义不动**——审查者与收口方的入口仍是全量。
4. 生产行为零变化：只碰 `.husky/pre-commit`、`vitest.config.ts`、`scripts/`（新增 1 脚本 + 1 测试）。

---

## 一、范围

### 1.1 交付面

| 文件                              | 动作 | 内容                                                    |
| --------------------------------- | ---- | ------------------------------------------------------- |
| `scripts/precommit-scope.mjs`     | 新建 | 纯函数 `resolveScopes(paths)` + CLI 薄壳（§2.2）        |
| `scripts/precommit-scope.test.js` | 新建 | §三 矩阵逐格                                            |
| `.husky/pre-commit`               | 修改 | 第三行 `pnpm test` → `node scripts/precommit-scope.mjs` |
| `vitest.config.ts`                | 修改 | `RESTART_FILES_DIR` 与 `cacheDir` 绝对化 + cwd 派生     |

### 1.2 明确不做（Out of Scope）

- **不改 `pnpm test`**（`package.json` 的 test 脚本仍是 `vitest run` 全量）。
- **不加 pre-push 全量**——那里是审查门禁，且 worktree 内 push 本就预期失败（分支带未审 commit，被 pre-push ② 判据拦；不是缺 `.push-gate`——该文件落在共享根，全 worktree 共用一份）。
- **不引入 `vitest related`**——依赖静态 import 图，见「决策留痕」。
- **不改 lint 面**（`npx lint-staged` / `pnpm lint` 两行原样保留，含行序）。
- **不新装依赖**。
- **不写「请求审查前跑全量」的自动化**——那一档是纪律，靠 `request-review` 前置门槛承载。

---

## 二、契约（**本票钉死，实施中不得擅改**）

### 2.1 映射表（`resolveScopes` 的判据，逐行可测）

| 暂存区命中                                                                                                                       | projects          | 理由                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `packages/server/**`                                                                                                             | `packages/server` | 本包                                                 |
| `packages/web/**`                                                                                                                | `packages/web`    | 本包                                                 |
| `scripts/**`                                                                                                                     | `scripts`         | 本包                                                 |
| `packages/shared/**`                                                                                                             | **全量（4）**     | 契约层，三包都依赖                                   |
| `docs/adr/**` `docs/lessons/**` `docs/plans/**`                                                                                  | `packages/server` | 记忆扫描白名单面（`scripts/flywheel/scan.mjs` 消费） |
| `docs/run/**` `docs/sessions/**` 及**其余 `*.md`**                                                                               | **跳过测试**      | 在飞文档 / 纯文本，无测试消费者                      |
| `vitest.config.ts` `scripts/vitest.config.ts` `package.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` `.husky/**` `tsconfig*.json` | **全量（4）**     | 测试基础设施本身                                     |
| **任何无法归类的路径**                                                                                                           | **全量（4）**     | **fail-closed**                                      |

- 多行命中 ⇒ **取并集**；「全量」优先于并集。
- 路径一律先归一化为**仓根相对、正斜杠**形式再匹配。

### 2.2 接口

```js
/**
 * @param {string[]} stagedPaths 仓根相对路径（正斜杠）
 * @returns {{ projects: string[], skip: boolean, reason: string }}
 * 契约：skip===true ⇒ projects 为空；skip===false ⇒ projects 非空。
 * projects 恒为 ['packages/shared','packages/server','packages/web','scripts']
 * 的**子序列**（顺序确定，防「顺序不定 ⇒ 读数不可比」）。
 */
export function resolveScopes(stagedPaths)
```

CLI：读 `git diff --cached --name-only` → `resolveScopes` → 打印裁决行（含 `reason`，供排障）→
`skip` 则 exit 0，否则 `npx vitest run --project <p1> --project <p2> …`。

**异常一律 fail-closed**：git 读失败、解析异常、空列表 ⇒ 跑全量（不跳过）。

---

## 三、验收（逐条可执行，实施者须留痕）

- **V1 纯文档**：暂存区仅 `docs/run/**` ⇒ `skip:true`；实跑一次真实提交，**不触发 vitest**（留读数）。
- **V2 单包**：仅 `packages/server/**` ⇒ 只跑 server（读数：vitest 启动行只出现一个 project）。
- **V3 契约层**：仅 `packages/shared/**` ⇒ 全量 4。
- **V4 基础设施**：仅 `vitest.config.ts` ⇒ 全量 4；另测 `.husky/pre-commit` 一处 ⇒ 同样全量 4。
- **V5 并集**：`packages/server/**` + `packages/web/**` ⇒ 两个 project，**顺序确定**。
- **V6 记忆面**：仅 `docs/adr/**` ⇒ `packages/server`。
- **V7 fail-closed（含反向对照）**：无法归类的路径（如 `foo.unknown`）⇒ 全量 4。
  **反向对照**：把 fallback 从「全量」改成「跳过」⇒ V7 **必须变红**（证明该判据非恒真）。
- **V8 缓存隔离实测**：在主仓库与某 worktree **两处**分别加载 `vitest.config.ts`，
  `RESTART_FILES_DIR` 与 `cacheDir` 解析出的**绝对路径不同**（留两处读数）。
- **V9 单元测试**：`scripts/precommit-scope.test.js` 覆盖 §2.1 **每一行** + 并集 + 空列表 + fail-closed 分支。
- **V10 全量未被改窄**：`pnpm test` 直接跑仍是 4 个 project（留读数）；`pnpm lint` + `pnpm test` 全绿。
- **V11 钩子仍剥 env**：`.husky/pre-commit` 的 `unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX`
  **原样保留**（`scripts/pre-commit-env.test.js` 直接重放该行，删了就红）。

---

## 四、红线（硬，违一条即停并报店长）

1. **不 `--no-verify`、不绕过门禁**——本票改的正是门禁本身，绕一次它的读数就没人信。
2. **不 `git add -A`**；限定路径 add → `git diff --cached --name-only` 核对 → 裸 `git commit`；
   **不用 `git commit --only`**（`pre-commit` 会 `unset GIT_INDEX_FILE`）。
3. **临时产物落 `os.tmpdir()`**，不落仓库根、不落 `catStudy-sessions/`。
4. **测试出 git 必须先剥注入变量**（`GIT_DIR` 写坏主仓 `core.bare` 的前科，已复发 2 次）。
5. **不 push**。
6. **缓存路径不得落在仓库内**——本票目的就是让它离开 `node_modules`（junction 共享面）。
7. **改契约先报店长**：实施中发现 §2.1 表有漏行 ⇒ 停下报，**不自行扩表**。

---

## 五、产物与提交

| 文件                                 | 说明                                              |
| ------------------------------------ | ------------------------------------------------- |
| 上述 2 新 + 2 改                     | 同批提交                                          |
| `docs/run/precommit-scope/report.md` | §三 逐条读数 + 反向对照 + 覆盖边界自陈 + 缺口回报 |

---

## 决策留痕

### 为什么按包而不是 `vitest related`

`related` 走静态 import 图：改了 `db/schema.ts` 这类**被运行时字符串引用**的面，图上看不见 ⇒ 漏。
按包是**粗但零假阴性**的下界。宁可多跑一个包，不可漏一个消费者。

### 为什么 `docs/run/**` 可跳过而 `docs/adr/**` 不行

记忆飞轮的 MD 白名单是 `docs/adr/` `docs/lessons/` `docs/plans/`（`scripts/flywheel/scan.mjs`），
`docs/run/**` **不在其内** ⇒ 无测试消费者。此条是**实测得出**（`git grep -ln "docs/adr\|docs/plans\|docs/lessons"` 命中面见报告），
不是推测；实施者若实测发现 `docs/run/**` 存在消费者 ⇒ **报店长改表**。

### 为什么失败要 fail-closed

门禁脚本自身出错时若回退成「跳过测试」，等于开了一条**静默放行**路径——比全量慢几分钟坏得多。
本仓对「静默翻译」有明确前科（`?? process.cwd()` 把「worktree 不可用」翻译成「在主仓库干」，见
`docs/run/multi-cat-isolation/tickets.md` 决策留痕）。

### 为什么「请求审查前跑全量」不在本票

那一档的**位置**有讲究（须在合并前、对「将会得到的那个结果」跑，而非合并后），且它是流程门槛
不是脚本——写作对象是 `request-review` 前置门槛与 `CONTEXT.md`。本票只交付**可执行的那一半**，
避免把纪律和代码混在一张票里各自半吊子。

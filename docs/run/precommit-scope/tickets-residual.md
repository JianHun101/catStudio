# 票 precommit-scope 残余收口：单A（LOG_FILE 相对路径）+ 单B（V14 护栏进提交口）

- 立票：2026-09-16 · 店长
- 前置：票 `precommit-scope` 已收口（PR #93，`dev = 2b349ef` 起的链）；`docs-single-writer` 已收口（PR #94）
- 两笔 = 两个独立小活，可**同一分支、两笔提交**（互不依赖，但同在测试基础设施面）

---

## 一、结论先行

两条都是**已知挂账**，不是新发现：

- **单A**：`LOG_FILE` 两处相对路径 × worktree 的 `node_modules` junction ⇒ 两猫的测试日志落到**主仓库同一物理文件**。
  实测本仓 `logger.test.ts` 断言的是 `resolveLogFile()` 的**纯函数返回值**（不读文件内容）⇒ 当前**不产假红**，
  是观感问题。**做它是因为它和票1 已修的 9 处同型** —— 同类残留留着，下一个人分不清哪些是「故意的」。
- **单B**：V14 护栏（`scripts/test-isolation-guard.test.js`）静态扫隔离路径写法，属 `scripts` project ⇒
  **改 `packages/**` 的提交口不跑它** ⇒ 护栏只在改 `scripts/**` 时才生效，**在它最该拦的位置上不在岗**。
  店长裁 **B**：改 `packages/**` 时追加 `scripts` project（实测代价 ~4.4s/次提交）。

---

## 二、契约（不得擅改）

### 单A

1. **两处相对路径改绝对**：`packages/server/vitest.config.ts:57`、`scripts/vitest.config.ts:11`
   —— `LOG_FILE` 由 `'node_modules/.cache/test-logs/cat-study-test.log'` 改为 **`os.tmpdir()` 派生的绝对路径**
   （末段保留 `test-logs/cat-study-test.log`，与票1 已落地的 `RESTART_FILES_DIR` / `cacheDir` 同款派生法、同一哈希键）。
2. **不得删该行**：`test:server`（cwd = `packages/server`，不加载根配置）依赖它；删了会回落
   `packages/server/` 内 —— 那正是要避免的形态（票1 已实测过的 17:38 事故类型）。**只改值**。
3. **`logger.test.ts:239/242` 是白名单项，逐字不动**：它**故意**用相对路径断言纯函数语义、不写文件。
   若你的实现让这两个用例变红 ⇒ **停下来报店长**，不要改断言。

### 单B

4. **落点唯一**：`scripts/precommit-scope.mjs` · `resolveScopes()` —— 在 `:146`
   （`const projects = ALL_PROJECTS.filter((s) => scopes.has(s))`）之后追加：

   命中任一 `packages/**` scope（即 `projects.some(s => s.startsWith('packages/'))`）⇒ **追加 `scripts`**。

5. **顺序契约不破**：`projects` 恒为 `ALL_PROJECTS` 的**子序列**（`['packages/shared','packages/server','packages/web','scripts']`）。
   `scripts` 本就在末位 ⇒ **追加到数组末尾**即保序；**不得**改成排序、去重后重排。
6. **`resolveScopes` 的返回形状一字不动**（仍是 `{ projects, skip, reason }`）；`projectNameOf` 一字不动；
   `.husky/pre-commit` 一字不动（本笔只改判定，不改钩子）。
7. **跳过态不受影响**：纯 `docs/run/**` 提交仍 `skip: true`（不得因本笔变成「跑 scripts」）。

---

## 三、交付面

| 文件                                          | 动作                                         |
| --------------------------------------------- | -------------------------------------------- |
| `packages/server/vitest.config.ts`            | `:57` LOG_FILE 改绝对值                      |
| `scripts/vitest.config.ts`                    | `:11` 同款改法                               |
| `scripts/precommit-scope.mjs`                 | `resolveScopes()` 追加 scripts 逻辑（§二-4） |
| `scripts/precommit-scope.test.js`             | 新增 V21–V22 格                              |
| `docs/run/precommit-scope/report-residual.md` | 新建：读数 + 反向对照                        |

---

## 四、验收

- **V21（单B 矩阵）**：① 暂存 `packages/server/x.ts` ⇒ `projects` 含 `@cat-study/server` **且含** `scripts`；
  ② 暂存 `packages/shared/x.ts` ⇒ 全量 4 个（本就含 scripts）；③ 暂存 `docs/run/x.md` ⇒ **`skip: true`**；
  ④ 暂存 `scripts/x.mjs` ⇒ 只 `scripts`（不反向追加 packages）。
- **V22（顺序契约）**：以上每格断言 `projects` 是 `ALL_PROJECTS` 的子序列（**按序比较，不是集合比较**）。
- **V23（单A 双模式）**：standalone（cwd = `packages/server`）与根模式解析出的 `LOG_FILE` **都是绝对路径**，
  **都不在仓库内**；且**两棵不同 worktree 解析值不同**（在**主仓库**与**本会话 worktree** 各跑一次取读数）。
- **V24（单A 白名单不破）**：`logger.test.ts` 全绿、其 `:239/242` 的相对路径断言**逐字节未改**。
- **V25（闸）**：`pnpm lint` + 全量 `pnpm test` 绿。

**反向对照（必做，写进报告）**：

- **单B**：去掉追加那几行 ⇒ **V21-① 必须变红**。**先让它红一次，再让它绿。**
- **单A**：把任一处改回相对路径 ⇒ **V23 的「两 worktree 不同」必须变红**（若 N 轮未复现，如实写「未复现」，**不许把绿当判据成立**）。

---

## 五、红线

- 提交限定路径，**勿 `git add -A`**；**勿 `--no-verify`**；不 push、不自行合并。
- **不装依赖**（本笔零新包）。
- 临时产物落 `os.tmpdir()`；测试出 git 须剥注入变量（`core.bare` 被写坏已复发 2 次）。
- 行号用 `git grep -n` **字节路径**复核，勿走 PS 文本管道。
- 卡住或票面自相矛盾 ⇒ 报店长裁，不自行改设计。

---

## 六、不在范围内

1. **`serial.ts:770` 的 `?? process.cwd()`**（Phase I-b 票面 §六-1 移出）—— **不在本票**。
2. **Phase I-b（审查面可达性）** —— 另一只猫在做，**不同票、不同文件面**，不要碰 `packages/server/src/execution/**`。
3. **`stripComments` 词法残留 f1/f2/f3** —— 店长已裁**不立单**（三条已逐条钉洞）。
4. **`schedule` 类 / 存量 5 处重复落盘** —— 均已裁决，不回溯。

---

## 七、依赖与重启

- 本票两笔均为**测试基础设施 + 文档**，`packages/server/src/` 生产码零改动 ⇒ **不需重启**。
- 与 Phase I-b **并行**：文件面零交集（本票碰 `vitest.config.ts` / `scripts/**`；Phase I-b 碰
  `execution/serial.cat-worktree.test.ts` / `docs/run/multi-cat-isolation/**`）。
  **这同时是 Phase I「一猫一 worktree」的首次真实并行行使** —— 若你俩的树互相串了（看到对方的改动、
  或提交落进对方分支），**立刻停下来报店长**：那是 Phase I 的实测缺陷，比本票内容重要得多。

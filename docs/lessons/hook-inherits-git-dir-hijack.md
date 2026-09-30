---
type: lesson
date: 2026-09-30
status: proposed
evidence:
  - kind: commit
    ref: 6a10408
  - kind: file
    ref: packages/server/src/llm/git-utils.ts
---

# worktree 内提交时 git 向钩子注入绝对 `GIT_DIR`——钩子里 `cwd: tmp` 的子进程被劫持到真实仓库

## 撞出来的场景

一张代码票**在会话 worktree 内**提交时，pre-commit 跑了全量测试。测试里有一类操作：
`cwd` 指到临时目录，在临时目录里 `git init` / `git config` / `git commit`。
它们在主工作区跑了一整年都没事，在 worktree 里跑却把**真实仓库**改了。

长期记忆里 `core.bare` 被写成 `true` **已复发 2 次**，症状是主仓 git 命令报
`must be run in a work tree`——根因就在这条链上。

## 现象

沙箱（按实测注入值复刻真实拓扑）里跑最小脚本
`cwd=tmp → git init . → git config user.* → git commit`：

- `cwd` 确在临时目录，但临时目录下**没有**生成 `.git`；
- `git config user.name gate-test` **落进共享 config**；
- 共享 `.git/config` 前后 diff：`bare = false → true`，`name` / `email` 被覆盖；
- 补跑 commit ⇒ **临时目录的提交落在真实分支上**（分支被 fake 提交篡改）。

## 机制

**worktree 内**提交，git 向钩子注入**绝对路径**的 `GIT_DIR`（指向 `.git/worktrees/<name>`）
与**绝对** `GIT_INDEX_FILE`；**主工作区**提交**不注入 `GIT_DIR`**——只有**相对**
`GIT_INDEX_FILE`，`cwd: tmp` 时解析无害。

优先级：`GIT_DIR` **高于 cwd 探测**——同一实验下 `git rev-parse --git-dir` **无视 cwd** 返回注入值。

注入面实测 8 项（含 `GIT_AUTHOR_*` / `GIT_EDITOR` / `GIT_EXEC_PATH` / `GIT_PREFIX`）；
**其中定位类只有 3 项**：`GIT_DIR`（仅 worktree）、`GIT_INDEX_FILE`、`GIT_PREFIX`。
`GIT_WORK_TREE` 从未被注入（属防御性冗余）。另有 `GIT_CONFIG_PARAMETERS` 是**探针伪影**
（`-c core.hooksPath` 由 git 传给子进程），忠实对照须排除。

## 两条腿的归因（三组对照，唯一变量 = `GIT_DIR`）

| 组               | cwd | 注入                                   | 真实仓库结果                                                       |
| ---------------- | --- | -------------------------------------- | ------------------------------------------------------------------ |
| B                | tmp | 无                                     | **零改动**；`rev-parse --git-dir` 报 `fatal: not a git repository` |
| C（主工作区档）  | tmp | 仅**相对** `GIT_INDEX_FILE`            | **零改动**；tmp 生成自己的 `.git`、提交落 tmp                      |
| A（worktree 档） | tmp | `GIT_DIR` 绝对 + 绝对 `GIT_INDEX_FILE` | **全链污染**                                                       |

三组 cwd **同为临时目录**而结果分化 ⇒「cwd 落在临时目录」**本身不是污染源**，归因唯一 =
**env 劫持**。**两条腿修法不同**：env 劫持 ⇒ 剥 env；cwd 腿 ⇒ 拦 cwd
（`cleanGitEnv()` 只剥 env、**不拦 cwd**）。

## 正解

`.husky/pre-commit` **顶部**（`set -e` 之后、`npx lint-staged` 之前）：
`unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX`。

- **绝不能剥 `GIT_EXEC_PATH`**——它是 git 自身的安装路径，**非定位变量**；剥掉可能干扰 git
  找自己的子命令（真机立即炸，属 fail-loud）。
- `GIT_AUTHOR_*` / `GIT_EDITOR` **不算定位类，一律不纳入**：危害仅限「临时仓库的提交身份」
  （注入 `GIT_AUTHOR_NAME` 会压过临时仓库自身的 `user.name`）。
  **登记观察项：将来若出现「测试内提交身份错乱」，根因面在此。**
- **纳入判据按类别判**——只纳入能改变「git 解析到哪个仓库 / 哪个 index」的定位类，
  **不按「多出就纳入」判**。
- 只动 `.husky/pre-commit`；**不动** `post-commit` / `pre-push` / `commit-msg`——
  那些钩子自己 spawn git 且**需要**正确的仓库定位。

## 可复用的动作

1. **在 tmp 里出 git 的测试，先剥定位类变量**；判据是「别让子进程继承外层仓库的定位」。
2. **归因先分腿，再修**：「env 劫持」与「cwd 落在真仓」症状同形、修法不同；用**唯一变量对照**
   把两条腿分开（本例三组 cwd 相同、只有注入不同）。
3. **同一份清理清单会漂移**：`git grep -c "function cleanGitEnv"` 实测基线 `6a10408` **7 份**、
   `a7bc515f` **10 份**（后三份是新增测试文件）——**计数是探针口径的产物，引用必须带时点与口径**。
   同一口径下按 unset 清单项数分三档：**4 项**（8 份内联）、**6 项**（`scripts/flywheel/scan.mjs`）、
   **8 项**（`scripts/commit-uuid-gate.mjs` 的具名常量 `INHERITED_GIT_ENV`——**它不在内联
   `unset` 清单里，只按 `unset` 字面扫会漏掉这一档**）。
   方向安全（多出项均属「未注入」面），但观察项的触发条件要**点名式收窄**：
   ①任一变体**少于**定位类三项；②清单混进已点名的非定位类五项却被当定位类用。
4. **验收必须真机挂钩**：在 worktree 内用真实 `git commit` 触发完整 pre-commit，
   **不许** `sh .husky/pre-commit` 手工跑冒充——手工跑就绕过了「git 注入 env」这个被测条件本身。
5. **承重反例**：撤销那一行 ⇒ 同场景必红（实跑报红→绿），否则「修好了」没有证据。

## 溯源

根修 `6a10408`，被审 sha `b17fbcf`，carrier PR #68 `69d543b`；同链 OQ-β 被审 `6f79419`、
PR #71 `15e2724`；Phase A 取证 `69eef9d` / `bbbbd35f` / `0569af67` / `92fc8374`。
相关代码：`packages/server/src/llm/git-utils.ts` 的 `cleanGitEnv()` 与 `getCwd()`。

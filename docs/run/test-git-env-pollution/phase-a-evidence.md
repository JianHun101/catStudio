# Phase A 取证报告 · git 注入 env 劫持测试内的 git 操作

票：`docs/run/test-git-env-pollution/tickets.md` @ `69eef9d`（spec-gate 裁定版）
执行：flash猫 · 2026-09-13 · 触发消息 `48118283-52ec-49b7-95f3-53b55f19c9a6`
**范围**：只取证，零代码改动（未碰 `.husky/pre-commit`、未碰 `packages/**`、未改任何 e2e）

---

## 0. 结论先行

| 项           | 结论                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **A1 证因**  | **复现成功** —— 沙箱全链（config + `core.bare` + 分支篡改）+ 真实仓库可逆探针。⇒ **不触发「停手改判」**，本票维持「根修票」定性 |
| **竞争机制** | 咬人的是 **env 劫持（`GIT_DIR`）**，**不是 cwd**。cwd=tmp 本身零污染（对照 B/C 实测）                                           |
| **C2 清单**  | 实测**定位类**注入变量 **3 个**，⊆ `git-utils.ts:53-56` 四项 ⇒ 按 OQ-2 裁定 **不立小票，挂观察**                                |
| **C4**       | 两仓五字段跑批前后**全不变**；共享 `.git/config` 与基线 **md5 逐字节一致**（`1400632f…`）                                       |
| **探针残留** | 真实仓库零改动、`git status` 空；探针全在仓库外（`D:/Game/ai/_probe-test-git-env/`，已实核不在任何 repo 内）                    |

---

## 1. C2 · 注入清单实测

### 1.1 方法

临时 hooks 目录内放一个**内容即全部**的 `pre-commit`（首行即 dump，天然满足 spec-gate「落钩子顶部」要求），`exit 1` **自断** ⇒ git 调起钩子但**不产生提交**、不动 HEAD：

```sh
#!/bin/sh
{ echo "### hook fired: pre-commit"; echo "### PWD=$PWD"; env | sort; } > "$PROBE_DUMP"
exit 1
```

- **真实仓库**两次（`-c core.hooksPath=<探针>`，本轮不得改 `.husky`）：① 主工作区 dev ② 会话 worktree。HEAD 前后比对**均为 `f43ae0f`→`f43ae0f` / `69eef9d`→`69eef9d`，零提交落地**。
- **沙箱对照**（无 `-c`，hooksPath 写进 config，忠实形态）：见 §1.3。

### 1.2 实测原文 · 真实仓库

**① 主工作区**（`git -C /d/Game/ai/catStudy commit`，PWD=`/d/Game/ai/catStudy`）

```
GIT_AUTHOR_DATE=@1789264454 +0800
GIT_AUTHOR_EMAIL=JianHun101@users.noreply.github.com
GIT_AUTHOR_NAME=JianHun101
GIT_CONFIG_PARAMETERS='core.hooksPath'='D:/Game/ai/_probe-test-git-env/hooks'
GIT_EDITOR=:
GIT_EXEC_PATH=C:/Program Files/Git/mingw64/libexec/git-core
GIT_INDEX_FILE=.git/index
GIT_PREFIX=
```

**② 会话 worktree**（`git -C .../catStudy-sessions/2a86307b commit`，PWD=`D:/Game/ai/catStudy-sessions/2a86307b`）

```
GIT_AUTHOR_DATE=@1789264455 +0800
GIT_AUTHOR_EMAIL=JianHun101@users.noreply.github.com
GIT_AUTHOR_NAME=JianHun101
GIT_CONFIG_PARAMETERS='core.hooksPath'='D:/Game/ai/_probe-test-git-env/hooks'
GIT_DIR=D:/Game/ai/catStudy/.git/worktrees/2a86307b
GIT_EDITOR=:
GIT_EXEC_PATH=C:/Program Files/Git/mingw64/libexec/git-core
GIT_INDEX_FILE=D:/Game/ai/catStudy/.git/worktrees/2a86307b/index
GIT_PREFIX=
```

**①vs②差异**：worktree 独有 `GIT_DIR`（绝对）；`GIT_INDEX_FILE` 由**相对** `.git/index` 变**绝对**。

> `GIT_CONFIG_PARAMETERS` 是**本轮探针伪影**（`-c core.hooksPath` 由 git 传给子进程），真实 `.husky` 走 config 不产生它 —— 见 §1.3 忠实对照排除。

### 1.3 忠实对照（无 `-c`，排除伪影）

沙箱内把 hooksPath 写进 config 后直接 `git commit`：

| 上下文            | GIT_* 实测                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 沙箱主工作区      | `GIT_AUTHOR_DATE` / `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_NAME` / `GIT_EDITOR` / `GIT_EXEC_PATH` / `GIT_INDEX_FILE=.git/index` / `GIT_PREFIX=` |
| 沙箱链接 worktree | 同上，外加 `GIT_DIR=<绝对>`、`GIT_INDEX_FILE` 变绝对                                                                                      |

**⇒ `GIT_CONFIG_PARAMETERS` 确认是伪影，不属 git 注入面。**

### 1.4 清单定性（给 C1 的直接输入）

| 类别                   | 实测变量                                                                                                                                       | 是否劫持仓库定位 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **定位类（须 unset）** | `GIT_DIR`（仅 worktree）· `GIT_INDEX_FILE` · `GIT_PREFIX`                                                                                      | **是**           |
| 非定位类               | `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_DATE` / `GIT_EDITOR` / `GIT_EXEC_PATH`                                                    | 否（但见下）     |
| **未注入**             | `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_NAMESPACE` / `GIT_CEILING_DIRECTORIES` | ——               |

**两条硬结论**：

1. **实测定位类 = 3 项，全部落在 `git-utils.ts:53-56` 四项之内**（`GIT_WORK_TREE` 未被注入，属防御性冗余）。按 OQ-2 裁定「实测多于四项 ⇒ 立小票」⇒ **不立小票，挂观察**。
2. `GIT_EXEC_PATH` **不在**四项里，且**绝不能 unset 进清单**（它是 git 自身安装路径，非定位变量）。

**新读数（超出四项，非定位但会泄漏，报店长裁）**：`GIT_AUTHOR_*` 会被 git 在**跑钩子前**解析并注入，于是钩子内任何 `git commit`（哪怕在临时仓库、哪怕该仓库自己 `git config user.name test`）**用的是外层提交的身份**。实测：

```
注入 GIT_AUTHOR_NAME=OUTER_PROBE_CAT，临时仓库内 config user.name=gate-test
  → tmpD 提交作者 = OUTER_PROBE_CAT <outer@probe.local>   ← 外层注入覆盖仓库自身 config
对照（不注入 GIT_AUTHOR_*）
  → tmpE 提交作者 = gate-test <gate@test.local>
```

不劫持定位、**本票判据（真实仓库零改动）用不上它**；纳入 unset 属「净化可选」。**倾向不纳入**（最小改动），请店长裁。

---

## 2. A1 · 复现（承重）

沙箱 = 真实拓扑复刻（主仓库 + 链接 worktree + **共享 config**），注入值**取自 §1 实测**（`GIT_DIR` / `GIT_INDEX_FILE` 指向沙箱 worktree gitdir）。

最小脚本 = 测试里的典型操作面：`cwd=tmp` → `git init .` → `git config user.name/user.email` → `git commit --allow-empty`。

### 2.1 对照 B · 不注入（干净 shell）

```
cwd = /d/Game/ai/_probe-test-git-env/tmpB
rev-parse --git-dir -> fatal: not a git repository
git init . -> tmpB 生成自己的 .git
提交作者 = gate-test          ← tmpB 自己的 config 生效
沙箱 main HEAD / wtbranch / 共享 config → 全不变
```

### 2.2 对照 C · 只注入相对 `GIT_INDEX_FILE`（= **主工作区**注入档）

```
rev-parse --git-dir -> fatal: not a git repository
tmpC 生成自己的 .git，提交落 tmpC（1cc8a681…）
沙箱 main HEAD / wtbranch / core.bare / 共享 config user.name → 全不变
```

**⇒ 票面「主工作区仅注入相对 `GIT_INDEX_FILE`，cwd=tmp 时解析无害」这条断言，实测成立**（原为断言，现为实测）。

### 2.3 注入组 A · 注入 `GIT_DIR` + 绝对 `GIT_INDEX_FILE`（= **worktree** 注入档）

```
cwd = /d/Game/ai/_probe-test-git-env/tmpA          ← cwd 确在临时目录
rev-parse --git-dir -> D:/…/sandbox/main/.git/worktrees/wt   ← cwd 被无视
git init .    -> tmpA 下【没有】生成 .git
git config user.name gate-test  -> 落进【沙箱共享 config】
```

沙箱共享 config **前后对比**：

```diff
 [core]
-	bare = false
+	bare = true                    ← git init 重初始化写出
 [user]
-	name = sandbox                 ← 被覆盖
-	email = sandbox@local
+	name = gate-test
+	email = gate@test.local
```

`core.bare=true` 的连带症状（与长期记忆「已复发 2 次」逐字吻合）：

```
git -C sandbox/main status -> fatal: this operation must be run in a work tree
```

补跑 commit（换放行钩子，排除探针伪影）→ **分支篡改**：

```
注入前 wtbranch = 5c620d66…
注入后 wtbranch = 201f3b6 "fake commit from test"    ← 临时目录的提交落在沙箱真实分支上
提交作者        = gate-test <gate@test.local>
tmpA3 有 .git？ -> 没有
```

**⇒ 票面 `git-utils.ts:46` 注释的三条症状「reinit 写 `core.bare` / config 写共享 config / worktree 分支被 fake 提交篡改」，逐条实测复现。**

### 2.4 真实仓库侧（可逆探针，不碰 HEAD/index/`user.*`）

Phase A 不改代码 ⇒ 无法把 dump 钩子挂进 `.husky`；用 `GIT_DIR=<真实 worktree gitdir>` + cwd=临时目录直接注入：

```
cwd = /d/Game/ai/_probe-test-git-env/tmpReal
GIT_DIR=D:/Game/ai/catStudy/.git/worktrees/2a86307b
  rev-parse --git-dir         -> D:/Game/ai/catStudy/.git/worktrees/2a86307b
  rev-parse --abbrev-ref HEAD -> session/2a86307b
  rev-parse HEAD              -> 69eef9d5cd…            ← 解析落在真实仓库

git config catstudy.env-hijack-probe proof-48118283   ← 单键可逆写入
  真实共享 config 读回 -> proof-48118283                ← 写进了真实仓库
  tmpReal 生成 .git 吗 -> 没有
git config --unset …
  config md5 before = 1400632fbe469ee2324047e09c7c103d
  config md5 after  = 1400632fbe469ee2324047e09c7c103d  ✅ 字节级复原
```

**关于「不搬真实 HEAD」的处置说明（请店长复核）**：真实仓库侧**只做了只读解析 + 单键可逆写入**，**未**执行会移动真实 HEAD 的 `git commit` —— 该工作区当前有并行猫在跑，一次假提交落 `session/2a86307b` 会被别的猫的提交带上（记忆「worktree 分支被 fake 提交篡改」）。**分支篡改已在拓扑等价的沙箱复现（§2.3）**，机制不依赖具体是哪个仓库。若判定必须真机搬 HEAD，请明示，我补跑并逐字段复原。

---

## 3. 竞争机制判定（票面点名，不许跳）

**判定：咬人的是 env 劫持，不是 cwd。** 三条证据：

| 实验             | cwd | 注入                    | 真实仓库     |
| ---------------- | --- | ----------------------- | ------------ |
| B                | tmp | 无                      | **零改动**   |
| C（主工作区档）  | tmp | 仅相对 `GIT_INDEX_FILE` | **零改动**   |
| A（worktree 档） | tmp | `GIT_DIR` 绝对          | **全链污染** |

**cwd 项排除**：B/C 的 cwd 同样落在临时目录，结果干净 ⇒ 「cwd 落在临时目录」本身不是污染源。A 的 cwd 与前两者**相同**，唯一变量是 `GIT_DIR` ⇒ 归因唯一。且 `git rev-parse --git-dir` 在 A 下**无视 cwd** 返回注入值 —— 直接读到「`GIT_DIR` 优先级高于 cwd 探测」。

**cwd 分支的残余（另一条腿，现状未被触发）**：

- `getCwd()` = `process.cwd()`，server project 的 vitest cwd = `packages/server`，**落在真实 worktree 仓库内** ⇒ 若某测试不带 `{cwd: tmp}` 调用破坏性导出，`cleanGitEnv()` **拦不住**（它只剥 env，不拦 cwd）。
- 实核调用面：破坏性导出 `gitResetHard` / `gitCleanWorkingTree` / `npmUninstall`（`git-utils.ts:189/202/246`，全用 `getCwd()`）在测试里**零真实调用**（`socketio.test.ts:108-112` 全 `vi.fn()` mock）。`gitCommit` 真实调用点：`git-utils.test.ts`（`beforeAll` 已 `process.chdir(tmp)`，`:110`）、`serial.ts:998-999`（`serial.test.ts:56-62` mock 掉）、`session-closeout.test.ts:96`（显式传 `cwd`）。
- **⇒ 今天不咬人，但这是一条「靠每个作者都记得」的腿**（与 OQ-1 判 C1 的那条理由同型）。登记为观察项，**不在本票面**（C5 边界）。

**两处 env 缺口实核**（票面盘点复核，未走样）：

| 面                                            | 实况                                                                  | 会被 pre-commit 跑到吗                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/hooks-config.test.js:16,29`          | `execFileSync('git', …)` **无 `env`** ⇒ 继承注入                      | **会**（scripts project，`**/*.test.js`）。但两条命令**只读**（`rev-parse --is-inside-work-tree` / `config --get core.hooksPath`）⇒ 无写入污染 |
| `scripts/handoff-gen.e2e.mjs:230-232` 等 6 处 | `execSync('git init'/'config', { cwd: TMP })` **无 `env`** ⇒ 继承注入 | **不会**（`.e2e.mjs` 不在 vitest include）。但**手工跑时**若 shell 带 `GIT_DIR`，同样会写真实仓库                                              |

---

## 4. C4 · 前后快照

| 字段             | 主仓库 前 → 后                             | worktree 前 → 后        |
| ---------------- | ------------------------------------------ | ----------------------- |
| `core.bare`      | `false` → `false`                          | `false` → `false`       |
| `user.name`      | `JianHun101` → `JianHun101`                | 同左                    |
| `user.email`     | `JianHun101@users.noreply.github.com` → 同 | 同左                    |
| `core.hooksPath` | `.husky` → `.husky`                        | 同左                    |
| `HEAD` sha       | `f43ae0f…` → `f43ae0f…`                    | `69eef9d…` → `69eef9d…` |

共享 `.git/config` 与基线 `diff` **空**、md5 一致；两仓 `git status --short` **空**。

> worktree HEAD 由 `f43ae0f` → `69eef9d` 是**店长在取证期间落 spec-gate 裁定**（`69eef9d`，09:53:49，纯 `docs/run/`），**非本探针产物** —— 探针每次 commit 前先比 HEAD、后比 HEAD，两次读数均相同。

---

## 5. 给 Phase B 的直接输入

1. **C1 unset 清单（实测支持）**：`GIT_DIR` · `GIT_INDEX_FILE` · `GIT_PREFIX`（+ `GIT_WORK_TREE` 作防御性冗余，零成本）。**与 `cleanGitEnv()` 四项完全一致** ⇒ 钩子侧与测试侧同口径。
2. **不要 unset** `GIT_EXEC_PATH`（非定位变量，是 git 自身安装路径）。
3. `GIT_AUTHOR_*`：**待店长裁**（§1.4）。不影响本票判据。
4. **落点**：`set -e` 之后、`npx lint-staged` **之前**（spec-gate 追加要求）。**本括注原写「lint-staged 自身 spawn git」，经复核不成立、已作废**（`.lintstagedrc` 两个任务 grep `git|execSync|spawnSync|cwd` **零命中**），与票面 C1 同批更正。位置**不变**，理由换成：**前移零成本且可证** —— git 跑非 bare 仓钩子时 cwd = 工作树根，被注入的 `GIT_DIR` 恰是**本 worktree 自己的 gitdir** ⇒ 剥掉后按 cwd 探测回到**同一个**仓库；真正买到的不变量是「**本钩子不在被注入的 env 下跑任何子进程**」。
5. **A3 红→绿复核用沙箱**：本报告脚本在 `D:/Game/ai/_probe-test-git-env/`（**仓库外**，已实核不在任何 repo 内；可弃，Phase B 若复用建议重建）。
6. **A1 已复现 ⇒ 不触发停手**；OQ-4 的「C2 取证仍有效」条款本轮无需启用（取证与复现都拿到了）。

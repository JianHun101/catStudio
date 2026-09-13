# Tickets: git 向钩子注入的 env 劫持测试内的 git 操作 —— 污染真实仓库 config

用户 2026-09-13 裁「②立」。来源：`0d45e03`（T1 commit-msg 门禁）实施期实证咬人（店长收口时复原过一次被污染的主仓 config）；`docs/run/commit-uuid-gate/tickets.md` 的 OQ-D 判该立票。

## 背景（已实核，非转述）

**机制（仓内既有源码注释在案，非本票新推断）**

- git 在 **worktree 内** commit 时向钩子注入**绝对路径**的 `GIT_DIR`（指向 `.git/worktrees/<name>`）与 `GIT_INDEX_FILE`；**主工作区** commit 不注入 `GIT_DIR`（只有相对 `GIT_INDEX_FILE`，`cwd: tmp` 时解析无害）—— `packages/server/src/llm/git-utils.ts:38-50`（2026-08-09 hook env dump 实测实锤，原文在案）。
- **`GIT_DIR` 优先级高于 cwd 探测** ⇒ 钩子里跑全量测试时，测试的 `execSync(..., { cwd: tmp })` 被劫持：`git init / config / add / commit` 全部打到**真实仓库**（`git-utils.ts:46` 原话：「reinit 写 `core.bare`、config 写共享 config、commit 落真实分支」「worktree 分支被 fake 提交篡改」）。
- 长期记忆在案：`core.bare` 被写成 `true` **已复发 2 次**，症状是主仓 git 命令报 `must be run in a work tree`。

**为什么现在才咬人**：本 run 的实施猫在**会话 worktree** 内提交 ⇒ 命中「worktree 注入 `GIT_DIR`」这一格；`0d45e03` 是本 run 第一个**在 worktree 内被 pre-commit 跑全量**的代码票。

**现状盘点（本票的真问题面 —— 全是实核）**

| 面                       | 现状                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanGitEnv()` 定义处   | **7 份**：`llm/git-utils.ts:51`（导出）· `llm/git-utils.test.ts:77`（副本）· `git/diff-collector.ts:51` · `git/diff-collector.test.ts:26`（副本）· `llm/session-closeout.test.ts:31`（副本）· `scripts/commit-uuid-gate.mjs:104`（导出）· `scripts/flywheel/scan.mjs:310` |
| 未剥离的 shell 出 git 面 | `scripts/hooks-config.test.js`（`git rev-parse` / `git config --get core.hooksPath` —— **vitest 面，会在 pre-commit 下跑**）· `scripts/handoff-gen.e2e.mjs`（临时仓库 `git init / config`，手工 e2e）                                                                     |
| 只读面同样中招           | 劫持后 `git config --get core.hooksPath` 读的是**被劫持的那个仓库** ⇒ 断言可能假绿/假红（本仓 hooksPath 类故障史里是否混着这个成因，未逐一回溯）                                                                                                                          |

## T1 · 根修：`.husky/pre-commit` 跑测试前剥离 git 注入的定位变量

**What to build:** 钩子在跑 `pnpm test` 前剥掉 git 注入的定位变量，恢复「按 cwd 探测」语义。

**Blocked by:** None —— 可立即开工（但 **A1 先证因是硬前置**，见验收）。

### 契约

- **C1 修点在钩子侧（单点）**：`.husky/pre-commit` 跑测试前 `unset` 掉 git 注入的定位变量（清单以 C2 实测为准）。**理由**：注入源只有一处（git 自己），钩子侧一刀覆盖**全部**测试 —— 含未来新增的、以及今天还不知道要剥离的那些。测试侧逐个洗 env 是「每个作者都要记得」的形态：现状 **7 份复制品 + 2 处缺口**就是它失效的证据。
- **C2 剥离清单 = 实测，不许按猜的写**：临时仓库内装一个 dump `env | grep '^GIT_'` 的钩子，**①主工作区 ②worktree 各 `git commit` 一次**取真实清单。`git-utils.ts:51-57` 的四项（`GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE` / `GIT_PREFIX`）是**已有实测的下界**，实测若多出变量一并纳入。
- **C3 作用域最小**：`unset` 只影响本钩子进程及其子进程；**不动** `.husky/post-commit` / `pre-push` / `commit-msg`（`handoff-gen` 自己 spawn git 且**需要**正确的仓库定位，改它语义风险不对称）。lint-staged 与 `pnpm test` 同在这一次 pre-commit 里 —— 实现选择「钩子顶部统一 unset」时，**须实测 lint-staged 仍正常**（它按 cwd 探测即可工作，但不能只靠推理）。
- **C4 判据 = 真实仓库零改动**：跑批前后比对**主仓库**与**当前 worktree** 的 `core.bare` / `user.name` / `user.email` / `core.hooksPath` 与 `HEAD` sha —— 全不变。
- **C5 不做**（本票边界）：不动 `packages/**` 生产代码；不重构那 7 份 `cleanGitEnv`（见 OQ-2）；不改任何 e2e。

### 验收（可证伪）

- **A1 先证因（硬前置，不许跳）**：构造注入环境（`GIT_DIR=<真实仓库 .git>`，或直接在 worktree 内经真实 `git commit` 触发 pre-commit）跑「临时仓库出 git」的最小脚本 ⇒ **观察到真实仓库 config/HEAD 被改**。
  **若复现不出来 ⇒ 停下来回店长，不许硬修**：根因不在这条链上，本票改判「护栏票」（新增测试的默认保护）或另立。本仓已两次把猜想当根因，这一步就是防它。
  **同时须排除竞争机制**：`git-utils.ts:34` 的 `getCwd()` 取 `process.cwd()` —— 若某条**生产**路径在全量测试中被调到（模块被先 import），破坏性操作（`git reset --hard` / `git add -A` / `config`）会直接打在真实仓库上。实施者须辨明咬人的是**env 劫持**还是**cwd 落在真实仓库**，以证据说明（两者修法不同）。
- **A2 修后同场景 ⇒ 不再污染**（C4 的四个字段 + HEAD 全不变）。
- **A3（承重反例）**：把 C1 那行撤销 ⇒ A2 必红。实施者须**实跑报出红→绿**，不许只声称。
- **A4 真机挂钩（承记忆「hook env 实测须确认真实触发」）**：在 **worktree 内**用真实 `git commit` 触发一次完整 pre-commit（含 lint-staged + lint + 全量测试），以前后快照为证；**不许**用 `sh .husky/pre-commit` 手工跑冒充。
- **A5** `pnpm test` 全绿 + `pnpm lint` 绿。

**决策留痕**

- 跳 grilling：形态由事故判据反推，可选面窄。
- Gate B：〔边界 = 1 个钩子 + 1 处回归断言〕〔契约 = C1–C5〕〔验收 = A1–A5〕。
- Gate C 反向证明：A2 与 A3 互为反面；A4 证明修复在**真实触发路径**上生效（而非只在手搓环境里成立）。

## OQ（请 spec-gate 裁）

- **OQ-1 修点：钩子侧单点 vs 测试侧共享 helper。** 我判钩子侧（C1 的理由）。**翻面条件**：若能给出「不经钩子却能拿到被污染 env」的真实路径，我改判（手工 `pnpm test` 无注入，我没想到这条路径——但这是推理，请你实核）。
- **OQ-2 那 7 份 `cleanGitEnv` 要不要单源化？** 我判**本票不做**（跨 `packages/server` 与 `scripts` 两个世界，收敛要新引共享层；且 T1 落地后它们对污染已非承重）。但「7 份同款 + 2 处缺口」本身是「记录≠真相」的活体 —— **该不该同时立一张小票，请你判**。
- **OQ-3 `hooks-config.test.js` 的只读劫持**（读错仓库 ⇒ 假绿/假红）算不算本票面内？我判**不算**（它是「没洗 env」的下游症状，T1 落地后自然消失）；若你判该有独立断言，我加。
- **OQ-4 A1 的复现若失败**：我给的处置是「停手改判」。若你判「即使复现不出也该上护栏」，请明说 —— 那是另一个票面（护栏 ≠ 修复），别混进来。

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
**状态（2026-09-13）**：Phase A 已回执（`bbbbd35` / `phase-a-evidence.md`）—— **A1 复现成功（全链）⇒ 不触发「停手改判」**，本票维持「根修票」定性；**Phase B 已放行**（修点未变，仅理由措辞更正，见 C1）。

### 契约

- **C1 修点在钩子侧（单点）**：`.husky/pre-commit` 跑测试前 `unset` 掉 git 注入的定位变量（清单以 C2 实测为准）。**理由**：注入源只有一处（git 自己），钩子侧一刀覆盖**全部**测试 —— 含未来新增的、以及今天还不知道要剥离的那些。测试侧逐个洗 env 是「每个作者都要记得」的形态：现状 **7 份复制品 + 2 处缺口**就是它失效的证据。
  **落点（spec-gate 2026-09-13 追加，勿挪）**：`unset` 必须落钩子**顶部** —— `set -e` 之后、`npx lint-staged` **之前**（实核 `.husky/pre-commit:3` = `set -e`，`:4` = `npx lint-staged` ⇒ `unset` 的**唯一落点**就在这两行之间）。**位置不变。**
  **理由（2026-09-13 Phase A 回执后更正 —— 原措辞「lint-staged 自身 spawn git（stash / add / 恢复暂存面）⇒ 放在它之后，最该护的那一段仍在被注入的 env 里对共享 config 动手」，经实测不成立，作废）**：
  ① **前移零成本且可证**：git 跑非 bare 仓钩子时 cwd = 工作树根，被注入的 `GIT_DIR` 恰是**这个 worktree 自己的 gitdir** ⇒ 剥掉定位变量后按 cwd 探测回到**同一个**仓库，lint-staged 不会跑偏。（`GIT_DIR` 仅在 **worktree 内** commit 时注入；主工作区只注入相对 `GIT_INDEX_FILE`，`cwd=tmp` 解析无害 —— Phase A 对照 C 已由断言升为实测。）
  ② **原措辞的两处失实**：`.lintstagedrc` 两个任务（`prettier --ignore-unknown --write` / `node scripts/skills-check-{manifest,mount}.mjs`）**零 git 调用**（grep `git|execSync|spawnSync|cwd` 零命中）；且「worktree 与主仓共享 config」是**仓库拓扑本身**（无 `extensions.worktreeConfig`），**不是注入造成的** ⇒「放在它之后 ⇒ 对共享 config 动手」这一步推不出来。
  ③ **前移真正买到的**：把不变量钉成「**本钩子不在被注入的 env 下跑任何子进程**」，比「记得只护 `pnpm test` 那一段」可维护，并自然覆盖未来 `.lintstagedrc` 新增会 shell 出 git 的任务。
  **记账**：原措辞是**未复现的机制断言**，正是本票要治的形态 —— 落票面时未先证因，由实施者在 Phase A 实测推翻。`phase-a-evidence.md` §5.4 的括注沿用了同一措辞，同批作废（该文件由 flash猫 同步更正）。
- **C2 剥离清单 = 实测，不许按猜的写**：临时仓库内装一个 dump `env | grep '^GIT_'` 的钩子，**①主工作区 ②worktree 各 `git commit` 一次**取真实清单。`cleanGitEnv()`（`git-utils.ts:51`）的四项（`:53-56` = `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE` / `GIT_PREFIX`）是**已有实测的下界**。
  **纳入判据（2026-09-13 Phase A 回执后收窄）**：**按类别判，不按「多出就纳入」判** —— 只纳入**定位类**（能改变 git 解析到**哪个仓库 / 哪个 index** 的变量）。实测注入面里另有**非定位类**（`GIT_AUTHOR_NAME/EMAIL/DATE` · `GIT_EDITOR` · `GIT_EXEC_PATH`），**一律不纳入**（裁决与理由见 OQ-5）。原句「实测若多出变量一并纳入」按字面会误纳它们，故作废。
  **本票最终清单（Phase A 实测定，Phase B 照此落）**：`unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX` —— **四项，与 `cleanGitEnv()` 完全一致**（钩子侧与测试侧同口径；`GIT_WORK_TREE` 为防御性冗余）。
  **dump 钩子的安装位置（spec-gate 追加）**：同样落钩子**顶部** —— 量到的必须是「git 注入给钩子进程」的真实继承面，不是某个子 shell 的。
  **已知残余（记录即可，不阻）**：dump 到的是**当前 git 版本**的真实清单，未来 git 新增注入变量时污染会复发；本仓无 CI 快照兜底，接受该残余风险。
- **C3 作用域最小**：`unset` 只影响本钩子进程及其子进程；**不动** `.husky/post-commit` / `pre-push` / `commit-msg`（`handoff-gen` 自己 spawn git 且**需要**正确的仓库定位，改它语义风险不对称）。lint-staged 与 `pnpm test` 同在这一次 pre-commit 里 —— 实现选择「钩子顶部统一 unset」时，**须实测 lint-staged 仍正常**（它按 cwd 探测即可工作，但不能只靠推理）。
- **C4 判据 = 真实仓库零改动**：跑批前后比对**主仓库**与**当前 worktree** 的 `core.bare` / `user.name` / `user.email` / `core.hooksPath` 与 `HEAD` sha —— 全不变。
- **C5 不做**（本票边界）：不动 `packages/**` 生产代码；不重构那 7 份 `cleanGitEnv`（见 OQ-2）；不改任何 e2e。

### 验收（可证伪）

- **A1 先证因（硬前置，不许跳）**：构造注入环境（`GIT_DIR=<真实仓库 .git>`，或直接在 worktree 内经真实 `git commit` 触发 pre-commit）跑「临时仓库出 git」的最小脚本 ⇒ **观察到真实仓库 config/HEAD 被改**。
  **若复现不出来 ⇒ 停下来回店长，不许硬修**：根因不在这条链上，本票改判「护栏票」（新增测试的默认保护）或另立。本仓已两次把猜想当根因，这一步就是防它。
  **回执（2026-09-13，`bbbbd35`）✅ 复现成功**：沙箱（真实拓扑复刻 = 主仓库 + 链接 worktree + 共享 config）全链命中 —— `git init .` 在 `cwd=tmp` 下**不生成 `.git`**、共享 config 被写 `core.bare=true` + 覆盖 `user.name`、随后真实分支被打上 fake commit；`git-utils.ts:46` 注释的三条症状**逐条复现**。真实仓库侧以「只读解析 + 单键可逆写入 + md5 字节级复原」佐证劫持在真机成立。**⇒ 不触发停手条款。**
  **同时须排除竞争机制**：`git-utils.ts:34` 的 `getCwd()` 取 `process.cwd()` —— 若某条**生产**路径在全量测试中被调到（模块被先 import），破坏性操作（`git reset --hard` / `git add -A` / `config`）会直接打在真实仓库上。实施者须辨明咬人的是**env 劫持**还是**cwd 落在真实仓库**，以证据说明（两者修法不同）。
  **回执（2026-09-13）✅ 判定 = env 劫持（`GIT_DIR`），不是 cwd**：三组对照 **cwd 同为临时目录**而结果分化（B 无注入 / C 仅相对 `GIT_INDEX_FILE` ⇒ 两仓零改动；A 注入 `GIT_DIR` ⇒ 全链污染），归因唯一；且 A 下 `rev-parse --git-dir` **无视 cwd** 返回注入值。
  **cwd 那条腿的残余（登记观察项，不在本票面 —— C5 边界）**：`getCwd()` = `process.cwd()`（`git-utils.ts:34`），server project 的 vitest cwd 落在真实仓库内 ⇒ 若某测试**不带 `{cwd: tmp}`** 调破坏性导出，`cleanGitEnv()` **拦不住**（它只剥 env、不拦 cwd）。今日未被触发：破坏性导出（`gitResetHard` / `gitCleanWorkingTree` / `npmUninstall`）在测试里零真实调用，`gitCommit` 的真实调用点要么 `beforeAll` 已 `chdir(tmp)`、要么显式传 `cwd` —— **但这是「靠每个作者都记得」的形态**（与 OQ-1 判 C1 的理由同型）。
- **A2 修后同场景 ⇒ 不再污染**（C4 的四个字段 + HEAD 全不变）。
- **A3（承重反例）**：把 C1 那行撤销 ⇒ A2 必红。实施者须**实跑报出红→绿**，不许只声称。
- **A4 真机挂钩（承记忆「hook env 实测须确认真实触发」）**：在 **worktree 内**用真实 `git commit` 触发一次完整 pre-commit（含 lint-staged + lint + 全量测试），以前后快照为证；**不许**用 `sh .husky/pre-commit` 手工跑冒充。
- **A5** `pnpm test` 全绿 + `pnpm lint` 绿。

**决策留痕**

- 跳 grilling：形态由事故判据反推，可选面窄。
- Gate B：〔边界 = 1 个钩子 + 1 处回归断言〕〔契约 = C1–C5〕〔验收 = A1–A5〕。
- Gate C 反向证明：A2 与 A3 互为反面；A4 证明修复在**真实触发路径**上生效（而非只在手搓环境里成立）。

## OQ（spec-gate 已裁 · 2026-09-13 · **Gate Result: ✅ PASS —— 可派 Phase B，等 Phase A 证据回来再放修点** · **Phase A 已回执 `bbbbd35`：A1 复现成功、修点未变 ⇒ 放行条件已满足，Phase B 已放行**）

- **OQ-1 修点：钩子侧单点 vs 测试侧共享 helper。** 我判钩子侧（C1 的理由）。**翻面条件**：若能给出「不经钩子却能拿到被污染 env」的真实路径，我改判。
  **裁：同意钩子侧单点 —— 翻面条件经实核无真实反例。** 全仓跑测试的调用面只有两条：pre-commit 钩子（有注入）· 人/agent 手动 `pnpm test`（从干净 shell 起，**无注入源**）；`dev.js` / `handoff-gen` / `eval` 均不跑测试。附 **C1 落点要求**（见上）—— 这是实现级硬要求，不是建议。
- **OQ-2 那 7 份 `cleanGitEnv` 要不要单源化？** 我判**本票不做**。
  **裁：当前不立票，判据给死。** C2 实测清单若**多于** `git-utils.ts:53-56` 那四项 ⇒ 立小票（7 份副本与新清单漂移 = 「记录≠真相」复发，副本从冗余变误导）；**不多于四项** ⇒ 不立，挂观察。**清单没量出来之前票面写什么都是猜。**
  **口径更正（2026-09-13，Phase A 回执后）**：原文写「实测**恰为四项** ⇒ 不立」，按字面**永不可满足** —— `GIT_WORK_TREE` **从未被注入**（Phase A 实测：主工作区 0 个定位类变量；worktree 3 个）。判据改为「**不多于**四项」，否则这条永远悬空。
  **结案（Phase A 实测）**：**定位类 3 项** = `GIT_DIR`（仅 worktree）· `GIT_INDEX_FILE` · `GIT_PREFIX`，**⊆ 四项 ⇒ 不立小票，挂观察**。`GIT_WORK_TREE` 属 `cleanGitEnv()` 的**防御性冗余**（零成本保留，不删）。
- **OQ-5（Phase A 新提，店长裁）非定位类注入变量纳不纳入 unset？** 实测注入面里还有 `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_DATE` / `GIT_EDITOR` / `GIT_EXEC_PATH`。其中 `GIT_AUTHOR_*` **会压过临时仓库自身 config 的身份**（沙箱实测：注入 `OUTER_PROBE_CAT` 压过仓库内 `user.name=gate-test`）。
  **裁：一律不纳入 —— 最小改动。** 三条理由：① **非定位类**，不改变 git 解析到哪个仓库，本票判据（真实仓库零改动）用不上它；② 本票边界是「**污染真实仓库**」，改**临时仓库的提交身份**是另一个（更轻的）危害面，混进来会糊掉 C1 的单点语义；③ **`GIT_EXEC_PATH` 尤其不能 unset** —— 它是 git 自身安装路径，非定位变量，剥掉可能干扰 git 找自己的子命令。
  **登记观察项**：若未来出现「测试内提交身份错乱」类故障，根因面在这里（不在本票）。
- **OQ-6（Phase A 请裁）真实仓库要不要补跑「搬 HEAD」那一次（`git commit` 落真实分支）？**
  **裁：不必。** 理由三条：① 机制已在**拓扑等价**沙箱复现**全链**（`core.bare=true` / 共享 config 被覆盖 / 分支被 fake commit 篡改 —— 三条症状逐条命中），机制**不依赖具体是哪个仓库**；② 该 worktree 有**并行链**，一次假提交会被别的猫的提交带上 —— **取证收益为零、污染风险非零**；③ 真实仓库侧已用「只读解析（`rev-parse` 落 `session/2a86307b`）+ 单键可逆写入（落真实共享 config）+ md5 字节级复原」佐证劫持在**真机**成立。
  **这条不构成缩范围**：A1 的判据是「观察到真实仓库 config/HEAD 被改」，探针已**观察到 config 被改**且在真机；HEAD 项由拓扑等价沙箱补齐。
- **OQ-3 `hooks-config.test.js` 的只读劫持**（读错仓库 ⇒ 假绿/假红）算不算本票面内？
  **裁：不算，且理由比票面更准。** worktree 与主仓**共享 config**（无 `extensions.worktreeConfig`）⇒ 被劫持的 `git config --get core.hooksPath` 读到的**就是**断言目标本体，读的是**真值**，不是假绿/假红。真正的退化是 `core.bare` 被污染时 `insideGitRepo()` 返假 → 该 tripwire 在**仓库已经坏掉**的时刻静默跳过（护栏恰在最需要时哑），但那是污染的下游症状，T1 根修后自然消失。给一条已死路径另立断言 = 自造维护面 ⇒ **不加**。
- **OQ-4 A1 的复现若失败**：我给的处置是「停手改判」。
  **裁：同意停手改判（护栏 ≠ 修复，别混进同一票）。** 补一条：**A1 复现失败时 C2 的 env dump 取证仍然有效** —— 护栏票同样要剥离清单，别整体作废重跑。

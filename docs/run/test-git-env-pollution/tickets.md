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
**交付与收口（2026-09-13）**：Phase B 已交付 `6a10408`（钩子根修 + 护栏回归）→ **修复轮 `b17fbcf`**（护栏补 unset 清单断言 + 票面口径精确化）；**复审 ✅**（吐槽猫：三处行号 grep 实核 / 绿态本机复核 `3 passed` / 承重反例实跑）；**已收口** —— PR #68，carrier `69d543b`，被审 `b17fbcf` 完整保留在 dev 历史中。详见文末「收口」段。

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
  **本票最终清单（Phase A 实测定，Phase B 照此落）**：`unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX` —— **四项，与 `git-utils.ts:53-56` 那份 `cleanGitEnv()` 逐字一致**（`GIT_WORK_TREE` 为防御性冗余）。
  **口径精确化（2026-09-13，审查 P3 采纳）**：原写「与 `cleanGitEnv()` **完全一致**」按字面**不成立** —— 全仓 7 份副本今天已有**三个变体**：`git-utils.ts:53-56` **4 项** · `scan.mjs:313-318` **6 项**（+`GIT_OBJECT_DIRECTORY` · `GIT_COMMON_DIR`）· `commit-uuid-gate.mjs:93-100` **8 项**（再 +`GIT_ALTERNATE_OBJECT_DIRECTORIES` · `GIT_CONFIG_PARAMETERS`）。⇒「**同口径**」只对 `git-utils.ts` 那一份成立；原句源自 spec-gate 报告（**只实核了那一份**就写了「完全一致」——同属「未先证因即落断言」，本票第 4 处）。
  **副本漂移的现状（不是「未来若漂移」）**：**已漂移 · 方向安全 · 无功能缺口** —— 三变体互为超集，多出的 4 项在 `phase-a-evidence.md` §1.4 表格里**逐项列为「未注入」** ⇒ 不在真实注入面内。
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
  **口径更正（2026-09-13，Phase A 回执后）**：原文写「实测**恰为四项** ⇒ 不立」，按字面**永不可满足** —— `GIT_WORK_TREE` **从未被注入**（Phase A 实测：主工作区 2 个定位类变量 · worktree 3 个）。判据改为「**不多于**四项」，否则这条永远悬空。
  **计数口径（2026-09-13，审查复核后补）**：上句「不多于四项」计的是**定位类**变量（能改变 git 解析到**哪个仓库 / 哪个 index** 的），**不是全量注入变量** —— 按全量计是主工作区 7 项 · worktree 8 项，字面会**反向触发立票**。口径与上文 C2「**按类别判，不按「多出就纳入」判**」**同源**，两处必须同口径读；判据给死时要连**计数口径**一并钉死，否则「不多于四项」与它要判的集合不在一面。
  **对称记账（2026-09-13，审查侧自曝 · 已独立复核）**：审查者在复核该口径时写的「按全量计是 **9 项**」**未数过** —— 对 `phase-a-evidence.md` §1.1 dump 原文逐行数：主工作区 **8 行 − 1 伪影 = 7**、worktree **9 行 − 1 = 8**（伪影 = `GIT_CONFIG_PARAMETERS`，§1.3 忠实对照已排除）。**判向不变**（7 / 8 / 9 全部 > 4），但**计数失真就是失真**，且与上文第 3 处（凭「零污染」推「不存在」）同属「**未先证因即落断言**」⇒ **两侧各犯一次，本条不记在谁头上，记在规矩上**：凡落计数，**先数再写，并写明单位与口径**（本仓「凭印象写计数」已有前例）。
  **本条自身的一处失真（2026-09-13 自查，同批更正）**：本段初写「主工作区 **0 个**定位类变量」，**是错的** —— 实测主工作区**有 2 项**（`GIT_INDEX_FILE` **相对形式** · `GIT_PREFIX`），worktree 多出 `GIT_DIR`（绝对）且 `GIT_INDEX_FILE` 转绝对。**措辞精确性（2026-09-13 审查 P3 采纳）**：`GIT_PREFIX` 属**被注入但值为空**（dump 原文即 `GIT_PREFIX=`）——「注入了」与「值为空」两事并存，本处取的是前一个事实（`grep '^GIT_'` 它确在 env 里）；未写成「有值」。**错因**：把对照 C 的**「零污染」**读成了**「不存在」** —— 那两项因**相对形式 + 无 `GIT_DIR`** 才无害，**不等于没被注入**。⇒ **本票面上我自己写的未经复核陈述第 3 处**（① C1 落点理由，② 「恰为四项」，③ 本处），三处同型，**均为「未先证因即落断言」**——正是本票要治的形态。
  **结案（Phase A 实测）**：**定位类 3 项** = `GIT_DIR`（仅 worktree）· `GIT_INDEX_FILE` · `GIT_PREFIX`，**⊆ 四项 ⇒ 不立小票，挂观察**。`GIT_WORK_TREE` 属 `cleanGitEnv()` 的**防御性冗余**（零成本保留，不删）。
  **观察项前提更新（2026-09-13，审查 P3 采纳）**：原登记的是「**未来若漂移**」⇒ **与实况不符，副本漂移已存在**（三变体 4 / 6 / 8 项，见上 C2 口径精确化段）。判据方向未翻：漂移是**安全方向的超集**、多出项不在实测注入面内 ⇒ **无功能缺口**，故**仍不立小票**。观察项据此改盯「**漂移转为缺口**」那一步 —— 触发条件写死（2026-09-13 审查 P3 点名式收窄）：**①** 任一变体**少于**定位类三项；**②** 清单混进**已点名的非定位类五项**（`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_DATE` / `GIT_EDITOR` / `GIT_EXEC_PATH`，见下 OQ-5）而被当定位类使用 —— 原写「如 `GIT_EXEC_PATH`」是**举例式**，举例外的四项按字面不触发，**点名后②才机械可查**。另注（审查 2026-09-13 判）：②的危害面本就是 **fail-loud**（`unset GIT_EXEC_PATH` 在真机立即炸，git 找不到自己的子命令），故②仅作登记、**不需护栏兜**。
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

## 收口（2026-09-13）

| 项             | 值                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被审 sha       | **`b17fbcf`**（修复轮）· 前置 `6a10408`（钩子根修 + 护栏回归）                                                                                                        |
| 免审前缀内提交 | `69eef9d` / `bbbbd35` / `0569af6` / `92fc837`（全在 `docs/run/**`）                                                                                                   |
| carrier        | **PR #68** `69d543b`（base=`dev`）                                                                                                                                    |
| 三方对齐       | `dev = origin/dev = .push-gate = 69d543b`                                                                                                                             |
| 复审结论       | ✅ 可合并 —— OQ-ε 认（不为从未注入的 `GIT_WORK_TREE` 立硬断言）· `⊇` 而非 `==` 认 · OQ-2 触发条件 ①硬 ②fail-loud 兜底可接受                                           |
| 收口侧独立复核 | `pnpm test` **109 files / 2154 passed**（较改前 2151 **净增 3** = 新增护栏用例数）· `pnpm lint` 三包 ✅ · 零 flaky；核对对象 = `dev` 上的干净快照（非审查者读数转述） |
| 重启           | **不涉 server / shared ⇒ 无重启审批**                                                                                                                                 |

**本 run 为何不清**（承 `745535c` 判据：**零未闭项才删**；有未闭项则保留并补「收口」段 —— 清了就成暗知识）：未闭观察项如下。

1. **OQ-2 副本漂移**：三变体 4 / 6 / 8 项**已存在**，方向安全、无功能缺口；触发条件见上（已点名式收窄）。
2. **cwd 那条腿**：`getCwd()` = `process.cwd()`（`git-utils.ts:34`），`cleanGitEnv()` 只剥 env、**不拦 cwd**；今日零真实调用（破坏性导出在测试里零真实调用），属「靠每个作者都记得」形态。
3. **OQ-5 非定位类注入**：若未来出现「测试内提交身份错乱」（`GIT_AUTHOR_*` 压过仓库内身份），根因面在此。
4. **OQ-β（流程级 · 待店长裁规范形态）**：`git commit --only <paths>` 与 lint-staged 不兼容 —— `--only` 置 `GIT_INDEX_FILE=<repo>/next-index-<pid>.lock`，与 lint-staged 的 `$GIT_DIR/index.lock` 相撞；`AGENTS.md`「提交」条目现写 `--only`，实际须改「`git add <paths>` + plain commit」（本票实施期有据偏离并实测通过）。
5. **已知残余（票面已明示接受）**：dump 到的是**当前 git 版本**的注入面，未来 git 新增注入变量时污染会复发；本仓无 CI 快照兜底。

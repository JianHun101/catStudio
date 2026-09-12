# Tickets: commit-msg 门禁 —— `catstudy [uuid]` 必须真实存在

用户 2026-09-13 裁「派② pre-commit 校验 uuid」。来源：`452dbfd` 事故（店长手打杜撰 uuid）+ `76dddf4` 复审 ✅ 时入池。

## 背景（已实核，非转述）

- **事故**：`452dbfd` 的 commit message 写着 `catstudy [b71976df-…]` —— 该 uuid 是**手打杜撰**的，库里 `messages` / `execution_logs` 双查无此行（真值本该取自 `$CATSTUDY_TRIGGER_MSG_ID`）。
- **症状**：归属判据 `probeAttribution`（判据 = 「该 uuid 是否存在任一状态的执行行」）把「查无此 uuid」归到「用户手动提交」⇒ post-commit 钩子**多投一份**交接文档。
- **为什么前三单没露头**：`18e6efb0` / `856808e5` / `7f1a3c62` 三条同类假 uuid 的提交**改动全在 `docs/run/**`**，被免审白名单闸（`isExemptDelivery`，要求「改动路径**全部**在 `docs/run/` 内」）走 `skip` 静默分支，**压根走不到归属判据**。`452dbfd` 是第一次跨出该前缀（改了 `AGENTS.md` / `CONTEXT.md` / `docs/plans/**`）⇒ 才露头。
- **口径更正（承重，写给实施者）**：用户说的「pre-commit 校验」在实现上**落不到 `pre-commit`** —— 该钩子在 commit message 生成**之前**运行，**物理上拿不到 message**。git 提供 message 的钩子是 **`commit-msg`**（`$1` = message 文件路径）。本条按 `commit-msg` 实施。

## T1 · `scripts/commit-uuid-gate.mjs` + `.husky/commit-msg` 薄壳

**What to build:** 新增一个提交期门禁：message 里带 `catstudy [uuid]` 时，该 uuid 必须能在这台机器上的 `messages` 表里查到；查不到就不许提交。

**Blocked by:** None — 可立即开工。

### 契约

- **C1 钩子形态**：新增 `.husky/commit-msg`（POSIX sh 薄壳，只负责把 `$1` 转交给脚本），**不改 `.husky/pre-commit`**（拿不到 message）。逻辑全在 `scripts/commit-uuid-gate.mjs` 单源——承本仓既有形态（`pre-push` → `handoff-gen.mjs`、`post-commit` → `handoff-gen.mjs`）。`core.hooksPath` 已是 `.husky`，新增钩子文件即被 git 拾取，**无需注册步骤**。
- **C2 判据源**：uuid 必须存在于 `messages.id`（`TEXT PRIMARY KEY`）。库路径**复用** `scripts/flywheel/retire-message-memory.mjs` 已导出的 `defaultDbs(root)`（dev + prod 两库，与 `db/index.ts` 的库分离同源）——**不新写一份库布局**（两个真相源 = 下次库改名必漏一个）。
- **C3 根解析（worktree 承重）**：钩子常在 worktree 内跑，而 **worktree 的 `packages/server/data/` 里没有 `.db`**（实核：只有一个 `cat-study.log`）。故根必须取**主仓库**：`git rev-parse --path-format=absolute --git-common-dir` → 取其父目录。`DatabaseSync` **只在 `existsSync(dbFile)` 之后**才 new——承 `retire-message-memory.mjs` 既有注释：`node:sqlite` 的构造函数会**创建**空库文件，在 worktree 里跑会落一地假库。`PRAGMA busy_timeout` 取值与既有脚本同源（有界等待，不重试）。
- **C4 四态判决**（**这是本票的判据主体，逐条都要有对应用例**）：

  | 态                                           | 判决                  | 理由                                        |
  | -------------------------------------------- | --------------------- | ------------------------------------------- |
  | message 无 `catstudy [uuid]` 标记            | **放行**              | 现状保持：merge / revert / 人工提交不受影响 |
  | 有标记，uuid 形状非法（非 `8-4-4-4-12` hex） | **阻断 exit 1**       | 形状错 = 手打/截断的高置信信号，且无需查库  |
  | 有标记，形状合法，两库都查无此 id            | **阻断 exit 1**       | 本票要挡的那一类                            |
  | 两库文件**都不存在**                         | **放行 + 显式警示行** | 判据**无主体**（不是「通过」）；见 OQ-1     |
  | 库存在但读取失败（加锁超时 / 表缺失）        | **阻断 exit 1**       | 判据有主体却判不动 ⇒ 查不动 ≠ 放行          |

- **C5 出口**：阻断信息必须含 ① 被拒的 uuid 原文 ② 一句「uuid = 触发本次执行的**用户消息 id**」③ 取证命令 `echo $CATSTUDY_TRIGGER_MSG_ID` ④ 全局逃生口 `git commit --no-verify`。**不新增第二个逃生开关**（env 白名单之类）——`--no-verify` 已是本仓既有唯一出口，多开一个等于把门禁变成装饰。
- **C6 标记提取单源**：复用 `handoff-gen.mjs` 已导出的 `extractCommitUuid`（该模块有 `isMain` 守卫，**可安全 import，不触发主流程**，已实核）。**不改**它的正则/语义（它服务投递面）；**严格形状校验加在新脚本内**，不动旧函数。
- **C7 判据面与执行面同面**：门禁只校验 message 里那个 uuid 在**库**中存在。**不**用 `$CATSTUDY_TRIGGER_MSG_ID` 当判据（env 是取证提示，库才是真相源）；**不**校验「该 uuid 有执行行」（那是投递面判据，混进来会误拦合法的用户手动提交）。

### 边界（做什么 / 不做什么）

- 做：新增 `scripts/commit-uuid-gate.mjs`、`.husky/commit-msg`、`scripts/commit-uuid-gate.test.js`；改 `README.md` 提交约定段（点名这道闸）。
- **不做**：不改 `pre-commit` / `post-commit` / `pre-push` 任何一个的现有逻辑；不改 `handoff-gen.mjs` 的投递判据或 `extractCommitUuid`；不新增依赖（`node:sqlite` 是 Node 内置，本机 v24 已实核可用）；不新增 `.env` 开关；不动 `messages` 表 schema。

### 验收（可证伪）

- **B1 单测** `scripts/commit-uuid-gate.test.js`（vitest scripts 面 `**/*.test.js`）：C4 五态**逐条**一个用例，**用真实 SQLite**（临时库文件，承仓规「SQLite 用真的」——不 mock 数据库）。断言打「判决 + 输出含 uuid 原文」，不打布尔翻版。
- **B1′（承重反例）** 把「存在性查询」改成恒真 ⇒「查无此 id → 阻断」用例**必红**；实施者须**实跑报出红→绿**，不许只声称。
- **B2 真机挂钩（承记忆「hook env 实测须确认真实触发」）**：在**临时 git 仓库**内 `git commit` 两次取证 —— ① 假 uuid ⇒ 被拒；② `$CATSTUDY_TRIGGER_MSG_ID` 真值 ⇒ 通过。**要求确认 git 真的调起了 `commit-msg`**（以钩子自身打印的行为证，如一行 `[commit-uuid-gate] …`）。**不许**只用 `sh .husky/commit-msg <file>` 手工执行冒充——那不是「挂钩生效」的证据。
- **B3** `pnpm test` 全绿 + `pnpm lint` 绿。
- **B4 文档对齐**：`README.md` 提交约定段补一句「该 uuid 会被 `commit-msg` 门禁按 `messages` 表校验存在性，查无 ⇒ 提交被拒」；`.husky/commit-msg` 头注释写明判据 / 四态 / 出口。

**决策留痕**

- 跳 grilling：形态由事故判据反推（「假 uuid 要在提交那一刻被挡」），可选面窄且用户已裁 → 不单跑 grill。
- Gate B 契约：[边界 = 新增 1 脚本 + 1 钩子 + 1 测试 + 1 处文档 / 契约 = C1–C7 / 验收 = B1–B4] 已钉死。
- Gate C 反向证明：B1–B4 全绿能否反证「手打假 uuid 会被挡在提交那一刻」？B1 的「查无此 id → 阻断」用例与 B2 的真机假 uuid 提交被拒，是同一判据的**两个独立面**（单元 / 真机挂钩）⇒ 反证成立。**但只覆盖「假 uuid」这一类**；「真 uuid 但配错 commit 内容」不在本票面内（那是归属判据的事）。

## OQ（请审查者裁）

- **OQ-1** C4 的「两库都不存在 ⇒ 放行 + 警示」是否过松？反向方案 = fail-closed。店长判「放行」的理由：库缺席时判据**无主体**，而 fail-closed 会让新 clone / 无库环境的**每一次提交**都被拦，压力把人推向 `--no-verify` ——正是 `pre-push` 头注释点名要止住的形态。**但这条我置信度中等，判错我改。**
- **OQ-2** 严格 UUID 形状（`8-4-4-4-12` hex）是否过严？现有 `extractCommitUuid` 只要求 36 位 `[0-9a-f-]`。我判「严是对的」（形状错是手打的高置信信号），但若仓里有非 UUID 形状的合法消息 id，这条会误拦。
- **OQ-3** 是否该同时校验「该 uuid 至少有 1 条 `execution_logs` 行」？**我判不该**（C7），列出来是为了让你有机会反对。
- **OQ-4** `commit-msg` 之外是否还需 `pre-push` 侧兜底（防 `--no-verify` 绕过）？我判**不必要**——`--no-verify` 是显式逃生口，绕过者自负；再加一道会让「紧急提交」永远卡两道。

## spec-gate 复核（2026-09-13 · 吐槽猫）✅ 通过可派

承重声明**逐条实核**（非采信转述）：`defaultDbs` 已导出（`retire-message-memory.mjs:51`）、`messages.id TEXT PRIMARY KEY`、**worktree 无 `.db` 亲证**（本会话 worktree 的 `packages/server/data/` 只剩 `cat-study.log`）、`rev-parse --git-common-dir` 回主仓、`extractCommitUuid` 有 `isMain` 守卫（`:1902-1904`，import 安全）、`busy_timeout` 单次有界等待。另：**主库最近 60 条 `messages.id` 零条非 UUID 形状** ⇒ OQ-2 的误拦面实测为空。

### OQ 裁定（已关 —— 实施者照此办，勿再自行解释）

| OQ                              | 裁定         | 附条件 / 依据                                                                                                                                       |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 两库都不存在 ⇒ 放行 + 警示 | **维持放行** | 警示**必须走 stderr**，不许静默 `exit 0`；否则「判据无主体」会退化成「真通过」。fail-closed 拦的是环境不是提交，压力全导向 `--no-verify` ⇒ 门禁报废 |
| OQ-2 严格 `8-4-4-4-12` hex      | **维持严**   | 误拦面已实测定为空（主库 60 条零非 UUID 形状）                                                                                                      |
| OQ-3 是否同查 `execution_logs`  | **同意不查** | 手打真 id 但无执行 = 用户手动提交的合法形态，查了就是 C7 点名的误拦                                                                                 |
| OQ-4 是否加 `pre-push` 兜底     | **同意不加** | `--no-verify` 是 C5 定的唯一显式逃生口；双闸会让紧急提交卡两道                                                                                      |

### P3（采纳入库 —— 实施必做，不是可选）

`extractCommitUuid` 的正则**只认小写 hex**（`handoff-gen.mjs:807`）：message 里写**大写** uuid 时它返回 `null` ⇒ 落进 C4 第 1 态「无标记 ⇒ 放行」，**静默通过**。现实无害（`crypto.randomUUID()` 全小写；手打大写 uuid 无归属与现状一致），但 C4 表里那句「形状非法 ⇒ 阻断」会被读成已覆盖这种情况。

⇒ **`.husky/commit-msg` 头注释必须写明**：「标记提取沿用 `extractCommitUuid`，只认小写 hex；大写 uuid 视为**无标记**，走放行（无归属）」——**别让文档声称它拦不下的东西**。（**不改** `extractCommitUuid` 的正则：它服务投递面，见 C6。）

### P3-2（店长自查，同族 —— 实施必做）

C5 的出口文案写「uuid = 触发本次执行的**用户消息 id**」——**这句在 A2A 场景下不准确**。实测：本轮唤醒我的 `$CATSTUDY_TRIGGER_MSG_ID = 1e573984-…`，在 `messages` 表里 `role = "agent"`（是吐槽猫投来的 DM，不是用户消息）。门禁本身只查 `messages.id` 存在性、**不看 role**（判据正确），但出口给猫看的**提示语会把人引向「找一条用户消息」**——A2A 触发的提交按这句去找必然找不到。

⇒ 出口文案改为「uuid = **触发本次执行的那条消息 id**（用户消息或别的猫投来的 A2A 消息皆可）」。**判据不动**，只改提示语。

## 收口（2026-09-13 · 店长）✅ 已上远端

| 项            | 值                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被审对象      | `0d45e03`（**逐字节保留**——`git merge-base --is-ancestor 0d45e03 dev` = YES，已审 sha 在 dev 第一父链上；blob 哈希逐一相同）                                               |
| carrier       | PR **#66** → `ad8d41c8917f2a55a48bc1a15d3dee4da88568c6`                                                                                                                    |
| 三方          | `dev` = `origin/dev` = `.push-gate` = `ad8d41c`                                                                                                                            |
| 审查          | 吐槽猫复审 ✅（五态与四条 OQ 裁定全对齐；B1 五态 + B1′ 反例 + B2 真机挂钩实跑 **14/14 绿**；commit uuid `8f8830c5…` 独立查库证实；上一单遗留的 config 污染独立复核已复原） |
| closeout 分支 | `closeout/commit-uuid-gate` 远端**已删**（`ls-remote` 零命中）                                                                                                             |

**本 run 未清 —— 两条未闭观察项还住在这里**（清了就成暗知识）：

- **OQ-C（挂账）**：`.husky/` 四个钩子 git mode **全 `100644`**（Windows 实测已两证可调起：临时仓库 + 本仓真提交）。Linux 场景是**潜在需求**且三个既有钩子同病——不是本票引入。待真有 Linux 开发环境时四个一起 `git update-index --chmod=+x`。
- **OQ-D（判该立票 · 未获批派活）**：shell 出 git 的测试会**污染主仓 config**（`core.bare=true` / author 写错 / `--amend` 改 SHA），本单实施期已实证咬人（店长复原过一次）。同型隐患全仓任何 shell 出 git 的测试都有。修法倾向 `pre-commit` 跑测试前 `unset GIT_DIR`（一行、单点，比给每个测试 helper 洗 env 便宜）。**另注**：本仓 `core.bare` 污染**已复发 2 次**（长期记忆在案），不是新问题。

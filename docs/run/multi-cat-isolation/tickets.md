# 票：降级路径收窄（测试先行）T-1

> 归属：多猫并行隔离 · **降级路径**（会话 worktree 不可用时，收尾动作落主仓库）。
> **立票 2026-09-15**（用户裁决「A」= 收口后会话继续使用是期望行为 + 「先不实际改，先做测试，确保各种情况通过的情况下，再走正式改」）。
> **Phase 1（测试面）立即派活；Phase 2（生产改动）待 Phase 1 读数回报用户后派。**

---

## 结论先行

1. **收窄对象不是「判据」，是「降级目标」本身**——把 `?? process.cwd()` 这个兜底整体去掉。worktree 不可用 → **不动作 + 显式告警**，绝不落主仓库。
2. **用户裁决 A**：收口后会话继续被使用是**期望行为**（会话可复用，`reply.ts:976` 的 `ensureSessionWorktree` 重建本来就是幂等复用设计）。⇒ 因此**不加 `closed_out_at` 列、不加 dispatch 入口拦截**（用户：一个列区分不了「这一次收口」与「下一次收口」，且它不能解决问题 ⇒ 意义不大）。若将来要做，形态是**收口记录**而非会话上的一列，另单。
3. **本票是测试先行**：Phase 1 **只加测试、零生产代码改动**，把「各种情况」逐格跑通并留下**当前代码下的基线读数**；Phase 2 才动 `serial.ts`。

---

## 一、本单范围

### Phase 1（本票交付面）—— 场景矩阵 + 全绿基线

**硬约束：Phase 1 不得让任何测试变红。** `pre-commit` = `npx lint-staged; pnpm lint; pnpm test`（**全仓、无路径过滤**）——一条红就提交不了（本仓已实证：某猫连续 8 次提交全废）。因此：

- **回归面**（worktree 存在时的现有行为）→ 正常 `it(...)`，断言**当前行为**，绿。
- **目标行为面**（Phase 2 要改成的样子）→ 用 `it.fails(...)` 编码（vitest 语义：该用例**预期失败**即通过）。好处有两条：闸保持全绿；Phase 2 一旦改对，`it.fails` 会**主动报错**，强制把它翻回 `it` —— 改没改对由机制提示，不靠人记。（若实施猫选用别的等价机制，须在报告中说明「为什么闸仍是绿的」。）

**测试落点**：建议新增 `packages/server/src/execution/serial.downgrade.test.ts`（沿用本目录既有拆分先例 `serial.spans.test.ts` / `serial.flow-wiring.test.ts`；不往 `serial.test.ts` 里堆）。**新增文件 = 与任何在途改动零交集。**

### 场景矩阵（逐格必须有断言）

**维度 A — 降级点（2 个危险点，已 `git grep -n` 复核行号）**

| #   | 位置                                                | 现状                                                                                                                                    | 目标                                                                    |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ①   | `packages/server/src/execution/serial.ts:1149-1153` | `worktreeCwd` 为 null → `gitCommit(msg)` **无 cwd** → 落 `process.cwd()` = 主仓库根 → `git add -A` + commit **进主仓库当前分支（dev）** | 走 `ensureSessionWorktree()`（查+建）；建不出 → **不提交** + `log.warn` |
| ②   | `packages/server/src/execution/serial.ts:1199`      | `cleanCwd` 为 null → `process.cwd()` = 主仓库根 → 跑 `git checkout -- .` + `git clean -fd`                                              | 同上；建不出 → **不清理** + `log.warn`                                  |

**维度 B — worktree 不可用的成因（必须逐格覆盖，不能只测「目录不存在」这一格）**

`getSessionWorktreePath`（`packages/server/src/llm/git-utils.ts:448`）返回 null 有**三条**分支：`!mainRoot`（非 git 仓，`:450`）/ `!shortId`（会话 id 形态异常，`:452`）/ `!existsSync(wtPath)`（目录不存在，`:454`）。**外加** `ensureSessionWorktree`（`:379`）自身建失败返回 null（`:381` `:383` `:385` 与 `removeStaleWorktreeDir` 失败、建分支/建 worktree 失败）——这一格是 Phase 2 的目标形态，最容易漏。

**维度 C — 回归面（worktree 存在）**：三处动作的**现状行为**断言，防 Phase 2 改坏。

### Phase 2（**已派活** —— 2026-09-15，用户裁决「①派」）

`serial.ts` 两处（①②）同批改：`getSessionWorktreePath` → `ensureSessionWorktree`，去掉 `?? process.cwd()`。

**①② 必须同批。** 只改 ① 不改 ②：① 「不提交」留下的改动，会被 ② 的 `git checkout -- .` + `git clean -fd` 抹掉 —— **从「误提交」升级成「静默删除」**（误提交至少内容还在 git 里）。这是本单最硬的一条耦合。

**Phase 2 交付面（五条，缺一不可）**：

1. **① 收窄**（`serial.ts:1149-1153`）：`getSessionWorktreePath` → `ensureSessionWorktree`；建不出 → **不提交** + `log.warn`。**去掉 `?? process.cwd()`**。
2. **② 收窄**（`serial.ts:1199-1211`）：同上；建不出 → **不清理** + `log.warn`（**清理作用域不得落到主仓库**）。
3. **翻回 `it`**：Phase 1 的 4 个 `it.fails` 目标格改为 `it` —— 改对后 `it.fails` 会**主动报错**，这正是它设计的信号（G3）。
4. **补 B3 早期失败格**（OQ1）：`claudeRan` 为 true 但 worktree 未建（走到 `reply.ts:976` 之前抛错）⇒ 谓词是**三条**不是两条，补一格并把措辞按三谓词收窄。
5. **`cleanGitEnv()` 对称**（OQ4）：`beforeAll` 剥环境变量是进程级、`afterAll` 只还原 → 补对称。

**Phase 2 的两条新风险（本轮拍板时识别，实施者必须实测留痕）**：

- **R1 · `ensureSessionWorktree` 是同步阻塞的**（`execFileSync` 建分支 + `git worktree add` + `linkNodeModules`），而它现在要进的是 auto-commit 收尾路径（原本只跑 `git add -A`）。Windows 上建 junction 有实感耗时。**必须实测该路径耗时并留读数**——落在既有阻塞段内、量级可接受，但**不许拍脑袋说「应该没问题」**。
- **R2 · 「新建 worktree 后立刻跑 `git clean -fd`」是全新组合**。原先 ② 只在 worktree **已存在**时跑清理；收窄后会先 `ensure` 建一个再清理。须实测确认 `git clean -fd` **不会碰掉新 worktree 里的 `node_modules` junction 与包级链接**（理论上 `.gitignore` 命中即免删，但这是新路径，**要实测不能推断**）。

**`serial.ts:765` 裁决（Phase 2 是否纳入 —— 已裁：不纳入）**：保持**观察项**。理由三条：① 它只决定「审查兜底在哪投」，**不改动任何 git 状态**——实害量级与 ①②（误提交 / 静默删除）不同；② Phase 1 读数未提供纳入理由（两条路在 dev.js 形态下殊途同归）；③ 审查 cwd 会被 **T-2 整体重设计**（一次性 detached worktree），现在改它 = 改两遍。**观测点**：T-2 落地时重新评估。

---

## 二、Out of Scope（明确不做）

- **`closed_out_at` 列 / sessions 表改动 / dispatch 入口拦截**——用户裁决 A 后**不做**（理由见「结论先行」第 2 条）。
- **`serial.ts:765`（审查兜底 cwd）**——**从「三处降级点」降级为观察项**，见「§三 纠正」第 1 条。**已裁：Phase 2 不纳入**（理由与观测点见 §一 Phase 2 末段）。
- **一猫一 worktree 隔离（T-2）与 no-ff 合并策略（T-3）**——本活的设计树已定，但**另票另派**，见 §五。
- **`git add -A` 收整个工作区的跨猫误提交根修**——同属 T-2 的 B 项（限定提交范围），不并入本票。

---

## 三、我上一轮说法里的三处纠正（本轮实测，**别再按旧口径实施**）

1. **`serial.ts:765` 不是「降级到主仓库」的缺陷。** `spawnReviewFallback`（`packages/server/src/execution/review-fallback.ts:137`）自带兜底工作区 `existsSync(cwd) ? cwd : resolve(script, '..', '..')`——`script` = `scripts/handoff-gen.mjs`，其仓库根**就是**主仓库根；而 `dev.js:266` 把 server cwd 设为 `ROOT`，所以 `process.cwd()` 也是主仓库根。**两条路殊途同归 ⇒ dev.js 形态下实害为零。** 真问题只在 `dev:server` 形态（cwd = `packages/server`，`existsSync` 为真反而绕过兜底，`--cwd` 落子目录）。⇒ **观察项，非本票交付面。**
2. **worktree 不可用时 CLI 的 cwd 不是主仓库根，是 `mainRoot/workspace/`。** 各适配器一律 `options.cwd ?? getWorkspaceDir()`（`claude.ts:221` / `dsh.ts:247` / `opencode.ts:310` / `pi.ts:107`），`getWorkspaceDir()`（`llm/cli-utils.ts:28`）= `process.cwd()/workspace`，且 `workspace/` 在 `.gitignore:38` **已忽略**。
3. **⇒ 兜底的爆炸半径集中在两处，且 ② 的实害不是「清理 workspace/」，是「回滚主仓库整棵树」**：
   - ① `git add -A` + commit → **提交进 dev，绕过审查链**；
   - ② `git checkout -- .` → **回滚主仓库全部 tracked 文件的未提交改动**（含店长在 dev 上的在途工作）；`git clean -fd` → **删除主仓库未跟踪且未被忽略的文件**（`workspace/` 因被忽略而不受影响，所以「脏文件累积」不是本处的病）。

---

## 四、验收标准（逐条可执行，实施者须逐条留痕）

- **G1 矩阵齐**：维度 A × 维度 B 逐格有测试（不是只测「目录不存在」一格）。
- **G2 回归面绿**：worktree 存在时 ①② 的现有行为断言（提交进 worktree / 清理作用域 = worktree），正常 `it`，**绿**。
- **G3 目标面以 `it.fails` 编码**：① 「建不出 → 不提交、主仓库零改动」② 「建不出 → 不清理、主仓库零改动」。
- **G4 红线格**：主仓库存在未提交的 tracked 改动 + `depth===0` 收尾跑一轮 → **留当前读数**。**判词已按实测改判**（审查 OQ2 裁定成立，原票面口径不成立）：
  - **G4a**：原票面写「预期：改动被回滚」——**错**。① 先跑且 `gitCommit` 无 cwd ⇒ 改动被提交进**主仓库当前分支**，实害是**绕过审查链的提交**，不是回滚；
  - **G4b**：① 不提交时（或无可提交内容），② 的 `git checkout -- .` 才回滚主仓库 tracked 改动 —— **G4b 才是 Phase 2 的真红线**。只让 ① 停手 = 把「误提交」升级成「静默删除」，Phase 2 改 ① 时必须同步看 G4b。
- **G5 闸绿**：`pnpm lint` + `pnpm test` **全绿**（Phase 1 硬约束，见 §一）。
- **G6 零生产改动**：`git diff --name-only` 只含测试文件（+ 本票若需微调）。**不得改 `serial.ts` / `git-utils.ts` 任何一行。**
- **G7 覆盖边界自陈（防「假绿门」）**：报告须写明**每条断言覆盖什么、不覆盖什么**。本仓已栽过「judge 扫消息 content 却 grep 工作区文件 = 恒真的假绿门」——**验证面必须与被判面同面**。若用 mock 协作方（`git-utils` 属被测模块的协作者，可 mock）断言「没调用」，必须说明它**证不了**「主仓库文件真的没动」。

---

## 四之二、Phase 1 结果（已收口，`33e7d51`）

**提交**：`947dece`（矩阵本体）+ `915ce6a`（注释行号修正）——1 文件 / 618 行，`serial.ts` / `git-utils.ts` / `reply.ts` **一行未动**（G6 ✅）。

**读数**（审查者隔离复跑与店长落盘快照复跑**逐字一致**）：`10 passed | 4 expected fail (14)`，6.29s。

| 格            | 结论                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| G1 矩阵齐     | ✅ 2 降级点 × 4 不可用成因逐格独立断言，无一格压成注释                                                                |
| G2 回归面     | ✅ 维 C：worktree 存在 ⇒ 提交落 worktree、清理作用域 = worktree，走真 `it`                                            |
| G3 目标面     | ✅ 以 `it.fails` 编码——Phase 2 改对后它会主动报错，**强制翻回 `it`**，不靠人记                                        |
| G4 红线锚     | ⚠️ **判词改判**（见 §四 G4a/G4b），读数已留                                                                           |
| G6 零生产改动 | ✅                                                                                                                    |
| G7 覆盖边界   | ✅ `anyClaude` 耦合**自带金丝**：三处绿格要求 ② 真动手，provider 被改回 deepseek 时**会响**，静默变空需同时改三处断言 |

**两条并入 Phase 2 范围**（审查 OQ1 / OQ4，已裁）：

1. **B3 可达性谓词是三条，不是两条。** 目标格在当前形态下不可达成立；但存在一条窄缝——走到 `reply.ts:976`（建 worktree）**之前**抛错（parse/上下文准备失败进 catch）时，`claudeRan` 已为 true 而 worktree 未建 ⇒「早期失败」窗口可达。**Phase 2 补一格**，并把 B3 措辞按三谓词收窄。
2. **`cleanGitEnv()` 不对称**：`beforeAll` 剥环境变量是**进程级**、`afterAll` 只还原。本仓 vitest 单文件一进程，现状无碍，Phase 2 一并收。

**P3 残留（不阻塞）**：OQ5 环境残留只活在测试进程内。

---

## 五、Roadmap（设计树已定，逐票派，**不并行**）

用户本轮四问四答，设计树闭合：

| 节点              | 裁决              | 内容                                                                                                                                                                                                                                  |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 合并策略       | **B**             | 收口改真 merge（`--no-ff`）——仓里远端 dev 本来就是 merge commit 形态；**排除 cherry-pick**（审的 sha ≠ 落的 sha，撞链锚契约）。须补 `mergeSession` 幂等（`session-closeout.ts:97` 明写注释依赖 ff-only 的「Already up to date」幂等） |
| Q2 auto-commit    | **A + B**，不做 C | A = 降级路径收窄（**本票**）；B = 限定提交范围（随 T-2 走）；C = 彻底删（不做——它与脏检查配对，`git add -A` 收进 index 后 `checkout -- .` 才能从 index 恢复，删它会让未提交改动**静默消失**）                                         |
| Q3 审查猫隔离     | **B**             | 审查走**一次性 detached worktree**（`git worktree add --detach <tmp> <sha>` → 审完 remove），零常驻成本，且天然满足「审阅态禁 commit」                                                                                                |
| Q4 收口后会话续用 | **A**             | 是期望行为 ⇒ 走 `ensureSessionWorktree` 重建，**不**加拦截                                                                                                                                                                            |

**派活顺序（串行，非可选）**：T-1（本票）→ T-2 一猫一 worktree 隔离（ADR 级：分支模型 `session/<sid>/<cat>`、43 个存量 worktree 处置、审查一次性 worktree、auto-commit 限定范围）→ T-3 no-ff 合并策略 + 幂等（依赖 T-2 的分支模型，否则重写）。

**为什么必须串行**：本仓 pre-commit 是**全仓无路径过滤**闸，而**会话内多猫共用一个 worktree**（`git-utils.ts:379` `ensureSessionWorktree` 按 `sessionId` 取路径）——「文件零交集」在这个前提下**不构成并行，只构成互相拖死**（R3 派活已实证：某猫连试 8 次全废）。T-2 落地前，一轮只派一只实施猫。

**我上一轮拍错过一次**，记在这里：我按「文件零交集 ⇒ 可并行」派了 R3 的 §A/§B 两猫，代价是其中一只 6 分钟全废。**这个判断是错的**——闸的作用域是仓，不是票。

---

## 六、提交纪律

- 提交信息 `catstudy [uuid]`，uuid 取 `messages` 表内**真实存在**的触发消息 id（`commit-msg` 门禁校验；**不得**编造合法格式 uuid）。
- `git add <具体路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`；**勿 `git add -A`**（会扫走他猫未提交的文件——本仓已有三次实证）。
- 票面行号提交前用 `git grep -n`（**字节路径**）复核——PS 文本管道在 UTF-8 无 BOM 源码上会给**反向错位假读数**。
- **卡住或票面自相矛盾 → 报店长裁，不自行改判。**

---

## 决策留痕

### 为什么 A 是「去掉兜底」而不是「加判据」

用户点破了一条我没想透的：**一个 `closed_out_at` 列区分不了「这一次收口」与「下一次收口」**——而本仓的工作流恰恰是**反复收口**（本会话自己就是活样本：收口多次，之后继续派活，`reply.ts:976` 每次都把 worktree 重建）。所以：

- 拿「已收口」当拦截判据 → 会把**正常工作判成异常**；
- 拿「目录不存在」当判据 → 把两类语义相反的东西合并了（「从未建过 worktree 的存量会话」的降级提交**是设计内的**，`serial.ts:1150-1152` 注释明写「行为与现网一致」；「已收口的会话」才是要拦的），**没有中间态**。

⇒ 真正的病根是 **`?? process.cwd()` 这个翻译本身**：它把「worktree 不可用」**静默翻译成「在主仓库干」**。去掉这个翻译，两类情形都自然收敛到「不动作 + 告警」。

**定性（重要，决定票面怎么写）**：这**不是「改设计」，是「补一个原作者没设想到的类别」**——原实现设想的是「存量会话」一类，分类里没有「已收口」这一类。

### 本单性质

`serial.ts:1150-1152` 的降级提交是**有意设计**，不是 bug；本票改的是**它的边界**。之所以立单，是因为它的失败模式是**静默且不可逆**的（回滚别人未提交的工作 / 把改动提进 dev 绕过审查链），而触发窗口虽然窄但存在：收口删 worktree 后 + 用户发消息时猫正忙（`execute()` 忙时入队即返回，收尾 auto-commit 立刻跑，而 `ensureSessionWorktree` 要等猫真开跑才建）。

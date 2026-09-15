# T-2 Phase T 实施留痕 —— 仓内原语与测试

> 票面：`docs/run/multi-cat-isolation/tickets-t2-phase-t.md` @ `21b8f69`
> 设计依据：`adr-0015-draft.md`（accepted）。
> 上游：Phase S（`sim-report.md`）12 格模拟勘验 —— **本票不重跑模拟**，把那些格搬进仓内。

---

## 结论先行

1. **21 格全绿 / 114 断言**，`pnpm lint` 3 包 + `pnpm test` **119 文件 / 2413 测试**（2392 + 21 格）。
2. **零接线**：`session-closeout.ts` / `serial.ts` / `reply.ts` / `registry.ts` **一行未动**（§五 V5）。
3. **既有测试零改动**：`git-utils.test.ts` 本次是 **130 增 / 0 删** —— 骨架抽取的「零行为变化」由这条自证（§五 V4）。
4. **三条反向对照全部做真变异验证**（不只是写在测试里）：把实现改坏 → 判据确实变红，读数见 §三。
5. **发现并**主动上报**三处需店长裁的事项**（§四）：两处票面路径漂移、一处契约未覆盖的形状选择。
6. 顺带**撤销一条我自己以为的缺口**：契约未提的「嵌套 ref 会被通配符误收」经实测**不成立**（`*` 不跨 `/`），故不报（§四·4）。

---

## 一、交付面

| 文件                                             | 动作 | 行数                                                                                                                                       |
| ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/server/src/llm/worktree-fanin.ts`      | 新建 | 6 个导出 / 5 个函数（`FanInResult` / `listCatBranches` / `hasMergeInProgress` / `isAncestor` / `fanInCatBranches` / `reclaimCatBranches`） |
| `packages/server/src/llm/git-utils.ts`           | 扩展 | +127 / −27（抽骨架 `ensureWorktreeAt`；新增 `catBranch` / `catWorktreePath` / `ensureCatWorktree`；导出 `cleanupWorktreeResidue`）         |
| `packages/server/src/llm/worktree-fanin.test.ts` | 新建 | B/C/D 组 16 格                                                                                                                             |
| `packages/server/src/llm/git-utils.test.ts`      | 扩展 | A 组 5 格（**纯新增，0 删**）                                                                                                              |

**Map Delta**：新增 2 文件、扩展 2 文件；**无模块边界变化**，无依赖方向变化（`worktree-fanin.ts` → `git-utils.ts` 单向，与 `session-closeout.ts` 同向）。

---

## 二、21 格读数

### 组 A · 命名与建立（`git-utils.test.ts`，28 断言）

| #   | 格         | 断言数 | 读数                                                                                                                                                                                                                |
| --- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 命名纯度   | 6      | `catBranch('abcd1234', <uuid>)` = `session/abcd1234-1564934c`；叶子名内零 `/`；**E1 回归实证**：先建 `session/e1slash1` 后 `git branch session/e1slash1/catA` **确实抛错**，连字符形 `session/e1slash1-catA` 建成功 |
| A2  | 建立与共存 | 7      | 会话 worktree 与猫 worktree 路径不同、两者 `.git` 标记均在；两条分支 ref 同时存在                                                                                                                                   |
| A3  | 分叉点     | 6      | 先造 C1（集成分支起点）再把主 HEAD 推到 C2 ⇒ 猫分支 tip = C1 而**非** C2；与主 HEAD 的 merge-base 仍是 C1                                                                                                           |
| A4  | 重复建幂等 | 3      | 第二次返回同一路径，`.git` 标记仍有效                                                                                                                                                                               |
| A5  | 失败形态   | 6      | 集成分支不存在 ⇒ **null**（不是主仓库、不是任何可用路径）；猫分支未建、目录未落盘；空 agent id ⇒ null                                                                                                               |

**A3 的对照设计**：若只造一个提交，「分叉自集成分支」与「分叉自主 HEAD」结果相同 ⇒ 判据恒真。故**刻意把主 HEAD 推前一个提交**，让两种分叉点可区分。

### 组 B · 枚举（`worktree-fanin.test.ts`，14 断言）

| #   | 格             | 断言数 | 读数                                                         |
| --- | -------------- | ------ | ------------------------------------------------------------ |
| B1  | 通配前缀命中   | 3      | 乱序创建 3 条 ⇒ 返回**排序后**的 3 条；**V3 反向对照**见 §三 |
| B2  | 空集           | 3      | 无猫分支 ⇒ `[]`，不抛错；换一个不存在的前缀同样 `[]`         |
| B3  | 不误收会话分支 | 2      | `session/<sid8>` 本身不在结果里                              |
| B4  | 不误收旁支     | 2      | `session/<sid8>catC`（无连字符）不在结果里                   |
| B5  | 过滤空 cat8    | 2      | `session/<sid8>-`（S3-5）不在结果里                          |
| B6  | 确定性         | 2      | 乱序建 5 条 ⇒ 两次调用结果一致且等于排序序列                 |

### 组 C · fan-in（47 断言）

| #   | 格           | 断言数 | 读数                                                                                                                |
| --- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| C1  | 按序 no-ff   | 8      | `merged` = `[catA, catB]` 按序；**读实际文件验内容在场**（非只看 exit 0）+ 已知不在场文件反对照                     |
| C2  | 整链幂等     | 6      | 重跑 ⇒ `merged` 空、`skipped` 两条、HEAD 不变、commit 数不变                                                        |
| C3  | 空合并       | 8      | 零提交猫分支 ⇒ `skipped`；**merge commit 数 +1（只 catA 那一笔）**；对照：catB 真提交后 merge commit 数 +2          |
| C4  | 冲突守卫     | 11     | `conflict:true` + `recovered:true`；`MERGE_HEAD` 消失、`status` 干净、catA 成果仍在场；**再跑仍冲突**（不是卡死）   |
| C5  | 半合并态入口 | 11     | 预置 `MERGE_HEAD` ⇒ **一条都没合**、不自行 abort、仓库态不变；**AA 与 UU 并存实测**；对照：abort 后同一调用走完循环 |
| C6  | cwd 守卫     | 3      | cwd 检出 dev ⇒ **抛错**且未合任何东西；对照：切到集成分支后同一调用不抛                                             |

**C3 的一处算术修正（写进代码注释防复发）**：`git rev-list --count` 数的是**可达提交**，不是线性深度 —— 合一条带 1 个提交的分支 = **+2**（猫的提交 + merge commit）。故「空合并不造垃圾 commit」的主判据改用 `rev-list --count --merges`（+1 vs +2），总数断言作辅证。

**C5 的一处语义澄清**：手动 merge 会**推进集成分支 ref**（HEAD 就在该分支上）⇒ `merge --abort` 后 `session/<sid8>` 停在那笔 merge commit 上 ⇒ catA 变成它的祖先、进 `skipped`。「入口即返」与「真的跑了」的区分字段是 `skipped` 非空 + `recovered:true`（前者形状是双空 + `recovered:false`）。

### 组 D · 回收（25 断言）

| #   | 格         | 断言数 | 读数                                                                                                                         |
| --- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| D1  | 回收已合   | 6      | 分支 ref 消失、worktree 目录消失；集成分支本身不受影响；先验「集成分支 ff 进 dev 后猫的内容确实在 dev 上」                   |
| D2  | 未合不回收 | 7      | 未合猫分支 + 其 worktree **双双留存**（含内容可读）；`reclaimed` 只含已合的 catA；**V3 反向对照**见 §三                      |
| D3  | 孤儿分支   | 5      | worktree 被外力删掉后分支仍可枚举，且能被回收                                                                                |
| D4  | 自指守卫   | 7      | cwd 在猫 worktree 内 ⇒ **物理清理被跳过**（`cleanupWorktreeResidue` 零调用）而 git 层照做；反向对照：cwd 在外 ⇒ 清理确实触发 |

---

## 三、V3 反向对照 —— 三条全部做**真变异验证**

票面要求「先让它红一次」。我把实现改坏、跑测试、记录红在哪，再还原。**这不是写在测试里的对照，是实测读数。**

| #    | 变异                                                                | 结果               | 红的落点                                                                                                      |
| ---- | ------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| V3-1 | `listCatBranches` 的 pattern 去掉 `*`（回到 S3-1 票面原文的裸前缀） | **14 格红 / 2 绿** | **B1 首红** —— 正是该红的那条。这就是 S3-1 的静默空集形态：枚举 0 条 ⇒ 循环 0 次 ⇒ 零报错                     |
| V3-2 | `fanInCatBranches` 主循环空转（不执行 `merge`）                     | **9 格红**         | **C1 红在 `expected null to be 'PAYLOAD-CAT-A'`** —— 「读内容」判据抓得住「exit 0 但什么都没进来」（E5 同族） |
| V3-3 | 拆掉 `reclaimCatBranches` 的「未合分支绝不回收」守卫                | **D2 独红**        | 红在 `expected null not to be null` —— 即 catB 的**分支 ref 已被删除**（活没了），直指要害                    |

**V3-3 的一处判据改进（实测驱动）**：首轮变异时 D2 红在 `reclaimed` 数组深比较（`expected [catA, catB] to deeply equal [catA]`）—— 红是红了，但指向的是「返回值不符」而不是「活被误删」。故把**存活断言（分支 ref + 目录 + 内容）前移到深比较之前**，让判据被破坏时先响的是「活没了」这件事本身。改后复跑变异，红落点变成 `expected null not to be null`。**这条改进只有跑了变异才发现。**

还原核验：三处变异逐条还原后复核（含 `*` / `merge` 调用 / 守卫三者均在、无 `MUTATED` 残留标记），37 格全绿。

---

## 四、需店长裁 / 主动上报

### 1. ⚠️ 票面两处**路径漂移**（不是我的实现选择，是票面写错）

| 票面写                             | 实际位置                                                 | 出处              |
| ---------------------------------- | -------------------------------------------------------- | ----------------- |
| `serial.downgrade.test.ts:130-134` | `packages/server/src/execution/serial.downgrade.test.ts` | 票面 §五 红线 1   |
| `reply.ts`                         | `packages/server/src/execution/reply.ts`（非 `llm/`）    | 票面 §四 V5、§1.2 |

两处都是**漏了包路径/包名写错**，文件本身存在。**V5 的零接线核验我按实际路径做的**（四条路径逐一确认存在后取 `git diff`，避免空判）。按红线 6「矛盾只报不改」，我没动票面。

### 2. ⚠️ 契约未覆盖的一处**形状选择**：worktree 路径怎么找

契约 §2.2 只说 `reclaimCatBranches` 回收「猫 worktree + 猫分支」，**没说怎么从分支名找到 worktree 路径**。我选了 `git worktree list --porcelain`（git 自己的账本），**不做字符串推导**（`session/<sid8>-<cat8>` 反推目录名在命名规则变动时会**静默指错路径**，而下游是删除操作）。detached worktree 无 `branch` 行 ⇒ 天然不进映射，不会误删。Phase S 的模拟脚本用的是显式映射表（脚本里没有这个函数），故此处无先例可循。

### 3. ⚠️ 超出契约 §1.1 清单的一处**导出**：`cleanupWorktreeResidue`

契约 §1.1 只列了 `catBranch` / `catWorktreePath` / `ensureCatWorktree` + 抽骨架。我把 `cleanupWorktreeResidue`（原私有）**改成导出**供 `reclaimCatBranches` 复用，理由与骨架抽取同款：那段「链接先删 + 复核无链接才 recursive 清扫」是「删 symlink 绝不跟随」的唯一承载点，**第二份拷贝漂移一次就是删穿主仓库 `node_modules`**。这是**新增导出、零行为变化**（无调用点改动）。同一理由也适用于骨架里**我多抽了 `linkNodeModules` 调用**（契约列的三步是「复用 / 建分支 / `add`」，链接是建 worktree 的第四步，两处都需要）。

### 4. ✅ 撤销一条我自己以为的缺口（**实测推翻，故不报**）

我一度准备上报：「`*` 可能跨 `/` ⇒ `session/<sid8>-catA/sub` 这种嵌套 ref 会被枚举命中，fan-in 会把别的分支树合进来」。**仓外临时仓实测不成立**：`for-each-ref 'refs/heads/session/abcd1234-*'` 对 `refs/heads/session/abcd1234-catA/sub` **零命中**（git 的 pattern 不跨 `/`）。⇒ 契约只过滤空 cat8 是**够的**，我没有加额外过滤。记这一笔是因为它正是本会话反复栽的形态：**「证明不存在」型断言必须先钉死谓词再证**。

### 5. 观察项（非缺口，Phase I 接线时留意）

- **`isAncestor` 无法区分「不是祖先」与「ref 不存在」**（都是 `merge-base --is-ancestor` 退出码非 0）。在 `reclaimCatBranches` 里无害（ref 来自当场枚举）；在 `fanInCatBranches` 里若**枚举与合并之间**他进程删掉了该猫分支，会走 merge 失败 → 被记成 `conflict:true`（实为无冲突）。需并发删分支才触发，低概率、且失败是显式的（不会静默误合）。
- **`cwd` 与 `process.cwd()` 是两个东西**：`fanInCatBranches`/`reclaimCatBranches` 的 `opts.cwd` 是「git 在哪跑」，自指守卫判的是「**进程**站在哪」（`process.cwd()`）。这与既有 `removeSessionWorktree` 一致，**是有意的**：Phase I 收口时进程在会话 worktree 内、而 git 命令 cwd 指定主仓库，守卫仍须生效。

---

## 五、验收判据逐条

| #   | 判据                          | 读数                                                                                                           |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| V1  | 矩阵齐（21 格逐一有实跑读数） | ✅ A1–A5 / B1–B6 / C1–C6 / D1–D4 全绿，无一格压成「同上」                                                      |
| V2  | 闸绿 + 测试用普通 `it`        | ✅ `pnpm lint` 3 包；`pnpm test` **119 文件 / 2413 通过**；本票**零 `it.fails`**（`git grep -c it.fails` = 0） |
| V3  | 三条反向对照                  | ✅ **全部做真变异验证**，读数见 §三                                                                            |
| V4  | 既有测试零改动                | ✅ `git-utils.test.ts` **130 增 / 0 删**（`git diff --numstat`）；`serial.downgrade.test.ts` 零改动            |
| V5  | 零接线                        | ✅ 四调用点 `git diff --stat` **空**（路径按实际位置核，见 §四·1）                                             |
| V6  | 覆盖边界自陈                  | ✅ 见 §六                                                                                                      |
| V7  | 缺口回报                      | ✅ 见 §四                                                                                                      |

---

## 六、覆盖边界自陈（V6）

### 本票**证了**什么

- 枚举前缀边界（含空集、空 cat8、旁支、别的会话、确定性）
- fan-in 的合并内容在场、整链幂等、空合并不造垃圾 commit、冲突守卫与恢复、半合并态拒绝、cwd 守卫
- 回收的「只回收已合」「孤儿分支可回收」「自指守卫跳过物理清理」
- 命名约束的真实性（斜杠形建不出来）、分叉点是集成分支（非主 HEAD）、建立幂等与失败形态
- **骨架抽取零行为变化**（既有测试零改动且全绿）

### 本票**证不了**什么（显式声明）

1. **证不了 Phase I 的接线顺序** —— 本票零调用点（V5），「谁在什么时机调 fan-in、reclaim 排在收口链第几步」全部未验。票面 §1.2 明确把它划给 Phase I。
2. **证不了与 `closeoutSession` 的组合行为** —— `mergeSession`（ff-only）/ `removeSessionWorktree` / writeGate / checkoutDev 与 fan-in 的先后与幂等交互未测；本票只保证 fan-in 自身在集成分支上的行为。
3. **证不了多进程并发** —— 全部用例单进程串行。§四·5 的 `isAncestor` 竞态属此类。
4. **证不了真实 `catStudy-sessions/` 布局** —— 测试用 `<mkdtemp>/wt/` 下的 worktree（raw `git worktree add`，无 `node_modules` junction）。故 **D1/D3/D4 的「目录被删净」不含 junction 残留场景**；junction 安全清理已由 `git-utils.test.ts` 既有的两个用例独立覆盖（`removeSessionWorktree` / 残留重建），本票复用同一实现而非重测。
5. **D 组只验了 `integrationRef = session/<sid8>` 一种形态** —— 契约把它做成参数正是为了覆盖 Phase S 遗留的中间态（「已合进集成分支、但集成分支尚未 ff 进 dev」）。传 `dev` 的形态未测。
6. **未做性能评估**（票面 §1.2 明示 Out of Scope）。
7. **未覆盖 Windows EPERM 路径** —— D4 用 `cleanupWorktreeResidue` 的代理 mock 判定守卫决策，而非依赖「平台相关的目录是否真被删掉」（win32 因 cwd 句柄失败、Linux 成功）。**这是刻意的**：靠目录存在与否会得到平台相关的假读数。

---

## 七、Quality Gate Report

- **Vision Check** ✅ 票面 §二契约逐条落地；无范围蔓延（未接线、未改 `session/<sid>` 语义、未做存量迁移、未碰 pre-commit、未评估性能）
- **Standards Check** ✅ 风格从既有 `git-utils.ts` / `session-closeout.ts`（`runGit` 参数数组 + `cleanGitEnv`）；无新增告警
- **Test Evidence** ✅ `pnpm lint` 3 包；`pnpm test` 119 文件 / 2413 通过 / 0 失败；单文件复跑 37/37
- **Architecture** ✅ `worktree-fanin.ts` → `git-utils.ts` 单向依赖；无跨包引用；无循环
- **Security** ✅ 无密钥、无 `eval`、无 SQL、无 shell 拼接（全部 `execFileSync` 参数数组）
- **Unfinished Business** ✅ 无 TODO/FIXME；临时仓全在系统 temp 且已删净（复核：`<tmpdir>/catStudy-sessions/` 空、无 `wt-fanin-test-*` 残留）
- **Two-Axis** ✅ Standards 轴：无 TS 规范面违规；Spec 轴：21 格 + V1–V7 逐条对账
- **Smell Sweep** ✅ 无命中（无长函数堆砌、无重复实现——骨架与残清清理都是**抽取**而非复制、无注释掉的代码）
- **Gate Result：✅ PASS**

---

## 八、红线逐条

| #   | 红线                           | 执行                                                                                                                                                      |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 测试出 git 先剥注入变量        | ✅ 两个测试文件各自 `cleanGitEnv()`（与 `git-utils.ts:51` 同款），所有 `execFileSync` 均带                                                                |
| 2   | 临时仓建系统 temp              | ✅ `mkdtempSync(join(tmpdir(), 'wt-fanin-test-'))`；猫 worktree 落 `<tmpdir>/catStudy-sessions/`（由 `ensureCatWorktree` 路径公式决定，非仓库根）         |
| 3   | 不 `git add -A`、不用 `--only` | ✅ 见 §九                                                                                                                                                 |
| 4   | 不 push                        | ✅ 未推送（收口归店长）                                                                                                                                   |
| 5   | 不碰任何调用点                 | ✅ V5                                                                                                                                                     |
| 6   | 删 symlink 绝不 recursive 跟随 | ✅ 复用 `cleanupWorktreeResidue`（链接先行 + 复核守卫），未新写任何 recursive 删除                                                                        |
| 7   | 开工前确认无并发实例           | ✅ `git status` 干净 + `execution_logs` 查同 agent 时间窗：本 agent 前两条执行（14:32:03 / 14:33:10）均 `ended`，与本轮（15:08:18 起）**无重叠** ⇒ 无并发 |

---

## 九、提交

`git add <四个具体路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`。uuid 取 `messages` 表内真实存在的触发消息 id。

**本票零 `packages/` 行为改动（新函数无调用点）⇒ 不触发重启**；但**新增了 server 源文件**，若店长判断需重启请照常发审批。

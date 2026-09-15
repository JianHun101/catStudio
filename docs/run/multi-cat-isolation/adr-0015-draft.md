---
type: decision
date: 2026-09-15
status: proposed
evidence:
  - kind: file
    ref: packages/server/src/llm/git-utils.ts
  - kind: file
    ref: packages/server/src/execution/serial.ts
  - kind: file
    ref: packages/server/src/llm/session-closeout.ts
  - kind: file
    ref: packages/server/src/execution/reply.ts
  - kind: file
    ref: docs/run/multi-cat-isolation/tickets.md
---

# （草案）ADR 0015: 一猫一 worktree——把「并行」从纪律变成结构

> **本文件是草案，不是定稿 ADR。** 落点为 `docs/run/`（在飞区），**待用户确认后**上浮为 `docs/adr/0015-per-cat-worktree-isolation.md`（`status: accepted`）。
> 放这里而非 `docs/adr/` 是刻意的：`docs/adr/` 不在 handoff 免审白名单（`scripts/handoff-gen.mjs:357` `REVIEW_EXEMPT_PREFIXES = ['docs/run/']`），提交即触发独立审查轮——而本设计**尚未经用户拍板**，确认前不派活（用户 2026-09-15 明示「出 ADR 确认后再派」）。
>
> **Status**: **proposed**（2026-09-15 店长起草，**待用户确认后派活**）。
> **前置**：T-1（降级路径收窄）已收口，`serial.ts` 不再把「worktree 不可用」静默翻译成「在主仓库干」。本 ADR 在其上处理**粒度**问题。
> **范围**：本 ADR 只定**隔离模型**（分支/worktree 粒度、命名、审查侧形态、存量处置）；**合并策略（no-ff）+ 幂等** 归 T-3，本文只标出接口。
> **上游问题**：用户 2026-09-15 提出「一个会话一个猫一个 worktree」；grilling 四问已闭环（Q1=B 合并策略、Q2=A/B auto-commit、Q3=B 审查侧隔离、Q4=A 收口后会话可继续使用）。

## 1. 背景与摩擦（全部为实测实证，非推演）

现状：**一个会话一个 worktree**（`git-utils.ts:379` `ensureSessionWorktree`，分支 `session/<shortId>`，路径 `<主仓库>/../catStudy-sessions/<shortId>`），**会话内多猫共用同一物理目录**。由此咬合出四条摩擦：

| #   | 摩擦                                                                                                                                                  | 证据                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **跨猫误提交**：`git add -A`（`git-utils.ts:167`）收整个工作区 ⇒ 别猫未提交的改动被按**提交者自己的 uuid** 收走                                       | 三次实证（`f710ac7` 等）。`git-utils.ts:181-184` 的 catch **不回滚索引**，且文案 `auto commit skipped (no changes)` **恒真**——钩子红被记成「没改动」 |
| F2  | **pre-commit 互锁**：`pre-commit` = `npx lint-staged; pnpm lint; pnpm test`，**全仓、无路径过滤** ⇒ 一猫的红**必然**挡死另一猫                        | R3 派活期间 §A 实施猫**连续 8 次提交全废**、跨约 6 分钟，失败面完全稳定                                                                              |
| F3  | **审查面 ≠ 被判面**：审查猫跑测试跑的是**工作区**，而工作区里可能躺着别人的未提交文件 ⇒ 绿/红是**混合态**的颜色                                       | R3 §B 受审时，工作区里同时躺着 ds猫 未提交的 §A 三文件                                                                                               |
| F4  | **脏检查抹别猫**：执行后清理 `git checkout -- .` + `git clean -fd`（`serial.ts:1261`/`:1266`）作用域是**整个会话 worktree**，注释却写「本次执行遗留」 | 与 F1 是一枚硬币两面：一个把别人的改动收走，一个把别人的改动抹掉                                                                                     |

**F2 是关键判据**：它证明「票面文件零交集 ⇒ 可并行」这个判断**不成立**——pre-commit 是**仓级作用域、不是票级**。在共用 worktree 下，「零交集」不构成并行，只构成**互相拖死**。

## 2. 判定

> **隔离的独特价值，是把「并行」从纪律变成结构。**

必须诚实区分：四条摩擦里，**只有 F1/F2/F4 与粒度有关，F3 与粒度无关**。

| 摩擦 | 靠「串行派活」能解？ | 靠「一猫一 worktree」能解？ | 靠「一次性 detached 审查 worktree」能解？ |
| ---- | -------------------- | --------------------------- | ----------------------------------------- |
| F1   | ✅（无并发即无共写） | ✅ 结构性                   | ❌                                        |
| F2   | ✅                   | ✅ 结构性                   | ❌                                        |
| F3   | ❌                   | ❌                          | ✅                                        |
| F4   | ✅                   | ✅ 结构性                   | ❌                                        |

⇒ **「一轮一只猫」是用纪律买到同样的安全，代价是放弃并行。** 本 ADR 选择**结构**：不依赖「店长记得别并发」这条纪律——本轮已经证明过这类纪律会失守（我按「零交集」派了并行，代价是 6 分钟全废）。

## 3. 决策

### D1 · 粒度：worktree 与工作分支从「按会话」改为「按 (会话, 猫)」

- **工作分支**：`session/<sid8>/<cat8>`
- **worktree 路径**：`<主仓库>/../catStudy-sessions/<sid8>-<cat8>`
- `sid8` = 会话 id 前 8 位（沿用 `sessionShortId`）；`cat8` = **agent id 前 8 位**。

**为什么用 id8 而不是猫名**：猫名是中文（`店长` / `ds猫` / `flash猫` / `吐槽猫` / `本地qwen猫` / `dsh猫`），做分支名与目录名要额外过一遍 sanitize（空格、斜杠、全角）+ 碰撞处理，而收益只是「目录好看」。id8 是 **ASCII、稳定、零映射表、零碰撞**。可读性由日志补偿：建 worktree 时同时打 `agentId` 与 `agents.name`（一行 log 即可解析）。**若用户更看重目录可读性，这是本 ADR 唯一可无痛替换的子决策**（换名不改结构）。

- **`session/<sid>` 分支保留**，降级为**会话集成分支**（店长侧的集成入口 + 收口器的输入）。它不再由实施猫直接提交。

### D2 · 会话级 worktree 保留为**店长的** worktree

`ensureSessionWorktree(sessionId)` **保留现有语义与路径**（`catStudy-sessions/<sid>`），不再扩展为多猫共用，而是**店长自己**的工作目录。理由：① 收口器（`session-closeout.ts`）与 `removeSessionWorktree` 的自指守卫、`mainRoot` 探测等既有机制**一行不用改**；② 店长本来就在会话 worktree 里读写票面，语义自然。

⇒ 净变化：**实施猫 / 审查猫从「共用店长的目录」变为「各有自己的目录」**，店长不动。

### D3 · 审查侧：**一次性 detached worktree**（Q3 = B）

```
git worktree add --detach <sessionsRoot>/.review-<sha8> <sha>
  → 审查者在该目录跑测试
  → git worktree remove <该目录>
```

- **零常驻成本**：用完即删，不需要给审查猫养一条常驻分支。
- **天然满足「审阅态 = detached HEAD」**：不动任何分支 ref，也就没有「在 detached 上提交丢东西」的风险。
- **修 F3 的根**：验证面 = 被判面（跑的就是那个 sha 的树）。
- **硬前提**：必须是 `git worktree add`（**共享同一 object store**），**绝不可用 `git clone`**——clone 会切断 object store，那时审查才需要 push/fetch 中转，且跨会话按 sha 读的能力一并丧失。
- 读 diff 无需额外机制：`git -C <自己的 worktree> show <sha>` 直接可读（同 `.git/objects`）。
- **附带收益**：审查兜底 cwd（`serial.ts:770`）与 D3 是同一问题的两面，一并纳入。

### D4 · auto-commit 限定提交范围（Q2 = A 打底、B 随本 ADR 落地、C 不做）

- **B 随本 ADR 天然达成**：一猫一 worktree 后 `git add -A` 只扫得到**该猫自己**的目录。
- **A（止血）**：T-1 已完成降级路径收窄（`serial.ts:1167`），无 worktree 时**不提交**而非落主仓库。
- **C（彻底删 auto-commit）不做**：它与脏检查是**配对**的——`git add -A` 先收进 index，`checkout -- .` 才能从 index 恢复。单独删它会静默删除改动，比误提交更不可逆。
- **仍保留待修的一条**（本 ADR 范围内，小改）：`git-utils.ts:181-184` 的 catch **不回滚索引**且文案恒真——失败后残留索引会被下一个裸 `git commit` 收走。**这是 F1 的残留通道，隔离后仍会在单猫范围内复发。**

### D5 · 存量处置：**不迁移**

现存 24 个会话 worktree（2026-09 之后的全部；2026-08 及更早的 18 个已由店长于本轮清理删除，见「决策留痕」）**保持原状**，不迁移到新命名。新命名只对**新建**生效。理由：迁移要动 24 个目录 + 24 条分支，而收益只是命名统一；旧 worktree 随收口/废弃自然消失。

## 4. 备选方案（未采纳）

| 方案                                                  | 为何不采纳                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **A1 只改 `git add -A` 为限定路径，不做隔离**         | 只堵 F1，F2/F4 原样在；且「哪些路径算这次改的」本身要一套推断，脆弱                         |
| **A2 靠「串行派活」纪律**                             | 复现成本已实证：本轮我按「零交集」判并行，6 分钟全废。**纪律会失守，结构不会**              |
| **A3 每猫一个 `git clone`**                           | **切断 object store** ⇒ 跨 worktree 按 sha 读不到，审查链断；且磁盘 ×N 倍                   |
| **A4 每猫一条分支但共用一个 worktree（频繁 switch）** | `git checkout` 切分支会带走工作区未提交内容，且同一分支不能被两个 worktree 检出；比现状更糟 |

## 5. 影响与代价（要认的账）

| 面             | 变化                                                                                                   | 代价                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **分支模型**   | 实施猫 = `session/<sid8>/<cat8>`；审查 = 一次性 detached；`session/<sid>` 降为集成分支                 | 店长收口从「单链一条」变成「N 条按序合进集成分支」，**冲突仲裁归店长** |
| **磁盘**       | worktree 数 ≈ 会话数 × 平均活跃猫数（现 24 个会话 → 估 50~70）**且只增不减**（无回收器）               | 需配套回收；现 432M，T-2 后线性涨                                      |
| **启动开销**   | 每猫首次执行各建一次 worktree（实测**现建 368ms / 复用 51ms**）                                        | 可接受，但在 auto-commit 路径上已有读数（票面 R1 实测）                |
| **pre-commit** | 不再跨猫互锁 ✅ 但每个 worktree **各跑一遍全量 vitest**（实测 15s）                                    | 成本 ×N；这是**用算力换正确性**                                        |
| **既有机制**   | `removeSessionWorktree` 的自指守卫、`mainRoot` 探测、收口器 5 步**均不需改**（店长 worktree 路径未变） | —                                                                      |

## 6. 留给 T-3 的接口（本文不裁）

- `session-closeout.ts:105` 是**唯一**合并调用点，现为 `merge --ff-only`。**N 条并行猫分支下 ff-only 必然非快进失败**（两条猫分支都从同一点切出，合完 A 再合 B，B 的 tip 不是 A 的后代）。
- `session-closeout.ts:281` 的 `removeWorktree` 排在 merge 之后 ⇒ 要 rebase 必须**先放掉 worktree**，而死锁在「merge 失败即停」（`:279`）——这是 T-3 要解的结构。
- **`cherry-pick` 已排除**：它改变 sha，而**审查链的锚就是 sha**（「审的 sha ≠ 落的 sha」是本仓反复栽过的坑）。
- **`--no-ff` 不是新形态**：远端 dev 上 `5dedbd7` 就是 PR merge commit。
- **no-ff 会破坏现有幂等**（`session-closeout.ts:97` 注释明写靠 ff-only 的 "Already up to date"）——中断重跑会**再产生一个 merge commit**。T-3 必须单独补幂等。

## 7. 待用户确认的三点

1. **主决策**：一猫一 worktree（D1–D3）。
2. **命名子决策**：`cat8`（agent id 前 8 位，ASCII 稳定）还是中文猫名 slug（可读但要 sanitize）？
3. **D5 存量**：接受「不迁移、随废弃自然消失」？

## 决策留痕

### 本 ADR 起草前完成的存量清理（2026-09-15，用户指令）

用户指令「删 9 月之前的 worktree、分支」。店长执行并逐条留痕：

- **删除 18 个 session worktree + 18 条 `session/*` 分支**（判据：分支末次提交日与目录 mtime **均 < 2026-09-01**，且 DB `sessions.updated_at` 无 9 月活动）。
- 其中 **5 个连 DB 行都已不存在**（纯 git 孤儿）；**13 个** DB 记录停在 8 月（最晚 `2026-08-30`）。
- **删除前实测：18 个 worktree 脏文件数全为 0** ⇒ 无未提交的活被删。
- **`session/4d3e7ff4` 持有 1 笔未合并提交 `bcfcd89`**（token-pool 初版）。已核实为**被取代的旧迭代**：dev 上 `token-pool.ts` 相对它 **+106 −16**，功能由更完整的实现落地。该 sha 记录在此以备追溯。
- 顺带清除一个**空壳孤儿目录** `catStudy-sessions/082b2ae7`（无 `.git`、无文件，不在 `git worktree list` 内）。
- **安全约束执行**：worktree 内的 `node_modules` 与 `packages/*/node_modules` 均是指向**主仓库**的 symlink；`git worktree remove` 只注销 git 层并留下 symlink 空壳，残留清理由 Node `unlinkSync` 逐链接删除（**绝不 recursive 跟随**），删除前后主仓库 `node_modules` 顶层条目数均为 **97**（未跟穿）。
- 结果：worktree **43 → 25**（1 主 + 24 会话）、`session/*` 分支 **42 → 24**、`catStudy-sessions/` 磁盘目录 **43 → 24**；`dev = 34fa0c1` 未变，主仓库工作区干净。

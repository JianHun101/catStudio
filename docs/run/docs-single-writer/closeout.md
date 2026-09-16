# 收口记录：票 `docs-single-writer`

> 收口方：店长。收口 2026-09-16。
> 本文件是 **post-merge 产物**（记录的就是合并本身），写入方 = 收口方、写在 `dev` 上、**绝不回写 worktree**
> —— 依据票面 §2.2「收口记录」条。

---

## 结论

**已收口。** `dev = origin/dev = 49a1099f`，PR #94 合并（merge commit `49a1099f`）。

---

## 一、收口读数

| 项          | 读数                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| 已审 sha    | `720a68a`（票2 交付，审查 ✅ 可合并）                                                             |
| 收口追加    | `49e032e`（票面 §2.2 对齐，`docs/run/` 免审前缀）                                                 |
| 推送门禁    | `.push-gate = 49e032ea…`（40 位）→ 推 `session/4c8acf70`                                          |
| PR          | #94，head=`session/4c8acf70` base=`dev`，merge commit `49a1099f`                                  |
| 落地口全量  | **123 文件 / 2499 用例全绿**（合并前干净快照上复跑；基线 122/2478，+1 文件 / +21 用例即本票新增） |
| `pnpm lint` | 3 包类型检查通过                                                                                  |
| 三读数      | `dev = origin/dev = 49a1099f` ✅                                                                  |
| 重启        | **不需要**——改动面为 `scripts/` + `CONTEXT.md` + `docs/`，**零 `packages/**` 改动**（见 §四）     |

**门禁当轮第三次真实读数**：票面更正提交 `49e032e` 时钩子打印
`[precommit-scope] 跳过 —— 1 条路径全为文档/在飞产物（无测试消费者）`，零 `Test Files` 行。

---

## 二、收口前 dupcheck 首次真实执行

新纪律（`CONTEXT.md`）要求收口前跑一次 `closeout-dupcheck`。**这是它交付后的第一次真实收口应用**：

```
$ node scripts/closeout-dupcheck.mjs --a dev --b session/4c8acf70
[closeout-dupcheck] a=dev@2b349ef b=session/4c8acf70@49e032e base=2b349ef ΔA=0 ΔB=6 交集=0 命中=0
[closeout-dupcheck] ✅ 无重复落盘（ΔA ∩ ΔB 上无 blob 相同项）
[closeout-dupcheck] ⚠️  判据无面：dev 是 session/4c8acf70 的祖先（无可合并的分叉）⇒ 无重复落盘的可能面
exit 0
```

**读作「无面」，不是「检查通过」**（脚本自己的警示说得对）。要留一句给将来的读者：

> **本仓收口链上「无面」是常态**——收口的正是从这个 `dev` 长出来的会话分支，`dev` 未前进 ⇒ `ΔA=0`。
> 这不是脚本没用：**分叉态恰恰是重复落盘唯一可能的形态**（主仓库侧没有新提交，就不存在「第二个写入方」）。
> 换言之「无面」的每一次出现，都同时意味着「本次不存在患者形态」——两者同源，不是巧合。

---

## 三、三条随带项裁决

### ① 存量 5 处重复落盘 → **不立后续单**

- **事实**：`report.md` §2.2 对 6 条真实分叉会话分支实跑，抓到 5 处真阳性（两侧 blob 逐字节相同），
  全部在**未合并**的会话分支上；`dev` 未被污染（今日实测 `dev` 侧无对应形态）。
- **裁决依据**：两侧 blob 逐字节相同 ⇒ 「两笔并作一笔」与「两笔各自落地」**内容等价**，无信息丢失、
  无功能损失。真正被损害的是**可见性**（人以为两笔都落了），不是数据。而这些分支对应的工作早已收口/
  结束，**不会走收口链** ⇒ 纪律里那条「先裁定保留哪一侧，再合并」对它们**无适用场景**。
- **不立单的正面理由**：脚本的价值面向未来，而**兜底机制本身就是那个「后续单」**——若某条残留分支
  将来真的要收口，dupcheck 挂在收口链上自会给出读数，届时按纪律处理即可。为「内容已经等价」的存量
  逐分支 `checkout` 取证裁定，是代价真实、收益为零的操作。
- **边界**：本裁决只覆盖**已存在**的 5 处；新形态一律按纪律走（脚本在链上）。

### ② 票面 §2.2 裸命令 → **改票面字、不改实现行为**（已落地 `49e032e`）

- 票面初版写裸命令 `node scripts/closeout-dupcheck.mjs`，实测撞 `exit 2`（默认 `--a dev --b HEAD`，
  主工作区两 ref 同 commit ⇒ 判据无主体）。
- **裁：`exit 2` 的 fail-loud 是对的**——那个调用形态每次都回「无命中」，正是本票要消灭的假绿门。
  要改的是**票面的字**，不是实现的行为。票面已改显式形态 `--a dev --b session/<sid8>`，
  §二 契约与 §三 验收一字未动。
- 与既有纪律的一致性：`CONTEXT.md` 那条纪律**从交付起**写的就是显式形态 —— 即「纪律条文」与「票面
  引例」原本不同口径，本次把票面对齐过去（不是发明新约束）。
- **教训（与本票 §决策留痕同一个病）**：票面里的命令是给人照着敲的，一条每次都报错的命令留在票面里，
  与「落点无消费」是同一类失效——写的人以为它在工作。

### ③ OQ1 `Δ` 取端点净差集 → **追认**

- 判据 `Δ = git diff --name-only <base> <ref>`（端点净差），非「提交日志触及集」。
- **追认依据**：两者唯一可辨差异是「一侧加了又删、净归零」。该路径在这一侧**没有最终内容**，
  也就**没有被吞的笔**；它进判据只会因 `rev-parse` 取不到 blob 而落 `skipped`，结论相同、白跑一趟。
  两种读法**均合票面 §2.1 字面**（`base..A` 的 `..` 在 `git diff` 里即两端点之差），选净差
  **不构成放宽**，红线 6 未触。审查者独立复核后亦认同。
- **边界**：若将来要覆盖净归零形态，须改判据、走红线 6 报批。

---

## 四、重启判定（取证，非断言）

改动面 `git diff --name-only 2b349ef 49a1099f`（实测 6 文件，逐行列出）：

```
CONTEXT.md
docs/run/docs-single-writer/report.md
docs/run/docs-single-writer/tickets.md
docs/run/multi-cat-isolation/tickets-t2-phase-i.md
scripts/closeout-dupcheck.mjs
scripts/closeout-dupcheck.test.js
```

`git diff --name-only 2b349ef 49a1099f | grep -c '^packages/'` ⇒ **0** ⇒ 无 server / shared
生产码变化 ⇒ **不需重启**。

> **口径自律**：本条按**改动面实测**判定，不按文件名归类。`docs-single-writer` 交付自陈「零
> `packages/**`」，我以 `git diff --name-only` 对合并区间复核成立——这正是上一票（`precommit-scope`）
> 我写错「无 server/shared 生产码」时缺的那一步（那次是按文件名归类、没看 diff）。

---

## 五、挂账（未派活）

- **单A**：`LOG_FILE` 两处相对路径收口（`packages/server/vitest.config.ts:57`、`scripts/vitest.config.ts:11`）
- **单B**：V14 护栏进「改 `packages/**` 的提交口」（追加 `scripts` project，约 4.4s/次）
- **Phase I 开工**：票面 `4808f6a`（`docs/run/multi-cat-isolation/tickets-t2-phase-i.md`）已立并随本 PR 进 `dev`；
  硬前置 = 两处路径漂移修正 + `listCatBranches` 走 `refs/heads/session/<sid8>-*` 通配符
- **双跑缺陷**：用户裁定挂起（不常发生），记在 Phase I 票面 §六 Out of Scope

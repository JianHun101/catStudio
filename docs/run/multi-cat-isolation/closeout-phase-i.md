# 收口记录：T-2 一猫一 worktree 隔离 —— Phase I 接线

> 收口方：店长。收口 2026-09-16。
> 本文件是 **post-merge 产物**（记录的就是合并本身），写入方 = 收口方、写在 `dev` 上、**绝不回写 worktree**
> —— 依据 `CONTEXT.md`「每份文档只有一个写入方」条。
> 票面：`docs/run/multi-cat-isolation/tickets-t2-phase-i.md`；交付报告：`report-phase-i.md`。

---

## 结论

**已收口。** `dev = origin/dev = 081fcd4`，PR #95 合并（merge commit `081fcd42`）。
**本票是生产行为变更 ⇒ 已发重启审批。**

---

## 一、收口读数

| 项                     | 读数                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| 已审 sha               | `9cd5b28` + `ed6a3b0`（第 1、2 笔 ✅）／`f4ab9de` + `da7415b`（第 3 笔 ✅）—— 按「票 = 三笔」两轮审 |
| 免审随行               | `97c9760`（票面补笔，`docs/run/` 免审前缀）                                                         |
| 推送门禁               | `.push-gate = da7415be…`（40 位）→ 推 `session/4c8acf70`                                            |
| PR                     | #95，head=`session/4c8acf70` base=`dev`，merge commit `081fcd42`                                    |
| 落地口全量             | **124 文件 / 2514 用例全绿**（合并前干净快照 `da7415b` 上复跑，与报告 §五逐字一致）                 |
| `node scripts/lint.js` | 3 包类型检查通过                                                                                    |
| 三读数                 | `dev = origin/dev = 081fcd4` ✅                                                                     |
| 重启                   | **需要** —— 5 处 `packages/server/src/` 生产码，实测含可执行改动（见 §四）                          |

---

## 二、收口前 dupcheck

```
$ node scripts/closeout-dupcheck.mjs --a dev --b session/4c8acf70
[closeout-dupcheck] a=dev@284ec3f b=session/4c8acf70@da7415b base=284ec3f ΔA=0 ΔB=18 交集=0 命中=0
[closeout-dupcheck] ✅ 无重复落盘（ΔA ∩ ΔB 上无 blob 相同项）
[closeout-dupcheck] ⚠️  判据无面：dev 是 session/4c8acf70 的祖先（无可合并的分叉）⇒ 无重复落盘的可能面
exit 0
```

**读作「无面」，不是「检查通过」**——与上一票同源注解，见 `docs/run/docs-single-writer/closeout.md` §二：
本仓收口链上「无面」是常态，而分叉态恰是重复落盘唯一可能的形态，两者同源。

---

## 三、审查随带项处置

### ① OQ1（集成分支创建者只剩店长）→ **已裁 A、已落地**

裁决与理由落在票面「补笔」节（`97c9760`）与报告 §6.1；实现 = 第 3 笔 `git-utils.ts:608` 一行补建
（`if (!ensureSessionWorktree(sessionId)) return null`）。审查者复核后认同。

### ② OQ2（票面 §2.1 与 V7 对 `/` 的要求互斥）→ **追认实现、改票面字**

措辞更正已在 `97c9760` 落票面（`/` 移出「可剔字符」、单列显式抛错项）。**实现一字未动** ——
静默剔除会把 `a/b` 折成 `ab`、与真名共用同一棵树，正是本票靶心。

### ③ 审查 P3 三条

| #   | 项                                                                        | 处置                                                                                                     |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| a   | V14 复现命令用 `/tmp` 路径，Windows PS 下需 git-bash 语义                 | **不改** —— 本仓开发环境即 git-bash，report 里的命令可粘贴执行；为此加一层平台适配是净增维护面。记录即可 |
| b   | `ensureCatWorktree` 复用期所有权标记读失败（配置损坏）                    | **随 Phase I-b 观察**，不立单 —— 无标记 ⇒ 抛错的兜底在，无新缺口                                         |
| c   | OQ5 猫路径降级矩阵未成套：**提交期** `ensureCatWorktree` 抛错分支无行测试 | **新挂 Phase I-b**（非法名 / 所有权冲突 ⇒ 跳树 + error 留痕，代码简单但无行测试）。不构成本票返工项      |

---

## 四、重启判定（取证，非断言）

改动面 `git diff --name-only 284ec3f da7415b` 实测 **18 文件**，其中 `packages/server/src/` 下
**5 个非测试生产文件**。逐文件数「非注释新增行」（判据：`^+` 且非空、非 `//`/`/*`/`*` 开头）：

| 文件                                                 | 新增行 | 其中非注释 |
| ---------------------------------------------------- | ------ | ---------- |
| `packages/server/src/execution/serial.ts`            | 143    | **96**     |
| `packages/server/src/execution/reply.ts`             | 9      | **2**      |
| `packages/server/src/llm/session-closeout.ts`        | 107    | **59**     |
| `packages/server/src/llm/git-utils.ts`               | 136    | **76**     |
| `packages/server/src/db/repository/executionLogs.ts` | 25     | **7**      |

⇒ **有可执行的生产码改动**（不是注释、不是测试）⇒ **需重启**。

> **口径自律**：本条按**改动面实测 + 行级取证**判定，不按文件名归类、也不凭交付自陈。
> 上一票（`precommit-scope`）我曾按文件名归类写下「无 server/shared 生产码」而措辞失准；
> 这一票把「含 `packages/server`」再往下追了一层——**含 server 文件 ≠ 要重启**，
> 要的是「跑着的那个进程，行为会不会变」。本票会变，且变在三处主路径上。

**本票重启后生效的行为**（三处，全部在主路径）：

1. `reply.ts` —— CLI cwd 按角色分派（store → 会话 worktree；其余 → 各猫 worktree）；
2. `serial.ts` —— 收尾块的提交 / 清理**目标树改为逐猫**（原为会话级一棵树 `git add -A`）；
3. `session-closeout.ts` —— 收口链新增 `fanInCatBranches` / `reclaimCatBranches` 两个 step。

---

## 五、挂账（未派活）

| 项                                                                                         | 状态                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 单A `LOG_FILE` 两处相对路径（`server/vitest.config.ts:57`、`scripts/vitest.config.ts:11`） | 未派活                                                                   |
| 单B V14 护栏进「改 `packages/**` 的提交口」                                                | 未派活                                                                   |
| **P3-c 提交期抛错分支补行测试**                                                            | **本票新挂**，随 Phase I-b                                               |
| Phase I-b（D3 审查猫一次性 detached worktree）                                             | 票面已划；`serial.ts:770` 审查兜底 cwd 随批                              |
| `git-utils.ts` catch 不回滚索引（D4 残留通道）                                             | 票面 §六已挂                                                             |
| 双跑缺陷（`serial.ts` catch 判死后不 kill 进程）                                           | 用户已裁「挂起，不常发生」                                               |
| ADR 0015 转正                                                                              | T-2 收口动作；`worktree-fanin.ts` 注释里遗留的 `<cat8>` 措辞随转正一并改 |

---

## 六、留一句给将来的读者

票面「结论先行」第 2 条（D1 接线与 fan-in **必须同批**）在本票里被证明是对的：
只接线不接 fan-in，收口器仍只合 `session/<sid8>`（停在分叉点，`--ff-only` 输出
`Already up to date.`、**退出码 0**）⇒ 照样删 worktree 与分支 ⇒ 猫的提交**永远没进过任何地方**，
而且全程零报错。**退出码 0 不等于活落地**——这是本票最容易被误读成「稳妥增量」的一处。

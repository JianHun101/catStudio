---
type: lesson
date: 2026-09-26
status: proposed
evidence:
  - kind: file
    ref: packages/server/src/llm/session-closeout.ts
  - kind: file
    ref: packages/server/src/llm/worktree-fanin.ts
  - kind: file
    ref: scripts/handoff-gen.mjs
---

# 命令 exit 0 ≠ 提交落到了 dev——判「落没落」必须验内容在场，不看退出码

## 撞出来的场景

多猫隔离的模拟票里有一格专门验「dev 侧 ff-only」：集成分支快进合进 `dev` 之后，
怎么判「猫的提交**确实**出现在 dev 上了」。

第一版判据是「合并命令退出码 0」。同批的另一格（E5）把这个判据判死了——
**`exit 0` 不等于「东西进去了」**。此后本仓的收口链把判据换成了端到端锚点：
不看命令说了什么，看目标树里有没有那个东西。

## 现象

`git merge --ff-only` 返回 0，只说明「这条命令按其定义完成了」。它不说明：

- **(a) 合的是你想合的那一条**——分支名在执行的那一刻才解析，中途别的猫提交会被连带吞进去
- **(b) 结果树里有那些文件**——快进成功但目标分支本来就有那些内容时，读数与「真合成了」相同
- **(c) 这件事发生在你以为的那棵树上**——多 worktree 并行时 cwd 可能是另一棵树

三条都不报错，三条都能让 `exit 0` 与「内容在场」脱钩。

## 正解

**判据钉在「目标树里内容在场」，不钉在命令的退出码上。** 本仓现行形态：

- **收口链判「这一笔在不在 dev 的祖先里」**：`git merge-base --is-ancestor <sha> dev`
  （`packages/server/src/llm/session-closeout.ts`）。它比「合并命令返回 0」强，
  因为它断言的是**这一笔提交**与 dev 的拓扑关系。
- **fan-in 判「这条猫分支合过了没」**：同型的祖先判据
  （`packages/server/src/llm/worktree-fanin.ts`）；`scripts/handoff-gen.mjs` 也用它定位提交归属。
- **产物面**：验的若是**文件**而非提交，就直接读目标树里的 blob 内容比对
  （`git show <ref>:<path>` / 读工作树文件），不看任何命令的退出码。

## 可复用的动作

1. 凡「A 把东西交给了 B」的判据，问一句：**我的读数能不能区分「交了」与「没交」？**
   读数来自命令退出码 ⇒ 不能区分，换掉。
2. 换法：**在接收侧取一次内容读数**（文件在场 / 提交是祖先 / 字段有值），
   且这个读数要能指名道姓（哪个 sha、哪个路径）。
3. 判据自身要**反向对照**：用一个**已知不在场**的 sha 或文件名跑一次，确认它报「不在场」。
   报不出来的判据是恒真的（见 [diff 归零不等于无冲突](diff-zero-does-not-mean-no-conflict.md)）。
4. 写「已合并 / 已落库 / 已投递」这类结论前，先明确问：**我在哪一侧、取的什么读数？**

## 溯源

源：`docs/run/multi-cat-isolation/tickets-t2.md` 与 `tickets-t2-phase-i.md`
（在 `docs/run/**`，活收口即清；正文已自包含）。

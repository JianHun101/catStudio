---
type: lesson
date: 2026-09-26
status: proposed
evidence:
  - kind: file
    ref: packages/server/src/execution/reply.test.ts
  - kind: file
    ref: packages/server/src/routes/eval.test.ts
  - kind: commit
    ref: 43b90d5a
  - kind: commit
    ref: 4d543cd4
---

# 验「参数真从 env 读」：断 env 看它回落到默认值不算数——钉非默认值才能区分「真读」与「写死」

## 撞出来的场景

2026-09-21，agent 回复计时器那张票的 A 单 / C 单，两单都是**测试文件**的改动，
修的是同一种假绿门：用例断言了一个「由 env 派生的参数的默认值」，而那条断言在
「真去读 env」和「写死这个默认值」两种实现下**都能过**。

当时的触发器很具体：`.env` 里 `MEMORY_TOP_K` 恰好被设成了 `5`（真源默认是 `3`），
于是 A 单的那条用例在本地必红——**它红不是因为被测代码变了，是因为跑批进程继承了
一份外部 env**。这条红还卡死了全仓提交口（`pre-commit` 会跑 server 测试）。

## 现象

一条用例写 `expect(params.topK).toBe(3)`，真源是 `envNumber('MEMORY_TOP_K', 3)` 这类现读 env 的写法。

- env 未设 ⇒ 真源回落到 `3` ⇒ 断言过 ✅
- 但**把 `3` 写死在实现里** ⇒ 断言同样过 ✅

⇒ 这条断言分不开「真读 env」与「写死默认」两种实现。它测的是**两个实现恰好一致的那个点**。

## 两个更隐蔽的变体

C 单的两处**当时没红**，各自靠一种巧合：

- **靠「未设回落」**：本机恰好没设该变量 ⇒ 真源回落到与断言相等的默认值
- **靠「预设值恰等于默认」**：`env.ts` 里 `process.env.EVAL_CHAIN_SLOW_MS ??= '300000'`
  的预设值刚好等于真源默认 `300000`

两者都是**潜伏**：换一台机器、解注释一个 `.env.example` 里的示例值，就会翻成假红或假绿。
（`.env.example` 恰好注释着这两条变量的示例值——下次谁照着解开就是这一轮的路障重演。）

## 正解

钉**非默认值**：`vi.stubEnv('MEMORY_TOP_K', '4')`（真源默认 `3`）、
`vi.stubEnv('MEMORY_MAX_DISTANCE', '0.7')`（默认 `0.6`）、
`vi.stubEnv('EVAL_CHAIN_SLOW_MS', '600000')`（默认 `300000`）、
`vi.stubEnv('EVAL_LABEL_MIN_COUNT', '50')`（默认 `30`），断言读数是**我设的那个值**。
此时「写死默认」的实现必红。

已固化为代码：`packages/server/src/execution/reply.test.ts` 与
`packages/server/src/routes/eval.test.ts` 的相关用例。

## 可复用的动作

1. **凡断 env 派生值，先问「这个断言在『写死默认值』的实现下会红吗？」** 不会 ⇒ 钉非默认值。
2. **不依赖外部 env**：用例自己 `vi.stubEnv` 设值，别赌「本机没设这个变量」——
   跑批进程可能继承一份 `.env`。
3. **审查侧配套**：以**负向对照**坐实判据是活的——临时把真源写死成默认值 ⇒ 该用例必红。
   本轮的 A 单 / C 单就是审查者逐条这么复现出来的。
4. **例外要显式排除**：`expect(limit).toBe(30)` 若其真源是编译期字面量（如
   `parseBoundedInt(rawLimit, 30, 1, 200)` 的第二个实参）而非 env 派生，则改 env 打不红，
   **不属本族**——判族前先横扫该文件全部 env 读取点。

## 溯源

源：`docs/run/agent-reply-timer/tickets.md`（在 `docs/run/**`，活收口即清；
正文已自包含）。落点可从 git 历史取：A 单 `43b90d5a`、C 单 `4d543cd4`。

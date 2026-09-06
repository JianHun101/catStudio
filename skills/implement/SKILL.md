---
name: implement
description: Implement a piece of work based on a spec or set of tickets. Use when the requirements are settled and the work is ready to build, ideally with a spec and one ticket in a fresh session. Not for fuzzy ideas that still need investigation (use wayfinder) or prototype exploration (use prototype). Output working code that satisfies the spec/ticket acceptance criteria.
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

## 前置门槛（猫咖约定，缺任一先回上一环，别直接写码）

开始前逐项确认：

- [ ] 有一份 spec + 一张工单（`grilling`/`to-spec` → `to-tickets` 产物）
- [ ] spec 每条需求**可证伪**、验收信号明确（`spec-gate` PASS）
- [ ] 跳过了 `grilling` → spec 尾部 `## 决策留痕` 段已写「为什么」（没留 → 审查可抓）

门槛不过 = 需求还没立住，先回 `grilling` / `to-spec` / `spec-gate`，不是硬着头皮 implement。**把「偷偷跳段」变成「看得见的跳段」**：跳可以，但必须留痕，审查链才接得住。

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.

## 与其他 skill 区别

| skill      | 区别                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| prototype  | implement 产出生产代码并满足验收标准；prototype 产出一次性代码回答设计问题，用完即弃 |
| to-tickets | implement 消费已拆好的 ticket；to-tickets 负责把 spec 拆成 ticket                    |

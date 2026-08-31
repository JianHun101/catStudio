---
name: implement
description: Implement a piece of work based on a spec or set of tickets. Use when the requirements are settled and the work is ready to build, ideally with a spec and one ticket in a fresh session. Not for fuzzy ideas that still need investigation (use wayfinder) or prototype exploration (use prototype). Output working code that satisfies the spec/ticket acceptance criteria.
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.

## 与其他 skill 区别

| skill      | 区别                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| prototype  | implement 产出生产代码并满足验收标准；prototype 产出一次性代码回答设计问题，用完即弃 |
| to-tickets | implement 消费已拆好的 ticket；to-tickets 负责把 spec 拆成 ticket                    |

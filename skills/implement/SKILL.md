---
name: implement
description: Implement a piece of work based on a PRD or set of issues. Use when the requirements are settled and the work is ready to build, ideally with a PRD and one issue in a fresh session. Not for fuzzy ideas that still need investigation (use decision-mapping) or prototype exploration (use prototype). Output working code that satisfies the PRD/issue acceptance criteria.
disable-model-invocation: true
---

Implement the work described by the user in the PRD or issues.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /review to review the work.

Commit your work to the current branch.

## 与其他 skill 区别

| skill                 | 区别                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| prototype             | implement 产出生产代码并满足验收标准；prototype 产出一次性代码回答设计问题，用完即弃            |
| request-refactor-plan | implement 按 PRD/issue 实施；request-refactor-plan 只产重构计划（含 tiny commits 拆分），不实施 |
| to-issues             | implement 消费已拆好的 issue；to-issues 负责把 PRD 拆成 issue                                   |

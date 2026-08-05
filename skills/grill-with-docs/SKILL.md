---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go. Use when the user has a codebase and wants the interview's conclusions persisted. Not for quick interviews with no doc output (use grill-me). Output a sharpened plan plus ADRs and glossary entries.
disable-model-invocation: true
---

Run a `/grilling` session, using the `/domain-modeling` skill.

## 与其他 skill 区别

| skill    | 区别                                                                  |
| -------- | --------------------------------------------------------------------- |
| grill-me | grill-with-docs 边访谈边产出 ADR/术语表；grill-me 纯访谈无文档        |
| grilling | grill-with-docs 面向有代码库的场景并持久化结论；grilling 是通用版访谈 |

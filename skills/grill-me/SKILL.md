---
name: grill-me
description: A relentless interview to sharpen a plan or design. Use when the user has a rough plan and wants it stress-tested through questioning, without creating docs. Not for interviews that should also record ADRs and glossary (use grill-with-docs). Output a sharpened plan with weak spots exposed.
disable-model-invocation: true
---

Run a `/grilling` session.

## 与其他 skill 区别

| skill           | 区别                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| grill-with-docs | grill-me 只访谈不产出文档；grill-with-docs 边访谈边写 ADR 和术语表                   |
| grilling        | grill-me 是 mattpocock 版访谈（强化计划）；grilling 是通用版（stress-test 任意计划） |

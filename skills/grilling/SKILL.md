---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases. Not for plans already settled, or interviews that must also produce docs (use grill-with-docs). Output the plan's weak points and hardened decisions.
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.

## 与其他 skill 区别

| skill                      | 区别                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| grill-me / grill-with-docs | grilling 是通用版访谈 skill；grill-me/grill-with-docs 是 mattpocock 同名变体（后者附带文档产出）——触发词 'grill' 命中时优先按用户语境选具体版 |

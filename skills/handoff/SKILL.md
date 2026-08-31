---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Use when work crosses sessions, another agent needs your context, or you are handing a task to a fresh session. Not for sending a review request for finished work (use request-review), or for project-internal summaries (use session-summary). Output a handoff document in the OS temp directory with suggested skills.
argument-hint: 'What will the next session be used for?'
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## 与其他 skill 区别

| skill           | 区别                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| request-review  | handoff 是把当前会话压成交接文档给新会话/新 agent 接手（与审查流程无关）；request-review 是完成工作的质量审查请求 |
| session-summary | handoff 产物放 OS 临时目录、含 suggested skills 供接手者调用；session-summary 产物放 docs/sessions/ 供项目留档    |

---
name: session-summary
description: Generate a structured summary of the current session's changes in the CatStudy project format (What/Why/Tradeoff/Open Questions/Next Action).
---

When the user asks to summarize the current session, generate a session work, or create a summary document, produce a markdown file following the strict format established by `cat-study-multi-agent-summary.md`.

## Format (required structure)

The output file must contain exactly these five sections:

```markdown
# <简洁标题 — 概括本次做了什么>

## 1. What — 具体改动

| 文件          | 改动                 |
| ------------- | -------------------- |
| `<file-path>` | <一句话说明改了什么> |
| ...           | ...                  |

## 2. Why — 为什么这样做

<用自然段落 + ASCII 图表/代码块解释核心架构决策。不只是列文件，要讲清楚设计推理链>

## 3. Tradeoff — 放弃了什么方案

| 放弃    | 原因         |
| ------- | ------------ |
| <方案A> | <为什么没选> |
| ...     | ...          |

## 4. Open Questions — 不确定的点

- **<主题>**：<具体不确定什么，当前怎么处理的，可能的风险>
- ...

## 5. Next Action — 希望做什么

- <具体可执行的下一步，用 checkbox 样式>
- ...
```

## Rules

1. **Section 1 (What)** — 文件按照从底层到上层、从共享到特化的顺序排列（shared → server/db → server/llm → server/routes → server/connectors → web → scripts → root config）。每个文件一行，改动说明要具体（不是"修改"而是"重构，从 Anthropic 端点改为 Chat Completions"）。

2. **Section 2 (Why)** — 不要复述 section 1。要回答"为什么这个设计是对的"。用 ASCII 图表展示数据流/架构关系。每个子决策用 `###` 小标题分组。

3. **Section 3 (Tradeoff)** — 每个 tradeoff 要给出"放弃的方案"和"放弃的原因"，不能只写"选了 A"。格式严格用表格。

4. **Section 4 (Open Questions)** — 真实的不确定性。不是 bug 列表，不是 TODO。是"当前这样做可能有问题，但需要更多信息才能确定"的事项。

5. **Section 5 (Next Action)** — 具体、可执行。优先排有依赖关系的（先完成的前置任务排前面）。已完成的事项前面加 `✅ ~~strikethrough~~`。

6. **输出路径** — 文件写入 `docs/sessions/` 目录下。如果目录不存在则先创建。
7. **文件命名** — `cat-study-<slug>-summary.md`，slug 用英文 kebab-case，概括本次主题。

8. **语言** — 全文中文。

## Context

Before writing, review:

- The current conversation to capture all files changed and decisions made
- `CONTEXT.md` to match the project's domain terminology
- Existing summary files in `docs/sessions/` as format references

## Post-generation

After writing the summary file, tell the user the file path (relative to project root, e.g. `docs/sessions/cat-study-xxx-summary.md`) and line count.

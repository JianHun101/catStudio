---
name: edit-article
description: Edit and improve articles by restructuring sections, improving clarity, and tightening prose. Use when user wants to edit, revise, or improve an article draft. Not for shaping raw material into an article from scratch (use writing-shape), or writing new sections without a draft. Output a revised draft with restructured sections and tightened prose.
disable-model-invocation: true
---

1. First, divide the article into sections based on its headings. Think about the main points you want to make during those sections.

Consider that information is a directed acyclic graph, and that pieces of information can depend on other pieces of information. Make sure that the order of the sections and their contents respects these dependencies.

Confirm the sections with the user.

2. For each section:

2a. Rewrite the section to improve clarity, coherence, and flow. Use maximum 240 characters per paragraph.

## 与其他 skill 区别

| skill         | 区别                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| writing-shape | edit-article 改写已有草稿（重构结构/收紧文字）；writing-shape 从素材段落塑造最终文章 |
| writing-beats | edit-article 面向成稿；writing-beats 面向素材的结构化（beat 旅程）                   |

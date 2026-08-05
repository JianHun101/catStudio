---
name: resolving-merge-conflicts
description: Use when you need to resolve an in-progress git merge/rebase conflict. Not for preventing destructive git operations (use git-guardrails-claude-code), or general git questions. Output the conflict resolved with both sides' intent preserved.
---

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.

## 与其他 skill 区别

| skill                      | 区别                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| git-guardrails-claude-code | resolving-merge-conflicts 处置已发生的合并/变基冲突；git-guardrails 在危险 git 命令执行前拦截预防 |

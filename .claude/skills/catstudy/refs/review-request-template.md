# Review Request 模板

```markdown
## Review Request

**Author**: 店长（暹罗猫）
**Branch**: {branch-name}
**Review-Target-ID**: {feature-slug}
**Date**: YYYY-MM-DD

### What（做了什么）

| 文件 | 改动 |
|------|------|
| path/to/file.ts | 描述改动 |

### Why（为什么这样做）

{设计决策和上下文}

### Original Requirements（原始需求）

> 用户说："{用户原话}"

来源：{Discord/issue/对话记录}

### Quality Gate 自检证据

- pnpm test → {N} passed, 0 failed ✅
- pnpm lint → 0 errors ✅
- pnpm build → exit 0 ✅

### Architecture Ownership

- Architecture cell: {cell name}
- Map delta: none | update required | new cell required
- Why: {为什么这样设计}

### Tradeoff（已知取舍）

| 选择 | 替代方案 | 为什么没选 |
|------|----------|------------|
| {方案A} | {方案B} | {原因} |

### Open Questions（待讨论）

**技术 OQ**（给 reviewer）：
1. {问题描述}

**价值 OQ**（需要用户判断）：
1. {问题描述 + Decision Packet}

### Review Focus（请 reviewer 重点关注）

1. {关注点1}
2. {关注点2}
```

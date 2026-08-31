# 审查请求模板

发送审查请求时，使用以下格式。这是 `skills/refs/shared-rules.md` 中"工作交接铁律"的标准模板。

---

# Review Request: {标题}

## What — 改了什么

{简要描述改动内容，按文件列出}

## Why — 关键决策

{核心设计决策及理由，用一两句话说明每个关键选择}

## Tradeoff — 放弃了什么

{说明考虑过但放弃的方案，以及放弃原因}

| 放弃的方案 | 原因         |
| ---------- | ------------ |
| {方案A}    | {为什么不用} |
| {方案B}    | {为什么不用} |

## Architecture Ownership — 架构归属

- **Cell**（影响哪个模块）：{shared/server/web/scripts}
- **Map Delta**（模块边界变化）：{新增/删除/移动了哪些文件}
- **Why**（为何放在这里）：{架构决策理由}

## Open Questions — 不确定的点

### 技术疑问（请 Reviewer 重点看）

- {疑问1}
- {疑问2}

### 价值疑问（需要确认的）

- {疑问1}

## Reviewer Checklist

- [ ] Standards 轴：符合 CODING_STANDARDS.md（文档化规范优先于坏味道基线；工具已强制的跳过）
- [ ] Spec 轴：忠实实现发起它的 spec/issue（无缺失、无范围蔓延、无错误实现）
- [ ] 硬违规与判断标签分开报（文档规范违规可硬；坏味道是判断标签）
- [ ] {检查项3}

## Self-Check Evidence

- 测试结果：`pnpm test` → {N} passed, {M} failed
- Lint 结果：`pnpm lint` → {通过/有 N 个错误}
- {其他验证方式}

---

行首 @审查者 发起审查（审查者按 shared-rules 审查配对规则动态确定，不写死真名）

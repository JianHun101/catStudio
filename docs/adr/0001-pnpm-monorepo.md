---
type: decision
date: 2026-07-13
status: accepted
evidence:
  - kind: file
    ref: pnpm-workspace.yaml
  - kind: file
    ref: packages/shared/src/types.ts
  - kind: file
    ref: packages/shared/src/schemas.ts
---

# ADR 0001: pnpm Monorepo 结构

前端和后端共享 TypeScript 类型（Agent 接口、Message 类型、Zod schema），分开仓库会导致类型重复和不一致。采用 pnpm workspace monorepo（`packages/server` / `packages/web` / `packages/shared`），与参考项目 Clowder AI 同架构。放弃了单仓平铺方案——平铺虽简单但类型共享需手动同步或发布私有包。

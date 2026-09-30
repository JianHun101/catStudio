---
type: plan
date: 2026-09-30
status: closed
evidence:
  - kind: file
    ref: packages/shared/src/skill-catalog.ts
  - kind: file
    ref: packages/server/src/execution/hints.ts
  - kind: file
    ref: packages/server/src/execution/reply.ts
  - kind: file
    ref: scripts/mcp-server-utils.mjs
---

# 技能发现面注入（skill-discovery-injection）

> **定稿规格**（2026-09-30 写入）。源活：票 `skill-discovery`（PR #138，2026-09-20 收口）。遗留项见源票的 errata 目录（Node 下限口径 / 注释失实两处），不属本规格范围。
> 本文是「猫怎么知道有哪些技能可用」的**唯一成文定义**。

## 1. 一句话

`SKILL_CATALOG`（技能白名单 + 一句话说明）原先只活在 MCP server 进程里、**从不进 system prompt**——猫对技能面是盲的，除非角色 prompt 里逐条写死某阶段用某技能。本规格把它搬成**常驻发现面**：每轮拼进第一条 system message。

**病灶定性**：不是模型不肯调技能，是**发现面不存在**。

## 2. 五条裁决

### D1 · 注入面 = 可读面

只注入白名单成员（`SKILL_WHITELIST`，当前 13 条），**绝不注入 `skills/` 目录全量**。

判据不是数字对齐，是**菜单不得说谎**：`read_skill` 的白名单是服务端强校验的，注入白名单外的技能 = 菜单里点了报错。**菜单说谎比没有菜单更坏**——模型试一次拿到错误，之后连真项也不信。故白名单增删后，注入面**自动**跟着变，两侧恒等；`SKILL_WHITELIST` 的判据是「猫可自取的技能正文范围」（访问约束），不是「流程链有哪些段」。

> 前端斜杠命令下拉另有一份技能清单（`packages/server/src/routes/skills.ts`），语义不同（人机交互面，不是模型发现面），**不合并、不当数据源**。

### D2 · 单一真相源落在叶子文件

目录数据的唯一定义点是 `packages/shared/src/skill-catalog.ts`——**零 import 的叶子**，只放 `SKILL_WHITELIST`（顺序即目录序）与 `SKILL_CATALOG`（一句话文案）两个字面量。

- server 侧经 `@cat-study/shared` 门面取用；
- `scripts/mcp-server-utils.mjs` **静态 import 该叶子 `.ts` 文件**（靠 Node 原生类型剥离；纯 `export const` 可擦除），本文件只做取值与 re-export，**无手抄字面量**。

**硬约束：必须从叶子文件直接 import，不得经 `packages/shared/src/index.ts`**——index 用 `export * from './types.js'` 这类 `.js` 说明符，plain node 不做 `.js` → `.ts` 重写，且会拉进 zod 依赖 ⇒ 经 index 必炸。

**不许可的形态**：「两份手抄 + 一致性测试」——那正是本规格要消灭的平行真相源。

### D3 · 注入位置 = `finalSystemPrompt`，不做独立 system 消息

落点在 `packages/server/src/execution/reply.ts` 组装系统提示处（`buildSkillDirectorySection()` 的调用点），在角色占位符替换**之后**拼入。两条理由：

1. **语义不混**：目录是「常驻发现面」（每轮不变），`dynamicHints` 是「场景提示」（每轮变）。后者已有「超限时被当最旧先丢」的观察项——**常驻菜单不能坐在会被丢的位置**；`finalSystemPrompt` 才是 harness 认的真 system prompt 面。
2. **不变量不破**：所有注入文本都必须在占位符替换之后拼，保证替换覆盖全部注入内容（含目录段里可能出现的 `@` 字样）。

### D4 · 全 agent 一律注入，不做 provider 分流

不按 provider / 有无工具面分流。已知取舍：给无工具面的 provider 注入一段用不上的目录是噪声，但为它单开分流分支的复杂度 > 收益。**这是取舍，不是遗漏**——后续若要给 HTTP 适配器造工具面，另立单。

### D5 · 文案逐字复用，不另写

形态 = 标题行 + 每条一行 `- <name>: <一句话>` + 一行行为指令（「对应场景先 `read_skill` 取正文再动手」）。**文案逐字取自 `SKILL_CATALOG`**，注入函数不另写说明——另写就是第二份真相。

## 3. 实现形态

| 层     | 落点                                     | 职责                                                             |
| ------ | ---------------------------------------- | ---------------------------------------------------------------- |
| 真相源 | `packages/shared/src/skill-catalog.ts`   | 两个字面量；**零 import 叶子**（自身注释即契约）                 |
| 纯函数 | `packages/server/src/execution/hints.ts` | `buildSkillDirectorySection()`：纯函数、无 I/O ⇒ 可纯单元测      |
| 接线   | `packages/server/src/execution/reply.ts` | 组装系统提示时拼入（单点）                                       |
| MCP 侧 | `scripts/mcp-server-utils.mjs`           | 静态 import 叶子 + re-export；白名单强校验与工具描述文案取自同源 |

## 4. 验收判据（可复跑）

1. **搬迁零行为变化**（实测，非读码）：真跑一次 MCP `tools/list`，`read_skill` 描述里的白名单串与搬迁前**逐字一致**——**不做前后对照不算过**。
2. **打在「真的进 prompt」这一面**：组装式模块测试断言组装出的**第一条 system message** 含该目录段且含全部白名单名字。**只测纯函数不算**——纯函数绿 + 没接上线 = 本活白干。
3. **纯函数格**：输出含全部名字、格式为 `- <name>: <一句话>`、名字集合 === `SKILL_WHITELIST`（无 `undefined` 空洞）。
4. **静态源断言**：全仓证明定义点唯一（只有 `skill-catalog.ts` 持有字面量），`scripts/mcp-server-utils.mjs` 内只剩取值 / re-export。

## 5. 已知边界与挂账

- **常驻成本**：约 13 行（~400–600 token），每轮在场。这是**用常驻上下文换发现能力**的自觉取舍。
- **无工具面的 provider 收不到自取能力**（见 D4），注入的那段目录对它们只是噪声。
- **乙案（事件级动态提示）与丙案（关键词强制注入）不做**：丙案已否；乙案等甲案生效后另立单评估。
- **白名单成员资格调整、技能正文内容改动不属本规格**：那是访问约束与领域内容面。

# skill-discovery 票单 —— 技能发现面注入（甲案）

状态：在飞（2026-09-20 立票）
基线：`dev` = d696bd9（会话分支已 ff 对齐）
背景：用户问「能否让 agent 自主调用 skill」——实核结论：不是模型不肯调，是**发现面不存在**。
`SKILL_CATALOG`（11 个技能名 + 一句话）只活在 MCP server 进程里、从不进 system prompt；
猫对技能面是盲的，除非角色 prompt 里逐条写死某阶段用某技能。本单补这层。

---

## 一、架构裁决（店长，2026-09-20）

### D1 注入面 = 可读面：只注入白名单 11 条，不得注入 `skills/` 全量 28 条

`read_skill` 的白名单是**服务端强制**的（`scripts/mcp-server-utils.mjs` `validateReadSkillParams`：
name 不在 `SKILL_CATALOG` 直接拒）。注入 28 条 = 菜单里 17 项点了报错。
**菜单说谎比没有菜单更坏**——模型试一次拿到错误，之后连真项也不信。
`packages/server/src/routes/skills.ts` 那份 28 条是**前端斜杠命令下拉**用的，语义不同，
本单不碰、也不拿来当数据源。

### D2 单一真相源：目录数据不得存在第二份

今天唯一真相在 `scripts/mcp-server-utils.mjs:271`（`SKILL_WHITELIST`）与 `:286`（`SKILL_CATALOG`）。
server **无法** import 它：`packages/server/tsconfig.json` 的 `rootDir: ".."`（= `packages/`）、
`include: ["src"]`、未开 `allowJs` ⇒ 把 `scripts/*.mjs` 拉进 server 生产代码会先撞类型检查。
故真相须搬到 server 可达处。**机制二选一，实施猫实测后择一，不得自行发明第三条**：

- **机制 A（首选）**：真相搬进 `packages/shared/src/skill-catalog.ts`（**零 import 的叶子文件**，
  只放 `SKILL_WHITELIST` / `SKILL_CATALOG` 两个字面量）——
  - server 侧走现成 `@cat-study/shared` 别名；
  - `scripts/mcp-server-utils.mjs` 改为**静态 import 该叶子 .ts 文件**
    （`../packages/shared/src/skill-catalog.ts`），靠 Node v24.14.0 的原生类型剥离（仅可擦除语法，
    纯 `export const` 满足）。
  - **必须从叶子文件直接 import，不得经 `packages/shared/src/index.ts`**：index 用的是
    `export * from './types.js'` 这类 `.js` 说明符，plain node **不做 .js→.ts 重写**，
    且 `schemas.js` 会拉进 zod —— 经 index 必炸。
  - **必须实测**（`node scripts/mcp-server.mjs` 真跑一次 tools/list + `pnpm test`），
    **只过 tsc 不算**。
- **机制 B（A 实测不成立时）**：真相改落 `packages/shared/src/skill-catalog.json`；
  server 走 `resolveJsonModule`（`tsconfig.base.json` 已开），scripts 走
  `import ... with { type: 'json' }`。
- **A / B 都不成立 → 停下来回报店长**。**不许**退化成「两份手抄 + 一致性测试」——
  那正是本单要消灭的平行真相源。

### D3 注入位置：拼进 `finalSystemPrompt`（第一条 system message），不做独立 system 消息

落点 `packages/server/src/execution/reply.ts`：`resolveRolePlaceholders(...)`（:594）**之后**、
`buildDynamicHints`（:601）**之前**。两条理由：

1. **语义不混**：目录是「常驻发现面」（每轮不变），`dynamicHints` 是「场景提示」（每轮变）。
   后者已有「超限时被当最旧先丢」的观察项（CLI 截断止血单）——常驻菜单不能坐在会被丢的位置；
   `finalSystemPrompt` 是 harness 认的真 system prompt 面。
2. **不变量不破**：铁律那条注入文本同样要在 `resolveRolePlaceholders` 之后拼，保证占位符替换
   覆盖全部注入文本（该不变量注释在 :588-594）。技能目录段若含 `@` 字样也必须被替换覆盖。

### D4 适用面：全 agent 一律注入，不做 provider 分流

实测 dev 库 `agents` 表：店长 / ds猫 / flash猫 / 吐槽猫 走 `llm_provider=claude`（CLI harness，
有 MCP 工具面），dsh猫 走 `dsh`（同款 MCP 挂载）；只有 `本地qwen猫`（ollama, vision）无工具面。
**已知取舍**：给唯一一只 vision 猫注入一段用不上的目录，是 11 行噪声；为它单开分流分支的
复杂度 > 收益。**这是取舍，不是遗漏**——后续若要给 HTTP 适配器造工具面，另立单。

### D5 文案：直接复用 `SKILL_CATALOG` 的一句话，不另写

另写 = 第二份真相。形态：标题行 + 11 行 `- <name>: <一句话>` + 一句行为指令
（「对应场景先 `read_skill` 取正文再动手，正文即该技能定义」）。
常驻成本 ≈ 11 行（~400-600 token）；clowder-ai 的先例（L6 能力唤醒段 ~2KB 常驻 + 6000 token 硬上限）
已趟过这个容量档，可接受。

---

## 二、派活单（ds猫）

**边界**

| 项     | 内容                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 可改   | `packages/shared/src/skill-catalog.ts`（新建）、`packages/shared/src/index.ts`（加一行 re-export，若机制 A/B 需要）、`scripts/mcp-server-utils.mjs`（删本地定义改取值）、`packages/server/src/execution/hints.ts`（新增纯函数）、`packages/server/src/execution/reply.ts`（接线一行）、对应 `.test.ts` |
| 不可改 | MCP 白名单成员资格（不加不减技能）、`read_skill`/`list_skills` 工具描述文案、`routes/skills.ts`、`buildDynamicHints` 的既有三条 hint 语义                                                                                                                                                              |

**不建议改而必须保留的既有导出名**：`SKILL_WHITELIST` / `SKILL_CATALOG` 在
`scripts/mcp-server-utils.mjs` 的导出面**保持不变**（`mcp-server.mjs` 与 `mcp-server.test.js`
是它们的消费者），只是定义点搬家 + re-export。

**建议形态（非强制，可微调）**

- `packages/shared/src/skill-catalog.ts`：`SKILL_WHITELIST: readonly string[]`（**顺序即目录序**，
  逐字保持现有序）+ `SKILL_CATALOG: Record<string, string>`（一句话逐字不变）。
- `packages/server/src/execution/hints.ts`：新增纯函数 `buildSkillDirectorySection(): string`，
  从 shared 取值拼段（纯函数，无 I/O ⇒ 可纯单元测）。
- `packages/server/src/execution/reply.ts`：在 D3 落点把该段并入 `baseSystemPrompt`。

**验收标准（逐条可验证）**

1. `pnpm lint` 三包全绿。
2. **搬迁零行为变化（实测，非读码）**：`node scripts/mcp-server.mjs` 真跑一次 tools/list，
   `read_skill` 描述里的白名单串与改动前**逐字一致**（11 条、顺序不变）。
   取证方式：改动前先跑一次存下输出，改动后 diff——**不做前后对照不算过**。
3. `pnpm test` 全绿。新增测试至少两条：
   - 纯单元：`buildSkillDirectorySection()` 输出含全部 11 个名字、格式为 `- <name>: <desc>`、
     名字集合 === `SKILL_WHITELIST`；
   - **打在「真的进 prompt」这一面**：组装式模块测试断言组装出的**第一条 system message**
     含该目录段且含全部 11 个名字。**只测纯函数不算**——纯函数绿 + 没接上线 = 本单白干。
4. **静态源断言**：全仓 grep 证明 `SKILL_WHITELIST` / `SKILL_CATALOG` 的**定义点唯一**
   （`packages/shared/src/skill-catalog.ts`）；`scripts/mcp-server-utils.mjs` 内只剩取值/re-export，
   **无手抄字面量**。
5. 不留 TODO 空壳；不顺手改别的东西——暴露的真 bug 记观察项回投店长，另开单。

**审查链**：自过 quality-gate → request-review → 投递吐槽猫。收口归店长，不自行合并。

---

## 三、非目标（明确不做，别顺手做）

- **乙案**（事件级动态提示，clowder-ai D11/D14 形态）：不在本单，等甲案生效后另立单评估。
- **丙案**（关键词强制注入）：已否，不做。
- HTTP 适配器（deepseek/ollama）的工具面：另一单。
- 白名单成员资格调整、技能正文内容改动：不在本单。

---

## 四、收口段（店长 · 2026-09-20）

**已收口**：被审 `056f944` → PR #138 → merge `10c442d`（parents `d696bd9` + `056f944`）；
`dev` = `origin/dev` = `.push-gate` = `10c442d`。

- **审查回执**：💬 仅评论——无 P2 及以上、不要求返工。审查者工作树 `8f6277c` 与被审 commit **全树 diff 为空** ⇒ 其全量跑（144 files / 3043 passed）跑的就是被审内容；搬迁零行为变化由其自查探针实测（新旧 `MCP_TOOLS` sha256 同为 `bf6ed823771892bf`）。
- **收口形态**：`closeout/skill-discovery` 分支 **carry 已审 sha 字面量**——无新 commit、不 `commit-tree` 造等价 sha；`.push-gate` 先写 `056f944` 再推（否则门禁判据②「`LAST_REVIEWED` 是被推 sha 的祖先 ⇒ 有未审 commit」必拦）。
- **重启面**：含 `packages/server` + `packages/shared` ⇒ 技能发现面要在运行实例生效须重启（归店长发审批）。

**本目录为何未清**：`docs/run/README.md` 的「活收口即清」其机械闸（`docs/run/docs-run-status-gate/tickets.md` 票 G4）**尚未落地**，存量上浮批（G2）又明确「开工时机归用户授权」。本单不擅自夹带未审 docs commit 进 PR 承载分支——那正撞「收口门禁只认推的正是已审那一笔」。
⇒ 本目录随 G2/G3 批次统一上浮/清理，**不是漏清**。

**遗留项**：见 `docs/run/skill-discovery-errata/tickets.md`（OQ1 Node 下限口径统一 + P3-1 注释失实 + P3-2 备案）。

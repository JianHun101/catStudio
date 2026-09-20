---
status: 在飞
---

# 票：skill-discovery 收口遗留订正（Node 下限口径统一 + 注释失实）

> 立票 2026-09-20 店长 · 来源：`056f944` 审查回执（💬 仅评论，PR #138）的 OQ1 + 两条 P3。
> **二稿 2026-09-20**：用户已授权开工（「按你建议的派」）。二稿按店长本轮实测**推翻初稿两条机制口径**（`.npmrc` 形态、`engineStrict` 代价）⇒ 裁决由「甲」减为「声明 + 故障点断言」。初稿原文见 `d55d133`。

## §1 门槛链（实测/出处分离）

| 面                                       | 门槛        | 出处                                            | 实测？                         |
| ---------------------------------------- | ----------- | ----------------------------------------------- | ------------------------------ |
| `node:sqlite` 免 flag 可用               | 22.13       | `scripts/commit-uuid-gate.mjs:69` 等脚本消费    | 否（文档）                     |
| **类型剥离默认开启**（裸 node 跑 `.ts`） | **22.18.0** | Node 官方 typescript 文档 + nodejs.org PR #8157 | 否（本机只有 v24.14.0）        |
| 本机运行版本                             | 24.14.0     | `node --version`                                | ✅（高于门槛，故门槛不咬本机） |

⊘ **值订正**：初稿写 `23.6` —— **过宽**。类型剥离已回移植到 22.x LTS，写 23.6 会把 22.18+ 的 LTS 用户无谓挡在门外。**正确值 22.18.0**，且**本机未实测**（落地以实测为准，见 §6-2）。

## §2 二稿订正：推翻初稿两条机制口径

### 订正 1 · `.npmrc` 的 `engine-strict=true` 在 pnpm 11 下**完全无效**

临时目录对照实测（pnpm **11.25.0** / node v24.14.0）：

- `.npmrc` 写 `engine-strict=true` → `pnpm config get engine-strict` = **`undefined`**；`pnpm install` 只打 `WARN Unsupported engine`，**exit 0（不拦）**
- 同一个 `.npmrc` 里的 `registry=` **仍被读取** ⇒ pnpm 11 只认源/认证类键，**引擎类键已迁走**

⇒ 初稿（及店长口述）里的「`.npmrc` 配 `engine-strict`」是**错的**。正确形态是 `pnpm-workspace.yaml` 的 `engineStrict: true`。

### 订正 2 · `engineStrict` 能硬拦，但**连坐依赖树** ⇒ 裁决**不采用**

`pnpm-workspace.yaml` 写 `engineStrict: true` 实测硬拦：`ERR_PNPM_UNSUPPORTED_ENGINE`，**exit 1**（`pnpm install` 与 `pnpm run <script>` 都拦）。**但它检查的不止本仓**：

| 实测场景                                    | 结果             |
| ------------------------------------------- | ---------------- |
| 根本身 `engines` 不满足                     | 拦（exit 1）     |
| 根满足、**workspace 成员** `engines` 不满足 | 拦（报成员路径） |
| 根满足、**直接依赖** `engines` 不满足       | 拦（报依赖名）   |

本仓已装 **721 个带 `engines.node` 的包**（76 种取值），其中：

- 最高下界 = **`lint-staged: >=22.22.1`**（另有 `@earendil-works/pi-agent-core: >=22.19.0` 等 10 个）⇒ 票面声明 22.18 却**装不上**，报错指向 lint-staged，**声明与实际门槛自相矛盾**
- `vitest` / `jsdom` / `@asamuzakjp/css-color` = `^20 || ^22 || >=24` ⇒ **Node 23.x 被整档排除**，装 Node 23 的人连 `pnpm install` 都过不去

⇒ 机械拦的成本由**依赖树**而非本仓代码决定，会随 `pnpm update` 静默漂移；且**它拦不到本单真正的故障点**——MCP server 是 harness 用**裸 `node`** 拉起的（`packages/server/src/llm/claude.ts:23`、`dsh.ts:38`、`opencode.ts:25` 三处 `command: ['node', …/scripts/mcp-server.mjs]`），**不经 pnpm** ⇒ 门禁不在那条路上。

## §3 裁决（本票实施内容）

1. **声明下限**：`package.json` 加 `engines.node: ">=22.18.0"`。纯声明——不满足时 pnpm 打 `WARN Unsupported engine`（**非静默**，但不阻断）。
2. **故障点断言**（替代 `engineStrict`）：在 MCP server 启动链路**最前面**加版本自检；不满足时把「需要 Node ≥22.18 / 当前 X / 哪些工具面会死」打到 **stderr** 并 `exit 1`。
   ⚠️ **接线陷阱（本单最容易做假的地方）**：`scripts/mcp-server.mjs:41` / `:49` 是**静态** import，ESM 按 import 顺序求值 ⇒ 守卫若写在 `mcp-server.mjs` 的函数体里、或写在 `mcp-server-utils.mjs` 里，都会**在 `.ts` import 崩掉之后才轮到它 = 永不执行**。正确做法：新建**独立守卫模块**（纯 JS，**不得** import 任何 `.ts`），在 `mcp-server.mjs` 里作为**第一条** `import` 排到 utils 之前。
3. **口径统一（族修·扫复述文本）**：全仓「Node 版本下限」复述面已扫，**共 4 处**（其余 grep 命中均为行为注记，不是下限声称），全部对齐到 22.18.0：
   - `README.md:11`（`>= 20`）
   - `README.md:20`（`# 确认 >= 20`）
   - `README.md:403`（`Node.js 20+`）
   - `.husky/commit-msg:32-33`（`Node ≥ 22.5 … 下限钉在 22.5`）
     ⚠️ README + `.husky/` **不在免审白名单**（免审只 `docs/run/**`）⇒ 走审查链。
4. **项 2 打包进本单**：`packages/shared/src/skill-catalog.ts:20` 删「wayfinder 起图 →」半句（见 §4）。
5. **不做**：不加 `engineStrict`；**不新建 `.npmrc`**（配了也无效，会误导下一个读代码的人）。

## §4 项 2（P3-1）· `skill-catalog.ts` 注释失实

`packages/shared/src/skill-catalog.ts:20` 写「前 9 条 = 流程链段（顺序即链序）：**wayfinder 起图** → grilling/to-spec → …」，而数组前 9 条是 `grilling…session-handoff`（**不含 wayfinder**；wayfinder 在第 10 位，归下一段「后 2 条 = 非流程链补充」）。

该句系从旧 `mjs` 逐字搬来（旧文件同样错），搬完后坐上了**唯一真相源**的位置 ⇒ 错句被升格。**修法**：删掉「wayfinder 起图 →」半句（一行）。

## §5 项 3（P3-2，备案无动作）

`packages/server/src/execution/hints.test.ts` 第 1 条近乎恒真：`entryNames(section) === [...SKILL_WHITELIST]`，而 section 本就由 `SKILL_WHITELIST.map(...)` 生成 ⇒ 只能抓「实现里加了 filter/sort/去重」这类分歧。
**票面就是这么要求的，不是缺陷**；此处只备案，不建议改——真判据在组装式那条（断言适配器真实入参的第一条 system message）。

## §6 边界

- **可改**：`package.json`（加 `engines`）、`README.md`（:11/:20/:403）、`.husky/commit-msg`（:32-33 注释）、`packages/shared/src/skill-catalog.ts`（**仅注释**）、`scripts/mcp-server.mjs`（**仅新增一条 import**）、**新建**守卫模块与其测试
- **不可改**：`SKILL_WHITELIST` / `SKILL_CATALOG` 的**内容与顺序**、`hints.ts` 逻辑、注入落点、白名单成员资格、`mcp-server.mjs` 既有工具逻辑

## §7 验收（行为可验证 + 防假绿）

1. `pnpm lint` 三包全绿 + `pnpm test` 全绿。
2. **门槛值实测（不是照抄本票的 22.18.0）**：能装到 22.18 就装（`nvm`），跑 `node scripts/mcp-server.mjs` 确认 initialize 成功、且 22.17 失败；**装不到就照实回报「未实测、取值依据 = Node 官方文档」**，禁止写成实测。
3. **守卫真的接上线**（防「纯函数绿但没接上线」——上一单 `056f944` 的同型教训）：必须有一条测试**打在接线面**上——读 `scripts/mcp-server.mjs` 源码，断言守卫 import 的行序**早于** utils import；并断言守卫模块源码内**不含** `.ts` 引入。
4. **守卫行为可验**：版本比较纯函数边界用例 `22.17.9`→拒 / `22.18.0`→过 / `24.14.0`→过；**拒绝路径须真跑一次**并回报 stderr 实际文案（可选手法：`node --import <stub>` 用 `Object.defineProperty(process.versions,'node',…)` 伪造低版本，端到端验一次接线真被执行）。
5. **口径一致机械化**：新增静态源断言测试，断言 `package.json` 的 `engines.node` 最小值 == README 三处与 `commit-msg` 注释里的**同一版本字面量**（防再度漂移）；该测试**须做真空性反对照**——改 README 一处跑测试确认**变红**，再改回。
6. 提交 `catstudy [uuid]`；提交信息里的行号 **grep 复核**。

## §8 非目标

- 不给 HTTP 适配器（deepseek/ollama）造工具面；不动白名单成员；不重构 `hints.ts`；不动注入落点
- **不做「何时用」层**（注入内容从 `SKILL_CATALOG` 短句升级为含 `Use when/Not for`）—— 挂用户裁决，不在本单

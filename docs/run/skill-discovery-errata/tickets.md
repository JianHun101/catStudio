---
status: 在飞
---

# 票：skill-discovery 收口遗留订正（Node 下限口径统一 + 注释失实）

> 立票 2026-09-20 · 店长 · 来源：`056f944` 审查回执（💬 仅评论，PR #138）的 OQ1 + 两条 P3。
> **本票是记录，不是派活单——开工时机待用户授权**（裁决 ≠ 派活授权）。

## 项 1（OQ1）· MCP 工具面的 Node 下限被本单顶高

`056f944` 的机制 A（D2）让 `scripts/mcp-server-utils.mjs` import `../packages/shared/src/skill-catalog.ts`（`.ts` 源文件）。裸 `node` 下 import `.ts` 依赖**类型剥离默认开启**（本机实测 `v24.14.0` 通过；`node --no-experimental-strip-types` 下 import 直接 `ERR_UNKNOWN_FILE_EXTENSION` **硬崩**，不是降级）。

⇒ 在低于门槛的 Node 上，**整片 MCP 工具面**（`post_message` / `read_skill` / `query_db` / `request_user_action`）**全有全无地死掉**——用户能正常提交、却整片工具哑火。

### 订正后的口径（审查者实测推翻了店长的原定性）

店长立票时写「README 声明 Node >= 20 ⇒ 本单把下限提上去」——**定性错了**：

- `.husky/commit-msg:32-33` 白纸黑字：「Node ≥ 22.5 才有 `node:sqlite` …（**本仓无 engines 约束，但功能本身已把下限钉在 22.5**）」⇒ 有效下限**早就是 22.5**；
- `README.md:11` / `:20` / `:403` 三处的 `>= 20` 在 `056f944` **之前**就已失准（本单未碰 README，是守边界，不是漏改）；
- 本单真实增量是 **22.5 → 23.6**，不是 20 → 23.6。

⊘ **门槛值 23.6 本机未实测**（本机只有 `v24.14.0`）——审查者按 Node release 口径给出。
落地前须实测：装 22 LTS 与 23.x 各跑一次 `node scripts/mcp-server.mjs` 看 initialize 是否成功。**不要照抄本文的 23.6**。

### 待裁项（用户）

⚠️ **本表的「甲/乙/丙」是「Node 下限口径」的三个候选，与 skill-discovery 票的「甲案/乙案/丙案」（技能发现面形态：目录注入 / 事件级提示 / 关键词强制）无关**——同形异义，勿混裁决。

| 口径   | 做法                                                                            | 代价                                                                         |
| ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **甲** | `package.json` 加 `engines.node`，README 三处 + `commit-msg` 注释同步到实测门槛 | Node 22 LTS 用户被排除——但**诚实**，他们的工具面本来就死                     |
| 乙     | 退回机制 B（目录数据落 JSON），`.mjs` 不 import `.ts`                           | 下限回到 22.5；但要重做 D2 的数据源形态，且两份消费者（TS / JSON）要重新对齐 |
| 丙     | 只改 README 文案，不加 `engines`                                                | 最便宜；但无机械拦截，装错版本仍是**静默死**                                 |

**店长建议：甲。** 「全有全无」的失败模式必须机械拦；丙的静默死正是本仓一贯要防的形态。乙的开销与收益不成比例——为兼容 22 LTS 重造数据源，而在用的运行实例与本机都是 24。

## 项 2（P3-1）· `skill-catalog.ts` 注释失实

`packages/shared/src/skill-catalog.ts:20` 写「前 9 条 = 流程链段（顺序即链序）：**wayfinder 起图** → grilling/to-spec → …」，而数组前 9 条是 `grilling…session-handoff`（**不含 wayfinder**；wayfinder 在第 10 位，归下一段「后 2 条 = 非流程链补充」）。

该句系从旧 `mjs` 逐字搬来（旧文件同样错），搬完后坐上了**唯一真相源**的位置 ⇒ 错句被升格。**修法**：删掉「wayfinder 起图 →」半句（一行）。

## 项 3（P3-2，备案无动作）

`packages/server/src/execution/hints.test.ts` 第 1 条近乎恒真：`entryNames(section) === [...SKILL_WHITELIST]`，而 section 本就由 `SKILL_WHITELIST.map(...)` 生成 ⇒ 只能抓「实现里加了 filter/sort/去重」这类分歧。
**票面就是这么要求的，不是缺陷**；此处只备案，不建议改——真判据在组装式那条（断言适配器真实入参的第一条 system message）。

## 边界

- **可改**：`package.json`、`README.md`（:11/:20/:403）、`.husky/commit-msg`（:32-33 注释）、`packages/shared/src/skill-catalog.ts`（**仅注释**）
- **不可改**：`SKILL_WHITELIST` / `SKILL_CATALOG` 的**内容与顺序**、`hints.ts` 逻辑、注入落点、白名单成员资格
- ⚠️ `package.json` / `README.md` / `.husky/` **不在免审白名单（`docs/run/**`）内 ⇒ 须走审查链**

## 验收

1. 三处口径一致：`grep -n engines package.json` 有值、且 README 三处与 `commit-msg` 注释与之相同。
2. **门槛实测**（不是照抄）：≥ 门槛版本跑 `node scripts/mcp-server.mjs` initialize 成功；低于门槛的失败形态与文档描述一致。
3. `skill-catalog.ts` 注释与数组内容一致（wayfinder 的归段描述正确）。

## 非目标

- 不给 HTTP 适配器（deepseek/ollama）造工具面；不动白名单成员；不重构 `hints.ts`。

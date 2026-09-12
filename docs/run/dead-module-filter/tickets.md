# Tickets: 死模块清理 —— `memory/filter.ts`

用户 2026-09-13 裁「派①清死模块」。来源：`76dddf4` 复审 ✅ 时吐槽猫入池、店长判「该立」。

## 背景（已实核，非转述）

- `packages/server/src/memory/filter.ts`（69 行）导出 4 个符号：`MemoryFilterReason` / `MemoryFilterResult` / `isMemoryFilterEnabled` / `evaluateMemoryContent`。
- **全仓唯一引用 = 它自己的测试**：`grep -rn "filter\.js|evaluateMemoryContent|isMemoryFilterEnabled|MemoryFilterReason|MemoryFilterResult"`（排除 `node_modules`）命中全部落在 `filter.ts` / `filter.test.ts` 两个文件内。
- 孤儿化成因：票壬退役 `saveMessageMemory`（当时的生产调用方）时未连带清理 —— 于是**测试还在给它跑绿、tsc 还在编译它**，是「记录≠真相」的活体。

## T1 · 物理删除 `filter.ts` + `filter.test.ts`，并对齐两处墓碑文案

**What to build:** 删两个文件；把已经在册的墓碑文案从「已无生产调用方」推进到「已删除」，免得下个会话按名去 grep 一个不存在的模块。

**Blocked by:** None — 可立即开工。

- [ ] 删 `packages/server/src/memory/filter.ts`
- [ ] 删 `packages/server/src/memory/filter.test.ts`
- [ ] `docs/plans/memory-flywheel.md` §7 墓碑句：`memory/filter.ts` 已无生产调用方 → **已删除**
- [ ] `.env.example` 的 `MEMORY_FILTER_ENABLED` / `MEMORY_MIN_CONTENT_LENGTH` 墓碑块：补一句「消费模块 `memory/filter.ts` 已删除」（行本身保留，承 `76dddf4` 已裁口径：墓碑不删，只在原地标注）

**边界（做什么 / 不做什么）**

- 做：上列 4 项。
- **不做**：不动 `MEMORY_DEDUP_*` / `MEMORY_UPDATE_THRESHOLD` 墓碑（另一条退役链，`76dddf4` 已收）；不动 `scripts/flywheel/retire-message-memory.mjs`（它查的是 `memories` 表，与本模块无关）；不删 `.env.example` 的任何行；不顺手清理 `memory/` 下其他文件。

**验收（可证伪）**

- **A1** 两个文件不在盘上（`ls` 零命中）。
- **A2（承重反例）** 全仓 grep 上列 5 个符号，改动后**必须零命中**（只允许命中 git 历史）。删前行 / 删后行都要贴出来对账。
- **A3** `pnpm test` 全绿，且**报出净减数**：文件数 108 → 107、passed 数净减 = 被删用例数。「全绿」不等于「真删了」——**计数净减才是**。
- **A4** `pnpm lint` 三包绿（tsc 无悬空 import）。

**决策留痕**

- 跳 grilling：因形态无分支（零调用方死模块，物理删是唯一动作）→ 不单跑 grill。
- Gate B 契约：[边界 = 删 2 文件 + 2 处墓碑对齐 / 契约 = 无（不涉跨组件接口）/ 验收 = A1–A4] 已钉死。
- Gate C 反向证明：A1–A4 全绿能否反证「死模块已清」？A2 零命中 = 无残留引用的直接判据；A3 计数净减 = 代码真被删的第二判据（防「注释掉」或「只删 import」蒙混）⇒ 反证成立。

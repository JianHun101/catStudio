# 消息时间戳按日分级 —— 票单

需求来源：用户 2026-10-13（messages.id `bc81b2c2-e10e-4fd9-8adc-5ee33910f816`）——「切到任意会话时可直接区分每条消息的时间；当天不展示月日；前一天用『昨天』；再之前用月+日；超出当年加年份」。原型方案经用户过目后拍板派活（`a3c144ea-999a-4b41-9d8f-6d5e980d4d5a`），三个拍板项按店长推荐口径：**昨天按自然日、分隔线保留、跨年格式 `YYYY年M月D日`**。

## 现状（实读，base = dev `f7be2913`）

- 每条消息右下角时间戳恒为 `HH:MM`，**无日期信息**：`ChatPanel.vue:78-86` 本地 `formatTime` → 视图模型 `:1295` `timeText` → `MessageItem.vue:520/:523` 渲染。
- 日期只在每天第一条消息上方出分隔线：`ChatPanel.vue:88-102` 本地 `formatDate` + `:105-122` `dateSepIndices`。`formatDate` 已有 今天/昨天/`M月D日` 三档，**跨年分支缺年份**（去年 12 月与上月显示同形）——本单顺手修掉。
- `utils/time.ts` 已是 web 侧时间口径唯一解析入口（`normalizeUtc`/`parseUtc`/`fmtUtcShort`/`fmtUtcFull`），有同目录 `time.test.ts`（纯函数 + 时区无关断言的既有范式）。
- `ChatPanel.vue:73` `normalizeDateTime` 只补「数字时间戳」私有形态，串形态委托 `normalizeUtc`——新函数须同样吃 `string | number`。

## 规格（契约级）

**新纯函数 ×2，落 `packages/web/src/utils/time.ts`**（该文件是时间口径唯一真相源，不另起文件）：

| 消息日期（相对 now，按**自然日**） | `fmtMsgTime`（消息时间戳） | `fmtDateSep`（分隔线） |
| ---------------------------------- | -------------------------- | ---------------------- |
| 今天                               | `HH:mm`                    | `今天`                 |
| 昨天                               | `昨天 HH:mm`               | `昨天`                 |
| 更早、当年内                       | `M月D日 HH:mm`             | `M月D日`               |
| 跨年                               | `YYYY年M月D日 HH:mm`       | `YYYY年M月D日`         |

钉死的口径：

1. **「昨天」按自然日判定，且优先级高于跨年**——12-31 的消息在 01-01 看显示「昨天 HH:mm」，不是「2025年12月31日」。
2. 今天档**不带任何日期前缀**（用户原话「当天不展示月份和日期」）。
3. 签名带显式 `now: Date` 参数——纯函数不碰 `Date.now()`，测试不需要 fake timer。
4. 入参 `string | number`：串走 `parseUtc`，数字走 `new Date(n)`；解析失败返回 `''`（与现 `formatTime` 行为一致，消息只是不显示时间）。
5. 时区无关：分档用本地读数（`getFullYear`/`getMonth`/`getDate`/`toDateString`），断言构造本地 Date 期望值，与机器时区解耦（沿用 `time.test.ts` 既有范式）。

**ChatPanel.vue**：删本地 `formatTime`/`formatDate`，改 import；`normalizeDateTime` 保留（`:318` 仍在用）；`dateSepIndices` 插入逻辑**不动**。视图模型计算时取一次 `now` 传给两个函数。

**已知限制（明确接受）**：时间戳在渲染时定档，不分秒 tick——应用跨午夜常开时，旧消息的档位要等下次视图模型重算才刷新。与既有分隔线行为同性质，不修。

## Gate Report

### Gate A · 需求照准

✅ 用户四条原话逐条可证伪：每条消息可读时间（AC1/AC5）、当天无月日（规则表第 1 行 + AC1）、昨天→「昨天」（AC1 边界用例）、更早→月日、跨年→加年（AC1/AC2）。

### Gate B · 契约锁定

✅ 边界：纯 web 展示格式化——不动 server/shared、不动数据结构、不动 `dateSepIndices` 插入逻辑、不动 `normalizeDateTime`；契约：两函数签名/分档表/昨天优先级/失败回 `''`；验收：AC1-AC6 全部行为可验（含静态源断言与挂载级断言）。

### Gate C · 反向证明

✅ 逐条反推：「切任意会话可区分」→ 每消息自带日期（AC1）；「当天不展示月日」→ 规则表第 1 行；「昨天」→ AC1 边界用例；「月+日」→ 当年档；「超出当年加年份」→ 跨年档 + 分隔线同修（AC2）。无漏网。

### Gate Result

✅ PASS → 单票（纯 web，单组件消费面，不拆多票）。

## 票① web：消息时间戳按日分级（派 ds猫）

- **改什么**：
  1. `packages/web/src/utils/time.ts`：新增 `fmtMsgTime(raw: string | number, now: Date): string` 与 `fmtDateSep(raw: string | number, now: Date): string`，规则按上表。
  2. `packages/web/src/components/ChatPanel.vue`：删 `:78-86` `formatTime`、`:88-102` `formatDate`，import 两新函数；`:1284`/`:1295` 调用点传 `now`（视图模型 computed 内取一次）。
  3. `packages/web/src/utils/time.test.ts`：扩分档行为测试。
  4. `packages/web/src/components/ChatPanel.test.ts`：静态源断言——ChatPanel 不再本地定义 `function formatTime(`/`function formatDate(`（防重新内联，照 R5 守卫搬家范式）。
- **边界**：只动 `packages/web`；不动分隔线插入逻辑、不动 `normalizeDateTime`、不动 MessageItem props 形状（`timeText`/`dateText` 仍是 string）。
- **验收**：
  - AC1 `fmtMsgTime` 五档行为测试全绿：今天 00:00 的消息在 23:59 看 → `HH:mm`（无前缀）；昨天 23:59 的消息在今天 00:01 看 → `昨天 23:59`；当年 2 天前 → `M月D日 HH:mm`；**跨年边界优先级**：2025-12-31 的消息在 2026-01-01 看 → `昨天 HH:mm`；跨年非昨天（如 2025-06-15 在 2026 年看）→ `2025年6月15日 HH:mm`。断言构造本地 Date，与机器时区无关。
  - AC2 `fmtDateSep`：今天/昨天/当年不变；跨年 → `YYYY年M月D日`（现状缺陷修复点，须有对应用例）。
  - AC3 解析失败 → `''`（两函数各一条用例）。
  - AC4 静态源断言：ChatPanel.vue 无本地 `function formatTime(`/`function formatDate(`。
  - AC5 挂载级：ChatPanel 挂混合日期消息，DOM 中旧消息时间戳含日期、今天消息仅 `HH:mm`。
  - AC6 `pnpm test:web` + `node scripts/lint.js` 全绿；`git diff --stat` 仅 `packages/web`。
- **提交**：走 worktree（基点对齐 dev 最新），`catstudy [a3c144ea-999a-4b41-9d8f-6d5e980d4d5a] feat(web): ...`，提交后按 `request-review` 发起审查，收口归店长。

## 收口（2026-10-13）

- **票① ✅ 已收口**：PR #209 MERGED → dev `08f90eb5`。对象面 `c79e197..8e1eb38b`（3 笔：`2be78816` 实现 + `5773c93`/`8e1eb38b` 守卫返工）。审查链：吐槽猫 R1 ⚠️（静态守卫注释字面量假红/假绿两方向缺口）→ ds猫 返工（判据面 `codeOnly` 剥注释 + 正面锚）→ R2 ✅（两方向变异审查者独立复现闭合，全量 3767 测试 + lint 独立复跑绿）。
- **carrier**：closeout 隔离分支 carry 已审 sha `8e1eb38b` 字面量直推，merge commit 由 GitHub 侧生成；隔离分支本地+远端已清理。
- **重启**：无需（纯 `packages/web`，Vite HMR 覆盖）。
- **观察项（P3，均不另开单）**：
  1. `codeOnly` 残口：`time.ts` 日后新增含 `//` 的字符串字面量（URL 一类）时，该行后半截代码会被静默剥掉 ⇒ 反向假绿。已同步写进 lessons 卡。
  2. 残留逃逸类：`new Date(<非简单标识符>)`（如 `new Date(s.trim())` / `new Date(props.createdAt)`）同时绕过守卫的清单与锚（`/^\w+$/` filter 所致）。**店长裁：留痕不单开**——旧版同漏、非本票回归，修法（断未过滤实参多重集）让断言显著变丑，收益不抵。
- **lessons 卡订正**：`docs/lessons/criterion-blind-spot-looks-like-truth.md` §同族② 补第 3 次复发 + `codeOnly` 结构性解法（该卡在 prompt 注入白名单，审查者点名收口必落）——lessons 不在免审面，单独走审查链（详见该笔提交）。

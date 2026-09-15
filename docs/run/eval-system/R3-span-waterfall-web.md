# R3 票：段分解的前端消费（段瀑布 + 真前端默认浅色）

> 归属：评估体系 P2 的 R3（`map.md` §待排 Ⅱ）。**立票 2026-09-15**（用户点头形态 + 明示「直接立票派活」）。
> 前置：R2 段表已落库（`spans` 15 列 / `span_llm` 9 列 + 四索引，`db/index.ts:774+`）；P1-B 链路 tab 已收口（两段条在 `EvaluationView.vue:616-627`）。
> 形态参照：`prototypes/R3-right-panel-v2.html`（已提交 `eb3f2d0`）——**照形态，不照代码**（HTML 原型 ≠ Vue 实现）。

## 结论先行

1. **R3 = 把跳展开的「两段条」换成 11 段瀑布。** 今天看板只能说「这一跳 170 秒」；R3 后能说「170 秒里 `llm.chat` 168.6 秒（99.17%）、首字 `ttft` 2.98 秒、记忆检索 1.16 秒、落库 15ms」。**卡点定位从「哪一跳」下沉到「哪一段」。**
2. **后端只需 1 个只读路由，零现有契约变更。** `ChainHop.executionLogId`（`useApi.ts:186`）就是 `spans.execution_id`——前端手里**已经有**这个 id，`getSpansByExecution()`（`repository/spans.ts:167`）也**已经写好**。缺的只是把它们接出来。
3. **本票携带一条与瀑布无关的小改**（§A 真前端默认浅色）——用户同一轮反馈提出，文件零交集、可独立 revert，故同票携带不同 commit。

---

## 一、范围与边界

### §A 真前端默认浅色（小改，独立 commit）

**用户原话（2026-09-15）**：「我指的就是真前端的默认。」

| 改动点                                        | 现状                  | 目标                                     |
| --------------------------------------------- | --------------------- | ---------------------------------------- |
| `packages/web/src/composables/useTheme.ts:14` | `return 'dark'`       | `return 'light'`                         |
| `packages/web/index.html:2`                   | `<html lang="zh-CN">` | `<html lang="zh-CN" data-theme="light">` |
| `packages/web/index.html:6`                   | `content="#1b1815"`   | `content="#f8f4ed"`                      |

**语义红线（易做错）**：

- 改的是**无存储时的默认**，**不是**覆盖用户选择。`localStorage` 存过 `'dark'` 的用户**必须仍进深色**——`readStoredTheme()` 的既有优先级（存储值 → 默认值）**不动**，只改兜底字面量。
- `index.html` 预置 `data-theme="light"` 是为**消首屏 FOUC**（JS 执行前 `:root` 是深色）。预置后若用户存过 `'dark'`，`applyTheme('dark')` 走 `delete dataset.theme` → 回落 `:root` 深色 ✅。
- **特异度陷阱（写进注释）**：`:root` 与 `[data-theme='light']` 特异度**相同**（均 0,1,0），浅色规则生效**只靠源码顺序**（`index.html` 中 `[data-theme='light']` 块在 `:root` 之后）。**不得**把浅色块挪到 `:root` 之前。

### §B 段瀑布（主体）

1. **后端**：`GET /api/eval/spans`（新只读路由，接线既有 repository，**不写新 SQL**）
2. **前端**：链路 tab 跳展开处，两段条 → 段瀑布；字段说明 `ⓘ`；轴外段独立标注
3. **`useApi.ts`**：加 `getEvalSpans(executionId)` + `SpanDto` 类型

### Out of Scope（明确不做）

- **查询表单 / 日期窗 / 深色图标**——原型里的探索形态，真前端**无此控件**（实测 `EvaluationView.vue` 零 `input[type=date]`）。用户本轮未点名，**不塞进本票**（避免范围蔓延）。
- **实时（进行中执行的段）**——R2 一次执行一事务在 `finalizeRun` 写 ⇒ running 跳查出来**必然是空**。本票只做后视镜（用户未裁实时，按未授权处理，同前几轮）。
- **表结构改动 / 存量回填 / OTLP 导出**——归 R2/后续。
- **`spans` 按 `chain_id` 跨执行聚合**——本票按**单次执行**取数（见契约理由）。

---

## 二、接口契约（店长拍板，实施者不得自行改判）

### 2.1 端点形态：按 `execution_id`，不按 `chain_id`

```
GET /api/eval/spans?execution_id=<execution_logs.id>
→ 200 { ok: true, spans: SpanDto[] }
```

**为什么按 `execution_id`**：

- 前端消费粒度就是**一次执行 = 一跳**（用户展开的是某跳）。按 `chain_id` 取会把整条链的段混在一起，前端还得自己按 `execution_id` 分组——**把已经存在的分组信息丢掉再重建**。
- `ChainHop.executionLogId` **已存在**（`useApi.ts:186`，注释即「挂 `execution_logs.id`」），与 `spans.execution_id` 同值 ⇒ **前端零契约变更**。
- `idx_spans_execution`（`db/index.ts:824`）正是为此建，注释原文「看板主路径：按执行取全段时间轴」。

**响应形状**：

- `SpanDto` = `SpanRow`（`repository/spans.ts:148`，**snake_case 原样**，随 eval 面既有惯例，见 `useApi.ts:116`）**+ `llm: LlmSpanDetail | null`**。
- `llm` **内联**在 span 上（`getLlmDetail()` 逐段调，或一次查全 `span_llm` 后按 `span_id` 归并）——**禁止让前端 N+1**。非 `llm.chat` 段恒 `null`。
- **排序 `start_at, id` 升序**（repository 已如此，路由不得重排）。
- **空数组是合法响应，不是 404**：`execution_id` 不存在 / 该执行未落段（running 中、或采集修复前的存量行）**一律 200 + `[]`**。理由：前端无法区分这两者对用户的意义（都是「无段数据」），404 只会诱发无意义的错误分支。
- 缺 `execution_id` 参数 → **400**（错误体说明缺参）。
- 路由**只读、零 LLM、零副作用**；不得回写任何表。

---

## 三、口径纪律（随票带上，否则报表口径裸奔）

这四条**必须体现在实现里**，不是文档建议：

1. **轴长 = 根段，禁止加总子段。** 瀑布横轴总长取**根段 `invoke_agent` 的 `duration_ms`**。实测子段和 ÷ 根段 = **2.0× / 1.6× / 3.0×**——加总必 >100%，因为段是**嵌套**的（`parent_span_id` 自引用），父子会重复计。
2. **轴外段独立标注，不进瀑布、不计总时长。** `dispatch.queue_wait` 与 `git.auto_commit` 的 `start_at` **在根段之前**（R2 §十三① / D14 明载），硬画会溢出轴。两者**同一处理路径**：瀑布只画 `[root.start_at, root.start_at + root.duration_ms]` 窗内的段；窗外段走「独立标注」区，显示为**单行文字**（如「排队 152s（不计入本次执行）」）。
   - **排队不计入本次执行时长**（用户 2026-09-15 确认）：它等的是上一个 trace 在跑，计入即**重复计时**。
   - ⚠️ 实现陷阱：**轴的起点必须是根段 `start_at`**，**不得**用 `min(start_at)` 全量取最小——那会把排队段拉进轴内。
3. **`running` 与「无数据」分开呈现，不得显示为空白或 `0`。** `endedAt == null`（跳在飞）→ 段**尚未落库**（一次执行一事务）⇒ 文案如「进行中 · 段未落库」；`endedAt != null` 且 `spans` 空 → 「无段数据（存量行）」。
   - 沿用 P1-B 已立的 `null ≠ 0` 判据。
4. **`ⓘ` 只讲真展示在前端的字段。** 用户原话：「没有展示在前端上的字段，就不用描述了」。**禁止**把后端有、界面无的字段（如原型的 `offset` / `items`）写进提示。

---

## 四、验收标准（逐条可执行，实施者须逐条留痕）

### §A 默认浅色

- **A1** 清空 `localStorage` 后加载 → `document.documentElement.dataset.theme === 'light'`，且 `meta[name=theme-color]` 为 `#f8f4ed`。
- **A2** 预置 `catstudy-theme=dark` 后加载 → `dataset.theme` **为空**（回落 `:root` 深色），`theme-color` 为 `#1b1815`。**A2 是本改动的红线，必须真跑**。
- **A3** 首屏无 FOUC：`index.html` 的 `<html>` 已带 `data-theme="light"`。
- **A4** 全量 `pnpm test:web` 绿（既有测试若有假设深色默认者，按新语义修正并在 commit message 写明）。

### §B 段瀑布

- **B1（后端模块测试，真实 SQLite + `app.inject`）**：插一次执行的 N 段 → 命中 N 条、按 `start_at` 升序、`llm.chat` 段带 `llm` 详情、非 LLM 段 `llm === null`。
- **B2**：`execution_id` 不存在 → **200 + `spans: []`**（**不是 404**）；缺参 → **400**。
- **B3（时间序渲染）**：段按 `start_at` 升序从左到右排，**无重叠**、无负偏移。断言用几何量（`getBoundingClientRect()` 或等效），**不得只断计算样式**。
- **B4（轴长口径）**：横轴总长 = 根段 `duration_ms`；**子段宽度和 > 轴长是正常的**（嵌套），实现**不得**归一化子段使其和 = 100%。
- **B5（轴外段）**：构造 `dispatch.queue_wait` 在根段之前的用例 → 它**不出现在瀑布轴内**，出现在独立标注区，且**不计入**总时长显示。
- **B6（null ≠ 0）**：`endedAt == null` 与「`endedAt` 非空但 spans 空」呈现**两种不同文案**，均**不显示为空白或 `0`**。
- **B7（浮层命中区 —— 用户本轮明确要求）**：**鼠标移到「流程名称」上 → 出浮层**；移到同段的其他区域（段身/空白）→ **不出**。浮层**贴名称**（水平间隙小、垂直居中），**不得遮挡**该段数值读数。
- **B8（`ⓘ`）**：每个 `ⓘ` 悬浮出说明；说明内容按 §三.4 只覆盖真展示字段；**至少验一条反例**（一个后端有、界面无的字段**未**出现提示）。
- **B9**：`pnpm lint` + `pnpm test` 全绿。

---

## 五、提交纪律

- **提交信息**：`catstudy [uuid]`——uuid 必须是 `messages` 表内**真实存在**的触发消息 id，否则 `commit-msg` 门禁拦下。
- **行号复核**：提交前用 `git grep -n`（**字节路径**）复核本票引用的行号。PS 文本管道在 UTF-8 无 BOM 源码上会给**反向错位假读数**（本仓已栽 4 次）。
- **两支并行提交**：§A 与 §B **文件零交集**，但**多 Agent 并行时勿 `git add -A`**（会扫走对方未提交的文件）——`git add <具体路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`。
- **本仓 Windows 行尾**：`core.autocrlf=true` 且无 `.gitattributes`，工作区 SFC 为 CRLF、仓库 blob 为 LF。**静态源断言（`?raw` + 多行 `toContain`）在 CRLF 工作区会假红**——撞上时先确认是不是这条，**不得**靠改断言绕过（另单处理）。
- **卡住或票面自相矛盾 → 不自行改判，报店长裁。**

---

## 决策留痕

- 跳 grilling：用户已就 R3 形态**两轮原型迭代逐条拍板**（`dd51821` / `eb3f2d0`），并明示「不用出原型了，按你说的直接立票派活」→ 故本单不单跑 grill。
- Gate B 契约：**边界** = §一（Out of Scope 三项钉死）/ **契约** = §二（端点形状、排序、空数组语义、400 条件）/ **验收** = §四（A1–A4 + B1–B9，逐条可执行）。
- **架构裁决 1（浮层技术选型）**：真前端现用原生 `title`（`EvaluationView.vue:616-627`）——撑不起 11 段多字段结构、延迟 ~1s、无法贴名称。**改自定义浮层**，命中区 = **段名元素**（用户 2026-09-15 明确要求「鼠标放到对应流程名称上再展示悬浮贴」）。
- **架构裁决 2（轴外段）**：`dispatch.queue_wait` 与 `git.auto_commit` 的 `start_at` 均在根段之前 ⇒ 统一走「独立标注」，**不进瀑布、不计总时长**。轴起点取**根段 `start_at`**，禁用 `min(start_at)`。
- **架构裁决 3（同票携带 §A）**：默认浅色与瀑布**文件零交集**、可独立 revert，且同为用户一轮反馈 ⇒ 同票不同 commit，省一轮审查往返。
- **架构裁决 4（按 `execution_id` 而非 `chain_id`）**：前端消费粒度 = 一跳，且 `ChainHop.executionLogId` 已与 `spans.execution_id` 同值 ⇒ 零契约变更、命中既有主路径索引。

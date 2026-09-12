# 票单 · memory-flywheel

> 规格地图见同目录 `map.md`（grilling 产出，Decisions 1–35 为已裁结论）。
> **2026-09-12 段三发车批次**（**Decisions 34/35**，用户原话「1 物理删 2 退 + 删 3发车」）：段三 15 问全裁（2 条用户裁 + 13 条店长拍板）⇒ **五票出票 = 票己（索引表 schema）/ 票庚（扫描器）/ 票辛（检索接线）/ 票壬（旧写口退役）/ 票癸（段一归位）**。**首发派活 = 票己 → ds猫、票癸 → flash猫**（**两票已收口 `8efab3d`**，见 map Decisions 36）。**第二轮派活（2026-09-12）= 票庚 → ds猫、票壬 → flash猫**——两者改动面无交集；**票辛 依赖票庚 + 票壬 落地 ⇒ 留待下一轮**（**单槽位 FIFO ⇒ 不一次堆满队列**）。
> **2026-09-12 授权批次**（Decisions 31）：票丙 / 票丁 / 票戊 出票；票丁排队。
> **⚠️ 派活中断修正（2026-09-12 补）**：首次执行在 `31c7eb5` 落盘后被中断（`execution_logs` 记 `interrupted`），**派活消息从未发出**（本会话 `messages` 表零条含「票丙/票戊/ds猫」；实施者零执行记录）。本行原写「票丙、票戊已派活」是**未兑现的乐观表述，已改**。**票丙、票戊已于本轮补派**（ds猫 / flash猫），状态见各票「状态」行。
> **收口清账（2026-09-12 补，店长 `git merge-base --is-ancestor` 实查非转述）**：**票丙**（交付 `c953dd4` → 审查反例回归补正 `4552237`）与**票戊**（交付 `edb1f2d`）**均已并入 `dev`**（携带者 `20f9c93` / `1395a44`）⇒ 两票状态行本轮翻「**已收口**」，**勿再派活**。**票乙**已收口且挂账两轮 ⇒ 按本文第 7 行「活收口即清」**移出本文件**（结论承接面 = `map.md` Frontier 票乙条 + Decisions 26；票单正文留 git 历史）。**票丁**排队原因（怕与票丙/票戊并行、收口时分不清「是谁的行为变化」）**已随两票落地消解 ⇒ 本轮派活**。
> 本文件只放**可派活的票单**——一票一段，含边界 / 契约 / 验收 / 决策留痕。
> 规矩（承 `docs/run/README.md`）：活收口即清，结论上浮到 `docs/plans/` 或 `docs/sessions/`。

---

## 票丙 · 切片器 + 表格转写（段三 · 纯函数模块，**不接线**）

**状态**：**已收口**（2026-09-12：交付 `c953dd4`（切片器 + 表格转写 + C3 frontmatter 剥离）→ 审查反例回归补正 `4552237` → **ff 并入 `dev`**，携带者 `20f9c93`（其合并说明记「审查 💬 零返工」）；店长实查。**勿再派活**）
**承**：map Decisions 14（450 上限 + 回退链 + 实测条）/ 21 三·四（块不放大、面包屑进文本）/ 27 + 28 一（转写 5 规则 + 全表无条件）/ 29（回退链补全 + 段首句锚 + 片序号不进文本）
**动机**：扫描器（Q5）与索引表（Q6）未裁 ⇒ 切片器**现在不接线**，先交付一个「MD 文本进、切片出」的**纯函数**。这是段三唯一能独立开工且能独立验证的一件——接线归后续票，届时它是被调用方而非被改方。

### 目标（可证伪）

给定 `{ path, content }`，输出切片数组：**每片 `text` 长度 ≤ 450**（含面包屑与话题锚），且**不存在因超长而静默丢弃的正文**——任何超长内容都被落到 L3-d/e/f 某个合法边界上。存在一片 `text` > 450、或存在一段原文内容不在任何片的 `body` 中（且不在硬切报告里），本票即失败。

### 落点

```
packages/server/src/memory/flywheel/
  table-transcribe.ts       + table-transcribe.test.ts
  segment.ts                + segment.test.ts
```

同域同目录（承项目 Conventions「测试跟随被测模块」）。

### 边界

**In Scope**

- `transcribeTableBlock(block, opts?) -> string[]`：Decisions 27 五条规则逐条落实
- `segmentDocument(input) -> SegmentReport`：L1 / L2 / L3-a…f 完整回退链 + 面包屑 + 段首句锚
- 两文件的纯单元测试（语料可用内联字符串 + 少量真实文件断言）

**Out of Scope（钉死，防扩线）**

- **不接线**：不 import `db/**`、不 import `embedding.ts`、不写任何表、不加 env 开关。本票产物**无任何运行时可观察行为变化**
- **不算身份键**（地图 Decisions 17 的「路径 + 小节锚 + 内容哈希」由上层组）——切片器只**输出** `path` / `sectionAnchor` / `body` 供上层取哈希
- **不做孤儿行清理**（Decisions 29 尾挂给段三后续票；本票无表可清）
- **不建 `docs/lessons/`**、不改任何 MD 文件（转写只发生在返回值里，磁盘一字不动）
- **不引模型 / 不引网络**：`。！？；` 之外一律走正则与字符串操作；生成式概括**禁止**（Decisions 29 四 2）
- **不动 `packages/server/src/memory/` 既有四个文件**（`embedding.ts` / `filter.ts` / `index.ts` / `query-rewrite.ts`）

### 契约（接口钉死）

**C1 · 转写（纯字符串变换）**

```ts
export function transcribeTableBlock(block: string, opts?: { prefix?: string }): string[]
```

- 输入：一个完整 markdown 表格块（表头行 + 分隔行 + 数据行，可含前后空白）
- 输出：**每个数据行一条** `列名1：值1；列名2：值2；…`；`prefix` 非空时作为该行前缀（`【<prefix>】` 形态由实现定，但**同节多表时必须产生可区分的行**）
- 五条规则（Decisions 27，逐条可单测）：① 丢弃 `|---|` 分隔行 ② 空单元格 ⇒ 该项**整条不输出**（不留 `列名：`）③ `\|` → `|`、单元格内 `<br>` / 真换行 → 空格 ④ 列名取自**表头同列** ⑤ **不重复造标题**（标题链由面包屑统一承担，本函数**永不**输出标题行）
- 单元格数 > 表头列数时：**多出的值丢弃并计一次告警**（不得静默错位）——此条为实施期补钉，须在测试中固化
- 非表格输入（无分隔行）⇒ **原样返回该块的非空行**（不 throw，转写是 L3-a 的一级，判错形态会把上级逻辑拖成异常路径）

**C2 · 切片**

```ts
export interface SegmentInput {
  path: string
  content: string
}

export interface Segment {
  path: string // 原样透传
  sectionAnchor: string // 节锚（H2 > H3 链文本），按节去重 / 整节返回的键
  breadcrumb: string // `相对路径 > H1 > H2 > H3`（缺级则省略），进 text
  body: string // 该片正文，不含面包屑与话题锚
  text: string // 嵌入文本 = breadcrumb + 话题锚（若有）+ body
  partIndex: number // 1-based
  partTotal: number
  hardCut: boolean // 该片由 L3-f 字符硬切产生
}

export interface SegmentReport {
  segments: Segment[]
  hardCuts: { path: string; sectionAnchor: string; partIndex: number }[]
  maxTextLength: number
}

export function segmentDocument(input: SegmentInput): SegmentReport
```

- **回退链（每一级都是一个合法边界，顺序不可换）**：L1 `##`（无则 `#`，再无则整文件一块）→ L2 `###` → L3-a 表格行（**全表无条件转写**，Decisions 28 一）→ L3-b 条目边界 `^\s*([-*+]|\d+[.)])\s` → L3-c 空行（段落）→ L3-d 句边界 `。！？；`（标点随前片）→ L3-e 行边界 `\n`（**代码块专用**：识别 ``` 围栏，围栏语言标记复制到每片）→ L3-f 字符硬切 450
- **转写行的刀插在 L3-c 与 L3-d 之间**，切点是 `；` 不是 `：`（Decisions 29 三 尾注）
- **话题锚（Decisions 29 四 2）**：**仅当**该片由 L3-d 或 L3-f 产生**且不是该段首片**时，`text` 前置**该段首句原文**；`body` 不含锚
- **片序号不进 `text`**：`partIndex` / `partTotal` 只作字段（Decisions 29 四 3）
- **450 是 `text.length` 上限**，面包屑与锚一并计入（Decisions 29 四 3）
- **`hardCut: true` 的片照样入库**，只写进 `hardCuts` 报告（Decisions 29 三：例外不再是「不切」）
- **确定性**：同输入同输出；**不读时钟、不读环境变量、不读文件系统**

**C3 · frontmatter 剥离（2026-09-12 补，承 map Decisions 33 二；审查实测缺口）**

> **为什么补**：`splitTopLevel` 的前言块 = `push(0, h2Idx[0], '')`，而 `if (isH1[i] || isH2[i]) continue` **只跳 H1/H2 标题行** ⇒ **首个 `##` 之前的一切（含整块 YAML）落进 `body`**（`segment.ts:239 / :249`，已提交的 `33a669f` grep `frontmatter|yaml` 零命中）。票戊已给 7 份 ADR 插入 8–19 行 frontmatter ⇒ 不剥则每份**前言片背着裸元数据进嵌入文本**（多条 ADR 前言片彼此同质、互相挤占 top-K；`status: accepted` 还污染语义检索），正面冲掉 Decisions 21 四「**元数据不进嵌入文本**」。

**六条规则（钉死）**：

1. **仅当文件第 1 行恰为 `---`**（允许尾随空白）才进入剥离判定；**正文中间的 `---` 是水平分割线，不剥**。
2. 向下找下一个恰为 `---` 或 `...` 的行，**含该行**一并剥离。
3. **未闭合**（到文件尾仍未找到）⇒ **不剥**，整份按普通正文处理。**向严不向宽**：宁可多索引，不可误删内容。
4. 剥离段**不进 `body` / 不进 `breadcrumb` / 不进 `warnings`**——它是**正常元数据，不是异常**。
5. **不解析 YAML**（不引 yaml 库、不校验键值）——只做围栏剥离。**字段消费是扫描器的事**，切片器只负责「元数据不进正文」。
6. 剥离后首行若为空行，**不影响后续**（L1 按 `##` 切）；H1 仍由面包屑承担。

**边界（须在测试固化）**：① 正文中间含 `---`（不剥）／② 只有开头 `---`、无闭合（不剥）／③ 剥离后首行空行（正常切）／④ frontmatter + 无 H1 直接 `##`（前言块为空 ⇒ **不产出空片**）。

### 验收（逐条可执行）

| #   | 验收项         | 判据                                                                                                                                                                                                                                   |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 转写五规则     | 单测逐条：分隔行丢弃 / 空单元格整项不输出（断言**不含** `列名：`）/ `\|` 与 `<br>` 还原 / 列名取自表头同列 / 输出**不含**任何 `#` 标题行                                                                                               |
| A2  | 转写异常面     | 单测：列多于表头（多出值丢弃 + 有告警痕迹）/ 非表格块原样返回（不抛）                                                                                                                                                                  |
| A3  | 回退链逐级     | 单测每级各一例：L1 无 `##` 用 `#` / 无标题整文件一块 / L2 按 `###` / L3-a 表格无条件转写（**短表也转**，断言返回值无 `\|` 形态）/ L3-b 条目 / L3-c 段落 / L3-d 句边界（标点随前片）/ L3-e 代码块按 `\n` **且语言标记复制** / L3-f 硬切 |
| A4  | 450 不变式     | 性质断言：对**全部真实语料**（`docs/adr/**` + `docs/plans/**` + `docs/lessons/**`）跑 `segmentDocument`，`segments.every(s => s.text.length <= 450)` 为真；`maxTextLength` ≤ 450                                                       |
| A5  | 无内容丢失     | 同一语料：把所有片的 `body` 与原文比对，除空白归一化外**不得有正文段落缺失**；凡缺失必出现在 `hardCuts` 报告里                                                                                                                         |
| A6  | 面包屑与锚     | 单测：多级标题的 `breadcrumb` 为 `路径 > H1 > H2 > H3`；**段首片无锚、非首片有锚**（锚 = 该段首句原文，断言与原文逐字相同）                                                                                                            |
| A7  | 纯函数静态断言 | `segment.ts` / `table-transcribe.ts` 源码**不含** `from 'fs'` / `node:fs` / `@huggingface/transformers` / `process.env` / `Date.now`（`?raw` 读源断言）                                                                                |
| A8  | 不接线         | `git diff --name-only` 仅含 `packages/server/src/memory/flywheel/**`；既有四个 memory 文件零改动；无 `db/**` import                                                                                                                    |
| A9  | 全量测试绿     | `pnpm test` 全绿；既有测试断言一条不删不弱                                                                                                                                                                                             |

**签收判据**：A1–**A11** 全过 + 实施者自报「未触碰 Out of Scope 清单任一项」+ **A4 的实测片数/硬切次数写进交付说明**（这是换型触发条件②「千级切片」的第一个真实读数，别再拿估算当数据）。

**C3 追加验收（2026-09-12 补，承 map Decisions 33 二）**：

| #   | 验收项               | 判据                                                                                                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A10 | frontmatter 不进正文 | 对**真实 ADR**（建议直接取 `docs/adr/0011-execution-engine-extraction.md`）跑 `segmentDocument`，断言**所有片的 `body` 与 `text` 均不含** `type:` / `status:` / `evidence:` / `- kind:` 字面 |
| A11 | 剥离边界四例         | 单测：① 正文中间含 `---`（**不剥**）／② 只有开头 `---`、无闭合（**不剥**）／③ 剥离后首行空行（正常切）／④ frontmatter + 无 H1 直接 `##`（**不产出空片**）                                    |

### 决策留痕

- 跳 grilling：形态在地图经 Q3/Q3-a/Q3-b 多轮 grilling 已裁（Decisions 14 / 21 / 27 / 28 一 / 29）→ 故本单不单跑 grill
- Gate B 契约：[边界=In/Out 双向钉死 / 契约=C1–C2 签名 + 回退链顺序 + 450 口径 / 验收=A1–A9]
- **不接线的裁决（本轮新定）**：扫描器（Q5）与索引表（Q6）未裁 ⇒ 若现在接线，切片器的接口要跟着未裁的下游反复改；纯函数形态让它**可独立验证、且将来是被调用方而非被改方**
- 本票过门记录：Gate Report 见 map Decisions 31

---

## 票丁 · 嵌入独立 sidecar（段三 · **已收口**）

**状态**：**已收口**（2026-09-12：交付 `ee7e287` **ff 并入 `dev`**，携带者 = **同一 sha**（`f11b274 → 41a3272 → ee7e287` 线性纯后代、无分叉 ⇒ ff 不改写被审 sha）；店长实查。**勿再派活**）｜原记录「已派活」（2026-09-12；排队原因——怕与票丙/票戊并行、收口时分不清「是谁的行为变化」——**已随两票落地消解**）
**派活前前提复核（店长实测，2026-09-12）**：`packages/server/src/memory/embedding-client.ts` 与 `scripts/flywheel/` **均不存在**（落点为新建，不覆盖既有文件）；`embedding.ts:72` 仍 `return []`、`:43` 仍有 `pipeline(` ⇒ **症状面与出票时一致，契约无需改**。`@huggingface/transformers` 已在依赖内 ⇒ **无需安装请求**。
**审查结论**（2026-09-12 吐槽猫 **💬 仅评论**，**零返工项**）：B1 **真进程真模型独立复现 → 逐位相同**（`diffs=0 maxDelta=0`、512 维、独立 pid、杀 sidecar 后端口不可达）；ESM 入口实解 `transformers.node.mjs`（**非 `.cjs`**）；**两处反向突变实测判别力**——禁 `isEnabled` 分流 → **3 红**（恰为 B6 三条）、`embedText` 短路假失败 → **3 红**（B6 + 代理接线两条）⇒ 接线**真被测**；B1–B7 / B9 逐条核实 + Out of Scope 反核（`saveMessageMemory` 仍在 `ingest.ts:370`、默认模型未动）；行号 `git grep` 权威复核**零漂移**；全量 `2039 passed / 103 files` + `lint 3 包` + `handoff e2e 228/0`。
**⚠️ 收口时需用户重启审批**（改 server 运行时；派活即声明，承本票「签收判据」）——**重启即 B8 真机窗口**。
**承**：map Decisions 28 二（形态已裁 = 独立 sidecar；**不随票甲关闭而撤销**）
**动机**：让「换型 = 改配置 + 重启 sidecar」成立（Decisions 28 三 的条件触发**能否被执行**全靠它），并让 server 重启不再背模型冷启动。

### 目标（可证伪）

嵌入推理跑在 server **主进程之外**的独立进程里；sidecar 起不来 / 探活失败 / 请求超时 / 模型维度不符 时，调用方能**区分**「未启用」与「失败」（现状 `embedText` 失败返回 `[]`、上游 `:92` 直接 `return` —— 两者不可区分）。存在任一路径静默返回空向量且无痕，本票即失败。

### 开工前必须钉死的三件（**本票已钉**，承 Decisions 28 二）

**① 降级面 = 明确失败，不退回进程内**

- sidecar 不可用 ⇒ `embedText` **不得**再返回 `[]` 了事。改为返回**带原因的失败**：`{ ok: false, reason: 'spawn-failed' | 'health-timeout' | 'request-timeout' | 'bad-status' | 'dim-mismatch' | 'not-enabled' }`，调用方按 `reason` 分流日志。
- **不保留「退回进程内」的第二实现**——两套实现并存 ⇒ 双份维护、换型收益归零。本仓 memory 全链 fire-and-forget（`AGENTS.md`「失败不阻塞」）⇒ 嵌入失败 = **不写入/不召回记忆**，不影响对话主链，可以显式失败。
- **告警给谁（诚实标注：本仓无告警基础设施）**：钉成 ① `log.error` 结构化字段含 `reason` ② **首次失败后**在检索结果上打降级标记（避免每轮刷日志）。不新造告警通道。

**② 探活与超时参数**

| 参数                 | 值  | 理由                                                           |
| -------------------- | --- | -------------------------------------------------------------- |
| 首启探活上限         | 30s | 冷启动含模型加载                                               |
| 单次嵌入请求超时     | 10s | 512 维小模型正常 < 100ms（Decisions 14 实测 27–39ms）          |
| 探活失败后的重探冷却 | 30s | 抄蓝本 `REPROBE_COOLDOWN_MS`（`EmbeddingService.ts:43`）       |
| 批量上限             | 64  | 抄蓝本两侧一致（`EmbeddingService.ts:34` / `embed-api.py:66`） |

**③ 生效 modelId 取 sidecar 回报**

- 主进程**不写死模型白名单**；`/health` 返回 `{ model, dim }`，主进程以它为权威（蓝本 `interfaces.ts:423-426` 同款）。
- **维度不一致 ⇒ 启动自检明确报错**（Decisions 16 护栏②）：库内向量维度 ≠ 回报维度 ⇒ 拒绝启动嵌入路径并报错，**不得**让 `vec_distance_cosine` 在查询期抛错后被 catch 成「记忆突然搜不到」。

### 形态裁决（本轮新定，ADR 0007 检查单）

- **sidecar 用 Node 子进程复用现有 `@huggingface/transformers` + 已缓存模型，不引 Python。** 蓝本用 Python 是为 MLX/GPU，本仓是 CPU + 512 维小模型 —— 引 Python 等于新增一套运行时/依赖/打包基建，收益为零。简单形态默认（ADR 0007 第 3 条），要引 Python 须附「Node 为什么不可行」的证伪证据。
- 进程内模型必须移出的理由**已由 Decisions 28 二 裁**，本票不重开。

### 边界

**In Scope**

- `scripts/flywheel/embed-server.mjs`（sidecar：HTTP `POST /v1/embeddings` + `GET /health`，仅监听 `127.0.0.1`）
- `packages/server/src/memory/embedding-client.ts`（客户端 + 探活 + 超时 + 重探冷却 + 降级）
- `packages/server/src/memory/embedding.ts` 改为客户端代理（保留 `isMemoryEnabled` / `embedText` 导出名，**改返回形态**）
- sidecar 的启停（随 server 启停；Windows 下按项目既有 spawn 约定）
- 各文件单测 + 一条 e2e（真起 sidecar 进程，`*.e2e.mjs`，不进 vitest include）

**Out of Scope（钉死）**

- **不删 `saveMessageMemory`**——旧写口去留是**段三阻塞项**、须单独裁（Decisions 17）；本票不碰写口数量
- **不建索引表**（Q6 未裁）、不写 `embedding_meta` 之外的新表
- **不换模型**（Decisions 28 三：暂不换型）；模型名从 env 读，默认仍 `Xenova/bge-small-zh-v1.5`
- **不做「免启动懒加载」优化**之外的守护逻辑（崩了不自动重启——重探冷却负责恢复，重启策略另议）

### 验收（逐条可执行）

| #   | 验收项          | 判据                                                                                                                                                                                 |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | 正常路径        | 起 sidecar → 嵌入一段中文 → 返回 512 维；与**现有进程内实现**对同一文本的向量**逐位相同**（换壳不换语义）                                                                            |
| B2  | 降级 · 起不来   | sidecar 未启动 ⇒ 返回 `{ok:false, reason:'spawn-failed' 或 'health-timeout'}`，**不是 `[]`**；日志含 reason                                                                          |
| B3  | 降级 · 超时     | stub sidecar 挂起 > 10s ⇒ `request-timeout`，调用方在 10s 量级返回，不挂死                                                                                                           |
| B4  | 降级 · 维度不符 | stub `/health` 回报 dim=1024 ⇒ 启动自检报错，**不进入查询路径**                                                                                                                      |
| B5  | modelId 取回报  | stub `/health` 回报 `model: 'X'` ⇒ 主进程日志与后续调用均以 `X` 为准（源码无模型白名单常量）                                                                                         |
| B6  | 未启用 ≠ 失败   | `MEMORY_ENABLED=false` ⇒ `reason:'not-enabled'`，与 `spawn-failed` **可区分**                                                                                                        |
| B7  | 零回归          | `pnpm test` 全绿；既有 memory 单测按新返回形态更新（**不删断言**）                                                                                                                   |
| B8  | 真机            | `pnpm start` 起 server ⇒ sidecar 自动起、嵌入可用；停 sidecar ⇒ 降级路径按 B2 生效                                                                                                   |
| B9  | 模型真在进程外  | `packages/server/src/memory/embedding.ts` 源码**不含** `pipeline(` 调用（`?raw` 静态断言）；真机验 sidecar 为**独立 pid**（主进程 pid ≠ sidecar pid），且停掉 sidecar 后主进程仍存活 |

**B9 的由来（spec-gate Gate C 补钉）**：B1–B8 全部只验「通过 HTTP 拿到了对的结果」——实现若在 `embedding.ts` 里内联 `pipeline(...)` 再自问自答，B1 照样绿。**验证面必须与被判面同面**（票乙那次的同款教训）。

**签收判据**：B1–B9 全过 + 实施者自报 Out of Scope 未触碰 + **需用户重启**（改 server 运行时）⇒ 派活时即声明。

### 决策留痕

- 跳 grilling：Decisions 28 二 已裁形态，本票只补三件操作参数（Gate B）
- Gate B 契约：[边界=In/Out 钉死 / 契约=三件已钉 + 返回形态变更 / 验收=B1–B8]
- 形态裁决（Node 子进程 vs Python）走 ADR 0007 检查单，见上
- 本票过门记录：Gate Report 见 map Decisions 31

### 收口留痕（店长，2026-09-12；**不随本活收口删除**）

| #        | 内容                                                                                                        | 处置                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B8**   | 真机：`pnpm start` ⇒ sidecar 自起、嵌入可用；停 sidecar ⇒ 按 B2 降级                                        | **✅「启用」分支已于 2026-09-12 15:30 窗口验完**（`MEMORY_ENABLED=true`；sidecar 自起 + 真文本 512 维 + 停 sidecar 降级 + 自愈，四条实测原文见 **map Decisions 47 一/二**）。**主库形态（`pnpm start`）仍未覆盖**——见下方两条如实标注 |
| **OQ4**  | `libuv` 断言（进程关停链）                                                                                  | **✅ 已兑现并出票 ⇒ 票巳**（2026-09-12 20:33 重启窗口取证：**关停侧零日志**——判定规则「无回收行才出票」触发）。根因两条：① `stopEmbeddingSidecar()` 零日志 ② 按钮重启路径根本不走 `shutdown()`（dev.js `taskkill /F` 硬杀）。详见票巳 |
| **P3-1** | 降级处理不对称：HTTP 非 200 走 `dropSidecar()`（杀进程），响应 JSON 解析失败 / 形态不符只 `failAll` 不 drop | 留观察——方向安全（多撞一次才被冷却拦住）                                                                                                                                                                                              |
| **P3-2** | OQ3 `baseUrl` 测试钩子命名（无 `__test_` 前缀）                                                             | 顺手项，下次动该文件时对齐                                                                                                                                                                                                            |

#### B8 真机实查（2026-09-12 12:02 重启窗口；店长取证，全部读日志/进程原文）

| 面                 | 判据                                                                                                      | 结果                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新代码真机生效     | `packages/server/data/cat-study.log` 出现 `记忆功能未启用（MEMORY_ENABLED=false），嵌入 sidecar 不启动`   | ✅ 该串**仅存在于新版** `memory/embedding.ts:59`（旧版无此分支）                                                                                                                                 |
| 启动接线真执行     | 上述日志由 `startEmbeddingSidecar()` **函数体内**打出                                                     | ✅ 反证 `index.ts:243` 的 `void startEmbeddingSidecar()` 真机跑到了，非死代码                                                                                                                    |
| 模型确已移出主进程 | 本次启动**零条** `加载嵌入模型...`；对比 08:42:50 旧版启动后打该串                                        | ✅ 主进程不再加载模型                                                                                                                                                                            |
| 降级面真机可见     | `12:03:33` 打出 `知识库查询嵌入不可用，跳过检索` + `reason:"not-enabled"`（调用点 `memory/index.ts:385`） | ✅ **票丁契约①在生产路径上生效**：「未启用」带 reason，不再静默空数组                                                                                                                            |
| 未启用零开销       | 全机 node 进程枚举**无 `embed-server` 进程**；无 sidecar 监听端口                                         | ✅ 未启用即不 spawn                                                                                                                                                                              |
| **启用分支**       | spawn + stdout 握手 + `/health` + 维度自检 + 关停回收                                                     | ❌ **未验**——需 `MEMORY_ENABLED=true`，与 Q1 裁决（不索引对话原话）冲突 ⇒ 刻意不为测试打开；其中 spawn/握手/维度自检已由 B1 e2e **真进程真模型**覆盖，真机独有增量 = 启用后的启动链路 + 关停回收 |

**两条如实标注**：① 本窗口重启的是 `pnpm dev`（实验库 `cat-study-dev.db`，12:02 写入）而非 B8 原文的 `pnpm start`（主库 `cat-study.db` 最后写入 08-25）——sidecar 链路两者同一份代码，但**主库形态未覆盖**；② 关停侧（SIGINT → `stopEmbeddingSidecar()` 回收）本窗口**未发生**（旧进程的关停日志不在本进程日志内），与 OQ4 的 libuv 断言同属未观察项。

---

## 票戊 · 段一回填：7 份近期 ADR 判 status + 填 evidence

**状态**：**已收口**（2026-09-12：`edb1f2d` **ff 并入 `dev`**，携带者 `1395a44`；店长实查。**勿再派活**）｜原记录「已审查通过 · 待收口」（2026-09-12 吐槽猫 💬**仅评论**：机械面独立复核全过——25/25 ref 可校 / 7/7 正文 hash-object **字节一致** / 0 越界；**零返工项**）。交付 = `edb1f2d`（7 份 frontmatter）。审查提三条**均归票面/地图、不归实施者**，已在 map **Decisions 33** 处置：① `date` 口径裁「写入即冻结、扫描器只补缺」（0011 保留 `2026-08-26`）；② **frontmatter 剥离**缺口转挂**票丙 C3**（本票 Out of Scope 内，不改）；③ `33a669f` 抢收实证。**收口已于 2026-09-12 执行（ff-only → dev，携带者 `1395a44`）。**
**承**：map Decisions 22（断点 2026-08-13 / ADR 0007 起 7 份）/ 20（frontmatter 载体 + `{kind, ref}` 形态 + 机器只校存在性）/ 11（落地锚 = 自证标记）
**动机**：老件 fail-closed + 无回填触发 = ADR **永久真空**（Decisions 22 五：闭环自锁）——ADR 恰是知识密度最高的一批，全数落在索引外则段三建成后无决策可检索。

### 目标（可证伪）

`docs/adr/` 下 **7 份**近期件（`0007` / `0008` / `0009` / `0011` / `0012` / `0013` / `0014`）各带 YAML frontmatter，含 `type` / `date` / `status` / `evidence` 四个字段；每条 `evidence.ref` 机器可校（commit sha 用 `git cat-file -e <sha>^{commit}`、路径用存在性）。**少于 7 份带齐，或有 ref 校验不过，本票即失败。**

### 边界

**In Scope**

- 上述 7 个文件的 **frontmatter 新增**（文件开头插入，**正文一字不动**）
- 每份的 `evidence` 逐条取自该 ADR 正文已有的落地证据（成文于正文的 commit / 文件路径），**不新造证据**

**Out of Scope（钉死）**

- **不碰 0001–0006**（老件一律 fail-closed，Decisions 11/22）
- **不补 0010 缺号**（Decisions 22：缺号不补）
- **不动 `research-*` / `roadmap.md` / `css-coding-standards.md`**（Decisions 22：不在本轮）
- **不改任何 ADR 正文**——包括不统一 `> **状态**：` 引用块（那是段一归位/门牌的活，另议）
- **不建 `docs/adr/README.md` 门牌**（Q2-c 未裁，门牌形态未定）
- **不扩 `status` 值域**（见下「值域口径」）

### 值域口径（本票的实现前提，诚实标注为**临时口径**）

`status` 取 **ADR skill 原形四值**：`proposed` / `accepted` / `rejected` / `superseded`。**不新增 `unverified` / `implemented` 一类值**——理由：「已决但未落地」是**进度**不是**决策成立性**，硬塞进 status 正是 ADR 0012 那类亏的形状（字段名对、值也对，机器只校存在性给绿灯）。进度由 ADR 正文的 §实施进度 / §后续项 承载。

⚠️ **Q2-c（状态字段值域是否本地扩写）仍未被裁**。本票按上述**最小口径**执行，不替 Q2-c 决策；若将来 Q2-c 扩写值域，7 份重填成本 ≈ 7 行。

### 契约（frontmatter 形态）

```yaml
---
type: decision # 派生自目录（Decisions 21 一），手写但恒为 decision
date: 2026-09-11 # 派生自 git（该文件首次提交日），实施时用 git log 取，不猜
status: accepted # 声明，四值之一
evidence:
  - kind: commit # {commit | file | exec-log | external}
    ref: 3b62dbe
  - kind: file
    ref: scripts/handoff-gen.mjs
---
```

- **机器只校存在性**（Decisions 11）：不改语义、不判断真伪
- `evidence` **不得为空数组**（Decisions 20 配套：`evidence` 空 ⇒ 跳过不入索引）
- `date` 取值口径：该 ADR 文件的**首次 git 提交日**（`git log --diff-filter=A --format=%ad --date=short -- <path>`），不是本次编辑日

### 验收（逐条可执行）

| #   | 验收项     | 判据                                                                                                  |
| --- | ---------- | ----------------------------------------------------------------------------------------------------- |
| E1  | 覆盖度     | 7 份目标文件**逐个**有 frontmatter 且四字段齐（脚本化断言，非目测）                                   |
| E2  | ref 可校   | 全部 `kind: commit` 的 ref 过 `git cat-file -e <sha>^{commit}`；全部 `kind: file` 的 ref 路径存在     |
| E3  | 正文零改动 | `git diff` 中每个目标文件的**新增行全部落在文件头部 frontmatter 块内**；正文无任何增删改              |
| E4  | 越界零改动 | `git diff --name-only` 仅含 7 个目标 ADR；0001–0006 与其余文件零改动                                  |
| E5  | date 口径  | 每份 `date` 与 `git log --diff-filter=A --date=short` 的输出一致（逐份比对）                          |
| E6  | 无自证注水 | 实施说明里逐份列出「evidence 取自正文哪一行/哪一段」——**证据必须能从该 ADR 正文指回**，指不出的不许填 |

**签收判据**：E1–E6 全过 + 实施者自报 Out of Scope 未触碰。

### 决策留痕

- 跳 grilling：范围与断点由 Decisions 22 已裁，本票只落地执行
- Gate B 契约：[边界=7 份白名单 + 正文零改动 / 契约=frontmatter 四字段 + evidence 形态 / 验收=E1–E6]
- 值域临时口径：见上，不替 Q2-c 决策
- 本票过门记录：Gate Report 见 map Decisions 31

---

## 票己 · 索引表 schema（段三主链第一步 · Q6 全落）

**状态**：**已收口**（2026-09-12：交付 `f493979` → 吐槽猫审查 **✅ 零返工**（独立复跑 `chunks.test.ts` **18 passed**、C8 期望表抽查回对票面、`chunks_fts` 建表与 `memories_fts` 逐字节对齐）→ **PR #51** carrier = merge commit `8efab3d` 并入 `dev`；店长实查。**勿再派活**）
**收口留痕**：本次审查曝出 **6 条下游契约地雷**（G1–G5 / X1）**已就地补进票庚·票辛票面**，并回改 map 两处勘误——见 **map Decisions 36**。⚠️ 本票只交付**读侧** repository；**写侧（FTS 行 / 向量行 / 三表孤儿删）全归票庚**。
**承**：map Decisions 34 四–八（X1–X5 全裁）/ Decisions 17（**chunk 身份键 = 路径 + 小节锚 + 内容哈希**，**明确「不必带片序号」**）/ Decisions 4（状态过滤硬约束）/ Decisions 24（status 管到节）
**动机**：段三主链（schema → 扫描器 → 接线）的底座。**扫描器写、接线读，两侧都以本票列名为准** ⇒ 必须先行，否则下游两边各自发明列名。

### 目标（可证伪）

`initDb()` 后 `chunks` / `chunk_vectors` / `chunks_fts` 三表存在且列与本节契约**逐字一致**；同一片重复写两次表内仍 1 行（幂等 upsert）；检索查询体不返回 `superseded`/`deprecated` 行。**存在任一契约列缺失、或唯一索引未生效（重复写产生两行）、或老库重跑 `initDb()` 报错 ⇒ 本票失败。**

### 落点

```
packages/server/src/db/index.ts                 （additive 迁移段，照既有 CREATE TABLE IF NOT EXISTS 幂等范式）
packages/server/src/db/repository/chunks.ts     + chunks.test.ts（同目录同名前缀）
```

### 契约（钉死，下游只许引用不许改名）

**`chunks` 列清单 —— 一次到位（X2）**

| 列                                                                                                   | 类型                       | 说明                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                                                                                                 | INTEGER PK AUTOINCREMENT   | 内部行号（**不进身份键**）                                                                    |
| `doc_path`                                                                                           | TEXT NOT NULL              | 仓库相对路径，正斜杠                                                                          |
| `section_anchor`                                                                                     | TEXT NOT NULL              | 节锚（= 票丙 `Segment.sectionAnchor`；无标题节为 `''`）                                       |
| `content_hash`                                                                                       | TEXT NOT NULL              | 该片正交内容指纹（`body` 的 sha256 hex）                                                      |
| `origin_id`                                                                                          | TEXT NOT NULL              | 扫描时该 MD 的 **git blob SHA**（`git hash-object <path>`）                                   |
| `type` / `status` / `date` / `evidence` / `supersedes` / `superseded_by` / `valid_from` / `valid_to` | TEXT                       | 元数据；`status` **节级**（Decisions 24）；`evidence` = **JSON 数组文本**（X2-a：不建关联表） |
| `part_index` / `part_total`                                                                          | INTEGER NOT NULL           | 片序号（**是列、不进唯一键**——Decisions 17 明裁「不必带片序号」）                             |
| `hard_cut`                                                                                           | INTEGER NOT NULL DEFAULT 0 | 该片由 L3-f 字符硬切产生                                                                      |
| `body`                                                                                               | TEXT NOT NULL              | 片正文（不含面包屑）                                                                          |
| `breadcrumb`                                                                                         | TEXT NOT NULL              | `相对路径 > H1 > H2 > H3`                                                                     |

- **唯一键（X2）**：`UNIQUE(doc_path, section_anchor, content_hash)`。
  - **⚠️ 已知边界（写进票面以免实施者自行发明）**：同节内若出现**两片 `body` 完全相同**，唯一键相撞 ⇒ 幂等合一（**丢一片序号**）。**取舍 = 严格照 Decisions 17**（带片序号会让「节内插入一段」把后续碎片身份全变）；且合一是**确定性**的 ⇒ 「重扫 N 次结果不变」不变式仍成立。**判据**：不合一（新增行）⇒ 违约；合一但重扫行数不稳定 ⇒ 违约。
  - upsert 语义 = `ON CONFLICT DO UPDATE`（重扫更新元数据列 + `part_index`/`part_total`/`hard_cut`）。
- **索引**：`idx_chunks_status`（供查询体过滤面）、`idx_chunks_origin`（供增量比对按 `origin_id` 查）。
- **`text` 不单独存**（可重算 = `breadcrumb` + 话题锚 + `body`）——**建了就是违约**（X2）。
- **表内禁止任何扫描时间戳 / 运行态字段**（X3 新钉）：不得有 `scanned_at` / `updated_at` / `created_at` / `last_seen` 类列。**存了则「删表 → 重扫 → 逐行等价」必破**（唯一例外 = `date`，它是 **MD 里的历史事实**、由票戊冻结，不是扫描时刻）。

**`chunk_vectors`**：sqlite-vec `vec0`，`embedding float[512]`，以 `chunk_id`（= `chunks.id`）关联。**照 `db/index.ts` 既有 `chunks` 侧 vec0 建表范式**。
⚠️ **勘误（2026-09-12 审查 OQ-0）**：本行原写「（与 `memories_vec` 同形）」——**`memories_vec` 在本仓不存在**（实测 `grep` 零命中；向量是 `memories.embedding BLOB`）。该空引用已删（票己实现选了「vec0 / `float[512]`」那半句显式契约，正确）。**下游警号**：向量通道走 vec0 `MATCH`，**不是** BLOB 扫表——见票辛 ⑦ X1。

**`chunks_fts`**：FTS5，索引 `body` + `breadcrumb`。**照 `db/index.ts:425` 既有 `memories_fts` 范式**（含 external-content 与否、tokenizer 选择——**实施前先读那 20 行，逐项对齐，不另发明**）。

**查询体过滤面（X4，硬约束）**：`chunks.ts` 导出的**所有**检索函数必带

```sql
WHERE status IS NULL OR status NOT IN ('superseded','deprecated')
```

- **`status IS NULL` 放行**（裁定）：`status` 是**可选声明**字段，排除集合是**显式失效标记**；NULL = 未声明状态，不是「已失效」。**排除集合取两者**（`superseded` + `deprecated`）——`deprecated` 语义 = 已退役，被检索到就是 Decisions 4 点名的劣化。
- **判据**：任一导出检索函数缺该 WHERE ⇒ 违约（**测试直接断源码**，见 C5）。

### 边界

**In Scope**：三表建表（additive 迁移）/ `chunks.ts` repository（upsert + 按 `origin_id` 查 + 按 `status` 过滤的检索入口）/ 单元测试
**Out of Scope（钉死）**

- **不写扫描器**（票庚）；**不改 `memories` 表结构、不 drop 它**（票壬清数据 / 票辛 drop 表）
- **不接线检索**（票辛）——本票只提供 repository，**不改 `memory/index.ts` 与 `reply.ts`**
- **不建 `chunks_fts` 的同步触发器逻辑**（写入侧同步归票庚/票辛；本票只建表）
- **不删 `memories` 存量**（票壬）

### 验收（逐条可执行）

| #   | 验收项                        | 判据                                                                                                                                                                                                            |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 三表建齐                      | `PRAGMA table_info(chunks)` 的列名集合 **=== 契约清单**（脚本断言，非目测）；`chunk_vectors`/`chunks_fts` 存在                                                                                                  |
| C2  | 唯一索引生效                  | 同一 `(doc_path, section_anchor, content_hash)` upsert 两次 ⇒ `COUNT(*)` = 1；改 `content_hash` 再 upsert ⇒ 2 行                                                                                                |
| C3  | 老库幂等                      | 对**已有库**（含 `memories` 等旧表）重跑 `initDb()` 零报错、零副作用（旧表行数不变）                                                                                                                            |
| C4  | 无时间戳列                    | `PRAGMA table_info(chunks)` 列名**不含** `*_at` / `*_time` / `*_ts` / `scanned*` / `last_seen`（脚本断言）                                                                                                      |
| C5  | 过滤面覆盖全部入口            | 对 `chunks.ts` **每个导出检索函数**做源码断言：函数体内含 `NOT IN ('superseded','deprecated')`；**运行时**断言：写 1 条 `superseded` + 1 条 `deprecated` + 1 条 `status IS NULL` + 1 条 `active` ⇒ 只返回后两条 |
| C6  | 无 `text` 列                  | `chunks` 列名不含 `text`（脚本断言）——可重算字段不落表                                                                                                                                                          |
| C7  | 测试环境                      | 用 `:memory:`（`setDb()`/`resetDb()` 钩子）+ `MEMORY_ENABLED=false`（承 AGENTS.md 铁律）                                                                                                                        |
| C8  | （Gate C 反例补）列定义完整性 | `PRAGMA table_info(chunks)` 的 **type / notnull / dflt_value** 与契约表**逐列相等**——C1 只断列名，会被「列在但类型/约束松」绕过                                                                                 |

**签收判据**：C1–C7 全过 + 实施者自报 Out of Scope 未触碰（**尤其：`memory/index.ts` / `reply.ts` 零 diff**）。

### 决策留痕

- 跳 grilling：范围由 Decisions 34 四–八 已裁，本票只落地
- Gate B 契约：[边界 = 三表 + repository / 契约 = 列清单 + 唯一键 + 过滤面 / 验收 = C1–C7]
- 本票过门记录：Gate Report 见 map Decisions 35（与本批同过）

---

## 票庚 · 扫描器（段三 · Q5 全落 + S4 孤儿物理删）

**状态**：**已收口**（2026-09-12：交付 `4d3e5a4` → 吐槽猫审查 **✅ 零返工**（G1–G5 逐条核算 / 三条反例实跑为红：G1→S11 · G3→S12 · mtime→S4 / `memory/index.ts`·`reply.ts` 零 diff）→ **PR #53** carrier = merge commit **`bf11cbd`** 并入 `dev`；店长实查。参见 **map Decisions 39**。**勿再派活**）｜原记录「本轮派 ds猫」
**承**：map Decisions 34 一–三（S1/S2/S3）/ S4（**用户裁「物理删」**）/ Decisions 20/22（fail-closed 准入）/ Decisions 17（身份键）/ 票丙 `segmentDocument` / 票丁 sidecar
**动机**：把白名单里的结晶 MD 变成 `chunks` 行。**它是唯一「读 MD 写索引」的入口**（Decisions 6：索引侧无独立写口）。

### 目标（可证伪）

给定仓库工作区，`pnpm flywheel:scan` 后：白名单内、frontmatter 合格、`evidence` 非空的件**全部**在 `chunks` 表内且 ≥1 行；**任一不合格件被静默丢弃（既不入库又不出现在跳过报告里）** ⇒ 本票失败。源文件被删后重扫，其 `chunks` 行**物理消失**（不是标记）。

### 落点

```
scripts/flywheel/scan.mjs        + scan.test.js（scripts 用 **/*.test.js——承 Conventions）
package.json                     （flywheel:scan / flywheel:reindex 两条 script）
packages/server/src/index.ts     （启动时 spawn 一次，fire-and-forget）
```

### 契约（钉死）

**① 白名单（S1）——写死为导出常量，测试直接断言**

```js
export const SCAN_PREFIXES = ['docs/adr/', 'docs/lessons/', 'docs/plans/']
```

- `docs/plans/**` **仅**收 `status ∈ {已定稿, 已收口}`（`进行中` 不扫）。
- **不扫**：`docs/run/**`（在飞、收口即清）、`docs/research/**`（未结晶）、`docs/sessions/**`（**一期不扫**，列二期候选）、`AGENTS.md`/`CONTEXT.md`（Decisions 1 明否）。
- 扩展名白名单：`.md`。

**② 触发点（S2）**

- 手动：`pnpm flywheel:scan`（= 显式通道落点）；全量：`pnpm flywheel:reindex`（drop → create → scan → embed）。
- 自动：**server 启动时 spawn 一次**（fire-and-forget，失败不阻塞启动、不 fail 启动）。
- **不做定时任务**（Out of scope 已否 clowder 全自动管线）。

**③ 增量判据（S2）**

- `origin_id` = `git hash-object <path>`（**blob SHA**）。与库内该 `doc_path` 的 `origin_id` 相同 ⇒ 跳过（报告 `skipped: unchanged`）。
- **绝不用 mtime**（LlamaIndex issue #21461 反例；本仓 checkout / 切分支会污染 mtime）。**判据：`touch` 改 mtime 不改内容 ⇒ 必须仍 skip**（见 S4）。

**④ fail-closed 跳件（S3，Decisions 20）**

- 缺 frontmatter / `type` 缺 / `evidence` 空数组 ⇒ **跳过**（不入库）+ 进**跳过报告**。
- 报告形态：stdout 结构化 JSON（`{scanned, inserted, updated, skipped:[{path, reason}], orphansDeleted, errors}`）+ `log.info` 一行汇总。**「跳过」永不是静默的**（承票丁「失败不静默」同形）。
- 脏件自动挡住：`research-*.md` / `.e2e.mjs` 无 frontmatter ⇒ 命中本规则（**不需要枚举黑名单**）。

**⑤ 切片与嵌入**

- 切片 = 调票丙 `segmentDocument({path, content})`（**不重新实现**）。
- 嵌入 = 调票丁 `EmbeddingClient`（**不内联 `pipeline()`**）。**sidecar 不可用时：该件不写任何行**，记 `errors` + summary（**禁止写半截**）。
- `content_hash` = `body` 的 sha256 hex（**与票己同算法**——须一致，否则唯一键失效）。

**⑥ 孤儿清理（S4，用户裁「物理删」）**

- 重扫后，库内 `doc_path ∈ 白名单` 且**不属本次扫描产出集合**的行**三表齐删**：`chunks` + `chunk_vectors`（按 `chunk_id`）+ **`chunks_fts`（按 `rowid`）**。
- **用户裁决原文「1 物理删」**；与 Decisions 4 的关系见 map Decisions 34 一（索引行是派生投影，不是知识条目）。
- **判据**：删源文件 → 重扫 ⇒ 该 `doc_path` 在**三张表**行数均 = 0。

**⑦ 只读 MD**：扫描器**不写任何 MD**（X2-b：节级 status 不回写）。**判据**：跑完 `git status --porcelain` 中 MD 零改动。

**⑧ 契约补遗（G1–G5）——票己审查后店长补钉（承 map Decisions 36 二）**

> **背景**：票己 只交付了 `chunks.ts` 的**读侧**入口；**写侧（FTS 行 / 向量行 / 三表孤儿删）全是本票的面**，而本票原票面**一字未提**。以下五条为**派单前就地补钉**，不是实施期追认。

- **G1 · `chunks_fts.content` 存 bigram 预分词串，不是原文**：必须 `bigramTokenize(body + ' ' + breadcrumb).join(' ')` 后写入。**`bigramTokenize` 直接复用 `db/repository/memories.ts:29`**（`memories.ts:108` 的 `ftsContent` 是同一形态）——**实现前先读那条写侧范式，逐项对齐，不另发明**。**判据**：写入侧照原文写 ⇒ 关键词通道 `MATCH` **永远零命中且不报错**（静默失败，S2 抓不到）⇒ 必须有「写入后按关键词能命中」的用例。
- **G2 · FTS 行 `rowid` 必须 = `chunks.rowid`**：读侧 `chunks.ts:196` 写死 `JOIN chunks c ON c.rowid = f.rowid`（`chunks.id` 是 `INTEGER PRIMARY KEY` ⇒ 与 rowid 同值）。写入照 `memories.ts:169-174` 形态：先 `DELETE FROM chunks_fts WHERE rowid = ?` 再 `INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)`。
- **G3 · vec0 主键必须传 `BigInt`**：写 `chunk_vectors` 时 `BigInt(chunkId)`——sqlite-vec **拒非整数 PK**（建表注释见 `db/index.ts:543-550`）。**判据**：不传 BigInt ⇒ 向量行写不进（报错或静默）⇒ 向量通道零召回。
- **G4 · `evidence` 入参形态 = `{kind, ref}` 对象数组**：真实 frontmatter（票戊已落 7 份）形态为 `evidence: [{kind: commit, ref: d555732}, …]`；map Decisions 20 定「每条 `{kind, ref}`，`kind ∈ {commit, file, exec-log, external}`」。票己 的 `ChunkUpsertInput.evidence?: string[]` **太窄** ⇒ **授权最小放宽**（改为可承载该对象数组的类型），**但 SQL/存储语义不变**（仍 `JSON.stringify` 落 JSON 文本）。**判据**：拿 `docs/adr/0007-*.md` 真实 frontmatter 走一遍 `upsertChunk` ⇒ `evidence` 列是对象数组的 JSON，读回可解析出 `kind`/`ref`。
- **G5 · 孤儿删三表齐删**（已并入上方 ⑥ / S5）。

**⑨ 搭车项（店长拍的搭车，非本票原生范围）**：`scripts/probes/dsh-acp-probe.e2e.mjs` 头注释仍指旧路径（票癸保留 R100 是有意取舍）⇒ **顺手修一行注释**指新落点。**判据**：注释路径存在。

### 边界

**In Scope**：scan.mjs（白名单 / 增量 / fail-closed / 孤儿删 / 报告）/ 两条 npm script / 启动 spawn / 单测 / **`chunks.ts` 写侧同步（FTS + 向量 + 三表孤儿删，见 ⑧）** / **G4 的 `evidence` 入参类型最小放宽** / 搭车项 ⑨
**Out of Scope**：**不改检索链**（票辛）/ **不改 `memories`**（票壬/辛）/ **不做定时任务** / **不建索引埋点**（X5 落 log 归票辛）/ 不实现切片与嵌入（票丙/丁 已交付）

### 验收（逐条可执行）

| #   | 验收项                        | 判据                                                                                                                                                      |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 白名单                        | 4 类目录各放一件合格样本：仅三前缀内且 `status` 合格者入库；`docs/run/**`、`docs/research/**`、`docs/sessions/**` 零行                                    |
| S2  | fail-closed 不静默            | 放一件无 frontmatter ⇒ 零行**且**出现在 `skipped[]`（含 reason）；`evidence: []` 同样                                                                     |
| S3  | 幂等                          | 连扫两次：第二次 `inserted=0, updated=0`，行数不变                                                                                                        |
| S4  | 增量是 SHA 不是 mtime         | `touch`（或 checkout 切分支）后重扫 ⇒ 仍 `skipped: unchanged`                                                                                             |
| S5  | 孤儿物理删（三表）            | 删源文件重扫 ⇒ 该 `doc_path` 在 `chunks` **与** `chunk_vectors` **与** `chunks_fts` **三表**均 0 行（原只写前两表 ⇒ FTS 僵尸行累积；承 ⑥/G5）             |
| S6  | 嵌入失败不写脏行              | mock sidecar 失败 ⇒ 该件零行 + `errors[]` 含 reason（**无半截行**）                                                                                       |
| S7  | 不写 MD                       | 跑完 `git status --porcelain -- '*.md'` 输出为空                                                                                                          |
| S8  | reindex 可重建                | 同输入连续两次 `reindex` ⇒ `chunks` 按身份键排序后**逐列相等**（X3 不变式）                                                                               |
| S9  | 启动不阻塞                    | sidecar / git 不可用时 server 正常启动（spawn 失败只记 log）                                                                                              |
| S10 | （Gate C 反例补）真实仓库全量 | 对**真实工作区**跑一次全量 `scan`：`scanned` 数 == 白名单内合格文件数，且 `skipped[]` **逐个列名**——S1 只验「4 类各一件」，**小样本全绿不能反证真实仓库** |

| S11 | （补钉 G1/G2）关键词通道真能命中 | 写入后按 `body` 里的词调 `searchChunksByKeyword` ⇒ **命中且非空**；并断言 `chunks_fts.content` 已是 bigram 串（≠ 原文）——**G1 是静默失败型地雷，S2/S3 抓不到** |
| S12 | （补钉 G3）向量行真写进去了 | 写 `chunk_vectors` 后 `searchChunksByVector` 能召回该片；且写入用 `BigInt(chunkId)`——**不传 BigInt 的写法必须有一条反例用例** |
| S13 | （补钉 G4）evidence 往返 | 用 `docs/adr/0007-*.md` 的**真实 frontmatter** 走一遍 ⇒ `evidence` 列为对象数组 JSON，读回能解出 `kind`/`ref` |

**签收判据**：S1–S13 全过 + `memory/index.ts` / `reply.ts` 零 diff。

### 决策留痕

- Gate B 契约：[边界 = 扫描器单点 / 契约 = 白名单 + 增量 + fail-closed + 物理删 / 验收 = S1–S9]
- ⚠️ **收口时判重启**：本票 spawn 接线进 `packages/server/src/index.ts` ⇒ **改 server 代码，收口需用户重启审批**（`request_user_action`）

---

## 票壬 · 旧写口退役（段三 · S5，**用户裁「退 + 删」**）

**状态**：**已收口**（2026-09-12：交付 `d0e3fac` → 吐槽猫审查 **✅ 零返工**（`git grep saveMessageMemory` 零命中 / 独立开库核实 主库 `0/0` + 快照 `198/110` / 独立复跑 9+23+212 passed）→ **PR #52** carrier = merge commit **`854f766`** 并入 `dev`；店长实查。四条 OQ 分流见 **map Decisions 37**。**勿再派活**）｜原记录「本轮派 flash猫」
**承**：map Decisions 34 零（**用户原话「2 退 + 删」**）/ Decisions 5（只索引结晶 MD、不索引对话原话）/ Decisions 6（索引侧永远无独立写口）/ Decisions 17（DEDUP 作废、改身份键幂等）
**动机**：`saveMessageMemory` 是**第二个写口**，与「索引侧无写口」正面冲突；其 `0.20 ≤ d < 0.35` 分支还会**覆写旧记忆正文**（演化原则 #4）。留着它，段三的新链路就永远有一条旁路在写旧表。

### 目标（可证伪）

`saveMessageMemory` 全仓**零引用**（含测试与 mock）；`memories` 表存量 **0 行**；对话消息入库流程行为不变。**存在任一残留引用、或 `SELECT COUNT(*) FROM memories` > 0、或 `ingest` 其它行为回归 ⇒ 本票失败。**

### 落点

```
packages/server/src/connectors/ingest.ts        （:26 import、:370 调用 —— ⚠️ 行号须 grep 复核后再改）
packages/server/src/memory/index.ts             （saveMessageMemory 函数 + 其私有分支）
packages/server/src/memory/index.test.ts        （:93 起的 describe 块）
packages/server/src/connectors/socketio.test.ts （:72 的 mock）
scripts/flywheel/retire-message-memory.mjs      （一次性、幂等 DELETE）
```

### 契约（钉死）

**① 三步（顺序固定）**

1. **摘调用**：`ingest.ts` 移除 `saveMessageMemory` 的 import 与调用点。**该调用点周围的行为不得改变**（消息落库 / 广播 / 后续处理全部原样）。
2. **删函数**：`memory/index.ts` 删 `saveMessageMemory` 及其**仅供它使用**的私有分支（含 `0.20 ≤ d < 0.35` 覆写分支 `memory/index.ts:115-125` 附近——**行号 grep 复核**）。**公共检索函数一律不动**（那是票辛的面）。
3. **清存量**：`DELETE FROM memories` + `DELETE FROM memories_fts`。**⚠️ 只清数据、不 DROP 表**。
   - ⚠️ **勘误（2026-09-12 店长实测）**：`memories_vec` **在本仓不存在**——`grep -rn 'memories_vec' packages/ scripts/ docs/adr/` **零命中**；向量是 `memories.embedding BLOB`（`db/index.ts:131`），**没有对应的 vec0 表**。原括号「`memories_vec` 若存在」是**空引用**，已删；**不得**把它写成硬编码目标表（写了 ⇒ 脚本当场 `no such table`）。

**② 为什么「不 drop 表」（诚实标注，防下游误读）**

- 读侧 `searchMemoriesHybridPath`（`memory/index.ts:212` → `db/repository/memories.ts:280`）**仍在调用**；此刻 drop 表 ⇒ 读侧抛「no such table」。
- ⇒ 本票交付后是一个**显式临时态**：**空表 + 零写口**，读侧返回零命中。**旧表结构的 DROP 归票辛**（接线时旧链整体下线）。
- **风险可接受**：`MEMORY_ENABLED=false` 已 2.5 周且零退化 ⇒ 读侧本就不活跃。

**③ 清理脚本**：`scripts/flywheel/retire-message-memory.mjs`，**幂等**（再跑无行可删、零报错），对 dev 库与主库分别执行并各自留执行记录（行数前后）。

### 边界

**In Scope**：三步 + 清理脚本 + 相应测试删除/改写
**Out of Scope**：**不 drop 旧表**（票辛）/ **不建新表**（票己）/ **不改检索链**（票辛）/ 不碰 `query-rewrite.ts`（那是另一条对话记忆链，本票不涉）

### 验收（逐条可执行）

| #   | 验收项                      | 判据                                                                                                                                                                                                    |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 零引用                      | `grep -rn "saveMessageMemory" packages/ scripts/` ⇒ **零命中**（含 `.test.ts` 与 mock）                                                                                                                 |
| V2  | ingest 不回归               | `connectors/socketio.test.ts` 全绿；消息落库 / 广播断言不变                                                                                                                                             |
| V3  | 存量清零                    | 对目标库执行后 `SELECT COUNT(*) FROM memories` = 0 且 `memories_fts` 同（**执行记录附前后行数**）                                                                                                       |
| V4  | 幂等                        | 清理脚本连跑两次：第二次零报错、零变更                                                                                                                                                                  |
| V5  | 无 skip 残留                | 删除的测试不留 `.skip` / 注释掉的死代码                                                                                                                                                                 |
| V6  | 表结构还在                  | `PRAGMA table_info(memories)` 仍有列（**未 drop**——防实施者「顺手」drop）                                                                                                                               |
| V7  | （Gate C 反例补）删除面收敛 | 清理脚本**硬编码两张真实存在的目标表**（`memories` / `memories_fts`——`memories_vec` 本仓不存在，见 ③ 勘误），**不接受参数化表名**；执行记录列出**各表前后行数**（防「误删其它表」在单条汇总数里不可见） |
| V8  | 无空引用报错                | 脚本对目标库执行**零 `no such table`**（任何人照 map 或旧票面补一句 `memories_vec` 就会当场炸——这是本票唯一「照文档抄就翻车」的点）                                                                     |

**签收判据**：V1–V6 全过 + `memory/index.ts` 中**公共检索函数零 diff**。

### 决策留痕

- **用户裁决原文「2 退 + 删」**（含删数据动作已明确点头，此前票面明标「不是默认项」）
- Gate B 契约：[边界 = 写口三步 / 契约 = 零引用 + 零行 + 不 drop / 验收 = V1–V6]

---

## 票辛 · 检索接线（段三收口 · W 组 + Q7 全落）

**状态**：**已收口**（2026-09-12：交付 `a0624c6` + 返工 `14e1706` → 吐槽猫**首轮两条必修** → 返工后**复查 ✅ 零返工** → **PR #54** carrier = merge commit **`db2216e`** 并入 `dev`（`dev` = `origin/dev` = `.push-gate` 三方对齐，店长实测）；店长独立复跑 `chunks.test.ts` **35 passed** / `mcp-server.test.js` **67 passed**。参见 **map Decisions 40**）
**✅ 唯一未完成项 W7 真机三验已于 2026-09-12 15:30 窗口完成**（`MEMORY_ENABLED=true`；sidecar 自起 `dim:512` / 真文本 `HTTP 200 dim=512` L2 归一 / 停 sidecar 降级 `request-timeout` fail-open / 冷却后自愈重 spawn）——四条实测原文见 **map Decisions 47 一/二**。**W9 亦同窗口补测**（真实全量 128 chunks；截断 0 节、未触上限；**边界如实标注见 Decisions 47 四**）。**勿再派活。**
**派活留痕**：曾派 ds猫（依赖**已全满足**——票己 ✅ `8efab3d` / 票庚 ✅ **`bf11cbd`**（PR #53）/ 票壬 ✅ `854f766`，三票均已并入 `dev`；票面已按票己审查补钉 **X1–X3**，见下 §契约补遗）
**派活留痕**：派 ds猫 的理由 = `chunks` schema 的**读侧（票己）与写侧（票庚）均为其交付**，接线面最熟
**承**：map Decisions 34 九–十三（W1–W5）/ Decisions 32（埋点契约 = **阈值前 top-N 切片身份 + 距离**）/ Decisions 14（450 上限 + 小块检索整节返回）/ Decisions 28/30（两条条件触发的信号源）
**动机**：把 `chunks` 接进 `reply` 的上下文注入，让记忆飞轮真正闭环——**这也是 B8「启用」分支的天然真机窗口**（票丁收口留账：`MEMORY_ENABLED=true` 的真机验证刻意留给本票）。

### 目标（可证伪）

`MEMORY_ENABLED=true` 时，回复上下文注入的条目**只能来自 `chunks`**（`memories` 路径彻底消失）；超预算时**按节截断**；「未启用 / 无命中 / 嵌入失败」三态在结果与日志上**可区分**；日志能答出「阈值前 top-N 有哪些、距离各多少」。**存在任一路径静默返回空且无痕、或仍从 `memories` 读、或超预算按块截断 ⇒ 本票失败。**

### 落点

```
packages/server/src/memory/index.ts             （检索改走 chunks；旧链下线）
packages/server/src/db/repository/chunks.ts     （hybrid 检索：向量 + chunks_fts + RRF）
packages/server/src/db/index.ts                 （DROP 旧 memories 链路表 + chunks_fts 同步逻辑）
packages/server/src/execution/reply.ts          （注入配额：预算 / 顺序 / 三态日志）
packages/server/src/index.ts                    （MEMORY_ENABLED 分支：启动 sidecar 探活）
```

### 契约（钉死）

**① W1 复用现有 RRF 形态**：`chunks_fts`（FTS5，票己已建）+ 同一 `RRF_K = 60` 融合；**实现前先读 `db/repository/memories.ts:247-300`，逐项对齐**（向量通道取 topK / 关键词通道取 topN / 融合打分公式）。⚠️ **中文 BM25 权重问题本仓未实测** ⇒ **不预设调整、不转述 clouder 结论**；跑真实语料后若有问题**另立票**。

**② W2 注入与配额**

- **W2-a 预算**：硬上限 **8k token 起**（实施时按实测调，**调整须在实施说明里给出依据**）；超限 **按节截断**（同一 `(doc_path, section_anchor)` 的片整体进退）。**按块截断 = 违约**（破坏 Decisions 14 安全网）。
- **W2-b 顺序**：最相关的条目**首尾各半**（Lost in the Middle, arXiv:2307.03172）。
- **W2-c**：`MEMORY_TOP_K` 沿用现值；**退休机制先不做**（语料量级未知，防防御性建设）。

**③ W3 降级三态可区分**：`MEMORY_ENABLED=false` / 无命中 / 嵌入失败 —— 三态在**结果**与**日志**上必须可区分（票丁已给 `reason`；本票把它接到检索结果层）。

**④ X5 埋点（Decisions 32 契约）**：结构化 `log.info`，字段 = **阈值前 top-N 的「切片身份（`doc_path` + `section_anchor`）+ 距离」**，且「空手而归」与「被阈值挡掉」**可区分**。**落 log 不落表**（落表 = 新增 GC/保留期面，且索引可重建、埋点表不可）。

**⑤ W4 冲突修正闭环 = 不建新机制**：**不实现任何新的审核面 / UI / 批量通道**；撞「与现实矛盾」走既有审查链（提审查 → 改 MD → 重扫）。**本项在票面上是「不做」**——实施者若建了机制即违约。

**⑥ 旧链下线**：`memories` / `memories_fts` **DROP**（⚠️ **`memories_vec` 本仓不存在**——实测零命中，向量是 `memories.embedding BLOB`，见 ⑧ X1）；`searchMemoriesHybrid` 及其调用链删除（`db/repository/memories.ts` 相应函数、`query-rewrite.ts` 若仅供旧链则一并退役——**须先 grep 调用面**）。

**⑦ 契约补遗（X1–X3）——票己审查后店长补钉（承 map Decisions 36 二）**

> **背景**：以下三条都是**「照某个文档抄就翻车」**型地雷，票己审查逐条取证后交给本票。补钉在**派单前**，不是实施期追认。

- **X1 · `memories_vec` 是空引用（OQ-0）**：票己票面写的「与 `memories_vec` 同形」在**本仓根本不存在该对象**（`grep` 零命中）。票己实现选了票面**显式契约**那半句（vec0 / `float[512]`）——**正确**。对本票的含义：**向量通道一律走 vec0 `MATCH`**（票己 `searchChunksByVector` 已交付，直接调），**不要照 `searchMemoriesByVector` 的 BLOB 扫表写法抄**——那是 `memories.embedding BLOB` 的旧形态，两者**不是同一种检索**。
- **X2 · 降级三态的「召回空」≠「嵌入失败」（OQ-4）**：票己 `searchChunksByVector` 是**先 KNN 截断、后 `status` 过滤**（`LIMIT topK` 在**内层**）⇒ 最近的 topK 片若全被标失效，返回**空**但**嵌入是好的**。W3 三态必须把这种空与「嵌入失败」「`MEMORY_ENABLED=false`」**分开报**，否则把全失效候选池误判成嵌入坏、修错地方。
- **X3 · 过滤面以票面为准，不是 map（OQ-1）**：权威原文 = **票己票面 · 契约 §查询体过滤面**：`WHERE (status IS NULL OR status NOT IN ('superseded','deprecated'))`——**`status IS NULL` 放行**（NULL = 未声明状态，不是已失效）。map 那句原缺 `status IS NULL` 分支，**已回改**（Decisions 34 七勘误行），但**判据仍取票面**。**照 map 旧句抄 = 实现出相反语义**（NULL 行被静默滤掉）。

### 边界

**In Scope**：检索改走 chunks / RRF 复用 / 注入配额 / 三态 / 埋点 / 旧链表 DROP
**Out of Scope**：**不建摘要或情境化改写层**（Decisions 30 五：不立项）/ **不做 UI 面板**（X5）/ **不做定时任务** / **不改切片器与嵌入层**（票丙/丁 已收口）

### 验收（逐条可执行）

| #   | 验收项                        | 判据                                                                                                                                  |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | 注入只来自 chunks             | 注入条目的 `doc_path` 全在白名单前缀内；`memories` 表已不存在                                                                         |
| W2  | 按节截断                      | 构造超预算语料 ⇒ 截断边界落在**节边界**（同节片不拆开），token 总数 ≤ 上限                                                            |
| W3  | 首尾各半                      | 最相关条目出现在注入串的**首部或尾部**，不落正中段                                                                                    |
| W4  | 三态可区分                    | 三种情形各跑一次：日志与结果**互不相同**（断言三者 `reason` 字段相异）                                                                |
| W5  | 埋点可答问                    | 构造「差一点被阈值挡掉」的条目 ⇒ 日志含其 `doc_path` + `section_anchor` + 距离；「无命中」与「被挡掉」两条日志可区分                  |
| W6  | 无新机制                      | `git diff` 中**不存在**新的审核/UI/批量修正入口（W4 是「不做」）                                                                      |
| W7  | 真机                          | `MEMORY_ENABLED=true` 起 server：**B8「启用」分支**（sidecar 自起 + 真文本 512 维 + 停 sidecar 走降级）**逐条补齐**并附实测输出       |
| W8  | 旧链零残留                    | `grep -rn "searchMemoriesHybrid\|memories_fts" packages/server/src` 零命中（DROP 后无悬挂调用）                                       |
| W9  | （Gate C 反例补）真实语料注入 | 对**真实全量 `chunks`** 跑一次注入：记录注入 token 数 / 截断节数 / 是否触上限——**构造语料全绿不能反证**（真实语料可能单节即接近上限） |

| W10 | （补钉 X1）向量通道形态 | 向量召回走 `chunk_vectors` 的 vec0 `MATCH`（调票己 `searchChunksByVector`）——**全仓 grep 不得出现 `memories_vec` 引用**；不得引入 BLOB 扫表式向量检索 |
| W11 | （补钉 X2）召回空 ≠ 嵌入失败 | 构造「最近 topK 全被 `status` 挡掉」的库 ⇒ 结果与日志必须报**「召回空（被状态过滤）」**，**不是**嵌入失败；三态断言各自 `reason` 相异（W4 加此第四态） |
| W12 | （补钉 X3）NULL 行真被放行 | 库内放一条 `status IS NULL` 的片 ⇒ **必须被召回**（运行时断言，非只断源码）——照 map 旧句抄会让它静默消失 |

**签收判据**：W1–W12 全过 + **用户重启审批已批**（本票改 server 运行时 ⇒ 收口必走 `request_user_action`）。

### 决策留痕

- **本票 = 段三收口票**：S/X/W 三组的最后一棒；W4 是显式「不做」，W5 埋点字段由 Decisions 32 钉死
- Gate B 契约：[边界 = 检索链路替换 / 契约 = RRF 复用 + 配额 + 三态 + 埋点 / 验收 = W1–W8]
- ⚠️ **收口需用户重启审批**

---

## 票癸 · 段一归位（段一收口 · 发现②四项 + Q2-c/Q2-d 落地）

**状态**：**已收口**（2026-09-12：交付 `9df86fd` → 吐槽猫审查 **✅ 零返工**（**6×R100** 实测 / `git rev-parse 9df86fd^:tickets.md` == 目标 blob `6ee3ed8…` 根 `tickets.md` **逐字节未动** / E1 十三份 ADR 全合规 / `packages/` 零命中）→ **PR #51** carrier = merge commit `8efab3d` 并入 `dev`；店长实查。**勿再派活**）
**收口留痕**：本票审查曝出两条偏差（**均由实施者自报、非静默**）：① **探针 usage 行破窗**——头注释仍指旧路径，但改它会破 R100 ⇒ 两害相权保留 R100（**店长裁：正确**），修正式注释**搭车到票庚 ⑨**；② **OQ-3 命名冲突**（map Decisions 9 写 `LL-NNN-slug.md` vs 门牌写 `<slug>.md`）⇒ **店长裁：以落地事实 `<slug>.md` 为准**，已回改 map Decisions 9（见 Decisions 36 一）。
**承**：map Decisions 34 零 + 十三 / Decisions 12（删 `docs/requirements/` + 迁 `docs/plans/dev-process-gate-flow.md`）/ Decisions 9（`docs/lessons/` 立格）/ Decisions 13（本票触发条件「待 Q3 裁完」**已满足**——Q3 随票丙收口裁完）
**动机**：段三扫描器按「白名单 + fail-closed」挡得住脏件，但**门牌缺失是段二的基线问题**：文件放错目录 ⇒ 白名单扫不到 ⇒ 沉淀的知识永远进不了索引。**它是段三的下游受益方，不卡段三开工**（S3 已裁解耦）。

### 现状（**实测取证，非转述**——2026-09-12 店长实查）

| #   | 违例                          | 实测                                                                                                                                                          |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docs/adr/` 混居非 ADR        | `dsh-acp-probe.e2e.mjs` + `research-2026-08-17-acp-feasibility.md` + `research-2026-08-17-opencode-32k-avoidance.md` + `research-dsh-prompt-length-bypass.md` |
| 2   | 仓库根 `tickets.md` 仍在      | 根版 **6449 B**（「投递外移」effort 票单）与 `docs/run/hook-fallback-delivery/tickets.md` **15985 B** —— **两份内容不同**（非简单重复）                       |
| 3   | `docs/requirements/` 未删未迁 | `docs/requirements/2026-09-06-dev-process-gate-flow.md` 仍在；`docs/plans/` 无该文件                                                                          |
| 4   | `docs/lessons/` 未建          | 目录不存在（Decisions 9 已立格）                                                                                                                              |

### 目标（可证伪）

`docs/adr/` 下**只有 ADR 文件**；根 `tickets.md` 消失且其活票有明确承接（**逐票比对清单**为证）；`docs/requirements/` 不存在且引用全部改指；`docs/lessons/README.md` 门牌存在。**存在任一文件被删而无承接、或引用悬空（grep 命中已删路径）、或 `git diff` 出现代码改动 ⇒ 本票失败。**

### 落点与动作

1. **ADR 清居**：三份 `research-*.md` → `docs/research/`（`git mv`，文件名不变）。
2. **`.e2e.mjs` 探针归位**：`dsh-acp-probe.e2e.mjs` → **先查它的被测对象**（读文件头注释 + grep 其调用的模块路径）⇒ 搬至**被测模块同目录**（承 Conventions「e2e 跟随被测脚本同目录」）；查无被测对象则落 `scripts/probes/`。**落点理由写进实施说明**。
3. **`docs/requirements/` 处置**：`git mv docs/requirements/2026-09-06-dev-process-gate-flow.md docs/plans/dev-process-gate-flow.md` → 删空目录 → `grep -rn "docs/requirements"` 全仓改指。
4. **`docs/lessons/` 建立**（Q2-c/Q2-d **店长就地拍板**）：`docs/lessons/README.md` 门牌，**对齐 `docs/run/README.md` 范式**，含：① 什么内容进这里（跨活复用的教训，非活内过程）② 卡片命名 `<slug>.md` ③ **状态字段值域**（照 ADR 四值的最小口径，**不替 Q2-c 的值域决策**，标临时口径）④ 卡片落此 ⇒ **自动落必审侧**（不在 Decisions 15 免审白名单）。
5. **根 `tickets.md` 处置（⚠️ 属另一在飞 effort，只搬不改）**：先**逐票号比对**根版 vs `docs/run/hook-fallback-delivery/tickets.md`：
   - 若 run 版是**超集**（根版活票全部在 run 版中）⇒ **删根版**（内容留 git 历史）；
   - 否则 ⇒ **只搬不改**并入 run 版，并在实施说明里列出「根版有而 run 版无」的票号清单；
   - **严禁只删不核**。动它前后各查一次 `git status`。

### 边界

**In Scope**：上述 5 项文件移动 / 删除 / 新增门牌
**Out of Scope**：**不改任何 ADR / plans / 票单正文内容**（只搬位置）/ **不建 lessons 卡片**（只建门牌）/ 不动 `docs/run/memory-flywheel/**`（本 effort 的在飞面）/ 不碰 `docs/sessions/**`

### 验收（逐条可执行）

| #   | 验收项                    | 判据                                                                                                                                   |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | ADR 目录纯净              | `git ls-files docs/adr/` 全部匹配 `^\d{4}-.*\.md$`（脚本断言）                                                                         |
| E2  | requirements 消失         | 目录不存在；`grep -rn "docs/requirements" --include="*.md" .` 零命中（`docs/run/**` 历史记录若命中，逐条列名并说明）                   |
| E3  | lessons 门牌              | `docs/lessons/README.md` 存在且含「内容边界 / 命名 / 状态值域（标临时口径）/ 必审说明」四项                                            |
| E4  | 根 tickets 有承接         | 根 `tickets.md` 不存在；实施说明含**逐票号比对清单**（根版各票在 run 版中的对应状态）                                                  |
| E5  | 零代码改动                | `git diff --stat` 仅含 `R`（重命名）/ `D`（删除）/ 新增 README；**`packages/`、`scripts/` 零改动**                                     |
| E6  | 无悬空引用                | `grep -rn "adr/research-\|adr/dsh-acp-probe"` 零命中（搬后引用已改指）或列出已改指清单                                                 |
| E7  | 内容零改动                | 每个被 `git mv` 的文件 `git diff --stat -M` 显示 **R100**（100% 相似度）——**动了内容即违约**                                           |
| E8  | （Gate C 反例补）比对可核 | 逐票比对清单**按票号逐条**列出「根版标题 → run 版对应票标题」；**每行结论必须能指回 run 版某票的标题原文**（「已覆盖」类断言不可注水） |

**签收判据**：E1–E7 全过 + 实施者自报「另一 effort 票单只搬不改」。

### 决策留痕

- **Q2-c/Q2-d 由店长在票内就地拍板**（设计面，不占用户裁量额度）；⚠️ 状态字段值域标**临时口径**，不替 Q2-c 的完整决策
- Gate B 契约：[边界 = 5 项归位动作 / 契约 = 只搬不改 + 逐票比对 / 验收 = E1–E7]
- ⚠️ **本票不在 Decisions 15 免审白名单内**（动 `docs/adr/**`、`docs/plans/**`、根文件）⇒ **必走审查链**

---

## 票子 · A2A 配额拦截的**静默面**补齐（机制层 · **非本 effort 面**）

**状态**：**已收口**（2026-09-12：交付 `b886399` → 吐槽猫审查 **✅ 零返工**（Z1–Z4 判据面 + 三反例独立复核为实 / OQ-2 `findStoreCat` 逐字等价从 diff 实证）→ **PR #55** carrier = merge commit **`a170f9b`** 并入 `dev`；店长实查。参见 **map Decisions 43**。**勿再派活**）｜原记录「已出票 · 待派」（排期在票辛之后）
**承**：Decisions 38 二（勘误后的真根因）+ **Decisions 39 二**（店长立票裁决，**不占用户裁量额度**——机制缺口修复，非形态裁决）
**动机**：`(traceId, agentId)` 桶耗尽后，正常的审查链投递被吞掉且**链上无人在能感知**。同一文件里另两条同类护栏**都有兜底**（`role-not-allowed` → store 广播 / count-limit → 发送者提示），**唯配额这条两者皆无**。
**实证**（**两个独立数据点，非孤证**）：`12:55:02` ds猫 的票庚审查请求 / `12:59:37` 店长的补投，**两次撞同一堵墙**，被拦方（吐槽猫）实测故障窗口 6 分钟。

### 目标（可证伪）

桶耗尽时，**发送者当场收到明确提示**且 **store 面可见**——不再只落一行 `log.warn`。**存在任一路径仍静默 ⇒ 本票失败。**

### 落点

```
packages/server/src/execution/serial.ts   （配额闸 `continue` 处补齐投递/广播，与另两条同口径）
```

### 契约（钉死）

**① 不引新机制**：复用 `role-not-allowed` 的 **store 广播**形态 + count-limit 的**发送者提示**形态，二者取其一或并用——**实现前先读那两处实现，逐项对齐**（承 Decisions 34 十二「不建新机制」先例）。
**② 不改配额口径**：`limit` / 双计语义 / 桶键 `(traceId, agentId)` **一律不动**——本票只补「静默」这一个面；**调参另立票**（语料量级未知，防防御性建设）。
**③ 不落 `execution_logs`**：那是**执行记录面**，配额拦截不是执行——落表会污染「是否被派发」的判据（该表两列语义相反，`triggered_by_message_id` 才是判据面）。⚠️ 这是**下游契约地雷**，照抄「凡拦截都记一笔」会做错。

### 验收（逐条可执行）

| #   | 验收项       | 判据                                                                         |
| --- | ------------ | ---------------------------------------------------------------------------- |
| Z1  | 发送者可见   | 桶耗尽时发送者侧能观测到「被配额拦下」的**明确信号**（非仅日志），且实测留痕 |
| Z2  | store 面可见 | 与 `role-not-allowed` 同口径的 store 广播**实测出现**（不是只写了代码）      |
| Z3  | 口径未动     | `limit` / 双计 / 桶键 的 diff **零改动**（`git diff` 实测）                  |
| Z4  | 未污染执行面 | `execution_logs` **无因本票新增的行**（构造超限场景前后比对行数）            |

**签收判据**：Z1–Z4 全过。⚠️ **改动面在 `serial.ts`（server 运行时）⇒ 收口需用户重启审批。**

### 边界

**In Scope**：配额拦截的**可见性**（发送者提示 + store 广播）
**Out of Scope**：**不改配额口径**（另立票）/ **不改 A2A 派发语义** / 不做重试或补偿投递（那是另一回事）

### 决策留痕

- **本票不属 memory-flywheel effort**（机制层）；落在本 effort 票单只为**排期可见**，交付后归机制层
- Gate B 契约：[边界 = 静默面补齐 / 契约 = 同口径 + 不改口径 + 不落执行表 / 验收 = Z1–Z4]

---

## 票丑 · 配额**单位归一**（机制层 · **非本 effort 面**）

**状态**：**已收口**（2026-09-12：交付 `b6c9cdd` → 吐槽猫审查 **✅ 零返工**（V2 两数钉死 / V4 判别面 / V7 下葬凭证独立复验；`serial.test.ts` + `socketio.test.ts` **191 passed**）→ **PR #56** carrier = merge commit **`ee2c93f`** 并入 `dev`（`dev` = `origin/dev` = `.push-gate` 三方对齐，店长实测）；店长独立复核 `memory/` / `reply.ts` / `db/` **零 diff** + 生产代码 `setMentionCount` 全量 grep ⇒ 唯一计数点 = 派发预留。参见 **map Decisions 44**。**勿再派活**）｜原记录「复申 ✅ 通过 · 待派」
**承**：Decisions 41 二/三
**与票子的关系**：**同文件同区域**（`serial.ts` A2A 段，见本文件票子「落点」）⇒ **两票必须串行**，不得两猫并行（同区域改动冲突）

### 现状（实测取证，非转述）

`(traceId, agentId)` 桶被**两处**各计一次（源码注释自陈，`serial.ts:100` 原文「各计一次 ⇒ 实际可执行轮次 ≈ limit / 2」）：

- `serial.ts:803-806` **派发预留 +1** —— A2A 派发点（`policy.allowed` 循环内）；**同步段无 await**（Node 单线程天然原子）⇒ **并发互斥的唯一来源**
- `serial.ts:663-665` **执行成功 +1** —— `if (depth > 0)`，agent 执行完成后

⇒ `MAX_MENTIONS_PER_AGENT=N` 的**实际效力 ≈ N/2 轮**，配置值不可直读。

### 目标（可证伪）

`limit` 的单位**唯一且可直读**：`MAX_MENTIONS_PER_AGENT=N` ⇒ 单 trace 内单猫最多被 A2A **派发** N 次。**存在任一计数路径仍双计 ⇒ 本票失败。**

### 落点

> ⚠️ **行号已于派单时重钉**（`a170f9b` 实测；票子 `b886399` 落地后同文件 +47 −6 ⇒ 票面
> 原行号**全部失效**）。**以「锚点」（源码原文行）为准、行号为辅助**；实施中若再漂移，
> 按锚点 grep 定位，**不要按号硬数**。

```
packages/server/src/execution/serial.ts
  锚点：`if (depth > 0) {` 紧跟 `state.setMentionCount(traceId, agent.id, ... + 1)`
  :663-665        删（执行成功计数）——保留 :805 预留为唯一计数点
  锚点：`各计一次 ⇒ 实际可执行轮次 ≈ limit / 2`（:100 文件头口径说明）
  :100            改（`limit / 2` 口径说明作废）
  锚点：`阈值 T-K 起可配（resolveMentionLimit 现读 env）：双计⇒实际轮次 ≈ limit/2`
  :798            改（「双计让防护阈值更早触达」的注释前提消失）
  锚点：`// 计数的是实际执行次数而非进入执行循环的次数，因此未执行的`
  :656-662        **改（非只删）**——该段现陈「未执行的排队任务/审查闭环 mention 不
                  消耗配额」：单计后 **语义相反**（预留先于槽位检查 ⇒ 排队未执行也
                  计数），须改写为「调度即计数（含入队未执行）」，**不得留旧句**
  锚点：`if (count >= limit) continue` / `... + 1) // 预留配额`
  :803-806        保留（唯一计数点，本票**不得动**）
packages/server/src/execution/serial.test.ts
  锚点：`// 环被截断而非无限：截断者是 **mention 配额**`
  :691-694        改（注释内引用的 `serial.ts:790` / `:649` **已漂移**，实为
                  `:805` / `:664` ——顺手重钉；V2 重写时一并处理）
  锚点：`expect(chatStream.mock.calls.length).toBe(7)` + 其下 `logWarn` 断言
  :697 / :699-703 V2 的重写对象（两者一并改写，勿只改其一）
.env.example
  锚点：`# 计数口径**双计**：调度点「检查+预留」与执行完成各计一次`
  :39-42          改（配额注释的「双计」口径作废——**env 真相源**，属本票落点）
```

### 契约（钉死）

**① 保留的必须是预留点（`:803-806`，锚点 `... + 1) // 预留配额`），不得反向保留。** 预留是**并发互斥的唯一来源**——检查与执行之间隔着整个 LLM 调用，只在执行完成计数会让同时派发的两路都读到 `count < limit`（现 `:662` 原文「防双双放行」正是此意）。**删预留 = 重开该竞态，本票明令禁止。**
**② 两道闸各司其职（店长裁决 a，替代原「配额自担环截断」）。** `MAX_AGENT_DISPATCH_DEPTH`（硬编码 `=10`）= **链长上限**，纯环的实际截断者是它；`MAX_MENTIONS_PER_AGENT` = **per-trace per-agent 预算**（防单只猫在宽 trace 里被反复拉扯）。**两闸都保留，不新建机制。** ⚠️ **明令禁止为「让配额继续当环截断者」而动 `limit`**——审查者建议的 (b)「降到 4 逐跳等价复现 7 跳」**已驳回**：① **算术复核（已含口径修正）**——按 **chatStream 执行调用数**计量，单计下 `limit=3 / 4 / 5` 分别为 **6 / 8 / 10 跳**，**没有任何整数 `limit` 能复现现网的 7 跳**（现网被拦尝试 = 第 8 次为**偶数**，单计下恒为 `2L+1` = **奇数**）⇒ (b) 的目标在单计下**算术上不可达**，不只是「参数选错」。**店长首轮「`limit=3` 复现 7 跳」系口径混用**（拿「派发尝试序号」的读数去对「执行跳数」的目标），已就地更正；② 更重要的是它把 per-agent 预算压到 3——**恰与用户诉求反向**（用户报的就是长 trace 里被误杀）。**判据输出不得依赖测试旧读数倒推产品参数。**
**③ 语义变更必须显式承认并落机器判据。** 归一后计的是**派发次数**（含排队后未执行/失败的派发——「预留不退回」是既有语义），**不是**执行次数；且 `:656-662` 的旧注释主张（「未执行的排队任务不消耗配额」）**在单计下变成假的**，须改写为「调度即计数」，并由 **V7** 钉死。⛔ 只改注释不加判据 ⇒ 本票不通过。
**④ 不动配置面。** `DEFAULT_MAX_MENTIONS_PER_AGENT = 5` / `resolveMentionLimit` / 桶键 `(traceId, agentId)` / `MAX_AGENT_DISPATCH_DEPTH` **零改动**（调参另议，本票不调）。
**⑤ 单计成立的前提须实证。** 实现前 **grep 证明「A2A 派发无旁路」**——所有 `depth > 0` 的执行都源自 `:877-880` 递归（实参 `limitedAgents` 为 `:801-806` 循环产物；公共入口在 `:1484`，`depth` 默认 0；`recovery.ts:121/353/496` 三处**均显式传 `0`**）。**查出旁路 ⇒ 停票回报，不得自行加计。**

### 验收（逐条可执行）

| #   | 验收项                          | 判据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 单计成立                        | A2A **派发** N 次后 `__getMentionCount(trace, agent) === N`（构造用例；不是「执行 N 次」）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| V2  | 环用例按新语义**重钉**          | 环用例（`serial.test.ts` 「环被截断而非无限」那条，**测试名须同步改写**；锚点 = `expect(chatStream.mock.calls.length).toBe(7)`）**实跑重测**：断言 = **实测跳数** + 截断者 = `agent dispatch depth limit reached`（depth 闸）——**不再断言 `mention limit filtered`**（= 裁决 a）。原 `toBe(7)` 与配额 warn 断言一并改写；⚠️ **禁止把旧值按下标/翻倍推算**（旧读数注释在 `:691-694`，行号漂移顺手重钉）。⚠️ **跳数口径钉死（复申补充，必须写进用例注释）**：「跳数」= **chatStream / LLM 执行调用数**（与现 `toBe(7)` 同计量）。单计 + `limit=5` 下期望值 = **10**；**被拦的是第 11 次派发尝试、拦者 = depth 闸**。**两个数字（10 / 11）一起断死**，禁止只断其一，禁止与「派发尝试序号」口径混用。附注：现网形态（执行 7 / 第 8 次尝试被拦）在单计下**无任何整数 `limit` 可精确复现**（单计被拦尝试恒为 `2L+1` = 奇数，现网是偶数）⇒ 必须按新语义**重测**，不得追着旧读数调参 |
| V3  | 受影响用例改写驱动方式          | 判据由「硬编码清单」改为**机制性清点**：`grep -rn "__getMentionCount" packages/server/src` **全部命中逐条归类**（店长实测 = 12 处断言；**依赖执行完成计数（现 `:664`）的 6 处 / 5 个用例**：`serial.test.ts` 配额跨-run 存活 ／ `socketio.test.ts` trace-quota ／ depth-0-1 ／ 验收2 ／ 验收3）——⚠️ **禁只改期望值**：须**改走 A2A 派发路径** + **断言对象由「执行者桶」改为「目标桶」** + 测试名同步改写                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| V4  | 反例为红 **+ 配额仍是真拦截者** | 至少一条**反向用例**：`limit=1` 时第二次派发必被拦，**且实跑断死截断时 `depth < 10`**（⇒ 拦截确来自配额而非 depth 闸——防「depth 顺手兜住 ⇒ 用例空洞通过」）+ 目标无 `execution_log`；把计数点改回 `:664` 式双计（执行完成处再计一次）⇒ 该用例**实跑为红**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| V5  | 配置面零改动                    | `git diff` 证明 **④** 四项零改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| V6  | depth=0 不误杀                  | 用户顶层触发（`depth=0`）**仍不消耗配额**（既有断言保留）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

| V7 | 语义变更有机器判据 | 「**调度即计数（含入队未执行）**」须有用例钉死：目标槽位忙 ⇒ 派发入队未执行 ⇒ **配额仍 +1**；且该断言须**经 A2A 派发路径**取得（非 `__setMentionCount` 播种）。旧注释 `:657-658` 的相反主张作废——本项是它唯一的下葬凭证 |

**签收判据**：V1–V7 全过。⚠️ **改动面在 `serial.ts`（server 运行时）⇒ 收口需用户重启审批。**

### 边界

**In Scope**：计数点归一 + 随之而来的注释与用例契约更新
**Out of Scope**：**不调配额阈值**（`5` 不动）/ **不做豁免判据**（= 票寅，条件触发）/ **不改 A2A 派发语义** / **不合并票子**（静默面是其票面）

### 决策留痕

- **本票不属 memory-flywheel effort**（机制层）；落在本 effort 票单只为**排期可见**
- **放宽方向已诚实标注**：单 trace 单猫可派发次数由「≈2.5 轮」变「5 次」——防护变弱，换来配置可直读；worst case 仍被 `depth=10` 卡死。真嫌宽 ⇒ 调 `MAX_MENTIONS_PER_AGENT` 一行（**本票刻意不动**，避免「补偿算两遍」）
- **票寅（判据升级）条件触发**：①② 落地后 **2 周内**，若 `agent-to-agent mention limit filtered` 再现于**实质工作链**（判据：被拦 agent 前后两次执行**均含工具调用**）**≥1 次** ⇒ 出票。**现不出票**（无数据即防御性建设）
- **店长裁决 a（2026-09-12，替代原契约②）**：审查者提出的 ②/④ 算术矛盾**成立**（店长手工推演复核：单计 + `limit=5` ⇒ 环在第 11 跳被 **depth 闸**拦下，**配额 warn 永不触发**，与 `serial.test.ts:699-703` 现断言冲突）。两条出路中**裁 (a)**：接受「depth 闸 = 链长上限 / 配额 = per-agent 预算」的新语义，**不改产品参数**。**驳回 (b)**：ⓐ **算术（含口径修正）**——按 chatStream 执行调用数，单计下 `limit=3/4/5` = **6/8/10 跳**，**无整数解可复现现网 7 跳**（单计被拦尝试恒奇数）。⚠️ 店长首轮「`limit=3` 复现 7 跳」是**口径混用**（尝试序号 vs 执行跳数），复申时由审查者指出、已更正；**这不影响驳回结论**，ⓑ 才是决定性的；ⓑ (b) 把 per-agent 预算压到 3，**与用户诉求（长 trace 被误杀）反向**。**通则：判据输出不得倒推产品参数。**
- **店长新增一条（审查者与本票面均未覆盖）**：单计 ⇒ 计数时点由「执行完成」前移到「**调度预留**」，而预留**先于槽位检查** ⇒ **排队后未执行的派发也消耗配额**——`:657-658` 注释主张的正是相反面，**该注释在单计下变成假的**。故 ③ 升级为「必须落机器判据」+ 新增 **V7**；仅改注释不通过。
- **复申结论（2026-09-12 吐槽猫，⚠️ → ✅ 放行）**：两处必修按裁定闭合（裁决 a 落地 / V7 必要且判据形态正确 / V4 `depth<10` 断死堵住「depth 顺手兜住 ⇒ 空洞通过」/ V3 机制性清点与审查者清点一致 / 文档落点无漏）。**唯一补充已落 V2**：跳数口径 = chatStream 执行调用数（期望 **10**），被拦 = 第 **11** 次尝试 / depth 闸，两数一起断死。审查者同时指出**店长首轮的算术是口径混用**（「`limit=3` 复现 7 跳」只在「派发尝试序号」口径下成立）——已在契约② 与 Decisions 42 就地更正。
- Gate B 契约：[边界 = 计数点归一 / 契约 = 保预留点 + **两闸各司其职** + 显式承认语义变更**且落判据** + 配置面不动 + 无旁路实证 / 验收 = V1–V7]

---

## 票卯 · `docs/plans/**` 补 YAML frontmatter（段三补票 · **内容侧落地** · Q2-f 乙案的落地动作）

**状态**：**已收口**（2026-09-12：交付 `dd85c97` → 吐槽猫审查 **✅ 零返工**（P1–P6 逐条独立实测：P3 直调 `classifyDocument` 四份全 `ok:true` / P6 反例独立复现为真 / P2 查库硬读数 `168 = 14+63+35+56` 与 `inserted:168` 逐字对上 / 8 个 evidence sha 逐个验实 / P4 删行全 0）→ **PR #59** carrier = merge commit **`836e1bd`** 并入 `dev`（`dev` = `origin/dev` = `.push-gate` 三方对齐，店长实测）；店长独立复跑 `scan.test.js` **21 passed** / scripts 全量 **162 passed**，独立查库 `chunks` 总数 **128 → 296**（plans 贡献 168 = 14+63+35+56 ⇒ **增量扫描真扫进去，非 `--reindex` 硬灌**）。参见 **map Decisions 49**。**勿再派活**）

### 现状（**实测取证，非转述**——2026-09-12 店长逐份实读 + 真机日志）

- 扫描器白名单 = `SCAN_PREFIXES = ['docs/adr/', 'docs/lessons/', 'docs/plans/']`（`scan.mjs:53`）；`docs/plans/` **另有额外门槛** `PLAN_STATUS_CRYSTALLIZED = {已定稿, 已收口}`（`scan.mjs:62`），其余态一律 fail-closed 跳过（`scan.mjs:243-249`）。
- **真机读数**（`MEMORY_ENABLED=true` 后首次扫描）：`scanned:18, inserted:128, skipped:11` ⇒ **有效面只有 `docs/adr/` 的 7 份**；`docs/plans/` **4 份全部**因 `no-frontmatter` 被跳；`docs/lessons/` 零卡片（只有门牌 `README.md`）。
- 四份现状（**逐份实读头部**）：

  | 文件                                  | 正文自述状态                                                                                   | 位置  |
  | ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- |
  | `docs/plans/episode-evaluation-v2.md` | `> 状态：已定稿 ✅（2026-08-11 第九轮复核通过…）`；同段另有「E2 归因分流 + E3 接线拆活进行中」 | `:3`  |
  | `docs/plans/review-chain-anchor.md`   | `状态：spec-gate PASS（含 chainType 对账位，见 D11）` —— **not 两态词表**                      | `:3`  |
  | `docs/plans/knowledge-base-v1.md`     | 头部**无**状态陈述                                                                             | —     |
  | `docs/plans/dev-process-gate-flow.md` | `状态：**待收口后回填**（…由店长回填）`                                                        | `:48` |

- ⇒ **这不是扫描器缺陷**（它按契约正确执行），是**内容侧从未落地**。`dev-process-gate-flow.md:48` 那句「待收口后回填」= 当初承诺的回填**至今没做**，**本票就是那次回填**。

### 目标（可证伪）

四份 `docs/plans/*.md` 头部各有**受支持子集内**的 YAML frontmatter，且**独立通过** `classifyDocument` 准入；`docs/plans/` 在真机扫描报告中 `inserted > 0`（不再全跳）。

### 落点与动作

- **只改这 4 个文件**：在**第 1 行**插入 frontmatter 块（`---` 开、`---` 闭），字段：
  - `type:` 非空字符串 —— 取 `plan`（与 ADR 的 `decision` 同风格）
  - `status:` ∈ `已定稿` / `已收口`（**只有这两态合法**）
  - `evidence:` **非空列表**，每条 `- kind: <commit|file|adr>` + 下一行更深缩进 `ref: <值>`
  - `date:` 可选（取该文档自述日期；**无则省略，不许编**）
- **形状参照物 = `docs/adr/0007-*.md` 头部**（照抄形状，不改字段名）。
- frontmatter **之后**接原文，正文其余部分**逐字节不动**。

### 契约（钉死）

1. **只支持 YAML 子集**（`parseFrontmatter` `scan.mjs:95-110`）：标量 / 缩进列表 / 行内数组。**不引 yaml 库、不发明形状**——解析不出的键会缺席并按 fail-closed 处置，塞近似值 = 该件静默跳过。
2. **边界规则必须与切片侧逐条对齐**（`scan.mjs:79-82` 自陈与票丙 `stripFrontmatter` 对齐）：第 1 行恰为 `---`、向下找 `---`/`...` 闭合、**未闭合 ⇒ 判无 frontmatter**。
3. **`status` 判定规则（防注水，本票最容易注水处）**：
   - **以正文自述为准，且不得比正文更进一步**（正文称「已定稿」⇒ 填 `已定稿`；正文含「进行中 / 未完成 / 待回填」类表述 ⇒ **不得填 `已收口`**）。
   - 正文**无**状态陈述 ⇒ 实施者取证（该活的收口/落地证据：merge commit / 票号 / `map.md` 裁决）并写进交接文档。
   - **取不到依据 ⇒ 该份停、不填、上报店长**——**不许猜**。四份各自独立判定，一份卡住不阻塞其余三份。
4. `type` / `status` **无白名单消费方已核实**：`classifyDocument` 只查 `type` 非空（`scan.mjs:234-235`）；检索侧状态过滤只挡 `superseded`/`deprecated`（`chunks.ts:305/326/357`）⇒ **中文两态不会被检索挡掉**。实现时**复核一次**，若发现消费方白名单 ⇒ 停票上报。

### 验收（逐条可执行）

| #      | 判据                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | 四份**第 1 行恰为 `---`** 且闭合行存在；`pnpm flywheel:scan`（= `node scripts/flywheel/scan.mjs`）报告中这 4 份**不再出现**于 `skipped`（**逐份列名**，不是只看总数）                                                                   |
| **P2** | 真实扫描**前后两次读数**（`inserted` / `skipped` 分类计数逐条列出），`docs/plans/` 贡献的行数 = 该 4 份的切片数——**实测，不是按切片器推算**。⚠️ 复测用**默认库**（不 `--reindex` 全清）——`--reindex` 会清空全表再重建，测不出「增量」面 |
| **P3** | **独立断言**：直接调 `classifyDocument({path, content})` 喂这 4 份内容 ⇒ 四份全 `ok:true`（**不接受「总报告变绿」当证据**——总报告绿也可能是别的件补上来的）                                                                             |
| **P4** | **正文逐字节未改**：`git diff --numstat` 每份 `+N −0`（**删行为 0**）；`git diff` 通读确认新增行全部落在 frontmatter 块内                                                                                                               |
| **P5** | 四份的 **status 判定依据逐份写入交接文档**（文件行 + commit sha / 票号）；任一份取不到依据 ⇒ 该份**停**并在交接文档标出（**不许静默降级为「先填一个」**）                                                                               |
| **P6** | **反例实跑**：把任一份 `status` 临时改成 `进行中` ⇒ 该份**回到 `plans-not-crystallized` 跳过**；恢复后转绿。（证明闸真在判，不是恒真用例）                                                                                              |

**签收判据**：P1–P6 全过（P5 允许「该份停」的合法形态——但停必须显式）。纯 docs ⇒ **零重启需求**。

### 边界

**In Scope**：`docs/plans/` 4 份的头部 frontmatter（准入所需字段）+ 随之而来的真机扫描复测
**Out of Scope**：

- **不动 `docs/lessons/`**（零卡片——「要不要造卡片」是内容语义决策，**不塞本票**）
- **不动 `docs/adr/`**（7 份已有效）
- **不改任何 `packages/**` / `scripts/**` 代码**——被验面是**内容**，改代码去迁就内容是错的
- **不删**正文既有状态叙述（`episode-evaluation-v2.md:3` 那句留作历史叙述；**机器真相源 = frontmatter**）。⚠️ 但若正文与 frontmatter **语义冲突**（正文称进行中）⇒ 按契约 3 停/降级，**不许两处并存两种完成度**
- 不建索引以外的任何机制

### 决策留痕

- **跳 grilling**：用户直接指令「plans补票吧」；成因单一（内容侧从未落地），无形态分歧
- **Gate B 契约**：[边界 = 只这 4 份头部 / 契约 = frontmatter 形状照 ADR 0007 + status 判定**不得超前于正文** / 验收 = P1–P6] 已钉死
- **Gate C 自曝一条**：P1–P6 全绿**不能**证明「白名单三前缀全部通电」——`docs/lessons/` 仍会是暗的（零内容）。那**不是**本票的漏网需求，是**显式划出边界**的项；段三的扫描面结论须继续如实写作「有效面 = `docs/adr/` + `docs/plans/`，`docs/lessons/` 无内容」

---

## 票辰 · 嵌入 sidecar 端口**可观测** + 扫描器端口**隔离**（段三收尾 · 运维面 · 用户裁「按你说的做吧」）

**状态**：**已收口**（2026-09-12：交付 `38bb30e`（7 文件 / +181 −7）→ 吐槽猫审查 **✅ 零返工**（C1–C5 逐项独立实测 / 承重反例 C3 亲手复现为红再恢复为绿 / OQ-2 承重前提源码实证 `defaultSpawn` 不传 `env`；五条 OQ 全裁）→ **PR #60** carrier = merge commit **`c02764bd`** 并入 `dev`（`dev` = `origin/dev` = `.push-gate` 三方对齐，店长实测）；店长独立复核：**11 处行号 `grep` 逐个命中**（`embedding-client.ts` `72/106/123/160/315/337/419/506` + `embedding.ts:66` + `scan.mjs:575` + `.env.example:60`）/ `35 + 22 passed` / **C3 亲手复现 `expected '9999' to be '0'`，还原后盘面干净**；(c) 的 `.env` 部分由店长写入 `EMBED_SIDECAR_PORT=3210`（已核 3210 空闲）。参见 **map Decisions 51**。**⚠️ C6 真机验证未完成**（需重启 + 真跑一次增量扫描），归收口窗口。**勿再派活**）

### 现状（**实测取证，非转述**——2026-09-12 店长逐处读码）

**端口为何观察不到：**

- `embed-server.mjs:285` `app.listen(parseInt(process.env.EMBED_SIDECAR_PORT || '0', 10))`；`:287` 自陈动机「OS 分配 → 并行实例不撞端口」⇒ **动态分配是刻意设计，不是缺陷**
- `.env.example:60` 早已文档化（注释行、未生效）
- 端口拿到后：`embedding-client.ts:337-344` 握手解析 → `:313` 拼进 `baseUrl` ⇒ **端口此后只活在 `baseUrl` 字符串里，未进 status**
- `embedding.ts:64` `log.info('嵌入 sidecar 就绪', { model: status.model, dim: status.dim })` —— **无 `port`** ⇒ 店长验 W7 时只能 netstat 捞（Decisions 47 已记该痛点）
- `embedding-client.ts:471-475` `defaultSpawn` **不传 `env`** ⇒ sidecar 继承父进程 env（端口只从 env 来）

**两个 spawn 点 + 两条到达扫描器的通道（关键）：**

| #   | spawn 点       | 位置                                                                          |
| --- | -------------- | ----------------------------------------------------------------------------- |
| ①   | 主 server      | `index.ts:160` `void startEmbeddingSidecar()` → `embedding.ts:57`             |
| ②   | 扫描器自 spawn | `scan.mjs:578` `new EmbeddingClient()` **不传 `baseUrl`** ⇒ 走 `defaultSpawn` |

| 通道  | 路径                                                                  | 该通道下扫描器的 `EMBED_SIDECAR_PORT`                                           |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **A** | server 启动 spawn `scan.mjs`（`index.ts:74-78` options **无 `env`**） | 继承 server 的 `process.env`（= `.env` 的值）                                   |
| **B** | 手动 `pnpm flywheel:scan`（新进程）                                   | `scan.mjs:562` **自己 `await import('env.js')` 加载 `.env`** ⇒ **同样拿到该值** |

⇒ **固定端口后，两条通道的扫描器 sidecar 都会去抢主 sidecar 的端口** ⇒ `EADDRINUSE` ⇒ 握手超时 ⇒ 按票庚 fail-closed「嵌入不可用则整件不写」⇒ **那一轮扫描白跑**（恰是有新内容、最需要它成的场景；无变更轮次不调嵌入 ⇒ 不撞）。

**⚠️ 决定修法落点的取证（本票承重）：**

- `env.ts:48-52`：`if (key && !(key in process.env)) process.env[key] = value` —— **`.env` 加载不覆盖已存在的环境变量**
- ⇒ 显式注入的 `EMBED_SIDECAR_PORT` **能穿透** `scan.mjs` 那次 `.env` 加载，不会被冲掉 ⇒ 在扫描器侧覆盖**成立**
- 反之：只在 `index.ts:74` 覆盖 ⇒ **只覆盖通道 A，漏通道 B**（店长原提法，见「决策留痕」自曝）

### 目标（可证伪）

1. 主 server 的 sidecar 端口**可预测**且**出现在启动日志**中（不再需要 netstat）
2. 扫描器拉起的 sidecar **恒为动态端口**（**两条通道皆然**），与主 sidecar **永不互撞**

### 落点与动作

**(a) 端口进 status + 日志**（`packages/server/src/memory/`）

- `embedding-client.ts`：`LiveSidecar` 增 `port: number`；`connect()` 的 spawn 分支取 `handshake.port`，`opts.baseUrl` 直连分支由 URL 解析；`lastSuccess` 增 `port`；`EmbeddingStatus` 增 `port?: number`；`status()` 的 ok 分支透出
- `embedding.ts:64` 日志加 `port: status.port`
- **不新增 env、不新增机制**

**(b) 扫描器端口隔离**（`scripts/flywheel/scan.mjs`）

- 在 `main()` 内、**早于** `new EmbeddingClient()`（`:578`）处，显式 `process.env.EMBED_SIDECAR_PORT = '0'`
- 必须带注释写明**不变量**：「扫描器的 sidecar 是短命私有的，恒用动态端口；**固定端口只属于主 server 的 sidecar**」
- **不在 `index.ts` 重复覆盖**——一处覆盖两条通道；父进程替子进程表达其内部需求是知识泄漏，且两处写同一条不变量 = 两处真相源

**(c) `.env` 与文档**

- `.env.example:60` 注释补边界：该值**仅作用于主 server 的 sidecar**；扫描器拉起的 sidecar 恒为 `0`
- `.env` 本身（**gitignored、且 worktree 内不存在**——已实测 `catStudy-sessions/3d977683/.env` 无此文件）由**店长在收口时**写入 `EMBED_SIDECAR_PORT=3210`。取值依据：`3210` 是 `embed-server.mjs:9` 文件头自带的示例值；已核不与 3200（server）/ 5173-5175（web）/ 3000（OneBot）/ 8080（llama-server）相撞

### 契约（钉死）

1. **端口来源唯一 = 握手真实值**。不得用 `process.env.EMBED_SIDECAR_PORT` 反推（默认 `0` 时它没有信息量）；`opts.baseUrl` 直连分支由 URL 解析，解析不出 ⇒ `port: 0`，**不抛错**（该分支是单测/stub 专用）
2. **`status().ok === false` ⇒ 无 `port`**（保持 `undefined`）；从未成功过时亦无
3. **不变量**：固定端口**只属于主 server 的 sidecar**；任何由扫描器拉起的 sidecar **恒动态**。该句写在 `scan.mjs` 覆盖点旁
4. **覆盖点顺序刚性**：必须早于 `new EmbeddingClient()`。**建议**紧随 `import('env.js')`（`:562`）之后——放其**之前**其实也成立（因契约承重的 `env.ts:49` 不覆盖），但**不采用**：那会让本票的正确性耦合到 `env.ts` 的实现细节上；放之后 = 「对已解析结果做显式覆盖」，语义自足
5. **不改 `embed-server.mjs`**：`listen` 与握手回报**保持原样**。本票是「把已有值暴露出来 + 隔离两个消费者」，不是改 sidecar 行为
6. **不给 `EmbeddingClient` 加 port 选项、不动 `defaultSpawn`**——避免「env + option」两处真相源

### 验收（逐条可执行）

| #      | 判据                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | `embedding.ts` 就绪日志含 `port`，其值 = 握手真实端口（**不是** env 值）——单测断言                                                                                                                    |
| **C2** | `status()` 成功后返回 `port`；失败 / 未成功时 `port === undefined`（**正反两态各一条**断言）                                                                                                          |
| **C3** | `scan.mjs` 的覆盖点**可证伪**：删掉该行 ⇒ 某条测试**变红**，恢复 ⇒ 转绿（**不接受纯文本 grep 当判据**）。若实施者实测后确无行为缝隙、只能退到静态源断言，**须在交接文档论证**为何无缝隙，不许静默降级 |
| **C4** | `.env.example` 注释已写明「仅主 server sidecar」边界                                                                                                                                                  |
| **C5** | **既有测试全绿**（`memory/**` + `scripts/**` 全量），零回归                                                                                                                                           |
| **C6** | **收口验收**（**需重启，归店长，不在 worktree 面**）：重启后启动日志出现 `port=3210`；再构造一次真实增量扫描 ⇒ 扫描器 sidecar 落在**非 3210** 端口、**无 `EADDRINUSE`**、报告 `errors:0`              |

**签收判据**：C1–C5 全过 + C3 的可证伪性已实证。C6 属收口面（需用户重启审批），本票在 worktree 面**无法自行闭合**——届时 C6 不绿则出返工票。

### 边界

**In Scope**：上述 (a)(b)(c) 三处 + 随之而来的既有测试同步

**Out of Scope**：

- **不做**「扫描器复用主 sidecar 连接」——**Decisions 48 三 已撤回**（三冲突之一为真耦合：`embedding-client.ts:218-222` **任一请求失败即杀进程**，复用会把服务端一次检索超时传染成扫描整轮崩）
- **不改 `embed-server.mjs`** 的监听 / 握手行为
- **不加 `EmbeddingClient` 的 port 选项**、不动 `defaultSpawn`
- **不改 `dropSidecar` 的重试策略**——「一次失败就杀」是否为最优是**独立取舍**（改后每次真故障多等一整个超时周期），本票不碰
- **不动 `index.ts:74` 的 spawn options**（理由见 (b)）
- 不清理 `map.md` Frontier 的其他条目

### 决策留痕

- **跳 grilling**：用户直接指令「按你说的做吧」（承 Decisions 48 三 的方案形态 + 本轮两轮答疑）；成因单一、无形态分歧
- **⚠️ 店长出票时自曝形态修订**：③ 的落点**从 `index.ts:74` 上移到 `scan.mjs` 的 `main()`**。原提法**只覆盖两条通道中的一条**——漏了手动 `pnpm flywheel:scan`（`scan.mjs:562` 自己加载 `.env`，实测取证）。修订后**一处覆盖两条通道**。**对用户可见的形态不变**（仍是「三件套」），变的只是第三件的落点
- **契约承重取证（须记，否则将来会被无声改坏）**：③ 成立的前提是 `env.ts:49`「`.env` 不覆盖已存在 env」。若该行为将来改成覆盖式，覆盖点**仍成立**（因它在 env.js 之后）；但若有人把覆盖点**上移到 env.js 之前**再叠加覆盖式加载，**③ 会静默失效** ⇒ **C3 的可证伪测试就是这条的护栏**
- **Gate B 契约**：[边界 = (a)(b)(c) 三处 / 契约 = 端口来源唯一 + 扫描器恒动态不变量 / 验收 = C1–C6] 已钉死
- **Gate C 自曝一条**：C1–C5 全绿**不能**证明「真机不再撞端口」——那需要**真跑一次扫描 + 一次重启**，归 C6（店长收口面）。本票在 worktree 面**结构性地无法自证最后一步**，如实标注而非假装闭合

---

## 票巳 · 关停链**可观测性** + sidecar **回收正确性**（票丁 OQ4 兑现 · 机制层 · **非本 effort 面**）

**状态**：出票（2026-09-12，店长）。**实施面料期待定**（见 OQ-1）。

**动机**：票丁 OQ4 留账「关停链未观察」，店长判定规则 = **「下次 server 关停时验，无回收行才出票」**。2026-09-12 20:33 重启窗口首次取证 ⇒ **关停侧零日志** ⇒ 按规则**出票**。

### 现状（实测取证；全部为日志 / 进程 / 源码原文，非转述）

| #   | 事实                                                                                                                                                   | 取证面                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 1   | `index.ts:330 shutdown()` **首行即** `log.info('shutting down...')`；链尾 `index.ts:348 stopEmbeddingSidecar()`                                        | 源码                          |
| 2   | 但 `stopEmbeddingSidecar()`（`embedding.ts:73-76`）**只有 `client?.stop()` + 置 null，零日志**                                                         | 源码                          |
| 3   | **按钮重启路径下 `shutdown()` 根本不执行**：`dev.js:248 killTree(serverChild.pid)` → `dev.js:108 taskkill /F /T`（Windows 硬杀，**不发 SIGTERM**）     | 源码                          |
| 4   | 20:33:39「restart request confirmed」→ 20:33:41 新进程「database ready」，**中间零关停日志**；全日志 28 条 `shutting down...`，最后一条停在 `15:13:51` | `cat-study.log`（两窗口对读） |
| 5   | 今日**无孤儿** sidecar（现存仅 PID 22360，parent=25624）——唯一原因是 `/T` **连坐杀树**，**不是回收链生效**                                             | `Get-CimInstance`             |
| 6   | 非 Windows：`killTree` = `process.kill(pid,'SIGKILL')`（`dev.js:103`）**只杀 server 本身** ⇒ sidecar 作为其**子进程会成为孤儿**，占端口 / 占内存       | 源码                          |

**结论**：回收是**偶然兜住的**——链条本身**既不可观测**（②），**在非 Windows 上也不成立**（⑥）。

### 改什么

- **(a)** `stopEmbeddingSidecar()` 增一条回收日志（含**真实 port**）—— 这是「回收有没有发生」的**唯一可判面**
- **(b)** 重启路径改优雅：dev.js **先发 SIGTERM → 宽限窗 → 超时兜底 `taskkill /F /T`**（**不可只发不等**）
- **(c)** 非 Windows `killTree` 补子进程回收（或与 (b) 合流）

### 契约（硬点）

1. 回收日志的 `port` **必须取自握手真实值**（承票辰契约 1），**不得** env 反推
2. **(b) 的宽限窗必须有上限**，超时后仍走硬杀 —— **重启可靠性不得因此退化**（**承重**：按钮重启是用户日常路径，卡住比不优雅严重得多）
3. **不改 `embed-server.mjs`** 的监听 / 握手行为

### 验收

| #      | 判据                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| **D1** | graceful 关停（真 SIGTERM）后日志出现回收行，且 `port` = 真机端口——**单测 + 真机各一条**                    |
| **D2** | **按钮重启后**日志出现 `shutting down...` **+** 回收行（**真机，归店长收口面**）                            |
| **D3** | 重启后 `embed-server.mjs` 进程数 **= 1**（无孤儿）                                                          |
| **D4** | **重启可靠性不退化**（**承重反例**）：宽限窗若被设为极大 ⇒ 重启卡死。须有测试或**明确论证**为何该风险不存在 |
| **D5** | 既有测试全绿，零回归                                                                                        |

### OQ（出票时**未决**，留实施 / 审查面）

- **OQ-1**：(b) 的宽限窗取值（建议 3–5s，须给依据）。**若实施者实测后认为不该动重启路径**（如 dev.js 已被验证稳定、引入 SIGTERM 会开出新的挂起面），**允许只做 (a)+(c)** —— **但必须在交接文档论证**，**不许静默缩范围**（承票辰 C3 的同一条规矩）
- **OQ-2**：`client.stop()` 目前**无回执**——是否该记 sidecar 的退出码 / 是否真被杀

### 边界

**In Scope**：(a)(b)(c) 三处 + 随之而来的测试同步

**Out of Scope**：

- **不改** `EmbeddingClient` 的失败 / 重试策略（票丁 P3-1 观察项，**独立取舍**）
- **不动** `.agent-busy` 保护窗语义
- **不改** `embed-server.mjs`
- **不处理**主库形态（`pnpm start`）覆盖缺口（**独立挂账**）

### 决策留痕

- **跳 grilling**：OQ4 的判定规则（**无回收行才出票**）已于票丁收口时预定，本轮为**规则触发**而非新形态决策；形态无分歧
- **⚠️ 本票与票辰同属「server 运行时 + dev.js」⇒ 收口需一次重启**；建议与任何在飞的 server 运行时票拼同一窗口

## 票午 · 嵌入**超时与批大小解耦**（走多批 + 失败重试）· 段三衍生病灶 · **用户裁「派活」**

**状态**：✅ **已收口**（2026-09-12；PR **#61** → carrier `6d19f1fca909a21d2516c48fd5d6716c7ed63ed0`；吐槽猫审查 `cc533e1` ✅ 零返工；三方对齐 `dev` = `origin/dev` = `.push-gate` = `6d19f1f`）。

**✅ D2 真机验证已在收口时当场做完（不挂重启窗口）**：扫描器走 tsx **直读源码**、主仓 dev 已含本票 ⇒ 无需重启即可验。`pnpm flywheel:scan --reindex`（清空索引行 296 重扫）⇒ **`inserted:296 / errors:0 / aborted:null`**，**三表齐平 296/296/296**，其中 `docs/plans/review-chain-anchor.md` = **56 片完整入库**（正是本票的靶心文档）。⚠️ 收口面仍需一次重启——**但不是为 D2**，是为让**长驻 server 进程**吃到本票的运行时改动（`embedding-client.ts` 被 `embedding.ts` import）。

**动机**：票辰 C6 真机验证期间发现 `docs/plans/review-chain-anchor.md`（**56 片，全库最大**）在「前面已有约 240 片嵌入」时**必** `embed-failed / request-timeout`（**2 红 2 绿稳定复现**）。用户 2026-09-12 裁定形态：**「按 10 秒的能力，走多批」**。

### 现状（实测取证；数据为店长真机实测，非估算）

| #   | 事实                                                                                                                                        | 取证面               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | `scan.mjs:405` 把**整件文档**交给 `embedMany`；`MAX_BATCH=64`（`embedding-client.ts:44`）⇒ 56 片全塞进**一次** HTTP 请求                    | 源码                 |
| 2   | 该请求预算 = **写死** `REQUEST_TIMEOUT_MS=10_000`（`embedding-client.ts:40`）⇒ **两个数互不知道对方存在**                                   | 源码                 |
| 3   | 实测该文档 56 片一次：**11.9 / 13.8 / 14.5 / 14.7 / 15.0 / 15.1 / 15.5 / 18.7 秒（8 次全超）**                                              | 真机（打活 sidecar） |
| 4   | 实测**分批不花额外时间**：16 片一批（4 批）总 **14.6s**；8 片一批（7 批）总 **16.0s**；不切（1 批）**14.7s**                                | 真机（同一件文档）   |
| 5   | 写库失败粒度 = **整件文档**（`scan.mjs:402-421`：任一批失败 ⇒ **该件一行不写**）                                                            | 源码                 |
| 6   | 半截索引**比没索引更坏**：有行即被当「已扫过」跳过（`scan.mjs` 头注）                                                                       | 源码                 |
| 7   | ⚠️ 同一请求耗时抖动 **25 倍**：抓到过 **0.58 / 0.56 / 0.59 秒**，输出向量与慢跑**逐位相同**（真算了，非缓存）；**未能按需复现、未查清原因** | 真机                 |

**结论**：必红**不是「参数没调好」**，是**接口层耦合**——超时是**常数**，请求体大小是**变量**。且机器抖动 25 倍 ⇒ **任何写死的绝对时限在这里都是脆的**，切批正是在给抖动买余量。

### 改什么

- **(a)** **超时预算与批大小解耦** = 每批各持一份 10s 预算（而非整件文档共用一份）—— 即用户裁的「走多批」
- **(b)** **失败自动重试一次** —— 用户原话「一次万一跑很久也没跑完，不是一点数据不产生，都白跑」。**(a) 修不了这半句**：(a) 修「**会不会**失败」，(b) 修「失败后**损失多大**」

### 契约（硬点）

1. **写库粒度不得改成按批落库** —— 半截索引比没索引更坏（现状 ⑥）；宁可整件重来
2. **不改 `embed-server.mjs`** 的监听 / 握手行为
3. **总吞吐不得退化**：分批后同一件文档总耗时 ≤ 不切分的 **1.5 倍**（基线见现状 ④）
4. 批大小**参数化**（常量或 env），**不得**硬编码散落多处

### 验收

| #      | 判据                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| **D1** | **承重反例**：把分批改回「整件一次」（或批大小 = `MAX_BATCH` 且不切）⇒ **必须有测试变红**    |
| **D2** | 该文档（56 片）在**前面已有 ≥240 片已嵌**的条件下扫过 ⇒ `errors:0` —— **真机，归店长收口面** |
| **D3** | 总吞吐不退化（契约 3），**须给实测数**                                                       |
| **D4** | (b) 若做：首次失败 + 重试成功 ⇒ 该件**完整入库**，**须有测试面**                             |
| **D5** | 既有测试全绿，零回归                                                                         |

### OQ（出票时**未决**，留实施 / 审查面）

- **OQ-1**：批大小取值（16 / 8 / 其他）—— **须给依据**；实测余量：16 片余量 2–6 倍、8 片余量 3–7 倍
- **OQ-2**：(b) 的重试次数与退避。**若认为 (b) 不该做，必须论证**，**不许静默缩范围**（承票辰 C3 同一条规矩）

### 边界

**In Scope**：(a)(b) 两处 + 随之而来的测试同步

**Out of Scope**：

- **不动** 票巳关停链（**独立票**，用户另裁）
- **不做**「索引陈旧读数」（**用户另裁**，见 map 待裁项）
- **不改** `segment.ts` 切片策略（450 上限 = Q3 已裁）
- **不改** `EmbeddingClient` 的「失败即杀进程」策略（票丁 P3-1，独立取舍）

### 决策留痕

- 形态由**用户裁定**（「走多批」）；**参数取证由店长实测提供**（现状 ③④，票面已附数）
- ⚠️ **落点决定是否需重启**：`scan.mjs` 是独立脚本（改它**不涉 server 运行时**）；但若 (a) 落在 `embedding-client.ts`（`MAX_BATCH` / `REQUEST_TIMEOUT_MS` 所在），该模块**被 server import** ⇒ **收口需一次重启**。实施者须在交接文档**明确标注落点**，供店长判是否拼窗口

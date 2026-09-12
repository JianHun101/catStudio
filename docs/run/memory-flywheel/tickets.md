# 票单 · memory-flywheel

> 规格地图见同目录 `map.md`（grilling 产出，Decisions 1–31 为已裁结论）。
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

| #        | 内容                                                                                                        | 处置                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **B8**   | 真机：`pnpm start` ⇒ sidecar 自起、嵌入可用；停 sidecar ⇒ 按 B2 降级                                        | **本票唯一未验项**，待用户重启窗口（重启即 B8 窗口）。**未验，不得记「B1–B9 全过」**                       |
| **OQ4**  | `libuv` 断言（进程关停链）                                                                                  | **建议单独立票（未立）**——作者已证纯 node 可复现、非本票引入；server SIGINT 关停链同构。重启验证时顺带观察 |
| **P3-1** | 降级处理不对称：HTTP 非 200 走 `dropSidecar()`（杀进程），响应 JSON 解析失败 / 形态不符只 `failAll` 不 drop | 留观察——方向安全（多撞一次才被冷却拦住）                                                                   |
| **P3-2** | OQ3 `baseUrl` 测试钩子命名（无 `__test_` 前缀）                                                             | 顺手项，下次动该文件时对齐                                                                                 |

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

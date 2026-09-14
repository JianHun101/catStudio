# C1 清理票：老记忆链残留核查与清除

> 来源：用户 2026-09-14「对老的记忆知识库进行核查，删掉无用的代码和表，减少对我们设计的影响」。
> 定位：**R1 的前置票**。两票改同一批文件（`chunks.ts` / `memory/index.ts`），**串行落**，不并行。
> 状态：**待派活**。

## 一、核查结论：表已经干净了，残留全在代码 / 配置 / 命名

先给实测，防后来者重复挖：

| 核查项                                 | 结论                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `memories` / `memories_fts` 表         | **已 DROP，两张都没了**。`cat-study.db` 与 `cat-study-dev.db` 实测 `no such table`                                               |
| `MEMORY_HYBRID_ENABLED` 开关           | 已删（`env.ts:143` 留说明注释）                                                                                                  |
| `memory/filter.ts` 消费模块            | **文件已不存在**（`MEMORY_FILTER_*` 随之失去消费方）                                                                             |
| `searchMemoriesHybrid` 函数            | **已删**。全仓仅剩 2 处引用：`chunks.ts:371`（注释）、`memory/index.test.ts:471-477`（一条**反断言**，防人照注释把死函数找回来） |
| `MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE` | **是活的**（`memory/index.ts:186-187` 真读），**不可删**                                                                         |

> ⚠️ **最后一行是一次真实的险情**：本会话首次核查时，grep 这两个变量返回零命中，差点判成死配置。**误判原因是 §二·A1 那个 NUL 字节让 grep 跳过了整个文件**。加 `-a` 后立刻出 40 行。这条同时是 A1 的实害演示——记在这里，防后人踩同一个坑。

**所以「删表」这件事已经做完了。** 本票要清的是**表没了、名字还活着**的部分。

## 二、病灶清单

分两组：**A 组零行为变更**（文本/配置/注释层），**B 组动模块边界**（`memories.ts` 消失）。A 先做，B 在后。

### A 组：零行为变更

#### A1. `memory/index.ts` 里有一个**字面 NUL 字节**（全仓唯一）

| 项       | 值                                                                                   |
| -------- | ------------------------------------------------------------------------------------ |
| 位置     | `packages/server/src/memory/index.ts:273`，字节 offset **11363**，共 **1** 个 `0x00` |
| 原文     | `` const key = `${chunk.doc_path}<NUL>${chunk.section_anchor}` ``                    |
| 引入     | `a0624c6`（票辛 检索接线）——**是提交进仓库的**，不是本地污染                         |
| 全仓扫描 | `.ts/.mjs/.js/.vue/.json/.md` 全遍历，**只有这一个文件命中**                         |

**实害（实测，不是推断）**：

- `file packages/server/src/memory/index.ts` → `data`（判为二进制）；
- **grep / ripgrep 默认跳过该文件**：本会话实测 `grep -n "topK" packages/server/src/memory/index.ts` 返回 `Binary file ... matches` 且**零结果**，加 `-a` 才出 40 行。
- 即：**这个文件对代码搜索隐形**——而它正是 R1 要改的文件。任何人（含 R1 实施者、审查者）在该文件里搜代码都搜不到，且**不报错**，只会以为「没有匹配」。

**修法**：把那个字面 `0x00` 换回源码转义写法 —— 写 **`'\0'`**（单引号字符串里的反斜杠零）。**语义完全不变**——它本来就是 `doc_path` / `section_anchor` 拼接的防歧义分隔符，转义后运行时值一模一样。

> 🔬 **根因已复现（本会话实证，非推测）**：**写本票时这个字节又长出来了一次。**
>
> 正文里写了一次「反斜杠 + u + 四个零」的转义写法（本意是举例说明修法），落盘后**它变成了一个真的 `0x00` 字节**——`git diff --staged --stat` 当场把本票标成 `Bin 0 -> 15310 bytes`（与 `memory/index.ts` 被标 `data` 同一个信号）。
>
> 结论：**这个字节不是手抖敲出来的，是某个「会求值转义序列」的写入层**（编辑器 / 工具 / 脚本）**把源码里的转义当成了待展开的内容**。它解释了 `a0624c6` 的成因——当时的作者想写模板字符串里的源码转义，写入层替他把那四个字符展开成了实字节，**提交、审查、测试全都没拦住**（tsc 与 vitest 都能跑，因为 NUL 在模板字符串里是合法的运行时值）。
>
> **故修法要点不是「删掉一个字节」，是换一种不会被展开的写法**：`'\0'` 在**同一条写入路径下安然落盘**（本票实测），而那个四字符形式会被吃掉。**实施者请照 `'\0'` 写，不要在源码里写四字符形式**——否则同样的字节会再长回来一次，而这次没人会发现。

**验收**：`file` 判为 `UTF-8 text`（或 `ASCII text`）；`grep -rn "MAX_PROBE_N" packages/server/src/memory/index.ts` **不加 `-a`** 也能命中。

#### A2. `eval/phase0.ts` 的判分基准在教一个**已作废的旋钮**

```
phase0.ts:363-367
  good('ext-06',
    ctx('记忆去重的阈值怎么调?'),
    'MEMORY_DEDUP_THRESHOLD 默认 0.20:余弦距离小于此值的记忆跳过存储。调大更激进去重(少存),调小更保守(多存)。更新阈值 0.35 介于去重与插入之间。')
```

`MEMORY_DEDUP_*` / `MEMORY_UPDATE_THRESHOLD` 三个旋钮已作废（`.env.example` 自标【已作废】），消费模块 `memory/filter.ts` 已删，`MEMORY_DEDUP_*` 在活代码里**零消费**（全仓 grep 仅命中本条）。

**这不是过期注释，是过期标准答案**：`phase0.ts` 是判官校准集，`good(...)` 的内容是**被判为正确**的期望。后果是 Phase 0 一旦重跑，**模型背诵这个死旋钮得满分，说真话（「该旋钮已作废」）反而判错**。校准集把死知识编码成了 ground truth。

**修法**：**照抄下面这段（店长已定稿，实施者不要自由发挥判分基准的措辞）**——保留 `ext-06` 的 id 与 `good()`（`humanScore: 5`）标签，**只把期望答案换成实话**，问题一字不动：

```
good(
  'ext-06',
  ctx('记忆去重的阈值怎么调?'),
  '现在没有去重阈值这个旋钮了——对话原话的实时嵌入层已整体退役(写口与 memories 表双删),MEMORY_DEDUP_* 系列参数一并作废。现行机制是 MD 为唯一写入口:扫描器把白名单 MD(docs/adr、docs/lessons、docs/plans)切片后嵌入,按身份键 content_hash 幂等 upsert 进 chunks 三表——重扫同一份文档是覆盖而非新增,所以不需要相似度去重。检索走 searchChunksHybrid(向量+关键词 RRF),阈值是 MEMORY_MAX_DISTANCE 默认 0.6,知识库侧另为 0.35。'
),
```

> **为什么保留问题而不整条删**：这是一道**有价值的陷阱题**——它测的正是「模型知不知道现状，还是在背诵已退役的文档」。`good()` 标签是对的，错的只是期望答案的**内容**。整条删掉等于把这道题浪费了。
>
> 定稿里的三条事实依据（实施者别改数）：`MEMORY_MAX_DISTANCE` 默认 0.6 = `memory/index.ts:187`；知识库 0.35 = `knowledge.ts:39`；MD 唯一写入口 + `content_hash` 幂等 upsert = `AGENTS.md` 「记忆」段。

**验收**：全仓 grep `MEMORY_DEDUP` 零命中（含 `phase0.ts`）。

#### A3. `.env.example` 5 条【已作废】变量仍占位

`.env.example:67-69`（`MEMORY_DEDUP_ENABLED` / `MEMORY_DEDUP_THRESHOLD` / `MEMORY_UPDATE_THRESHOLD`）、`:74-75`（`MEMORY_FILTER_ENABLED` / `MEMORY_MIN_CONTENT_LENGTH`）。读者会以为可调。

**修法**：删除这 5 行。**保留** `:70-71` 的 `MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE`（活的，见 §一）。

**验收**：`.env.example` 内 `已作废` 字样零命中。

#### A4. `memory/index.ts:67-68` 的注释是**假的**

```
:67  /** 该节内最相关片的余弦距离（节级排序依据） */
:68  distance: number
```

「节级排序依据」不成立：节序由 `bestIndex` 定（`:231-234`），`kept` 按插入序（`:290-294`），`renderSections` 只按位置首尾各半（`:327`）——**全链没有任何一处 sort 用 `distance`**。它当下唯一的真实读点是 `reply.ts:656` 的台账日志列。

**修法**：照抄这句，一字不改——`/** 该节内最相关片的余弦距离（台账列：当前不参与排序，节序由片级位次 bestIndex 决定） */`

**验收**：`grep -n "节级排序依据" packages/server/src/memory/index.ts` **零命中**（该字样只此一处）。

> 补这条验收的原因（spec-gate Gate C 抓的）：A4 原先只有「改成实话」这个说法，**没有任何可观察结果能证明它被满足**——「实话」不可证伪。换成「旧字样零命中」即可机械判定。

#### A5. `chunks.ts` 两处指向**已删对象**的注释

- `chunks.ts:338`：「分词**复用 `memories.ts`** 的 `bigramTokenize`/`buildFtsQuery`」——`memories.ts` 即将消失（B 组），且它本就不是 memories 表的模块；
- `chunks.ts:371-375`：「**逐项对齐 `memories.ts` 的 `searchMemoriesHybrid`**」+「与 **memories 侧同款哨兵**」——`searchMemoriesHybrid` **已不存在**。照注释去找函数必然扑空。

**修法**：随 B 组的拆分结果改写指向（见 §三）。

### B 组：`memories.ts` 拆解——文件消失

#### B1. 病灶：一个以死表命名、实际服务知识库的模块

`packages/server/src/db/repository/memories.ts`（173 行）的模块头注释**自己承认**：

> 「⚠️ 本模块的历史名字来自 `memories` 表……该表已随段三检索接线**下线**……留下的两样东西都与那张表**无关**」

它实际装着三样互不相关的东西：

| 内容                                                                           | 实际服务谁                    | 现状                                      |
| ------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------- |
| `bigramTokenize` / `buildFtsQuery` / `KEYWORD_STOPWORDS` / `FTS_SPECIAL_CHARS` | `chunks_fts` 的切分与查询构造 | 纯函数，**无 db 依赖**                    |
| `HYBRID_CHANNEL_TOP_N` / `RRF_K`                                               | `chunks.ts` 的 RRF 融合       | 常量，**唯一消费者是 `chunks.ts`**        |
| `searchMemoriesByVector` + `MemorySearchResult` + `SEARCHABLE_TABLES`          | **`knowledge` 表**            | 白名单**只剩一个值**（`memories.ts:146`） |

**最刺眼的一处反转**：`knowledge.ts:13` 从 `./memories.js` 导入 `searchMemoriesByVector`，`knowledge.ts:41` 调它时传 `'knowledge'`，而**查的是 `memories.ts` 自己的 db 句柄**——`knowledge.ts` 有 `setRepoDb`（`:17`）却不用于检索。知识库的取数逻辑住在「记忆」模块里。

**对设计的实害**：R1 正是围绕检索写埋点。实施者读 `chunks.ts` 会连撞两处「对齐 memories.ts」「与 memories 侧同款」——而 `memories.ts` 里既没有 `searchMemoriesHybrid`，也不含任何 memories 语义。**这就是用户说的「对我们设计的影响」。**

#### B2. 拆解方案（店长裁决）

| 原内容                                                                         | 去哪                                                                                                              | 理由                                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bigramTokenize` / `buildFtsQuery` / `KEYWORD_STOPWORDS` / `FTS_SPECIAL_CHARS` | **新建** `db/repository/fts.ts`                                                                                   | FTS5 切分与查询构造是一个独立关注点；**无 db 依赖 ⇒ 无 `setRepoDb`、无 repository/index 接线**           |
| `HYBRID_CHANNEL_TOP_N` / `RRF_K`                                               | 移入 `chunks.ts`                                                                                                  | 唯一消费者就是它，常量跟着用法走                                                                         |
| `searchMemoriesByVector` / `MemorySearchResult`                                | **并入 `knowledge.ts`**，用 `knowledge.ts` 自己的 db 句柄                                                         | 白名单只剩 `knowledge`，参数化表名已无存在理由                                                           |
| `SEARCHABLE_TABLES` 白名单 + `table` 参数 + `TypeError` 分支                   | **整个删除**                                                                                                      | **「参数来源永不放宽到外部输入」的安全边界，在只有一个值之后退化为死代码**。删掉即消灭一条永不触发的路径 |
| `MemorySearchResult` 类型                                                      | **删除**，与既有 `KnowledgeSearchResult`（`knowledge.ts:21-28`）合一                                              | 两者形状本就相同——`knowledge.ts:42-48` 现在做的正是**逐字段搬运**。合并后这层映射整个消失                |
| `MemoryRow` 类型（`repository/index.ts:74` 导出）                              | **删除**（已实测**零消费方**：全仓仅 `types.ts:72` 定义 + `repository/index.ts:74` re-export 两处，无任何使用点） | 随 memories 语义一起退场                                                                                 |

**连带从 `repository/index.ts` 删除**：`:19`（`setMemoriesDb` 导入）、`:37`（调用）、`:55`（`export * as memories`）。`fts.ts` 无 db 句柄，**不新增任何接线**。

**净效果**：删 1 个文件、新建 1 个（更小、更纯）、`knowledge.ts` 内部自洽、`repository/index.ts` 少 3 行、白名单机制与类型映射层整体消失。

#### B3. 受影响文件（实施者照单核对，勿遗漏）

| 文件                                             | 改什么                                                 |
| ------------------------------------------------ | ------------------------------------------------------ |
| `db/repository/memories.ts` + `memories.test.ts` | **删除**；测试内容按 §三 拆到 `fts.test.ts` 与知识库侧 |
| `db/repository/fts.ts`（新建）                   | 承接 FTS 四件套 + 新建 `fts.test.ts`（同目录同名前缀） |
| `db/repository/chunks.ts:16`                     | 导入改指 `./fts.js`；两个融合常量改为本文件内定义      |
| `db/repository/knowledge.ts:13,41`               | 删除对该模块的依赖，检索逻辑内联                       |
| `db/repository/index.ts:19,37,55`                | 删 `setMemoriesDb` 接线与 `memories` 命名空间导出      |
| `db/repository/chunks.test.ts:18`                | `bigramTokenize` 导入改指 `./fts.js`                   |
| `memory/index.test.ts:19`                        | 同上；并复核 `:471-477` 那条反断言的指向是否仍成立     |

## 三、边界（明写不做）

- **不动检索行为**——本票零行为变更（A 组纯文本，B 组纯搬家）。`searchChunksHybrid` 的融合逻辑、`chunks.ts:306` 的 `<`、哨兵填法**一律原样**。
- **不删哨兵**（`chunks.ts:400` / `memory/index.ts:223`）——它的语义职责移交给 R1 的 `channel` 列，删除要动 `RetrievedSection.distance` 的类型与 `renderSections` 消费面，属 R1 之后的事。
- **不动 `db/index.ts:641-647` 那个全覆盖 `catch {}`**——它用同一机制承接「迁移幂等」与「掩盖失败」，与本项目靶心同型，但**另立一票**，不捆进来。
- **不做 20 处「票辛」标记的全面分诊**——只处理 §二 点名的、会误导读代码的那几处。全面分诊是文档债，不阻塞设计。
- **不改 `MEMORY_TIMEOUT_MS`**（`reply.ts:620` 是局部常量、非环境变量，名字有误导性）——记一笔，另票。

## 四、验收标准（行为可验证）

1. **A1**：`file packages/server/src/memory/index.ts` 不再判为 `data`；**不加 `-a`** 的 `grep -rn "MAX_PROBE_N" packages/server/src/memory/index.ts` 能命中。
2. **A1 语义不变**：全库测试绿（NUL→`\0` 是等价改写，节内去重行为逐字节不变）。
3. **A2**：全仓（含 `phase0.ts`）grep `MEMORY_DEDUP` **零命中**；且 `ext-06` 的期望答案与店长定稿**逐字一致**（防实施者自行改写判分基准）。
4. **A4**：`grep -n "节级排序依据" packages/server/src/memory/index.ts` **零命中**（该字样只此一处）。
5. **A3**：`.env.example` grep `已作废` 零命中；`MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE` **仍在**且仍被 `memory/index.ts:186-187` 消费。
6. **B1**：`db/repository/memories.ts` 与 `memories.test.ts` **文件不存在**；全仓 grep `repository/memories` 与 `from './memories` **零命中**。
7. **B2 行为等价（本票最关键的一条）**：知识库检索回归——`search_knowledge` 命中结果与改动前**逐字段一致**（`id`/`content`/`source`/`created_at`/`distance`，含 `maxDistance=0.35` 默认值语义与 topK 排序）。
8. **B3**：`repository/index.ts` 的 `initRepository` 不再引用 `setMemoriesDb`；`repo.memories` 命名空间不存在（若外部无消费方）。
9. **A5**：`chunks.ts` 内 grep `searchMemoriesHybrid` **零命中**；`memories.ts` 相关指向全部改写。
10. **MemoryRow 已删**：全仓 grep `MemoryRow` **零命中**（含 `types.ts` 与 `repository/index.ts`）。
11. 全套 `npx vitest run` 绿 + `node scripts/lint.js` 通过。
12. 提交 `catstudy [uuid]`，提交前 grep 复核行号（本仓纪律）。

## 五、与 R1 的关系

**C1 是 R1 的前置，串行落，不并行。** 两票改同一批文件：

| 文件                                      | C1 动                               | R1 动                            | 冲突面                           |
| ----------------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------- |
| `db/repository/chunks.ts`                 | `:16` 导入 + `:338`/`:371-375` 注释 | `:396-407` 出口带通道身份        | 同文件，行不重叠但**同函数邻域** |
| `memory/index.ts`                         | `:273` NUL + `:67-68` 注释          | `:216-234` 采集 + `:90-110` 统计 | 同文件                           |
| `db/repository/knowledge.ts` / `index.ts` | 拆解                                | —                                | —                                |

并行必冲突。**C1 先合、R1 再开**——且 C1 先落正好达成用户要的「减少对我们设计的影响」：R1 实施者拿到的 `chunks.ts` 不再有指向死函数的注释。

## 决策留痕

- **跳 grilling**：因本票需求来自**用户明确指令 + 店长实测核查**（不是模糊想法）——核查面、病灶、拆解方案均有逐条源码证据与行号，无待澄清的需求分歧 → 故本单不单跑 grill。
- **Gate A 需求照准**：A1~~A5 + B1~~B3 每条都有可观察结果（`file` 判定 / grep 零命中 / 文件不存在 / 检索结果逐字段一致）。
- **Gate B 契约锁定**：边界 = §三（明写不做：不动检索行为、不删哨兵、不动 `db/index.ts:641-647` 的 `catch {}`、不做全量票辛分诊）；契约 = §二·B2 拆解表（四样东西的去向逐个钉死，含 `MemoryRow` 零消费方实测）；验收 = §四 十二条。
- **Gate C 反向证明**：逐条对账后**补了两处漏网**——① A4 原只有「改成实话」这个不可证伪的说法，补「旧字样零命中」；② `MemoryRow` 原写「核查后清理（若无消费方）」是条件式空头承诺，实测零消费方后钉死为「删除」并补验收第 10 条。
- **原「挂后续单」不在本票**：`db/index.ts:641-647` 全覆盖 `catch {}`、`reply.ts:620` 的 `MEMORY_TIMEOUT_MS` 命名误导、20 处票辛标记的全面分诊——均记在 §三，**本票不碰**。

## 实施留痕（2026-09-14，flash猫）

### 一、§四 十二条逐条实测

| #   | 判据                  | 实测                                                                                                                                           |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A1 文件不再判为二进制 | `file` → `JavaScript source, Unicode text, UTF-8 text`（改动前 `data`）；**不加 `-a`** 的 grep 命中 `:44` 与 `:238` 两行                       |
| 2   | A1 语义不变           | 全套 112 文件 / 2233 用例绿（改动前 2239；差值 6 可逐条核：删 `memories.test.ts` 13 例、新增 `fts.test.ts` 7 例、`knowledge.test.ts` −1/+1）   |
| 3   | A2                    | `ext-06` 期望答案与票面定稿**逐字节一致**（284 字符，脚本比对返回 `IDENTICAL: true`）。⚠️ 本条前半句不可满足，见 §三                           |
| 4   | A4                    | `grep -n "节级排序依据" packages/server/src/memory/index.ts` 零命中（exit 1）                                                                  |
| 5   | A3                    | `.env.example` grep `已作废` 零命中（exit 1）；`MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE` 仍在（`:64`/`:65`）且仍被 `memory/index.ts:186-187` 消费 |
| 6   | B1                    | `memories.ts` / `memories.test.ts` 已删；**代码面** grep `repository/memories` 与 `from './memories` 零命中。⚠️ 全仓口径不可满足，见 §三       |
| 7   | B2 行为等价           | 差分核验通过，方法见 §二                                                                                                                       |
| 8   | B3                    | `initRepository` 无 `setMemoriesDb`；`repo.memories` 命名空间不存在；`setMemoriesDb` / `memoriesRepo` 全仓代码面零命中                         |
| 9   | A5                    | `chunks.ts` 内 grep `searchMemoriesHybrid` 零命中；`memories.ts` 相关指向全部改写（含票外 2 处，见 §四）                                       |
| 10  | MemoryRow             | 全仓代码面零命中                                                                                                                               |
| 11  | lint + 测试           | `node scripts/lint.js` 三包通过；`npx vitest run` 112 文件 / 2233 用例全绿                                                                     |
| 12  | 提交纪律              | 提交带 `catstudy [uuid]`；提交信息内行号已 grep 复核                                                                                           |

**A1 修法执行记录**：按票面警告**没有**在源码里写那个四字符转义形式；改用**字节级替换**（读 Buffer → 把 `0x00` 换成反斜杠 + `0` 两个字节 → 写回），保证落盘的就是源码转义、不会再长出真字节。改后 13 个改动文件全部扫过 NUL，均为 0。

### 二、B2 差分核验（本票最关键一条的做法）

临时差分测试在**同一进程、同一夹具**上跑「改动前的 SQL」（逐字抄自 `git show HEAD:packages/server/src/db/repository/memories.ts` 的 `searchMemoriesByVector` + `knowledge.ts` 的字段映射）与「新实现」，11 组参数（`topK ∈ {0,1,2,3,10}` × `maxDistance ∈ {0, 0.1, 0.35, 0.5, 1.5, 缺省}`，含缺省即 0.35 的默认语义），夹具含 3 条正常行 + 1 条 `embedding IS NULL` 行。判据 = `toEqual` 逐字段 + 结果字段集比对。**全组一致，零差异**。临时文件跑完即删（`git status` 已核无残留）。

### 三、票面两处**不可满足**的验收（未自行改判，请店长裁）

**缺陷 1（A2 验收自相矛盾）**：§四 第 3 条要求「全仓 grep `MEMORY_DEDUP` 零命中（含 `phase0.ts`）」，但 §二·A2 的定稿文案**本身**就含该字面量（票内 `:75`），而店长在同一处标注「实施者不要自由发挥判分基准的措辞」。两条要求互斥：照抄定稿 ⇒ 该 grep 必不零命中；想让 grep 归零 ⇒ 必须改写定稿。
全仓实测命中 8 行 / 6 处：本票自身 4 处（`:62` `:65` `:75` `:83`）、`AGENTS.md:47`（「别再找 `MEMORY_DEDUP_*` 那类阈值旋钮」——刻意留痕）、`docs/plans/memory-flywheel.md:185,187`（作废留痕）、`docs/sessions/*` 2 处（历史会话总结）、**`README.md:223-224`（真残留，见 §五）**。
→ 本轮按**「定稿优先」**执行（票面明写「照抄」），本条按**「生产代码 + `.env.example` 零命中」**交付。

**缺陷 2（B1 验收全仓口径不可满足）**：§四 第 6 条要求全仓 grep `repository/memories` 零命中，但**本票正文自己**（`:119` `:131` 等多处）必须写出该路径才能描述病灶 ⇒ 全仓口径天然不可满足。按**代码面（`packages/` + `scripts/`）零命中**交付；连新写的 3 处留痕注释也已刻意改写成不含该路径字面量。

> 两条同型：**验收写成了「全仓 / 全字面量」口径，而票面自己就是该字面量的合法载体**。这是「验证面必须与被判面同面」的镜像——口径写宽了，就永远为假。

### 四、票外补的 3 处指向（均属 A5 同病灶、零行为变更，请审查重点看是否越界）

| 位置                                       | 原文                                              | 改后                                                                       | 理由                                                                                                   |
| ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `db/repository/flowStates.ts:12`           | 「参照 `memories.ts:335-367` 的本地批事务范式」   | 「参照 `chunks.ts` 的 `deleteChunksByDocPaths` / `deleteStaleChunkRows`…」 | 指向**已删文件**，且那组行号在 173 行的原文件里本就不存在（改动前即已失真）                            |
| `db/repository/chunks.ts:284`              | 「`searchMemoriesByVector` 同为『先召回后过滤』」 | 「`knowledge.ts` 的 `searchKnowledgeByVector` 同为…」                      | B 组把该函数内联后，此处会**二次**变成死指向——与 A5 治的是同一个病，但 A5 只点名了 `:338` / `:371-375` |
| `db/repository/index.ts:74`、`types.ts:72` | `MemoryRow`                                       | 删除                                                                       | §二·B2 已裁                                                                                            |

### 五、README 残留清理（`50aa11b` 审查 ⚠️ 后并入）

背景：`50aa11b` 审查（吐槽猫）裁决 `README.md:222-224` **并入本票**——与 A3 治的 `.env.example` 完全同型（死旋钮当活参数展示），「票面 A3 的验收语义覆盖不到 README，等于 A3 只治了半边」。同一裁决**明示不并入** `:218` `REDIS_URL`（存疑但无票内证据）——**未动**。

实施时按同一判据（「票 §一 已记 → 同批清」/「本票改动使其变死指向」）**自查**出另三处同病灶，一并申报：

| README 位置   | 原文                                          | 改后                                                    | 判据                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:222`–`:224` | 三行环境变量表行                              | **删除**                                                | 审查裁决并入；`MEMORY_HYBRID_ENABLED` 票 §一 已记「已删」                                                                                                                                                                                       |
| `:87`         | 仓储层（…`messages/memories/verdicts`…）      | `memories/` → `chunks/knowledge/`                       | **本票 B2 删掉 `repository/memories.ts` 使其变成死指向**——B3「照单核对，勿遗漏」的漏网；`repository/` 实测无 `memories.ts`                                                                                                                      |
| `:110`        | `# 记忆存储 + 检索 + 去重（向量 + 混合检索）` | `# 切片检索 + 上下文构建（向量 + 关键词 RRF 混合检索）` | 三个词里两个已死：「存储」「去重」随旧写口退役（实测 `memory/index.ts` **零写库调用**，导出仅 `retrieveMemoryContext` / `buildKnowledgeContext`），「混合检索」是活的。**新措辞镜像该模块自己的文件头**（`memory/index.ts:1-13`），非实施者新写 |
| `:112`        | `filter.ts   # 记忆筛选 deny-list`            | **删除**                                                | 文件**实测不存在**（票 §一 已记「文件已不存在」）——与审查者对 `:222` 采用的判据同源                                                                                                                                                             |

**范围声明**：`:87` / `:110` / `:112` 三处**不在审查裁决项内**，是实施自查发现并申报的 A5 同病灶（死指向），零行为变更、共 3 行。若判越界，逐行可 revert，不影响已裁的 `:222`–`:224`。
**未动**：`:218` `REDIS_URL`（审查明示无票内证据，不并入）。

> **行尾说明（防误判为全文件改动）**：README 工作副本原有的 CRLF 来自 `core.autocrlf=true`（本仓无 `.gitattributes`）的**检出展开**——仓库里的 blob 实测是 **LF**（`git show HEAD:README.md` 的 CR 计数 = 0，全仓 `.md` 同）。本次编辑后工作副本变 LF，**提交内容不受影响**（autocrlf 在 `add` 时本就会归一化，`git diff` 只有上述 4 处）。

### 六、本轮新发现、**未动**——请裁归属（不阻塞本票）

核 `:87`/`:110`/`:112` 时顺带扫了同一棵树里的 Redis 面，实测两条死残留，**均未动**：

| 位置            | 现状                                           | 实测证据                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md:86`  | `redis.ts    # Redis 客户端（可选，失败降级）` | **文件不存在**：`packages/server/src/db/` 实测只有 `index.ts` / `index.test.ts` / `repository/`。全仓 `packages/` + `scripts/` grep `-i redis` **仅 4 处命中，且无一行 Redis 客户端代码**——`connectors/socketio.ts:633` 一句注释、`handoff-gen.mjs:728-731` 的关键字启发式 |
| `README.md:218` | `REDIS_URL`（默认 `redis://localhost:6379`）   | **零消费方**：全仓非测试代码 grep `REDIS_URL` **零命中**；`.env.example` 里也没有它                                                                                                                                                                                        |

**未动理由（是裁决，不是遗漏）**：

- `:218` 审查已在 `50aa11b` 结论里**明示不并入**（「存疑但无票内证据」）。本轮补上了证据，但**不自行反转审查的显式排除**——那会把「申报待裁」变成「先斩后奏」。
- `:86` 按审查对 `:222` 采用的判据（「票 §一 已记 → 同批清」）**不成立**：票 §一 未记 `redis.ts`；它也不属「本票改动使其变死指向」（与 `:87` 不同）。
- 两条都落在店长 §三 边界「不做全量票辛注释分诊」的外沿；且 README 的**整体去留**你此前已定调属独立决策。

**建议**：并入 R1 票（R1 本就围绕检索写埋点，README 的 memory / retrieval 描述会再动一次）或另立 docs 小票。**不阻塞本票**——若判「就停在这」，本票照常收口。

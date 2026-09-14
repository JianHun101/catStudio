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

**修法**：改写该条的问题与期望答案，指向现行机制（MD 是唯一写入口，`chunks` 三表索引，无去重三段式）；或整条删除。**由店长定稿后交实施者照抄**——判分基准的措辞不宜由实施者自由发挥。

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

**修法**：改成实话（「台账列；当前不参与排序，排序由片级位次决定」）。

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

| 原内容                                                                         | 去哪                                                                 | 理由                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bigramTokenize` / `buildFtsQuery` / `KEYWORD_STOPWORDS` / `FTS_SPECIAL_CHARS` | **新建** `db/repository/fts.ts`                                      | FTS5 切分与查询构造是一个独立关注点；**无 db 依赖 ⇒ 无 `setRepoDb`、无 repository/index 接线**           |
| `HYBRID_CHANNEL_TOP_N` / `RRF_K`                                               | 移入 `chunks.ts`                                                     | 唯一消费者就是它，常量跟着用法走                                                                         |
| `searchMemoriesByVector` / `MemorySearchResult`                                | **并入 `knowledge.ts`**，用 `knowledge.ts` 自己的 db 句柄            | 白名单只剩 `knowledge`，参数化表名已无存在理由                                                           |
| `SEARCHABLE_TABLES` 白名单 + `table` 参数 + `TypeError` 分支                   | **整个删除**                                                         | **「参数来源永不放宽到外部输入」的安全边界，在只有一个值之后退化为死代码**。删掉即消灭一条永不触发的路径 |
| `MemorySearchResult` 类型                                                      | **删除**，与既有 `KnowledgeSearchResult`（`knowledge.ts:21-28`）合一 | 两者形状本就相同——`knowledge.ts:42-48` 现在做的正是**逐字段搬运**。合并后这层映射整个消失                |
| `MemoryRow` 类型（`repository/index.ts:74` 导出）                              | 核查后清理（若无消费方）                                             | 随 memories 语义一起退场                                                                                 |

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
3. **A2**：全仓（含 `phase0.ts`）grep `MEMORY_DEDUP` **零命中**。
4. **A3**：`.env.example` grep `已作废` 零命中；`MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE` **仍在**且仍被 `memory/index.ts:186-187` 消费。
5. **B1**：`db/repository/memories.ts` 与 `memories.test.ts` **文件不存在**；全仓 grep `repository/memories` 与 `from './memories` **零命中**。
6. **B2 行为等价（本票最关键的一条）**：知识库检索回归——`search_knowledge` 命中结果与改动前**逐字段一致**（`id`/`content`/`source`/`created_at`/`distance`，含 `maxDistance=0.35` 默认值语义与 topK 排序）。
7. **B3**：`repository/index.ts` 的 `initRepository` 不再引用 `setMemoriesDb`；`repo.memories` 命名空间不存在（若外部无消费方）。
8. **A5**：`chunks.ts` 内 grep `searchMemoriesHybrid` **零命中**；`memories.ts` 相关指向全部改写。
9. 全套 `npx vitest run` 绿 + `node scripts/lint.js` 通过。
10. 提交 `catstudy [uuid]`，提交前 grep 复核行号（本仓纪律）。

## 五、与 R1 的关系

**C1 是 R1 的前置，串行落，不并行。** 两票改同一批文件：

| 文件                                      | C1 动                               | R1 动                            | 冲突面                           |
| ----------------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------- |
| `db/repository/chunks.ts`                 | `:16` 导入 + `:338`/`:371-375` 注释 | `:396-407` 出口带通道身份        | 同文件，行不重叠但**同函数邻域** |
| `memory/index.ts`                         | `:273` NUL + `:67-68` 注释          | `:216-234` 采集 + `:90-110` 统计 | 同文件                           |
| `db/repository/knowledge.ts` / `index.ts` | 拆解                                | —                                | —                                |

并行必冲突。**C1 先合、R1 再开**——且 C1 先落正好达成用户要的「减少对我们设计的影响」：R1 实施者拿到的 `chunks.ts` 不再有指向死函数的注释。

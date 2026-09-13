---
type: plan
date: 2026-09-13
status: 已收口
evidence:
  - kind: commit
    ref: ff97e01
  - kind: commit
    ref: 98fe0cc
  - kind: commit
    ref: 6d19f1f
  - kind: commit
    ref: c02764bd
  - kind: commit
    ref: db2216e
  - kind: commit
    ref: 854f766
  - kind: commit
    ref: bf11cbd
  - kind: commit
    ref: 8efab3d
---

# 经验记忆库（memory-flywheel）落地规格（定稿）

> 状态：**已收口**（2026-09-13）。段三主链真机通电，14 张票全部收口。
> 写者：店长（架构师）· 审查：吐槽猫（每票独立实核，零返工为主）· 裁定：用户。
> 本文件是 `docs/run/memory-flywheel/` 收口后的**结论上浮面**；票单与地图已按
> `docs/run/README.md`「活收口即清」删除，**过程留痕在 git 历史**（见 §8）。

## 1. 一句话

决策/教训先结晶成人可观测的 MD（**git 是唯一真相源**），扫描器把 MD 切成人可读的
切片、向量化入索引（**索引是派生投影，可整份删除重建**），猫开工前按需检索注入
system prompt；检索命中与现实矛盾时走既有审查链改 MD、重扫。

**不做**：自动索引对话原话层（判词：未经辨明真伪的原话，检索到也无意义）；摘要 /
情境化改写层（不立项）；UI 面板；定时任务；索引侧独立写口。

## 2. 主链形态（七段，逐段钉死）

### 2.1 源与准入

| 项          | 契约                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| 白名单前缀  | `docs/adr/` `docs/lessons/` `docs/plans/`（`scan.mjs` `SCAN_PREFIXES`，**必须带尾斜杠**）                 |
| 额外门槛    | `docs/plans/` **仅收** `status ∈ {已定稿, 已收口}`（`PLAN_STATUS_CRYSTALLIZED`）；其余态 fail-closed 跳过 |
| 元数据载体  | **YAML frontmatter**（`type` / `date` / `status` / `evidence` / `supersedes`）                            |
| 判定分工    | 机器**只校存在性**，语义归审查链；ADR 侧附加规则落 `docs/adr/README.md` 门牌                              |
| `date` 口径 | **写入即冻结、扫描器只补缺**（不随每次提交漂移）                                                          |
| 存量策略    | 存量不收；规范化前置（位置一次性归位 + 门牌补齐；内容只复核在飞件与近期件），**过闸准入**                 |

### 2.2 切片（`packages/server/src/memory/flywheel/segment.ts`）

- 上限 `MAX_TEXT_LENGTH = 450`；**块不放大**。
- 三级确定性回退：句边界 → 行边界 → 字符硬切。**不存在不能切的内容**——「不切并记例外」已作废，例外改为「切了并标记」。
- 每块带**标题链（面包屑）+ 段首句锚**（确定性上下文层；模型增强层不立项）。
- frontmatter 剥离后再切。
- 表格：**无条件**转「列名：值」句子（`table-transcribe.ts`），不做条件触发。

### 2.3 扫描器（`scripts/flywheel/scan.mjs`）

- 入口：`pnpm flywheel:scan` / `pnpm flywheel:reindex` / server 启动 spawn 一次（**不做定时任务**）。
- 增量判据 = **blob SHA**（`git hash-object`），**不用 mtime**（checkout / 切分支会污染 mtime）。
- 扫描器**边检边修**：blob SHA 一变即重嵌并删旧代 ⇒ 不存在「检测到了但没修」的中间态。
- 脏件 fail-closed 跳过；孤儿行**物理删**（用户裁）。

### 2.4 嵌入（独立 sidecar 进程）

- 模型 `Xenova/bge-small-zh-v1.5` / 512 维，跑在 `scripts/flywheel/embed-server.mjs`，**不进主进程内存**，只监听 `127.0.0.1`。
- 生命周期归 `memory/embedding.ts`（`startEmbeddingSidecar` / `stopEmbeddingSidecar`），随 server 启停。
- 客户端 `memory/embedding-client.ts`：探活 30s / 请求 10s / 重探 30s；**失败带显式 reason**，不静默返回空数组；请求级失败即 `dropSidecar`。
- sidecar **自带 stdin 关断自检**：父进程无论软杀硬杀，管道闭合 ⇒ 子进程自退（e2e B10 真机实测 **124ms** 自退）。⚠️ 该实测同时**打掉了**旧判据「非 Windows 会留孤儿 sidecar」。
- 端口经 stdout 握手回报；`EMBED_SIDECAR_PORT`（默认 `0` = OS 分配）**只管主 server**；**扫描器侧恒为动态端口**（隔离，避免首次扫描抢端口）。

### 2.5 索引表（`packages/server/src/db/repository/chunks.ts`）

- 新建 `chunks` + `chunk_vectors`（sqlite-vec `vec0` float[512]）+ `chunks_fts`；**不改 `memories`**。
- 列含 `valid_from` / `valid_to` / `superseded_by` / `origin_id`（blob SHA）/ `content_hash`（唯一索引）；`evidence` 走 JSON 列。
- **表内不存任何扫描时间戳** —— 这是「删表 → 重扫 → 逐行等价」成立的前提。
- 查询体**必带** `status IS NULL OR status NOT IN ('superseded','deprecated')`（**NULL 放行**）。
- 节级 `status` 不回写 MD（管到节 = chunk 行上的列，零额外机制）。

### 2.6 检索（`searchChunksHybrid`）

- 混合召回：向量 + 关键词（`chunks_fts`）经 **RRF k=60** 融合——**逐项对齐**既有 `memories.ts` 的 `searchMemoriesHybrid` 形态。
- **检索质量埋点已落地**：阈值前近邻池留痕（`candidateChunks` / `topCandidates` / `droppedByThreshold`），职责 = 让「空手而归」与「被阈值挡掉」可分辨，**不是指标面板**。

### 2.7 注入与配额（`packages/server/src/memory/index.ts`）

- 预算**硬上限** `MEMORY_CONTEXT_TOKEN_BUDGET`（默认 8000）。
- **按节截断，不按块截断**（守「小块检索、整节返回」的安全网）。
- 最相关条目**首尾各半**（Lost in the Middle, arXiv:2307.03172）。
- `MEMORY_TOP_K` 沿用现值；**退休机制先不做**。

### 2.8 旧写口退役

`saveMessageMemory` **退役**（生产代码零命中），存量 **198 行物理删**（用户裁：「退 + 删」）。
退役前快照 `cat-study-pre-retire.db{,-shm,-wal}` 已于 2026-09-12 按用户裁决**删除**
（198 行 + 110 FTS，**无第二份拷贝、不可恢复**；三面复核零命中）。退役脚本
`scripts/flywheel/retire-message-memory.mjs` 保留。

## 3. 关键裁决（不可翻）

| #   | 裁决                                                                                                         | 归属                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | **MD 是唯一真相源**，向量表只是索引；AGENTS.md 是框架语义载体、不是知识载体                                  | 店长（Decisions 1）                   |
| 2   | **只索引结晶后的 MD，不索引对话原话**（`memories` 实时嵌入层退役）                                           | 店长（Q1）                            |
| 3   | **捕获通道的「手」落在文件系统，不落在数据库**——索引侧永远无独立写口                                         | 用户（Q1′）                           |
| 4   | **存量不收 / 规范化前置 / 过闸准入**；规范化按 C 分级                                                        | 用户（Q2 / Q2-b）                     |
| 5   | **收录标准**：三类枚举（决策/教训/方法）+ 每条必须带证据；禁止清单（未定方案 / brainstorm / WIP / 模型发挥） | 店长（平移 clowder F102，管线不搬）   |
| 6   | **演化原则**：追加不重写；软删除不物理删；状态字段**必须落在索引侧并参与查询期过滤**                         | 店长                                  |
| 7   | `docs/lessons/` 立为第三格（装无取舍的经验，与 ADR 同权）                                                    | 用户                                  |
| 8   | 切片 **450** + 三级回退 + 面包屑；表格转写**无条件**                                                         | 用户 + 店长                           |
| 9   | 白名单三前缀 + 独立扫描器 + **不做定时任务** + blob SHA 增量 + 孤儿**物理删**                                | 用户 + 店长（Q5）                     |
| 10  | 新建三表、**不改 `memories`**；表内不存扫描时间戳                                                            | 店长（Q6）                            |
| 11  | 注入预算硬上限 + 按节截断 + 首尾各半；**退休机制先不做**                                                     | 店长（Q7）                            |
| 12  | **Q4 冲突修正不建新机制**：撞「与现实矛盾」走既有审查链（提审查 → 改 MD → 重扫）                             | 用户 + 店长                           |
| 13  | 嵌入**独立 sidecar**（Node 子进程，不引 Python）；降级面 = 明确失败 + 显式 reason，**不退回进程内**          | 用户（形态）+ 店长（ADR 0007 检查单） |
| 14  | `bge-m3` **暂不换型**，降级为条件触发（触发面见 git 历史 map Decisions 28 三）；换型本身不占票（改配置）     | 用户                                  |
| 15  | `docs/plans/**` 白名单**已通电**（补 frontmatter）；`docs/lessons/**` 零卡片 = **显式边界**，非漏网          | 用户（「plans补票吧」）               |
| 16  | 嵌入**超时与批大小解耦**（走多批 + 附带重试）                                                                | 用户（「派活」）                      |

## 4. 票单全表（14 张，全部收口）

| 票      | 内容                                              | 交付 / 携带者                                             | 状态                                  |
| ------- | ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| 乙      | 审查兜底交付物闸 + `docs/run/**` 免审白名单       | `3b62dbe` + `8c20dc3`                                     | ✅ 已收口                             |
| 丙      | 切片器 + 表格转写（纯函数不接线）                 | `c953dd4` → `4552237`，携带者 `20f9c93`                   | ✅ 已收口                             |
| 丁      | 嵌入独立 sidecar                                  | `ee7e287`（ff，携带者同 sha）                             | ✅ 已收口                             |
| 戊      | 段一回填：7 份近期 ADR 判 status + 填 evidence    | `edb1f2d`，携带者 `1395a44`                               | ✅ 已收口                             |
| 己      | 索引表 schema（Q6 全落）                          | `f493979` / PR **#51** carrier `8efab3d`                  | ✅ 已收口                             |
| 庚      | 扫描器（Q5 全落 + 孤儿物理删）                    | `4d3e5a4` / PR **#53** carrier `bf11cbd`                  | ✅ 已收口                             |
| 辛      | 检索接线（W 组 + Q7 全落）                        | `a0624c6` + 返工 `14e1706` / PR **#54** carrier `db2216e` | ✅ 已收口                             |
| 壬      | 旧写口退役（用户裁「退 + 删」）                   | `d0e3fac` / PR **#52** carrier `854f766`                  | ✅ 已收口                             |
| 癸      | 段一归位（门牌形态 + 值域）                       | `9df86fd` / PR **#51**                                    | ✅ 已收口                             |
| 卯      | `docs/plans/**` 补 YAML frontmatter               | `dd85c97` / PR **#59** carrier `836e1bd`                  | ✅ 已收口                             |
| 辰      | sidecar 端口可观测 + 扫描器端口隔离               | `38bb30e` / PR **#60** carrier `c02764bd`                 | ✅ 已收口（**C6 后半未通电**，见 §5） |
| 午      | 嵌入超时与批大小解耦                              | PR **#61** carrier `6d19f1f`                              | ✅ 已收口                             |
| 巳      | 关停链可观测性 + sidecar 回收正确性（**机制层**） | `9243a7b` + 返工 `ed5f143` / PR **#63** carrier `98fe0cc` | ✅ 已收口（D1/D2/D3 真机三验全过）    |
| 子 / 丑 | A2A 配额拦截静默面 + 单位归一（**机制层**）       | `b886399` / PR **#55**；`b6c9cdd` / PR **#56**            | ✅ 已收口                             |

票**甲**（换 `bge-m3`）关闭为「暂不换型」，见 §3 #14。

## 5. 真机验收：已通电 / 未通电（如实分列）

**已通电（日志原文取证，非转述）**

- 启用链路：`MEMORY_ENABLED=true` ⇒ sidecar 自起（`嵌入 sidecar 就绪 · port:3210`）+ 真文本 512 维 + 停 sidecar 降级 + 自愈。
- 注入链路：`记忆上下文已注入` 带 `reason:"ok"` + `candidateChunks` + `memoryChars`（4017~5059 量级），真机对话即走此链。
- 增量扫描：`docs/plans/**` 补 frontmatter 后**真扫进去**（`chunks` 128 → 296，plans 贡献 168 = 14+63+35+56，**非 `--reindex` 硬灌**）。
- 关停链路：按钮重启窗口 **2.16 秒**走完优雅关停——`收到关停请求（文件握手）` → `shutting down...` → `嵌入 sidecar 关停 · port:3210 · killedChild:true`，**未走兜底强杀**；重启后 `.shutdown-request` / `.restart-request` 均不在盘上（读方 + 写方双向清理都真跑到）。

**未通电（挂账，带可证伪触发条件）**

| 项                                                                               | 触发条件（判据已改口径，见下）                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **C6 后半**：扫描器侧 sidecar 端口隔离（`scan.mjs` 置 `EMBED_SIDECAR_PORT='0'`） | server 运行时跑一次真实增量扫描 ⇒ `errors:0` **且**全日志无真实 `EADDRINUSE`；若报 `EADDRINUSE` 或整轮 `embed-failed` ⇒ 出返工票 |
| **主库形态**：`pnpm start`（`cat-study.db`）未覆盖 B8 全链                       | sidecar 链路 dev / 生产同一份代码，但主库形态下次重启时顺手核                                                                    |

> **C6 后半判据改口径（用户 2026-09-13 裁定）**：原判据「扫描器 sidecar 落在**非 3210** 端口」**不可直读** —— `嵌入 sidecar 就绪` 这行只由 `startEmbeddingSidecar()`（`embedding.ts`）打，而扫描器是**直接 `new EmbeddingClient()`**、从不经过该函数（全日志该行全部来自主 server）。为一条诊断日志改生产代码不值，故**作废该观测面**，改用上表的**反向可证伪**判据。
>
> **现状**：通道①（server 启动扫描）**已有实测** —— `20:33:45 inserted:168 skipped:14 errors:0`，而同期主 server 正占着 3210；若不隔离，这 168 片必因 `EADDRINUSE` 一片也写不进去（反向证明，判据是硬的）。通道②（手动 `pnpm flywheel:scan`）**尚未在 server 运行时跑过** —— 两通道同过 `scan.mjs` `main()`，但**未实测**，不写成「已通电」。

## 6. 已知局限与挂账（不阻塞本期）

- **检索侧算法未定**：`query-rewrite.ts` 双通道（对话记忆链）与 `searchChunksHybrid`（知识链）两条链的检索侧关系本图未定；用户提「可放到后续需求」——**待裁**。
- **增长控制量级参数**未知：文档源进来后条目量级未知，配额 / 退休阈值待数据。
- **P3 · `bad-status` 可重试**：响应级维度不一致被归入可重试原因集 ⇒ 净效果 = 延迟翻倍、零正确性损害。触发条件：真机出现**成对** `bad-status` 重试且 detail 含「返回维度…不一致」⇒ 收窄分支。
- **P3 · `REQUEST_BATCH_SIZE` 16 vs 8**：真机无差，取 16。触发条件：切批后仍再现 `request-timeout` ⇒ 先下调到 8。
- **P3 · 降级处理不对称**：HTTP 非 200 走 `dropSidecar`，JSON 解析失败只 `failAll`。方向安全，留观察。
- **日志夹具 id 判据（排障纪律）**：测试与生产 server 写**同一个** `cat-study.log`，行内不带来源标识 ⇒ 读日志下结论前**先认夹具 id**（`session-1` / `agent-impl` / `stuck-1` / `bbbbbbb` 只存在于测试）。已两次把测试噪声误读成生产事故。建议（未立票）：日志行加 `pid` / `env`。
- **行号引用纪律**：在飞文档引源码位置**只写符号名**，或带版本号；票收口时回校票面行号。同族错在本 run 复发三种（写错 / 符号名与行号不配对 / 定稿后被本票自己的实施改动而漂移）——**根因是复核方式不校验配对**，一律 `grep -n <符号名>` 取行号。

## 7. 环境变量与命令（操作面）

```bash
pnpm flywheel:scan       # 增量扫描（blob SHA 判据，边检边修）
pnpm flywheel:reindex    # 全量重建索引（删表 → 重扫 → 逐行等价）
```

- `MEMORY_ENABLED`（本机 `true`）/ `MEMORY_EMBEDDING_MODEL` / `MEMORY_CONTEXT_TOKEN_BUDGET`（默认 8000）/ `MEMORY_TOP_K` / `MEMORY_MAX_DISTANCE`。
- `EMBED_SIDECAR_PORT`（本机 `3210`，默认 `0` = OS 分配）——**只管主 server**；扫描器侧恒动态。

> **已作废，勿拧**（旧写口退役 / §2.8）：`MEMORY_DEDUP_ENABLED` / `MEMORY_DEDUP_THRESHOLD`
> / `MEMORY_UPDATE_THRESHOLD` / `MEMORY_FILTER_ENABLED` / `MEMORY_MIN_CONTENT_LENGTH` ——
> 生产代码**零消费**（`MEMORY_DEDUP_THRESHOLD` 仅剩 `eval/phase0.ts` 一处文档字符串）。
> 新链走**身份键幂等 upsert**（`chunks.content_hash` 唯一索引），不设阈值去重；
> 入库筛选随 `saveMessageMemory` 一并退役（`memory/filter.ts` 已于 2026-09-13 物理删除，含其测试）。
> 五项仍物理躺在 `.env.example`，已同批标注作废 —— 设置它们**零效果**。

## 8. 过程留痕（票单已清，留痕在 git 历史）

`docs/run/memory-flywheel/`（`map.md` 59 条 Decisions + `tickets.md` 14 张票面）已于
2026-09-13 按 `docs/run/README.md`「活收口即清」删除，**结论 = 本文件**。

要看取舍过程（「为什么否掉 A 选 B」）：

```bash
git show ff97e01:docs/run/memory-flywheel/map.md      # 59 条 Decisions 全文
git show ff97e01:docs/run/memory-flywheel/tickets.md  # 14 张票面（契约 / 验收 / 收口留痕）
```

落盘时间线：`bd3fc98` → `49363e3` → `af41313` → `ff97e01`（纯 `docs/run/**` 免审提交，
`REVIEW_EXEMPT_PREFIXES = ['docs/run/']`）。

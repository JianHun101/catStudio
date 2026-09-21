# 行锚族体检：`scripts/flywheel/scan.mjs` 被引行号全量复核

<!-- 来源: G5 收口轮（PR #146，dev 3241573）店长实核 —— 起因是 ee54fbc 给 scan.mjs +3 行断了 1 处锚，顺势全量实测发现陈旧面远大于此 -->
<!-- 状态: 待派（店长 2026-09-20 立票 · 未派活） -->

## 一、立票理由

`ee54fbc`（票 A status 值域统一）给 `scripts/flywheel/scan.mjs` 加了 3 行，断掉 1 处文档锚
（`retired-docs-tombstone/tickets.md:57` 引的 `:548` 实际漂到 `:551`）。

**只修这 1 处是错的**：同一批实测发现**另外 7 处早已陈旧**，与 `ee54fbc` 无关。
只补断掉的那处，会让剩下 7 处陈旧锚更没道理——**要么全做，要么不做**，故单开一张票一次性做完。

## 二、实测读数（2026-09-20，dev `3241573`）

复核命令（逐条取目标行原文，不靠推导）：

```bash
for L in <行号>; do printf "%-5s %s\n" ":$L" "$(sed -n "${L}p" scripts/flywheel/scan.mjs | cut -c1-95)"; done
git grep -n "function cleanGitEnv\|function classifyDocument\|EMBED_SIDECAR_PORT" scripts/flywheel/scan.mjs
```

`scan.mjs` 当前 **758 行**。逐条对表：

| 引用处                                                                                                                                   | 引的行               | 期望内容                        | 实测 `:行` 原文                                                                     | 真值                         | 判定                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `precommit-scope/report.md:476` `:484`                                                                                                   | `scan.mjs:48`        | 白名单注释                      | `import path from 'node:path'`                                                      | `:53`（注释）/ `:60`（常量） | ❌ 陈旧                                                                        |
| `retired-docs-tombstone/run-inventory.md:167`                                                                                            | `scan.mjs:62`        | `PLAN_STATUS_CRYSTALLIZED` 定义 | `/** 扩展名白名单（契约 ①） */`                                                     | `:72`                        | ❌ 陈旧                                                                        |
| `retired-docs-tombstone/tickets.md:13` `:27`                                                                                             | `scan.mjs:230`       | `classifyDocument`              | `while (i < lines.length) {`                                                        | `:258`                       | ❌ 陈旧（偏 +28）                                                              |
| `run-inventory.md:56` `:167` · `docs-run-status-gate/tickets.md:72`                                                                      | `scan.mjs:243`       | 准入闸                          | `}`                                                                                 | `:271`                       | ❌ 陈旧（偏 +28）                                                              |
| `test-git-env-pollution/tickets.md:19`                                                                                                   | `scan.mjs:310`       | `cleanGitEnv()` 定义处          | `}`                                                                                 | `:405`                       | ❌ 陈旧（偏 **+95**）                                                          |
| `test-git-env-pollution/tickets.md:43`                                                                                                   | `scan.mjs:313-318`   | `cleanGitEnv` 体（6 项变体）    | `:313` 为空行                                                                       | `:405` 起                    | ❌ 陈旧                                                                        |
| `retired-docs-tombstone/tickets.md:57`                                                                                                   | `scan.mjs:548`       | `deleteStaleChunkRows` 调用     | `}`                                                                                 | `:551`                       | ❌ 陈旧（偏 +3，**本票起因**）                                                 |
| `flaky-precommit/fix-report.md:34` · `tickets.md:99`                                                                                     | `scan.mjs:575`       | 强制 `EMBED_SIDECAR_PORT='0'`   | `report.orphansDeleted += …`                                                        | `:711`                       | ❌ 陈旧（偏 **+136**）                                                         |
| `docs-run-status-gate/tickets.md:24`                                                                                                     | `scan.mjs:72` `:271` | 常量 + 闸                       | 逐条对得上                                                                          | —                            | ✅ 准                                                                          |
| `docs-run-status-gate/tickets.md:24`                                                                                                     | `scan.mjs:271`       | fail-closed 准入闸              | `if (relPath.startsWith('docs/plans/') && !PLAN_STATUS_CRYSTALLIZED.has(status)) {` | —                            | ✅ 准                                                                          |
| `docs-run-status-gate/tickets.md:72`                                                                                                     | `scan.mjs:265`       | `evidence` 判据                 | `const evidence = fm.data.evidence`                                                 | —                            | ✅ 准                                                                          |
| `adr/0006-vector-memory-retrieval.md:18`                                                                                                 | `scan.mjs:60`        | 白名单                          | `export const SCAN_PREFIXES = ['docs/adr/', 'docs/lessons/', 'docs/plans/']`        | —                            | ✅ 准                                                                          |
| `R6-diag-inventory.md:88` `:161`                                                                                                         | `scan.mjs:488`       | 跨包「不改」点                  | `const retired = RETIRED_STATUSES.has(cls.meta.status ?? '')`                       | —                            | ⚠️ **待逐条核**：该行是墓碑分叉点，「跨包」理由与之是否同一处需读上下文再判    |
| `R9-retrieval-golden-dataset.md:17` · `T2-trace-observability.md:56` · `research-rag-eval.md:64` · `research-trace-observability.md:334` | `scan.mjs:53`        | 白名单                          | `:53` 是白名单**注释**行、常量在 `:60`                                              | —                            | ⚠️ 半准（引注释不算错，但与其余三处引 `:53` 指同一物、真值不同行，须统一口径） |

**净读数：12 条可判中 8 条陈旧、3 条准、1 条待判**。最大偏移 **+136 行**。

## 三、边界

- **只改指向行号，不改任何判据/实现**。这是文档侧修正票，**零 `packages/**`、零 `scripts/**` 代码改动**。
- **不动 `scan.mjs` 本身**（不为了「行号对上」去挪源码）。
- 不在本票内新增/删除任何 `scan.mjs` 引用；只把已存在的引用校准到真值。
- 真值一律按 **当时 dev 尖端**取，取法与 §二 命令一致（`sed -n` 取原文 + `git grep -n <符号名>` 取定义），**不许用推导**。

## 四、验收

1. 逐条：`sed -n "<引用行>p" scripts/flywheel/scan.mjs` 的内容与引用处**上下文语义相符**（表里每一行都要给读数，不许抽样）。
2. **反对照**：另取 3 处**已知正确**的引用（`docs-run-status-gate/tickets.md:24` 的 `:72`、`:265`、`:271`）复核，确认本票的判据**不会把已对的判成错的**（防「全量重写」造成的反向破坏）。
3. 全仓 `git grep -nE "scan\.mjs:[0-9]+" -- 'docs/**'` 输出与修后文件逐条对表，**无第九条漏网**。
4. 纯 `docs/**` ⇒ 免审面，但**仍走收口链**（`.push-gate` 改签 + PR），不直推。

## 五、决策留痕

- **2026-09-20 店长（立票，未派活）**：G5 收口轮实核立票。**只做体检不做顺手修**——G5 票面临界明写「行锚族体检已被认领单开小票」，在本票内擅自修会造出无授权 diff。
- **口径**：本票治的是「文档引用源码行号」这一族，**族边界按失效机制划**（引用面漂移），不按文件划——同族还包括 `session-closeout.ts` 的 14 处锚（已由 G5 返工轮修过一轮，`ee54fbc` 断的那处即属此族）。

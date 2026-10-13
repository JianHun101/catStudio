# scripts/eval —— 检索评估跑批脚本

五个跑批/诊断脚本，各自同名 `.test.js`。产物落 `docs/eval/`（索引见 `docs/eval/README.md`）。

## 跑之前的共性三条（不满足就是假读数）

1. **tsx**：脚本自己 bootstrap 拉 tsx（它在 `packages/server/node_modules`，**仓库根没有**）。
   找不到会以明确错误退出，不会静默降级。
2. **库与 .env 要显式指主仓库**：`env.ts` 只认**仓库根** `.env`，而 worktree 内的 `.env` 通常是空的；
   worktree 内也没有 `packages/server/data/` 下的库。⇒ 一律 `--env <主仓库>/.env
--db <主仓库>/packages/server/data/cat-study-dev.db`。三个读库脚本都以
   **`readonly + fileMustExist`** 打开库——「静默建一个空库跑出全零」在这条打开方式下物理不可达。
3. **嵌入 sidecar 走动态端口**：活 server 的 sidecar 钉在 `3210`，跑批继承该端口值会 `EADDRINUSE`
   ⇒ 静默降级成仅关键词通道 ⇒ 假读数。脚本用 `EMBED_SIDECAR_PORT=0` 取动态端口，跑完显式回收
   （只杀本进程 spawn 的实例）。**禁止假定 server 在跑。**

**输出通道约定**（全部脚本一致）：stdout 只出**一行结构化 JSON**（机器通道），人类可读汇总走
stderr——本仓 logger 写 stdout，混流会毁掉机器通道。全部支持 `--help`。

**运行期不碰 3200/5173**：这些脚本只读库、不启 server。

## 脚本

### `retrieval-baseline.mjs` —— 检索基线（R10）

黄金集变成**可复跑的数字**：recall + 阈值前命中率，real / constructed 两组各自出分（不合成总分）。
被测出口 = **全链最终注入节集**，从冻结改写出发（跳过改写器）。三条硬闸（canary 反对照 / 降级闸 /
空库闸）任一不过 ⇒ **拒出报告**。

- 跑法：`pnpm eval:retrieval:baseline`，或 `node scripts/eval/retrieval-baseline.mjs --env <主仓>/.env --db <主仓>/.../cat-study-dev.db`
- 产物：缺省 `docs/eval/retrieval-baseline-<date>.md` + **同基名 `.json`**（两份吃同一个 ctx 对象）
- 前置：tsx + 库 + sidecar + `docs/eval/retrieval-golden.json`
- 确定性：md 与 json 两份**各自**逐字节可复现（`--date` 可注入，日期不进数值面）

### `golden-check.mjs` —— 黄金集保鲜校验（R9 §五）

回答唯一的问题：「黄金集里每条 `expect` / `forbid` 锚点，**今天**还能不能解析到一块活片？」
解不出 ⇒ 报「标尺腐烂」并非零退出。**它不判条目对不对**（那是人的事），只判条目指的东西还在不在。
「活块」判据逐条复用扫描器链路（白名单 → `classifyDocument` 准入 → 切片锚点集，退役件走墓碑分支）。

- 跑法：`pnpm eval:golden:check`
- 产物：**不写盘**，stdout 一行 JSON
- 前置：tsx + 工作树语料（**不读库、不起 sidecar**）
- 退出码：`0` 全绿 / `1` 有腐烂 / `2` 用法或读盘错误（与「腐烂」分开，CI 才能分清该改语料还是改路径）

### `freeze-rewrite.mjs` —— 冻结改写器（R9 §六）

跑批要能复跑出同一个数，而链路上唯一不确定的一环是**查询改写**（LLM 调用）——本脚本把改写冻下来
写进黄金集。**改写文本只能从这里产出**：手写改写 = 把「冻结」偷换成「出题人想象」，且失效是静默的。

- 三档：`dry`（裸跑缺省，不调 LLM 不写盘）/ `--check`（调 LLM 验可复现，不写）/ `--write`（调 LLM 并写）。
  `--check` 与 `--write` **互斥**（exit 2）。缺省**刻意落只读一侧**（事故实证，非理论风险）。
- 跑法：`pnpm eval:golden:freeze`（裸跑体检）／`pnpm eval:golden:freeze --write`
- 产物：写 `docs/eval/retrieval-golden.json` 的 `rewritten` 段（**唯一合法出处**）
- 前置：`--check` / `--write` 要 tsx + LLM 可用；`dry` 不调 LLM
- `rewritten: []` 是**可用**的冻结形态（= 生产降级行为），但空清单非空即 exit 1——人工核完写进
  `meta.emptiesAcknowledged` 才收回 0。**脚本自己永不写这个键**（判定权与实施权分开）

### `rerank-offline-ab.mjs` —— 重排离线三臂对照（R13a）

同一 ≤3 节预算下，cross-encoder 重排能否拿回 topK 放大才够得着的锚点。**生产链路零改动**——
重排只发生在跑批侧，重建序须与链段自落的 `final` 流水逐行自证，不符即拒出报告。

- 跑法：`node scripts/eval/rerank-offline-ab.mjs [--quant-crosscheck]`（**无 pnpm 别名**）
- 产物：缺省 `docs/eval/rerank-offline-ab-<date>.md` + `.json`（**确定性面**）与
  `.latency.md` / `.latency.json`（**计时面**，不可复现、不进 sha 比对）。拆两个产物是刻意的：
  混在一起会让确定性硬闸恒不可满足，变成偶发假红的假门
- 前置：tsx + 库快照 + sidecar + 黄金集 + cross-encoder 模型
- 结论面：重排净增量为负，**已裁决不接入生产**（依据见 `docs/plans/memory-flywheel.md`）

### `retrieval-attribution-recheck.mjs` —— 未召回归因复核（T3）

把基线的「读数」变成「机制读数」：回答**为什么**没召回（差多少名、差多少分、哪个旋钮能救），
不产出新基线。含**承重反对照**（构造「阈值收紧 ⇒ 已注入的节当场掉出」的单变量实验）——对照不过即拒出报告。

- 跑法：`node scripts/eval/retrieval-attribution-recheck.mjs [--no-live-rewrite]`（**无 pnpm 别名**）
- 产物：缺省落 `docs/run/eval-system/T3-retrieval-optimization-diagnosis.md`（**不在 `docs/eval/`**）
- 前置：tsx + 库 + sidecar + 黄金集
- 只读保证：库 readonly 打开；`MEMORY_TOP_K` 扫描期临时改 env、**用完即还原**；
  另三个融合参数是模块私有常量，只能在重建层做反事实，报告里**明标**为重建读数

## 测试

`scripts/**/*.test.js` 由 vitest 的 scripts project 收录（`.e2e.mjs` 天然隔离，不收录）。
每个测试文件只测同名脚本：

| 测试                                    | 覆盖                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `retrieval-baseline.test.js`            | 打分/汇总纯函数、三条硬闸、产物渲染与 json 副产品形状                       |
| `golden-check.test.js`                  | schema 校验、活块判据三分支（含退役件墓碑）、**拿仓内真身黄金集过真切片器** |
| `freeze-rewrite.test.js`                | 三档语义与互斥、空改写确认位、退出码                                        |
| `rerank-offline-ab.test.js`             | 重建序自证、按节截断规则单真相源、产物渲染                                  |
| `retrieval-attribution-recheck.test.js` | 合并序重建、等价性自证、旋钮反事实口径                                      |

- 跑法：`node node_modules/vitest/vitest.mjs run`（**worktree 内 `pnpm test` 会被 junction 拒**，
  报 `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`；`--project` 过滤不认目录型 project）

## 相关

- 产物索引：`docs/eval/README.md`
- 检索链定稿规格：`docs/plans/memory-flywheel.md`

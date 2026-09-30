---
type: plan
date: 2026-09-30
status: closed
evidence:
  - kind: file
    ref: scripts/precommit-scope.mjs
  - kind: file
    ref: .husky/pre-commit
  - kind: file
    ref: packages/server/src/test-helpers.ts
  - kind: file
    ref: scripts/test-isolation-guard.test.js
---

# 提交口门禁按改动面收窄（precommit-scope）

> **定稿规格**（2026-09-30 写入）。源活：票 `precommit-scope`（PR #93）＋残余票（PR #96），均于 2026-09-16 收口。
> 本文是「提交口跑哪些测试」的**唯一成文定义**——检索语料里原先没有第二处能回答这个问题。

## 1. 一句话

提交口按**暂存区改动面**决定跑哪些 vitest project：纯文档跳过、单包只跑该包、契约层与测试基础设施跑全量、**无法归类一律 fail-closed 跑全量**。收窄的**硬前提**是缓存与日志路径按仓库根绝对化（见 §4）——不先做这层，两猫的测试仍写同一批**物理**文件，收窄是空转。

`pnpm test` 的**全量语义不动**：审查者与收口方的入口仍是全量，收窄只发生在提交口。

## 2. 判据（判定即优先级，逐行可测）

| 序  | 暂存区命中                                                                                                                                                                            | projects          | 理由                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| ①   | 全量触发：`vitest.config.ts` / `scripts/vitest.config.ts` / `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`；`packages/shared/**`；`.husky/**`；任意深度的 `tsconfig*.json` | **全量（4）**     | 契约层（三包都依赖）与测试基础设施本身                   |
| ②   | `packages/server/**` / `packages/web/**` / `scripts/**`                                                                                                                               | 本包              | 本包改动只影响本包测试                                   |
| ③   | `docs/adr/**` / `docs/lessons/**` / `docs/plans/**`                                                                                                                                   | `packages/server` | 记忆飞轮扫描白名单面（`scripts/flywheel/scan.mjs` 消费） |
| ④   | `docs/run/**` / `docs/sessions/**` / 其余 `*.md`                                                                                                                                      | **跳过测试**      | 在飞文档 / 纯文本，无测试消费者                          |
| ⑤   | **任何无法归类的路径**                                                                                                                                                                | **全量（4）**     | **fail-closed**                                          |

- 多行命中 ⇒ **取并集**；「全量」优先于并集。
- 路径一律先归一化为**仓根相对、正斜杠**再匹配。
- **`packages/**` 命中时追加 `scripts`**（`packages/server/README.md` 这类包内文档走「本包」而非「跳过」）：护栏脚本（`scripts/test-isolation-guard.test.js`）本身属 `scripts` project，而它最该拦的形态恰恰是「在 server 测试里顺手敲相对路径」——不追加的话，护栏在它最该在岗的位置上不在岗。追加 `scripts` 实测代价约 4.4s/次，相对 server 自身跑批可忽略。

## 3. 接口契约

```js
/**
 * @param {string[]} stagedPaths 仓根相对路径（正斜杠）
 * @returns {{ projects: string[], skip: boolean, reason: string }}
 * 契约：skip === true ⇒ projects 为空；skip === false ⇒ projects 非空。
 * projects 恒为 ['packages/shared','packages/server','packages/web','scripts'] 的
 * **子序列**（顺序确定——顺序不定则读数不可比；`scripts` 在末位，追加到数组末尾即保序）。
 */
export function resolveScopes(stagedPaths)
```

- **出口**：`skip` ⇒ `exit 0`（不启 vitest，日志打印裁决 + `reason`，供排障）；收窄 / 全量 ⇒ 起 vitest 并**原样透传退出码**。
- **用 `node <root>/node_modules/vitest/vitest.mjs` 而非 `npx vitest`**：避开 Windows `.cmd` wrapper。
- **异常一律 fail-closed**：git 读失败 / 解析异常 / 空列表 ⇒ 跑全量，**不跳过**。门禁脚本自身出错时若回退成「跳过」，等于开了一条**静默放行**路径——比多跑几分钟坏得多。
- `scope` 名与 `vitest --project` 认的 **project 名不同**，中间由一层映射消化（`vitest --project packages/server` 会报 `No projects matched the filter`）。映射层存在，但 `resolveScopes` 的返回形状不因此变化。

## 4. 缓存与日志路径：按仓库根绝对化（收窄的硬前提）

worktree 的 `node_modules` 是指向主仓库的 junction ⇒ **仓库内的相对路径 = 两棵树共用的同一个物理文件**。故下列路径一律改为**仓库根派生的 `os.tmpdir()` 绝对路径**（同一哈希键）：

| 路径                | 落点                                           | 不隔离的后果                                     |
| ------------------- | ---------------------------------------------- | ------------------------------------------------ |
| vitest `cacheDir`   | 根 `vitest.config.ts`                          | 两猫的测试缓存互踩                               |
| `RESTART_FILES_DIR` | 根 `vitest.config.ts`                          | 重启机制测试操纵运行时真实文件                   |
| `LOG_FILE`          | `packages/server` / `scripts` 两处 vitest 配置 | 两猫的测试日志落到主仓库同一物理文件（观感问题） |

- `LOG_FILE` **不得删该行**（`test:server` 的 cwd = `packages/server`、不加载根配置，删了就回落到包内）——**只改值**。
- `logger.test.ts` 里故意用相对路径断言 `resolveLogFile()` **纯函数语义**（不写文件）的用例是**白名单项**，逐字不动；若某次改动让它们变红 ⇒ 停下来报店长，不要改断言。
- 隔离写法有**类级护栏**（`scripts/test-isolation-guard.test.js`，静态扫隔离路径写法）。护栏的词法启发式有三条已知残留（见 §6），但每条都**逐条钉洞**（`scripts/test-isolation-guard.test.js` 内有对应的实测读数格），将来换真解析器时这些格会红、强制同步改声明——不会静默漂移。

## 5. 明确不做（Out of Scope）

- **不改 `pnpm test`**（`package.json` 的 test 脚本仍是全量 `vitest run`）。
- **不加 pre-push 全量**——那里是审查门禁。
- **不引入 `vitest related`**：它走静态 import 图，改了「被运行时字符串引用」的面（如 `db/schema.ts`）图上看不见 ⇒ 漏。按包是**粗但零假阴性**的下界——宁可多跑一个包，不可漏一个消费者。
- **不改 lint 面**（`lint-staged` / `pnpm lint` 两行原样保留，含行序）。
- **不新装依赖**（含不引入 `acorn` 之类真解析器，见 §6）。
- **不写「请求审查前跑全量」的自动化**——那一档的位置有讲究（须在合并前、对「将会得到的那个结果」跑），且它是**流程门槛不是脚本**，写作对象是 `request-review` 前置门槛与 `CONTEXT.md`。

## 6. 已知边界与挂账（引用本规格前先读）

- **覆盖边界：跨根 ≠ 同根**。本机制交的是**跨根**隔离（主仓库 ↔ worktree ↔ worktree，即 junction 别名面）；**同一 worktree 内两个 vitest 进程仍共享同一批隔离目录**。该形态在有「一猫一 worktree」之后自然消失，故本规格不处理；重开条件 = 隔离落地**之前**真出现一条同根并发假红挡死提交。
- **同根并发的最小修法有未验证前提**（勿直接照抄实施）：给隔离路径派生末段挂 `process.pid` 的前提是「两份派生公式在不同进程内求值」；若 vitest 配置在主进程求值、worker 另起进程，该修法会让「两份派生式同解」的断言退化成**同进程自比**，失去交叉校验意义。实施前先测进程模型。
- **静止的例外面**：`docs/run/**` 可跳过、`docs/adr|lessons|plans/**` 不可——判据是**有无测试消费者**（实测），不是目录名好看。若将来实测发现 `docs/run/**` 存在消费者 ⇒ 改表。
- **词法启发式三条残留（f1/f2/f3）不立单**：触发都要求**故意写出**罕见词法形态，不是「顺手写错」的形态；护栏的靶子是后者。重开条件 = 发生一次**实证漏报**（真写了违规却过闸）⇒ 换真解析器。
- **一处实测教训（值得留档）**：首版清单有第 10 处漏网（`routes/connectors.test.ts` 的 `browseTmpDir` 把路径字面量**拆成两个实参**写），是并发实跑抓出来的、不是静态正则——**「连续形态的静态正则」对同一写法的拆行变体是盲的**。

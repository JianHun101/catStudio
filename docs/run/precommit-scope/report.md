# 报告：pre-commit 测试门禁三档收窄

> 票面 `docs/run/precommit-scope/tickets.md`（`89681b0`）。实施 2026-09-16。
> **本票 = 八笔提交**：
>
> - `e005954`（报告首版，V1 的钩子读数载体）
> - `a534193`（票面 §1.1 四文件：三档收窄 + 根配置缓存隔离）
> - `38a654d`（**A′ 扩面**：restart 族 10 处收口 + V14 类级护栏）
> - `2049d59`（**复审修复·第一轮**：吐槽猫 ⚠️建议修改 的 6 项逐条处理 + 自查补漏 1 项）
> - `8775c1b`（**复审修复·第一轮·补**：跨行窗口去重规则漏报）
> - `104db8f`（**复审修复·第二轮**：`stripComments` block 态未闭合兜底 + 边界 (f) 如实改写）
> - `076e6db`（**复审修复·第二轮·族扫补**：失败模式族扫扫出 `line` 态同型吞行；
>   (f) 由「一条残留」改写为「整类根因 + 两条残留」）
> - **第八笔 = 本文件的承载提交**（**复审修复·第三轮**：族扫表 `re` 行「不能吞」被证为**假声明**
>   ⇒ 新增 **f3**（`re` 态闭合成形抹内容）、三条残留合并声明、OQ3 前提措辞更正；**本轮不动代码**）
>   —— sha 即 `git log -1`（自指：提交 sha 无法写进它自己承载的文件，故本笔按「承载提交」指认）。
>
> 验收 = §三 V1–V11（前两笔）+ §三之二 V12–V14（A′ 笔）+ §三之二「V14 复审修复」三张表
> （第 4–8 笔）逐条留痕（下）。

## 结论先行

1. **交付面全部落地，V1–V14 逐条有读数**（§三）。全量入口未改窄：`pnpm test` 仍是
   **122 文件 / 2478 用例**（= shared 3 + server 88 + web 18 + scripts 13，四个 project 全跑；
   较 A′ 笔 +5 = 复审修复两轮新增的 5 个用例格），全绿；`pnpm lint` 3 包绿。
2. **两条票面契约与实测不符**，均按「不擅改契约、就地补实现层」处理，并在此显式回报（§五）：
   - **① scope 名 ≠ vitest project 名**。票面 §2.2 的 `projects` 形状是仓根相对路径，而
     `vitest --project` 认的是 project 名（实测 `--project packages/server` ⇒ `Startup Error:
No projects matched the filter`）。CLI 侧加 `projectNameOf()` 映射层消化，`resolveScopes`
     的返回形状**一字未动**。
   - **② 根 `vitest.config.ts` 的 `test.env` 被 `packages/server/vitest.config.ts` 覆盖** ——
     首版报请裁决 ⇒ **店长裁 A′**：扩面到 restart 族全收（LOG_FILE 两处另立单）。**已按 A′ 落地**（§五-1）。
3. **一处票面清单外的第 10 处，由 V13 并发实跑抓出并已收口**（`routes/connectors.test.ts` 的
   `browseTmpDir`，写成 `path.join('node_modules', '.cache', …)`——**字面量被拆成两个实参**，
   连续形态的静态正则看不见）。见 §三 V13、§四-5。
4. **一处边界事实（新发现，非本票缺陷，请店长裁）**：A′ 交的是**跨根**隔离（主仓库 ↔ worktree ↔
   worktree），**不交同根并发隔离**（同一 worktree 内两进程仍共享同一隔离目录）。读数见 §三 V13-补充。
5. 生产行为零变化：只碰 `.husky/pre-commit`、`vitest.config.ts`、`packages/server/**`（配置 + 测试面）、
   `scripts/`、本报告。

---

## 一、交付物

| 文件                                 | 动作 | 说明                                                                               |
| ------------------------------------ | ---- | ---------------------------------------------------------------------------------- |
| `scripts/precommit-scope.mjs`        | 新建 | 纯函数 `resolveScopes` + `projectNameOf` + CLI 薄壳                                |
| `scripts/precommit-scope.test.js`    | 新建 | 42 用例：§2.1 逐行 + 并集 + 空列表 + fail-closed + 映射                            |
| `.husky/pre-commit`                  | 修改 | 第三行 `pnpm test` → `node scripts/precommit-scope.mjs`（前两行与 `unset` 行原样） |
| `vitest.config.ts`                   | 修改 | `cacheDir` / `RESTART_FILES_DIR` → `os.tmpdir()` 下的按仓库根派生绝对路径          |
| `docs/run/precommit-scope/report.md` | 新建 | 本文件                                                                             |

**A′ 笔追加交付面**（11 文件，见 §三之二表格）：`packages/server/src/test-helpers.ts`（新增
`isolatedTestDir`）、`packages/server/vitest.config.ts`、6 个测试文件（`restart-request` /
`shutdown-request` / `routes/messages` / `routes/config` / `routes/config-summary` / `routes/connectors`）、
`packages/server/src/connectors/socketio.test.ts`（**仅注释与用例名**）、`scripts/graceful-stop.test.js`、
`scripts/test-isolation-guard.test.js`（新建，V14 护栏）。

---

## 二、实现要点（与票面 §2 契约的对应）

### 判据顺序（`classify`，判定即优先级）

```
① 全量触发：FULL_EXACT（vitest.config.ts / scripts/vitest.config.ts / package.json /
   pnpm-lock.yaml / pnpm-workspace.yaml）/ FULL_PREFIXES（packages/shared/、.husky/）/
   basename 匹配 tsconfig*.json（任意深度）
② 收窄：packages/server|web/**、scripts/**、docs/{adr,lessons,plans}/**→ packages/server
③ 跳过：docs/run/**、docs/sessions/**、其余 *.md
④ 兜底：FULL（无法归类 ⇒ fail-closed）
```

- **`packages/server/README.md` 取「本包」而非「跳过」**（包前缀先于 `*.md` 判）。当前树
  `packages/**/*.md` 数量为 **0**（`git ls-files` 实测），故这条今天不改变任何读数；定为向严侧
  是为将来包内出现「被测试消费的 MD」时不漏。
- **`tsconfig*.json` 按 basename 匹配任意深度**（票面字面未限定目录）⇒ `packages/server/tsconfig.json`
  也走全量。向严，与票面字面一致。

### 出口（CLI）

- 跳过 → `exit 0`（不启 vitest，日志打印裁决 + `reason`）。
- 收窄/全量 → `node <root>/node_modules/vitest/vitest.mjs run --project <名> …`，退出码原样透传。
  用 `node vitest.mjs` 而非 `npx vitest`：避开 Windows `.cmd` wrapper（`AGENTS.md` Gotchas）。
- 异常（git 读失败 / 解析异常 / 空列表）→ 全量。`git diff --cached` 的调用带 `cleanGitEnv()`
  （钩子顶部已 `unset`，此处是第二道防御 + 手动调用时的唯一防线）。

---

## 三、验收读数（V1–V11）

### V1 纯文档 ⇒ `skip:true`，真实提交不触发 vitest

单元读数：`resolveScopes(['docs/run/precommit-scope/tickets.md'])` ⇒ `{projects: [], skip: true}`（7 格，含 `docs/sessions/**`、`README.md`、`CONTEXT.md`、`AGENTS.md`、深层嵌套）。

**实跑读数**：提交 `e005954`（暂存区仅本文件，即纯 `docs/run/**`）。`pre-commit` 第三行起的输出原文：

```
[precommit-scope] 跳过 —— 1 条路径全为文档/在飞产物（无测试消费者）
[precommit-scope] 跳过测试
```

**无任何 `Test Files` 行 ⇒ vitest 根本没被拉起**；同一次提交里 `npx lint-staged` 与 `pnpm lint`
照常执行（故这不是「钩子整体没跑」的假阴性），提交成功：`1 file changed, 274 insertions(+)`。

### V2 单包 ⇒ 只跑该 project

```
$ node node_modules/vitest/vitest.mjs run --project @cat-study/server --reporter=verbose \
    -t "重启机制文件路径被隔离"
 ✓ |@cat-study/server| src/connectors/socketio.test.ts > socketio connector > 重启机制文件路径被隔离到 node_modules/.cache（测试跑批不碰运行时真实文件） 78ms
 Test Files  1 passed | 87 skipped (88)
```

**唯一前缀 = `|@cat-study/server|`** ⇒ 只有一个 project 被选中（88 = server 全量文件数）。

> 用例名在 A′ 笔改为「…被隔离到**仓库外 tmp 目录**」——首版那名把落点写死成 `node_modules/.cache`，
> 收口后成错误陈述。本行读数留的是**当时**（`a534193`）的原文，未回改。

### V3 契约层 ⇒ 全量 4

`resolveScopes(['packages/shared/src/index.ts'])` ⇒ `projects === ALL_PROJECTS`（4 个，单测）。
实跑 `--project @cat-study/shared --reporter=verbose`：全部行前缀 `|@cat-study/shared|`，3 文件通过。

### V4 基础设施 ⇒ 全量 4

单测 12 格：`vitest.config.ts`、`scripts/vitest.config.ts`、`package.json`、`pnpm-lock.yaml`、
`pnpm-workspace.yaml`、`.husky/pre-commit`、`.husky/commit-msg`、`tsconfig.base.json`、
`packages/server/tsconfig.json`、`packages/web/tsconfig.node.json`、`internal/tsconfig.build.json`。

**实跑读数**：commit B 的暂存区含 `vitest.config.ts` + `.husky/pre-commit` ⇒ 钩子走全量
（读数见 V10，与 `pnpm test` 同）。

### V5 并集 ⇒ 两个 project，顺序确定

单测：`['packages/server/a.ts','packages/web/b.vue']` 与**反序入参**给出同一答案
`['packages/server','packages/web']`（顺序按 `ALL_PROJECTS`，与入参次序无关）。

实跑 `--project @cat-study/server --project @cat-study/web -t "…"`：

```
 Test Files  1 passed | 105 skipped (106)
```

**106 = 88(server) + 18(web)** ⇒ 两个 project 都被选中，且无 startup error。

### V6 记忆面 ⇒ `packages/server`

单测 3 格：`docs/adr/**`、`docs/lessons/**`、`docs/plans/**` ⇒ `['packages/server']`。
（判据来源已核：`scripts/flywheel/scan.mjs` 的 MD 白名单即这三个前缀；`docs/run/**` 不在其内 ⇒
可跳过。票面「决策留痕」要求的实测见 §四。）

### V7 fail-closed（含反向对照）

单测 5 格：`foo.unknown`、`src/random.txt`、`Makefile`、`docs/mystery.json`、`''` ⇒ 全量 4。

**反向对照（实跑）**：把 `classify()` 的兜底 `return FULL` 改为 `return SKIP` ⇒

```
 × V7 无法归类 ⇒ 全量（fail-closed）：foo.unknown
 × V7 无法归类 ⇒ 全量（fail-closed）：src/random.txt
 × V7 无法归类 ⇒ 全量（fail-closed）：Makefile
 × V7 无法归类 ⇒ 全量（fail-closed）：docs/mystery.json
 × V7 无法归类 ⇒ 全量（fail-closed）：
 Test Files  1 failed (1)
      Tests  5 failed | 37 passed (42)
```

**恰好 5 格变红、其余 37 格不动** ⇒ 该判据非恒真（不是「写了 `expect(true)`」式的绿门）。
随后已还原为 `return FULL` 并复跑 42/42 绿（`grep -c "临时反向对照"` = 0，无残留）。

### V8 缓存隔离实测（两处加载 `vitest.config.ts`）

用 **vite 的 `loadConfigFromFile` 真实加载**（探针落 `os.tmpdir()`，非复刻公式），两处：

| 处  | 根                                 | `cacheDir` 解析值                                   | `RESTART_FILES_DIR` 解析值                                  |
| --- | ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| A   | 本会话 worktree（真实配置）        | `…\Temp\cat-study-vitest\`**`eed1edd5d355`**`\vite` | `…\Temp\cat-study-vitest\`**`eed1edd5d355`**`\restart-test` |
| B   | 同一份配置的**逐字副本**（另一根） | `…\Temp\cat-study-vitest\`**`1d467f2d43ae`**`\vite` | `…\Temp\cat-study-vitest\`**`1d467f2d43ae`**`\restart-test` |

- 副本与原文件**字节级相同**（`readFileSync(a).equals(readFileSync(b))` = `true`）—— 变的是**根**，不是内容。
- 两处 `cacheDir` / `RESTART_FILES_DIR` **均不同** ⇒ 解析值随配置所在仓库根变化。

**行为级印证（更硬的一层）**：处 A 的 `eed1edd5d355` 与**实跑落点**完全一致
（改后跑批在 `…\Temp\cat-study-vitest\eed1edd5d355\vite\` 下建出产物；改前 `…\Temp\cat-study-vitest\`
**整个目录不存在**）—— 配置读数与真实落点互为印证，不是纸面推演。

派生键的反推核验：`sha1(winPath('D:\Game\ai\catStudy-sessions\4c8acf70')).slice(0,12)` = `eed1edd5d355`
（Windows 反斜杠形式；POSIX 形式会得到另一个值 —— 这正是选 `__dirname`/`path.resolve` 而不是拼字符串的原因）。

> **取证限制（如实标注）**：处 B 的「另一根」是 `os.tmpdir()` 下的等价副本，**不是主仓库**——
> 主仓库当前未合并本票改动，其 `vitest.config.ts` 仍是旧版，无法作为「加载同一份配置」的第二处。
> 本读数证明的是「同一份配置换个根 ⇒ 换个路径」这条机制；主仓库侧的真机读数要等本票合并后才有。

### V9 单元测试覆盖 §2.1 每一行

`scripts/precommit-scope.test.js`：**42 用例全绿**。覆盖面 = §2.1 每行 + 并集（含反序入参）+
空列表/非数组 + fail-closed 分支 + 归一化（`./` 前缀、反斜杠、首尾空白）+ 优先级冲突
（全量压并集、包前缀压 `*.md`）+ **契约不变量**（`skip⇔projects` 空、子序列、顺序确定，
每格都过）+ 非恒真对照 + `projectNameOf` 映射。

### V10 全量未被改窄

```
$ pnpm test          # = vitest run，全量入口一字未改
 Test Files  121 passed (121)          # A′ 笔后：122 passed (122)
      Tests  2463 passed (2463)       # A′ 笔后：2473 passed (2473)
```

**121 = 3(shared) + 88(server) + 18(web) + 12(scripts)** ⇒ 四个 project 全跑、全绿。
（A′ 笔后 122 = 121 + `scripts/test-isolation-guard.test.js` 1 个文件 / +10 用例。）
`pnpm lint` 亦绿（`node scripts/lint.js`：shared/server tsc + web vue-tsc，3 包通过）。

### V11 钩子仍剥 env

- `.husky/pre-commit:6` 的 `unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX` **原样保留**，
  且仍在 `npx lint-staged` 之前（`pre-commit-env.test.js` 的「落点」用例即钉此序）。
- `scripts/pre-commit-env.test.js` 单跑：**3 passed**（该用例直接重放钩子里抽出的 `unset` 行 ⇒
  删行必红）；全量跑批中亦绿。
- `npx lint-staged` / `pnpm lint` 两行**原样保留，含行序**。

---

## 三之二、A′ 扩面验收读数（V12–V14）

> 背景：首版 §五-1 报请裁决 ⇒ 店长裁 **A′**（`packages/server/vitest.config.ts` 的
> `RESTART_FILES_DIR` 与 7 处测试内 `stubEnv` 相对路径 + `scripts/graceful-stop.test.js` 全收，
> 全改 `os.tmpdir()` 派生**绝对**路径；`LOG_FILE` 两处另立单）。
> **实施中清单从 9 处变 10 处**——多出的一处由 V13 实跑抓出，见 V13。

### 交付面（A′ 笔）

| 文件                                                | 动作 | 内容                                                                                               |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `packages/server/src/test-helpers.ts`               | 修改 | 新增 `isolatedTestDir(name)`：`os.tmpdir()/cat-study-test-isolation/<sha1(包目录)>/<name>`         |
| `packages/server/vitest.config.ts:52`（改前 `:28`） | 修改 | 改**值**（不删行）→ `resolve(ISOLATION_ROOT, 'restart-test')`                                      |
| `packages/server/src/restart-request.test.ts`       | 修改 | `ISOLATED_DIR = isolatedTestDir('restart-test-create')`                                            |
| `packages/server/src/shutdown-request.test.ts`      | 修改 | `isolatedTestDir('restart-test-shutdown')`                                                         |
| `packages/server/src/routes/messages.test.ts`       | 修改 | `vi.mock` factory 内改**动态 import** 取 helper（factory 被提升，顶层绑定此刻未初始化）            |
| `packages/server/src/routes/config.test.ts`         | 修改 | `isolatedTestDir('restart-test-context-config')`                                                   |
| `packages/server/src/routes/config-summary.test.ts` | 修改 | `isolatedTestDir('restart-test-env-patch')`                                                        |
| `packages/server/src/routes/connectors.test.ts`     | 修改 | 3 处：`restart-test-napcat` / `restart-test-napcat-config` / **`restart-test-browse`（第 10 处）** |
| `packages/server/src/connectors/socketio.test.ts`   | 修改 | 仅**用例名与注释**（原文写死「被隔离到 node_modules/.cache」，改后成错误陈述）；断言一字未动       |
| `scripts/graceful-stop.test.js`                     | 修改 | `TEST_DIR = isolatedTestDir('graceful-stop-test')`                                                 |
| `scripts/test-isolation-guard.test.js`              | 新建 | V14 类级护栏（10 用例）                                                                            |

**10 处清单**（票面 9 + V13 抓出的 1）：配置默认值 ×1、测试内 `stubEnv`/`process.env` 赋值 ×7、
`scripts` 侧绝对但落 junction 共享面 ×1、`join` 拆分形态 ×1。

**为何 `packages/server/vitest.config.ts` 的 `RESTART_FILES_DIR` 只能改值不能删行**：`test:server` =
`pnpm --filter @cat-study/server test`（cwd = 包目录，**不加载根配置**）⇒ 删行会回落 `process.cwd()`
⇒ 把 `.restart-request` 写进 `packages/server/`（17:38 那类事故）。

### V12 双模式：standalone 与根模式解析到同一绝对路径、且在仓库外

探针（临时 `zz-probe-isolation.test.ts`，跑完即删；读数落 `os.tmpdir()`）：

| 模式                                                | `process.cwd()`                   | 解析出的 `RESTART_REQUEST_FILE`                                                               |
| --------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| 根模式 `npx vitest run --project @cat-study/server` | `<会话 worktree>`（仓库根）       | `C:\Users\…\Temp\cat-study-test-isolation\`**`7f9cc2031625`**`\restart-test\.restart-request` |
| standalone `cd packages/server && npx vitest run`   | `<会话 worktree>\packages\server` | **同一路径**（逐字节相同）                                                                    |

- 两种 cwd 不同、解析值相同 ⇒ **不带 cwd 依赖**（cwd 派生会在两种跑法下分叉，且分叉是静默的）。
- 绝对路径 + 不含 `node_modules` + 在仓库外 ⇒ V12 判据成立。
- **两份派生公式同解**：配置面（`packages/server/vitest.config.ts` 的 `__dirname`）与 helper 面
  （`test-helpers.ts` 的 `import.meta.url`）算出**同一个** `7f9cc2031625`。此等式已由
  `scripts/test-isolation-guard.test.js` 的「防公式漂移」用例**钉死**（公式改一处不同步 ⇒ 先红）。

### V13 并发实跑 + 反向对照（跨根）

批次 = restart 族的 8 个文件（`socketio.test.ts` 为主犯），两进程**同时**起：

| 态                                                                       | 轮次 | 会话 worktree                          | 主仓库（`bc808c0`，仍是旧相对路径） |
| ------------------------------------------------------------------------ | ---- | -------------------------------------- | ----------------------------------- |
| **反向对照**：`browseTmpDir` 改回 `path.join('node_modules','.cache',…)` | 4    | 3 红 / 1 绿（`1 failed \| 49 passed`） | 3 红 / 1 绿                         |
| **修复后**（browse 也走 `isolatedTestDir`）                              | 4    | **4 轮全绿（318/318）**                | **4 轮全绿（318/318）**             |

反向对照的失败原文（复现的正是票面点名的形态）：

```
FAIL  … > NapCat 路径浏览… > dir 不存在 → 400 路径不存在；dir 是文件 → 400 不是目录
AssertionError: expected '路径不存在' to be '不是目录'
FAIL  … > dir 存在 → 目录优先排序 + executable 标记（.bat 命中、.txt 不命中）
AssertionError: expected 400 to be 200
```

（一侧的 `beforeAll` `mkdirSync`/`afterAll` `rmSync` 删掉另一方正在用的同一批物理文件 ⇒ 假红。
**未复现轮次为 0**：反向对照 4/4 轮里至少一侧红，故不需要写「未复现」。）

**第 10 处的发现过程**：A′ 收口前先跑了一轮跨根并发（browse 尚未改）⇒ round 2 主仓库侧
`1 failed`，报错正是上表同一形态。定位到 `browseTmpDir` 是**清单外**的第 10 处 ⇒ 先修，
再跑上表的「修复后」4 轮。**这条是 V13 的净收益**（静态扫漏了它，见 V14）。

### V13-补充：同根并发**不**被本票覆盖（边界事实，请店长裁）

两进程**都**在会话 worktree（同一个根）跑同一批：

| 轮次 | 进程 A                             | 进程 B                             |
| ---- | ---------------------------------- | ---------------------------------- |
| 1    | 11 failed / 210 passed             | 6 failed / 215 passed              |
| 2    | 7 failed / 214 passed              | 10 failed / 211 passed             |
| 3    | 8 failed / 213 passed              | 10 failed / 211 passed             |
| 4    | 4 failed / 213 passed（4 skipped） | 5 failed / 212 passed（4 skipped） |

失败原文命中同一批隔离目录：

```
Error: ENOENT: no such file or directory, open '…\cat-study-test-isolation\7f9cc2031625\restart-test\.restart-request'
Error: ENOENT: no such file or directory, open '…\cat-study-test-isolation\7f9cc2031625\graceful-stop-test\.shutdown-request'
AssertionError: expected 'msg-restart' to be 'first-request'  // 请求文件内容被对方覆盖
SyntaxError: Unexpected end of JSON input                          // 读到对方写了一半的文件
```

**机制**：派生键 = **仓库根**，同一个 worktree 的两个进程算出同一个哈希 ⇒ 同一批目录。
**影响的准确边界**：

- **交了的**：主仓库 ↔ worktree ↔ （Phase I 后的）worktree ↔ worktree —— 即** junction 别名面**，
  也正是票面「依赖」段点名的 T-2 Phase I 目标形态。修复前这三者是同一批物理文件。
- **没交的**：**同一 worktree 内**两进程并发。票面「依赖」段明写这一形态归 T-2 Phase I
  （「Phase I 未接线前会话内多猫共用一个 worktree…T-2 落地后此约束自动解除」）——
  故按票面口径**不属本票交付**，但**店长派活时把「两猫在同一个 worktree 里并发提交不互踩」
  写成了本票承诺**，两者口径不一致，**如实报出，请店长裁**。
- **最小修法（若裁「要修」）**：`isolatedTestDir(name)` 的末段再挂 `process.pid`
  （或一次运行的 nonce）⇒ 隔离粒度从「仓库」降到「进程」，同根并发一并解决；
  `socketio.test.ts:339-340` 的 `toContain('restart-test')` 仍成立（末段前缀不变）。
  ⚠️ 派活单写的是 `socketio.test.ts:336`——**行号漂移**，`git grep -n` 复核实为 `:339-340`
  （A′ 笔只在该文件加了注释与用例名两处文本，断言本体未动）。
  代价：`os.tmpdir()` 下目录数随运行次数线性增长（现状**本就无回收**，非新增成本）；
  副作用：跨进程复用同一目录的调试便利消失。**未自行实施**——粒度的语义变更越出派活单钉死的交付面。

### V14 类级护栏（`scripts/test-isolation-guard.test.js`，14 用例）

被判面 = 「`packages/**` + `scripts/**` 源码里不存在把测试隔离文件落到 junction 共享面的写法」。
三条规则（对**去注释后**的代码逐行判）：R1 连续 `node_modules/.cache` 字面量（含 R1 拆分形态
`join('node_modules','.cache',…)`）/ R2 隔离键（`RESTART_FILES_DIR`/`LOG_FILE`/`ENV_FILE_PATH`）
被赋非绝对**字面量** / R3 同行出现隔离键与 `process.cwd()`。

| 判据                                         | 读数                                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检测器**非恒真**（种入违规必须红）           | 临时落 `scripts/tmp-guard-probe.js`（三类各一行）⇒ `1 failed \| 7 passed`，三行分别报 `[R1] [R2] [R3]`；文件已删（`git status` 无残留）                                                                                                       |
| **真文件反向对照**                           | 把 `connectors.test.ts` 的 `browseTmpDir` 改回 `path.join(` 形态 ⇒ 红并指名 `packages/server/src/routes/connectors.test.ts:882 [R1]`；改回即绿                                                                                                |
| 全仓扫描零违规（白名单外）                   | 扫 **289** 个源文件（`packages/**` + `scripts/**`，跳 `node_modules`/`dist`/`coverage`/`.cache`/`data`；其中本文件不自扫 ⇒ 实判 288），白名单外违规 **0 条**                                                                                  |
| 白名单**非死条目**                           | 5 条逐条命中 ≥1 行（有断言钉着）；理由字段必填非空（有断言钉着）                                                                                                                                                                              |
| 白名单（**按行匹配正则收窄，非整文件豁免**） | `server/vitest.config.ts:57`+`scripts/vitest.config.ts:11`+`logger.test.ts:239/242`（LOG_FILE 族，另立单）；`restart-request.ts:60`+`context-config.ts:29`+`routes/connectors.ts:115/120`（生产侧 `?? process.cwd()` 运行时兜底、非测试隔离） |
| 两份派生公式同解                             | `serverVitestConfig.test.env.RESTART_FILES_DIR === isolatedTestDir('restart-test')` ⇒ 通过                                                                                                                                                    |

### V14 复审修复（第三笔 —— 吐槽猫 ⚠️建议修改 的逐项处理）

> 审查结论（原文「核心 10 处收口正确，但 V14 护栏与其自述能力有真实落差」）⇒ 本笔只动护栏与
> 失真文案，**10 处隔离收口与跨根派生逻辑一字未动**（审查者已独立验绿，不必重做）。

| #   | 审查项                                                                         | 严重度 | 处理                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `stripComments` 把代码当注释吞掉 ⇒ 护栏恒绿（正则字面量）                      | P2     | ✅ **已修**：`code` 态遇 `/` 增加**正则字面量态**（`re`/`reClass`，含字符类与转义）；判定顺序 = `//` → `/*` → 正则 → 其余。新增 4 条反向对照（吞行 / 真块注释不误伤 / 除号不误判 / `return` 后置正则）                                                                                   |
| 2   | 护栏自述「静态扫能在提交口拦下」与实际执行面不符                               | P2     | ✅ **声明确实不成立，已改为如实**（本文件属 `scripts` project，改 `packages/**` 的提交口只跑本包）⇒ 文件头改为「执行面 = 审查档 / 落地档全量」，并列入覆盖边界 (g)。**「让 packages 改动也带上 scripts project」= scope 语义变更，未擅改，报店长裁**（§五-4）                            |
| 3   | R1 拆分规则只认同行，pretty 换行即盲区且未声明                                 | P3     | ✅ **已修**：新增 `R1_WINDOW = 3` **跨行滑窗**（只判 R1，R2/R3 仍严格同行——跨行拼接会把无关两行凑成命中）；抽出 `scanSource()` 使该判据可反向对照；新增 5 条断言格                                                                                                                       |
| 4   | `shutdown-request.test.ts:57-61` 退化为同义反复 + 注释失真                     | P2     | ✅ **已修**：用例名与注释改为「env（绝对）赢过 cwd」的**真实语义**，并补一条 `not.toBe(resolve(cwd, …))` 断言（忽略 env 的实现会红）；**另补「未设 env → 回落 cwd」用例**（改绝对后该回落分支已无覆盖），带反向对照读数（§三之二 V14-R4）                                                |
| 5   | `routes/messages.test.ts` 未断言隔离生效（时序偏差假绿）                       | P3     | ✅ **已修**：写入分支补 `expect(RESTART_REQUEST_FILE).toContain('restart-test-messages')`——factory 时序若偏差，该文件路径不含该末段 ⇒ 必红                                                                                                                                               |
| 6   | 白名单两处脆弱点（同文件条目合并计数 / `/napcat/` 过宽）                       | P3     | ✅ **已修**：`hitCount` 改以**白名单条目**为键（原按 `file` 键控，同文件两条目合并 ⇒ 死条目检查失效）；`connectors.ts` 的 `lineMatch` 由 `/napcat/` 收窄为 `/RESTART_FILES_DIR\s*\?\?\s*process\.cwd\(\)/`（精确到那条兜底写法）                                                         |
| 7   | **自查补漏**（非审查项）：跨行窗口的**去重规则漏报**，自己推演时判错，实测推翻 | ——     | ✅ **已修**：原规则「上一窗口命中则跳过」会把**两处相邻的真实违规并成一条**（实测：两处相邻 ⇒ 报 1 条，漏报侧）。改为「锚点 = 携带前半段字面量的那一行 + 后续 `R1_WINDOW-1` 行内须有另一半」⇒ 同输入报 3 条（多报侧，fail-closed）。教训：**判据的方向偏好要写进代码**，不能只写在注释里 |

**残留 / 未做**：OQ1（同根并发粒度）属范围裁决，**未自行实施**（见 §五-1b）；
审查者提的 OQ4「检测器与夹具拆两文件」判为可接受、非必须，维持现状。

**三条修复的反向对照读数（都是实跑，不是推演）**：

| 修复                      | 反向对照做法                                                                                                                   | 读数                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 `stripComments` 正则态 | 把 `38a654d` 版（**旧**）的 `stripComments` 抽出来，喂同一条探针 `const re = /[/*]/\nconst LOG_FILE = 'node_modules/.cache/x'` | **旧**：第 2 行输出 `"                    "`（全空白）、含 `LOG_FILE`? `false`、R1 可见? `false` ⇒ 恒绿属实；**新**：第 2 行保留、R1 命中（有单测格钉着） |
| #3 R1 跨行窗口            | 先断言「逐行判对这条**全部**为 null」（窗口拿掉即红），再断言 `scanSource` 报 1 条                                             | ✅ 逐行 `every(!detectR1)` = true（逐行确实看不见）；`scanSource(...).length === 1`（窗口接住）                                                           |
| #4 新补用例非恒真         | 把 `shutdown-request.test.ts` 的期望值从 `resolve(process.cwd(), …)` 改成隔离目录                                              | ❌ 1 failed —— 实测值 `D:\Game\ai\catStudy-sessions\4c8acf70\…`（**worktree 根**，即 cwd），非 tmpdir ⇒ 回落分支真被走到                                  |

### V14 复审修复·第二轮（第六笔 —— 吐槽猫 二次 ⚠️建议修改 的处理）

> 审查结论（原文「`stripComments` 的正则修复是**半程**，且覆盖边界 (f) 里『不会吞代码』
> 这句声明与实测相反」）⇒ **判断成立**，且不止声明失真：修法本身也只接住了 `= /` 一类前缀。

| #   | 审查项                                                                                                           | 严重度 | 处理                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `stripComments` 正则修复半程：`)`/`]`/标识符前缀 + 体内 `/*` 仍吞代码                                            | P2     | ✅ **已修**：给 `block` 态补**与 `re` 态对称的未闭合兜底** —— 合法 JS 的块注释必闭合，故**跑到 EOF 仍在 `block` 态**即判误剥、把缓冲原文写回。`buf` 与 `placeholder` 并行累积，闭合才落占位符 ⇒ 行号不错位。**未扩前缀集合**（审查者点名的反向陷阱：把 `)`/`]` 认成正则前置会把 `f(x) / 2 / g` 误判成正则，新开一条遮蔽路径）          |
| 2   | 覆盖边界 (f)「不会吞代码」是**假声明**                                                                           | P2     | ✅ **已如实改写**：写明误判代价不是保守的、已收口口径（EOF 兜底）、**并显式声明残留洞**（见下）                                                                                                                                                                                                                                        |
| 3   | 报告头未点名 `8775c1b` 的 sha                                                                                    | P3     | ✅ **已补**：头部逐笔点名（详见头部注：本笔按「本文件的承载提交」指认，因提交 sha 无法写进它自己承载的文件）                                                                                                                                                                                                                           |
| 4   | **失败模式族扫**（本技能 R2+ 要求，非审查项）：同一型「误判令状态机进吞食态 ⇒ 恒绿」在**别的状态**是否还有实例？ | ——     | ✅ **扫出 1 处新实例并已声明**：`line` 态同样能吞（吞到行尾）。逐状态扫完：`code` 不吞 / `line` **能吞（未收口 · f2）** / `block` EOF 类已收口、提前闭合类未收口（f1）/ `re` 已收口 / `sq`·`dq`·`tpl` 不吞（内容原样保留）。见 §四-9 表<br>⚠️ **本行「`re` 已收口」经第三轮复核证伪** —— `re` 态**闭合成形**时同样吞内容（f3），见下节 |

**残留洞（已写进覆盖边界 (f)，并**用一条测试格钉住**，防声明再次与实测脱钩）——两条，同根因**
（`isRegexStart` 只按左侧字符判正则/除号，`)`/`]`/标识符后可以是正则却被判成除法）：

- **(f1) 块注释被后文提前闭合**：误判的「块注释」若中途撞上其后某处真实的块注释闭合符而被
  提前闭合，则中间那一段仍被吞 —— EOF 兜底只管「到文件尾都没闭合」的形态。**实测**：
  误判起点 + 违规行 + 一条真注释 ⇒ 违规行**不可见**。
- **(f2) `line` 态吞行尾**（族扫新发现）：误判的除法后若正则体内以 `/` `/` 开头（如 `/[//]/`），
  `//` 判据先于正则判据命中 ⇒ 进 `line` 态吞到行尾（含**同一行**的违规）。**实测**：
  `arr[0] /[//]/.test(s) ; LOG_FILE='node_modules/.cache/x'` ⇒ 违规**不可见**。
  `line` 态**没有**「未闭合」信号（行尾即合法终止）⇒ 块态那套不变量兜底不适用，故**未修**。

两条共用同一单测格（`已声明边界 (f) 的三条**残留**`）钉着，将来若真修好该格会红、提醒同步改
声明。词法层无法与真注释区分（真注释正文任意），属**潜伏**：触发需先有「字符类内含 `/` 或 `*`
的正则 + 该正则左侧是 `)`/`]`/标识符」写法，仓内当前 0 处。（**第三条 f3 见下节** —— 它由第三轮
审查指出，触发面比这两条更宽。）

### V14 复审修复·第三轮（第八笔 —— 吐槽猫 三次 ⚠️建议修改 的处理）

> 审查结论（原文「本轮的族扫表本身漏了一整个状态：`re`/`reClass` 行写『否（不能吞）』是**假声明**」）
> ⇒ **判断成立**，且我用抽取的真实实现独立复现（见下）。**本轮不修代码、只修声明与钉洞** ——
> 审查者裁决：词法层无法区分「真正则」与「误判的除法 + 后续斜杠」，代码修法随**方案层裁决**
> （换真解析器）一起收口。

| #   | 审查项                                                                     | 严重度 | 处理                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 族扫表 `re` 行「不能吞」是假声明（§四-9 表 + (f) 声明段）                  | P2     | ✅ **已纠正**：新增 **f3** 并写进覆盖边界 (f) 与 §四-9 表（`re` 行改「**能**（闭合成形时抹掉两端间全部内容）」）；三条残留共用一个钉洞测试格                                                                             |
| 2   | 触发面描述过窄（原写「需正则字面量 + `)`/`]`/标识符前缀」）                | ——     | ✅ **已补**：(f3) **不需要正则字面量** —— 只需「`/` 左侧字符落在 `REGEX_PRECEDER_CHARS`（`++`/`--` 的第二字符、`}` 等）且同行另有 `/`」。触发面在 (f) 段与 §四-9 分别写明                                                |
| 3   | OQ3 前提不严谨（「`re` 态 EOF 未闭合**只可能**来自非法输入」为 P3 观察）   | P3     | ✅ **已实测推翻并改写**：`const x = a++ / b`（合法 JS、无尾换行）也会落进去；旧版输出丢弃 `/ b`、新版原样写回 ⇒ 方向安全但前提表述错误，已改为「也会在合法输入上触发」                                                   |
| 4   | **同型二次 ⇒ 族扫**（本技能 R2+ 要求）：族扫表本身是否还有别的状态被错标？ | ——     | ✅ **逐状态复核**：`code` 否 / `line` **能**（f2）/ `block` **能**（EOF 类已收口，提前闭合类 f1）/ `re`·`reClass` **能**（f3，本轮纠正）/ `sq`·`dq`·`tpl` 否（内容原样保留 ⇒ 多扫不少扫）—— 除 `re` 行外**未再发现**错标 |

**钉洞格新增 (f3) 三格 + 一格对照**（`已声明边界 (f) 的三条**残留**`）：

| 探针输入                                        | 旧版（`8775c1b`） | 本版        |
| ----------------------------------------------- | ----------------- | ----------- |
| `let r = i++ / 2 ; LOG_FILE = '…'`              | ❌ 不可见         | ❌ 仍不可见 |
| `let r = i-- / 2 ; LOG_FILE = '…'`              | ❌ 不可见         | ❌ 仍不可见 |
| `function f(){} / LOG_FILE = '…' / 2`           | ❌ 不可见         | ❌ 仍不可见 |
| 对照：闭合斜杠**移到违规之前**（`i++ / 2 / 3`） | ✅ 可见           | ✅ 可见     |

**反向对照读数（抽取仓内**真实** `stripComments` 字节，非复制逻辑；旧版取自 `8775c1b`）**：

| 探针输入（违规在**第 2 行**，末两行除外）    | 修复前（`8775c1b` 版）          | 修复后                                |
| -------------------------------------------- | ------------------------------- | ------------------------------------- |
| `if (x) /[/*]/.test(y)`                      | ❌ 违规行**不可见**（吞到 EOF） | ✅ 可见，命中 R1                      |
| `while (a) /[/*]/g.test(b)`                  | ❌ 同上                         | ✅ 同上                               |
| `const z = foo` + 行首 `/[/*]/`              | ❌ 同上                         | ✅ 同上                               |
| `f(x)` + 行首 `/[/*]/`                       | ❌ 同上                         | ✅ 同上                               |
| `arr[0] /[/*]/.test(s)`                      | ❌ 同上                         | ✅ 同上                               |
| 控制：`if (x) /[ab]/.test(y)`（体内无 `/*`） | ✅ 可见                         | ✅ 可见（未误伤）                     |
| 控制：一条真块注释内含违规字样               | ✅ 被剥（不可见）               | ✅ 被剥（未误伤）                     |
| **残留 f1**：误判块被后文真注释闭合          | ❌ 不可见                       | ❌ **仍不可见**（已声明）             |
| **残留 f2**：`arr[0] /[//]/…` 同行违规       | ❌ 不可见                       | ❌ **仍不可见**（已声明）             |
| **残留 f3**：`i++ / 2 ; 违规`（`re` 态闭合） | ❌ 不可见                       | ❌ **仍不可见**（本轮族扫复核补声明） |
| 控制：闭合斜杠**移到违规之前**               | ✅ 可见                         | ✅ 可见（未误伤）                     |
| **合计**                                     | **8 格与期望不符**              | **3 格**（即已声明的三条残留）        |

> **f3 的独立读数（本轮实测，非转述）**：抽新旧两版真实实现对同一组输入 ——
> `i++ / 2 ; 违规` / `i-- / 2 ; 违规` / `} / 违规 / 2` 三格**新旧均「不可见」**
> ⇒ **非本轮引入**，是上版族扫表的**漏项**；控制格（闭合斜杠移到违规前）两版均「可见」
> ⇒ 三格不是恒绿。**上一版把 `re` 行写成「否（不能吞）」= 声明与实测脱钩**，已纠正。

> **`re` 态 EOF 兜底（范围外改动，已在 OQ3 标红）**：新补的 `else if (state==='re') out += reBuf`
> 不在审查意见范围内。实测 6 格输入中**只有**「截断的正则（非法 JS）」「文件首未闭合正则」
> 两格行为改变（旧：丢弃 → 新：原样写回），其余 4 格（已闭合正则 / 除号收尾 / `return` 后置
> 正则 / 正则 + 尾随换行）新旧**逐字节相同**。
>
> ⚠️ **措辞更正（本轮，审查者 P3 指出）**：原写「合法输入无反向误伤」的前提是「`re` 态
> EOF 未闭合**只可能**来自非法输入」—— **该前提不严谨**，已实测推翻：`const x = a++ / b`
> （**合法 JS**，无尾换行）中 `/` 被 `isRegexStart` 误判成正则起点 ⇒ 落进 `re` 态直到 EOF。
> 实测两版：`8775c1b` 输出 `"const x = a++ "`（`/ b` **被丢弃**）→ 本版输出与输入**逐字节
> 相同**（原样写回）。故正确表述是：**EOF 兜底也会在合法输入上触发**（触发面 = 无尾换行的
> 误判除法）；但方向安全 —— 它把旧版的**丢字符**换成**写回**，只会让更多文本进入判定。

---

## 四、覆盖边界自陈（本票没覆盖什么）

1. **`pnpm test` 的全量语义未动**（票面 §1.2 明写不做）：审查者与收口方的入口仍是全量。
   「请求审查前跑全量」那一档是**纪律**，随票2 写进 `CONTEXT.md`，本票不含其代码。
2. **`packages/*/vitest.config.ts` 未列入全量触发面**（票面 §2.1 只显式列了
   `scripts/vitest.config.ts`）⇒ 按包前缀归各包。当前无实害（包内 vitest 配置只影响该包测试），
   但本报告 §五-1 的缺口若要修，改的正是 `packages/server/vitest.config.ts` ⇒ 那种提交只跑 server，成立。
3. **`docs/run/**` 确实零测试消费者**（票面「决策留痕」要求的实测，本票复核）：
   `git grep -ln "docs/run" -- packages scripts` 命中 **14 个文件**，逐条读上下文后分三类——
   - **注释引用**（11 个）：`serial.downgrade.test.ts:3`、`ChatPanel.test.ts:587/624`、
     `embed-server.test.js:196`、`worktree-fanin.ts:16`、`routes/eval.ts:120`、
     `commit-uuid-gate.mjs:6`、`scan.mjs:48`、`handoff-gen.mjs`（多处）、本票新增 2 文件 ——
     全部是「票面在 `docs/run/xxx`」式**注释**，非断言面。
   - **判据常量**：`handoff-gen.mjs:357` 的 `REVIEW_EXEMPT_PREFIXES = ['docs/run/']` —— 消费的是
     **git 变更路径列表**，不是文件内容。
   - **测试夹具写在临时仓库里**：`scan.test.js:169` 把 `'docs/run/e.md'` 写进**测试自建**的临时仓库，
     断言的是「run/research/sessions **零行**」（`docs/run` 恰是**不该被扫**的反例）；
     `handoff-gen.e2e.mjs` 同理自建临时 git 仓，且 e2e 不纳入 vitest include。

   ⇒ **无任何测试读取真实 `docs/run/**` 的内容**。记忆飞轮白名单（`scan.mjs:48` 注释 + `SCAN_PREFIXES`
   = `docs/adr/`/`docs/lessons/`/`docs/plans/`）也不含 `docs/run/**` ⇒ 「跳过」成立，§2.1 无漏行。

4. **其他落在 junction 共享面的相对路径写点**（首版列了 9 处）——**已按 A′ 全部收口**，状态见 §五-2。
5. **`node_modules/.cache` 的「拆分字面量」形态**：`path.join('node_modules', '.cache', …)`
   不构成连续子串，**R1 的连续形态正则看不见**。第 10 处（`browseTmpDir`）正是此形态，
   静态扫漏掉、由 V13 实跑抓出。**已补 R1 拆分规则**（`'node_modules'` 与 `'.cache'`
   两个字面量同现即红）并加了单测格。**第三笔补齐跨行**：新增 `R1_WINDOW = 3` 的**跨行滑窗**
   ——审查指出「R1 拆分只认同行 ⇒ prettier 换行即盲区」，已修并可反向对照（`scanSource()` 单测格）。
   **残余边界**：窗口宽 3 行，三段以上再拆分（`join('node','_modules',…)`）或经变量中转仍是盲区
   ——未穷举，如实标注（护栏文件头边界 (e)）。
6. **`LOG_FILE` 族两处（`packages/server/vitest.config.ts:57`〔改前 `:33`〕、`scripts/vitest.config.ts:11`）未收口**
   ——店长裁「另立单」。已在 V14 白名单显式列出理由（**不是**「没注意」：`logger.test.ts` 那两行
   是**故意**用相对路径验 `resolveLogFile()` 纯函数语义、全程不落盘）。后续单立票时移除白名单条目。
7. **V14 护栏的「执行面」窄于它的扫描面**（第三笔修正的**声明**，非代码）：护栏扫
   `packages/**` + `scripts/**`，但它自己属 `scripts` project ⇒ **改 `packages/**` 的提交口只跑
   本包，不跑护栏**。护栏实际生效于**审查档 / 落地档全量**。首版文件头写「静态扫能在提交口拦下」
   是**不成立的声明**，已改为如实（护栏文件头 + 覆盖边界 (g)）。**是否让 `packages/**` 改动
   也带上 `scripts` project = scope 语义变更，报店长裁**（§五-4）。
8. **护栏是启发式，不是证明**：R1 拆分/跨行的盲区见 §四-5；R2/R3 只认字面量与同行同现，
   经变量中转的 cwd 派生不红（护栏文件头边界 (a)）；R3 不区分「字符串里的描述文字」与
   「真的路径表达式」（本次新增的 shutdown 用例名即被误伤，改措辞消解，边界 (h)）。
9. **`stripComments` 的注释剥离是词法启发式，不是解析器** —— 这是一**类**洞（单一根因，
   边界 (f)）。根因：`isRegexStart` 只按左侧字符判 `/` 是正则还是除号，`)` / `]` / 标识符后
   一律判除号，**但这些位置在合法 JS 里可以是正则**（`if (x) /re/.test(s)`）⇒ 误判后状态机
   进吞食态，违规静默消失（**恒绿**，不是保守方向）。
   **族扫口径**（逐状态问「能否吞掉违规」，实跑见下）：

   | 状态            | 吞食可能                                                  | 处置                                                                                           |
   | --------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
   | `code`          | 否（不吞，逐字符输出）                                    | ——                                                                                             |
   | `line`          | **能**（吞到行尾）                                        | ⚠️ **未收口**（f2）：`line` 态无「未闭合」信号（行尾即合法终止）⇒ 块态那套不变量兜底**不适用** |
   | `block`         | **能**（吞到闭合符 / EOF）                                | ✅ **EOF 类已收口**（不变量兜底：合法块注释必闭合）；⚠️ **提前闭合类未收口**（f1）             |
   | `re`/`reClass`  | **能**（**闭合成形**时抹掉两端间的全部内容）              | ⚠️ **未收口**（f3）：换行兜底 / EOF 兜底**只管「未闭合」**；**上一版此格写「否」是假声明**     |
   | `sq`/`dq`/`tpl` | 否（字符串内容**原样保留**，只丢失引号边界 ⇒ 多扫不少扫） | ——                                                                                             |

   **三条残留**（同根因，均已实测复现、均有单测格钉着）：**(f1)** 误判块撞上其后真注释
   闭合符而被提前闭合 ⇒ 中间段被吞；**(f2)** 误判除法后正则体内以 `/` `/` 开头 ⇒ 进 `line`
   态吞到行尾（含同一行违规）；**(f3)** 被误判成正则起点的 `/` 在**同一行内**撞上后一个
   未转义 `/`（真除法、字符串里的斜杠均可）⇒ `re` 态闭合并把两端之间整体替换为等长空白
   ⇒ 夹在中间的违规静默消失（实测 `let r = i++ / 2 ; LOG_FILE = '…'` 违规**不可见**）。
   **(f3) 与另两条的差别**：它**不需要正则字面量**，触发面只需「`/` 左侧字符落在
   `REGEX_PRECEDER_CHARS`（如 `++`/`--` 的第二字符、`}`）且同行另有 `/`」；
   (f1)/(f2) 才需要「字符类内含 `/` 或 `*` 的正则 + 其左侧是 `)`/`]`/标识符」。
   三条仓内当前均 0 处 ⇒ 潜伏。**彻底收口 = 换真 JS 解析器剥注释**（如 `acorn`）——
   属**新增依赖**，未在派活单范围内，不擅自引入；**是否立单请店长裁**。
   **本轮的处置 = 只修声明与钉洞，不动代码**（审查者裁决：词法层无法区分「真正则」与
   「误判的除法 + 后续斜杠」，故代码修法随方案层裁决一起收口；见 §四-9.1）。

---

## 五、缺口回报（请店长裁 / 挂后续单）

### 1. 【首版阻断项 —— 店长裁 A′，已落地】

**现象（实测，非推演）**：`packages/server/vitest.config.ts:28` 也设了一份
`RESTART_FILES_DIR: 'node_modules/.cache/restart-test'`（相对路径）。改根配置**对它无效**：

- **探针实验**：把根配置的 `RESTART_FILES_DIR` 临时改成哨兵值
  `node_modules/.cache/ROOT-WINS-PROBE` ⇒ server 项目的用例
  「重启机制文件路径被隔离到 …」**仍然通过**（它断言路径含 `restart-test`）
  ⇒ 生效的是 server 包的值，根配置被覆盖。
- **行为实验**：改后跑 `--project @cat-study/server -t "【重启请求】前缀消息"`（一个真会写请求文件的用例）——
  - 主仓库共享面 `…/catStudy/node_modules/.cache/restart-test` 的 mtime 由 `08:16:42` → `08:26:36`（**被写**）；
  - 本会话 worktree 经新配置派生的隔离目录 `…\Temp\cat-study-vitest\eed1edd5d355\restart-test`
    **未被创建**。

**店长复核后认定缺口比首版报告更宽**（不止配置面那一处默认值：全仓同型写点 9 处，其中
`scripts/graceful-stop.test.js:20` 虽是绝对路径但经 `__dirname` 落 junction 共享面），
**裁 A′**：restart 族 9 处全收 + `LOG_FILE` 两处另立单。

**收口状态**：✅ 已按 A′ 落地，**实际收口 10 处**（第 10 处见 §三之二 V13）。
读数：V12 双模式同解、V13 跨根并发 4 轮双绿（对照 4/4 红）、V14 护栏 10 用例 + 反向对照。
`pnpm test` 122 文件 / 2473 用例全绿；`pnpm lint` 3 包绿。

### 1b. 【新发现·边界事实】同根并发不被 A′ 覆盖

**一句话**：A′ 的派生键是**仓库根** ⇒ 同一个 worktree 里的两个 vitest 进程算出**同一个**隔离目录，
仍互删。读数、机制、准确边界与最小修法见 **§三之二「V13-补充」**。
**请店长裁**：本票口径（票面「依赖」段把同根并发归 T-2 Phase I）vs 派活单口径
（「两猫在同一个 worktree 里并发提交不互踩」）不一致，按哪个收口？

### 2. 其余落在 junction 共享面的写点（**首版状态 → A′ 后状态**）

> 行号一律 **`git grep -n` 字节路径复核**；括注「改前 `:N`」的是首版报告里的行号（改动后已漂移）。

| 位置（改后）                                                         | 改前            | 首版值                                                                             | A′ 后状态                                                             |
| -------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/server/vitest.config.ts:52`                                | `:28`           | `RESTART_FILES_DIR` 相对路径                                                       | ✅ **已收口**（改值不删行）→ `resolve(ISOLATION_ROOT,'restart-test')` |
| `restart-request.test.ts:138`                                        | `:136`          | `stubEnv` 相对路径                                                                 | ✅ **已收口** → `isolatedTestDir('restart-test-create')`              |
| `shutdown-request.test.ts:20`                                        | `:17`           | 同上                                                                               | ✅ **已收口** → `isolatedTestDir('restart-test-shutdown')`            |
| `routes/messages.test.ts:32`                                         | `:29`           | 同上（`process.env` 赋值）                                                         | ✅ **已收口**（factory 内动态 import 取 helper）                      |
| `routes/config.test.ts:20`                                           | `:16`           | 同上                                                                               | ✅ **已收口** → `isolatedTestDir('restart-test-context-config')`      |
| `routes/config-summary.test.ts:16`                                   | `:14`           | 同上                                                                               | ✅ **已收口** → `isolatedTestDir('restart-test-env-patch')`           |
| `routes/connectors.test.ts:606` / `:704`                             | `:605` / `:703` | 同上                                                                               | ✅ **已收口** → `isolatedTestDir('restart-test-napcat{,-config}')`    |
| `routes/connectors.test.ts:882`（`browseTmpDir`）                    | ——              | **首版漏列**：`path.join('node_modules','.cache',…)` 拆成两个字面量                | ✅ **已收口**（**V13 实跑抓出**，静态扫漏）                           |
| `scripts/graceful-stop.test.js:22`                                   | `:20`           | `resolve(__dirname,'../node_modules/.cache/graceful-stop-test')`（绝对但落共享面） | ✅ **已收口** → `isolatedTestDir('graceful-stop-test')`               |
| `packages/server/vitest.config.ts:57`、`scripts/vitest.config.ts:11` | 同              | `LOG_FILE` 相对路径                                                                | ⬜ **未收口**（店长裁「另立单」，见 §四-6；V14 白名单已列理由）       |

### 3. 契约文本与实现的落差（已在实现层消化，无需裁决，仅留痕）

- 票面 §2.2 的 CLI 示例写作 `npx vitest run --project <p1> --project <p2> …`（`<p>` 即 `projects`
  的元素），但实测这四个字符串**不是** vitest 的 project 名。已在 CLI 加 `projectNameOf()` 映射
  （单源 = 各包 `package.json` 的 `name`，无 `package.json` 的 `scripts` 回落目录名），
  **`resolveScopes` 的返回契约一字未动**，并补了 2 条映射护栏（包改名失配时 fail-loud：vitest
  报 startup error，不是静默跑错 project）。
- 票面「决策留痕」要求实测的 `docs/run/**` 消费者面，已在本报告 §四-3 逐条核完（14 个命中文件全为
  注释 / 路径判据常量 / 测试自建临时仓夹具，**无一处读真实内容**）——结论：§2.1 无漏行，无需改表。

### 4. 【新·请店长裁】V14 护栏要不要进「改 packages 的提交口」

**现象**（审查 P2-2 指出，本笔已按「修正声明」处理，未改代码）：护栏落在 `scripts` project，
而 `precommit-scope.resolveScopes` 把 `packages/server/**` 只映射到 `@cat-study/server` ⇒
**在 server/web 测试里敲相对路径（最常见的漏网形态）时，提交口不跑护栏**，只有审查档 / 落地档
的全量才跑。

**为什么没自行修**：让 `packages/**` 的 scope 也带上 `scripts` project，是 `resolveScopes`
返回语义的变更（scope 与 project 不再一一对应），越出派活单「不碰 `resolveScopes` 契约」的边界。

**两个选项**：

| 选项                                                                   | 代价                                                                 | 收益                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **A（维持现状）**：护栏只在审查/落地档全量跑，声明已改为如实           | 提交口漏网形态要靠审查档兜（审查档本就是本票的中间档，不是没有兜底） | 提交口保持「只跑被测包」的最窄形态，不增加任何提交耗时             |
| **B**：`packages/server/`、`packages/web/` 的 scope 映射追加 `scripts` | 每次改 server/web 的提交多跑 scripts project（251 用例，实测 ~4.4s） | 类级护栏回到**提交口**，与它「防新写测试顺手敲相对路径」的立意一致 |

**倾向**：本笔按 A 落地（只改声明），因为 B 是 scope 语义变更需架构裁决；若裁 B，改动量 = `SCOPE_PREFIXES`
一张表 + `precommit-scope.test.js` 若干格，可单独一笔。

---

## 六、红线自查

| 红线                                                                                   | 状态                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不 `--no-verify`、不绕门禁                                                             | ✅ 全程未用                                                                                                                                                 |
| 不 `git add -A`、限定路径 add + `diff --cached --name-only` 核对、不用 `commit --only` | ✅ 每次提交前核对                                                                                                                                           |
| 临时产物落 `os.tmpdir()`                                                               | ✅ V8 探针与副本、V7 对照产物、V12 双模式探针、V14 种植探针（`scripts/tmp-guard-probe.js`）均在 `os.tmpdir()` 或**跑完即删**；`git status` 无残留未跟踪文件 |
| 测试出 git 剥注入变量                                                                  | ✅ `precommit-scope.mjs` 的 `git diff --cached` 走 `cleanGitEnv()`；单测不触 git                                                                            |
| 不 push                                                                                | ✅ 未 push                                                                                                                                                  |
| 缓存路径不落仓库内                                                                     | ✅ 派生自 `os.tmpdir()`；V14 有静态护栏守着（白名单外违规 0）                                                                                               |
| 改契约先报店长                                                                         | ✅ 首版 §五-1 报请裁决后再动；A′ 交付面按派活单一字未扩（第 10 处同型、同文件、同病灶，按承诺收口）                                                         |
| 行号 grep 复核                                                                         | ✅ 本报告所有 `file:line` 均以 `git grep -n` 字节路径核对                                                                                                   |

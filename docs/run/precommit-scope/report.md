# 报告：pre-commit 测试门禁三档收窄

> 票面 `docs/run/precommit-scope/tickets.md`（`89681b0`）。实施 2026-09-16。
> 交付面 = 票面 §1.1 四文件 + 本报告。验收 = §三 V1–V11 逐条留痕（下）。

## 结论先行

1. **交付面 4 文件全部落地，V1–V11 逐条有读数**（§三）。全量入口未改窄：`pnpm test` 仍是
   **121 文件 / 2463 用例**（= shared 3 + server 88 + web 18 + scripts 12，四个 project 全跑），全绿。
2. **两条票面契约与实测不符**，均按「不擅改契约、就地补实现层」处理，并在此显式回报（§五）：
   - **① scope 名 ≠ vitest project 名**。票面 §2.2 的 `projects` 形状是仓根相对路径，而
     `vitest --project` 认的是 project 名（实测 `--project packages/server` ⇒ `Startup Error:
No projects matched the filter`）。CLI 侧加 `projectNameOf()` 映射层消化，`resolveScopes`
     的返回形状**一字未动**。
   - **② 根 `vitest.config.ts` 的 `test.env` 被 `packages/server/vitest.config.ts` 覆盖** ——
     票面「缓存隔离是本票的硬前提」在 **server 项目上零效果**（实测见 §五-1）。**此处越出票面
     边界（§派活单「不碰 `packages/**`」）故未自行扩面，请店长裁。**
3. 生产行为零变化：只碰 `.husky/pre-commit`、`vitest.config.ts`、`scripts/`（新增 1 脚本 + 1 测试）。

---

## 一、交付物

| 文件                                 | 动作 | 说明                                                                               |
| ------------------------------------ | ---- | ---------------------------------------------------------------------------------- |
| `scripts/precommit-scope.mjs`        | 新建 | 纯函数 `resolveScopes` + `projectNameOf` + CLI 薄壳                                |
| `scripts/precommit-scope.test.js`    | 新建 | 42 用例：§2.1 逐行 + 并集 + 空列表 + fail-closed + 映射                            |
| `.husky/pre-commit`                  | 修改 | 第三行 `pnpm test` → `node scripts/precommit-scope.mjs`（前两行与 `unset` 行原样） |
| `vitest.config.ts`                   | 修改 | `cacheDir` / `RESTART_FILES_DIR` → `os.tmpdir()` 下的按仓库根派生绝对路径          |
| `docs/run/precommit-scope/report.md` | 新建 | 本文件                                                                             |

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
 Test Files  121 passed (121)
      Tests  2463 passed (2463)
```

**121 = 3(shared) + 88(server) + 18(web) + 12(scripts)** ⇒ 四个 project 全跑、全绿。
`pnpm lint` 亦绿（`node scripts/lint.js`：shared/server tsc + web vue-tsc，3 包通过）。

### V11 钩子仍剥 env

- `.husky/pre-commit:6` 的 `unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX` **原样保留**，
  且仍在 `npx lint-staged` 之前（`pre-commit-env.test.js` 的「落点」用例即钉此序）。
- `scripts/pre-commit-env.test.js` 单跑：**3 passed**（该用例直接重放钩子里抽出的 `unset` 行 ⇒
  删行必红）；全量跑批中亦绿。
- `npx lint-staged` / `pnpm lint` 两行**原样保留，含行序**。

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

4. **其他落在 junction 共享面的相对路径写点未修**（不在票面交付面）——见 §五-2。

---

## 五、缺口回报（请店长裁 / 挂后续单）

### 1. 【阻断本票目标】根 `vitest.config.ts` 的 `test.env` 被 `packages/server/vitest.config.ts` 覆盖

**现象（实测，非推演）**：`packages/server/vitest.config.ts:28` 也设了一份
`RESTART_FILES_DIR: 'node_modules/.cache/restart-test'`（相对路径）。改根配置**对它无效**：

- **探针实验**：把根配置的 `RESTART_FILES_DIR` 临时改成哨兵值
  `node_modules/.cache/ROOT-WINS-PROBE` ⇒ server 项目的用例
  「重启机制文件路径被隔离到 node_modules/.cache」**仍然通过**（它断言路径含 `restart-test`）
  ⇒ 生效的是 server 包的值，根配置被覆盖。
- **行为实验**：改后跑 `--project @cat-study/server -t "【重启请求】前缀消息"`（一个真会写请求文件的用例）——
  - 主仓库共享面 `…/catStudy/node_modules/.cache/restart-test` 的 mtime 由 `08:16:42` → `08:26:36`（**被写**）；
  - 本会话 worktree 经新配置派生的隔离目录 `…\Temp\cat-study-vitest\eed1edd5d355\restart-test`
    **未被创建**。

**影响**：票面「结论先行 2」说「缓存隔离是本票的硬前提，不修这条收窄是空转」——这条**在 server
项目（测试量最大的 88 文件、跨猫冲突的主要来源）上没有达成**：两个 worktree 并行跑 server 测试时，
`node_modules/.cache/restart-test` 仍是同一批物理文件，而 `socketio.test.ts` 的 `afterEach`
会 `unlinkSync` 这些文件 ⇒ **会删掉另一个 worktree 正在用的请求文件**（票面点名的正是这个形态）。

**为何未自行修**：派活单边界明写「**不碰 `packages/**`**」，且票面红线 7「改契约先报店长，不自行扩表」。
最小修法（若裁「扩」）= 把 `packages/server/vitest.config.ts:28` 同款改为从 `os.tmpdir()` 派生的
绝对路径（末段保留 `restart-test`，`socketio.test.ts:336` 的断言继续成立），交付面由 4 文件变 5 文件。

**顺带**：`packages/server/vitest.config.ts:33` 与 `scripts/vitest.config.ts:11` 的
`LOG_FILE: 'node_modules/.cache/test-logs/cat-study-test.log'` 同属这一类（见下条）。

### 2. 其余落在 junction 共享面的写点（同根因，未修）

| 位置                                                                                                                                                                                            | 值                                                               | 影响                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/server/vitest.config.ts:28`                                                                                                                                                           | `RESTART_FILES_DIR` 相对路径                                     | 见上条（阻断级）                                                                                    |
| `packages/server/vitest.config.ts:33`、`scripts/vitest.config.ts:11`                                                                                                                            | `LOG_FILE` 相对路径                                              | 两 worktree 测试日志交错于同一文件（`logger.test.ts:242` 断言的是 `path.resolve()` 结果，未受影响） |
| `restart-request.test.ts:136`、`routes/messages.test.ts:29`、`shutdown-request.test.ts:17`、`routes/config.test.ts:16`、`routes/connectors.test.ts:605/703`、`routes/config-summary.test.ts:14` | 测试内 `stubEnv` 的相对路径                                      | 同型（各自后缀不同 ⇒ 同仓库内不互撞，跨 worktree 仍撞）                                             |
| `scripts/graceful-stop.test.js:20`                                                                                                                                                              | `resolve(__dirname,'../node_modules/.cache/graceful-stop-test')` | 同上                                                                                                |

判据：这些**都不在**票面 §1.1 交付面内，本票按边界不动。是否一并收口请店长裁（可挂后续单）。

### 3. 契约文本与实现的落差（已在实现层消化，无需裁决，仅留痕）

- 票面 §2.2 的 CLI 示例写作 `npx vitest run --project <p1> --project <p2> …`（`<p>` 即 `projects`
  的元素），但实测这四个字符串**不是** vitest 的 project 名。已在 CLI 加 `projectNameOf()` 映射
  （单源 = 各包 `package.json` 的 `name`，无 `package.json` 的 `scripts` 回落目录名），
  **`resolveScopes` 的返回契约一字未动**，并补了 2 条映射护栏（包改名失配时 fail-loud：vitest
  报 startup error，不是静默跑错 project）。
- 票面「决策留痕」要求实测的 `docs/run/**` 消费者面，已在本报告 §四-3 逐条核完（14 个命中文件全为
  注释 / 路径判据常量 / 测试自建临时仓夹具，**无一处读真实内容**）——结论：§2.1 无漏行，无需改表。

---

## 六、红线自查

| 红线                                                                                   | 状态                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 不 `--no-verify`、不绕门禁                                                             | ✅ 全程未用                                                                      |
| 不 `git add -A`、限定路径 add + `diff --cached --name-only` 核对、不用 `commit --only` | ✅ 每次提交前核对                                                                |
| 临时产物落 `os.tmpdir()`                                                               | ✅ V8 探针与副本、V7 对照实验产物均在 `os.tmpdir()`；仓库内零新增未跟踪文件      |
| 测试出 git 剥注入变量                                                                  | ✅ `precommit-scope.mjs` 的 `git diff --cached` 走 `cleanGitEnv()`；单测不触 git |
| 不 push                                                                                | ✅ 未 push                                                                       |
| 缓存路径不落仓库内                                                                     | ✅ 派生自 `os.tmpdir()`                                                          |
| 改契约先报店长                                                                         | ✅ §五-1 未自行扩表，报请裁决                                                    |

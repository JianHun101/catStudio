# 票单 · memory-flywheel

> 规格地图见同目录 `map.md`（grilling 产出，Decisions 1–25 为已裁结论）。
> 本文件只放**可派活的票单**——一票一段，含边界 / 契约 / 验收 / 决策留痕。
> 规矩（承 `docs/run/README.md`）：活收口即清，结论上浮到 `docs/plans/` 或 `docs/sessions/`。

---

## 票乙 · 审查兜底交付物闸 + `docs/run/**` 免审白名单

**状态**：**已收口**（spec-gate 2026-09-11 → 派活 flash猫 → 审查回炉修订 → 实施落 dev）
**收口证据（2026-09-12 复核）**：`3b62dbe` feat(scripts): handoff 免审白名单（票乙）+ `8c20dc3` fix(scripts): 免审豁免前置换 `CATSTUDY_FORCE_DELIVER`（原信号在猫环境常驻致豁免恒不生效）——**两笔均已在 dev 上**（`dev` = `origin/dev` = `.push-gate` = `3ef3640`）。**真机生效**：同会话连续 7 次 `docs/run/**` 提交被判静默（`[handoff-gen] ⏭️ ... 改动全在免审前缀内`）。
**⚠️ 待上浮**：按本文件第 5 行规矩「活收口即清」，票乙应从本文件移除、结论上浮到 `docs/plans/` 或 `docs/sessions/`。**本轮未执行**（无对应活文档承接），留作下一轮收口动作——**在此之前以「已收口」状态保留，勿再派活**。
**承**：map Decisions 15（免审白名单 = `docs/run/` 一个前缀）/ 18（回环阻塞）/ 25（落点修正）
**动机**：地图落盘（`docs/run/**` 提交）每轮触发一条无意义审查请求 → 噪声 + 唤醒回环。

### 目标（可证伪）

一个 commit 的改动路径**全部**落在 `docs/run/` 前缀内时，handoff 投递判定为**静默**：
不 POST 任何审查请求、不记 delivered 账本、stdout 留一行痕。存在反例即未满足——
只要有一条纯 `docs/run/**` 提交仍发出审查请求，本票即失败。

### 边界

**In Scope**

- `scripts/handoff-gen.mjs`：免审前缀常量 + 导出纯函数 `isExemptDelivery(paths)` + 内部 helper `changedPathsOf` + 在 `deliverSha` **单点**接入
- `scripts/handoff-gen.test.js`：纯函数单测
- `scripts/handoff-gen.e2e.mjs`：端到端一组（stub server 计数）

**Out of Scope（钉死，防扩线）**

- **不改** `packages/server/**`（原拟落点 `review-fallback.ts` 已推翻，见 map Decisions 25）⇒ **零 server 改动、零重启**
- **不改** `.husky/pre-push`、`.husky/post-commit`、`packages/server/src/git/git-utils.ts`（auto-commit）
- **不实现「免审且可直接推」**——pre-push 仍按「已审历史」拦。免的是**独立审查轮**，不是上远端（承 Decisions 25 诚实标注）
- **不新增状态文件**、**不给账本加「已静默」态**（承 T-A 复盘：加了会连「收尾兜底 spawn 失败」时最后一道网一起关掉）
- **不扩前缀清单**——只有 `docs/run/` 一个前缀
- **不改** `.handoff-draft.md` 的清理时机：命中后草稿仍留盘，与既有归属静默同款；该文件已在 `.gitignore:58` ignore，无扫走风险

### 契约（接口钉死）

**C1 · 常量**

```js
export const REVIEW_EXEMPT_PREFIXES = ['docs/run/']
```

前缀**必须带尾斜杠**——这是 `docs/run-x/a.md` 不得命中的唯一保证。

**C2 · 纯判据（导出，可单测；不碰 I/O）**

```js
export function isExemptDelivery(paths) -> boolean
// true  ⇔ Array.isArray(paths) && paths.length > 0
//         && paths.every(p => REVIEW_EXEMPT_PREFIXES.some(pre => p.startsWith(pre)))
// false ⇔ 其余一切（含 null / undefined / 空数组）
```

**空数组必须判 false**——`every` 对空集恒真，是陷阱（上游 `:136-140` 已对空 diff 早退，此处不依赖它）。

**C3 · 路径获取（内部 helper，不导出）**

```js
function changedPathsOf(cwd, fullSha) -> string[] | null
```

- 实现：`parseChangedFiles(git(cwd, \`diff --name-status ${fullSha}~1..${fullSha}\`)).map(f => f.path)`
- 复用既有 `parseChangedFiles`（`:295`，rename `R100\told\tnew` 取**新路径**）——不另写解析器
- 任何异常 → `null`
- **`null` ⇒ 不豁免（照常投递）**——与 `decideHookDelivery(null)`「判据查不动一律投递」同款精神，静默只在判据明确时发生

**C4 · 接入点（唯一一处）**

`deliverSha`（`:1453`）内、`state.delivered` 早退块**之后**、`tryPostToCatstudy` 调用**之前**：

```js
const paths = changedPathsOf(cwd, fullSha)
if (!isForceDeliver(process.env.CATSTUDY_FORCE_DELIVER) && isExemptDelivery(paths)) {
  console.log(
    `[handoff-gen] ⏭️  ${fullSha.slice(0, 7)} 改动全在免审前缀内（${paths.join(', ')}）` +
      `——静默，不投递（连带跳过 commit_hash 写回）`
  )
  return 'skip'
}
```

- **为什么落在 `deliverSha`**：全部 **4 个调用点**——post-commit（`:1625`）/ `--gate-deliver`（`:1574`）/ `--fallback-sha`（`:1555`）/ `drainPending`（`:1516`）——都经此 ⇒ **一处判、全覆盖**。放 CLI 三个分支则漏掉 `drainPending`（它被 post-commit 与 gate-deliver 两条路径共用）。
- **前置开关 = `CATSTUDY_FORCE_DELIVER`**：显式意图 > 自动豁免，但信号源**审查回炉已换**——首版写的是 `!process.env.CATSTUDY_SESSION_ID`，该 env 是 server 注入给**每只猫 CLI 的常驻变量**（`llm/claude.ts:361` / `opencode.ts:91` / `dsh.ts:94`），而钩子（裸 `node` 调用）全量继承它 ⇒ 前置在产品路径上**恒为假**，免审豁免等于不存在。改用**钩子永不设**的专用开关（人工 shell 显式 export 才为真，取值只认 `1`/`true`）。
- **已知代价（留痕，非漏改）**：本早退同时跳过 `attemptDeliver` 的 **commit_hash 写回**（同文件 `:1262` 声明「静默路径也要记 commit_hash」）。免审提交不进审查链，这条链锚无消费方；下游若另有依赖属架构面（挂 OQ3 交店长裁）。
- **返回既有 `'skip'` 而非新值**：与归属静默同一语义（非错误、不记账本，见 `:1472-1477` 既有契约）。
- **留痕 = stdout 一行**，含关键词 `免审`（可 grep）；不新增文件、不写状态。

### 验收（逐条可执行）

| #   | 验收项                | 判据                                                                                                                                                                                                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 纯判据单测            | `scripts/handoff-gen.test.js` 新增 6 条：① 单路径全命中 → true ② 混合路径 → false ③ `docs/run-x/a.md` → false ④ `[]` → false ⑤ `null` / `undefined` → false ⑥ 深层 `docs/run/memory-flywheel/map.md` → true                                                   |
| A2  | rename 取新路径       | 单测：`parseChangedFiles("R100\tdocs/old.md\tdocs/run/new.md")` → 路径为 `docs/run/new.md`                                                                                                                                                                    |
| A3  | 全量测试绿            | `pnpm test` 全绿；既有 `scripts/handoff-gen.test.js`（248 行）断言一条不删不弱                                                                                                                                                                                |
| A4  | 端到端 · 命中判静默   | `handoff-gen.e2e.mjs` 新增组：临时 repo 造**纯 `docs/run/**` commit**；stub server **计数 POST**；`--fallback-sha <sha>` → **POST 计数 = 0** + stdout 含 `免审` + exit 0。**两条形态**：16a（env 未设）/ **16d（`CATSTUDY_SESSION_ID` 常驻 = 猫的真实环境）** |
| A5  | 端到端 · 非命中不回归 | 同组：混合 commit（`docs/run/a.md` + `packages/server/src/x.ts`）→ **POST 计数 = 1**                                                                                                                                                                          |
| A6  | 端到端 · 旁路优先     | 同组：命中 sha + `CATSTUDY_FORCE_DELIVER=1` → **POST 计数 = 1**（显式意图不被白名单吞；16e 再验「生产形态 + 开关并存」）                                                                                                                                      |
| A7  | 零 server 改动        | `git diff --name-only` 不含 `packages/server/**`；交付说明「无需重启」                                                                                                                                                                                        |

**签收判据**：A1–A7 全过 + 实施者自报「未触碰 Out of Scope 清单任一项」。

**修订（审查回炉 · 2026-09-11）**：首版不合规项 = 前置信号源选错（`CATSTUDY_SESSION_ID` 常驻 ⇒ 豁免在生产路径恒不生效，A4 的原始判据只在 `env -u` 下为真——**验证面不是被判面**）。已改：C4 前置换 `CATSTUDY_FORCE_DELIVER`；A4 增加 16d（生产形态回归）；A6 换开关；新增静态源断言防回退（`handoff-gen.test.js`：「豁免判据行不得含 `CATSTUDY_SESSION_ID`」）。**A1/A2/A3/A5/A7 未变**。

### 决策留痕

- 跳 grilling：本票形态在 `map.md` 经 Q2/Q3/Q6 多轮 grilling 已裁（Decisions 15/18/25）→ 故本单不单跑 grill
- Gate B 契约：[边界=In/Out Scope 双向钉死如上 / 契约=C1–C4 接口签名 + 接入点唯一 / 验收=A1–A7 逐条可执行]
- 落点修正留痕：原拟 `packages/server/src/execution/review-fallback.ts` 经取证推翻→ `scripts/handoff-gen.mjs`，理由见 map Decisions 25（server 侧拿不到路径清单，且该文件明确回避在收尾路径开同步 git 子进程）
- 本票过门记录：Gate Report 见 map Decisions 26

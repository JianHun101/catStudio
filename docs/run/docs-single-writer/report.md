# 票 `docs-single-writer` 实施报告

> 交付：`scripts/closeout-dupcheck.mjs`（362 行）、`scripts/closeout-dupcheck.test.js`（422 行）、
> `CONTEXT.md`（「流程约定」+3 条）。范围与边界见 `tickets.md` §一/§四。
>
> **本文所有行号一律对「提交后」的 blob**（lint-staged 的 prettier 会在 commit 期重排源码行，
> 按提交前的工作区取证必偏——本票首版提交信息的行号就是这么偏的，已 amend 更正）。
> 复核走字节级 oracle：`git grep -n <sha> -- <path>`，勿用 PowerShell 文本管道。

## 结论先行

三条交付面全落，§三 验收 9 条全过，`pnpm lint` + `pnpm test` 全绿（**123 文件 / 2499 用例**，
基线 122/2478，+1 文件 / +21 用例即本票新增）。**零 `packages/**` 改动**，脚本只读仓。

**两处需店长知情的判断**（都落在契约留白里，未改判据，红线 6 未触发）：

1. **`Δ` 取「端点净差集」（`git diff base <ref>`），不取「提交日志触及集」**——票面 §2.1 写
   `base..A 触及的文件集合`，`..` 在 `git diff` 里就是两端点之差，两种读法都合字面。选净差的
   理由与后果见 §四.1。
2. **「判据无面」单列一态**：`dev` 是会话分支祖先时两侧无分叉，脚本 `exit 0` 但必打 stderr 警示。
   不加这一态，票面 §2.2 那条**裸命令**在本仓当前拓扑下每次都给「✅ 无重复落盘」，是假绿门。

---

## 一、§三 逐条读数

| 条目                   | 读数                                                                                                                                                 | 证据                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **V1 受控正例**        | 命中 `docs/dup.md`，两侧 blob 同为 `6d4d43ae…`，`exit 1`                                                                                             | `closeout-dupcheck.test.js:152-187`（3 用例） |
| **V2 反例·blob 不同**  | 交集非空（`common=['docs/x.md']`）但 `hits=[]`、`skipped=[]`，`exit 0`                                                                               | `:191-220`                                    |
| **V3 反例·单侧**       | 两侧各有提交、交集为空 ⇒ 不命中（`vacuous=false`，故非「无面」掩盖）                                                                                 | `:222-248`                                    |
| **V3b 收口记录豁免面** | 两侧**都**在 Δ 里、一侧删除 ⇒ 落 `skipped` 不进 `hits`                                                                                               | `:233-247`                                    |
| **V4 反例·无交集**     | 交集空、`hits=[]`、`exit 0`（零命中路径的 exit code）                                                                                                | `:250-267`                                    |
| **V5 反向对照**        | **真变异源码**：判据行 `===` 改 `!==`，变异副本 import 后 V1 **变红**（`hits` 由 1 → 0），且 `common`/`vacuous` 不变（排除「变异把模块改坏」的伪红） | `:271-319`（4 用例）                          |
| **V6 输出可定位**      | `exit 1` + stderr 含路径 + **两侧完整 40 位 blob sha**；零命中时 stdout 含 `✅`                                                                      | `:178`（命中半）、`:262`（零命中半）          |
| **V7 真仓读数**        | 见 §二（指定读数 + 5 条非空集读数）                                                                                                                  | 手工留痕，不入套件（见 §四.3）                |
| **V8 闸绿**            | `pnpm lint` 3 包通过；`pnpm test` **123 文件 / 2499 用例全绿**                                                                                       | 本轮实测                                      |
| **V9 沙箱卫生**        | 见 §三                                                                                                                                               | `:381-422`（4 用例）                          |

**V5 的做法说明**：不是「另写一个反判据与实现比对」——那证明的只是测试自己。做法是把**被测源码**
读进来、把判据行替换成 `!==`、把相对 import 改写成绝对 `file://` URL（免拷依赖链），落到
`os.tmpdir()` 再 `import()`。测试先断言该判据行在源码里**唯一存在**（`:275-278`）——替换面
一旦漂移，本组立刻变红而不是静默退化成假绿。

---

## 二、V7 真仓读数

### 2.1 票面指定的那一跑

```
$ node scripts/closeout-dupcheck.mjs --a dev --b session/4c8acf70
[closeout-dupcheck] a=dev@2b349ef b=session/4c8acf70@a104e27 base=2b349ef ΔA=0 ΔB=1 交集=0 命中=0
[closeout-dupcheck] ✅ 无重复落盘（ΔA ∩ ΔB 上无 blob 相同项）
[closeout-dupcheck] ⚠️  判据无面：dev 是 session/4c8acf70 的祖先（无可合并的分叉）⇒ 无重复落盘的可能面。
                    本次**没有**对账任何文件——这不是「检查通过」，只是无面可查
exit 0
```

**这一跑是「无面」，不是「干净」**：本票工作期间 `dev` 是会话分支的祖先，两侧根本没有分叉，
`ΔA=0` ⇒ 交集恒空。**读数留在这里，但不得当成本脚本的阳性证据**。

### 2.2 补的非空集读数（**我加的，非票面要求**）

指定那跑证明不了脚本会跑，故对**本仓真实分叉**的会话分支实跑 6 次（全部只读）：

| A   | B                | base      | ΔA  | ΔB  | 交集 | 命中              | exit |
| --- | ---------------- | --------- | --- | --- | ---- | ----------------- | ---- |
| dev | session/0eb66b63 | `0ca73cf` | 122 | 3   | 3    | **1**             | 1    |
| dev | session/2b40f323 | `873d86b` | 260 | 12  | 12   | **4**             | 1    |
| dev | session/6f8d27d4 | `b12e858` | 276 | 2   | 2    | 0                 | 0    |
| dev | session/9b11861d | `8c20dc3` | 213 | 1   | 1    | 0（1 处 skipped） | 0    |
| dev | session/af97bcf8 | `2c5c8ca` | 270 | 7   | 7    | 0（3 处 skipped） | 0    |
| dev | session/e896dd06 | `eb5753c` | 85  | 1   | 1    | 0                 | 0    |

**5 处真阳性**（脚本在真实数据上抓到了它要抓的形态）：

```
docs/run/eval-system/P1-a2-no-reply-guard.md   dev 12ab58f 8e48564 ／ 会话 6595f75 6172653
CLAUDE.md                                      dev 6656383             ／ 会话 56d8116
packages/server/src/execution/token-pool.test.ts  dev 7e09542          ／ 会话 39ef99c
skills/to-spec/SKILL.md                        dev 6656383             ／ 会话 f136e17
skills/to-tickets/SKILL.md                     dev 6656383             ／ 会话 c2ac95b f136e17
```

两侧 blob 逐字节相同（脚本打印两组等值 sha 即为证）。**按票面 §一.2「不回溯存量」，这些一律
不修、不改**——它们全部在**未合并**的会话分支上，不影响 `dev`。列出只为证明判据非空转。
其中 `CLAUDE.md` 那笔正是票面 §2.2 所说「两个写入口」的形态：两侧各写一遍同一段。

---

## 三、V9 沙箱卫生读数

1. **临时仓落 `os.tmpdir()`**：断言 `realpathSync(tmpdir())` 前缀成立，且**不在**仓库根下
   （红线 1）。本轮跑完 `ls -d .closeout-* handoff-test-* wt-*` 于仓库根 ⇒ 无残留。
2. **剥注入变量（真注入真跑）**：CLI 注入 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
   `GIT_COMMON_DIR` 指向**外层仓库的真 gitdir**（`--git-common-dir` 解析，测试内断言它非空
   且不落在沙箱里——否则「注入无效」会让这格恒绿），读数与未注入时**逐字相同**（`exit 1` +
   路径 + 沙箱 base sha）。
   **真空性反对照（探针必须能失败）**：另跑一条不剥 env 的探针对照，`git rev-parse --verify
branchA^{commit}` 被劫持到外层仓、`exit 1` ⇒ 注入确有让 ref 解析失败的能力，本格有判别力。
3. **结构不变量（静态源断言）**：全源 `execFileSync` **只出现 1 次**（唯一 git 出口 = 唯一
   `cleanGitEnv()` 施加点）；源码无 `'checkout'/'reset'/'commit'/'add'` 字面量（红线 3 只读）。

---

## 四、覆盖边界自陈

### 1. `Δ` 是端点净差集，不是提交日志触及集

`Δ` 由 `git diff --name-only -z <base> <ref>` 得出（`:112-115`），**不是** `git log` 的文件集。
可辨差异只有一处：**一侧「加了又删」净归零**时该文件不进 `Δ`。判断依据是**本脚本防的害**：
「两侧最终内容相同 ⇒ 3-way 静默吞一笔」。净归零的路径在那一侧**根本没有最终内容**，没有可被
吞的笔——它进判据只会靠 `rev-parse` 取不到 blob 而落 `skipped`，结论相同、白跑一趟。故取净差。
**若店长认为应付该形态，须改判据、走红线 6 报批**，我不擅自放宽。

### 2. 「两侧各有 ≥1 笔提交」这条 `且` 是冗余的机械复核

在净差语义下，文件进 `Δ` 已蕴含该侧有提交触及它，故该条**判不出任何额外东西**。保留它有两个
真实作用：① 判据语义完整（报警 = 两侧**各自落过笔**，而非「恰好同内容」）；② 它是
`commitsA`/`commitsB` 两个读数的产生处，命中时打印出来，收口方才有得 `git show` 去裁决保留
哪一侧。**不谎称它抓到了什么**——它今天没抓到任何东西。

### 3. V7 不进测试套件

非 hermetic：读数随仓状态变，进套件等于把 CI 绑死在某次快照上（且本仓今日的真阳性明天就消失）。
按票面 §三 的要求以**报告留痕**形式交付。

### 4. 不做/不碰（票面 §一.2 + 红线）

不自动修复、不回溯存量、不改 auto-commit 与收口链代码、不 push、不 `git add -A`、不碰
`packages/**`、不动 `docs/run/README.md`。

### 5. 真阳性不影响 `dev`

§2.2 那 5 处全在**未合并**的会话分支上。本票**不做任何裁定**——保留哪一侧是收口方的活。

---

## 五、缺口回报（**未处理，交店长裁**）

1. **实测出 5 处存量重复落盘，全部未合并**（§2.2）。本票按「不回溯存量」不动。若这些会话分支
   将来要合回 `dev`，按新纪律须**先裁定保留哪一侧再合并**——`session/2b40f323` 一笔就含 4 处。
   是否要为这几条分支立后续单，请店长裁。
2. **`node:sqlite` 的 `ExperimentalWarning` 会随本脚本打到 stderr**：本脚本 import
   `cleanGitEnv` ⇒ 连带 import `commit-uuid-gate.mjs` ⇒ 连带 `node:sqlite`。脚本本身不碰库。
   与 `precommit-scope.mjs` 同源同现象（既有可接受），故**未动**——要消掉只能把 `cleanGitEnv`
   抽到独立小模块，那会改到 `commit-uuid-gate.mjs`（超出本票交付面，且属提交门禁代码）。
   现状影响：收口现场 stderr 多两行 node 警告，不影响 exit code 与读数。
3. **票面 §2.2 那条裸命令 `node scripts/closeout-dupcheck.mjs` 会撞 `exit 2`**：裸跑取默认
   `--a dev --b HEAD`，在**主工作区**（检出 `dev`）两个 ref 同 commit ⇒ 判据无主体、fail-loud。
   我判定这是**对的行为**（那个形态每次都「无命中」，正是假绿门），并在 `CONTEXT.md` 那条纪律里
   写全了显式形态 `--a dev --b session/<sid8>`。**未改票面**——如需把票面 §2.2 的裸命令一并对齐，
   请店长裁（票面是店长的写入面）。

---

## 六、复核入口（供审查者逐条重跑）

```bash
pnpm lint
node node_modules/vitest/vitest.mjs run --project scripts scripts/closeout-dupcheck.test.js   # 21 用例
pnpm test                                                                                      # 全量
node scripts/closeout-dupcheck.mjs --a dev --b session/4c8acf70                                 # V7 指定读数
node scripts/closeout-dupcheck.mjs --a dev --b session/2b40f323                                 # 真阳性（exit 1）
```

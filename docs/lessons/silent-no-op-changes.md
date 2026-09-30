---
type: lesson
date: 2026-09-30
status: proposed
evidence:
  - kind: commit
    ref: a037d80
  - kind: commit
    ref: 42bf1892
---

# 「看起来生效」的读数取自哪一层——改动没到达生效面的五种形态

## 通则

凡「看起来生效」的读数（exit 0 / 只打 WARN / `git status` 干净 / sha 不变 / 声明在位 /
纯函数绿），都要追问一句：**它的出口取自哪一层？** 出口层 ≠ 作用层 ⇒ 读数与「真生效」同形。
判据必须搬到**真正生效的那一层**（index 缓存 / 故障点 / 求值序 / 被实际消费的配置文件），
并配一条**能红的反对照**。

## 形态①：改了工作区，判的是 index 的 stat 缓存

一次剥工作区行尾 CR 的收尾：剥完 `git diff` **报零差异**（文件与 index blob 逐字节相同，
blob 本就是 LF），但 `git status` 把该批文件**全标 M**（成批幽灵 M）。

机制：**index 的 stat 缓存记的是剥离前（CRLF）的 size / mtime**，不是内容差异。

刷不动的四条（实测排除法）：

| 手段                                | 读数              | 结论                           |
| ----------------------------------- | ----------------- | ------------------------------ |
| `git update-index --refresh`        | rc=1，status 仍 M | 刷不动                         |
| `git add --refresh`                 | rc=0，status 仍 M | 刷不动                         |
| `git -c core.autocrlf=false status` | 仍 M              | **与属性 / autocrlf 语义无关** |
| 真 `git add <path>`                 | status 转干净     | **唯一有效通道**               |

那个 `git add` 是**内容无操作**（`rev-parse :path` 前后同值、`--cached` 为空、文件 `cmp` 一致）。
另外**不采用 `git add --renormalize`**——本仓 tracked blob 全是 LF，它是 **no-op**，
跑了只给人「已经修好了」的假象。

代价：只剥不 `add`，25 处 status 全显脏，而以「主工作区干净」为硬门禁的 worktree 创建脚本
此后**每次都会失败**。⇒ **「剥完 `git diff` 为空」不足以判干净。**

## 形态②：断言的「本仓」实际只覆盖取数的那棵树

票面断言「本仓 **0 个** tracked 二进制」，据此不加二进制项。该断言**只对主仓库成立**：
24 个存量 worktree 里有一棵带 **6 个 tracked PNG**，另有若干棵的同一文件在旧修订上
**含 1 个 NUL 字节**、被 git 判为 `-text`。

机制：worktree 各自检出**自己的旧修订**，「本仓」这个**全称命题**实际只覆盖了取数的那棵工作树。

处置：按「含 CRLF 字节对」判定的剥 CR 会损坏那 6 个 PNG——已由「**剥离后必须与 index blob
逐字节相同才入 index**」的守卫拦下并还原。

## 形态③：配置写在了已不消费的键位上

想在 pnpm 11 下用 `engine-strict` 硬拦 Node 版本：`.npmrc` 里写 `engine-strict=true`，
`pnpm config get engine-strict` 读回 `undefined`，`pnpm install` 只打
`WARN Unsupported engine` 且 **exit 0（不拦）**。同一个 `.npmrc` 里的 `registry=` **仍被读取**
⇒ **引擎类键已迁走**。

正确形态：`pnpm-workspace.yaml` 的 `engineStrict: true`（实测硬拦
`ERR_PNPM_UNSUPPORTED_ENGINE`、exit 1）。裁决：**不新建 `.npmrc`**——配了也无效，
会误导下一个读代码的人。

## 形态④：门禁装在链路外，故障点在链路的另一侧

`engineStrict` 会**连坐依赖树**：实测本仓已装 **721 个带 `engines.node` 的包（76 种取值）**，
**最高下界来自 `lint-staged`**（`>=22.22.1`）⇒ 声明 22.18 却**装不上**，
声明与实际门槛自相矛盾；且若干测试依赖的约束把 Node 23.x 整档排除。

更关键：真正的故障点是 **MCP server 由 harness 用裸 `node` 拉起**（不经 pnpm）
⇒ pnpm 侧的门禁**不在那条路上**。机械拦的成本由**依赖树**而非本仓代码决定，
会随依赖更新**静默漂移**。改走「**故障点断言**」：在启动链路最前面做版本自检，
不满足时把「需要什么版本 / 当前什么版本 / 哪些工具面会死」打到 stderr 并 exit 1。

## 形态⑤：守卫排在求值序的后面 ⇒ 永不执行

把版本守卫写进主脚本的**函数体里**、或写进被它 import 的工具模块里，都会因为
**ESM 静态 import 按序求值**而排在那条先崩的 import **之后** ⇒ **永不执行**。

正确位置：**独立守卫模块（纯 JS，不得 import 任何 `.ts`）**，作为主脚本的**第一条** `import`。
验收必须**打在接线面**上：读主脚本源码断言「守卫 import 的行序早于工具 import」＋
断言守卫模块源码内不含 `.ts` 引入；并**真跑一次拒绝路径**（伪造低版本端到端验接线确被执行）。
只测版本比较纯函数，测的是「函数绿但没接上线」。

## 同族：布尔开关按字符串长相读 ⇒ 静默反转

`=== '1'` 会让 `.env.example` 里的 `=true` **静默读成关**；而宽松惯例 `!== 'false'`
会把已写明的 `=0`（关闭）**反转成启用**（`'0' !== 'false'` 为真）。
⇒ **惯例要按默认侧方向选，不能按字符串长相选**（详见
[「整族修」的族边界按失效机制划](family-boundary-by-failure-mechanism.md) 的同族段）。

## 可复用的动作

1. **写判据前先问「这个读数取自哪一层」**，把它按到与作用面同一层。
2. **每条「看起来生效」的读数配一条能红的反对照**；没有反对照的绿，与「没测」同形。
3. **全称命题要带取数口径**：「本仓 0 个二进制」这类断言实际只覆盖**取数的那棵树**——
   多 worktree 仓里这几乎是必然的坑。
4. **配置类改动要验「它真被消费了」**：读回一次（`config get`），或跑一次本该被拦的输入。

## 溯源

形态①②：`a037d80`（PR #89）；形态③④⑤：`ceed5e63`（PR #142，实施 `42bf1892`）。
接线面测试与守卫模块落在 `scripts/mcp-server.mjs` 与 `scripts/mcp-server-utils.mjs` 一侧。

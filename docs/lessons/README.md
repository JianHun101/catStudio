# docs/lessons/ — 经验教训（无取舍的知识）

这个目录放**跨活复用的经验**：撞出来的教训、可复用的做法。

本文件（`README.md`）是目录门牌，长期保留；`<slug>.md` 卡片是常驻件，**不随活收口清理**
（与 `docs/run/` 相反——那是在飞件，活一结束即失效）。

## 内容边界

**进这里的是「无取舍的经验」。**

判据不是口味，是 ADR 自己的准入门槛：`skills/domain-modeling/ADR-FORMAT.md` 要求三条件全真，
其第 3 条「the result of a real trade-off」被教训**确定性击穿**——「pnpm 遇 junction 报
`ERR_PNPM_UNSAFE_*`」是撞出来的，当时没有备选方案可比。硬塞进 `docs/adr/` 会持续稀释那个
目录的信噪比，故单立一格，与 ADR **同权**（同挂状态字段、同进索引、同受三关判据管）。

**有取舍的决策** ⇒ `docs/adr/`（不是这里）。
**不进这里**：活内过程（哪张票、谁 block 谁——那是票单，在 `docs/run/`，收口即清）；
本会话的过程叙述 ⇒ `docs/sessions/`；定稿规格 / 勘察报告 ⇒ `docs/plans/` / `docs/research/`。

## 命名

`<slug>.md`——slug 用 kebab-case，只描述教训本身。
**不加日期前缀**：日期是 `plans/`/`research/` 那类「随活过期」件的命名词汇，卡片是长期件，
带上日期会读成「有保质期」。

## 状态值域（⚠️ 临时口径）

frontmatter `status:` 沿用 ADR 四值的**最小口径**（同一词汇表，不另发明拼写）：

| 值                   | 含义                                       |
| -------------------- | ------------------------------------------ |
| `proposed`           | 已记下，尚未被复用验证                     |
| `accepted`           | 已被后续活复用且成立                       |
| `deprecated`         | 已不成立（环境变了 / 被证伪）              |
| `superseded by <ID>` | 被另一张卡或一份 ADR 取代（`<ID>` 写全名） |

**标临时口径的原因**：本档只钉「值域拼写与 ADR 同源」这一条，**不替 Q2-c 的完整值域决策**
（Q2-c 还管旧件回填口径与字段全集）。Q2-c 定稿时以那份为准，本档随改。

## 必审说明

卡片落此 ⇒ **自动落必审侧**：`docs/lessons/**` **不在免审白名单内**（该白名单只含
`docs/run/**`），天然必审——与 `docs/adr/**` 同理，它是知识真相源，不是过程留痕。

写入走**独立 commit + `git add <路径>` → 核对暂存区（`git diff --cached --name-only`）→ 裸 `git commit`**：
`git commit --only` 在本仓不可用——`.husky/pre-commit` 的 `unset GIT_INDEX_FILE` 与它冲突（口径与实测见
`AGENTS.md` 提交段）。`git add -A` 型 auto-commit 抢收在本仓已复发 3 次，卡片一旦被抢收就跳过审查链；
限定路径是这条通道的固定动作，不是可选礼仪。

# 票：Windows 行尾假红根修（`.gitattributes` + 存量工作区归一）

> 归属：Windows 行尾（`core.autocrlf=true` 且**无** `.gitattributes`）。
> **立票 2026-09-15**（用户明确「立单」）。**尚未派活**——与重启排期绑定，见「派活前置」。
> 前置实证：R3 派活期间 §A 实施猫**连续 8 次提交全废**（跨约 6 分钟，失败面完全稳定）；店长两次手工零 diff 归一解开当期，**只解当期、不防复发**。

## 结论先行

1. **症状链**：worktree 检出 CRLF，而仓库 blob 存的是 LF → 测试用 `?raw` 读源码拿到 `\r\n` → 静态源断言（期望串是 LF）必红 → `pre-commit` 是 `npx lint-staged; pnpm lint; pnpm test`（**全仓、无路径过滤**）→ **谁都提交不了**。
2. **加 `.gitattributes` 能根治未来**的检出与合并，**但不回溯存量工作区**——实测 `checkout -f` / `checkout-index -f` / `read-tree --reset -u` 三条重物化路径**全部拒绝落盘**。
3. **存量靠一次性物理剥 CR**，判据 = 剥完 `git diff` 为空。
4. **明确不采用 `git add --renormalize`**：本仓 471 个 tracked blob **全部是 LF**，它是 **no-op**——跑了只会给人「已经修好了」的假象。

---

## 一、范围

### §A 防复发：新增 `.gitattributes`（仓级一个文件）

```
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
```

- **必须三组规则，不是一行**。`*.bat` / `*.cmd` 不走 `eol=lf`——cmd.exe 对 LF-only 的 `goto` 与标签有坑。本仓当前 **0 个** `.bat` / `.cmd`（已实测），这两行是**预防性**的。
- **不加二进制项**：本仓 **0 个 tracked 二进制**（png/jpg/gif/ico/zip/gz/db/woff/ttf/pdf/mp4/wasm 全零命中，已实测），`text=auto` 会自动判定；写了没消费者（本仓已栽过「无落点预留会腐烂」）。
- 本仓**无 `.gitmodules`**（已实测）。
- **不改 `core.autocrlf`**：`.gitattributes` 优先级高于它（`git check-attr` 实读 `text: auto / eol: lf`），改 `core.autocrlf` 影响面更大而无额外收益。

### §B 治当下：存量工作区一次性剥 CR

- **覆盖范围**：主仓库 + **全部现存 24 个 session worktree**。
- **范围修正（2026-09-15 店长，派活前）**：立票时此处写的是「不覆盖 42 个历史 worktree」，理由是「它们不活跃，随废弃清理自然消失」。**该理由已不成立**——用户同日指令清理了 8 月及更早的 **18 个** worktree，**现存的 24 个全部是 9 月的、可被重新启用的**。若不处理，其中任何一个会话被恢复时都会**原样带回 CRLF 假红**（`.gitattributes` 不回溯存量，见 §一 §A）。现存 24 个**实测脏文件数全为 0**（店长派活前实测），剥 CR 为零 diff 操作。
- **动作**：只剥行尾 CR，**不改内容、不动 index、不产生任何提交**。
- **判据（逐条留痕）**：每条 checkout 处理完后 `git diff --exit-code` 退出码为 **0**，且 `git ls-files --eol` 中 `w/crlf` 计数归零。

---

## 二、Out of Scope（明确不做）

- **测试侧 `?raw` 读入归一化**（11 个测试文件 + helper）——§A 落地后新检出即 LF，「改了未提交跑测试」的残留窗口随之关闭。本票不做；**若日后复发，另立票**。
- 已删除的 18 个历史 session worktree（用户 2026-09-15 指令清理，已不存在）。
- 修改 `core.autocrlf`（理由见 §A 末条）。

---

## 三、验收标准（逐条可执行，实施者须逐条留痕）

- **C1** `.gitattributes` 已提交，内容为 §A 的三组规则。
- **C2（本票核心判据）新检出根治**：全新 `git worktree add` 一个临时 worktree → 其 `git ls-files --eol` 中 `w/crlf` 计数为 **0**、`w/lf` 等于 tracked 文件总数；且在该 worktree 内跑 `pnpm test:web` **全绿**——**`ChatPanel.test.ts` 的三条多行断言（`:462` / `:471` / `:481`）必须绿**（这正是本轮挡住全部提交的那三条）。
- **C3** 主仓库 + 全部 24 个现存 session worktree 剥 CR 后，**每一处** `git diff --exit-code` 为 **0**（共 **25 处**）；且每一处的 `w/crlf` 计数均为 **0**。**逐条留痕**（25 行读数，不接受「抽样 N 个」）。
- **C4** **新增 CRLF 文件**：用工具写出一个 CRLF 文本文件并 `git add` → 该文件在 index 内为 LF（`git ls-files --eol` 该行 `i/lf`）。
- **C5** **自证**：本票自身的提交必须能过 `pre-commit`（即用本票的改动证明它解开了自己的门）。
- **C6** `pnpm lint` + `pnpm test` 全绿。

---

## 四、提交纪律

- 提交信息 `catstudy [uuid]`，uuid 取 `messages` 表内**真实存在**的触发消息 id（`commit-msg` 门禁会校验；变量缺失时报环境未注入，**不得**编造合法格式 uuid）。
- `git add <具体路径>` → `git diff --cached --name-only` 核对 → 裸 `git commit`；**勿 `git add -A`**（会扫走他猫未提交的文件——本仓已有 `f710ac7` 三次实证）。
- 票面行号提交前用 `git grep -n`（**字节路径**）复核——PS 文本管道在 UTF-8 无 BOM 源码上会给**反向错位假读数**。
- **卡住或票面自相矛盾 → 报店长裁，不自行改判。**

---

## 五、派活前置（与重启排期绑定）

**✅ 前置已满足，2026-09-15 派活。** 重启已于 2026-09-15 21:10 落地（用户手动整进程重启，`/api/eval/spans` 实测 200）。

**顺序**：重启落地 → 店长派活。本票**不含 server 改动**，重启前后均可实施。

**与 T-2 的排序（店长裁）**：本票**先于 T-2 落地**。T-2（一猫一 worktree 隔离，ADR 0015）会新建更多 worktree，而 `.gitattributes` 未落地前**每个新 worktree 检出都会带回 CRLF 假红**——本票先行，T-2 的验收才不会被一个与它无关的行尾问题反复打断。

---

## 决策留痕

### 立票依据（6 组实测，**全部在临时克隆内跑，本仓零改动**）

| #   | 实验                                                                                              | 读数                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 临时克隆（= 现状复刻）                                                                            | 470 个全 `w/crlf`，status 干净                                                                                                                       |
| 2   | 加 `.gitattributes` 并提交                                                                        | status **仍为 0**，`ChatPanel.vue` **仍 3177 个 CR** ⇒ **不回溯**                                                                                    |
| 3   | 带 `.gitattributes` 的**新克隆**                                                                  | **471 个全 `w/lf`、CR=0、status 干净** ⇒ 根治未来 ✅                                                                                                 |
| 4   | 存量重物化：`rm`+`checkout` / `checkout -f` / `checkout-index -f` / `read-tree --reset -u`        | **四条全失败**，CR 仍是 3177——git 判定「文件与索引已一致」即拒绝落盘，`-f` 也不管用                                                                  |
| 5   | 新增 CRLF 文件 → `git add`                                                                        | index **0 CR**，工作副本 **2 CR**（索引被归一，工作副本不动）                                                                                        |
| 6   | `.lintstagedrc` = `"*": "prettier --ignore-unknown --write"` + `.prettierrc` **未设 `endOfLine`** | prettier 默认 `lf` ⇒ **被提交的文件会在提交那刻被改写成 LF 落盘**（解释了主仓库那批 `w/lf`）（#1↔#3 的 470→471 之差 = 新增的 `.gitattributes` 自身） |

⇒ 残留窗口很窄：**被暂存提交的路径其实自愈**（实验 6），真正暴露的是「工作副本是 CRLF 且还没提交」这一小段。

### 爆炸半径（本轮实测，主仓库在 `5dedbd7`）

```
471 tracked：i/lf w/crlf = 437 | i/lf w/lf = 34 | i/crlf = 0
core.autocrlf = true；.gitattributes 不存在
换行敏感断言 = ChatPanel.test.ts 的 3 条（:462 / :471 / :481，多行 toContain）
其余 ?raw 测试为单行断言，CRLF 天然免疫
```

⇒ **不是「11 个文件都埋着雷」，是 1 个文件 3 条。**

### 为什么这个洞此前没暴露

三条断言来自票 I（合并 `ca5bc4f`）。该合并之后 dev 上的提交（`2a6a855` / `dd51821` / `eb3f2d0` / `f1640ee` / R3 两笔）**全部出自主仓库**——主仓库那两个文件恰为 `w/lf`，所以全绿。**worktree 侧本轮是第一次撞上**，一撞就是 8 次连续失败。

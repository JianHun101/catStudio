# CatStudy removeSessionWorktree 自指守卫：收口者不拆自己住的房子

## 1. What — 具体改动

| 文件                                        | 改动                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/llm/git-utils.ts`      | `removeSessionWorktree` 增加自指守卫：`process.cwd()` 解析后等于或位于 `wtPath` 内时跳过 `cleanupWorktreeResidue` 的物理残留清理（只做 git 层 `worktree remove` + 删分支）；新增纯函数 `isPathInside`（`path.relative` 判定目录包含关系，win32 大小写不敏感由 Node 底层保证）      |
| `packages/server/src/llm/git-utils.test.ts` | 新增两例：mock `process.cwd()` 指向 worktree 内 → 断言 `rmSync` 不触发、目录保留、函数不抛错；指向 worktree 外 → 断言 `rmSync` 触发、目录删除。文件级 `vi.mock` 代理 `node:fs`/`node:child_process`（仅包装 `rmSync` 与 `execFileSync`，其余全量委托真实实现，既有用例行为零变化） |

## 2. Why — 为什么这样做

### 根因：会话隔离把收口者自己也隔离进了 worktree

店长 2026-08-20 实锤的代码级链路（git-utils.ts:363 `ensureSessionWorktree` + socketio.ts:2748 → claude.ts:190 / dsh.ts:246）：

```
会话隔离机制
  每个会话 → catStudy-sessions/<8位id> 独立目录 + 独立分支 session/<8位id>
    └── cwd 透传给 agent CLI（claude/dsh 适配器）

收口自己会话（店长 7531d744）
  process.cwd() == D:\Game\ai\catStudy-sessions\7531d744 == 被收口的 wtPath
    └── removeSessionWorktree 按收口序列执行
          git worktree remove --force（Windows 上 cwd 被当前进程持有 → EPERM 失败）
          → cleanupWorktreeResidue 兜底 rmSync 递归删除 ← 灾难点
```

修复前 `cleanupWorktreeResidue`（git-utils.ts:530-552）的 `rmSync(wtPath, {recursive, force})` 从不检查 `process.cwd()` 是否落在 `wtPath` 内。Windows 上 Node 进程的 cwd 句柄无 `FILE_SHARE_DELETE`，目录被删后进程不抛错、后续一切文件 IO（日志、回复落库）悬空 → 僵尸进程占 slot → FIFO 队列全体排队。

讽刺的是这个知识代码里早就知道——`removeStaleWorktreeDir` 的注释（git-utils.ts:343）明写「agent CLI 子进程持 cwd，进程退出即自愈」，但只用在**重建路径**，没灌进**收口路径**。

### 守卫设计：只跳过物理删除，git 层照常

```
cwd 在 wtPath 内（收口自己会话）
  git worktree remove --force  → 仍尝试（Windows 必然 EPERM 失败，catch 静默）
  删分支                        → 仍尝试（worktree 未注销 → git branch -D 失败，catch 静默）
  物理残留清理                   → 跳过（关键改动）
    └── 残留交给进程退出后的收口兜底：
          removeStaleWorktreeDir 重建路径  /  下次成功收口

cwd 在 wtPath 外（常规收口其他会话）
  → 行为与守卫前完全一致（既有用例 235/254 行断言覆盖）
```

`isPathInside` 用 `path.relative` 判定：等于 → `''`；位于其内 → 不以 `..` 开头且非绝对路径（不同盘符相对结果为绝对形式）；win32 下 Node 的 `path.relative` 按大小写不敏感比较，天然覆盖 `D:\` 与 `d:\` 盘符大小写差异。

### 测试设计：把「残留是否被物理清理」做成唯一可观测信号

两个用例共用「git worktree remove 被模拟为失败」的判定环境（目录必然残留），使 `rmSync` 是否触发成为区分守卫是否生效的唯一信号：

- **cwd 在内**：`vi.spyOn(process, 'cwd')` 指向 worktree 根（真实场景——会话隔离把 cwd 透传为 worktree 根，店长实例 7531d744）；断言 `rmSync` 未触发、目录保留、函数不抛错。
- **cwd 在外**：cwd 指向主仓库（tmp，非 worktree 内）；断言 `rmSync` 触发、目录删除。

mock 只代理不替换：`vi.mock('node:fs')` 仅把 `rmSync` 包成 `vi.fn`（委托真实实现），`vi.mock('node:child_process')` 仅对 `git worktree remove` 按开关抛错，其余调用全量委托——既有 16 个用例行为零变化。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                                                   | 原因                                                                                                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接在 `removeSessionWorktree` 里内联 `resolve(process.cwd()) === wtPath` 的字符串比较 | 字符串前缀比较对路径分隔符/大小写/不同盘符不可靠；`path.relative` 方案把边界语义交给 Node 底层，win32 大小写不敏感免费获得                         |
| 在 `git worktree remove` 失败后仍尝试物理删除但逐个重试                                | 根因是进程自己占着 cwd，重试不可能成功（Windows 句柄语义）；跳过等进程退出后兜底是唯一正确路径，且 `removeStaleWorktreeDir` 已具备成熟的重建清理链 |
| 用 `vi.spyOn(fs, 'rmSync')` 直接断言（不 mock 模块）                                   | vitest 对 `node:fs` 具名导入的 live binding 拦截不确定，跨 Node 版本有风险；`vi.mock` + 委托代理是确定性方案，且文件级声明对既有用例零影响         |
| 用真实 `process.chdir` 进 worktree 验证（win32-only）                                  | 依赖平台 git 对「目录被持 cwd」的确切行为（Windows EPERM / POSIX 允许删除），跨平台测试会炸；mock 判定环境是平台无关的确定性复现                   |

## 4. Open Questions — 不确定的点

- **收口失败后的残留收敛**：自指守卫生效时，worktree 注册 + 分支 + 物理目录三者都残留（git 层操作均因 worktree 未注销而静默失败）。兜底依赖「进程退出后 removeStaleWorktreeDir 重建路径清理」或「下次成功收口」。若进程长期驻留（server 常驻），残留会累积，直到同一 shortId 下次被 ensureSessionWorktree 命中才清理——是否需要在 server 侧增加周期性兜底清理，待观察
- **git branch -D 的静默失败**：收口自己会话时分支删除必然失败（worktree 未注销），catch 静默。残留分支在 `removeStaleWorktreeDir` 重建路径时不会被删（只清目录）——分支残留是否会造成 ref 泄漏，需后续确认重建路径是否覆盖分支层
- **`isPathInside` 的盘符大小写边界**：win32 下 `path.relative` 的大小写不敏感由 Node 实现保证，但未在测试中直接覆盖（两用例的 cwd 与 wtPath 大小写一致）。真实场景中环境变量注入的路径与 `sessionWorktreePath` 计算路径大小写不一致的概率极低，暂不补用例

## 5. Next Action — 希望做什么

- [ ] 真机验证：店长收口自己会话（7531d744 场景）时确认日志出现 `skip residue cleanup — cwd inside session worktree`，且进程不卡死、后续文件 IO 正常
- [ ] 确认收口兜底链对「残留分支」的清理覆盖（重建路径当前只清目录，分支是否漏删）
- [ ] 评估是否需要 server 常驻进程的周期性残留清扫（当前依赖进程退出触发）

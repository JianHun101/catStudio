/**
 * T-A ②（2026-09-10）：执行收尾兜底投递。
 *
 * 背景：T-A 把 post-commit 钩子从「每 commit 必投」改成「有归属则静默」——审查请求
 * 归实施猫自己投（铁律 + `request-review` 技能）。但猫可能忘（尤其铁律文案尚未同步的
 * 过渡窗口），故在**执行收尾**加第二道闸：本执行有 commit 且其回复 mentions 不含
 * 审查者 → 补投。
 *
 * 为什么判定点必须在这里、而不能合并进钩子（票单 T-A 的关键设计）：commit 发生在
 * 执行**中途**（猫在工具循环里跑 `git commit`），那一刻它的回复尚未产生，「已投递吗」
 * 物理上没有答案；而用户手动提交没有执行可挂靠，只能在钩子侧判。两处时序不同，不可合并。
 *
 * 为什么补投交给 `scripts/handoff-gen.mjs --fallback-sha`（子进程）而不是 server
 * 自己 POST：补填请求的正文是 git diff 的机械生成产物（文件清单 + Reviewer Checklist），
 * 生成器全仓只有那一份——server 侧重写等于两份实现、必然漂移，且「投递形态不变」
 * 是本票硬边界。server 已用同一款 spawn 模式挂 `scripts/mcp-server.mjs`（claude/dsh/
 * opencode 适配器），不是新依赖形态。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'

const log = createLogger('review-fallback')

export interface FallbackJudgement {
  /** true = 该补投；false = 静默（并给出理由，留痕用） */
  deliver: boolean
  reason: string
}

/**
 * 判定「执行收尾该不该补投审查请求」——纯函数，无 I/O。
 *
 * 三分支（对应票单判定表 ② 与降级项 ③）：
 *   - 无 commit → 静默（本执行没产出提交，无审查请求可投）
 *   - 会话无 reviewer 角色 → 静默（该会话不跑审查链，补投无意义）
 *   - 回复 mentions 含审查者 → 静默（主动投递已发生；mentions 是文本 @ 与
 *     `post_message` 两通道的并集，见 serial.ts mentions 写回段）
 *   - 其余 → 补投
 *
 * ⚠️ 这是**启发式**：@审查者 用于非审查用途时会漏兜一次（退回今天的行为）。
 * 阶段二（T-F）用锚 + chainType 收紧。
 *
 * @param input.commitSha — 本执行 running 行的 commit_hash（无 commit 传空）
 * @param input.mentions — 回复落库的 mentions（审查者名命中即视为已投递）
 * @param input.reviewerName — 会话内 role='reviewer' 的猫名（无则 null）
 */
export function judgeReviewFallback(input: {
  commitSha?: string | null
  mentions: string[]
  reviewerName?: string | null
}): FallbackJudgement {
  const { commitSha, mentions, reviewerName } = input
  if (!commitSha) {
    return { deliver: false, reason: '本执行无 commit——无审查请求可投' }
  }
  if (!reviewerName) {
    return { deliver: false, reason: '会话内无 reviewer 角色——审查链不适用' }
  }
  if (mentions.includes(reviewerName)) {
    return { deliver: false, reason: `回复已 @ ${reviewerName}——主动投递已发生` }
  }
  return {
    deliver: true,
    reason: `本执行有 commit（${commitSha.slice(0, 7)}）但回复未 @ ${reviewerName}——收尾兜底投递`,
  }
}

/** 本模块所在目录（源码与构建产物通用——向上找根不依赖层级） */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** 补投脚本相对仓库根的路径 */
const HANDOFF_GEN_REL = ['scripts', 'handoff-gen.mjs'] as const

/** 从 startDir 向上找**确实含有** `scripts/handoff-gen.mjs` 的最近祖先（含自身）；
 *  存在性即自校验，找不到返回 null——绝不猜。 */
function findRepoRootFrom(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, ...HANDOFF_GEN_REL))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 定位补投脚本 `scripts/handoff-gen.mjs` 的绝对路径；找不到返回 null。
 *
 * 两个候选起点，按序：① 本模块所在目录向上找——锚「当前加载的 server 代码所属
 * 检出」，与正在跑的 server 版本同源；② 进程 cwd 向上找——模块落在检出之外时兜底。
 *
 * **为什么不锚 `process.cwd()`**（必改 1，原实现的缺陷）：cwd 不是仓库根的稳定代理。
 * `pnpm dev:server`（AGENTS.md 明列的单包启动）= `pnpm --filter @cat-study/server dev`
 * = `tsx watch src/index.ts`，cwd = `packages/server` → 原实现解析出
 * `packages/server/scripts/handoff-gen.mjs`，existsSync false → ② 整条兜底链**静默
 * 失效**（只留一条 error 日志）。dev.js:252-253 把 cwd 设成 ROOT 只是那一种启动形态
 * 的巧合，不是契约。
 *
 * 为什么不是固定层级 `new URL('../../../..', import.meta.url)`：源码与构建产物深度
 * 不同——tsconfig `rootDir: ".."` + `outDir: "./dist"`，产物落在 `dist/server/src/
 * execution/`（见 packages/server/package.json start），比 `src/execution/` 深一层。
 * 固定层级必有一边解析错；向上找对两种布局都成立。
 *
 * 为什么不用 git-utils 的 getMainRepoRoot()：它在执行收尾路径上多一次**同步 git
 * 子进程**，且语义是**主仓库**根——从 worktree 内跑 server 时它指向主仓库的脚本
 * （版本与正在运行的 server 代码不一致），而本函数要的正是「代码所属检出」。
 */
export function resolveHandoffGenScript(opts: { cwd?: string } = {}): string | null {
  const starts = [moduleDir, opts.cwd ?? process.cwd()]
  for (const start of starts) {
    const root = findRepoRootFrom(start)
    if (root) return join(root, ...HANDOFF_GEN_REL)
  }
  return null
}

export interface SpawnOutcome {
  spawned: boolean
  /** spawned=false 时的原因（调用方记日志用） */
  reason?: string
}

/**
 * 触发补投：以子进程调 `handoff-gen.mjs --fallback-sha=<sha>`，fire-and-forget。
 *
 * 不 await、不阻塞执行收尾——补投是安全网，失败只留痕不抛出（失败时该 SHA 会随
 * 下次 post-commit / pre-push 的 pending 逻辑或人工重跑补上）。
 * 幂等由 handoff-gen 的 `.handoff-delivered.json` 账本兜（同一 SHA 全流程至多一条）。
 *
 * @param cwd — 生成交接文档的工作目录（会话 worktree 优先，与 CLI 执行 cwd 同源）
 * @param commitSha — 补投目标 commit（本执行 commit_hash）
 */
export function spawnReviewFallback(cwd: string, commitSha: string): SpawnOutcome {
  const script = resolveHandoffGenScript()
  if (!script) {
    // 不静默降级：解析已按存在性自校验，走到这里说明两处起点向上都没有该脚本。
    // 报出两个起点——安全网自己失效时必须可诊断（否则只剩一句「找不到」）。
    return {
      spawned: false,
      reason: `定位不到 scripts/handoff-gen.mjs（起点：${moduleDir} / ${process.cwd()}）`,
    }
  }
  // 会话 worktree 可能已被收口清理（收口后进行中的执行）→ 退回**脚本所属仓库根**。
  // 为什么不用 process.cwd()：`pnpm dev:server` 下它是 packages/server——把手写的
  // cwd 换成子目录会让 handoff-gen 的 git diff 落在错误范围（同一 cwd 假设的另一处
  // 残留）。脚本自身所在仓库根才是它的同源工作区，且与 hook 的调用 cwd 一致。
  // 注：修复前该降级分支在 dev:server 形态下不可达（脚本路径先错了），现在可达。
  const workdir = existsSync(cwd) ? cwd : resolve(script, '..', '..')
  // 清掉 CATSTUDY_SESSION_ID（不继承）：它在 handoff-gen 里是「投给谁」的最高优先
  // 信号（显式指定 > commit uuid 反查），server 侧若带着它（注入给 CLI 子进程的
  // 那份被误继承/外部 shell 导出），兜底就会**改写投递目标**、投到错误的会话。
  // 它**不参与幂等判据**——旁路 delivered 账本的是 CATSTUDY_FORCE_DELIVER。
  const env = { ...process.env }
  delete env.CATSTUDY_SESSION_ID
  try {
    const child = spawn(
      process.execPath,
      [script, `--fallback-sha=${commitSha}`, `--cwd=${workdir}`],
      { cwd: workdir, stdio: 'ignore', windowsHide: true, env }
    )
    child.on('error', (err) => {
      log.error('review fallback spawn error', { commitSha, error: err.message })
    })
    child.on('exit', (code) => {
      // 票单 ③「不静默吞」——② 是本票自称唯一的收尾安全网，它自己的失败必须可见：
      // 非零退出码 = 补投没发生，该 SHA 只剩 pre-push 一道网，抬到 error。
      // 不做 stdio:'pipe' 接 stderr：pipe 的读句柄会让父进程事件循环保持引用，
      // 与下面 child.unref()（不阻塞执行收尾）的目的相冲。退出码是这里能拿到的最
      // 廉价信号，够定位「补投没跑成」。
      if (code === 0) log.info('review fallback child exited', { commitSha, code })
      else log.error('review fallback child exited non-zero——补投未发生', { commitSha, code })
    })
    // 不阻塞父进程退出——补投跑完与否不影响执行收尾
    child.unref()
    return { spawned: true }
  } catch (err: any) {
    return { spawned: false, reason: messageOf(err) ?? 'spawn 失败（诊断取不出）' }
  }
}

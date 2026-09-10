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
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'

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

/** handoff-gen 脚本路径（项目根/scripts）——与 cli-utils getWorkspaceDir 同款
 *  cwd 假设：dev.js 把 server 进程的 cwd 设为项目根。 */
function handoffGenPath(): string {
  return resolve(process.cwd(), 'scripts', 'handoff-gen.mjs')
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
  const script = handoffGenPath()
  if (!existsSync(script)) {
    return { spawned: false, reason: `handoff-gen 脚本不存在：${script}` }
  }
  // 会话 worktree 可能已被收口清理（收口后进行中的执行）→ 退回 server cwd
  const workdir = existsSync(cwd) ? cwd : process.cwd()
  // 清掉 CATSTUDY_SESSION_ID（不继承）：该变量在 handoff-gen 里是「人工显式指定」
  // 的最高优先目标，且**旁路 delivered 账本**（显式指定即明确意图）。server 侧
  // 若带着它（注入给 CLI 子进程的那份被误继承/外部 shell 导出），兜底就会投错
  // 会话并跳过幂等锁。投递目标一律由脚本从 commit uuid 反查——与钩子同源。
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
      log.info('review fallback child exited', { commitSha, code })
    })
    // 不阻塞父进程退出——补投跑完与否不影响执行收尾
    child.unref()
    return { spawned: true }
  } catch (err: any) {
    return { spawned: false, reason: err.message }
  }
}

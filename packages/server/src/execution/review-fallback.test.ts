/**
 * T-A ② 收尾兜底判据单测（judgeReviewFallback 三分支 + 边界）。
 *
 * 只测纯判据：spawn 侧是子进程 I/O（被测边界为文件系统/进程，按约定不在此覆盖）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeReviewFallback, resolveHandoffGenScript } from './review-fallback.js'

const SHA = 'a'.repeat(40)
const REVIEWER = '吐槽猫'

/** 仓库根 = 本测试文件向上 4 层（packages/server/src/execution → 仓库根） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('judgeReviewFallback — T-A ② 收尾兜底判据', () => {
  it('有 commit 且回复未 @ 审查者 → 补投', () => {
    const v = judgeReviewFallback({ commitSha: SHA, mentions: [], reviewerName: REVIEWER })
    expect(v.deliver).toBe(true)
    expect(v.reason).toContain('收尾兜底投递')
  })

  it('回复已 @ 审查者 → 静默（主动投递已发生）', () => {
    const v = judgeReviewFallback({
      commitSha: SHA,
      mentions: [REVIEWER],
      reviewerName: REVIEWER,
    })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('已 @')
  })

  it('本执行无 commit → 静默（无审查请求可投）', () => {
    const v = judgeReviewFallback({ commitSha: null, mentions: [], reviewerName: REVIEWER })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('无 commit')
  })

  it('会话内无 reviewer 角色 → 静默（审查链不适用）', () => {
    const v = judgeReviewFallback({ commitSha: SHA, mentions: [], reviewerName: null })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('reviewer')
  })

  it('mentions 含其他猫但不含审查者 → 仍补投（判据只认审查者）', () => {
    const v = judgeReviewFallback({
      commitSha: SHA,
      mentions: ['店长', 'ds猫'],
      reviewerName: REVIEWER,
    })
    expect(v.deliver).toBe(true)
  })

  it('commitSha 为 undefined（未反查到）与无 commit 同语义', () => {
    const v = judgeReviewFallback({ mentions: [REVIEWER], reviewerName: REVIEWER })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('无 commit')
  })
})

describe('resolveHandoffGenScript — 脚本定位（必改 1：不锚 process.cwd）', () => {
  const expected = resolve(REPO_ROOT, 'scripts', 'handoff-gen.mjs')

  it('默认调用解析到仓库根脚本，且文件确实存在（存在性自校验）', () => {
    expect(resolveHandoffGenScript()).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  it('cwd = packages/server（pnpm dev:server 形态）仍解析到仓库根', () => {
    // 回归点：修复前实现是 resolve(process.cwd(), 'scripts', ...) —— 该形态下解析成
    // packages/server/scripts/handoff-gen.mjs，existsSync false → ② 整条兜底链静默失效
    const cwd = resolve(REPO_ROOT, 'packages', 'server')
    expect(resolveHandoffGenScript({ cwd })).toBe(expected)
  })

  it('cwd 在任何仓库之外仍能定位（模块目录候选优先）', () => {
    expect(resolveHandoffGenScript({ cwd: tmpdir() })).toBe(expected)
  })

  it('cwd 深在子目录内 → 向上走找到仓库根（走的是 walk-up 而非直接命中）', () => {
    const cwd = resolve(REPO_ROOT, 'packages', 'server', 'src')
    expect(resolveHandoffGenScript({ cwd })).toBe(expected)
  })
})

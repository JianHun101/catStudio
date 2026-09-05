/**
 * hooks 配置回归护栏——断言主仓库 core.hooksPath 恒等 .husky（目录）。
 *
 * 背景（hooks 根修单，2026-09-05）：husky v9 prepare 会在每次 install 时把
 * core.hooksPath 写成 .husky/_（husky/index.js），而 .husky/_ 不是目录 →
 * git 找不到钩子 → post-commit/pre-commit/pre-push 全哑、审查链静默断
 * （第三次同因复发后立根修：删 prepare:husky、改自维护 hooks-install）。
 * 本测试是漂移 tripwire：hooksPath 一旦被旧机制/手工写坏，全量测试大声失败，
 * 修复 = git config core.hooksPath .husky（或重跑 node scripts/hooks-install.mjs）。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

function insideGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function readHooksPath() {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null // 未设置 → git 回落默认 .git/hooks（同样钩子全哑）
  }
}

describe('hooks 配置回归护栏', () => {
  it('core.hooksPath === .husky（漂移则大声失败）', () => {
    if (!insideGitRepo()) return // 非 git 环境（打包产物等）→ 跳过
    const hooksPath = readHooksPath()
    expect(
      hooksPath,
      hooksPath === null
        ? 'core.hooksPath 未设置——git 用默认 .git/hooks，钩子全哑。修复: git config core.hooksPath .husky'
        : `core.hooksPath 漂移为 "${hooksPath}"——应为 .husky。修复: git config core.hooksPath .husky（或 node scripts/hooks-install.mjs）`
    ).toBe('.husky')
  })
})

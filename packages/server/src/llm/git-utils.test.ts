/**
 * git-utils e2e 标记文件守卫测试。
 *
 * gitCommit() 的 CWD 是函数内动态取（getCwd()），不随 import 冻结——
 * 测试 chdir 到临时 git 仓库后调用，所有 git 操作自然落在临时仓库，
 * 不依赖「先 chdir 再 import」的加载顺序（模块缓存下也安全）。
 * 保留 chdir + 动态 import 仅为让测试与模块加载路径清晰。
 *
 * git-utils 所有 execSync 统一带 env: cleanGitEnv()（剔除 GIT_DIR/
 * GIT_INDEX_FILE/GIT_WORK_TREE/GIT_PREFIX）——worktree 内 commit 时 git
 * 会向 hook 注入绝对 GIT_DIR（.git 是文件指针需显式指定仓库位置），
 * env 劫持优先级高于 cwd 探测，不清理则测试的 cwd: tmp 被劫持、
 * fake 提交落真实仓库（店长 2026-08-09 实测实锤）。
 *
 * 覆盖场景：无标记文件 → auto-commit 正常；标记文件存在 → 跳过；
 * 删除标记 → 恢复。验证"文件跨进程"方案，防止回归到环境变量（不跨进程）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const origCwd = process.cwd()
let tmp: string
let gitUtils: typeof import('./git-utils.js')

/**
 * 清理 git 环境变量（与 git-utils.ts 的 cleanGitEnv 同款）。
 * pre-commit hook 内 git 注入 GIT_DIR（worktree 场景为绝对路径），
 * 测试自身的 execSync 若不清理，git init/config/add/commit 会被劫持
 * 到真实仓库（reinit 写 core.bare、config 写共享 config、提交落真实分支）。
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: tmp,
    env: cleanGitEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'git-utils-test-'))
  execSync('git init', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.name test', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.email test@test.local', {
    cwd: tmp,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  writeFileSync(resolve(tmp, 'a.txt'), 'init', 'utf-8')
  git('add -A')
  git('commit -m init')

  // CWD 动态取（getCwd() 每次调用时 resolve）→ chdir 后调用即落在 tmp；
  // chdir 只是让测试上下文与临时仓库一致，不再有加载顺序依赖
  process.chdir(tmp)
  gitUtils = await import('./git-utils.js')
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(tmp, { recursive: true, force: true })
})

describe('gitCommit e2e marker guard', () => {
  it('无标记文件时 auto-commit 正常执行', () => {
    writeFileSync(resolve(tmp, 'b.txt'), 'b', 'utf-8')
    const hash = gitUtils.gitCommit('normal commit')
    expect(hash).toBeTruthy()
    expect(git('log -1 --pretty=%B')).toContain('normal commit')
  })

  it('标记文件存在时跳过 auto-commit，且不产生新 commit', () => {
    mkdirSync(resolve(tmp, 'scripts'), { recursive: true })
    writeFileSync(resolve(tmp, 'scripts/.e2e-testing'), 'e2e in progress', 'utf-8')
    writeFileSync(resolve(tmp, 'c.txt'), 'c', 'utf-8')

    const hash = gitUtils.gitCommit('should be skipped')
    expect(hash).toBeNull()
    expect(git('log -1 --pretty=%B')).not.toContain('should be skipped')
  })

  it('删除标记文件后恢复 auto-commit', () => {
    rmSync(resolve(tmp, 'scripts/.e2e-testing'))
    writeFileSync(resolve(tmp, 'd.txt'), 'd', 'utf-8')
    const hash = gitUtils.gitCommit('resume commit')
    expect(hash).toBeTruthy()
    expect(git('log -1 --pretty=%B')).toContain('resume commit')
  })
})

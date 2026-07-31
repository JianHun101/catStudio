/**
 * git-utils e2e 标记文件守卫测试。
 *
 * gitCommit() 的模块级 CWD 在 import 时捕获 → 测试先 chdir 到临时 git 仓库，
 * 再动态 import 模块，让守卫逻辑在受控的临时仓库上运行。
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

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: tmp,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'git-utils-test-'))
  execSync('git init', { cwd: tmp, stdio: 'ignore' })
  execSync('git config user.name test', { cwd: tmp, stdio: 'ignore' })
  execSync('git config user.email test@test.local', { cwd: tmp, stdio: 'ignore' })
  writeFileSync(resolve(tmp, 'a.txt'), 'init', 'utf-8')
  git('add -A')
  git('commit -m init')

  // CWD 在模块加载时捕获 → 先 chdir 再 import
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

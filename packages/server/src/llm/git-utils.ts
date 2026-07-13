/**
 * Git + npm 工具函数 — 消息撤回支持。
 *
 * - auto-commit：每轮 Agent 完成后提交改动
 * - 撤回已完成消息：git reset --hard HEAD~1
 * - 撤回进行中消息：git checkout -- . + git clean -fd
 * - npm 精确卸载：记录消息执行前后 package.json 的依赖差异
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('git-utils')

const CWD = resolve(process.cwd())

/** 检查是否在 git 仓库内 */
function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: CWD, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 获取当前 HEAD commit hash */
export function getHeadCommit(): string | null {
  if (!isGitRepo()) return null
  try {
    return execSync('git rev-parse HEAD', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** git add -A && git commit */
export function gitCommit(message: string): string | null {
  if (!isGitRepo()) return null
  try {
    execSync('git add -A', { cwd: CWD, stdio: 'ignore' })
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: CWD, stdio: 'ignore' })
    const hash = getHeadCommit()
    log.info('auto commit', { message, hash })
    return hash
  } catch (err: any) {
    // 没有改动时 git commit 会非零退出，这是正常的
    log.info('auto commit skipped (no changes)', { message })
    return null
  }
}

/** 撤回已完成消息：git reset --hard HEAD~1 */
export function gitResetHard(): boolean {
  if (!isGitRepo()) return false
  try {
    execSync('git reset --hard HEAD~1', { cwd: CWD, stdio: 'ignore' })
    log.info('git reset --hard HEAD~1')
    return true
  } catch (err: any) {
    log.error('git reset failed', { error: err.message })
    return false
  }
}

/** 撤回进行中消息：还原所有未提交改动 */
export function gitCleanWorkingTree(): boolean {
  if (!isGitRepo()) return false
  try {
    execSync('git checkout -- .', { cwd: CWD, stdio: 'ignore' })
    execSync('git clean -fd', { cwd: CWD, stdio: 'ignore' })
    log.info('git checkout -- . + git clean -fd')
    return true
  } catch (err: any) {
    log.error('git clean failed', { error: err.message })
    return false
  }
}

/** 读取 package.json 中的 dependencies + devDependencies 包名集合 */
function readPkgDeps(): Set<string> {
  const pkgs = new Set<string>()
  try {
    const raw = readFileSync(resolve(CWD, 'package.json'), 'utf-8')
    const json = JSON.parse(raw)
    for (const key of ['dependencies', 'devDependencies'] as const) {
      if (json[key] && typeof json[key] === 'object') {
        for (const pkg of Object.keys(json[key])) {
          pkgs.add(pkg)
        }
      }
    }
  } catch { /* 读不到就算了 */ }
  return pkgs
}

/** 拍快照：返回当前 package.json 中的包名集合 */
export function snapshotPackageDeps(): string[] {
  return Array.from(readPkgDeps())
}

/** 对比快照，返回新增的包名 */
export function diffNewPackages(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before)
  return after.filter((pkg) => !beforeSet.has(pkg))
}

/** npm uninstall 指定包列表 */
export function npmUninstall(packages: string[]): void {
  if (packages.length === 0) return
  for (const pkg of packages) {
    try {
      execSync(`npm uninstall ${pkg}`, { cwd: CWD, stdio: 'ignore' })
      log.info('npm uninstall', { package: pkg })
    } catch {
      log.warn('npm uninstall failed', { package: pkg })
    }
  }
}

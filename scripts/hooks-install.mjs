/**
 * 钩子维护器——确保 core.hooksPath 恒等于 .husky（幂等）。
 *
 * 背景（2026-09-05 hooks 根修单，第三次同因复发后立根修）：husky v9 的
 * prepare（node_modules/husky/index.js）会在每次 pnpm/npm install 时无条件执行
 *   git config core.hooksPath .husky/_
 * 把钩子目录指到 `.husky/_`——但本仓库钩子已是自包含脚本
 * （.husky/post-commit|pre-commit|pre-push 直接执行，不 source _/husky.sh shim，
 * 自 1e0d812 起迁移），且 `.husky/_` 是仓库内一个 168B 的跟踪占位文件而非目录。
 * hooksPath=.husky/_ 时 git 找 .husky/_/<hook> → ENOTDIR → 钩子全哑、审查链静默断。
 * 本仓库不需要 husky 的 shim 机制，hooksPath 必须恒为 .husky（真实钩子所在目录）。
 *
 * 本脚本替代 package.json 原 `"prepare": "husky"`——每次 install 后运行一次，
 * 值已正确则 no-op，漂移（被旧 husky prepare / 手工写坏）则修正回 .husky。
 * 同时是可手动重跑的恢复工具：node scripts/hooks-install.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 非 git 检出（如被作为依赖装进别的项目）→ 跳过，不写任何 config。
// main 仓库 .git 是目录、linked worktree 的 .git 是指针文件——existsSync 均命中。
if (!existsSync(path.join(ROOT, '.git'))) {
  process.exit(0)
}

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
}

const read = git(['config', '--get', 'core.hooksPath'])
const current = read.status === 0 ? read.stdout.trim() : null // null = 未设置

if (current === '.husky') {
  console.log('[hooks-install] core.hooksPath 已是 .husky（无需动作）')
  process.exit(0)
}

const set = git(['config', 'core.hooksPath', '.husky'])
if (set.status !== 0) {
  console.error(`[hooks-install] 设置 core.hooksPath=.husky 失败: ${(set.stderr || '').trim()}`)
  process.exit(1)
}

console.log(
  current === null
    ? '[hooks-install] core.hooksPath 未设置（git 默认 .git/hooks → 钩子全哑）→ 已设为 .husky'
    : `[hooks-install] core.hooksPath 漂移为 "${current}" → 已修正回 .husky`
)

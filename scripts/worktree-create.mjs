/**
 * CatStudy worktree 创建脚本（worktree 落地方案单①）。
 *
 * worktree 落地方案定稿契约（2026-08，店长裁决 + 吐槽猫核实）：审查链 hook 在
 * worktree 默认全哑——.husky/_ 被自身 .gitignore（内容 `*`）排除、git 不跟踪；
 * core.hooksPath = .husky/_ 是 repo 级 config（worktree 共享）且相对 worktree
 * 根解析；worktree 无 node_modules（.gitignore:2），pre-commit 的 npx
 * lint-staged / pnpm lint / pnpm test 全依赖依赖面；.push-gate 本地不跟踪
 * （.gitignore:54），worktree 内 push 必被阻断——这是防御正确的预期行为。
 *
 * 本脚本做四件事：门禁校验（主工作区干净 + origin/dev 是 dev 祖先）→ 创建 worktree
 * （目录在仓库外）→ hook 引导（复制 .husky/ 整目录，含 _ shim）→ 依赖引导
 * （worktree 内 pnpm install）。复制在前、install 在后：install 的
 * prepare:husky 会再生 shim（cwd=worktree），复制是 install 失败时的兜底。
 *
 * 用法: node scripts/worktree-create.mjs <feature>
 *   feature: 功能名 → 分支 feat/{feature}、目录 ../catstudy-{feature}（仓库外）
 *
 * 纯 node 内置模块，无第三方依赖（同 dev.js 约定）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const isWindows = process.platform === 'win32'

// git 分支名约束（git check-ref-format 的宽松子集，覆盖常见非法形态）
const FEATURE_RE = /^[A-Za-z0-9._-]+$/

/** 失败即退出（带 [worktree] 前缀，与 dev.js 的 [dev] 风格一致） */
function fail(msg) {
  console.error(`[worktree] ${msg}`)
  process.exit(1)
}

/**
 * 执行 git。数组参数 spawn——无 shell（Windows 下 git.exe 原生可解析，
 * 规避 .cmd 包装与 shell:true 的项目约定）；路径含空格由数组参数天然隔离。
 */
function git(args, { cwd = ROOT, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 && !allowFail) {
    fail(`git ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`)
  }
  return r
}

// ─── 参数与前置校验 ────────────────────────────────

const feature = process.argv[2]
if (!feature) {
  fail('用法: node scripts/worktree-create.mjs <feature>')
}
if (!FEATURE_RE.test(feature) || feature.startsWith('-') || feature === '.' || feature === '..') {
  fail(`feature 名非法: ${feature}（仅允许字母/数字/._-，不以 - 开头）`)
}

const branch = `feat/${feature}`
const wtDir = path.resolve(ROOT, '..', `catstudy-${feature}`)

// 必须从主工作区运行——worktree 内嵌套创建会拿到嵌套的 hooksPath 语义，
// 且清理复杂度翻倍，直接拒绝。
const gitDir = git(['rev-parse', '--git-dir']).stdout.trim()
if (/(^|[\\/])worktrees([\\/]|$)/.test(gitDir)) {
  fail('必须在主工作区运行本脚本（当前已是 worktree）')
}

// 1. 主工作区干净校验（git status --porcelain 含 untracked，非空即不干净）
const statusOut = git(['status', '--porcelain']).stdout.trim()
if (statusOut) {
  fail(`主工作区不干净，先提交或清理再创建 worktree:\n${statusOut}`)
}

// 2. fetch 确保远端最新（门禁比较需要新鲜的 origin/dev；失败即退出）
git(['fetch'])
console.log('[worktree] fetch 完成')

// 3. 门禁: origin/dev 必须是 dev 的祖先（分叉/落后 → 拒绝；dev 领先 → 放行——
// 日常提交落 dev 不推送、收口时统一 push 是项目常态，领先 ≠ 分叉；祖先判断
// 表达门禁原意「worktree 基线包含远端全部内容」，收口时 ff-only 才能成功。
// 门禁失败提示不指「先同步」——同步动作归收口链，实施猫无权限执行）
const devSha = git(['rev-parse', 'dev']).stdout.trim()
const originRes = git(['rev-parse', 'origin/dev'], { allowFail: true })
if (originRes.status !== 0) {
  fail('origin/dev 不存在——请先推送 dev 或确认远端配置')
}
const ancestorRes = git(['merge-base', '--is-ancestor', 'origin/dev', 'dev'], { allowFail: true })
if (ancestorRes.status !== 0) {
  fail(
    `门禁未通过: origin/dev(${originRes.stdout.trim().slice(0, 7)}) 不是 dev(${devSha.slice(0, 7)}) 的祖先` +
      '——dev 落后或分叉，需店长先收口同步，或报告店长处理'
  )
}

// 4. 目标分支与目录不存在性检查（已存在 → 收口清理或换 feature 名）
if (git(['rev-parse', '--verify', '--quiet', branch], { allowFail: true }).status === 0) {
  fail(`分支 ${branch} 已存在——先收口清理或换 feature 名`)
}
if (existsSync(wtDir)) {
  fail(`目标目录已存在: ${wtDir}——先清理（git worktree remove / 手动删除）`)
}

// ─── 创建 worktree ─────────────────────────────────

// 5. worktree add（目录在仓库外；Windows 路径规范化：统一正斜杠防转义歧义）
const wtArg = wtDir.replace(/\\/g, '/')
console.log(`[worktree] 创建 worktree: ${wtArg}（分支 ${branch}，基线 dev=${devSha.slice(0, 7)}）`)
git(['worktree', 'add', '-b', branch, wtArg, 'dev'])

// 6. hook 引导：复制 .husky/ 整目录（含 _ shim）。worktree checkout 只带被跟踪
// 文件（.husky/pre-commit 等），.husky/_ 不被跟踪——不复制则 hooksPath 指向
// 不存在的 .husky/_ → hook 全哑。复制在前、install 在后（见文件头注释）。
cpSync(path.join(ROOT, '.husky'), path.join(wtDir, '.husky'), { recursive: true })
console.log('[worktree] 已复制 .husky/ → worktree（hook 引导就位）')

// 7. 依赖引导：worktree 内 pnpm install（走全局 store 缓存；prepare:husky
// 以 worktree 为 cwd 再生 shim）。pnpm 在 Windows 是 .cmd 包装——cmd /c 执行
// （dev.js NapCat 同款），非 Windows 直接 spawn。
const installRes = isWindows
  ? spawnSync('cmd.exe', ['/c', 'pnpm', 'install'], {
      cwd: wtDir,
      stdio: 'inherit',
      windowsHide: true,
    })
  : spawnSync('pnpm', ['install'], { cwd: wtDir, stdio: 'inherit' })

if (installRes.status !== 0) {
  // worktree 保留现场供诊断（.husky 已复制兜底，hook 可命中而非静默跳过）
  console.error('[worktree] pnpm install 失败——worktree 已保留现场，可手动重试 pnpm install')
  console.error('[worktree] 清理命令:')
  console.error(`  git worktree remove --force ${wtArg}`)
  console.error(`  git branch -D ${branch}`)
  process.exit(1)
}

// ─── 输出 ─────────────────────────────────────────

const hooksPath = git(['config', '--get', 'core.hooksPath'], { cwd: wtDir }).stdout.trim()
console.log('')
console.log('[worktree] ✅ worktree 就绪')
console.log(`  目录: ${wtArg}`)
console.log(`  分支: ${branch}`)
console.log(
  `  hooksPath: ${hooksPath || '(未继承，请检查)'}（repo 级 config，相对 worktree 根解析）`
)
console.log('')
console.log('使用说明:')
console.log(`  git -C ${wtArg} status   # 一切 git 操作带 -C，或 cd 进 worktree 目录`)
console.log('  提交走标准链: commit message 带 catstudy [uuid] 标记、限定路径')
console.log(
  '  ⚠️ push 必失败（worktree 无 .push-gate，pre-push 门禁拦截）——预期行为，绝不 git push --no-verify 绕过'
)
console.log(
  '  收口归店长（主工作区执行）: ff-only 合并 → 删分支 → 更新 .push-gate → push → git worktree remove'
)

/**
 * CatStudy 类型检查直调脚本（lint 直调单，2026-09-11）。
 *
 * 为什么不再用 `pnpm -r lint`（原实现）：
 *   pnpm 把 task run state 放在 <workspace root>/node_modules/.pnpm-task-run-state-v1，
 *   并**拒绝**该位置是符号链接/非目录的形态（ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH）。
 *   会话 worktree 的 node_modules 正是链接形态（指向主仓库的 pnpm store）⇒
 *   `pnpm -r lint` 在 worktree 内恒 exit 1，与源码有没有类型错误无关——于是
 *   `pnpm lint` 这道闸在 worktree 里长期是假的。触发点是 `-r` 的递归调度：非递归的
 *   `pnpm run <script>` 不读该状态目录（实测：2026-09-11，本 worktree）。
 *
 * 本脚本绕开递归调度：按写死的包清单，串行直调各包 node_modules 内的类型检查二进制，
 * node 直接执行 JS 入口——不用 .bin 下的 .cmd 包装、不经 shell（AGENTS.md Gotchas
 * 的同一条约定）。任一包失败 → 整体 exit 1，交给 .husky/pre-commit 的 set -e 断提交。
 *
 * 包清单**写死**是有意的（不从 packages/ 扫）：漏扫一个包 = 静默漏检，而静默漏检正是
 * 本单要治的病。代价是清单会与磁盘漂移，故配两道**显式**护栏（都不静默）：
 *   ① 磁盘上声明了 `lint` 脚本的包 ≠ 本清单 → 报错退出，列出差异；
 *   ② 清单里的命令 ≠ 包 package.json 的 `lint` 脚本 → 报错退出（防两处真相漂移）。
 * 护栏命中即整体失败（fail-closed）：宁可挡住提交让人来同步，也不放过没被检查的代码。
 *
 * 路径一律相对本脚本位置解析（无绝对路径字面值）：主工作区与 worktree 下都指向
 * 「当前仓库」，换机器/换盘符/换 worktree 都不必改脚本。
 *
 * 用法: node scripts/lint.js      （= pnpm lint，根 package.json 已接上）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * 包清单（写死）。
 *   dir      — 包目录，相对仓库根
 *   provider — 提供二进制的包名（装在 <dir>/node_modules/ 下）
 *   bin      — provider 的 bin 名（其 package.json `bin` 字段里的键）
 *   args     — 传给二进制的参数
 * 三项与各包 package.json 的 `lint` 脚本逐字对应（护栏②校验）。
 */
export const PACKAGES = [
  { dir: 'packages/shared', provider: 'typescript', bin: 'tsc', args: ['--noEmit'] },
  { dir: 'packages/server', provider: 'typescript', bin: 'tsc', args: ['--noEmit'] },
  { dir: 'packages/web', provider: 'vue-tsc', bin: 'vue-tsc', args: ['--noEmit'] },
]

/** 失败即退出（[lint] 前缀，与 dev.js / worktree-create.mjs 的日志风格一致） */
function fail(msg) {
  console.error(`[lint] ${msg}`)
  process.exit(1)
}

/** 读包 manifest；不存在或解析不了都显式报错，不静默跳过。 */
function readManifest(pkgDir) {
  const manifestPath = path.join(ROOT, pkgDir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${pkgDir}/package.json 不存在——清单与磁盘不齐，请同步 scripts/lint.js`)
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail(`${pkgDir}/package.json 解析失败: ${err.message}`)
  }
}

/**
 * 护栏①②：清单 ↔ 磁盘对账。任一条不齐 → 报错退出（fail-closed），绝不静默漏检。
 */
function assertManifestInSync() {
  const packagesDir = path.join(ROOT, 'packages')
  const onDisk = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}`)
        .filter((dir) => existsSync(path.join(ROOT, dir, 'package.json')))
        .filter((dir) => typeof readManifest(dir).scripts?.lint === 'string')
        .sort()
    : []

  const listed = PACKAGES.map((p) => p.dir).sort()
  const notListed = onDisk.filter((dir) => !listed.includes(dir))
  const notOnDisk = listed.filter((dir) => !onDisk.includes(dir))
  if (notListed.length > 0 || notOnDisk.length > 0) {
    const lines = ['包清单与磁盘不齐（scripts/lint.js 的 PACKAGES）:']
    if (notListed.length > 0) lines.push(`  磁盘上声明了 lint 但清单漏了: ${notListed.join(', ')}`)
    if (notOnDisk.length > 0)
      lines.push(`  清单里有但磁盘上没有 lint 脚本: ${notOnDisk.join(', ')}`)
    lines.push('  修复 = 同步 PACKAGES 后再提交（本检查 fail-closed，不静默漏检）')
    fail(lines.join('\n'))
  }

  // 护栏②：清单命令 vs 包自身 `lint` 脚本，逐字一致——两处真相漂移必须当场暴露，
  // 否则改了 package.json 却忘了改这里，闸门会按旧命令跑（静默跑偏）。
  for (const pkg of PACKAGES) {
    const declared = readManifest(pkg.dir).scripts.lint.trim().split(/\s+/)
    const expected = [pkg.bin, ...pkg.args]
    if (declared.join(' ') !== expected.join(' ')) {
      fail(
        `${pkg.dir} 的 lint 脚本「${declared.join(' ')}」与清单「${expected.join(' ')}」不一致` +
          '——两处真相漂移，请同步 scripts/lint.js 的 PACKAGES'
      )
    }
  }
}

/**
 * 解析 provider 包内 bin 的 JS 入口。绝对路径现算（path.resolve），源码内不落字面值。
 * 入口路径会穿过 node_modules 的链接——实测在会话 worktree 内畅通（三包 exit 0）。
 */
function resolveBinEntry(pkgDir, provider, binName) {
  const manifestPath = path.join(ROOT, pkgDir, 'node_modules', provider, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${pkgDir} 下缺 ${provider}——先在仓库根跑 pnpm install（worktree 内同样）`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail(`${pkgDir}/node_modules/${provider}/package.json 解析失败: ${err.message}`)
  }

  const relEntry =
    typeof manifest.bin === 'string'
      ? binName === provider
        ? manifest.bin
        : null
      : manifest.bin?.[binName]
  if (!relEntry) {
    fail(`${provider} 未声明 bin「${binName}」——provider/bin 对不上，请同步 scripts/lint.js`)
  }

  const entry = path.resolve(path.dirname(manifestPath), relEntry)
  if (!existsSync(entry)) {
    fail(`${provider} 的 bin 入口不存在: ${path.relative(ROOT, entry)}`)
  }
  return entry
}

/** 跑单个包的检查；返回是否通过（启动失败也计失败，不当作通过）。 */
function runPackage({ dir, provider, bin, args }) {
  const entry = resolveBinEntry(dir, provider, bin)
  console.log(`[lint] ${dir}: ${bin} ${args.join(' ')}`)
  const res = spawnSync(process.execPath, [entry, ...args], {
    cwd: path.join(ROOT, dir),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (res.error) {
    console.error(`[lint] ${dir} 启动失败: ${res.error.message}`)
    return false
  }
  return res.status === 0
}

/** 串行跑完清单，收集失败项——一次跑全比踩第一个坑就停更有用，退出码仍为 1。 */
function main() {
  assertManifestInSync()

  const failed = []
  for (const pkg of PACKAGES) {
    if (!runPackage(pkg)) failed.push(pkg.dir)
  }

  if (failed.length > 0) {
    console.error(`[lint] ❌ 类型检查未通过: ${failed.join(', ')}`)
    return 1
  }
  console.log(`[lint] ✅ 类型检查通过（${PACKAGES.length} 个包）`)
  return 0
}

/**
 * 只有 `node scripts/lint.js` 直跑才做检查；被 import（scripts/lint.test.js 断言
 * PACKAGES 形状）时只导出常量，零副作用。
 */
function isDirectInvocation() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const norm = (p) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  return norm(argv1) === norm(fileURLToPath(import.meta.url))
}

if (isDirectInvocation()) {
  process.exit(main())
}

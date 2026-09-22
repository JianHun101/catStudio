// 源码注释面「路径:行号」锚 —— 取数探针（**只取数，不判失效**）
//
// 用法：在主仓库根跑 `node docs/run/line-anchor-source-comments/probe.mjs`
//
// 设计取舍（重要）：
//   - 本脚本**不做**「这个锚失效了没」的判定。起草期试过自动判定（符号名 ±N 行窗口），
//     双向都有误报——弱符号名（node/busy）假阳、符号名写在上一行时取不到造成假阴。
//     **失效判定必须由人读目标行原文得出**（票面 §2.4）。
//   - 本脚本的产出 = 锚清单 + 目标行原文，供人逐条判。
//   - 判据不按扩展名枚举（票面 §2.1）：凡 `<路径>:<行号>` 且该路径能后缀匹配到
//     `git ls-files` 里的真文件，即属本族。这天然排除 IP:端口 / 模型 tag / URL。
//   - 引用方排除测试文件（`.test.` / `.spec.`）；引用**目标**不设限。

import { execSync } from 'node:child_process'
import fs from 'node:fs'

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const run = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })

const files = run('git ls-files').split('\n').filter(Boolean)
const lineCache = new Map()
const linesOf = (p) => {
  if (!lineCache.has(p)) lineCache.set(p, fs.readFileSync(`${ROOT}/${p}`, 'utf8').split('\n'))
  return lineCache.get(p)
}

const ANCHOR = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}):(\d+)(?:-(\d+))?/g

const grepOut = run('git grep -nE "[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,6}:[0-9]+" -- packages scripts')

const rows = []
for (const line of grepOut.split('\n')) {
  if (!line) continue
  const m = line.match(/^([^:]+):(\d+):(.*)$/)
  if (!m) continue
  const [, srcFile, srcLine, text] = m
  if (/\.(test|spec)\./.test(srcFile)) continue

  for (const a of text.matchAll(ANCHOR)) {
    const [anchor, refPath, from, to] = a
    if (text.slice(Math.max(0, (a.index ?? 0) - 2), a.index ?? 0) === '//') continue // URL
    const cands = files.filter((c) => c === refPath || c.endsWith('/' + refPath))
    if (!cands.length) continue // 不是文件路径（IP / 模型 tag / 已删文件）
    const resolved = cands.length === 1 ? cands[0] : null
    const n = Number(from)
    let target = 'AMBIGUOUS: ' + cands.map((c) => c.split('/').slice(-2).join('/')).join(' | ')
    if (resolved) {
      const tl = linesOf(resolved)
      target =
        n > tl.length
          ? `OUT-OF-RANGE（该文件仅 ${tl.length} 行）`
          : (tl[n - 1] ?? '').trim().slice(0, 76)
    }
    rows.push({
      src: `${srcFile}:${srcLine}`,
      anchor,
      span: to ? `${from}-${to}` : from,
      resolved: resolved ?? '?',
      target,
    })
  }
}

console.log(`源码注释面「路径:行号」锚 —— ${rows.length} 条（引用方已排除测试文件）`)
console.log('判定方式：逐条读下方「目标行原文」，自己在上下文里判 MATCH / ROTATED / WRONG-FILE。\n')
for (const r of rows) {
  console.log(`${r.src}\n  锚 → ${r.anchor}\n  目标行原文: ${r.target}\n`)
}

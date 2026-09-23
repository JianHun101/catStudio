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
//   - **C 档（目标已删 / 已迁走）单独出口**（审查 P2-2）：目标文件已删时，「真文件」这道门必然
//     匹配不到 ⇒ 若只判这一道，C 档就**构造上不可达**（判据恰好排除掉它要处理的东西）。
//     故第二道门用**机制级判据**补：该路径是否出现在 git 历史的**删除记录**
//     **或 rename 的旧路径**里（`git log --all --diff-filter=RD --name-status`）。
//     命中 ⇒ C 档候选；不命中 ⇒ 面外（IP:端口 / 模型 tag / 对比度比值的同形异义）。
//     ⚠️ **只取 `--diff-filter=D` 会漏掉 rename 的旧路径**（审查 R2-P2 实测：82 条 rename-old
//     与 229 条 D 记录**零重叠**）——旧路径既不在 `ls-files` 里、也不在删除记录里，
//     会静默落「面外」，与「本就无可指」同形。
//   - 探针基名字符类**允许内嵌点号**（审查 P2-1）：旧版 `[A-Za-z0-9_-]+` 把
//     `socketio.test.ts:2075` 拆成 `test.ts:2075` → 后缀匹配不到真文件 → 静默丢弃。
//     承重过滤是「真文件门」而不是字符类宽度，放宽安全。

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

// 基名字符类含 `.`（旧版不含 ⇒ `socketio.test.ts:2075` 被拆成 `test.ts:2075` 后丢弃）
const ANCHOR = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}):(\d+)(?:-(\d+))?/g

const grepOut = run('git grep -nE "[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,6}:[0-9]+" -- packages scripts')

// C 档出口的第二道门：历史中**被删**或**被迁走（rename）**的路径（机制级判据，非扩展名枚举）。
// 必须用 `--name-status`：`--name-only` 对 rename 行只给**新**路径，取不到旧路径。
const histRows = run('git log --all --diff-filter=RD --name-status --format=')
  .split('\n')
  .filter(Boolean)
const deletedPaths = []
const renamedOld = new Map() // 旧路径 → 新路径（出口的 `was` 要注明迁往何处）
for (const row of histRows) {
  const cols = row.split('\t')
  if (cols[0] === 'D') deletedPaths.push(cols[1])
  else if (/^R\d+$/.test(cols[0])) renamedOld.set(cols[1], cols[2])
}

const rows = []
const cRows = [] // 目标已删（C 档候选）
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
    if (!cands.length) {
      // 第二道门：解析不到真文件 ⇒ C 档（目标已删 / 已迁走）或面外同形异义
      const gone = deletedPaths.filter((d) => d === refPath || d.endsWith('/' + refPath))
      const moved = [...renamedOld.keys()].filter((d) => d === refPath || d.endsWith('/' + refPath))
      if (gone.length) cRows.push({ src: `${srcFile}:${srcLine}`, anchor, was: gone.join(' | ') })
      else if (moved.length)
        cRows.push({
          src: `${srcFile}:${srcLine}`,
          anchor,
          was: moved.map((m) => `${m} → ${renamedOld.get(m)}`).join(' | '),
          moved: true,
        })
      continue
    }
    const resolved = cands.length === 1 ? cands[0] : null
    const n = Number(from)
    let target = 'AMBIGUOUS: ' + cands.map((c) => c.split('/').slice(-2).join('/')).join(' | ')
    if (resolved) {
      const tl = linesOf(resolved)
      // 空白行必须**显式标注**：旧版直接印空串，与「没什么可看」同形（本族）
      const raw = (tl[n - 1] ?? '').trim()
      target =
        n > tl.length
          ? `OUT-OF-RANGE（该文件仅 ${tl.length} 行）`
          : raw.slice(0, 76) || '（该行为空白 —— 锚落在空行上，非「无内容可看」）'
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

// C 档单独出口：目标已删 / 已迁走 ⇒ 「真文件门」结构上取不到它，须另判
console.log(
  `\n== C 档（目标已删 或 已迁走，须按 §2.5「先判声称性质」处置）—— ${cRows.length} 条 ==`
)
for (const r of cRows) {
  console.log(`${r.src}\n  锚 → ${r.anchor}\n  ${r.moved ? '已迁走' : '已删路径'}: ${r.was}\n`)
}

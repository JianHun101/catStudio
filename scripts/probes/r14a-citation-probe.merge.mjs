#!/usr/bin/env node
/**
 * R14a S2 分片产物合并（票面 §八 验收 8）
 *
 * 背景：S2 首跑把 4 provider × 15 次调用压在**一个进程**里，`--out` 只在全部跑完时
 * 写一次 ⇒ 进程一死，30 次已完成调用的读数**全部归零**（票面 §六「S2 分片跑法」）。
 * 改按 provider 分片后，四片各写各的 JSON；本脚本把碎片拼回一份合并产物。
 *
 * ## 为什么不手抄分片汇总
 *
 * 票面 §八.8 明写「`summary` **重算**（不手抄分片汇总）」。手抄 = 又造一个真相源。
 * 故此处**直接复用探针导出的 `summarize`**（`r14a-citation-probe.e2e.mjs`）——
 * 合并口径与分片口径由**同一份代码**保证，不靠人对照。
 *
 * 探针底部有 `isEntry` 守卫 ⇒ import 它**不会**触发跑批。
 *
 * ## 用法
 *
 *   node scripts/probes/r14a-citation-probe.merge.mjs \
 *     --date 2026-09-23 \
 *     --out docs/eval/r14a-citation-probe-2026-09-23-s2.json \
 *     [--reason ollama=本地模型超时]
 *
 * 分片文件按 `docs/eval/r14a-citation-probe-<date>-s2-<provider>.json` 约定路径查找；
 * 缺失的片**显式记「未测 + 原因」**——票面 §八.8 禁止用别的 provider 顶替、禁止悄悄改 N。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { summarize } from './r14a-citation-probe.e2e.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** S2 的 provider 全集。分片**逐个独立**跑，任一片缺失只标该片「未测」。 */
export const SHARD_PROVIDERS = ['claude', 'opencode', 'dsh', 'ollama']

export function shardFile(date, provider) {
  return `docs/eval/r14a-citation-probe-${date}-s2-${provider}.json`
}

/**
 * 合并分片。纯函数（不读盘），便于单测。
 *
 * @param {Array<{provider: string, report: object|null, reason?: string}>} shards
 * @returns {object} 合并产物
 * @throws 分片之间 `n` / `variants` 不一致时抛错——**不悄悄改 N**（票面 §八.8）
 */
export function mergeShards(shards) {
  const present = shards.filter((s) => s.report)

  if (present.length === 0) throw new Error('无任何分片产物可合并')

  const n = present[0].report.n
  for (const s of present) {
    if (s.report.n !== n) {
      throw new Error(`分片 N 不一致：${s.provider}=${s.report.n}，首个=${n}（票面禁止悄悄改 N）`)
    }
  }
  const variants = present[0].report.variants
  for (const s of present) {
    if (JSON.stringify(s.report.variants) !== JSON.stringify(variants)) {
      throw new Error(`分片 variants 不一致：${s.provider}`)
    }
  }

  // runs 拼接：按 SHARD_PROVIDERS 的固定序（不是文件系统序），保证同输入同产物字节
  const runs = []
  for (const provider of SHARD_PROVIDERS) {
    const s = shards.find((x) => x.provider === provider)
    if (s?.report) runs.push(...s.report.runs)
  }
  // 未知 provider 的片也不丢——按传入序追加（顺序稳定即可复现）
  for (const s of shards) {
    if (s.report && !SHARD_PROVIDERS.includes(s.provider)) runs.push(...s.report.runs)
  }

  const providers = present.flatMap((s) => s.report.providers ?? [])

  return {
    ok: true,
    mode: 's2',
    merged: true,
    ranAt: new Date().toISOString(),
    n,
    variants,
    instructions: present[0].report.instructions,
    questionSet: present[0].report.questionSet,
    // 分母口径：**实际跑满的 provider 数**（票面 §八.8 要求写死）
    providersTested: present.length,
    providersExpected: shards.length,
    shards: shards.map((s) => ({
      provider: s.provider,
      file: s.file ?? null,
      present: Boolean(s.report),
      runs: s.report ? s.report.runs.length : 0,
      expectedRuns: s.report ? s.report.n * s.report.questionSet.length : null,
      // 缺片必须带原因；无原因也不许静默——留确定性占位
      reason: s.report ? null : (s.reason ?? '未提供原因'),
    })),
    providers,
    runs,
    summary: summarize(runs),
  }
}

function parseArgs(argv) {
  const args = { date: null, out: null, reasons: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--date') args.date = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--reason') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) args.reasons[kv.slice(0, eq)] = kv.slice(eq + 1)
      else args.fallbackReason = kv
    } else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || !args.date || !args.out) {
    process.stderr.write(
      '用法：node scripts/probes/r14a-citation-probe.merge.mjs --date <YYYY-MM-DD> ' +
        '--out <合并产物路径> [--reason <provider>=<原因>]\n'
    )
    return args.help ? 0 : 2
  }

  const shards = SHARD_PROVIDERS.map((provider) => {
    const rel = shardFile(args.date, provider)
    const abs = path.resolve(REPO_ROOT, rel)
    if (!existsSync(abs)) {
      return {
        provider,
        file: rel,
        report: null,
        reason: args.reasons[provider] ?? args.fallbackReason,
      }
    }
    return { provider, file: rel, report: JSON.parse(readFileSync(abs, 'utf8')) }
  })

  const merged = mergeShards(shards)
  const outAbs = path.resolve(REPO_ROOT, args.out)
  mkdirSync(path.dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, JSON.stringify(merged, null, 2))

  const missing = merged.shards.filter((s) => !s.present)
  process.stderr.write(
    `[r14a-merge] 合并 ${merged.providersTested}/${merged.providersExpected} 片，` +
      `runs=${merged.runs.length} ⇒ ${outAbs}\n`
  )
  for (const s of missing) {
    process.stderr.write(`[r14a-merge]   未测：${s.provider}（${s.reason}）\n`)
  }
  return 0
}

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry) process.exit(main())

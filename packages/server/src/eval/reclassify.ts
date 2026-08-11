/**
 * P5 全量重评脚本 — 按当前 classification_ver 重算全部 episode 结局。
 *
 * 用途：episodes 判定规则升级（EPISODE_CLASSIFICATION_VER 常量变更）后手动触发
 * 一次全量 upsert 重评——幂等，重评结果覆盖历史结局（规格 §3 P5 承重假设）。
 * 纯规则引擎 + 状态机，零 LLM 调用（P5 重评是跑表不是打分，K5 评分线独立关闸）。
 *
 * 运行: npx tsx packages/server/src/eval/reclassify.ts
 *
 * 输出：按 outcome × root_triggered_by 分组统计——任务结局只统计在 U 根
 * episode 上（success 计数唯一归属 U 根），H 根（审查链）不参与任务结局计数
 * （规格 G2 拍板），仅列审查链元指标。
 */
import { initDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { classifyEpisodes, episodeStats, EPISODE_CLASSIFICATION_VER } from './episodes.js'

const OUTCOME_LABELS = [
  'success',
  'corrected_success',
  'needs_investigation',
  'harness_fix_needed',
  'routing_failure',
  'abandoned',
  'unclassified',
]

function main(): void {
  initDb()
  initRepository(getDb())

  console.log(`[reclassify] 判定规则版本: ${EPISODE_CLASSIFICATION_VER}`)
  const { upserted, open } = classifyEpisodes()
  console.log(`[reclassify] 全量重评完成：upsert ${upserted} 条，在途 open ${open} 条（不归因）`)

  const stats = episodeStats()
  if (stats.versionStale > 0) {
    console.log(
      `[reclassify] ⚠️  版本偏差存量行 ${stats.versionStale} 条（classification_ver ≠ 当前版本）——本轮已覆盖`
    )
  }

  console.log('[reclassify] ── U 根任务结局计数（旗舰指标口径，H 根不双计）──')
  for (const label of OUTCOME_LABELS) {
    const cnt = stats.uRoot[label] ?? 0
    console.log(`  ${label.padEnd(20)} ${cnt}`)
  }
  console.log('[reclassify] ── H 根审查链计数（不计任务结局）──')
  for (const label of OUTCOME_LABELS) {
    const cnt = stats.hRoot[label] ?? 0
    if (cnt > 0) console.log(`  ${label.padEnd(20)} ${cnt}`)
  }
  const hTotal = Object.values(stats.hRoot).reduce((s, n) => s + n, 0)
  if (hTotal === 0) console.log('  （无 H 根 episode）')
  console.log(`[reclassify] 在途（open，结局未定）: ${stats.open}`)
}

main()

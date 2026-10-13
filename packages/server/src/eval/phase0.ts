/**
 * Phase 0 选型预验证（W2 L2 评估子系统）。
 *
 * 契约要点：
 * - 50 条 = 30 猫咖真实（来源限定 DS 族猫，排除 ollama 猫）+ 20 外部构造对照
 * - 判定口径：score ≥4 通过 / ≤2 不通过 / 3 不计
 * - 主指标：Spearman ≥ 0.7 且与人工一致率 ≥ 80%；子指标：自有族 vs 外部
 *   一致率差距 ≤ 15pp（超阈否决）；主指标并列时跨族优先
 * - 失败面收敛在 Phase 0 内部：任一候选不通过即淘汰，全灭回退（不接线上）
 *
 * 使用：
 *   npx tsx src/eval/phase0.ts --collect   # 收集 30 条真实回复 → 标注文件
 *   npx tsx src/eval/phase0.ts --run       # 标注完成后跑全候选评分 + 闸门报告
 *
 * 双形态：纯统计/挑选函数导出供 co-located 测试；CLI 入口 isMain 保护，
 * 测试 import 零副作用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AgentConfig } from '@cat-study/shared'
import { getAdapterForAgent } from '../llm/registry.js'
import { buildGEvalPrompt, judgeChatOptions, parseJudgeOutput, truncateForJudge } from './scorer.js'
import { initDb, getDb } from '../db/index.js'
import {
  initRepository,
  messages as messagesRepo,
  agents as agentsRepo,
} from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('eval-phase0')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVAL_DATA_DIR = path.join(__dirname, '..', '..', 'data', 'eval')
const SAMPLES_FILE = path.join(EVAL_DATA_DIR, 'phase0-samples.json')
const REPORT_FILE = path.join(EVAL_DATA_DIR, 'phase0-report.json')

// ─── 样本类型 ────────────────────────────────────────

export interface Phase0Sample {
  id: string
  source: 'real' | 'external'
  sessionId?: string
  messageId?: string
  agentName?: string
  /** 前置消息（时间正序，最多 9 条） */
  context: string[]
  reply: string
  /** 人工标注 1-5；null = 待标注 */
  humanScore: number | null
}

// ─── 统计纯函数（测试覆盖） ──────────────────────────

/** 平均秩（ties 取均值），1-based */
export function rank(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  return values.map((v) => {
    let first = -1
    let last = -1
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] === v) {
        if (first === -1) first = i
        last = i
      }
    }
    return (first + last) / 2 + 1
  })
}

/** Spearman 秩相关（Pearson on ranks）。样本 <2 或分母为 0 → NaN */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN
  const rx = rank(xs)
  const ry = rank(ys)
  const n = rx.length
  const meanX = rx.reduce((a, b) => a + b, 0) / n
  const meanY = ry.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i] - meanX) * (ry[i] - meanY)
    dx += (rx[i] - meanX) ** 2
    dy += (ry[i] - meanY) ** 2
  }
  const denom = Math.sqrt(dx * dy)
  return denom === 0 ? NaN : num / denom
}

/** 判定口径：≥4 通过 / ≤2 不通过 / 3 不计 */
export function verdictOf(score: number): 'pass' | 'fail' | 'ignore' {
  if (score >= 4) return 'pass'
  if (score <= 2) return 'fail'
  return 'ignore'
}

/** 一致率（双方同为 pass/fail 算一致；任一方 ignore 不计入分母） */
export function agreementRate(
  judgeScores: number[],
  humanScores: number[]
): { rate: number; counted: number; total: number } {
  let agree = 0
  let counted = 0
  for (let i = 0; i < judgeScores.length; i++) {
    const jv = verdictOf(judgeScores[i])
    const hv = verdictOf(humanScores[i])
    if (jv === 'ignore' || hv === 'ignore') continue
    counted++
    if (jv === hv) agree++
  }
  return { rate: counted > 0 ? agree / counted : NaN, counted, total: judgeScores.length }
}

/**
 * Cohen's κ——**扣掉「碰巧一致」之后**的一致率（票「一致性口径补 κ」· 2026-09-22）。
 *
 * 与 `agreementRate` **共用同一套三值口径**（`verdictOf`；任一方 `ignore` 不入分母），
 * 因而 `counted` / `total` 逐字同值，两个数可以并列渲染。差别只在分母里减掉了
 * 「按各自边际分布本来就会撞上」的那部分：
 *
 *     κ = (po − pe) / (1 − pe)，po = 观测一致率，pe = 期望巧合率
 *
 * **为什么非要有它**：本仓自己的 `docs/run/eval-system/research-rag-eval.md` 记了原始一致率「会掩盖
 * 分歧」。两边边际分布一边倒时（例如绝大多数样本都是 pass），一致率会虚高到接近 1
 * ——可那正是判官**没有分辨力**的形态（两人都只会说 pass，当然一致）。κ 在这个极限下
 * 趋近 0。Phase 0 的「一致率 97.1%」正是这种读数，故它需要一个不随一边倒而虚高的伴生指标。
 *
 * 退化情形一律返回 `NaN`（与 `agreementRate` 空分母同约定）：
 *   · 有效样本为 0；· `pe === 1`（双方各自只出现一种判定 ⇒ 分母 1−pe = 0，κ 无定义）。
 * **不返回 0 或 1**——那两个都是「有读数」的假象，会把「测不了」伪装成「分歧大/完全一致」。
 *
 * ⚠️ 本函数**只产读数、不参与 `gateVerdict`**：改判定口径 = 改 Phase 0 的结论面，属
 * 架构决策（票面边界：边界与验收标准归店长）。是否把 κ 接进闸门请单独立票。
 */
export function cohenKappa(
  judgeScores: number[],
  humanScores: number[]
): { kappa: number; counted: number; total: number } {
  let counted = 0
  let agree = 0
  // 两类（pass / fail）各自的边际计数——`ignore` 在下面的 continue 里出清
  let judgePass = 0
  let humanPass = 0
  for (let i = 0; i < judgeScores.length; i++) {
    const jv = verdictOf(judgeScores[i])
    const hv = verdictOf(humanScores[i])
    if (jv === 'ignore' || hv === 'ignore') continue
    counted++
    if (jv === hv) agree++
    if (jv === 'pass') judgePass++
    if (hv === 'pass') humanPass++
  }
  const total = judgeScores.length
  if (counted === 0) return { kappa: NaN, counted, total }
  const po = agree / counted
  const pJudgePass = judgePass / counted
  const pHumanPass = humanPass / counted
  const pe = pJudgePass * pHumanPass + (1 - pJudgePass) * (1 - pHumanPass)
  return { kappa: pe === 1 ? NaN : (po - pe) / (1 - pe), counted, total }
}

export interface Phase0Metrics {
  spearman: number
  agreement: number
  /**
   * Cohen's κ（`cohenKappa`）。与 `agreement` **同口径同分母**，并排读才看得出分歧：
   * 一致率高而 κ 低 = 样本一边倒、判官无分辨力（Phase 0 的病）。**不进闸门**。
   */
  kappa: number
  selfAgreement: number
  externalAgreement: number
  counted: number
  total: number
}

/** 闸门判定：主指标（Spearman≥0.7 且一致率≥80%）+ 子指标（族间差距≤15pp） */
export function gateVerdict(m: Phase0Metrics): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!Number.isFinite(m.spearman) || m.spearman < 0.7) {
    reasons.push(`Spearman ${Number.isFinite(m.spearman) ? m.spearman.toFixed(2) : 'NaN'} < 0.7`)
  }
  if (!Number.isFinite(m.agreement) || m.agreement < 0.8) {
    reasons.push(
      `一致率 ${Number.isFinite(m.agreement) ? (m.agreement * 100).toFixed(1) : 'NaN'}% < 80%`
    )
  }
  if (!Number.isFinite(m.selfAgreement) || !Number.isFinite(m.externalAgreement)) {
    reasons.push('自有族或外部一致率缺失（样本不足）')
  } else if (Math.abs(m.selfAgreement - m.externalAgreement) > 0.15) {
    reasons.push(
      `自有族 vs 外部一致率差 ${Math.abs(m.selfAgreement - m.externalAgreement) * 100 >= 1 ? (Math.abs(m.selfAgreement - m.externalAgreement) * 100).toFixed(0) : (Math.abs(m.selfAgreement - m.externalAgreement) * 100).toFixed(1)}pp > 15pp`
    )
  }
  return { pass: reasons.length === 0, reasons }
}

/** 选型：通过闸门的候选中取 (spearman, agreement) 最优；并列时跨族优先（契约） */
export function pickWinner(
  results: Array<{ name: string; metrics: Phase0Metrics; pass: boolean }>
): string | null {
  const passed = results.filter((r) => r.pass)
  if (passed.length === 0) return null
  passed.sort(
    (a, b) => b.metrics.spearman - a.metrics.spearman || b.metrics.agreement - a.metrics.agreement
  )
  const top = passed[0]
  const ties = passed.filter(
    (r) =>
      Math.abs(r.metrics.spearman - top.metrics.spearman) < 0.01 &&
      Math.abs(r.metrics.agreement - top.metrics.agreement) < 0.01
  )
  if (ties.length > 1) {
    const cross = ties.find((r) => !/^deepseek/.test(r.name))
    if (cross) return cross.name
  }
  return top.name
}

// ─── 候选模型 ────────────────────────────────────────

export interface JudgeCandidate {
  name: string
  agent: AgentConfig
}

/** 候选列表：DS 族两档 + Kimi K3（跨族；未配置 KIMI_API_KEY 时跳过） */
export function buildCandidates(): JudgeCandidate[] {
  const dsKey = process.env.DS_KEY || ''
  const kimiKey = process.env.KIMI_API_KEY || ''
  const candidates: JudgeCandidate[] = [
    {
      name: 'deepseek-v4-flash',
      agent: {
        id: 'judge-ds-flash',
        name: '评估裁判',
        avatar: '⚖️',
        systemPrompt: '',
        llmProvider: 'deepseek',
        llmModel: 'deepseek-v4-flash',
        llmApiKey: dsKey,
      },
    },
    {
      name: 'deepseek-v4-pro',
      agent: {
        id: 'judge-ds-pro',
        name: '评估裁判',
        avatar: '⚖️',
        systemPrompt: '',
        llmProvider: 'deepseek',
        llmModel: 'deepseek-v4-pro',
        llmApiKey: dsKey,
      },
    },
  ]
  if (kimiKey) {
    candidates.push({
      name: 'kimi-k3',
      agent: {
        id: 'judge-kimi-k3',
        name: '评估裁判',
        avatar: '⚖️',
        systemPrompt: '',
        // K5 变更单接线形态：deepseek provider 走 Moonshot OpenAI 兼容 HTTP 端点
        // （评测稳定通道同构；claude adapter CLI 通道评测期连崩 2 次已弃用）
        llmProvider: 'deepseek',
        llmModel: 'kimi-k3',
        llmApiKey: kimiKey,
        llmBaseUrl: 'https://api.moonshot.cn',
      },
    })
  }
  return candidates
}

// ─── 样本收集（30 条真实 + 20 外部对照） ─────────────

/**
 * 从消息表挑 DS 族猫回复（排除 ollama 猫），取最新 count 条。
 * 纯函数（测试用注入数据）；agentById 为 agent_id → {provider, model} 映射。
 * DS 族判定按模型名包含 'deepseek'（生产主猫 llmProvider='opencode'、
 * llmModel='opencode-go/deepseek-v4-flash' 经 opencode 适配器跑 Go 订阅；
 * 旧 claude 直连形态仍命中——按 provider 过滤会把全猫误杀，M1 教训）。
 * 用 includes('deepseek') 而非 startsWith——切 Go 后模型名前缀变成 'opencode-go/'，
 * 但模型族仍是 DeepSeek（跑的是 DeepSeek V4 Flash）
 */
export function selectCandidates(
  rows: Array<{
    id: string
    session_id: string
    agent_id: string | null
    role: string
    content: string
    created_at: string
  }>,
  agentById: Map<string, { provider: string; model: string }>,
  count: number
): Array<{ messageId: string; sessionId: string; agentId: string; content: string }> {
  return rows
    .filter((r) => {
      if (r.role !== 'agent' || r.agent_id === null) return false
      const meta = agentById.get(r.agent_id)
      if (!meta) return false
      if (meta.provider === 'ollama') return false
      return meta.model.includes('deepseek')
    })
    .slice(0, count)
    .map((r) => ({
      messageId: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id as string,
      content: r.content,
    }))
}

/**
 * 被评回复的前置上下文提取（OQ① 修复版）：rows 为倒序（created_at DESC，
 * 最新在前），目标之后即更早消息。取目标之后最多 maxCount 条（不含目标自身
 * ——reply 字段单独承载被评回复），反转为时间正序。与 scorer.collectContextRows
 * 同一坐标系（DESC 序 + 目标后移窗口），差异仅在是否含目标。
 */
export function extractPrecedingContext(
  rows: Array<{ id: string; role: string; agent_id: string | null; content: string }>,
  targetMessageId: string,
  maxCount: number = 9
): Array<{ role: string; agent_id: string | null; content: string }> {
  const idx = rows.findIndex((r) => r.id === targetMessageId)
  if (idx === -1) return []
  const window = rows.slice(idx + 1, Math.min(rows.length, idx + 1 + maxCount))
  return window.reverse() // 时间正序，最早在前
}

/** 收集 30 条真实回复候选样本（来源限定 DS 族猫）→ 写标注文件（human_score 待填） */
export function collectCandidatesFromDb(count: number = 30): Phase0Sample[] {
  const recent = messagesRepo.getLatestAgentMessages(2000)
  const agentById = new Map<string, { provider: string; model: string }>()
  for (const row of agentsRepo.listAllAgents()) {
    agentById.set(row.id, { provider: row.llm_provider, model: row.llm_model })
  }
  const picked = selectCandidates(recent, agentById, count)

  const samples: Phase0Sample[] = picked.map((p, i) => {
    // 每条回复的前置最近 9 条（G-Eval 上下文，时间正序，不含目标自身）
    const all = messagesRepo.getRecentMessages(p.sessionId, 100)
    const ctx = extractPrecedingContext(all, p.messageId).map(
      (m) => `${m.role === 'user' ? '用户' : '其他猫'}: ${truncateForJudge(m.content, 800)}`
    )
    return {
      id: `real-${String(i + 1).padStart(2, '0')}`,
      source: 'real',
      sessionId: p.sessionId,
      messageId: p.messageId,
      agentName: agentsRepo.getAgentById(p.agentId)?.name,
      context: ctx,
      reply: truncateForJudge(p.content, 1200),
      humanScore: null,
    }
  })
  return samples
}

/** 外部构造对照 20 条（好坏分明，自带人工标签） */
export function buildExternalSamples(): Phase0Sample[] {
  const good = (id: string, context: string[], reply: string): Phase0Sample => ({
    id,
    source: 'external',
    context,
    reply,
    humanScore: 5,
  })
  const bad = (id: string, context: string[], reply: string): Phase0Sample => ({
    id,
    source: 'external',
    context,
    reply,
    humanScore: 1,
  })
  const mid = (id: string, context: string[], reply: string, score: number): Phase0Sample => ({
    id,
    source: 'external',
    context,
    reply,
    humanScore: score,
  })

  const ctx = (q: string): string[] => [`用户: ${q}`]
  return [
    // 9 好（5 分）
    good(
      'ext-01',
      ctx('请给 packages/server 加一个 health 路由'),
      '已完成:新增 GET /health 路由,返回 {status: "ok"}。已加测试覆盖 200 响应,`pnpm test` 全绿。'
    ),
    good(
      'ext-02',
      ctx('怎么解决 Windows 下 localhost 的 IPv6 歧义?'),
      '用 127.0.0.1 代替 localhost。项目已有此惯例:dev 代理和 spawn 均指向 127.0.0.1,避免 IPv6 解析到 ::1 导致连接失败。'
    ),
    good(
      'ext-03',
      ctx('messages 表加了新列,老库怎么升级?'),
      '用 additive ALTER TABLE 迁移:新列必须带 DEFAULT,放进 db/index.ts 的 migrations 数组,try/catch 包住幂等执行。老库升级零数据损失,新库建出同构。'
    ),
    good(
      'ext-04',
      ctx('agent 回复超时了怎么办?'),
      '先查 execution_logs 的 latency_ms 与 error_message 定位阶段;CLI 有 20 分钟 idle timeout,dispatch 有 30 分钟硬超时兜底。若是单次卡死,重启 server 会走恢复流程重新执行。'
    ),
    good(
      'ext-05',
      ctx('提交信息里 catstudy [uuid] 是什么?'),
      '是触发消息 id 的标记,post-commit hook 据此自动投递审查链。格式必须 `catstudy [uuid]`,否则审查链断裂。'
    ),
    good(
      'ext-06',
      ctx('记忆去重的阈值怎么调?'),
      '现在没有去重阈值这个旋钮了——对话原话的实时嵌入层已整体退役(写口与 memories 表双删),MEMORY_DEDUP_* 系列参数一并作废。现行机制是 MD 为唯一写入口:扫描器把白名单 MD(docs/adr、docs/lessons、docs/plans)切片后嵌入,按身份键 content_hash 幂等 upsert 进 chunks 三表——重扫同一份文档是覆盖而非新增,所以不需要相似度去重。检索走 searchChunksHybrid(向量+关键词 RRF),阈值是 MEMORY_MAX_DISTANCE 默认 0.6,知识库侧另为 0.35。'
    ),
    good(
      'ext-07',
      ctx('为什么 socketio.ts 里 MCP 工具面要每次 spawn 生成?'),
      'MCP server 路径每次生成到 OS temp,带 pid + 随机后缀——同一进程并发多个 spawn 不冲突,流结束/异常路径 finally 清理,避免文件泄漏与串台。'
    ),
    good(
      'ext-08',
      ctx('OneBot 出站回复失败会重试吗?'),
      '不会。出站 fetch 超时走 log.warn 不重试,与出站失败语义一致(ONEBOT_FETCH_TIMEOUT_MS 默认 10s)。NapCat 假死防悬挂,不阻塞主流程。'
    ),
    good(
      'ext-09',
      ctx('测试为什么要用 :memory: SQLite?'),
      '零磁盘 IO、跑得快;FK 约束生效与真实库一致;setDb/resetDb 钩子每用例隔离,避免测试间污染。'
    ),
    // 9 差（1 分）
    bad(
      'ext-11',
      ctx('请给 packages/server 加一个 health 路由'),
      '你这个问题我建议先看看别的地方,比如前端那边,我最近在看 Vue 的响应式原理,挺有意思的。'
    ),
    bad(
      'ext-12',
      ctx('怎么解决 Windows 下 localhost 的 IPv6 歧义?'),
      'localhost 就挺好用的,不用改,你多试几次可能就好了。'
    ),
    bad('ext-13', ctx('messages 表加了新列,老库怎么升级?'), '删库重建最干净,反正数据也不重要。'),
    bad('ext-14', ctx('agent 回复超时了怎么办?'), '超时就超时吧,你等着就行,总会回复的。'),
    bad(
      'ext-15',
      ctx('提交信息里 catstudy [uuid] 是什么?'),
      '就是个格式,随便写个数字就行,没人看的。'
    ),
    bad('ext-16', ctx('记忆去重的阈值怎么调?'), '把环境变量全删了重启,就好了。'),
    bad(
      'ext-17',
      ctx('为什么 socketio.ts 里 MCP 工具面要每次 spawn 生成?'),
      '因为代码就是这么写的,我也不知道为什么,你自己看代码吧。'
    ),
    bad('ext-18', ctx('OneBot 出站回复失败会重试吗?'), '会无限重试,直到成功为止,你放心。'),
    bad(
      'ext-19',
      ctx('测试为什么要用 :memory: SQLite?'),
      '因为内存快。具体为什么,嗯……反正就是快。'
    ),
    // 中档 2 条（4 分 / 2 分，制造非二值分布——判定口径的"不计"路径）
    mid('ext-20', ctx('请给 packages/server 加一个 health 路由'), '加路由可以,返回 ok 就行。', 4),
    mid('ext-21', ctx('agent 回复超时了怎么办?'), '重启一下 server 应该就好了。', 2),
  ]
}

// ─── 评分与报告（不落库——Phase 0 是评估实验） ───────

/** 对单条样本用给定 judge 打分（复用 G-Eval prompt + 解析，不写 eval_scores） */
export async function judgeSample(
  judge: AgentConfig,
  sample: Phase0Sample
): Promise<number | null> {
  const adapter = getAdapterForAgent(judge)
  const prompt = buildGEvalPrompt(
    sample.context.map((c) => ({ role: 'user' as const, agent_id: null, content: c })),
    sample.reply,
    sample.agentName || '被评猫'
  )
  let fullText = ''
  for await (const chunk of adapter.chatStream(
    [{ role: 'user', content: prompt }],
    judgeChatOptions(judge.llmModel, 120_000)
  )) {
    fullText += chunk.content
  }
  const output = parseJudgeOutput(fullText)
  return output ? Math.round(output.score) : null
}

/** 跑一个候选的全量指标（50 条） */
export async function runCandidate(
  candidate: JudgeCandidate,
  samples: Phase0Sample[]
): Promise<{ name: string; metrics: Phase0Metrics; pass: boolean; reasons: string[] }> {
  const judged: Array<number | null> = []
  for (const s of samples) {
    judged.push(await judgeSample(candidate.agent, s))
  }
  const validIdx = judged
    .map((j, i) => (j !== null && samples[i].humanScore !== null ? i : -1))
    .filter((i) => i !== -1)
  const judgeScores = validIdx.map((i) => judged[i] as number)
  const humanScores = validIdx.map((i) => samples[i].humanScore as number)
  const realIdx = validIdx.filter((i) => samples[i].source === 'real')
  const extIdx = validIdx.filter((i) => samples[i].source === 'external')

  const metrics: Phase0Metrics = {
    spearman: spearman(judgeScores, humanScores),
    agreement: agreementRate(judgeScores, humanScores).rate,
    kappa: cohenKappa(judgeScores, humanScores).kappa,
    selfAgreement: agreementRate(
      realIdx.map((i) => judged[i] as number),
      realIdx.map((i) => samples[i].humanScore as number)
    ).rate,
    externalAgreement: agreementRate(
      extIdx.map((i) => judged[i] as number),
      extIdx.map((i) => samples[i].humanScore as number)
    ).rate,
    counted: judgeScores.length,
    total: samples.length,
  }
  const verdict = gateVerdict(metrics)
  return { name: candidate.name, metrics, pass: verdict.pass, reasons: verdict.reasons }
}

// ─── CLI ──────────────────────────────────────────────

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

async function cliCollect(): Promise<void> {
  initDb()
  initRepository(getDb())
  const samples = collectCandidatesFromDb(30)
  writeJson(SAMPLES_FILE, { version: 1, samples })
  console.log(`✅ 已收集 ${samples.length} 条真实回复候选样本 → ${SAMPLES_FILE}`)
  console.log('请店长协调用户标注 humanScore（1-5，null 待填），完成后运行 --run')
}

async function cliRun(): Promise<void> {
  if (!fs.existsSync(SAMPLES_FILE)) {
    console.error('❌ 标注文件不存在，先运行 --collect')
    process.exit(1)
  }
  const { samples: realSamples } = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf-8')) as {
    samples: Phase0Sample[]
  }
  const labeledReal = realSamples.filter((s) => s.humanScore !== null)
  if (labeledReal.length < 30) {
    console.error(`❌ 真实样本标注不足（${labeledReal.length}/30），请先完成标注`)
    process.exit(1)
  }
  const all = [...labeledReal, ...buildExternalSamples()]
  const candidates = buildCandidates()
  const report: Record<string, unknown> = {}
  const results: Array<{ name: string; metrics: Phase0Metrics; pass: boolean; reasons: string[] }> =
    []
  for (const c of candidates) {
    log.info('Phase 0 judging candidate', { name: c.name })
    const r = await runCandidate(c, all)
    results.push(r)
    report[c.name] = {
      metrics: r.metrics,
      pass: r.pass,
      reasons: r.reasons,
    }
    console.log(
      `\n[${c.name}] Spearman=${r.metrics.spearman.toFixed(2)} 一致率=${(r.metrics.agreement * 100).toFixed(1)}% ` +
        `κ=${Number.isFinite(r.metrics.kappa) ? r.metrics.kappa.toFixed(3) : 'NaN'} ` +
        `自有=${(r.metrics.selfAgreement * 100).toFixed(1)}% 外部=${(r.metrics.externalAgreement * 100).toFixed(1)}% ` +
        `(${r.metrics.counted}/${r.metrics.total}) → ${r.pass ? '✅ 通过' : '❌ ' + r.reasons.join('; ')}`
    )
  }
  const winner = pickWinner(results)
  report.winner = winner
  report.conclusion = winner
    ? `最终选型: ${winner}`
    : '❌ 无候选通过闸门——回退（不接线上，失败面收敛在 Phase 0 内部）'
  writeJson(REPORT_FILE, report)
  console.log(`\n${report.conclusion}`)
  console.log(`报告已写 → ${REPORT_FILE}`)
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const cmd = process.argv[2]
  if (cmd === '--collect') {
    cliCollect().catch((err) => {
      console.error('collect failed:', err)
      process.exit(1)
    })
  } else if (cmd === '--run') {
    cliRun().catch((err) => {
      console.error('run failed:', err)
      process.exit(1)
    })
  } else {
    console.log('用法: npx tsx src/eval/phase0.ts --collect | --run')
  }
}

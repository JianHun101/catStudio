/**
 * 评估采样器（W2 L2 评估子系统）。
 *
 * 契约要点：
 * - 随机 1-5% 采样（EVAL_SAMPLE_RATE，默认 0.02），只对 DS 族猫
 *   （llmModel 包含 'deepseek'——生产主猫 llmProvider='opencode'，模型
 *   opencode-go/deepseek-v4-flash 经 opencode 适配器跑 Go 订阅；旧 claude 适配器
 *   直连形态仍命中）的回复采样——ollama 图测猫不进入评估（Phase 0 来源限定同口径）
 * - fire-and-forget：调用方不 await（socketio 成功路径触发即返回），
 *   不占 agent slot、不进 dispatch 主链，失败只记日志
 * - 评分后 score ≤ 2 由 scorer 落库时标注 sample_reason='low_score'
 *   （低分样本回采信号；'user_feedback' 为 W4 预留值不实现）
 */
import type { AgentConfig } from '@cat-study/shared'
import { scoreReply } from './scorer.js'
import { createLogger } from '../logger.js'

const log = createLogger('eval-sampler')

export type SampleReason = 'random' | 'low_score' | 'user_feedback'

export function getSampleRate(): number {
  const raw = parseFloat(process.env.EVAL_SAMPLE_RATE || '0.02')
  if (Number.isNaN(raw) || raw <= 0) return 0
  return Math.min(Math.max(raw, 0.01), 0.05) // 契约区间 1-5%，上下限均强制
}

/**
 * 回复完成后的采样入口。fire-and-forget：返回 void，内部异步评分不阻塞调用方。
 * random 可注入（测试用固定序列），默认 Math.random。
 */
export function maybeScoreSample(
  agent: AgentConfig,
  sessionId: string,
  messageId: string,
  random: () => number = Math.random
): void {
  // 评估对象限定 DS 族猫（Phase 0 来源限定同口径）：按模型名过滤——生产主猫
  // llmProvider='opencode'（opencode-go/deepseek-v4-flash 经 opencode 适配器跑
  // Go 订阅），按 provider 过滤会把全猫误杀；同时显式排除 ollama 图测猫（回复为
  // 图片描述，不同族）。用 includes('deepseek') 而非 startsWith——切 Go 后模型名
  // 前缀变成 'opencode-go/'，但模型族仍是 DeepSeek（跑的是 DeepSeek V4 Flash）
  if (agent.llmProvider === 'ollama' || !agent.llmModel?.includes('deepseek')) return

  const rate = getSampleRate()
  if (rate <= 0) return

  // 命中采样 → 异步评分；异常静默（评分是旁路，失败不影响回复主流程）
  if (random() < rate) {
    void scoreReply(agent, sessionId, messageId).catch((err: any) => {
      log.warn('eval scoring failed (fire-and-forget)', {
        messageId,
        sessionId,
        agentName: agent.name,
        error: err.message,
      })
    })
  }
}

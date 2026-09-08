/**
 * 契约③ X2 闭环（ADR 0014 §4 契约③）——verdict 落盘后推进状态机 + 收口兜底提醒。
 *
 * X2（用户拍板，记账+推进者；否决 X1 驱动者）：
 * - **agent 自由接棒保留**：下一棒由 agent 自己的 @ / post_message 表态决定，
 *   状态机**不替 agent 决定**该干嘛、该调哪个 skill。
 * - 状态机只在 hook 不覆盖的跳**补信号**，3 件事：
 *   ① verdict 推进账本——审查 {✅/⚠️/❌} 落盘事件 → recordFlowTransition 沿主干道前进
 *   ② 恰好一次去重——commit_sha 主键判同源，防「判定式投递 + hook 兜底」双触发
 *   ③ verdict ✅ → 派生 closeout 信号提醒店长收口
 *
 * 边界：只管主干道（FLOW_MAIN_CHAIN）；岔道（@求助 / ❌打回 / 澄清）不进状态机。
 * 不重做 post-commit hook 自动投审路径（request-review 那跳仍由 hook 触发）。
 *
 * 本模块是 verdict 落盘后的**非阻塞**接缝——serial.ts 的 review 钩子在
 * recordReviewVerdict 之后 fire-and-forget 调用（不 await、不抛错，审查链主流程零阻塞）。
 *
 * 反查链（E3 接线）：verdict 消息 message_id → messages.task_id（= 源链 trace_id）→
 * execution_logs.commit_hash（源链实施行挂的 commit）→ flow_states (session_id, commit_sha)。
 */

import { createLogger } from '../logger.js'
import {
  messages as messagesRepo,
  flowStates as flowStatesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import { deriveNextIntent, type FlowStage } from './flow-state.js'
import { buildDeliverySignal } from './delivery-signal.js'
import type { ReviewVerdict } from '../eval/verdict-parser.js'

const log = createLogger('flow-advance')

/** 反查被审 commit_sha（verdict 消息 →源链 trace_id → commit_hash）。无 commit 链路返回 undefined。 */
function resolveCommitSha(messageId: string): string | undefined {
  const meta = messagesRepo.getTaskIdByMessageId(messageId)
  if (!meta) return undefined
  return execLogsRepo.getCommitHashByTraceId(meta.task_id)
}

/** 推进到终态是否需收口提醒（verdict approve → yes；suggest/reject 打回 → 不推进不提醒）。 */
function shouldAdvance(verdict: ReviewVerdict): boolean {
  return verdict === 'approve'
}

/**
 * verdict 落盘后推进契约③状态机（X2 记账）。
 *
 * 触发点：serial.ts review 钩子（recordReviewVerdict 落盘后）。
 * 幂等：recordFlowTransition 是 (session_id, commit_sha) 键 upsert + 审计 append——
 * 同一 commit 多次 approve 重复推进 → 审计流水多一条、当前状态已 closed 不再前进
 * （deriveNextIntent(closed)=null），天然防重复收口。
 *
 * 非阻塞：DB 异常/task 查无 commit 链路 → 仅记日志，不抛错（审查链主流程零影响）。
 *
 * @param targets 作用域 allowedNames 对应目标（含 isStore 角色判定）——closeout 兜底判断
 *   判定式收口是否已在 A2A 层发生（reviewer 已 @店长收口 → 状态机不重复补信号）。
 */
export function advanceFlowAfterVerdict(opts: {
  messageId: string
  sessionId: string
  verdict: ReviewVerdict
  targets: Array<{ name: string; isStore: boolean }>
}): void {
  try {
    if (!shouldAdvance(opts.verdict)) {
      // suggest/reject：内容寻址新 sha 自解，状态机不在主干道推进（X2 边界）
      return
    }

    const commitSha = resolveCommitSha(opts.messageId)
    if (!commitSha) {
      log.info('flow advance skipped — no commit chain (pure session)', {
        messageId: opts.messageId,
        sessionId: opts.sessionId,
      })
      return
    }

    // 读当前状态 → 沿主干道机械推进（deriveNextIntent 循环，每步 recordFlowTransition）
    const current = flowStatesRepo.getFlowState(opts.sessionId, commitSha)?.state as
      FlowStage | undefined
    let stage: FlowStage | undefined = current
    let advanced = false
    while (true) {
      const next = deriveNextIntent(stage)
      if (!next) break // closed 终态 → 无下一步
      flowStatesRepo.recordFlowTransition(opts.sessionId, commitSha, next.stage, next.intent)
      stage = next.stage
      advanced = true
      log.info('flow state advanced', {
        sessionId: opts.sessionId,
        commitSha: commitSha.slice(0, 7),
        toStage: next.stage,
        intent: next.intent,
      })
    }

    if (advanced) {
      // 恰好一次去重（①）：判定式收口未投（targets 无 store 猫）→ 状态机补 closeout 提醒店长收口。
      // 判定式已投（reviewer @店长收口，A2A 层在推进）→ 状态机不重复补（防双触发）。
      const storeCat = opts.targets.find((t) => t.isStore)
      if (!storeCat) {
        const signal = buildDeliverySignal({
          targets: ['店长'], // store 猫名——会话成员固定名
          intent: 'closeout',
          commitSha,
          traceId: opts.sessionId,
        })
        log.info('closeout signal derived (mechanical fallback)', {
          sessionId: opts.sessionId,
          commitSha: commitSha.slice(0, 7),
          signal,
        })
        // 注：信号已产出留痕；真正触发店长收口由 store 收口链（closeoutSession）接手，
        // 状态机只负责"记账 + 派生信号提醒"，不替 agent 执行收口动作（X2 边界）。
      }
    }
  } catch (err: any) {
    log.warn('flow advance failed (non-blocking)', {
      messageId: opts.messageId,
      sessionId: opts.sessionId,
      error: err.message,
    })
  }
}

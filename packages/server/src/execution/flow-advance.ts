/**
 * 契约③ X2 闭环（ADR 0014 §4 契约③）——verdict 落盘后推进状态机 + 收口兜底提醒。
 *
 * X2（用户拍板，记账+推进者；否决 X1 驱动者）：
 * - **agent 自由接棒保留**：下一棒由 agent 自己的 @ / post_message 表态决定，
 *   状态机**不替 agent 决定**该干嘛、该调哪个 skill。
 * - 状态机只在 hook 不覆盖的跳**补信号**，3 件事：
 *   ① verdict 推进账本——审查 {✅可合并 / 💬仅评论} 落盘事件 → recordFlowTransition
 *      沿主干道前进（⚠️/❌ 打回不推进；💬 非阻断档照常推进，T-C）
 *   ② 恰好一次去重——commit_sha 主键判同源，防「判定式投递 + hook 兜底」双触发
 *   ③ verdict ✅ → closeout 信号**真正投递**店长收口（判定式投递缺席时）
 *
 * 边界：只管主干道（FLOW_MAIN_CHAIN）；岔道（@求助 / ❌打回 / 澄清）不进状态机。
 * 不重做 post-commit 投审路径（request-review 那跳由实施猫按技能自行发起，hook 只在
 * commit 无归属执行时兜底补投——scripts/handoff-gen.mjs、execution/review-fallback.ts）。
 *
 * 本模块是 verdict 落盘后的**非阻塞**接缝——serial.ts 的 review 钩子在
 * recordReviewVerdict 之后调用。函数体同步（推进是同步 DB 写）；closeout 投递
 * 内部走 ingest（async 管线）以 `.then/.catch` 收尾，不 await、不抛错——审查链
 * 主流程零阻塞（本模块整体被 try/catch 包住，DB 异常只记日志）。
 *
 * 反查链（E3 接线）：verdict 消息 message_id → messages.task_id（= 源链 trace_id）→
 * execution_logs.commit_hash（源链实施行挂的 commit）→ flow_states (session_id, commit_sha)。
 */

import { createLogger } from '../logger.js'
import {
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  flowStates as flowStatesRepo,
  executionLogs as execLogsRepo,
} from '../db/repository/index.js'
import { deriveNextIntent, type FlowStage } from './flow-state.js'
import { buildDeliverySignal } from './delivery-signal.js'
import { ingestUserMessage } from '../connectors/ingest.js'
import type { ReviewVerdict } from '../eval/verdict-parser.js'

const log = createLogger('flow-advance')

/**
 * 反查被审 commit（verdict 消息 → 源链 trace_id → commit_hash）。
 * 同时回吐 trace_id——closeout 投递要带源链 task_id，让店长收口链与任务链同线程。
 * 无 commit 链路（纯会话）返回 undefined。
 */
function resolveCommitChain(messageId: string): { commitSha: string; traceId: string } | undefined {
  const meta = messagesRepo.getTaskIdByMessageId(messageId)
  if (!meta) return undefined
  const commitSha = execLogsRepo.getCommitHashByTraceId(meta.task_id)
  if (!commitSha) return undefined
  return { commitSha, traceId: meta.task_id }
}

/** 会话内 store 角色猫名（收口提醒的投递目标）。无 store 成员 → undefined。 */
function resolveStoreCatName(sessionId: string): string | undefined {
  for (const id of sessionsRepo.getSessionAgentIds(sessionId)) {
    const row = agentsRepo.getAgentById(id)
    if (row?.role === 'store') return row.name
  }
  return undefined
}

/**
 * 推进到终态是否需收口提醒。
 *
 * approve / **comment** → yes：💬 是**非阻断**档（T-C）——审查者有低严重度
 * 观察项，不要求返工，故不该把链卡住；「不阻断收口」的落地就是照常推进。
 * suggest/reject 打回 → 不推进不提醒（内容寻址新 sha 自解）。
 */
function shouldAdvance(verdict: ReviewVerdict): boolean {
  return verdict === 'approve' || verdict === 'comment'
}

/**
 * 收口提醒**真正投递**（X2 第③件事的落地点）。
 *
 * 走 ingest 管线（落库 + 广播 + dispatch）注入一条 @店长 消息——店长收到即执行
 * 收口动作（合并 → 更新 .push-gate → 推分支 → 开 PR）。这是「机械补信号」的落地：
 * 判定式投递（reviewer @店长）缺席时，状态机不替 agent 决策收不收口，只把
 * 「这个 commit 已可收口」变成一条可见消息送达店长。
 *
 * 恰好一次：同 commit 重复 approve 时 flow_state 已 closed → 外层 advanced=false
 * 不进入本函数；判定式已投（targets 含 store 猫）→ 外层直接跳过。两层去重都在
 * 调用点，本函数只负责投递一次。
 *
 * 非阻塞：ingest 返回的 Promise 以 then/catch 收尾，失败只记日志。
 */
function deliverCloseoutNotice(opts: {
  sessionId: string
  commitSha: string
  traceId: string
  verdict: ReviewVerdict
}): void {
  const storeCatName = resolveStoreCatName(opts.sessionId)
  if (!storeCatName) {
    // 会话无 store 成员——无处可投。记日志而非静默：这是「提醒没送达」的可观测痕迹
    log.warn('closeout notice skipped — no store cat in session', {
      sessionId: opts.sessionId,
      commitSha: opts.commitSha.slice(0, 7),
    })
    return
  }

  const signal = buildDeliverySignal({
    targets: [storeCatName],
    intent: 'closeout',
    commitSha: opts.commitSha,
    traceId: opts.traceId,
  })

  ingestUserMessage({
    sessionId: opts.sessionId,
    content:
      `【契约③·状态机兜底】commit ${opts.commitSha.slice(0, 7)} 审查结论 ` +
      `${opts.verdict === 'approve' ? '✅可合并' : '💬仅评论（非阻断）'}，` +
      `主干道已推进至 closed。审查者未 @店长 收口，状态机补投本提醒——请店长收口。`,
    mentions: signal.targets,
    taskId: opts.traceId,
    // T-F 入口主闸：契约③收口提醒 = **服务端 agent 入口**，锚 = 源链 trace_id（下面那行），
    // 受 agent 投递的锚必填约束（这里天然满足）。非审查类（投给店长）→ 不需要 chainType。
    origin: 'agent',
  })
    .then((result) => {
      if (result.ok) {
        log.info('closeout notice delivered', {
          sessionId: opts.sessionId,
          commitSha: opts.commitSha.slice(0, 7),
          target: storeCatName,
          messageId: result.messageId,
        })
      } else {
        log.warn('closeout notice rejected by ingest', {
          sessionId: opts.sessionId,
          status: result.status,
          error: result.error,
        })
      }
    })
    .catch((err: any) => {
      log.warn('closeout notice delivery failed (non-blocking)', {
        sessionId: opts.sessionId,
        error: err.message,
      })
    })
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

    const chain = resolveCommitChain(opts.messageId)
    if (!chain) {
      log.info('flow advance skipped — no commit chain (pure session)', {
        messageId: opts.messageId,
        sessionId: opts.sessionId,
      })
      return
    }
    const { commitSha, traceId } = chain

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
      // 恰好一次去重（②）：判定式收口未投（targets 无 store 猫）→ 状态机补 closeout
      // 提醒店长收口。判定式已投（reviewer @店长收口，A2A 层在推进）→ 状态机不重复补
      // （防双触发）。advance 已发生 = 本 commit 首次走到终态，同 commit 重复 verdict
      // 不再进入本块（flow_state 已 closed，advanced=false）。
      const storeCat = opts.targets.find((t) => t.isStore)
      if (!storeCat) {
        deliverCloseoutNotice({
          sessionId: opts.sessionId,
          commitSha,
          traceId,
          verdict: opts.verdict,
        })
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

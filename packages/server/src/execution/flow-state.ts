/**
 * 契约③ flow_state 状态机（ADR 0014 §4 — 主干道机械推导）。
 *
 * 设计（用户拍板，见 ADR §4 契约③落地形态）：
 * - 「当前状态」→ DB 字段 `flow_states.state`，键 (session_id, commit_sha)，
 *   投递/事件发生时**同事务更新**（不变的事实，见 db/repository/flowStates.ts）。
 * - 「下一步」**不落库**——本模块纯函数 `deriveNextIntent` 读当前状态 + 查主链
 *   **机械算出**（派生数据，落库需随主链改跑迁移=一致债）。
 * - 状态机**只管主干道**：quality-gate → request-review → receive-review → 闭环。
 *   岔道（实现猫@求助 / 审查❌打回 / 需求澄清）走判断式投递，不接管。
 *
 * 本模块纯函数、无 DB 依赖——只有状态名、主链序、下一步推导。注入链路消费方
 * （routes/db）自行决定何时记录状态、何时取派生下一步。
 */

/** 主干道状态序（值取自 ADR 契约③示例：quality-gate / request-review／receive-review）。 */
export const FLOW_MAIN_CHAIN = [
  'implement',
  'quality-gate',
  'request-review',
  'receive-review',
  'closed',
] as const

export type FlowStage = (typeof FLOW_MAIN_CHAIN)[number]

/** 派生「下一步」：{ stage: 下一步达成后的状态, intent: 动作语义（供投递信号 intent 字段）} */
export interface NextStep {
  stage: FlowStage
  intent: string
}

/**
 * 读当前 flow_state → 机械算「下一步」（纯函数、无 agent 参与）。
 * - 未初始化（undefined）或处于 `implement` → 下一步跑 quality-gate
 * - `quality-gate` → 请求审查（intent=review_commit，ADR 契约①示例）
 * - `request-review` → 等到接收审查
 * - `receive-review` → 收口
 * - `closed`（终态）→ null（无下一步）
 */
export function deriveNextIntent(current: FlowStage | undefined): NextStep | null {
  switch (current) {
    case undefined:
    case 'implement':
      return { stage: 'quality-gate', intent: 'quality_gate' }
    case 'quality-gate':
      return { stage: 'request-review', intent: 'review_commit' }
    case 'request-review':
      return { stage: 'receive-review', intent: 'receive_review' }
    case 'receive-review':
      return { stage: 'closed', intent: 'closeout' }
    case 'closed':
      return null
  }
}

/** 该状态是否在主干道（岔道状态不在 FLOW_MAIN_CHAIN → 状态机不接管）。 */
export function isOnMainChain(state: string | undefined): boolean {
  return !!state && (FLOW_MAIN_CHAIN as readonly string[]).includes(state)
}

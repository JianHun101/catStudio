/**
 * 投递轻信号契约（ADR 0014 §4 契约①）——投递外移的信号形状定义。
 *
 * 病根回顾：路由（@谁）焊死在 skill 内容里 → 字面不解析静默丢单 / 双触发。
 * 本模块把「投递给谁」抽象成一条轻信号 {target, intent, ref}，作为判断式投递
 * 的产出/消费共享契约：
 *
 * - target：本信号要投递到的目标猫名（会话成员，完整名）。
 * - intent：投递目的（领域动作名，如 review_commit / close_out / help /
 *   request_review）——决定下一棒「为什么被叫起来」，供消费层/审计用。
 * - ref：定位 + 去重的主键。以 commit_sha 为主键（审查链事件的定位+去重同源）；
 *   纯会话无 commit 退 trace_id 兜底（trace_id 仅关联列串同一趟消息线程，
 *   绝不替代 ref 做定位/去重——ADR §4 契约③：两次触发 trace_id 不同，若以
 *   trace_id 判同源会漏判重复）。
 *
 * 边界（T1 派活单）：
 * - 只定义契约 + 消费映射（纯单元可测）；不接传输层 post_message / route-signals
 *   （那走 T4/T5 接线，且 post_message 工具 schema 有体量护栏六把≤3400 不宜动）。
 * - 判断式投递原链路（agent 自由向 -> post_message / 行首 @）不破坏。
 *
 * 承载物（信号产出动作）在铁律层出口检查段（config/seed-data.ts COMMON_IRON_LAWS，
 * T2 负责）——本模块只定义信号本身，不写产出指令。
 */

import { z } from 'zod'

/** 契约束① 轻信号形状：{target, intent, ref}，不载全文、不比较内容。 */
export const deliverySignalSchema = z.object({
  target: z.string().min(1),
  intent: z.string().min(1),
  ref: z.string().min(1),
})

export type DeliverySignal = z.infer<typeof deliverySignalSchema>

/** 消费通道：post_message 结构化路由首选；行首 @ 为 fallback（契约①「两套通道」）。 */
export type DeliveryChannel = 'post_message' | 'at-mention'

/** 消费映射产物：一条轻信号决策出一条投递动作。 */
export interface DeliveryAction {
  channel: DeliveryChannel
  /** 目标猫名——post_message 的 targetCats 元素 / 行首 @ 对象。原样透传，不做名称变换。 */
  target: string
}

/**
 * ref 主键解析（契约①「ref 以 commit_sha 为主键；纯会话退 trace_id」）。
 * commit_sha 存在 → 直接作 ref（审查链事件主键）；缺失（纯会话/无 commit）→ 退 trace_id。
 * 纯调用方各按其上下文传参：有 commit 传 commitSha，无则只传 traceId。
 */
export function resolveDeliveryRef(partial: { commitSha?: string; traceId: string }): string {
  return partial.commitSha ?? partial.traceId
}

/**
 * 产出轻信号（契约①/②）：给定目标 + 意图 + commit 上下文，解析 ref 并过 schema 校验。
 * 产出形状恒定（ref 主键语义内聚于此），消费层只认 DeliverySignal。
 * 校验失败抛 ZodError——契约违规要暴露而非静默（判定式投递是一场一等公民消费）。
 */
export function buildDeliverySignal(partial: {
  target: string
  intent: string
  commitSha?: string
  traceId: string
}): DeliverySignal {
  return deliverySignalSchema.parse({
    target: partial.target,
    intent: partial.intent,
    ref: resolveDeliveryRef(partial),
  })
}

/**
 * 消费映射（契约①「post_message 首选 / 行首 @ fallback」）：
 * postMessageAvailable = 结构化路由可用（MCP post_message 工具在场且预校验会过）→
 * 首选 post_message；否则降级行首 @。target 原样透传（目标猫名已定，不二次解析）。
 */
export function planDelivery(
  signal: DeliverySignal,
  opts: { postMessageAvailable: boolean }
): DeliveryAction {
  return {
    channel: opts.postMessageAvailable ? 'post_message' : 'at-mention',
    target: signal.target,
  }
}

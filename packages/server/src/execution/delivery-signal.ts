/**
 * 投递轻信号契约（ADR 0014 §4 契约①）——投递外移的信号形状定义。
 *
 * 病根回顾：路由（@谁）焊死在 skill 内容里 → 字面不解析静默丢单 / 双触发。
 * 本模块把「投递给谁」抽象成一条轻信号 {targets, intent, ref}，作为判断式投递
 * 的产出/消费共享契约：
 *
 * - targets：本信号要投递到的目标猫名数组（会话成员，完整名）。数组化——
 *   契约即传输层形状，直接对齐 post_message 的 targetCats 数组（不设适配层）；
 *   多播一次投多只天然承载，at-mention 通道转多行 @。用户拍板弃单数 target。
 * - intent：投递目的（定死词汇表 quality_gate / review_commit / receive_review /
 *   closeout，见 DELIVERY_INTENTS——弃 T1 旧注释 request_review / close_out 变体）。
 *   flow-state.ts 状态机派生谱 === 本契约值域（单测断言一致）。
 * - ref：定位 + 去重的主键。以 commit_sha 为主键（审查链事件的定位+去重同源）；
 *   纯会话无 commit 退 trace_id 兜底（trace_id 仅关联列串同一趟消息线程，
 *   绝不替代 ref 做定位/去重——ADR §4 契约③：两次触发 trace_id 不同，若以
 *   trace_id 判同源会漏判重复）。
 *
 * 边界（P0 投递契约对齐派活单）：
 * - 只定义契约 + 消费映射（纯单元可测）；不接传输层 post_message / route-signals
 *   （post_message 工具 schema 被 mcp-server.test.js 护栏③冻结——六把既有工具
 *   inputSchema 结构与瘦身前逐字段零差异，threading intent/ref 会破护栏）。
 * - 判断式投递原链路（agent 自由向 -> post_message / 行首 @）不破坏。
 *
 * 承载物：铁律层出口检查段（packages/server/src/seed-data.ts 的 COMMON_IRON_LAWS）承载
 * 「投递决定」（投给谁 / 要它做什么 / 凭什么定位），**不承载本形状**——形状由服务端产出
 * （flow-advance.ts 契约③兜底提醒）。本模块只定义信号本身，不写产出指令。
 */

import { z } from 'zod'

/**
 * intent 词汇表定死（用户拍板，ADR §4 契约①）：状态机主干道派生谱——
 * quality-gate → review_commit → receive-review → closeout。弃 T1 旧注释变体
 * （request_review / close_out）。单源：契约值域 + flow-state.ts 派生谱共用此常量。
 */
export const DELIVERY_INTENTS = [
  'quality_gate',
  'review_commit',
  'receive_review',
  'closeout',
] as const

export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number]

/** 契约① 轻信号形状：{targets, intent, ref}，不载全文、不比较内容。 */
export const deliverySignalSchema = z.object({
  targets: z.array(z.string().min(1)).min(1),
  intent: z.enum(DELIVERY_INTENTS),
  ref: z.string().min(1),
})

export type DeliverySignal = z.infer<typeof deliverySignalSchema>

/** 消费通道：post_message 结构化路由首选；行首 @ 为 fallback（契约①「两套通道」）。 */
export type DeliveryChannel = 'post_message' | 'at-mention'

/** 消费映射产物：一条轻信号决策出一条投递动作。 */
export interface DeliveryAction {
  channel: DeliveryChannel
  /** 目标猫名数组——post_message 的 targetCats / 多行行首 @ 的对象。原样透传，不做名称变换。 */
  targets: string[]
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
 * 产出轻信号（契约①/②）：给定目标组 + 意图 + commit 上下文，解析 ref 并过 schema 校验。
 * 产出形状恒定（ref 主键语义内聚于此），消费层只认 DeliverySignal。
 * 校验失败抛 ZodError——契约违规要暴露而非静默（判定式投递是一场一等公民消费）。
 */
export function buildDeliverySignal(partial: {
  targets: string[]
  intent: DeliveryIntent
  commitSha?: string
  traceId: string
}): DeliverySignal {
  return deliverySignalSchema.parse({
    targets: partial.targets,
    intent: partial.intent,
    ref: resolveDeliveryRef(partial),
  })
}

/**
 * 消费映射（契约①「post_message 首选 / 行首 @ fallback」）：
 * postMessageAvailable = 结构化路由可用（MCP post_message 工具在场且预校验会过）→
 * 首选 post_message；否则降级行首 @。targets 原样透传（目标猫名已定，不二次解析）。
 */
export function planDelivery(
  signal: DeliverySignal,
  opts: { postMessageAvailable: boolean }
): DeliveryAction {
  return {
    channel: opts.postMessageAvailable ? 'post_message' : 'at-mention',
    targets: signal.targets,
  }
}

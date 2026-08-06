/**
 * MCP 结构化路由信号——存储与消费（Phase 1）。
 *
 * 模型通过 post_message 工具（scripts/mcp-server.mjs）把「投递下一棒」的
 * 意图声明为结构化信号；本模块是信号的内存存储（路由信号 Map）：
 *   - internal.ts 预校验通过后 storeRouteSignal 入 Map
 *   - socketio.ts:870 合并点 consumeRouteSignals 按 messageId 标签取走
 *
 * messageId 标签语义（审查裁决）：只消费 signal.msgId === 当前流 msgId 的
 * 信号——abort 残留信号天然失效（残留信号属于旧流 msgId，与新流不匹配），
 * 无需清理逻辑。按 agentId 分组存储，消费时同 agent 同流的一次取走。
 *
 * 纯内存结构，与 activeStreams 解耦——不存活跃流状态，只存信号本身。
 */

/** 一条路由信号（对应内部端点 body + MCP 工具参数） */
export interface RouteSignal {
  sessionId: string
  agentId: string
  /** 当前流 msgId——messageId 标签：只被同 msgId 的合并点消费 */
  msgId: string
  targetCats: string[]
  clientMessageId?: string
}

/** 存储：agentId → 该 agent 的信号列表（按到达序） */
const signalStore = new Map<string, RouteSignal[]>()

/** 预校验通过后入 Map（internal.ts 调用）。同 agent 同流重复信号合并目标去重。 */
export function storeRouteSignal(signal: RouteSignal): void {
  const existing = signalStore.get(signal.agentId) ?? []
  const same = existing.find((s) => s.sessionId === signal.sessionId && s.msgId === signal.msgId)
  if (same) {
    // 同流重复投递（模型多次调 post_message）→ 目标并集，去重保序
    same.targetCats = [...new Set([...same.targetCats, ...signal.targetCats])]
    same.clientMessageId = signal.clientMessageId ?? same.clientMessageId
    return
  }
  existing.push(signal)
  signalStore.set(signal.agentId, existing)
}

/**
 * 合并点消费（socketio.ts 调用）：取走 agentId + msgId 匹配的信号并清除。
 * 返回的信号 targetCats 与 parseMentionsFromReply 结果取并集。
 */
export function consumeRouteSignals(
  sessionId: string,
  agentId: string,
  msgId: string
): RouteSignal[] {
  const existing = signalStore.get(agentId)
  if (!existing) return []
  const matched = existing.filter((s) => s.sessionId === sessionId && s.msgId === msgId)
  if (matched.length > 0) {
    const rest = existing.filter((s) => !(s.sessionId === sessionId && s.msgId === msgId))
    if (rest.length > 0) signalStore.set(agentId, rest)
    else signalStore.delete(agentId)
  }
  return matched
}

/** 测试钩子：清空信号存储（dispatch 测试用例间隔离） */
export function __test_resetRouteSignals(): void {
  signalStore.clear()
}

/** 测试钩子：当前存储的信号数（断言消费语义用） */
export function __test_routeSignalCount(): number {
  let n = 0
  for (const list of signalStore.values()) n += list.length
  return n
}

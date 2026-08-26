/**
 * MCP 用户请求信号——存储与消费（重启请求稳定触发 Phase 1）。
 *
 * 模型通过 request_user_action 工具（scripts/mcp-server.mjs）把「需要用户
 * 介入（重启/选项选择）」的意图声明为结构化信号；本模块是信号的内存存储
 * （照搬 route-signals.ts 的信号 Map 模式）：
 *   - internal.ts 预校验通过后 storeUserRequestSignal 入 Map
 *   - socketio.ts runAgentReply 完成点 consumeUserRequestSignals 按 messageId 标签取走
 *
 * messageId 标签语义（照搬 route-signals 审查裁决）：只消费 signal.msgId ===
 * 当前流 msgId 的信号——abort 残留信号天然失效（残留信号属于旧流 msgId，
 * 与新流不匹配），无需清理逻辑。按 agentId 分组存储，消费时同 agent 同流
 * 的一次取走。
 *
 * 纯内存结构，与 activeStreams 解耦——不存活跃流状态，只存信号本身。
 */

/** 一条用户请求信号（对应内部端点 body + MCP 工具参数） */
export interface UserRequestSignal {
  sessionId: string
  agentId: string
  /** 当前流 msgId——messageId 标签：只被同 msgId 的合并点消费 */
  msgId: string
  /** 请求类型——枚举就绪：restart/push 已落地；choice 服务端暂拒（渲染留第二步，管道先通） */
  type: 'restart' | 'push' | 'choice'
  /** 请求原因（写 .restart-request 文件与前端按钮展示用） */
  reason: string
  /** choice 用选项组（restart 忽略；结构就绪，服务端暂不支持 choice） */
  options?: { id: string; label: string }[]
}

/** 存储：agentId → 该 agent 的信号列表（按到达序） */
const signalStore = new Map<string, UserRequestSignal[]>()

/** 预校验通过后入 Map（internal.ts 调用）。同 agent 同流重复信号合并（reason 取最后到达）。 */
export function storeUserRequestSignal(signal: UserRequestSignal): void {
  const existing = signalStore.get(signal.agentId) ?? []
  const same = existing.find((s) => s.sessionId === signal.sessionId && s.msgId === signal.msgId)
  if (same) {
    // 同流重复请求（模型多次调 request_user_action）→ 以最后到达的 reason 为准
    same.type = signal.type
    same.reason = signal.reason
    same.options = signal.options ?? same.options
    return
  }
  existing.push(signal)
  signalStore.set(signal.agentId, existing)
}

/**
 * 合并点消费（socketio.ts 调用）：取走 agentId + msgId 匹配的信号并清除。
 * 返回的信号与 isRestartRequestContent 文本检测结果取并集。
 */
export function consumeUserRequestSignals(
  sessionId: string,
  agentId: string,
  msgId: string
): UserRequestSignal[] {
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
export function __test_resetUserRequestSignals(): void {
  signalStore.clear()
}

/** 测试钩子：当前存储的信号数（断言消费语义用） */
export function __test_userRequestSignalCount(): number {
  let n = 0
  for (const list of signalStore.values()) n += list.length
  return n
}

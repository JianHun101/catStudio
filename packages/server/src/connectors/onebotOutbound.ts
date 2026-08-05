/**
 * OneBot v11 出站转发——把 agent 回复发回 QQ 绑定群/私聊。
 *
 * 链路：replyBus（emitAgentReply，socketio runAgentReply 落库后触发）
 *   → 本模块订阅 → listBindingsBySession 找绑定 → fetch 到 NapCat HTTP API。
 *
 * 语义（P3 派活单契约）：
 * - ONEBOT_ENABLED=false → startOneBotOutbound 不订阅（零开销）
 * - 群绑定 → POST ${ONEBOT_API_BASE}/send_group_msg（group_id）
 * - 私聊绑定 → POST ${ONEBOT_API_BASE}/send_private_msg（user_id）
 * - body 带 `[猫名]: ` 前缀——与入站 `[昵称]: ` 前缀对称，接收方知道谁在说话
 * - fetch fire-and-forget：失败 log.warn 不重试不回 5xx（出站失败不阻塞回复管线）
 * - 一个会话绑多个聊天（群+私聊）→ 逐条发送
 */
import { onAgentReply, type AgentReplyMessage } from './replyBus.js'
import { connectorBindings as bindingsRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('onebot-out')

/** 当前接入的外部平台标识（与 routes/connectors.ts 的 PLATFORM_QQ 对齐） */
const PLATFORM_QQ = 'qq'

function onebotEnabled(): boolean {
  return process.env.ONEBOT_ENABLED !== 'false'
}

/**
 * OneBot 出站 fetch 超时（毫秒）——P4 #2：NapCat 假死（accept 不响应）时防止
 * fetch 悬挂卡住该会话后续绑定（发送是 for 循环逐条 await，悬挂即慢泄漏）。
 * 默认 10s，ONEBOT_FETCH_TIMEOUT_MS env 可覆盖。
 */
function onebotFetchTimeoutMs(): number {
  const v = parseInt(process.env.ONEBOT_FETCH_TIMEOUT_MS || '10000', 10)
  return Number.isFinite(v) && v > 0 ? v : 10000
}

/**
 * 启动出站转发：订阅 replyBus。
 * @returns 取消订阅函数（测试与优雅关闭用）；未启用时返回 null
 */
export function startOneBotOutbound(): (() => void) | null {
  if (!onebotEnabled()) {
    log.info('onebot outbound disabled (ONEBOT_ENABLED=false)')
    return null
  }
  const unsubscribe = onAgentReply((msg) => {
    // fire-and-forget——出站失败不阻塞 runAgentReply 的回复管线
    void deliverAgentReply(msg)
  })
  log.info('onebot outbound started', { apiBase: process.env.ONEBOT_API_BASE })
  return unsubscribe
}

/**
 * 把一条 agent 回复投递给会话的所有 QQ 绑定。
 * @returns 投递的绑定数（0 = 无绑定未投递）
 */
export async function deliverAgentReply(msg: AgentReplyMessage): Promise<number> {
  const bindings = bindingsRepo
    .listBindingsBySession(msg.sessionId)
    .filter((b) => b.platform === PLATFORM_QQ)
  if (bindings.length === 0) return 0

  const base = process.env.ONEBOT_API_BASE || 'http://127.0.0.1:3000'
  // [猫名]: 前缀与入站 [昵称]: 对称——QQ 侧能看到发言者是谁
  const text = `[${msg.agentName}]: ${msg.content}`

  let delivered = 0
  for (const binding of bindings) {
    const endpoint = binding.external_type === 'group' ? '/send_group_msg' : '/send_private_msg'
    const body =
      binding.external_type === 'group'
        ? { group_id: Number(binding.external_id), message: text }
        : { user_id: Number(binding.external_id), message: text }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // NapCat HTTP API 默认配置带 token（鉴权 401/403）——token 存在时才带
    // Authorization 头；未配置的环境不带头，保持与无鉴权 NapCat 兼容（P3 测试
    // 无 token 断言不受影响）
    const token = process.env.ONEBOT_TOKEN
    if (token) headers['Authorization'] = `Bearer ${token}`
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // P4 #2: AbortSignal.timeout 超时拒绝（name === 'TimeoutError'）自然进下方
        // catch 走 log.warn 不重试——与出站失败语义一致
        signal: AbortSignal.timeout(onebotFetchTimeoutMs()),
      })
      if (!res.ok) {
        log.warn('onebot send failed', {
          endpoint,
          externalId: binding.external_id,
          status: res.status,
        })
        continue
      }
      delivered++
    } catch (err: any) {
      // 网络失败/超时——log.warn 不重试（NapCat 本地服务，失败多半是没启动）
      log.warn('onebot send error', {
        endpoint,
        externalId: binding.external_id,
        error: err.message,
      })
    }
  }
  return delivered
}

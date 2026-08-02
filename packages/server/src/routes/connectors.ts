/**
 * 连接器 REST API — 外部平台（QQ/NapCat OneBot v11）↔ 猫咖会话的绑定管理与消息接入。
 *
 * - POST/GET/DELETE /api/connectors/bindings — 群号/QQ ↔ session 映射增查删
 * - POST /api/connectors/onebot/webhook — 收 OneBot v11 HTTP 上报
 *   （立即 200 防 NapCat 超时重投，事件过滤与摄入放异步处理）
 */
import type { FastifyInstance } from 'fastify'
import {
  connectorBindings as bindingsRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
} from '../db/repository/index.js'
import { ingestUserMessage } from '../connectors/ingest.js'
import { parseOneBotMessage, type OneBotMessageEvent } from '../connectors/onebot.js'
import { createLogger } from '../logger.js'

const log = createLogger('connectors')

/** 当前接入的外部平台标识（绑定表 platform 字段）——OneBot 承载的即 QQ */
const PLATFORM_QQ = 'qq'

function onebotEnabled(): boolean {
  return process.env.ONEBOT_ENABLED !== 'false'
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  // ─── 绑定管理 ──────────────────────────────────

  app.post('/api/connectors/bindings', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const { platform, externalType, externalId, sessionId } = body
    if (typeof platform !== 'string' || !platform) {
      return reply.status(400).send({ error: 'platform is required (string)' })
    }
    if (externalType !== 'group' && externalType !== 'private') {
      return reply.status(400).send({ error: "externalType must be 'group' or 'private'" })
    }
    if (typeof externalId !== 'string' || !externalId) {
      return reply.status(400).send({ error: 'externalId is required (string)' })
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return reply.status(400).send({ error: 'sessionId is required (string)' })
    }
    const session = sessionsRepo.getSessionById(sessionId)
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    const binding = bindingsRepo.upsertConnectorBinding(
      platform,
      externalType,
      externalId,
      sessionId
    )
    return reply.status(201).send({ ok: true, binding })
  })

  app.get('/api/connectors/bindings', async (req, reply) => {
    const { platform } = req.query as { platform?: string }
    const bindings = bindingsRepo.listConnectorBindings(
      typeof platform === 'string' && platform ? platform : undefined
    )
    return reply.send({ ok: true, bindings })
  })

  app.delete('/api/connectors/bindings', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const { platform, externalType, externalId } = body
    if (typeof platform !== 'string' || !platform) {
      return reply.status(400).send({ error: 'platform is required (string)' })
    }
    if (externalType !== 'group' && externalType !== 'private') {
      return reply.status(400).send({ error: "externalType must be 'group' or 'private'" })
    }
    if (typeof externalId !== 'string' || !externalId) {
      return reply.status(400).send({ error: 'externalId is required (string)' })
    }
    const removed = bindingsRepo.deleteConnectorBinding(platform, externalType, externalId)
    if (!removed) {
      return reply.status(404).send({ error: 'Binding not found' })
    }
    return reply.send({ ok: true })
  })

  // ─── OneBot v11 webhook ────────────────────────

  app.post('/api/connectors/onebot/webhook', async (req, reply) => {
    if (!onebotEnabled()) {
      return reply.status(503).send({ error: 'OneBot connector is disabled' })
    }
    const event = req.body as OneBotMessageEvent | undefined
    if (!event || typeof event !== 'object') {
      return reply.status(400).send({ error: 'Event body is required' })
    }

    // 立即 200——NapCat 上报超时会重投；事件过滤/绑定查找/摄入放异步处理
    reply.send({ ok: true })

    try {
      await handleOneBotEvent(event)
    } catch (err: any) {
      // 处理失败不回 5xx（响应已发）——记录日志，NapCat 侧视为已接收
      log.error('onebot event processing failed', { error: err.message })
    }
  })
}

/**
 * 处理一条 OneBot 事件：过滤 → 绑定查找 → 解析 → 摄入。
 * 所有不符合条件的输入在此静默返回（无绑定群/私聊、自消息、非 message 事件、
 * 群聊未 @机器人）——webhook 仍已 200，NapCat 不会重投。
 */
async function handleOneBotEvent(event: OneBotMessageEvent): Promise<void> {
  // 1. 只处理 message 事件（notice/request 等忽略）
  if (event.post_type !== 'message') return
  // 2. 防自循环：机器人自己发的消息忽略
  if (event.user_id !== undefined && String(event.user_id) === String(event.self_id)) return

  const messageType = event.message_type
  if (messageType !== 'group' && messageType !== 'private') return

  // 3. 绑定查找：群用 group_id，私聊用 user_id
  const externalId = String(messageType === 'group' ? event.group_id : event.user_id)
  const binding = bindingsRepo.getConnectorBinding(PLATFORM_QQ, messageType, externalId)
  if (!binding) return // 无绑定的群/私聊静默忽略

  // 4. roster：绑定会话的 agent 名单（文本 @猫名 匹配用）
  const session = sessionsRepo.getSessionById(binding.session_id)
  if (!session) {
    // 绑定指向的会话已被删除（绑定无 FK，成为孤儿）——静默忽略
    log.warn('binding points to missing session', {
      bindingId: binding.id,
      sessionId: binding.session_id,
    })
    return
  }
  const roster = sessionsRepo
    .getSessionAgentIds(binding.session_id)
    .map((id) => agentsRepo.getAgentById(id)?.name)
    .filter((n): n is string => !!n)

  const parsed = parseOneBotMessage(event, { roster, selfId: event.self_id, messageType })
  if (!parsed) return

  // 5. 摄入（QQ 群友消息是真实对话 → 进向量记忆库，与前端消息同等对待）
  const result = await ingestUserMessage({
    sessionId: binding.session_id,
    content: parsed.content,
    mentions: parsed.mentions,
    saveMemory: true,
  })
  if (!result.ok) {
    log.warn('onebot ingest failed', {
      sessionId: binding.session_id,
      status: result.status,
      error: result.error,
    })
  }
}

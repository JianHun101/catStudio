/**
 * E2 归因分流器 + closure 复验闭环 — v2 episode 评估规格 §4。
 *
 * 契约要点：
 * - 归因：非 success 结局的 classified episode → 定位根因 → 分流到既有动作通道
 *   （店长映射：needs_investigation→调查单 / harness_fix_needed→拆活单 /
 *    routing_failure+abandoned→dispatch 重放机制 / corrected_success→改进素材）
 * - 幂等：episode_attributions UNIQUE(episode_id)——一个 episode 只分流一次，
 *   定时器每轮扫描不重复投递（L1 滞回去重同款语义）
 * - closure 复验：对已分流记录重跑判定（classifyChain），结局翻转为
 *   success/corrected_success → episode_state='closed' + 记录 status='resolved'；
 *   翻转以判定为准，不依赖口头确认（规格 §4 钉死）
 * - 消息层闭环：投递成功时把消息 id 写回 episode_attributions.delivery_message_id，
 *   markResolved 关闭时对原消息原地追加「✅已关闭」标记（方案 A——用户同一
 *   位置看到完整状态，不撤回、不另起新消息；投递失败/会话缺失则不记录）
 * - 在途（open）不归因（classifyEpisodes 判定 1 已 skip，此处防御性跳过）
 * - 投递走 L1 同款消息通道（system 落库 + 房间广播 + mentions 写回店长），
 *   不触发 dispatch（role='system' 非执行入口）
 * - replay 动作 = 触发一次 dispatch 重放检查（replayStuckUserMessages，既有机制）：
 *   abandoned 零执行场景的根消息在 NULL 面，补派后产生新执行链 → 下一轮判定
 *   success → closure 复验关闭，闭环成立；routing_failure 消息在 done 面不在
 *   重放扫描范围（已知边界，action_detail 记录在案）
 */

import { v4 as uuid } from 'uuid'
import { Events } from '@cat-study/shared'
import type { Server as SocketServer } from 'socket.io'
import { getDb } from '../db/index.js'
import { sessions as sessionsRepo, messages as messagesRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'
import { replayStuckUserMessages } from '../connectors/socketio.js'
import {
  collectChain,
  classifyChain,
  type EpisodeOutcome,
  type RootMessageRow,
} from './episodes.js'

const log = createLogger('episode-attribution')

/** 归因动作类型（店长映射，规格 §4） */
export type AttributionAction = 'investigation' | 'harness_fix' | 'replay' | 'improvement'

/** 归因记录行（db 表 episode_attributions） */
export interface AttributionRow {
  id: string
  episode_id: string
  outcome: string
  root_cause: string | null
  action_type: AttributionAction
  action_detail: string | null
  status: 'dispatched' | 'resolved'
  created_at: string
  updated_at: string
}

/** 需要归因分流的结局（成功类无需动作；unclassified 无根因可归，不动作） */
const ACTIONABLE: Partial<Record<EpisodeOutcome, AttributionAction>> = {
  needs_investigation: 'investigation',
  harness_fix_needed: 'harness_fix',
  routing_failure: 'replay',
  abandoned: 'replay',
  corrected_success: 'improvement',
}

// ─── 根因定位 ─────────────────────────────────────────────

/** 链内最近失败行的 error_type（归因源 1） */
function latestFailureType(chain: Awaited<ReturnType<typeof collectChain>>): string | null {
  const failures = chain
    .filter((l) => l.status === 'failed' && (l.error_type ?? 'unknown') !== 'server_restart')
    .sort((a, b) => ((b.started_at ?? '') > (a.started_at ?? '') ? 1 : -1))
  return failures[0]?.error_type ?? null
}

/** 最近一次 reject/suggest 审查结论（归因源 2：completed 后被打回场景） */
function latestRejectOrSuggest(rootMsg: RootMessageRow, chainTaskId: string | null): string | null {
  if (!chainTaskId) return null
  const row = getDb()
    .prepare(
      `SELECT v.verdict FROM review_verdicts v
       JOIN messages m ON m.id = v.message_id
       WHERE m.task_id = ? AND m.session_id = ? AND v.created_at > ?
         AND v.verdict IN ('reject', 'suggest')
       ORDER BY v.created_at DESC LIMIT 1`
    )
    .get(chainTaskId, rootMsg.session_id, rootMsg.created_at) as { verdict: string } | undefined
  return row?.verdict ?? null
}

/**
 * 定位根因：按结局 + 执行链 + verdict 组合推导根因文本（信息性记录，
 * 供调查/拆活单正文与复验参考）。
 */
export function locateRootCause(
  outcome: EpisodeOutcome,
  chain: Awaited<ReturnType<typeof collectChain>>,
  rootMsg: RootMessageRow,
  chainTaskId: string | null
): string {
  switch (outcome) {
    case 'needs_investigation': {
      const errType = latestFailureType(chain)
      if (errType === 'timeout') return 'timeout（配额/网络需调查）'
      if (errType) return `error_type=${errType}（需调查）`
      const verdict = latestRejectOrSuggest(rootMsg, chainTaskId)
      return verdict ? `完成被打回（verdict=${verdict}），未重做` : '完成态存在未知异常（需调查）'
    }
    case 'harness_fix_needed':
      return `harness 侧失败（error_type=${latestFailureType(chain) ?? 'unknown'}）`
    case 'routing_failure':
      return '全部执行行失败且无明确归因（路由整体失败）'
    case 'abandoned': {
      const onlyRestart = chain.length > 0 && chain.every((l) => l.status === 'failed')
      return onlyRestart
        ? '仅 server_restart 失败（重启打断未恢复）'
        : '零执行超窗（落库未调度，dispatch 静默丢）'
    }
    case 'corrected_success':
      return '打回后重做完成（改进素材）'
    default:
      return '无明确根因'
  }
}

// ─── 分流投递（L1 同款消息通道）──────────────────────────

/** 动作 → 消息标题（调查单/拆活单的既有通道形态 = 行首 @店长 的 system 消息） */
const ACTION_TITLES: Record<AttributionAction, string> = {
  investigation: '📋调查单',
  harness_fix: '🔧拆活单',
  replay: '🔄重放检查',
  improvement: '💡改进素材',
}

/** 动作 → 正文提示（投递到既有动作通道后的预期处置） */
const ACTION_HINTS: Record<AttributionAction, string> = {
  investigation: '请调查根因并跟进修复',
  harness_fix: '请拆活派发修复（harness 侧问题）',
  replay:
    'dispatch 重放检查已触发（零执行消息补派）；routing_failure 消息在 done 面不在重放扫描范围，待 A2A/人工重新触发',
  improvement: '打回后重做完成的样本，改进评审可参考',
}

/**
 * 分流投递：对根消息所在会话落库 + 房间广播（system 角色，mentions 写回店长——
 * 上下文过滤只对店长可见，与 L1 告警同款）。单会话 FK 失败不 abort。
 */
function dispatchAction(
  io: SocketServer,
  action: AttributionAction,
  ep: { sessionId: string; rootTriggerMessageId: string; outcome: string; rootCause: string }
): string | null {
  const s = sessionsRepo.getSessionById(ep.sessionId)
  if (!s) return null // 会话已删——投递无目标，归因记录仍在案
  const content = [
    `@店长 ${ACTION_TITLES[action]}（episode 归因分流）：`,
    `- 根消息: ${ep.rootTriggerMessageId}`,
    `- 结局: ${ep.outcome}`,
    `- 根因: ${ep.rootCause}`,
    `- 建议: ${ACTION_HINTS[action]}`,
  ].join('\n')
  try {
    const msgId = uuid()
    messagesRepo.insertMessage(msgId, s.id, 'system', content, JSON.stringify(['店长']), null, null)
    io.to(`session:${s.id}`).emit(Events.NEW_MESSAGE, {
      id: msgId,
      sessionId: s.id,
      agentId: null,
      role: 'system',
      content,
      mentions: ['店长'],
      createdAt: new Date().toISOString(),
    })
    log.warn('episode 归因分流已投递', { sessionId: s.id, action, outcome: ep.outcome })
    return msgId // 投递成功——供写回 delivery_message_id（消息层闭环）
  } catch (err: any) {
    log.warn('episode 归因分流投递失败（跳过该会话）', { sessionId: s.id, error: err.message })
    return null
  }
}

// ─── 主流程 ───────────────────────────────────────────────

interface ActionableEpisodeRow {
  id: string
  root_trigger_message_id: string
  session_id: string | null
  outcome: EpisodeOutcome
  chain_task_id: string | null
}

/** 一轮归因 + 复验。返回统计供日志/测试断言。 */
export function runEpisodeAttribution(io: SocketServer): {
  dispatched: number
  resolved: number
} {
  const db = getDb()
  let dispatched = 0
  let resolved = 0
  let needReplayCheck = false

  // ── 归因生成：classified 非成功类结局且无归因记录 → 分流 ──
  const actionable = db
    .prepare(
      `SELECT e.id, e.root_trigger_message_id, e.session_id, e.outcome, e.chain_task_id
       FROM episodes e
       WHERE e.episode_state = 'classified'
         AND e.outcome IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM episode_attributions a WHERE a.episode_id = e.id)`
    )
    .all() as ActionableEpisodeRow[]

  for (const ep of actionable) {
    const action = ACTIONABLE[ep.outcome]
    if (!action) continue // unclassified：无根因可归，不动作
    const rootMsg = db
      .prepare(`SELECT id, session_id, content, task_id, created_at FROM messages WHERE id = ?`)
      .get(ep.root_trigger_message_id) as RootMessageRow | undefined
    if (!rootMsg) continue // 根消息已删（孤儿 episode）——归因无源，跳过
    const chain = collectChain(ep.root_trigger_message_id)
    const rootCause = locateRootCause(ep.outcome, chain, rootMsg, ep.chain_task_id)

    // OR IGNORE：UNIQUE(episode_id) 双保险幂等（主查询 NOT EXISTS 已排除）
    db.prepare(
      `INSERT OR IGNORE INTO episode_attributions
         (id, episode_id, outcome, root_cause, action_type, action_detail, status)
       VALUES (?, ?, ?, ?, ?, ?, 'dispatched')`
    ).run(uuid(), ep.id, ep.outcome, rootCause, action, ACTION_HINTS[action])

    if (ep.session_id) {
      const msgId = dispatchAction(io, action, {
        sessionId: ep.session_id,
        rootTriggerMessageId: ep.root_trigger_message_id,
        outcome: ep.outcome,
        rootCause,
      })
      // 投递成功 → 写回消息 id（消息层闭环：closure 复验关闭时原地追加标记）
      if (msgId) {
        db.prepare(
          `UPDATE episode_attributions SET delivery_message_id = ? WHERE episode_id = ?`
        ).run(msgId, ep.id)
      }
    } else {
      log.warn('episode 归因分流跳过投递（episode 无 session_id）', { episodeId: ep.id })
    }
    if (action === 'replay') needReplayCheck = true
    dispatched++
  }

  // replay 分流 → 触发一次 dispatch 重放检查（既有机制，abandoned 零执行闭环的引擎）
  if (needReplayCheck) {
    void triggerReplayCheck(io)
  }

  // ── closure 复验：已分流记录重跑判定，翻转 success 类才关闭 ──
  const pending = db
    .prepare(
      `SELECT a.episode_id, a.action_type, e.root_trigger_message_id
       FROM episode_attributions a
       JOIN episodes e ON e.id = a.episode_id
       WHERE a.status = 'dispatched'`
    )
    .all() as Array<{ episode_id: string; action_type: string; root_trigger_message_id: string }>

  for (const p of pending) {
    if (p.action_type === 'improvement') {
      // 改进素材无动作通道可复验——直接关闭（记录在案，不动作不等待）
      markResolved(p.episode_id)
      resolved++
      continue
    }
    const rootMsg = db
      .prepare(`SELECT id, session_id, content, task_id, created_at FROM messages WHERE id = ?`)
      .get(p.root_trigger_message_id) as RootMessageRow | undefined
    if (!rootMsg) {
      // 根消息已删——无法复验，关闭（孤儿终态）
      markResolved(p.episode_id)
      resolved++
      continue
    }
    const chain = collectChain(p.root_trigger_message_id)
    const { outcome, state } = classifyChain(chain, rootMsg)
    // 翻转 abandoned/失败类 → success/corrected_success 才关闭（不依赖口头确认）
    if (state === 'classified' && (outcome === 'success' || outcome === 'corrected_success')) {
      markResolved(p.episode_id)
      log.info('episode closure 复验通过：结局翻转，关闭', {
        episodeId: p.episode_id,
        outcome,
      })
      resolved++
    }
    // 未翻转：保持 dispatched（不重复投递——归因幂等键已挡住），下轮再复验
  }

  return { dispatched, resolved }
}

/** 关闭 episode + 归因记录 resolved（closure 终态） */
function markResolved(episodeId: string): void {
  const db = getDb()
  const outcome = db.prepare(`SELECT outcome FROM episodes WHERE id = ?`).get(episodeId) as
    { outcome: string } | undefined
  db.prepare(
    `UPDATE episode_attributions SET status = 'resolved', updated_at = datetime('now') WHERE episode_id = ?`
  ).run(episodeId)
  db.prepare(
    `UPDATE episodes SET episode_state = 'closed', updated_at = datetime('now') WHERE id = ?`
  ).run(episodeId)
  // 消息层闭环：投递过的归因消息原地追加「已关闭」标记（不撤回、不另起
  // 新消息——用户同一位置看到完整状态）。投递消息已删则跳过（关闭本身
  // 已落库，标记属终态归档的尽力而为）
  if (!outcome) return
  const attr = db
    .prepare(`SELECT delivery_message_id FROM episode_attributions WHERE episode_id = ?`)
    .get(episodeId) as { delivery_message_id: string | null } | undefined
  if (!attr?.delivery_message_id) return // 旧库/投递失败：无投递消息可标记
  const msg = db
    .prepare(`SELECT content FROM messages WHERE id = ?`)
    .get(attr.delivery_message_id) as { content: string } | undefined
  if (!msg) return
  messagesRepo.updateMessageContent(
    attr.delivery_message_id,
    `${msg.content}\n\n✅已关闭（结局翻转 ${outcome.outcome}）`
  )
}

/** replay 动作的执行体：触发 dispatch 重放检查（既有机制，失败不阻塞归因主流程） */
export async function triggerReplayCheck(io: SocketServer): Promise<void> {
  try {
    await replayStuckUserMessages(io)
  } catch (err: any) {
    log.warn('episode replay 检查失败（非阻塞）', { error: err.message })
  }
}

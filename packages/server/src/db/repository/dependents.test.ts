/**
 * 删除依赖清理测试（票 6 批一）。
 *
 * 判据面 = **既有删除端点还删得掉**：spec §4.1 的删除策略是「物理删除全 RESTRICT」，
 * 7 张表补的 FK 全是 RESTRICT ⇒ 子行会挡住父行的 DELETE。本文件测的就是「挡不挡得住」：
 *
 * - 负向对照（真空性）：**不调 purge** 直接删父行 → 必须**抛 FK**。没有这一条，正例全绿
 *   也可能只是「约束压根没生效」，测的是个空转。
 * - 正例：走 `db/repository` 的 `delete*` 函数 → 子行随之清掉、父行删得掉。
 * - 全清形态（`pnpm seed --reset` 的调用序）→ 一趟跑完不抛。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import {
  initRepository,
  messages as messagesRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
  executionLogs as execLogsRepo,
  flowStates as flowStatesRepo,
} from './index.js'

const SESSION = 's1'
const AGENT = 'a1'
const REVIEWER = 'a2'

/** 父行 + 各张子表各一行（引用都指向真实存在的父行） */
function seedGraph(): void {
  const db = getDb()
  db.exec(`
    INSERT INTO sessions (id, title, agent_ids) VALUES ('${SESSION}', 't', '[]');
    INSERT INTO agents (id, name, system_prompt, llm_api_key)
      VALUES ('${AGENT}', 'ds猫', 'p', 'sk'), ('${REVIEWER}', '吐槽猫', 'p', 'sk');
    INSERT INTO messages (id, session_id, agent_id, role, content, mentions)
      VALUES ('m1', '${SESSION}', '${AGENT}', 'agent', 'y', '[]'),
             ('m2', '${SESSION}', NULL, 'user', 'x', '[]');
    INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, message_id)
      VALUES ('e1', '${SESSION}', '${AGENT}', 'm2', 'completed', '2026-09-01T00:00:00.000Z', 'm1');
    INSERT INTO flow_states (session_id, commit_sha, state, updated_at)
      VALUES ('${SESSION}', 'sha', 'closed', '2026-09-01T00:00:00.000Z');
    INSERT INTO flow_state_events (session_id, commit_sha, to_state, intent, created_at)
      VALUES ('${SESSION}', 'sha', 'closed', 'closeout', '2026-09-01T00:00:00.000Z');
    INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id, created_at)
      VALUES ('cb1', 'qq', 'group', 'g1', '${SESSION}', '2026-09-01T00:00:00.000Z');
    INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, episode_state, classification_ver)
      VALUES ('ep1', 'm2', 'U', 'open', 'v1');
    INSERT INTO episode_attributions (id, episode_id, outcome, action_type, status, delivery_message_id, created_at, updated_at)
      VALUES ('ea1', 'ep1', 'abandoned', 'replay', 'resolved', 'm1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
      VALUES ('m1', '${SESSION}', '${REVIEWER}', '${AGENT}', 'suggest', '2026-09-01T00:00:00.000Z');
    INSERT INTO review_parse_failures (message_id, reason, raw, created_at)
      VALUES ('m1', 'bad_verdict', 'r', '2026-09-01T00:00:00.000Z');
    INSERT INTO human_labels (id, message_id, session_id, agent_id, labeler, score, created_at)
      VALUES ('hl1', 'm1', '${SESSION}', '${AGENT}', 'user', 4, '2026-09-01T00:00:00.000Z');
  `)
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('db/repository/dependents —— 删除依赖清理（票 6 RESTRICT 配套）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  describe('真空性反对照：不清理就删不掉（证明约束真在、清理真承重）', () => {
    it('裸 DELETE messages → 被 review_verdicts / review_parse_failures / episode_attributions / execution_logs / human_labels 拦下', () => {
      seedGraph()
      expect(() =>
        getDb().exec(`DELETE FROM messages WHERE session_id = '${SESSION}'`)
      ).toThrowError(/FOREIGN KEY/)
      // 一条都没删掉（语句级回滚）
      expect(count('messages')).toBe(2)
    })

    it('裸 DELETE sessions → 被 flow_states / review_verdicts 等拦下', () => {
      seedGraph()
      // 先清消息侧，孤立出「会话侧」的依赖
      messagesRepo.deleteMessagesBySession(SESSION)
      expect(() => getDb().exec(`DELETE FROM sessions WHERE id = '${SESSION}'`)).toThrowError(
        /FOREIGN KEY/
      )
      expect(count('sessions')).toBe(1)
    })

    it('裸 DELETE agents → 被 review_verdicts 的 reviewer/subject 两条链拦下', () => {
      seedGraph()
      expect(() => getDb().exec(`DELETE FROM agents WHERE id = '${REVIEWER}'`)).toThrowError(
        /FOREIGN KEY/
      )
      expect(count('agents')).toBe(2)
    })
  })

  describe('正例：走 repository 的 delete* 能删干净', () => {
    it('deleteMessagesBySession：消息与其四类子行一起清掉，父行（会话/成员）完好', () => {
      seedGraph()
      const r = messagesRepo.deleteMessagesBySession(SESSION)

      expect(r.changes).toBe(2)
      expect(count('messages')).toBe(0)
      expect(count('execution_logs')).toBe(0)
      expect(count('review_verdicts')).toBe(0)
      expect(count('review_parse_failures')).toBe(0)
      expect(count('episode_attributions')).toBe(0) // delivery_message_id 指向被删消息
      expect(count('human_labels')).toBe(0) // J1：漏了这条 = 带标注的消息删不掉（500）
      // 会话本体与成员不动（那两条链由 session/agent 侧负责）
      expect(count('sessions')).toBe(1)
      expect(count('agents')).toBe(2)
      expect(count('episodes')).toBe(1) // episode 只被 attribution 引用，不在清理面
    })

    it('deleteMessagesByAgent：按猫删消息同样带上子行清理', () => {
      seedGraph()
      messagesRepo.deleteMessagesByAgent(AGENT)
      expect(count('messages')).toBe(1) // 'm2'（user 行，agent_id NULL）留下
      expect(count('review_verdicts')).toBe(0)
      expect(count('execution_logs')).toBe(0)
    })

    it('deleteSession：会话侧四条依赖清掉，会话才删得掉', () => {
      seedGraph()
      messagesRepo.deleteMessagesBySession(SESSION)
      execLogsRepo.deleteExecutionLogsBySession(SESSION)

      sessionsRepo.deleteSession(SESSION)

      expect(count('sessions')).toBe(0)
      expect(count('flow_states')).toBe(0)
      expect(count('flow_state_events')).toBe(0)
      expect(count('connector_bindings')).toBe(0)
      expect(count('review_verdicts')).toBe(0)
      // 成员不随会话消失（那是 agent 侧的删除策略，票 8 的 409 契约管）
      expect(count('agents')).toBe(2)
    })

    it('deleteAgentById：审查结论（reviewer + subject 两侧）随猫清掉，猫才删得掉', () => {
      seedGraph()
      messagesRepo.deleteMessagesBySession(SESSION)
      execLogsRepo.deleteExecutionLogsBySession(SESSION)

      agentsRepo.deleteAgentById(REVIEWER)
      expect(count('agents')).toBe(1)
      expect(count('review_verdicts')).toBe(0)

      // subject 侧同理：删被审查的猫
      agentsRepo.deleteAgentById(AGENT)
      expect(count('agents')).toBe(0)
    })

    it('deleteAll* 序（seed --reset 形态）：四步跑完不抛，全库空', () => {
      seedGraph()
      expect(() => {
        messagesRepo.deleteAllMessages()
        execLogsRepo.deleteAllExecutionLogs()
        sessionsRepo.deleteAllSessions()
        agentsRepo.deleteAllAgents()
      }).not.toThrow()

      for (const t of [
        'messages',
        'execution_logs',
        'sessions',
        'agents',
        'flow_states',
        'flow_state_events',
        'connector_bindings',
        'review_verdicts',
        'review_parse_failures',
      ]) {
        expect(count(t), t).toBe(0)
      }
      expect(getDb().pragma('foreign_key_check')).toEqual([])
    })
  })

  describe('⑤-c：记录时间由 repository 层生成 ISO 毫秒（不再走 SQL datetime）', () => {
    const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

    it('flowStates.recordFlowTransition → flow_states.updated_at 与审计流水 created_at 同为 ISO 毫秒', () => {
      seedGraph()
      flowStatesRepo.recordFlowTransition(SESSION, 'sha2', 'quality-gate', 'quality_gate')
      const s = getDb()
        .prepare(`SELECT updated_at FROM flow_states WHERE commit_sha='sha2'`)
        .get() as { updated_at: string }
      const e = getDb()
        .prepare(`SELECT created_at FROM flow_state_events WHERE commit_sha='sha2'`)
        .get() as { created_at: string }
      expect(s.updated_at).toMatch(ISO_MS)
      expect(e.created_at).toMatch(ISO_MS)
      expect(e.created_at).toBe(s.updated_at) // 同一时刻、同一口径
    })

    it('漏传时间列直接撞 NOT NULL（去 DEFAULT 的意义：不静默降级）', () => {
      seedGraph()
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id)
             VALUES ('cb2', 'qq', 'group', 'g2', '${SESSION}')`
          )
          .run()
      ).toThrowError(/NOT NULL/)
    })
  })
})

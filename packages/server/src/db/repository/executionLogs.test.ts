/**
 * execution_logs repo — 归属反查与写回消歧（T-M）测试。
 *
 * 被测面全部走**真实 repo 函数**（不手抄 SQL——手抄 SQL 就是「验证面与被判面
 * 不同面」，本 spec 已吃过一次恒真假绿门）。
 *
 * 件 1 合成单变量实验读数（修前，2026-09-10；T-M 票面口径见
 * `docs/sessions/cat-study-review-chain-anchor-summary.md` §2.2）：
 *   A `updateRunningExecutionCommitHash(U,SHA)`（无 agentId） → changes=2（命中 e1,e2 两行）
 *   B 同法带 agentId                                       → changes=1（各中自己的行）
 *   C `updateExecutionLogCommitHash(U,SHA)`（无 status 过滤）→ 3 行全中，**ended 行 e0 被盖**
 *   D `getExecutorNameByCommitHash(SHA)`（A 之后）          → ds猫（started_at 靠后者，非作者）
 *     `getExecutorNameByTriggeredBy(U)`（A 之后）           → ds猫（同上）
 * ⇒ 判据「A 命中 2 行 ⇒ 全刷子因成立，写侧一并收窄」成立。下列断言即由该实验转成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb } from '../index.js'
import { initRepository } from './index.js'
import { executionLogs as repo } from './index.js'

/** 触发消息 id（= commit message 里的 catstudy [uuid]） */
const U = '4d1e6f22-0000-4000-8000-000000000001'
/** 链锚（messages.task_id） */
const ANCHOR = 'aaaa1111-0000-4000-8000-0000000000aa'
/** 第二个会话的触发消息 id（跨会话并行用例用） */
const U2 = '4d1e6f22-0000-4000-8000-000000000002'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

interface LogSpec {
  id: string
  agent: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  traceId: string
  msgId?: string
}

function insertLog(db: Database.Database, spec: LogSpec): void {
  db.prepare(
    `INSERT INTO execution_logs
       (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
     VALUES (?, 's1', ?, ?, ?, ?, ?)`
  ).run(spec.id, spec.agent, spec.msgId ?? U, spec.status, spec.traceId, spec.startedAt)
}

/** e0（ended, flash）· e1（running, flash）· e2（running, ds）——跨 2 只猫 */
function seedCrossAgent(db: Database.Database): void {
  insertLog(db, {
    id: 'e0',
    agent: 'agent-flash',
    status: 'completed',
    startedAt: '2026-09-10 09:00:00',
    traceId: 'tr-0',
  })
  insertLog(db, {
    id: 'e1',
    agent: 'agent-flash',
    status: 'running',
    startedAt: '2026-09-10 10:00:00',
    traceId: 'tr-1',
  })
  insertLog(db, {
    id: 'e2',
    agent: 'agent-ds',
    status: 'running',
    startedAt: '2026-09-10 10:00:05',
    traceId: 'tr-2',
  })
}

function hashOf(db: Database.Database, id: string): string | null {
  return (
    db.prepare('SELECT commit_hash FROM execution_logs WHERE id = ?').get(id) as {
      commit_hash: string | null
    }
  ).commit_hash
}

describe('execution_logs repo — 归属反查（T-M）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 't')").run()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-ds', 'ds猫', '🐯', 'p', 'claude', 'm', 'k')`
    ).run()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-flash', 'flash猫', '😼', 'p', 'claude', 'm', 'k')`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 's1', 'agent', '派活', '[]', ?)`
    ).run(U, ANCHOR)
  })

  afterEach(() => {
    resetDb()
  })

  describe('getExecutorNameByCommitHash', () => {
    it('同一 sha 落在跨 agent 的多行上 → undefined（不猜；旧实现返回 started_at 靠后的 ds猫）', () => {
      seedCrossAgent(db)
      // 无 agentId 全刷的产物形态（修前 A 路），此处直接摆出该形态
      db.prepare('UPDATE execution_logs SET commit_hash = ?').run(SHA)
      expect(repo.getExecutorNameByCommitHash(SHA)).toBeUndefined()
    })

    it('同一 agent 的多行同 sha → 返回该 agent（重试不算歧义，不误拒）', () => {
      insertLog(db, {
        id: 'r1',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      insertLog(db, {
        id: 'r2',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:09',
        traceId: 'tr-2',
      })
      db.prepare('UPDATE execution_logs SET commit_hash = ?').run(SHA)
      const hit = repo.getExecutorNameByCommitHash(SHA)
      expect(hit?.name).toBe('flash猫')
      expect(hit?.trace_id).toBe('tr-2') // 同 agent 内取最近
    })

    it('唯一命中 → 返回作者，task_id = 链锚（T-I 口径不回归）', () => {
      insertLog(db, {
        id: 'e1',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      db.prepare('UPDATE execution_logs SET commit_hash = ?').run(SHA)
      const hit = repo.getExecutorNameByCommitHash(SHA)
      expect(hit?.name).toBe('flash猫')
      expect(hit?.task_id).toBe(ANCHOR)
    })

    it('无命中 → undefined（404 语义归调用方）', () => {
      seedCrossAgent(db)
      expect(repo.getExecutorNameByCommitHash(SHA)).toBeUndefined()
    })
  })

  describe('getExecutorNameByTriggeredBy', () => {
    it('同 uuid 多执行者 → undefined（不猜；旧实现返回最近开始的 ds猫）', () => {
      seedCrossAgent(db)
      expect(repo.getExecutorNameByTriggeredBy(U)).toBeUndefined()
    })

    it('同 uuid 同 agent 多行 → 返回该 agent 最近一条', () => {
      insertLog(db, {
        id: 'a1',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 09:00:00',
        traceId: 'tr-0',
      })
      insertLog(db, {
        id: 'a2',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 11:00:00',
        traceId: 'tr-1',
      })
      expect(repo.getExecutorNameByTriggeredBy(U)?.trace_id).toBe('tr-1')
    })

    it('无执行行 → undefined', () => {
      expect(repo.getExecutorNameByTriggeredBy(U)).toBeUndefined()
    })
  })

  describe('hasExecutorRowsForTrigger — 区分「无行」与「指不出人」', () => {
    it('无执行行 → false（/executor 据此回 404）', () => {
      expect(repo.hasExecutorRowsForTrigger(U)).toBe(false)
    })

    it('有行但跨 agent 指不出人 → true（/executor 据此回 200 + ambiguous，不报 404）', () => {
      seedCrossAgent(db)
      expect(repo.getExecutorNameByTriggeredBy(U)).toBeUndefined()
      expect(repo.hasExecutorRowsForTrigger(U)).toBe(true)
    })

    it('执行行指向已不存在的 agent → false（行在但不可反查，保持既有 404 安全方向）', () => {
      // FK 打开时造不出这种行，放开 FK 造（= prod 历史数据 / 缺 FK 库的形态），随后恢复。
      // 判据是**区分性**的：裸数 execution_logs 有 1 行，但本函数走 INNER JOIN agents
      // ⇒ false ⇒ /executor 回 404 ⇒ 钩子判「无归属」多投一条（既有的安全方向，不改）。
      db.pragma('foreign_keys = OFF')
      insertLog(db, {
        id: 'orphan',
        agent: 'agent-gone',
        status: 'running',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-x',
      })
      db.pragma('foreign_keys = ON')
      const raw = db
        .prepare('SELECT COUNT(*) AS c FROM execution_logs WHERE triggered_by_message_id = ?')
        .get(U) as { c: number }
      expect(raw.c).toBe(1)
      expect(repo.hasExecutorRowsForTrigger(U)).toBe(false)
      expect(repo.getExecutorNameByTriggeredBy(U)).toBeUndefined()
    })
  })

  describe('updateRunningExecutionCommitHash — 不得制造无法消歧的归属', () => {
    it('无 agentId + 跨 agent 的 running 行 → 拒写（旧实现 changes=2 且两行同 sha → 必红）', () => {
      seedCrossAgent(db)
      const r = repo.updateRunningExecutionCommitHash(U, SHA)
      expect(r.changes).toBe(0)
      expect(r.skippedAmbiguous).toBe(true)
      expect(hashOf(db, 'e1')).toBeNull()
      expect(hashOf(db, 'e2')).toBeNull()
    })

    it('无 agentId + 同 agent 多 running 行 → 照写（同一只猫重试，消歧成立）', () => {
      insertLog(db, {
        id: 'e1',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      insertLog(db, {
        id: 'e2',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:05',
        traceId: 'tr-2',
      })
      const r = repo.updateRunningExecutionCommitHash(U, SHA)
      expect(r).toEqual({ changes: 2, skippedAmbiguous: false })
      expect(hashOf(db, 'e1')).toBe(SHA)
      expect(hashOf(db, 'e2')).toBe(SHA)
    })

    it('带 agentId → 只命中自己的 running 行，跨 agent 也不拒（精确路径不受消歧影响）', () => {
      seedCrossAgent(db)
      const r = repo.updateRunningExecutionCommitHash(U, SHA, 'agent-ds')
      expect(r).toEqual({ changes: 1, skippedAmbiguous: false })
      expect(hashOf(db, 'e1')).toBeNull()
      expect(hashOf(db, 'e2')).toBe(SHA)
      expect(repo.getExecutorNameByCommitHash(SHA)?.name).toBe('ds猫')
    })

    it('无 agentId 但只有一只猫在跑 → 照写（单执行者轮次不误拒）', () => {
      insertLog(db, {
        id: 'e0',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 09:00:00',
        traceId: 'tr-0',
      })
      insertLog(db, {
        id: 'e1',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      const r = repo.updateRunningExecutionCommitHash(U, SHA)
      expect(r).toEqual({ changes: 1, skippedAmbiguous: false })
      expect(hashOf(db, 'e0')).toBeNull() // 只写 running
    })
  })

  describe('updateExecutionLogCommitHash — depth=0 自动提交快照', () => {
    it('跨 agent → 拒写（旧实现 changes=3 且全行同 sha → 必红）', () => {
      seedCrossAgent(db)
      const r = repo.updateExecutionLogCommitHash(U, SHA)
      expect(r.changes).toBe(0)
      expect(r.skippedAmbiguous).toBe(true)
      expect(hashOf(db, 'e0')).toBeNull()
      expect(hashOf(db, 'e1')).toBeNull()
      expect(hashOf(db, 'e2')).toBeNull()
    })

    it('单 agent → 照写，**已终态行一并覆盖**（round 快照语义；加 running 过滤会让本路径恒空操作）', () => {
      // 本用例固化「为何不给本函数加 status 过滤」：唯一调用点（serial.ts depth=0 收尾块）
      // 在所有 execute() 返回之后执行，届时行已由 finalizeExecutionLog 置终态
      // —— 加 running 过滤 ⇒ 恒 0 行 ⇒ 该路径被废掉，而不是被收窄。
      insertLog(db, {
        id: 'e0',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 09:00:00',
        traceId: 'tr-0',
      })
      insertLog(db, {
        id: 'e1',
        agent: 'agent-flash',
        status: 'running',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      const r = repo.updateExecutionLogCommitHash(U, SHA)
      expect(r).toEqual({ changes: 2, skippedAmbiguous: false })
      expect(hashOf(db, 'e0')).toBe(SHA)
      expect(hashOf(db, 'e1')).toBe(SHA)
    })

    it('拒写后反查仍可消歧（单 agent 轮次不受影响）', () => {
      insertLog(db, {
        id: 'e1',
        agent: 'agent-flash',
        status: 'completed',
        startedAt: '2026-09-10 10:00:00',
        traceId: 'tr-1',
      })
      repo.updateExecutionLogCommitHash(U, SHA)
      expect(repo.getExecutorNameByCommitHash(SHA)?.name).toBe('flash猫')
    })
  })
})

/**
 * P1-A：latency_ms 采集修复（`finalizeExecutionLog` 的 COALESCE）+ 链路取数。
 *
 * 修复前形态：`updateExecutionLogDiagnostics` 先写 latency_ms，`finalizeExecutionLog`
 * 再以 null 盖掉（opts 里没有 latencyMs）⇒ 全表 100% NULL。下列断言即钉死该回归。
 */
describe('execution_logs repo — P1-A 耗时保留与链路取数', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 't')").run()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-ds', 'ds猫', '🐯', 'p', 'claude', 'm', 'k')`
    ).run()
    // 触发消息（task_id = 链锚）
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 's1', 'agent', '派活', '[]', ?)`
    ).run(U, ANCHOR)
  })

  afterEach(() => {
    resetDb()
  })

  /** 起一个 running 行（started_at 取当前，保证落在 30 天窗口内）。
   *  **ISO 毫秒而非 `datetime('now')`**：窗口下界自 ⑤-b 起由 `isoDaysAgo()` 在 JS 侧
   *  算成 ISO 毫秒（`getExecutionHopsWithChainAnchor` 的 WHERE 绑定），夹具还写秒级串
   *  就是格式混比——同一天里 ISO 串首位 `T` 恒大于空格，窗口会静默放大。 */
  function startRun(id: string, agent = 'agent-ds'): void {
    db.prepare(
      `INSERT INTO execution_logs
         (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
       VALUES (?, 's1', ?, ?, 'running', 'tr', ?)`
    ).run(id, agent, U, new Date().toISOString())
  }

  function latencyOf(id: string): number | null {
    return (
      db.prepare('SELECT latency_ms FROM execution_logs WHERE id = ?').get(id) as {
        latency_ms: number | null
      }
    ).latency_ms
  }

  const DIAG = {
    packagesInstalled: '',
    promptChars: 10,
    replyChars: 20,
    promptTokens: 3,
    completionTokens: 4,
  }

  // 票 6 回归：定位键一度只有「agent_id + 最新 running」。秒级时间戳时代，同猫跨会话
  // 并行的两行必然同秒、平局按插入序恰好命中先起的那个（**偶然正确**）；⑤-a 切 ISO 毫秒
  // 后先后可辨 ⇒ `ORDER BY started_at DESC LIMIT 1` 必然选中**后起**的那次，A 的收口就
  // 写到了 B 的行上（B 变 failed、A 反被 B 的收口写成 completed——静默错挂）。
  describe('finalize / diagnostics 的定位键含 session（跨会话并行不错挂）', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, title) VALUES ('s2', 't2')").run()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions) VALUES (?, 's2', 'agent', '派活', '[]')`
      ).run(U2)
      // A（s1）先起、B（s2）后起——毫秒时间戳让 B 严格更晚
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES ('eA', 's1', 'agent-ds', ?, 'running', 'tr', '2026-09-01T10:00:00.000Z')`
      ).run(U)
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES ('eB', 's2', 'agent-ds', ?, 'running', 'tr', '2026-09-01T10:00:01.000Z')`
      ).run(U2)
    })

    it('finalize(A) 只改 A 的行——B 仍是 running，不被写串', () => {
      repo.finalizeExecutionLog('agent-ds', 's1', 'failed', null, 'interrupted', null, 'timeout')

      expect(
        db.prepare(`SELECT status, error_message FROM execution_logs WHERE id='eA'`).get()
      ).toEqual({ status: 'failed', error_message: 'interrupted' })
      expect(
        db.prepare(`SELECT status, error_message FROM execution_logs WHERE id='eB'`).get()
      ).toEqual({ status: 'running', error_message: null })
    })

    it('diagnostics(B) 只写 B 的行——A 的 latency 仍为 NULL', () => {
      repo.updateExecutionLogDiagnostics('agent-ds', 's2', { latencyMs: 4242, ...DIAG })

      expect(latencyOf('eB')).toBe(4242)
      expect(latencyOf('eA')).toBeNull()
    })

    // R8 §A：同一个「agent + 最新 running」洞的**读**侧（T-A ② 收尾兜底判据
    // `getRunningExecutionCommitHash`）。读侧误命中的危害与写侧不同源——写侧把 B 的**行**
    // 改坏，读侧把 B 的 **sha 当成 A 的产出**喂给 `judgeReviewFallback`，两种后果：
    // B 有 sha ⇒ 对别人的 commit 发起审查投递；B 无 sha（执行中途尚未提交）⇒ 读回
    // `undefined`、判词落「本执行无 commit」而**静默漏投** A 自己的 commit。
    it('getRunningExecutionCommitHash(A 会话) 取 A 的 sha——不被后起的 B 遮盖', () => {
      db.prepare("UPDATE execution_logs SET commit_hash='shaA' WHERE id='eA'").run()
      db.prepare("UPDATE execution_logs SET commit_hash='shaB' WHERE id='eB'").run()

      expect(repo.getRunningExecutionCommitHash('agent-ds', 's1')).toBe('shaA')
      expect(repo.getRunningExecutionCommitHash('agent-ds', 's2')).toBe('shaB')
    })

    it('B 行尚无 commit 时，A 会话仍取到自己的 sha（静默漏投面）', () => {
      db.prepare("UPDATE execution_logs SET commit_hash='shaA' WHERE id='eA'").run()

      expect(repo.getRunningExecutionCommitHash('agent-ds', 's1')).toBe('shaA')
    })
  })

  describe('finalizeExecutionLog 不擦除耗时', () => {
    // FK 补链后（票 6 批一）：`finalizeExecutionLog` 写回的 replyMessageId →
    // `execution_logs.message_id → messages.id` ⇒ 回复行须先落库（生产路径亦然：
    // 回复先入库、再 finalize 写回）。放在本内层 describe，避免与同层的
    // `getExecutionHopsWithChainAnchor` 用同一字面量 id 造夹具时撞 PK。
    beforeEach(() => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES ('m-reply', 's1', 'agent', 'x', '[]')`
      ).run()
    })

    it('先写 diagnostics、后 finalize(null) ⇒ 保留 1234（修复前被盖成 NULL）', () => {
      startRun('e1')
      repo.updateExecutionLogDiagnostics('agent-ds', 's1', { latencyMs: 1234, ...DIAG })
      expect(latencyOf('e1')).toBe(1234)
      repo.finalizeExecutionLog('agent-ds', 's1', 'completed', null, null, 'm-reply', null)
      expect(latencyOf('e1')).toBe(1234)
    })

    it('反向用例：没写过 diagnostic 的行 finalize 后仍 NULL——不得变成 0', () => {
      startRun('e2')
      repo.finalizeExecutionLog('agent-ds', 's1', 'failed', null, 'boom', null, 'timeout')
      // 0 是「瞬间完成」，与「无数据」是两回事——失败跳就该是 NULL
      expect(latencyOf('e2')).toBeNull()
    })

    it('显式传入 latencyMs ⇒ 照写（COALESCE 不吞真值）', () => {
      startRun('e3')
      repo.finalizeExecutionLog('agent-ds', 's1', 'completed', 777, null, 'm-reply', null)
      expect(latencyOf('e3')).toBe(777)
    })

    it('diagnostics 写的值跨多次 finalize 调用仍在（幂等，不被后续调用擦）', () => {
      startRun('e4')
      repo.updateExecutionLogDiagnostics('agent-ds', 's1', { latencyMs: 555, ...DIAG })
      repo.finalizeExecutionLog('agent-ds', 's1', 'completed', null, null, 'm-reply', null)
      // 第二次调用命不中（行已 completed，WHERE status='running'）——但值必须还在
      repo.finalizeExecutionLog('agent-ds', 's1', 'completed', null, null, 'm-reply', null)
      expect(latencyOf('e4')).toBe(555)
    })
  })

  describe('getExecutionHopsWithChainAnchor', () => {
    /** 插一条 messages 行并返回 id（role=agent，task_id 可 null） */
    function msg(id: string, taskId: string | null): string {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, 's1', 'agent', 'x', '[]', ?)`
      ).run(id, taskId)
      return id
    }

    it('触发侧 task_id 即链锚', () => {
      startRun('e1')
      const rows = repo.getExecutionHopsWithChainAnchor(30)
      expect(rows).toHaveLength(1)
      expect(rows[0].chain_id).toBe(ANCHOR)
      expect(rows[0].agent_name).toBe('ds猫')
    })

    it('回复侧 task_id 优先于触发侧（coalesce 左项赢）', () => {
      const reply = msg('m-reply', 'bbbb2222-0000-4000-8000-0000000000bb')
      startRun('e2')
      db.prepare('UPDATE execution_logs SET message_id = ? WHERE id = ?').run(reply, 'e2')
      expect(repo.getExecutionHopsWithChainAnchor(30)[0].chain_id).toBe(
        'bbbb2222-0000-4000-8000-0000000000bb'
      )
    })

    it('回复侧 task_id 为 NULL ⇒ 回落到触发侧，不丢锚', () => {
      const reply = msg('m-reply', null)
      startRun('e3')
      db.prepare('UPDATE execution_logs SET message_id = ? WHERE id = ?').run(reply, 'e3')
      expect(repo.getExecutionHopsWithChainAnchor(30)[0].chain_id).toBe(ANCHOR)
    })

    it('两侧都无 task_id ⇒ chain_id NULL（孤儿跳，仍返回不筛掉）', () => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES ('m-orphan', 's1', 'agent', 'x', '[]', NULL)`
      ).run()
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES ('e4', 's1', 'agent-ds', 'm-orphan', 'running', 'tr', ?)`
      ).run(new Date().toISOString())
      const rows = repo.getExecutionHopsWithChainAnchor(30)
      expect(rows).toHaveLength(1)
      expect(rows[0].chain_id).toBeNull()
    })

    it('message_id 为 NULL 的失败跳仍返回（LEFT JOIN 不吞行）', () => {
      startRun('e5')
      db.prepare(
        "UPDATE execution_logs SET status = 'failed', message_id = NULL WHERE id = 'e5'"
      ).run()
      const rows = repo.getExecutionHopsWithChainAnchor(30)
      expect(rows).toHaveLength(1)
      expect(rows[0].message_id).toBeNull()
      expect(rows[0].status).toBe('failed')
    })

    it('窗口外（started_at 超窗）的行不返回', () => {
      // 超窗行同样写 ISO 毫秒——与窗口下界（JS 侧 `isoDaysAgo()`）同形才有判别力：
      // 混比时「超窗」可能只是格式差异造成的假超窗
      db.prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES ('old', 's1', 'agent-ds', ?, 'completed', 'tr', ?)`
      ).run(U, new Date(Date.now() - 90 * 86400_000).toISOString())
      expect(repo.getExecutionHopsWithChainAnchor(30)).toHaveLength(0)
      expect(repo.getExecutionHopsWithChainAnchor(365)).toHaveLength(1)
    })

    it('取到的 latency_ms / reply_chars 原样带出（供纯函数算段）', () => {
      startRun('e6')
      repo.updateExecutionLogDiagnostics('agent-ds', 's1', { latencyMs: 4242, ...DIAG })
      const r = repo.getExecutionHopsWithChainAnchor(30)[0]
      expect(r.latency_ms).toBe(4242)
      expect(r.reply_chars).toBe(20)
      expect(r.triggered_by_message_id).toBe(U)
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// T-2 Phase I 取数点：本调度树内**实际执行过**的 agent 集合
// ══════════════════════════════════════════════════════════════════
describe('execution_logs repo — 按 trace 取「本调度树执行过的 agent」', () => {
  it('同 trace 的 A2A 子链一并覆盖；不同 trace 不串（去重 + 排序）', () => {
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    // FK：execution_logs.session_id → sessions.id、agent_id → agents.id，先备齐
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 't')").run()
    for (const a of ['cat-a', 'cat-b', 'cat-c', 'cat-z']) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES (?, ?, '🐱', 'p', 'claude', 'm', 'k')`
      ).run(a, a)
    }
    // FK 补链后（票 6 批一）：`triggered_by_message_id` → messages.id ⇒ 触发消息先落库
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 's1', 'agent', '派活', '[]', ?)`
    ).run(U, ANCHOR)
    // 顶层一批两只猫 + A2A 子链一只（同一 traceId——子链**继承**父 trace）
    insertLog(db, { id: 'x1', agent: 'cat-a', status: 'completed', startedAt: 't1', traceId: 'TR' })
    insertLog(db, { id: 'x2', agent: 'cat-b', status: 'completed', startedAt: 't2', traceId: 'TR' })
    insertLog(db, { id: 'x3', agent: 'cat-c', status: 'completed', startedAt: 't3', traceId: 'TR' })
    // 同 agent 多行（重试）⇒ 去重
    insertLog(db, { id: 'x4', agent: 'cat-a', status: 'failed', startedAt: 't4', traceId: 'TR' })
    // 另一条 trace 的猫不得混入
    insertLog(db, {
      id: 'x5',
      agent: 'cat-z',
      status: 'completed',
      startedAt: 't5',
      traceId: 'OTHER',
    })

    expect(repo.listExecutorAgentIdsByTrace('TR')).toEqual(['cat-a', 'cat-b', 'cat-c'])
    expect(repo.listExecutorAgentIdsByTrace('OTHER')).toEqual(['cat-z'])
  })

  it('空集与空 traceId ⇒ []（合法状态，不抛错）', () => {
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    expect(repo.listExecutorAgentIdsByTrace('nobody')).toEqual([])
    expect(repo.listExecutorAgentIdsByTrace('')).toEqual([])
  })
})

/**
 * R4 §A：会话内**每只有执行的猫的最后一次执行**——右侧面板展开某猫 trace 前的取数口。
 *
 * 路由面（HTTP 契约五格）在 `routes/eval.test.ts`；本段只钉 **SQL 语义**，
 * 即路由面看不见或看起来恒真的那几条：分区聚合、同秒平局确定性、跨会话隔离、
 * 返回序。同秒平局那条尤其要在这里钉——它是**唯一**能在两次调用间抖出不同答案的
 * 面，路由层断言一次结果看不出来。
 */
describe('execution_logs repo — 会话内每猫最近一次执行（R4 §A）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    // execution_logs 的两条 FK（→ sessions / → agents）在测试库里**是真的**，先备父行
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 't')").run()
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s2', 't')").run()
    for (const id of ['cat-a', 'cat-b']) {
      db.prepare(
        `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES (?, ?, 'p', 'k')`
      ).run(id, `名-${id}`)
    }
    // FK 补链后（票 6 批一）：本段 `put()` 用字面量 'U' 当触发消息 id ⇒ 那行必须真的在
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('U', 's1', 'agent', 'x', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
  })

  /** 落一条执行行。`endedAt` 省略 ⇒ 已完成；显式 null ⇒ 在飞。
   *  `latencyMs` 缺省 null（诊断数据收口时才写，与真实一致）。 */
  function put(
    id: string,
    over: {
      agent?: string
      session?: string
      status?: string
      startedAt?: string
      endedAt?: string | null
      latencyMs?: number | null
    } = {}
  ): void {
    db.prepare(
      `INSERT INTO execution_logs
         (id, session_id, agent_id, triggered_by_message_id, status, trace_id,
          started_at, ended_at, latency_ms)
       VALUES (?, ?, ?, 'U', ?, 'tr', ?, ?, ?)`
    ).run(
      id,
      over.session ?? 's1',
      over.agent ?? 'cat-a',
      over.status ?? 'completed',
      over.startedAt ?? '2026-09-15 10:00:00',
      over.endedAt === undefined ? '2026-09-15 10:00:01' : over.endedAt,
      over.latencyMs ?? null
    )
  }

  it('每猫一条：同猫多行只留 started_at 最大者，且结果按 started_at 倒序（最近在前）', () => {
    put('a-old', { agent: 'cat-a', startedAt: '2026-09-15 08:00:00' })
    put('a-new', { agent: 'cat-a', startedAt: '2026-09-15 09:00:00' })
    put('b-old', { agent: 'cat-b', startedAt: '2026-09-15 07:00:00' })

    const rows = repo.getLatestExecutionPerAgent('s1')
    expect(rows.map((r) => r.id)).toEqual(['a-new', 'b-old'])
    expect(rows[0].agent_id).toBe('cat-a')
  })

  it('同 started_at 平局：仍只出一条，且**两次调用给同一条**（判据稳定，不随查询计划抖）', () => {
    put('tie-1', { agent: 'cat-a', startedAt: '2026-09-15 10:00:00' })
    put('tie-2', { agent: 'cat-a', startedAt: '2026-09-15 10:00:00' })

    const first = repo.getLatestExecutionPerAgent('s1')
    const second = repo.getLatestExecutionPerAgent('s1')
    expect(first).toHaveLength(1) // 平局不得把两条都放出来
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id))
  })

  it('跨会话隔离 + 空集：别的会话的执行不混入；无执行的会话 ⇒ []（合法状态，不抛错）', () => {
    put('a-s1', { agent: 'cat-a', session: 's1' })
    put('b-s2', { agent: 'cat-b', session: 's2' })

    expect(repo.getLatestExecutionPerAgent('s1').map((r) => r.id)).toEqual(['a-s1'])
    expect(repo.getLatestExecutionPerAgent('s2').map((r) => r.id)).toEqual(['b-s2'])
    expect(repo.getLatestExecutionPerAgent('no-such-session')).toEqual([])
  })

  it('在飞（ended_at / latency_ms 皆 NULL）照样是该猫的最新，且 null 原样出（不回落成 0）', () => {
    put('done', { agent: 'cat-a', startedAt: '2026-09-15 09:00:00', latencyMs: 60000 })
    put('inflight', {
      agent: 'cat-a',
      status: 'running',
      startedAt: '2026-09-15 10:00:00',
      endedAt: null,
    })

    const rows = repo.getLatestExecutionPerAgent('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('inflight')
    expect(rows[0].status).toBe('running')
    expect(rows[0].ended_at).toBeNull()
    expect(rows[0].latency_ms).toBeNull() // 不是 0
  })
})

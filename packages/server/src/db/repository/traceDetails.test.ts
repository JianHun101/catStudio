/**
 * `context_decisions` + `prompt_snapshots` 两表写口 / 读口测试（T2）。
 *
 * 测试面 = **真实迁移路径**（与 `retrievalEvents.test.ts` 同款范式）：`createTestDb()`
 * 造无此二表的老库 → `initDb()` 跑生产同一条 additive 迁移建表。不手搓 DDL。
 *
 * 覆盖票 `docs/run/ui-redesign/T2-trace-page.md` 中**写口侧可独立判定**的判据：
 * additive 建表 / 两表同事务 / 幂等（同名节先删后插）/ 读口投影 / 存量行判据 /
 * CASCADE（父执行行删则子行随删，不阻塞父删除）。
 *
 * 不在此测的：决策的**四级漏斗口径**（判据面在 `reply.ts` 的 `buildContextDecisions`
 * ——在 `execution/reply.test.ts` 里测；在本文件测它只能测到「写口原样存了给它的值」，
 * 是恒真的假绿门）、快照内容与真注入串的一致性（判据面在 `reply.ts` 的调用点）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../index.js'
import { initRepository, traceDetails as repo } from './index.js'
import type { TraceDetailsInput } from './traceDetails.js'

/** 造一条 execution_logs 行（本表两处 FK 的父行，CASCADE 用例也靠它） */
function seedExecution(id: string, sessionId = 'sess-1', agentId = 'agent-1'): void {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, system_prompt, llm_api_key)
     VALUES (?, 'ds猫', 'p', 'k')`
  ).run(agentId)
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title) VALUES (?, 't')`).run(sessionId)
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, session_id, role, content, task_id)
     VALUES ('trig-1', ?, 'user', 'x', 'anchor-1')`
  ).run(sessionId)
  db.prepare(
    `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id)
     VALUES (?, ?, ?, 'trig-1', 'running', 'trace-1')`
  ).run(id, sessionId, agentId)
}

function makeInput(over: Partial<TraceDetailsInput> = {}): TraceDetailsInput {
  return {
    executionId: 'exec-1',
    sessionId: 'sess-1',
    decisions: [
      { messageId: 'trig-1', ordinal: 0, stage: 'truncate', decision: 'kept', detail: null },
      { messageId: 'gone-1', ordinal: 1, stage: 'assemble', decision: 'invisible', detail: null },
    ],
    sections: [
      {
        sectionKey: 'system_prompt',
        label: '系统提示（本猫人格）',
        status: 'injected',
        content: '你是 ds猫。',
        ordinal: 0,
      },
      {
        sectionKey: 'memory',
        label: '相关记忆',
        status: 'empty',
        content: '',
        ordinal: 6,
      },
    ],
    ...over,
  }
}

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('traceDetails 两表写口 / 读口', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  describe('验收 · additive 建表', () => {
    it('两表在真实迁移产物里，且老库重跑 initDb 既有表行数一行不变', () => {
      seedExecution('exec-1')
      const before = countRows('execution_logs')
      initDb() // 老库重跑：台账路径零执行
      const names = (
        getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
      expect(names).toContain('context_decisions')
      expect(names).toContain('prompt_snapshots')
      expect(countRows('execution_logs')).toBe(before)
    })
  })

  describe('验收 · 两表同事务落盘', () => {
    it('正常输入：决策逐条落行、节逐条落行，字符数为 content.length', () => {
      seedExecution('exec-1')
      expect(repo.insertTraceDetails(makeInput())).toBe(true)

      const decisions = repo.getContextDecisions('exec-1')
      expect(decisions).toHaveLength(2)
      expect(decisions[0]).toMatchObject({
        ordinal: 0,
        message_id: 'trig-1',
        stage: 'truncate',
        decision: 'kept',
        detail: null,
      })
      // 左连 messages 取到正文摘要（详情页「哪条被丢了」靠它认出是哪条）
      expect(decisions[0].content_head).toBe('x')

      const metas = repo.getPromptSectionMetas('exec-1')
      expect(metas).toHaveLength(2)
      expect(metas[0]).toMatchObject({
        section_key: 'system_prompt',
        status: 'injected',
        char_count: '你是 ds猫。'.length,
        ordinal: 0,
      })
      // `empty` 是**合法的节状态**（本轮该节没内容），不是「没写」
      expect(metas[1]).toMatchObject({ section_key: 'memory', status: 'empty', char_count: 0 })
      expect(repo.getPromptSection('exec-1', 'memory')).toBe('')
    })

    it('事务原子性：节插入撞唯一约束时，决策行**一并回滚**（不留半截行）', () => {
      seedExecution('exec-1')
      // 同一输入里两节同 key：第二节撞主键 (execution_id, section_key) ⇒ 整事务回滚
      const bad = makeInput({
        sections: [
          { sectionKey: 'dup', label: 'a', status: 'injected', content: 'A', ordinal: 0 },
          { sectionKey: 'dup', label: 'b', status: 'injected', content: 'B', ordinal: 1 },
        ],
      })
      expect(repo.insertTraceDetails(bad)).toBe(false)
      // 写口内部吞错（关键路径不抛），但两表都必须零行——这正是「同事务」的判据
      expect(countRows('context_decisions')).toBe(0)
      expect(countRows('prompt_snapshots')).toBe(0)
    })

    it('幂等：同 execution_id 重跑，节按 key 覆盖（不留两行「系统提示」）', () => {
      seedExecution('exec-1')
      repo.insertTraceDetails(makeInput())
      repo.insertTraceDetails(
        makeInput({
          sections: [
            {
              sectionKey: 'system_prompt',
              label: '系统提示（本猫人格）',
              status: 'injected',
              content: '改过的串',
              ordinal: 0,
            },
          ],
        })
      )
      const metas = repo.getPromptSectionMetas('exec-1')
      expect(metas).toHaveLength(1)
      expect(repo.getPromptSection('exec-1', 'system_prompt')).toBe('改过的串')
    })
  })

  describe('验收 · 读口', () => {
    it('节清单**不带正文**（懒加载契约），正文只在 getPromptSection 出', () => {
      seedExecution('exec-1')
      repo.insertTraceDetails(makeInput())
      const metas = repo.getPromptSectionMetas('exec-1')
      // 判据是**键集**，不是「响应里 grep 不到某词」——后者在本仓栽过（响应全文
      // grep 绿是因为语料恰巧不含该词，判据本意是字段）。故逐键比对。
      expect(Object.keys(metas[0]).sort()).toEqual(
        ['char_count', 'label', 'ordinal', 'section_key', 'status'].sort()
      )
    })

    it('`hasTraceDetails` 按「两表有没有行」判，存量行为 false', () => {
      seedExecution('exec-1')
      expect(repo.hasTraceDetails('exec-1')).toBe(false) // 存量行：本票之前的执行
      // 退化输入（两表都空）⇒ 仍 false：判据是「有行」不是「写过一次」。
      // 生产路径上 `decisions` 恒非空（至少含触发消息那一行），此例只钉住判据口径
      // ——前端据它显示「无段数据（存量行）」占位，两表都空时那确实就是该显示的东西。
      repo.insertTraceDetails(makeInput({ decisions: [], sections: [] }))
      expect(repo.hasTraceDetails('exec-1')).toBe(false)
      repo.insertTraceDetails(makeInput())
      expect(repo.hasTraceDetails('exec-1')).toBe(true)
    })

    it('不存在的 key → getPromptSection 返回 null（与合法的空串分开）', () => {
      seedExecution('exec-1')
      repo.insertTraceDetails(makeInput())
      expect(repo.getPromptSection('exec-1', 'nope')).toBeNull()
    })

    it('决策与节都按 ordinal 升序出，且按 execution_id 隔离', () => {
      seedExecution('exec-1')
      seedExecution('exec-2')
      repo.insertTraceDetails(makeInput())
      repo.insertTraceDetails(
        makeInput({
          executionId: 'exec-2',
          decisions: [
            { messageId: 'trig-1', ordinal: 5, stage: 'assemble', decision: 'kept', detail: null },
          ],
          sections: [],
        })
      )
      expect(repo.getContextDecisions('exec-1')).toHaveLength(2)
      expect(repo.getContextDecisions('exec-2')).toHaveLength(1)
      expect(repo.getContextDecisions('exec-2')[0].ordinal).toBe(5)
    })
  })

  describe('验收 · CASCADE（父执行行删则子行随删，不阻塞父删除）', () => {
    it('删 execution_logs 行：两表子行随删，且删除语句本身不报错', () => {
      seedExecution('exec-1')
      repo.insertTraceDetails(makeInput())
      expect(countRows('context_decisions')).toBe(2)

      // 关键判据：不是「能删」而是「删得掉」——若 FK 写成 RESTRICT，这里会抛
      // FOREIGN KEY constraint failed（回退删消息 → purge 删 execution_logs 就是这条路）
      expect(() =>
        getDb().prepare(`DELETE FROM execution_logs WHERE id = 'exec-1'`).run()
      ).not.toThrow()
      expect(countRows('context_decisions')).toBe(0)
      expect(countRows('prompt_snapshots')).toBe(0)
    })
  })

  describe('验收 · 失败不致命（关键路径硬约束）', () => {
    it('执行行不存在时插子行 → 返回 false 且不抛', () => {
      // 无 seedExecution ⇒ FK 父行缺失
      expect(() => repo.insertTraceDetails(makeInput({ executionId: 'nope' }))).not.toThrow()
      expect(repo.insertTraceDetails(makeInput({ executionId: 'nope' }))).toBe(false)
    })
  })
})

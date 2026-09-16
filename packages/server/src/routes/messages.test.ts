import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { RESTART_REQUEST_FILE, removeRestartRequest } from '../restart-request.js'
import type { FastifyInstance } from 'fastify'

// 执行注册表 mock（第 4 刀断环后 messages.ts → ingest 经 registry 寻址广播/执行）：
// bus/engine 未注册 → ingest 的广播/执行守卫跳过（旧 getIO→null 同语义）；
// rowToAgent 走真实 execution/row.js（本文件会话 fixture agent_ids='[]'，无行可映射）
vi.mock('../execution/registry.js', () => ({
  getExecutionBus: vi.fn(() => null),
  getExecutionEngine: vi.fn(() => null),
}))

// 重启请求文件隔离：本文件与 socketio.test.ts 都写/读/删 .restart-request（vitest 全局
// env 指向共享目录 `restart-test`）——全量并行时两文件用例交错互删
// 同一文件是 6846bb4 文档化的竞态配对（existsSync 通过后文件可能已被对方 afterEach 删掉）。
// 隔离机制：vi.mock factory 在 restart-request.js 首次导入（messages.js 链）前改写
// RESTART_FILES_DIR 指向独立目录——importOriginal 返回真实模块（零 mock 语义），只是
// 求值环境不同；生产链路（messages.ts → ingest.ts → restart-request.js 静态导入链）
// 与断言拿到同一隔离实例。与 restart-request.test.ts（vi.resetModules + vi.stubEnv）
// 的差异：那里被测模块即生产模块本身，重导入即隔离；这里静态导入链在 messages.ts
// 顶层，resetModules 需整链重导入 + 重建 app + 处理跨 describe 注册表泄漏——factory
// 方案隔离效果等价且零结构改动。vitest 默认 per-file worker 隔离，env 改写不跨文件泄漏。
// 目录取 test-helpers.isolatedTestDir 的**绝对**路径：vi.mock factory 被提升到 import 之前，
// 顶层 import 的绑定此刻未初始化 ⇒ 只能在 factory 内动态 import（见下）。
vi.mock('../restart-request.js', async (importOriginal) => {
  const { isolatedTestDir } = await import('../test-helpers.js')
  process.env.RESTART_FILES_DIR = isolatedTestDir('restart-test-messages')
  return await importOriginal<typeof import('../restart-request.js')>()
})

describe('Message Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    const { messageRoutes } = await import('./messages.js')
    await app.register(messageRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  describe('GET /api/messages/:id（handoff uuid 反查）', () => {
    it('returns sessionId for an existing message', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-debug-1', 'debug')
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run('6cfecca8-ba78-4039-a12c-71313afd29cd', 'session-debug-1')

      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.id).toBe('6cfecca8-ba78-4039-a12c-71313afd29cd')
      expect(body.sessionId).toBe('session-debug-1')
      expect(body.role).toBe('user')
    })

    it('returns 404 for unknown message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/nonexistent-id',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body.error).toBeDefined()
    })
  })

  describe('GET /api/messages/:id/executor（实施者反查，handoff-gen 动态补填人）', () => {
    // T-I：链锚在**消息行**上，与执行行的 trace_id 是**两个值**——本组 fixture 刻意
    // 让两者不同（ANCHOR ≠ TRACE），把"回传的是哪一个"变成可判定的断言。
    const UUID = '6cfecca8-ba78-4039-a12c-71313afd29cd'
    const ANCHOR = 'anchor-msg-1' // 该消息的 messages.task_id（链锚）
    const TRACE = 'trace-exec-1' // 该轮执行 execution_logs.trace_id（当轮追踪，≠ 锚）

    const insertFixture = (triggeredBy: string) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-exec-1', 'debug')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-ds', 'ds猫')
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, 'session-exec-1', 'user', '派活', '[]', ?)`
      ).run(triggeredBy, ANCHOR)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'), ?)`
      ).run('log-1', 'session-exec-1', 'agent-ds', triggeredBy, TRACE)
    }

    it('returns executor agentName for a message with execution log', async () => {
      insertFixture(UUID)
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${UUID}/executor`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentId).toBe('agent-ds')
      expect(body.agentName).toBe('ds猫')
      // T-I：taskId = **该消息的链锚**（messages.task_id），不是执行行的当轮 trace_id
      expect(body.taskId).toBe(ANCHOR)
      expect(body.taskId).not.toBe(TRACE) // 阴性对照：旧实现回传的正是 TRACE
    })

    it('returns 404 when no execution log exists for the message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(404)
    })

    it('多执行者且消歧不了 → 200 + ambiguous:true（T-M：不再"取最近执行"猜一只）', async () => {
      const db = getDb()
      insertFixture(UUID)
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-reviewer', '吐槽猫')
      // 后开始的一行——旧实现正是靠 started_at 挑中它（"取最近执行"）
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'failed', datetime('now', '+1 minute'))`
      ).run('log-2', 'session-exec-1', 'agent-reviewer', UUID)
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${UUID}/executor`,
      })
      // 为什么不是 404：404 在调用方 probeAttribution 语义里是"该 uuid 无执行行 ⇒ 无归属
      // ⇒ 钩子兜底投递"——把"指不出人"报成 404 会让有归属的 agent 提交被多投一轮。
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        agentId: null,
        agentName: null,
        taskId: null,
        matchedBy: null,
        ambiguous: true,
      })
    })

    it('同一 agent 的多行执行（重试）不算歧义 → 仍指认该实施者', async () => {
      const db = getDb()
      insertFixture(UUID)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES ('log-retry', 'session-exec-1', 'agent-ds', ?, 'failed', datetime('now', '+1 minute'), 'trace-retry')`
      ).run(UUID)
      const res = await app.inject({ method: 'GET', url: `/api/messages/${UUID}/executor` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentName).toBe('ds猫')
      expect(body.ambiguous).toBe(false)
      expect(body.matchedBy).toBe('trigger')
    })

    it('?commit= 按 commit_hash 精确命中各自实施者（同 uuid 双执行者各 commit 各命中各）', async () => {
      const uuid = UUID
      const hashA = 'a'.repeat(40)
      const hashB = 'b'.repeat(40)
      const db = getDb()
      insertFixture(uuid) // agent-ds + log-1（completed，无 commit_hash）
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-flash', 'flash猫')
      // ds猫 的提交 + flash猫 的提交（同 uuid 双执行者各写各的 hash）
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, commit_hash, trace_id)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'), ?, ?)`
      ).run('log-ds', 'session-exec-1', 'agent-ds', uuid, hashA, 'trace-ds')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, commit_hash, trace_id)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'), ?, ?)`
      ).run('log-flash', 'session-exec-1', 'agent-flash', uuid, hashB, 'trace-flash')

      const resA = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashA}`,
      })
      expect(resA.statusCode).toBe(200)
      expect(JSON.parse(resA.body).agentName).toBe('ds猫')
      // T-I：taskId = 链锚（同一条链上两个 commit 回传**同一个锚**），不是各行的 trace_id
      expect(JSON.parse(resA.body).taskId).toBe(ANCHOR)
      expect(JSON.parse(resA.body).taskId).not.toBe('trace-ds')
      // T-M：hash 真命中才叫精确匹配
      expect(JSON.parse(resA.body).matchedBy).toBe('commit')

      const resB = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashB}`,
      })
      expect(resB.statusCode).toBe(200)
      expect(JSON.parse(resB.body).agentName).toBe('flash猫')
      expect(JSON.parse(resB.body).taskId).toBe(ANCHOR)
      expect(JSON.parse(resB.body).taskId).not.toBe('trace-flash')
      expect(JSON.parse(resB.body).matchedBy).toBe('commit')
    })

    it('同一 sha 落在跨 agent 的多行上 → ambiguous（T-M；旧实现返回 started_at 靠后者）', async () => {
      const uuid = UUID
      const sha = 'd'.repeat(40)
      const db = getDb()
      insertFixture(uuid) // log-1：agent-ds
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-flash', 'flash猫')
      // 无 agentId 全刷 / 自动提交快照的产物形态：一个 sha 盖在两只猫的行上
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES ('log-flash-2', 'session-exec-1', 'agent-flash', ?, 'completed', datetime('now', '+1 minute'), 'trace-flash')`
      ).run(uuid)
      db.prepare('UPDATE execution_logs SET commit_hash = ? WHERE triggered_by_message_id = ?').run(
        sha,
        uuid
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${sha}`,
      })
      // 按 hash 指不出唯一作者 ⇒ 回退 uuid 分支同样指不出 ⇒ ambiguous（不是挑一只）
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        agentId: null,
        agentName: null,
        taskId: null,
        matchedBy: null,
        ambiguous: true,
      })
    })

    it('?commit= 查不到（老 commit 未写回 hash）时回退 uuid 逻辑', async () => {
      const uuid = UUID
      insertFixture(uuid) // log-1：无 commit_hash
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${'c'.repeat(40)}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentId).toBe('agent-ds')
      expect(body.agentName).toBe('ds猫')
      // 回退路径同样回传链锚（锚源与反查路径无关——两条路径都从触发消息行取）
      expect(body.taskId).toBe(ANCHOR)
      // T-M：回退必须自报家门——调用方据此措辞，不再把回退说成"commit_hash 精确匹配"
      expect(body.matchedBy).toBe('trigger')
      expect(body.ambiguous).toBe(false)
    })

    it('消息行缺失（存量 fixture）→ 仍 200，taskId 归 null（加 JOIN 不改失败语义，T-I 验收②）', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-orphan', 'debug', '[]', datetime('now'), datetime('now'))`
      ).run()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES ('agent-orphan', '孤猫', '🐈', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run()
      // 执行行在，但它指向的消息**不在** messages 表（LEFT JOIN 的边界）
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES ('log-orphan', 'session-orphan', 'agent-orphan', 'no-such-message', 'completed', datetime('now'), 'trace-orphan')`
      ).run()
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/no-such-message/executor',
      })
      expect(res.statusCode).toBe(200) // 有执行行 ⇒ 不是 404（404 判据仍是"有无执行行"）
      expect(JSON.parse(res.body)).toEqual({
        agentId: 'agent-orphan',
        agentName: '孤猫',
        taskId: null,
        matchedBy: 'trigger',
        ambiguous: false,
      })
    })

    it('端到端两跳（T-I 验收③）：显式锚投递 → commit 写回 → /executor 回传锚 → 下一跳锚不换', async () => {
      const HOP1 = '2b9d6d4c-0000-4000-8000-000000000a01'
      const CHAIN_ANCHOR = 'anchor-chain-1'
      const ROUND_TRACE = 'trace-round-1'
      const sha = 'f'.repeat(40)
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-two-hop', 'debug', '[]', datetime('now'), datetime('now'))`
      ).run()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
         VALUES ('agent-hop', '接棒猫', '🐈', 'prompt', 'claude', 'model', 'key', '', 'high', '[]', 'implementer')`
      ).run()
      // 第 1 跳：显式锚投递（messages.task_id = CHAIN_ANCHOR），该轮执行另有一个 trace_id
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, 'session-two-hop', 'user', '派活', '[]', ?)`
      ).run(HOP1, CHAIN_ANCHOR)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES ('log-hop', 'session-two-hop', 'agent-hop', ?, 'running', datetime('now'), ?)`
      ).run(HOP1, ROUND_TRACE)

      // 产出 commit → 写回执行行
      const wrote = await app.inject({
        method: 'POST',
        url: `/api/messages/${HOP1}/commit-hash`,
        payload: { commitHash: sha },
      })
      expect(JSON.parse(wrote.body)).toEqual({
        ok: true,
        updated: 1,
        skippedAmbiguous: false,
      })

      // 第 2 跳的锚 = /executor 回传值（handoff-gen 就是这么用的）
      const exec = await app.inject({
        method: 'GET',
        url: `/api/messages/${HOP1}/executor?commit=${sha}`,
      })
      const nextAnchor = JSON.parse(exec.body).taskId as string
      expect(nextAnchor).toBe(CHAIN_ANCHOR)
      expect(nextAnchor).not.toBe(ROUND_TRACE) // 阴性对照：旧实现回传 ROUND_TRACE

      // 拿它当锚投下一跳 → 落库锚仍等于第 1 跳的锚（链内锚不变，spec 头号目标）
      const hop2 = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: {
          sessionId: 'session-two-hop',
          content: '下一跳投递',
          mentions: ['接棒猫'],
          taskId: nextAnchor,
        },
      })
      expect(hop2.statusCode).toBe(201)
      const row = db
        .prepare(`SELECT task_id FROM messages WHERE id = ?`)
        .get(JSON.parse(hop2.body).messageId) as { task_id: string }
      expect(row.task_id).toBe(CHAIN_ANCHOR)
    })
  })

  describe('POST /api/messages/:id/commit-hash（post-commit 写回实施者 hash）', () => {
    it('只写 running 记录——completed 的执行不动（同 uuid 双执行者各 commit 各命中各）', async () => {
      const uuid = '6cfecca8-ba78-4039-a12c-71313afd29cd'
      const hash = 'd'.repeat(40)
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-exec-1', 'debug')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-ds', 'ds猫')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-flash', 'flash猫')
      // ds猫 已 finalize（completed），flash猫 仍 running——提交者是 flash猫
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'))`
      ).run('log-done', 'session-exec-1', 'agent-ds', uuid)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'running', datetime('now'))`
      ).run('log-running', 'session-exec-1', 'agent-flash', uuid)

      const res = await app.inject({
        method: 'POST',
        url: `/api/messages/${uuid}/commit-hash`,
        payload: { commitHash: hash },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        updated: 1,
        skippedAmbiguous: false,
      })

      const rowRunning = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-running') as { commit_hash: string | null }
      expect(rowRunning.commit_hash).toBe(hash)
      const rowDone = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-done') as { commit_hash: string | null }
      expect(rowDone.commit_hash).toBeNull()
    })

    it('带 agentId 精确命中自己的 running 行——双 running 各 commit 各刷各，无覆盖无错投（eae5a5e 实害化 → 0fe8292 根治）', async () => {
      const uuid = '553bbc08-3819-4d75-9499-f23c6eb1282f'
      const DUAL_ANCHOR = 'anchor-dual-exec'
      const hashA = 'a'.repeat(40)
      const hashB = 'b'.repeat(40)
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-exec-2', 'debug')
      // T-I：链锚落在消息行上（两条执行行共用同一条触发消息 ⇒ 同一个锚）
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, 'session-exec-2', 'user', '派双单', '[]', ?)`
      ).run(uuid, DUAL_ANCHOR)
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-ds', 'ds猫')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-flash', 'flash猫')
      // 同 uuid 双 running（双猫同时执行——店长一条消息派两单的常态，eae5a5e 错投场景）
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'running', datetime('now'))`
      ).run('log-ds', 'session-exec-2', 'agent-ds', uuid)
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'running', datetime('now'))`
      ).run('log-flash', 'session-exec-2', 'agent-flash', uuid)

      // 各自带 agentId 写回各自 commit——agentId 过滤命中自己的行
      const resA = await app.inject({
        method: 'POST',
        url: `/api/messages/${uuid}/commit-hash`,
        payload: { commitHash: hashA, agentId: 'agent-ds' },
      })
      expect(resA.statusCode).toBe(200)
      expect(JSON.parse(resA.body)).toEqual({
        ok: true,
        updated: 1,
        skippedAmbiguous: false,
      })
      // 中间态：ds猫 写回后 flash猫 的行未被触碰（无覆盖）
      const rowFlashMid = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-flash') as { commit_hash: string | null }
      expect(rowFlashMid.commit_hash).toBeNull()
      const resB = await app.inject({
        method: 'POST',
        url: `/api/messages/${uuid}/commit-hash`,
        payload: { commitHash: hashB, agentId: 'agent-flash' },
      })
      expect(resB.statusCode).toBe(200)
      expect(JSON.parse(resB.body)).toEqual({
        ok: true,
        updated: 1,
        skippedAmbiguous: false,
      })

      // 各 commit 各命中各的行
      const rowDs = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-ds') as { commit_hash: string | null }
      expect(rowDs.commit_hash).toBe(hashA)
      const rowFlash = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-flash') as { commit_hash: string | null }
      expect(rowFlash.commit_hash).toBe(hashB)

      // executor 反查闭环：?commit= 各精确命中各的实施者（无错投）+ taskId 随行
      const execA = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashA}`,
      })
      // T-I：两条执行行**同一条链**（同一个触发消息）⇒ taskId 同为该消息的锚；
      // 与各自执行行的 trace_id（此 fixture 未写，DEFAULT ''）无关
      expect(JSON.parse(execA.body)).toEqual({
        agentId: 'agent-ds',
        agentName: 'ds猫',
        taskId: DUAL_ANCHOR,
        matchedBy: 'commit',
        ambiguous: false,
      })
      const execB = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashB}`,
      })
      expect(JSON.parse(execB.body)).toEqual({
        agentId: 'agent-flash',
        agentName: 'flash猫',
        taskId: DUAL_ANCHOR,
        matchedBy: 'commit',
        ambiguous: false,
      })
    })

    it('无 agentId + 同 uuid 多只猫在跑 → 拒写（updated:0 + skippedAmbiguous，旧实现 updated:2 且两行同 sha）', async () => {
      const uuid = 'aa11bb22-0000-4000-8000-00000000c001'
      const sha = 'e'.repeat(40)
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-ambig', 'debug', '[]', datetime('now'), datetime('now'))`
      ).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, 'session-ambig', 'agent', '派双单', '[]', 'anchor-ambig')`
      ).run(uuid)
      for (const [id, name] of [
        ['agent-ds', 'ds猫'],
        ['agent-flash', 'flash猫'],
      ]) {
        db.prepare(
          `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
           VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
        ).run(id, name)
        db.prepare(
          `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
           VALUES (?, 'session-ambig', ?, ?, 'running', datetime('now'))`
        ).run(`log-${id}`, id, uuid)
      }

      const res = await app.inject({
        method: 'POST',
        url: `/api/messages/${uuid}/commit-hash`,
        payload: { commitHash: sha },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        updated: 0,
        skippedAmbiguous: true,
      })
      // 拒写 = 一个字都没写（不是"写了但没命中"）：归属留空，读侧 404/ambiguous，
      // 调用方兜底 @店长——而不是给两只猫都记一笔"我提交了它"
      const rows = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE triggered_by_message_id = ?')
        .all(uuid) as Array<{ commit_hash: string | null }>
      expect(rows.map((r) => r.commit_hash)).toEqual([null, null])
      // 反查闭环：该 uuid 有执行行但指不出人 ⇒ ambiguous（不是挑一只）
      const exec = await app.inject({ method: 'GET', url: `/api/messages/${uuid}/executor` })
      expect(JSON.parse(exec.body).ambiguous).toBe(true)
    })

    it('拒绝非 40-hex 的 commitHash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/commit-hash',
        payload: { commitHash: 'short' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/handoff/verdict（补填风暴根治方向 1：投递前查已审 ✅）', () => {
    // fixture：commit → execution_log（commit_hash + trace_id）→ task_id 消息链
    // → review_verdicts（message_id 指向链上审查结论消息）
    const insertVerdictChain = (opts: { sha: string; taskId: string; verdict?: string }) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-verdict', 'debug')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-v', 'v猫')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, commit_hash, trace_id)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'), ?, ?)`
      ).run('vlog', 'session-verdict', 'agent-v', 'vm-1', opts.sha, opts.taskId)
      // 任务链上的审查结论消息（user role：吐槽猫的审查回复经 ingest 落库带 task_id）
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, ?, 'user', '审查结论', '[]', ?)`
      ).run('vmsg-review', 'session-verdict', opts.taskId)
      if (opts.verdict) {
        db.prepare(
          `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict)
           VALUES (?, ?, ?, ?)`
        ).run('vmsg-review', 'session-verdict', 'agent-v', opts.verdict)
      }
    }

    it('approve 命中 → approved: true', async () => {
      insertVerdictChain({ sha: 'a'.repeat(40), taskId: 'trace-v1', verdict: 'approve' })
      const res = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'a'.repeat(40)}`,
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true, approved: true })
    })

    it('suggest → approved: false（有修改就有新审查，仍须补填）', async () => {
      insertVerdictChain({ sha: 'b'.repeat(40), taskId: 'trace-v2', verdict: 'suggest' })
      const res = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'b'.repeat(40)}`,
      })
      expect(JSON.parse(res.body)).toEqual({ ok: true, approved: false })
    })

    it('reject → approved: false', async () => {
      insertVerdictChain({ sha: 'c'.repeat(40), taskId: 'trace-v3', verdict: 'reject' })
      const res = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'c'.repeat(40)}`,
      })
      expect(JSON.parse(res.body)).toEqual({ ok: true, approved: false })
    })

    it('无 verdict 记录 → approved: false', async () => {
      insertVerdictChain({ sha: 'd'.repeat(40), taskId: 'trace-v4' })
      const res = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'d'.repeat(40)}`,
      })
      expect(JSON.parse(res.body)).toEqual({ ok: true, approved: false })
    })

    it('无执行记录（SHA 查不到）→ approved: false', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'e'.repeat(40)}`,
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true, approved: false })
    })

    it('sha 缺失/非法 → 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/handoff/verdict' })
      expect(res.statusCode).toBe(400)
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/handoff/verdict?sha=${'short'}`,
      })
      expect(res2.statusCode).toBe(400)
    })
  })

  describe('POST /api/messages（REST 注入通道图片守卫）', () => {
    // 对齐 socketio.test.ts 的 SEND_MESSAGE 守卫覆盖（前缀/大小/数量三重防线）
    const insertSession = (id: string) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run(id, 'rest-test')
    }

    // T-F 之后 REST 注入通道 = **agent 入口**：投递必须带链锚（缺 → 400）。
    // 本组用例测的是图片守卫 / 会话路由，锚取固定值且不参与断言——补锚是**契约适配**，
    // 不是绕过（缺锚行为另有专门用例覆盖，见 connectors/ingest.test.ts 主闸组）。
    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { taskId: 'anchor-rest-fixture', ...payload },
      })

    const lastStoredImages = (sessionId: string): string[] => {
      const row = getDb()
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(sessionId) as any
      return JSON.parse(row.images)
    }

    it('drops images without data:image/ prefix (server guard)', async () => {
      insertSession('session-rest-guard-1')
      const res = await postMessage({
        sessionId: 'session-rest-guard-1',
        content: '防垃圾',
        mentions: [],
        images: ['data:image/png;base64,OK', 'not-an-image', 'javascript:alert(1)'],
      })
      expect(res.statusCode).toBe(201)
      // 非法前缀被过滤，只保留合法 data:image/ 项（与 socket 侧同构）
      expect(lastStoredImages('session-rest-guard-1')).toEqual(['data:image/png;base64,OK'])
    })

    it('drops oversized images (>3MB) (server guard)', async () => {
      // 双层防线：生产 Fastify 默认 bodyLimit 1MB 会先于路由 413 拒绝整个请求体，
      // 路由的 3MB 单图守卫（与 socket 侧同构）是兜底——生产 REST 实际单图上限是 1MB，
      // 严于 socket 的 3MB；若 REST 真要传大图，需同步调 bodyLimit 才够
      // 这里放大 bodyLimit 以触达路由自身的 3MB 单图守卫
      const bigApp = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 })
      const { messageRoutes } = await import('./messages.js')
      await bigApp.register(messageRoutes)
      try {
        insertSession('session-rest-guard-2')
        const oversized = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) // 超过 3MB 上限
        const res = await bigApp.inject({
          method: 'POST',
          url: '/api/messages',
          payload: {
            sessionId: 'session-rest-guard-2',
            content: '防滥用',
            mentions: [],
            images: ['data:image/png;base64,small', oversized],
            taskId: 'anchor-rest-fixture', // T-F：REST = agent 入口，缺锚 400（同 postMessage 注释）
          },
        })
        expect(res.statusCode).toBe(201)
        const stored = lastStoredImages('session-rest-guard-2')
        expect(stored).toEqual(['data:image/png;base64,small'])
        expect(stored).not.toContain(oversized)
      } finally {
        await bigApp.close()
      }
    })

    it('truncates images to 4 (server guard)', async () => {
      insertSession('session-rest-guard-3')
      const res = await postMessage({
        sessionId: 'session-rest-guard-3',
        content: '防滥用',
        mentions: [],
        images: [
          'data:image/png;base64,1',
          'data:image/png;base64,2',
          'data:image/png;base64,3',
          'data:image/png;base64,4',
          'data:image/png;base64,5',
        ],
      })
      expect(res.statusCode).toBe(201)
      const stored = lastStoredImages('session-rest-guard-3')
      expect(stored).toHaveLength(4)
      expect(stored).not.toContain('data:image/png;base64,5')
    })
  })

  describe('POST /api/messages（已交接会话路由兜底，方案 A）', () => {
    const insertSession = (
      id: string,
      opts: { handoffFrom?: string; runningSummary?: string | null } = {}
    ) => {
      getDb()
        .prepare(
          `INSERT INTO sessions (id, title, agent_ids, handoff_from, running_summary, created_at, updated_at)
           VALUES (?, 'test', '[]', ?, ?, datetime('now'), datetime('now'))`
        )
        .run(id, opts.handoffFrom ?? null, opts.runningSummary ?? null)
    }

    const insertMessage = (id: string, sessionId: string) => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', 'hello', '[]')`
        )
        .run(id, sessionId)
    }

    // T-F 之后 REST 注入通道 = **agent 入口**：投递必须带链锚（缺 → 400）。
    // 本组用例测的是图片守卫 / 会话路由，锚取固定值且不参与断言——补锚是**契约适配**，
    // 不是绕过（缺锚行为另有专门用例覆盖，见 connectors/ingest.test.ts 主闸组）。
    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { taskId: 'anchor-rest-fixture', ...payload },
      })

    it('AC4: 发往已交接旧会话 → 消息落子会话，响应带 redirectedTo', async () => {
      insertSession('old-session')
      insertSession('child-session', {
        handoffFrom: 'old-session',
        runningSummary: JSON.stringify({ text: '总结' }),
      })
      insertMessage('m-1', 'child-session')

      const res = await postMessage({ sessionId: 'old-session', content: '还在吗', mentions: [] })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.redirectedTo).toBe('child-session')
      // 消息落子会话（1 条 fixture + 1 条新消息）；旧会话无新消息
      const childCount = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('child-session') as any
      expect(childCount.cnt).toBe(2)
      const oldCount = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('old-session') as any
      expect(oldCount.cnt).toBe(0)
    })

    it('AC5: 未交接会话 → 消息留在原会话，响应无 redirectedTo', async () => {
      insertSession('normal-session')

      const res = await postMessage({
        sessionId: 'normal-session',
        content: '普通消息',
        mentions: [],
      })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.redirectedTo).toBeUndefined()
      const count = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('normal-session') as any
      expect(count.cnt).toBe(1)
    })
  })

  describe('POST /api/messages（x-test-call 头重启请求隔离）', () => {
    // 实施猫测试调用（真实链路 POST 含重启请求格式）会写 .restart-request pending
    // 文件——顶掉店长真实请求 10 分钟（createRestartRequest 未过期保留跳过）。
    // x-test-call: 1 → 跳过识别与文件写入，消息本身照常摄入。
    beforeEach(() => {
      removeRestartRequest() // 防用例间残留影响存在性断言
      getDb()
        .prepare(
          `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
           VALUES (?, 'rest-test', '[]', datetime('now'), datetime('now'))`
        )
        .run('session-restart-isolate')
    })
    afterEach(() => {
      removeRestartRequest()
    })

    it('带 x-test-call: 1 头 + 重启请求格式 → 201 + 不写请求文件 + 消息照常落库', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-test-call': '1' },
        payload: {
          sessionId: 'session-restart-isolate',
          content: '【重启请求】原因：测试重启',
          mentions: [],
          taskId: 'anchor-restart-fixture', // T-F：REST = agent 入口，缺锚 400
        },
      })

      expect(res.statusCode).toBe(201)
      expect(existsSync(RESTART_REQUEST_FILE)).toBe(false)
      const row = getDb()
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get('session-restart-isolate') as any
      expect(row).toBeDefined()
      expect(row.content).toBe('【重启请求】原因：测试重启')
    })

    it('不带 x-test-call 头 + 重启请求格式 → 请求文件照常写入（现状行为保持）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: {
          sessionId: 'session-restart-isolate',
          content: '【重启请求】原因：测试重启',
          mentions: [],
          taskId: 'anchor-restart-fixture', // T-F：REST = agent 入口，缺锚 400
        },
      })

      expect(res.statusCode).toBe(201)
      // 隔离**生效**的判据（不只是「文件存在」）：路径须落在本文件专属的隔离目录。
      // 缺这条时，factory 内动态 import 的时序若出偏差（隔离没生效），测试照绿。
      expect(RESTART_REQUEST_FILE).toContain('restart-test-messages')
      expect(existsSync(RESTART_REQUEST_FILE)).toBe(true)
      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8')) as any
      expect(req.state).toBe('pending')
      expect(req.sessionId).toBe('session-restart-isolate')
    })
  })

  // T-F 入口主闸：REST 注入通道 = agent 入口（前端走 socketio，不受此限）。
  // 这一组验的是**路由接线**（origin/chainType 是否真透传到 ingest），行为本身在
  // connectors/ingest.test.ts 覆盖——两处不是重复：那里测判据，这里测接对了没有。
  describe('POST /api/messages（T-F 投递契约主闸）', () => {
    const SESSION = 'session-gate'

    const seed = () => {
      getDb()
        .prepare(
          `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
           VALUES ('agent-rev', '吐槽猫', '🐱', 'p', 'deepseek', 'm', 'k', 'reviewer')`
        )
        .run()
      getDb()
        .prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 'gate', '["agent-rev"]')`)
        .run(SESSION)
    }

    it('REST 缺 taskId → 400 缺链锚（agent 入口强制锚）', async () => {
      seed()
      const res = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { sessionId: SESSION, content: '投递', mentions: [] },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('缺链锚')
    })

    it('REST 审查类缺 chainType → 400；补上 chainType 后 201（接线正确）', async () => {
      seed()
      const base = {
        sessionId: SESSION,
        content: '请审查',
        mentions: ['吐槽猫'],
        taskId: 'anchor-gate',
      }
      const missing = await app.inject({ method: 'POST', url: '/api/messages', payload: base })
      expect(missing.statusCode).toBe(400)
      expect(JSON.parse(missing.body).error).toContain('chainType')

      const ok = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { ...base, chainType: 'followup' },
      })
      expect(ok.statusCode).toBe(201)
    })

    it('REST chainType 非法值 → 400 独立文案（不把「拼错」报成「没给」，N-4）', async () => {
      seed()
      const payload = {
        sessionId: SESSION,
        content: '请审查',
        mentions: ['吐槽猫'],
        taskId: 'anchor-gate',
        chainType: 'First', // 大小写拼错：旧实现静默归一为 undefined → 报「缺 chainType」
      }
      const res = await app.inject({ method: 'POST', url: '/api/messages', payload })
      expect(res.statusCode).toBe(400)
      const err = JSON.parse(res.body).error as string
      expect(err).toContain('First') // 文案里回显非法值，调用方一眼看出拼错
      expect(err).toContain('非法')
      expect(err).not.toContain('缺') // 区分性：不是「缺 chainType」那条文案

      // 对照：真正的「没给」仍走「缺 chainType」文案（两条文案不可混同）
      const missing = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { ...payload, chainType: undefined },
      })
      expect(missing.statusCode).toBe(400)
      expect(JSON.parse(missing.body).error).toContain('缺 chainType')
    })
  })
})

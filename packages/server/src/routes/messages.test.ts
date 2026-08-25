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
// env 指向共享目录 node_modules/.cache/restart-test）——全量并行时两文件用例交错互删
// 同一文件是 6846bb4 文档化的竞态配对（existsSync 通过后文件可能已被对方 afterEach 删掉）。
// 隔离机制：vi.mock factory 在 restart-request.js 首次导入（messages.js 链）前改写
// RESTART_FILES_DIR 指向独立目录——importOriginal 返回真实模块（零 mock 语义），只是
// 求值环境不同；生产链路（messages.ts → ingest.ts → restart-request.js 静态导入链）
// 与断言拿到同一隔离实例。与 restart-request.test.ts（vi.resetModules + vi.stubEnv）
// 的差异：那里被测模块即生产模块本身，重导入即隔离；这里静态导入链在 messages.ts
// 顶层，resetModules 需整链重导入 + 重建 app + 处理跨 describe 注册表泄漏——factory
// 方案隔离效果等价且零结构改动。vitest 默认 per-file worker 隔离，env 改写不跨文件泄漏。
vi.mock('../restart-request.js', async (importOriginal) => {
  process.env.RESTART_FILES_DIR = 'node_modules/.cache/restart-test-messages'
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
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, trace_id)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'), ?)`
      ).run('log-1', 'session-exec-1', 'agent-ds', triggeredBy, 'trace-exec-1')
    }

    it('returns executor agentName for a message with execution log', async () => {
      insertFixture('6cfecca8-ba78-4039-a12c-71313afd29cd')
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentId).toBe('agent-ds')
      expect(body.agentName).toBe('ds猫')
      // E3 接线：taskId = 命中执行行的 trace_id（审查链投递 payload 同源反查）
      expect(body.taskId).toBe('trace-exec-1')
    })

    it('returns 404 when no execution log exists for the message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns the latest execution when multiple agents were triggered', async () => {
      const db = getDb()
      insertFixture('6cfecca8-ba78-4039-a12c-71313afd29cd')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-reviewer', '吐槽猫')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'failed', datetime('now', '+1 minute'))`
      ).run('log-2', 'session-exec-1', 'agent-reviewer', '6cfecca8-ba78-4039-a12c-71313afd29cd')
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentName).toBe('吐槽猫')
    })

    it('?commit= 按 commit_hash 精确命中各自实施者（同 uuid 双执行者各 commit 各命中各）', async () => {
      const uuid = '6cfecca8-ba78-4039-a12c-71313afd29cd'
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
      // E3 接线：taskId 随 commit 精确匹配各自执行行的 trace_id（与 executor 同源）
      expect(JSON.parse(resA.body).taskId).toBe('trace-ds')

      const resB = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashB}`,
      })
      expect(resB.statusCode).toBe(200)
      expect(JSON.parse(resB.body).agentName).toBe('flash猫')
      expect(JSON.parse(resB.body).taskId).toBe('trace-flash')
    })

    it('?commit= 查不到（老 commit 未写回 hash）时回退 uuid 逻辑', async () => {
      const uuid = '6cfecca8-ba78-4039-a12c-71313afd29cd'
      insertFixture(uuid) // log-1：无 commit_hash
      const res = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${'c'.repeat(40)}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentId).toBe('agent-ds')
      expect(body.agentName).toBe('ds猫')
      // 回退 uuid 逻辑时 taskId 同步取 uuid 路径命中行的 trace_id
      expect(body.taskId).toBe('trace-exec-1')
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
      expect(JSON.parse(res.body)).toEqual({ ok: true, updated: 1 })

      const rowRunning = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-running') as { commit_hash: string | null }
      expect(rowRunning.commit_hash).toBe(hash)
      const rowDone = db
        .prepare('SELECT commit_hash FROM execution_logs WHERE id = ?')
        .get('log-done') as { commit_hash: string | null }
      expect(rowDone.commit_hash).toBeNull()
    })

    it('带 agentId 精确命中自己的 running 行——双 running 各 commit 各刷各，无覆盖无错投（eae5a5e 竞态根治）', async () => {
      const uuid = '553bbc08-3819-4d75-9499-f23c6eb1282f'
      const hashA = 'a'.repeat(40)
      const hashB = 'b'.repeat(40)
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-exec-2', 'debug')
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
      expect(JSON.parse(resA.body)).toEqual({ ok: true, updated: 1 })
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
      expect(JSON.parse(resB.body)).toEqual({ ok: true, updated: 1 })

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
      // 该 fixture 未写 trace_id（存量行 DEFAULT ''）→ taskId 归 null（已知噪声契约）
      expect(JSON.parse(execA.body)).toEqual({
        agentId: 'agent-ds',
        agentName: 'ds猫',
        taskId: null,
      })
      const execB = await app.inject({
        method: 'GET',
        url: `/api/messages/${uuid}/executor?commit=${hashB}`,
      })
      expect(JSON.parse(execB.body)).toEqual({
        agentId: 'agent-flash',
        agentName: 'flash猫',
        taskId: null,
      })
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

    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/messages', payload })

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

    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/messages', payload })

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
        },
      })

      expect(res.statusCode).toBe(201)
      expect(existsSync(RESTART_REQUEST_FILE)).toBe(true)
      const req = JSON.parse(readFileSync(RESTART_REQUEST_FILE, 'utf-8')) as any
      expect(req.state).toBe('pending')
      expect(req.sessionId).toBe('session-restart-isolate')
    })
  })
})

/**
 * 消息 REST API — 供外部工具（pre-push hook 等）向 cat-study 管道注入消息。
 *
 * POST /api/messages → 写入 DB → 广播 → 调度 Agent 执行
 * 等价于 Web 前端通过 Socket.IO 发送 SEND_MESSAGE 事件，但不需要 WebSocket 连接。
 */
import type { FastifyInstance } from 'fastify'
import {
  messages as messagesRepo,
  executionLogs as execLogsRepo,
  verdicts as verdictsRepo,
} from '../db/repository/index.js'
import { ingestUserMessage } from '../connectors/ingest.js'

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/messages/:id → 按消息 id 反查所属会话
   * 供 handoff-gen 从 commit message 的 catstudy [uuid]（uuid 即触发消息 id）
   * 反查投递目标会话——永远指向"用户实际发起这条消息的会话"，比硬编码更准。
   */
  app.get('/api/messages/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'id is required' })
    }
    const row = messagesRepo.getMessageByIdOnly(id)
    if (!row) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    return reply.send({ id: row.id, sessionId: row.session_id, role: row.role })
  })

  /**
   * GET /api/messages/:id/executor → 反查"执行这条消息"的 agent（实施者）
   * 供 handoff-gen 动态决定交接文档补填人——"谁执行了触发消息，谁补填"。
   * ?commit=<full-sha> 时 commit_hash 精确匹配优先（同 uuid 多执行者时各 commit
   * 各命中各的实施者，根治"取最近开始执行"误指）；未传 commit 或按 hash 查不到
   * （老 commit 未写回 hash）回退 uuid 逻辑；无执行记录 404。
   */
  app.get('/api/messages/:id/executor', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'id is required' })
    }
    const { commit } = req.query as { commit?: string }
    const executor = commit
      ? (execLogsRepo.getExecutorNameByCommitHash(commit) ??
        execLogsRepo.getExecutorNameByTriggeredBy(id))
      : execLogsRepo.getExecutorNameByTriggeredBy(id)
    if (!executor) {
      return reply.status(404).send({ error: 'No execution log for this message' })
    }
    // taskId = 命中执行行的 trace_id——E3 接线：审查链投递 payload 带 taskId，与
    // chain_task_id 同源反查（commit_hash → execution_logs → trace_id）。反查路径
    // （uuid 退化 / commit_hash 精确匹配）与 executor 同源，taskId 随之精确。
    return reply.send({
      agentId: executor.agent_id,
      agentName: executor.name,
      taskId: executor.trace_id || null,
    })
  })

  /**
   * POST /api/messages/:id/commit-hash → 把 commit sha 写回该消息的执行记录
   * 供 handoff-gen（post-commit）投递前调用——agent 人工提交路径此前从不写
   * commit_hash（只有 socketio 自动提交兜底路径写），导致 executor 反查只能
   * "取最近"误指。写回后同 uuid 双执行者各 commit 各命中各的实施者。
   * 可选 body.agentId：handoff-gen 从 CATSTUDY_AGENT_ID（claude.ts spawn env
   * 注入，post-commit 父进程链继承）透传——双 running 行按 agent_id 精确命中
   * 自己的行，根治 eae5a5e 错投竞态；不带则 fallback 全刷 running（手动提交）。
   * 写回失败不阻断投递（反查增强不是硬依赖，失败退化 uuid 逻辑 + 兜底店长）。
   */
  app.post('/api/messages/:id/commit-hash', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'id is required' })
    }
    const body = req.body as { commitHash?: string; agentId?: string } | null
    const commitHash = typeof body?.commitHash === 'string' ? body.commitHash.trim() : ''
    if (!/^[0-9a-f]{40}$/.test(commitHash)) {
      return reply.status(400).send({ error: 'commitHash must be a 40-char hex sha' })
    }
    const agentId = typeof body?.agentId === 'string' && body.agentId ? body.agentId : undefined
    const result = agentId
      ? execLogsRepo.updateRunningExecutionCommitHash(id, commitHash, agentId)
      : execLogsRepo.updateRunningExecutionCommitHash(id, commitHash)
    return reply.send({ ok: true, updated: result.changes })
  })

  /**
   * GET /api/handoff/verdict?sha=<commit_sha> → { ok, approved }
   * 供 handoff-gen（post-commit）投递补填请求前查询"该 commit 是否已审 ✅"——
   * 补填请求风暴根治方向 1：已审 ✅ 的提交不再发补填请求（hook 每 commit 必投、
   * 去重键只防同 SHA，已闭环提交照样被反复补填的因果链第四层）。
   * 判定链：commit_hash → execution_logs（getExecutorNameByCommitHash，:80）→
   * trace_id（与 executor 反查同源）→ review_verdicts JOIN messages 查 approve。
   * 语义：只认 verdict='approve'；suggest/reject/无 verdict/无执行记录 → false
   * （有修改就有新审查，仍须补填）。sha 缺失/非 40 位十六进制 → 400。
   */
  app.get('/api/handoff/verdict', async (req, reply) => {
    const { sha } = req.query as { sha?: string }
    if (!sha || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      return reply.status(400).send({ error: 'sha must be a 40-char hex sha' })
    }
    const executor = execLogsRepo.getExecutorNameByCommitHash(sha)
    if (!executor) {
      return reply.send({ ok: true, approved: false })
    }
    const approved = verdictsRepo.hasApproveVerdictByTaskId(executor.trace_id)
    return reply.send({ ok: true, approved })
  })

  app.post('/api/messages', async (req, reply) => {
    const body = req.body as any

    // 基本参数校验
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      return reply.status(400).send({ error: 'sessionId is required (string)' })
    }
    if (!body.content || typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'content is required (string)' })
    }

    // 摄入管线（校验/重定向/落库/广播/调度/执行）已提取为共享核心，
    // 与 socketio SEND_MESSAGE 同构——两入口共用 ingest.ts。
    // 不传 saveMemory：外部工具注入的管道消息不进向量记忆库（保持现状）。
    // x-test-call: 1（实施猫测试调用）→ 跳过重启请求识别与文件写入：
    // 测试消息含重启请求格式会写 pending 请求文件，顶掉店长真实请求 10 分钟。
    const result = await ingestUserMessage({
      sessionId: body.sessionId,
      content: body.content,
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
      images: Array.isArray(body.images) ? body.images : undefined,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      skipRestartRequest: req.headers['x-test-call'] === '1',
    })

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error })
    }

    return reply.status(201).send({
      ok: true,
      messageId: result.messageId,
      // 已交接会话 → 消息被重定向到子会话，调用方据此感知落点
      ...(result.redirectedFrom ? { redirectedTo: result.effectiveSessionId } : {}),
    })
  })
}

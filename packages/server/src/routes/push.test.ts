/**
 * push 审批 REST 路由测试（POST /api/push/confirm | /api/push/cancel）。
 *
 * 业务核心 executePushConfirm/cancelPush 在 git/push-state.ts（push 审批状态机唯一 owner）——
 * 本测试只 mock 最外层 git 边界（getMainRepoRoot/gitPushOriginDev——真实 git push 绝不在
 * 测试环境执行），其余走真实实现；push-state 模块级状态经 __test_resetPushStates 用例间隔离。
 * （store 层不在此测——confirmPush/cancelPush 的乐观置位/错误映射在 web chat.test.ts）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildTestApp, createTestDb } from '../test-helpers.js'
import { setDb, resetDb } from '../db/index.js'
import type { FastifyInstance } from 'fastify'

vi.mock('../llm/git-utils.js', () => ({
  getMainRepoRoot: vi.fn(() => null),
  gitPushOriginDev: vi.fn(() => ({ ok: true })),
  gitResetHard: vi.fn(),
  gitCleanWorkingTree: vi.fn(),
  npmUninstall: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('push routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    app = await buildTestApp()
    const { pushRoutes } = await import('./push.js')
    await app.register(pushRoutes)
  })

  afterEach(async () => {
    const { __test_resetPushStates } = await import('../git/push-state.js')
    __test_resetPushStates()
    vi.clearAllMocks()
    resetDb()
    await app.close()
  })

  const confirm = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/push/confirm', payload })

  describe('POST /api/push/confirm', () => {
    it('缺 messageId → 400', async () => {
      const res = await confirm({})
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('messageId is required (string)')
    })

    it('非 string messageId → 400', async () => {
      const res = await confirm({ messageId: 123 })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('messageId is required (string)')
    })

    it('成功 → 200 done + git push 在 getMainRepoRoot 定位的主仓库根执行', async () => {
      const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
      vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

      const res = await confirm({ messageId: 'msg-push-r1' })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true, state: 'done' })
      expect(gitPushOriginDev).toHaveBeenCalledWith('C:\\fake\\main')
    })

    it('幂等：done 后再确认 → already-done，不二次 push', async () => {
      const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
      vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

      await confirm({ messageId: 'msg-push-r2' })
      vi.mocked(gitPushOriginDev).mockClear()
      const res = await confirm({ messageId: 'msg-push-r2' })

      expect(JSON.parse(res.body)).toEqual({ ok: true, state: 'done', reason: 'already-done' })
      expect(gitPushOriginDev).not.toHaveBeenCalled()
    })

    it('主仓库根定位失败 → 200 failed no-main-root，不执行 push', async () => {
      const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
      vi.mocked(getMainRepoRoot).mockReturnValue(null)

      const res = await confirm({ messageId: 'msg-push-r3' })

      expect(JSON.parse(res.body)).toEqual({ ok: false, state: 'failed', reason: 'no-main-root' })
      expect(gitPushOriginDev).not.toHaveBeenCalled()
    })

    it('push 失败 → 200 failed 带 error（业务失败也 200，状态在 body）', async () => {
      const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
      vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')
      vi.mocked(gitPushOriginDev).mockResolvedValueOnce({ ok: false, error: 'remote rejected' })

      const res = await confirm({ messageId: 'msg-push-r4' })

      expect(JSON.parse(res.body)).toEqual({
        ok: false,
        state: 'failed',
        reason: 'failed',
        error: 'remote rejected',
      })
    })

    it('推送中重复确认 → already-pushing，不二次执行 push', async () => {
      const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
      const { executePushConfirm } = await import('../git/push-state.js')
      vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')
      let resolvePush: () => void
      const pending = new Promise<void>((r) => {
        resolvePush = r
      })
      vi.mocked(gitPushOriginDev).mockImplementationOnce(
        () => pending.then(() => ({ ok: true })) as any
      )

      // 直接调业务函数种入 pushing 态（第一击挂起中，不 await）——比并发 inject 更确定
      const p1 = executePushConfirm('msg-push-r5')

      const res = await confirm({ messageId: 'msg-push-r5' })
      expect(JSON.parse(res.body)).toEqual({
        ok: false,
        state: 'pushing',
        reason: 'already-pushing',
      })
      expect(gitPushOriginDev).toHaveBeenCalledTimes(1)

      resolvePush!()
      expect(await p1).toEqual({ ok: true, state: 'done' })
    })
  })

  describe('POST /api/push/cancel', () => {
    it('成功 → 200 ok:true', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/push/cancel',
        payload: { messageId: 'msg-push-c1' },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })
    })

    it('缺 messageId → 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/push/cancel', payload: {} })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('messageId is required (string)')
    })
  })
})

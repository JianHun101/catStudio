/**
 * git/push-state.ts 状态机测试。
 *
 * 策略：只 mock 最外层 git 边界（getMainRepoRoot/gitPushOriginDev——真实 git push 绝不在
 * 测试环境执行，cwd 会命中真实主仓库），其余走真实实现。状态机为进程内 Map，
 * 用例间 __test_resetPushStates 隔离。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  executePushConfirm,
  cancelPush,
  getPushState,
  __test_resetPushStates,
} from './push-state.js'

vi.mock('../llm/git-utils.js', () => ({
  getMainRepoRoot: vi.fn(() => null),
  gitPushOriginDev: vi.fn(() => ({ ok: true })),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('push-state', () => {
  beforeEach(() => {
    __test_resetPushStates()
    vi.clearAllMocks()
  })

  it('成功 → done + git push 在 getMainRepoRoot 定位的主仓库根执行', async () => {
    const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

    const res = await executePushConfirm('msg-push-1')

    expect(res).toEqual({ ok: true, state: 'done' })
    expect(gitPushOriginDev).toHaveBeenCalledWith('C:\\fake\\main')
    expect(getPushState('msg-push-1')).toBe('done')
  })

  it('幂等：done 后再确认 → already-done，不二次 push', async () => {
    const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

    await executePushConfirm('msg-push-2')
    vi.mocked(gitPushOriginDev).mockClear()
    const res = await executePushConfirm('msg-push-2')

    expect(res).toEqual({ ok: true, state: 'done', reason: 'already-done' })
    expect(gitPushOriginDev).not.toHaveBeenCalled()
  })

  it('主仓库根定位失败 → failed no-main-root，不执行 push', async () => {
    const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue(null)

    const res = await executePushConfirm('msg-push-3')

    expect(res).toEqual({ ok: false, state: 'failed', reason: 'no-main-root' })
    expect(gitPushOriginDev).not.toHaveBeenCalled()
  })

  it('push 失败 → failed 带 error（error 透传）+ getPushState 返回 failed', async () => {
    const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')
    vi.mocked(gitPushOriginDev).mockResolvedValueOnce({ ok: false, error: 'remote rejected' })

    const res = await executePushConfirm('msg-push-4')

    expect(res).toEqual({ ok: false, state: 'failed', reason: 'failed', error: 'remote rejected' })
    expect(getPushState('msg-push-4')).toBe('failed')
  })

  it('推送中重复确认 → already-pushing，不二次执行 push', async () => {
    const { getMainRepoRoot, gitPushOriginDev } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')
    let resolvePush: () => void
    const pending = new Promise<void>((r) => {
      resolvePush = r
    })
    vi.mocked(gitPushOriginDev).mockImplementationOnce(
      () => pending.then(() => ({ ok: true })) as any
    )

    // 第一击挂起中（不 await）——状态同步推进到 pushing
    const p1 = executePushConfirm('msg-push-5')
    const res = await executePushConfirm('msg-push-5')

    expect(res).toEqual({ ok: false, state: 'pushing', reason: 'already-pushing' })
    expect(gitPushOriginDev).toHaveBeenCalledTimes(1)

    resolvePush!()
    expect(await p1).toEqual({ ok: true, state: 'done' })
  })

  it('PUSH_STATES_MAX 有界裁剪：删最旧且永不删当前 messageId', async () => {
    const { getMainRepoRoot } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

    // 压入 55 个终态（上限 50）——最旧 5 个被挤掉
    for (let i = 0; i < 55; i++) {
      await executePushConfirm(`msg-push-max-${i}`)
    }

    expect(getPushState('msg-push-max-0')).toBeUndefined()
    expect(getPushState('msg-push-max-4')).toBeUndefined()
    expect(getPushState('msg-push-max-5')).toBe('done')
    expect(getPushState('msg-push-max-54')).toBe('done')
  })

  it('cancel → 删除（getPushState undefined，可重新批准）', async () => {
    const { getMainRepoRoot } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue('C:\\fake\\main')

    await executePushConfirm('msg-push-cancel')
    cancelPush('msg-push-cancel')

    expect(getPushState('msg-push-cancel')).toBeUndefined()
    // 取消后重新确认 → 重新执行 push（push 幂等）
    const res = await executePushConfirm('msg-push-cancel')
    expect(res).toEqual({ ok: true, state: 'done' })
  })

  it('getPushState 未确认 → undefined', () => {
    expect(getPushState('msg-never-confirmed')).toBeUndefined()
  })
})

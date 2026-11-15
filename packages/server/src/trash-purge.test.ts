/**
 * 回收站清扫接线（T2）：P2-1 的接线面测试。
 *
 * 被 mock 的只有边界：仓储（清扫结果）、socket IO（广播）、执行引擎（槽位）。清扫本身在
 * `repository/trash.test.ts` 用真实 SQLite 测，这里只钉「清掉的行有没有发出去 / 槽位有没
 * 有清」——`index.ts` 的 `main()` 一被 import 就起服务，所以接线逻辑单独放在
 * `trash-purge.ts` 才能测。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Events } from '@cat-study/shared'

const { mockPurge, mockGetIO, mockDispose, mockGroupsChanged } = vi.hoisted(() => ({
  mockPurge: vi.fn(),
  mockGetIO: vi.fn(),
  mockDispose: vi.fn(),
  mockGroupsChanged: vi.fn(),
}))

vi.mock('./db/repository/index.js', () => ({ trash: { purgeExpiredTrash: mockPurge } }))
vi.mock('./connectors/socketio.js', () => ({ getIO: mockGetIO }))
vi.mock('./execution/registry.js', () => ({
  getExecutionEngine: () => ({ disposeSession: mockDispose }),
}))
vi.mock('./routes/sessionGroups.js', () => ({ emitGroupsChanged: mockGroupsChanged }))

import { runTrashPurge } from './trash-purge.js'

type PurgeResult = {
  groups: number
  sessions: number
  sessionIds: string[]
  groupIds: string[]
  skipped?: 'probe'
}

const resultOf = (over: Partial<PurgeResult> = {}): PurgeResult => ({
  groups: 0,
  sessions: 0,
  sessionIds: [],
  groupIds: [],
  ...over,
})

describe('runTrashPurge — 清扫接线（P2-1 / P2-2）', () => {
  let mockEmit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockPurge.mockReset()
    mockGetIO.mockReset()
    mockDispose.mockReset()
    mockGroupsChanged.mockReset()
    mockEmit = vi.fn()
    mockGetIO.mockReturnValue({ emit: mockEmit })
  })

  it('hourly 清掉会话 + 组：发 SESSION_PURGED、补 GROUPS_CHANGED、逐成员清槽位', () => {
    mockPurge.mockReturnValue(
      resultOf({ groups: 1, sessions: 2, sessionIds: ['s1', 's2'], groupIds: ['g1'] })
    )

    runTrashPurge('hourly')

    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_PURGED, {
      sessionIds: ['s1', 's2'],
      groupIds: ['g1'],
    })
    expect(mockGroupsChanged).toHaveBeenCalledTimes(1)
    expect(mockDispose).toHaveBeenCalledTimes(2)
    expect(mockDispose).toHaveBeenCalledWith('s1')
    expect(mockDispose).toHaveBeenCalledWith('s2')
  })

  it('只清会话（无组）：发 SESSION_PURGED，不补 GROUPS_CHANGED', () => {
    mockPurge.mockReturnValue(resultOf({ sessions: 1, sessionIds: ['s1'] }))

    runTrashPurge('hourly')

    expect(mockEmit).toHaveBeenCalledWith(Events.SESSION_PURGED, {
      sessionIds: ['s1'],
      groupIds: [],
    })
    expect(mockGroupsChanged).not.toHaveBeenCalled()
  })

  it('本轮零删除：不广播、不清槽位', () => {
    mockPurge.mockReturnValue(resultOf())

    runTrashPurge('hourly')

    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockGroupsChanged).not.toHaveBeenCalled()
    expect(mockDispose).not.toHaveBeenCalled()
  })

  it('启动清扫（getIO 尚未创建 = null）：不抛错，槽位照样清', () => {
    mockGetIO.mockReturnValue(null)
    mockPurge.mockReturnValue(resultOf({ sessions: 1, sessionIds: ['s1'] }))

    expect(() => runTrashPurge('startup')).not.toThrow()
    expect(mockDispose).toHaveBeenCalledWith('s1')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('probe 跳过：不广播、不清槽位', () => {
    mockPurge.mockReturnValue(resultOf({ skipped: 'probe' }))

    runTrashPurge('startup')

    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockGroupsChanged).not.toHaveBeenCalled()
    expect(mockDispose).not.toHaveBeenCalled()
  })

  it('清扫抛错：吞掉并记日志，不把定时器打挂', () => {
    mockPurge.mockImplementation(() => {
      throw new Error('db locked')
    })

    expect(() => runTrashPurge('hourly')).not.toThrow()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

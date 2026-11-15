/**
 * `runtime-instance` 测试（票 B 契约 A / 验收 A1）——[运行时自检] 的实例读数读点。
 *
 * 只判三件可观察行为：注册后可读、未注册是 null、复位后回到 null。
 * 模块态是进程级单例，故每个用例前后都复位，避免测试顺序耦合。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setRuntimeInstance,
  getRuntimeInstance,
  __test_resetRuntimeInstance,
  type RuntimeInstance,
} from './runtime-instance.js'

const instance = (over: Partial<RuntimeInstance> = {}): RuntimeInstance => ({
  bootId: 'c79a40db-1111-4222-8333-444455556666',
  startedAt: '2026-11-15T15:19:16.838Z',
  gitSha: '62c8b9b4aabbccddeeff00112233445566778899',
  gitDirty: 0,
  ...over,
})

describe('runtime-instance', () => {
  beforeEach(() => {
    __test_resetRuntimeInstance()
  })

  it('未注册时返回 null（测试进程 / 采集失败 / CLI 兜底）', () => {
    expect(getRuntimeInstance()).toBeNull()
  })

  it('注册后返回**同一对象**（读侧拿到的就是写入层那份读数，不再重取时间）', () => {
    const value = instance()
    setRuntimeInstance(value)
    expect(getRuntimeInstance()).toBe(value)
  })

  it('覆盖注册：后写的替换先写的', () => {
    setRuntimeInstance(instance({ bootId: 'first' }))
    const second = instance({ bootId: 'second' })
    setRuntimeInstance(second)
    expect(getRuntimeInstance()?.bootId).toBe('second')
  })

  it('`__test_resetRuntimeInstance` 后回到 null', () => {
    setRuntimeInstance(instance())
    __test_resetRuntimeInstance()
    expect(getRuntimeInstance()).toBeNull()
  })
})

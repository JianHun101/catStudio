import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'

/**
 * 票① 回前台立即重连（后台标签页冻结根治）——三条断言面：
 * 可见性分支（visible 且断开才 connect）、单例只注册一次、disconnectSocket 对称移除。
 *
 * useSocket 是模块级单例（`socket` ref），模块只求值一次。每条用例 resetModules 后
 * 重新 import —— 否则上一条用例留下的单例与监听器会串味（与 useTheme.test.ts 同款加载方式）。
 */

const { mockSocket, ioSpy } = vi.hoisted(() => {
  const socket = {
    id: 'test-socket-id',
    connected: false,
    disconnected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
  }
  return { mockSocket: socket, ioSpy: vi.fn(() => socket) }
})

vi.mock('socket.io-client', () => ({ io: ioSpy }))

async function loadUseSocket() {
  vi.resetModules()
  return await import('./useSocket')
}

/**
 * 派发一次 visibilitychange。jsdom 的 `document.visibilityState` 是只读 getter，
 * 只能 defineProperty 覆盖（configurable 以便 afterEach 复位）。
 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 本文件注册的 visibilitychange 监听器（按事件名过滤掉 jsdom/Vue 的其它注册） */
function registeredListeners(): EventListenerOrEventListenerObject[] {
  return addSpy.mock.calls
    .filter((c) => c[0] === 'visibilitychange')
    .map((c) => c[1])
    .filter((l): l is EventListenerOrEventListenerObject => l != null)
}

// addEventListener/removeEventListener 定义在 EventTarget.prototype 上（document 无自有属性），
// 故按原型下桩；spyOn 的实例方法在 afterEach 恢复。
let addSpy: MockInstance<EventTarget['addEventListener']>
let removeSpy: MockInstance<EventTarget['removeEventListener']>

beforeEach(() => {
  vi.clearAllMocks()
  mockSocket.connected = false
  mockSocket.disconnected = true
  addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
  removeSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener')
})

afterEach(() => {
  addSpy.mockRestore()
  removeSpy.mockRestore()
  // 复位 jsdom 默认值——同 jsdom 环境的其它测试文件共享 document
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('useSocket 回前台重连', () => {
  it('A1：visible 且已断开 → 立即 connect()（不等重连退避）', async () => {
    const { useSocket } = await loadUseSocket()
    useSocket()
    expect(mockSocket.connect).toHaveBeenCalledTimes(1) // 单例创建时那次

    mockSocket.connect.mockClear()
    mockSocket.disconnected = true
    setVisibility('visible')

    expect(mockSocket.connect).toHaveBeenCalledTimes(1)
  })

  it('A2：hidden → 不 connect()（后台不空转）', async () => {
    const { useSocket } = await loadUseSocket()
    useSocket()
    mockSocket.connect.mockClear()

    mockSocket.disconnected = true
    setVisibility('hidden')

    expect(mockSocket.connect).not.toHaveBeenCalled()
  })

  it('A3：visible 但连接仍在 → 不重连（防每次切前台抖断连接）', async () => {
    const { useSocket } = await loadUseSocket()
    useSocket()
    mockSocket.connect.mockClear()

    mockSocket.connected = true
    mockSocket.disconnected = false
    setVisibility('visible')

    expect(mockSocket.connect).not.toHaveBeenCalled()
  })

  it('A4：重复 useSocket() 不重复注册监听（单例语义，防 N 个监听叠加）', async () => {
    const { useSocket } = await loadUseSocket()
    useSocket()
    useSocket()
    useSocket()

    expect(registeredListeners()).toHaveLength(1)
  })

  it('A5：disconnectSocket() 以同一函数引用移除监听（不留悬挂监听）', async () => {
    const { useSocket, disconnectSocket } = await loadUseSocket()
    useSocket()

    const [handler] = registeredListeners()
    expect(handler).toBeTypeOf('function')

    disconnectSocket()

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', handler)
  })
})

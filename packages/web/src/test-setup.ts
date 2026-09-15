import { config } from '@vue/test-utils'

// 全局 stub：避免未实现的路由组件导致测试崩溃
config.global.stubs = {
  SessionCreateModal: true,
  AgentEditModal: true,
}

/**
 * jsdom 未实现 ResizeObserver（ChatPanel 的思考框内跟进用它观测内容增长，
 * 挂载即 new 会 ReferenceError 打挂整个用例）。此处提供惰性桩：只记录回调与观测
 * 目标，不自动触发——jsdom 无布局，尺寸恒 0，真实触发无意义。
 * 需要驱动回调的用例可读 `resizeObserverCallbacks` 手动调。
 */
export const resizeObserverCallbacks: ResizeObserverCallback[] = []

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

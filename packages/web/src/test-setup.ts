import { config } from '@vue/test-utils'

// 全局 stub：避免未实现的路由组件导致测试崩溃
config.global.stubs = {
  SessionCreateModal: true,
  AgentEditModal: true,
}

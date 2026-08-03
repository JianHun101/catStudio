import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/shared',
  'packages/server',
  'packages/web',
  // scripts/ 下的纯函数模块测试（restart-gate.js 等，dev.js 依赖零依赖 ESM）
  'scripts',
])

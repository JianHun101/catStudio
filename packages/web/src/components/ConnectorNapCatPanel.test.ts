import { describe, it, expect } from 'vitest'
import source from './ConnectorNapCatPanel.vue?raw'

/**
 * Verify ConnectorNapCatPanel.vue (连接器配置弹窗 Tab2).
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Regression protection for
 * the NapCat lifecycle panel: 只读状态 + 薄桥启停（server 零 spawn），
 * 契约：GET status 渲染 / POST control → 3s × 10 轮询等状态翻转。
 */

describe('ConnectorNapCatPanel 状态渲染', () => {
  it('进入面板 → onMounted 拉取 GET status 渲染状态卡片', () => {
    expect(source).toContain('onMounted(refresh)')
    expect(source).toContain('api.getOneBotStatus()')
    expect(source).toContain('运行中')
    expect(source).toContain('已停止')
    expect(source).toContain('status?.apiBase')
  })

  it('启停按钮 → POST control → 3s × 最多 10 次轮询等 running 翻转（契约 30s 上限）', () => {
    expect(source).toContain('api.napcatControl(action)')
    expect(source).toContain('setTimeout(r, 3000)')
    expect(source).toContain('i < 10')
    expect(source).toContain('st.running === target')
    expect(source).toContain(`handleAction('start')`)
    expect(source).toContain(`handleAction('stop')`)
  })

  it('TOKEN 只展示服务端脱敏掩码（完整 token 不出 server）', () => {
    expect(source).toContain('status?.tokenMasked')
    expect(source).toContain(`status?.tokenConfigured ? status?.tokenMasked : '未配置'`)
  })

  it('未配置启动命令 → 引导文案 + start 按钮禁用', () => {
    expect(source).toContain('launchCmdConfigured')
    expect(source).toContain('NAPCAT_LAUNCH_CMD')
    expect(source).toContain('未配置启动命令')
    expect(source).toContain('!status?.launchCmdConfigured')
  })

  it('组件卸载后停止轮询（disposed 标志防写已卸载组件的 ref）', () => {
    expect(source).toContain('let disposed = false')
    expect(source).toContain('onUnmounted')
    expect(source).toContain('if (disposed) return false')
    expect(source).toContain('if (!disposed) acting.value = false')
  })
})

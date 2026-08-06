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
  it('进入面板 → onMounted 拉取 GET status + GET config 渲染', () => {
    expect(source).toContain('onMounted(() => {')
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

  it('未配置启动命令 → 引导文案；start 按钮禁用条件含 launchReady', () => {
    expect(source).toContain('launchCmdConfigured')
    expect(source).toContain('NAPCAT_LAUNCH_CMD')
    expect(source).toContain('未配置启动命令')
    expect(source).toContain('!status?.launchReady') // 按钮禁用以「命令就绪」为准（含占位符未配路径也禁用）
  })

  it('组件卸载后停止轮询（disposed 标志防写已卸载组件的 ref）', () => {
    expect(source).toContain('let disposed = false')
    expect(source).toContain('onUnmounted')
    expect(source).toContain('if (disposed) return false')
    expect(source).toContain('if (!disposed) acting.value = false')
  })
})

describe('ConnectorNapCatPanel 启动路径配置', () => {
  it('进入面板 → GET config 回填路径输入框', () => {
    expect(source).toContain('api.getNapcatConfig()')
    expect(source).toContain('napcatPath.value = cfg.napcatPath')
    expect(source).toContain('loadConfig()')
  })

  it('保存按钮 → POST config；成功提示立即生效 + 刷新状态', () => {
    expect(source).toContain('api.saveNapcatConfig')
    expect(source).toContain('已保存，点「启动 NapCat」立即生效')
    expect(source).toContain('await refresh()')
  })

  it('保存失败（400 路径不存在）→ 错误显示', () => {
    expect(source).toContain('pathError')
    expect(source).toContain("err.message || '保存失败'")
  })

  it('手动填写说明——浏览器无法选择本地文件路径（安全沙箱）', () => {
    expect(source).toContain('浏览器无法直接选择本地文件路径')
    expect(source).toContain('.exe / .bat')
  })

  it('占位符未配路径 → 引导「请在下方填写路径」', () => {
    expect(source).toContain('{NAPCAT_PATH}')
    expect(source).toContain('请在下方')
    expect(source).toContain('!status.launchReady')
  })
})

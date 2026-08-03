import { describe, it, expect } from 'vitest'
import { isRestartRequestContent, extractRestartReason } from './restart-request.js'

// ─── 重启请求识别契约（行首命中兼容 + 嵌中命中）──────
// 第六次行首事故根治：agent 回复天然带叙述前文（「收到…请求」合并为一条消息），
// 行首 startsWith 与真实产出模式不匹配——识别放宽为「包含【重启请求】原因：」即命中。

describe('isRestartRequestContent', () => {
  it('嵌中命中：叙述 + 「：【重启请求】原因：」合并消息 → true（agent 真实产出模式）', () => {
    expect(isRestartRequestContent('收到。先自查链路：【重启请求】原因：服务器卡了')).toBe(true)
    expect(extractRestartReason('收到。先自查链路：【重启请求】原因：服务器卡了')).toBe(
      '服务器卡了'
    )
  })

  it('行首「【重启请求】原因：」依然命中（不回归）', () => {
    expect(isRestartRequestContent('【重启请求】原因：测试重启')).toBe(true)
    expect(extractRestartReason('【重启请求】原因：测试重启')).toBe('测试重启')
  })

  it('行首不带原因壳（「【重启请求】重启」）仍命中——行首兼容语义保留', () => {
    expect(isRestartRequestContent('【重启请求】重启')).toBe(true)
    expect(extractRestartReason('【重启请求】重启')).toBe('重启')
  })

  it('复盘文字「【重启请求】嵌在长汇报中间」不含「原因：」→ 不误触发', () => {
    expect(isRestartRequestContent('上次把【重启请求】嵌在长汇报中间，识别失败了')).toBe(false)
  })

  it('非重启消息 → 不命中', () => {
    expect(isRestartRequestContent('你好，处理完了')).toBe(false)
    expect(extractRestartReason('你好，处理完了')).toBe('用户请求')
  })

  it('reason 缺省兜底：空原因 / 原因壳后无内容 → 用户请求', () => {
    expect(extractRestartReason('【重启请求】原因：')).toBe('用户请求')
    expect(extractRestartReason('【重启请求】原因：   ')).toBe('用户请求')
  })

  it('reason 只取到段落行尾（下个换行为止）', () => {
    expect(extractRestartReason('【重启请求】原因：卡住了\n继续汇报其他事')).toBe('卡住了')
  })
})

import { describe, it, expect } from 'vitest'
import source from './ToolRow.vue?raw'

/**
 * ToolRow：ChatPanel 工具行渲染的共享 partial（流式 fold / 历史 segments 交错 /
 * 历史 fold-tool-list 退化三路径抽取的 name/status/io 单源，560ef47 思考框内嵌工具）。
 *
 * 静态源断言（?raw）——回归保护：抽取后行级 io/status/truncated 渲染收在本组件，
 * 若有人改回 ChatPanel 内联复制（双份同步隐患）或弄丢 io 门控/plain 恒纯行语义即拦下。
 */

describe('ToolRow 工具行共享 partial', () => {
  it('io 门控展开：非 plain 且有 io（toolHasIo）→ details 可展开；plain（流式）→ 恒纯行', () => {
    expect(source).toContain('!plain && toolHasIo(tool)')
    expect(source).toContain('v-if="tool.input != null" class="tool-io-block"')
    expect(source).toContain('v-if="tool.output != null" class="tool-io-block"')
  })

  it('name/status/truncated 行级渲染在组件内（toolStatusLabel/icon/name/chevron 单源）', () => {
    expect(source).toContain('function toolStatusLabel(status: string | undefined): string')
    expect(source).toContain('toolStatusLabel(tool.status)')
    expect(source).toContain('class="tool-card-name">{{ tool.name }}')
    expect(source).toContain('v-if="tool.truncated"')
    expect(source).toContain('class="tool-card-truncated"')
    expect(source).toContain(':class="`tool-status-${tool.status}`"')
    expect(source).toContain('class="tool-row-chevron">▶</span>')
    expect(source).toContain('class="tool-row-head tool-row-head-plain"')
  })

  it('行级辅助函数随组件走（toolHasIo/toolLabel/toolIoText/toolRowClass）', () => {
    expect(source).toContain('function toolHasIo(t: ToolCallInfo): boolean')
    expect(source).toContain('function toolLabel(t: ToolCallInfo): string')
    expect(source).toContain('function toolIoText(v: unknown): string')
    expect(source).toContain('function toolRowClass(t: ToolCallInfo): string')
    expect(source).toContain('return t.input != null || t.output != null')
  })

  it('scoped 样式随组件走：工具行卡片/io/状态色/旋转动画类在 ToolRow（ChatPanel 已删内联复制）', () => {
    expect(source).toContain('<style scoped>')
    expect(source).toContain('.tool-row {')
    expect(source).toContain('.tool-row[open] .tool-row-chevron')
    expect(source).toContain('.tool-row-io {')
    expect(source).toContain('.tool-card-truncated {')
    expect(source).toContain('@keyframes toolSpin')
  })

  it('attr（class 等）经 $attrs 落到实际渲染根节点（多根组件不自动透传——流式传 stream-tool-row 仍生效）', () => {
    expect(source).toContain('v-bind="$attrs"')
  })
})

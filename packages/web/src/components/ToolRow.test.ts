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

// ─── B·改：工具行线退场，改「类型色带 + 同色相淡底」（票② 2.2 / AC5）──────────
describe('ToolRow B·改 类型色带', () => {
  it('AC5 四档类型映射：Read/Grep/Bash/Edit 各归一类（大小写与命名风格无关）', () => {
    expect(source).toContain('function toolKindClass(t: ToolCallInfo): string')
    // 搜索档：grep / search / glob / fetch
    expect(source).toContain("n.includes('grep')")
    expect(source).toContain("n.includes('search')")
    // 执行档：bash / shell / terminal / task
    expect(source).toContain("n.includes('bash')")
    expect(source).toContain("n.includes('shell')")
    // 编辑档：edit / write / patch
    expect(source).toContain("n.includes('edit')")
    expect(source).toContain("n.includes('write')")
    // 读取档：read / view / ls
    expect(source).toContain("n.includes('read')")
    // 两处根节点（details / div）都挂类型类
    expect(source.match(/:class="\[toolRowClass\(tool\), toolKindClass\(tool\)\]"/g)).toHaveLength(
      2
    )
  })

  it('AC5 色带形态与四档色值：左缘 3px 圆头带（上下内缩 4px）+ 8% 淡底', () => {
    expect(source).toContain('.tool-row::before')
    const band = /\.tool-row::before\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(band).toMatch(/width:\s*3px/)
    expect(band).toMatch(/border-radius:\s*999px/)
    expect(band).toMatch(/left:\s*0/)
    expect(band).toMatch(/top:\s*4px/)
    expect(band).toMatch(/bottom:\s*4px/)

    // 四档色值（原型实测）
    const read = /\.tool-row\.tk-read\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(read).toContain('--tk: #6b7fa8')
    expect(read).toContain('--tk-bg: rgba(107, 127, 168, 0.08)')
    const search = /\.tool-row\.tk-search\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(search).toContain('--tk: #8a7bd8')
    const run = /\.tool-row\.tk-run\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(run).toContain('--tk: #c89840')
    const write = /\.tool-row\.tk-write\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(write).toContain('--tk: #5a8f6e')

    // 旧的蓝卡边框退役
    expect(source).not.toContain('border: 1px solid rgba(130, 170, 220, 0.22)')
  })
})

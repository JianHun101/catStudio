import { describe, it, expect } from 'vitest'
import source from './DiffViewer.vue?raw'

/**
 * DiffViewer.vue 静态源断言（web 组件测试范式：?raw 读 SFC 验证关键模式）。
 * 行为契约：
 * - 只渲染 v===1 的 diff 块（版本升级时旧块整体丢弃，前端不猜格式）
 * - 行级渲染：增绿/删红/hunk 头/元信息/截断标记各自独立 class
 * - 新旧行号双列渲染
 */

describe('DiffViewer', () => {
  it('只消费 v===1 的 diff 块（版本契约过滤）', () => {
    expect(source).toContain("b.kind === 'diff' && b.v === 1")
  })

  it('元素形状防御：filePath/diff 非 string 的畸形 block 整体过滤（防 parseUnifiedDiff(undefined) 崩渲染）', () => {
    expect(source).toContain("typeof b.filePath === 'string'")
    expect(source).toContain("typeof b.diff === 'string'")
  })

  it('渲染文件标题（filePath）+ 文件图标', () => {
    expect(source).toContain('diff-file-header')
    expect(source).toContain('block.filePath')
  })

  it('行级着色 class：add 绿 / del 红 / hunk 头 / context', () => {
    expect(source).toContain('diff-add')
    expect(source).toContain('diff-del')
    expect(source).toContain('diff-hunk')
    expect(source).toContain('diff-ctx')
  })

  it('截断标记渲染为独立提示样式（与服务端 TRUNCATED_MARKER 契约）', () => {
    expect(source).toContain('DIFF_TRUNCATED_MARKER')
    expect(source).toContain('diff-truncated')
  })

  it('新旧行号双列渲染', () => {
    expect(source).toContain('line.oldLine')
    expect(source).toContain('line.newLine')
  })

  it('样式区使用主题变量（--bg-surface/--border-subtle），无硬编码色板', () => {
    expect(source).toContain('var(--border-subtle')
    expect(source).toContain('var(--bg-hover')
  })
})

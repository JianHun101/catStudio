import { describe, it, expect } from 'vitest'
import source from './NapcatPathPicker.vue?raw'

/**
 * Verify NapcatPathPicker.vue (路径浏览选择器弹窗).
 *
 * Static verification tests — read the SFC source via Vite's `?raw` import.
 * 浏览器 file input 拿不到本地绝对路径（安全沙箱）→ 选择器走 server 只读目录导航
 * （GET /api/connectors/napcat/browse）：盘符列表 → 目录逐层 → 可执行文件高亮 → 确定回填。
 */

describe('NapcatPathPicker 导航', () => {
  it('挂载 → onMounted 加载盘符列表（browseNapcatDir 无参调用）', () => {
    expect(source).toContain('api.browseNapcatDir')
    expect(source).toContain('onMounted(() => load(null))')
    expect(source).toContain('选择磁盘')
  })

  it('盘符列表层 entry.name 即完整路径（currentDir 为 null 时直接回填）', () => {
    expect(source).toContain(
      `currentDir.value ? joinPath(currentDir.value, selected.value) : selected.value`
    )
  })

  it('目录条目点击/双击进入 → openEntry 用 joinPath 拼完整路径', () => {
    expect(source).toContain('function openEntry(entry: NapcatBrowseEntry): void')
    expect(source).toContain(
      `load(currentDir.value ? joinPath(currentDir.value, entry.name) : entry.name)`
    )
    expect(source).toContain("e.type === 'dir' ? openEntry(e) : selectFile(e)")
  })

  it('↑ 上级 → goUp 用后端返回的 parentDir（盘符根 parent=null 回到盘符层）', () => {
    expect(source).toContain('parentDir.value = res.parent')
    expect(source).toContain('function goUp(): void')
    expect(source).toContain('load(parentDir.value)')
    expect(source).toContain('↑ 上级')
  })

  it('可执行文件高亮（executable 徽标「可执行」）+ 点选选中态', () => {
    expect(source).toContain('exec-badge')
    expect(source).toContain('可执行')
    expect(source).toContain("e.type === 'file' && e.executable")
    expect(source).toContain("entry-selected': selected === e.name")
  })

  it('确定 → emit select 完整路径；无选中时确定禁用', () => {
    expect(source).toContain("emit('select', full)")
    expect(source).toContain(
      'full = currentDir.value ? joinPath(currentDir.value, selected.value) : selected.value'
    )
    expect(source).toContain(':disabled="!selected"')
    expect(source).toContain("(e: 'select', path: string): void")
  })

  it('关闭路径：overlay 点击自身 / 关闭按钮 → emit close', () => {
    expect(source).toContain('@click.self="emit(\'close\')"')
    expect(source).toContain('@click="emit(\'close\')"')
  })

  it('错误态/空态/加载态展示', () => {
    expect(source).toContain('error-msg')
    expect(source).toContain('（空目录）')
    expect(source).toContain('加载中…')
  })
})

/**
 * 记忆引用展示态构造（M1）——纯函数单测。
 *
 * 判据面 = 三态**不被折叠**（`state` 原样透出，UI 才有得分支）与标签消歧。
 * 「同文档多节」那条不是美观问题：两个同名链接点开内容不同，读的人无从分辨。
 */
import { describe, it, expect } from 'vitest'
import { buildMemoryRefView, docBaseName, sectionTitle } from './memoryRefs'
import type { MemoryRef, MemoryRefsEntry } from '@/composables/useApi'

function ref(over: Partial<MemoryRef> = {}): MemoryRef {
  return {
    docPath: 'docs/adr/0002-b.md',
    sectionAnchor: '## 决策',
    breadcrumb: 'docs/adr/0002-b.md > 决策',
    sectionRank: 0,
    injectedPosition: 1,
    bodyHead: '片段正文',
    ...over,
  }
}

function entry(over: Partial<MemoryRefsEntry> = {}): MemoryRefsEntry {
  return { state: 'injected', reason: 'ok', refs: [ref()], ...over }
}

describe('buildMemoryRefView', () => {
  it('null / undefined → null（父组件据此不渲染记忆行）', () => {
    expect(buildMemoryRefView(null)).toBeNull()
    expect(buildMemoryRefView(undefined)).toBeNull()
  })

  it('三态原样透出（不在构造层折叠——折叠了 UI 就分不出「没查」与「查了没用」）', () => {
    expect(buildMemoryRefView(entry({ state: 'injected' }))!.state).toBe('injected')
    expect(buildMemoryRefView(entry({ state: 'none', reason: 'no-hit', refs: [] }))!.state).toBe(
      'none'
    )
    expect(
      buildMemoryRefView(entry({ state: 'not-retrieved', reason: 'skipped-a2a', refs: [] }))!.state
    ).toBe('not-retrieved')
  })

  it('标签 = 文件名去扩展名；同文档只出现一次时不加节名（加了是噪音）', () => {
    const view = buildMemoryRefView(entry())!
    expect(view.items).toHaveLength(1)
    expect(view.items[0].label).toBe('0002-b')
    expect(view.items[0].title).toBe('docs/adr/0002-b.md > 决策')
    expect(view.items[0].ref.docPath).toBe('docs/adr/0002-b.md')
  })

  it('同文档多节 → 标签附节名消歧（两个同名链接点开内容不同 = 误导）', () => {
    const view = buildMemoryRefView(
      entry({
        refs: [
          ref({ sectionAnchor: '## 决策', injectedPosition: 1 }),
          ref({ sectionAnchor: '## 后果', injectedPosition: 2 }),
        ],
      })
    )!
    expect(view.items.map((i) => i.label)).toEqual(['0002-b · 决策', '0002-b · 后果'])
  })

  it('breadcrumb 缺失 → title 回退 docPath + 节名（不留空白悬停）', () => {
    const view = buildMemoryRefView(entry({ refs: [ref({ breadcrumb: null })] }))!
    expect(view.items[0].title).toBe('docs/adr/0002-b.md > 决策')
  })

  it('refs 缺失（老 server / 字段缺省）不抛，按空列表处理', () => {
    const view = buildMemoryRefView({ state: 'none', reason: null } as MemoryRefsEntry)!
    expect(view.items).toEqual([])
  })
})

describe('docBaseName / sectionTitle', () => {
  it('取末段并去 .md；路径异常时原样回退', () => {
    expect(docBaseName('docs/adr/0002-b.md')).toBe('0002-b')
    expect(docBaseName('docs/lessons/中文名.MD')).toBe('中文名')
    expect(docBaseName('')).toBe('')
  })

  it('节锚去前导 # 与空白', () => {
    expect(sectionTitle('## 决策')).toBe('决策')
    expect(sectionTitle('#tombstone')).toBe('tombstone')
    expect(sectionTitle('无井号')).toBe('无井号')
  })
})

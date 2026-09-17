/**
 * useSkillCommand 测试 — 斜杠补全的纯逻辑面（数据源 mock 掉，只测本模块）。
 *
 * 重点是**Enter 直通契约**：无候选项时 `navigate('Enter')` 必须返回 null 且不产生
 * 副作用——调用方（ChatPanel.onKeydown）据此不 preventDefault，事件落到发送分支。
 * 07af101 的病灶就是这条被破坏（下拉恒空时吞掉斜杠消息的 Enter）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSkillCommand } from './useSkillCommand'
import type { SkillEntry } from './useApi'

const { mockGetSkills } = vi.hoisted(() => ({ mockGetSkills: vi.fn() }))
vi.mock('./useApi', () => ({ api: { getSkills: mockGetSkills } }))

const SKILLS: SkillEntry[] = [
  { name: 'implement', description: '实施一个已定稿的票', category: '外部技能' },
  { name: 'to-spec', description: '把需求写成规格', category: '外部技能' },
  { name: 'on-site-project', description: '驻场方法论', category: '驻场方法论' },
]

/** 起一个已装载清单的实例（detect 触发懒加载 → 等微任务队列排空） */
async function loaded() {
  const c = useSkillCommand()
  c.detect('/imp', 4)
  await new Promise((r) => setTimeout(r, 0))
  return c
}

beforeEach(() => {
  mockGetSkills.mockReset()
  mockGetSkills.mockResolvedValue({ ok: true, skills: SKILLS })
})

describe('useSkillCommand detect', () => {
  it('行首 / 与空白后的 / 激活；词中的 / 不激活', () => {
    const c = useSkillCommand()
    c.detect('/abc', 4)
    expect(c.skillActive.value).toBe(true)

    c.detect('hello /abc', 10)
    expect(c.skillActive.value).toBe(true)

    c.detect('a/b', 3)
    expect(c.skillActive.value).toBe(false)
  })

  it('查询串不含空白——打空格即退出补全态', () => {
    const c = useSkillCommand()
    c.detect('/implement ', 11)
    expect(c.skillActive.value).toBe(false)
  })

  it('向前扫到最近的 / 为止（前面的内容不参与查询串）', async () => {
    const c = await loaded()
    c.detect('帮我用 /to', 7)
    expect(c.skillActive.value).toBe(true)
    expect(c.skillQuery.value).toBe('to')
    expect(c.skillSuggestions.value.map((s) => s.name)).toEqual(['to-spec'])
  })
})

describe('useSkillCommand 候选项', () => {
  it('空查询列全部；有查询按子串过滤', async () => {
    const c = await loaded()
    c.detect('/', 1)
    expect(c.skillSuggestions.value).toHaveLength(3)
    c.detect('/imp', 4)
    expect(c.skillSuggestions.value.map((s) => s.name)).toEqual(['implement'])
  })

  it('上下键在候选区间内移动，不越界', async () => {
    const c = await loaded()
    c.detect('/', 1)
    c.navigate('ArrowUp', '', 0)
    expect(c.skillIndex.value).toBe(0)
    c.navigate('ArrowDown', '', 0)
    expect(c.skillIndex.value).toBe(1)
    c.navigate('ArrowDown', '', 0)
    c.navigate('ArrowDown', '', 0)
    expect(c.skillIndex.value).toBe(2) // 3 条候选，封顶 2
  })
})

describe('useSkillCommand 补全与直通', () => {
  it('Enter 有候选项 → 补成 /name （尾随空格）并关闭下拉', async () => {
    const c = await loaded()
    c.detect('/imp', 4)
    const result = c.navigate('Enter', '/imp', 4)
    expect(result).toBe('/implement ')
    expect(c.skillActive.value).toBe(false)
  })

  it('Tab 与 Enter 同效', async () => {
    const c = await loaded()
    c.detect('/to', 3)
    expect(c.navigate('Tab', '/to', 3)).toBe('/to-spec ')
  })

  it('补全保留 / 之前的正文与光标之后的内容', async () => {
    const c = await loaded()
    c.detect('先看 /to', 7)
    expect(c.navigate('Enter', '先看 /to', 7)).toBe('先看 /to-spec ')
  })

  it('**无候选项时 Enter 返回 null 且不抛**（07af101 回归闸：事件必须落到 handleSend）', async () => {
    const c = await loaded()
    c.detect('/zzz', 4)
    expect(c.skillSuggestions.value).toHaveLength(0)
    expect(c.navigate('Enter', '/zzz', 4)).toBeNull()
    expect(c.navigate('Tab', '/zzz', 4)).toBeNull()
    // 未补全 → 下拉仍开着（无「无匹配」空态由调用方渲染），但没有任何文本被改写
    expect(c.skillActive.value).toBe(true)
  })

  it('下拉未激活时 Enter 同样直通', () => {
    const c = useSkillCommand()
    expect(c.navigate('Enter', '普通消息', 4)).toBeNull()
  })

  it('Escape 关闭下拉且不改文本', async () => {
    const c = await loaded()
    c.detect('/imp', 4)
    expect(c.navigate('Escape', '/imp', 4)).toBeNull()
    expect(c.skillActive.value).toBe(false)
  })
})

describe('useSkillCommand 取数降级', () => {
  it('清单拉取失败 → 不抛、下拉无候选、skillsLoaded 保持 false（兜底提示接管）', async () => {
    mockGetSkills.mockRejectedValue(new Error('network down'))
    const c = useSkillCommand()
    c.detect('/imp', 4)
    await new Promise((r) => setTimeout(r, 0))
    expect(c.skillsLoaded.value).toBe(false)
    expect(c.skillSuggestions.value).toHaveLength(0)
    expect(c.skillActive.value).toBe(true)
  })

  it('成功后再次 detect 不重复取数', async () => {
    const c = await loaded()
    c.detect('/', 1)
    c.detect('/im', 3)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockGetSkills).toHaveBeenCalledTimes(1)
  })
})

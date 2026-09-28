import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import SubNav from './SubNav.vue'
import source from './SubNav.vue?raw'
import designTokens from '../../index.html?raw'

/**
 * SubNav 行为契约（T5 §二A：设置页与评估中心共用的二级导航）。
 *
 * 它承载的三条口径各自只有一个表述点，消费方（SettingsView / EvaluationView）不再复述：
 * · 宽度 148px —— 用户两轮反馈后的裁决值（原型 v6 的 188px 被嫌宽）
 * · 激活态由 `modelValue` 单源决定，点击 emit `update:modelValue` 带该 item 的 key
 * · badge 仅 > 0 时渲染（评估「回标」的待回标数）
 * · 图标走 `#icon` 具名 slot：传了才渲染（设置页三个线框 SVG），不传即纯文字导航（评估页五 tab）
 */

const ITEMS = [
  { key: 'a', label: '观察' },
  { key: 'b', label: '回标', badge: 3 },
  { key: 'c', label: '标注' },
]

describe('SubNav 静态源（?raw）', () => {
  it('宽度 148px —— 本组件的唯一表述点，消费方不复述', () => {
    const rule = source.match(/\.sub-nav\s*\{[\s\S]*?\}/)
    expect(rule, '未找到 .sub-nav 规则').toBeTruthy()
    expect(rule![0]).toContain('width: 148px')
  })

  it('激活态沿用原型口径（accent-soft 浅色块 + 文字加深）', () => {
    expect(source).toContain('.sub-nav-item.active')
    expect(source).toContain('var(--accent-soft)')
  })

  it('T6 父标题规格 = 原型 v6 `.nav-t`（11px / 700 / .08em / faint 档色 / 内边距 10 10 6）', () => {
    const rule = source.match(/\.sub-nav-title\s*\{[\s\S]*?\}/)
    expect(rule, '未找到 .sub-nav-title 规则').toBeTruthy()
    expect(rule![0]).toContain('font-size: 11px')
    expect(rule![0]).toContain('font-weight: 700')
    expect(rule![0]).toContain('letter-spacing: 0.08em')
    // 内边距是**对齐关系**而不是观感值：容器 10px + 自身 10px = 20px，与 `.sub-nav-item`
    // 的文案左缘（容器 10px + item padding 10px）严格同位。改这里即标题相对导航项错开。
    expect(rule![0]).toContain('padding: 10px 10px 6px')
    const item = source.match(/\.sub-nav-item\s*\{[\s\S]*?\}/)
    expect(item, '未找到 .sub-nav-item 规则').toBeTruthy()
    expect(item![0], '导航项横向内边距须与标题同位前提一致').toContain('padding: 8px 10px')
  })

  it('色板零新增：本组件引用的 CSS 变量都在 index.html 有定义', () => {
    // 原型 v6 的父标题用 `--text-faint`，本仓 index.html **没有这个变量**——照抄规格
    // 字面量不报错、不告警，只静默失效（颜色回落继承值，与相邻元素同色 ⇒ 父标题形同消失）。
    // 这是 T6 票面逐字给出的样式规格里唯一的暗坑，故把 T3 在 SettingsView 立的同款守卫
    // 也搬到本组件：SubNav 是独立 SFC，那道守卫扫不到它。
    const defined = new Set([...designTokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    const missing = [...used].filter((v) => !defined.has(v))
    expect(missing, `引用了 index.html 未定义的 CSS 变量：${missing.join(', ')}`).toEqual([])
  })
})

describe('SubNav 行为', () => {
  it('渲染 items 文案；激活项由 modelValue 单源决定（含 aria-current）', () => {
    const w = mount(SubNav, { props: { items: ITEMS, modelValue: 'b' } })
    const btns = w.findAll('.sub-nav-item')
    expect(btns.map((b) => b.text())).toEqual(['观察', '回标3', '标注'])
    expect(btns[1]!.classes()).toContain('active')
    expect(btns[0]!.classes()).not.toContain('active')
    expect(btns[1]!.attributes('aria-current')).toBe('page')
    expect(btns[0]!.attributes('aria-current')).toBeUndefined()
  })

  it('点击 emit update:modelValue 带该 item 的 key（v-model 靠它写回激活态）', async () => {
    const w = mount(SubNav, { props: { items: ITEMS, modelValue: 'a' } })
    await w.findAll('.sub-nav-item')[2]!.trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['c']])
  })

  it('badge 仅在 > 0 时渲染：0 与缺省都不占位（原 v-if="pendingBadge > 0" 同口径）', () => {
    const zero = mount(SubNav, {
      props: { items: [{ key: 'x', label: '回标', badge: 0 }], modelValue: 'x' },
    })
    expect(zero.find('.sub-nav-badge').exists()).toBe(false)
    const three = mount(SubNav, { props: { items: ITEMS, modelValue: 'a' } })
    expect(three.find('.sub-nav-badge').text()).toBe('3')
  })

  it('图标走 #icon slot：不传则整列无图标（评估页五 tab 的形态）', () => {
    const plain = mount(SubNav, { props: { items: ITEMS, modelValue: 'a' } })
    expect(plain.find('svg').exists()).toBe(false)

    const withIcon = mount(SubNav, {
      props: { items: ITEMS, modelValue: 'a' },
      slots: { icon: () => h('svg', { class: 'nav-icon' }) },
    })
    expect(withIcon.findAll('svg.nav-icon').length).toBe(3)
  })

  it('aria-label 落在 nav 地标上（一个页面里可能有多个 nav）', () => {
    const w = mount(SubNav, { props: { items: ITEMS, modelValue: 'a', label: '评估分类' } })
    expect(w.find('nav').attributes('aria-label')).toBe('评估分类')
  })

  it('父标题三态：传则渲染且先于导航项；不传 / 空串都不渲染（评估页零 diff 的保证）', () => {
    const withTitle = mount(SubNav, {
      props: { items: ITEMS, modelValue: 'a', title: '设置' },
    })
    const title = withTitle.find('.sub-nav-title')
    expect(title.exists()).toBe(true)
    expect(title.text()).toBe('设置')
    // 独占一行且在导航项**上方**：Tab 序与视觉序一致（DOM 里先于第一个按钮）
    const nav = withTitle.find('nav').element
    expect(nav.firstElementChild?.className).toBe('sub-nav-title')
    expect(nav.children[1]!.className).toContain('sub-nav-item')

    // 缺省不渲染——评估中心五 tab 的形态，加了 prop 也不该凭空多一行
    const absent = mount(SubNav, { props: { items: ITEMS, modelValue: 'a' } })
    expect(absent.find('.sub-nav-title').exists()).toBe(false)
    // 空串等同于未传（`v-if` 判真值）：调用方传 `title=""` 不应渲染空行占位
    const blank = mount(SubNav, { props: { items: ITEMS, modelValue: 'a', title: '' } })
    expect(blank.find('.sub-nav-title').exists()).toBe(false)
  })
})

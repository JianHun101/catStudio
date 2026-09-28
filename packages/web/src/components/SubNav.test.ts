import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import SubNav from './SubNav.vue'
import source from './SubNav.vue?raw'

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
})

// @vitest-environment jsdom
// 挂载测试需要 DOM。文件级环境注释——根配置 environment 为默认 node。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import source from './AgentSettingsDrawer.vue?raw'
import modalSource from './AgentEditModal.vue?raw'
import AgentSettingsDrawer from './AgentSettingsDrawer.vue'
import { useChatStore } from '@/stores/chat'
import type { AgentConfig } from '@cat-study/shared'

/**
 * 猫咪设置抽屉（R4 屏③）。
 *
 * 本文件的主要价值不是「抽屉能渲染」，而是**对拍护栏**：抽屉与 `AgentEditModal`
 * 是两份表单（拆分会让 AgentEditModal 的 `?raw` 断言红，票面不许 —— 见组件头注释），
 * 两份拷贝的必然结局是漂移。故这里直接拿两份源码对拍：
 *   字段 label 集合 / 分组标题集合 / 供应商选项值集合 / 推理深度选项值集合 /
 *   头像选项集合 / 保存 payload 键 —— 任一侧加字段漏改另一侧，这里就红。
 *
 * 这不能替代「共用一份表单体」的架构收益，但能把漂移从「静默」变成「响亮的红」——
 * 与 B2 形态选型同一条理由（漏排一条要吵，别静默）。
 */

/** 取 `<label>X</label>` 文案集合 */
function labels(src: string): string[] {
  return [...src.matchAll(/<label>([^<]+)<\/label>/g)].map((m) => m[1].trim()).sort()
}

/** 取分组标题集合（`.form-section-title`） */
function sectionTitles(src: string): string[] {
  return [...src.matchAll(/class="form-section-title">([^<]+)</g)].map((m) => m[1].trim()).sort()
}

/** 取 `const X = [ ... ]` 数组块 */
function arrayBlock(src: string, name: string): string {
  return new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`).exec(src)?.[1] ?? ''
}

function providerValues(src: string): string[] {
  return [...arrayBlock(src, 'providerOptions').matchAll(/value: '([^']+)'/g)]
    .map((m) => m[1])
    .sort()
}

function effortValues(src: string): string[] {
  return [...arrayBlock(src, 'effortOptions').matchAll(/value: '([^']+)'/g)].map((m) => m[1]).sort()
}

function avatarValues(src: string): string[] {
  return [...arrayBlock(src, 'avatarOptions').matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('AgentSettingsDrawer ↔ AgentEditModal 对拍护栏（防两份表单漂移）', () => {
  it('字段 label 逐项一致（加字段只改一边 → 这里红）', () => {
    expect(labels(source)).toEqual(labels(modalSource))
    // 反例对照：抽取函数真能取到东西（空数组对空数组也会「相等」= 恒真假绿）
    expect(labels(source).length).toBeGreaterThanOrEqual(10)
    expect(labels(source)).toContain('Max Tokens（单次输出上限）')
    expect(labels(source)).toContain('额外环境变量 (JSON)')
  })

  it('分组标题逐项一致', () => {
    expect(sectionTitles(source)).toEqual(sectionTitles(modalSource))
    expect(sectionTitles(source)).toContain('LLM 配置')
    expect(sectionTitles(source)).toContain('角色设定 (System Prompt)')
  })

  it('供应商 / 推理深度 / 头像 三个选项集合逐项一致', () => {
    expect(providerValues(source)).toEqual(providerValues(modalSource))
    expect(effortValues(source)).toEqual(effortValues(modalSource))
    expect(avatarValues(source)).toEqual(avatarValues(modalSource))
    // 反例对照：集合非空且含后加的 provider（防「两边都漏了 opencode」也算过）
    expect(providerValues(source)).toContain('opencode')
    expect(providerValues(source)).toContain('dsh')
    expect(providerValues(source)).toContain('ollama')
    expect(avatarValues(source).length).toBe(15)
  })

  it('保存 payload 键集合一致（少传一个字段 = 后端静默保留旧值）', () => {
    const KEYS = [
      'name: name.value',
      'avatar: avatar.value',
      'systemPrompt: systemPrompt.value',
      'llmProvider: llmProvider.value',
      'llmModel: llmModel.value',
      'llmApiKey: llmApiKey.value',
      'llmBaseUrl: llmBaseUrl.value',
      'effortLevel: llmEffortLevel.value',
      'llmMaxTokens: Number(llmMaxTokens.value)',
      'llmTemperature: Number(llmTemperature.value)',
      'llmEnvExtra: llmEnvExtra.value',
    ]
    for (const k of KEYS) {
      expect(source).toContain(k)
      expect(modalSource).toContain(k)
    }
    // 回归护栏（AgentEditModal.test.ts 的同款病）：空串必须原样传，
    // `|| undefined` 会被 JSON 序列化丢掉、后端 partial-update 跳过 ⇒ Base URL 清不掉
    expect(source).not.toContain('llmBaseUrl: llmBaseUrl.value || undefined')
  })

  it('前端校验判据与 AgentEditModal 同源（maxTokens 1..131072 / 温度 0..2）', () => {
    for (const src of [source, modalSource]) {
      expect(src).toContain('validateRuntimeConfig')
      expect(src).toContain('maxTokens < 1 || maxTokens > 131072')
      expect(src).toContain('temp < 0 || temp > 2')
      expect(src).toContain('Max Tokens 必须是 1~131072 的整数')
      expect(src).toContain('温度必须是 0~2 之间的小数')
    }
  })

  it('抽屉形态：360px 宽、右侧贴边（R4 屏③ 形态值）', () => {
    const drawerCss = /\.drawer\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(drawerCss).toMatch(/width:\s*360px/)
    const overlayCss = /\.drawer-overlay\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(overlayCss).toMatch(/justify-content:\s*flex-end/) // 从右边缘滑出
    // 表单体自己滚动，头/脚常驻（长 System Prompt 不会把按钮顶出视口）
    expect(/\.drawer-body\s*\{([^}]*)\}/.exec(source)?.[1] ?? '').toMatch(/overflow-y:\s*auto/)
  })
})

describe('AgentSettingsDrawer 挂载（保存闭环 / 校验拦截）', () => {
  const agent = {
    id: 'a1',
    name: 'ds猫',
    avatar: '🐯',
    systemPrompt: '你是猫咖的实现猫。',
    llmProvider: 'claude',
    llmModel: 'deepseek-flash',
    llmApiKey: '',
    llmBaseUrl: '',
    effortLevel: 'high',
    llmMaxTokens: 2048,
    llmTemperature: 0.7,
    llmEnvExtra: '{}',
    role: 'implementer',
  } as unknown as AgentConfig

  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    vi.clearAllMocks()
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function mountDrawer(a: AgentConfig | null = agent) {
    return mount(AgentSettingsDrawer, {
      props: { agent: a },
      global: { plugins: [pinia] },
    })
  }

  it('agent 为 null 时不渲染（抽屉关闭态）', () => {
    const wrapper = mountDrawer(null)
    expect(wrapper.find('.drawer').exists()).toBe(false)
    expect(wrapper.find('.drawer-overlay').exists()).toBe(false)
  })

  it('从 agent 回填全部字段（含缺省 2048 / 0.7 / {}）', async () => {
    const wrapper = mountDrawer()
    expect((wrapper.find('input[type="text"]').element as HTMLInputElement).value).toBe('ds猫')
    expect(wrapper.find('.drawer-sub').text()).toContain('claude / deepseek-flash')
    expect(wrapper.find('.drawer-sub').text()).toContain('effort high')
    // 头像 picker 选中态跟着 agent 走
    expect(wrapper.findAll('.avatar-option.selected').map((b) => b.text())).toEqual(['🐯'])
    wrapper.unmount()
  })

  it('保存：校验通过 → store.updateAgent 收到完整 payload → emit close', async () => {
    const store = useChatStore()
    const spy = vi.spyOn(store, 'updateAgent').mockResolvedValue(undefined as never)
    const wrapper = mountDrawer()

    await wrapper.find('.btn-ok').trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('a1')
    expect(spy.mock.calls[0][1]).toMatchObject({
      name: 'ds猫',
      llmProvider: 'claude',
      llmMaxTokens: 2048,
      llmTemperature: 0.7,
      llmEnvExtra: '{}',
    })
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('校验拦截：Max Tokens 越界 → 不发请求 + 显式报错（不白屏）', async () => {
    const store = useChatStore()
    const spy = vi.spyOn(store, 'updateAgent').mockResolvedValue(undefined as never)
    const wrapper = mountDrawer()

    await wrapper.find('input[type="number"]').setValue(999999)
    await wrapper.find('.btn-ok').trigger('click')
    await flushPromises()

    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.find('.error-msg').text()).toContain('1~131072')
    expect(wrapper.emitted('close')).toBeFalsy()
    wrapper.unmount()
  })

  it('保存失败 → 错误提示可见且不关闭（样本不丢）', async () => {
    const store = useChatStore()
    vi.spyOn(store, 'updateAgent').mockRejectedValue(new Error('服务器错误：保存失败'))
    const wrapper = mountDrawer()

    await wrapper.find('.btn-ok').trigger('click')
    await flushPromises()

    expect(wrapper.find('.error-msg').text()).toContain('保存失败')
    expect(wrapper.emitted('close')).toBeFalsy()
    wrapper.unmount()
  })
})

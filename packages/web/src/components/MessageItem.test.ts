import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import source from './MessageItem.vue?raw'
import MessageItem from './MessageItem.vue'
import { useChatStore } from '@/stores/chat'
import { renderMarkdown } from '@/utils/markdown'
import type { Message } from '@cat-study/shared'

// 计数桩：折叠块 thinking 段的 markdown 只应在「内容变化」时算一次——
// 收起时一次都不算（L2），展开后不因无关 prop 变化重算（L3 改 computed）。
vi.mock('@/utils/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/markdown')>()
  return { ...actual, renderMarkdown: vi.fn((text: string) => `<p>${text}</p>`) }
})

const AGENT_MSG: Message = {
  id: 'm1',
  sessionId: 's1',
  agentId: 'a1',
  role: 'agent',
  content: '最终正文',
  mentions: [],
  thinkingContent: '历史思考正文',
  toolContent: [{ id: 't1', name: 'Bash', status: 'completed' }],
  segments: [
    { kind: 'thinking', content: '历史思考正文' },
    { kind: 'tool', content: '', tool: { id: 't1', name: 'Bash', status: 'completed' } },
    { kind: 'text', content: '最终正文' },
  ],
  createdAt: '2026-01-01T00:00:00Z',
}

const USER_MSG: Message = {
  id: 'u1',
  sessionId: 's1',
  agentId: null,
  role: 'user',
  content: '提问',
  mentions: ['ds猫'],
  createdAt: '2026-01-01T00:00:00Z',
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    msg: AGENT_MSG,
    grouped: false,
    isLatestUser: false,
    avatar: '🐱',
    senderName: 'ds猫',
    modelName: 'deepseek-flash',
    tokensText: '12k/128k tokens',
    contextLevel: '' as const,
    execMetaText: null,
    durationText: null,
    timeText: '10:00',
    statusEntries: [],
    restartState: 'none' as const,
    restartConfirming: false,
    retractConfirming: false,
    // M1：默认不渲染记忆行（父组件拿不到数据时的真实形态）；要测该行的用例显式覆盖
    memoryRefs: null,
    ...over,
  }
}

/** 模拟用户点 summary：jsdom 不实现 <details> 的原生开合，手动置 open + 派发 toggle */
async function toggleFold(wrapper: ReturnType<typeof mount>): Promise<void> {
  const details = wrapper.find('details').element as HTMLDetailsElement
  details.open = !details.open
  details.dispatchEvent(new Event('toggle'))
  await nextTick()
}

describe('MessageItem 折叠块（L2：收起不渲染内容体）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(renderMarkdown).mockClear()
  })

  it('默认收起且内容体不在 DOM（历史 thinking 零 parse）', () => {
    const wrapper = mount(MessageItem, { props: baseProps() })
    const details = wrapper.find('details')
    expect(details.exists()).toBe(true)
    expect(details.attributes('open')).toBeUndefined()
    expect(wrapper.find('.stream-fold-body').exists()).toBe(false)
    expect(wrapper.find('.thinking-content').exists()).toBe(false)
    // 收起时折叠块内 thinking 一次都没算（正文 renderMarkdown 不受影响）
    expect(vi.mocked(renderMarkdown).mock.calls.map((c) => c[0])).not.toContain('历史思考正文')
  })

  it('展开后内容体出现（segments 路径：thinking 段 markdown + 工具行走 ToolRow）', async () => {
    const wrapper = mount(MessageItem, { props: baseProps() })
    await toggleFold(wrapper)
    expect(wrapper.find('.stream-fold-body').exists()).toBe(true)
    expect(wrapper.find('.fold-thinking').html()).toContain('<p>历史思考正文</p>')
    expect(
      wrapper.findComponent({ name: 'ToolRow' }).exists() || wrapper.html().includes('tool-row')
    ).toBe(true)
  })

  it('展开后再收起 → 内容体移除、open 属性撤下（受控 open 态双向同步）', async () => {
    const wrapper = mount(MessageItem, { props: baseProps() })
    await toggleFold(wrapper)
    expect(wrapper.find('.stream-fold-body').exists()).toBe(true)
    await toggleFold(wrapper)
    expect(wrapper.find('.stream-fold-body').exists()).toBe(false)
    expect(wrapper.find('details').attributes('open')).toBeUndefined()
  })

  it('老消息（无 segments）退化路径：展开后 thinking blob + 工具列表两块', async () => {
    const legacy: Message = { ...AGENT_MSG, segments: undefined }
    const wrapper = mount(MessageItem, { props: baseProps({ msg: legacy }) })
    expect(wrapper.find('.thinking-content').exists()).toBe(false)
    await toggleFold(wrapper)
    expect(wrapper.find('.thinking-content').exists()).toBe(true)
    expect(wrapper.find('.fold-tool-list').exists()).toBe(true)
    expect(wrapper.find('.stream-fold-body').exists()).toBe(false)
  })

  it('展开态下无关 prop 变化不重算 thinking markdown（computed 缓存，取代手写 markdownCache）', async () => {
    const wrapper = mount(MessageItem, { props: baseProps() })
    await toggleFold(wrapper)
    const afterExpand = vi
      .mocked(renderMarkdown)
      .mock.calls.filter((c) => c[0] === '历史思考正文').length
    expect(afterExpand).toBe(1)
    await wrapper.setProps({ grouped: true })
    await wrapper.setProps({ tokensText: '13k/128k tokens' })
    const afterPropChurn = vi
      .mocked(renderMarkdown)
      .mock.calls.filter((c) => c[0] === '历史思考正文').length
    expect(afterPropChurn).toBe(1)
  })

  it('内容真变（新 msg 引用）才重算 thinking markdown', async () => {
    const wrapper = mount(MessageItem, { props: baseProps() })
    await toggleFold(wrapper)
    const next: Message = {
      ...AGENT_MSG,
      segments: [
        { kind: 'thinking', content: '换了一批思考' },
        { kind: 'text', content: '最终正文' },
      ],
    }
    await wrapper.setProps({ msg: next })
    const calls = vi.mocked(renderMarkdown).mock.calls.map((c) => c[0])
    expect(calls).toContain('换了一批思考')
  })
})

describe('MessageItem 用户消息状态行（停止按钮 / 撤回）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const entry = {
    agentId: 'a1',
    agentName: 'ds猫',
    agentAvatar: '🐱',
    status: 'replying' as const,
  }

  it('无状态行 / 非用户消息 → 状态区不渲染', () => {
    expect(
      mount(MessageItem, { props: baseProps({ msg: USER_MSG, statusEntries: [] }) })
        .find('.msg-agent-status')
        .exists()
    ).toBe(false)
  })

  it('busy 且无流式 → 显示停止按钮；typingStates 有该 agent 时按钮让位给 streaming 气泡', async () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    store.agentStates = new Map([
      [
        'a1',
        new Map([
          ['s1', { agentId: 'a1', sessionId: 's1', status: 'busy', queueLength: 0 } as never],
        ]),
      ],
    ])
    const wrapper = mount(MessageItem, {
      props: baseProps({ msg: USER_MSG, statusEntries: [entry] }),
    })
    expect(wrapper.find('.btn-stop-agent').exists()).toBe(true)

    store.typingStates.set('a1', { messageId: 'x', content: 'c', sessionId: 's1' })
    await nextTick()
    expect(wrapper.find('.btn-stop-agent').exists()).toBe(false)
  })

  it('停止按钮点击 emit stopAgent(agentId)', async () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    store.agentStates = new Map([
      [
        'a1',
        new Map([
          ['s1', { agentId: 'a1', sessionId: 's1', status: 'busy', queueLength: 0 } as never],
        ]),
      ],
    ])
    const wrapper = mount(MessageItem, {
      props: baseProps({ msg: USER_MSG, statusEntries: [entry] }),
    })
    await wrapper.find('.btn-stop-agent').trigger('click')
    expect(wrapper.emitted('stopAgent')).toEqual([['a1']])
  })

  it('占位气泡在屏（replyTimers 有条目）→ 状态行停止按钮让位，不出现两个「停止」', async () => {
    const store = useChatStore()
    store.activeSessionId = 's1'
    store.agentStates = new Map([
      [
        'a1',
        new Map([
          ['s1', { agentId: 'a1', sessionId: 's1', status: 'busy', queueLength: 0 } as never],
        ]),
      ],
    ])
    const wrapper = mount(MessageItem, {
      props: baseProps({ msg: USER_MSG, statusEntries: [entry] }),
    })
    expect(wrapper.find('.btn-stop-agent').exists()).toBe(true)

    // 无流式执行（A2A / headless / 首 chunk 前）：气泡侧渲染占位气泡承载按钮
    store.replyTimers = new Map([
      ['s1:a1', { startedAt: Date.now() - 3_000, lastBeatAt: Date.now() }],
    ])
    await nextTick()
    expect(wrapper.find('.btn-stop-agent').exists()).toBe(false)
  })

  it('状态行不显示秒数（计时唯一权威位 = Agent 气泡 footer 的 ReplyElapsed）', () => {
    // 票②：状态行保留状态文字与停止按钮，秒数上移——A2A / headless 执行没有用户消息
    // 状态行可挂，秒数留在这里就漏一半。entry 即使带全 startedAt/lastBeatAt 也不出秒。
    const wrapper = mount(MessageItem, {
      props: baseProps({
        msg: USER_MSG,
        statusEntries: [{ ...entry, startedAt: Date.now() - 30_000, lastBeatAt: Date.now() }],
      }),
    })
    const row = wrapper.find('.agent-status-row')
    expect(row.text()).toContain('回复中')
    expect(row.text()).not.toContain('秒')
    expect(row.find('.status-label').exists()).toBe(true)
  })

  it('撤回按钮仅在 isLatestUser 时出现，点击 emit retract(msgId)', async () => {
    const wrapper = mount(MessageItem, {
      props: baseProps({ msg: USER_MSG, statusEntries: [entry], isLatestUser: true }),
    })
    expect(wrapper.find('.btn-retract').exists()).toBe(true)
    await wrapper.find('.btn-retract').trigger('click')
    expect(wrapper.emitted('retract')).toEqual([['u1']])
  })
})

describe('MessageItem 重启 / 图片 / diff 委托', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('restart_request pending → 两个按钮 emit confirmRestart / cancelRestart', async () => {
    const wrapper = mount(MessageItem, {
      props: baseProps({
        msg: { ...AGENT_MSG, messageType: 'restart_request' },
        restartState: 'pending',
      }),
    })
    const buttons = wrapper.findAll('.btn-restart')
    expect(buttons).toHaveLength(2)
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('confirmRestart')).toEqual([['m1']])
    expect(wrapper.emitted('cancelRestart')).toEqual([['m1']])
  })

  it('restartConfirming → 「已确认，等待重启…」；confirmed → 「重启中…」', () => {
    const pending = mount(MessageItem, {
      props: baseProps({
        msg: { ...AGENT_MSG, messageType: 'restart_request' },
        restartState: 'pending',
        restartConfirming: true,
      }),
    })
    expect(pending.find('.restart-label').text()).toContain('已确认，等待重启…')
    const confirmed = mount(MessageItem, {
      props: baseProps({
        msg: { ...AGENT_MSG, messageType: 'restart_request' },
        restartState: 'confirmed',
      }),
    })
    expect(confirmed.find('.restart-label').text()).toContain('重启中…')
  })

  it('图片点击 emit previewImages(images, index)', async () => {
    const wrapper = mount(MessageItem, {
      props: baseProps({ msg: { ...AGENT_MSG, images: ['a.png', 'b.png'] } }),
    })
    await wrapper.findAll('.msg-image')[1].trigger('click')
    expect(wrapper.emitted('previewImages')).toEqual([[['a.png', 'b.png'], 1]])
  })
})

// ─── 静态源断言（自 ChatPanel.test.ts 迁入：这些标记已随消息块搬进本组件）──────

describe('MessageItem 结构契约（静态源）', () => {
  it('A2 对应：折叠块判定不再出现在模板里（走 computed），模板不含数组级现算', () => {
    // 折叠块内容体由 computed 驱动（含缓存），模板只消费结果
    expect(source).toContain('v-if="foldEntries" class="stream-fold-body"')
    expect(source).toContain('v-for="(e, ei) in foldEntries"')
    expect(source).toContain('v-html="e.html"')
    // 旧手写缓存机制不复存在（只是文档注释里提到它，代码零残留）
    expect(source).not.toContain('const markdownCache')
    expect(source).not.toContain('markdownCache.')
  })

  it('三处模板判定已上移父组件：模板不再出现 isGrouped / isLatestUserMessage / activeMessages', () => {
    const template = source.slice(source.indexOf('<template>'))
    expect(template).not.toContain('isGrouped(')
    expect(template).not.toContain('isLatestUserMessage(')
    expect(template).not.toContain('activeMessages')
    expect(template).not.toContain('store.messageStatus')
  })

  it('历史消息思考+工具单折叠：thinkingContent 或 toolContent 存在才渲染默认收起 thinking-block（无独立 tool-area）', () => {
    expect(source).toMatch(
      /<details\s+v-if="msg\.thinkingContent \|\| msg\.toolContent\?\.length"\s+class="thinking-block stored-thinking"/
    )
    // 受控 open：默认收起（foldOpen 初值 false）+ toggle 同步
    expect(source).toContain('const foldOpen = ref(false)')
    expect(source).toContain(':open="foldOpen"')
    expect(source).toContain('@toggle="onFoldToggle"')
    expect(source).toContain('class="fold-tool-list"')
    expect(source).not.toContain('class="tool-area"')
  })

  it('历史折叠块工具行渲染抽 ToolRow 共享 partial（退化路径按 msg.toolContent 驱动）', () => {
    expect(source).toContain('<template v-for="(t, ti) in msg.toolContent" :key="ti">')
    expect(source).toContain('<ToolRow :tool="t" />')
    // name/status/io 行级渲染不再在本组件内联复制（单源收在 ToolRow.vue）
    expect(source).not.toContain('toolHasIo(t)')
    expect(source).not.toContain('toolIoText(t.input)')
    expect(source).not.toContain('toolStatusLabel(t.status)')
  })

  it('storedFoldEntries：有 segments 时按时间序产出 thinking/tool 交错条目（tool 按 id join tool_content 补 io、只跳过最后一个 text 段）', () => {
    expect(source).toContain(
      'function computeStoredFoldEntries(msg: Message): StoredFoldEntry[] | null'
    )
    expect(source).toContain('if (!msg.segments?.length) return null')
    expect(source).toContain('const byId = new Map<string, ToolCallInfo>()')
    expect(source).toContain('let lastTextIndex = -1')
    expect(source).toContain('if (i === lastTextIndex) continue')
    expect(source).toContain('full = byId.get(t.id)')
    expect(source).toContain("entries.push({ kind: 'thinking', content: seg.content })")
    expect(source).toContain("entries.push({ kind: 'tool', tool: full ?? t })")
  })

  it('正文走 computed 记忆化：内容 + 相关 agent 名变化才重算（占位符替换依赖 store/reviewer 角色名）', () => {
    expect(source).toContain('const bodyHtml = computed')
    expect(source).toContain(
      'renderMarkdown(resolveDisplayPlaceholders(finalTextContent(props.msg), store.agents))'
    )
    expect(source).toContain('function finalTextContent(msg: Message): string')
    expect(source).toContain("if (s.kind === 'text') return s.content")
    expect(source).toContain('const thinkingHtml = computed')
    expect(source).toContain("tc.includes('[思考]')")
    expect(source).toContain("tc.replace(/\\[思考\\]\\s*/g, '')")
  })

  it('footer：{模型} · {n}k/{m}k tokens（分组消息同样渲染）+ 耗时/execMeta 兜底链', () => {
    expect(source).toContain('class="msg-footer"')
    expect(source).toMatch(/v-if="msg\.role === 'agent' && msg\.agentId"/)
    expect(source).toMatch(/modelName \}\} · \{\{ tokensText/)
    expect(source).toContain('v-if="execMetaText" class="msg-duration"')
    expect(source).toContain('v-else-if="durationText" class="msg-duration"')
    expect(source).not.toContain('stopAgent(msg.agentId)')
  })

  it('system 消息保持原 msg-time 结构（无 footer 行）+ 色阶 class 走标量 prop', () => {
    expect(source).toMatch(/v-else class="msg-time"/)
    expect(source).toContain(':class="contextLevel"')
  })

  it('对话内 diff 展示：extra.rich.blocks 存在才渲染 DiffViewer', () => {
    expect(source).toContain("import DiffViewer from './DiffViewer.vue'")
    expect(source).toContain('v-if="msg.extra?.rich?.blocks?.length"')
    expect(source).toContain(':blocks="msg.extra.rich.blocks"')
  })

  it('状态行：AgentStatusLabel 整条 entry 透传，停止按钮判据下沉本组件（typingStates 不进父渲染依赖）', () => {
    expect(source).toContain("import AgentStatusLabel from './AgentStatusLabel.vue'")
    expect(source).toContain('<AgentStatusLabel :entry="s" />')
    expect(source).not.toContain('statusLabelZh(s.status)')
    expect(source).toContain('!store.typingStates.has(s.agentId)')
    expect(source).toContain('class="agent-status-row"')
    expect(source).toContain('@click.stop="emit(\'stopAgent\', s.agentId)"')
  })

  it('README 语义：C1 硬约束——props 不接收整个消息数组或下标（全标量/稳定引用）', () => {
    const propsBlock = source.slice(
      source.indexOf('defineProps<{'),
      source.indexOf('}>()', source.indexOf('defineProps<{'))
    )
    expect(propsBlock).not.toContain('activeMessages')
    expect(propsBlock).not.toContain('index')
    expect(propsBlock).not.toContain('Message[]')
    // 数组 prop 只有「本条消息自带的状态行」（切片，不是全会话数组）
    expect(propsBlock).toContain('statusEntries: AgentStatusEntry[]')
  })
})

// ─── M1 记忆引用行 ────────────────────────────────────
describe('MessageItem 记忆引用行（M1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function memRef(over: Record<string, unknown> = {}) {
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

  function view(over: Record<string, unknown> = {}) {
    return { state: 'injected', items: [{ label: '0002-b', title: 'T', ref: memRef() }], ...over }
  }

  it('memoryRefs=null → 不渲染记忆行（父组件还没拿到数据时的真实形态）', () => {
    const wrapper = mount(MessageItem, { props: baseProps({ memoryRefs: null }) })
    expect(wrapper.find('.msg-memory-refs').exists()).toBe(false)
  })

  it('有注入 → footer 内一行「📎 记忆 N 条：」+ N 个可点条目', () => {
    const items = [
      { label: '0002-b', title: 't1', ref: memRef() },
      { label: '0007-c', title: 't2', ref: memRef({ docPath: 'docs/adr/0007-c.md' }) },
      { label: '0009-d', title: 't3', ref: memRef({ docPath: 'docs/adr/0009-d.md' }) },
    ]
    const wrapper = mount(MessageItem, { props: baseProps({ memoryRefs: view({ items }) }) })
    const row = wrapper.find('.msg-memory-refs')
    expect(row.exists()).toBe(true)
    // 落在 footer 内（票面 §三：msg-footer 内新增一行）
    expect(wrapper.find('.msg-footer .msg-memory-refs').exists()).toBe(true)
    expect(row.text()).toContain('记忆 3 条')
    const links = row.findAll('.mem-link')
    expect(links).toHaveLength(3)
    expect(links.map((l) => l.text())).toEqual(['0002-b', '0007-c', '0009-d'])
    // 三态只有 injected 才有链接（下两条用例判另两态）
    expect(row.findAll('.mem-muted')).toHaveLength(0)
  })

  it('三态之二「无注入」与之三「未检索」**措辞不同**（使用率的分母口径）', () => {
    const none = mount(MessageItem, {
      props: baseProps({ memoryRefs: { state: 'none', items: [] } }),
    })
    expect(none.find('.msg-memory-refs').text()).toContain('未使用记忆')
    expect(none.find('.mem-link').exists()).toBe(false)

    const notRetrieved = mount(MessageItem, {
      props: baseProps({ memoryRefs: { state: 'not-retrieved', items: [] } }),
    })
    expect(notRetrieved.find('.msg-memory-refs').text()).toContain('未检索记忆')
    expect(notRetrieved.find('.msg-memory-refs').text()).not.toContain('未使用记忆')
  })

  it('用户消息不渲染记忆行（记忆只挂在 agent 回复上，即使父组件误传了视图）', () => {
    const wrapper = mount(MessageItem, { props: baseProps({ msg: USER_MSG, memoryRefs: view() }) })
    expect(wrapper.find('.msg-memory-refs').exists()).toBe(false)
  })

  it('点条目 → emit openMemoryRef（带原始 ref；抽屉归父组件，本组件不碰网络）', async () => {
    const wrapper = mount(MessageItem, { props: baseProps({ memoryRefs: view() }) })
    await wrapper.find('.mem-link').trigger('click')
    const emitted = wrapper.emitted('openMemoryRef') as unknown[][]
    expect(emitted).toHaveLength(1)
    expect((emitted[0][0] as { docPath: string }).docPath).toBe('docs/adr/0002-b.md')
  })

  it('静态源：记忆行只遍历本 prop 内的数组，未新增任何会话级集合遍历（O(1) 契约）', () => {
    const rowBlock = source.slice(
      source.indexOf('class="msg-memory-refs"'),
      source.indexOf('</div>', source.indexOf('class="msg-memory-refs"'))
    )
    expect(rowBlock).toContain('v-for="(item, mi) in memoryRefs.items"')
    expect(rowBlock).not.toContain('activeMessages')
    expect(rowBlock).not.toContain('memoryRefsByMessage')
    // **模板**里不许出现会话级集合（头注里讨论这条契约的那句话不算——判据取模板切片）
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).not.toContain('activeMessages')
    expect(template).not.toContain('memoryRefsByMessage')
  })
})

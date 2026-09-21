import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import source from './ChatPanel.vue?raw'
import statusLabelSource from './AgentStatusLabel.vue?raw'
import ChatPanel from './ChatPanel.vue'
import { useChatStore } from '@/stores/chat'
import { renderMarkdown } from '@/utils/markdown'
import type { Message, StreamSegment } from '@cat-study/shared'

// A1：renderMarkdown 计数桩——按调用次数把「一个 chunk 触发多少条历史消息重算 markdown」
// 钉成机械断言（CPU 密集段：marked.parse + DOMPurify.sanitize）。其余导出保持真实现。
vi.mock('@/utils/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/markdown')>()
  return { ...actual, renderMarkdown: vi.fn(() => '<p>stub</p>') }
})

/**
 * Verify ChatPanel.vue's TransitionGroup animation setup.
 *
 * These are static verification tests — they read the SFC source via Vite's
 * `?raw` import to confirm the expected patterns exist. This provides
 * regression protection against accidental removal of TransitionGroup or
 * transition CSS classes.
 */

describe('ChatPanel animation setup', () => {
  it('uses TransitionGroup with name="msg" in template', () => {
    expect(source).toMatch(/TransitionGroup\s+name="msg"/)
  })

  it('defines .msg-enter-active transition class', () => {
    expect(source).toContain('.msg-enter-active')
  })

  it('defines .msg-enter-from transition class', () => {
    expect(source).toContain('.msg-enter-from')
  })

  it('removed the old @keyframes msg-in animation', () => {
    expect(source).not.toContain('@keyframes msg-in')
  })

  it('removed animation property from .message class', () => {
    // The old `animation: msg-in 0.25s ease-out;` should be gone
    // The .message rule should not contain animation
    const messageBlock = source.match(/\.message\s*\{[^}]*\}/s)
    if (messageBlock) {
      expect(messageBlock[0]).not.toContain('animation:')
    }
  })

  it('has box-shadow: none on .message.system .msg-bubble', () => {
    expect(source).toContain('.message.system .msg-bubble')
    const systemBubbleBlock = source.match(/\.message\.system\s+\.msg-bubble\s*\{[^}]*\}/s)
    if (systemBubbleBlock) {
      expect(systemBubbleBlock[0]).toContain('box-shadow: none')
    }
  })
})

describe('ChatPanel markdown table overflow', () => {
  it('table 溢出逃生通道：msg-text table 规则含 table-layout:fixed + overflow-x: auto + max-width: 100%', () => {
    // 回归保护：table 曾因 width:100% 是建议值（长单元格 min-content 撑破气泡）溢出聊天气泡，
    // 历史经 display:block 逃生（97eee3b），08-08 实测其把 table 降级为块级元素致 td 按内容收缩、
    // 行分隔线右侧断裂空白带（表格右缘 x=868、行线只到 x=761）——改 table-layout:fixed
    // （width:100% 硬约束的正规实现）+ max-width；超宽内容由 overflow-wrap:anywhere 断行吸收，
    // 不可断内容（nowrap 内联块/pre）刺出容器，滚动需外层包裹容器（table 自身 overflow-x 不建滚动容器）
    const tableBlock = source.match(/\.chat-panel \.msg-text table\s*\{[^}]*\}/s)
    expect(tableBlock).toBeTruthy()
    // 根因双锁：正向锁 table-layout:fixed（width:100% 从建议值变硬约束）、
    // 反向锁 display:block 不复辟（重加 display:block 会复发空白带而正向锁全绿）——
    // 只锁正向表征拦不住删 fixed 后回退 display:block（同 10070d1 黑名单断言教训）
    expect(tableBlock![0]).toContain('table-layout: fixed')
    expect(tableBlock![0]).not.toContain('display: block')
    expect(tableBlock![0]).toContain('overflow-x: auto')
    expect(tableBlock![0]).toContain('max-width: 100%')
    // 漂移锁：box-sizing:border-box 防 content-box 下 width:100% + border 1px 溢出 2px，
    // 触发自身 overflow-x:auto → 右缘漂移 + 滚动区空白（13:21 实证根因）
    expect(tableBlock![0]).toContain('box-sizing: border-box')
  })

  it('文本溢出逃生：msg-text 规则含 overflow-wrap: anywhere，pre 覆盖回 normal，td/th 断行', () => {
    // 回归保护：长无断点串（URL/工具名/hash/路径）在普通段落文本中会撑破气泡——
    // code 已有 word-break:break-all 但裸文本无处理（13:21 实证：40+ 字符工具名串溢出）。
    // anywhere 允许任意字符间断行；pre 必须覆盖回 normal（代码块走 overflow-x 滚动不换行）。
    const msgTextBlock = source.match(/\.msg-text\s*\{[^}]*\}/s)
    expect(msgTextBlock).toBeTruthy()
    expect(msgTextBlock![0]).toContain('overflow-wrap: anywhere')
    // pre 规则现为三落点并列组（正文 + 流式思考框 + 历史思考框），故选择器后允许并列项，
    // 锚点仍是「首条 .msg-text pre 规则块」——断言意图不变（代码块覆盖回 normal）
    const preBlock = source.match(/\.chat-panel \.msg-text pre[^{]*\{[^}]*\}/s)
    expect(preBlock).toBeTruthy()
    expect(preBlock![0]).toContain('overflow-wrap: normal')
    const tdBlock = source.match(
      /\.chat-panel \.msg-text th,\s*\n\s*\.chat-panel \.msg-text td\s*\{[^}]*\}/s
    )
    expect(tdBlock).toBeTruthy()
    expect(tdBlock![0]).toContain('overflow-wrap: anywhere')
  })
})

// 重启确认按钮 / 对话内 diff 展示的静态断言已随消息块迁入 MessageItem.test.ts
// （历史气泡的标记不再在 ChatPanel 模板里）。

// 票 J 重建：bf5aab5 拆 SkillLoader 时端点被删、下拉成恒空空壳，07af101 遂剥离补全只留
// 提示文案。本轮重建数据源（端点见 routes/skills.ts，逻辑见 useSkillCommand.ts）。
describe('ChatPanel skill 斜杠补全', () => {
  it('下拉在场：skillSuggestions 驱动 skill-dropdown，项含名字与描述', () => {
    expect(source).toContain('skill-dropdown')
    expect(source).toContain('skillSuggestions')
    expect(source).toContain('selectSkillItem')
    expect(source).toMatch(/v-for="\(skill, idx\) in skillSuggestions"/)
  })

  it('Enter 直通：斜杠键盘分支只在「有候选项」时才 preventDefault（07af101 回归闸）', () => {
    // 旧版无条件 preventDefault 再判断有无候选项，下拉恒空时把斜杠消息的 Enter 一并
    // 吞掉、消息根本发不出去。这里钉死守卫条件本身：无候选项 → 不进 if → 落到 handleSend。
    const keydown = source.match(/function onKeydown[\s\S]*?\n\}/)
    expect(keydown).toBeTruthy()
    expect(keydown![0]).toContain('skillSuggestions.value.length > 0')
    expect(keydown![0]).toMatch(
      /if \(skillActive\.value && \(skillSuggestions\.value\.length > 0 \|\| e\.key === 'Escape'\)\) \{[\s\S]*?e\.preventDefault\(\)/
    )
  })

  it('清单不可用时仍回退 CLI 原生触发提示（端点没取到 ≠ 没这个词）', () => {
    expect(source).toContain('skill 由 CLI 原生触发')
    expect(source).toContain('服务端不再注入')
    expect(source).toContain('skill-tip')
    expect(source).toContain('skillsLoaded')
    expect(source).not.toContain('未找到匹配的技能')
  })

  it('取数走 useApi（不在组件里自造 fetch 死调用）', () => {
    expect(source).not.toContain('fetchSkills')
    expect(source).not.toContain('/api/skills')
  })
})

describe('ChatPanel 右栏 props 清理（B2 删右栏）', () => {
  it('rightSidebarOpen / toggleRightSidebar 已从 props/emits 与模板移除', () => {
    expect(source).not.toContain('rightSidebarOpen')
    expect(source).not.toContain('toggleRightSidebar')
    expect(source).not.toContain('收起 Agent 面板')
  })
})

describe('ChatPanel 气泡 footer（模型 + tokens 用量——B2 措辞改）', () => {
  // footer 标记本体已随消息块迁入 MessageItem.vue（静态断言见 MessageItem.test.ts）；
  // 这里保留的是 footer 数据源（模型/tokens/execMeta 文案）在父组件的口径。

  it('tokens 文案：m = maxContextTokens（上下文窗口数，非 llm_max_tokens 单次输出上限）', () => {
    expect(source).toContain('function tokensTextFor(agentId: string): string')
    expect(source).toContain('store.contextTokens.get(agentId) ?? 0')
    expect(source).toContain('maxTokensFor(agentId)')
    expect(source).toContain('tokens')
    expect(source).toContain('不是 llm_max_tokens（单次输出上限 2048）')
    // 旧措辞「窗口 {pct}%」已移除
    expect(source).not.toContain('窗口 {{ contextPctFor(msg.agentId) }}%')
  })

  it('旧版停止按钮已从历史气泡 footer 移除（B2 重定位到 streaming/状态行）', () => {
    expect(source).not.toContain('stopAgent(msg.agentId)')
  })

  it('执行元数据（execution_logs 落库稳定耗时/token）优先展示，durationMs 降为无 meta 时兜底', () => {
    // 稳定 meta 分支（v-if）在 durationMs 之前；durationMs 保留为 v-else-if 兜底（execution 未拉取时新回复短暂可显）
    expect(source).toContain('function execMetaFor(msg')
    expect(source).toContain('store.sessionExecutions.get(msg.id)')
    expect(source).toContain('function execMetaTextFor(msg')
    expect(source).toContain('meta.latencyMs != null')
    expect(source).toContain('fmtTokens(inTok ?? 0)')
    // 两条分支的文案各算一次后随视图模型下发（MessageItem 只做展示）
    expect(source).toContain('execMetaText: execMetaTextFor(msg)')
    expect(source).toContain(
      'durationText: msg.durationMs != null ? `耗时 ${formatDuration(msg.durationMs)}` : null'
    )
    expect(source).toContain('function formatDuration(ms: number): string')
  })
})

describe('ChatPanel 停止按钮重定位（B2——正在思考的气泡 / busy 无流式时的用户消息状态行）', () => {
  it('streaming 气泡 footer 有停止按钮：@click.stop + canStopAgent 守卫（正在思考时）', () => {
    expect(source).toMatch(
      /v-if="canStopAgent\(agentId\)"[\s\S]{0,120}class="btn-stop-agent"[\s\S]{0,140}@click\.stop="stopAgent\(agentId\)"/
    )
    // OQ3 双端 session 化：stopAgent 传当前会话 sessionId（精确中断目标会话）
    expect(source).toContain('store.interruptAgent(agentId, store.activeSessionId ?? undefined)')
  })

  // 用户消息状态行（agent-status-row / 停止按钮）已随消息块迁入 MessageItem.vue——
  // 静态断言与行为断言见 MessageItem.test.ts。这里只留 streaming 气泡侧。

  it('streaming 气泡每 agent 唯一（v-for activeTypingStates）——无分组问题；footer info 守卫已移除（分组消息同样渲染 footer）', () => {
    expect(source).toContain('v-for="[agentId, typing] in activeTypingStates"')
    expect(source).toContain('key="\'streaming-\' + agentId"')
    // 守卫已移除：旧形式 `agentId && !isGrouped(i)` 不再出现（防回归锚定）
    expect(source).not.toMatch(/agentId && !isGrouped\(i\)/)
  })
})

describe('ChatPanel 80% 告警横幅（阈值来自配置）', () => {
  it('横幅渲染条件：warnedAgents.length > 0，role=alert', () => {
    expect(source).toContain('class="context-warning-banner"')
    expect(source).toContain('v-if="warnedAgents.length"')
    expect(source).toContain('role="alert"')
  })

  it('横幅 sticky 固定可见：position: sticky + top: 0 + z-index + 实底背景（滚动后贴顶，不滚动仍在消息流最顶）', () => {
    // 静态源断言锚定 sticky 实现（同文件既有 ?raw 范式）；背景实底防滚动文字透出
    expect(source).toMatch(/\.context-warning-banner[\s\S]{0,160}position: sticky/)
    expect(source).toMatch(/position: sticky;\s*top: 0;\s*z-index: 10/)
    expect(source).toMatch(/\.context-warning-banner[\s\S]{0,300}var\(--bg-deep\)/)
  })

  it('横幅文案含告警线/交接线占位（warnThreshold/handoffThreshold 来自 store.contextConfig）', () => {
    expect(source).toContain('store.contextConfig.warnThreshold')
    expect(source).toContain('store.contextConfig.handoffThreshold')
    expect(source).toContain('告警线')
    expect(source).toContain('交接触发线')
  })

  it('色阶：>= 交接线红、>= 告警线黄（contextLevelFor 算成标量 prop 下发）', () => {
    expect(source).toContain("return 'critical'")
    expect(source).toContain("return 'warn'")
    // 判定在父组件算一次（contextLevel 进视图模型），MessageItem 只消费标量
    expect(source).toContain('contextLevel: agentId ? contextLevelFor(agentId) : ')
    expect(source).toContain('.msg-footer-info.warn')
    expect(source).toContain('.msg-footer-info.critical')
  })

  it('横幅/色阶阈值不写死 0.7/0.9（配置失败才回退默认 0.8/0.9）', () => {
    // 旧的 0.7/0.9 写死色阶已随 AgentPanel 删除；新判定走 store.contextConfig
    expect(source).not.toMatch(/r >= 0\.7/)
    expect(source).not.toMatch(/r >= 0\.9/)
  })
})

describe('ChatPanel 交接失败横幅（HANDOFF_FAILED 可见化——单 A server 契约）', () => {
  it('横幅渲染：store.handoffFailed 驱动 + reason 展示 + 手动关闭按钮', () => {
    expect(source).toContain('class="handoff-failed-banner"')
    expect(source).toContain('v-if="store.handoffFailed"')
    expect(source).toContain('⚠️ 交接失败：{{ store.handoffFailed.reason }}')
    expect(source).toContain('@click="store.dismissHandoffFailed()"')
    expect(source).toContain('class="banner-dismiss"')
  })

  it('横幅样式族与告警横幅同构：sticky 贴顶 + 实底背景 + 红色系区分（accent-red）', () => {
    const bannerBlock = source.match(/\.handoff-failed-banner\s*\{[\s\S]*?\}/)
    expect(bannerBlock).toBeTruthy()
    expect(bannerBlock![0]).toContain('position: sticky')
    expect(bannerBlock![0]).toContain('top: 0')
    expect(bannerBlock![0]).toContain('z-index: 10')
    expect(bannerBlock![0]).toContain('var(--bg-deep)')
    expect(bannerBlock![0]).toContain('var(--accent-red)')
  })

  it('失败横幅在告警横幅之后（同时出现时文档流占位错开，不叠加）', () => {
    const warnIdx = source.indexOf('context-warning-banner')
    const failIdx = source.indexOf('handoff-failed-banner')
    expect(warnIdx).toBeGreaterThan(-1)
    expect(failIdx).toBeGreaterThan(warnIdx)
  })
})

describe('ChatPanel 运行时长心跳隔离（1s tick 下沉 AgentStatusLabel 叶子组件）', () => {
  it('顶层不再有每秒变化的 now/nowTimer（tick 不再拖全组件重渲）', () => {
    // 静态源断言验收标准②：ChatPanel.vue 顶层无 now ref / nowTimer，1s tick 已隔离
    expect(source).not.toContain('now = ref(Date.now())')
    expect(source).not.toContain('nowTimer')
    expect(source).not.toContain('now.value = Date.now()')
  })

  it('statusLabelZh / HEARTBEAT_STALE_MS 已迁出 ChatPanel（liveness 语义随组件走）', () => {
    expect(source).not.toContain('statusLabelZh')
    expect(source).not.toContain('HEARTBEAT_STALE_MS')
  })

  // `<AgentStatusLabel :entry="s" />` 的模板断言随状态行迁入 MessageItem.test.ts
  it('tick 隔离后 ChatPanel 里不再有 statusLabelZh(s.status) 调用', () => {
    expect(source).not.toContain('statusLabelZh(s.status)')
  })
})

describe('AgentStatusLabel 状态行去秒（计时唯一权威位 = 气泡 footer）', () => {
  it('replying 不再输出秒数——秒数计算逻辑已整体迁出本组件', () => {
    // 票②：A2A / headless 执行没有用户消息状态行可挂，秒数留在状态行就漏一半——
    // 计时上移到 Agent 自己的气泡 footer（ReplyElapsed.vue），状态行只留状态文字。
    expect(statusLabelSource).not.toContain('回复中 · 已 ')
    expect(statusLabelSource).not.toContain('Math.floor((now.value - props.entry.startedAt)')
    // 静止「回复中」保留（存量适配器 / 心跳正常时的状态文字）
    expect(statusLabelSource).toContain("return '回复中'")
  })

  it('本地 1s tick 保留：驱动「无响应」翻转（事件不再到来，只能本地按秒判定）', () => {
    expect(statusLabelSource).toContain('now = ref(Date.now())')
    expect(statusLabelSource).toMatch(
      /nowTimer = setInterval\(\(\) => \{\s*now\.value = Date\.now\(\)\s*\}, 1000\)/
    )
    expect(statusLabelSource).toMatch(/if \(nowTimer\) \{\s*clearInterval\(nowTimer\)/)
  })

  it('心跳失联超阈值 → 显示「无响应」（liveness：本地时钟不能掩盖 server 已死）', () => {
    expect(statusLabelSource).toContain('HEARTBEAT_STALE_MS = 25_000')
    expect(statusLabelSource).toContain('无响应')
    expect(statusLabelSource).toContain('now.value - props.entry.lastBeatAt > HEARTBEAT_STALE_MS')
    expect(statusLabelSource).toContain('lastBeatAt')
  })

  it('props entry 只留 status/lastBeatAt——startedAt 随秒数迁出（状态行不再消费锚点）', () => {
    expect(statusLabelSource).toContain('entry: { status: string; lastBeatAt?: number }')
    expect(statusLabelSource).not.toContain('props.entry.startedAt')
  })
})

describe('ChatPanel 计时上气泡 footer + 占位气泡（票②）', () => {
  it('流式气泡 footer：静态「回复中…」替换为 ReplyElapsed（锚点缺失才回退静态）', () => {
    expect(source).toContain("import ReplyElapsed from './ReplyElapsed.vue'")
    expect(source).toMatch(
      /v-if="replyTimerFor\(agentId\)"[\s\S]{0,160}:started-at="replyTimerFor\(agentId\)!\.startedAt"/
    )
    // 旧 server 不带 startedAt → 无锚点可显示，回退静态文案（存量适配器不误伤）
    expect(source).toContain('<span v-else class="streaming-indicator">回复中…</span>')
  })

  it('占位气泡：replyTimers 有 / typingStates 无 的 agent 渲染 streaming 同款虚线气泡 + 停止按钮 + 计时', () => {
    // 数据源判据：有计时锚点（执行在跑）且无流式条目（headless 整轮 / 首 chunk 前 / A2A）
    expect(source).toContain('const placeholderTimers = computed(')
    expect(source).toContain('if (store.typingStates.has(agentId)) continue')
    // 复用 .message.streaming 视觉语言（虚线边框）——零新增容器样式
    expect(source).toMatch(
      /v-for="timer in placeholderTimers"[\s\S]{0,160}class="message agent streaming"/
    )
    expect(source).toContain('class="placeholder-thinking"')
    expect(source).toContain('<span class="thinking-dots"><i></i><i></i><i></i></span>')
    expect(source).toContain('v-if="canStopAgent(timer.agentId)"')
    expect(source).toMatch(
      /v-if="canStopAgent\(timer\.agentId\)"[\s\S]{0,220}@click\.stop="stopAgent\(timer\.agentId\)"/
    )
  })

  it('占位气泡与流式气泡互斥：同一 agent 不会两个气泡同时在屏（切流式时计时同源不重置）', () => {
    // typingStates 有条目即剔除占位；两处 ReplyElapsed 的锚点都取自 store.replyTimers
    // 的同一条目（startedAt 来自服务端），切换组件实例不重算锚点
    expect(source).toContain('if (store.typingStates.has(agentId)) continue')
    expect(source).toContain('return store.currentReplyTimerFor(agentId)')
  })

  describe('占位气泡行为（挂载级：A2A / headless 执行可见性）', () => {
    const T0 = 1_700_000_000_000

    beforeEach(() => {
      // jsdom 未实现 Element.scrollTo（ChatPanel 贴底滚动会调）
      Object.defineProperty(Element.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      })
      setActivePinia(createPinia())
      vi.useFakeTimers()
      vi.setSystemTime(T0)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** 会话 s1 + a1 执行中（有计时锚点、无流式内容 = A2A / headless 形态） */
    function setupRunning(): ReturnType<typeof useChatStore> {
      const store = useChatStore()
      store.sessions = [
        { id: 's1', title: 't', agentIds: ['a1', 'a2'], broadcastMode: false } as never,
      ]
      store.activeSessionId = 's1'
      store.agents = [
        { id: 'a1', name: 'ds猫', avatar: '🐱', role: 'implementer', llmModel: 'm' } as never,
        { id: 'a2', name: 'flash猫', avatar: '🐱', role: 'implementer', llmModel: 'm' } as never,
      ]
      // 键 = `${sessionId}:${agentId}`——本会话（s1）的条目才参与渲染
      store.replyTimers = new Map([['s1:a1', { startedAt: T0 - 12_000, lastBeatAt: T0 }]])
      store.agentStates = new Map([
        [
          'a1',
          new Map([
            ['s1', { agentId: 'a1', sessionId: 's1', status: 'busy', queueLength: 0 } as never],
          ]),
        ],
      ])
      return store
    }

    function mountPanel() {
      return mount(ChatPanel, {
        props: { leftSidebarOpen: true },
        global: { stubs: { Teleport: true } },
      })
    }

    it('replyTimers 有 / typingStates 无 → 虚线占位气泡在屏，带逐秒计时 + 停止按钮', async () => {
      setupRunning()
      const wrapper = mountPanel()
      await nextTick()

      const bubbles = wrapper.findAll('.message.agent.streaming')
      expect(bubbles).toHaveLength(1)
      expect(bubbles[0].find('.placeholder-thinking').exists()).toBe(true)
      expect(bubbles[0].text()).toContain('回复中 · 已 12 秒')
      expect(bubbles[0].find('.btn-stop-agent').exists()).toBe(true)
    })

    it('首 chunk 到达（typingStates 有条目）→ 占位让位流式气泡，秒数锚点同源不重置', async () => {
      const store = setupRunning()
      const wrapper = mountPanel()
      await nextTick()
      expect(wrapper.findAll('.placeholder-thinking')).toHaveLength(1)

      store.typingStates.set('a1', { messageId: 'm1', content: 'x', sessionId: 's1' })
      await nextTick()

      const bubbles = wrapper.findAll('.message.agent.streaming')
      expect(bubbles).toHaveLength(1) // 不是两个气泡叠加
      expect(bubbles[0].find('.placeholder-thinking').exists()).toBe(false) // 占位已让位
      // 计时同源：锚点来自 store（服务端 startedAt），组件实例切换不归零
      expect(bubbles[0].text()).toContain('回复中 · 已 12 秒')
    })

    it('别的会话的执行帧不渲染到本会话（幽灵计时：秒数在走、成员卡却空闲）', async () => {
      const store = setupRunning()
      // 同一只猫在**另一个会话**并行执行——s1 视图上不得出现它的占位气泡
      store.replyTimers = new Map([
        ['s1:a1', { startedAt: T0 - 12_000, lastBeatAt: T0 }],
        ['s2:a1', { startedAt: T0 - 90_000, lastBeatAt: T0 }],
      ])
      const wrapper = mountPanel()
      await nextTick()

      const bubbles = wrapper.findAll('.message.agent.streaming')
      expect(bubbles).toHaveLength(1)
      // 取的是 s1 那条（12 秒）而非 s2 那条（90 秒）——键控隔离的直接读数
      expect(bubbles[0].text()).toContain('回复中 · 已 12 秒')
      expect(wrapper.text()).not.toContain('已 1:30')
    })

    it('执行终止清计时 → 占位气泡消失（不留「无响应」僵尸）', async () => {
      const store = setupRunning()
      const wrapper = mountPanel()
      await nextTick()
      expect(wrapper.findAll('.message.agent.streaming')).toHaveLength(1)

      store.replyTimers = new Map()
      await nextTick()
      expect(wrapper.findAll('.message.agent.streaming')).toHaveLength(0)
    })

    it('无流式期间秒数由本地 tick 递增（server 零额外流量）', async () => {
      setupRunning()
      const wrapper = mountPanel()
      await nextTick()
      expect(wrapper.text()).toContain('回复中 · 已 12 秒')

      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(wrapper.text()).toContain('回复中 · 已 15 秒')
    })
  })
})

describe('ChatPanel renderMarkdown 记忆化（L3：手写缓存整体退役）', () => {
  it('手写 markdownCache 与两条记忆化函数已删除——缓存改由 MessageItem 的 computed 承担', () => {
    // 抽组件后 markdown 在子组件里跑 computed（依赖追踪自带缓存、无键拼接、无无界增长），
    // 父组件的手写 Map 成为纯复杂度：键含整条正文、无淘汰、无界增长。
    expect(source).not.toContain('markdownCache')
    expect(source).not.toContain('renderMessageMarkdown')
    expect(source).not.toContain('renderThinkingMarkdown')
    expect(source).not.toContain('markdownAgentNames')
    expect(source).not.toContain('finalTextContent')
  })

  it('流式气泡的 markdown 只渲染体（正文段仍是死代码，热区只有折叠块 thinking 段）', () => {
    // 流式期间的 markdown 调用点收在流式折叠块内（历史消息已由 MessageItem 自渲染）
    expect(source).toContain('v-html="renderMarkdown(e.content)"')
    // 历史消息正文/思考不再由父组件渲染
    expect(source).not.toContain('v-html="renderMarkdown(resolveDisplayPlaceholders(msg.content')
    expect(source).not.toContain('v-html="renderMarkdown(msg.thinkingContent')
  })
})

describe('ChatPanel 思考展示结构分离（typing.segments 优先 + 旧前缀兼容）', () => {
  it('typingView/resolveTypingSegs 优先消费 typing.segments，无 segments 时退化 parseThinkingBlocks', () => {
    expect(source).toContain('typing.segments && typing.segments.length')
    expect(source).toContain('? typing.segments')
    expect(source).toContain('parseThinkingBlocks(typing.content)')
  })

  // 旧库 [思考] 前缀兼容随思考渲染迁入 MessageItem.vue（断言见 MessageItem.test.ts）
})

describe('ChatPanel 思考+工具单折叠（工具嵌思考框内——对齐用户「对外只露正文+思考框」）', () => {
  it('buildStreamItems 把 thinking+tool 段收进单一 fold（时间序交错 entries），流式期间 text 段全不渲染（既不产出外层 seg 也不进 fold）', () => {
    // 重构自 fc2fc9e toolArea：thinking 与 tool 不再分容器——思考折叠块是唯一过程容器，
    // tool 嵌在 thinking 间实际发生位置；点1 新规格流式期间 text 段 drop——最终正文只在流结束定格
    expect(source).toContain("seg.kind === 'text'")
    expect(source).toContain("type: 'fold'")
    expect(source).toContain("fold.entries.push({ kind: 'tool', tool })")
    expect(source).toContain("fold.entries.push({ kind: 'thinking', content: seg.content })")
    // 流式期间不再产出外层 seg（text 段被 drop——最终正文由 storedFoldEntries 在完成态留外层）
    expect(source).not.toMatch(/items\.push\(\{ type: 'seg', seg \}\)/)
    // 独立 toolArea 数据结构已移除
    expect(source).not.toContain("type: 'toolArea'")
  })

  it('点1：流式期间 buildStreamItems 不渲染 text 段（既不产出外层 seg 也不进 fold），thinking+tool 才收进单一 fold；纯正文流无折叠块', () => {
    // text 段在流式中被 continue 跳过（drop——不进外层 seg、也不建/收进 fold）。
    // 断言锚在 buildStreamItems 本体上：同文件别处不再有 `seg.kind === 'text' ... continue`
    // 可供误命中（历史折叠块的同判据已随消息块迁入 MessageItem）——防「断言被别处满足」假绿。
    expect(source).toContain("if (seg.kind === 'text') {")
    expect(source).toMatch(
      /function buildStreamItems[\s\S]*?if \(seg\.kind === 'text'\) \{[\s\S]*?continue/
    )
    // 不再定位/保留最后一个 text 段（流途中最终段未定，正文只在流结束定格）
    expect(source).not.toContain('finalTextIndex')
    // 不再产出外层 seg
    expect(source).not.toMatch(/items\.push\(\{ type: 'seg', seg \}\)/)
    // fold 创建条件：thinking/tool 段触发（text 段不再建 fold）
    expect(source).toMatch(/type: 'fold', entries: \[\], tools: \[\], open: true/)
    // 单调展开指针保持：一旦出现 thinking 或 tool 段即展开（治 flap 逻辑不因 text drop 退化）
    expect(source).toContain('const monotonicOpen = hasThinking || fold.tools.length > 0')
  })

  it('折叠块自动展开判据：出现 thinking 或 tool 段即单调展开（monotonicOpen），不随正文进入/工具完成中段收起（治 flap）', () => {
    expect(source).toContain('const monotonicOpen = hasThinking || fold.tools.length > 0')
    expect(source).toContain('fold.open = st ? (frozen ? st.open : monotonicOpen) : monotonicOpen')
  })

  it('processing 解耦保留：仅供 header 活跃指示（thinking-dots），不驱动 open（open 归 monotonicOpen）；并改为折叠体存在即恒亮到流结束', () => {
    // 新公式：折叠体有过程内容（thinking/tool）即 processing=true，dots 恒亮到流结束
    expect(source).toContain('const processing = fold.entries.length > 0')
    expect(source).toContain('fold.processing = processing')
    // 旧瞬时态公式（hasActiveTool/enteredText 驱动）已移除——processing 不再依赖工具推进/正文前思考
    expect(source).not.toContain('hasActiveTool')
    expect(source).not.toContain('enteredText')
    expect(source).not.toMatch(
      /fold\.open\s*=\s*st \? \(frozen \? st\.open : processing\) : processing/
    )
  })

  it('流式模板 item 分支：seg 渲染正文，fold 渲染 thinking-block 受控折叠容器（取消独立 tool-area）', () => {
    expect(source).toContain('v-for="(item, ii) in typing.items"')
    expect(source).toContain("item.type === 'seg'")
    expect(source).toContain('class="thinking-block stream-fold"')
    expect(source).not.toContain("item.type === 'toolArea'")
    expect(source).not.toContain('class="tool-area"')
  })

  it('fold 内 entries 交错渲染：thinking 文本（fold-thinking）与工具行（ToolRow partial）按 e.kind 分支同容器', () => {
    expect(source).toContain('v-for="(e, ei) in item.entries"')
    expect(source).toContain("e.kind === 'thinking'")
    expect(source).toContain('class="fold-thinking"')
    // 流式工具行走 ToolRow 共享 partial：class 透传 stream-tool-row，去 plain（卡片头饱满 + 为 B 铺路）
    expect(source).toMatch(/<ToolRow v-else[\s\S]{0,90}stream-tool-row[^\n]*\/>/)
    expect(source).not.toMatch(/<ToolRow v-else[\s\S]{0,90}stream-tool-row[\s\S]{0,90}plain \/>/)
  })

  it('流式折叠体高度上限只作用流式：.stream-fold .stream-fold-body 有 max-height + overflow-y:auto（长思考不撑爆气泡/拖累窗口滚动）', () => {
    const foldBodyBlock = source.match(/\.stream-fold \.stream-fold-body \{[\s\S]*?\n\}/)
    expect(foldBodyBlock).toBeTruthy()
    expect(foldBodyBlock![0]).toContain('max-height: 220px')
    expect(foldBodyBlock![0]).toContain('overflow-y: auto')
  })

  it('流式/历史折叠体限高各用专有后代选择器：共享 base .stream-fold-body 无 max-height（不重蹈 b12e858 共享 class 泄漏），历史 .stored-thinking .stream-fold-body 有界（点3）', () => {
    const baseBlock = source.match(/\.stream-fold-body \{[\s\S]*?\n\}/)
    expect(baseBlock).toBeTruthy()
    expect(baseBlock![0]).not.toContain('max-height')
    // 点3：历史折叠体也 220px 有界（专有后代选择器；用户拍板「有界就靠框内滚到达」，取代 b12e858「历史无上限/工具恒可见」）
    const storedBlock = source.match(/\.stored-thinking \.stream-fold-body \{[\s\S]*?\n\}/)
    expect(storedBlock).toBeTruthy()
    expect(storedBlock![0]).toContain('max-height: 220px')
    expect(storedBlock![0]).toContain('overflow-y: auto')
  })

  it('折叠体直接子项 flex-shrink:0（行为修复：flex column + 有界高度会把 <details> 工具行压成 ~2px 细线——flex-shrink:0 让内容由容器 overflow 滚动而非压缩子项）', () => {
    const shrinkBlock = source.match(/\.stream-fold-body > \* \{[\s\S]*?\n\}/)
    expect(shrinkBlock).toBeTruthy()
    expect(shrinkBlock![0]).toContain('flex-shrink: 0')
  })

  it('流式折叠块 header 用户点过冻结：toggleStreamFold 记 frozen + open 取反 + 版本号 bump 即时生效（fc2fc9e ⚠️ 修复延续）', () => {
    expect(source).toContain('toggleStreamFold(agentId, item.open)')
    expect(source).toContain('streamFoldState.value.set')
    expect(source).toContain('frozen: true')
    expect(source).toContain('@keydown.enter.prevent="toggleStreamFold(agentId, item.open)"')
    expect(source).toContain('const streamFoldVersion = ref(0)')
    expect(source).toContain('streamFoldVersion.value++')
    expect(source).toMatch(/function buildStreamItems[\s\S]{0,300}streamFoldVersion\.value/s)
  })

  it('流式 header processing 显动点、有工具时显摘要提示（thinking-tool-hint）', () => {
    expect(source).toContain('class="thinking-tool-hint"')
    expect(source).toContain('toolAreaSummary(item.tools)')
    expect(source).toContain('v-if="item.processing" class="thinking-dots"')
  })

  // 历史折叠块（单折叠 + ToolRow 退化路径 + segments 交错还原）的标记已随消息块
  // 迁入 MessageItem.vue；本文件的这些断言整体迁到 MessageItem.test.ts。
  // ToolRow 行级渲染的单源断言在 ToolRow.test.ts 已覆盖，不重复。
})

// ─── 思考框横向溢出（正文/流式思考框/历史思考框三落点同源）────────────────────
// 病灶：思考框里渲染出的 markdown（代码块 white-space:pre 永不折行、行内 code 掉进 UA
// 默认的 word-break:normal）没有任何专属规则，溢出冒到最近的滚动容器 .stream-fold-body
// （overflow-y:auto 会令未声明的 overflow-x 强制计算成 auto），有 1px 就冒横条。
// 本组断言锁住「三组规则各自并列三个落点」——新增落点漏一个就红。

describe('ChatPanel 思考框横向溢出（三落点同源：正文 / 流式思考框 / 历史思考框）', () => {
  it('行内 code：三落点并列 + word-break:break-all（无空格长路径可折行）', () => {
    expect(source).toContain(
      '.chat-panel .msg-text code,\n.chat-panel .fold-thinking code,\n.chat-panel .thinking-content code {'
    )
    const block = source.match(/\.chat-panel \.thinking-content code\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toContain('word-break: break-all')
  })

  it('代码块：三落点并列 + overflow-x:auto（长行由 pre 自己滚，不外溢到容器）', () => {
    expect(source).toContain(
      '.chat-panel .msg-text pre,\n.chat-panel .fold-thinking pre,\n.chat-panel .thinking-content pre {'
    )
    const block = source.match(/\.chat-panel \.thinking-content pre\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toContain('overflow-x: auto')
    expect(block![0]).toContain('overflow-wrap: normal')
  })

  it('块内 code：三落点并列 + white-space:pre（块内保持原样换行语义）', () => {
    expect(source).toContain(
      '.chat-panel .msg-text pre code,\n.chat-panel .fold-thinking pre code,\n.chat-panel .thinking-content pre code {'
    )
    const block = source.match(/\.chat-panel \.thinking-content pre code\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toContain('white-space: pre')
  })

  it('亮色主题的 pre 覆盖同样并列三落点（否则思考框代码块在浅底上留白边）', () => {
    expect(source).toContain("[data-theme='light'] .chat-panel .fold-thinking pre,")
    expect(source).toContain("[data-theme='light'] .chat-panel .thinking-content pre {")
    expect(source).toContain("[data-theme='light'] .chat-panel .thinking-content pre code {")
  })

  it('兜底：.stream-fold-body 显式 overflow-x:hidden（防止漏网内容顶出横条；注释写明不是主修）', () => {
    const baseBlock = source.match(/\.stream-fold-body \{[\s\S]*?\n\}/)
    expect(baseBlock).toBeTruthy()
    expect(baseBlock![0]).toContain('overflow-x: hidden')
    expect(baseBlock![0]).toContain('横向兜底')
  })
})

// ─── 思考框内跟进（stick-to-bottom，框内滚动）────────────────────────────────
// 观测面是 .stream-fold-inner 的尺寸，不是「枚举内容增长来源」——后者漏一条渲染路径就
// 静默失效。不能观测 .stream-fold-body 自身：它 max-height:220px 固定，观测不到增长。

describe('ChatPanel 思考框内跟进（观测 .stream-fold-inner 尺寸 + 三不变量）', () => {
  it('模板：条目列表外包 .stream-fold-inner 并挂 v-fold-stick（RO 的观测对象）', () => {
    expect(source).toContain('<div v-fold-stick class="stream-fold-inner">')
    // 包裹层必须在 .stream-fold-body 之内（指令用 closest('.stream-fold-body') 找滚动容器）
    expect(source).toMatch(
      /class="stream-fold-body"[\s\S]{0,400}class="stream-fold-inner"[\s\S]{0,400}class="fold-thinking"/
    )
  })

  it('观测接线：指令 mounted 建 RO 观测 inner、卸载 disconnect 并摘 scroll 监听（随元素生命周期，不泄漏）', () => {
    expect(source).toContain('const vFoldStick: Directive<HTMLElement> = {')
    expect(source).toContain('new ResizeObserver(() => scheduleFoldStick(body))')
    expect(source).toContain('ro.observe(el)')
    // closest 而非 parentElement：中间插一层时 parentElement 会指错且静默失效
    expect(source).toContain("el.closest('.stream-fold-body')")
    expect(source).not.toContain('el.parentElement')
    expect(source).toContain('b.ro.disconnect()')
    expect(source).toContain("b.body.removeEventListener('scroll', b.onScroll)")
    expect(source).toContain('foldStickBindings.delete(el)')
  })

  it('冷启动不变量：sticky 位初值 true，且只由 scroll 事件重算（纯几何判据实测冷启动失效）', () => {
    // 首次溢出那一帧 scrollTop 仍是 0（clientHeight 被 max-height 钳住），几何距离一跃 ≥4px；
    // 纯几何判据会判「不在底部」而 return，此后 dist 单调增、跟随一次都不触发（真机实测
    // 7 → 28 → 49px，scrollTop 恒 0）。故写侧只认 sticky 位，初值 true = 默认跟随。
    expect(source).toContain('foldSticky.set(body, true)')
    expect(source).toContain("body.addEventListener('scroll', onScroll, { passive: true })")
    expect(source).toContain('foldSticky.set(body, isAtFoldBottom(body))')
  })

  it('三不变量：sticky 位判据（想跟才贴底、滚上去不抢）+ behavior:auto + rAF 节流', () => {
    // I1/I2/I3：sticky=true 才贴底；sticky 由 scroll 事件按几何距离翻转（I2 让位 / I3 复位）
    expect(source).toContain('if (!foldSticky.get(body)) return')
    expect(source).toContain('function isAtFoldBottom(body: HTMLElement): boolean')
    expect(source).toContain(
      'body.scrollHeight - body.scrollTop - body.clientHeight < FOLD_SCROLL_TOLERANCE'
    )
    // 写侧不得再自己算几何距离（那正是冷启动失效的成因）
    expect(source).not.toContain('const distToBottom = body.scrollHeight')
    // 流式期平滑滚动追不上逐 chunk 增长，且会与用户手动滚动打架
    expect(source).toContain("body.scrollTo({ top: body.scrollHeight, behavior: 'auto' })")
    // rAF 节流：同帧多次触发合并一次，且滚动写推迟到下一帧（避免 RO loop 告警）
    expect(source).toContain('let foldStickRaf = 0')
    expect(source).toContain('foldStickRaf = requestAnimationFrame(')
  })

  it('卸载清理：取消在途 rAF + 清空待处理集合（RO 实例由指令逐个 disconnect，不重复）', () => {
    expect(source).toContain('cancelAnimationFrame(foldStickRaf)')
    expect(source).toContain('pendingFoldBodies.clear()')
  })

  it('布局迁移：包裹层承接 flex column + gap，其子项 flex-shrink:0（工具行不被压成细线）', () => {
    const innerBlock = source.match(/\.stream-fold-inner \{[\s\S]*?\n\}/)
    expect(innerBlock).toBeTruthy()
    expect(innerBlock![0]).toContain('flex-direction: column')
    expect(innerBlock![0]).toContain('gap: 5px')
    const innerChild = source.match(/\.stream-fold-inner > \* \{[\s\S]*?\n\}/)
    expect(innerChild).toBeTruthy()
    expect(innerChild![0]).toContain('flex-shrink: 0')
    // base 的 gap 仍是历史路径（不套包裹层）的承重项，不能顺手删
    const baseBlock = source.match(/\.stream-fold-body \{[\s\S]*?\n\}/)
    expect(baseBlock![0]).toContain('gap: 5px')
  })
})

describe('ChatPanel 历史消息 segments 交错还原（segments 落库后时间序优先 + 老消息退化）', () => {
  it('父组件不再持有历史折叠块逻辑（函数与模板标记整体迁入 MessageItem）', () => {
    expect(source).not.toContain('storedFoldEntries')
    expect(source).not.toContain('StoredFoldEntry')
    expect(source).not.toContain('class="fold-tool-list"')
    expect(source).not.toContain('<ToolRow :tool="t" />')
  })

  it('两条内容体路径（segments 交错 / 老消息退化）现由 MessageItem 持有，标记见 MessageItem.test.ts', () => {
    expect(source).not.toContain('v-if="storedFoldEntries(msg)" class="stream-fold-body"')
    expect(source).not.toContain('v-html="renderThinkingMarkdown(msg)"')
  })
})

// ─── A1：渲染边界机械断言（O(N)/chunk → O(1)/chunk）────────────────────────
// 票单 docs/run/frontend-perf/tickets.md A1：200 条带 segments 的历史消息 + 一次
// AGENT_TYPING 更新 ⇒ renderMarkdown 调用增量为常数（与 N 无关）。

// ─── A2：静态源断言（模板不再在渲染期现算数组级判定）──────────────────────

describe('A2 渲染边界：模板不再现算数组级判定', () => {
  it('ChatPanel 模板不再出现 storedFoldEntries( / isLatestUserMessage( / isGrouped( ', () => {
    const template = source.slice(source.indexOf('<template>'))
    expect(template).not.toContain('storedFoldEntries(')
    expect(template).not.toContain('isLatestUserMessage(')
    // 分组判定从模板 3 次现算改为视图模型内算一次（MessageItem 只收标量 grouped）
    expect(template).not.toContain('isGrouped(')
    expect(template).not.toContain('dateSepIndices.has(')
  })

  it('消息列表改渲染 MessageItem 且不下传数组/下标（C1 硬约束）', () => {
    expect(source).toContain("import MessageItem from './MessageItem.vue'")
    const itemTag = source.match(/<MessageItem[\s\S]*?\/>/)?.[0]
    expect(itemTag).toBeTruthy()
    expect(itemTag).toContain(':msg="view.msg"')
    expect(itemTag).toContain(':grouped="view.grouped"')
    expect(itemTag).toContain(':status-entries="view.statusEntries"')
    expect(itemTag).not.toContain('activeMessages')
    expect(itemTag).not.toContain(':index')
  })

  it('视图模型：标量判定集中一次算 + 逐字段相等复用对象引用（子组件 props 身份稳定）', () => {
    expect(source).toContain('const messageViews = computed<MessageView[]>(() => {')
    expect(source).toContain('function isSameView(a: MessageView, b: MessageView): boolean')
    expect(source).toContain('const view = cached && isSameView(cached, fresh) ? cached : fresh')
    // O(N²) 消除：最新用户消息一次倒序求得，不再每条消息跑一次全量 filter
    expect(source).toContain('const lastUserMessageId = computed')
    expect(source).not.toContain('activeMessages.filter((m) => m.role === ')
  })
})

// ─── A1：渲染边界机械断言（O(N)/chunk → O(1)/chunk）────────────────────────
// 票单 docs/run/frontend-perf/tickets.md A1：200 条带 segments 的历史消息 + 一次
// AGENT_TYPING 更新 ⇒ renderMarkdown 调用增量为常数（与 N 无关）。

const A1_MESSAGE_COUNT = 200

function a1HistoricalMessage(i: number): Message {
  if (i % 2 === 0) {
    return {
      id: `m${i}`,
      sessionId: 's1',
      agentId: null,
      role: 'user',
      content: `第 ${i} 条用户提问。`,
      mentions: ['ds猫'],
      createdAt: '2026-01-01T00:00:00Z',
    }
  }
  const body = `第 ${i} 条回复正文。`.repeat(4)
  const thinking = `第 ${i} 条推理过程。`.repeat(20)
  return {
    id: `m${i}`,
    sessionId: 's1',
    agentId: 'a1',
    role: 'agent',
    content: body,
    mentions: [],
    thinkingContent: thinking,
    toolContent: [{ id: `t${i}`, name: 'Bash', status: 'done' }],
    segments: [
      { kind: 'thinking', content: thinking },
      { kind: 'tool', content: '', tool: { id: `t${i}`, name: 'Bash', status: 'done' } },
      { kind: 'text', content: body },
    ],
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('A1 渲染边界：单次 chunk 不按 N 触发 markdown 重算', () => {
  let scrollToStub: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom 未实现 Element.scrollTo（ChatPanel 贴底滚动会调）
    scrollToStub = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollToStub,
    })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.mocked(renderMarkdown).mockClear()
  })

  it(`${A1_MESSAGE_COUNT} 条历史消息 + 一次 AGENT_TYPING ⇒ renderMarkdown 调用增量 ≤ 5`, async () => {
    const store = useChatStore()
    store.sessions = [{ id: 's1', title: 'A1', agentIds: ['a1'], broadcastMode: false } as never]
    store.activeSessionId = 's1'
    store.agents = [
      { id: 'a1', name: 'ds猫', avatar: '🐱', role: 'implementer', llmModel: 'm' } as never,
    ]
    store.messages = Array.from({ length: A1_MESSAGE_COUNT }, (_, i) => a1HistoricalMessage(i))
    // 真实会话形态：最新用户消息带 agent 状态行（状态行里读 store.typingStates——这条读取
    // 是 typingStates 进入「消息列表渲染依赖」的唯一入口；纯 agent 历史测不出真实基线）
    store.messageStatus = new Map([
      [
        `m${A1_MESSAGE_COUNT - 2}`,
        [
          {
            agentId: 'a1',
            agentName: 'ds猫',
            agentAvatar: '🐱',
            status: 'replying' as const,
          },
        ],
      ],
    ])

    const wrapper = mount(ChatPanel, {
      props: { leftSidebarOpen: true },
      global: { stubs: { Teleport: true } },
    })
    await nextTick()
    await nextTick()

    const baseline = vi.mocked(renderMarkdown).mock.calls.length
    vi.mocked(renderMarkdown).mockClear()

    // 一次 chunk：typing 内容推进（服务端 reply.ts 逐 chunk emit 的等价触发）
    store.typingStates.set('a1', {
      messageId: 'stream1',
      sessionId: 's1',
      content: '流式思考片段 1',
      segments: [{ kind: 'thinking', content: '流式思考片段 1' }],
    })
    await nextTick()
    await nextTick()

    const delta = vi.mocked(renderMarkdown).mock.calls.length
    // 改前基线（3237 行单组件、零消息级子组件边界，2026-09-13 本机实测）：**delta = 101**
    // ——200 条消息里 100 条 agent 消息，单个 chunk 触发整张列表重算 ⇒ 每条折叠块内的
    // `renderMarkdown(e.content)`（历史 thinking 段，无缓存）重跑一次，+1 条流式折叠块。
    // 即 delta ≈ agent 消息数 × 每条 thinking 条目数，与 N 线性。改后须为常数（≤5）。
    expect(baseline).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(5)

    wrapper.unmount()
  })
})

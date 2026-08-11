import { describe, it, expect } from 'vitest'
import source from './ChatPanel.vue?raw'

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
    const preBlock = source.match(/\.chat-panel \.msg-text pre\s*\{[^}]*\}/s)
    expect(preBlock).toBeTruthy()
    expect(preBlock![0]).toContain('overflow-wrap: normal')
    const tdBlock = source.match(
      /\.chat-panel \.msg-text th,\s*\n\s*\.chat-panel \.msg-text td\s*\{[^}]*\}/s
    )
    expect(tdBlock).toBeTruthy()
    expect(tdBlock![0]).toContain('overflow-wrap: anywhere')
  })
})

describe('ChatPanel restart confirm feedback', () => {
  it('pending 态显示 [确认重启][取消] 按钮，点击走 store.confirmRestart', () => {
    expect(source).toContain('store.confirmRestart(msg.id)')
    expect(source).toContain('store.cancelRestart(msg.id)')
  })

  it('confirming 中（store.confirmingRestartMessageId === msg.id）显示「已确认，等待重启…」脉冲样式', () => {
    expect(source).toContain('store.confirmingRestartMessageId === msg.id')
    expect(source).toContain('已确认，等待重启…')
    // 复用 restart-label 脉冲样式（点击即有反馈，无需等服务端）
    expect(source).toMatch(/已确认，等待重启…/)
  })

  it('confirmed 态仍显示「重启中…」restart-label', () => {
    expect(source).toContain('重启中…')
    expect(source).toContain('restart-label')
  })
})

describe('ChatPanel 对话内 diff 展示接入（富文本块通道）', () => {
  it('import DiffViewer 组件', () => {
    expect(source).toContain("import DiffViewer from './DiffViewer.vue'")
  })

  it('extra.rich.blocks 存在才渲染 DiffViewer（无 extra 纯文本回退与现网一致）', () => {
    expect(source).toContain('v-if="msg.extra?.rich?.blocks?.length"')
    expect(source).toContain(':blocks="msg.extra.rich.blocks"')
  })
})

describe('ChatPanel skill 提示（SkillLoader 拆除后）', () => {
  it('提示框展示 CLI 原生触发说明（不再是「未找到匹配的技能」空壳）', () => {
    // bf5aab5 拆除 SkillLoader：/api/skills 数据源已删，skill 由 CLI 原生消费
    // （斜杠透传 + 模型自主调用），服务端不再注入——空壳文案改为正确说明
    expect(source).toContain('skill 由 CLI 原生触发')
    expect(source).toContain('服务端不再注入')
    expect(source).toContain('skill-tip')
    expect(source).not.toContain('未找到匹配的技能')
  })

  it('fetchSkills 死调用已清除（端点已删，恒 404 降级空列表）', () => {
    expect(source).not.toContain('fetchSkills')
    expect(source).not.toContain('/api/skills')
  })

  it('补全机制已剥离：无 skillSuggestions 下拉与键盘拦截分支（斜杠消息 Enter 可直发）', () => {
    // 数据源恒空时下拉不可达；keydown 拦截分支曾吞掉斜杠消息的 Enter（preventDefault 后
    // 直达 :493 发送逻辑被短路）——剥离后 Enter 直通 handleSend，CLI 斜杠触发通道保留
    expect(source).not.toContain('skillSuggestions')
    expect(source).not.toContain('skill-dropdown')
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
  it('agent 消息每条显示 {模型} · {n}k/{m}k tokens（分组消息同样渲染，守卫仅限 role/agentId）', () => {
    expect(source).toContain('class="msg-footer"')
    // 守卫已去掉 !isGrouped(i)：同 agent 连续回复（分组气泡）每条都带 footer
    expect(source).toMatch(/v-if="msg\.role === 'agent' && msg\.agentId"/)
    expect(source).not.toMatch(/agentId && !isGrouped\(i\)/)
    // 模板插值：{{ modelNameFor(msg.agentId) }} · {{ tokensTextFor(msg.agentId) }}
    expect(source).toContain('modelNameFor(msg.agentId) }} · {{ tokensTextFor(msg.agentId) }}')
  })

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

  it('canStop 判定：busy 或有排队任务', () => {
    expect(source).toContain("state?.status === 'busy'")
    expect(source).toContain('state?.queueLength ?? 0) > 0')
  })

  it('system 消息保持原 msg-time 结构（无 footer 行）', () => {
    expect(source).toMatch(/v-else class="msg-time"/)
  })
})

describe('ChatPanel 停止按钮重定位（B2——正在思考的气泡 / busy 无流式时的用户消息状态行）', () => {
  it('streaming 气泡 footer 有停止按钮：@click.stop + canStopAgent 守卫（正在思考时）', () => {
    expect(source).toMatch(
      /v-if="canStopAgent\(agentId\)"[\s\S]{0,120}class="btn-stop-agent"[\s\S]{0,140}@click\.stop="stopAgent\(agentId\)"/
    )
    expect(source).toContain('store.interruptAgent(agentId)')
  })

  it('用户消息状态行（per-agent）承载：无流式内容（!typingStates.has）且可停止时挂按钮', () => {
    expect(source).toContain('!store.typingStates.has(s.agentId) && canStopAgent(s.agentId)')
    expect(source).toContain('@click.stop="stopAgent(s.agentId)"')
    expect(source).toContain('class="agent-status-row"')
  })

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

  it('色阶：>= 交接线红、>= 告警线黄（contextLevelFor 返回值驱动 class）', () => {
    expect(source).toContain("return 'critical'")
    expect(source).toContain("return 'warn'")
    expect(source).toContain(':class="contextLevelFor(msg.agentId)"')
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

import { describe, it, expect } from 'vitest'
import source from './ChatPanel.vue?raw'
import statusLabelSource from './AgentStatusLabel.vue?raw'
import toolRowSource from './ToolRow.vue?raw'

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
    // 正则而非 toContain——prettier 会把后续 <span> 重排到新行，tokensTextFor(msg.agentId) 后
    // 可能是换行再 }}；正则匹配到 tokensTextFor(msg.agentId) 前缀即通过（对 prettier 格式鲁棒）
    expect(source).toMatch(/modelNameFor\(msg\.agentId\) \}\} · \{\{ tokensTextFor\(msg\.agentId\)/)
    // C5：agent 耗时徽标（durationMs 随广播注入，瞬态不落库）
    expect(source).toContain('msg.durationMs != null')
    expect(source).toContain('耗时 {{ formatDuration(msg.durationMs) }}')
    expect(source).toContain('function formatDuration(ms: number): string')
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

  it('执行元数据（execution_logs 落库稳定耗时/token）优先展示，durationMs 降为无 meta 时兜底', () => {
    // 稳定 meta 分支（v-if）在 durationMs 之前；durationMs 保留为 v-else-if 兜底（execution 未拉取时新回复短暂可显）
    expect(source).toContain('v-if="execMetaTextFor(msg)" class="msg-duration"')
    expect(source).toContain('· {{ execMetaTextFor(msg) }}')
    expect(source).toContain('v-else-if="msg.durationMs != null" class="msg-duration"')
    expect(source).toContain('function execMetaFor(msg')
    expect(source).toContain('store.sessionExecutions.get(msg.id)')
    expect(source).toContain('function execMetaTextFor(msg')
    expect(source).toContain('meta.latencyMs != null')
    expect(source).toContain('fmtTokens(inTok ?? 0)')
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

  it('模板用 <AgentStatusLabel :entry="s" /> 替换 statusLabelZh(s)（整条 entry 透传）', () => {
    expect(source).toContain("import AgentStatusLabel from './AgentStatusLabel.vue'")
    expect(source).toContain('<AgentStatusLabel :entry="s" />')
    expect(source).not.toContain('statusLabelZh(s.status)')
  })
})

describe('AgentStatusLabel 运行时长心跳（回复中 · 已 N 秒——4775ac1 行为零回归）', () => {
  it('replying 带 startedAt → 显示「回复中 · 已 N 秒」递增文案 + 时长计算逻辑（读 now 而非 Date.now()）', () => {
    // 静态源断言：headless 黑盒适配器整轮不 yield chunk，前端靠本地 1s tick 的 now
    // 重算累计秒数（服务端 10s 心跳只刷新 liveness 锚点，不再驱动秒数）
    expect(statusLabelSource).toContain('回复中 · 已 ')
    expect(statusLabelSource).toContain('Math.floor((now.value - props.entry.startedAt) / 1000)')
    expect(statusLabelSource).not.toContain(
      'Math.floor((Date.now() - props.entry.startedAt) / 1000)'
    )
  })

  it('本地 1s tick：now = ref(Date.now()) + setInterval(1000) 每秒更新，onUnmounted clearInterval', () => {
    // 反转上单「省一个 timer」决策的硬风险点：timer 生命周期必须正确管理
    expect(statusLabelSource).toContain('now = ref(Date.now())')
    expect(statusLabelSource).toMatch(
      /nowTimer = setInterval\(\(\) => \{\s*now\.value = Date\.now\(\)\s*\}, 1000\)/
    )
    expect(statusLabelSource).toMatch(/if \(nowTimer\) \{\s*clearInterval\(nowTimer\)/)
  })

  it('心跳失联超阈值 → 停止递增、显示「无响应」（liveness：本地时钟不能掩盖 server 已死）', () => {
    expect(statusLabelSource).toContain('HEARTBEAT_STALE_MS = 25_000')
    expect(statusLabelSource).toContain('无响应')
    expect(statusLabelSource).toContain('now.value - props.entry.lastBeatAt > HEARTBEAT_STALE_MS')
    expect(statusLabelSource).toContain('lastBeatAt')
  })

  it('props entry 带 startedAt/lastBeatAt 可选字段（服务端心跳注入，前端据此显示时长/无响应）', () => {
    expect(statusLabelSource).toContain(
      'entry: { status: string; startedAt?: number; lastBeatAt?: number }'
    )
  })

  it('无 startedAt → 回退静止「回复中」（存量适配器未带 startedAt 不误伤）', () => {
    expect(statusLabelSource).toContain("return '回复中'")
  })
})

describe('ChatPanel renderMarkdown 记忆化（per-message 缓存）', () => {
  it('定义 markdownCache Map + 记忆化函数（renderMessageMarkdown / renderThinkingMarkdown）', () => {
    expect(source).toContain('const markdownCache = new Map<string, string>()')
    expect(source).toContain('function renderMessageMarkdown(msg: Message): string')
    expect(source).toContain('function renderThinkingMarkdown(msg: Message): string')
  })

  it('正文缓存键覆盖相关 agent 名（占位符替换依赖 store/reviewer 角色名，改名则键变重算）', () => {
    expect(source).toContain('function markdownAgentNames(): string')
    expect(source).toContain('const key = `${msg.id}:${markdownAgentNames()}:${msg.content}`')
    expect(source).toContain("a.role === 'store'")
    expect(source).toContain("a.role === 'reviewer'")
  })

  it('模板正文/思考渲染点已切到记忆化函数（未变消息 markdown 只算一次）', () => {
    expect(source).toContain('v-html="renderMessageMarkdown(msg)"')
    expect(source).toContain('v-html="renderThinkingMarkdown(msg)"')
    // 模板里 v-html 不再直接调 renderMarkdown（记忆化函数体内仍含 renderMarkdown，那是实现细节）
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

  it('renderThinkingMarkdown 兼容旧库 [思考] 前缀（新纯文本原样返回、含前缀才剥）', () => {
    expect(source).toContain("tc.includes('[思考]')")
    expect(source).toContain("tc.replace(/\\[思考\\]\\s*/g, '')")
  })
})

describe('ChatPanel 思考+工具单折叠（工具嵌思考框内——对齐用户「对外只露正文+思考框」）', () => {
  it('buildStreamItems 把 thinking+tool 段收进单一 fold（时间序交错 entries），text 正文保留外层 seg', () => {
    // 重构自 fc2fc9e toolArea：thinking 与 tool 不再分容器——思考折叠块是唯一过程容器，
    // tool 嵌在 thinking 间实际发生位置；text 段保留外层渲染正文
    expect(source).toContain("seg.kind === 'text'")
    expect(source).toContain("type: 'fold'")
    expect(source).toContain("fold.entries.push({ kind: 'tool', tool })")
    expect(source).toContain("fold.entries.push({ kind: 'thinking', content: seg.content })")
    expect(source).toContain("type: 'seg'")
    // 独立 toolArea 数据结构已移除
    expect(source).not.toContain("type: 'toolArea'")
  })

  it('折叠块自动展开判据：工具推进中/正文前思考展开；进入纯正文无推进工具则收起（processing 驱动）', () => {
    expect(source).toContain('const processing = hasActiveTool || (!enteredText && hasThinking)')
    expect(source).toContain('const hasActiveTool = fold.tools.some(isToolActive)')
    expect(source).toContain("const enteredText = segs.some((s) => s.kind === 'text')")
    expect(source).toContain('fold.open = st ? (frozen ? st.open : processing) : processing')
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
    // 流式工具行走 ToolRow 共享 partial：class 透传 stream-tool-row + plain 恒纯行（io 只进落库）
    expect(source).toMatch(/<ToolRow v-else[\s\S]{0,90}stream-tool-row[\s\S]{0,90}plain \/>/)
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

  it('历史消息思考+工具单折叠：thinkingContent 或 toolContent 存在才渲染默认收起 thinking-block（无独立 tool-area）', () => {
    expect(source).toMatch(
      /<details\s+v-if="msg\.thinkingContent \|\| msg\.toolContent\?\.length"\s+class="thinking-block stored-thinking"/
    )
    expect(source).toContain(':open="false"')
    expect(source).toContain('class="fold-tool-list"')
    expect(source).not.toContain('class="tool-area"')
  })

  it('历史折叠块工具行渲染抽 ToolRow 共享 partial：退化路径按 msg.toolContent 驱动（行级 io/status 渲染单源收在 ToolRow.vue）', () => {
    expect(source).toContain('<template v-for="(t, ti) in msg.toolContent" :key="ti">')
    expect(source).toContain('<ToolRow :tool="t" />')
    // name/status/io 行级渲染不再在 ChatPanel 内联复制（io 门控/展开逻辑收在 ToolRow.vue）
    expect(source).not.toContain('toolHasIo(t)')
    expect(source).not.toContain('toolIoText(t.input)')
    expect(source).not.toContain('toolStatusLabel(t.status)')
    expect(toolRowSource).toContain('function toolHasIo(t: ToolCallInfo): boolean')
    expect(toolRowSource).toContain('toolStatusLabel(tool.status)')
    expect(toolRowSource).toContain('class="tool-row-io"')
    expect(toolRowSource).toContain('toolIoText(tool.input)')
    expect(toolRowSource).toContain('toolIoText(tool.output)')
    expect(toolRowSource).toContain('v-if="tool.truncated"')
  })
})

describe('ChatPanel 历史消息 segments 交错还原（segments 落库后时间序优先 + 老消息退化）', () => {
  it('storedFoldEntries：有 segments 时按时间序产出 thinking/tool 交错条目（tool 按 id join tool_content 补 io、text 段跳过）', () => {
    expect(source).toContain('function storedFoldEntries(msg: Message): StoredFoldEntry[] | null')
    expect(source).toContain('if (!msg.segments?.length) return null')
    expect(source).toContain('const byId = new Map<string, ToolCallInfo>()')
    expect(source).toContain("if (seg.kind === 'text') continue")
    expect(source).toContain('full = byId.get(t.id)')
    expect(source).toContain("entries.push({ kind: 'thinking', content: seg.content })")
    expect(source).toContain("entries.push({ kind: 'tool', tool: full ?? t })")
  })

  it('历史折叠块内容体两路径：新消息走 stream-fold-body 时间序交错；老消息走 template v-else 两块退化（零回归）', () => {
    // 新消息（segments 落库）：折叠块内按时间序交错渲染思考段 + 工具行
    expect(source).toContain('v-if="storedFoldEntries(msg)" class="stream-fold-body"')
    expect(source).toContain('<template v-for="(e, ei) in storedFoldEntries(msg)" :key="ei">')
    expect(source).toContain('class="fold-thinking"')
    expect(source).toContain('v-html="renderMarkdown(e.content)"')
    // 新消息交错路径工具行走 ToolRow 共享 partial（io 分支由 ToolRow 内部 toolHasIo 决定）
    expect(source).toMatch(/<ToolRow v-else :tool="e\.tool" \/>/)
    // 老消息退化路径仍保留（thinking blob + fold-tool-list 两块，工具行同样走 ToolRow）
    expect(source).toContain('v-html="renderThinkingMarkdown(msg)"')
    expect(source).toContain('class="fold-tool-list"')
    expect(source).toContain('<ToolRow :tool="t" />')
  })
})

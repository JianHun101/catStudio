import { describe, it, expect } from 'vitest'
import source from './SessionAgentsPanel.vue?raw'

/**
 * Verify SessionAgentsPanel.vue — 会话右侧边栏（clowder-ai 精简评估面板，单 B1）。
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. 用户决策：右侧边栏恢复但更精简
 * （低密度分区卡片：状态指示/统计计数/会话成员/队列/折叠配置），严禁恢复旧版
 * 300px 高密度运行控制台（9dc5619^ 那版：进度条/停止按钮全量）。停止按钮归
 * ChatPanel 气泡（B2），本面板不装——避免双实现。
 */

describe('SessionAgentsPanel 精简面板结构（clowder-ai 模式）', () => {
  it('无会话空态：不报错，提示选择会话', () => {
    expect(source).toContain('v-if="!store.activeSessionId"')
    expect(source).toContain('选择会话后展示成员与用量')
  })

  it('统计计数卡：消息总数 / 猫咪回复数（从 store 消息列表计数，零额外请求）', () => {
    expect(source).toContain('stat-card')
    expect(source).toContain('messageStats.total')
    expect(source).toContain('messageStats.agent')
    expect(source).toContain('store.activeMessages')
    expect(source).toContain("m.role === 'agent'")
    expect(source).toContain('消息总数')
    expect(source).toContain('猫咪回复')
  })

  it('会话成员卡：头像/名/状态点/状态文字 + 排队数徽章（agentStates 实时）', () => {
    expect(source).toContain('v-for="agent in memberAgents"')
    expect(source).toContain('agent.avatar')
    expect(source).toContain('member-name')
    expect(source).toContain('statusFor(agent.id)')
    expect(source).toContain('queueFor(agent.id)')
    expect(source).toContain('队列 {{ queueFor(agent.id) }}')
  })

  it('tokens 用数字而非进度条：{用量}/{上限}（fmtTokens，与气泡 footer 同一数字体系）', () => {
    expect(source).toContain('member-tokens')
    expect(source).toContain('tokensText(agent.id)')
    expect(source).toContain('store.contextTokens.get(agentId)')
    expect(source).toContain('store.agentTokenStats.get(agentId)?.maxContextTokens')
    expect(source).toContain('store.contextConfig.maxContextTokens')
    // 数字格式化 12.4k / 128k（k 后去末尾 .0）
    expect(source).toContain("(n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k'")
    // 严禁恢复进度条渲染
    expect(source).not.toContain('token-bar')
    expect(source).not.toContain('progress')
  })

  it('调度队列信息：agentStateList 过滤会话成员 + 排队数', () => {
    expect(source).toContain('store.agentStateList.filter')
    expect(source).toContain('s.queueLength > 0')
    expect(source).toContain('调度队列')
    expect(source).toContain('暂无排队任务')
  })

  it('折叠配置层级（clowder-ai 折叠风格）：广播模式开关走 store.toggleBroadcast', () => {
    expect(source).toContain('class="config-section"')
    expect(source).toContain('config-summary')
    expect(source).toContain('store.broadcastMode')
    expect(source).toContain('store.toggleBroadcast()')
    expect(source).toContain('role="switch"')
  })

  it('成员卡不装停止按钮（归 ChatPanel 气泡，避免双实现）', () => {
    expect(source).not.toContain('interruptAgent')
    expect(source).not.toContain('stopAgent')
    expect(source).not.toContain('btn-stop')
  })
})

describe('SessionAgentsPanel 成员管理（PATCH addAgentIds/removeAgentIds）', () => {
  it('添加列表排除已在会话的 agent（addableAgents 过滤 activeSession.agentIds）', () => {
    expect(source).toContain('const addableAgents = computed')
    expect(source).toContain('store.agents.filter((a) => !ids.has(a.id))')
    expect(source).toContain('store.activeSession?.agentIds')
    expect(source).toContain('＋ 添加猫咪')
  })

  it('添加：多选 → api.updateSessionAgents(addAgentIds) → 关闭弹层（刷新由 SESSION_UPDATE 广播驱动）', () => {
    expect(source).toContain('selectedAddIds.value = []')
    expect(source).toContain('@change="togglePick(agent.id)"')
    expect(source).toContain('api.updateSessionAgents(store.activeSessionId, {')
    expect(source).toContain('addAgentIds: selectedAddIds.value')
    expect(source).toContain('pickerOpen.value = false')
    expect(source).toContain('SESSION_UPDATE')
  })

  it('移除：成员卡 ✕ → api.updateSessionAgents(removeAgentIds: [agentId])', () => {
    expect(source).toContain('removeAgent(agent.id)')
    expect(source).toContain('removeAgentIds: [agentId]')
    expect(source).toContain('aria-label="移除"')
  })

  it('多选弹层：空列表禁用确认 + 已选计数 + 取消', () => {
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('所有猫咪都已在会话中')
    expect(source).toContain(':disabled="selectedAddIds.length === 0 || adding"')
    expect(source).toContain('已选 {{ selectedAddIds.length }} 只')
  })
})

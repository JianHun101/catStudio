import { describe, it, expect } from 'vitest'
import source from './AgentPanel.vue?raw'

/**
 * Verify AgentPanel.vue's stop button (AGENT_INTERRUPT) wiring.
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist (same convention as
 * AgentEditModal.test.ts). Regression protection for the "停止" button:
 * - visible when busy OR queue > 0, hidden when idle
 * - hidden via `visibility` (not v-if) so status-area width stays constant —
 *   the 6897e8e layout-jump fix (灰点锚点不漂移) must not regress
 * - click stops propagation (card click opens edit modal) and goes through
 *   the store's socket wrapper (interruptAgent → AGENT_INTERRUPT emit)
 */

describe('AgentPanel stop button', () => {
  it('renders 停止 button with click.stop + store.interruptAgent wiring', () => {
    expect(source).toMatch(/@click\.stop="stopAgent\(agent\.id\)"/)
    expect(source).toMatch(
      /function stopAgent\(agentId: string\): void \{[\s\S]*store\.interruptAgent\(agentId\)/
    )
  })

  it('shows when busy OR queueLength > 0 (canStop)', () => {
    expect(source).toMatch(/canStop\(agent\.id\)/)
    expect(source).toMatch(/agentStatus\(agentId\) === 'busy' \|\| agentQueue\(agentId\) > 0/)
  })

  it('hides via visibility class (not v-if) — layout stability', () => {
    // v-if 移除 DOM 会改变 status-area 宽度 → 顶行布局跳动（6897e8e 已修问题回归）
    expect(source).toMatch(/'btn-stop-hidden': !canStop\(agent\.id\)/)
    expect(source).toMatch(/\.btn-stop-hidden \{\s*visibility: hidden;/)
    expect(source).not.toMatch(/v-if="canStop/)
  })

  it('keeps btn-retry-sm style base', () => {
    expect(source).toMatch(/class="btn-retry-sm btn-stop"/)
  })
})

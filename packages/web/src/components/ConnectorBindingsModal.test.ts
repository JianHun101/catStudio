import { describe, it, expect } from 'vitest'
import source from './ConnectorBindingsModal.vue?raw'

/**
 * Verify ConnectorBindingsModal.vue's binding CRUD flow.
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. Regression protection for
 * the QQ binding config page: frontend form validation must match the
 * backend contract (connectors.ts: externalId pure digits, sessionId
 * required) so invalid input never reaches the network.
 */

describe('ConnectorBindingsModal form validation', () => {
  it('externalId validates as pure digits before sending (backend contract)', () => {
    // Must be /^\d+$/ — matches normalizeExternalId in routes/connectors.ts.
    // A frontend gap here would surface as a 400 round-trip for every typo.
    expect(source).toMatch(/\/\^\\d\+\$\/\.test\(externalId\.value\.trim\(\)\)/)
  })

  it('sessionId required — blocks submit with readable message', () => {
    expect(source).toContain('请选择要绑定的会话')
    expect(source).toMatch(/!sessionId\.value/)
  })

  it('create goes through api.createConnectorBinding with camelCase contract fields', () => {
    // API boundary converts snake_case (DB rows) to camelCase — must send
    // externalType/externalId/sessionId, not external_type.
    expect(source).toContain('await api.createConnectorBinding({')
    expect(source).toContain('externalType: externalType.value')
    expect(source).toContain('externalId: externalId.value.trim()')
  })

  it('delete goes through api.deleteConnectorBinding with snake_case binding row fields', () => {
    // Binding rows come back snake_case from GET (no camelCase mapping at
    // this API boundary) — delete must read external_type/external_id.
    expect(source).toContain('await api.deleteConnectorBinding({')
    expect(source).toContain('externalType: binding.external_type')
    expect(source).toContain('externalId: binding.external_id')
  })
})

describe('ConnectorBindingsModal list rendering', () => {
  it('maps external_type to 群聊/私聊 labels', () => {
    expect(source).toContain('typeLabel(b.external_type)')
    expect(source).toContain("'群聊'")
    expect(source).toContain("'私聊'")
  })

  it('session title joins via store.sessions with raw-id fallback', () => {
    // 派活单：session_id 用 getSessions() join 出标题，查不到显示原始 id。
    // store.sessions is the GET /api/sessions result — same source, no extra request.
    expect(source).toMatch(/store\.sessions\.find\(\(s\) => s\.id === id\)\?\.title \|\| id/)
  })

  it('delete uses two-step confirm (first click arms, second executes)', () => {
    expect(source).toMatch(/confirmDeleteId\.value !== binding\.external_id/)
    expect(source).toContain('confirmDeleteId.value = binding.external_id')
    expect(source).toContain('确认删除？')
  })

  it('loads bindings on mount and refreshes after add/delete', () => {
    expect(source).toContain('onMounted(loadBindings)')
    expect(source).toContain('await loadBindings() // POST 成功后刷新列表')
    expect(source).toContain('await loadBindings() // DELETE 成功后刷新列表')
  })
})

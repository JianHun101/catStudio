import { describe, it, expect } from 'vitest'
import source from './AgentEditModal.vue?raw'

/**
 * Verify AgentEditModal.vue's handleSave payload construction.
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. This is regression
 * protection against the "llmBaseUrl cannot be cleared" bug: the old
 * `llmBaseUrl.value || undefined` made axios drop the key from the JSON
 * body (undefined properties are not serialized), so the backend's
 * partial-update semantics (`body[key] !== undefined` only) skipped the
 * field and the DB kept the old value forever.
 */

describe('AgentEditModal handleSave payload', () => {
  it('sends llmBaseUrl as-is (empty string serializes, undefined would be dropped)', () => {
    // Must be `llmBaseUrl: llmBaseUrl.value,` — same pattern as llmApiKey.
    // An empty string "" survives JSON serialization and passes the
    // backend `!== undefined` partial-update check.
    expect(source).toMatch(/llmBaseUrl: llmBaseUrl\.value,/)
  })

  it('removed the old `|| undefined` coercion', () => {
    expect(source).not.toContain('llmBaseUrl: llmBaseUrl.value || undefined')
  })

  it('llmApiKey keeps the as-is pattern (untouched sibling field)', () => {
    expect(source).toMatch(/llmApiKey: llmApiKey\.value,/)
  })
})

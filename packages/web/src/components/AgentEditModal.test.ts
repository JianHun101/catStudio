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

describe('AgentEditModal 静态运行配置字段（B2——单 A 契约 llmMaxTokens/llmTemperature）', () => {
  it('watch 从 agent 读新字段，缺省 2048/0.7（与 DB 列默认一致）', () => {
    expect(source).toContain('(a as any).llmMaxTokens ?? 2048')
    expect(source).toContain('(a as any).llmTemperature ?? 0.7')
  })

  it('handleSave 传 llmMaxTokens/llmTemperature（camelCase 契约，Number 归一化）', () => {
    expect(source).toContain('llmMaxTokens: Number(llmMaxTokens.value)')
    expect(source).toContain('llmTemperature: Number(llmTemperature.value)')
  })

  it('前端校验对齐后端契约：maxTokens 正整数 1..131072、温度 0..2——不通过不发请求', () => {
    expect(source).toContain('validateRuntimeConfig')
    expect(source).toContain('maxTokens < 1 || maxTokens > 131072')
    expect(source).toContain('temp < 0 || temp > 2')
    expect(source).toContain('if (!validateRuntimeConfig()) return')
    expect(source).toContain('Max Tokens 必须是 1~131072 的整数')
    expect(source).toContain('温度必须是 0~2 之间的小数')
  })

  it('模板输入项：type=number + min/max/step 与契约对齐', () => {
    expect(source).toContain('v-model.number="llmMaxTokens"')
    expect(source).toContain('v-model.number="llmTemperature"')
    expect(source).toContain('min="1"')
    expect(source).toContain('max="131072"')
    expect(source).toContain('min="0"')
    expect(source).toContain('max="2"')
  })
})

describe('AgentEditModal opencode provider（店长追加派活——设置界面可直接添加 opencode 猫）', () => {
  it('providerOptions 含 OpenCode (CLI) 项', () => {
    expect(source).toContain("{ value: 'opencode', label: 'OpenCode (CLI)' }")
  })

  it('providerHint 有 opencode case：提示本地认证无需填 key + 模型填 provider/model 格式', () => {
    expect(source).toContain("case 'opencode':")
    expect(source).toContain('opencode auth login')
    expect(source).toContain('本地认证无需填 key')
    expect(source).toContain('provider/model 格式')
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { parseClaudeCodeOutput, spawnSupervised } from './cli-utils.js'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用
vi.mock('./cli-utils.js', () => ({
  resolveBin: vi.fn(() => '/usr/local/bin/claude'),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  parseClaudeCodeOutput: vi.fn(),
  attachIdleTimeout: vi.fn(() => () => {}),
  spawnSupervised: vi.fn(),
  // MCP_SERVER_PATH 模块级常量依赖（真实路径在测试中不触达——spawn 被 mock）
  getWorkspaceDir: vi.fn(() => '/tmp/workspace'),
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { ClaudeAdapter } from './claude.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

/**
 * 内置工具黑名单期望全列（验收 #8 关键裁决——知识库 Phase 1 沿用）。
 * 与 claude.ts BUILTIN_TOOLS_DISALLOWED 同源钉死：「含 Bash 且非空」判据拦不住
 * 删减（10070d1/00a9a95 历史实证）——全列精确比对（数量 + 顺序双锁）才是防
 * 静默清空/删减再犯的完整闭环。修改黑名单必须同步更新本数组与 claude.ts 常量。
 * 第二步收权限（店长裁决）：从 28 工具全列收窄为工程面最小集 24 项，
 * WebSearch 放行后为 23 项，二次放行 14 项（2026-08-09 实测实证驱动，
 * 用户裁决「除 skill 外放行」）后为 9 项——
 * 保留 Bash（危险命令面 Bash(rm:*)/Bash(curl:*) 命令级禁，spike 实证生效）、
 * Read/Write/Edit/Glob/Grep；维持禁 9 项：WebFetch（实测不可用）、
 * SendMessage/AskUserQuestion（已被 MCP post_message / request_user_action
 * 替代）、EnterPlanMode/ExitPlanMode（方案决策写成 skill）、
 * EnterWorktree/ExitWorktree（git 命令等效）。路径 B 全局单一配置；
 * per-agent 分档（含收口动作 merge/push 按角色区分）记为收口链待办。
 */
const EXPECTED_DISALLOWED = [
  'Bash(rm:*)',
  'Bash(curl:*)',
  'WebFetch',
  'SendMessage',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
]

describe('ClaudeAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })
    expect(adapter.provider).toBe('claude')
  })

  // ─── 外部取消 ────────────────────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })

  // ─── buildEnv ─────────────────────────────────

  it('buildEnv sets all required environment variables', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
      effortLevel: 'high',
    })

    // 通过私有方法访问（用 any 绕过 TypeScript 检查）
    const env = (adapter as any).buildEnv() as Record<string, string>

    expect(env.DEEPSEEK_API_KEY).toBe('sk-test-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key')
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  it('buildEnv keeps DeepSeek tier fallbacks when no baseUrl (regression)', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
      effortLevel: 'high',
    })

    const env = (adapter as any).buildEnv() as Record<string, string>

    // DeepSeek 路径：HAIKU/SUBAGENT 兜底 flash，无 FABLE 覆盖，
    // ENABLE_TOOL_SEARCH 显式 false（MCP spike case 5 实锤 ToolSearch 真实执行——必须项）
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
  })

  // K5 后为能力保留测试——生产 judge 接线已改走 deepseek adapter（OpenAI 兼容 HTTP，
  // https://api.moonshot.cn），本测试不再反映生产 judge 接线形态，仅验证 claude 适配器
  // 对自定义端点的 buildEnv 能力（模型层兜底/禁用 Tool Search）
  it('buildEnv targets custom endpoint with model tier fallbacks (Kimi K3)', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-kimi-key',
      model: 'kimi-k3[1m]',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      effortLevel: 'max',
    })

    const env = (adapter as any).buildEnv() as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-kimi-key')
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k3[1m]')
    // 非 DeepSeek 端点：HAIKU/SUBAGENT/FABLE 全量兜底主模型
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('kimi-k3[1m]')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k3[1m]')
    // Kimi 端点不支持 Tool Search
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })

  // ─── buildEnv context 透传（MCP 结构化路由五变量，契约 4——店长裁决）───

  it('buildEnv with context passes five MCP variables', () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
    const env = (adapter as any).buildEnv({
      sessionId: 'session-1',
      agentId: 'agent-impl',
      msgId: 'msg-1',
      token: 'tok-1',
      traceId: 'trace-1',
    }) as Record<string, string>

    expect(env.CATSTUDY_SERVER_URL).toBe('http://127.0.0.1:3200')
    expect(env.CATSTUDY_SIGNAL_TOKEN).toBe('tok-1')
    expect(env.CATSTUDY_SESSION_ID).toBe('session-1')
    expect(env.CATSTUDY_AGENT_ID).toBe('agent-impl')
    expect(env.CATSTUDY_MSG_ID).toBe('msg-1')
  })

  it('buildEnv without context omits MCP variables (regression baseline)', () => {
    // 测试隔离：本测试可能在 MCP server 子进程环境下运行（spawn 时注入
    // CATSTUDY_* 变量，buildEnv 的 ...process.env 会原样透传）——清理后再断言
    const saved = {
      token: process.env.CATSTUDY_SIGNAL_TOKEN,
      sessionId: process.env.CATSTUDY_SESSION_ID,
      msgId: process.env.CATSTUDY_MSG_ID,
    }
    delete process.env.CATSTUDY_SIGNAL_TOKEN
    delete process.env.CATSTUDY_SESSION_ID
    delete process.env.CATSTUDY_MSG_ID
    try {
      const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
      const env = (adapter as any).buildEnv() as Record<string, string>
      expect(env.CATSTUDY_SIGNAL_TOKEN).toBeUndefined()
      expect(env.CATSTUDY_SESSION_ID).toBeUndefined()
      expect(env.CATSTUDY_MSG_ID).toBeUndefined()
    } finally {
      if (saved.token !== undefined) process.env.CATSTUDY_SIGNAL_TOKEN = saved.token
      if (saved.sessionId !== undefined) process.env.CATSTUDY_SESSION_ID = saved.sessionId
      if (saved.msgId !== undefined) process.env.CATSTUDY_MSG_ID = saved.msgId
    }
  })

  // ─── chatStream MCP 挂载（--mcp-config / --allowedTools / --disallowedTools）───

  it('chatStream with context mounts MCP config and cleans up temp file', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
    const spawned = { on: vi.fn(), stderr: null, kill: vi.fn(), exitCode: null, killed: false }
    vi.mocked(spawnSupervised).mockReturnValue(spawned as any)
    vi.mocked(parseClaudeCodeOutput).mockImplementation(async function* () {
      yield { content: 'hi', done: false }
      yield { content: '', done: true }
    })

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        context: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', token: 'tok-1' },
      })
    )
    expect(chunks.at(-1)?.done).toBe(true)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    expect(args).toContain('--mcp-config')
    expect(args).toContain('--allowedTools')
    expect(args).toContain('--disallowedTools')
    // 白名单双工具并存（逗号串单值——知识库 Phase 1 扩面）
    const allowedIdx = args.indexOf('--allowedTools')
    expect(args[allowedIdx + 1]).toContain('mcp__catstudy__post_message')
    expect(args[allowedIdx + 1]).toContain('mcp__catstudy__search_knowledge')
    // .mcp.json 生成后由 finally 清理——断言临时文件已删
    const cfgIdx = args.indexOf('--mcp-config')
    expect(cfgIdx).toBeGreaterThan(-1)
    expect(existsSync(args[cfgIdx + 1])).toBe(false)
  })

  // ─── 验收 #8（知识库 Phase 1 沿用）：黑名单全列精确比对（第二步收权限二次放行后 9 项）───

  it('chatStream with context disallows engineering-minimal tool list (exact, order-locked)', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
    const spawned = { on: vi.fn(), stderr: null, kill: vi.fn(), exitCode: 0, killed: false }
    vi.mocked(spawnSupervised).mockReturnValue(spawned as any)
    vi.mocked(parseClaudeCodeOutput).mockImplementation(async function* () {
      yield { content: '', done: true }
    })

    await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        context: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', token: 'tok-1' },
      })
    )
    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    const idx = args.indexOf('--disallowedTools')
    expect(idx).toBeGreaterThan(-1)
    // 全列精确比对（数量 + 顺序双锁）——防静默清空/删减再犯
    expect(args[idx + 1]).toBe(EXPECTED_DISALLOWED.join(','))
    expect(EXPECTED_DISALLOWED).toHaveLength(9)
  })

  // ─── 验收 #5/#6（知识库 Phase 1）：白名单双工具并存 ───

  it('chatStream with context allows both MCP tools (post_message + search_knowledge)', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
    const spawned = { on: vi.fn(), stderr: null, kill: vi.fn(), exitCode: 0, killed: false }
    vi.mocked(spawnSupervised).mockReturnValue(spawned as any)
    vi.mocked(parseClaudeCodeOutput).mockImplementation(async function* () {
      yield { content: '', done: true }
    })

    await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        context: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', token: 'tok-1' },
      })
    )
    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('mcp__catstudy__post_message,mcp__catstudy__search_knowledge')
  })

  it('chatStream without context keeps baseline args (no MCP flags)', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-6' })
    const spawned = { on: vi.fn(), stderr: null, kill: vi.fn(), exitCode: 0, killed: false }
    vi.mocked(spawnSupervised).mockReturnValue(spawned as any)
    vi.mocked(parseClaudeCodeOutput).mockImplementation(async function* () {
      yield { content: '', done: true }
    })

    await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6' })
    )
    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--disallowedTools')
  })
})

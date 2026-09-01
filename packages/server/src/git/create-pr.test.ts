/**
 * git/create-pr.ts 测试。
 *
 * 策略：mock 最外层边界——`node:child_process` 的 execFile（createPr 唯一 I/O 通道，
 * 真实 gh/git 绝不在测试环境执行）与 `../llm/git-utils.js`（getMainRepoRoot 返回假主仓库根、
 * cleanGitEnv 空 env）。按 `cmd + args[0]` 分发 mock 响应（gh auth / git ls-remote / gh pr），
 * 断言 createPr 的参数组装与全部错误分支。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn() }
})

vi.mock('../llm/git-utils.js', () => ({
  getMainRepoRoot: vi.fn(() => 'C:\\fake\\main'),
  cleanGitEnv: () => ({}),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

/** mock 命令响应分发表：key = `${cmd} ${args[0]}`；code 非 0 → reject 带 stderr */
type Handler = (args: string[]) => { stdout?: string; stderr?: string; code?: number }
function stubExec(handlers: Record<string, Handler>): void {
  vi.mocked(execFile).mockImplementation(((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: any
  ) => {
    const handler = handlers[`${cmd} ${args[0] ?? ''}`]
    if (!handler) {
      cb(new Error(`unexpected command: ${cmd} ${args.join(' ')}`), '', '')
      return {} as any
    }
    const out = handler(args)
    const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`) as any
    err.stderr = out.stderr ?? ''
    err.stdout = out.stdout ?? ''
    if (out.code) cb(err, err.stdout, err.stderr)
    else cb(null, out.stdout ?? '', out.stderr ?? '')
    return {} as any
  }) as any)
}

/** 断言指定命令的最后一次调用 argv */
function lastArgs(cmd: string, arg0: string): string[] {
  const calls = vi
    .mocked(execFile)
    .mock.calls.filter((c) => c[0] === cmd && (c[1] as string[])[0] === arg0)
  return calls[calls.length - 1][1] as string[]
}

const MAIN_ROOT = 'C:\\fake\\main'

describe('createPr', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { getMainRepoRoot } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue(MAIN_ROOT)
    stubExec({
      'gh auth': () => ({ stdout: 'logged in to github.com' }),
      'git ls-remote': () => ({ stdout: 'abc123\trefs/heads/feat-x\n' }),
      'gh pr': () => ({
        stdout: '{"number":123,"url":"https://github.com/org/repo/pull/123"}',
      }),
    })
  })

  it('成功：gh pr create 参数完整（--base dev --head --title --body）+ 返回 { number, url }', async () => {
    const { createPr } = await import('./create-pr.js')
    const res = await createPr({
      head: 'feat-x',
      title: 'feat: 新功能',
      body: '改动说明',
    })

    expect(res).toEqual({
      ok: true,
      number: 123,
      url: 'https://github.com/org/repo/pull/123',
    })
    expect(lastArgs('gh', 'pr')).toEqual([
      'pr',
      'create',
      '--base',
      'dev',
      '--head',
      'feat-x',
      '--title',
      'feat: 新功能',
      '--body',
      '改动说明',
      '--json',
      'number,url',
    ])
    // 所有命令都在主仓库根执行（任意位置调用均安全）
    for (const call of vi.mocked(execFile).mock.calls) {
      expect((call[2] as { cwd?: string }).cwd).toBe(MAIN_ROOT)
    }
  })

  it('base 显式传值覆盖默认 dev；body 缺省不传 --body', async () => {
    const { createPr } = await import('./create-pr.js')
    const res = await createPr({ base: 'main', head: 'feat-y', title: 'T' })

    expect(res).toEqual({ ok: true, number: 123, url: 'https://github.com/org/repo/pull/123' })
    expect(lastArgs('gh', 'pr')).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'feat-y',
      '--title',
      'T',
      '--json',
      'number,url',
    ])
  })

  it('gh 未 auth → not-authed 不静默 + 不执行 pr create', async () => {
    stubExec({
      'gh auth': () => ({ code: 1, stderr: 'Please run: gh auth login' }),
    })
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    expect(res).toEqual({
      ok: false,
      reason: 'not-authed',
      error: 'Please run: gh auth login',
    })
    expect(
      vi.mocked(execFile).mock.calls.some((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'pr')
    ).toBe(false)
  })

  it('分支未 push（远端无 ref）→ branch-not-pushed 不静默', async () => {
    stubExec({
      'gh auth': () => ({ stdout: 'ok' }),
      'git ls-remote': () => ({ code: 2, stderr: '' }),
    })
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    // stderr 空 → 兜底 err.message（ls-remote --exit-code 分支不存在时 exit 2、stderr 常为空）
    expect(res).toEqual({
      ok: false,
      reason: 'branch-not-pushed',
      error: 'Command failed: git ls-remote --exit-code origin feat-x',
    })
    // 未 push 不走到 gh pr create
    expect(
      vi.mocked(execFile).mock.calls.some((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'pr')
    ).toBe(false)
  })

  it('gh pr create 返回非零 → create-failed 透传 stderr', async () => {
    stubExec({
      'gh auth': () => ({ stdout: 'ok' }),
      'git ls-remote': () => ({ stdout: 'abc123\trefs/heads/feat-x\n' }),
      'gh pr': () => ({ code: 1, stderr: 'pull request create failed: 409 Conflict' }),
    })
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    expect(res).toEqual({
      ok: false,
      reason: 'create-failed',
      error: 'pull request create failed: 409 Conflict',
    })
  })

  it('gh pr create stdout 非合法 JSON → create-failed 报错不静默', async () => {
    stubExec({
      'gh auth': () => ({ stdout: 'ok' }),
      'git ls-remote': () => ({ stdout: 'abc123\trefs/heads/feat-x\n' }),
      'gh pr': () => ({ stdout: 'unexpected output' }),
    })
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('create-failed')
      expect(res.error).toContain('gh 输出无法解析')
      expect(res.error).toContain('unexpected output')
    }
  })

  it('gh 未安装（ENOENT，stderr 空）→ not-authed 兜底 err.message 不静默', async () => {
    vi.mocked(execFile).mockImplementation(((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: any
    ) => {
      if (cmd === 'gh') {
        const err = new Error('spawn gh ENOENT') as any
        err.stderr = ''
        err.stdout = ''
        cb(err, '', '')
        return {} as any
      }
      cb(null, 'abc123\trefs/heads/feat-x\n', '')
      return {} as any
    }) as any)
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    expect(res).toEqual({ ok: false, reason: 'not-authed', error: 'spawn gh ENOENT' })
  })

  it('主仓库根定位失败 → no-main-root', async () => {
    const { getMainRepoRoot } = await import('../llm/git-utils.js')
    vi.mocked(getMainRepoRoot).mockReturnValue(null)
    const { createPr } = await import('./create-pr.js')

    const res = await createPr({ head: 'feat-x', title: 'T' })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('no-main-root')
    }
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })
})

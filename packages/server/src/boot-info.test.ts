/**
 * `boot-info.ts` 测试（票 A · 启动账本采集层）。
 *
 * 判据面四条，各配反例/真空性对照：
 *
 * 1. **fail-soft**：非仓库目录 ⇒ git 字段全 `null`（不是 0）；真实仓库 ⇒ 根/sha 可读。
 * 2. **dirty 双态**：干净树 ⇒ `0` + 摘要 `null`；`touch` 一个未跟踪文件 ⇒ `1` + 摘要非空
 *    （证明 `status --porcelain` 真在看工作树，而不是恒返回干净）。
 * 3. **剥 `GIT_*`**：注入伪造 `GIT_DIR` 后仍能找到真实仓库根——否则探测会被指到别处。
 * 4. **摘要截断**：超上限时截断且带省略号，长度 ≈ 上限 + 1。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb } from './test-helpers.js'
import { setDb, resetDb } from './db/index.js'
import {
  collectBootInfo,
  collectGitInfo,
  summarizeDirty,
  DIRTY_SUMMARY_MAX,
  GIT_TIMEOUT_MS,
} from './boot-info.js'

/** 入口模块的真实路径（本 worktree 内的仓库文件——用于正向探测） */
const REAL_MODULE = fileURLToPath(import.meta.url)

/** 测试内 git 调用——同样剥 `GIT_*`，否则夹具会被外层钩子的仓库定位劫持 */
function gitRun(cwd: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  execFileSync('git', args, {
    cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

describe('boot-info · summarizeDirty', () => {
  it('空输入 ⇒ 空串（干净树的判据）', () => {
    expect(summarizeDirty('')).toBe('')
    expect(summarizeDirty('\n\n')).toBe('')
  })

  it('多行以 `; ` 连接，保留 porcelain 的状态两字符（不 trim 掉）', () => {
    expect(summarizeDirty(' M a.ts\n?? b.ts\n')).toBe(' M a.ts; ?? b.ts')
  })

  it('超上限截断并加省略号（长度 = 上限 + 1）', () => {
    const long = 'x'.repeat(DIRTY_SUMMARY_MAX + 50)
    const out = summarizeDirty(long)
    expect(out).toHaveLength(DIRTY_SUMMARY_MAX + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('boot-info · collectGitInfo', () => {
  let tmpDirs: string[] = []

  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'catstudy-bootinfo-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
    tmpDirs = []
    vi.unstubAllEnvs()
  })

  it('非仓库目录 ⇒ git 字段全 null（未知不写成 0）', () => {
    const dir = mkTmp()
    const info = collectGitInfo(join(dir, 'module.mjs'))
    expect(info).toEqual({
      git_root: null,
      git_sha: null,
      git_dirty: null,
      dirty_summary: null,
    })
  })

  it('真实仓库 ⇒ 根可读、sha 是 40 位十六进制、dirty ∈ {0,1}', () => {
    const info = collectGitInfo(REAL_MODULE)
    expect(info.git_root).not.toBeNull()
    expect(info.git_sha).toMatch(/^[0-9a-f]{40}$/)
    expect([0, 1]).toContain(info.git_dirty)
  })

  it('注入伪造 GIT_DIR 仍能找到真实根（剥 `GIT_*` 的承重判据）', () => {
    vi.stubEnv('GIT_DIR', resolve(tmpdir(), 'definitely-not-a-repo'))
    const info = collectGitInfo(REAL_MODULE)
    expect(info.git_root).not.toBeNull()
    expect(info.git_sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('dirty 双态：干净树 0/摘要 null；出现未跟踪文件后 1/摘要非空', () => {
    const dir = mkTmp()
    gitRun(dir, ['init', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'a')
    gitRun(dir, ['add', 'a.txt'])
    gitRun(dir, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'init',
    ])

    const moduleFile = join(dir, 'module.mjs')
    const clean = collectGitInfo(moduleFile)
    expect(clean.git_root).toContain(basename(dir))
    expect(clean.git_dirty).toBe(0)
    expect(clean.dirty_summary).toBeNull()

    writeFileSync(join(dir, 'untracked.txt'), 'x')
    const dirty = collectGitInfo(moduleFile)
    expect(dirty.git_dirty).toBe(1)
    expect(dirty.dirty_summary).toContain('untracked.txt')
  })
})

describe('boot-info · collectBootInfo', () => {
  beforeEach(() => {
    setDb(createTestDb())
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  it('身份字段取进程真值；端口用调用方传入的配置意图值', () => {
    const info = collectBootInfo(REAL_MODULE, { port: 4321 })
    expect(info.pid).toBe(process.pid)
    expect(info.port).toBe(4321)
    expect(info.module_file).toBe(REAL_MODULE)
    expect(info.cwd).toBe(process.cwd())
    expect(info.mode).toBe('dev') // vitest 下 NODE_ENV=test ⇒ 非 production
    expect(info.probe_mode).toBe(0)
    expect(info.db_file).toBe(':memory:')
    expect(info.node_version).toBe(process.version)
    // 真实 git 探测面一并带上（与 collectGitInfo 同源）
    expect(info.git_sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('CATSTUDY_PROBE_MODE=1 ⇒ probe_mode=1（探针实例也要写账本）', () => {
    vi.stubEnv('CATSTUDY_PROBE_MODE', '1')
    expect(collectBootInfo(REAL_MODULE, { port: 3200 }).probe_mode).toBe(1)
  })

  it('NODE_ENV=production ⇒ mode=production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(collectBootInfo(REAL_MODULE, { port: 3200 }).mode).toBe('production')
  })

  it('git 探测超时常量是 2s（配置面回归）', () => {
    expect(GIT_TIMEOUT_MS).toBe(2000)
  })
})

/**
 * serial × 一猫一 worktree（T-2 Phase I 接线）——**猫路径**。
 *
 * 判据对象是「猫的改动落在**哪条分支**上」。与 `serial.downgrade.test.ts` 的分工：
 * 那边把夹具钉成 `role: 'store'`（店长仍持会话 worktree，T-1 Phase 2 语义逐字不变），
 * 这边钉成**非 store**（含 `role` 缺失/未知）——票面 V1 要求「两格都要读数，不能只测一格」。
 *
 * **不 mock `../llm/git-utils.js` 与 `node:child_process`**：本票的判据正是「真仓库里
 * 真落到了哪条分支」，mock 掉就是自己证自己。断言一律读**真文件内容**
 * （`git cat-file` / `git log`），不看返回值 exit code——E5 的教训就是「exit 0 ≠ 东西进去了」。
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentConfig } from '@cat-study/shared'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import {
  catBranch,
  catWorktreePath,
  ensureCatWorktree,
  ensureSessionWorktree,
  sessionBranch,
  sessionShortId,
  sessionWorktreePath,
} from '../llm/git-utils.js'

const h = vi.hoisted(() => ({
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
  collectCommitDiffs: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => ({ chatStream: h.chatStream })),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  retrieveMemoryContext: h.retrieveMemoryContext,
  buildKnowledgeContext: h.buildKnowledgeContext,
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: h.collectCommitDiffs,
  GIT_TIMEOUT_MS: 5000,
}))

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../eval/verdict-parser.js', () => ({ recordReviewVerdict: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// ═══ 真 git 临时仓库夹具 ═══

const origCwd = process.cwd()
const origGitEnv: Record<string, string | undefined> = {}

let tmpRepo = ''
let initSha = ''
/** 本文件创建的 worktree 目录（清理用；**不**动共享的 catStudy-sessions 父目录） */
const worktrees: string[] = []

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

function git(args: string[], cwd = tmpRepo): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function gitOrNull(args: string[], cwd = tmpRepo): string | null {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/**
 * **实际文件内容**（票面 V2：不看 exit code，读 blob 本身）。
 *
 * 刻意**不走 `git()`**——那个 helper 带 `.trim()`（为分支名/标题这类单行读数设计），
 * 会把 blob 的尾随换行吃掉，让「内容比对」变成「去尾空白后的比对」。
 */
function fileOnBranch(ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['cat-file', '-p', `${ref}:${path}`], {
      cwd: tmpRepo,
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** 分支末次提交标题（不存在 → null） */
function branchHead(ref: string): string | null {
  return gitOrNull(['log', '-1', '--format=%s', ref])
}

function tracked(path: string): boolean {
  return gitOrNull(['ls-files', '--error-unmatch', path]) !== null
}

const catWtFor = (sessionId: string, catName: string): string => {
  const shortId = sessionShortId(sessionId)
  return catWorktreePath(tmpRepo, shortId, catName)
}

function registerWorktree(p: string | null): void {
  if (p && !worktrees.includes(p)) worktrees.push(p)
}

/** 本文件用到的全部会话 id（逐格唯一，前 8 位互不相同）——残留清扫用 */
const SESSION_IDS = ['scwt0001', 'scwt0002', 'scwt0003', 'scwt0004', 'scwt0005', 'scwt0006']

function dropWorktrees(): void {
  for (const dir of worktrees.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
  // 路径只依赖 `tmpdir()` 与 shortId（**不含**随机仓库名）⇒ 上一次跑崩 / 半途失败
  // 留下的同 id 目录会让 `ensureCatWorktree` 走进「已存在 → 复用」分支并撞上所有权
  // 校验。**实测踩过**：一次反向对照留下的 `<tmpdir>/catStudy-sessions/scwt0006-flash猫`
  // 让 V10 的「集成分支不存在 ⇒ 建不出」前提失效（它是上一轮别的配置建出来的）。
  for (const sid of SESSION_IDS) {
    const paths = [sessionWorktreePath(tmpRepo, sessionShortId(sid))]
    for (const name of [CAT1.name, CAT2.name]) paths.push(catWtFor(sid, name))
    for (const p of paths) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* 不存在/占用 → 忽略 */
      }
    }
  }
  gitOrNull(['worktree', 'prune'])
  // 猫/会话分支也逐条清（分支名带会话 shortId，本文件内的用例外互不串场；
  // reset --hard 不清分支，残留会让下一格「集成分支不存在」的前提失效）
  for (const b of (gitOrNull(['branch', '--format=%(refname:short)']) ?? '')
    .split('\n')
    .filter((n) => n.startsWith('session/'))) {
    gitOrNull(['branch', '-D', b])
  }
}

/** 非 store 猫：`role` 缺失 ⇒ 本票判「按非 store 处理 = 给猫 worktree」（票面 V9） */
const CAT1: AgentConfig = {
  id: 'cat-1',
  name: 'flash猫',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'claude',
  llmModel: 'claude-sonnet-5',
  llmApiKey: 'sk-test',
}

/** 显式 role='implementer' 的实施猫（与 CAT1 的差别只有 role 的有无） */
const CAT2: AgentConfig = { ...CAT1, id: 'cat-2', name: '暹罗猫', role: 'implementer' }

/** 店长（对照组：仍需落会话 worktree） */
const STORE: AgentConfig = { ...CAT1, id: 'store-1', name: '店长', role: 'store' }

const ALL_AGENTS = [CAT1, CAT2, STORE]

async function runRound(
  sessionId: string,
  triggerId: string,
  agent: AgentConfig,
  traceId = `trace-${triggerId}`
): Promise<void> {
  const engine = createExecutionEngine(createFakeBus()) as ExecutionEngine &
    ExecutionEngineTestHooks
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, title, agent_ids, broadcast_mode)
     VALUES (?, '测试会话', '["cat-1","cat-2","store-1"]', 0)`
  ).run(sessionId)
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, session_id, role, content, mentions)
     VALUES (?, ?, 'user', '你好', '[]')`
  ).run(triggerId, sessionId)
  await engine.executeAgentsSerial(
    sessionId,
    [agent],
    { id: triggerId, content: '你好', mentions: [] },
    traceId,
    0
  )
}

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: () => {},
    emitSystemNotice: () => {},
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

beforeAll(() => {
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) {
    origGitEnv[k] = process.env[k]
    delete process.env[k]
  }

  tmpRepo = mkdtempSync(join(tmpdir(), 'serial-catwt-repo-'))
  execFileSync('git', ['init'], { cwd: tmpRepo, env: cleanGitEnv(), stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], {
    cwd: tmpRepo,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  execFileSync('git', ['config', 'user.email', 'test@test.local'], {
    cwd: tmpRepo,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  // 行尾钉死（Windows autocrlf 会把内容比对变成行尾比对）
  execFileSync('git', ['config', 'core.autocrlf', 'false'], {
    cwd: tmpRepo,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  execFileSync('git', ['checkout', '-b', 'dev'], {
    cwd: tmpRepo,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  writeFileSync(resolve(tmpRepo, 'tracked.txt'), 'base\n', 'utf-8')
  writeFileSync(resolve(tmpRepo, '.gitignore'), 'node_modules/\n', 'utf-8')
  for (const pkg of ['server', 'shared', 'web']) {
    mkdirSync(resolve(tmpRepo, 'packages', pkg), { recursive: true })
    writeFileSync(resolve(tmpRepo, 'packages', pkg, '.gitkeep'), '', 'utf-8')
  }
  git(['add', '-A'])
  git(['commit', '-m', 'init'])
  initSha = git(['rev-parse', 'HEAD'])
  process.chdir(tmpRepo)
})

afterAll(() => {
  process.chdir(origCwd)
  dropWorktrees()
  try {
    rmSync(tmpRepo, { recursive: true, force: true })
  } catch {
    /* 兜底清理失败忽略 */
  }
  for (const [k, v] of Object.entries(origGitEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('serial × 一猫一 worktree（猫路径，T-2 Phase I）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    dropWorktrees()
    git(['reset', '--hard', initSha])
    git(['clean', '-fdx'])
    process.chdir(tmpRepo)

    const db = createTestDb()
    setDb(db)
    initDb()
    initRepository(db)
    for (const a of ALL_AGENTS) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, '🐱', 'p', 'claude', 'claude-sonnet-5', 'sk-test', ?)`
        // role 列 NOT NULL：CAT1 用 'unknown'（= 老库迁移默认值，不在 AgentRole 里）
        // ——正是票面 V9「role 缺失/未知 ⇒ 走猫 worktree」要覆盖的形态
      ).run(a.id, a.name, a.role ?? 'unknown')
    }

    h.retrieveMemoryContext.mockResolvedValue({
      text: '',
      reason: 'no-hit',
      sections: [],
      stats: {},
    })
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(0)
      return ''
    })
    h.collectCommitDiffs.mockResolvedValue(null)
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
  })

  afterEach(() => {
    resetDb()
    process.chdir(tmpRepo)
  })

  /**
   * V9 + V1（猫格）：`role` 缺失的猫走**猫 worktree**，改动落**猫分支**。
   * 判据读 `cat-file` 的实际 blob，不是 exit code。
   */
  it('V9/V1 · role 缺失 ⇒ 走猫 worktree；改动落猫分支（cat-file 读实际文件）', async () => {
    const sid = 'scwt0001'
    const shortId = sessionShortId(sid)
    // 集成分支先存在（生产中由店长的会话 worktree 建出）——猫分支从它分叉
    git(['branch', sessionBranch(shortId)])

    const catWt = ensureCatWorktree(sid, CAT1.id, CAT1.name)
    registerWorktree(catWt)
    expect(catWt, '集成分支在 ⇒ 猫 worktree 应建得出').toBeTruthy()
    writeFileSync(resolve(catWt!, 'cat-edit.txt'), 'flash猫 改的\n', 'utf-8')

    await runRound(sid, 'scwt-m1', CAT1)

    // V2 判据：**实际文件内容**出现在猫分支上
    expect(fileOnBranch(catBranch(shortId, CAT1.name), 'cat-edit.txt')).toBe('flash猫 改的\n')
    expect(branchHead(catBranch(shortId, CAT1.name))).toBe('catstudy [scwt-m1]')
    // 集成分支未被猫的提交污染（那是 fan-in 的活）
    expect(fileOnBranch(sessionBranch(shortId), 'cat-edit.txt')).toBeNull()
    // 主仓库零改动（红线锚）
    expect(branchHead('dev')).toBe('init')
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
  })

  /** V2 主体：两只猫各改各的 ⇒ 各自的改动只在自己分支上，互不串（含 role 有/无两形态） */
  it('V2 · 两只猫各改各的 ⇒ 各自分支只含自己的改动；另一只猫的树不受影响', async () => {
    const sid = 'scwt0002'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    const wt1 = ensureCatWorktree(sid, CAT1.id, CAT1.name)
    const wt2 = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(wt1)
    registerWorktree(wt2)
    expect(wt1).toBeTruthy()
    expect(wt2).toBeTruthy()
    expect(wt1).not.toBe(wt2)

    writeFileSync(resolve(wt1!, 'only-cat1.txt'), 'A\n', 'utf-8')
    writeFileSync(resolve(wt2!, 'only-cat2.txt'), 'B\n', 'utf-8')

    await runRound(sid, 'scwt-a', CAT1, 'trace-scwt-a')
    await runRound(sid, 'scwt-b', CAT2, 'trace-scwt-b')

    const b1 = catBranch(shortId, CAT1.name)
    const b2 = catBranch(shortId, CAT2.name)
    // 各自的改动在各自分支上
    expect(fileOnBranch(b1, 'only-cat1.txt')).toBe('A\n')
    expect(fileOnBranch(b2, 'only-cat2.txt')).toBe('B\n')
    // 交叉为零 + 另一只猫的**工作树**里文件仍在（没被对方的提交/清理波及）
    expect(fileOnBranch(b1, 'only-cat2.txt')).toBeNull()
    expect(fileOnBranch(b2, 'only-cat1.txt')).toBeNull()
    expect(existsSync(resolve(wt1!, 'only-cat1.txt'))).toBe(true)
    expect(existsSync(resolve(wt2!, 'only-cat2.txt'))).toBe(true)
    // 集成分支仍停在分叉点（没有任何猫的提交直接落上去）
    expect(branchHead(sessionBranch(shortId))).toBe('init')
  })

  /**
   * V3 的常驻对照（**判据非恒真**的那半）：同一次断言换成店长 ⇒ 改动落**会话分支**、
   * 不进任何猫分支。若「提交落哪棵树的判据」是恒绿的，这一格与上一格不可能同时成立。
   * （V3 要求的「把提交目标改回 `ensureSessionWorktree` ⇒ V2 变红」是**源码级**反向
   * 对照，读数是手跑的，见 report-phase-i.md §三。）
   */
  it('V3 对照 · store 的改动落会话分支、不进任何猫分支（证上两格的判据能分辨）', async () => {
    const sid = 'scwt0003'
    const shortId = sessionShortId(sid)
    const sessWt = ensureSessionWorktree(sid)
    registerWorktree(sessWt)
    expect(sessWt).toBeTruthy()
    writeFileSync(resolve(sessWt!, 'store-edit.txt'), '店长 改的\n', 'utf-8')

    await runRound(sid, 'scwt-s', STORE)

    expect(fileOnBranch(sessionBranch(shortId), 'store-edit.txt')).toBe('店长 改的\n')
    expect(branchHead(sessionBranch(shortId))).toBe('catstudy [scwt-s]')
    // 一只猫的树都没被建出来、更没有猫分支捡到这份改动
    expect(gitOrNull(['branch', '--list', `${sessionBranch(shortId)}-*`])).toBe('')
    expect(fileOnBranch(catBranch(shortId, CAT1.name), 'store-edit.txt')).toBeNull()
  })

  /** 猫名非法 ⇒ 该猫这棵树的解析显式失败，**不静默降级到主仓库**，其余猫照常提交 */
  it('V7 接线面 · 猫名含 `/` ⇒ 该树解析失败不落主仓库；同轮另一只猫照常提交', async () => {
    const sid = 'scwt0004'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // 把 cat-1 的猫名在 DB 里改成含 `/` 的形态（模拟脏数据）
    getDb().prepare(`UPDATE agents SET name = 'a/b' WHERE id = 'cat-1'`).run()

    const wt2 = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(wt2)
    writeFileSync(resolve(wt2!, 'only-cat2.txt'), 'B\n', 'utf-8')

    await runRound(sid, 'scwt-bad', CAT1, 'trace-scwt-bad')
    await runRound(sid, 'scwt-ok', CAT2, 'trace-scwt-ok')

    // 主仓库零改动——非法猫名绝不把提交「降级」到主仓库
    expect(branchHead('dev')).toBe('init')
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
    // 同轮另一只猫的提交照常落自己的分支
    expect(fileOnBranch(catBranch(shortId, CAT2.name), 'only-cat2.txt')).toBe('B\n')
  })

  /** 集成分支**不存在** ⇒ 猫 worktree 建不出 ⇒ 不提交、也绝不落主仓库（T-1 降级语义） */
  it('V10 降级 · 集成分支不存在 ⇒ 猫树建不出、不提交、不落主仓库；存量会话分支不受影响', async () => {
    const sid = 'scwt0005'
    const shortId = sessionShortId(sid)
    // 存量形态：既有 `session/<sid8>` 分支（老会话的集成分支）不该被误伤
    git(['branch', sessionBranch(shortId)])
    // 另一个从未建过集成分支的会话
    const sid2 = 'scwt0006'
    const shortId2 = sessionShortId(sid2)

    await runRound(sid2, 'scwt-nb', CAT1, 'trace-scwt-nb')

    expect(ensureCatWorktree(sid2, CAT1.id, CAT1.name)).toBeNull()
    expect(existsSync(catWtFor(sid2, CAT1.name))).toBe(false)
    expect(branchHead('dev')).toBe('init')
    expect(tracked('tracked.txt')).toBe(true)
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
    // 存量集成分支原样还在，且通配符**同时命中新旧两种形态**
    git(['branch', catBranch(shortId, CAT1.name)])
    const hits = (git(['branch', '--list', `${sessionBranch(shortId)}*`]) ?? '')
      .split('\n')
      .map((s) => s.replace('*', '').trim())
      .filter(Boolean)
      .sort()
    expect(hits).toEqual([sessionBranch(shortId), catBranch(shortId, CAT1.name)].sort())
    expect(existsSync(sessionWorktreePath(tmpRepo, shortId2))).toBe(false)
  })
})

// ─── 就地测试库（与 serial.downgrade.test.ts 同款：内存 SQLite，无磁盘、FK 生效）──
import Database from 'better-sqlite3'
function createTestDb(): Database.Database {
  return new Database(':memory:')
}

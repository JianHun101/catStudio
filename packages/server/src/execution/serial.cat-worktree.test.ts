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
// 形态 G 的合并入口（**不 mock**：本文件的判据就是「真仓库里真合没合进去」）
import { mergeCatBranchesIntoOwnBranch } from '../llm/worktree-fanin.js'

const h = vi.hoisted(() => ({
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
  collectCommitDiffs: vi.fn(),
  // 日志留痕断言用（P3-c：「error 留痕跳树」是本票明写的验收面，只读行为测不出「留痕」）。
  // 提到 hoisted 是因为 `serial.ts` 在模块加载时 `createLogger()` **只调一次**——
  // 工厂里 `vi.fn()` 内联写死的话，句柄随那次调用一起丢掉，事后无从断言。
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: h.logWarn,
    error: h.logError,
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

/**
 * 「`sha` 是否已在 `cwd` 的 `HEAD` 里」——V16 判据的唯一探针。
 *
 * **三态而非布尔**：`git merge-base --is-ancestor` 退出码 0=是、1=否、**其余=出错**
 * （未知 ref / 非仓库 / 参数错）。折成布尔会把「探针本身坏了」读成「不包含」——
 * 而 V16-b 恰恰断言的就是「不包含」，那是本仓反复点名的**假绿门**形态
 * （判据恒真/恒假都不算读数）。三态让「坏探针」与「真结论」在断言上分得开。
 */
function ancestorState(
  sha: string,
  ref: string,
  cwd = tmpRepo
): 'ancestor' | 'not-ancestor' | 'error' {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], {
      cwd,
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
    return 'ancestor'
  } catch (err: any) {
    return err?.status === 1 ? 'not-ancestor' : 'error'
  }
}

/** 猫 worktree 的所有权标记（`branch.<完整分支名>.catAgentId`，写在 `.git/config`） */
function catOwnerMarker(branch: string): string | null {
  return gitOrNull(['config', '--get', `branch.${branch}.catAgentId`])
}

const catWtFor = (sessionId: string, catName: string): string => {
  const shortId = sessionShortId(sessionId)
  return catWorktreePath(tmpRepo, shortId, catName)
}

function registerWorktree(p: string | null): void {
  if (p && !worktrees.includes(p)) worktrees.push(p)
}

/** 本文件用到的全部会话 id（逐格唯一，前 8 位互不相同）——残留清扫用 */
const SESSION_IDS = [
  'scwt0001',
  'scwt0002',
  'scwt0003',
  'scwt0004',
  'scwt0005',
  'scwt0006',
  'scwt0007',
  'scwt0008',
  'scwt0009',
  'scwt0010',
  'scwt0011',
  'scwt0012',
]

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
  // 让「集成分支不存在」的前提失效（它是上一轮别的配置建出来的）。
  // 该危害在本笔后**未消失**，只是落点换了：现在由 V13 / V15 各自的**显式前提断言**
  // （`branch --list` 为空 + 会话 worktree 不存在）把守，而不是靠用例内部的隐式推演
  // ——前提成立与否有了读数，不再是「跑绿了就说明前提在」。
  for (const sid of SESSION_IDS) {
    const paths = [sessionWorktreePath(tmpRepo, sessionShortId(sid))]
    for (const name of ALL_CAT_NAMES) paths.push(catWtFor(sid, name))
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

/**
 * 审查猫（V16 主角）。`role: 'reviewer'` 是本仓真实存在的角色
 * （`AgentRole = 'store' | 'implementer' | 'reviewer'`，`packages/shared/src/types.ts:7`）。
 * **在 cwd 分派上它与其它非 store 猫无差别**——`ensureAgentWorktree` 只判 `=== 'store'`。
 * 本格刻意用它（而非随便一只猫）来钉住「审查者**确实**拿的是自己的猫树」这个前提，
 * 免得读者以为下面的陈旧性是「因为用了某只特殊猫」。
 */
const REVIEWER: AgentConfig = { ...CAT1, id: 'rev-1', name: '吐槽猫', role: 'reviewer' }

/**
 * P3-c-2 所有权冲突的**可达**触发形态：**规范化碰撞**。
 *
 * 字面的「同名不同 agentId」在今天的 schema 下**不可达**——`agents.name` 是
 * `UNIQUE`（`db/index.ts:159`），两只猫不可能真的重名。但 `catSlug` 会剥掉空白
 * （`.replace(/[\s\\~^:?*\["@{]/g, '')`），于是 `甲 猫` 与 `甲猫` 两个**不同的**
 * DB 值归一到**同一条分支 + 同一棵树 + 同一目录**——DB 的 UNIQUE 拦不住它。
 * 这正是所有权标记存在的意义：撞车时不静默共用。
 */
const DUP_A: AgentConfig = { ...CAT1, id: 'dup-1', name: '甲 猫' }
/** 与 DUP_A **规范化后**同名（DB 里是另一个字符串，UNIQUE 不冲突） */
const DUP_B_NAME = '甲猫'

const ALL_AGENTS = [CAT1, CAT2, STORE, REVIEWER, DUP_A]

/** 本文件会建出猫树/猫分支的全部猫名（`dropWorktrees` 清理面） */
const ALL_CAT_NAMES = [CAT1.name, CAT2.name, REVIEWER.name, DUP_A.name, DUP_B_NAME]

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

  /**
   * V13（本笔新增）：**无 store 会话**——集成分支不存在，且本轮唯一执行者是**非 store** 猫。
   * 三格分别断言（票面「补笔：第 3 笔」§验收）：
   * ① 拿到**猫 worktree**（不是 `workspace/` 降级）——直接读 `chatStream` 实收的 `cwd`，
   *    不是「目录存在」这类旁证；② 集成分支被**补建**、fork 点 = 主仓库 HEAD；
   * ③ 该猫的改动 `git cat-file` **读得到**（在猫分支上）。
   *
   * 接线前这三格全不成立（猫树建不出 ⇒ `cwd: undefined` ⇒ 适配器落 `workspace/`，
   * 而它 gitignored ⇒ 改动连 `git status` 都看不见）。反向对照 V14 见报告 §三。
   */
  it('V13 · 无 store 会话 ⇒ 猫侧补建集成分支：cwd=猫树、fork 点=主仓库 HEAD、改动 git 可见', async () => {
    const sid = 'scwt0007'
    const shortId = sessionShortId(sid)
    // 前提：集成分支**不存在**，也没有任何会话 worktree（不成立则本格测的不是补建路径）
    expect(gitOrNull(['branch', '--list', sessionBranch(shortId)])).toBe('')
    expect(existsSync(sessionWorktreePath(tmpRepo, shortId))).toBe(false)

    // 第一轮：不预置任何文件——树必须由**执行链自己**建出来
    await runRound(sid, 'scwt-v13a', CAT1, 'trace-scwt-v13a')

    // ① 拿到猫 worktree —— 读适配器实收的 cwd（`workspace/` 降级会让这里变 undefined）。
    // 先钉调用次数：`.at(-1)` 只在「本轮恰好一次 chatStream」时才是那个读数——不加这一格，
    // 将来若加入重试/二次调用，断言会**静默**改读另一次调用的 cwd（本仓「声明与实测脱钩」同型）。
    // `reply.ts` 现只有 `:966` 一个调用点（`git grep` 实测），且 mock 流不含 @ ⇒ 无 A2A 子链。
    expect(h.chatStream).toHaveBeenCalledTimes(1)
    const passedCwd = h.chatStream.mock.calls.at(-1)?.[1]?.cwd
    expect(passedCwd).toBe(catWtFor(sid, CAT1.name))
    expect(existsSync(catWtFor(sid, CAT1.name))).toBe(true)
    // ② 集成分支被补建，fork 点 = 主仓库 HEAD（不是 dev 的后代、也不是某只猫的分支）
    expect(git(['rev-parse', sessionBranch(shortId)])).toBe(initSha)
    // ③ 猫的改动在**猫分支**上 `cat-file` 读得到
    writeFileSync(resolve(catWtFor(sid, CAT1.name), 'v13.txt'), '补建后有活干\n', 'utf-8')
    await runRound(sid, 'scwt-v13b', CAT1, 'trace-scwt-v13b')

    expect(fileOnBranch(catBranch(shortId, CAT1.name), 'v13.txt')).toBe('补建后有活干\n')
    // 猫的提交不直接落集成分支（那是 fan-in 的活）；补建后它仍停在分叉点
    expect(git(['rev-parse', sessionBranch(shortId)])).toBe(initSha)
    // 主仓库零改动（红线锚）
    expect(branchHead('dev')).toBe('init')
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
  })

  /**
   * V15（**原 V10 降级格**，OQ1 裁 A 后期望反转；用例名同步改——名字里留着「建不出」
   * 就是本仓点过名的「记录≠真相」）。
   *
   * 旧行为：集成分支不存在 ⇒ 猫树建不出、静默降级到 `workspace/`（改动不可见）。
   * 新行为：猫侧**补建**集成分支（fork = 主仓库 HEAD）⇒ 猫树建得出、改动 `cat-file` 读得到。
   * 本格**逐字保留**的旧格：主仓库零改动 / 存量集成分支不被误伤 / 通配符同时命中新旧两形态。
   */
  it('V15/V10 补建 · 集成分支不存在 ⇒ 猫树建得出、改动可见；存量会话分支与通配符不受影响', async () => {
    const sid = 'scwt0005'
    const shortId = sessionShortId(sid)
    // 存量形态：既有 `session/<sid8>` 分支（老会话的集成分支）不该被误伤
    git(['branch', sessionBranch(shortId)])
    // 另一个从未建过集成分支的会话
    const sid2 = 'scwt0006'
    const shortId2 = sessionShortId(sid2)

    await runRound(sid2, 'scwt-nb', CAT1, 'trace-scwt-nb')

    // 反转格①：猫树建得出（旧期望 `toBeNull()` / `existsSync === false`）
    expect(ensureCatWorktree(sid2, CAT1.id, CAT1.name)).toBeTruthy()
    expect(existsSync(catWtFor(sid2, CAT1.name))).toBe(true)
    // 反转格②：集成分支被补建、fork 点 = 主仓库 HEAD
    expect(git(['rev-parse', sessionBranch(shortId2)])).toBe(initSha)
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
    // 反转格③：补建走的是 `ensureSessionWorktree`（单源）⇒ 会话 worktree 一并建出；
    // 这是**零额外成本**的：收口时 `fanInCatBranches` 的 cwd 本就是它（票面补笔 §「为什么用 ensureSessionWorktree」）
    expect(existsSync(sessionWorktreePath(tmpRepo, shortId2))).toBe(true)
  })

  /**
   * V16（本笔核心读数）· **审查面可达性** —— 审查者执行时，其工作区是否包含被审 sha 的改动。
   *
   * **这一格红是本票预期要修的东西，不是 flaky**：Phase I 接线后审查猫也拿自己的猫树，
   * 该树 fork 自 `session/<sid8>`（= fan-in 前不含任何猫的提交）⇒ 审查者工作区里
   * 被审提交**不在**。危险度不在「读到旧代码」，在「**读不出是旧的**」——文件都在、
   * 路径都对，只有内容是旧版；用工作区读文件工具（而非 `git show <sha>:path`）
   * 会静默审一份不存在的版本。故本格用**两条互补判据**把后果钉死：
   * `merge-base --is-ancestor`（结构面）+ 直接读文件内容（可感知面）。
   *
   * 反向对照见报告 §三：把断言翻成正向（「审查者应看得到」）时本格必红，
   * 两向读数都在 `report-phase-ib.md`；**别把这一格当判据翻转的理由改绿**。
   */
  it('V17/V21 · 审查面可达（第 1 笔 V16-b **翻转**）：审查者树含被审改动；集成分支与 dev 零移动', async () => {
    const sid = 'scwt0008'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // ── 被审方：实施猫在自己的树上改一个**已跟踪**文件 → 提交落猫分支 ──
    // 改已跟踪文件（而不是新建）是刻意的：这才能造出「文件在、内容是旧版」那一格。
    const implWt = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(implWt)
    expect(implWt).toBeTruthy()
    writeFileSync(resolve(implWt!, 'tracked.txt'), 'base 改过\n', 'utf-8')

    await runRound(sid, 'scwt-impl', CAT2, 'trace-scwt-impl')

    const implSha = git(['rev-parse', catBranch(shortId, CAT2.name)])
    const sessionShaBefore = git(['rev-parse', sessionBranch(shortId)])
    // 被审提交确实产生了（否则下面的「看不到」是空转：没有东西可看）
    expect(fileOnBranch(catBranch(shortId, CAT2.name), 'tracked.txt')).toBe('base 改过\n')
    // 前置：集成分支**不含**被审提交（fan-in 尚未发生）——不成立则本格测的不是该形态
    expect(ancestorState(implSha, sessionBranch(shortId))).toBe('not-ancestor')

    // ── 审查方：`role: 'reviewer'` 的猫执行（形态 G：执行起点把猫分支合进它自己的分支）──
    const callsBefore = h.chatStream.mock.calls.length
    await runRound(sid, 'scwt-rev', REVIEWER, 'trace-scwt-rev')

    // 分派：审查者拿到的是**它自己的猫 worktree**（不是会话树、不是 `workspace/` 降级）。
    // 先钉本轮的调用次数：`.at(-1)` 只在「本轮恰好一次 chatStream」时才是那个读数。
    expect(h.chatStream.mock.calls.length - callsBefore).toBe(1)
    const revCwd = h.chatStream.mock.calls.at(-1)?.[1]?.cwd
    expect(revCwd).toBe(catWtFor(sid, REVIEWER.name))
    expect(revCwd).not.toBe(sessionWorktreePath(tmpRepo, shortId))

    // **V17（本笔靶心）**：审查者树里 `HEAD` **含**被审 sha。
    // 第 1 笔这一格断言的是 `'not-ancestor'`（把缺口钉成红格）；形态 G 落地后翻成正向。
    // ⚠️ 两条对照**必须保留**（票面 §八 V17「只翻期望值，不删格」）——它们是判据非恒真的
    // 常驻闸，探针坏掉 / 恒假时 ① 会先红：
    //   ① 同一探针喂**实施猫自己的树** ⇒ 「已在」
    //   ② 喂**集成分支** ⇒ 「不在」（fan-in 尚未发生 ⇒ 集成分支**仍**不含被审提交）
    // 一正一反 ⇒ 探针确实在分辨「哪棵树 / 哪条 ref」，而不是恒绿门。
    expect(ancestorState(implSha, 'HEAD', revCwd!)).toBe('ancestor')
    expect(ancestorState(implSha, 'HEAD', implWt!)).toBe('ancestor')
    expect(ancestorState(implSha, sessionBranch(shortId))).toBe('not-ancestor')
    // 可感知面：审查者 cwd 里这个文件读到的是**被审版本**（第 1 笔这里读到的还是 `base\n`）
    expect(readFileSync(resolve(revCwd!, 'tracked.txt'), 'utf-8')).toBe('base 改过\n')
    expect(readFileSync(resolve(implWt!, 'tracked.txt'), 'utf-8')).toBe('base 改过\n')

    // **V21 零分支移动**：本笔只动审查者**自己那条**猫分支。
    // 集成分支与 dev 逐字节不变（契约 1「绝不改集成分支 / dev」的结构性读数，不是约定）；
    // 实施猫的树与分支不受影响（合的是它的**提交**，不是它的 ref）。
    expect(git(['rev-parse', sessionBranch(shortId)])).toBe(sessionShaBefore)
    expect(fileOnBranch(catBranch(shortId, CAT2.name), 'tracked.txt')).toBe('base 改过\n')
    expect(existsSync(resolve(implWt!, 'tracked.txt'))).toBe(true)
    expect(branchHead('dev')).toBe('init')
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
  })

  /**
   * V19 隔离不被打破（契约 5「只对审查者生效」的反向那一半）。
   *
   * 与 V17 是**同一场景下的一对**：审查者 ⇒ `ancestor`，非审查者 ⇒ `not-ancestor`。
   * 单测 V17 只能证「合并会跑」；不测 V19 的话，把判据写成「对所有猫都合」也能全绿 ——
   * 而那等于把 Phase I 刚建立的隔离拆掉。
   */
  it('V19 · 非审查者执行后其树不含他猫提交（形态 G 的范围限定真生效）', async () => {
    const sid = 'scwt0006'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // 他猫（实施猫）先落一笔提交——它**会**被审查者合并，但**不该**进非审查者的树
    const implWt = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(implWt)
    expect(implWt).toBeTruthy()
    writeFileSync(resolve(implWt!, 'tracked.txt'), 'base 改过\n', 'utf-8')
    await runRound(sid, 'scwt-iso-impl', CAT2, 'trace-scwt-iso-impl')
    const implSha = git(['rev-parse', catBranch(shortId, CAT2.name)])
    expect(ancestorState(implSha, sessionBranch(shortId))).toBe('not-ancestor')

    // 非审查者（CAT1：`role` 缺失 ⇒ 非 store ⇒ 走猫树，但**不是** reviewer）执行
    const callsBefore = h.chatStream.mock.calls.length
    await runRound(sid, 'scwt-iso-other', CAT1, 'trace-scwt-iso-other')
    expect(h.chatStream.mock.calls.length - callsBefore).toBe(1)
    const cwd = h.chatStream.mock.calls.at(-1)?.[1]?.cwd
    expect(cwd).toBe(catWtFor(sid, CAT1.name))

    // **判据（V19）**：他猫提交**不在**它的树里，文件读到的仍是旧版
    expect(ancestorState(implSha, 'HEAD', cwd!)).toBe('not-ancestor')
    expect(readFileSync(resolve(cwd!, 'tracked.txt'), 'utf-8')).toBe('base\n')
    // 反恒真对照：同一条 sha 喂**实施猫自己的树** ⇒ 「已在」（探针没坏、sha 也没写错）
    expect(ancestorState(implSha, 'HEAD', implWt!)).toBe('ancestor')
  })

  /**
   * V20 冲突显式停（票面 §八 契约 4 / §二-3「不静默」）。
   *
   * 两段读数：
   * - **直接读数**：合并入口的返回值 —— `conflict` + `recovered`（abort 回可重跑态）
   * - **集成读数**：审查者**不开跑** —— 冲突时 `chatStream` 一次都不被调用。这一格是
   *   「不带着缺内容的工作区产出回执」的可机检形态；只断言返回值不断言行为，
   *   把「返回 conflict 但照样开跑」的实现放过去就还是假绿。
   */
  it('V20 · 与被审同处改动 ⇒ 返回 conflict、树回可重跑态、审查者不开跑', async () => {
    const sid = 'scwt0011'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // 审查者侧先在自己的分支上改**同一处**（造出必然冲突的形态：两分支自同一分叉点改同一文件同一行）
    const revWt = ensureCatWorktree(sid, REVIEWER.id, REVIEWER.name)
    registerWorktree(revWt)
    expect(revWt).toBeTruthy()
    writeFileSync(resolve(revWt!, 'tracked.txt'), 'rev 改过\n', 'utf-8')
    git(['add', '-A'], revWt!)
    git(['commit', '-m', 'rev 侧先改'], revWt!)
    const revShaBefore = git(['rev-parse', catBranch(shortId, REVIEWER.name)])

    const implWt = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(implWt)
    writeFileSync(resolve(implWt!, 'tracked.txt'), 'impl 改过\n', 'utf-8')
    await runRound(sid, 'scwt-cf-impl', CAT2, 'trace-scwt-cf-impl')
    const implSha = git(['rev-parse', catBranch(shortId, CAT2.name)])
    // 前提：两分支确实分叉、互不包含（否则下面根本测不到冲突）
    expect(ancestorState(implSha, revShaBefore)).toBe('not-ancestor')
    expect(ancestorState(revShaBefore, implSha)).toBe('not-ancestor')

    // ── 直接读数：合并入口的返回值 ──
    const r = mergeCatBranchesIntoOwnBranch(shortId, { cwd: revWt!, mainRoot: tmpRepo })
    expect(r.conflict).toBe(true)
    expect(r.recovered).toBe(true) // abort 成功 ⇒ 回可重跑态
    expect(r.merged).toEqual([])
    // 审查者**自己那条**分支必然进 `skipped`（`isAncestor(自, 自)` 为真）——
    // 枚举含自身是设计使然（`listCatBranches` 不排除自身），自合是 no-op。
    // 它排在冲突那条之前（分支名排序：`吐槽猫` < `暹罗猫`）⇒ 断言它是 skipped 的**唯一**成员，
    // 同时也就证明了「循环停在第二个来源上」（merged 为空）。
    expect(r.skipped).toEqual([catBranch(shortId, REVIEWER.name)])
    // 树回可重跑态（三条独立断言，缺一则「recovered」可能只是自报）：
    expect(git(['rev-parse', catBranch(shortId, REVIEWER.name)])).toBe(revShaBefore)
    expect(gitOrNull(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], revWt!)).toBeNull()
    expect(git(['status', '--porcelain'], revWt!)).toBe('')

    // ── 集成读数：审查者**没有开跑** ──
    const callsBefore = h.chatStream.mock.calls.length
    await runRound(sid, 'scwt-cf-rev', REVIEWER, 'trace-scwt-cf-rev')
    expect(h.chatStream.mock.calls.length - callsBefore).toBe(0)
    // 且**不静默**：冲突有 error 留痕（判据非恒真——下面这条断言在无冲突时不成立）
    expect(h.logError).toHaveBeenCalledWith(
      'merge conflict',
      expect.objectContaining({ label: 'review-view', recovered: true })
    )
  })

  /**
   * V22 幂等（票面 §八 契约 3）：审查者**重复执行**不产生新的 merge commit。
   *
   * 末行那条「内容仍在」是必需的：只断言「sha 没变」的话，把 skip 实现成
   * 「第二次干脆不合并 / 把分支重置回去」也能全绿。
   */
  it('V22 · 审查者重复执行 ⇒ 已合即 skip，不产生第二个 merge commit', async () => {
    const sid = 'scwt0012'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    const implWt = ensureCatWorktree(sid, CAT2.id, CAT2.name)
    registerWorktree(implWt)
    writeFileSync(resolve(implWt!, 'tracked.txt'), 'base 改过\n', 'utf-8')
    await runRound(sid, 'scwt-idem-impl', CAT2, 'trace-scwt-idem-impl')
    const implSha = git(['rev-parse', catBranch(shortId, CAT2.name)])

    const revBranch = catBranch(shortId, REVIEWER.name)
    const revWt = catWtFor(sid, REVIEWER.name)
    const mergeCommits = (): number =>
      git(['log', '--format=%s', revBranch])
        .split('\n')
        .filter((l) => l.startsWith('review-view ')).length

    // 第 1 轮：真合 ⇒ 产生 merge commit
    await runRound(sid, 'scwt-idem-rev1', REVIEWER, 'trace-scwt-idem-rev1')
    const afterFirst = git(['rev-parse', revBranch])
    expect(ancestorState(implSha, 'HEAD', revWt)).toBe('ancestor')
    expect(mergeCommits()).toBe(1)

    // 第 2 轮：同一会话、同一审查者 ⇒ 已合即 skip，**不造第二个 merge commit**
    await runRound(sid, 'scwt-idem-rev2', REVIEWER, 'trace-scwt-idem-rev2')
    expect(git(['rev-parse', revBranch])).toBe(afterFirst)
    expect(mergeCommits()).toBe(1)
    // 幂等 ≠ 「什么都没发生」：被审内容仍在树里
    expect(ancestorState(implSha, 'HEAD', revWt)).toBe('ancestor')
  })

  /**
   * P3-c-1（Phase I 审查遗留）：`ensureCatWorktree` 的**提交期抛错分支**——非法猫名。
   *
   * 触发形态 = **快照/现状分歧**：执行期用派发批次里的 agent 配置（合法名），提交期
   * `resolveCommitTargets` 重新读 **DB 当前行**（`getAgentById`）。`agents` 表可变
   * （`reply.ts` 已为此把 provider/model 记为快照：「事后 join 拿到的是今天的配置」），
   * 猫名在两次读之间被改掉即命中本分支（V7 用的同一形态，本格把它测成行级契约）。
   */
  it('P3-c-1 · 提交期猫名非法 ⇒ 该猫不提交、不清理、留 error；主仓库零改动', async () => {
    const sid = 'scwt0009'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // 猫树先存在（执行期走配置快照的合法名 ⇒ 本轮执行本身照常进行）
    const catWt = ensureCatWorktree(sid, CAT1.id, CAT1.name)
    registerWorktree(catWt)
    expect(catWt).toBeTruthy()
    // 脏文件（未跟踪）：本格「**不清理**」的行为读数——清理若真执行，`git clean -fd` 会删掉它
    writeFileSync(resolve(catWt!, 'dirty.txt'), '待清理\n', 'utf-8')

    // 提交期读到的名字变非法（`/` ⇒ `catSlug` 显式抛错，不静默剔除）
    getDb().prepare(`UPDATE agents SET name = 'a/b' WHERE id = 'cat-1'`).run()

    await runRound(sid, 'scwt-p3c1', CAT1, 'trace-scwt-p3c1')

    // 留 error：显式抛错被收成 error 级留痕（**不吞成静默**——静默正是本仓反复点名的形态）
    expect(h.logError).toHaveBeenCalledWith(
      'worktree resolve failed — tree skipped',
      expect.objectContaining({ agentId: 'cat-1', agentName: 'a/b' })
    )
    // 不提交：后果留痕 + 行为读数（该猫分支 sha 逐字节不变）
    expect(h.logWarn).toHaveBeenCalledWith(
      'auto commit skipped — worktree unavailable',
      expect.objectContaining({ agentId: 'cat-1' })
    )
    expect(git(['rev-parse', catBranch(shortId, CAT1.name)])).toBe(initSha)
    // 不清理：后果留痕 + 行为读数。
    // ⚠ 「文件还在」**单独一条判不出**清理与否——成功路径会把脏文件 `git add -A` 提交掉，
    // 于是它也「还在」（反向对照实测：见报告 §四 P3-c 控制组）。判据必须配上
    // 「**不在分支上** + 树**仍是脏的**」才与成功路径分得开。
    expect(h.logWarn).toHaveBeenCalledWith(
      'dirty-file cleanup skipped — worktree unavailable',
      expect.objectContaining({ agentId: 'cat-1' })
    )
    expect(existsSync(resolve(catWt!, 'dirty.txt'))).toBe(true)
    expect(git(['status', '--porcelain'], catWt!)).toContain('dirty.txt')
    expect(fileOnBranch(catBranch(shortId, CAT1.name), 'dirty.txt')).toBeNull()
    // 降级绝不落主仓库（T-1 已收窄的红线锚）
    expect(branchHead('dev')).toBe('init')
    expect(readFileSync(resolve(tmpRepo, 'tracked.txt'), 'utf-8')).toBe('base\n')
  })

  /**
   * P3-c-2（同上）：同一个提交期 catch 的**另一成因**——所有权冲突。
   *
   * 触发形态 = **规范化碰撞**：`甲 猫`（dup-1 已占）与 `甲猫`（cat-1 改成）是两个不同的
   * DB 值（`agents.name` 的 UNIQUE 拦不住），但 `catSlug` 剥空白后归一 ⇒ 同一条分支、
   * 同一棵树。提交期解析 cat-1 时命中**别人的树** ⇒ 拒绝复用、显式抛错。
   * 比 P3-c-1 多一条独有断言：**所有权标记不被静默覆写**——覆写 = 两只猫共用一棵树
   * 且无人察觉，这正是该标记存在的全部理由。
   */
  it('P3-c-2 · 提交期所有权冲突（规范化碰撞）⇒ 不提交、不清理、留 error；标记不被覆写', async () => {
    const sid = 'scwt0010'
    const shortId = sessionShortId(sid)
    git(['branch', sessionBranch(shortId)])

    // 前提读数：「两个不同的 DB 名」确实归一到**同一条分支**（碰撞是实测的，不是推演）
    const shared = catBranch(shortId, DUP_A.name)
    expect(DUP_A.name).not.toBe(DUP_B_NAME)
    expect(catBranch(shortId, DUP_B_NAME)).toBe(shared)

    // 该分支/树由 dup-1 占住（分支 + 目录 + 所有权标记三件套一起落）
    const dupWt = ensureCatWorktree(sid, DUP_A.id, DUP_A.name)
    registerWorktree(dupWt)
    expect(dupWt).toBeTruthy()
    expect(catOwnerMarker(shared)).toBe('dup-1')

    // cat-1 自己的树（执行期走配置快照名 ⇒ 本轮执行照常；脏文件落这里，用于「不清理」读数）
    const catWt = ensureCatWorktree(sid, CAT1.id, CAT1.name)
    registerWorktree(catWt)
    expect(catWt).toBeTruthy()
    writeFileSync(resolve(catWt!, 'dirty.txt'), '待清理\n', 'utf-8')

    // 提交期：cat-1 的 DB 名改成规范化后与 dup-1 撞车的形态 ⇒ 命中已被占用的分支/树
    getDb().prepare(`UPDATE agents SET name = ? WHERE id = 'cat-1'`).run(DUP_B_NAME)

    await runRound(sid, 'scwt-p3c2', CAT1, 'trace-scwt-p3c2')

    expect(h.logError).toHaveBeenCalledWith(
      'worktree resolve failed — tree skipped',
      expect.objectContaining({ agentId: 'cat-1', agentName: DUP_B_NAME })
    )
    // 不提交 / 不清理：行为读数（共享分支 sha 不变、脏文件仍在且**仍是脏的**——
    // 「文件还在」单独不成判据，理由同 P3-c-1）
    expect(git(['rev-parse', shared])).toBe(initSha)
    expect(existsSync(resolve(catWt!, 'dirty.txt'))).toBe(true)
    expect(git(['status', '--porcelain'], catWt!)).toContain('dirty.txt')
    expect(fileOnBranch(catBranch(shortId, CAT1.name), 'dirty.txt')).toBeNull()
    // 该成因独有的安全性质：标记仍是 dup-1（**没被静默覆写成 cat-1**）
    expect(catOwnerMarker(shared)).toBe('dup-1')
    expect(branchHead('dev')).toBe('init')
    // 被占的那棵树没被这轮清理波及（不清理的作用面是「目标树」，不是别人的树）
    expect(existsSync(dupWt!)).toBe(true)
  })
})

// ─── 就地测试库（与 serial.downgrade.test.ts 同款：内存 SQLite，无磁盘、FK 生效）──
import Database from 'better-sqlite3'
function createTestDb(): Database.Database {
  return new Database(':memory:')
}

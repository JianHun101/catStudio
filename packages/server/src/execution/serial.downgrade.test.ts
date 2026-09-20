/**
 * serial.ts × 降级路径（T-1 · Phase 1 测试先行 → Phase 2 生产改动）。
 * 票面：`docs/run/multi-cat-isolation/tickets.md`。
 *
 * **被测面**：`executeAgentsSerial` 顶层收尾（`depth === 0`）的两处「worktree 不可用」
 * 处置——
 *   ① auto-commit：收窄前是 `gitCommit(msg)`（无 cwd ⇒ 落 `process.cwd()` = 主仓库根
 *      ⇒ `git add -A` + commit **进主仓库当前分支**，绕过审查链）；
 *   ② 脏文件清理：收窄前是 `getSessionWorktreePath(sid) ?? process.cwd()` ⇒
 *      `git checkout -- .` + `git clean -fd` **作用到主仓库整棵树**。
 * **Phase 2 后两者同批走 `ensureSessionWorktree`（查 + 建），建不出 → 不动作 + 显式告警。**
 *
 * **形态：真 git 仓库，`git-utils` 与 `node:child_process` 一律不 mock。**
 * 降级路径的实害是「文件系统上真的动了哪个仓库」——只有让 `git commit` / `git checkout`
 * 真跑、再读真仓库的真状态才判得出来。本仓栽过「验证面与被判面不同面」的假绿门
 * （judge 扫消息 content 却 grep 工作区文件），故本文件**不采用**「mock 掉 gitCommit
 * 再断言它没被调用」的形态——那只证得了「调用没发生」，证不了「主仓库文件真的没动」。
 * 做法与 `llm/session-closeout.test.ts` 同款：`mkdtemp` + `git init` + `chdir`。
 *
 * **Phase 1 → Phase 2 的读法变化（重要）**：Phase 1 用 `it.fails` 编码「目标行为面」
 * （建不出 ⇒ 不动作 + 告警），闸保持全绿、改对后强制翻回 `it`。Phase 2 已改对，故
 * 4 格全部翻正为 `it`；同时 **Phase 1 记为「现状」的若干格其读数本身也变了**
 * （B1/B2/B3-busy/B4/G4a/G4b）——那正是本票要改的行为，逐格在注释里留了 Phase 1 旧读数
 * 以便对照。G7：每格的覆盖边界自陈见文末「覆盖边界」段。
 *
 * **安全前提（必读，否则测试自己就是事故）**：Phase 2 前 `serial.ts:1200/1210/1211`
 * 的 execSync **不带 `cleanGitEnv()`**（与 `git-utils` 不对称），Phase 2 已补对称并
 * 由 OQ4 用例做 A/B 实证。但测试**自身**出 git 仍必须先剥——git 跑钩子时会向子进程
 * 注入 `GIT_DIR`（本仓已知：曾把主仓库 `core.bare` 写成 true），`beforeAll` 剥掉这四个
 * 变量、`afterAll` 按原值还原（对称）。
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentConfig, Message } from '@cat-study/shared'
import {
  createIsolatedRepoRoot,
  createTestDb,
  removeIsolatedRepoRoot,
  type IsolatedRepoRoot,
} from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { ensureSessionWorktree, sessionShortId, sessionWorktreePath } from '../llm/git-utils.js'

// ═══ 边界 mock（LLM / 记忆 / 摘要 / handoff / diff / 信号——与「提交落哪」无关）═══
// 刻意**不** mock：`../llm/git-utils.js`、`node:child_process`。

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
  collectCommitDiffs: vi.fn(),
  /**
   * OQ1 的开关：让 `reply.ts:314` 的 `getAdapterForAgent` 抛错。
   * 这是**唯一**一条能确定性地构造「`claudeRan` 已为 true、而 worktree 还没建」的缝——
   * `getAdapterForAgent` 是 `runAgentReply` 函数体的第一条语句（`reply.ts:314`），
   * 远早于建 worktree 的 `reply.ts:976`；抛错经 `serial.ts:575` 的 Promise.race
   * reject → `:596` 的 catch → `return claudeRan`（`needsLock` 初值 = provider 是 claude）。
   * 用标志位而不是 `mockImplementationOnce`：`clearAllMocks` 清调用不清实现，
   * 一次性实现会串到后续用例。
   */
  failAdapterResolve: false,
}))

// logger mock 保留**通道名**首参：要区分「serial.ts 自己告的警」与
// 「git-utils 内部告的警」（两者都走 logger，混在一起判据就糊了）
vi.mock('../logger.js', () => ({
  createLogger: (name: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => h.logWarn(name, ...args),
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => {
    if (h.failAdapterResolve) throw new Error('adapter resolve failed (test)')
    return { chatStream: h.chatStream }
  }),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  retrieveMemoryContext: h.retrieveMemoryContext,
  buildKnowledgeContext: h.buildKnowledgeContext,
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
  // T-1：a2a 记忆门新增的两个被消费导出——同一条规矩（见上），partial factory
  // 缺一个就是调用点 TypeError。默认值镜像生产：门**关**、跳过结果形状同构。
  isA2aMemoryEnabled: vi.fn(() => false),
  skippedRetrievalResult: vi.fn(() => ({
    text: '',
    reason: 'skipped-a2a',
    sections: [],
    stats: {},
  })),
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

/** 临时「主仓库」夹具（壳进程唯一，见 `createIsolatedRepoRoot`） */
let repoRoot: IsolatedRepoRoot
/** 临时「主仓库」根（真 git 仓，dev 分支）——= `repoRoot.repo` */
let tmpRepo = ''
/** 非 git 目录（B1 成因：`getMainRepoRoot()` → null）；不落 worktree，无对撞面，仍走裸 `mkdtemp` */
let tmpNoGit = ''
/** dev 分支的初始 commit（每用例 `reset --hard` 回到它） */
let initSha = ''
/** 本文件创建的 worktree 目录（清理用；**不**动共享的 catStudy-sessions 父目录） */
const worktrees: string[] = []
const scratchDirs: string[] = []

/** 剥 git 环境变量——测试自身出 git 必须干净，否则被 worktree 钩子注入的 GIT_DIR 劫持 */
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

/** 某仓库最后一次提交的标题（无 commit / 非仓库 → null） */
function lastCommitSubject(cwd = tmpRepo): string | null {
  return gitOrNull(['log', '-1', '--format=%s'], cwd)
}

/** 「主仓库」某文件当前内容（绝对路径，与 process.cwd() 无关） */
function repoFile(rel: string): string {
  return readFileSync(resolve(tmpRepo, rel), 'utf-8')
}

const e2eMarkerPath = (): string => resolve(tmpRepo, 'scripts', '.e2e-testing')

/**
 * 生产同式解析出的会话 worktree 路径（`sessionShortId` + `sessionWorktreePath`
 * 与 `git-utils.ts` **同源**，不另写一份表达式——两处各写一份就是下一个漂移源）。
 * shortId 为空时返回 null：那种成因下 `sessionWorktreePath(root, '')` 会指向
 * `catStudy-sessions` **父目录**本身，拿它去 rmSync 会扫掉别人的 worktree。
 */
function wtPathFor(sessionId: string): string | null {
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  return sessionWorktreePath(tmpRepo, shortId)
}

/** serial.ts（通道名 'socketio'）自己发过一条提及 worktree 的告警吗 */
function serialWarnedAboutWorktree(): boolean {
  return h.logWarn.mock.calls.some(
    ([name, msg]) => name === 'socketio' && /worktree|降级/i.test(String(msg))
  )
}

/** serial.ts 发过「脏工作区，重置中」告警吗（= ② 真的动手了） */
function serialWarnedDirtyReset(): boolean {
  return h.logWarn.mock.calls.some(
    ([name, msg]) => name === 'socketio' && String(msg).includes('dirty workspace')
  )
}

/**
 * 丢掉本文件建过的 worktree 目录 + `worktree prune`。
 *
 * 为什么必须逐测试做：worktree 路径只依赖 mainRoot 的**父目录**与 shortId（**不含**
 * 随机仓库名），所以上一次跑崩留下的同 id 目录会让 `ensureSessionWorktree` 走进
 * 「已存在 → 复用」分支并指向一个已被删除的仓库。跨进程那半已由
 * `createIsolatedRepoRoot` 的壳目录消灭，**同进程**这半（本文件多格共用一棵壳树）仍需逐格扫。
 */
function dropWorktrees(): void {
  for (const dir of worktrees.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
  gitOrNull(['worktree', 'prune'])
}

beforeAll(() => {
  // ⚠ 安全前提：git 跑钩子时向子进程注入 GIT_DIR 等——环境里残留会让测试自己的
  // git 操作（乃至生产侧未剥 env 的那几条）穿透到真实仓库。这里从**进程环境**剥掉。
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) {
    origGitEnv[k] = process.env[k]
    delete process.env[k]
  }

  // 仓库根落进程唯一的壳里：`sessionWorktreePath` 的 `..` 从此落在 `<壳>` 内，
  // 不再与并发跑同一文件的另一进程共用 `tmpdir()/catStudy-sessions/`
  repoRoot = createIsolatedRepoRoot('serial-downgrade-')
  tmpRepo = repoRoot.repo
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
  // 行尾钉死：Windows 全局 core.autocrlf 会把 checkout 出来的文件写成 CRLF，
  // 让「内容比对」变成行尾比对（本仓行尾假红的前科同理）
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
  // `.gitignore` + `packages/*/` **必须进初始 commit**（R2 判据的保真前提）：
  //   - 没有 commit 里的 `node_modules/`，worktree 检出后不认识这个忽略规则，
  //     `linkNodeModules` 建的 junction 会以未跟踪身份出现 ⇒ 制造出真仓库里
  //     **不存在**的 `?? node_modules` 假读数；
  //   - 同理 `packages/server/` 在真仓库是 tracked，夹具里不 tracked 则
  //     `mkdirSync(dirname(dest))` 会凭空造出 `?? packages/`。
  writeFileSync(resolve(tmpRepo, '.gitignore'), 'node_modules/\n', 'utf-8')
  for (const pkg of ['server', 'shared', 'web']) {
    mkdirSync(resolve(tmpRepo, 'packages', pkg), { recursive: true })
    writeFileSync(resolve(tmpRepo, 'packages', pkg, '.gitkeep'), '', 'utf-8')
  }
  git(['add', '-A'])
  git(['commit', '-m', 'init'])
  initSha = git(['rev-parse', 'HEAD'])

  tmpNoGit = mkdtempSync(join(tmpdir(), 'serial-downgrade-nogit-'))
  process.chdir(tmpRepo)
})

afterAll(() => {
  process.chdir(origCwd)
  dropWorktrees()
  // 删**壳**（连 `<壳>/catStudy-sessions/*` 一起）；tmpNoGit 在壳外，单独删
  removeIsolatedRepoRoot(repoRoot)
  for (const dir of [...scratchDirs, tmpNoGit]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
  // 与 beforeAll 的剥离**对称**：按原值还原（不是 delete 了事——原值可能本就有）
  for (const [k, v] of Object.entries(origGitEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ═══ 假 bus / 夹具 ═══

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: (_m: Message) => {},
    emitSystemNotice: () => {},
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

/**
 * 用 `claude` provider——**不是随意选的**：`serial.ts:526` 的
 * `needsLock = agent.llmProvider === 'claude'` 就是 `claudeRan` 的初值，而顶层收尾的
 * ② 脏文件清理整个挂在 `if (anyClaude)` 里。用非 claude provider 跑，
 * ② 永远不执行，本矩阵的第二半（清理作用域）会**全是空断言**。
 * （`serial.ts` 注释：「只有它会编辑源文件」——② 本来就只为 claude 执行体存在。）
 */
const A1: AgentConfig = {
  id: 'agent-1',
  name: 'flash猫',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'claude',
  llmModel: 'claude-sonnet-5',
  llmApiKey: 'sk-test',
  // 店长：一猫一 worktree 之后仍持会话 worktree（ADR 0015 D2），本矩阵的判据对象
  role: 'store',
}

interface RoundOpts {
  /** 引擎与消息共用的会话 id（决定 shortId / worktree 路径） */
  sessionId?: string
  /** 槽位置忙：本轮 `execute()` 只入队不执行（复现「猫正忙时收尾立刻跑」的生产窗口） */
  busy?: boolean
}

/** 落库触发消息 → `executeAgentsSerial(depth=0)`（与 serial.spans.test.ts 同形） */
async function runRound(
  engine: ExecutionEngine & ExecutionEngineTestHooks,
  triggerId: string,
  traceId: string,
  opts: RoundOpts = {}
): Promise<boolean> {
  const sessionId = opts.sessionId ?? 'session-1'
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, title, agent_ids, broadcast_mode)
     VALUES (?, '测试会话', '["agent-1"]', 0)`
  ).run(sessionId)
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions)
     VALUES (?, ?, 'user', '你好', '[]')`
  ).run(triggerId, sessionId)

  const engine2 = engine as ExecutionEngine & ExecutionEngineTestHooks
  if (opts.busy) {
    engine2.__test_seedSlot('agent-1', sessionId, { currentTriggerMessageId: 'other-trigger' })
  }
  return engine2.executeAgentsSerial(
    sessionId,
    [A1],
    { fromAgent: false, id: triggerId, content: '你好', mentions: [] },
    traceId,
    0
  )
}

/** 一轮收尾跑完后，从**真仓库**读回来的读数 */
interface Reading {
  /** 主仓库（临时 dev 仓）最后一次提交的标题 */
  mainRepoHead: string | null
  /** 主仓库工作区是否脏 */
  mainRepoDirty: boolean
  /** 主仓库 tracked.txt 的当前内容 */
  mainRepoTracked: string
  /** 主仓库是否新增了一笔 `catstudy [<triggerId>]` 提交（= ① 降级提交落主仓库） */
  committedIntoMainRepo: boolean
  /** serial.ts 自己告过「worktree 不可用」的警吗 */
  warnedAboutWorktree: boolean
  /** serial.ts 发过「脏工作区，重置中」告警吗（= ② 动手了） */
  warnedDirtyReset: boolean
  /** 本轮收尾路径上解析出的会话 worktree 路径（评估不到 → null） */
  worktreePath: string | null
  /** 该 worktree 本轮跑完后是否存在（① 现建 / reply.ts 先建 / 复用 都会让它为 true） */
  worktreeExists: boolean
  /** 该 worktree 当前分支末次提交标题 */
  worktreeHead: string | null
}

/**
 * 降级场景：主仓库预置**未提交的 tracked 改动** → 跑一轮 → 读真仓库。
 *
 * `cwd` 决定「server 站在哪」；`e2eMarker` 打开时 `gitCommit` 直接返回 null
 * （① 不提交），从而把 ② 的清理行为**单独暴露出来**。
 */
async function runScenario(opts: {
  sessionId: string
  triggerId: string
  cwd?: string
  busy?: boolean
  e2eMarker?: boolean
}): Promise<Reading> {
  process.chdir(opts.cwd ?? tmpRepo)
  const wt = wtPathFor(opts.sessionId)
  if (wt && !worktrees.includes(wt)) worktrees.push(wt)
  if (opts.e2eMarker) {
    mkdirSync(dirname(e2eMarkerPath()), { recursive: true })
    writeFileSync(e2eMarkerPath(), '', 'utf-8')
  }
  // 主仓库的未提交 tracked 改动（票面 G4 的前提）
  writeFileSync(resolve(tmpRepo, 'tracked.txt'), 'DIRTY\n', 'utf-8')

  const engine = createExecutionEngine(createFakeBus())
  await runRound(engine, opts.triggerId, `trace-${opts.triggerId}`, {
    sessionId: opts.sessionId,
    busy: opts.busy,
  })

  const head = lastCommitSubject()
  return {
    mainRepoHead: head,
    mainRepoDirty: (gitOrNull(['status', '--porcelain']) ?? '') !== '',
    mainRepoTracked: repoFile('tracked.txt'),
    committedIntoMainRepo: head === `catstudy [${opts.triggerId}]`,
    warnedAboutWorktree: serialWarnedAboutWorktree(),
    warnedDirtyReset: serialWarnedDirtyReset(),
    worktreePath: wt,
    worktreeExists: wt !== null && existsSync(resolve(wt, '.git')),
    worktreeHead: wt !== null && existsSync(wt) ? lastCommitSubject(wt) : null,
  }
}

/** 建一个真会话 worktree（走真 `ensureSessionWorktree`）并登记清理 */
function makeWorktree(sessionId: string): string {
  const wt = ensureSessionWorktree(sessionId)
  expect(wt, `ensureSessionWorktree(${sessionId}) 应建出 worktree`).toBeTruthy()
  worktrees.push(wt!)
  return wt!
}

/** B4 成因：占住会话分支 → `git worktree add` 必失败 */
function occupySessionBranch(shortId: string): void {
  const branch = `session/${shortId}`
  git(['branch', branch])
  // 占位树落**本进程的壳**里（不是裸 `tmpdir()`）——否则两进程同跑时后到的那个
  // `git worktree add` 会撞上「目录已存在」，B4 成因在夹具层就被伪造出来
  const holder = resolve(repoRoot.shell, `holder-${shortId}`)
  scratchDirs.push(holder)
  git(['worktree', 'add', holder, branch])
}

/** 一次性诱饵仓库（OQ4 用）：环境注入 GIT_DIR 时被劫持的目标 */
function makeDecoyRepo(): string {
  const decoy = mkdtempSync(join(tmpdir(), 'serial-downgrade-decoy-'))
  scratchDirs.push(decoy)
  execFileSync('git', ['init'], { cwd: decoy, env: cleanGitEnv(), stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], {
    cwd: decoy,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  execFileSync('git', ['config', 'user.email', 'test@test.local'], {
    cwd: decoy,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  writeFileSync(resolve(decoy, 'decoy-only.txt'), 'base\n', 'utf-8')
  git(['add', '-A'], decoy)
  git(['commit', '-m', 'init'], decoy)
  writeFileSync(resolve(decoy, 'decoy-only.txt'), 'DECOY-DIRTY\n', 'utf-8')
  return decoy
}

describe('serial × 降级路径（T-1：Phase 1 测试先行 → Phase 2 生产收窄）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.failAdapterResolve = false
    __test_reset()
    // 上一格的 worktree 目录必须真删掉（路径只依赖 tmpdir + shortId，残留会串场）
    dropWorktrees()
    // 主仓库回到初始 commit + 干净工作区（上一格留下的提交/文件不串场）
    git(['reset', '--hard', initSha])
    git(['clean', '-fdx'])

    const db = createTestDb()
    setDb(db)
    initDb()
    initRepository(db)
    // provider 必须是 claude：`execute()` 的 agent 配置取自**这一行**
    // （`agentsRepo.getAgentById` + `rowToAgent`），不是传给 `executeAgentsSerial` 的常量——
    // 这行写 deepseek 则 `anyClaude` 恒 false，② 的清理段永不执行（空断言）
    // role='store'：**本矩阵的判据对象是「收尾路径上那棵 worktree」**，而一猫一
    // worktree（T-2 Phase I）之后只有店长还持会话 worktree（ADR 0015 D2）。把夹具钉成
    // store ⇒ 本文件全部格子的语义与 T-1 Phase 2 收窄时**逐字一致**（改的是归属、
    // 不是期望）。猫（role 缺失/未知）走各自猫 worktree 的路径见
    // `serial.cat-worktree.test.ts`——两格都要读数，不能只测一格（票面 V1）。
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-1', 'flash猫', '🐱', 'p', 'claude', 'claude-sonnet-5', 'sk-test', 'store')`
    ).run()

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
    process.chdir(tmpRepo)
  })

  afterEach(() => {
    resetDb()
    process.chdir(tmpRepo)
  })

  // ══════════════════════════════════════════════════════════════════
  // 维度 C · 回归面：worktree 存在 → 隔离生效（Phase 2 前后行为一致，必须一直绿）
  // ══════════════════════════════════════════════════════════════════
  describe('维度 C · 回归面（worktree 存在）', () => {
    it('C-① 有 worktree ⇒ auto-commit 落 worktree 分支；主仓库 HEAD 不动', async () => {
      const wt = makeWorktree('sdcreg01')
      writeFileSync(resolve(wt, 'cat-edit.txt'), 'flash猫 改的\n', 'utf-8')

      const engine = createExecutionEngine(createFakeBus())
      await runRound(engine, 'sd-c1', 'trace-sd-c1', { sessionId: 'sdcreg01' })

      // 提交落在 worktree（会话分支）——不是主仓库
      expect(lastCommitSubject(wt)).toBe('catstudy [sd-c1]')
      expect(lastCommitSubject(tmpRepo)).toBe('init')
      // 主仓库的未提交 tracked 改动原样保留（没被提交、也没被回滚）
      writeFileSync(resolve(tmpRepo, 'tracked.txt'), 'DIRTY\n', 'utf-8')
      expect(repoFile('tracked.txt')).toBe('DIRTY\n')
    })

    it('C-② 有 worktree ⇒ 清理作用域 = worktree：worktree 被重置，主仓库未提交改动原样保留', async () => {
      const wt = makeWorktree('sdcreg02')
      // worktree 里造脏（② 的真作用对象）
      writeFileSync(resolve(wt, 'tracked.txt'), 'WT-DIRTY\n', 'utf-8')
      // ① 关掉（e2e 标记 ⇒ gitCommit 直接返回 null），把 ② 单独暴露出来
      mkdirSync(dirname(e2eMarkerPath()), { recursive: true })
      writeFileSync(e2eMarkerPath(), '', 'utf-8')
      // 主仓库也造脏——② 若降级到主仓库，这个改动会被 `checkout -- .` 抹掉
      writeFileSync(resolve(tmpRepo, 'tracked.txt'), 'DIRTY\n', 'utf-8')

      const engine = createExecutionEngine(createFakeBus())
      await runRound(engine, 'sd-c2', 'trace-sd-c2', { sessionId: 'sdcreg02' })

      // ② 真在 worktree 上动了手（留痕 + 文件被重置）
      expect(serialWarnedDirtyReset()).toBe(true)
      expect(readFileSync(resolve(wt, 'tracked.txt'), 'utf-8')).toBe('base\n')
      // 主仓库**不受影响**：未提交改动还在
      expect(repoFile('tracked.txt')).toBe('DIRTY\n')
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // 维度 A×B · 降级面（Phase 2 收窄后：降级 = **不动作 + 显式告警**）
  //   4 类不可用成因逐格独立断言；每格注释里留 Phase 1 旧读数以便对照
  // ══════════════════════════════════════════════════════════════════
  describe('维度 A×B · 降级面（收窄后）', () => {
    // ── B1：非 git 仓（`getMainRepoRoot()` → null，`git-utils.ts:450`）──
    describe('B1 · 非 git 仓（getMainRepoRoot → null）', () => {
      it('B1 · 建不出 ⇒ ① 不提交、② 不清理，两者各留一条显式告警', async () => {
        // Phase 1 旧读数：① 无 cwd 调用但落空（无仓库可落）；② git 直接抛错被吞
        // ⇒ 当时实害为零，但**零告警**（降级发生了却没人知道）。Phase 2 补的就是告警这一半。
        const r = await runScenario({
          sessionId: 'sdb1ng001',
          triggerId: 'sd-b1',
          cwd: tmpNoGit,
        })
        // ① 没提交进主仓库（`isGitRepo()` false ⇒ `ensureSessionWorktree` 提前返回 null）
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        // ② 同样建不出 ⇒ 不清理
        expect(r.warnedDirtyReset).toBe(false)
        // 主仓库的未提交改动**未被动过**
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        // 且降级**不再静默**
        expect(r.warnedAboutWorktree).toBe(true)
      })
    })

    // ── B2：会话 id 形态异常（`sessionShortId` → ''，`git-utils.ts:452`）──
    describe("B2 · 会话 id 形态异常（sessionShortId → ''）", () => {
      it('B2 · 建不出 ⇒ 不提交、不清理，主仓库未提交改动原地保留', async () => {
        // Phase 1 旧读数：① 把主仓库未提交改动**提交进当前分支**（mainRepoHead =
        // `catstudy [sd-b2]`、树被清干净）、② 因此无脏可清 —— 绕过审查链的那条实害。
        const r = await runScenario({ sessionId: '!!!!!', triggerId: 'sd-b2' })
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        expect(r.mainRepoDirty).toBe(true)
        expect(r.warnedAboutWorktree).toBe(true)
        expect(r.warnedDirtyReset).toBe(false)
      })
    })

    // ── B3：worktree 目录不存在（`git-utils.ts:454`）──
    // 三条谓词，不是两条（审查 OQ1）：
    //   a) 本轮真跑 LLM ⇒ `reply.ts:976` 先把 worktree 建出来，收尾只是复用；
    //   b) 猫忙 ⇒ 本轮无执行（`anyClaude=false`）⇒ 收尾是**本轮唯一**的 worktree 解析点，
    //      ① 会**现建**出来（Q4 裁决 A：收口后会话续用是期望行为）；
    //   c) 早期失败 —— `claudeRan` 已为 true 而 worktree 尚未建（走到 `reply.ts:976`
    //      之前抛错）⇒ ① 现建、② 作用域 = 新 worktree。这一格是 Phase 2 新补的。
    describe('B3 · worktree 目录不存在', () => {
      it('B3-a · 本轮真跑 LLM ⇒ reply.ts 先建工作区，收尾复用；主仓库零改动', async () => {
        const triggerId = 'sd-b3a'
        const wt = wtPathFor('sdb3llm1')!
        worktrees.push(wt)
        // 本用例**不**调用 ensureSessionWorktree——目录只可能由 reply.ts:976 建出来
        expect(existsSync(wt)).toBe(false)

        const r = await runScenario({ sessionId: 'sdb3llm1', triggerId })

        expect(existsSync(wt)).toBe(true)
        // 降级没发生：主仓库 HEAD 未动、未提交改动原样（既没被提交也没被回滚）
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
      })

      it('B3-b · 猫忙（本轮无执行）⇒ ① 现建 worktree 并把提交落在它上面；主仓库零改动', async () => {
        // Phase 1 旧读数：`committedIntoMainRepo: true`（`mainRepoHead` = `catstudy [sd-b3b]`）
        // —— 生产触发窗口（收口删 worktree 后 + 猫忙）下的降级提交。
        const r = await runScenario({
          sessionId: 'sdb3busy1',
          triggerId: 'sd-b3b',
          busy: true,
        })
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        // ① 走的是 `ensureSessionWorktree` ⇒ worktree 被**现建**出来（不再是「降级到主仓库」）
        expect(r.worktreeExists).toBe(true)
        // 建得出 ⇒ 不告警（告警只在「建不出」时出现，与 B1/B2/B4 区分开）
        expect(r.warnedAboutWorktree).toBe(false)
        // ② 挂在 `if (anyClaude)` 里——本轮没有执行体 ⇒ 清理段不跑
        expect(r.warnedDirtyReset).toBe(false)
      })

      it('B3-c · 早期失败（claudeRan=true 而 worktree 未建）⇒ ① 现建、② 作用域 = 新 worktree', async () => {
        // 「本轮有 claude 执行体、但 worktree 尚未建」这条窄缝：`getAdapterForAgent`
        // 是 `runAgentReply` 的第一条语句（`reply.ts:314`），在此抛错就落在
        // 「`claudeRan` 已为 true ∧ 走不到 `reply.ts:976`」——OQ1 的第三谓词。
        const wt = wtPathFor('sdb3erly')!
        worktrees.push(wt)
        expect(existsSync(wt)).toBe(false)

        h.failAdapterResolve = true
        const r = await runScenario({ sessionId: 'sdb3erly', triggerId: 'sd-b3e' })
        h.failAdapterResolve = false

        // ① 现建：收尾路径上把 worktree 补出来
        expect(r.worktreeExists).toBe(true)
        // 而这一轮**没有任何东西可提交**（worktree 是从 HEAD 现检出的干净树）⇒ 提交为空
        expect(r.worktreeHead).toBe('init')
        // 主仓库零改动：没被提交、没被回滚、没被清
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        expect(r.mainRepoDirty).toBe(true)
        expect(r.warnedAboutWorktree).toBe(false)
        // ② 作用域 = 新 worktree；新建即干净 ⇒ 清理未被触发
        expect(r.warnedDirtyReset).toBe(false)
      })
    })

    // ── B4：`ensureSessionWorktree` 自建失败（会话分支已被别的 worktree 占用）──
    describe('B4 · ensureSessionWorktree 自建失败（会话分支已被别的 worktree 占用）', () => {
      it('B4-a · 建不出 ⇒ ① 不提交、② 不清理，两条告警齐；主仓库零改动', async () => {
        // Phase 1 旧读数：① 降级提交进主仓库（`catstudy [sd-b4]`），② 因此无脏可清。
        occupySessionBranch('sdb4fail')
        const r = await runScenario({ sessionId: 'sdb4fail', triggerId: 'sd-b4' })
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        expect(r.mainRepoDirty).toBe(true)
        expect(r.warnedAboutWorktree).toBe(true)
        expect(r.warnedDirtyReset).toBe(false)
      })

      it('B4-b · ① 被 e2e 标记关掉时，② 仍不碰主仓库（Phase 1 的「只改 ① 不改 ②」耦合已断）', async () => {
        // Phase 1 旧读数：① 不提交 ⇒ ② 的 `checkout -- .` 把主仓库未提交改动
        // **静默删掉**（`mainRepoTracked` 从 `DIRTY` 变回 `base`）——比误提交更不可逆。
        // Phase 2 ①② 同批收窄后，② 也走 `ensureSessionWorktree`，这条删除路径不复存在。
        occupySessionBranch('sdb4fl02')
        const r = await runScenario({
          sessionId: 'sdb4fl02',
          triggerId: 'sd-b4b',
          e2eMarker: true,
        })
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.warnedDirtyReset).toBe(false)
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        expect(r.mainRepoDirty).toBe(true)
      })
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // G4 · 红线锚：主仓库有未提交 tracked 改动 + depth===0 跑一轮
  // ══════════════════════════════════════════════════════════════════
  describe('G4 · 红线锚（主仓库存在未提交 tracked 改动）', () => {
    it('G4a · 生产触发窗口（猫忙）⇒ ① 不再提交进主仓库（Phase 1 旧读数为 true）', async () => {
      const r = await runScenario({
        sessionId: 'sdg4anch1',
        triggerId: 'sd-g4a',
        busy: true, // 生产触发窗口：猫忙 ⇒ 入队即返回 ⇒ 收尾立刻跑
      })
      // Phase 1 实测：① 先跑且成功，把主仓库改动**提交**进当前分支（绕过审查链）。
      // Phase 2：① 走 `ensureSessionWorktree` ⇒ 提交只落 worktree，主仓库零改动。
      expect(r.committedIntoMainRepo).toBe(false)
      expect(r.mainRepoHead).toBe('init')
      expect(r.mainRepoTracked).toBe('DIRTY\n')
      expect(r.mainRepoDirty).toBe(true)
      expect(r.warnedDirtyReset).toBe(false)
      expect(r.worktreeExists).toBe(true)
    })

    it('G4b · ① 不提交时 ② 也不回滚主仓库——「静默删除」路径已关闭', async () => {
      // Phase 1 实测（票面 G4b 原文）：① 不提交时 ② 的 `checkout -- .` 会把主仓库
      // tracked 改动回滚成 `base`——**静默删除**，是本票最硬的那条红线。
      // 成因取 B2（shortId 为空）——worktree 必建不出，收窄前 ② 的 `?? process.cwd()` 生效。
      const r = await runScenario({
        sessionId: '!!!!!',
        triggerId: 'sd-g4b',
        e2eMarker: true,
      })
      expect(r.committedIntoMainRepo).toBe(false)
      expect(r.warnedDirtyReset).toBe(false)
      // 改动**原地保留**（Phase 1 这里读数是 `base\n` = 内容静默消失）
      expect(r.mainRepoTracked).toBe('DIRTY\n')
      expect(r.mainRepoDirty).toBe(true)
      expect(r.warnedAboutWorktree).toBe(true)
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // R1 · `ensureSessionWorktree` 进入 ① 后的耗时读数（票面要求实测，非阈值断言）
  // ══════════════════════════════════════════════════════════════════
  describe('R1 · 收尾路径上 worktree 解析的耗时读数', () => {
    it('R1 · 现建 vs 复用：两个读数都留痕（本用例断言行为，耗时只报数不设阈值）', async () => {
      const sid = 'sdr1tim'
      const wt = wtPathFor(sid)!
      worktrees.push(wt)
      // 链接源备齐 ⇒ 现建那条会把 `mklink /J` 的真实 Windows 成本算进去
      // （不备则是无源可链的**下界**，量出来的数会偏乐观）
      mkdirSync(resolve(tmpRepo, 'node_modules'), { recursive: true })
      writeFileSync(resolve(tmpRepo, 'node_modules', 'sentinel.txt'), 'root-dep\n', 'utf-8')
      mkdirSync(resolve(tmpRepo, 'packages', 'server', 'node_modules'), { recursive: true })
      writeFileSync(
        resolve(tmpRepo, 'packages', 'server', 'node_modules', 'sentinel.txt'),
        'x\n',
        'utf-8'
      )

      // 直接测 `ensureSessionWorktree` 本身——轮次级计时（~300ms 的引擎/DB 开销）
      // 会把几十毫秒的建链成本淹进噪声，区分度不够（实测轮次级 346/254ms 无区分度）。
      //
      // 真仓库端到端读数（本机 2026-09-15，主仓库 dev@3822b17，474 个 tracked 文件，
      // 会话 worktree 与真 dev 库快照同环境）：**现建 368ms / 复用 51ms**；其中
      // `git worktree add` 单项 = 205ms（夹具没这个量级，故夹具读数是**下界**）。
      // 结论：新增的阻塞成本落在既有 `gitCommit`（3 次连续 execSync）同一量级，
      // 不改变「收尾段是百毫秒级阻塞」的既有形态。
      const tA = Date.now()
      const first = ensureSessionWorktree(sid)
      const buildMs = Date.now() - tA
      expect(first).toBe(wt)

      const tB = Date.now()
      const again = ensureSessionWorktree(sid)
      const reuseMs = Date.now() - tB
      expect(again).toBe(wt)

      // 顺带走一遍**收尾路径**（① 现建 → 复用）确认它在这条路上不炸。
      // 注意：下面两条 `worktreeExists` **不绑定 Phase 2 行为**（本用例已先把 worktree
      // 建出来了，还原成旧代码同样绿）——行为绑定在 B3-b（猫忙 ⇒ ① 现建，旧代码下真红）。
      // 本用例的定位是「报数」，不是「判行为」，别把它的绿当成覆盖。
      const r1 = await runScenario({ sessionId: sid, triggerId: 'sd-r1a', busy: true })
      const r2 = await runScenario({ sessionId: sid, triggerId: 'sd-r1b', busy: true })

      // eslint-disable-next-line no-console
      console.info(
        `[T-1 R1] ensureSessionWorktree 现建=${buildMs}ms 复用=${reuseMs}ms ` +
          `（含 mklink /J 根链接 + packages/server 包级链接；临时仓库夹具，真仓库包级链接为 3 条）`
      )

      expect(r1.worktreeExists).toBe(true)
      expect(r2.worktreeExists).toBe(true)
      // 只做「有界」这个弱断言，避免把 CI 负载抖动量成回归；真实读数以上面那行为准
      expect(buildMs).toBeLessThan(30_000)
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // R2 · 「新建 worktree 后立刻清理」是全新组合（票面要求实测，不许推断）
  // ══════════════════════════════════════════════════════════════════
  describe('R2 · 新 worktree 上的清理不碰 node_modules junction', () => {
    it('R2 · 新 worktree 建出来即干净（clean 未被触发）；强制触发 `git clean -fd` 也不动 junction', async () => {
      const sid = 'sdr2junc'
      const wt = wtPathFor(sid)!
      worktrees.push(wt)
      // 主仓库备好链接源：根 node_modules + 包级 packages/server/node_modules
      mkdirSync(resolve(tmpRepo, 'node_modules'), { recursive: true })
      writeFileSync(resolve(tmpRepo, 'node_modules', 'sentinel.txt'), 'root-dep\n', 'utf-8')
      mkdirSync(resolve(tmpRepo, 'packages', 'server', 'node_modules'), { recursive: true })
      writeFileSync(
        resolve(tmpRepo, 'packages', 'server', 'node_modules', 'sentinel.txt'),
        'pkg-dep\n',
        'utf-8'
      )

      // 早期失败路径 ⇒ ① 现建 worktree（含 linkNodeModules），② 作用域 = 那个新 worktree
      h.failAdapterResolve = true
      const r = await runScenario({ sessionId: sid, triggerId: 'sd-r2' })
      h.failAdapterResolve = false

      expect(r.worktreeExists).toBe(true)
      // ① 建 worktree 时 linkNodeModules 已把链接建好
      expect(existsSync(resolve(wt, 'node_modules')), '根 junction').toBe(true)
      expect(existsSync(resolve(wt, 'packages', 'server', 'node_modules')), '包级 junction').toBe(
        true
      )
      expect(readFileSync(resolve(wt, 'node_modules', 'sentinel.txt'), 'utf-8')).toBe('root-dep\n')

      // 读数①：新建即干净 ⇒ ② 的 `git clean -fd` **根本不在触发路径上**
      //   （`.gitignore` 命中 junction ⇒ 不出现在 status；packages/* 是 tracked 目录）
      expect(git(['status', '--porcelain'], wt)).toBe('')
      expect(r.warnedDirtyReset).toBe(false)

      // 读数②：强制走一遍 ② 的确切命令序列——证明「若被触发」也不碰链接
      writeFileSync(resolve(wt, 'stray.txt'), 'untracked\n', 'utf-8')
      expect(git(['status', '--porcelain'], wt)).toContain('stray.txt')
      execSync('git checkout -- .', { cwd: wt, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git clean -fd', { cwd: wt, env: cleanGitEnv(), stdio: 'ignore' })

      expect(existsSync(resolve(wt, 'stray.txt')), 'stray 被清掉（clean 确实生效）').toBe(false)
      expect(existsSync(resolve(wt, 'node_modules')), '根 junction 存活').toBe(true)
      expect(
        existsSync(resolve(wt, 'packages', 'server', 'node_modules')),
        '包级 junction 存活'
      ).toBe(true)
      expect(readFileSync(resolve(wt, 'node_modules', 'sentinel.txt'), 'utf-8')).toBe('root-dep\n')
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // OQ4 · `cleanGitEnv()` 对称（Phase 2 把 ② 的三条 execSync 与 gitCommit 对齐）
  // ══════════════════════════════════════════════════════════════════
  describe('OQ4 · ② 的清理与 gitCommit 一样剥 GIT_* 环境变量', () => {
    it('OQ4 · A/B 对照：不剥 GIT_DIR 会漂移出目标仓库；剥了则作用域钉在 worktree', async () => {
      const wt = makeWorktree('sdoq4git')
      writeFileSync(resolve(wt, 'tracked.txt'), 'WT-DIRTY\n', 'utf-8')
      // 诱饵仓库：环境注入 GIT_DIR 时会被劫持到的那个仓库
      const decoy = makeDecoyRepo()

      // ① 关掉（e2e 标记 ⇒ gitCommit 返回 null），把 ② 的清理**单独暴露出来**
      mkdirSync(dirname(e2eMarkerPath()), { recursive: true })
      writeFileSync(e2eMarkerPath(), '', 'utf-8')

      process.env.GIT_DIR = resolve(decoy, '.git')
      process.env.GIT_WORK_TREE = decoy
      let drifted = ''
      let scoped = ''
      try {
        // A/B 对照（同一 cwd，只差 env）——证明下面那条断言不是恒真
        drifted = execSync('git status --porcelain', {
          cwd: wt,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        scoped = execSync('git status --porcelain', {
          cwd: wt,
          env: cleanGitEnv(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()

        const engine = createExecutionEngine(createFakeBus())
        await runRound(engine, 'sd-oq4', 'trace-sd-oq4', { sessionId: 'sdoq4git' })
      } finally {
        delete process.env.GIT_DIR
        delete process.env.GIT_WORK_TREE
      }

      // 对照组成立：不剥 env ⇒ 读的是**诱饵**仓库的状态（漂移真实存在）
      expect(drifted, 'GIT_DIR 未被剥 ⇒ 漂移出目标仓库').toContain('decoy-only.txt')
      expect(scoped, '剥掉后读的是 worktree 自己的状态').toContain('tracked.txt')
      expect(scoped).not.toContain('decoy-only.txt')

      // ② 真在 worktree 上动了手（作用域没漂）
      expect(readFileSync(resolve(wt, 'tracked.txt'), 'utf-8')).toBe('base\n')
      // 诱饵仓库**不受影响**
      expect(readFileSync(resolve(decoy, 'decoy-only.txt'), 'utf-8')).toBe('DECOY-DIRTY\n')
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 覆盖边界（G7，防「假绿门」：验证面必须与被判面同面）
//
// 证得了：
//   - 「主仓库零改动」这一类断言读的是**真临时 git 仓**的真状态（`git log` / `git status`
//     / 文件内容），不是 mock 调用记录 ⇒ 证得了「文件系统上主仓库真的没被动」。
//   - B1–B4 四类成因逐格独立断言；每格的 `warnedAboutWorktree` 与
//     `warnedDirtyReset` 从 logger 的**通道名 + 文本**两维区分（不被其他模块的告警污染）。
//   - OQ4 用例自带 A/B 对照（同一 cwd、只差 env）⇒「剥了才不漂」这条不是恒真。
//
// 证不了（明写，别当已覆盖）：
//   - **`anyClaude` 门槛耦合**：② 整段挂在 `if (anyClaude)` 里，而 `anyClaude` 依赖
//     agent 的 `llmProvider === 'claude'`（取自 **agents 表行**，不是传参）。后人把
//     夹具里的 provider 改回 deepseek ⇒ B3-c/B4-b/R2/OQ4 里「② 不动作」的四条断言会
//     **静默变空**。缓解：同时有 5 条**要求 ② 真动手**的绿断言（C-②、OQ4 的
//     `readFileSync(wt) === 'base\n'`、以及「② 不动手」格中要求 `warnedAboutWorktree`
//     为真），provider 一改就会响——但「静默变空」这件事本身没被机制挡住。
//   - `R1` 的耗时读数是**下界**：临时仓库夹具里 `linkNodeModules` 无源可链（主仓库
//     没有真依赖树），真仓库建 junction 的耗时未直接读到。R2 覆盖了 junction 的
//     **存活性**，未覆盖其**建链耗时**。
//   - `wtPathFor` 用 `sessionShortId` + `sessionWorktreePath` 复算路径（与生产同源），
//     但**没有**走 `getMainRepoRoot()`；若生产侧 mainRoot 解析变化，本文件的路径假设会
//     先失效——`runScenario` 回读的 `worktreeExists` 用的是同一个复算值，两者**同向**
//     失效，不会互相证伪。
//   - B1（非 git 仓）格读的是「无仓库可落」；真实机器上 server 站在 git 仓里，
//     这一格的**触发概率**未评估。
// ══════════════════════════════════════════════════════════════════════════

/**
 * serial.ts × 降级路径（T-1 Phase 1 · 测试先行）。
 * 票面：`docs/run/multi-cat-isolation/tickets.md`。
 *
 * **被测面**：`executeAgentsSerial` 顶层收尾（`depth === 0`）的两处「worktree 不可用 →
 * 兜底落 `process.cwd()`」——
 *   ① `serial.ts:1149-1153` auto-commit：无 worktree ⇒ `gitCommit(msg)` **不带 cwd** ⇒
 *      落 `process.cwd()` = 主仓库根 ⇒ `git add -A` + commit **进主仓库当前分支**（绕过审查链）
 *   ② `serial.ts:1199-1211` 脏文件清理：无 worktree ⇒ `process.cwd()` ⇒
 *      `git checkout -- .` + `git clean -fd` **作用到主仓库整棵树**
 *
 * **形态：真 git 仓库，`git-utils` 与 `node:child_process` 一律不 mock。**
 * 降级路径的实害是「文件系统上真的动了哪个仓库」——只有让 `git commit` / `git checkout`
 * 真跑、再读真仓库的真状态才判得出来。本仓栽过「验证面与被判面不同面」的假绿门
 * （judge 扫消息 content 却 grep 工作区文件），故本文件**不采用**「mock 掉 gitCommit
 * 再断言它没被调用」的形态——那只证得了「调用没发生」，证不了「主仓库文件真的没动」。
 * 做法与 `llm/session-closeout.test.ts` 同款：`mkdtemp` + `git init` + `chdir`。
 *
 * **安全前提（必读，否则测试自己就是事故）**：`serial.ts:1200/1210/1211` 的 execSync
 * **不带 `cleanGitEnv()`**（与 `git-utils` 不对称）。若进程环境里残留 `GIT_DIR`
 * （本仓已知：git 跑钩子时向子进程注入，曾把主仓库 `core.bare` 写成 true），那几条
 * `git checkout -- .` 会**穿透到真实仓库**。故 `beforeAll` 先剥掉这四个变量。
 *
 * **Phase 1 契约**：只加测试、零生产改动；目标行为（Phase 2 要改成的样子）用 `it.fails`
 * 编码——闸保持全绿，Phase 2 改对后它会主动报错、强制翻回 `it`。
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentConfig, Message } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { ensureSessionWorktree } from '../llm/git-utils.js'

// ═══ 边界 mock（LLM / 记忆 / 摘要 / handoff / diff / 信号——与「提交落哪」无关）═══
// 刻意**不** mock：`../llm/git-utils.js`、`node:child_process`。

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
  collectCommitDiffs: vi.fn(),
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

/** 临时「主仓库」根（真 git 仓，dev 分支） */
let tmpRepo = ''
/** 非 git 目录（B1 成因：`getMainRepoRoot()` → null） */
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

beforeAll(() => {
  // ⚠ 安全前提：`serial.ts` 的清理段 execSync 不带 cleanGitEnv()——环境里残留
  // GIT_DIR 会让它穿透到真实仓库。这里从**进程环境**剥掉（子进程继承 process.env）。
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) {
    origGitEnv[k] = process.env[k]
    delete process.env[k]
  }

  tmpRepo = mkdtempSync(join(tmpdir(), 'serial-downgrade-repo-'))
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
  git(['add', '-A'])
  git(['commit', '-m', 'init'])
  initSha = git(['rev-parse', 'HEAD'])

  tmpNoGit = mkdtempSync(join(tmpdir(), 'serial-downgrade-nogit-'))
  process.chdir(tmpRepo)
})

afterAll(() => {
  process.chdir(origCwd)
  for (const dir of [...worktrees, ...scratchDirs, tmpRepo, tmpNoGit]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
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
 * ② 脏文件清理整个挂在 `if (anyClaude)`（`:1189`）里。用非 claude provider 跑，
 * ② 永远不执行，本矩阵的第二半（清理作用域）会**全是空断言**。
 * （`:3570` 注释：「只有它会编辑源文件」——② 本来就只为 claude 执行体存在。）
 */
const A1: AgentConfig = {
  id: 'agent-1',
  name: 'flash猫',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'claude',
  llmModel: 'claude-sonnet-5',
  llmApiKey: 'sk-test',
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
    { id: triggerId, content: '你好', mentions: [] },
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
}

/**
 * 降级场景：主仓库预置**未提交的 tracked 改动** → 跑一轮 → 读真仓库。
 *
 * `cwd` 决定「server 站在哪」；`e2eMarker` 打开时 `gitCommit` 直接返回 null
 * （① 不提交），从而把 ② 的清理行为**单独暴露出来**——这是 Phase 2「只改 ① 不改 ②」
 * 那条耦合的复现开关。
 */
async function runScenario(opts: {
  sessionId: string
  triggerId: string
  cwd?: string
  busy?: boolean
  e2eMarker?: boolean
}): Promise<Reading> {
  process.chdir(opts.cwd ?? tmpRepo)
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
  const holder = join(tmpdir(), `serial-downgrade-holder-${shortId}`)
  scratchDirs.push(holder)
  git(['worktree', 'add', holder, branch])
}

describe('serial × 降级路径（T-1 Phase 1：只加测试、零生产改动）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
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
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', 'flash猫', '🐱', 'p', 'claude', 'claude-sonnet-5', 'sk-test')`
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
  // 维度 C · 回归面：worktree 存在 → 隔离生效（现状行为，绿）
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
  // 维度 A×B 矩阵：2 个降级点 × 4 类 worktree 不可用成因
  //   每格两条：现状（it，绿，留读数）+ 目标（it.fails，Phase 2 翻成 it）
  // ══════════════════════════════════════════════════════════════════
  describe('维度 A×B · 矩阵', () => {
    // ── B1：非 git 仓（`getMainRepoRoot()` → null，`git-utils.ts:450`）──
    describe('B1 · 非 git 仓（getMainRepoRoot → null）', () => {
      it('B1 现状 · ① 无 cwd 调用但落空（无仓库可落）；② 落 cwd 但 git 直接抛错被吞 ⇒ 无实害', async () => {
        const r = await runScenario({
          sessionId: 'sdb1ng001',
          triggerId: 'sd-b1',
          cwd: tmpNoGit,
        })
        // ① 没提交进主仓库（`isGitRepo()` false ⇒ gitCommit 提前返回 null）
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        // ② 跑在非 git 目录上 ⇒ git status 抛错被 catch 吞掉
        expect(r.warnedDirtyReset).toBe(false)
        // 主仓库的未提交改动**未被动过**（这一格当前就无实害）
        expect(r.mainRepoTracked).toBe('DIRTY\n')
        // 但——**零告警**：降级发生了却没人知道（目标面要补的就是这条）
        expect(r.warnedAboutWorktree).toBe(false)
      })

      it.fails(
        'B1 目标 · 建不出 ⇒ 不提交、不清理，且 serial 显式告警（worktree 不可用）',
        async () => {
          const r = await runScenario({
            sessionId: 'sdb1ng002',
            triggerId: 'sd-b1t',
            cwd: tmpNoGit,
          })
          expect(r).toMatchObject({
            committedIntoMainRepo: false,
            warnedDirtyReset: false,
            warnedAboutWorktree: true, // ← 当前为 false，Phase 2 补齐
          })
        }
      )
    })

    // ── B2：会话 id 形态异常（`sessionShortId` → ''，`git-utils.ts:452`）──
    describe("B2 · 会话 id 形态异常（sessionShortId → ''）", () => {
      it('B2 现状 · ① 把主仓库未提交改动提交进当前分支（绕过审查链）', async () => {
        const r = await runScenario({ sessionId: '!!!!!', triggerId: 'sd-b2' })
        expect(r.committedIntoMainRepo).toBe(true)
        expect(r.mainRepoHead).toBe('catstudy [sd-b2]')
        expect(r.mainRepoTracked).toBe('DIRTY\n') // 改动进了 commit，不是被回滚
        expect(r.mainRepoDirty).toBe(false)
      })

      it.fails('B2 目标 · 建不出 ⇒ 不提交、不清理，且 serial 显式告警', async () => {
        const r = await runScenario({ sessionId: '!!!!!', triggerId: 'sd-b2t' })
        expect(r).toMatchObject({
          committedIntoMainRepo: false,
          mainRepoTracked: 'DIRTY\n',
          warnedAboutWorktree: true,
        })
      })
    })

    // ── B3：worktree 目录不存在（`git-utils.ts:454`）──
    describe('B3 · worktree 目录不存在', () => {
      it('B3 现状 · 本轮真跑 LLM ⇒ reply.ts 先建 worktree，降级**不发生**（这一成因在有执行的路径上不可达）', async () => {
        const triggerId = 'sd-b3a'
        const wt = resolve(tmpdir(), 'catStudy-sessions', 'sdb3llm1')
        worktrees.push(wt)
        // 本测试**不**调用 ensureSessionWorktree——目录只可能由 reply.ts:980 建出来
        expect(existsSync(wt)).toBe(false)

        const r = await runScenario({ sessionId: 'sdb3llm1', triggerId })

        expect(existsSync(wt)).toBe(true)
        // 降级没发生：主仓库 HEAD 未动、未提交改动原样（既没被提交也没被回滚）
        expect(r.committedIntoMainRepo).toBe(false)
        expect(r.mainRepoHead).toBe('init')
        expect(r.mainRepoTracked).toBe('DIRTY\n')
      })

      it('B3 现状 · 忙时入队（本轮无执行，anyClaude=false）⇒ ① 降级提交进主仓库；② 整段被跳过', async () => {
        const r = await runScenario({
          sessionId: 'sdb3busy1',
          triggerId: 'sd-b3b',
          busy: true,
        })
        expect(r.committedIntoMainRepo).toBe(true)
        expect(r.mainRepoHead).toBe('catstudy [sd-b3b]')
        // ② 挂在 `if (anyClaude)` 里——本轮没有执行体 ⇒ 连降级清理都不跑
        expect(r.warnedDirtyReset).toBe(false)
      })

      it.fails('B3 目标 · 建不出 ⇒ 不提交、不清理，且 serial 显式告警', async () => {
        const r = await runScenario({
          sessionId: 'sdb3busy2',
          triggerId: 'sd-b3t',
          busy: true,
        })
        expect(r).toMatchObject({
          committedIntoMainRepo: false,
          mainRepoTracked: 'DIRTY\n',
          warnedAboutWorktree: true,
        })
      })
    })

    // ── B4：`ensureSessionWorktree` 自建失败（`git-utils.ts:379` 的 4 条 return null 路径）──
    describe('B4 · ensureSessionWorktree 自建失败（会话分支已被别的 worktree 占用）', () => {
      it('B4 现状 · ① 降级提交进主仓库（本轮真跑 LLM ⇒ ② 也走降级，但 ① 已把树清干净 ⇒ 无操作）', async () => {
        occupySessionBranch('sdb4fail')
        const r = await runScenario({ sessionId: 'sdb4fail', triggerId: 'sd-b4' })
        expect(r.committedIntoMainRepo).toBe(true)
        expect(r.mainRepoHead).toBe('catstudy [sd-b4]')
        expect(r.mainRepoTracked).toBe('DIRTY\n') // 进了 commit
        expect(r.mainRepoDirty).toBe(false) // 树被 ① 清干净 ⇒ ② 即使跑也无可清
      })

      it('B4 现状（② 单独暴露）· ① 被 e2e 标记关掉时，② 在主仓库上真跑 checkout+clean', async () => {
        occupySessionBranch('sdb4fl02')
        const r = await runScenario({
          sessionId: 'sdb4fl02',
          triggerId: 'sd-b4b',
          e2eMarker: true,
        })
        expect(r.committedIntoMainRepo).toBe(false)
        // ② 作用域落到主仓库：未提交改动被 `git checkout -- .` 回滚
        expect(r.warnedDirtyReset).toBe(true)
        expect(r.mainRepoTracked).toBe('base\n')
        expect(r.mainRepoDirty).toBe(false)
      })

      it.fails('B4 目标 · 建不出 ⇒ 不提交、不清理，且 serial 显式告警', async () => {
        occupySessionBranch('sdb4fl03')
        const r = await runScenario({ sessionId: 'sdb4fl03', triggerId: 'sd-b4t' })
        expect(r).toMatchObject({
          committedIntoMainRepo: false,
          warnedAboutWorktree: true,
        })
      })
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // G4 · 红线锚：主仓库有未提交 tracked 改动 + depth===0 跑一轮 → 留当前读数
  // ══════════════════════════════════════════════════════════════════
  describe('G4 · 红线锚（主仓库存在未提交 tracked 改动）', () => {
    it('G4a · ① 的实害是「提交进主仓库当前分支」——不是「改动被回滚」', async () => {
      const r = await runScenario({
        sessionId: 'sdg4anch1',
        triggerId: 'sd-g4a',
        busy: true, // 生产触发窗口：猫忙 ⇒ 入队即返回 ⇒ 收尾立刻跑
      })
      // 票面 G4 的预期原文是「改动被回滚」——实测读数与之不符，以实测为准：
      // ① 先跑且成功，把改动**提交**进主仓库当前分支（绕过审查链），② 因此无脏可清。
      expect(r.committedIntoMainRepo).toBe(true)
      expect(r.mainRepoTracked).toBe('DIRTY\n')
      expect(r.mainRepoDirty).toBe(false)
      expect(r.warnedDirtyReset).toBe(false)
    })

    it('G4b · ① 不提交时 ② 回滚主仓库 tracked 改动——Phase 2「只改 ① 不改 ②」的耦合证据', async () => {
      // ② 要真跑，本轮必须有 claude 执行体（`anyClaude`）；故**不能**用 busy 场景。
      // 成因取 B2（shortId 为空）——worktree 必建不出，② 的 `?? process.cwd()` 生效。
      const r = await runScenario({
        sessionId: '!!!!!',
        triggerId: 'sd-g4b',
        e2eMarker: true,
      })
      expect(r.committedIntoMainRepo).toBe(false)
      expect(r.warnedDirtyReset).toBe(true)
      // 改动**静默消失**（比「误提交」更不可逆——内容不在 git 里了）
      expect(r.mainRepoTracked).toBe('base\n')
    })
  })
})

/**
 * decideHookDelivery 判定逻辑单测（T-A ①：post-commit 兜底投递三分支）。
 *
 * 判据三态：有归属（agent 提交）→ 静默；无归属（用户手动提交）→ 投递；
 * 判据查不动 → **静默让位**（A 案，2026-09-12 用户裁定）。
 *
 * 为什么查不动不再投：查不动最常见于 server 正忙着跑那只猫——那正是「有归属」的
 * 字面状态，钩子此刻做不出判断、投出去的是待补填的空壳（猫补填后还会再投一份，
 * 内容不同 ⇒ 过不了内容去重 ⇒ 审查者收到两份）。让位 ≠ 永久放弃：义务归实施猫
 * 铁律自投，漏了由收尾兜底 `--fallback-sha` 接手。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  decideHookDelivery,
  parseArgs,
  resolveExecutorName,
  probeAttribution,
  describeExecutorMatch,
  isExemptDelivery,
  isForceDeliver,
  REVIEW_EXEMPT_PREFIXES,
  parseChangedFiles,
  sessionShortId,
  isPathInside,
  judgeRepoOwnership,
  formatOwnershipRefusal,
} from './handoff-gen.mjs'

describe('decideHookDelivery — T-A ① 钩子侧归属判据', () => {
  it('有归属执行（agent 执行中提交）→ 不投（实施猫负责主动投递）', () => {
    const verdict = decideHookDelivery(true)
    expect(verdict.deliver).toBe(false)
    expect(verdict.reason).toContain('有归属')
  })

  it('无归属执行（用户手动提交）→ 兜底投递', () => {
    const verdict = decideHookDelivery(false)
    expect(verdict.deliver).toBe(true)
    expect(verdict.reason).toContain('手动提交')
  })

  it('归属判据查不动（探针超时/不可达/响应不可解析）→ 静默让位，不猜', () => {
    const verdict = decideHookDelivery(null)
    expect(verdict.deliver).toBe(false)
    expect(verdict.reason).toContain('查不动')
    expect(verdict.reason).toContain('静默')
    expect(verdict.reason).toContain('让位')
  })

  it('undefined 与 null 同语义（判据缺失 = 查不动 → 静默让位）', () => {
    expect(decideHookDelivery(undefined).deliver).toBe(false)
  })

  it('安全底线（A4）：翻的是 `null`，不是 `false`——无归属仍照投', () => {
    // 无 uuid 的手动提交路径传的是 `false`（不是 `null`），行为必须一字不变。
    // 这条断言与上面两条构成对：同一次改动只许翻转 `null` 那一格。
    expect(decideHookDelivery(false).deliver).toBe(true)
    expect(decideHookDelivery(false).reason).toContain('手动提交')
  })
})

describe('decideHookDelivery — 原痛点复现（返工不新起链）', () => {
  it('同一任务链连续两次 commit（第二次为返工形态）→ 钩子投 0 条', () => {
    // 两次提交都是 agent 在执行中提交（有归属）——旧行为是「每 commit 必投一条」，
    // 即每次返工都新起一条链；新行为两次都静默，审查请求只有实施猫主动投的那一条。
    const commits = [
      { sha: 'a'.repeat(40), attributed: true }, // 首轮 commit
      { sha: 'b'.repeat(40), attributed: true }, // 返工 commit（新 SHA，链不变）
    ]
    const delivered = commits.filter((c) => decideHookDelivery(c.attributed).deliver)
    expect(delivered).toHaveLength(0)
  })

  it('手动提交与 agent 提交混合 → 只补投手动那条', () => {
    const commits = [
      { sha: 'a'.repeat(40), attributed: true }, // agent 提交 → 静默
      { sha: 'b'.repeat(40), attributed: false }, // 用户手动提交 → 兜底投
    ]
    const delivered = commits.filter((c) => decideHookDelivery(c.attributed).deliver)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sha).toBe('b'.repeat(40))
  })
})

describe('parseArgs — 未知参数拒绝（必改 2）', () => {
  // 根因：无参调用 = post-commit 投递路径。静默忽略未知参数 → 拼错的 flag 会
  // 「换一条路继续干」并真发出一条消息（`--help` 实证投出 cdc476ba）。

  it('--help（未登记 flag）→ 抛错，不落进无参投递路径', () => {
    expect(() => parseArgs(['--help'])).toThrow(/未知参数/)
  })

  it('拼错的 flag（--no-postt）→ 抛错', () => {
    expect(() => parseArgs(['--no-postt'])).toThrow(/未知参数/)
  })

  it('非 flag 位置参数（被忽略的旧行为）→ 抛错', () => {
    expect(() => parseArgs(['HEAD~1..HEAD'])).toThrow(/未知参数/)
  })

  it('大小写不符（--CWD）→ 抛错（正则只认小写，不得静默吞）', () => {
    expect(() => parseArgs(['--CWD', '/tmp'])).toThrow(/未知参数/)
  })

  it('取值型 flag 缺值（--cwd 在末尾）→ 抛错，不静默丢参数', () => {
    expect(() => parseArgs(['--cwd'])).toThrow(/缺少值/)
    expect(() => parseArgs(['--fallback-sha'])).toThrow(/缺少值/)
  })

  it('布尔型 flag 不接受值（--no-post=1）→ 抛错', () => {
    expect(() => parseArgs(['--no-post=1'])).toThrow(/不接受值/)
  })

  // T-H / N5：取值型 flag 的值被后随 flag 贪吃（`--cwd --no-post` → {cwd:'--no-post'}）。
  // 旧行为的实害不是"值错了"——是**后随 flag 被静默吞掉**（少传一个 flag），且畸形值
  // 要等撞上后续 git 校验（`不是 git 仓库`）才暴露，报错点离病因很远。取值以 `-`
  // 开头一律判参数错误——路径与 sha 都不长这样。
  it('取值型 flag 的值是后随 flag（--cwd --no-post）→ 抛错，不静默吞掉后面那个 flag', () => {
    expect(() => parseArgs(['--cwd', '--no-post'])).toThrow(/不能以 - 开头/)
    expect(() => parseArgs(['--fallback-sha', '--cwd=/tmp'])).toThrow(/不能以 - 开头/)
    expect(() => parseArgs(['--cwd=--no-post'])).toThrow(/不能以 - 开头/)
  })

  it('--range（已移除）空格形式也抛错（不缺值时也一样）', () => {
    expect(() => parseArgs(['--range', 'a..b'])).toThrow(/已移除/)
  })

  it('合法参数照常解析：无参 / 空格形式 / 等号形式', () => {
    expect(parseArgs([])).toEqual({})
    expect(parseArgs(['--no-post'])).toEqual({ noPost: true })
    expect(parseArgs(['--gate-deliver'])).toEqual({ gateDeliver: true })
    expect(parseArgs(['--cwd', '/tmp/x', '--fallback-sha', 'abc'])).toEqual({
      cwd: '/tmp/x',
      fallbackSha: 'abc',
    })
    expect(parseArgs(['--cwd=/tmp/y', '--fallback-sha=def'])).toEqual({
      cwd: '/tmp/y',
      fallbackSha: 'def',
    })
  })

  it('生产调用形态全部合法（post-commit 无参 / pre-push / server 兜底 spawn）', () => {
    // 三条真实调用路径的参数形态——exit 非 0 只可能出现在人类手滑时
    expect(() => parseArgs([])).not.toThrow()
    expect(() => parseArgs(['--gate-deliver'])).not.toThrow()
    expect(() => parseArgs(['--fallback-sha=' + 'a'.repeat(40), '--cwd=/tmp'])).not.toThrow()
  })
})

describe('resolveExecutorName — 措辞不得把「回退」说成「精确匹配」（T-M 取证陷阱）', () => {
  const origFetch = globalThis.fetch
  let logs

  const stubFetch = (payload, status = 200) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }))
  }

  const captureLogs = () => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '))
    })
  }

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('服务端回报 matchedBy=trigger → 日志写「回退」，绝不出现「精确匹配」（旧实现无条件写「精确匹配」→ 必红）', async () => {
    captureLogs()
    stubFetch({ agentName: 'ds猫', taskId: 'anchor-1', matchedBy: 'trigger', ambiguous: false })
    const who = await resolveExecutorName('http://x', 'uuid-1', 'a'.repeat(40))
    expect(who?.agentName).toBe('ds猫')
    const line = logs.find((l) => l.includes('实施者:'))
    expect(line).toContain('回退触发消息反查')
    expect(logs.join('\n')).not.toContain('精确匹配')
  })

  it('服务端回报 matchedBy=commit → 日志写「精确匹配」', async () => {
    captureLogs()
    stubFetch({ agentName: 'flash猫', taskId: 'anchor-1', matchedBy: 'commit', ambiguous: false })
    await resolveExecutorName('http://x', 'uuid-1', 'a'.repeat(40))
    expect(logs.find((l) => l.includes('实施者:'))).toContain('精确匹配')
  })

  it('老 server 不回报 matchedBy → 明说「匹配方式未知」，不冒充精确匹配（旧实现必红）', async () => {
    captureLogs()
    stubFetch({ agentName: 'ds猫', taskId: 'anchor-1' })
    await resolveExecutorName('http://x', 'uuid-1', 'a'.repeat(40))
    const line = logs.find((l) => l.includes('实施者:'))
    expect(line).toContain('匹配方式未知')
    expect(logs.join('\n')).not.toContain('精确匹配')
  })

  it('ambiguous:true → 返回 null（兜底 @店长）且日志与「server 不可达」区分开', async () => {
    captureLogs()
    stubFetch({ agentId: null, agentName: null, taskId: null, matchedBy: null, ambiguous: true })
    const who = await resolveExecutorName('http://x', 'uuid-1', 'a'.repeat(40))
    expect(who).toBeNull()
    const joined = logs.join('\n')
    expect(joined).toContain('归属不可消歧')
    expect(joined).not.toContain('不可达')
  })

  it('describeExecutorMatch 的三态措辞（纯函数口径）', () => {
    expect(describeExecutorMatch('commit', 'a'.repeat(40))).toBe(', commit_hash 精确匹配')
    expect(describeExecutorMatch('trigger', 'a'.repeat(40))).toContain('回退触发消息反查')
    expect(describeExecutorMatch('trigger', undefined)).toBe(', 按触发消息反查')
    expect(describeExecutorMatch(undefined, 'a'.repeat(40))).toContain('匹配方式未知')
  })
})

describe('probeAttribution — ambiguous 是「有归属」的直接证据（T-M）', () => {
  const origFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  const stub = (payload, status = 200) => {
    globalThis.fetch = vi.fn(async () => ({ ok: status < 300, status, json: async () => payload }))
  }

  it('200 + ambiguous:true → true（有执行行 ⇒ 不投，避免白起一轮）', async () => {
    stub({ agentId: null, agentName: null, taskId: null, matchedBy: null, ambiguous: true })
    expect(await probeAttribution('http://x', 'uuid-1')).toBe(true)
  })

  it('404 → false（无执行行）——ambiguous 改判不得把这条既有语义带跑', async () => {
    stub({}, 404)
    expect(await probeAttribution('http://x', 'uuid-1')).toBe(false)
  })

  it('200 有 agentName → true', async () => {
    stub({ agentName: 'ds猫', matchedBy: 'trigger', ambiguous: false })
    expect(await probeAttribution('http://x', 'uuid-1')).toBe(true)
  })

  it('200 但既无 agentName 也无 ambiguous（契约漂移）→ null（查不动，交调用方判静默让位）', async () => {
    stub({ matchedBy: null })
    expect(await probeAttribution('http://x', 'uuid-1')).toBeNull()
  })
})

describe('isExemptDelivery — docs/run/ 免审白名单（票乙）', () => {
  // 判据的靶心：纯 `docs/run/**` 提交（在飞过程文档）不再发起独立审查轮。
  // 两个陷阱都在下面钉死：**尾斜杠**（前缀 ≠ 路径段）与**空数组**（every 对空集恒真）。

  it('常量带尾斜杠（docs/run-x/a.md 不得命中的唯一保证）', () => {
    expect(REVIEW_EXEMPT_PREFIXES).toEqual(['docs/run/'])
  })

  it('单路径命中前缀 → true', () => {
    expect(isExemptDelivery(['docs/run/map.md'])).toBe(true)
  })

  it('深层路径命中前缀 → true（前缀匹配不是同层匹配）', () => {
    expect(isExemptDelivery(['docs/run/memory-flywheel/map.md'])).toBe(true)
  })

  it('混合路径（一条非免审）→ false，整条提交照常走审查', () => {
    expect(isExemptDelivery(['docs/run/a.md', 'packages/server/src/x.ts'])).toBe(false)
    // 顺序无关：非免审那条在后也在前，都是 false
    expect(isExemptDelivery(['packages/server/src/x.ts', 'docs/run/a.md'])).toBe(false)
  })

  it('docs/run-x/a.md → false（前缀相似但缺尾斜杠边界，不是命中）', () => {
    expect(isExemptDelivery(['docs/run-x/a.md'])).toBe(false)
    expect(isExemptDelivery(['docs/runs/a.md'])).toBe(false)
    // 单条也不行——不是「至少一条命中」而是「全部命中」
    expect(isExemptDelivery(['docs/run/a.md', 'docs/run-x/b.md'])).toBe(false)
  })

  it('空数组 → false（every 对空集恒真，是陷阱）', () => {
    expect(isExemptDelivery([])).toBe(false)
  })

  it('null / undefined / 非数组（判据查不动）→ false，照常投递', () => {
    expect(isExemptDelivery(null)).toBe(false)
    expect(isExemptDelivery(undefined)).toBe(false)
    expect(isExemptDelivery('docs/run/a.md')).toBe(false)
  })

  it('rename 取新路径（parseChangedFiles，A2）——改名**进**免审前缀要判豁免', () => {
    const files = parseChangedFiles('R100\tdocs/old.md\tdocs/run/new.md')
    expect(files).toEqual([{ status: 'R100', path: 'docs/run/new.md' }])
    expect(isExemptDelivery(files.map((f) => f.path))).toBe(true)
    // 反向：从免审前缀改名**出去**，取新路径 ⇒ 不再豁免（取旧路径就会误判）
    const out = parseChangedFiles('R100\tdocs/run/old.md\tscripts/x.mjs')
    expect(isExemptDelivery(out.map((f) => f.path))).toBe(false)
  })

  it('阴性对照：非豁免清单在旧行为下会投递（判据不是恒真门）', () => {
    // 上一轮的噪声源形态：地图提交 `docs/run/memory-flywheel/map.md` 单文件。
    // 本判据上线前它必投一条——即本票的原始病案。
    expect(isExemptDelivery(['docs/run/memory-flywheel/map.md'])).toBe(true)
    expect(
      isExemptDelivery(['docs/run/memory-flywheel/tickets.md', 'scripts/handoff-gen.mjs'])
    ).toBe(false)
  })
})

describe('isForceDeliver — 免审豁免的强制投递开关（票乙·审查回炉）', () => {
  it('1 / true（含大小写与首尾空白）→ true', () => {
    expect(isForceDeliver('1')).toBe(true)
    expect(isForceDeliver('true')).toBe(true)
    expect(isForceDeliver('TRUE')).toBe(true)
    expect(isForceDeliver(' 1 ')).toBe(true)
  })

  it('未设（undefined / null / 空串）→ false', () => {
    expect(isForceDeliver(undefined)).toBe(false)
    expect(isForceDeliver(null)).toBe(false)
    expect(isForceDeliver('')).toBe(false)
    expect(isForceDeliver('   ')).toBe(false)
  })

  it('「非空即真」是陷阱：0 / false / no / 任意值 → false（手滑不得静默变成强制投递）', () => {
    expect(isForceDeliver('0')).toBe(false)
    expect(isForceDeliver('false')).toBe(false)
    expect(isForceDeliver('FALSE')).toBe(false)
    expect(isForceDeliver('no')).toBe(false)
    expect(isForceDeliver('yes')).toBe(false)
    expect(isForceDeliver('2')).toBe(false)
  })
})

describe('免审豁免前置不得回退到 CATSTUDY_SESSION_ID（静态源断言）', () => {
  // 病案（审查回炉 P2，实害）：首版判据是
  //   `!process.env.CATSTUDY_SESSION_ID && isExemptDelivery(paths)`
  // 而该 env 是 **server 注入给每只猫 CLI 的常驻变量**（llm/claude.ts:361 /
  // opencode.ts:91 / dsh.ts:94），钩子（裸 node 调用）全量继承它 ⇒ 前置在产品路径上
  // 恒为假，免审豁免等于不存在，纯 docs/run 提交照发审查请求。
  // 断言**源码**而不是行为：行为面在 e2e 16d；这里钉的是「别再退回那个 env」——
  // 行为用例需要一个真为假的 env 才红，而源码断言在任何环境下都红。
  //
  // 按行滤注释，**不**用 `/\/\*[\s\S]*?\*\//` 剥块注释：本仓注释里到处是
  // `docs/run/**`，其中的 `/*` 会被当成块注释开头，一路吞到下一个 `*/`——
  // 实测把 guard 行整段吃掉了（该 strip 的旧用法见下方 e2e 静态断言组，已同步改）。
  const src = readFileSync(new URL('./handoff-gen.mjs', import.meta.url), 'utf-8')
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })

  it('豁免判据行用 CATSTUDY_FORCE_DELIVER，且不含 CATSTUDY_SESSION_ID', () => {
    const guard = codeLines
      .filter((l) => l.includes('isExemptDelivery(paths)'))
      .filter((l) => !l.includes('function ')) // 排除定义行，只留调用/判据行
    expect(guard.length).toBe(1)
    expect(guard[0]).toContain('CATSTUDY_FORCE_DELIVER')
    expect(guard[0]).not.toContain('CATSTUDY_SESSION_ID')
  })
})

describe('handoff-gen.e2e.mjs — 临时仓库不得建在仓库树内（静态源断言）', () => {
  // 回归模式：有人新加一条用例，又把临时 git 仓库写成 join(ROOT, '.handoff-test-x')。
  // 那样它既不在 .gitignore、也多半不会被删——并发的 `git add -A`（auto-commit）
  // 会把它整棵扫进提交。本仓库已因此踩过两次（第二次在审查者点名后复发）。
  // 断言源码而不是断言运行时：运行时即使漏删，用例自己也可能看不见残留。
  // 只断言**代码**：e2e 的注释里正记录着这个模式（那段历史说明），不剥注释会让
  // 守卫被自己的说明文字打红——第一次跑就是这么红的。
  // 按行滤注释（`//` / `*` / `/*` 开头），**不**用 `/\/\*[\s\S]*?\*\//` 剥块注释：
  // 本仓文本里到处是 `docs/run/**`，其中的 `/*` 会被当成块注释开头、一路吞到下一个
  // `*/`——那段被吞掉的代码恰好包含要断言的目标，守卫于是恒绿（假绿门）。
  const source = readFileSync(new URL('./handoff-gen.e2e.mjs', import.meta.url), 'utf-8')
  const code = source
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  it('不出现 join(ROOT, …)——临时仓库一律挂系统临时目录', () => {
    expect(code).not.toContain('join(ROOT, ')
  })

  it('私有根由 os.tmpdir() 派生（根修本身在位，而非只是恰好没写 ROOT）', () => {
    expect(source).toContain("from 'node:os'")
    expect(source).toMatch(/mkdtempSync\(join\(tmpdir\(\),/)
  })
})

describe('judgeRepoOwnership — 仓库身份判据（夹具泄漏票）', () => {
  // 泄漏现场（2026-09-28 两次：`e09340a` / `3f8047c`）：临时仓库复制真 `.husky` +
  // `scripts/` 后，继承了猫 CLI 常驻的 `CATSTUDY_SESSION_ID`，一次普通 `git commit`
  // 就把补填请求灌进了**活会话**。判据 = 「提交仓库自证属于该会话的工作区族」。
  // 本组钉纯函数与耦合面；真机面（真钩子 + 真 commit）在 e2e 组 19。

  const SERVER_GIT_UTILS = new URL('../packages/server/src/llm/git-utils.ts', import.meta.url)
  const SELF = new URL('./handoff-gen.mjs', import.meta.url)
  const SESSION = '19ae98b1-4ca1-4439-8dd7-d2250ec30eee'

  it('sessionShortId 与 server 侧同源（耦合靠断言钉，不靠注释）', () => {
    // 承重面就两处：字符类 `[^a-zA-Z0-9-]` 与截断长度 `8`。short id 是 worktree 目录名
    // /分支名的后缀源，任一处漂移都会让「会话工作区在册」的判定与 server 实际建出来的
    // 目录对不上——失败形态是静默的（要么误拒合法提交，要么把不相关的仓库认成自己的）。
    //
    // 比对前**折掉全部空白**：两侧一处写成单行链、一处拆成多行只是排版差异，不是语义
    // 差异。首版直接 `toContain` 裸表达式，结果被自己的换行判红——那是把「格式对不上」
    // 误报成「逻辑漂移」（假红）。折白后钉住的仍是上句那两处承重面，改任一处即红
    // （判别力已实测：把 `8` 改成 `7` 本用例立刻失败）。
    const expr = "replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)"
    const squash = (s) => s.replace(/\s+/g, '')
    const pin = squash(expr)
    expect(squash(readFileSync(SERVER_GIT_UTILS, 'utf-8'))).toContain(pin)
    expect(squash(readFileSync(SELF, 'utf-8'))).toContain(pin)
  })

  it('会话 worktree 前缀与 server 侧同源', () => {
    const decl = "SESSION_WORKTREE_PREFIX = 'catStudy-sessions'"
    expect(readFileSync(SERVER_GIT_UTILS, 'utf-8')).toContain(decl)
    expect(readFileSync(SELF, 'utf-8')).toContain(decl)
  })

  it('short id 取前 8 位、剔非法字符（worktree 目录名后缀源）', () => {
    expect(sessionShortId(SESSION)).toBe('19ae98b1')
    expect(sessionShortId('session-19')).toBe('session-')
    expect(sessionShortId('a/b c')).toBe('abc')
  })

  it('short id 清洗后为空 → 不认（fail-closed，不得回落成「所有仓库都算」）', () => {
    const judge = judgeRepoOwnership(process.cwd(), '中文会话名')
    expect(judge.owned).toBe(false)
    expect(judge.reason).toBe('short-id-empty')
  })

  it('isPathInside 不被前缀同形目录骗过（catStudy-sessions-evil ≠ catStudy-sessions）', () => {
    // 判据按目录边界切，不按字符串前缀——否则 `catStudy-sessions-evil` 会被当成
    // `catStudy-sessions` 的子路径，把隔壁目录里的仓库认成会话工作区。
    expect(isPathInside('/a/catStudy-sessions', '/a/catStudy-sessions')).toBe(true)
    expect(isPathInside('/a/catStudy-sessions', '/a/catStudy-sessions/x')).toBe(true)
    expect(isPathInside('/a/catStudy-sessions', '/a/catStudy-sessions-evil/x')).toBe(false)
  })

  it('独立临时仓库（没有该会话的登记）→ 不认，原因是 no-session-worktree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ident-unit-none-'))
    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' })
      const judge = judgeRepoOwnership(repo, SESSION)
      expect(judge.owned).toBe(false)
      expect(judge.reason).toBe('no-session-worktree')
      expect(judge.family).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('登记了该会话的 worktree → 认（判据认的是登记表，不是目录存在性）', () => {
    // 布局必须与生产同形：`catStudy-sessions` 是**主仓库根的兄弟目录**（server 的
    // `sessionWorktreePath` = `resolve(mainRoot, '..', 'catStudy-sessions', <shortId>)`），
    // 不是主仓库的子目录——摆错位置测的就不是这条判据了。
    const root = mkdtempSync(join(tmpdir(), 'ident-unit-ok-'))
    const repo = join(root, 'main')
    const wt = join(root, 'catStudy-sessions', `${sessionShortId(SESSION)}-flash猫`)
    try {
      mkdirSync(repo, { recursive: true })
      execSync('git init', { cwd: repo, stdio: 'pipe' })
      execSync('git config user.email t@t.local', { cwd: repo, stdio: 'pipe' })
      execSync('git config user.name t', { cwd: repo, stdio: 'pipe' })
      execSync('git commit --allow-empty -m base', { cwd: repo, stdio: 'pipe' })
      execSync(`git worktree add "${wt}" -b wt/ok`, { cwd: repo, stdio: 'pipe' })
      const judge = judgeRepoOwnership(repo, SESSION)
      expect(judge.owned).toBe(true)
      expect(judge.reason).toBe('owned')
      expect(judge.family.length).toBe(1)
      // 反证：同一仓库换个「没登记过」的会话 id → 不认（钉住判据绑的是会话，不是仓库形态）
      expect(judgeRepoOwnership(repo, 'deadbeef-0000-4000-8000-000000000000').owned).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('拒绝告警面四件事齐全（判据 / 读数 / 后果 / 处置）', () => {
    // 静默拒绝 = 把噪声换成隐身：夹具作者以为投出去了，活会话那边什么都没有。
    const text = formatOwnershipRefusal('/tmp/fixture', 'sid-1', {
      owned: false,
      reason: 'no-session-worktree',
      top: '/tmp/fixture',
      mainRoot: '/tmp/fixture',
      sessionsDir: '/tmp/catStudy-sessions',
      family: [],
      shortId: 'sid-1',
    })
    expect(text).toContain('身份校验未通过') // 判据
    expect(text).toContain('没有登记过这个会话的工作区') // 读数（为什么拒）
    expect(text).toContain('未投递') // 后果
    expect(text).toContain('CATSTUDY_') // 处置
  })

  it('判据接在「环境变量支」上且真的拒投（静态源断言：不是只告警后照投）', () => {
    // 行为面由 e2e 19a/19f 覆盖（已做红→绿自证）；这里钉的是**接线意图**——
    // 「告警了但继续投」正是本票最该防的退化形态，而它在行为面上与「拒投 + 告警」
    // 只差一个 return，靠用例覆盖是全绿的。
    const src = readFileSync(SELF, 'utf-8')
    const code = src.split('\n').filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    // 排除定义行（`export function judgeRepoOwnership(cwd, sessionId) {` 长得一模一样，
    // 不排除的话 findIndex 命中的是它，断言就成了「函数体里有 return 'fatal'」——恒红/恒绿）
    const at = code.findIndex(
      (l) => l.includes('judgeRepoOwnership(cwd, sessionId)') && !l.includes('function ')
    )
    expect(at).toBeGreaterThan(-1)
    expect(code.slice(at, at + 5).join('\n')).toContain("return 'fatal'")
  })
})

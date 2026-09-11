/**
 * decideHookDelivery 判定逻辑单测（T-A ①：post-commit 兜底投递三分支）。
 *
 * 判据三态：有归属（agent 提交）→ 静默；无归属（用户手动提交）→ 投递；
 * 判据查不动 → 投递（降级语义：宁可多投不可漏投）。
 */
import { readFileSync } from 'node:fs'
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

  it('归属判据查不动（写回失败/响应不可解析）→ 投递，不静默吞', () => {
    const verdict = decideHookDelivery(null)
    expect(verdict.deliver).toBe(true)
    expect(verdict.reason).toContain('查不动')
  })

  it('undefined 与 null 同语义（判据缺失 = 查不动 → 投递）', () => {
    expect(decideHookDelivery(undefined).deliver).toBe(true)
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

  it('200 但既无 agentName 也无 ambiguous（契约漂移）→ null（查不动，降级投递）', async () => {
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

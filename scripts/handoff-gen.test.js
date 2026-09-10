/**
 * decideHookDelivery 判定逻辑单测（T-A ①：post-commit 兜底投递三分支）。
 *
 * 判据三态：有归属（agent 提交）→ 静默；无归属（用户手动提交）→ 投递；
 * 判据查不动 → 投递（降级语义：宁可多投不可漏投）。
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { decideHookDelivery, parseArgs } from './handoff-gen.mjs'

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

describe('handoff-gen.e2e.mjs — 临时仓库不得建在仓库树内（静态源断言）', () => {
  // 回归模式：有人新加一条用例，又把临时 git 仓库写成 join(ROOT, '.handoff-test-x')。
  // 那样它既不在 .gitignore、也多半不会被删——并发的 `git add -A`（auto-commit）
  // 会把它整棵扫进提交。本仓库已因此踩过两次（第二次在审查者点名后复发）。
  // 断言源码而不是断言运行时：运行时即使漏删，用例自己也可能看不见残留。
  // 只断言**代码**：e2e 的注释里正记录着这个模式（那段历史说明），不剥注释会让
  // 守卫被自己的说明文字打红——第一次跑就是这么红的。
  const source = readFileSync(new URL('./handoff-gen.e2e.mjs', import.meta.url), 'utf-8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('不出现 join(ROOT, …)——临时仓库一律挂系统临时目录', () => {
    expect(code).not.toContain('join(ROOT, ')
  })

  it('私有根由 os.tmpdir() 派生（根修本身在位，而非只是恰好没写 ROOT）', () => {
    expect(source).toContain("from 'node:os'")
    expect(source).toMatch(/mkdtempSync\(join\(tmpdir\(\),/)
  })
})

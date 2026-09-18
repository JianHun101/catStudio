/**
 * 冻结改写器测试（R9 G3 / G5 + R11 三档语义）。
 *
 * **不打真 LLM**：`rewriteRetrievalQueries` 的传输层另有 `complete` 侧测试覆盖；
 * 本文件要验的是「冻结这一步的机器行为」——前置闸、空结果的处置、两跑差集的算法、
 * 环境变量补载的覆盖语义、以及 R11 的**缺省落安全侧**（`dry` 零 LLM 零写盘 /
 * `--write` 才真改写）。
 *
 * 前四组是纯单元（改写器注入假实现）。**末尾三组走 CLI 级** `main()`：跑在一棵
 * **假仓库根**下——根里只有一枚空壳 `env.js`，`query-rewrite.ts` 按需建或不建。
 * 于是「`dry` 档够不着改写器」不靠读代码断言：走岔了会当场 `ERR_MODULE_NOT_FOUND`。
 * 代价是全程零 LLM 调用、零真仓库写入。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_ATTEMPTS,
  ACK_KEY,
  FREEZE_SOURCE,
  loadEnvFile,
  checkRewritePreconditions,
  freezeRewrites,
  diffRewrites,
  unackedEmpties,
  inspectFrozen,
  resolveMode,
  parseArgs,
  main,
} from './freeze-rewrite.mjs'

const ENV_KEYS = ['DS_KEY', 'MEMORY_QUERY_REWRITE_ENABLED']
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const tmpFiles = []
const tmpDirs = []

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  delete globalThis.__freezeProbe
  delete globalThis.__freezeReply
  while (tmpFiles.length > 0) {
    try {
      fs.unlinkSync(tmpFiles.pop())
    } catch {
      /* 已删即忽略 */
    }
  }
  while (tmpDirs.length > 0) {
    try {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
    } catch {
      /* 已删即忽略 */
    }
  }
})

let tmpSeq = 0
function tmpFile(content) {
  const p = path.join(os.tmpdir(), `freeze-rewrite-test-${process.pid}-${++tmpSeq}.env`)
  fs.writeFileSync(p, content, 'utf8')
  tmpFiles.push(p)
  return p
}

const e = (id, over = {}) => ({
  id,
  kind: 'constructed',
  query: `问题 ${id}`,
  rewritten: [],
  expect: [],
  forbid: [],
  answerability: '略',
  ...over,
})

// ─── CLI 级夹具（假仓库根：不碰真仓库、不碰真 LLM） ───────

function tmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${++tmpSeq}-`))
  tmpDirs.push(p)
  return p
}

/**
 * 假仓库根。`main()` 会 import `<root>/packages/server/src/env.js`（worktree 里
 * 该文件本就可能是空壳），故建一枚空的即可。
 *
 * **缺省不建 `query-rewrite.ts`** —— 这是 F1 的硬证法：`dry` 档若走岔到改写器，
 * 会当场 `ERR_MODULE_NOT_FOUND`，而不是静默打真 LLM。`withRewrite` 时才建一枚
 * 假改写器（把 query 记进 `globalThis.__freezeProbe`，供断言调用次数与入参）。
 */
function fakeRoot({ withRewrite = false } = {}) {
  const root = tmpDir('freeze-root')
  fs.mkdirSync(path.join(root, 'packages/server/src/memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/server/src/env.js'), 'export {}\n', 'utf8')
  if (withRewrite) {
    fs.writeFileSync(
      path.join(root, 'packages/server/src/memory/query-rewrite.ts'),
      'export async function rewriteRetrievalQueries(query) {\n' +
        '  globalThis.__freezeProbe.push(query)\n' +
        "  if (globalThis.__freezeReply === 'empty') return []\n" +
        "  return [query + ' 的改写']\n" +
        '}\n',
      'utf8'
    )
  }
  return root
}

/** 写一份黄金集到临时目录，返回其路径 */
function goldenFile(entries, meta = {}) {
  const file = path.join(tmpDir('freeze-data'), 'retrieval-golden.json')
  fs.writeFileSync(file, JSON.stringify({ meta, entries }, null, 2) + '\n', 'utf8')
  return file
}

/** 拦下 stdout / stderr（`main()` 两个通道都写，直接跑会淹测试输出） */
function capture() {
  const out = []
  const err = []
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  const r = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk))
    return true
  })
  return {
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    restore: () => {
      o.mockRestore()
      r.mockRestore()
    },
  }
}

/** 跑一次 `main(argv)` 并连同两个通道的文本一起交回 */
async function runMain(argv) {
  const cap = capture()
  let code
  try {
    code = await main(argv)
  } finally {
    cap.restore()
  }
  return { code, stdout: cap.stdout(), stderr: cap.stderr() }
}

describe('loadEnvFile', () => {
  it('解析 KEY=VALUE、跳过注释空行、去包裹引号', () => {
    const p = tmpFile('# 注释\n\nDS_KEY="abc"\nOTHER=\'x y\'\nNOEQ\n')
    delete process.env.DS_KEY
    delete process.env.OTHER
    const r = loadEnvFile(p)
    expect(process.env.DS_KEY).toBe('abc')
    expect(process.env.OTHER).toBe('x y')
    expect(r.keys).toContain('DS_KEY')
    delete process.env.OTHER
  })

  it('**不覆盖已存在的变量**——命令行给的优先于文件（否则 `DS_KEY=x node …` 被静默顶掉）', () => {
    process.env.DS_KEY = 'from-shell'
    const p = tmpFile('DS_KEY=from-file\n')
    loadEnvFile(p)
    expect(process.env.DS_KEY).toBe('from-shell')
  })
})

describe('checkRewritePreconditions', () => {
  it('开关为 0 ⇒ 不通过，理由点名开关', () => {
    process.env.DS_KEY = 'k'
    process.env.MEMORY_QUERY_REWRITE_ENABLED = '0'
    expect(checkRewritePreconditions()).toMatchObject({ ok: false })
    expect(checkRewritePreconditions().reason).toContain('MEMORY_QUERY_REWRITE_ENABLED')
  })

  it('没配 DS_KEY ⇒ 不通过，理由提示 --env（worktree 内没有 .env 是常态）', () => {
    delete process.env.DS_KEY
    delete process.env.MEMORY_QUERY_REWRITE_ENABLED
    const r = checkRewritePreconditions()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('DS_KEY')
    expect(r.reason).toContain('--env')
  })

  it('两项齐备 ⇒ 通过（缺省即视为开启，与 isQueryRewriteEnabled 同判）', () => {
    process.env.DS_KEY = 'k'
    delete process.env.MEMORY_QUERY_REWRITE_ENABLED
    expect(checkRewritePreconditions()).toEqual({ ok: true })
  })
})

describe('freezeRewrites', () => {
  it('改写结果写进 rewritten，且**不改入参对象**', async () => {
    const input = [e('A'), e('B')]
    const { entries } = await freezeRewrites({
      entries: input,
      rewrite: async (q) => [`${q} 的改写`],
    })
    expect(entries.map((x) => x.rewritten)).toEqual([['问题 A 的改写'], ['问题 B 的改写']])
    expect(input.every((x) => x.rewritten.length === 0)).toBe(true)
  })

  it('空结果**重试到上限**：首跑空、次跑有 ⇒ 不算空（滤抖动）', async () => {
    let n = 0
    const { entries, empty } = await freezeRewrites({
      entries: [e('A')],
      rewrite: async () => (++n === 1 ? [] : ['第二次成了']),
    })
    expect(entries[0].rewritten).toEqual(['第二次成了'])
    expect(empty).toEqual([])
    expect(n).toBe(2)
  })

  it('持续空 ⇒ 进 empty 清单，且 **rewritten 保持空数组、不拿原 query 冒充**', async () => {
    const { entries, empty } = await freezeRewrites({
      entries: [e('A', { query: '原话' })],
      rewrite: async () => [],
    })
    expect(empty).toEqual(['A'])
    expect(entries[0].rewritten).toEqual([])
    expect(entries[0].rewritten).not.toContain('原话')
  })

  it('空串 / 纯空白 / 非字符串被滤掉（它们进集会让「有改写」变成假话）', async () => {
    const { entries } = await freezeRewrites({
      entries: [e('A')],
      rewrite: async () => ['', '  ', null, '有效'],
    })
    expect(entries[0].rewritten).toEqual(['有效'])
  })

  it('--only 只跑点名条目，其余原样保留并记进 reused', async () => {
    const { entries, reused } = await freezeRewrites({
      entries: [e('A', { rewritten: ['旧的'] }), e('B', { rewritten: ['旧的'] })],
      rewrite: async () => ['新的'],
      only: ['B'],
    })
    expect(reused).toEqual(['A'])
    expect(entries.find((x) => x.id === 'A').rewritten).toEqual(['旧的'])
    expect(entries.find((x) => x.id === 'B').rewritten).toEqual(['新的'])
  })

  it('attempts=1 ⇒ 不重试（空即空）', async () => {
    let n = 0
    await freezeRewrites({
      entries: [e('A')],
      rewrite: async () => (++n === 1 ? [] : ['x']),
      attempts: 1,
    })
    expect(n).toBe(1)
  })
})

describe('diffRewrites — G3 两跑差集', () => {
  it('完全一致 ⇒ 无差集', () => {
    const before = [e('A', { rewritten: ['x', 'y'] })]
    const after = [e('A', { rewritten: ['x', 'y'] })]
    expect(diffRewrites({ before, after })).toEqual({ changed: [], empty: [] })
  })

  it('文本不同 ⇒ 进 changed（**如实报，不掩盖 LLM 波动**）', () => {
    const { changed } = diffRewrites({
      before: [e('A', { rewritten: ['x'] })],
      after: [e('A', { rewritten: ['x 改了'] })],
    })
    expect(changed).toEqual([{ id: 'A', before: ['x'], after: ['x 改了'] }])
  })

  it('条数不同 ⇒ 进 changed（多一路/少一路都是差集）', () => {
    const { changed } = diffRewrites({
      before: [e('A', { rewritten: ['x'] })],
      after: [e('A', { rewritten: ['x', 'z'] })],
    })
    expect(changed).toHaveLength(1)
  })

  it('本次为空 ⇒ 进 empty 而非 changed（两副药方：一个要重跑，一个要接受波动）', () => {
    const { changed, empty } = diffRewrites({
      before: [e('A', { rewritten: ['x'] })],
      after: [e('A', { rewritten: [] })],
    })
    expect(changed).toEqual([])
    expect(empty).toEqual(['A'])
  })
})

describe('unackedEmpties — 人工确认位', () => {
  it('未列进 meta 的空条目 ⇒ 全部算未确认', () => {
    expect(unackedEmpties(['G02'], undefined)).toEqual(['G02'])
  })

  it('已列进 meta.emptiesAcknowledged 的空条目 ⇒ 归零（判定权归人）', () => {
    expect(unackedEmpties(['G02', 'C09'], ['G02'])).toEqual(['C09'])
  })

  it('确认位不是数组/含非字符串 ⇒ 不炸，按「未确认」处理（向严）', () => {
    expect(unackedEmpties(['G02'], 'G02')).toEqual(['G02'])
    expect(unackedEmpties(['G02'], [1, null, 'G02'])).toEqual([])
  })
})

describe('parseArgs', () => {
  it('缺省全空、--check / --write 是布尔、--only 逗号切分', () => {
    expect(parseArgs([])).toMatchObject({
      file: null,
      env: null,
      check: false,
      write: false,
      only: null,
    })
    expect(parseArgs(['--check', '--only', 'G01, G02', '--env', 'x.env'])).toMatchObject({
      check: true,
      write: false,
      only: ['G01', 'G02'],
      env: 'x.env',
    })
    // 两个开关都能被解析出来（互斥由 resolveMode 判，不在解析层静默吃掉一个）
    expect(parseArgs(['--write'])).toMatchObject({ write: true, check: false })
  })

  it('契约常量可被外部断言（确认位键名与来源串是文档的一部分）', () => {
    expect(ACK_KEY).toBe('emptiesAcknowledged')
    expect(FREEZE_SOURCE).toContain('rewriteRetrievalQueries')
    expect(DEFAULT_ATTEMPTS).toBe(2)
  })
})

describe('resolveMode — 三档判定（R11）', () => {
  it('裸跑 ⇒ dry：**缺省落安全侧**，不是旧版的「真改写 + 写回」', () => {
    expect(resolveMode({ check: false, write: false })).toBe('dry')
  })

  it('--check ⇒ check（打 LLM 但不写盘）、--write ⇒ write', () => {
    expect(resolveMode({ check: true, write: false })).toBe('check')
    expect(resolveMode({ check: false, write: true })).toBe('write')
  })

  it('--check 与 --write 同给 ⇒ null（用法错，由调用方落 exit 2）', () => {
    expect(resolveMode({ check: true, write: true })).toBeNull()
  })
})

describe('inspectFrozen — dry 档的只读体检', () => {
  it('数出已冻结 / 空条目，空条目再按人工确认位分出未确认', () => {
    const r = inspectFrozen({
      entries: [e('A', { rewritten: ['x'] }), e('B'), e('C')],
      acked: ['B'],
    })
    expect(r).toEqual({
      total: 3,
      frozen: 1,
      empty: ['B', 'C'],
      unacked: ['C'],
      wouldRewrite: 3,
    })
  })

  it('--only 只影响 wouldRewrite（体检面始终是全量，否则报出来的状态是残的）', () => {
    const r = inspectFrozen({ entries: [e('A'), e('B')], only: ['B'], acked: [] })
    expect(r.total).toBe(2)
    expect(r.empty).toEqual(['A', 'B'])
    expect(r.wouldRewrite).toBe(1)
  })
})

describe('main — F1 裸跑 = 只读体检（零 LLM、零写盘）', () => {
  it('假 root 里**没有** query-rewrite.ts 也照样跑通（走岔到改写器会 ERR_MODULE_NOT_FOUND）', async () => {
    const root = fakeRoot()
    const file = goldenFile([e('A', { rewritten: ['x'] }), e('B', { rewritten: ['y'] })])
    const before = fs.readFileSync(file, 'utf8')

    const { code, stdout } = await runMain(['--root', root, '--file', file])

    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      mode: 'dry',
      llmCalls: 0,
      wrote: false,
      total: 2,
      frozen: 2,
      empty: [],
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('空改写未确认 ⇒ exit 1 且**仍然不写盘**（体检不改状态，只报状态）', async () => {
    const root = fakeRoot()
    const file = goldenFile([e('A', { rewritten: ['x'] }), e('B')], { emptiesAcknowledged: [] })
    const before = fs.readFileSync(file, 'utf8')

    const { code, stdout, stderr } = await runMain(['--root', root, '--file', file])

    expect(code).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, mode: 'dry', unacked: ['B'] })
    expect(stderr).toContain('B')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('空改写已确认 ⇒ exit 0（确认位归零的语义在三档下一致）', async () => {
    const root = fakeRoot()
    const file = goldenFile([e('A'), e('B')], { emptiesAcknowledged: ['A', 'B'] })

    const { code, stdout } = await runMain(['--root', root, '--file', file])

    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, unacked: [], empty: ['A', 'B'] })
  })

  it('前置闸对 dry **只是体检项**：DS_KEY 缺失 + 开关为 0 也不拦（它压根不改写）', async () => {
    delete process.env.DS_KEY
    process.env.MEMORY_QUERY_REWRITE_ENABLED = '0'
    const root = fakeRoot()
    const file = goldenFile([e('A', { rewritten: ['x'] })])

    const { code, stdout } = await runMain(['--root', root, '--file', file])

    expect(code).toBe(0)
    expect(JSON.parse(stdout).precondition).toMatchObject({ ok: false })
  })
})

describe('main — 用法闸', () => {
  it('--check 与 --write 同给 ⇒ exit 2，且在读盘 / 前置闸之前就挡下', async () => {
    const { code, stderr } = await runMain(['--check', '--write'])

    expect(code).toBe(2)
    expect(stderr).toContain('互斥')
  })
})

describe('main — F2 --write = 真改写 + 写回（旧缺省行为，一字不差地保留）', () => {
  it('--write 调改写器、写回 rewritten；meta 原样透传（**机器永不自写确认位**）', async () => {
    process.env.DS_KEY = 'k'
    globalThis.__freezeProbe = []
    const root = fakeRoot({ withRewrite: true })
    const file = goldenFile([e('A'), e('B')], { note: '原样保留' })

    const { code, stdout } = await runMain(['--write', '--root', root, '--file', file])

    expect(code).toBe(0)
    expect(globalThis.__freezeProbe).toEqual(['问题 A', '问题 B'])
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, mode: 'write', frozen: 2, empty: [] })

    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written.entries.map((x) => x.rewritten)).toEqual([['问题 A 的改写'], ['问题 B 的改写']])
    expect(written.meta).toEqual({ note: '原样保留' })
    expect(written.meta[ACK_KEY]).toBeUndefined()
  })

  it('改写全空 ⇒ 写回的是**空数组**（不拿原 query 冒充）、exit 1、确认位仍不由机器写', async () => {
    process.env.DS_KEY = 'k'
    globalThis.__freezeProbe = []
    globalThis.__freezeReply = 'empty'
    const root = fakeRoot({ withRewrite: true })
    const file = goldenFile([e('A')], { note: '原样保留' })

    const { code, stdout } = await runMain(['--write', '--root', root, '--file', file])

    expect(code).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      mode: 'write',
      empty: ['A'],
      unacked: ['A'],
    })

    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written.entries[0].rewritten).toEqual([])
    expect(written.entries[0].rewritten).not.toContain('问题 A')
    expect(written.meta).toEqual({ note: '原样保留' })
  })

  it('前置闸未过 ⇒ exit 2 且**不写盘**（--write 才吃这道硬闸）', async () => {
    delete process.env.DS_KEY
    const root = fakeRoot({ withRewrite: true })
    const file = goldenFile([e('A')], { note: '原样保留' })
    const before = fs.readFileSync(file, 'utf8')

    const { code, stdout } = await runMain(['--write', '--root', root, '--file', file])

    expect(code).toBe(2)
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, phase: 'precondition' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

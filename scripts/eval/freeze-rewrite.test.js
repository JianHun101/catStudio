/**
 * 冻结改写器测试（R9 G3 / G5）。
 *
 * **不打真 LLM**：`rewriteRetrievalQueries` 的传输层另有 `complete` 侧测试覆盖；
 * 本文件要验的是「冻结这一步的机器行为」——前置闸、空结果的处置、两跑差集的算法、
 * 环境变量补载的覆盖语义。
 *
 * 全部是纯单元：改写器是注入的假实现，`.env` 用 tempfile，env 变量改完即还原。
 */
import { describe, it, expect, afterEach } from 'vitest'
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
  parseArgs,
} from './freeze-rewrite.mjs'

const ENV_KEYS = ['DS_KEY', 'MEMORY_QUERY_REWRITE_ENABLED']
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const tmpFiles = []

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  while (tmpFiles.length > 0) {
    try {
      fs.unlinkSync(tmpFiles.pop())
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
  it('缺省全空、--check 是布尔、--only 逗号切分', () => {
    expect(parseArgs([])).toMatchObject({ file: null, env: null, check: false, only: null })
    expect(parseArgs(['--check', '--only', 'G01, G02', '--env', 'x.env'])).toMatchObject({
      check: true,
      only: ['G01', 'G02'],
      env: 'x.env',
    })
  })

  it('契约常量可被外部断言（确认位键名与来源串是文档的一部分）', () => {
    expect(ACK_KEY).toBe('emptiesAcknowledged')
    expect(FREEZE_SOURCE).toContain('rewriteRetrievalQueries')
    expect(DEFAULT_ATTEMPTS).toBe(2)
  })
})

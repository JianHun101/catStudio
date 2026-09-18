/**
 * 检索黄金集校验器测试（R9 G2 / G5）。
 *
 * 测试面刻意分两层：
 *   - **纯单元**：`validateGoldenSet` / `checkGoldenSet` 喂手搓对象——判据面窄、可穷举；
 *   - **真语料**：拿**仓内真身** `docs/eval/retrieval-golden.json` 过一遍**真切片器**
 *     （`scripts/flywheel/scan.mjs` + `memory/flywheel/segment.ts`）。这一层是黄金集
 *     真正的保鲜门：语料哪天改了名，这条测试先红，而不是等 R10 跑批时才发现标尺烂了。
 *
 * 真空性反对照（G2 明文要求「故意改坏一条锚点 ⇒ 必须报腐烂且退出非零」）做成
 * **内存内变异**——不落盘、不改真身，避免测试自己污染被测物件。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GOLDEN_KINDS,
  GOLDEN_SCHEMA_VERSION,
  validateGoldenSet,
  buildLiveAnchorIndex,
  checkGoldenSet,
  summaryLine,
} from './golden-check.mjs'

import { collectCandidatePaths, classifyDocument } from '../flywheel/scan.mjs'
import { segmentDocument } from '../../packages/server/src/memory/flywheel/segment.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GOLDEN_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'retrieval-golden.json')

/** 仓内真身（只读一次，多个用例共用） */
const goldenRaw = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'))

/** 最小合法条目工厂——每个用例只破坏它关心的那一个字段 */
function entry(over = {}) {
  return {
    id: 'X01',
    kind: 'constructed',
    query: '问题？',
    rewritten: ['改写一'],
    expect: [
      {
        doc_path: 'docs/adr/0007-external-tool-form-selection-checklist.md',
        section_anchor: '检查单（四条，对治拍板链四环）',
      },
    ],
    forbid: [],
    answerability: '答案在该节。',
    ...over,
  }
}

const set = (entries, over = {}) => ({ version: GOLDEN_SCHEMA_VERSION, entries, ...over })

/** 只挑该类错误里含某关键词的（错误类型多，逐个断言全文太脆） */
const errorsMatching = (errors, needle) => errors.filter((e) => e.includes(needle))

describe('validateGoldenSet — schema', () => {
  it('仓内真身过校验，且条目数/分型与 meta.counts 一致', () => {
    const r = validateGoldenSet(goldenRaw)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(goldenRaw.entries).toHaveLength(40)
    expect(r.byKind).toEqual(goldenRaw.meta.counts)
    expect(Object.keys(r.byKind).sort()).toEqual([...GOLDEN_KINDS].sort())
  })

  it('version 不是 1 ⇒ 报错（值域钉死，防静默兼容未知格式）', () => {
    const r = validateGoldenSet(set([entry()], { version: 2 }))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, 'version 必须是 1')).toHaveLength(1)
  })

  it('顶层缺 entries ⇒ 报错且不继续（没有可校验的对象）', () => {
    const r = validateGoldenSet({ version: 1 })
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '顶层缺字段 `entries`')).toHaveLength(1)
  })

  it('id 重复 ⇒ 报错（id 是「重排不变」的引用键，重复即引用歧义）', () => {
    const r = validateGoldenSet(set([entry(), entry()]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, 'id 重复：X01')).toHaveLength(1)
  })

  it('kind 出值域 ⇒ 报错', () => {
    const r = validateGoldenSet(set([entry({ kind: 'made-up' })]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.kind 必须是')).toHaveLength(1)
  })

  it('negative 的 forbid 为空 ⇒ 报错（该型的定义就是「禁止命中」）', () => {
    const r = validateGoldenSet(set([entry({ kind: 'negative', expect: [], forbid: [] })]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.forbid 不得为空')).toHaveLength(1)
  })

  it('negative 允许 expect 为空（只钉禁止面）', () => {
    const r = validateGoldenSet(
      set([entry({ kind: 'negative', expect: [], forbid: [entry().expect[0]] })])
    )
    expect(r.errors).toEqual([])
  })

  it('非 negative 的 expect 为空 ⇒ 报错', () => {
    const r = validateGoldenSet(set([entry({ expect: [] })]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.expect 不得为空')).toHaveLength(1)
  })

  it('real 缺 evidence ⇒ 报错（G1：真实条目带六标准理由与行 id 证据）', () => {
    const r = validateGoldenSet(set([entry({ kind: 'real' })]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.evidence 是 real 条目必填')).toHaveLength(1)
  })

  it('real 的 evidence.retrieval_query_id 非数字 ⇒ 报错', () => {
    const r = validateGoldenSet(
      set([entry({ kind: 'real', evidence: { retrieval_query_id: '112', rationale: '理由' } })])
    )
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, 'retrieval_query_id 必须是有限数字')).toHaveLength(1)
  })

  it('real 的 evidence.rationale 空缺 ⇒ 报错', () => {
    const r = validateGoldenSet(
      set([entry({ kind: 'real', evidence: { retrieval_query_id: 112, rationale: '  ' } })])
    )
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, 'rationale 必须是非空字符串')).toHaveLength(1)
  })

  it('锚点缺 section_anchor ⇒ 报错（节粒度是 D1 的契约，缺一维退化成整篇）', () => {
    const bad = entry({
      expect: [{ doc_path: 'docs/adr/0007-external-tool-form-selection-checklist.md' }],
    })
    const r = validateGoldenSet(set([bad]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.section_anchor 必须是非空字符串')).toHaveLength(1)
  })

  it('rewritten 不是数组 ⇒ 报错；是空数组 ⇒ 合法（空 = 无冻下来的改写）', () => {
    expect(validateGoldenSet(set([entry({ rewritten: 'x' })])).ok).toBe(false)
    expect(validateGoldenSet(set([entry({ rewritten: [] })])).errors).toEqual([])
  })

  it('answerability 空缺 ⇒ 报错（可答性闸必须留痕）', () => {
    const r = validateGoldenSet(set([entry({ answerability: '' })]))
    expect(r.ok).toBe(false)
    expect(errorsMatching(r.errors, '.answerability 必须是非空字符串')).toHaveLength(1)
  })

  it('错误**全量**返回不短路（一次修完，不挤牙膏）', () => {
    const r = validateGoldenSet(set([entry({ kind: 'bad', query: '', answerability: '' })]))
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('checkGoldenSet — 锚点存在性（含真空性反对照）', () => {
  const index = () =>
    buildLiveAnchorIndex({
      root: REPO_ROOT,
      scanMod: { collectCandidatePaths, classifyDocument },
      segment: segmentDocument,
    })

  it('仓内真身 45 个锚点全部解析到活块；白名单内过不了准入的文件进 skippedDocs', () => {
    const idx = index()
    const { rotten, checked } = checkGoldenSet({ data: goldenRaw, index: idx })

    expect(rotten).toEqual([])
    expect(checked).toBe(45)
    // 白名单文件里过不了准入的（无 frontmatter 的老 ADR / 非结晶态 plans）——不是活块，
    // 但要让调用方能把「锚点指着准入不过的文件」与「锚点拼错」分开
    const skipped = new Set(idx.skipped.map((s) => s.path))
    expect(skipped.has('docs/adr/0001-pnpm-monorepo.md')).toBe(true)
    expect(skipped.has('docs/lessons/README.md')).toBe(true)
    expect(idx.skipped.every((s) => typeof s.reason === 'string' && s.reason !== '')).toBe(true)
  })

  it('**真空性反对照**：改坏一条锚点 ⇒ 报该条腐烂，且原因钉在 anchor-not-found', () => {
    const mutated = JSON.parse(JSON.stringify(goldenRaw))
    const victim = mutated.entries.find((e) => e.kind === 'constructed')
    victim.expect[0].section_anchor += '（改坏了）'

    const { rotten } = checkGoldenSet({ data: mutated, index: index() })

    expect(rotten).toHaveLength(1)
    expect(rotten[0]).toMatchObject({
      id: victim.id,
      field: 'expect',
      doc_path: victim.expect[0].doc_path,
      reason: 'anchor-not-found',
    })
  })

  it('真空性反对照（另一极）：真身**不**变异时上述断言不成立——否则红点恒红、判据无效', () => {
    const { rotten } = checkGoldenSet({ data: goldenRaw, index: index() })
    expect(rotten).toHaveLength(0)
  })

  it('doc_path 指向不存在的文件 ⇒ 原因钉在 doc-not-live（与拼错锚点是两副药方）', () => {
    const mutated = JSON.parse(JSON.stringify(goldenRaw))
    mutated.entries[0].expect[0].doc_path = 'docs/adr/9999-not-exist.md'
    const { rotten } = checkGoldenSet({ data: mutated, index: index() })
    expect(rotten).toHaveLength(1)
    expect(rotten[0].reason).toBe('doc-not-live')
  })

  it('forbid 面同样受检（负例的禁止锚点烂了，整条负例失去意义）', () => {
    const mutated = JSON.parse(JSON.stringify(goldenRaw))
    const neg = mutated.entries.find((e) => e.kind === 'negative')
    neg.forbid[0].section_anchor = '不存在的节'
    const { rotten } = checkGoldenSet({ data: mutated, index: index() })
    expect(rotten).toHaveLength(1)
    expect(rotten[0].field).toBe('forbid')
  })
})

describe('summaryLine', () => {
  it('全绿与腐烂两种形态都可读，且腐烂时点名', () => {
    const ok = summaryLine({
      entries: 40,
      byKind: { real: 12, constructed: 23, negative: 5 },
      checked: 45,
      rotten: [],
    })
    expect(ok).toContain('entries=40')
    expect(ok).toContain('real=12')
    expect(ok).toContain('rotten=0')
    expect(ok).not.toContain('标尺腐烂')

    const bad = summaryLine({ entries: 40, byKind: {}, checked: 45, rotten: [{ id: 'C07' }] })
    expect(bad).toContain('rotten=1')
    expect(bad).toContain('标尺腐烂')
  })
})

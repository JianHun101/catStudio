import { describe, expect, it } from 'vitest'
import { summarizeSkippedByReason, UNKNOWN_REASON } from './scan-report.js'

/** 飞轮跳过面收敛 B：跳过明细按 reason 归桶（两类跳过必须可分） */

/** 构造 n 条同 reason 的跳过项——真实报告里这 n 条是 n 个 path */
function repeat(reason: string, n: number): Array<{ path: string; reason: string }> {
  return Array.from({ length: n }, (_, i) => ({ path: `docs/adr/${i}.md`, reason }))
}

/**
 * **退化实现（反面样本）**：只报总数、不分类——正是本票要防的那种写法。
 *
 * 它存在的唯一目的是让下一条用例能断言「真实实现 ≠ 这个」。删掉它，那条断言就退化
 * 成同义反复；留着它，「分列」这件事才有个具体的反面可对照。
 */
function degenerateSingleBucket(skipped: unknown): Record<string, number> {
  return Array.isArray(skipped) ? { skipped: skipped.length } : {}
}

describe('summarizeSkippedByReason · 核心验收：两类跳过分列', () => {
  // 真实现场形状：本实例报告 scanned:21 / skipped:21，其中 20 件 unchanged、1 件 empty-evidence。
  // 归桶前这两类在 `skipped: 21` 这一个数上**同形**，读日志分不出「全健康」还是「有缺口」。
  const report = [...repeat('unchanged', 20), { path: 'docs/plans/x.md', reason: 'empty-evidence' }]

  it('unchanged（正常增量）与 empty-evidence（真缺口）各自成桶，计数正确', () => {
    const out = summarizeSkippedByReason(report)
    expect(out).toEqual({ unchanged: 20, 'empty-evidence': 1 })
    // 反向否定：总数与分项同时可读，没有一个桶把另一类吞掉
    expect(out.unchanged).not.toBe(report.length)
    expect(out['empty-evidence']).not.toBe(report.length)
  })

  it('反对照：退化成「只报总数」的实现与本实现不等价', () => {
    // 若把实现改成 `{ skipped: n }` 这类单桶写法，本断言必红——这是「分列」的哨兵。
    expect(summarizeSkippedByReason(report)).not.toEqual(degenerateSingleBucket(report))
    // 且桶数必须等于**不同 reason 的种数**（2），不是 1——退化成单桶时这条也会红。
    expect(Object.keys(summarizeSkippedByReason(report))).toHaveLength(2)
  })

  it('桶序 = reason 首次出现顺序（读日志时与报告本身可逐行对照）', () => {
    const out = summarizeSkippedByReason([
      { reason: 'empty-evidence' },
      { reason: 'unchanged' },
      { reason: 'empty-evidence' },
    ])
    expect(Object.keys(out)).toEqual(['empty-evidence', 'unchanged'])
    expect(out).toEqual({ 'empty-evidence': 2, unchanged: 1 })
  })
})

describe('summarizeSkippedByReason · 不静默丢（对应 scan.mjs 契约④）', () => {
  it('reason 缺失 ⇒ 归 <unknown> 桶，而不是被丢弃', () => {
    const out = summarizeSkippedByReason([{ path: 'a.md' }])
    expect(out).toEqual({ [UNKNOWN_REASON]: 1 })
  })

  it('reason 非字符串（数字 / null / 对象 / 布尔）⇒ 全部归 <unknown>', () => {
    const out = summarizeSkippedByReason([
      { reason: 42 },
      { reason: null },
      { reason: { why: 'x' } },
      { reason: true },
    ])
    expect(out).toEqual({ [UNKNOWN_REASON]: 4 })
  })

  it('reason 为空串 / 纯空白 ⇒ 归 <unknown>（空串当键会让日志出现无名字段）', () => {
    const out = summarizeSkippedByReason([{ reason: '' }, { reason: '   ' }])
    expect(out).toEqual({ [UNKNOWN_REASON]: 2 })
    expect(Object.keys(out)).not.toContain('')
  })

  it('元素本身是 null / undefined / 原始值 ⇒ 归 <unknown>，不抛', () => {
    const out = summarizeSkippedByReason([null, undefined, 'x', 7])
    expect(out).toEqual({ [UNKNOWN_REASON]: 4 })
  })

  it('真实 reason 与 <unknown> 同现时各归各桶，互不吞噬', () => {
    const out = summarizeSkippedByReason([
      { reason: 'unchanged' },
      { path: 'b.md' },
      { reason: 'unchanged' },
    ])
    expect(out).toEqual({ unchanged: 2, [UNKNOWN_REASON]: 1 })
  })
})

describe('summarizeSkippedByReason · 入参不受信与边界', () => {
  it('非数组入参一律空桶且不抛（parseScanReport 返回 any，报告可能畸形）', () => {
    for (const bad of [undefined, null, 'unchanged', 42, { reason: 'x' }, true]) {
      expect(() => summarizeSkippedByReason(bad)).not.toThrow()
      expect(summarizeSkippedByReason(bad)).toEqual({})
    }
  })

  it('空数组 ⇒ 空桶（无跳过 = 全部进索引，不该伪造出桶）', () => {
    expect(summarizeSkippedByReason([])).toEqual({})
    expect(Object.keys(summarizeSkippedByReason([]))).toHaveLength(0)
  })

  it('reason 为 `__proto__` 时是真桶，不是原型污染', () => {
    // 普通对象上 `obj['__proto__'] = n` 走的是原型设置器 ⇒ 这条计数会被静默吃掉。
    // 空原型对象下它才是一条普通属性。
    const out = summarizeSkippedByReason([{ reason: '__proto__' }, { reason: '__proto__' }])
    expect(out['__proto__']).toBe(2)
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(Object.keys(out)).toEqual(['__proto__'])
  })
})

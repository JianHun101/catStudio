/**
 * utils/diff — unified diff 行级解析器测试。
 *
 * 输入是服务端 git show --unified=3 --no-color 输出的文件级 diff
 * （含 ---/+++ 路径行与 @@ hunk 头，不含 diff --git 头）。
 */

import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, DIFF_TRUNCATED_MARKER } from './diff'

const SAMPLE = `--- a/packages/server/src/x.ts
+++ b/packages/server/src/x.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 22
+const c = 3
 const d = 4`

describe('parseUnifiedDiff', () => {
  it('解析增删行并推进行号', () => {
    const lines = parseUnifiedDiff(SAMPLE)
    // meta(2) + hunk(1) + context(1) + del(1) + add(2) + context(1) = 8
    expect(lines).toHaveLength(8)

    // hunk 头：起始行号
    expect(lines[2]).toMatchObject({ type: 'hunk', text: '@@ -1,3 +1,4 @@' })

    // context 行：新旧行号同时推进（旧 1/新 1）
    expect(lines[3]).toMatchObject({
      type: 'context',
      oldLine: 1,
      newLine: 1,
      text: ' const a = 1',
    })

    // 删除行：只有旧行号（新行号 null），旧 2
    expect(lines[4]).toMatchObject({ type: 'del', oldLine: 2, newLine: null, text: '-const b = 2' })

    // 新增行：只有新行号，新 2
    expect(lines[5]).toMatchObject({
      type: 'add',
      oldLine: null,
      newLine: 2,
      text: '+const b = 22',
    })
    expect(lines[6]).toMatchObject({ type: 'add', oldLine: null, newLine: 3, text: '+const c = 3' })

    // 结尾 context：行号连续推进（旧 3/新 4）
    expect(lines[7]).toMatchObject({
      type: 'context',
      oldLine: 3,
      newLine: 4,
      text: ' const d = 4',
    })
  })

  it('--- / +++ 与 index 行归为 meta', () => {
    const lines = parseUnifiedDiff(`index abc..def 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a`)
    const meta = lines.filter((l) => l.type === 'meta')
    expect(meta.map((m) => m.text)).toEqual(['index abc..def 100644', '--- a/x', '+++ b/x'])
  })

  it('hunk 无逗号计数（单行）解析正确', () => {
    const lines = parseUnifiedDiff('@@ -5 +5 @@\n c5\n')
    expect(lines[0]).toMatchObject({ type: 'hunk' })
    expect(lines[1]).toMatchObject({ type: 'context', oldLine: 5, newLine: 5 })
  })

  it('\\ No newline at end of file 归为 meta', () => {
    const lines = parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n')
    expect(lines[1]).toMatchObject({ type: 'del' })
    expect(lines[2]).toMatchObject({ type: 'meta', text: '\\ No newline at end of file' })
  })

  it('空输入 → 空数组（不崩）', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('   ')).toEqual([])
  })

  it('截断标记常量与服务端契约一致（diff-collector.ts TRUNCATED_MARKER 同值）', () => {
    expect(DIFF_TRUNCATED_MARKER).toBe('[diff 过长已截断]')
  })
})

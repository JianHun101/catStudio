/**
 * Unified diff 行级解析器（零依赖，自研）。
 *
 * 输入：文件级 unified diff 文本——git show --unified=3 --no-color 输出，
 * 不含 `diff --git` 头（服务端已按文件切块），含 `--- a/` / `+++ b/` 路径行
 * 与 `@@ -a,b +c,d @@` hunk 头。
 * 输出：DiffLine[]，按行标注类型（增/删/上下文/hunk 头/元信息）与新旧行号，
 * 供 DiffViewer 行级渲染（绿/红着色）。
 */

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'meta'
  oldLine: number | null
  newLine: number | null
  /** 原始行文本（含前导 +/-/空格，`white-space: pre` 原样渲染） */
  text: string
}

/** 截断标记（与服务端 packages/server/src/git/diff-collector.ts 的 TRUNCATED_MARKER 同值契约） */
export const DIFF_TRUNCATED_MARKER = '[diff 过长已截断]'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** 解析文件级 unified diff 为行列表；空/空白输入 → 空数组 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return []
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(HUNK_RE)
      if (m) {
        oldLine = parseInt(m[1], 10)
        newLine = parseInt(m[3], 10)
      }
      lines.push({ type: 'hunk', oldLine: null, newLine: null, text: raw })
    } else if (
      raw.startsWith('---') ||
      raw.startsWith('+++') ||
      raw.startsWith('index ') ||
      raw.startsWith('\\ ') // "\ No newline at end of file"
    ) {
      lines.push({ type: 'meta', oldLine: null, newLine: null, text: raw })
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'add', oldLine: null, newLine, text: raw })
      newLine++
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'del', oldLine, newLine: null, text: raw })
      oldLine++
    } else {
      lines.push({ type: 'context', oldLine, newLine, text: raw })
      oldLine++
      newLine++
    }
  }
  return lines
}

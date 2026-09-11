/**
 * scripts/lint.js 的静态源断言（scripts 包约定：co-located、同名前缀）。
 *
 * 断言面 = 源码文本 + 模块导出常量，**不起子进程、不跑真类型检查**——真检查是
 * `pnpm lint` 自己的事，这里守的是脚本自身的两条硬要求：
 *   ① 无绝对路径字面值——路径必须相对脚本位置现算，否则换机器/换 worktree 即断；
 *   ② 包清单可解析——PACKAGES 形状合法、目录唯一、覆盖三个包（漏包 = 静默漏检）。
 * 清单覆盖面对齐派活单写死的口径：shared→tsc、server→tsc、web→vue-tsc。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PACKAGES } from './lint.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(__dirname, 'lint.js'), 'utf8')

/** 字符串字面量开头的绝对路径：Windows 盘符（C:\ 或 C:/）或 POSIX 根（/foo）。 */
const ABSOLUTE_LITERAL = /(['"`])(?:[A-Za-z]:[\\/]|\/)[^'"`\n]*\1/g

describe('scripts/lint.js 静态断言', () => {
  it('无绝对路径字面值（换机器/换 worktree 不会断）', () => {
    const hits = [...SOURCE.matchAll(ABSOLUTE_LITERAL)].map((m) => m[0])
    expect(hits).toEqual([])
  })

  it('断言器本身有效（正样本命中 / 负样本不误伤，防恒真绿门）', () => {
    const positives = [String.raw`const a = 'C:\probe'`, `const b = "/probe"`]
    for (const line of positives) {
      expect([...line.matchAll(ABSOLUTE_LITERAL)].length).toBeGreaterThan(0)
    }

    const negatives = [`const c = path.join(ROOT, 'packages')`, 'const d = `[lint] ok`']
    for (const line of negatives) {
      expect([...line.matchAll(ABSOLUTE_LITERAL)]).toEqual([])
    }
  })

  it('包清单可解析且形状合法', () => {
    expect(Array.isArray(PACKAGES)).toBe(true)
    expect(PACKAGES.length).toBeGreaterThan(0)

    for (const pkg of PACKAGES) {
      expect(typeof pkg.dir).toBe('string')
      expect(pkg.dir.startsWith('packages/')).toBe(true)
      expect(typeof pkg.provider).toBe('string')
      expect(typeof pkg.bin).toBe('string')
      expect(Array.isArray(pkg.args)).toBe(true)
      expect(pkg.args.length).toBeGreaterThan(0)
      expect(pkg.args.every((arg) => typeof arg === 'string')).toBe(true)
    }

    // 目录唯一：重复项会让同一个包被检查两遍，同时掩盖某个真正漏配的包
    expect(new Set(PACKAGES.map((p) => p.dir)).size).toBe(PACKAGES.length)
  })

  it('覆盖三个包：shared/server 走 tsc，web 走 vue-tsc', () => {
    expect(PACKAGES.map((p) => `${p.dir}: ${p.bin} ${p.args.join(' ')}`)).toEqual([
      'packages/shared: tsc --noEmit',
      'packages/server: tsc --noEmit',
      'packages/web: vue-tsc --noEmit',
    ])
  })
})

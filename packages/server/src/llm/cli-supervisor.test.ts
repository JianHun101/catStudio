/**
 * `cli-supervisor.mjs` 静态源断言（票①）。
 *
 * **为什么是静态源断言而不是行为测试**：该文件是纯 .mjs，**导入即执行**——顶层的
 * argv 解析、`spawn(command, ...)`、`setInterval` 轮询在 import 那刻就跑起来
 * （会真起子进程、真挂轮询），故无法 import 进来做行为断言；而它是票① 改动面里
 * 唯一没有测试文件的模块，判据错了没有任何信号。
 *
 * **能证明什么**：判据与平台分派这两处**写法**没被改回旧语义。
 * **不能证明什么**：运行时真的走这个分支、真的杀得掉进程树——那由
 * `cli-utils.test.ts` 的 `terminateChild` 行为用例覆盖（两边是同款语义的两份实现，
 * 本文件只保证 .mjs 这一份不漂移，不重复证明语义本身）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./cli-supervisor.mjs', import.meta.url)), 'utf8')

describe('cli-supervisor.mjs 静态源断言（票①：判据 + 平台分派）', () => {
  it('存活判据不含旧谓词（`killed` 是「信号已发出」而非「进程已死」）', () => {
    // 旧谓词字面量：`killed` 在 kill() 成功那刻即置 true ⇒ 宽限期后的升级判断恒假
    expect(SRC).not.toContain('!child.killed')
    // 新谓词：双 null 才算还活着（两个字段都要在判据里）
    expect(SRC).toContain('child.exitCode !== null || child.signalCode !== null')
    expect(SRC).toContain('child.exitCode === null && child.signalCode === null')
  })

  it('win32 走 `taskkill` 树杀（/pid /t /f，shell:false）', () => {
    expect(SRC).toContain("process.platform === 'win32'")
    expect(SRC).toContain('taskkill')
    expect(SRC).toContain("'/t'")
    expect(SRC).toContain("'/f'")
    expect(SRC).toContain('shell: false')
  })

  it('POSIX 保留 SIGTERM → 宽限期 → SIGKILL 升级序列', () => {
    expect(SRC).toContain("child.kill('SIGTERM')")
    expect(SRC).toContain("child.kill('SIGKILL')")
    expect(SRC).toContain('GRACE_MS')
  })
})

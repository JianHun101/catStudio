/**
 * 常量单源守卫。
 *
 * 只钉一条：`PLACEHOLDER_API_KEY` 的**字面量值**——它是与存量数据的契约，
 * 不是可随意改写的内部实现细节。详见 `constants.ts` 注释。
 */
import { describe, it, expect } from 'vitest'
import { PLACEHOLDER_API_KEY } from './constants.js'

describe('PLACEHOLDER_API_KEY', () => {
  it('字面量与存量库/历史数据保持一致（改它 = 自愈认不出既有占位符行）', () => {
    // 这条断言看着「只是抄了一遍常量」，但正是它的价值所在：改常量值本身不会
    // 让任何行为用例变红（写入口与守卫读的是同一个常量，自洽），
    // 而**存量库**里躺的是旧字面量——识别失效是静默的。这条把静默变显式。
    expect(PLACEHOLDER_API_KEY).toBe('sk-your-api-key-here')
  })
})

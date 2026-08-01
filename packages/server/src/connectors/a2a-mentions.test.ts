import { describe, it, expect } from 'vitest'
import { parseMentionsFromReply } from './a2a-mentions.js'

const CATS = ['吐槽猫', '店长', 'ds猫', '布偶猫']

describe('parseMentionsFromReply', () => {
  // ─── 行首 @mention ──────────────────────────

  it('匹配行首的 @mention', () => {
    expect(parseMentionsFromReply('@吐槽猫 请 review', CATS)).toEqual(['吐槽猫'])
  })

  it('匹配有前导空格的 @mention', () => {
    expect(parseMentionsFromReply('  @吐槽猫 请 review', CATS)).toEqual(['吐槽猫'])
  })

  it('匹配多个行首 @mention', () => {
    const text = '@店长 你来看看\n@吐槽猫 也看看'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫', '店长'])
  })

  it('只匹配 agentNames 中的名称', () => {
    expect(parseMentionsFromReply('@不存在的猫 hello', CATS)).toEqual([])
  })

  it('匹配文档末尾的交接 @mention', () => {
    const text = `【工作交接】

### 1. What
改了 context filter

### 5. Checklist
- [ ] 逻辑正确
- [ ] 测试覆盖

@吐槽猫 请 review`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 句中的 @mention 不触发 ──────────────────

  it('句中 @mention 不触发', () => {
    expect(parseMentionsFromReply('请 @吐槽猫 review 一下', CATS)).toEqual([])
  })

  it('引用他人话语的 @mention 不触发', () => {
    expect(parseMentionsFromReply('@吐槽猫 说过这个问题需要修', CATS)).toEqual(['吐槽猫'])
    // ^ 这仍然是行首，算作主动喊话（和 Cat Café 设计一致）
  })

  // ─── 代码块剥离 ──────────────────────────────

  it('剥离围栏代码块中的 @mention', () => {
    const text = `@店长 看看这个

\`\`\`typescript
// @吐槽猫 这里需要优化性能
function foo() {}
\`\`\`

代码在文件 src/foo.ts`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['店长'])
  })

  it('剥离无语言标记的代码块中的 @mention', () => {
    const text = `\`\`\`
@吐槽猫
@店长
\`\`\`
@ds猫 你来`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  it('剥离多个代码块中的 @mention', () => {
    const text = `\`\`\`js
// @吐槽猫
\`\`\`
\`\`\`python
# @店长
\`\`\`
@ds猫 帮我看看`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  // ─── 行内代码剥离 ────────────────────────────

  it('剥离行内代码中的 @mention', () => {
    const text = '请参考 `@吐槽猫` 的配置'
    expect(parseMentionsFromReply(text, CATS)).toEqual([])
  })

  it('剥离行内代码但保留外部的 @mention', () => {
    const text = '`@店长` 的配置参考这里\n@吐槽猫 你来 review'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 边界情况 ────────────────────────────────

  it('空内容返回空数组', () => {
    expect(parseMentionsFromReply('', CATS)).toEqual([])
  })

  it('空白内容返回空数组', () => {
    expect(parseMentionsFromReply('   \n  \n  ', CATS)).toEqual([])
  })

  it('排除自己 @ 自己的情况（由调用方处理）', () => {
    // parseMentionsFromReply 不做自己排除，调用方负责 filter
    const result = parseMentionsFromReply('@店长 请 review', CATS)
    expect(result).toContain('店长')
  })

  it('纯代码块内容返回空数组', () => {
    expect(parseMentionsFromReply('```\n@吐槽猫\n@店长\n```', CATS)).toEqual([])
  })

  // ─── 混合场景 ────────────────────────────────

  it('综合场景：代码+注释+文档末尾 @mention', () => {
    const text = `我修改了 filter 逻辑：

\`\`\`typescript
// 新增规则：mentions.includes(agent.name) 时保留
// @吐槽猫 注意：这里不影响广播模式逻辑
if (m.role === 'agent') {
  if (mentions.includes(agent.name)) {
    relevantMessages.push(m)
  }
}
\`\`\`

请参考 \`@店长\` 之前的实现。

@吐槽猫 请 review 以上改动`
    // 只有末尾行首的 @吐槽猫 应该触发
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  it('行内代码紧邻行首 @mention', () => {
    const text = '`some code`\n@吐槽猫 review'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 特殊字符名称 ────────────────────────────

  it('正则特殊字符名称的转义', () => {
    const names = ['猫+狗', 'a.b', 'c*d']
    expect(parseMentionsFromReply('@猫+狗 hello', names)).toEqual(['猫+狗'])
    expect(parseMentionsFromReply('@a.b hello', names)).toEqual(['a.b'])
    expect(parseMentionsFromReply('@c*d hello', names)).toEqual(['c*d'])
  })
})

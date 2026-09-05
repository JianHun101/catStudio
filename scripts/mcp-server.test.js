/**
 * mcp-server 纯函数单测（知识库 Phase 1 测试三层分治之一）。
 *
 * validateSearchParams 抽为可导出纯函数供单测（mcp-server-utils.mjs——
 * mcp-server.mjs 带 shebang，vitest 模块执行器会把它当非法 token）——
 * 工具面本体保持 spike 留档模式（不做 spawn 子进程级测试）；
 * 端点侧由 internal.test.ts 覆盖。
 */
import { describe, it, expect } from 'vitest'
import {
  validateSearchParams,
  validateQueryDbParams,
  validateUserRequestParams,
  validateCreatePrParams,
  validateQuerySessionMessagesParams,
  QUERY_DB_TABLES,
  USER_REQUEST_TYPES,
  SESSION_MESSAGE_KINDS,
} from './mcp-server-utils.mjs'

describe('validateSearchParams (search_knowledge)', () => {
  it('合法入参：仅 query → ok，topK 默认 3', () => {
    const r = validateSearchParams({ query: '提交规范' })
    expect(r).toEqual({ ok: true, query: '提交规范', topK: 3 })
  })

  it('合法入参：query + topK 边界 1 和 10 → ok', () => {
    expect(validateSearchParams({ query: 'x', topK: 1 }).ok).toBe(true)
    expect(validateSearchParams({ query: 'x', topK: 10 }).ok).toBe(true)
    expect(validateSearchParams({ query: 'x', topK: 5 }).topK).toBe(5)
  })

  it('query 前后空白裁剪', () => {
    const r = validateSearchParams({ query: '  提交规范  ' })
    expect(r.query).toBe('提交规范')
  })

  it('空 query → 错误文本（含 reason 可纠正）', () => {
    const r = validateSearchParams({ query: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('query')
    expect(r.reason).toContain('非空字符串')
  })

  it('纯空白 query → 错误文本', () => {
    const r = validateSearchParams({ query: '   ' })
    expect(r.ok).toBe(false)
  })

  it('query 非字符串（数字/数组/缺省）→ 错误文本', () => {
    expect(validateSearchParams({ query: 123 }).ok).toBe(false)
    expect(validateSearchParams({ query: ['x'] }).ok).toBe(false)
    expect(validateSearchParams({}).ok).toBe(false)
    expect(validateSearchParams(undefined).ok).toBe(false)
  })

  it('topK 越界：0 / 11 / 负数 → 错误文本', () => {
    for (const bad of [0, 11, -1]) {
      const r = validateSearchParams({ query: 'x', topK: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('1-10')
    }
  })

  it('topK 非整数（小数/字符串/布尔）→ 错误文本', () => {
    expect(validateSearchParams({ query: 'x', topK: 2.5 }).ok).toBe(false)
    expect(validateSearchParams({ query: 'x', topK: '3' }).ok).toBe(false)
    expect(validateSearchParams({ query: 'x', topK: true }).ok).toBe(false)
  })
})

describe('validateQueryDbParams (query_db)', () => {
  it('合法入参：仅 table → ok，limit 默认 50、conditions 默认 []', () => {
    const r = validateQueryDbParams({ table: 'messages' })
    expect(r).toEqual({ ok: true, table: 'messages', conditions: [], limit: 50 })
  })

  it('合法入参：table + conditions + limit 边界 1 和 100 → ok', () => {
    const conds = [{ column: 'role', op: '=', value: 'user' }]
    expect(validateQueryDbParams({ table: 'messages', conditions: conds, limit: 1 }).ok).toBe(true)
    expect(validateQueryDbParams({ table: 'messages', conditions: conds, limit: 100 }).ok).toBe(
      true
    )
    const r = validateQueryDbParams({ table: 'agents', conditions: conds, limit: 5 })
    expect(r).toEqual({ ok: true, table: 'agents', conditions: conds, limit: 5 })
  })

  it('六张白名单表全部放行', () => {
    for (const t of QUERY_DB_TABLES) {
      expect(validateQueryDbParams({ table: t }).ok).toBe(true)
    }
  })

  it('表名非白名单（sqlite_master/不存在表/非字符串/缺省）→ 错误文本', () => {
    for (const bad of ['sqlite_master', 'users', 123, undefined]) {
      const r = validateQueryDbParams({ table: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('table')
    }
  })

  it('limit 越界：0 / 101 / 负数 → 错误文本', () => {
    for (const bad of [0, 101, -1]) {
      const r = validateQueryDbParams({ table: 'messages', limit: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('1-100')
    }
  })

  it('limit 非整数（小数/字符串/布尔）→ 错误文本', () => {
    expect(validateQueryDbParams({ table: 'messages', limit: 2.5 }).ok).toBe(false)
    expect(validateQueryDbParams({ table: 'messages', limit: '50' }).ok).toBe(false)
    expect(validateQueryDbParams({ table: 'messages', limit: true }).ok).toBe(false)
  })

  it('conditions 非数组 → 错误文本', () => {
    const r = validateQueryDbParams({ table: 'messages', conditions: { column: 'x' } })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('conditions')
  })

  it('condition 缺 column / op 非 =/>/</LIKE / value 非字符串 → 错误文本', () => {
    expect(
      validateQueryDbParams({
        table: 'messages',
        conditions: [{ op: '=', value: 'x' }],
      }).ok
    ).toBe(false)
    expect(
      validateQueryDbParams({
        table: 'messages',
        conditions: [{ column: 'role', op: 'CONTAINS', value: 'x' }],
      }).ok
    ).toBe(false)
    expect(
      validateQueryDbParams({
        table: 'messages',
        conditions: [{ column: 'role', op: '=', value: 123 }],
      }).ok
    ).toBe(false)
  })

  it('注入字符串 value 通过形状校验（参数化在服务端兜底，本层不拦）', () => {
    const r = validateQueryDbParams({
      table: 'messages',
      conditions: [{ column: 'content', op: '=', value: `' OR 1=1 --` }],
    })
    expect(r.ok).toBe(true)
  })
})

describe('validateUserRequestParams (request_user_action)', () => {
  it('合法入参：type + reason → ok，options 默认 []', () => {
    const r = validateUserRequestParams({ type: 'restart', reason: '服务器卡死' })
    expect(r).toEqual({ ok: true, type: 'restart', reason: '服务器卡死', options: [] })
  })

  it('合法入参：choice 枚举过形状校验（服务端 400 兜底"暂不支持"，本层不拦）', () => {
    const r = validateUserRequestParams({ type: 'choice', reason: '选择方案' })
    expect(r.ok).toBe(true)
    expect(r.type).toBe('choice')
  })

  it('合法入参：options 结构正确透传', () => {
    const options = [
      { id: 'a', label: '重启' },
      { id: 'b', label: '等待' },
    ]
    const r = validateUserRequestParams({ type: 'restart', reason: 'x', options })
    expect(r).toEqual({ ok: true, type: 'restart', reason: 'x', options })
  })

  it('reason 前后空白裁剪', () => {
    const r = validateUserRequestParams({ type: 'restart', reason: '  服务器卡死  ' })
    expect(r.reason).toBe('服务器卡死')
  })

  it('type 缺省 / 非枚举（foo/123/undefined）→ 错误文本', () => {
    for (const bad of ['foo', 123, undefined]) {
      const r = validateUserRequestParams({ type: bad, reason: 'x' })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('type')
    }
    expect(validateUserRequestParams({ reason: 'x' }).ok).toBe(false)
  })

  it('reason 缺省 / 空串 / 纯空白 → 错误文本', () => {
    for (const bad of [undefined, '', '   ']) {
      const r = validateUserRequestParams({ type: 'restart', reason: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('reason')
    }
    expect(validateUserRequestParams({ type: 'restart' }).ok).toBe(false)
  })

  it('options 非数组 → 错误文本', () => {
    const r = validateUserRequestParams({ type: 'restart', reason: 'x', options: { id: 'a' } })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('options')
  })

  it('options 每项缺 id/label 或空串 → 错误文本', () => {
    const badCases = [
      [{ label: 'x' }],
      [{ id: 'a' }],
      [{ id: '', label: 'x' }],
      [{ id: 'a', label: '' }],
      ['not-object'],
    ]
    for (const options of badCases) {
      const r = validateUserRequestParams({ type: 'restart', reason: 'x', options })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('options')
    }
  })

  it('枚举常量只含 restart/choice（契约钉死，防误扩）', () => {
    expect(USER_REQUEST_TYPES).toEqual(['restart', 'choice'])
  })
})

describe('validateCreatePrParams (create_pr)', () => {
  it('合法入参：仅 head/title/body → ok，base 默认 undefined（服务端 createPr 兜底 dev）', () => {
    const r = validateCreatePrParams({ head: 'session/abc', title: 'T', body: 'B' })
    expect(r).toEqual({ ok: true, base: undefined, head: 'session/abc', title: 'T', body: 'B' })
  })

  it('合法入参：head/title/body + base 显式 → ok 透传', () => {
    const r = validateCreatePrParams({ base: 'main', head: 'feat-x', title: 'T', body: 'B' })
    expect(r).toEqual({ ok: true, base: 'main', head: 'feat-x', title: 'T', body: 'B' })
  })

  it('head/title/body 前后空白裁剪', () => {
    const r = validateCreatePrParams({ head: '  feat-x  ', title: '  T  ', body: '  B  ' })
    expect(r).toEqual({ ok: true, base: undefined, head: 'feat-x', title: 'T', body: 'B' })
  })

  it('缺 head / 空串 / 纯空白 → 错误文本点名 head', () => {
    for (const bad of [undefined, '', '   ']) {
      const r = validateCreatePrParams({ head: bad, title: 'T', body: 'B' })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('head')
    }
  })

  it('head 非字符串（数字/数组）→ 错误文本', () => {
    expect(validateCreatePrParams({ head: 123, title: 'T', body: 'B' }).ok).toBe(false)
    expect(validateCreatePrParams({ head: ['x'], title: 'T', body: 'B' }).ok).toBe(false)
  })

  it('缺 title / 缺 body → 错误文本点名对应字段', () => {
    expect(validateCreatePrParams({ head: 'x', body: 'B' }).ok).toBe(false)
    const r = validateCreatePrParams({ head: 'x', title: 'T' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('body')
  })

  it('base 非字符串（数字/布尔）→ 错误文本点名 base', () => {
    expect(validateCreatePrParams({ base: 123, head: 'x', title: 'T', body: 'B' }).ok).toBe(false)
    expect(validateCreatePrParams({ base: true, head: 'x', title: 'T', body: 'B' }).ok).toBe(false)
  })

  it('base 空串/纯空白 → 错误文本点名 base（与端点 400 一致，不静默归一）', () => {
    for (const bad of ['', '   ']) {
      const r = validateCreatePrParams({ base: bad, head: 'x', title: 'T', body: 'B' })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('base')
    }
  })

  it('base 缺省 → ok（服务端 createPr 兜底 dev）', () => {
    const r = validateCreatePrParams({ head: 'x', title: 'T', body: 'B' })
    expect(r).toEqual({ ok: true, base: undefined, head: 'x', title: 'T', body: 'B' })
  })
})

describe('validateQuerySessionMessagesParams (query_session_messages)', () => {
  it('合法入参：全空 → ok，limit 默认 20、其余 undefined（服务端走默认）', () => {
    const r = validateQuerySessionMessagesParams({})
    expect(r).toEqual({
      ok: true,
      limit: 20,
      before: undefined,
      from: undefined,
      to: undefined,
      kinds: undefined,
      agentIdFilter: undefined,
    })
  })

  it('合法入参：全部显式传 → ok 透传', () => {
    const r = validateQuerySessionMessagesParams({
      limit: 5,
      before: 'msg-abc',
      from: '2026-09-01T10:00:00Z',
      to: '2026-09-01T12:00:00Z',
      kinds: ['thinking', 'text'],
      agentIdFilter: 'agent-1',
    })
    expect(r).toEqual({
      ok: true,
      limit: 5,
      before: 'msg-abc',
      from: '2026-09-01T10:00:00Z',
      to: '2026-09-01T12:00:00Z',
      kinds: ['thinking', 'text'],
      agentIdFilter: 'agent-1',
    })
  })

  it('limit 边界 1/100 放行，越界（0/101/-1/小数）→ 错误文本', () => {
    expect(validateQuerySessionMessagesParams({ limit: 1 }).ok).toBe(true)
    expect(validateQuerySessionMessagesParams({ limit: 100 }).ok).toBe(true)
    for (const bad of [0, 101, -1, 2.5]) {
      const r = validateQuerySessionMessagesParams({ limit: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('limit')
    }
    expect(validateQuerySessionMessagesParams({ limit: '20' }).ok).toBe(false)
  })

  it('before/from/to/agentIdFilter 非字符串或缺省空串/纯空白 → 错误文本点名', () => {
    for (const [key, bad] of [
      ['before', 123],
      ['from', ['x']],
      ['to', true],
      ['agentIdFilter', ''],
      ['before', '   '],
    ]) {
      const r = validateQuerySessionMessagesParams({ [key]: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain(key)
    }
  })

  it('before 前后空白裁剪（id 游标不可含空白）', () => {
    const r = validateQuerySessionMessagesParams({ before: '  msg-abc  ' })
    expect(r.before).toBe('msg-abc')
  })

  it('kinds 非法（非数组/空数组/含未知 kind/元素非字符串）→ 错误文本', () => {
    for (const bad of ['text', [], ['text', 'image'], [123]]) {
      const r = validateQuerySessionMessagesParams({ kinds: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('kinds')
    }
  })

  it('kinds 三项枚举常量契约钉死（防误扩）', () => {
    expect(SESSION_MESSAGE_KINDS).toEqual(['text', 'thinking', 'tool'])
  })
})

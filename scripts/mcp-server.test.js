/**
 * mcp-server 纯函数单测（知识库 Phase 1 测试三层分治之一）。
 *
 * validate*Params 抽为可导出纯函数供单测（mcp-server-utils.mjs——
 * mcp-server.mjs 带 shebang，vitest 模块执行器会把它当非法 token）——
 * 工具面本体保持 spike 留档模式（不做 spawn 子进程级测试）；
 * 端点侧由 internal.test.ts 覆盖。
 *
 * 工具 2（tools/list schema 瘦身）回归护栏：工具定义元数据集中
 * mcp-server-utils.mjs（MCP_TOOLS = tools/list 真实载荷），本文件直接
 * import 测量 JSON.stringify 体量 + inputSchema 结构冻结基线——放 vitest
 * 不放 hook（钩子断护栏不能跟着断，hooks 根修同思路）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateSearchParams,
  validateQueryDbParams,
  validateUserRequestParams,
  validateCreatePrParams,
  validateQuerySessionMessagesParams,
  validateReadSkillParams,
  QUERY_DB_TABLES,
  USER_REQUEST_TYPES,
  SESSION_MESSAGE_KINDS,
  MCP_TOOLS,
  TOOL_NAME,
  SEARCH_TOOL_NAME,
  QUERY_DB_TOOL_NAME,
  QUERY_SESSION_MESSAGES_TOOL_NAME,
  LIST_SESSION_MEMBERS_TOOL_NAME,
  REQUEST_USER_ACTION_TOOL_NAME,
  CREATE_PR_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  SKILL_CATALOG,
  SKILL_WHITELIST,
  findRepoRoot,
  getSkillsRoot,
  readSkill,
  listSkills,
} from './mcp-server-utils.mjs'
// 服务端权威白名单（query.ts 只 `import type`，无运行期副作用——可直接 import）
import { QUERY_TABLE_SCHEMAS } from '../packages/server/src/db/repository/query.js'

/**
 * 读 `skills/` 下任意仓库源文件（静态源断言用；路径由本文件位置推导，不依赖 cwd）。
 * 只读真实仓库单源 `skills/`，不读测试内快照常量——断言守的必须是技能/模板本体。
 */
/** skills/ 活源根（路径由本文件位置推导，不依赖 cwd） */
const SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

function readSkillsFile(...segments) {
  return readFileSync(resolve(SKILLS_ROOT, ...segments), 'utf8')
}

/** 读技能正文（ADR 0014 §3 零路由不变量守卫用） */
function readSkillDoc(name) {
  return readSkillsFile(name, 'SKILL.md')
}

/** 读仓库内任意文件（本文件在 scripts/，上跳一级即仓库根） */
function readRepoFile(...segments) {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', ...segments), 'utf8')
}

/** 取 `const <name> = \`…\`` 模板字面量的正文；取不到返回 ''（守卫据此判红） */
function templateLiteralOf(source, constName) {
  const anchor = source.indexOf(`const ${constName} = \``)
  if (anchor < 0) return ''
  const bodyStart = source.indexOf('`', anchor) + 1
  const bodyEnd = source.indexOf('`', bodyStart)
  return bodyEnd < 0 ? '' : source.slice(bodyStart, bodyEnd)
}

/**
 * ADR 0014 §3 零路由黑名单（**冒烟守卫**——窄内容黑名单，不是不变量强制）。
 * 本系统路由判据是 `@`；中文短语只挡最常见表述，不保证穷尽（如英文 "Reviewer" 不在此列）。
 */
const ROUTING_PATTERNS = [
  /请谁审查|投给谁/,
  /(请|交给|转给|发给|递给|通知|告知)\s*(审查者|审查猫|吐槽猫|店长)/,
]

/** 深删 description 键（inputSchema 结构冻结对比用——瘦身只允许 description 文案变化） */
function stripDescriptions(v) {
  if (Array.isArray(v)) return v.map(stripDescriptions)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === 'description') continue
      out[k] = stripDescriptions(val)
    }
    return out
  }
  return v
}

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

  it('白名单表全部放行', () => {
    for (const t of QUERY_DB_TABLES) {
      expect(validateQueryDbParams({ table: t }).ok).toBe(true)
    }
  })

  // 表名这一层**不适用**「本层只校形状」——它是服务端 QUERY_TABLE_SCHEMAS 的镜像。
  // 两边漂移 ⇒ 同一张表「MCP 侧 advertised / 服务端明确拒绝」两种结论
  // （`memories` 随段三下线时就漏改过一次）。逐项钉死：改一处必须改三处。
  it('QUERY_DB_TABLES 与服务端 QUERY_TABLE_SCHEMAS 逐项一致', () => {
    expect([...QUERY_DB_TABLES].sort()).toEqual(Object.keys(QUERY_TABLE_SCHEMAS).sort())
  })

  it('query_db 的 tool schema enum 与 QUERY_DB_TABLES 一致', () => {
    const tool = MCP_TOOLS.find((t) => t.name === QUERY_DB_TOOL_NAME)
    expect(tool).toBeDefined()
    expect([...tool.inputSchema.properties.table.enum].sort()).toEqual([...QUERY_DB_TABLES].sort())
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

describe('validateReadSkillParams (read_skill)', () => {
  it('合法入参：清单内 name → ok，trim 后透传', () => {
    const r = validateReadSkillParams({ name: 'quality-gate' })
    expect(r).toEqual({ ok: true, name: 'quality-gate' })
  })

  it('合法入参：白名单内全部技能全放行', () => {
    for (const name of SKILL_WHITELIST) {
      expect(validateReadSkillParams({ name }).ok).toBe(true)
    }
  })

  it('name 前后空白裁剪', () => {
    const r = validateReadSkillParams({ name: '  quality-gate  ' })
    expect(r.name).toBe('quality-gate')
  })

  it('name 缺省 / 空串 / 纯空白 / 非字符串 → 错误文本点名 name', () => {
    for (const bad of [undefined, '', '   ', 123, ['x']]) {
      const r = validateReadSkillParams({ name: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('name')
    }
  })

  it('name 非白名单内（code-review/tdd/prototype/..）→ 错误文本', () => {
    // wayfinder 于 2026-09-15 撤销排除（口径翻转，见下方白名单冻结用例），
    // 故从本反例集移除，改以其他未登记的顶级技能（code-review/prototype）为反例。
    for (const bad of ['code-review', 'tdd', 'prototype', '..', 'a/b', 'QUALITY-GATE']) {
      const r = validateReadSkillParams({ name: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('技能白名单')
    }
  })
})

describe('MCP_TOOLS 工具面（tools/list 常驻载荷——工具 1+2 合成单 + 技能懒加载工具）', () => {
  // 既有六把（瘦身子集护栏用的目标集 = 工具 2 改动前的工具，list_session_members 隔离）
  const SIX_EXISTING = [
    TOOL_NAME,
    SEARCH_TOOL_NAME,
    QUERY_DB_TOOL_NAME,
    QUERY_SESSION_MESSAGES_TOOL_NAME,
    REQUEST_USER_ACTION_TOOL_NAME,
    CREATE_PR_TOOL_NAME,
  ]
  // 工具 2 后的七把（含 list_session_members）——「瘦身净效果」护栏测的集合；
  // read_skill/list_skills 是注入层改造新增（见下方护栏②注释），不混入净效果计量。
  const SLIM_7 = [...SIX_EXISTING, LIST_SESSION_MEMBERS_TOOL_NAME]
  // 注入层改造新增的技能懒加载工具（无「瘦身前」基线 → 护栏③跳过）
  const NEW_SKILL_TOOLS = [READ_SKILL_TOOL_NAME, LIST_SKILLS_TOOL_NAME]

  it('tools/list 暴露九把工具、名字唯一、含新增 read_skill/list_skills', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'post_message',
      'search_knowledge',
      'query_db',
      'query_session_messages',
      'list_session_members',
      'request_user_action',
      'create_pr',
      'read_skill',
      'list_skills',
    ])
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(9)
    const lsm = MCP_TOOLS.find((t) => t.name === LIST_SESSION_MEMBERS_TOOL_NAME)
    expect(lsm?.inputSchema).toEqual({ type: 'object', properties: {} })
    const ls = MCP_TOOLS.find((t) => t.name === LIST_SKILLS_TOOL_NAME)
    expect(ls?.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('工具 2 护栏①：瘦身后六把既有工具 JSON.stringify 合计 ≤ 3400（防回卷）', () => {
    // 目标集 = 六把既有工具（list_session_members 是工具 1 新增、独立小体量）；
    // 派活单验收「六把合计 ≤ 3400」字面落地。放 vitest 不放 hook（hooks 根修同思路）。
    const six = MCP_TOOLS.filter((t) => SIX_EXISTING.includes(t.name))
    expect(six).toHaveLength(6)
    expect(JSON.stringify(six).length).toBeLessThanOrEqual(3400)
  })

  it('工具 2 护栏②：瘦身后七把（含 list_session_members）resident < 瘦身前基线 4090', () => {
    // tools/list 真实返回 MCP_TOOLS——加 list_session_members 后仍应低于瘦身前
    // 六把基线 4090（勘察实测值），钉死「瘦身净效果」不因新增工具被吃掉。
    // 注意：read_skill/list_skills 是注入层改造新增（工具 3），体量不计入瘦身净效果
    // 计量——本护栏测 SLIM_7（工具 2 时的 resident），避免被工具 3 的体量误伤。
    const slim = MCP_TOOLS.filter((t) => SLIM_7.includes(t.name))
    expect(slim).toHaveLength(7)
    expect(JSON.stringify(slim).length).toBeLessThan(4090)
  })

  it('工具 2 护栏③：既有工具（除 read_skill/list_skills）inputSchema 结构与瘦身前逐字段零差异', () => {
    // 冻结基线 = 工具 2 改动前六把 inputSchema 去 description 快照。瘦身只允许
    // description 文案变化；property 名/required/enum/type/嵌套结构是 tools/call
    // 参数校验契约，动了即破既有调用——此处把「不破契约」变成可执行断言。
    // read_skill/list_skills 无「瘦身前」基线，跳过（与 list_session_members 同款）。
    const BASELINE = {
      post_message: {
        type: 'object',
        properties: {
          targetCats: { type: 'array', items: { type: 'string' } },
          clientMessageId: { type: 'string' },
        },
        required: ['targetCats'],
      },
      search_knowledge: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      query_db: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            enum: ['messages', 'execution_logs', 'sessions', 'agents', 'knowledge'],
          },
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: ['=', '>', '<', 'LIKE'] },
                value: { type: 'string' },
              },
              required: ['column', 'op', 'value'],
            },
          },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['table'],
      },
      query_session_messages: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          before: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string', enum: ['text', 'thinking', 'tool'] } },
          agentIdFilter: { type: 'string' },
        },
      },
      request_user_action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['restart', 'choice'] },
          reason: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['type', 'reason'],
      },
      create_pr: {
        type: 'object',
        properties: {
          base: { type: 'string' },
          head: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['head', 'title', 'body'],
      },
    }
    for (const t of MCP_TOOLS) {
      if (t.name === LIST_SESSION_MEMBERS_TOOL_NAME) continue // 新工具无「瘦身前」基线
      if (t.name === READ_SKILL_TOOL_NAME || t.name === LIST_SKILLS_TOOL_NAME) continue // 注入层改造新增无基线
      expect(stripDescriptions(t.inputSchema)).toEqual(BASELINE[t.name])
    }
  })

  it('catalog 契约：read_skill 的 name 枚举 = SKILL_WHITELIST，description 内嵌清单', () => {
    const tool = MCP_TOOLS.find((t) => t.name === READ_SKILL_TOOL_NAME)
    expect(tool).toBeTruthy()
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（技能清单内，kebab-case）' } },
      required: ['name'],
    })
    // catalog 嵌进工具描述：read_skill description 须包含全部白名单技能名
    for (const name of SKILL_WHITELIST) {
      expect(tool?.description).toContain(name)
    }
    // SKILL_CATALOG 键 == SKILL_WHITELIST（单本 catalog，两处不漂移）
    expect(Object.keys(SKILL_CATALOG)).toEqual(SKILL_WHITELIST)
  })

  it('白名单定死 11 技能、request-review 回流、wayfinder 排除已撤销（口径翻转）', () => {
    expect(SKILL_WHITELIST).toEqual([
      'grilling',
      'to-spec',
      'spec-gate',
      'to-tickets',
      'implement',
      'quality-gate',
      'request-review',
      'receive-review',
      'session-handoff',
      'wayfinder',
      'design-taste-frontend',
    ])
    expect(SKILL_WHITELIST).toContain('request-review')
    // 2026-09-15 口径翻转：`disable-model-invocation` 是上游来源标记、本仓不构成访问约束
    // （ADR 0014 §6 白名单判据重构；manifest.yaml 头部与 BOOTSTRAP.md 同款表述），
    // 故 wayfinder 撤销排除——原 `not.toContain('wayfinder')` 断言随之删除，改为正向钉死。
    expect(SKILL_WHITELIST).toContain('wayfinder')
    expect(SKILL_WHITELIST).toContain('design-taste-frontend')
  })

  // T-D 验收「文案指向的技能名真实存在」——铁律文案点名的技能必须真在流程链清单内。
  // 静态源断言（读 seed-data.ts 铁律三段的模板字面量，不做模糊全文扫描）。
  // 判据是**失败安全**的：名单派生的 token 一旦既不是技能、又不在窄白名单里 → 红，
  // 逼人显式裁决「这是技能名还是普通术语」，而不是静静地指向一个不存在的技能。
  it('铁律文案点名的 kebab token 要么是技能、要么在非技能白名单里（T-D）', () => {
    const seed = readRepoFile('packages', 'server', 'src', 'seed-data.ts')
    const laws = ['COMMON_IRON_LAWS', 'CODER_DUTIES', 'REVIEWER_DUTIES']
      .map((name) => {
        const body = templateLiteralOf(seed, name)
        expect(body, `seed-data.ts 取不到 ${name} 正文`).not.toBe('')
        return body
      })
      .join('\n')
    const tokens = [
      ...new Set(
        [...laws.matchAll(/(?<![a-zA-Z-])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?![a-zA-Z-])/g)].map(
          (m) => m[1]
        )
      ),
    ]
    // 非技能专名的 kebab token（窄白名单，与本文件 ROUTING_PATTERNS 同款取舍：不保证穷尽，求失败安全）
    const NOT_SKILLS = new Set(['package-name', 'post-commit', 'push-gate', 'ff-only', 'rev-parse'])
    const named = tokens.filter((t) => !NOT_SKILLS.has(t))
    // 铁律至少点名一个技能，否则修成「谁也不提」也算过
    expect(named.length).toBeGreaterThan(0)
    for (const token of named) {
      expect(SKILL_WHITELIST, `铁律点名 ${token}，但它不在技能白名单`).toContain(token)
    }
  })

  // ADR 0014 §3 不变量：技能正文只管领域内容，不含路由（@谁 / 请谁审查 / 投给谁）。
  // request-review 回流（2026-09-10）是「名字回流、范围收窄」——本断言把它守住
  // （冒烟守卫：`@` 是硬判据，中文黑名单是窄的），防这次翻转把 §3 一起翻掉。
  it('request-review 技能正文零路由（ADR 0014 §3 不变量）', () => {
    const text = readSkillDoc('request-review')
    // frontmatter 一并纳入守卫：路由藏在 description 里同样破坏不变量
    expect(text).not.toContain('@')
    for (const re of ROUTING_PATTERNS) expect(text).not.toMatch(re)
  })

  // F1 实证：路由行曾藏在技能**引用的 ref** 里（ADR §5 合并时漏剥末行），当前恰好没被踩到。
  // 本断言把零路由守卫从 SKILL.md 扩到它引用的共享 ref——同一形状的洞不再只靠运气。
  //
  // 枚举派生（T-D / N2）：早先这里**硬编码** review-request-template.md 一个文件名，
  // 于是「正文换引另一个 ref」= 守卫静默漏守（旧断言照绿，新 ref 零覆盖）。
  // 现在改从 SKILL.md 正文解析引用清单——正文换引用即自动纳入。
  // 边界：只取**一级**引用（技能正文直接点名的）。ref 之间再互相引用不在本守卫范围
  // （如模板引 shared-rules.md，那是共享规则层、按设计带路由，不在 §3 技能正文约束内）。
  it('每个技能引用的共享 ref 无 @ 行 / 无中文路由黑名单（F1 回归守卫·枚举派生·全技能）', () => {
    // T-H④（原 T-D N7）：原先只枚举 `request-review` **一个**技能的引用清单，于是
    // 另一个引 refs 的技能（`receive-review` → `refs/review-standards.md`）**零覆盖**
    // ——「ref 里藏路由行」这个形状的洞只堵了一半。改为枚举 `skills/*/SKILL.md` 全部。
    const skillNames = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'refs' && d.name !== 'catstudy')
      .map((d) => d.name)
      .filter((name) => existsSync(join(SKILLS_ROOT, name, 'SKILL.md')))
    // 枚举面为空 = 守卫失效（目录改名/换布局），必须红
    expect(skillNames.length).toBeGreaterThan(0)

    const cited = new Map() // ref 文件名 → 引用它的技能（报错信息用）
    for (const skill of skillNames) {
      const text = readSkillDoc(skill)
      for (const m of text.matchAll(/(?:skills\/)?refs\/([a-z0-9-]+\.md)/g)) {
        if (!cited.has(m[1])) cited.set(m[1], skill)
      }
    }
    // 解析不出任何引用同样是守卫失效
    expect(cited.size).toBeGreaterThan(0)

    for (const [name, skill] of cited) {
      const text = readSkillsFile('refs', name)
      expect(text, `${name}（被 ${skill} 引用）含 @`).not.toContain('@')
      for (const re of ROUTING_PATTERNS) {
        expect(re.test(text), `${name}（被 ${skill} 引用）命中路由黑名单 ${re}`).not.toBe(true)
      }
    }
  })

  // 回流技能的领域内容三条（票单 T-B 验收一）：门槛六条 / 同型 audit / 轮次升级
  it('request-review 技能正文含三条领域规则', () => {
    const text = readSkillDoc('request-review')
    expect(text).toContain('BLOCKED 前置门槛（六条）')
    expect(text).toContain('强制 failure-mode audit')
    expect(text).toMatch(/同对象 ≥3 轮/)
  })
})

describe('技能读盘契约（readSkill / getSkillsRoot / findRepoRoot / listSkills）', () => {
  let tmpRoot
  let prevEnv
  const ENV_KEY = 'CATSTUDY_SKILLS_DIR'

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY]
    tmpRoot = mkdtempSync(join(tmpdir(), 'catstudy-skills-'))
    process.env[ENV_KEY] = tmpRoot
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevEnv
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('getSkillsRoot 命中 CATSTUDY_SKILLS_DIR 覆盖目录', () => {
    expect(getSkillsRoot()).toBe(tmpRoot)
  })

  it('getSkillsRoot 无覆盖 → 从 cwd 上溯找仓库根 skills/（含 manifest.yaml 标志文件）', () => {
    delete process.env[ENV_KEY]
    const root = getSkillsRoot()
    expect(root).toBeTruthy()
    expect(existsSync(join(root, 'manifest.yaml'))).toBe(true)
  })

  it('findRepoRoot 上溯到含 pnpm-workspace.yaml 的仓库根', () => {
    const root = findRepoRoot(process.cwd())
    expect(root).toBeTruthy()
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('readSkill 按名读 skills/<name>/SKILL.md 全文', () => {
    mkdirSync(join(tmpRoot, 'implement'), { recursive: true })
    writeFileSync(join(tmpRoot, 'implement', 'SKILL.md'), '# Implement\n\n生产代码。')
    const r = readSkill('implement')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('# Implement')
    expect(r.text).toContain('生产代码。')
  })

  it('readSkill 读顶层通用版而非 catstudy 嵌套定制版（ADR 0014 §74 剖除两级注入）', () => {
    mkdirSync(join(tmpRoot, 'quality-gate'), { recursive: true })
    mkdirSync(join(tmpRoot, 'catstudy', 'quality-gate'), { recursive: true })
    writeFileSync(join(tmpRoot, 'quality-gate', 'SKILL.md'), '# quality-gate 顶层通用版')
    writeFileSync(
      join(tmpRoot, 'catstudy', 'quality-gate', 'SKILL.md'),
      '# catstudy-quality-gate 定制版'
    )
    const r = readSkill('quality-gate')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('quality-gate 顶层通用版')
    expect(r.text).not.toContain('catstudy-quality-gate 定制版')
  })

  it('readSkill 清单内但源库缺文件 → ok:false 点名（交付单 B 才落地场景）', () => {
    const r = readSkill('grilling')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('grilling')
    expect(r.reason).toContain('SKILL.md')
  })

  it('readSkill 名字非法（穿越/含特殊字符）→ 路径守卫拒绝', () => {
    for (const bad of ['../foo', 'a/b', '..', 'quality-gate/../../etc']) {
      const r = readSkill(bad)
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('技能名非法')
    }
  })

  it('listSkills 返回全量技能清单（catalog 即白名单）', () => {
    const r = listSkills()
    expect(r.ok).toBe(true)
    for (const name of SKILL_WHITELIST) {
      expect(r.text).toContain(name)
    }
  })
})

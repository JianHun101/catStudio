/**
 * mcp-server.mjs 纯函数工具层（无 shebang、无副作用——供 vitest 单测直接
 * import）。
 *
 * 抽离原因（两层）：
 * 1. 参数校验——mcp-server.mjs 带 shebang（#!/usr/bin/env node），vitest
 *    模块执行器把带 shebang 的代码作为函数体执行时报 "Invalid or unexpected
 *    token"——测试 import 本文件即可，工具面本体保持 spike 留档模式（不做
 *    spawn 子进程级测试）。
 * 2. 工具定义元数据（工具 2「tools/list schema 瘦身」回归护栏）——resident
 *    体量硬断言（JSON.stringify(MCP_TOOLS) ≤ 上限）必须能 import 到真实
 *    tools/list 载荷；defs 放 mcp-server.mjs 则 shebang 使 vitest 不可达。
 *    故工具 name 常量 + 定义对象集中本文件（单一来源），mcp-server.mjs 只
 *    import 使用——tools/list 返回的正是本文件 MCP_TOOLS，测量即真值。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ─── 工具名常量 ──────────────────────────────────────────
export const TOOL_NAME = 'post_message'
export const SEARCH_TOOL_NAME = 'search_knowledge'
export const QUERY_DB_TOOL_NAME = 'query_db'
export const QUERY_SESSION_MESSAGES_TOOL_NAME = 'query_session_messages'
export const LIST_SESSION_MEMBERS_TOOL_NAME = 'list_session_members'
export const REQUEST_USER_ACTION_TOOL_NAME = 'request_user_action'
export const CREATE_PR_TOOL_NAME = 'create_pr'
export const READ_SKILL_TOOL_NAME = 'read_skill'
export const LIST_SKILLS_TOOL_NAME = 'list_skills'

/**
 * 工具定义（tools/list 常驻载荷）——inputSchema 结构钉死契约：
 * property 名/required/enum/type/minimum/maximum/嵌套结构不可动（瘦身只压
 * description 文案；结构是 tools/call 参数校验契约）。mcp-server.mjs 只 import
 * 本文件 MCP_TOOLS 返回 tools/list，故 resident 体量 == JSON.stringify(MCP_TOOLS)。
 */
const POST_MESSAGE_TOOL = {
  name: TOOL_NAME,
  description:
    '把消息结构化投递给猫咖的下一棒 Agent（替代文本行首 @）。' +
    'targetCats 传目标猫完整名字，可一次投多个。' +
    '仅「真要把下一棒叫起来干活」时用；叙述性提及猫名勿用。',
  inputSchema: {
    type: 'object',
    properties: {
      targetCats: {
        type: 'array',
        items: { type: 'string' },
        description: '目标猫完整名字数组（会话成员，非空）',
      },
      clientMessageId: {
        type: 'string',
        description: '可选：客户端消息 id（幂等）',
      },
    },
    required: ['targetCats'],
  },
}

const QUERY_DB_TOOL = {
  name: QUERY_DB_TOOL_NAME,
  description:
    '查猫咖数据库表（排障取证，替代 raw SQL；表/列白名单服务端强制）。' +
    'table 传白名单表；conditions 过滤（AND 连接；op ∈ =/>/</LIKE，LIKE 的 % 写进 value）；' +
    'limit 1-100 默认 50；返回 snake_case 原样。',
  inputSchema: {
    type: 'object',
    properties: {
      table: {
        type: 'string',
        enum: ['messages', 'execution_logs', 'sessions', 'agents', 'knowledge'],
        description: '白名单表名',
      },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: '该表可查列名（白名单）' },
            op: { type: 'string', enum: ['=', '>', '<', 'LIKE'] },
            value: { type: 'string' },
          },
          required: ['column', 'op', 'value'],
        },
        description: '可选：AND 条件数组',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: '返回条数 1-100，默认 50',
      },
    },
    required: ['table'],
  },
}

const REQUEST_USER_ACTION_TOOL = {
  name: REQUEST_USER_ACTION_TOOL_NAME,
  description:
    '把「需用户介入」的请求结构化投递给用户（替代文本格式匹配）。' +
    'type：restart（申请重启 server，仅店长可发，需用户批准）；choice（暂不支持）。' +
    'reason 必填写明原因。仅「真需用户操作」时用。',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['restart', 'choice'],
        description: 'restart 已落地；choice 暂不支持',
      },
      reason: {
        type: 'string',
        description: '请求原因（必填非空）',
      },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '选项 id（回灌用）' },
            label: { type: 'string', description: '选项展示文本' },
          },
          required: ['id', 'label'],
        },
        description: '可选：选项组（choice 用）',
      },
    },
    required: ['type', 'reason'],
  },
}

const SEARCH_KNOWLEDGE_TOOL = {
  name: SEARCH_TOOL_NAME,
  description:
    '检索猫咖知识库（运营方标准数据：接入文档/领域标准/规范）。' +
    'query 传检索意图，topK 1-10 默认 3；' +
    '返回命中条目 JSON（含 content/source/distance），无命中返回空数组。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索意图（非空）',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: '返回条数 1-10，默认 3',
      },
    },
    required: ['query'],
  },
}

const CREATE_PR_TOOL = {
  name: CREATE_PR_TOOL_NAME,
  description:
    '创建 GitHub PR（收口链发布关，替代 push 审批）。' +
    '仅店长可调（非 store 被 403 拒）。' +
    'head 传已 push origin 的源分支（本工具不代推，未推报 branch-not-pushed）；' +
    'base 默认 dev；title/body 必填。成功返回 PR 号+URL，失败原因不静默透传。',
  inputSchema: {
    type: 'object',
    properties: {
      base: {
        type: 'string',
        description: '默认 dev',
      },
      head: {
        type: 'string',
        description: '源分支（须已 push origin）',
      },
      title: {
        type: 'string',
        description: 'PR title（非空）',
      },
      body: {
        type: 'string',
        description: 'PR body（非空）',
      },
    },
    required: ['head', 'title', 'body'],
  },
}

const QUERY_SESSION_MESSAGES_TOOL = {
  name: QUERY_SESSION_MESSAGES_TOOL_NAME,
  description:
    '回读当前会话历史消息（agent 中途回看的语境通道）。' +
    '返回 messages（含 role/agentName/createdAt/blocks——原生结构化块 kind ∈ text/thinking/tool 交错）。' +
    'limit 1-100 默认 20；before 传消息 id 翻更早；from/to 时间窗；kinds 留指定块；agentIdFilter 只看某 agent。' +
    '勿回读自己刚写的连续 thinking（防复读），勿整段照抄。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: '返回消息条数 1-100，默认 20',
      },
      before: {
        type: 'string',
        description: '消息 id 游标（更早批次）',
      },
      from: {
        type: 'string',
        description: 'created_at 下界',
      },
      to: {
        type: 'string',
        description: 'created_at 上界',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['text', 'thinking', 'tool'] },
        description: '可选：只留这些块类型',
      },
      agentIdFilter: {
        type: 'string',
        description: '可选：只看某 agent',
      },
    },
  },
}

const LIST_SESSION_MEMBERS_TOOL = {
  name: LIST_SESSION_MEMBERS_TOOL_NAME,
  description:
    '列出当前会话全部成员（agentId/name/role）。' +
    'role 是身份定位：store=店长（收口决策）、reviewer=审查猫、implementer=实施猫、vision=视觉验收——' +
    '派活/收口前查会话有哪些猫、各自干嘛。会话由环境注入，无参数。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}

// ─── 技能懒加载（注入层改造：server 不再塞全文进 prompt，模型经 read_skill 自取）──────
// 技能名路径守卫（readSkill 读盘前第二道防御——名字只允许小写字母/数字/连字符，防空穿越）。
// 虽 validateReadSkillParams 已把 name 收进 SKILL_CATALOG，readSkill 读盘前仍用它做第二道防御。
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * P2=A 流程链技能集合（注入层目录——catalog 嵌进 read_skill 描述、不再注入 prompt）。
 * 判据：开发流程链（wayfinder 起图 → grilling/to-spec → spec-gate → to-tickets → implement
 * → quality-gate → request-review → receive-review） + 会话压缩 session-handoff（handoff 重命名）。
 * request-review 于 2026-09-10 回流（ADR 0014 §5 修订：post-commit hook 不再机械投递，
 * 请求审查改由 Agent 自行发起；范围收窄——技能正文零路由，递送语义仍归状态机
 * FLOW_MAIN_CHAIN，见 execution/flow-state.ts）；wayfinder 排除（disable-model-invocation 是设计）。
 * session-handoff 目录由交付单 B 重命名 handoff 落地——清单先行，readSkill 读缺返回错误文本。
 */
export const FLOW_CHAIN_SKILLS = [
  'grilling',
  'to-spec',
  'spec-gate',
  'to-tickets',
  'implement',
  'quality-gate',
  'request-review',
  'receive-review',
  'session-handoff',
]

/** 技能名 → 一句话说明（catalog 清单，read_skill 描述 + list_skills 共用同一本）。 */
export const SKILL_CATALOG = {
  grilling: '压测计划/需求：用提问把粗糙计划压出可证伪需求理解',
  'to-spec': '把 grilling 出的需求写成可证伪 spec',
  'spec-gate': '需求进实施前的自查门（可证伪性/契约/验收，前半个门）',
  'to-tickets': '把 spec 拆成工单',
  implement: '按 spec/工单实施，产出满足验收的代码',
  'quality-gate': '代码提交审查前的自查门（后半个门）',
  'request-review': '发起审查请求前的门槛与轮次规则（BLOCKED 六条 / 同型 audit / ≥3 轮升级）',
  'receive-review': '接收并处理审查反馈（P1/P2/P3 分类）',
  'session-handoff': '会话压缩交接（跨会话把上下文传给下一棒）',
}

const READ_SKILL_TOOL = {
  name: READ_SKILL_TOOL_NAME,
  description:
    '读取猫咖技能正文（按名取 skills/<名>/SKILL.md 全文；懒加载——模型按需自取，不再由 server 全文注入 prompt）。' +
    'name 必须在技能清单内：' +
    FLOW_CHAIN_SKILLS.join(' / ') +
    '。' +
    '技能正文即该技能定义（含使用时机/输出/前置门槛），模型在对应流程阶段按需调用本工具自取。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（技能清单内，kebab-case）' },
    },
    required: ['name'],
  },
}

const LIST_SKILLS_TOOL = {
  name: LIST_SKILLS_TOOL_NAME,
  description:
    `列出猫咖技能清单（P2 流程链 ${FLOW_CHAIN_SKILLS.length} 技能 + 一句话说明）。` +
    'catalog 已内嵌 read_skill 描述，本工具是冗余兜底——模型不确定有哪些技能时可先调本工具。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}

/** tools/list 常驻载荷（顺序即 tools/list 返回顺序；resident 体量 = JSON.stringify 本数组） */
export const MCP_TOOLS = [
  POST_MESSAGE_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  QUERY_DB_TOOL,
  QUERY_SESSION_MESSAGES_TOOL,
  LIST_SESSION_MEMBERS_TOOL,
  REQUEST_USER_ACTION_TOOL,
  CREATE_PR_TOOL,
  READ_SKILL_TOOL,
  LIST_SKILLS_TOOL,
]

/**
 * search_knowledge 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：query 非空字符串、topK 可选 1-10 整数（默认 3）。
 * 返回 { ok: true, query, topK } 或 { ok: false, reason }（reason 回模型可纠正）。
 */
export function validateSearchParams(args) {
  const query = args?.query
  if (typeof query !== 'string' || !query.trim()) {
    return {
      ok: false,
      reason: `search_knowledge 参数无效: query 必须是非空字符串（当前: ${JSON.stringify(query)}）`,
    }
  }
  const topK = args?.topK ?? 3
  if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 10) {
    return {
      ok: false,
      reason: `search_knowledge 参数无效: topK 必须是 1-10 整数（当前: ${JSON.stringify(topK)}）`,
    }
  }
  return { ok: true, query: query.trim(), topK }
}

/**
 * query_db 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：table ∈ 白名单、conditions 可选数组（每项 { column: 非空字符串,
 * op: =/>/</LIKE, value: 字符串 }）、limit 可选 1-100 整数（默认 50）。
 * 列名白名单由服务端 QUERY_TABLE_SCHEMAS 权威校验（400 层）——本层只校形状，
 * 避免 JS/TS 两侧白名单双份漂移。
 *
 * ⚠️ **表名这一层不适用「只校形状」**：本常量与 `QUERY_DB_TOOL` 的 `enum` 是
 * 服务端 `QUERY_TABLE_SCHEMAS` 的**镜像**，两边不一致会出现「同一张表两条通道
 * 两种结论」（MCP 侧 advertised、服务端明确拒绝）。`mcp-server.test.js` 有逐项
 * 一致性用例钉住——**改一处必须改三处**（本常量 / tool enum / 服务端 schemas）。
 * `memories` 已随段三接线下线（表已 DROP），三处同步摘除。
 *
 * 返回 { ok: true, table, conditions, limit } 或 { ok: false, reason }。
 */
export const QUERY_DB_TABLES = ['messages', 'execution_logs', 'sessions', 'agents', 'knowledge']
const QUERY_DB_OPS = ['=', '>', '<', 'LIKE']

export function validateQueryDbParams(args) {
  const table = args?.table
  if (typeof table !== 'string' || !QUERY_DB_TABLES.includes(table)) {
    return {
      ok: false,
      reason: `query_db 参数无效: table 必须是白名单表之一（${QUERY_DB_TABLES.join('/')}；当前: ${JSON.stringify(table)}）`,
    }
  }
  const limit = args?.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return {
      ok: false,
      reason: `query_db 参数无效: limit 必须是 1-100 整数（当前: ${JSON.stringify(limit)}）`,
    }
  }
  const conditions = args?.conditions ?? []
  if (!Array.isArray(conditions)) {
    return {
      ok: false,
      reason: `query_db 参数无效: conditions 必须是数组（当前: ${JSON.stringify(conditions)}）`,
    }
  }
  for (const c of conditions) {
    if (
      typeof c !== 'object' ||
      c === null ||
      typeof c.column !== 'string' ||
      !c.column.trim() ||
      typeof c.op !== 'string' ||
      !QUERY_DB_OPS.includes(c.op) ||
      typeof c.value !== 'string'
    ) {
      return {
        ok: false,
        reason: `query_db 参数无效: conditions 每项须 { column: 非空字符串, op: ${QUERY_DB_OPS.join('/')}, value: 字符串 }（当前: ${JSON.stringify(c)}）`,
      }
    }
  }
  return { ok: true, table, conditions, limit }
}

/**
 * request_user_action 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：type ∈ {restart, choice}（枚举就绪——choice 服务端当前 400「暂不支持」，
 * 渲染留第二步，管道先通）、reason 必填非空字符串、
 * options 可选数组（每项 { id: 非空字符串, label: 非空字符串 }，choice 用，restart 忽略）。
 * 服务端角色白名单与 type 支持面由 internal.ts 权威校验（400/403 层）——
 * 本层只校形状，与 validateQueryDbParams 同款分层。
 * 返回 { ok: true, type, reason, options } 或 { ok: false, reason }。
 */
export const USER_REQUEST_TYPES = ['restart', 'choice']

export function validateUserRequestParams(args) {
  const type = args?.type
  if (typeof type !== 'string' || !USER_REQUEST_TYPES.includes(type)) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: type 必须是 ${USER_REQUEST_TYPES.join('/')} 之一（当前: ${JSON.stringify(type)}）`,
    }
  }
  const reason = args?.reason
  if (typeof reason !== 'string' || !reason.trim()) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: reason 必须是非空字符串（当前: ${JSON.stringify(reason)}）`,
    }
  }
  const options = args?.options ?? []
  if (!Array.isArray(options)) {
    return {
      ok: false,
      reason: `request_user_action 参数无效: options 必须是数组（当前: ${JSON.stringify(options)}）`,
    }
  }
  for (const o of options) {
    if (
      typeof o !== 'object' ||
      o === null ||
      typeof o.id !== 'string' ||
      !o.id.trim() ||
      typeof o.label !== 'string' ||
      !o.label.trim()
    ) {
      return {
        ok: false,
        reason: `request_user_action 参数无效: options 每项须 { id: 非空字符串, label: 非空字符串 }（当前: ${JSON.stringify(o)}）`,
      }
    }
  }
  return { ok: true, type, reason: reason.trim(), options }
}

/**
 * create_pr 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：head 必填非空字符串、title 必填非空字符串、body 必填非空字符串、
 * base 可选非空字符串（缺失/undefined → 服务端 createPr 默认 'dev'）。
 * 服务端角色白名单与 createPr 业务失败（not-authed/branch-not-pushed 等）
 * 由 internal.ts 权威校验（403/422 层）——本层只校形状，与既有工具同款分层。
 * 返回 { ok: true, base, head, title, body }（字符串 trim）或 { ok: false, reason }。
 */
export function validateCreatePrParams(args) {
  const head = args?.head
  if (typeof head !== 'string' || !head.trim()) {
    return {
      ok: false,
      reason: `create_pr 参数无效: head 必须是非空字符串（当前: ${JSON.stringify(head)}）`,
    }
  }
  const title = args?.title
  if (typeof title !== 'string' || !title.trim()) {
    return {
      ok: false,
      reason: `create_pr 参数无效: title 必须是非空字符串（当前: ${JSON.stringify(title)}）`,
    }
  }
  const body = args?.body
  if (typeof body !== 'string' || !body.trim()) {
    return {
      ok: false,
      reason: `create_pr 参数无效: body 必须是非空字符串（当前: ${JSON.stringify(body)}）`,
    }
  }
  const base = args?.base
  if (base !== undefined && (typeof base !== 'string' || !base.trim())) {
    return {
      ok: false,
      reason: `create_pr 参数无效: base 必须是非空字符串（当前: ${JSON.stringify(base)}）`,
    }
  }
  return {
    ok: true,
    base: base?.trim() || undefined,
    head: head.trim(),
    title: title.trim(),
    body: body.trim(),
  }
}

/**
 * query_session_messages 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约（全部可选，服务端 default 兜底）：limit 可选 1-100 整数（默认 20）、
 * before 可选非空字符串（消息 id 游标）、from/to 可选非空字符串（created_at 时间窗）、
 * kinds 可选非空数组（每项 ∈ text/thinking/tool）、agentIdFilter 可选非空字符串。
 * 服务端鉴权链与窗口解析由 internal.ts 权威处理（400/404/401/409 层）——本层只校形状，
 * 与 validateQueryDbParams 同款分层。可选字段缺省返回 undefined（调用方 JSON.stringify
 * 自动省略该键 → 服务端走默认）。
 * 返回 { ok: true, limit, before, from, to, kinds, agentIdFilter } 或 { ok: false, reason }。
 */
export const SESSION_MESSAGE_KINDS = ['text', 'thinking', 'tool']

export function validateQuerySessionMessagesParams(args) {
  const limit = args?.limit ?? 20
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: limit 必须是 1-100 整数（当前: ${JSON.stringify(limit)}）`,
    }
  }
  const before = args?.before
  if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: before 必须是非空字符串（当前: ${JSON.stringify(before)}）`,
    }
  }
  const from = args?.from
  if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: from 必须是非空字符串（当前: ${JSON.stringify(from)}）`,
    }
  }
  const to = args?.to
  if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: to 必须是非空字符串（当前: ${JSON.stringify(to)}）`,
    }
  }
  const kinds = args?.kinds
  if (
    kinds !== undefined &&
    (!Array.isArray(kinds) ||
      kinds.length === 0 ||
      !kinds.every((k) => typeof k === 'string' && SESSION_MESSAGE_KINDS.includes(k)))
  ) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: kinds 必须是非空数组且每项 ∈ ${SESSION_MESSAGE_KINDS.join('/')}（当前: ${JSON.stringify(kinds)}）`,
    }
  }
  const agentIdFilter = args?.agentIdFilter
  if (agentIdFilter !== undefined && (typeof agentIdFilter !== 'string' || !agentIdFilter.trim())) {
    return {
      ok: false,
      reason: `query_session_messages 参数无效: agentIdFilter 必须是非空字符串（当前: ${JSON.stringify(agentIdFilter)}）`,
    }
  }
  return {
    ok: true,
    limit,
    before: before?.trim() || undefined,
    from: from?.trim() || undefined,
    to: to?.trim() || undefined,
    kinds,
    agentIdFilter: agentIdFilter?.trim() || undefined,
  }
}

/**
 * read_skill 参数校验（纯函数，供单测——scripts/mcp-server.test.js）。
 * 契约：name 必填非空字符串且 ∈ SKILL_CATALOG（P2=A 流程链清单）。
 * 收进 SKILL_CATALOG 即双重作用：一是把模型可自取的范围钉死在流程链（wayfinder 排除），
 * 二是名单内名字全是 kebab-case，天然满足 SKILL_NAME_RE 路径守卫（读盘前 mcp-server.mjs
 * 再以 SKILL_NAME_RE 作第二道防御）。返回 { ok: true, name } 或 { ok: false, reason }。
 */
export function validateReadSkillParams(args) {
  const name = args?.name
  if (typeof name !== 'string' || !name.trim()) {
    return {
      ok: false,
      reason: `read_skill 参数无效: name 必须是非空字符串（当前: ${JSON.stringify(name)}）`,
    }
  }
  const trimmed = name.trim()
  if (!SKILL_CATALOG[trimmed]) {
    return {
      ok: false,
      reason: `read_skill 参数无效: name 不在技能清单（${FLOW_CHAIN_SKILLS.join('/')}；当前: ${JSON.stringify(name)}）`,
    }
  }
  return { ok: true, name: trimmed }
}

// ─── 技能读盘原语（read_skill/list_skills 实现——注入层改造：模型经工具自取正文）───
// readSkill 读顶层 skills/<name>/SKILL.md（catalog 名即顶层目录名）。
// catstudy 定制版（catstudy-quality-gate / catstudy-receive-review）是「独立定义」，非本工具
// 路由目标——manifest §294 明示两套不同定义、一期不切路由；ADR 0014 §74 已剖除两级路径注入。
// 故顶层是意图（与旧注入层一致：其在 skills/catstudy/ 上的两级注入本就是 V1 未实现的 TODO 缺口）。
// 读盘定位与 skill-loader.ts（已删）同款：CATSTUDY_SKILLS_DIR 环境覆盖优先，否则从 cwd 上溯找
// pnpm-workspace.yaml → skills/。

/** 从 start 上溯找仓库根（存在 pnpm-workspace.yaml 的那层；找不到返回 null）。 */
export function findRepoRoot(start) {
  let cur = resolve(start)
  for (;;) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 定位技能源库根（CATSTUDY_SKILLS_DIR 覆盖优先；找不到 → null → read_skill 降级）。 */
export function getSkillsRoot() {
  const envRoot = process.env['CATSTUDY_SKILLS_DIR']
  if (envRoot) return existsSync(envRoot) ? envRoot : null
  const repoRoot = findRepoRoot(process.cwd())
  if (!repoRoot) return null
  const skillsDir = join(repoRoot, 'skills')
  return existsSync(skillsDir) ? skillsDir : null
}

/**
 * 按名读技能正文（read_skill 工具实现）。name 已由 validateReadSkillParams 收进
 * SKILL_CATALOG，此处再以 SKILL_NAME_RE 作第二道路径守卫（防御纵深，防穿越）。
 * 成功 → { ok: true, text }（SKILL.md 全文）；失败 → { ok: false, reason }（可回模型诊断）。
 */
export function readSkill(name) {
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, reason: `技能名非法（${name}），仅允许小写字母/数字/连字符` }
  }
  const root = getSkillsRoot()
  if (!root) {
    return {
      ok: false,
      reason: '技能源库未定位（CATSTUDY_SKILLS_DIR 未设且无法从 cwd 上溯到仓库根）',
    }
  }
  const file = join(root, name, 'SKILL.md')
  try {
    if (!existsSync(file)) {
      return {
        ok: false,
        reason: `技能正文未找到：${name}/SKILL.md（清单内但源库暂无此文件——可能由交付单 B 才落地）`,
      }
    }
    return { ok: true, text: readFileSync(file, 'utf-8') }
  } catch (err) {
    return { ok: false, reason: `技能正文读取失败：${err.message}` }
  }
}

/** 列技能清单（list_skills 工具实现）——catalog 即 P2=A 流程链技能；数量动态渲染，不在文案写死。 */
export function listSkills() {
  const lines = Object.entries(SKILL_CATALOG).map(([n, desc]) => `- ${n}: ${desc}`)
  return {
    ok: true,
    text: `技能清单（P2 流程链 ${Object.keys(SKILL_CATALOG).length} 技能）：\n` + lines.join('\n'),
  }
}

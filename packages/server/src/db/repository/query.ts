/**
 * 通用表查询函数（query_db 窄通道工具的服务端执行层）。
 *
 * 安全三层（店长裁决，防注入 + 防越权）：
 *   1. 表名白名单 + 常量 map 分发——SQL 表名只来自 QUERY_TABLE_SCHEMAS 的 key，
 *      sqlite_master 等系统表直接查不到
 *   2. 列名白名单 = 返回列白名单（一套表定义两用）——conditions.column 必须 ∈
 *      该表可查列，校验后双引号包裹；SELECT 只投影白名单列
 *   3. 敏感列硬剔除：agents 排除 llm_api_key / llm_base_url / system_prompt
 *      （密钥绝不能进模型视野）；memories / knowledge 排除 embedding BLOB
 *      （512-dim 向量与检索语义无关且体积大）；value 全部 `?` 参数化绑定
 *
 * 契约细节（店长裁决）：
 *   - 表级 orderBy——5 张表 created_at DESC；execution_logs 无 created_at 列，
 *     用 started_at DESC
 *   - 允许无条件查询（limit 兜底，默认 50）——「查最近消息」是核心排障用例
 *   - LIKE 的 % 由模型自己写在 value 里，服务端不自动包裹
 *   - 无命中返回 rows: []，不报错；total = 全量匹配数（LIMIT 前），
 *     给模型「还有更多」的信号
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 每张表的可查列白名单（= 返回列白名单）+ 排序列配置 */
export const QUERY_TABLE_SCHEMAS = {
  agents: {
    columns: [
      'id',
      'name',
      'avatar',
      'llm_provider',
      'llm_model',
      'effort_level',
      'skill_modules',
      'role',
      'created_at',
      'updated_at',
    ],
    orderBy: 'created_at',
  },
  sessions: {
    columns: [
      'id',
      'title',
      'agent_ids',
      'broadcast_mode',
      'running_summary',
      'handoff_from',
      'summary_msg_id',
      'created_at',
      'updated_at',
    ],
    orderBy: 'created_at',
  },
  messages: {
    columns: [
      'id',
      'session_id',
      'agent_id',
      'role',
      'content',
      'mentions',
      'images',
      'task_id',
      'thinking_content',
      'tool_content',
      'dispatch_state',
      'created_at',
    ],
    orderBy: 'created_at',
  },
  memories: {
    columns: ['id', 'agent_id', 'content', 'source_message_id', 'created_at'],
    orderBy: 'created_at',
  },
  knowledge: {
    columns: ['id', 'content', 'source', 'tags', 'created_at'],
    orderBy: 'created_at',
  },
  execution_logs: {
    columns: [
      'id',
      'session_id',
      'agent_id',
      'triggered_by_message_id',
      'status',
      'trace_id',
      'started_at',
      'ended_at',
      'latency_ms',
      'error_message',
      'message_id',
      'commit_hash',
      'packages_installed',
      'prompt_chars',
      'reply_chars',
      'prompt_tokens',
      'completion_tokens',
    ],
    // 无 created_at 列——用 started_at 排序（店长裁决）
    orderBy: 'started_at',
  },
} as const

export type QueryTableName = keyof typeof QUERY_TABLE_SCHEMAS

export type QueryOp = '=' | '>' | '<' | 'LIKE'

export interface QueryCondition {
  column: string
  op: QueryOp
  value: string
}

export interface QueryTableParams {
  table: QueryTableName
  conditions?: QueryCondition[]
  limit?: number
}

export interface QueryTableResult {
  rows: Record<string, string | number | null>[]
  /** 全量匹配数（LIMIT 前）——告知模型是否还有更多行 */
  total: number
}

/**
 * 白名单表参数化查询（query_db 窄通道执行层）。
 *
 * 入参假设已由端点校验（400 层）——本函数仍是安全执行点：表名经 schema map
 * 解析（非白名单 key 直接 throw，防绕过端点直调）；列名逐一校验后双引号包裹
 * （列名只来自白名单常量，无注入面）；value 全部 `?` 绑定。
 */
export function queryTable(params: QueryTableParams): QueryTableResult {
  // as const 常量是只读字面量元组——宽化为 readonly string[] 供 includes/join 使用
  const schema: { columns: readonly string[]; orderBy: string } = QUERY_TABLE_SCHEMAS[params.table]
  if (!schema) {
    throw new Error(`query_db 表名不在白名单: ${params.table}`)
  }
  const conditions = params.conditions ?? []
  for (const c of conditions) {
    if (!schema.columns.includes(c.column)) {
      throw new Error(`query_db 列不在白名单: ${params.table}.${c.column}`)
    }
  }

  const whereSql =
    conditions.length > 0
      ? `WHERE ${conditions.map((c) => `"${c.column}" ${c.op} ?`).join(' AND ')}`
      : ''
  const values: Array<string | number> = conditions.map((c) => c.value)
  const limit = params.limit ?? 50

  const rows = db
    .prepare(
      `SELECT ${schema.columns.join(', ')} FROM ${params.table} ${whereSql}
       ORDER BY ${schema.orderBy} DESC LIMIT ?`
    )
    .all(...values, limit) as Record<string, string | number | null>[]

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM ${params.table} ${whereSql}`)
    .get(...values) as { n: number }

  return { rows, total: totalRow.n }
}

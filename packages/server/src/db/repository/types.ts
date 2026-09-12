/**
 * 数据库 Row 类型定义。
 *
 * 每个 interface 对应一个表，字段名与数据库列名一致（snake_case）。
 * 这些类型用于 repository 层的返回值标注，消除业务代码中的 `as any`。
 *
 * 注意：better-sqlite3 的 .get()/.all() 返回类型是 unknown，
 * 因此 repository 函数内部仍需要 `as XxxRow` 断言。
 * 但外部调用方获得的是编译期类型安全的返回值。
 */

export interface AgentRow {
  id: string
  name: string
  avatar: string
  system_prompt: string
  llm_provider: string
  llm_model: string
  llm_api_key: string
  llm_base_url: string | null
  effort_level: string
  /** 单次输出 token 上限（per-agent 静态运行配置；迁移 DEFAULT 2048 回填存量行） */
  llm_max_tokens: number
  /** 采样温度（per-agent 静态运行配置；迁移 DEFAULT 0.7 回填存量行） */
  llm_temperature: number
  /** 额外环境变量（per-agent 静态运行配置；JSON 字符串，迁移 DEFAULT '{}' 回填存量行） */
  llm_env_extra: string
  skill_modules: string
  role: string
  created_at: string
  updated_at: string
}

export interface SessionRow {
  id: string
  title: string
  agent_ids: string // JSON 字符串数组
  broadcast_mode: number // 0 或 1
  running_summary: string | null // JSON 字符串
  handoff_from: string | null
  summary_msg_id: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  session_id: string
  agent_id: string | null
  role: 'user' | 'agent' | 'system'
  content: string
  mentions: string // JSON 字符串数组
  images: string | null // JSON 字符串数组（base64 dataURL）
  task_id: string | null
  thinking_content: string | null
  /** 工具调用记录 JSON（结构化数组：id/name/status/input/output 截断摘要；
   *  独立列，永不进 LLM 上下文——正文/思考/工具三通道分离） */
  tool_content: string | null
  /** 回复分段 JSON（与 shared.StreamSegment[] 同形，kind+content+tool 按时间序交错）——
   *  历史渲染还原交错顺序；老消息 NULL（无分段 → 前端退化 thinking_content+tool_content 两块） */
  segments: string | null
  dispatch_state: string | null
  /** 附加富内容 JSON（diff 块等；独立列，永不进 LLM 上下文） */
  extra: string | null
  created_at: string
}

export interface MessageWithAgentName extends MessageRow {
  agent_name: string | null
}

export interface MemoryRow {
  id: string
  agent_id: string
  content: string
  embedding: Buffer | null
  source_message_id: string | null
  created_at: string
}

/**
 * chunks 表行（段三切片索引，Decisions 34 X1/X2）。
 *
 * 身份键 = `doc_path` + `section_anchor` + `content_hash`（唯一索引，Decisions 17
 * 明裁「不带片序号」）；`part_index`/`part_total`/`hard_cut` 是重扫可被覆盖的切片
 * 信息，**不进身份键**。表内无任何扫描时间戳列（X3，「删表 → 重扫 → 逐行等价」）。
 * `date` 是 MD 里的历史事实（票戊冻结），不是扫描时刻。
 */
export interface ChunkRow {
  /** 内部行号；`chunk_vectors.chunk_id` 与之对齐。不进身份键 */
  id: number
  doc_path: string
  section_anchor: string
  /** `body` 的 sha256 hex（与票庚扫描器同算法，否则唯一键失效） */
  content_hash: string
  /** 扫描时该 MD 的 git blob SHA（`git hash-object <path>`），增量比对键 */
  origin_id: string
  type: string | null
  /** **节级**（Decisions 24）；硬排除集合 = superseded/deprecated，NULL = 未声明状态（放行） */
  status: string | null
  date: string | null
  /** JSON 数组文本（X2-a：不建关联表） */
  evidence: string | null
  supersedes: string | null
  superseded_by: string | null
  valid_from: string | null
  valid_to: string | null
  part_index: number
  part_total: number
  /** 该片由 L3-f 字符硬切产生 */
  hard_cut: number
  /** 片正文（不含面包屑） */
  body: string
  breadcrumb: string
}

export interface ExecutionLogRow {
  id: string
  session_id: string
  agent_id: string
  triggered_by_message_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  trace_id: string
  started_at: string | null
  ended_at: string | null
  latency_ms: number | null
  error_message: string | null
  message_id: string | null
  commit_hash: string | null
  packages_installed: string | null // JSON 字符串数组
  prompt_chars: number | null
  reply_chars: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  /** L1 错误分类桶（classifyError 七桶 + 'server_restart'；存量行 NULL → 聚合 COALESCE('unknown')） */
  error_type: string | null
}

export interface SessionReadStateRow {
  session_id: string
  last_read_at: string
}

/** v2 episode 评估表行（docs/plans/episode-evaluation-v2.md §3） */
export interface EpisodeRow {
  id: string
  /** 锚定主键：根触发消息 id（UNIQUE，upsert 冲突键） */
  root_trigger_message_id: string
  /** 双根语义：'U'（用户任务）/ 'H'（交接审查链根） */
  root_triggered_by: 'U' | 'H'
  /** 实际锚定消息 id（零执行场景 = 根消息自身） */
  root_message_id: string | null
  /** 归组辅助键（U 根自身值，可 NULL，不承重） */
  task_id: string | null
  /** 结局判定关联键（= 链末 execution_log.trace_id 抄录；NULL 仅零执行场景，G2-N5） */
  chain_task_id: string | null
  /** 根消息所在会话（N6：verdict JOIN 的 session 限定键） */
  session_id: string | null
  /** 7 类结局之一，未定（在途 open）= NULL */
  outcome: string | null
  /** closure 状态机：open → classified → closed */
  episode_state: 'open' | 'classified' | 'closed'
  /** 判定规则版本号（P5 全量重评承重） */
  classification_ver: string
  created_at: string
  updated_at: string
}

export interface ConnectorBindingRow {
  id: string
  platform: string
  external_type: 'group' | 'private'
  external_id: string
  session_id: string
  created_at: string
}

/** flow_states 表行（契约③当前状态，键 (session_id, commit_sha)） */
export interface FlowStateRow {
  session_id: string
  commit_sha: string
  /** 主干道状态（implement/quality-gate/request-review/receive-review/closed，见 execution/flow-state.ts） */
  state: string
  updated_at: string
}

/** flow_state_events 表行（同事务审计随写，与状态字段双保险） */
export interface FlowStateEventRow {
  id: number
  session_id: string
  commit_sha: string
  from_state: string | null
  to_state: string
  intent: string
  created_at: string
}

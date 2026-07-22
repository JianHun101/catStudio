/**
 * Repository 层统一入口。
 *
 * 使用方式：
 *   import { repo } from '../db/repository/index.js'
 *   const agent = repo.agents.getById(id)
 *
 * 初始化（在 initDb() 之后调用一次）：
 *   import { initRepository } from '../db/repository/index.js'
 *   initRepository(getDb())
 */

import type Database from 'better-sqlite3'

// 导入各实体的 setRepoDb
import { setRepoDb as setAgentsDb } from './agents.js'
import { setRepoDb as setSessionsDb } from './sessions.js'
import { setRepoDb as setMessagesDb } from './messages.js'
import { setRepoDb as setMemoriesDb } from './memories.js'
import { setRepoDb as setExecutionLogsDb } from './executionLogs.js'
import { setRepoDb as setSessionReadStateDb } from './sessionReadState.js'

/** 初始化所有 repository 模块的 db 实例（在 initDb() 之后调用） */
export function initRepository(db: Database.Database): void {
  setAgentsDb(db)
  setSessionsDb(db)
  setMessagesDb(db)
  setMemoriesDb(db)
  setExecutionLogsDb(db)
  setSessionReadStateDb(db)
}

// 按实体分组导出，调用方用 repo.agents.xxx / repo.sessions.xxx 等
export * as agents from './agents.js'
export * as sessions from './sessions.js'
export * as messages from './messages.js'
export * as memories from './memories.js'
export * as executionLogs from './executionLogs.js'
export * as sessionReadState from './sessionReadState.js'

// Row 类型也一并导出
export type {
  AgentRow,
  SessionRow,
  MessageRow,
  MessageWithAgentName,
  MemoryRow,
  ExecutionLogRow,
  SessionReadStateRow,
} from './types.js'

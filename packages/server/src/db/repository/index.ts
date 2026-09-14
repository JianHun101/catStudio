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
import { setRepoDb as setKnowledgeDb } from './knowledge.js'
import { setRepoDb as setExecutionLogsDb } from './executionLogs.js'
import { setRepoDb as setSessionReadStateDb } from './sessionReadState.js'
import { setRepoDb as setConnectorBindingsDb } from './connectorBindings.js'
import { setRepoDb as setQueryDb } from './query.js'
import { setRepoDb as setVerdictsDb } from './verdicts.js'
import { setRepoDb as setEvalScoresDb } from './evalScores.js'
import { setRepoDb as setUserFeedbackDb } from './userFeedback.js'
import { setRepoDb as setSettingsDb } from './settings.js'
import { setRepoDb as setFlowStatesDb } from './flowStates.js'
import { setRepoDb as setChunksDb } from './chunks.js'

/** 初始化所有 repository 模块的 db 实例（在 initDb() 之后调用） */
export function initRepository(db: Database.Database): void {
  setAgentsDb(db)
  setSessionsDb(db)
  setMessagesDb(db)
  setKnowledgeDb(db)
  setExecutionLogsDb(db)
  setSessionReadStateDb(db)
  setConnectorBindingsDb(db)
  setQueryDb(db)
  setVerdictsDb(db)
  setEvalScoresDb(db)
  setUserFeedbackDb(db)
  setSettingsDb(db)
  setFlowStatesDb(db)
  setChunksDb(db)
}

// 按实体分组导出，调用方用 repo.agents.xxx / repo.sessions.xxx 等
export * as agents from './agents.js'
export * as sessions from './sessions.js'
export * as messages from './messages.js'
export * as knowledge from './knowledge.js'
export * as executionLogs from './executionLogs.js'
export * as sessionReadState from './sessionReadState.js'
export * as connectorBindings from './connectorBindings.js'
export * as query from './query.js'
export * as verdicts from './verdicts.js'
export * as evalScores from './evalScores.js'
export * as userFeedback from './userFeedback.js'
export * as settings from './settings.js'
export * as flowStates from './flowStates.js'
export * as chunks from './chunks.js'

// Row 类型也一并导出
export type {
  AgentRow,
  SessionRow,
  MessageRow,
  MessageWithAgentName,
  ChunkRow,
  ExecutionLogRow,
  SessionReadStateRow,
  ConnectorBindingRow,
  EpisodeRow,
  FlowStateRow,
  FlowStateEventRow,
} from './types.js'

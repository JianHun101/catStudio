import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const db = new Database(path.join(__dirname, '..', 'data', 'cat-study.db'))

// 吐槽猫最近一次执行日志
console.log('=== 吐槽猫最近的 execution_logs ===')
const logs = db
  .prepare(
    `
  SELECT el.*, a.name as agent_name
  FROM execution_logs el
  JOIN agents a ON a.id = el.agent_id
  WHERE a.name = '吐槽猫'
  ORDER BY el.started_at DESC LIMIT 5
`
  )
  .all()
logs.forEach((l) => console.log(JSON.stringify(l, null, 2)))

// 那条 len=120 的消息详情
console.log('\n=== 消息 5be9410c 完整内容 ===')
const msg = db
  .prepare(`SELECT * FROM messages WHERE id = '5be9410c-ff05-41d2-af86-d8e19b5811fb'`)
  .get()
if (msg) {
  console.log('content:', msg.content)
  console.log('length:', msg.content?.length)
  console.log('full row:', JSON.stringify(msg, null, 2))
}

// 检查该消息的执行记录
console.log('\n=== 消息 5be9410c 的执行记录 ===')
const execLogs = db
  .prepare(
    `
  SELECT el.* FROM execution_logs el
  WHERE el.triggered_by_message_id = '5be9410c-ff05-41d2-af86-d8e19b5811fb'
`
  )
  .all()
execLogs.forEach((l) => console.log(JSON.stringify(l, null, 2)))

// 看看同一时间窗口发生了什么
console.log('\n=== 16:04 前后的所有 execution_logs ===')
const windowLogs = db
  .prepare(
    `
  SELECT el.started_at, el.ended_at, el.status, el.error_message, a.name
  FROM execution_logs el
  JOIN agents a ON a.id = el.agent_id
  WHERE el.started_at >= '2026-08-01 15:50:00'
  ORDER BY el.started_at ASC
`
  )
  .all()
windowLogs.forEach((l) => console.log(JSON.stringify(l)))

import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const db = new Database(path.join(__dirname, '..', 'data', 'cat-study.db'))

// 吐槽猫的完整配置
console.log('=== 吐槽猫 agent 配置 ===')
const agent = db.prepare(`SELECT * FROM agents WHERE name = '吐槽猫'`).get()
console.log(JSON.stringify(agent, null, 2))

// 对比店长的配置
console.log('\n=== 店长 agent 配置 ===')
const manager = db.prepare(`SELECT * FROM agents WHERE name = '店长'`).get()
console.log(JSON.stringify(manager, null, 2))

// 吐槽猫所有执行的 token 统计
console.log('\n=== 吐槽猫近期执行 token 对比 ===')
const stats = db
  .prepare(
    `
  SELECT el.started_at, el.prompt_chars, el.reply_chars,
         el.prompt_tokens, el.completion_tokens, el.status, el.error_message
  FROM execution_logs el
  WHERE el.agent_id = 'e0764bc7-8155-5fe2-b4db-c40aa00da6ea'
  ORDER BY el.started_at DESC LIMIT 10
`
  )
  .all()
stats.forEach((s) => console.log(JSON.stringify(s)))

// 检查是否有 maxTokens 相关配置
console.log('\n=== agents 表列名 ===')
const cols = db.prepare('PRAGMA table_info(agents)').all()
cols.forEach((c) => console.log(c.name, c.type))

import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const db = new Database(path.join(__dirname, '..', 'data', 'cat-study.db'))

// 吐槽猫最近消息
const rows = db
  .prepare(
    `
  SELECT m.id, m.role, m.agent_id, length(m.content) as len, m.created_at,
         substr(m.content, 1, 300) as preview,
         substr(m.content, -200) as ending
  FROM messages m
  WHERE m.content LIKE '%吐槽猫%' OR m.agent_id IN (SELECT id FROM agents WHERE name LIKE '%吐槽猫%')
  ORDER BY m.created_at DESC LIMIT 10
`
  )
  .all()

console.log('=== 吐槽猫最近消息 ===')
rows.forEach((r) => {
  console.log(
    JSON.stringify(
      {
        id: r.id,
        role: r.role,
        agent_id: r.agent_id,
        len: r.len,
        created_at: r.created_at,
        preview: r.preview,
        ending: r.ending,
      },
      null,
      2
    )
  )
  console.log('---')
})

// 查 agents 表确认吐槽猫的 id
const agents = db
  .prepare(`SELECT id, name FROM agents WHERE name LIKE '%吐%' OR name LIKE '%槽%'`)
  .all()
console.log('=== agents 匹配 ===')
agents.forEach((a) => console.log(JSON.stringify(a)))

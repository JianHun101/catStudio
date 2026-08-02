const Database = require('better-sqlite3')
const db = new Database('data/cat-study.db', { readonly: true })
console.log('=== sessions ===')
for (const r of db
  .prepare(
    'SELECT id, title, handoff_from, agent_ids, (running_summary IS NOT NULL AND length(running_summary) > 0) as has_summary FROM sessions ORDER BY updated_at DESC'
  )
  .all()) {
  console.log(JSON.stringify(r))
}
console.log('=== agents ===')
for (const r of db.prepare('SELECT id, name, role FROM agents ORDER BY name').all()) {
  console.log(JSON.stringify(r))
}
console.log('=== recent messages (last 12) ===')
for (const r of db
  .prepare(
    'SELECT session_id, role, substr(content,1,40) as content, created_at FROM messages ORDER BY created_at DESC, rowid DESC LIMIT 12'
  )
  .all()) {
  console.log(JSON.stringify(r))
}
db.close()

import { initDb, getDb } from '../packages/server/src/db/index.js'

initDb()
const db = getDb()
const rows = db.prepare('SELECT name, system_prompt FROM agents').all() as Array<{
  name: string
  system_prompt: string
}>

let allOk = true
for (const r of rows) {
  const hasAntiMirror = r.system_prompt.includes('禁止重复或模仿')
  const hasFormat = r.system_prompt.includes('禁止重复或模仿用户或其他猫的措辞和句式')
  console.log(`${r.name}: ${hasAntiMirror ? '✅' : '❌'} ${hasFormat ? '(完整)' : '(部分)'}`)
  if (!hasAntiMirror) allOk = false
}

console.log(allOk ? '\n✅ 所有 agent system prompt 已更新' : '\n❌ 有 agent 缺少反镜像规则')
process.exit(allOk ? 0 : 1)

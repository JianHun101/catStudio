/**
 * handoff-gen.mjs 端到端测试
 *
 * 模拟完整 git 工作流 → 验证生成的 .handoff-draft.md 的结构和内容。
 *
 * 用法:
 *   node scripts/handoff-gen.test.mjs
 */

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateHandoff } from './handoff-gen.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HANDOFF_SCRIPT = resolve(__dirname, 'handoff-gen.mjs')

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`  ❌ FAIL: ${msg}`)
  }
}

function assertContains(haystack, needle, msg) {
  if (haystack.includes(needle)) {
    passed++
  } else {
    failed++
    console.error(`  ❌ FAIL: ${msg}`)
    console.error(`     Expected to contain: ${JSON.stringify(needle)}`)
  }
}

function assertNotContains(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    passed++
  } else {
    failed++
    console.error(`  ❌ FAIL: ${msg}`)
    console.error(`     Should NOT contain: ${JSON.stringify(needle)}`)
  }
}

// ─── Setup: 创建临时 git 仓库 ───────────────────────────────

const TMP = join(ROOT, '.handoff-test-tmp')
if (existsSync(TMP)) {
  rmSync(TMP, { recursive: true, force: true })
}
mkdirSync(TMP, { recursive: true })

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: TMP, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

// 初始化仓库
execSync('git init', { cwd: TMP, stdio: 'pipe' })
execSync('git config user.email "test@catstudy.local"', { cwd: TMP, stdio: 'pipe' })
execSync('git config user.name "Test Cat"', { cwd: TMP, stdio: 'pipe' })

// ─── 创建模拟 cat-study 项目结构 ────────────────────────────

// 初始文件
const INITIAL_FILES = {
  'packages/shared/types.ts': `
export interface AgentConfig {
  id: string
  name: string
  avatar: string
  systemPrompt: string
  skillModules: string[]
}
`.trim(),

  'packages/server/src/db/index.ts': `
import Database from 'better-sqlite3'
export function initDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
  return db
}
`.trim(),

  'packages/server/src/skills/skill-loader.ts': `
export class SkillLoader {
  matchAndBuild(basePrompt: string, skillModules: string[], triggerText: string) {
    return { prompt: basePrompt, matchedSkills: [] }
  }
}
`.trim(),

  'packages/web/src/components/ChatPanel.vue': `
<template>
  <div class="chat-panel">
    <textarea v-model="input" placeholder="输入消息..."></textarea>
  </div>
</template>
`.trim(),

  'packages/server/src/seed-data.ts': `
export const IRON_LAWS_CODER = "代码审查：写完代码后必须生成交接文档"
`.trim(),

  '.husky/pre-push': `
#!/usr/bin/env sh
echo "pre-push check"
`.trim(),

  'scripts/dev.js': `
// dev script
console.log('starting dev...')
`.trim(),
}

for (const [fp, content] of Object.entries(INITIAL_FILES)) {
  const fullPath = join(TMP, fp)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

// 确保 .husky/pre-push 在 git 追踪中
git('add -A')
git('commit -m "feat: initial project setup"')

// ─── 第二轮改动：模拟一次复杂的多类型 commit ────────────────

// 1. 修改 skill-loader.ts（正则改动）
writeFileSync(
  join(TMP, 'packages/server/src/skills/skill-loader.ts'),
  `
export class SkillLoader {
  matchAndBuild(basePrompt: string, skillModules: string[], triggerText: string) {
    // 新增: 显式 /skillName 指令匹配
    for (const name of skillModules) {
      const regex = new RegExp('(?:^|\\\\s)/' + escapeRegex(name) + '\\\\b')
      if (regex.test(triggerText)) {
        return { prompt: basePrompt + '\\n[skill loaded]', matchedSkills: [name] }
      }
    }
    return { prompt: basePrompt, matchedSkills: [] }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
}
`.trim()
)

// 2. 修改 db/index.ts（DB migration）
writeFileSync(
  join(TMP, 'packages/server/src/db/index.ts'),
  `
import Database from 'better-sqlite3'
export function initDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_modules TEXT NOT NULL DEFAULT "[]")')
  // Migration: add skill_modules column
  try { db.exec('ALTER TABLE agents ADD COLUMN skill_modules TEXT NOT NULL DEFAULT "[]"') } catch {}
  return db
}
`.trim()
)

// 3. 修改 ChatPanel.vue（前端组件改动）
writeFileSync(
  join(TMP, 'packages/web/src/components/ChatPanel.vue'),
  `
<template>
  <div class="chat-panel">
    <textarea v-model="input" placeholder="输入消息...（输入 / 触发技能）"></textarea>
    <div v-if="skillDropdown" class="skill-dropdown">
      <div v-for="s in skills" :key="s.name" @click="selectSkill(s)">{{ s.name }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
const skills = ref([])
const skillDropdown = ref(false)
let abortController: AbortController | null = null

async function fetchSkills() {
  abortController = new AbortController()
  const res = await fetch('/api/skills', { signal: abortController.signal })
  skills.value = await res.json()
}

onMounted(() => fetchSkills())
onUnmounted(() => abortController?.abort())

function selectSkill(s: any) {
  skillDropdown.value = false
}
</script>
`.trim()
)

// 4. 修改 seed-data.ts（LLM/Prompt 变更）
writeFileSync(
  join(TMP, 'packages/server/src/seed-data.ts'),
  `
export const IRON_LAWS_CODER = "代码审查：写完代码后必须生成交接文档并 @吐槽猫 review。不论改动大小。"
export const IRON_LAWS_REVIEWER = "审查铁律：逐项检查 Checklist，行首独占一行 @作者 告知结果。"
`.trim()
)

// 5. 修改 pre-push hook（Shell 脚本改动）
writeFileSync(
  join(TMP, '.husky/pre-push'),
  `
#!/usr/bin/env sh
# pre-push 审查门禁
GATE_FILE=".push-gate"
if [ ! -f "$GATE_FILE" ]; then
  echo "阻断：未找到 .push-gate"
  exit 1
fi
LAST_REVIEWED=$(cat "$GATE_FILE" | tr -d '[:space:]')
if ! echo "$LAST_REVIEWED" | grep -qE '^[0-9a-f]{40}$'; then
  echo "阻断：.push-gate 内容无效"
  exit 1
fi
`.trim()
)

// 6. 新文件（API endpoint）
const routesDir = join(TMP, 'packages/server/src/routes')
mkdirSync(routesDir, { recursive: true })
writeFileSync(
  join(routesDir, 'skills.ts'),
  `
import type { FastifyInstance } from 'fastify'
export async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async (req, reply) => {
    const { agentIds } = req.query as any
    const skills = await loadSkills(agentIds)
    return reply.send(skills)
  })
}
`.trim()
)

// 7. 修改 types.ts（类型变更）
writeFileSync(
  join(TMP, 'packages/shared/types.ts'),
  `
export interface AgentConfig {
  id: string
  name: string
  avatar: string
  systemPrompt: string
  skillModules: string[] | null
  effortLevel?: 'low' | 'medium' | 'high' | 'max'
  createdAt?: string
}
`.trim()
)

git('add -A')
git('commit -m "feat: skill system overhaul — slash commands + DB migration + frontend dropdown"')

// ─── 运行测试 ───────────────────────────────────────────────

console.log('\n🧪 handoff-gen.mjs 端到端测试\n')

// ═══ 测试组 1: generateHandoff() API ═══════════════════════

console.log('📦 测试组 1: generateHandoff() API')

const result = generateHandoff({ cwd: TMP })

assert(result !== null, '应返回非空内容')
assert(typeof result === 'string', '返回类型应为 string')

// 验证五个必需段落都存在
assertContains(result, '# 工作交接', '应包含标题')
assertContains(result, '## 1. What — 改了什么', '应包含 What 段')
assertContains(result, '## 2. Why — 关键决策', '应包含 Why 段')
assertContains(result, '## 3. Tradeoff — 放弃了什么', '应包含 Tradeoff 段')
assertContains(result, '## 4. Open Questions — 不确定的点', '应包含 OQ 段')
assertContains(result, '## 5. Reviewer Checklist', '应包含 Checklist 段')

// 验证 Why/Tradeoff/OQ 有占位符
assertContains(result, 'TODO: 补填', 'Why 段应有 TODO 占位符')

// 验证末尾有 @吐槽猫
assertContains(result, '@吐槽猫 请审查以上改动。', '末尾应有 @吐槽猫')

console.log('')

// ═══ 测试组 2: What 段 — 文件清单 ═════════════════════════

console.log('📦 测试组 2: What 段')

// 验证改动的文件都被记录了
assertContains(result, 'packages/shared/types.ts', '应记录 types.ts 改动')
assertContains(result, 'packages/server/src/db/index.ts', '应记录 db/index.ts 改动')
assertContains(result, 'packages/server/src/skills/skill-loader.ts', '应记录 skill-loader.ts 改动')
assertContains(result, 'packages/web/src/components/ChatPanel.vue', '应记录 ChatPanel.vue 改动')
assertContains(result, 'packages/server/src/seed-data.ts', '应记录 seed-data.ts 改动')
assertContains(result, '.husky/pre-push', '应记录 pre-push 改动')
assertContains(result, 'packages/server/src/routes/skills.ts', '应记录 skills.ts（新文件）')

// 验证状态标记
assertContains(result, '新文件', '应包含状态标记')

// 验证 commit 信息
assertContains(result, 'Commit:', '应包含 commit hash')
assertContains(result, 'Message:', '应包含 commit message')
assertContains(result, 'skill system overhaul', 'commit message 应被记录')

// 验证分层排序提示
assertContains(result, '文件按分层排序', '应包含分层排序说明')

console.log('')

// ═══ 测试组 3: Checklist — 改动类型检测 ═════════════════════

console.log('📦 测试组 3: Reviewer Checklist')

// 正则匹配 — skill-loader 含 new RegExp + escapeRegex
assertContains(result, '正则 / 字符串匹配', '应检测到正则改动')
assertContains(result, 'CJK 字符边界', '正则检查点应含 CJK 边界')
assertContains(result, 'ReDoS', '正则检查点应含 ReDoS')

// DB migration — db/index.ts 含 ALTER TABLE
assertContains(result, 'DB migration', '应检测到 DB migration')
assertContains(result, '迁移是否幂等', 'DB 检查点应含幂等性')

// API endpoint — routes/skills.ts 新文件
assertContains(result, 'API endpoint', '应检测到 API endpoint')
assertContains(result, '参数校验是否完整', 'API 检查点应含参数校验')

// 前端组件 — ChatPanel.vue
assertContains(result, '前端组件', '应检测到前端组件改动')
assertContains(result, 'AbortController', '前端检查点应含 AbortController')

// LLM/Prompt — seed-data.ts
assertContains(result, 'LLM / Prompt 变更', '应检测到 LLM/Prompt 变更')
assertContains(result, 'pnpm seed', 'LLM 检查点应含 seed 提示')

// Shell 脚本 — .husky/pre-push
assertContains(result, 'Shell 脚本', '应检测到 Shell 脚本改动')
assertContains(result, 'Windows Git Bash', 'Shell 检查点应含 Windows 兼容性')

// 类型变更 — shared/types.ts
assertContains(result, '类型 / 接口变更', '应检测到类型变更')

console.log('')

// ═══ 测试组 4: cat-study 项目特有检查点 ═════════════════════

console.log('📦 测试组 4: cat-study 项目特有检查点')

// 有 skillModules 相关改动 → 应触发相关检查
assertContains(result, '`AGENT_SKILL_MODULES` 硬编码', '应含 AGENT_SKILL_MODULES 检查点')

// 有 socketio/connectors 相关吗？这次没改 socketio.ts 实际文件，
// 但 skill-loader 在 server/src/skills/ 而非 server/src/connectors/
// 所以不应该触发 socketio 特有检查
assertNotContains(
  result,
  '`retractionRequests`',
  '无 socketio 改动时不应触发 retractionRequests 检查'
)

console.log('')

// ═══ 测试组 5: CLI 入口（通过子进程） ════════════════════════

console.log('📦 测试组 5: CLI 入口')

try {
  execSync(`node ${HANDOFF_SCRIPT} --cwd "${TMP}" --no-post`, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10000,
  })

  // 验证文件被写入
  const draftPath = join(TMP, '.handoff-draft.md')
  assert(existsSync(draftPath), '.handoff-draft.md 应被写入磁盘')

  // 验证文件内容和 API 返回一致
  const fileContent = readFileSync(draftPath, 'utf-8')
  assert(fileContent === result, '磁盘文件内容应与 API 返回值一致')
} catch (err) {
  console.error(`  ❌ CLI 执行失败: ${err.message}`)
  failed++
}

console.log('')

// ═══ 测试组 6: 边界情况 ═════════════════════════════════════

console.log('📦 测试组 6: 边界情况')

// 6a: 无改动的仓库
const EMPTY_TMP = join(ROOT, '.handoff-test-empty')
if (existsSync(EMPTY_TMP)) rmSync(EMPTY_TMP, { recursive: true, force: true })
mkdirSync(EMPTY_TMP, { recursive: true })
execSync('git init', { cwd: EMPTY_TMP, stdio: 'pipe' })
execSync('git config user.email "test@catstudy.local"', { cwd: EMPTY_TMP, stdio: 'pipe' })
execSync('git config user.name "Test Cat"', { cwd: EMPTY_TMP, stdio: 'pipe' })

// 空仓库（无 commit）
try {
  const emptyResult = generateHandoff({ cwd: EMPTY_TMP })
  assert(emptyResult === null, '无 commit 的仓库应返回 null')
} catch (err) {
  // generateHandoff 内 execSync git rev-parse HEAD 会抛异常
  // 但我们的实现里用了 try/catch 和 safeGit
  console.error(`  边界测试异常: ${err.message}`)
}

// 6b: catstudy 自动快照 commit → 应跳过
const SNAPSHOT_TMP = join(ROOT, '.handoff-test-snapshot')
if (existsSync(SNAPSHOT_TMP)) rmSync(SNAPSHOT_TMP, { recursive: true, force: true })
mkdirSync(SNAPSHOT_TMP, { recursive: true })
execSync('git init', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })
execSync('git config user.email "test@catstudy.local"', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })
execSync('git config user.name "Test Cat"', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })

// 先建一个正常 commit 作为基准
const snapFile = join(SNAPSHOT_TMP, 'test.txt')
writeFileSync(snapFile, 'initial', 'utf-8')
execSync('git add -A', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })
execSync('git commit -m "feat: initial"', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })

// 修改文件
writeFileSync(snapFile, 'updated', 'utf-8')
execSync('git add -A', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })

// 模拟 catstudy 自动快照 commit
execSync('git commit -m "catstudy [6cfecca8-ba78-4039-a12c-71313afd29cd]"', {
  cwd: SNAPSHOT_TMP,
  stdio: 'pipe',
})

// verify: generateHandoff 应返回 null（过滤 catstudy 快照）
{
  const snapResult = generateHandoff({ cwd: SNAPSHOT_TMP })
  assert(snapResult === null, 'catstudy [uuid] 格式的 commit 应被过滤（返回 null）')
}

// 6c: 普通 commit message 含 "catstudy" 但不是快照格式 → 不应被过滤
writeFileSync(snapFile, 'updated2', 'utf-8')
execSync('git add -A', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })
execSync('git commit -m "fix: handle catstudy edge case in retraction logic"', {
  cwd: SNAPSHOT_TMP,
  stdio: 'pipe',
})

{
  const normalResult = generateHandoff({ cwd: SNAPSHOT_TMP })
  assert(normalResult !== null, '普通 commit message 含 catstudy 但不匹配快照格式时，不应被过滤')
}

rmSync(SNAPSHOT_TMP, { recursive: true, force: true })
rmSync(EMPTY_TMP, { recursive: true, force: true })

console.log('')

// ═══ 测试组 7: 格式细节 ═════════════════════════════════════

console.log('📦 测试组 7: 格式细节')

// Why/Tradeoff/OQ 应该是注释占位符，不是 AI 猜测的假内容
// 占位符用 HTML 注释格式
assertContains(result, '<!-- TODO:', 'Why 段应为 HTML 注释格式的占位符')

// Checklist 应该用 - [ ] markdown 格式
assertContains(result, '- [ ]', 'Checklist 应为 markdown checkbox 格式')

// 不应包含未替换的模板变量
assertNotContains(result, '{{', '不应有未替换的模板变量')
assertNotContains(result, '${', '不应有未替换的模板变量')

console.log('')

// ═══ 测试组 8: --no-post 标志 ═══════════════════════════════════

console.log('📦 测试组 8: --no-post 标志')

// 8a: --no-post 时不尝试连接服务器，文件留在磁盘
const NO_POST_TMP = join(ROOT, '.handoff-test-nopost')
if (existsSync(NO_POST_TMP)) rmSync(NO_POST_TMP, { recursive: true, force: true })
mkdirSync(NO_POST_TMP, { recursive: true })

// 创建一个简单的 git 仓库
execSync('git init', { cwd: NO_POST_TMP, stdio: 'pipe' })
execSync('git config user.email "test@catstudy.local"', { cwd: NO_POST_TMP, stdio: 'pipe' })
execSync('git config user.name "Test Cat"', { cwd: NO_POST_TMP, stdio: 'pipe' })

// 创建文件并提交
const noPostFile = join(NO_POST_TMP, 'test.ts')
mkdirSync(dirname(noPostFile), { recursive: true })
writeFileSync(noPostFile, 'export const x = 1', 'utf-8')
execSync('git add -A', { cwd: NO_POST_TMP, stdio: 'pipe' })
execSync('git commit -m "test: no-post flag"', { cwd: NO_POST_TMP, stdio: 'pipe' })

// 修改文件并第二次提交（让 diff 非空）
writeFileSync(noPostFile, 'export const x = 2', 'utf-8')
execSync('git add -A', { cwd: NO_POST_TMP, stdio: 'pipe' })
execSync('git commit -m "test: second commit for diff"', { cwd: NO_POST_TMP, stdio: 'pipe' })

try {
  const output = execSync(`node ${HANDOFF_SCRIPT} --cwd "${NO_POST_TMP}" --no-post`, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10000,
  })

  // 验证文件留在磁盘
  const draftPath = join(NO_POST_TMP, '.handoff-draft.md')
  assert(existsSync(draftPath), '--no-post: .handoff-draft.md 应保留在磁盘')
  assertNotContains(output, 'cat-study', '--no-post 时不应尝试连接 cat-study')
  console.log('  8a: --no-post 文件保留 ✅')
} catch (err) {
  console.error(`  ❌ --no-post 测试失败: ${err.message}`)
  failed++
}

// 清理
rmSync(NO_POST_TMP, { recursive: true, force: true })

console.log('')

// ─── Cleanup ────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true })

// ─── 结果汇总 ───────────────────────────────────────────────

console.log('═'.repeat(50))
console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`)
console.log('═'.repeat(50))

if (failed > 0) {
  process.exit(1)
}

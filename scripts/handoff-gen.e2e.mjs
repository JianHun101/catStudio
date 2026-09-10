/**
 * handoff-gen.mjs 端到端测试
 *
 * 模拟完整 git 工作流 → 验证生成的 .handoff-draft.md 的结构和内容。
 *
 * 用法:
 *   node scripts/handoff-gen.e2e.mjs
 */

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateHandoff,
  extractCommitUuid,
  resolveCommitSessionId,
  resolveExecutorName,
  resolveExecutionCommitSpan,
  probeAttribution,
  decideHookDelivery,
  tryPostToCatstudy,
  buildHandoffMessage,
  runHandoff,
  readState,
  writeState,
} from './handoff-gen.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HANDOFF_SCRIPT = resolve(__dirname, 'handoff-gen.mjs')

// 落库验证轮询预算调小（默认 10s）——测试不需要真实等满预算
process.env.HANDOFF_VERIFY_MS = '500'

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

/** 启动一个临时 HTTP stub server（127.0.0.1 随机端口），用于测试反查投递目标 */
function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
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
export const IRON_LAWS_CODER = "代码审查：提交后由作者按 request-review 自行发起审查请求。"
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

// 验证末尾不包含硬编码的 @吐槽猫（路由由 POST wrapper 指令控制，不嵌入文档）
assertNotContains(result, '@吐槽猫 请审查以上改动。', '文档不应包含硬编码的 @吐槽猫')

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

// 6b: catstudy 自动快照 commit → 有代码改动时不应跳过，应正常生成 handoff
// （死循环已由 git-utils.ts gitCommit() 自然阻断——无改动时 commit 失败不触发 hook）
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

// 修改文件（模拟 agent 代码改动）
writeFileSync(snapFile, 'updated', 'utf-8')
execSync('git add -A', { cwd: SNAPSHOT_TMP, stdio: 'pipe' })

// 模拟 catstudy 自动快照 commit（agent 有实质代码改动）
execSync('git commit -m "catstudy [6cfecca8-ba78-4039-a12c-71313afd29cd]"', {
  cwd: SNAPSHOT_TMP,
  stdio: 'pipe',
})

// verify: 有代码改动的 catstudy commit 应正常生成 handoff（不再跳过）
{
  const snapResult = generateHandoff({ cwd: SNAPSHOT_TMP })
  assert(snapResult !== null, 'catstudy [uuid] 有代码改动时应生成 handoff')
  assert(snapResult.includes('工作交接'), 'handoff 应包含标题')
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

// ═══ 测试组 9: 参数错误（--range 已移除 / 未知参数拒绝） ═══════

console.log('📦 测试组 9: 参数错误（--range 已移除 / 未知参数拒绝）')

/**
 * 跑 CLI 且**容忍非零退出**——返回 { code, output }。
 *
 * 参数错误现在是 exit 非 0（必改 2：参数错误 = 调用方错误，不是运行时故障，
 * 后者才维持 exit 0 以免阻断 commit）。execSync 对非零退出会抛，输出需从
 * err.stdout 取回（命令带 2>&1，stderr 已并入 stdout）。
 */
function runCliExpectExit(args, opts = {}) {
  try {
    const output = execSync(`node ${HANDOFF_SCRIPT} ${args} 2>&1`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
      ...opts,
    }).toString()
    return { code: 0, output }
  } catch (err) {
    return { code: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// 构建: 3 个 commit（基线 → 改 a.ts → 新增 b.ts）
const RANGE_TMP = join(ROOT, '.handoff-test-range')
if (existsSync(RANGE_TMP)) rmSync(RANGE_TMP, { recursive: true, force: true })
mkdirSync(RANGE_TMP, { recursive: true })
execSync('git init', { cwd: RANGE_TMP, stdio: 'pipe' })
execSync('git config user.email "test@catstudy.local"', { cwd: RANGE_TMP, stdio: 'pipe' })
execSync('git config user.name "Test Cat"', { cwd: RANGE_TMP, stdio: 'pipe' })

const rangeFile = join(RANGE_TMP, 'a.ts')
writeFileSync(rangeFile, 'export const a = 1', 'utf-8')
execSync('git add -A', { cwd: RANGE_TMP, stdio: 'pipe' })
execSync('git commit -m "feat: baseline"', { cwd: RANGE_TMP, stdio: 'pipe' })

writeFileSync(rangeFile, 'export const a = 2', 'utf-8')
execSync('git add -A', { cwd: RANGE_TMP, stdio: 'pipe' })
execSync('git commit -m "feat: change a"', { cwd: RANGE_TMP, stdio: 'pipe' })

writeFileSync(join(RANGE_TMP, 'b.ts'), 'export const b = 1', 'utf-8')
execSync('git add -A', { cwd: RANGE_TMP, stdio: 'pipe' })
execSync('git commit -m "feat: add b"', { cwd: RANGE_TMP, stdio: 'pipe' })

function rangeGit(cmd) {
  return execSync(`git ${cmd}`, { cwd: RANGE_TMP, encoding: 'utf-8', stdio: 'pipe' }).trim()
}
const rangeBase = rangeGit('rev-parse HEAD~2')
const rangeHead = rangeGit('rev-parse HEAD')

// 9a: = 形式 --range=X..Y（旧 pre-push 调用方式）→ 报错提示已移除，不产生草稿
// 注：此处曾断言「参数错误 exit 0」，必改 2 裁定参数错误一律 exit 非 0（见下 9c）
const r9a = runCliExpectExit(`--cwd "${RANGE_TMP}" --no-post --range="${rangeBase}..${rangeHead}"`)
assert(r9a.code !== 0, '参数错误应 exit 非 0（必改 2：参数错误 = 调用方错误）')
assertContains(r9a.output, '已移除', '--range 应提示已移除（Fix C）')
assert(
  !existsSync(join(RANGE_TMP, '.handoff-draft.md')),
  '--range 报错后不应生成草稿（参数错误先于生成）'
)
console.log('  9a: = 形式 --range 报错提示已移除 ✅')

// 9b: 空格形式 --range X..Y 同样报错
const r9b = runCliExpectExit(`--cwd "${RANGE_TMP}" --no-post --range ${rangeBase}..${rangeHead}`)
assert(r9b.code !== 0, '空格形式 --range 也应 exit 非 0')
assertContains(r9b.output, '已移除', '空格形式 --range 也应提示已移除')
console.log('  9b: 空格形式 --range 报错提示已移除 ✅')

// 9c: 未知参数拒绝（必改 2——静默忽略的后果是「换一条路继续干」）
// 回归证据：修复前 `node scripts/handoff-gen.mjs --help` 静默落进**无参 post-commit
// 投递路径**并真发出一条消息（2026-09-10 实证 cdc476ba）。
// 用「无 --no-post」形态跑：修复若退化，它会**生成草稿**（post-commit 路径先写草稿、
// 仅投递成功才清理），故「无草稿」正是「没进入投递路径」的判据。CATSTUDY_URL 指向
// 必然拒连的端口，且清掉 CATSTUDY_SESSION_ID——退化时也不污染任何真实会话。
{
  const env = { ...process.env, CATSTUDY_URL: 'http://127.0.0.1:1' }
  delete env.CATSTUDY_SESSION_ID
  const r9c = runCliExpectExit(`--cwd "${RANGE_TMP}" --help`, { env })
  assert(r9c.code !== 0, '未知参数 --help 应 exit 非 0')
  assertContains(r9c.output, '未知参数', '--help 应报「未知参数」')
  assertContains(r9c.output, 'no-post', '报错应列出已知 flag（可自助纠错）')
  assert(
    !existsSync(join(RANGE_TMP, '.handoff-draft.md')),
    '未知参数不应生成草稿——即未进入 post-commit 投递路径'
  )
  const r9d = runCliExpectExit(`--cwd "${RANGE_TMP}" --no-postt`, { env })
  assert(r9d.code !== 0, '拼错的 flag 应 exit 非 0')
}
console.log('  9c: 未知参数拒绝（--help / 拼错 flag 均不投递） ✅')

rmSync(RANGE_TMP, { recursive: true, force: true })

console.log('')

// ═══ 测试组 10: commit uuid 反查会话（handoff 投递目标） ═════════════

console.log('📦 测试组 10: commit uuid 反查会话')

// 10a: extractCommitUuid 纯函数
{
  const uuid = '6cfecca8-ba78-4039-a12c-71313afd29cd'
  assert(extractCommitUuid(`catstudy [${uuid}]`) === uuid, 'catstudy [uuid] 应提取 uuid')
  assert(
    extractCommitUuid(`catstudy [${uuid}]\nmore lines`) === uuid,
    '多行 commit message 应提取第一行 uuid'
  )
  assert(extractCommitUuid('fix: handle catstudy edge case') === null, '普通 commit 应返回 null')
  assert(extractCommitUuid('catstudy [not-a-uuid]') === null, '非 uuid 格式应返回 null')
  assert(extractCommitUuid(null) === null, 'null 输入应返回 null')
  console.log('  10a: extractCommitUuid 纯函数 ✅')
}

// 10b/10c/10d: resolveCommitSessionId 反查（stub server）
{
  const uuid = '6cfecca8-ba78-4039-a12c-71313afd29cd'
  let hits = []
  const { server, port } = await startStubServer((req, res) => {
    hits.push(req.url)
    if (req.url === `/api/messages/${uuid}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-debug-1', role: 'user' }))
    } else if (req.url.startsWith(`/api/messages/${uuid}/executor`)) {
      // startsWith：兼容 ?commit=<sha> query（commit_hash 精确匹配反查）
      // taskId = 命中执行行的 trace_id（E3 接线：投递 payload 携带源链 task_id）
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ agentId: 'agent-ds', agentName: 'ds猫', taskId: 'trace-10e' }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })
  const serverUrl = `http://127.0.0.1:${port}`

  const LOOKUP_TMP = join(ROOT, '.handoff-test-lookup')
  if (existsSync(LOOKUP_TMP)) rmSync(LOOKUP_TMP, { recursive: true, force: true })
  mkdirSync(LOOKUP_TMP, { recursive: true })
  execSync('git init', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  const lookupFile = join(LOOKUP_TMP, 'a.txt')
  writeFileSync(lookupFile, '1', 'utf-8')
  execSync('git add -A', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid}]"`, { cwd: LOOKUP_TMP, stdio: 'pipe' })

  // 10b: 命中 → 返回消息所在会话
  hits = []
  const sid = await resolveCommitSessionId(LOOKUP_TMP, serverUrl)
  assert(sid === 'session-debug-1', 'uuid 反查应返回消息所在会话')
  assert(hits.includes(`/api/messages/${uuid}`), '应请求反查 API')
  console.log('  10b: uuid 反查命中 ✅')

  // 10c: 消息已删（404）→ null + 明确报错，调用方不投递（不做降级兜底）
  writeFileSync(lookupFile, '2', 'utf-8')
  execSync('git add -A', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync('git commit -m "catstudy [aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]"', {
    cwd: LOOKUP_TMP,
    stdio: 'pipe',
  })
  const sid404 = await resolveCommitSessionId(LOOKUP_TMP, serverUrl)
  assert(sid404 === null, '404 时应返回 null（报错不投递，禁止降级兜底）')
  console.log('  10c: 404 报错不投递 ✅')

  // 10d: 手动 commit（无 uuid）→ null 且不发请求（报错不投递）
  writeFileSync(lookupFile, '3', 'utf-8')
  execSync('git add -A', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync('git commit -m "fix: manual commit"', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  hits = []
  const sidManual = await resolveCommitSessionId(LOOKUP_TMP, serverUrl)
  assert(sidManual === null, '手动 commit（无 uuid）应返回 null')
  assert(hits.length === 0, '无 uuid 时不应发起反查请求')
  console.log('  10d: 手动 commit 报错不投递 ✅')

  // 10e: 实施者反查（execution_logs）→ 命中返回 { agentName, taskId }，404 兜底 null
  hits = []
  const executorHit = await resolveExecutorName(serverUrl, uuid)
  assert(executorHit?.agentName === 'ds猫', '实施者反查命中应返回 agent 名')
  assert(executorHit?.taskId === 'trace-10e', 'E3 接线：taskId = 命中执行行的 trace_id')
  assert(hits.includes(`/api/messages/${uuid}/executor`), '应请求实施者反查 API')
  const executorMiss = await resolveExecutorName(serverUrl, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert(executorMiss === null, '无执行记录（404）应返回 null，调用方兜底店长')
  console.log('  10e: 实施者反查命中/404 兜底 ✅')

  // 10g: 实施者反查带 commit sha → URL 带 ?commit= query（commit_hash 精确匹配）
  hits = []
  const commitSha = 'a'.repeat(40)
  const executorWithSha = await resolveExecutorName(serverUrl, uuid, commitSha)
  assert(executorWithSha?.agentName === 'ds猫', '带 commit sha 反查应命中 agent 名')
  assert(
    hits.includes(`/api/messages/${uuid}/executor?commit=${commitSha}`),
    '应带 ?commit= query 请求实施者反查 API'
  )
  // 不带 sha 时 URL 保持无 query（老调用/e2e 兼容）
  hits = []
  await resolveExecutorName(serverUrl, uuid)
  assert(
    hits.includes(`/api/messages/${uuid}/executor`) && !hits.some((u) => u.includes('?')),
    '不带 sha 时 URL 应无 query'
  )
  console.log('  10g: 实施者反查带 commit sha → ?commit= query ✅')

  // 10f: buildHandoffMessage 动态补填人——命中传实施者名，缺省兜底店长
  const msgImpl = buildHandoffMessage('# 文档', 'ds猫')
  assert(msgImpl.startsWith('@ds猫 请补填以下交接文档'), '应 @实施者 补填')
  const msgDefault = buildHandoffMessage('# 文档')
  assert(msgDefault.startsWith('@店长 请补填以下交接文档'), '缺省应兜底 @店长 补填')
  console.log('  10f: buildHandoffMessage 动态补填人 ✅')

  rmSync(LOOKUP_TMP, { recursive: true, force: true })
  server.close()
}

console.log('')

// ═══ 测试组 11: 投递瞬态重试（连接失败 → 延迟重试 → 成功） ═════════

console.log('📦 测试组 11: 投递瞬态重试')

{
  const uuid = '77c0e5b4-3d14-4f66-bc8e-11ab22cd33dd'

  // git 仓库：commit 带 catstudy [uuid] → 反查可命中
  const RETRY_TMP = join(ROOT, '.handoff-test-retry')
  if (existsSync(RETRY_TMP)) rmSync(RETRY_TMP, { recursive: true, force: true })
  mkdirSync(RETRY_TMP, { recursive: true })
  execSync('git init', { cwd: RETRY_TMP, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: RETRY_TMP, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: RETRY_TMP, stdio: 'pipe' })
  writeFileSync(join(RETRY_TMP, 'a.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: RETRY_TMP, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid}]"`, { cwd: RETRY_TMP, stdio: 'pipe' })

  // 11a: 瞬态失败（socket destroy）→ 2s 重试 → 第三次成功
  let postHits = 0
  let destroyed = 0
  let lastPostBody = null
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-debug-1', role: 'user' }))
      return
    }
    // E3 接线：executor 反查返回 taskId（= 命中执行行的 trace_id），投递 body 应携带
    if (req.url.startsWith(`/api/messages/${uuid}/executor`) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ agentId: 'agent-ds', agentName: 'ds猫', taskId: 'trace-11a' }))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        lastPostBody = body
      })
      // 前两次模拟瞬态连接失败（连接被 reset → fetch 抛错 → transient）
      if (postHits <= 2) {
        destroyed++
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'm1', sessionId: 'session-debug-1' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const serverUrl = `http://127.0.0.1:${port}`

  const prevUrl = process.env.CATSTUDY_URL
  const prevSid = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = serverUrl
  delete process.env.CATSTUDY_SESSION_ID
  const ok = await tryPostToCatstudy('# 测试交接文档\n内容', RETRY_TMP)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(ok === 'ok', '瞬态失败重试后应投递成功')
  assert(postHits === 3, `应共发起 3 次 POST（首次+2 次重试，实际 ${postHits}）`)
  assert(destroyed === 2, '前两次应为瞬态失败')
  const deliveredBody = lastPostBody ? JSON.parse(lastPostBody) : null
  assert(
    deliveredBody?.taskId === 'trace-11a',
    'E3 接线：投递 body 应携带源链 taskId（executor 反查同源）'
  )
  console.log('  11a: 瞬态失败自动重试（2 次后成功）✅')

  // 11b: 4xx 确定性失败不重试（CATSTUDY_SESSION_ID 显式指定，跳过反查）
  let postHits400 = 0
  const { server: server400, port: port400 } = await startStubServer((req, res) => {
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits400++
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  process.env.CATSTUDY_URL = `http://127.0.0.1:${port400}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const ok400 = await tryPostToCatstudy('# 测试', RETRY_TMP)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(ok400 === 'fatal', '4xx 确定性失败应返回 fatal')
  assert(postHits400 === 1, `4xx 不应重试（实际 ${postHits400} 次）`)
  console.log('  11b: 4xx 确定性失败不重试 ✅')

  // 11c: verdict 已审 ✅（approved=true）→ 跳过补填投递（风暴根治方向 1）
  const headSha = execSync('git rev-parse HEAD', { cwd: RETRY_TMP, stdio: 'pipe' })
    .toString()
    .trim()
  let postHitsApproved = 0
  let verdictHitsApproved = 0
  const { server: serverApproved, port: portApproved } = await startStubServer((req, res) => {
    if (req.url === `/api/handoff/verdict?sha=${headSha}`) {
      verdictHitsApproved++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, approved: true }))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsApproved++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  process.env.CATSTUDY_URL = `http://127.0.0.1:${portApproved}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okApproved = await tryPostToCatstudy('# 测试交接文档\n内容', RETRY_TMP)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(okApproved === 'ok', 'verdict 命中 approve 应视为投递成功（返回 ok）')
  assert(
    postHitsApproved === 0,
    `已审 ✅ 的 commit 不应投递补填（实际 ${postHitsApproved} 次 POST）`
  )
  assert(verdictHitsApproved >= 1, '应请求 verdict 反查 API')
  console.log('  11c: verdict approved=true → 跳过补填投递 ✅')

  // 11d: verdict approved=false（未审/suggest/reject）→ 照常投递
  let postHitsNotApproved = 0
  const { server: serverNotApproved, port: portNotApproved } = await startStubServer((req, res) => {
    if (req.url === `/api/handoff/verdict?sha=${headSha}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, approved: false }))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsNotApproved++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  process.env.CATSTUDY_URL = `http://127.0.0.1:${portNotApproved}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okNotApproved = await tryPostToCatstudy('# 测试交接文档\n内容', RETRY_TMP)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(okNotApproved === 'ok', 'approved=false 应照常投递成功')
  assert(postHitsNotApproved === 1, `approved=false 应投递 1 次（实际 ${postHitsNotApproved} 次）`)
  console.log('  11d: verdict approved=false → 照常投递 ✅')

  // 11e: verdict 端点连接中断（fetch 抛错）→ 静默降级照常投递（宁多投不丢补填）
  let postHitsDown = 0
  let verdictDestroyed = 0
  const { server: serverDown, port: portDown } = await startStubServer((req, res) => {
    if (req.url.startsWith('/api/handoff/verdict')) {
      verdictDestroyed++
      req.socket.destroy()
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsDown++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  process.env.CATSTUDY_URL = `http://127.0.0.1:${portDown}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okDown = await tryPostToCatstudy('# 测试交接文档\n内容', RETRY_TMP)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(okDown === 'ok', 'verdict 端点不可达应降级照常投递')
  assert(verdictDestroyed >= 1, '应尝试请求 verdict 反查 API')
  assert(postHitsDown === 1, `verdict 失败不应阻塞投递（实际 ${postHitsDown} 次 POST）`)
  console.log('  11e: verdict 端点不可达 → 降级照常投递 ✅')

  rmSync(RETRY_TMP, { recursive: true, force: true })
  server.close()
  server400.close()
  serverApproved.close()
  serverNotApproved.close()
  serverDown.close()
}

console.log('')

// ═══ 测试组 12: 投递去重（同一份文档只投一次） ═══════════════

console.log('📦 测试组 12: 投递去重')

{
  const uuid = 'aabbccdd-1122-3344-5566-778899aabbcc'
  const DEDUP_TMP = join(ROOT, '.handoff-test-dedup')
  if (existsSync(DEDUP_TMP)) rmSync(DEDUP_TMP, { recursive: true, force: true })
  mkdirSync(DEDUP_TMP, { recursive: true })
  execSync('git init', { cwd: DEDUP_TMP, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: DEDUP_TMP, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: DEDUP_TMP, stdio: 'pipe' })
  writeFileSync(join(DEDUP_TMP, 'a.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: DEDUP_TMP, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid}]"`, { cwd: DEDUP_TMP, stdio: 'pipe' })

  // 12a: 目标会话已有相同内容（包裹消息）→ 跳过 POST（视为成功，草稿可清理）
  let postHitsDup = 0
  let listHitsDup = 0
  const { server: serverDup, port: portDup } = await startStubServer((req, res) => {
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      listHitsDup++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 会话里已有一条内容完全相同的补填请求（锚点是实际投递的包裹消息）
      res.end(
        JSON.stringify([
          { id: 'm-old', role: 'user', content: buildHandoffMessage('# 测试交接文档\n内容') },
        ])
      )
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsDup++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  const prevUrlDup = process.env.CATSTUDY_URL
  const prevSidDup = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = `http://127.0.0.1:${portDup}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okDup = await tryPostToCatstudy('# 测试交接文档\n内容', DEDUP_TMP)
  if (prevUrlDup === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrlDup
  if (prevSidDup !== undefined) process.env.CATSTUDY_SESSION_ID = prevSidDup

  assert(okDup === 'ok', '去重命中时应视为投递成功（返回 ok，草稿可清理）')
  assert(postHitsDup === 0, `内容相同的文档不应重复 POST（实际 ${postHitsDup} 次）`)
  assert(listHitsDup >= 1, '去重检查应拉取会话消息列表')
  console.log('  12a: 会话已有相同内容 → 跳过 POST ✅')

  serverDup.close()

  // 12b: 会话中无相同内容 → 正常 POST 一次
  let postHitsFresh = 0
  const { server: serverFresh, port: portFresh } = await startStubServer((req, res) => {
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([])) // 空会话
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsFresh++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  process.env.CATSTUDY_URL = `http://127.0.0.1:${portFresh}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okFresh = await tryPostToCatstudy('# 测试交接文档\n内容', DEDUP_TMP)
  if (prevUrlDup === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrlDup
  if (prevSidDup !== undefined) process.env.CATSTUDY_SESSION_ID = prevSidDup

  assert(okFresh === 'ok', '无相同内容时应投递成功')
  assert(postHitsFresh === 1, `应恰好 POST 1 次（实际 ${postHitsFresh} 次）`)
  console.log('  12b: 会话无相同内容 → 正常 POST ✅')

  serverFresh.close()

  // 12c: 内容不同的文档不被误挡 → 正常 POST
  let postHitsRange = 0
  const { server: serverRange, port: portRange } = await startStubServer((req, res) => {
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          { id: 'm-old', role: 'user', content: buildHandoffMessage('# 单 commit 版文档') },
        ])
      )
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHitsRange++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  process.env.CATSTUDY_URL = `http://127.0.0.1:${portRange}`
  process.env.CATSTUDY_SESSION_ID = 'session-debug-1'
  const okRange = await tryPostToCatstudy('# 合并审版文档（范围不同）', DEDUP_TMP)
  if (prevUrlDup === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrlDup
  if (prevSidDup !== undefined) process.env.CATSTUDY_SESSION_ID = prevSidDup

  assert(okRange === 'ok', '内容不同的文档应正常投递')
  assert(postHitsRange === 1, `内容不同不应被误挡（实际 ${postHitsRange} 次）`)
  console.log('  12c: 内容不同不被误挡 ✅')

  serverRange.close()
  rmSync(DEDUP_TMP, { recursive: true, force: true })
}

console.log('')

// ═══ 测试组 13: 投递状态文件幂等 + 落库验证 + pending 补投（Fix A+B+D） ═══

console.log('📦 测试组 13: 投递状态文件幂等 + 落库验证 + pending 补投')

const STATE_FILE = '.handoff-delivered.json'

function readStateFile(tmp) {
  return JSON.parse(readFileSync(join(tmp, STATE_FILE), 'utf-8'))
}

/**
 * 进程内跑 CLI 主流程（stub server 与测试同进程——某些沙箱环境阻断子进程
 * 对 127.0.0.1 的 TCP，execSync 起的 CLI 连不上 stub，必须进程内调用）。
 * 覆盖 CATSTUDY_URL、清空 CATSTUDY_SESSION_ID 走自动反查，结束后恢复。
 */
async function runInProc(cwd, url, opts = {}) {
  const prevUrl = process.env.CATSTUDY_URL
  const prevSid = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = url
  delete process.env.CATSTUDY_SESSION_ID
  try {
    await runHandoff({ cwd, ...opts })
  } finally {
    if (prevUrl === undefined) delete process.env.CATSTUDY_URL
    else process.env.CATSTUDY_URL = prevUrl
    if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid
  }
}

/** 建一个带 catstudy [uuid] commit 的临时仓库 */
function makeUuidRepo(dirName, uuid, files) {
  const tmp = join(ROOT, dirName)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execSync('git init', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: tmp, stdio: 'pipe' })
  for (const [fp, content] of Object.entries(files)) {
    writeFileSync(join(tmp, fp), content, 'utf-8')
  }
  execSync('git add -A', { cwd: tmp, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid}]"`, { cwd: tmp, stdio: 'pipe' })
  return tmp
}

function gitIn(tmp, cmd) {
  return execSync(`git ${cmd}`, { cwd: tmp, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

// 13a: 同 SHA 二次运行 → 状态文件幂等跳过，不重复 POST
{
  const uuid = '13aa0000-0000-4000-8000-000000000001'
  const TMP13A = makeUuidRepo('.handoff-test-state', uuid, { 'a.txt': '1' })
  let postHits = 0
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-13a', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13a = `http://127.0.0.1:${port}`

  // 第一次运行（post-commit 路径）：投递成功 → delivered 记录 + 草稿清理
  await runInProc(TMP13A, url13a)
  assert(postHits === 1, `首次运行应 POST 1 次（实际 ${postHits}）`)
  const headSha13a = gitIn(TMP13A, 'rev-parse HEAD')
  const state13a = readStateFile(TMP13A)
  assert(state13a.delivered[headSha13a] !== undefined, '状态文件应记录 HEAD 的 delivered')
  assert(state13a.pending.length === 0, '投递成功后 pending 应为空')
  assert(!existsSync(join(TMP13A, '.handoff-draft.md')), '投递成功应清理草稿')

  // 第二次运行：delivered 命中 → 跳过，不再 POST
  await runInProc(TMP13A, url13a)
  assert(postHits === 1, `幂等：同 SHA 二次运行不应再 POST（实际 ${postHits}）`)
  const state13a2 = readStateFile(TMP13A)
  assert(state13a2.delivered[headSha13a] !== undefined, '二次运行后 delivered 记录应保留')
  assert(state13a2.pending.length === 0, '二次运行后 pending 应为空')

  server.close()
  rmSync(TMP13A, { recursive: true, force: true })
  console.log('  13a: 同 SHA 二次运行跳过（状态文件幂等）✅')
}

// 13b: POST 超时但消息已落库 → 落库验证判定成功，不重投
{
  const uuid = '13bb0000-0000-4000-8000-000000000002'
  const TMP13B = makeUuidRepo('.handoff-test-verify-ok', uuid, { 'a.txt': '1' })
  let postHits = 0
  let landed = false // 模拟"消息在 POST 后才落库"（write→broadcast→dispatch 顺序）
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-13b', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      // POST 前列表为空（去重不短路）；POST 后消息出现（dispatch 同步等待拖超时）
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          landed
            ? [{ id: 'm1', role: 'user', content: buildHandoffMessage('# 测试交接文档\n内容') }]
            : []
        )
      )
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      landed = true // 消息已落库
      req.socket.destroy() // POST 永不返回 → fetch 超时 → 走落库验证
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13b = `http://127.0.0.1:${port}`
  const prevUrl = process.env.CATSTUDY_URL
  const prevSid = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = url13b
  delete process.env.CATSTUDY_SESSION_ID
  const result13b = await tryPostToCatstudy('# 测试交接文档\n内容', TMP13B)
  if (prevUrl === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrl
  if (prevSid !== undefined) process.env.CATSTUDY_SESSION_ID = prevSid

  assert(result13b === 'ok', 'POST 超时但消息已落库 → 应判定成功（落库验证命中）')
  assert(postHits === 1, '判定成功后不应重试 POST')
  server.close()
  rmSync(TMP13B, { recursive: true, force: true })
  console.log('  13b: POST 超时但消息已落库 → 落库验证判定成功 ✅')
}

// 13c: 落库验证失败（消息未落库）→ transient 重试耗尽 → CLI 层 SHA 记入 pending
{
  const uuid = '13cc0000-0000-4000-8000-000000000003'
  const TMP13C = makeUuidRepo('.handoff-test-verify-miss', uuid, { 'a.txt': '1' })
  let postHits = 0
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-13c', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([])) // 消息从未落库
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      req.socket.destroy()
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13c = `http://127.0.0.1:${port}`
  const prevUrlC = process.env.CATSTUDY_URL
  const prevSidC = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = url13c
  delete process.env.CATSTUDY_SESSION_ID
  const result13c = await tryPostToCatstudy('# 测试交接文档\n内容', TMP13C)
  if (prevUrlC === undefined) delete process.env.CATSTUDY_URL
  else process.env.CATSTUDY_URL = prevUrlC
  if (prevSidC !== undefined) process.env.CATSTUDY_SESSION_ID = prevSidC

  assert(result13c === 'transient', '消息未落库 → 应判定 transient（重试耗尽）')
  assert(postHits === 3, `3 次尝试全部落库验证失败（实际 ${postHits}）`)

  // CLI 层：重试耗尽 → SHA 记入 pending（Fix D），草稿保留
  await runInProc(TMP13C, url13c)
  const headSha13c = gitIn(TMP13C, 'rev-parse HEAD')
  const state13c = readStateFile(TMP13C)
  assert(state13c.pending.includes(headSha13c), '重试耗尽后 SHA 应记入 pending')
  assert(state13c.delivered[headSha13c] === undefined, '失败 SHA 不应出现在 delivered')
  assert(existsSync(join(TMP13C, '.handoff-draft.md')), '投递失败应保留草稿')

  server.close()
  rmSync(TMP13C, { recursive: true, force: true })
  console.log('  13c: 落库验证失败 → transient + pending 记录 + 草稿滞留 ✅')
}

// 13d: 历史改写自愈（prune 非祖先条目）+ --gate-deliver 兜底投 HEAD
{
  const uuid1 = '13dd0000-0000-4000-8000-000000000001'
  const uuid2 = '13dd0000-0000-4000-8000-000000000002'
  const TMP13D = join(ROOT, '.handoff-test-prune')
  if (existsSync(TMP13D)) rmSync(TMP13D, { recursive: true, force: true })
  mkdirSync(TMP13D, { recursive: true })
  execSync('git init', { cwd: TMP13D, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: TMP13D, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: TMP13D, stdio: 'pipe' })
  writeFileSync(join(TMP13D, 'a.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13D, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid1}]"`, { cwd: TMP13D, stdio: 'pipe' })
  writeFileSync(join(TMP13D, 'b.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13D, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid2}]"`, { cwd: TMP13D, stdio: 'pipe' })
  const sha1 = gitIn(TMP13D, 'rev-parse HEAD~1')
  const sha2 = gitIn(TMP13D, 'rev-parse HEAD')
  const bogus = 'f'.repeat(40)

  // 手工构造脏状态：delivered 含非祖先 bogus + 有效 sha1；pending 含 bogus + sha1
  writeFileSync(
    join(TMP13D, STATE_FILE),
    JSON.stringify(
      {
        delivered: { [sha1]: '2026-08-01T00:00:00.000Z', [bogus]: '2026-08-01T00:00:00.000Z' },
        pending: [sha1, bogus],
      },
      null,
      2
    )
  )

  let postHits = 0
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid1}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid1, sessionId: 'session-13d-1', role: 'user' }))
      return
    }
    if (req.url === `/api/messages/${uuid2}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid2, sessionId: 'session-13d-2', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13d = `http://127.0.0.1:${port}`

  await runInProc(TMP13D, url13d, { gateDeliver: true })

  const state13d = readStateFile(TMP13D)
  assert(state13d.delivered[bogus] === undefined, '非祖先 delivered 条目应被 prune')
  assert(!state13d.pending.includes(bogus), '非祖先 pending 条目应被 prune')
  assert(!state13d.pending.includes(sha1), 'pending 中的有效 SHA 处理完应移除')
  assert(
    state13d.delivered[sha1] !== undefined,
    'sha1（已 delivered）补投时状态跳过，仍留 delivered'
  )
  assert(state13d.delivered[sha2] !== undefined, '--gate-deliver 应兜底投递 HEAD（sha2）')
  assert(postHits === 1, `sha1 已 delivered → 不重复 POST；仅 HEAD 投 1 次（实际 ${postHits}）`)
  server.close()
  rmSync(TMP13D, { recursive: true, force: true })
  console.log('  13d: 历史改写自愈（prune 非祖先）+ gate-deliver 兜底 HEAD ✅')
}

// 13e: pending 补投（per-SHA 重新生成 + 各自会话反查）
{
  const uuid2 = '13ee0000-0000-4000-8000-000000000002'
  const uuid3 = '13ee0000-0000-4000-8000-000000000003'
  const TMP13E = join(ROOT, '.handoff-test-pending')
  if (existsSync(TMP13E)) rmSync(TMP13E, { recursive: true, force: true })
  mkdirSync(TMP13E, { recursive: true })
  execSync('git init', { cwd: TMP13E, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: TMP13E, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: TMP13E, stdio: 'pipe' })
  writeFileSync(join(TMP13E, 'a.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13E, stdio: 'pipe' })
  execSync('git commit -m "feat: base"', { cwd: TMP13E, stdio: 'pipe' })
  writeFileSync(join(TMP13E, 'b.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13E, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid2}]"`, { cwd: TMP13E, stdio: 'pipe' })
  writeFileSync(join(TMP13E, 'c.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13E, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuid3}]"`, { cwd: TMP13E, stdio: 'pipe' })
  const sha2 = gitIn(TMP13E, 'rev-parse HEAD~1')

  // 手工构造：commit2 投递失败滞留 pending
  writeFileSync(join(TMP13E, STATE_FILE), JSON.stringify({ delivered: {}, pending: [sha2] }))

  const postBodies = []
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid2}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid2, sessionId: 'session-13e-2', role: 'user' }))
      return
    }
    if (req.url === `/api/messages/${uuid3}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid3, sessionId: 'session-13e-3', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        postBodies.push(JSON.parse(raw))
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13e = `http://127.0.0.1:${port}`

  await runInProc(TMP13E, url13e, { gateDeliver: true })

  assert(postBodies.length === 2, `应投 sha2（补投）+ sha3（兜底 HEAD，实际 ${postBodies.length}）`)
  const body2 = postBodies.find((b) => b.sessionId === 'session-13e-2')
  assert(body2 !== undefined, 'sha2 文档应投到 uuid2 反查的会话（per-SHA 反查）')
  assertContains(body2.content, 'b.txt', 'sha2 文档应含 commit2 的文件（b.txt）')
  assertNotContains(body2.content, 'c.txt', 'sha2 文档不应含 HEAD 的文件（c.txt）')
  const sha2short = gitIn(TMP13E, `log -1 --pretty=%h ${sha2}`)
  assertContains(
    body2.content,
    `git show ${sha2short}`,
    'sha2 文档审查须知应指向 sha2 自身的绝对引用（git show <sha>，非相对范围）'
  )
  assertNotContains(
    body2.content,
    `${sha2}~1..${sha2}`,
    '审查须知不再含相对范围引用（git diff <range> 已唯一化为 git show <sha>）'
  )
  const state13e = readStateFile(TMP13E)
  assert(state13e.pending.length === 0, '补投成功后 pending 应清空')
  assert(state13e.delivered[sha2] !== undefined, 'sha2 应移入 delivered')
  server.close()
  rmSync(TMP13E, { recursive: true, force: true })
  console.log('  13e: pending 补投（per-SHA 重新生成 + 会话反查）✅')
}

// 13f: pending 中 fatal（触发消息 404）→ 移除死条目，不永久滞留
{
  const uuidBad = '13ff0000-0000-4000-8000-0000000000ff'
  const uuidOk = '13ff0000-0000-4000-8000-00000000000f'
  const TMP13F = join(ROOT, '.handoff-test-pending-fatal')
  if (existsSync(TMP13F)) rmSync(TMP13F, { recursive: true, force: true })
  mkdirSync(TMP13F, { recursive: true })
  execSync('git init', { cwd: TMP13F, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: TMP13F, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: TMP13F, stdio: 'pipe' })
  writeFileSync(join(TMP13F, 'a.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13F, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuidBad}]"`, { cwd: TMP13F, stdio: 'pipe' })
  writeFileSync(join(TMP13F, 'b.txt'), '1', 'utf-8')
  execSync('git add -A', { cwd: TMP13F, stdio: 'pipe' })
  execSync(`git commit -m "catstudy [${uuidOk}]"`, { cwd: TMP13F, stdio: 'pipe' })
  const sha1 = gitIn(TMP13F, 'rev-parse HEAD~1')
  const sha2 = gitIn(TMP13F, 'rev-parse HEAD')

  // 手工构造：commit1（触发消息已删）滞留 pending
  writeFileSync(join(TMP13F, STATE_FILE), JSON.stringify({ delivered: {}, pending: [sha1] }))

  let postHits = 0
  const { server, port } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuidBad}` && req.method === 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' }) // 触发消息已删除
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    if (req.url === `/api/messages/${uuidOk}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuidOk, sessionId: 'session-13f', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13f = `http://127.0.0.1:${port}`

  await runInProc(TMP13F, url13f, { gateDeliver: true })

  const state13f = readStateFile(TMP13F)
  assert(!state13f.pending.includes(sha1), 'pending 中 fatal（反查 404）→ 应移除死条目')
  assert(state13f.delivered[sha1] === undefined, 'fatal 不应记 delivered')
  assert(state13f.delivered[sha2] !== undefined, 'HEAD 兜底投递应正常')
  assert(postHits === 1, `仅 HEAD 投 1 次（fatal 不 POST，实际 ${postHits}）`)
  server.close()
  rmSync(TMP13F, { recursive: true, force: true })
  console.log('  13f: pending fatal 移除死条目 ✅')
}

// 13g: writeState 并发合并语义（基线合并 + 删除权威——2026-08-01 实测并发事故的回归防护）
{
  const TMP13G = join(ROOT, '.handoff-test-merge')
  if (existsSync(TMP13G)) rmSync(TMP13G, { recursive: true, force: true })
  mkdirSync(TMP13G, { recursive: true })
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  const shaX = 'c'.repeat(40)

  // 场景 1：进程 A 基线为空，进程 B 并发写入 pending=[shaB]，A 用旧基线写回自己的
  // 结果（delivered[shaA]）→ B 的新增条目不得丢失（丢 pending 即该 commit 文档永不补投）
  const baselineA = readState(TMP13G) // 空基线
  writeState(TMP13G, { delivered: {}, pending: [shaB], raw: baselineA.raw }) // B 写入
  writeState(TMP13G, { delivered: { [shaA]: 't' }, pending: [], raw: baselineA.raw }) // A 写回
  const after1 = readState(TMP13G)
  assert(after1.delivered[shaA] !== undefined, '合并后 A 的 delivered 保留')
  assert(
    after1.pending.includes(shaB),
    '并发 B 新增的 pending 不应被 A 的写回覆盖（丢 pending 即丢文档）'
  )
  assert(!after1.pending.includes(shaA), '已 delivered 的 sha 不应留在 pending')

  // 场景 2：删除权威——A 基线读到 pending=[shaX]，A 移除 shaX（fatal）后写回，
  // 盘上旧条目不得把它"复活"
  const baseline2 = readState(TMP13G)
  writeState(TMP13G, { delivered: {}, pending: [shaX], raw: baseline2.raw }) // 初始含 shaX
  const baseline3 = readState(TMP13G)
  assert(baseline3.pending.includes(shaX), '前置：shaX 已在 pending 中')
  writeState(TMP13G, { delivered: {}, pending: [shaB], raw: baseline3.raw }) // A 只移除 shaX
  const after2 = readState(TMP13G)
  assert(!after2.pending.includes(shaX), 'A 删除的 pending 条目不应被盘上旧文件复活')
  assert(after2.pending.includes(shaB), 'A 未触及的条目保留')

  rmSync(TMP13G, { recursive: true, force: true })
  console.log('  13g: writeState 并发合并（基线合并 + 删除权威）✅')
}

// ═══ 测试组 14: 归属判据（T-H ①「任一状态执行行」） ═══════════════════════
// 本组的存在理由：T-A 的判据源是写回端点的 `updated`（running 命中行数），而
// e2e 的 stub 从来没有 commit-hash 端点 → writeback 恒失败 → attributed 恒 null
// → 一律走降级投递。于是**三条判据在 e2e 里全不生效**，测试全绿也不代表判据对。
// 本组把两个端点都补上，让「静默」这条路径第一次在 e2e 里可断言。

/**
 * 归属场景 stub：写回 `updated`（旧判据源）与 executor（新判据源）各自可配，
 * 用来构造「两者结论相反」的场景——那正是 T-H ① 的靶心。
 * @param {number} cfg.updated — 写回响应里的 running 命中行数
 * @param {'ok'|404|500} cfg.executor — executor 端点行为（'ok' = 存在任一状态执行行）
 */
async function startAttributionStub({ uuid, sessionId, updated, executor }) {
  const hits = { writeback: 0, executor: 0, post: 0 }
  const postBodies = []
  const { server, port } = await startStubServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      return json(200, { id: uuid, sessionId, role: 'user' })
    }
    if (req.url === `/api/messages/${uuid}/commit-hash` && req.method === 'POST') {
      hits.writeback++
      return json(200, { ok: true, updated })
    }
    if (req.url.startsWith(`/api/messages/${uuid}/executor`) && req.method === 'GET') {
      hits.executor++
      if (executor === 404) return json(404, { error: 'No execution log for this message' })
      if (executor === 500) return json(500, { error: 'boom' })
      return json(200, { agentId: 'a-1', agentName: 'ds猫', taskId: 'task-1' })
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      return json(200, [])
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      hits.post++
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        postBodies.push(JSON.parse(raw))
        json(201, { ok: true, messageId: 'm-new' })
      })
      return
    }
    json(404, { error: 'not found' })
  })
  return { server, url: `http://127.0.0.1:${port}`, hits, postBodies }
}

// 14a: 执行**已终态**（写回命中 running 行 = 0，但执行行存在）→ 静默，不多投
//      这是 T-H ① 的靶心：旧判据源在此判「无归属 → 兜底投递」，返工每次提交都叠一条链。
{
  const uuid = '14aa0000-0000-4000-8000-00000000000a'
  const tmp = makeUuidRepo('.handoff-test-attr-terminal', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14a',
    updated: 0,
    executor: 'ok',
  })
  await runInProc(tmp, stub.url)

  assert(
    stub.hits.writeback === 1,
    `前置：写回应确实发生（实际 ${stub.hits.writeback}）——否则本场景没被构造出来`
  )
  // 阴性对照（证明下面那条不是恒真）：本场景写回读数 = 0，而旧判据把「updated=0」
  // 映射成 attributed=false → decideHookDelivery(false).deliver === true（投递）。
  // 也就是说：换回旧实现，本场景必然 POST 1 次，断言当场红。
  assert(
    decideHookDelivery(0 > 0).deliver === true,
    '阴性对照：旧判据输入（running 命中 0 → 无归属）在旧实现下会投递'
  )
  assert(stub.hits.post === 0, `执行已终态仍有归属 → 应静默（POST 0 次，实际 ${stub.hits.post}）`)
  assert(stub.hits.executor === 1, `应问一次归属探针（实际 ${stub.hits.executor}）`)

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14a: 执行已终态仍有归属 → 静默（旧判据会多投一条）✅')
}

// 14b: 真·用户手动提交（该 uuid 从无执行行）→ 兜底投递 1 条
{
  const uuid = '14bb0000-0000-4000-8000-00000000000b'
  const tmp = makeUuidRepo('.handoff-test-attr-manual', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14b',
    updated: 0,
    executor: 404,
  })
  await runInProc(tmp, stub.url)

  assert(stub.hits.post === 1, `无执行行 = 手动提交 → 应兜底投 1 条（实际 ${stub.hits.post}）`)
  // 投递路径会**两次**打这个端点：先归属探针、后实施者反查（补填人）。故这里是 ≥1
  // 而不是 ===1——14a 的静默路径才是「只打探针一次」的干净读数。
  assert(
    stub.hits.executor >= 1,
    `无执行行时也应问过探针（二者同得 updated=0，实际 ${stub.hits.executor} 次）`
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14b: 真手动提交（无执行行）→ 兜底投 1 条 ✅')
}

// 14c: 探针查不动（executor 500）→ 一律投递，不静默吞
{
  const uuid = '14cc0000-0000-4000-8000-00000000000c'
  const tmp = makeUuidRepo('.handoff-test-attr-unprobeable', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14c',
    updated: 0,
    executor: 500,
  })
  await runInProc(tmp, stub.url)

  assert(stub.hits.post === 1, `探针查不动 → 降级一律投递（实际 ${stub.hits.post}）`)

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14c: 探针查不动 → 降级投递（不静默吞）✅')
}

// 14d: 写回已命中 running 行 = 归属的**充分条件** → 静默，且不再花探针那次往返
{
  const uuid = '14dd0000-0000-4000-8000-00000000000d'
  const tmp = makeUuidRepo('.handoff-test-attr-running', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14d',
    updated: 1,
    executor: 'ok',
  })
  await runInProc(tmp, stub.url)

  assert(stub.hits.post === 0, `写回命中 running 行 → 有归属 → 静默（实际 ${stub.hits.post}）`)
  assert(
    stub.hits.executor === 0,
    `正信号短路：命中 running 行即已确证有归属，不应再问探针（实际 ${stub.hits.executor}）`
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14d: 写回命中 running 行 → 静默且省掉探针往返 ✅')
}

// ═══ 测试组 15: 审查请求覆盖（T-H ②「同一 uuid 的连续 commit 段」） ═══════
// 一次派发只发一条审查请求（T-A：不叠链），而投递文档的改动面此前恒为 `<sha>~1..<sha>`
// ——同一派发里更早的 commit 因此全流程拿不到审查。本组钉住修复后的覆盖面。

/** 基础提交（无 uuid，作跨度回溯的停止点）+ N 个共享 uuid 的提交 */
function makeSpanRepo(dirName, uuid, commits) {
  const tmp = join(ROOT, dirName)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execSync('git init', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: tmp, stdio: 'pipe' })
  writeFileSync(join(tmp, 'base.txt'), 'base', 'utf-8')
  execSync('git add -A', { cwd: tmp, stdio: 'pipe' })
  execSync('git commit -m "base（无 uuid——跨度回溯的停止点）"', { cwd: tmp, stdio: 'pipe' })
  for (const [file, content] of commits) {
    writeFileSync(join(tmp, file), content, 'utf-8')
    execSync('git add -A', { cwd: tmp, stdio: 'pipe' })
    // uuid 写在 **body**（与真实仓库一致，不是 subject）——extractCommitUuid 读整条 message。
    // 用两次 `-m`（= 空行分段）而不是在单个 `-m` 里塞 `\n`：execSync 在 Windows 走
    // cmd.exe，参数里的真实换行会把命令行截断（本 helper 首版就踩了这个）。
    execSync(`git commit -m "feat: ${file}" -m "catstudy [${uuid}]"`, {
      cwd: tmp,
      stdio: 'pipe',
    })
  }
  return tmp
}

// 15a: 同一 uuid 两个 commit → 文档覆盖**两者**，审查须知指向整段
{
  const uuid = '15aa0000-0000-4000-8000-00000000000a'
  const tmp = makeSpanRepo('.handoff-test-span-multi', uuid, [
    ['a.txt', '1'],
    ['b.txt', '2'],
  ])
  const headSha = gitIn(tmp, 'rev-parse HEAD')
  const firstSha = gitIn(tmp, 'rev-parse HEAD~1')

  const span = resolveExecutionCommitSpan(tmp, 'HEAD')
  assert(span?.count === 2, `跨度应回溯到 2 个 commit（实际 ${span?.count}）`)
  assert(span?.first === firstSha, '跨度首元素应为更早那个 commit')

  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-15a',
    updated: 0,
    executor: 404, // 无执行行 → 走兜底投递，好把文档正文抓下来
  })
  await runInProc(tmp, stub.url)

  assert(stub.postBodies.length === 1, `应投出 1 条（实际 ${stub.postBodies.length}）`)
  const doc = stub.postBodies[0]?.content || ''
  assertContains(doc, 'a.txt', '早期 commit 的文件（a.txt）也应在覆盖范围内——这是本票的靶心')
  assertContains(doc, 'b.txt', 'HEAD commit 的文件（b.txt）应在覆盖范围内')
  const headShort = gitIn(tmp, `log -1 --pretty=%h ${headSha}`)
  const firstShort = gitIn(tmp, `log -1 --pretty=%h ${firstSha}`)
  assertContains(
    doc,
    `git diff ${firstShort}~1..${headShort}`,
    '审查须知应指向覆盖整段的绝对 sha 引用'
  )
  assertContains(doc, '连续 2 个 commit', '应显式说明覆盖了几个 commit（不假装只有一个）')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  15a: 同一 uuid 多 commit → 文档覆盖整段 ✅')
}

// 15b: 单 commit → 与既有文案逐字相同（回归：改动面不因本票变化）
{
  const uuid = '15bb0000-0000-4000-8000-00000000000b'
  const tmp = makeSpanRepo('.handoff-test-span-single', uuid, [['a.txt', '1']])
  const headSha = gitIn(tmp, 'rev-parse HEAD')
  const span = resolveExecutionCommitSpan(tmp, 'HEAD')
  assert(span?.count === 1, `单 commit 跨度应为 1（实际 ${span?.count}）`)

  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-15b',
    updated: 0,
    executor: 404,
  })
  await runInProc(tmp, stub.url)

  assert(stub.postBodies.length === 1, `应投出 1 条（实际 ${stub.postBodies.length}）`)
  const doc = stub.postBodies[0]?.content || ''
  assertContains(
    doc,
    `git show ${gitIn(tmp, `log -1 --pretty=%h ${headSha}`)}`,
    '单 commit 仍用 git show <sha>（既有文案不变）'
  )
  assertNotContains(doc, '连续', '单 commit 不应出现「连续 N 个 commit」措辞')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  15b: 单 commit → 文案与既有逐字相同 ✅')
}

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

/**
 * handoff-gen.mjs 端到端测试
 *
 * 模拟完整 git 工作流 → 验证生成的 .handoff-draft.md 的结构和内容。
 *
 * 用法:
 *   node scripts/handoff-gen.e2e.mjs
 */

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateHandoff,
  extractCommitUuid,
  resolveCommitSessionId,
  resolveExecutorName,
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

/** 链锚形状断言用：`randomUUID()` 的 v4 形态。投递载荷有没有锚，就靠它分辨。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 启动一个临时 HTTP stub server（127.0.0.1 随机端口），用于测试反查投递目标 */
function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

/**
 * 瞬态重试（OQ-1 保护面）：`resolveCommitSessionId` 在 server 不可达时**抛**
 * `HANDOFF_TRANSIENT`（设计如此——调用方按「瞬态 → 延迟重试」处理）。
 * 但组 10 的三个调用点在顶层裸块里、外面没有 try，一次 fetch 抖动就把整轮 e2e 打崩：
 * **无汇总、exit 非 0、已跑过的组全白跑**（实测 6 次运行命中 1 次，失败形态与
 * `handoff-gen.mjs` catch 里构造的错误对象一致）。
 *
 * 只重试 `HANDOFF_TRANSIENT`（可重试的那一类）；其余异常照旧上抛——不掩盖真 bug。
 * 断言仍落在**成功那一次**的返回值上，判据强度不变：这不是"把红的测成绿的"，
 * 是把"基础设施抖一下就没有汇总"换成"抖一下重试一次"。
 */
async function callWithTransientRetry(fn, attempts = 3, delayMs = 100) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err?.code !== 'HANDOFF_TRANSIENT') throw err
      lastErr = err
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// helper 自证：它自己没被测的话，"保护面"就只是句声明（本会话已反复踩过恒真门）。
{
  let n = 0
  const v = await callWithTransientRetry(async () => {
    n++
    if (n < 3) {
      const e = new Error('transient')
      e.code = 'HANDOFF_TRANSIENT'
      throw e
    }
    return 'ok'
  })
  assert(v === 'ok' && n === 3, `瞬态重试应重试到成功（实得 v=${v} n=${n}）`)

  let m = 0
  let threw = null
  try {
    await callWithTransientRetry(async () => {
      m++
      const e = new Error('real bug')
      e.code = 'OTHER'
      throw e
    })
  } catch (e) {
    threw = e
  }
  assert(
    threw?.message === 'real bug' && m === 1,
    `非瞬态异常应原样上抛且只跑一次——重试不得掩盖真 bug（实得 m=${m}）`
  )
}

// ─── 入口主闸镜像（T-O 并入）────────────────────────────────

/** 真实 REST 通道上的两个 400 条件，逐字对齐 `connectors/ingest.ts:buildDeliveryGateError`。
 *  handoff-gen 的投递固定 `origin:'agent'`（`routes/messages.ts:173` 硬编码），
 *  故「缺锚即 400」对**每一次**投递都适用。
 *
 *  为什么必须镜像：inline stub 原先一律无条件 201 ⇒「载荷无锚」这个缺口在 e2e 里
 *  **恒不显形**——文档照样"投出"、断言照样绿。这层假绿正是上一轮没拦住 T-F 缺口的
 *  直接原因。`startAttributionStub` 已按此修；本组把同一件事推到全部**会应答 2xx**
 *  的 stub（例外 3 处均无闸可接、且在各自 handler 就地注明理由：一处应答固定 400，
 *  两处 `socket.destroy()` 永不返回）。
 *
 *  规则 B（审查类投递缺 chainType）在本 e2e 里**当前不可达**：handoff-gen 只发补填
 *  请求，载荷 `mentions:[fillerName]` 且 filler ∈ {store, implementer}——实测 agents
 *  表：店长=store，ds猫/flash猫/dsh猫=implementer，reviewer 只有吐槽猫 ⇒
 *  `isReviewDelivery` 恒 false。仍然实现它（要的是闸门的**忠实镜像**，不是现状快照），
 *  并另加一条诊断断言钉住「放行载荷不得点名 reviewer」——改 filler 或加 mentions 的
 *  人会在那里立刻看到指向上游的红。
 */
const STUB_REVIEWER_NAMES = ['吐槽猫']

function mirrorEntryGateError(body) {
  if (!body || typeof body.taskId !== 'string' || !body.taskId) {
    return '缺链锚：agent 投递必须携带 task_id（首轮锚 = 本轮 trace_id）'
  }
  const mentions = Array.isArray(body.mentions) ? body.mentions : []
  if (mentions.some((n) => STUB_REVIEWER_NAMES.includes(n)) && !body.chainType) {
    return '审查类投递缺 chainType（需声明 first=建链 / followup=链内更新）'
  }
  return null
}

/** 经镜像闸**放行**的全部载荷——末尾用它断言「镜像真接上了」。 */
const gatedPostBodies = []

/**
 * 统一的 `/api/messages` POST 处理：读 body → 过入口主闸镜像 → 交 `onOk(body, raw)`。
 * 调用方在自己的 POST 分支里 `return handleMessagePost(req, res, cb)`。
 * @param {(body: any, raw: string) => void} onOk — 闸门放行后的应答逻辑
 */
function handleMessagePost(req, res, onOk) {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    gatedPostBodies.push(body)
    const gateError = mirrorEntryGateError(body)
    if (gateError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: gateError }))
      return
    }
    onOk(body, raw)
  })
  return true
}

// ─── Setup: 创建临时 git 仓库 ───────────────────────────────

// 所有测试仓库都建在**系统临时目录**下的一个私有根里，绝不建在仓库树内。
// 起因：本文件此前用 `join(ROOT, '.handoff-test-*')` 在仓库根建临时仓库，而
// 那些目录既不在 .gitignore 里、清理又不全（模块级的 EMPTY_TMP / SNAPSHOT_TMP /
// NO_POST_TMP / RANGE_TMP 从不删除）——任何并发的 `git add -A`（auto-commit）
// 都会把它们扫进提交。本仓库已因此踩过两次。改到 os.tmpdir() 是根修：
// 临时产物不该出现在仓库树里，于是"清理不全"也就不再是污染源。
// 注意：不补 .gitignore 兜底——那会掩盖同类回归（目录再出现时不再刺眼）。
const TEST_BASE = mkdtempSync(join(tmpdir(), 'handoff-e2e-'))

// 崩溃路径也要收：文件末尾的 `rmSync(TEST_BASE)` 只在跑到底时执行——中途 uncaught
// 会留下一整个 fixture 根（实测：`handoff-e2e-nexELU`，mtime 13:37:11Z，内含
// `.handoff-test-lookup` + `tmp`，正是 OQ-1 那次瞬态逃逸崩在半路留下的）。
// exit 钩子在 uncaught exception 之后仍会跑，与末尾清理幂等（force + recursive）。
process.on('exit', () => {
  try {
    rmSync(TEST_BASE, { recursive: true, force: true })
  } catch {}
})

const TMP = join(TEST_BASE, 'tmp')
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
const EMPTY_TMP = join(TEST_BASE, '.handoff-test-empty')
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
const SNAPSHOT_TMP = join(TEST_BASE, '.handoff-test-snapshot')
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
const NO_POST_TMP = join(TEST_BASE, '.handoff-test-nopost')
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
const RANGE_TMP = join(TEST_BASE, '.handoff-test-range')
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

  const LOOKUP_TMP = join(TEST_BASE, '.handoff-test-lookup')
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
  const sid = await callWithTransientRetry(() => resolveCommitSessionId(LOOKUP_TMP, serverUrl))
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
  const sid404 = await callWithTransientRetry(() => resolveCommitSessionId(LOOKUP_TMP, serverUrl))
  assert(sid404 === null, '404 时应返回 null（报错不投递，禁止降级兜底）')
  console.log('  10c: 404 报错不投递 ✅')

  // 10d: 手动 commit（无 uuid）→ null 且不发请求（报错不投递）
  writeFileSync(lookupFile, '3', 'utf-8')
  execSync('git add -A', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  execSync('git commit -m "fix: manual commit"', { cwd: LOOKUP_TMP, stdio: 'pipe' })
  hits = []
  const sidManual = await callWithTransientRetry(() =>
    resolveCommitSessionId(LOOKUP_TMP, serverUrl)
  )
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
  const RETRY_TMP = join(TEST_BASE, '.handoff-test-retry')
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
      return handleMessagePost(req, res, (_body, raw) => {
        postHits++
        lastPostBody = raw
        // 前两次模拟瞬态连接失败（连接被 reset → fetch 抛错 → transient）
        if (postHits <= 2) {
          destroyed++
          req.socket.destroy()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'm1', sessionId: 'session-debug-1' }))
      })
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
    // 入口主闸镜像**不接**此处（T-O 并入的刻意例外）：本 stub 的设计应答就是 400
    // （测「4xx 确定性失败不重试」），闸门被它包含、接上去零区分性。
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
      return handleMessagePost(req, res, () => {
        postHitsApproved++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
      // T-O 复审 §四-1：本处原为**未接闸**的 inline 201——「全部会应答 2xx 的
      // inline stub 都已接镜像」的说法因它而不成立（它恰是唯一一处）。接上：
      // 载荷无锚时应在入口 400，而不是被这个 stub 无条件吞成 201。
      return handleMessagePost(req, res, () => {
        postHitsNotApproved++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
      return handleMessagePost(req, res, () => {
        postHitsDown++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
  const DEDUP_TMP = join(TEST_BASE, '.handoff-test-dedup')
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
      return handleMessagePost(req, res, () => {
        postHitsDup++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
      return handleMessagePost(req, res, () => {
        postHitsFresh++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
      return handleMessagePost(req, res, () => {
        postHitsRange++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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

/** pending 只剩 sha 面的投影——`pending` 自 2026-09-12 起是 `{ sha, src }` 条目数组 */
function pendingShas(state) {
  return state.pending.map((e) => e.sha)
}

/** 取某条 pending 条目的来源标记（不存在则 undefined） */
function pendingSrcOf(state, sha) {
  return state.pending.find((e) => e.sha === sha)?.src
}

/**
 * executor 端点的两种调用**必须分开数**（同一个 URL 前缀，靠 query 区分）：
 * - 归属探针 `probeAttribution`：不带 query —— 「判据有没有被咨询」只认这一种
 * - 实施者反查 `resolveExecutorName`：带 `?commit=` —— 投递成功路径的例行调用，
 *   与判据无关。混着数会让「没咨询判据」被一次名字反查假证成「咨询了」。
 */
const probeCalls = (hits) => hits.urls.filter((u) => !u.includes('?')).length
const nameLookupCalls = (hits) => hits.urls.filter((u) => u.includes('?')).length

/**
 * 进程内跑 CLI 主流程（stub server 与测试同进程——某些沙箱环境阻断子进程
 * 对 127.0.0.1 的 TCP，execSync 起的 CLI 连不上 stub，必须进程内调用）。
 * 覆盖 CATSTUDY_URL、清空 CATSTUDY_SESSION_ID 走自动反查，结束后恢复。
 */
/** 捕获 `console.log` 输出跑一段代码——用于断言**日志本身**（本会话的观测面）。
 *  日志是排障唯一入口，写错方向比不写更坏，所以它也要有断言而不是只靠人眼看。 */
async function captureLogs(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    orig(...a)
  }
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return lines
}

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

/** 建一个临时仓库，HEAD 是一笔给定 message 的提交 */
function makeCommitRepo(dirName, files, commitMsg) {
  const tmp = join(TEST_BASE, dirName)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execSync('git init', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.email "test@catstudy.local"', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.name "Test Cat"', { cwd: tmp, stdio: 'pipe' })
  for (const [fp, content] of Object.entries(files)) {
    // 目录可能不存在（如 `docs/run/a.md`）——递归建，别让嵌套路径的用例只能写平铺文件
    const abs = join(tmp, fp)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  execSync('git add -A', { cwd: tmp, stdio: 'pipe' })
  execSync(`git commit -m "${commitMsg}"`, { cwd: tmp, stdio: 'pipe' })
  return tmp
}

/** 建一个带 catstudy [uuid] commit 的临时仓库 */
function makeUuidRepo(dirName, uuid, files) {
  return makeCommitRepo(dirName, files, `catstudy [${uuid}]`)
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
      return handleMessagePost(req, res, () => {
        postHits++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
    // 入口主闸镜像**不接**此处（T-O 并入的刻意例外）：本 stub 永不应答
    // （`socket.destroy()` 模拟 POST 不返回 → 走落库验证），400/201 在客户端不可观测，
    // 接上去只是把 body 读一遍、零区分性。
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
    // 入口主闸镜像**不接**此处（同上：永不应答，无可观测差异）
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
  assert(pendingShas(state13c).includes(headSha13c), '重试耗尽后 SHA 应记入 pending')
  assert(
    pendingSrcOf(state13c, headSha13c) === 'hook',
    'post-commit 入 pending 的条目须标 src=hook——标错则补投不跑判据，该被重判静默的条目会照投（多一条无主链）'
  )
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
  const TMP13D = join(TEST_BASE, '.handoff-test-prune')
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
      return handleMessagePost(req, res, () => {
        postHits++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13d = `http://127.0.0.1:${port}`

  await runInProc(TMP13D, url13d, { gateDeliver: true })

  const state13d = readStateFile(TMP13D)
  assert(state13d.delivered[bogus] === undefined, '非祖先 delivered 条目应被 prune')
  assert(!pendingShas(state13d).includes(bogus), '非祖先 pending 条目应被 prune')
  assert(!pendingShas(state13d).includes(sha1), 'pending 中的有效 SHA 处理完应移除')
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
  const TMP13E = join(TEST_BASE, '.handoff-test-pending')
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
      return handleMessagePost(req, res, (body) => {
        postBodies.push(body)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
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
  const TMP13F = join(TEST_BASE, '.handoff-test-pending-fatal')
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
      return handleMessagePost(req, res, () => {
        postHits++
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messageId: 'm-new' }))
      })
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const url13f = `http://127.0.0.1:${port}`

  await runInProc(TMP13F, url13f, { gateDeliver: true })

  const state13f = readStateFile(TMP13F)
  assert(!pendingShas(state13f).includes(sha1), 'pending 中 fatal（反查 404）→ 应移除死条目')
  assert(state13f.delivered[sha1] === undefined, 'fatal 不应记 delivered')
  assert(state13f.delivered[sha2] !== undefined, 'HEAD 兜底投递应正常')
  assert(postHits === 1, `仅 HEAD 投 1 次（fatal 不 POST，实际 ${postHits}）`)
  server.close()
  rmSync(TMP13F, { recursive: true, force: true })
  console.log('  13f: pending fatal 移除死条目 ✅')
}

// 13g: writeState 并发合并语义（基线合并 + 删除权威——2026-08-01 实测并发事故的回归防护）
{
  const TMP13G = join(TEST_BASE, '.handoff-test-merge')
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
    pendingShas(after1).includes(shaB),
    '并发 B 新增的 pending 不应被 A 的写回覆盖（丢 pending 即丢文档）'
  )
  assert(!pendingShas(after1).includes(shaA), '已 delivered 的 sha 不应留在 pending')
  assert(
    pendingSrcOf(after1, shaB) === 'legacy',
    '裸字符串条目（旧形态 / 未标来源）→ src=legacy：不判归属、照投（安全方向），不得丢条目'
  )

  // 场景 2：删除权威——A 基线读到 pending=[shaX]，A 移除 shaX（fatal）后写回，
  // 盘上旧条目不得把它"复活"
  const baseline2 = readState(TMP13G)
  writeState(TMP13G, { delivered: {}, pending: [shaX], raw: baseline2.raw }) // 初始含 shaX
  const baseline3 = readState(TMP13G)
  assert(pendingShas(baseline3).includes(shaX), '前置：shaX 已在 pending 中')
  writeState(TMP13G, { delivered: {}, pending: [shaB], raw: baseline3.raw }) // A 只移除 shaX
  const after2 = readState(TMP13G)
  assert(!pendingShas(after2).includes(shaX), 'A 删除的 pending 条目不应被盘上旧文件复活')
  assert(pendingShas(after2).includes(shaB), 'A 未触及的条目保留')

  rmSync(TMP13G, { recursive: true, force: true })
  console.log('  13g: writeState 并发合并（基线合并 + 删除权威）✅')
}

// ═══ 测试组 14: 归属判据（T-H ①「任一状态执行行」） ═══════════════════════
// 本组的存在理由：T-A 的判据源是写回端点的 `updated`（running 命中行数），而
// e2e 的 stub 从来没有 commit-hash 端点 → writeback 恒失败 → attributed 恒 null
// → 按当时的降级语义（③=投）一律走降级投递。于是**三条判据在 e2e 里全不生效**，
// 测试全绿也不代表判据对。本组把两个端点都补上，让「静默」这条路径第一次可断言。
// （③ 的降级方向 2026-09-12 已翻为「静默让位」——判据缺端点时的失效形态从「恒投」
//  变成「恒静默」，同样不会自己显形，故本组「补端点 + 断言日志」照旧必要。）
// T-F 必改 1 追加：组内的 POST stub 镜像真实入口主闸（agent 入口缺 taskId → 400），
// 且 14b/14c/14e/14f 断言**载荷本体**带锚——上一轮那条「载荷无锚」的缺口在
// 「无条件 201 + 只数 POST 次数」下恒为绿，本组把它关掉。

/**
 * 归属场景 stub：写回 `updated`（旧判据源）与 executor（新判据源）各自可配，
 * 用来构造「两者结论相反」的场景——那正是 T-H ① 的靶心。
 * @param {number} cfg.updated — 写回响应里的 running 命中行数
 * @param {'ok'|404|500|'hang'} cfg.executor — executor 端点行为（'ok' = 存在任一状态执行行；
 *        'hang' = 永不响应，模拟探针超时/不可达）
 * @param {string|null} [cfg.executorTaskId='task-1'] — executor 回传的 taskId；
 *        传 null 表示**回传有 agentName 但 trace_id 空**（老库执行行）——自铸锚的另一条来路
 */
async function startAttributionStub({
  uuid,
  sessionId,
  updated,
  executor,
  executorTaskId = 'task-1',
  skippedAmbiguous = false,
}) {
  // urls 记 executor 端点的**逐次原始 URL**：该端点同时服务两件事——归属探针
  // （`probeAttribution`，不带 query）与实施者反查（`resolveExecutorName`，带 `?commit=`）。
  // 只数总数会把两者混为一谈，而「判据到底被咨询过吗」必须能分开数（见 14h/14i）。
  const hits = { writeback: 0, executor: 0, post: 0, urls: [] }
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
      // skippedAmbiguous = T-M 的服务端**拒写**（同 uuid 多猫在跑且没带 agentId）
      return json(200, {
        ok: true,
        updated,
        ...(skippedAmbiguous ? { skippedAmbiguous: true } : {}),
      })
    }
    if (req.url.startsWith(`/api/messages/${uuid}/executor`) && req.method === 'GET') {
      hits.executor++
      hits.urls.push(req.url)
      if (executor === 404) return json(404, { error: 'No execution log for this message' })
      if (executor === 500) return json(500, { error: 'boom' })
      // 'hang'：**不响应**——探针的 `AbortSignal.timeout(3000)` 到点 abort ⇒ catch ⇒ null
      //（探针超时那条子形态）。定时兜底销毁 socket，免得挂着的连接拖住 server.close()。
      if (executor === 'hang') {
        const t = setTimeout(() => req.socket.destroy(), 4000)
        req.on('close', () => clearTimeout(t))
        return
      }
      return json(200, {
        agentId: 'a-1',
        agentName: 'ds猫',
        ...(executorTaskId ? { taskId: executorTaskId } : {}),
      })
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      return json(200, [])
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      hits.post++
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw)
        postBodies.push(body)
        // 入口主闸**镜像**（T-F 必改 1）：真实 REST 通道固定以 `origin: 'agent'` 摄入，
        // `ingest.ts` 规则 5 对 agent 入口缺 taskId 一律 400。本 stub 原先是无条件 201，
        // 于是「载荷无锚」这个缺口在 e2e 里恒不显形——文档照样"投出"、断言照样绿：
        // 这层假绿正是上一轮没拦住它的直接原因。缺锚即 400 是对真机的忠实模拟。
        // 注意由此产生的盲区：4xx = fatal 不重试，`hits.post` 在 400 下**同样是 1**，
        // 所以本组的断言必须落在 `postBodies` 的载荷本体上（只数次数等于没测）。
        if (!body.taskId) return json(400, { error: '缺链锚：agent 投递必须携带 task_id' })
        json(201, { ok: true, messageId: 'm-new' })
      })
      return
    }
    json(404, { error: 'not found' })
  })
  return { server, url: `http://127.0.0.1:${port}`, hits, postBodies }
}

/**
 * 「投递本身恒瞬态失败」stub：写回 / 探针 / 会话反查都正常，只有 POST 打不通
 * （socket 直接断）+ 落库验证查不到 ⇒ `tryPostToCatstudy` 重试耗尽判 transient。
 * 用来构造 **drain 补投这一轮又失败** 的现场（P1/P2：来源标记必须在二次失败后保住）。
 *
 * `executor` 默认 '500'（探针查不动）是有意的：那样 post-commit 投 HEAD 那一步会判
 * **静默让位**、一次 POST 都不发，于是 POST 计数里只剩 drain 那一条的重试——读数干净，
 * 同时让用例对「查不动 → 投」的旧语义敏感（翻回去 ⇒ HEAD 再投 3 次，计数当场变）。
 */
async function startTransientPostStub({ uuid, sessionId, executor = 500 }) {
  let postHits = 0
  const { server, port } = await startStubServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      return json(200, { id: uuid, sessionId, role: 'user' })
    }
    if (req.url === `/api/messages/${uuid}/commit-hash` && req.method === 'POST') {
      return json(200, { ok: true, updated: 0 })
    }
    if (req.url.startsWith(`/api/messages/${uuid}/executor`) && req.method === 'GET') {
      if (executor === 404) return json(404, { error: 'No execution log for this message' })
      return json(500, { error: 'boom' })
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      return json(200, []) // 消息从未落库 → 落库验证失败 → transient
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits++
      req.socket.destroy()
      return
    }
    json(404, { error: 'not found' })
  })
  return { server, url: `http://127.0.0.1:${port}`, postHits: () => postHits }
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
  const logs14a = await captureLogs(() => runInProc(tmp, stub.url))

  assert(
    stub.hits.writeback === 1,
    `前置：写回应确实发生（实际 ${stub.hits.writeback}）——否则本场景没被构造出来`
  )
  // 三态之三：**调用成功但 0 行**（区别于 14g 的「拒写」）。两者都说成「已写回（命中 0）」
  // 正是旧实现的措辞病——这里钉住它有自己的说法。
  assert(
    logs14a.some((l) => l.includes('写回调用成功但命中 0 行')),
    '写回成功但 0 行命中的日志应自成一态（不得与 14g 的「拒写」混称）'
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
  assert(stub.postBodies.length === 0, `静默路径不该有载荷（实际 ${stub.postBodies.length} 条）`)

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
  // T-F 必改 1 的区分性断言：反查不到执行行 → 载荷必须**自铸锚**。
  // 为什么必须断载荷本体：stub 现在按 `body.taskId` 缺省返 400，而 4xx = fatal 不重试、
  // `hits.post` 照样是 1——只数 POST 次数的话，删掉自铸逻辑本用例仍会全绿。
  assert(stub.postBodies.length === 1, `应投出 1 条载荷（实际 ${stub.postBodies.length}）`)
  assert(
    UUID_RE.test(stub.postBodies[0]?.taskId || ''),
    `反查未命中 → 载荷必须自带链锚（自铸 uuid），实际 ${JSON.stringify(stub.postBodies[0]?.taskId)}`
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14b: 真手动提交（无执行行）→ 兜底投 1 条 ✅')
}

// 14h: pending 补投**重判归属**（2026-09-12 修 T-A 时期的分类错误）
//      hook 条目入 pending 的来路是「判了『无归属 → 投』而 POST 瞬态失败」，而那一刻
//      server 多半不可达 ⇒ 探针答不出（null）。**读数是时点值，不是这个 commit 的属性**：
//      下一轮 server 恢复 ⇒ 探针给出真答案（本用例 = 「有归属」）。原实现补投不重判 ⇒
//      一次时点读数被固化成永久事实，且此后每次投递机会都照投（实害：被 auto-commit
//      抢收的 agent 提交在 server 恢复后被永久误投，每 commit 叠一条无主的审查链）。
{
  const uuid = '14ab0000-0000-4000-8000-0000000000ab'
  const tmp = makeUuidRepo('.handoff-test-pending-rejudge', uuid, { 'a.txt': '1' })
  const sha = gitIn(tmp, 'rev-parse HEAD')
  // 手工构造「钩子那次 POST 瞬态失败」的现场：这笔 SHA 躺在 pending 里，来源 hook。
  // ⚠️ src 必须显式写 'hook'——裸字符串会被规范化成 'legacy'（不判、照投），
  // 那正是 14i 的场景，本用例的靶心（重判）就落空了。
  writeFileSync(
    join(tmp, STATE_FILE),
    JSON.stringify({ delivered: {}, pending: [{ sha, src: 'hook' }] })
  )
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14h',
    updated: 0, // 写回无 running 行（执行已终态）——无信息量，交探针
    executor: 'ok', // 探针：该 uuid 存在执行行 ⇒ 有归属
  })
  const logs14h = await captureLogs(() => runInProc(tmp, stub.url))
  const state14h = readStateFile(tmp)

  assert(stub.hits.post === 0, `补投重判为有归属 → 应静默（POST 0 次，实际 ${stub.hits.post}）`)
  assert(
    !pendingShas(state14h).includes(sha),
    '判静默即义务解除 ⇒ 应移出 pending——留着会每次投递机会重判一遍（探针往返 + 日志）'
  )
  assert(state14h.delivered[sha] === undefined, '静默不是投递 ⇒ 不得记 delivered（账本单态）')
  assert(
    logs14h.some((l) => l.includes('pending 移除')),
    '移出 pending 要有独立留痕：补投行只证明"试过"、静默行只说"不投"，都不是"移除"的证词'
  )
  // 对照组（证明本用例钉的不是恒真）：判据**确实被咨询过**——探针往返是这条分支的
  // 可观测成本。判据没跑（原实现：补投不带 judgeAttribution）这一格必为 0 而 POST 变 1。
  // ⚠️ 旧版此处断言 `decideHookDelivery(true).deliver === false`，只是把纯函数输出
  // 重述一遍、不驱动任何路径，撑不起「对照」这个标签（审查意见）。真正有判别力的是
  // 探针读数——它与 14i 的「兜底条目不咨询判据 ⇒ executor=0」构成同一场景形状的两面。
  assert(
    probeCalls(stub.hits) === 2,
    `hook 条目须被咨询判据两次——drain 补投重判 1 次 + post-commit 投 HEAD 再 1 次；` +
      `实际归属探针 ${probeCalls(stub.hits)} 次 / 名字反查 ${nameLookupCalls(stub.hits)} 次`
  )
  assert(
    nameLookupCalls(stub.hits) === 0,
    '两次裁决都判静默 ⇒ 从未走到投递，故不该有实施者反查（它一出现即"其实投了"的证词）'
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14h: pending 补投重判归属 → 静默 + 移出 pending（时点读数不固化）✅')
}

// 14i: 收尾兜底条目（src=fallback）补投**不得重判归属**（2026-09-12 二次修正）
//      首版让 drainPending 判**全部** pending 条目，依据是「条目进 pending 的唯一来路
//      是 POST 瞬态失败」——该前提是假的：瞬态失败是每条投递路径共有的入队方式，
//      --fallback-sha 与 --gate-deliver 同样会走。而兜底条目的 SHA 取自
//      execution_logs.commit_hash，**必然有归属** ⇒ 补投被判据判静默、移出 pending
//      ⇒ 收尾兜底整条失效（`review-fallback.ts` 明写「失败时随下次 post-commit /
//      pre-push 的 pending 逻辑补上」）。本用例两半都验：① 兜底入口失败入 pending 时
//      带 src；② 该条目补投**照投**、且判据**根本不被咨询**（与 14h 同场景形状，
//      executor 读数 0 vs 1 构成两面对照）。
{
  const uuid = '14ff0000-0000-4000-8000-00000000000f'
  const tmp = makeUuidRepo('.handoff-test-fallback-pending', uuid, { 'a.txt': '1' })
  const sha = gitIn(tmp, 'rev-parse HEAD')

  // ① 兜底入口 --fallback-sha → POST 瞬态失败（连接被打断 + 落库验证查不到）→ 入 pending
  let postHits14i = 0
  const { server: deadServer, port: deadPort } = await startStubServer((req, res) => {
    if (req.url === `/api/messages/${uuid}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: uuid, sessionId: 'session-14i', role: 'user' }))
      return
    }
    if (req.url.startsWith('/api/sessions/') && req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([])) // 消息从未落库 → 落库验证失败 → transient
      return
    }
    if (req.url === '/api/messages' && req.method === 'POST') {
      postHits14i++
      req.socket.destroy()
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await runInProc(tmp, `http://127.0.0.1:${deadPort}`, { fallbackSha: sha })
  const afterFail14i = readStateFile(tmp)
  assert(
    postHits14i === 3,
    `前置：POST 重试确实耗尽（实际 ${postHits14i}）——否则本场景没被构造出来`
  )
  assert(pendingShas(afterFail14i).includes(sha), '兜底投递瞬态失败 → SHA 应入 pending')
  assert(
    pendingSrcOf(afterFail14i, sha) === 'fallback',
    `兜底入口入 pending 须标 src=fallback（实际 ${pendingSrcOf(afterFail14i, sha)}）——` +
      '标成 hook 会让它在补投时被重判静默，收尾兜底失效'
  )
  assert(afterFail14i.delivered[sha] === undefined, '失败不得记 delivered（账本单态=真投过）')
  deadServer.close()

  // ② 换成「探针会答『有归属』」的 server：补投必须照投，且不得咨询判据
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14i',
    updated: 0, // 写回无 running 行——无信息量，逼判据去问探针
    executor: 'ok', // 探针：该 uuid 存在执行行 ⇒ 有归属（若被咨询，判据必静默）
  })
  const logs14i = await captureLogs(() => runInProc(tmp, stub.url))
  const afterDrain14i = readStateFile(tmp)
  assert(
    stub.hits.post === 1,
    `兜底条目补投应照投 1 条（实际 ${stub.hits.post}）——重判会把它砍成 0，` +
      '而这正是首版的行为（收尾兜底的审查请求永久消失）'
  )
  assert(
    probeCalls(stub.hits) === 0,
    `兜底条目不得咨询归属判据（实际归属探针 ${probeCalls(stub.hits)} 次）——` +
      '问了必答「有归属」⇒ 必静默（首版即如此，兜底审查请求永久消失）'
  )
  assert(
    nameLookupCalls(stub.hits) === 1,
    `兜底条目照投 ⇒ 恰好一次实施者反查（实际 ${nameLookupCalls(stub.hits)}）——` +
      '它与 probeCalls=0 分开数正是要点：反查是投递路径的例行调用，不是判据被咨询的证据'
  )
  assert(afterDrain14i.delivered[sha] !== undefined, '补投成功 → 应移入 delivered')
  assert(!pendingShas(afterDrain14i).includes(sha), '补投成功 → 应移出 pending')
  assert(
    logs14i.some((l) => l.includes('来源 fallback，不判归属')),
    '补投日志须自带来源与「不判归属」——本票唯一安全网是留痕，判错方向要能一眼看出来'
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14i: 兜底条目补投 → 照投 + 不咨询判据（收尾兜底不被重判砍掉）✅')
}

// 14k（P3/P1）: `src='fallback'` 条目在 drain 补投时**再次**瞬态失败 ⇒ src 必须保住
//      为什么必须钉：`drainPending` 以 `pendingSrc: entry.src` 原样透传（本条的唯一被测面）。
//      src 一旦退化成 `legacy`/`hook`，下一轮 drain 就会把**兜底条目**当钩子条目去重判归属
//      ⇒ 判静默砍掉 ⇒ ef8c752 修好的安全网又断（`--fallback-sha` 的审查请求永久消失）。
//      14i 只覆盖「失败一次 → drain 成功」；「drain 里再失败一次」是本条补的格子，
//      也是该安全网**唯一**的报警器。
{
  // ⚠️ uuid 必须**十六进制**（`extractCommitUuid` 只认 [0-9a-f]）——写成 14kk… 会被判
  // 「commit message 无 uuid」，用例当场退化成「手动提交」路径、断言全不成立。
  const uuid = '14b10000-0000-4000-8000-0000000000b1'
  const tmp = makeSpanRepo('.handoff-test-fallback-resrc', uuid, [
    ['a.txt', '1'],
    ['b.txt', '2'],
  ])
  // 靶心取 HEAD~1：它有父提交（drain 按 `<sha>~1..<sha>` 生成文档，根提交会生成不出内容
  // 而被当"无内容可投"记 delivered、绕开被测路径），且与 HEAD 不同 SHA ⇒ HEAD 那一步的
  // 读数不会串到本条条目的 src 上。
  const target = gitIn(tmp, 'rev-parse HEAD~1')
  writeFileSync(
    join(tmp, STATE_FILE),
    JSON.stringify({ delivered: {}, pending: [{ sha: target, src: 'fallback' }] })
  )
  const stub = await startTransientPostStub({ uuid, sessionId: 'session-14k' })
  await runInProc(tmp, stub.url)
  const state14k = readStateFile(tmp)

  assert(
    stub.postHits() === 3,
    `前置 + 判别力：POST 恰为 drain 那一条的重试上限（实际 ${stub.postHits()}）——` +
      'HEAD 那一步探针查不动 ⇒ 静默让位 ⇒ 0 次；旧语义（查不动一律投）下这里会变 6'
  )
  assert(
    pendingShas(state14k).includes(target),
    '二次瞬态失败 → 该 SHA 仍须在 pending（义务不得凭空消失）'
  )
  assert(
    pendingSrcOf(state14k, target) === 'fallback',
    `二次失败后 src 必须保住（实际 ${pendingSrcOf(state14k, target)}）——退化成 legacy/hook ` +
      '会让它在下一轮被当钩子条目重判静默，收尾兜底整条失效'
  )
  assert(state14k.delivered[target] === undefined, '失败不得记 delivered（账本单态=真投过）')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14k: fallback 条目二次瞬态失败 → 仍在 pending 且 src 保住 ✅')
}

// 14l（P3/P2）: 同款覆盖 `src='gate'`（`deliverHeadIfUndelivered` 的 `pendingSrc: 'gate'`）
//      与 14k 同一形状、不同来路：门禁兜底条目的 SHA 同样「必然有归属」，退化后一样会被
//      重判静默砍掉。两条合起来才证明保住 src 是 drain 的通用行为，不是 fallback 的特例。
{
  const uuid = '14b20000-0000-4000-8000-0000000000b2'
  const tmp = makeSpanRepo('.handoff-test-gate-resrc', uuid, [
    ['c.txt', '1'],
    ['d.txt', '2'],
  ])
  const target = gitIn(tmp, 'rev-parse HEAD~1')
  writeFileSync(
    join(tmp, STATE_FILE),
    JSON.stringify({ delivered: {}, pending: [{ sha: target, src: 'gate' }] })
  )
  const stub = await startTransientPostStub({ uuid, sessionId: 'session-14l' })
  await runInProc(tmp, stub.url)
  const state14l = readStateFile(tmp)

  assert(
    stub.postHits() === 3,
    `前置 + 判别力：POST 恰为 drain 那一条的重试上限（实际 ${stub.postHits()}）`
  )
  assert(pendingShas(state14l).includes(target), '二次瞬态失败 → 该 SHA 仍须在 pending')
  assert(
    pendingSrcOf(state14l, target) === 'gate',
    `二次失败后 src 必须保住（实际 ${pendingSrcOf(state14l, target)}）——gate 条目被重判归属` +
      '同样会被判静默砍掉（它取自 pre-push 的门禁兜底，判据问了必答「有归属」）'
  )
  assert(state14l.delivered[target] === undefined, '失败不得记 delivered（账本单态=真投过）')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14l: gate 条目二次瞬态失败 → 仍在 pending 且 src 保住 ✅')
}

// 14c: 探针查不动（executor 500 = 响应不可解析）→ **静默让位**（A 案，2026-09-12 翻转）
//      旧语义是「一律投递，不静默吞」——本用例原样钉着它，故判据一翻它必红，就地翻转。
//      为什么查不动不再投：查不动最常见于 server 正忙着跑那只猫（=「有归属」的字面状态），
//      钩子此刻投出去的是 Why/Tradeoff/OQ 全 TODO 的空壳，猫补填后还会再投一份完整版
//      （内容不同 ⇒ 过不了内容去重 ⇒ 审查者收到两份）。让位 ≠ 永久放弃：义务归实施猫
//      铁律自投，漏了由收尾兜底 `--fallback-sha` 接手。
{
  const uuid = '14cc0000-0000-4000-8000-00000000000c'
  const tmp = makeUuidRepo('.handoff-test-attr-unprobeable', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14c',
    updated: 0,
    executor: 500,
  })
  const logs14c = await captureLogs(() => runInProc(tmp, stub.url))
  const state14c = existsSync(join(tmp, STATE_FILE))
    ? readStateFile(tmp)
    : { delivered: {}, pending: [] }

  assert(stub.hits.post === 0, `探针查不动 → 静默让位（POST 0 次，实际 ${stub.hits.post}）`)
  assert(
    // 断言**判词字段本身**（`🔎 兜底投递判据: 静默`），不是「整行含『静默』」：
    // 后者会被 reason 文案里的「静默让位」蒙混过关——`deliver` 翻回 true 时日志会打出
    // 「判据: 投递——…静默让位…」这种自相矛盾的行，而宽松断言照样绿（实测踩到）。
    logs14c.some((l) => l.includes('兜底投递判据: 静默')),
    '静默要有留痕，且必须落在判词字段上——本票唯一的安全网就是日志'
  )
  assert(
    logs14c.some((l) => l.includes('探针查不动')),
    '日志须写明归属来源是「探针查不动」，不得与「有归属静默」混称（陈述假机制的老病）'
  )
  assert(
    Object.keys(state14c.delivered).length === 0,
    '静默不是投递 ⇒ 不得记 delivered（账本单态=真投过）'
  )
  assert(pendingShas(state14c).length === 0, '静默不入 pending——不入的是「待补投」，义务另有所归')
  assert(stub.postBodies.length === 0, `静默路径不该有载荷（实际 ${stub.postBodies.length} 条）`)

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14c: 探针查不动（HTTP 500）→ 静默让位（POST 0 / 无账本 / 无 pending）✅')
}

// 14j（A7，新增）: 探针**超时**（不可达）⇒ 同一结论——静默让位
//      与 14c 是 `probeAttribution` 同一 `null` 分支的两个子形态：14c = 服务端答了但
//      答不成（HTTP 500），本用例 = 服务端压根不答（`AbortSignal.timeout(3000)` 到点 abort）。
//      **判别力对照**：把 `decideHookDelivery` 里 `null` 那一格改回 `deliver: true` ⇒
//      本用例 POST 变 1、日志不含「静默」、状态文件多一条 pending，三条断言全红。
{
  const uuid = '14c20000-0000-4000-8000-0000000000c2'
  const tmp = makeUuidRepo('.handoff-test-attr-probe-timeout', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14j',
    updated: 0,
    executor: 'hang', // 永不响应 ⇒ 探针 3s 超时 ⇒ catch ⇒ null
  })
  const logs14j = await captureLogs(() => runInProc(tmp, stub.url))
  const state14j = existsSync(join(tmp, STATE_FILE))
    ? readStateFile(tmp)
    : { delivered: {}, pending: [] }

  assert(stub.hits.post === 0, `探针超时 → 静默让位（POST 0 次，实际 ${stub.hits.post}）`)
  assert(
    logs14j.some((l) => l.includes('兜底投递判据: 静默')),
    '静默要有留痕，且必须落在判词字段上（不是整行含「静默」——reason 文案里也有那两个字）'
  )
  assert(
    logs14j.some((l) => l.includes('探针查不动')),
    '日志须写明归属来源是「探针查不动」——超时与「有归属」「无归属」三态不可混称'
  )
  assert(
    Object.keys(state14j.delivered).length === 0,
    '静默不是投递 ⇒ 不得记 delivered（账本单态=真投过）'
  )
  assert(pendingShas(state14j).length === 0, '静默不入 pending——「让位」不等于「待补投」')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14j: 探针超时 → 静默让位（POST 0 / 无账本 / 无 pending）✅')
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
  const logs14d = await captureLogs(() => runInProc(tmp, stub.url))

  assert(stub.hits.post === 0, `写回命中 running 行 → 有归属 → 静默（实际 ${stub.hits.post}）`)
  assert(
    stub.hits.executor === 0,
    `正信号短路：命中 running 行即已确证有归属，不应再问探针（实际 ${stub.hits.executor}）`
  )
  assert(stub.postBodies.length === 0, `静默路径不该有载荷（实际 ${stub.postBodies.length} 条）`)
  // 阳性对照：真命中时必须打「已写回」——14g 断言拒写时**不**打这一行，
  // 得先钉住这一行在正常路径上确实存在，否则「不打」可能只是它压根被删了。
  assert(
    logs14d.some((l) => l.includes('commit_hash 已写回 execution_logs')),
    '写回命中 1 行时应打「已写回」（14g 的阴性对照基线）'
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14d: 写回命中 running 行 → 静默且省掉探针往返 ✅')
}

// 14g: 服务端**拒写**（同 uuid 多猫在跑且无 CATSTUDY_AGENT_ID ⇒ skippedAmbiguous）
//      日志必须只说「未写回…不猜」，**不得**紧跟一行「已写回（命中 0）」。
//      旧实现是无条件打印：相邻两行自相矛盾（上一行「未写回」/ 下一行「已写回」），
//      而日志是本票唯一观测面——矛盾的一行会把排障引向「服务端没写」，
//      真因却是「客户端没带 agentId」，两个方向的修法相反。
{
  // 必须全 hex：`extractCommitUuid` 按 UUID 形态匹配，含非 hex 字符会被判成
  // 「commit message 无 uuid」而走手动提交路径——那样就绕开了写回，测不到本组
  const uuid = '14ee0000-0000-4000-8000-00000000000e'
  const tmp = makeUuidRepo('.handoff-test-attr-ambiguous', uuid, { 'a.txt': '1' })
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14g',
    updated: 0,
    skippedAmbiguous: true,
    executor: 'ok',
  })
  const logs14g = await captureLogs(() => runInProc(tmp, stub.url))

  assert(
    logs14g.some((l) => l.includes('commit_hash 未写回')),
    '拒写应打「未写回…不猜」（T-M）'
  )
  assert(
    !logs14g.some((l) => l.includes('commit_hash 已写回')),
    '拒写时**不得**再打「已写回」——相邻两行自相矛盾（旧实现必红：它无条件打印这一行）'
  )
  // 三态互斥：拒写 ≠ 「调用成功但没命中」——旧实现把两者都说成「已写回（命中 running 行 0）」，
  // 混淆的正是这两类 0 的后续处置（一个去问探针，一个是真没归属线索）。
  assert(
    !logs14g.some((l) => l.includes('命中 running 行 0')),
    '拒写不得复用「命中 running 行 0」这套措辞（那是「调用成功但 0 行」，另一态）'
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14g: 服务端拒写 → 日志只说「未写回」，不再跟一行「已写回」✅')
}

// 14e: 用户终端**手动提交**（commit message 无 catstudy [uuid]）→ 兜底投递且自铸锚
//      这是 T-F 必改 1 的原始病案：无 uuid ⇒ 无源链可反查 ⇒ 载荷原本不带锚 ⇒
//      入口主闸 400 ⇒ 4xx=fatal 不重试、连 pending 都不留，「手动提交补投通路 100% 死」
//      （spec D5 / 用户故事 14 整条边界）。无 uuid 反查不出会话，投递目标按既有契约
//      由 CATSTUDY_SESSION_ID 人工指定——本用例顺带钉住这条契约。
{
  const tmp = makeCommitRepo(
    '.handoff-test-attr-manual-nouuid',
    { 'a.txt': '1' },
    'chore: 手动提交'
  )
  const stub = await startAttributionStub({
    uuid: 'unused-no-uuid',
    sessionId: 'session-14e',
    updated: 0,
    executor: 404,
  })

  const prevUrl = process.env.CATSTUDY_URL
  const prevSid = process.env.CATSTUDY_SESSION_ID
  process.env.CATSTUDY_URL = stub.url
  process.env.CATSTUDY_SESSION_ID = 'session-14e'
  try {
    await runHandoff({ cwd: tmp })
  } finally {
    if (prevUrl === undefined) delete process.env.CATSTUDY_URL
    else process.env.CATSTUDY_URL = prevUrl
    if (prevSid === undefined) delete process.env.CATSTUDY_SESSION_ID
    else process.env.CATSTUDY_SESSION_ID = prevSid
  }

  assert(stub.hits.post === 1, `手动提交 → 应兜底投 1 条（实际 ${stub.hits.post}）`)
  assert(stub.postBodies.length === 1, `应投出 1 条载荷（实际 ${stub.postBodies.length}）`)
  assert(
    UUID_RE.test(stub.postBodies[0]?.taskId || ''),
    `无 uuid 路径必须自铸锚，实际 ${JSON.stringify(stub.postBodies[0]?.taskId)}`
  )
  // 阴性对照：无 uuid 时 `attributed` 的初值是 `false`（不是 `null`）⇒ 归属判据判
  // 「无归属 → 投递」，与自铸锚是两件事——判"该投"不等于**投得出去**（原缺口正是死在
  // 这一步）。A4 安全底线：本次翻转改的是 `null` 那格，`false` 这一格一字未动。
  // ⚠️ 旧版本行传的是 `null` 却在注释里写「无 uuid 路径」——**陈述假机制**（`null` 是
  // 探针查不动那一格，2026-09-12 起判静默）。实参改成 `false` 后与注释所述机制一致。
  assert(
    decideHookDelivery(false).deliver === true,
    '阴性对照：无 uuid 路径（attributed=false）的归属判据确实判「投」——缺口在载荷无锚，不在判据'
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14e: 手动提交（无 uuid）→ 自铸锚兜底投递 ✅')
}

// 14f: 执行行**存在但 trace_id 空**（executor 200 有 agentName、无 taskId）→ 自铸锚
//      走 --fallback-sha 入口（收尾兜底，不跑归属判据）：post-commit 入口下这条路径会被
//      探针判「有归属 → 静默」，本就到不了投递；而收尾兜底必然要投，锚却取不到
//      ——「任何无锚载荷一律自铸锚」这条兜底要覆盖的第二种来路。
{
  const uuid = '14ff0000-0000-4000-8000-00000000000f'
  const tmp = makeUuidRepo('.handoff-test-attr-empty-trace', uuid, { 'a.txt': '1' })
  const headSha = gitIn(tmp, 'rev-parse HEAD')
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-14f',
    updated: 0,
    executor: 'ok',
    executorTaskId: null, // 老库执行行：有执行、trace_id 列空
  })
  await runInProc(tmp, stub.url, { fallbackSha: headSha })

  assert(
    stub.hits.executor === 1,
    `前置：实施者反查确实发生（实际 ${stub.hits.executor}）——否则本场景没被构造出来`
  )
  assert(stub.postBodies.length === 1, `应投出 1 条载荷（实际 ${stub.postBodies.length}）`)
  assert(
    UUID_RE.test(stub.postBodies[0]?.taskId || ''),
    `trace_id 空路径必须自铸锚，实际 ${JSON.stringify(stub.postBodies[0]?.taskId)}`
  )
  // 反查本身是成功的（补填人仍取到 ds猫）——自铸锚不因反查"半成功"而退化成兜底店长
  assert(
    (stub.postBodies[0]?.mentions || []).includes('ds猫'),
    `实施者反查仍应生效（补填人 = ds猫），实际 ${JSON.stringify(stub.postBodies[0]?.mentions)}`
  )

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  14f: 执行行 trace_id 空 → 自铸锚投递（补填人仍取到）✅')
}

// ═══ 测试组 15: 审查请求覆盖裁决（T-H ②「只看 HEAD」） ═══════════════════════
// 裁决：一次派发 = 一条审查请求，锚在该派发**最新**的 commit——改动面也就只有它。
// 本组把这个裁决**钉成契约**（而不是让它靠"碰巧如此"）：同一次派发里更早的 commit
// 不进这条请求的改动面。这是**有意接受**的已知缺口，不是漏改——替代方案（逐 commit
// 各投一条 / 按 uuid 回溯成段）均已实测否决，理由见 handoff-gen.mjs 文件头 T-H ②。
//
// 为什么用「断言不含」来钉一个缺口：缺口本身是裁决的一部分（「代码与裁决一致」的
// 要求）。哪天有人重提「按 uuid 回溯扩展改动面」，这条会红，并把他引到文件头那段
// 实测证据（回溯会裹进兄弟票——本 workflow 里「一条消息 @ 两只猫」是常态）。

/** 基础提交（无 uuid）+ N 个共享同一 catstudy uuid 的提交（模拟"一次派发多 commit"） */
function makeSpanRepo(dirName, uuid, commits) {
  const tmp = join(TEST_BASE, dirName)
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

// 15a: 同一 uuid 两个 commit → 改动面**只看 HEAD**（更早的 commit 属有意缺口，见本组头注与
// handoff-gen.mjs 文件头 T-H ②——「按 uuid 回溯成段」已实测否决并回退）
{
  const uuid = '15aa0000-0000-4000-8000-00000000000a'
  const tmp = makeSpanRepo('.handoff-test-span-multi', uuid, [
    ['a.txt', '1'],
    ['b.txt', '2'],
  ])
  const headSha = gitIn(tmp, 'rev-parse HEAD')

  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-15a',
    updated: 0,
    executor: 404, // 无执行行 → 走兜底投递，好把文档正文抓下来
  })
  await runInProc(tmp, stub.url)

  assert(stub.postBodies.length === 1, `应投出 1 条（实际 ${stub.postBodies.length}）`)
  const doc = stub.postBodies[0]?.content || ''
  assertContains(doc, 'b.txt', 'HEAD commit 的文件应在改动面内')
  assertNotContains(
    doc,
    'a.txt',
    '裁决：同派发里更早的 commit（a.txt）**不在**本请求改动面内——这是有意的「一次派发一条请求」代价'
  )
  assertContains(
    doc,
    `git show ${gitIn(tmp, `log -1 --pretty=%h ${headSha}`)}`,
    '审查须知指向 HEAD 自身的绝对引用（不扩展成 commit 段）'
  )
  assertNotContains(doc, '连续', '不应出现「连续 N 个 commit」这类段式措辞')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('  15a: 多 commit 同派发 → 改动面只看 HEAD（裁决契约）✅')
}

console.log('')

// ═══ 测试组 16: 免审白名单（票乙：纯 docs/run/** 提交不发起审查轮） ═══════════
// 靶心：在飞过程文档每落一次盘 → handoff 投一条审查请求（噪声 + 唤醒回环）。
// 16a 是主判据；16b–16e 是它的四道**非恒真护栏**——没有它们，「POST = 0」在
// stub 没接上 / 会话反查失败 / 判据恒真时同样绿，那是本仓踩过的假绿形态。
//
// 16d 是**审查回炉补的**（P2 实害）：首版判据带 `!process.env.CATSTUDY_SESSION_ID`
// 前置，而该 env 是 server 注入给每只猫 CLI 的**常驻变量**（`llm/claude.ts:361` /
// `llm/opencode.ts:91` / `llm/dsh.ts:94`），钩子（裸 node 调用）全量继承它 ⇒ 前置在
// 产品路径上恒为假，免审豁免等于不存在。首版之所以全绿：样本跑在
// `env -u CATSTUDY_SESSION_ID` 下——**验证面不是被判面**（本仓记过的假绿形态）。
// 16d 把「猫的真实环境」钉成用例。四条用例各用独立临时仓库（账本按仓库隔离）。

/**
 * 建一个**有父提交**的仓库（首提交为 'chore: base'）。
 * 必须两步：`changedPathsOf` 走 `<sha>~1..<sha>`，根 commit 没有 `~1` ⇒ 异常分支
 * ⇒ 判据查不动 ⇒ 不豁免（安全侧）。本组要验的是**正常提交**上的豁免，故造父提交。
 */
function makeRepoWithParent(dirName, baseFiles, files, commitMsg) {
  const tmp = makeCommitRepo(dirName, baseFiles, 'chore: base')
  for (const [fp, content] of Object.entries(files)) {
    const abs = join(tmp, fp)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  execSync('git add -A', { cwd: tmp, stdio: 'pipe' })
  execSync(`git commit -m "${commitMsg}"`, { cwd: tmp, stdio: 'pipe' })
  return tmp
}

/**
 * runInProc 的 env 注入版：显式设置一组 env（值传 `undefined` = 显式清空）。
 * 16 组用它构造「生产环境形态」（CATSTUDY_SESSION_ID 常驻）与「显式意图」
 * （CATSTUDY_FORCE_DELIVER=1）两种条件——**只差 env，其余全同**。
 */
async function runInProcWithEnv(cwd, url, envPairs, opts = {}) {
  const prevUrl = process.env.CATSTUDY_URL
  const saved = new Map()
  process.env.CATSTUDY_URL = url
  for (const [k, v] of Object.entries(envPairs)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await runHandoff({ cwd, ...opts })
  } finally {
    if (prevUrl === undefined) delete process.env.CATSTUDY_URL
    else process.env.CATSTUDY_URL = prevUrl
    for (const [k, prev] of saved) {
      if (prev === undefined) delete process.env[k]
      else process.env[k] = prev
    }
  }
}

/** HEAD commit 的改动路径（断言「场景确被构造出来」用——判据对了但 fixture 错了同样是假绿） */
function changedPathsOfHead(tmp) {
  return gitIn(tmp, 'diff --name-status HEAD~1..HEAD')
    .split('\n')
    .map((l) => l.split('\t').pop())
    .filter(Boolean)
}

// 16a–16e：纯 docs/run 提交（判据靶心）。四条用例各用独立仓库，共用一个 stub。
{
  const uuid = '16aa0000-0000-4000-8000-000000000016'
  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-16a',
    updated: 0,
    executor: 'ok',
  })
  /** 纯 docs/run 提交、**带父提交**（`changedPathsOf` 走 `<sha>~1..<sha>`） */
  const mkExemptRepo = (dirName) =>
    makeRepoWithParent(
      dirName,
      { 'README.md': '# base\n' },
      { 'docs/run/memory-flywheel/map.md': '# 地图\n' },
      `catstudy [${uuid}] docs(map): 落图`
    )

  // 16a: env 未设（人工终端直跑）→ 判静默（POST 0 + 留痕 + 不记账本）
  {
    const tmp = mkExemptRepo('.handoff-test-exempt-docsrun')
    const headSha = gitIn(tmp, 'rev-parse HEAD')
    const paths = changedPathsOfHead(tmp)
    assert(
      paths.length > 0 && paths.every((p) => p.startsWith('docs/run/')),
      `前置：HEAD 确为纯 docs/run 提交（实际 ${JSON.stringify(paths)}）——否则本场景没被构造出来`
    )

    const post0 = stub.hits.post
    const exec0 = stub.hits.executor
    let threw = null
    const logs16a = await captureLogs(async () => {
      try {
        await runInProc(tmp, stub.url, { fallbackSha: headSha })
      } catch (err) {
        threw = err
      }
    })

    // A4：进程内 `runHandoff` 返回即等价 exit 0（顶层 catch 也兜异常，故"不抛"要显式断言）
    assert(threw === null, `免审路径不得抛异常（实际 ${threw?.message}）`)
    assert(stub.hits.post === post0, `纯 docs/run 提交不得 POST（实际 ${stub.hits.post - post0}）`)
    assert(
      logs16a.some((l) => l.includes('免审')),
      '应留痕一行含「免审」（可 grep）——否则「静默」与「投递链路整个坏掉」不可区分'
    )
    assert(
      stub.hits.executor === exec0,
      `应在实施者反查**之前**返回（实际反查 ${stub.hits.executor - exec0} 次）——否则静默点不在入口`
    )
    assert(
      !existsSync(join(tmp, STATE_FILE)),
      '判静默不得记账本（账本单态 = 真投过；记了会锁死收尾兜底）'
    )
    console.log('  16a: 纯 docs/run 提交（env 未设）→ 判静默（POST 0 / 留痕 / 不记账本）✅')
  }

  // 16d（回归·本轮新增）：**生产环境形态** —— CATSTUDY_SESSION_ID 由 server 注入给猫的
  //      CLI（llm/claude.ts:361），`.husky/post-commit` 是裸 node 调用、全量继承它。
  //      首版判据「该 env 未设 且 全免审」在此形态下恒假 ⇒ 纯 docs 提交照发审查请求。
  //      与 16a **同 sha 形态、只差这一个 env**：任何差异只能归因于它。
  {
    const tmp = mkExemptRepo('.handoff-test-exempt-prodenv')
    const headSha = gitIn(tmp, 'rev-parse HEAD')
    const post0 = stub.hits.post
    let threw = null
    const logs16d = await captureLogs(async () => {
      try {
        await runInProcWithEnv(
          tmp,
          stub.url,
          { CATSTUDY_SESSION_ID: 'session-16d', CATSTUDY_FORCE_DELIVER: undefined },
          { fallbackSha: headSha }
        )
      } catch (err) {
        threw = err
      }
    })

    assert(threw === null, `生产形态下免审路径不得抛异常（实际 ${threw?.message}）`)
    assert(
      stub.hits.post === post0,
      `生产形态（CATSTUDY_SESSION_ID 常驻）下仍须判静默——实际 POST ${stub.hits.post - post0} 次`
    )
    assert(
      logs16d.some((l) => l.includes('免审')),
      '生产形态下应留痕含「免审」——首版在此形态判「照常投递」，正是回炉的那条 P2'
    )
    assert(!existsSync(join(tmp, STATE_FILE)), '生产形态下同样不得记账本')
    console.log('  16d: 生产形态（CATSTUDY_SESSION_ID 常驻，无强制开关）→ 仍判静默 ✅')
  }

  // 16c: 显式意图 = CATSTUDY_FORCE_DELIVER=1 → 强制投递，豁免不得把它吞掉
  //      （首版这个信号源是 CATSTUDY_SESSION_ID——它在生产路径上恒为真，等于没有开关）
  {
    const tmp = mkExemptRepo('.handoff-test-exempt-force')
    const headSha = gitIn(tmp, 'rev-parse HEAD')
    const post0 = stub.hits.post
    const logs16c = await captureLogs(() =>
      runInProcWithEnv(
        tmp,
        stub.url,
        { CATSTUDY_SESSION_ID: undefined, CATSTUDY_FORCE_DELIVER: '1' },
        { fallbackSha: headSha }
      )
    )
    assert(
      stub.hits.post === post0 + 1,
      `强制投递不得被白名单吞掉（实际 POST ${stub.hits.post - post0} 次）——人工重投旁路必须活着`
    )
    assert(
      !logs16c.some((l) => l.includes('免审')),
      'FORCE_DELIVER=1 时不应走豁免分支（判据是「未强制 且 全免审」）'
    )
    assert(
      existsSync(join(tmp, STATE_FILE)),
      '16c 真投递 → 应落 delivered 账本（与 16a 的「不记账本」成对照）'
    )
    console.log('  16c: CATSTUDY_FORCE_DELIVER=1 → 显式意图优先，照常投递 ✅')
  }

  // 16e: 生产形态 + 强制开关并存 → 仍照常投递（两个信号不得互相污染）
  {
    const tmp = mkExemptRepo('.handoff-test-exempt-prodenv-force')
    const headSha = gitIn(tmp, 'rev-parse HEAD')
    const post0 = stub.hits.post
    await runInProcWithEnv(
      tmp,
      stub.url,
      { CATSTUDY_SESSION_ID: 'session-16e', CATSTUDY_FORCE_DELIVER: 'true' },
      { fallbackSha: headSha }
    )
    assert(
      stub.hits.post === post0 + 1,
      `生产形态下强制开关仍须生效（实际 POST ${stub.hits.post - post0} 次）`
    )
    assert(existsSync(join(tmp, STATE_FILE)), '16e 真投递 → 应落 delivered 账本')
    console.log('  16e: 生产形态 + FORCE_DELIVER=true → 照常投递 ✅')
  }

  stub.server.close()
}

// 16b: 混合改动（一条 docs/run + 一条 packages/server）→ 照常投递，不回归
{
  const uuid = '16bb0000-0000-4000-8000-000000000016'
  const tmp = makeRepoWithParent(
    '.handoff-test-exempt-mixed',
    { 'README.md': '# base\n' },
    { 'docs/run/a.md': '# a\n', 'packages/server/src/x.ts': 'export const x = 1\n' },
    `catstudy [${uuid}] feat: 混合改动`
  )
  const headSha = gitIn(tmp, 'rev-parse HEAD')
  const paths = changedPathsOfHead(tmp)
  assert(
    paths.includes('docs/run/a.md') && paths.includes('packages/server/src/x.ts'),
    `前置：混合场景确被构造出来（实际 ${JSON.stringify(paths)}）`
  )

  const stub = await startAttributionStub({
    uuid,
    sessionId: 'session-16b',
    updated: 0,
    executor: 'ok',
  })
  const logs16b = await captureLogs(() => runInProc(tmp, stub.url, { fallbackSha: headSha }))

  // 非恒真护栏：同一 stub、同一入口，只差改动面 ⇒ 16a 的 POST 0 不是「stub 没接上」
  assert(stub.hits.post === 1, `混合改动应照常投递（实际 POST ${stub.hits.post} 次）`)
  assert(
    !logs16b.some((l) => l.includes('免审')),
    '只要有一条非免审路径，整条提交照常走审查——不得出现「免审」留痕'
  )
  console.log('  16b: 混合改动 → 照常投递（免审判据不是恒真门）✅')

  stub.server.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log('')

// ─── 入口主闸镜像：接线自证 + 不变式 ────────────────────────

// **非恒真**：本组是"镜像真被接上"的自证。镜像若没接（或接成死代码），
// 下面所有投递断言都仍然全绿——那正是本轮要消灭的假绿形态。
assert(
  gatedPostBodies.length > 0,
  `入口主闸镜像应至少放行过一次 POST（实际 0 次 ⇒ 镜像没接上，投递类断言全部成了恒真门）`
)
// 以下两条**构造上恒真**（闸门已先拦），留作诊断：失败信息指向真因而不是
// 让人去猜为什么某条投递用例莫名变红。
assert(
  gatedPostBodies.every((b) => b?.taskId),
  '放行载荷应全部带锚（闸门已保证；此处若红说明有人绕过了 handleMessagePost）'
)
assert(
  gatedPostBodies.every((b) => !(b?.mentions ?? []).some((n) => STUB_REVIEWER_NAMES.includes(n))),
  '放行载荷不应点名 reviewer——真机上那会触发「审查类投递缺 chainType」400（handoff-gen 从不发 chainType）'
)

// ─── Cleanup ────────────────────────────────────────────────

// 整个私有根一次删掉——不再逐个 rmSync，于是「漏删某个测试仓库」这个类别消失。
// 即便本进程在删之前崩掉，残留也落在系统临时目录里，不进仓库树。
rmSync(TEST_BASE, { recursive: true, force: true })

// ─── 结果汇总 ───────────────────────────────────────────────

console.log('═'.repeat(50))
console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`)
console.log('═'.repeat(50))

if (failed > 0) {
  process.exit(1)
}

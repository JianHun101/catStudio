/**
 * 端到端管道测试 — 通过真实 git commit 触发 post-commit hook 链路。
 *
 * 测试流程:
 *   1. 连接 cat-study server → 验证健康
 *   2. 查找（或创建）包含店长和吐槽猫的会话
 *   3. 创建测试文件 → git commit → post-commit hook → handoff-gen.mjs 自动投递
 *   4. 轮询 GET /api/sessions/:id/messages，等待 Agent 回复
 *   5. 验证：店长补填了 Why/Tradeoff/OQ → @吐槽猫被触发 → 吐槽猫生成审查回复
 *   6. 输出完整的消息链路 + 测试报告
 *   7. 清理：git reset --soft 撤销测试 commit
 *
 * 用法:
 *   node scripts/handoff-pipeline.e2e.mjs
 *   node scripts/handoff-pipeline.e2e.mjs --timeout=300  # 自定义超时（秒）
 *   node scripts/handoff-pipeline.e2e.mjs --no-cleanup    # 保留测试 commit
 *
 * 环境变量:
 *   CATSTUDY_URL          服务器地址（默认 http://127.0.0.1:3200）
 *   CATSTUDY_SESSION_ID   目标会话 ID（自动查找包含店长+吐槽猫的会话）
 *
 * 测试期间会在 git 根下创建 scripts/.e2e-testing 标记文件，
 * 通知 server 跳过 agent 自动快照 commit（环境变量不跨进程，必须用文件）。
 *
 * 前置条件:
 *   1. cat-study server 必须运行（pnpm dev:server）
 *   2. seed 数据必须已初始化（自动，首次启动时完成）
 *   3. LLM API key 必须已配置（.env 文件）
 *   4. Git 仓库干净（无未提交的改动）
 *
 * Web 观察地址:
 *   cat-study Web UI: http://localhost:5173
 *   测试开始后，在 Web UI 中选择对应会话即可实时观察 Agent 的思考和回复。
 */

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ─── 配置 ────────────────────────────────────────────────────────

const SERVER_URL = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'
const WEB_URL = 'http://localhost:5173'
const POLL_INTERVAL_MS = 2000 // 轮询间隔
const DEFAULT_TIMEOUT_S = 300 // 默认超时（5 分钟）
const AGENT_REPLY_TIMEOUT_S = 180 // 单个 Agent 回复超时
const TEST_TRIGGER_FILE = 'scripts/.e2e-test-trigger.txt'
const E2E_MARKER_FILE = 'scripts/.e2e-testing'

// ─── Claude Code CLI 子进程检测 ─────────────────────────────────

/**
 * 检测当前进程是否在 CatStudy server 的 Claude Code CLI 子进程中运行。
 *
 * CatStudy 的 ClaudeAdapter 通过 spawnSupervised() 启动 Claude Code CLI，
 * supervisor 进程会设置 CATSTUDY_SUPERVISOR_PARENT_PID 指向 server 的 PID。
 * 该环境变量不会出现在其他 Claude Code 会话中，是精确的检测标记。
 *
 * 在此类子进程中运行 e2e 测试会导致：
 *   1. 循环调度（测试触发 dispatch → 同一 Agent → 死锁）
 *   2. dev.js 检测到文件变更 → 重启 server → 测试中断
 */
function isRunningInsideClaudeCode() {
  if (process.env.CATSTUDY_SUPERVISOR_PARENT_PID) {
    return true
  }
  return false
}

if (isRunningInsideClaudeCode()) {
  console.log('⚠️  检测到当前环境为 Claude Code CLI 子进程，跳过 e2e 测试。')
  console.log('   原因: 在 Agent 内部运行 e2e 测试会导致循环调度和 server 重启。')
  console.log('   请在终端中直接运行: node scripts/handoff-pipeline.e2e.mjs')
  process.exit(0)
}

// ─── e2e 标记文件 ────────────────────────────────────────────────
//
// server 与 e2e 是独立进程，环境变量不跨进程传递。
// 用标记文件（git 根下 scripts/.e2e-testing）让 server 的 gitCommit()
// 感知测试状态：文件存在 → 跳过 agent 自动快照 commit。
// 否则 agent 回复触发的 catstudy [uuid] commit 会被 stepCleanup 的
// git reset --soft 一起回退，破坏 execution_logs.commit_hash 指向的历史。

function e2eMarkerPath() {
  return resolve(ROOT, E2E_MARKER_FILE)
}

function createE2eMarker() {
  writeFileSync(
    e2eMarkerPath(),
    `# e2e 测试进行中 — server 应跳过 auto-commit\n# 由 handoff-pipeline.e2e.mjs 创建/清理\n`,
    'utf-8'
  )
}

function removeE2eMarker() {
  try {
    if (existsSync(e2eMarkerPath())) {
      unlinkSync(e2eMarkerPath())
      log('   ', `已删除 ${E2E_MARKER_FILE}`)
    }
  } catch {
    // 删除失败不阻塞主流程
  }
}

// Ctrl+C 时也要清理标记文件，否则残留标记会永久禁用 server 的 auto-commit
process.on('SIGINT', () => {
  removeE2eMarker()
  process.exit(130)
})

// ─── 工具函数 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { timeout: DEFAULT_TIMEOUT_S, cleanup: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout' && i + 1 < argv.length) {
      opts.timeout = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_S
    } else if (argv[i] === '--no-cleanup') {
      opts.cleanup = false
    }
  }
  return opts
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function log(emoji, msg) {
  console.log(`[${timestamp()}] ${emoji} ${msg}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Git 工具 ────────────────────────────────────────────────────

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function safeGit(cmd) {
  try {
    return git(cmd)
  } catch {
    return null
  }
}

// ─── 测试步骤 ────────────────────────────────────────────────────

/**
 * Step 1: 验证服务器健康
 */
async function stepHealthCheck() {
  log('🔍', 'Step 1/7: 检查服务器健康...')
  try {
    const data = await fetchJson(`${SERVER_URL}/api/health`)
    log('✅', `服务器在线 (uptime: ${Math.round(data.uptime)}s)`)
    return true
  } catch (err) {
    log('❌', `服务器不可达: ${err.message}`)
    console.log('')
    console.log('   请先启动 cat-study server:')
    console.log('     pnpm dev:server')
    console.log('   或: pnpm dev')
    return false
  }
}

/**
 * Step 2: 获取或创建包含店长和吐槽猫的会话
 */
async function stepFindSession() {
  log('🔍', 'Step 2/7: 查找测试会话...')

  const sessions = await fetchJson(`${SERVER_URL}/api/sessions`)
  const sessionList = Array.isArray(sessions) ? sessions : sessions?.sessions || []

  for (const s of sessionList) {
    const detail = await fetchJson(`${SERVER_URL}/api/sessions/${s.id}`)
    if (detail.agents) {
      const names = detail.agents.map((a) => a.name)
      if (names.includes('店长') && names.includes('吐槽猫')) {
        log('✅', `找到会话: "${detail.title}" (${detail.id})`)
        log('   ', `Agents: ${names.join(', ')}`)
        return detail
      }
    }
  }

  // 未找到 → 自动创建
  log('⚠️', '未找到包含店长+吐槽猫的会话，自动创建...')

  const agentsData = await fetchJson(`${SERVER_URL}/api/agents`)
  const agents = Array.isArray(agentsData) ? agentsData : agentsData?.agents || []
  const dianzhang = agents.find((a) => a.name === '店长')
  const reviewer = agents.find((a) => a.name === '吐槽猫')

  if (!dianzhang || !reviewer) {
    log('❌', '未找到店长或吐槽猫 agent——请先运行 seed')
    console.log('     pnpm seed')
    return null
  }

  const created = await fetchJson(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'E2E 管道测试',
      agentIds: [dianzhang.id, reviewer.id],
    }),
  })

  log('✅', `创建测试会话: "${created.title}" (${created.id})`)
  log('   ', `Agents: 店长, 吐槽猫`)
  return created
}

/**
 * Step 3: 用真实 git commit 触发 post-commit hook 链路
 *
 * 链路: git commit → .husky/post-commit → node scripts/handoff-gen.mjs
 *       → 生成交接文档 → POST /api/messages → 店长自动补填
 *
 * @returns {{ success: boolean, commitHash: string | null }}
 */
function stepTriggerRealHandoff(sessionId) {
  log('📤', 'Step 3/7: git commit → post-commit hook → handoff-gen...')
  log('   ', `触发文件: ${TEST_TRIGGER_FILE}`)

  // 1. 前置检查：工作区是否干净（忽略数据库 WAL 文件——server 运行中会持续写入）
  const statusRaw = safeGit('status --porcelain')
  const status = statusRaw
    ? statusRaw
        .split('\n')
        .filter((l) => l.trim() && !/\.db(-journal|-wal|-shm)?$/.test(l.trim()))
        .join('\n')
    : ''
  if (status) {
    log('⚠️', `工作区有未提交的改动，测试 commit 可能包含不相关文件:`)
    for (const line of status.split('\n').slice(0, 5)) {
      if (line.trim()) console.log(`     ${line}`)
    }
    console.log('')
    console.log('   建议先清理工作区: git checkout -- . && git clean -fd')
    return { success: false, commitHash: null }
  }

  // 2. 保存当前 HEAD
  const headBefore = safeGit('rev-parse HEAD')
  if (!headBefore) {
    log('❌', '无法获取当前 HEAD——仓库可能没有 commit')
    return { success: false, commitHash: null }
  }

  // 3. 创建测试文件
  const triggerPath = resolve(ROOT, TEST_TRIGGER_FILE)
  const triggerContent = [
    '# E2E 测试触发文件',
    `# 生成时间: ${new Date().toISOString()}`,
    '#',
    '# 此文件用于触发 post-commit hook → handoff-gen.mjs → cat-study 管道。',
    '# 测试完成后会自动清理（git reset --soft）。',
    '#',
    '# 改动说明:',
    '# - 新增 e2e pipeline 触发机制',
    '# - 测试 handoff-gen.mjs 对单文件变更的检测',
    '',
  ].join('\n')

  writeFileSync(triggerPath, triggerContent, 'utf-8')
  log('   ', `测试文件已创建: ${TEST_TRIGGER_FILE}`)

  // 4. 构造有意义的 commit message（handoff-gen 会解析它）
  const commitMsg = [
    'test: e2e 管道触发测试',
    '',
    '验证 post-commit → handoff-gen → 店长补填 → 吐槽猫审查的完整链路。',
    '新增 e2e 触发文件用于模拟真实代码变更场景。',
  ].join('\n')

  // 5. 设置环境变量，确保 handoff-gen 投递到正确的会话
  process.env.CATSTUDY_SESSION_ID = sessionId

  // 5b. 创建 e2e 标记文件，禁止 catstudy agent 在测试期间产生自动快照 commit
  //     注意：server 是独立进程，环境变量传不过去——必须用标记文件（跨进程可见）
  createE2eMarker()
  log('   ', `e2e 标记文件已创建: ${E2E_MARKER_FILE}`)

  // 6. git add + commit（post-commit hook 同步执行）
  let commitHash = null
  try {
    log('   ', 'git add + commit → 触发 post-commit hook...')
    git(`add ${TEST_TRIGGER_FILE}`)
    // 用 --allow-empty 兜底，但正常情况不会触发
    git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`)
    commitHash = safeGit('rev-parse HEAD')
    log('✅', `commit 完成 (${commitHash?.slice(0, 8)})`)
    log('   ', `post-commit hook 已将 handoff 投递到 cat-study`)
  } catch (err) {
    log('❌', `commit 失败: ${err.message}`)
    return { success: false, commitHash: null, headBefore }
  }

  return { success: true, commitHash, headBefore }
}

/**
 * Step 4: 等待店长补填回复
 */
async function stepWaitForStoreManager(sessionId, startTime) {
  log('⏳', 'Step 4/7: 等待店长补填 Why/Tradeoff/OQ...')
  log('   ', `Web UI: ${WEB_URL} — 可在会话页面实时观察`)

  const deadline = Date.now() + AGENT_REPLY_TIMEOUT_S * 1000
  let lastMsgCount = 0

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    try {
      const messages = await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/messages?limit=20`)

      const agentMsgs = messages.filter(
        (m) => m.role === 'agent' && new Date(m.createdAt) > startTime
      )

      if (agentMsgs.length > lastMsgCount) {
        lastMsgCount = agentMsgs.length
        for (const m of agentMsgs) {
          const preview = m.content.slice(0, 120).replace(/\n/g, ' ')
          log('📩', `[agent] ${preview}...`)
        }
      }

      // 找包含 Why/关键决策 的回复（说明店长已补填）
      const dmReply = agentMsgs.find(
        (m) =>
          (m.content.includes('Why') || m.content.includes('关键决策')) &&
          (m.content.includes('###') || m.content.includes('---'))
      )

      if (dmReply) {
        log('✅', `店长已补填交接文档 (${dmReply.id})`)
        log('   ', `内容长度: ${dmReply.content.length} 字符`)
        if (dmReply.content.includes('@吐槽猫')) {
          log('✅', '店长的回复中包含 @吐槽猫 — 将触发审查')
        } else {
          log('⚠️', '店长的回复中未包含 @吐槽猫 — 审查可能不会自动触发')
        }
        return dmReply
      }
    } catch (err) {
      log('⚠️', `轮询出错: ${err.message}`)
    }
  }

  log('❌', `等待店长回复超时 (${AGENT_REPLY_TIMEOUT_S}s)`)
  return null
}

/**
 * Step 5: 等待吐槽猫审查回复
 */
async function stepWaitForReviewer(sessionId, startTime, dmReplyId) {
  log('⏳', 'Step 5/7: 等待吐槽猫审查回复...')
  log('   ', '吐槽猫正在读取交接文档 + 代码 diff → 逐项检查...')

  const deadline = Date.now() + AGENT_REPLY_TIMEOUT_S * 1000

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    try {
      const messages = await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/messages?limit=30`)

      // 排除店长的回复（通过 ID），只找吐槽猫的新消息
      const agentMsgs = messages.filter(
        (m) => m.role === 'agent' && new Date(m.createdAt) > startTime && m.id !== dmReplyId
      )

      if (agentMsgs.length === 0) continue

      // 找吐槽猫的审查回复
      const reviewReply = agentMsgs.find(
        (m) =>
          m.content.includes('审查') ||
          m.content.includes('Review') ||
          m.content.includes('Checklist') ||
          m.content.includes('阻塞')
      )

      // NOTE: 500 字符阈值依赖吐槽猫当前 prompt 产生的回复长度（通常 800-5000 字符）。
      // 如果 prompt 修改导致回复风格变短，此阈值需同步调整，否则检测将静默失效。
      if (reviewReply && reviewReply.content.length > 500) {
        log('✅', `吐槽猫已完成审查回复 (${reviewReply.id})`)
        log('   ', `内容长度: ${reviewReply.content.length} 字符`)
        return reviewReply
      }

      // 兜底：排除店长后任何足够长的 agent 消息
      const fallback = agentMsgs.find((m) => m.content.length > 500)
      if (fallback) {
        log('✅', `吐槽猫已回复 (${fallback.id}), 内容长度: ${fallback.content.length} 字符`)
        return fallback
      }
    } catch (err) {
      log('⚠️', `轮询出错: ${err.message}`)
    }
  }

  log('⚠️', `等待吐槽猫回复超时 (${AGENT_REPLY_TIMEOUT_S}s)`)
  return null
}

/**
 * Step 6: 清理测试 commit 和文件
 *
 * 单 commit 场景：git reset --soft 回退测试 commit（无副作用）。
 * 多 commit 场景（可能包含 catstudy 快照 commit）：中止清理并提示手动处理——
 * 绝不 reset，否则会连快照 commit 一起回退，破坏 execution_logs.commit_hash 指向的历史。
 */
function stepCleanup(headBefore, testCommitHash) {
  if (!headBefore) return

  log('🧹', 'Step 6/7: 清理测试 commit...')

  let ok = true
  try {
    // 检查测试 commit 和 headBefore 之间是否有额外的中间 commit
    const currentHead = safeGit('rev-parse HEAD')
    const revList = safeGit(`rev-list ${headBefore}..${currentHead}`)
    const intermediateHashes = revList ? revList.split('\n').filter(Boolean) : []

    if (intermediateHashes.length === 0) {
      log('   ', '无中间 commit，跳过清理')
    } else if (intermediateHashes.length === 1) {
      // 只有一个 commit — 正常的测试场景，reset --soft 安全
      git(`reset --soft ${headBefore}`)
      log('   ', `git reset --soft ${headBefore.slice(0, 8)}`)

      // 删除测试触发文件
      const triggerPath = resolve(ROOT, TEST_TRIGGER_FILE)
      if (existsSync(triggerPath)) {
        unlinkSync(triggerPath)
        log('   ', `已删除 ${TEST_TRIGGER_FILE}`)
      }
      // 从暂存区移除
      try {
        git(`reset HEAD -- ${TEST_TRIGGER_FILE}`)
      } catch {
        // 文件可能已被删除，reset 失败是正常的
      }
    } else {
      // 多个中间 commit — 可能包含 catstudy agent 在测试期间产生的快照 commit
      // 绝不 reset：会连带回退快照 commit。中止清理，由开发者手动核实。
      ok = false
      log('❌', `检测到 ${intermediateHashes.length} 个中间 commit（含测试 commit）`)
      for (const h of intermediateHashes) {
        const msg = safeGit(`log -1 --pretty=%B ${h}`)
        log('   ', `  ${h.slice(0, 8)}: ${msg?.split('\n')[0]?.slice(0, 60) || '?'}`)
      }
      console.log('')
      console.log('   ⚠️ 中止自动清理 — 防止误删 catstudy 快照 commit。')
      console.log(
        `   仅回退测试 commit（保留快照）: git rebase --onto ${headBefore.slice(0, 8)} ${testCommitHash ? testCommitHash.slice(0, 8) : '<test-commit>'} <HEAD>`
      )
      console.log(`   全部回退（快照将丢失，不推荐）: git reset --soft ${headBefore.slice(0, 8)}`)
      console.log('')
    }

    // 无论结果如何都清理标记文件，恢复 server 的 auto-commit（含 Ctrl+C 残留防御）
    removeE2eMarker()

    if (ok) {
      log('✅', '清理完成')
    } else {
      log('❌', '清理中止 — 请按上方提示手动处理')
    }
    return ok
  } catch (err) {
    log('⚠️', `清理失败: ${err.message}`)
    console.log('   可手动清理: git reset --soft HEAD~1')
    removeE2eMarker()
    return false
  }
}

/**
 * Step 7: 验证完整链路 + 输出报告
 */
async function stepVerifyAndReport(
  sessionId,
  commitHash,
  dmReply,
  reviewReply,
  startTime,
  testStart
) {
  log('📊', 'Step 7/7: 生成测试报告...')
  console.log('')

  // 获取完整消息链
  let allMessages = []
  try {
    allMessages = await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/messages?limit=50`)
  } catch {
    // 获取失败不影响报告
  }

  const relevantMsgs = allMessages.filter((m) => new Date(m.createdAt) >= startTime)

  // ─── 测试报告 ──────────────────────────────────────

  const checks = [
    {
      label: '① 服务器健康',
      pass: true,
      detail: `${SERVER_URL}/api/health`,
    },
    {
      label: '② 会话就绪',
      pass: true,
      detail: `session: ${sessionId}`,
    },
    {
      label: '③ post-commit 触发',
      pass: !!commitHash,
      detail: commitHash
        ? `commit: ${commitHash.slice(0, 8)} → post-commit hook → handoff-gen`
        : '触发失败',
    },
    {
      label: '④ 店长补填',
      pass: !!dmReply,
      detail: dmReply
        ? `补填完成 (${dmReply.content.length} 字符), @吐槽猫: ${dmReply.content.includes('@吐槽猫') ? '✅' : '❌'}`
        : '超时未回复',
    },
    {
      label: '⑤ 吐槽猫审查',
      pass: !!reviewReply,
      detail: reviewReply
        ? `审查完成 (${reviewReply.content.length} 字符)`
        : '超时未回复或未检测到',
    },
  ]

  console.log('═'.repeat(60))
  console.log('  📋 端到端管道测试报告')
  console.log('═'.repeat(60))
  console.log('')
  console.log(`  服务器:    ${SERVER_URL}`)
  console.log(`  Web UI:    ${WEB_URL}`)
  console.log(`  会话 ID:   ${sessionId}`)
  console.log(`  触发方式:  git commit → post-commit hook → handoff-gen.mjs`)
  console.log(`  耗时:      ${Math.round((Date.now() - testStart) / 1000)}s`)
  console.log('')

  for (const check of checks) {
    const icon = check.pass ? '✅' : '❌'
    console.log(`  ${icon} ${check.label}: ${check.detail}`)
  }

  const allPassed = checks.every((c) => c.pass)
  console.log('')
  console.log(`  ${allPassed ? '✅ 全部通过' : '❌ 部分未通过'}`)
  console.log('')
  console.log('═'.repeat(60))

  // ─── 消息链时间线 ──────────────────────────────────

  if (relevantMsgs.length > 0) {
    console.log('')
    console.log('  📜 消息时间线:')
    console.log('  ─'.repeat(56))
    for (const m of relevantMsgs) {
      const time = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
      const roleLabel = m.role === 'user' ? '👤 用户' : '🤖 Agent'
      const preview = m.content.slice(0, 150).replace(/\n/g, ' ')
      console.log(`  ${time} ${roleLabel} | ${preview}${m.content.length > 150 ? '...' : ''}`)
    }
  }

  return allPassed
}

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const testStart = Date.now()

  console.log('')
  console.log('═'.repeat(60))
  console.log('  🐱 cat-study Handoff → Review 端到端管道测试')
  console.log('═'.repeat(60))
  console.log('')
  console.log(`  服务器:     ${SERVER_URL}`)
  console.log(`  Web 观察:   ${WEB_URL}`)
  console.log(`  触发方式:   git commit → post-commit hook → handoff-gen.mjs`)
  console.log(`  超时:       ${args.timeout}s`)
  console.log(`  轮询间隔:   ${POLL_INTERVAL_MS / 1000}s`)
  console.log(`  清理 commit: ${args.cleanup ? '是' : '否'}`)
  console.log('')

  // Step 1: 健康检查
  if (!(await stepHealthCheck())) {
    process.exit(1)
  }

  // Step 2: 查找/创建会话
  const session = await stepFindSession()
  if (!session) {
    process.exit(1)
  }
  const sessionId = session.id

  // Step 3: 用真实 git commit 触发 post-commit hook
  const trigger = stepTriggerRealHandoff(sessionId)
  if (!trigger.success) {
    if (trigger.headBefore) {
      stepCleanup(trigger.headBefore)
    }
    process.exit(1)
  }

  // 记录投递时间——之后的消息才是相关的
  const startTime = new Date()

  // 给 dispatch + 上下文构建一点时间
  log('⏳', '等待 Agent 调度 + 上下文构建...')
  await sleep(3000)

  // Step 4: 等店长
  const dmReply = await stepWaitForStoreManager(sessionId, startTime)

  // Step 5: 等吐槽猫
  let reviewReply = null
  if (dmReply && dmReply.id && dmReply.content.includes('@吐槽猫')) {
    await sleep(2000)
    reviewReply = await stepWaitForReviewer(sessionId, startTime, dmReply.id)
  } else if (dmReply) {
    log('⚠️', '店长回复中未包含 @吐槽猫 — 跳过审查等待')
  }

  // Step 6: 清理测试 commit
  if (args.cleanup) {
    if (!stepCleanup(trigger.headBefore, trigger.commitHash)) {
      log('❌', '测试清理未完成 — 请手动处理后重试，避免污染仓库历史')
      process.exit(2)
    }
  } else {
    log('💡', `--no-cleanup: 测试 commit ${trigger.commitHash?.slice(0, 8)} 保留在工作区`)
    log('💡', `   e2e 标记文件 ${E2E_MARKER_FILE} 也保留 — server auto-commit 将继续被禁用`)
    log('💡', `   手动恢复: 删除该文件`)
  }

  // Step 7: 报告
  const allPassed = await stepVerifyAndReport(
    sessionId,
    trigger.commitHash,
    dmReply,
    reviewReply,
    startTime,
    testStart
  )

  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('测试异常:', err)
  removeE2eMarker() // 意外异常逃逸 main() 时也清理标记，防止 server auto-commit 被永久禁用
  process.exit(1)
})

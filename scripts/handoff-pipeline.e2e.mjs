/**
 * 端到端管道测试 — 验证完整的 handoff → review 链路。
 *
 * 测试流程:
 *   1. 连接 cat-study server → 验证健康
 *   2. 查找（或创建）包含店长和吐槽猫的会话
 *   3. POST /api/messages 投递模拟的 post-commit handoff 消息
 *   4. 轮询 GET /api/sessions/:id/messages，等待 Agent 回复
 *   5. 验证：店长补填了 Why/Tradeoff/OQ → @吐槽猫被触发 → 吐槽猫生成审查回复
 *   6. 输出完整的消息链路 + 测试报告
 *
 * 用法:
 *   node scripts/handoff-pipeline.e2e.mjs
 *   node scripts/handoff-pipeline.e2e.mjs --timeout=180  # 自定义超时（秒）
 *
 * 环境变量:
 *   CATSTUDY_URL  服务器地址（默认 http://127.0.0.1:3200）
 *
 * 前置条件:
 *   1. cat-study server 必须运行（pnpm dev:server）
 *   2. seed 数据必须已初始化（自动，首次启动时完成）
 *   3. LLM API key 必须已配置（.env 文件）
 *
 * Web 观察地址:
 *   cat-study Web UI: http://localhost:5173
 *   测试开始后，在 Web UI 中选择对应会话即可实时观察 Agent 的思考和回复。
 */

// ─── 配置 ────────────────────────────────────────────────────────

const SERVER_URL = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'
const WEB_URL = 'http://localhost:5173'
const POLL_INTERVAL_MS = 2000 // 轮询间隔
const DEFAULT_TIMEOUT_S = 180 // 默认超时（3 分钟）
const AGENT_REPLY_TIMEOUT_S = 120 // 单个 Agent 回复超时

// ─── Claude Code CLI 子进程检测 ─────────────────────────────────

/**
 * 检测当前进程是否在 CatStudy server 的 Claude Code CLI 子进程中运行。
 *
 * CatStudy 的 ClaudeAdapter 通过 spawnSupervised() 启动 Claude Code CLI，
 * supervisor 进程会设置 CATSTUDY_SUPERVISOR_PARENT_PID 指向 server 的 PID。
 * 该环境变量不会出现在其他 Claude Code 会话中，是精确的检测标记。
 *
 * 在此类子进程中运行 e2e 测试会导致：
 *   1. 循环调度（测试 POST 消息 → 触发同一 Agent 的 dispatch → 死锁）
 *   2. dev.js 检测到文件变更 → 重启 server → 测试中断
 */
function isRunningInsideClaudeCode() {
  // CatStudy ClaudeAdapter 独有的环境变量标记
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

// ─── 工具函数 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { timeout: DEFAULT_TIMEOUT_S }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout' && i + 1 < argv.length) {
      opts.timeout = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_S
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

// ─── 测试步骤 ────────────────────────────────────────────────────

/**
 * Step 1: 验证服务器健康
 */
async function stepHealthCheck() {
  log('🔍', 'Step 1/6: 检查服务器健康...')
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
  log('🔍', 'Step 2/6: 查找测试会话...')

  const sessions = await fetchJson(`${SERVER_URL}/api/sessions`)
  const sessionList = Array.isArray(sessions) ? sessions : sessions?.sessions || []

  // 查找包含店长和吐槽猫的会话
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

  // 获取 agent IDs
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
 * Step 3: 投递模拟 handoff 消息
 */
async function stepPostHandoff(sessionId) {
  log('📤', 'Step 3/6: 投递 handoff 消息到 cat-study...')

  // 模拟 post-commit hook 生成的 handoff 消息
  const mockHandoff = [
    '@店长 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
    '',
    '补填规则：',
    '- **Why**（关键决策）：从 commit message 和文件改动推导每个关键决策及理由。',
    '- **Tradeoff**（放弃了什么）：如果放弃过其他方案，用表格列出方案及原因。确认没有则写"无"。',
    '- **Open Questions**（不确定的点）：列出从改动中能识别的不确定、希望 reviewer 重点看的地方。',
    '',
    '补完后在**末尾行首独占一行** @吐槽猫 进行代码审查。',
    '',
    '---',
    '',
    '# 工作交接',
    '',
    '## 1. What — 改了什么',
    '',
    '| 文件 | 改动 |',
    '| --- | --- |',
    '| .husky/post-commit | 新文件 |',
    '| scripts/handoff-gen.mjs | 新文件 |',
    '',
    '> Commit: abc1234',
    '> Message: feat: post-commit 自动生成交接文档草稿 + 端到端测试',
    '> Stats: 2 files changed, 650 insertions',
    '',
    '## 2. Why — 关键决策',
    '',
    '<!-- TODO: 补填 -->',
    '',
    '## 3. Tradeoff — 放弃了什么',
    '',
    '<!-- TODO: 补填 -->',
    '',
    '## 4. Open Questions — 不确定的点',
    '',
    '<!-- TODO: 补填 -->',
    '',
    '## 5. Reviewer Checklist',
    '',
    '### Shell 脚本',
    '',
    '- [ ] Windows Git Bash 兼容性？',
    '- [ ] 空输入 / 无效输入是否正确处理？',
    '',
    '---',
    '',
    '@吐槽猫 请审查以上改动。',
  ].join('\n')

  const result = await fetchJson(`${SERVER_URL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      content: mockHandoff,
      mentions: ['店长'],
    }),
  })

  log('✅', `消息已投递 (messageId: ${result.messageId})`)
  return result.messageId
}

/**
 * Step 4: 等待店长补填回复
 */
async function stepWaitForStoreManager(sessionId, startTime) {
  log('⏳', 'Step 4/6: 等待店长补填 Why/Tradeoff/OQ...')
  log('   ', `Web UI: ${WEB_URL} — 可在会话页面实时观察`)

  const deadline = Date.now() + AGENT_REPLY_TIMEOUT_S * 1000
  let lastMsgCount = 0

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    try {
      const messages = await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/messages?limit=20`)

      // 检查是否有新的 agent 消息
      const agentMsgs = messages.filter(
        (m) => m.role === 'agent' && new Date(m.createdAt) > startTime
      )

      if (agentMsgs.length > lastMsgCount) {
        lastMsgCount = agentMsgs.length
        for (const m of agentMsgs) {
          const preview = m.content.slice(0, 120).replace(/\n/g, ' ')
          log('📩', `[${m.agentId ? 'agent' : 'system'}] ${preview}...`)
        }
      }

      // 找店长的回复
      const dmReply = agentMsgs.find(
        (m) =>
          m.content.includes('Why') && (m.content.includes('关键决策') || m.content.includes('###'))
      )

      if (dmReply) {
        log('✅', `店长已补填交接文档 (${dmReply.id})`)
        log('   ', `内容长度: ${dmReply.content.length} 字符`)
        // 检查是否包含 @吐槽猫
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
async function stepWaitForReviewer(sessionId, startTime) {
  log('⏳', 'Step 5/6: 等待吐槽猫审查回复...')
  log('   ', `吐槽猫正在读取交接文档 + 代码 diff + 逐项检查...`)

  const deadline = Date.now() + AGENT_REPLY_TIMEOUT_S * 1000
  let lastMsgCount = 0

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    try {
      const messages = await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/messages?limit=30`)

      const agentMsgs = messages.filter(
        (m) => m.role === 'agent' && new Date(m.createdAt) > startTime
      )

      if (agentMsgs.length > lastMsgCount) {
        lastMsgCount = agentMsgs.length
      }

      // 找吐槽猫的审查回复
      const reviewReply = agentMsgs.find(
        (m) =>
          (m.content.includes('审查') ||
            m.content.includes('Review') ||
            m.content.includes('Checklist')) &&
          (m.content.includes('通过') ||
            m.content.includes('需修改') ||
            m.content.includes('建议改进') ||
            m.content.includes('❌') ||
            m.content.includes('✅'))
      )

      if (reviewReply) {
        log('✅', `吐槽猫已完成审查回复 (${reviewReply.id})`)
        log('   ', `内容长度: ${reviewReply.content.length} 字符`)
        return reviewReply
      }

      // 如果找到两条以上 agent 消息，第二条很可能是吐槽猫的
      if (agentMsgs.length >= 2) {
        const second = agentMsgs[agentMsgs.length - 1]
        log('✅', `吐槽猫已回复 (${second.id}), 内容长度: ${second.content.length} 字符`)
        return second
      }
    } catch (err) {
      log('⚠️', `轮询出错: ${err.message}`)
    }
  }

  log('⚠️', `等待吐槽猫回复超时 (${AGENT_REPLY_TIMEOUT_S}s) — 可能仍在处理中`)
  return null
}

/**
 * Step 6: 验证完整链路 + 输出报告
 */
async function stepVerifyAndReport(
  sessionId,
  handoffMsgId,
  dmReply,
  reviewReply,
  startTime,
  testStart
) {
  log('📊', 'Step 6/6: 生成测试报告...')
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
      label: '③ Handoff 投递',
      pass: !!handoffMsgId,
      detail: handoffMsgId ? `messageId: ${handoffMsgId}` : '投递失败',
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
  console.log(`  服务器:  ${SERVER_URL}`)
  console.log(`  Web UI:  ${WEB_URL}`)
  console.log(`  会话 ID: ${sessionId}`)
  console.log(`  耗时:    ${Math.round((Date.now() - testStart) / 1000)}s`)
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
      const roleLabel = m.role === 'user' ? '👤 用户' : m.role === 'agent' ? '🤖 Agent' : '🔧 系统'
      const preview = m.content.slice(0, 150).replace(/\n/g, ' ')
      console.log(`  ${time} ${roleLabel} | ${preview}${m.content.length > 150 ? '...' : ''}`)
    }
  }

  return allPassed
}

// ─── 主流程 ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const testStart = Date.now()

  console.log('')
  console.log('═'.repeat(60))
  console.log('  🐱 cat-study Handoff → Review 端到端管道测试')
  console.log('═'.repeat(60))
  console.log('')
  console.log(`  服务器:   ${SERVER_URL}`)
  console.log(`  Web 观察: ${WEB_URL}`)
  console.log(`  超时:     ${args.timeout}s`)
  console.log(`  轮询间隔: ${POLL_INTERVAL_MS / 1000}s`)
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

  // Step 3: 投递 handoff
  const handoffMsgId = await stepPostHandoff(sessionId)

  // 记录投递时间——之后的消息才是相关的
  const startTime = new Date()

  // 给 dispatch + context 构建一点时间
  log('⏳', '等待 Agent 调度 + 上下文构建...')
  await sleep(3000)

  // Step 4: 等店长
  const dmReply = await stepWaitForStoreManager(sessionId, startTime)

  // Step 5: 等吐槽猫
  let reviewReply = null
  if (dmReply && dmReply.content.includes('@吐槽猫')) {
    // 短延迟——让 dispatch 来得及把吐槽猫从队列中拉出来
    await sleep(2000)
    reviewReply = await stepWaitForReviewer(sessionId, startTime)
  } else if (dmReply) {
    log('⚠️', '店长回复中未包含 @吐槽猫 — 跳过审查等待')
  }

  // Step 6: 报告
  const allPassed = await stepVerifyAndReport(
    sessionId,
    handoffMsgId,
    dmReply,
    reviewReply,
    startTime,
    testStart
  )

  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('测试异常:', err)
  process.exit(1)
})

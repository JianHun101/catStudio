/**
 * Handoff 交接文档生成器 — post-commit hook 自动调用。
 *
 * 从 git diff 提取机械部分（文件清单 + Reviewer Checklist），
 * 然后自动投递到 cat-study，由店长 agent 补填 Why / Tradeoff / Open Questions，
 * 补完后转发给 @吐槽猫 审查——全程不需要用户手动干预。
 *
 * 用法:
 *   node scripts/handoff-gen.mjs              # 分析 HEAD~1..HEAD，自动投递到 cat-study
 *   node scripts/handoff-gen.mjs --no-post    # 只生成 .handoff-draft.md，不投递
 *   node scripts/handoff-gen.mjs --range=X..Y # 分析指定范围
 *   node scripts/handoff-gen.mjs --cwd=/path  # 指定仓库路径
 *
 * 环境变量:
 *   CATSTUDY_URL          服务器地址（默认 http://127.0.0.1:3200）
 *   CATSTUDY_SESSION_ID   目标会话 ID（未设则自动从 /api/sessions 获取第一个）
 */

import { execSync } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Public API ─────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.cwd]      仓库路径，默认 process.cwd()
 * @param {string} [opts.range]    git diff 范围，默认 'HEAD~1..HEAD'
 * @returns {string|null} 生成的 markdown 内容，无改动时返回 null
 */
export function generateHandoff(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const range = opts.range || 'HEAD~1..HEAD'

  // 验证仓库
  if (!existsSync(join(cwd, '.git'))) {
    throw new Error(`不是 git 仓库: ${cwd}`)
  }

  // 验证 range 有效
  let headExists = true
  try {
    execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' })
  } catch {
    headExists = false
  }
  if (!headExists) {
    console.log('[handoff-gen] 仓库尚无 commit，跳过')
    return null
  }

  // 处理初始 commit（无 HEAD~1）
  let diffFiles
  try {
    diffFiles = git(cwd, `diff --name-status ${range}`)
  } catch {
    // 回退：用 git show 获取第一个 commit 的 diff
    console.log('[handoff-gen] 检测到初始 commit，使用 git show HEAD')
    diffFiles = git(cwd, 'show --name-status --format="" HEAD')
  }

  if (!diffFiles.trim()) {
    console.log('[handoff-gen] 无文件改动，跳过')
    return null
  }

  const commitMsg = safeGit(cwd, 'log -1 --pretty=%B') || ''

  // 跳过 merge/revert commit
  // 注意：不再跳过 catstudy [uuid] 自动快照。
  // 死循环已由 git-utils.ts 的 gitCommit() 自然阻断——agent 纯文本回复无文件改动时
  // git commit 非零退出返回 null，post-commit hook 不会触发，循环自限。
  // agent 有实质代码改动的 commit 理应进入 handoff → 审查流程。
  if (commitMsg) {
    const firstLine = commitMsg.split('\n')[0]
    if (/^(Merge|Revert)/.test(firstLine)) {
      console.log('[handoff-gen] merge/revert commit，跳过')
      return null
    }
  }

  const diffStat = safeGit(cwd, `diff ${range} --stat`) || safeGit(cwd, 'show HEAD --stat') || ''
  const diffBody = safeGit(cwd, `diff ${range}`) || safeGit(cwd, 'show HEAD') || ''
  const shortHash = safeGit(cwd, 'log -1 --pretty=%h') || 'HEAD'

  // 解析文件列表
  const files = parseChangedFiles(diffFiles)

  // 按分层排序
  const sortedFiles = sortByLayer(files)

  // 检测改动类型
  const changeTypes = detectChangeTypes(sortedFiles, diffBody)

  // 生成 What 段
  const whatSection = buildWhatSection(sortedFiles, diffStat, shortHash, commitMsg)

  // 生成 Checklist
  const checklistSection = buildChecklistSection(changeTypes)

  // 组装完整文档
  return [
    '# 工作交接',
    '',
    '> ⚠️ 审查须知：先通读改动对应的完整 diff（`git show ' +
      shortHash +
      '` 或 `git diff ' +
      (opts.range || 'HEAD~1..HEAD') +
      '`），再核对本文档——本文档是作者的声明清单，不是事实本身，不要只验证文档声称的点。',
    '',
    '## 1. What — 改了什么',
    '',
    whatSection,
    '',
    '## 2. Why — 关键决策',
    '',
    '<!-- TODO: 补填 — 说明核心设计决策及理由。每个关键决策一个 ### 小标题。',
    '     不要复述 What——要回答"为什么这样做是对的"。 -->',
    '',
    '## 3. Tradeoff — 放弃了什么',
    '',
    '<!-- TODO: 补填 — 用表格列出放弃的方案及原因。',
    '     如果确实没有放弃的方案，写"无"——空段会让 reviewer 不确定你是忘了还是真没有。 -->',
    '',
    '## 4. Open Questions — 不确定的点',
    '',
    '<!-- TODO: 补填 — 每条 OQ 必须点名具体文件/符号，格式：',
    '     "我动了 X（文件/函数/语义），请重点查 Y（调用点/边界/行为）。"',
    '     目的是把 reviewer 的搜索空间从整个 diff 缩到点名的位置。',
    '     真实的不确定性，不是 bug 列表；确认没有则写"无"。 -->',
    '',
    '## 5. Reviewer Checklist',
    '',
    checklistSection,
    '',
  ].join('\n')
}

// ─── 命令参数解析 ───────────────────────────────────────────

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--range' && i + 1 < argv.length) {
      opts.range = argv[++i]
    } else if (argv[i] === '--cwd' && i + 1 < argv.length) {
      opts.cwd = argv[++i]
    } else if (argv[i] === '--no-post') {
      opts.noPost = true
    }
  }
  return opts
}

// ─── Git 工具 ───────────────────────────────────────────────

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function safeGit(cwd, cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

// ─── 文件解析 ───────────────────────────────────────────────

/**
 * @param {string} raw — git diff --name-status 输出
 * @returns {Array<{path: string, status: string}>}
 */
function parseChangedFiles(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      const status = parts[0] || 'M'
      // Rename: "R100\told/path.js\tnew/path.js" → parts[2] 是新路径
      if (status.startsWith('R')) {
        return { status, path: parts[2] || parts[1] }
      }
      return { status, path: parts[1] || parts[0] }
    })
}

/** 分层排序权重 */
const LAYER_ORDER = [
  'shared/',
  'server/src/db/',
  'server/src/routes/',
  'server/src/skills/',
  'server/src/connectors/',
  'server/src/dispatch/',
  'server/src/memory/',
  'server/src/llm/',
  'server/src/',
  'web/',
  'scripts/',
  '.husky/',
  '.claude/',
]

function getLayerRank(filePath) {
  for (let i = 0; i < LAYER_ORDER.length; i++) {
    if (filePath.includes(LAYER_ORDER[i])) return i
  }
  return LAYER_ORDER.length // 未匹配的放最后
}

function sortByLayer(files) {
  return [...files].sort((a, b) => {
    const rankDiff = getLayerRank(a.path) - getLayerRank(b.path)
    if (rankDiff !== 0) return rankDiff
    return a.path.localeCompare(b.path)
  })
}

// ─── What 段生成 ────────────────────────────────────────────

function buildWhatSection(files, diffStat, shortHash, commitMsg) {
  const lines = ['| 文件 | 改动 |', '| --- | --- |']

  for (const f of files) {
    const desc = statusToDesc(f.status)
    lines.push(`| ${f.path} | ${desc} |`)
  }

  const stats = parseDiffStat(diffStat)
  if (stats) {
    lines.push('', `> Commit: ${shortHash}`)
    lines.push(`> Message: ${commitMsg.split('\n')[0]}`)
    lines.push(`> Stats: ${stats}`)
  }

  lines.push(
    '',
    '文件按分层排序（shared → server/db → server/routes → server/connectors → web → scripts → config）。'
  )
  return lines.join('\n')
}

function statusToDesc(status) {
  switch (status[0]) {
    case 'A':
      return '新文件'
    case 'D':
      return '删除'
    case 'M':
      return '修改'
    case 'R':
      return '重命名'
    default:
      return status.length > 1 ? status : '修改'
  }
}

function parseDiffStat(stat) {
  if (!stat) return null
  const lastLine = stat.split('\n').filter(Boolean).pop() || ''
  const match = lastLine.match(/(\d+)\s+files?\s+changed/)
  if (!match) return lastLine
  const insertions = lastLine.match(/(\d+)\s+insertions?/)
  const deletions = lastLine.match(/(\d+)\s+deletions?/)
  let result = `${match[0]}`
  if (insertions) result += `, ${insertions[0]}`
  if (deletions) result += `, ${deletions[0]}`
  return result
}

// ─── 改动类型检测 ──────────────────────────────────────────

/**
 * 检测改动类型，返回匹配的 Checklist 项。
 * 规则顺序有优先级——先到的规则先匹配，避免重复检查项。
 */
function detectChangeTypes(files, diff) {
  /** @type {Map<string, string[]>} */
  const typeChecks = new Map()

  for (const rule of CHANGE_TYPE_RULES) {
    if (rule.detect(files, diff)) {
      for (const check of rule.checks) {
        if (!typeChecks.has(rule.type)) {
          typeChecks.set(rule.type, [])
        }
        typeChecks.get(rule.type).push(check)
      }
    }
  }

  // 检查是否有 cat-study 项目特有检查点需要加入
  const catStudyChecks = detectCatStudyChecks(files, diff)
  if (catStudyChecks.length > 0) {
    typeChecks.set('cat-study 项目特有', catStudyChecks)
  }

  return typeChecks
}

const CHANGE_TYPE_RULES = [
  {
    type: '正则 / 字符串匹配',
    detect: (_files, diff) =>
      /\bnew\s+RegExp\b/.test(diff) ||
      /\bescapeRegex\b/.test(diff) ||
      (/[^.\w]\.test\(/.test(diff) && /\/.*\/[gimsu]*/.test(diff)),
    checks: [
      '正则是否覆盖 CJK 字符边界？（`\\b` 对中文不生效）',
      '是否有 ReDoS 风险？（嵌套量词、回溯爆炸）',
      '特殊字符是否正确 escape？（`escapeRegex` 或等价处理）',
      '空字符串 / 纯空白 / 超长输入是否处理？',
    ],
  },
  {
    type: 'DB migration',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('db/index.ts')) ||
      files.some((f) => f.path.includes('migration')),
    checks: [
      '迁移是否幂等（重复执行不报错）？',
      '存量数据的默认值是否正确？',
      '是否有对应的回滚方案？',
      '新增列的约束（NOT NULL / DEFAULT）和旧数据兼容？',
    ],
  },
  {
    type: 'DB migration',
    detect: (_files, diff) => /\bALTER\s+TABLE\b/i.test(diff) || /\bCREATE\s+TABLE\b/i.test(diff),
    checks: [], // 已在上方添加
  },
  {
    type: '状态管理 / 生命周期',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('dispatch/') ||
          f.path.includes('socketio.ts') ||
          f.path.includes('retractionRequests')
      ),
    checks: [
      '新增字段在所有退出路径是否都设值/清理？',
      '是否有竞态窗口？（两个 async 操作之间的间隙）',
      '资源（timer / listener / stream / interval）是否正确释放？',
      '异常路径是否也执行了清理？',
    ],
  },
  {
    type: 'API endpoint',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('routes/') && !f.path.includes('test')),
    checks: [
      '参数校验是否完整（Zod / 手动）？',
      '错误响应是否包含有用信息（而非裸 500）？',
      '向后兼容是否保证？',
      'REST verb 和路径是否符合项目约定？',
    ],
  },
  {
    type: '前端组件',
    detect: (files, _diff) => files.some((f) => f.path.includes('web/')),
    checks: [
      '空态（无数据）是否正确展示？',
      '加载态（fetching）是否有指示？',
      '错误态（请求失败）是否有用户提示？',
      '是否需要 AbortController（组件卸载时取消进行中的请求）？',
      '`watch` / `onMounted` / event listener 是否在 `onUnmounted` 中清理？',
    ],
  },
  {
    type: '环境变量 / 配置解析',
    detect: (_files, diff) =>
      /\bprocess\.env\./.test(diff) ||
      /\bparseInt\(/.test(diff) ||
      /\bparseFloat\(/.test(diff) ||
      /\bisNaN\(/.test(diff),
    checks: [
      '`parseInt` / `parseFloat` 结果是否做了 `isNaN` 校验？',
      '默认值是否合理？',
      '是否有对应 `.env.example` 更新？',
    ],
  },
  {
    type: '类型 / 接口变更',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('types.ts') || f.path.includes('schemas.ts') || f.path.includes('shared/')
      ),
    checks: [
      '`null` / `undefined` 是否区分处理？',
      '类型收窄是否完整？',
      'Zod schema 和 TypeScript 类型是否一致？',
    ],
  },
  {
    type: '事件 / 消息',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('socketio') || f.path.includes('connectors')) ||
      /\bEvents\.\w+/.test(_diff),
    checks: [
      '事件名是否使用 `Events` 常量而非裸字符串？',
      'room / channel 名称前后端是否一致？（前缀、分隔符）',
      '是否有对应的事件监听者？',
    ],
  },
  {
    type: 'LLM / Prompt 变更',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('seed-data') ||
          f.path.includes('skills/') ||
          f.path.includes('systemPrompt') ||
          f.path.includes('system_prompt')
      ),
    checks: [
      'seed-data 改了 prompt → 是否确认 `pnpm seed` 后 DB 中的实际 prompt 已更新？',
      'system prompt 精简后是否丢掉了必需的格式约束？（如 @mention 行首规则）',
      '新增/修改 skill 内容是否和对应 manifest.json trigger 同步？',
    ],
  },
  {
    type: 'Shell 脚本',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('.husky/') ||
          (f.path.includes('scripts/') &&
            (f.path.endsWith('.sh') || f.path.endsWith('.js') || f.path.endsWith('.mjs')))
      ),
    checks: [
      'Windows Git Bash 兼容性？（CRLF 行尾、`findstr` vs `grep`、`xargs` 参数差异）',
      '空输入 / 无效输入是否正确处理？（如 `.push-gate` 空文件绕过）',
      '`trap` / 信号处理是否清理了临时文件和子进程？',
    ],
  },
  {
    type: '新增 repository 方法',
    detect: (files, _diff) => files.some((f) => f.path.includes('repository/')),
    checks: [
      '方法签名和调用方参数类型是否一致？',
      '`SELECT *` 返回类型是否和 `MessageRow` / `AgentRow` 匹配？',
      '新增方法是否在 `db/repository/index.ts` 中 re-export？',
      '是否有对应测试覆盖？返回空集 / 不存在记录的行为是否明确？',
    ],
  },
]

// ─── cat-study 特有检查点检测 ───────────────────────────────

/** @returns {string[]} */
function detectCatStudyChecks(files, diff) {
  const checks = []

  // 检查是否存在 AGENT_SKILL_MODULES 硬编码
  if (
    diff.includes('AGENT_SKILL_MODULES') ||
    diff.includes('skillModules') ||
    diff.includes('skill_modules')
  ) {
    checks.push('`AGENT_SKILL_MODULES` 硬编码是否已清除？（改用 DB `skill_modules` 列）')
    checks.push('`parseSkillModules` / `parseJsonArray` 是否有重复实现？')
  }

  // dispatch / socketio 改动的特有检查
  if (files.some((f) => f.path.includes('dispatch/') || f.path.includes('socketio'))) {
    if (!checks.some((c) => c.includes('retractionRequests'))) {
      checks.push(
        '`retractionRequests` Map 在所有退出路径是否正确清理？（Window ② 提前 return、Window ③ abort return、超时路径）'
      )
    }
    if (!checks.some((c) => c.includes('activeStreams'))) {
      checks.push('`activeStreams` Map 的 delete 是否和 `retractionRequests.delete` 配对？')
    }
    checks.push('`agentSlots` 的 `currentTriggerMessageId` 是否在所有状态变更点更新？')
    checks.push(
      'Socket.IO room 前缀一致性 — `socket.join(`session:${id}`)` vs `io.to(id)` 是否对齐？'
    )
    checks.push("Window ②（流式前）撤回保护 — 是否因 `role = 'user'` 硬编码误杀 A2A 路径？")
  }

  // Redis / bridge 相关
  if (diff.includes('emitViaBridge') || diff.includes('Redis') || diff.includes('redis')) {
    checks.push(
      'Redis 不可用时 dispatch 状态变更 — 是否有桥接 fallback？（`emitViaBridge` / Socket.IO 直接广播）'
    )
  }

  // seed.ts 改动
  if (files.some((f) => f.path.includes('seed.ts'))) {
    checks.push(
      '`seed.ts --reset` 流程 — 表删除顺序是否符合 FK 依赖？（memories → messages → execution_logs → sessions → agents）'
    )
  }

  // env var 解析
  if (diff.includes('parseInt') && diff.includes('||')) {
    checks.push(
      "`parseInt('0') || default` 零值被吞？含 `parseInt` / `parseFloat` 的 env var 解析是否用 `isNaN` 校验？"
    )
  }

  // pre-push / .push-gate 改动
  if (files.some((f) => f.path.includes('.husky/') || f.path.includes('.push-gate'))) {
    checks.push('`.push-gate` / pre-push hook — 空文件 / 无效 SHA / 仅空白字符是否被正确拦截？')
  }

  // 前端改动
  if (files.some((f) => f.path.includes('web/'))) {
    checks.push(
      '前端 store action 失败时是否清理了 `pending*` 状态？（`pendingHandoffSummary` 等）'
    )
  }

  // agent 相关改动
  if (files.some((f) => f.path.includes('agent'))) {
    checks.push('`messages.agent_id` 无 FK 约束 → 级联删除是否手动覆盖？')
  }

  // 占位符
  if (diff.includes('@作者') || diff.includes('@author')) {
    checks.push('`@作者` 占位符 — 用户触发路径（非 A2A）是否被替换为实际用户名？')
  }

  return checks
}

// ─── Checklist 段生成 ──────────────────────────────────────

function buildChecklistSection(changeTypes) {
  const lines = []

  if (changeTypes.size === 0) {
    lines.push('<!-- handoff-gen 未检测到匹配的改动类型，请手动补填 Checkist -->')
    return lines.join('\n')
  }

  for (const [type, checks] of changeTypes) {
    if (checks.length === 0) continue
    lines.push(`### ${type}`)
    lines.push('')
    for (const check of checks) {
      lines.push(`- [ ] ${check}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ─── cat-study 自动投递 ──────────────────────────────────────

/**
 * 将交接文档投递到 cat-study，让店长 agent 自动补填 TODO 部分。
 *
 * 消息格式：@店长 补填 Why/Tradeoff/OQ → 补完后 @吐槽猫 审查。
 * 整个链路不需要用户手动操作。
 *
 * @param {string} content — 完整的交接文档 markdown
 * @param {string} [cwd] — 工作目录（用于定位 .handoff-draft.md 以清理）
 * @returns {Promise<boolean>} 投递成功返回 true
 */
async function tryPostToCatstudy(content, cwd) {
  const serverUrl = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'

  // 获取 session ID（优先级：环境变量 → API 自动获取 → 跳过）
  let sessionId = process.env.CATSTUDY_SESSION_ID
  if (!sessionId) {
    try {
      const res = await fetch(`${serverUrl}/api/sessions`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const body = await res.json()
        const sessions = Array.isArray(body) ? body : body?.sessions || []
        if (sessions.length > 0) {
          sessionId = sessions[0].id
        }
      }
    } catch {
      // server 不可达，继续走文件生成路径
    }
  }

  if (!sessionId) {
    console.log(
      '[handoff-gen] ⚠️  无法获取 cat-study session（CATSTUDY_SESSION_ID 未设且 API 不可达）'
    )
    console.log('  .handoff-draft.md 已生成，下次 push 时 pre-push hook 会重试投递')
    return false
  }

  // 构造消息：@店长 补填 TODO → 补完后 @吐槽猫
  const message = [
    '@店长 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
    '',
    '补填规则：',
    '- **Why**（关键决策）：从 commit message 和文件改动推导每个关键决策及理由。不要复述 What——要回答"为什么这样做是对的"。',
    '- **Tradeoff**（放弃了什么）：如果放弃过其他方案，用表格列出方案及原因。确认没有则写"无"——空段会让 reviewer 不确定你是忘了还是真没有。',
    '- **Open Questions**（不确定的点）：每条必须点名具体文件/符号——"我动了 X 的语义，请重点查 Y"。把吐槽猫的搜索空间从整个 diff 缩到点名的位置。真实的不确定性，不是 bug 列表；确认没有则写"无"。',
    '',
    '补完后在**末尾行首独占一行** @吐槽猫 进行代码审查，并在审查请求中附上审查须知：**先通读完整 diff 再核对本文档**——本文档是声明清单不是事实本身，不要只验证文档声称的点。',
    '',
    '---',
    '',
    content,
  ].join('\n')

  try {
    const res = await fetch(`${serverUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        content: message,
        mentions: ['店长'],
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (res.ok) {
      console.log(`[handoff-gen] ✅ 交接文档已投递到 cat-study (session: ${sessionId})`)
      console.log('  店长将自动补填 Why/Tradeoff/OQ → @吐槽猫 审查')
      console.log('  在 cat-study 会话页面可实时查看审查进度')
      return true
    } else {
      const errText = await res.text().catch(() => '')
      console.log(
        `[handoff-gen] ⚠️  投递失败 (HTTP ${res.status}${errText ? ': ' + errText.slice(0, 120) : ''})`
      )
      return false
    }
  } catch (err) {
    console.log(`[handoff-gen] ⚠️  cat-study server 不可达 (${serverUrl})`)
    console.log('  .handoff-draft.md 已生成，下次 push 时 pre-push hook 会重试投递')
    return false
  }
}

// ─── CLI entry ──────────────────────────────────
// 放在文件末尾，确保所有 const 已初始化（ESM TDZ）

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  try {
    const result = generateHandoff(args)
    if (result) {
      const cwd = args.cwd || process.cwd()
      writeFileSync(join(cwd, '.handoff-draft.md'), result, 'utf-8')
      console.log('📋 .handoff-draft.md 已生成')

      // 自动投递到 cat-study（除非指定 --no-post）
      if (!args.noPost) {
        const posted = await tryPostToCatstudy(result, cwd)
        if (posted) {
          // 投递成功 → 清理本地草稿（内容已在 cat-study 消息管道中）
          try {
            unlinkSync(join(cwd, '.handoff-draft.md'))
            console.log('  (本地 .handoff-draft.md 已清理——内容在 cat-study 管道中)')
          } catch {
            // 清理失败不影响主流程
          }
        }
      }
    }
  } catch (err) {
    // post-commit hook 不应阻断 commit，失败时只告警
    console.error('[handoff-gen] 生成失败:', err.message)
    process.exit(0)
  }
}

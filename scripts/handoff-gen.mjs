/**
 * Handoff 交接文档生成器 — post-commit hook 自动调用。
 *
 * 从 git diff 提取机械部分（文件清单 + Reviewer Checklist），
 * 然后自动投递到 cat-study，由店长 agent 补填 Why / Tradeoff / Open Questions，
 * 补完后转发给 @吐槽猫 审查——全程不需要用户手动干预。
 *
 * 用法:
 *   node scripts/handoff-gen.mjs                    # 分析 HEAD~1..HEAD，自动投递到 cat-study
 *   node scripts/handoff-gen.mjs --no-post          # 只生成 .handoff-draft.md，不投递
 *   node scripts/handoff-gen.mjs --gate-deliver     # pre-push 门禁入口：补投 pending 队列
 *                                                   # + 兜底投递 HEAD（若尚未投递）
 *   node scripts/handoff-gen.mjs --cwd=/path        # 指定仓库路径
 *
 * 投递幂等（修复重复投递，见重复投递根治计划 A+B+C+D）：
 *   .handoff-delivered.json 状态文件按 commit SHA 记录投递结果，锚点取代"内容字节"：
 *     { "delivered": { "<full-sha>": "<iso-time>" }, "pending": ["<sha>", ...] }
 *   - 同一 SHA 投递成功一次后，后续任何投递机会（post-commit / --gate-deliver）
 *     查状态直接跳过，不再重复投递
 *   - 投递失败（瞬态重试耗尽）的 SHA 记入 pending，每次投递机会先补投 pending：
 *     文档从 git 按 SHA 重新生成（确定性的，不依赖草稿文件）→ 投递 → 成功移入 delivered
 *   - 状态文件丢失/历史改写（reset）自动退化为"首次投递"——宁可多投不可漏投
 *
 * 成功判定（修复 B）：POST 超时/5xx 后不再立即判失败，改为轮询目标会话最近消息
 * 验证"消息是否客观落库"（write→broadcast→dispatch 顺序，落库先于 dispatch 同步等待）。
 * 4xx 是确定性失败，不走落库验证直接 fatal。
 *
 * 环境变量:
 *   CATSTUDY_URL          服务器地址（默认 http://127.0.0.1:3200）
 *   CATSTUDY_SESSION_ID   目标会话 ID（人工显式指定，明确意图优先）。
 *                         投递目标选择：
 *                         1. CATSTUDY_SESSION_ID 环境变量（人工指定；同时旁路
 *                            delivered 状态跳过——显式指定即明确意图，如会话重建后重投）
 *                         2. commit message 的 catstudy [uuid] 反查消息所在会话（自动）
 *                         两者都不可用时**报错不投递**——绝不猜目标。
 *                         曾因反查失败静默降级到环境变量/API 第一个会话，
 *                         把审查文档投到错误会话（"UI优化"打偏、b8b0a6d 跨会话）。
 *   HANDOFF_VERIFY_MS    落库验证轮询预算（默认 10000ms，测试可调小）
 */

import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── 投递状态文件 ─────────────────────────────────────────
// 按 commit SHA 幂等记录投递结果，取代"内容字节"去重锚点（重复投递根治计划 A+D）。
// 与 .push-gate / .handoff-draft.md 并列在仓库根，已加入 .gitignore。

const STATE_FILE = '.handoff-delivered.json'

/** 落库验证轮询预算（ms）。调用时惰性读取 env——测试可在 import 之后调小 */
function verifyBudgetMs() {
  return Number(process.env.HANDOFF_VERIFY_MS) || 10000
}

// ─── Public API ─────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.cwd]      仓库路径，默认 process.cwd()
 * @param {string} [opts.range]    git diff 范围，默认 'HEAD~1..HEAD'
 * @param {string} [opts.sha]      指定目标 commit（pending 补投用——文档从 git 按 SHA
 *                                 确定性重新生成，commitMsg/stat/shortHash 都指向该
 *                                 commit 而非 HEAD）。与 range 同传时两者一致（sha~1..sha）。
 * @returns {string|null} 生成的 markdown 内容，无改动时返回 null
 */
export function generateHandoff(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const range = opts.range || 'HEAD~1..HEAD'
  const target = opts.sha || 'HEAD'
  // pending 补投：range 跟随 target（sha~1..sha），保证审查须知行指向正确 commit
  const effectiveRange = opts.sha ? `${opts.sha}~1..${opts.sha}` : range

  // 验证仓库
  if (!existsSync(join(cwd, '.git'))) {
    throw new Error(`不是 git 仓库: ${cwd}`)
  }

  // 验证 target 有效
  let targetExists = true
  try {
    execSync(`git rev-parse ${target}`, { cwd, stdio: 'pipe' })
  } catch {
    targetExists = false
  }
  if (!targetExists) {
    console.log('[handoff-gen] 仓库尚无目标 commit，跳过')
    return null
  }

  // 处理初始 commit（无 ~1 父提交）
  let diffFiles
  try {
    diffFiles = git(cwd, `diff --name-status ${effectiveRange}`)
  } catch {
    // 回退：用 git show 获取第一个 commit 的 diff
    console.log('[handoff-gen] 检测到初始 commit，使用 git show')
    diffFiles = git(cwd, `show --name-status --format="" ${target}`)
  }

  if (!diffFiles.trim()) {
    console.log('[handoff-gen] 无文件改动，跳过')
    return null
  }

  const commitMsg = safeGit(cwd, `log -1 --pretty=%B ${target}`) || ''

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

  const diffStat =
    safeGit(cwd, `diff ${effectiveRange} --stat`) || safeGit(cwd, `show ${target} --stat`) || ''
  const diffBody = safeGit(cwd, `diff ${effectiveRange}`) || safeGit(cwd, `show ${target}`) || ''
  const shortHash = safeGit(cwd, `log -1 --pretty=%h ${target}`) || 'HEAD'

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
      effectiveRange +
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
    const arg = argv[i]
    // 等号形式 --cwd=/path（pre-push 曾用 --range=X..Y，已移除——见下）
    const eqMatch = /^--([a-z-]+)=(.*)$/.exec(arg)
    if (eqMatch) {
      const [, key, value] = eqMatch
      if (key === 'cwd') opts.cwd = value
      else if (key === 'no-post') opts.noPost = true
      else if (key === 'gate-deliver') opts.gateDeliver = true
      else if (key === 'range') {
        // 重复投递根治计划 Fix C：pre-push 不再生成范围版合并审文档。
        // 遇到旧调用必须报错而非静默忽略——静默回退默认 HEAD~1..HEAD 会投出错误文档
        throw new Error('--range 已移除（Fix C：投递按 commit SHA 幂等，不再生成范围版合并审文档）')
      }
      continue
    }
    if (arg === '--cwd' && i + 1 < argv.length) {
      opts.cwd = argv[++i]
    } else if (arg === '--no-post') {
      opts.noPost = true
    } else if (arg === '--gate-deliver') {
      opts.gateDeliver = true
    } else if (arg === '--range' && i + 1 < argv.length) {
      throw new Error('--range 已移除（Fix C：投递按 commit SHA 幂等，不再生成范围版合并审文档）')
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
 * 从 commit message 提取 catstudy [uuid] 中的消息 id。
 * uuid 即触发消息 id（socketio.ts gitCommit 用 `catstudy [${triggerMsg.id}]` 生成）。
 * 非自动快照 commit（手动提交）返回 null——这类 commit 走 fallback 链。
 * @param {string} commitMsg — git log -1 --pretty=%B 输出
 * @returns {string|null}
 */
export function extractCommitUuid(commitMsg) {
  const m = /catstudy\s+\[([0-9a-f-]{36})\]/.exec(commitMsg || '')
  return m ? m[1] : null
}

/**
 * 从最近 commit message 的 uuid 反查触发消息所在会话。
 * GET /api/messages/:id → { sessionId }——永远指向"用户实际发起这条消息的会话"，
 * 比环境变量硬编码（会话重建即失效）和 API 猜第一个（按 updated_at 排序）都准。
 * 反查失败（手动 commit 无 uuid / 消息已删 404 / server 不可达）返回 null 并输出
 * 明确原因——调用方必须**报错不投递**，禁止降级兜底（曾因 404 后静默降级到
 * 环境变量，把审查文档投到错误会话）。
 * @param {string} cwd — 仓库路径
 * @param {string} serverUrl — cat-study server 地址
 * @param {string} [sha] — 指定 commit（pending 补投：旧 commit 的 uuid 反查各自会话；
 *                         缺省为 HEAD）
 * @returns {Promise<string|null>}
 */
export async function resolveCommitSessionId(cwd, serverUrl, sha) {
  const commitMsg = safeGit(cwd, sha ? `log -1 --pretty=%B ${sha}` : 'log -1 --pretty=%B')
  const uuid = extractCommitUuid(commitMsg)
  if (!uuid) {
    console.log(
      '[handoff-gen] ⚠️  commit message 无 catstudy [uuid]（手动提交）——无法反查投递目标，不投递'
    )
    return null
  }
  try {
    const res = await fetch(`${serverUrl}/api/messages/${uuid}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.log(
        `[handoff-gen] ⚠️  commit uuid 反查失败 (HTTP ${res.status})：消息 ${uuid} 不存在或已删除——不投递`
      )
      return null
    }
    const body = await res.json()
    if (body?.sessionId) {
      console.log(`[handoff-gen] 目标会话: ${body.sessionId}（commit uuid ${uuid} 反查）`)
      return body.sessionId
    }
    console.log(`[handoff-gen] ⚠️  反查响应缺少 sessionId（消息 ${uuid}）——不投递`)
  } catch {
    console.log(`[handoff-gen] ⚠️  cat-study server 不可达 (${serverUrl})，无法反查投递目标`)
    // 瞬态故障（典型场景：post-commit 撞上 dev.js 重启窗口，实测停机 ~1.4s）：
    // 抛带标记错误，由调用方按"瞬态 → 延迟重试"处理；404/无 uuid 等确定性失败
    // 仍返回 null（报错不投递，禁止降级兜底）。
    const err = new Error('cat-study server 不可达，反查失败')
    err.code = 'HANDOFF_TRANSIENT'
    throw err
  }
  return null
}

/**
 * 投递去重：这份交接文档（实际投递的完整消息内容）是否已在此会话投过。
 *
 * 背景：post-commit 每 commit 必投递，commit 由自动化流程产生、频率不可控，
 * 同一份文档曾被投 8+ 次（5253e8c 的补填请求反复进队列）。去重检查在 POST 前
 * 拉取目标会话最近消息，若存在内容完全相同的消息则跳过。
 *
 * 锚点必须是**实际投递的包裹消息**（buildHandoffMessage 产物）而非原始 markdown——
 * 会话里存的是包裹后的完整消息，旧实现拿原始 markdown 比包裹消息，逐字节永不相等，
 * 去重实为死代码（"投 8+ 次"的放大器之一）。状态文件（delivered）是主防线，
 * 这里是状态文件丢失后的内容级兜底。
 *
 * 检查失败（server 不可达/列表 404）不阻塞投递——宁可多投一次也不漏投。
 *
 * @param {string} serverUrl
 * @param {string} sessionId
 * @param {string} message — 实际投递的完整消息内容（buildHandoffMessage 产物）
 * @returns {Promise<boolean>} 已投递过返回 true
 */
async function alreadyDelivered(serverUrl, sessionId, message) {
  try {
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages?limit=100`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const msgs = await res.json()
    return (msgs || []).some(
      (m) => m?.role === 'user' && m?.content && m.content.trim() === message.trim()
    )
  } catch {
    console.log('[handoff-gen] ⚠️  去重检查失败（消息列表不可达）——继续投递，宁可多投不可漏投')
    return false
  }
}

/**
 * 构造投递消息：@店长 补填 TODO → 补完后 @吐槽猫 审查。
 * 与 pre-push 曾投的"裸草稿 + mentions:["吐槽猫"]"不同——统一为补填请求形状，
 * 全部投递路径共用这一个形状。
 * @param {string} content — 完整交接文档 markdown
 */
export function buildHandoffMessage(content) {
  return [
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
}

/**
 * 落库验证（重复投递根治计划 Fix B 的核心）：POST 超时/5xx 后轮询目标会话最近消息，
 * 以"消息是否客观落库"判定投递是否成功。
 *
 * 为什么轮询而不是立即判失败：消息写入顺序是 write → broadcast → dispatch，
 * dispatch 在 slot idle 时同步等待 agent 完整回复（分钟级），POST 的 5s 超时必然
 * abort——但消息其实早已落库。验证把成功判定从"网络往返及时返回"改成"客观落库"，
 * 误判失败→草稿滞留→重投的循环被结构性切断。
 *
 * 与 alreadyDelivered 的区别：不吞错——server 持续不可达要抛出来转瞬态重试，
 * 而不是视为"没投过"。
 *
 * @param {string} serverUrl
 * @param {string} sessionId
 * @param {string} message — 实际 POST 的消息内容（buildHandoffMessage 产物）
 * @returns {Promise<boolean>} 消息已落库 → true；轮询耗尽仍未落库 → false
 * @throws 首次请求即连接失败（server 不可达）或轮询期间持续不可达——调用方转 transient
 */
async function verifyDelivered(serverUrl, sessionId, message) {
  const budget = verifyBudgetMs()
  const deadline = Date.now() + budget
  let lastErr = null
  let first = true
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages?limit=100`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const msgs = await res.json()
        if (
          (msgs || []).some(
            (m) => m?.role === 'user' && m?.content && m.content.trim() === message.trim()
          )
        ) {
          console.log('[handoff-gen] ✅ 落库验证命中——消息已投递到目标会话')
          return true
        }
        lastErr = null // 服务器可达但消息未落库 → 继续等
      } else {
        lastErr = new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      if (first) throw err // 首次请求就连接失败 → server 不可达，不空等轮询预算
      lastErr = err
    }
    first = false
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (lastErr) throw lastErr
  console.log(`[handoff-gen] ⚠️  落库验证超时（${budget}ms）——消息未出现在目标会话，判定投递失败`)
  return false
}

/**
 * POST 后的不确定结果（超时/连接失败/5xx）统一走落库验证。
 * @returns {Promise<'ok'|'transient'>}
 */
async function verifyOrTransient(serverUrl, sessionId, message) {
  try {
    const ok = await verifyDelivered(serverUrl, sessionId, message)
    return ok ? 'ok' : 'transient'
  } catch {
    return 'transient'
  }
}

/**
 * 单次投递尝试：确定目标会话 + POST 交接文档。
 *
 * @param {string} content — 完整的交接文档 markdown
 * @param {string} cwd — 工作目录
 * @param {string} serverUrl — cat-study server 地址
 * @param {Object} [opts]
 * @param {string} [opts.sha] — 目标 commit（pending 补投时传旧 commit SHA，
 *                              反查该 commit 自己的 uuid 所在会话；缺省为 HEAD）
 * @returns {Promise<'ok'|'transient'|'fatal'>}
 *   ok       — 投递成功（POST 2xx，或超时/5xx 后落库验证命中）
 *   transient— 瞬态故障（连接失败 / 5xx / 落库验证未命中），调用方可延迟重试
 *   fatal    — 确定性失败（无 uuid / 404 / 4xx），重试无意义
 */
async function attemptDeliver(content, cwd, serverUrl, opts = {}) {
  // 获取 session ID：CATSTUDY_SESSION_ID（人工显式指定，明确意图优先）
  // → commit uuid 反查（自动，永远指向"用户实际发起这条消息的会话"）。
  // 原则：两者都不可用时**报错不投递**——绝不猜目标。曾因反查失败静默降级到
  // 环境变量/含店长会话/API 第一个，把审查文档投到错误会话（"UI优化"打偏、
  // b8b0a6d 跨会话事故），错误的投递比不投递更糟。
  let sessionId = process.env.CATSTUDY_SESSION_ID
  if (sessionId) {
    console.log(`[handoff-gen] 目标会话: ${sessionId}（CATSTUDY_SESSION_ID 人工显式指定）`)
  } else {
    try {
      sessionId = await resolveCommitSessionId(cwd, serverUrl, opts.sha)
    } catch (err) {
      if (err?.code === 'HANDOFF_TRANSIENT') return 'transient'
      throw err
    }
  }

  if (!sessionId) {
    console.log('[handoff-gen] ❌ 无法确定投递目标会话（反查失败且未人工指定 CATSTUDY_SESSION_ID）')
    console.log('  .handoff-draft.md 已生成但**未投递**——草稿滞留，等门禁重试或人工处理')
    console.log('  处置：确认 cat-study server 运行、commit 含 catstudy [uuid]，')
    console.log('        或显式设置 CATSTUDY_SESSION_ID 后重新生成投递')
    return 'fatal'
  }

  // 构造消息：@店长 补填 TODO → 补完后 @吐槽猫（所有投递路径共用这一形状）
  const message = buildHandoffMessage(content)

  // 投递去重：同一份文档已投过则跳过（锚点：实际投递的完整消息）
  if (await alreadyDelivered(serverUrl, sessionId, message)) {
    console.log(
      `[handoff-gen] ⏭️  该交接文档已在此会话中投递过，跳过重复投递 (session: ${sessionId})`
    )
    return 'ok'
  }

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
      return 'ok'
    }
    const errText = await res.text().catch(() => '')
    console.log(
      `[handoff-gen] ⚠️  投递失败 (HTTP ${res.status}${errText ? ': ' + errText.slice(0, 120) : ''})`
    )
    // 4xx：确定性错误（会话已删 / 请求格式错），重试无意义，不做落库验证
    if (res.status >= 400 && res.status < 500) {
      if (process.env.CATSTUDY_SESSION_ID) {
        console.log(
          '  🔍 目标会话 ID 由 CATSTUDY_SESSION_ID 人工指定——4xx 通常意味着会话已删除或重建'
        )
        console.log('    请将环境变量更新为有效会话 ID 后重试')
      }
      return 'fatal'
    }
    // 5xx：消息可能已落库（write→broadcast→dispatch 顺序，落库先于 dispatch）——
    // 落库验证，命中即视为成功
    return await verifyOrTransient(serverUrl, sessionId, message)
  } catch {
    // 超时/连接失败：POST 可能已到达并落库（dispatch 同步等待拖超时）——落库验证
    console.log(`[handoff-gen] ⚠️  cat-study server 响应超时/不可达 (${serverUrl})——落库验证`)
    return await verifyOrTransient(serverUrl, sessionId, message)
  }
}

/**
 * 将交接文档投递到 cat-study，让店长 agent 自动补填 TODO 部分。
 *
 * 消息格式：@店长 补填 Why/Tradeoff/OQ → 补完后 @吐槽猫 审查。
 * 整个链路不需要用户手动操作。
 *
 * 瞬态重试：投递常撞上 dev.js 重启窗口（agent 完成 → 锁释放 → dev.js 延迟重启，
 * 实测停机 ~1.4s）。连接失败 / 5xx / 落库验证未命中等瞬态故障延迟 2s 重试
 * （最多 2 次）即覆盖；确定性失败（无 uuid / 404 / 4xx）不重试，报错后草稿滞留。
 *
 * @param {string} content — 完整的交接文档 markdown
 * @param {string} [cwd] — 工作目录
 * @param {Object} [opts] — 透传 attemptDeliver（如 { sha }）
 * @returns {Promise<'ok'|'transient'|'fatal'>} 最后一次尝试的结果
 */
export async function tryPostToCatstudy(content, cwd, opts = {}) {
  const serverUrl = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'
  const maxAttempts = 3 // 首次 + 2 次重试
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(
        `[handoff-gen] 投递重试 ${attempt - 1}/${maxAttempts - 1}（2s 后，覆盖 dev.js 重启窗口 ~1.4s）...`
      )
      await new Promise((r) => setTimeout(r, 2000))
    }
    const result = await attemptDeliver(content, cwd, serverUrl, opts)
    if (result !== 'transient') return result
  }
  console.log('[handoff-gen] ❌ 投递重试耗尽——.handoff-draft.md 草稿滞留')
  console.log('  处置：确认 cat-study server 运行后手动重跑 node scripts/handoff-gen.mjs，')
  console.log('        或等待下次投递机会自动补投（pending 队列）')
  return 'transient'
}

// ─── 投递状态文件（Fix A+D：按 commit SHA 幂等） ─────────────

function statePath(cwd) {
  return join(cwd, STATE_FILE)
}

/** 读取状态文件；缺失/损坏一律视作空状态（退化"首次投递"，宁可多投不可漏投） */
function readState(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(cwd), 'utf-8'))
    return {
      delivered: parsed?.delivered && typeof parsed.delivered === 'object' ? parsed.delivered : {},
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
    }
  } catch {
    return { delivered: {}, pending: [] }
  }
}

/** 写状态文件：tmp + rename 原子替换，半写不可见 */
function writeState(cwd, state) {
  const p = statePath(cwd)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, p)
}

/** @param {string} sha — 完整 SHA */
function isAncestorOfHead(cwd, sha) {
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * 历史改写自愈：delivered/pending 中不是当前 HEAD 祖先的 SHA 全部移除。
 * e2e 管道会 reset --hard 改写历史——旧 SHA 已不存在，留着会让状态"超前"、
 * 误跳过新历史中的同内容 commit；清除后按首次投递重新幂等恢复。
 */
function pruneState(cwd) {
  const state = readState(cwd)
  const headSha = safeGit(cwd, 'rev-parse HEAD')
  if (!headSha) return // 仓库无 commit，不动状态
  let changed = false
  for (const sha of Object.keys(state.delivered)) {
    if (!isAncestorOfHead(cwd, sha)) {
      delete state.delivered[sha]
      changed = true
    }
  }
  const kept = state.pending.filter((sha) => isAncestorOfHead(cwd, sha))
  if (kept.length !== state.pending.length) {
    state.pending = kept
    changed = true
  }
  if (changed) {
    writeState(cwd, state)
    console.log('[handoff-gen] ♻️  状态文件已清理失效条目（历史改写自愈）')
  }
}

/** 把 'HEAD' 解析为完整 SHA（pending 条目存的就是完整 SHA） */
function resolveFullSha(cwd, sha) {
  if (sha === 'HEAD') return safeGit(cwd, 'rev-parse HEAD')
  return sha
}

/**
 * 投递单个 commit 的文档并更新状态（Fix A+D 的单一状态入口）。
 *
 * - delivered 命中 → 跳过（幂等；CATSTUDY_SESSION_ID 显式指定时旁路——明确意图，
 *   如会话重建后重投）
 * - ok → 记 delivered、移出 pending
 * - fatal → 移出 pending（确定性失败重试无意义，死 SHA 不滞留）
 * - transient（重试已耗尽）→ 记入 pending，下次投递机会自动补投
 *
 * @returns {Promise<'ok'|'transient'|'fatal'>}
 */
async function deliverSha(cwd, serverUrl, sha, content) {
  const fullSha = resolveFullSha(cwd, sha)
  const state = readState(cwd)
  if (state.delivered[fullSha]) {
    if (!process.env.CATSTUDY_SESSION_ID) {
      console.log(`[handoff-gen] ⏭️  ${fullSha.slice(0, 7)} 已投递过（状态文件）——跳过，不重复投递`)
      // 顺带清出 pending：delivered 与 pending 不应同时存在（跳过路径也要移，否则
      // 该 SHA 每次投递机会都会被 drainPending 重新处理一遍）
      if (state.pending.includes(fullSha)) {
        state.pending = state.pending.filter((s) => s !== fullSha)
        writeState(cwd, state)
      }
      return 'ok'
    }
    console.log(
      `[handoff-gen] ℹ️  ${fullSha.slice(0, 7)} 已投递过，但 CATSTUDY_SESSION_ID 显式指定——按明确意图重新投递`
    )
  }
  const result = await tryPostToCatstudy(content, cwd, { sha })
  if (result === 'ok') {
    state.delivered[fullSha] = new Date().toISOString()
  }
  state.pending = state.pending.filter((s) => s !== fullSha) // ok/fatal 移出；transient 下面重新记入
  if (result === 'transient') {
    if (!state.pending.includes(fullSha)) state.pending.push(fullSha)
  }
  writeState(cwd, state)
  return result
}

/**
 * 补投 pending 队列（每次投递机会先处理）：
 * 交接文档是 `git show <sha>` 的确定性生成结果，重新生成必然得到同一文档——
 * pending 只记 SHA 不存内容，草稿被覆盖不影响补投（Fix D）。
 */
async function drainPending(cwd, serverUrl) {
  const state = readState(cwd)
  if (!state.pending.length) return
  for (const sha of [...state.pending]) {
    if (!isAncestorOfHead(cwd, sha)) {
      // 历史改写后 SHA 失效（prune 兜底），正常不会走到这里
      console.log(
        `[handoff-gen] ⏭️  pending 中 ${sha.slice(0, 7)} 不是当前 HEAD 祖先（历史已改写）——移除`
      )
      state.pending = state.pending.filter((s) => s !== sha)
      writeState(cwd, state)
      continue
    }
    const doc = generateHandoff({ cwd, sha, range: `${sha}~1..${sha}` })
    if (doc === null) {
      // 无文件改动/merge commit → 无内容可投，直接记已投
      state.delivered[sha] = new Date().toISOString()
      state.pending = state.pending.filter((s) => s !== sha)
      writeState(cwd, state)
      continue
    }
    console.log(`[handoff-gen] 📤 补投 pending: ${sha.slice(0, 7)}（从 git 重新生成）`)
    await deliverSha(cwd, serverUrl, sha, doc)
  }
}

/** --gate-deliver 兜底：HEAD 若尚未投递则生成并投递（覆盖 post-commit 中途崩溃窗口） */
async function deliverHeadIfUndelivered(cwd, serverUrl) {
  const headSha = safeGit(cwd, 'rev-parse HEAD')
  if (!headSha) return
  const state = readState(cwd)
  if (state.delivered[headSha] && !process.env.CATSTUDY_SESSION_ID) return
  const doc = generateHandoff({ cwd })
  if (doc) await deliverSha(cwd, serverUrl, 'HEAD', doc)
}

// ─── CLI entry ──────────────────────────────────
// 放在文件末尾，确保所有 const 已初始化（ESM TDZ）

/**
 * CLI 主流程（导出以便 e2e 进程内调用——stub server 与调用方同进程；
 * 某些沙箱环境会阻断子进程对 127.0.0.1 的 TCP，execSync 起的 CLI 连不上 stub）。
 * @param {Object} args — parseArgs 产物（{ cwd?, noPost?, gateDeliver? }）
 */
export async function runHandoff(args) {
  const cwd = args.cwd || process.cwd()

  // --no-post：只生成草稿，不投递、不碰状态文件（人工预审用）
  if (args.noPost) {
    const result = generateHandoff(args)
    if (result) {
      writeFileSync(join(cwd, '.handoff-draft.md'), result, 'utf-8')
      console.log('📋 .handoff-draft.md 已生成')
    }
    return
  }

  const serverUrl = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'

  // 历史改写自愈（幂等）
  pruneState(cwd)

  // pre-push 门禁入口：补投 pending 队列 + 兜底投递 HEAD（若尚未投递）
  if (args.gateDeliver) {
    await drainPending(cwd, serverUrl)
    await deliverHeadIfUndelivered(cwd, serverUrl)
    return
  }

  // post-commit 路径：先补投 pending（每次投递机会先处理），再生成并投递 HEAD
  await drainPending(cwd, serverUrl)
  const result = generateHandoff(args)
  if (result) {
    writeFileSync(join(cwd, '.handoff-draft.md'), result, 'utf-8')
    console.log('📋 .handoff-draft.md 已生成')

    // 自动投递到 cat-study
    const outcome = await deliverSha(cwd, serverUrl, 'HEAD', result)
    if (outcome === 'ok') {
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  try {
    await runHandoff(parseArgs(process.argv.slice(2)))
  } catch (err) {
    // post-commit hook 不应阻断 commit，失败时只告警
    console.error('[handoff-gen] 生成失败:', err.message)
    process.exit(0)
  }
}

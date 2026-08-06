#!/usr/bin/env node
/**
 * MCP 结构化路由 Phase 0 spike 驱动
 *
 * 验证目标（roadmap Phase 0）：
 *   1. claude.ts:83-93 同款 spawn 参数 + --mcp-config 后，DeepSeek 代理端点上
 *      stream-json 是否出 tool_use 块、CLI 是否执行工具、tool_result 后是否续流
 *   2. --allowedTools 白名单语法是否被接受（被拒则试 --disallowedTools 黑名单兜底）
 *   3. ENABLE_TOOL_SEARCH 与 MCP 工具面交互（有干扰则 DeepSeek 端点也设 false）
 *
 * 用法: node scripts/mcp-spike.mjs [--dump <dir>]
 *   --dump <dir>  把每次运行的完整 NDJSON 事件流存文件（留档）
 */

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = path.join(ROOT, 'workspace')
const ECHO_SERVER = path.join(ROOT, 'scripts', 'mcp-echo.mjs')
const TIMEOUT_MS = 240_000 // 单次运行最长 4 分钟
const dumpDir = process.argv.includes('--dump')
  ? process.argv[process.argv.indexOf('--dump') + 1]
  : null

// ─── Claude Code CLI 二进制解析（与 cli-utils resolveBin 同策略） ───
function resolveClaudeBin() {
  try {
    const prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const exe = path.join(
      prefix,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    )
    if (fs.existsSync(exe)) return exe
  } catch {
    /* fallthrough */
  }
  const local = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  if (fs.existsSync(local)) return local
  return 'claude'
}

const CLAUDE_BIN = resolveClaudeBin()

// ─── .env 手动解析（项目惯例，无 dotenv） ───
function loadEnv() {
  const file = path.join(ROOT, '.env')
  if (!fs.existsSync(file)) return {}
  const env = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

// ─── MCP 配置（每 spawn 生成到 OS temp） ───
function mcpConfigPath() {
  const cfg = {
    mcpServers: {
      'catstudy-echo': { command: process.execPath, args: [ECHO_SERVER] },
    },
  }
  const p = path.join(os.tmpdir(), `catstudy-spike-mcp-${process.pid}.json`)
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  return p
}

// ─── 单次 Claude CLI 运行 ───
function runClaude(label, prompt, extraArgs = [], extraEnv = {}, cfgPath = null) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      ...extraArgs,
    ]
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: process.env.DS_KEY,
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: process.env.DS_KEY,
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      ...extraEnv,
    }
    const child = spawn(CLAUDE_BIN, args, { env, cwd: WORKSPACE, shell: false })
    const events = []
    let stderr = ''

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        events.push(JSON.parse(line))
      } catch {
        /* 跳过非 JSON 行 */
      }
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ label, code: 'TIMEOUT', events, stderr, prompt })
    }, TIMEOUT_MS)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ label, code, events, stderr, prompt })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ label, code: `SPAWN_ERROR: ${err.message}`, events, stderr, prompt })
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

// ─── 事件分析 ───
function analyze(events) {
  const toolUses = []
  const toolResults = []
  let textAfterToolUse = ''
  let sawToolUse = false
  let sawToolResult = false

  for (const ev of events) {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          sawToolUse = true
          toolUses.push({ name: block.name, input: block.input })
        }
        if (block.type === 'text') {
          if (sawToolUse) textAfterToolUse += block.text
        }
      }
    }
    if (ev.type === 'user' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_result') {
          sawToolResult = true
          toolResults.push(String(block.content).slice(0, 200))
        }
      }
    }
  }
  return { sawToolUse, toolUses, sawToolResult, toolResults, textAfterToolUse }
}

// ─── 报告 ───
function report(name, r, a, verdict) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`【${name}】${verdict}`)
  console.log(`${'='.repeat(64)}`)
  console.log(`exit: ${r.code}`)
  console.log(`stderr: ${r.stderr.slice(0, 400) || '(空)'}`)
  console.log(
    `tool_use 块: ${a.sawToolUse ? '✅ 出现' : '❌ 未出现'}${a.sawToolUse ? ' → ' + JSON.stringify(a.toolUses) : ''}`
  )
  console.log(
    `tool_result: ${a.sawToolResult ? '✅ ' + JSON.stringify(a.toolResults) : '❌ 未出现'}`
  )
  if (a.sawToolUse) {
    console.log(
      `tool_use 后续文本: ${a.textAfterToolUse ? '✅ 续流: ' + a.textAfterToolUse.slice(0, 200).replace(/\n/g, '\\n') : '❌ 无续流（tool_use 后没有 text）'}`
    )
  }
  if (dumpDir) {
    const f = path.join(dumpDir, `${name.replace(/[^\w-]+/g, '_')}.jsonl`)
    fs.mkdirSync(dumpDir, { recursive: true })
    fs.writeFileSync(f, r.events.map((e) => JSON.stringify(e)).join('\n'))
    console.log(`事件流留档: ${f}`)
  }
}

const ECHO_PROMPT =
  '这是一次 MCP 工具链路 spike 验证。你有一个名为 echo 的 MCP 工具可用，' +
  '它只有一个参数 text。请立即调用 echo 工具，text 参数传「spike 端到端验证」。' +
  '工具返回后，把工具返回的内容原样复述给用户（不要添加任何额外说明）。'

async function main() {
  const env = loadEnv()
  if (!env.DS_KEY) {
    console.error('❌ .env 中缺少 DS_KEY，spike 需要真实 API 密钥')
    process.exit(1)
  }
  process.env.DS_KEY = env.DS_KEY

  console.log(`Claude CLI: ${CLAUDE_BIN}`)
  console.log(`存在: ${fs.existsSync(CLAUDE_BIN)}`)

  // ─── 用例 1: 基线（无 MCP）───
  const r1 = await runClaude(
    '基线（无 MCP）',
    '只回复一句话：spike baseline ok。不要做任何其他事。'
  )
  const a1 = analyze(r1.events)
  report('1-基线-无MCP', r1, a1, a1.sawToolUse ? '' : '')

  // ─── 用例 2: MCP 主链路 ───
  const cfg = mcpConfigPath()
  const r2 = await runClaude('MCP主链路', ECHO_PROMPT, ['--mcp-config', cfg])
  const a2 = analyze(r2.events)
  report('2-MCP主链路', r2, a2, '')

  // ─── 用例 3: --allowedTools 白名单 ───
  const r3 = await runClaude('allowedTools白名单', ECHO_PROMPT, [
    '--mcp-config',
    cfg,
    '--allowedTools',
    'mcp__catstudy__echo',
  ])
  const a3 = analyze(r3.events)
  report('3-allowedTools白名单', r3, a3, '')

  // ─── 用例 4: --disallowedTools 黑名单（兜底验证） ───
  const r4 = await runClaude('disallowedTools黑名单', ECHO_PROMPT, [
    '--mcp-config',
    cfg,
    '--disallowedTools',
    'mcp__catstudy__echo',
  ])
  const a4 = analyze(r4.events)
  report('4-disallowedTools黑名单', r4, a4, '')

  // ─── 用例 5: ENABLE_TOOL_SEARCH 交互 ───
  const r5 = await runClaude(
    'ENABLE_TOOL_SEARCH=true',
    ECHO_PROMPT,
    ['--mcp-config', cfg, '--allowedTools', 'mcp__catstudy__echo'],
    { ENABLE_TOOL_SEARCH: 'true' }
  )
  const a5 = analyze(r5.events)
  report('5-ENABLE_TOOL_SEARCH交互', r5, a5, '')

  // ─── 汇总判定 ───
  console.log(`\n${'='.repeat(64)}`)
  console.log('SPIKE 汇总')
  console.log(`${'='.repeat(64)}`)
  const verdicts = {
    '1-基线':
      a1.sawToolUse === false &&
      r1.events.some((e) => e.type === 'result' || e.type === 'assistant'),
    '2-MCP主链路': a2.sawToolUse && a2.sawToolResult,
    '3-allowedTools': a3.sawToolUse && a3.sawToolResult,
    '4-disallowedTools黑名单': true, // 无论结果，语法被接受与否都要记录
    '5-ENABLE_TOOL_SEARCH': true,
  }
  for (const [k, v] of Object.entries(verdicts)) {
    console.log(`  ${v ? '✅' : '❌'} ${k}`)
  }

  fs.unlinkSync(cfg) // 清理临时 mcp 配置
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

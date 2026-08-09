/**
 * CatStudy 开发启动器。
 *
 * 直接启动 server + web 进程，不依赖 pnpm --parallel（避免 Windows shell 问题）。
 * 通过 node 直接执行 tsx / vite 的 JS 入口，无需 .cmd 文件。
 *
 * Server 使用 tsx 运行，不监听文件变更自动重启——文件变更热重启已退役
 * （Agent 编辑 src/ 下的文件触发立即重启 → 杀死正在执行的 Agent；
 * 7f69535 的保护窗也只能推迟、不能阻止）。保存代码仅打提示日志，
 * 重启全面收归用户确认制。
 *
 * 机制（重启只发生在用户确认之后）：
 *   店长发「【重启请求】原因：xxx」→ 用户点前端 [确认重启] → server 写
 *   .restart-request（state=confirmed）→ dev.js 执行重启（Agent 执行中则
 *   等待执行结束，保护窗）→ 写 .restart-done 供新 server 广播「重启完成」。
 *
 * NapCat 生命周期管理（2026-08 架构决策）：NapCat 是独立程序，server 永不 spawn 它
 * （连接器进程生命周期 = 部署脚本层职责——开发环境 dev.js 做，生产环境守护进程做）。
 * dev.js 负责：启动时自动拉起（幂等）+ .napcat-request 请求文件轮询（start/stop）。
 * 启动命令两种形态：①NAPCAT_LAUNCH_CMD 完整命令行（cwd 固定 ROOT）；②含
 * {NAPCAT_PATH} 占位符的模板——启动时用 .napcat-config.json（配置页面「NapCat 启动
 * 路径」保存）替换占位符，且以路径所在目录为 cwd（bat 内相对路径依赖 cwd；cwd 固定
 * ROOT 会让 napcat.bat 的 `node ./index.js` 找不到模块秒退）；args 传完整命令串——
 * cmd /c 对纯文件名查找不可靠（本机 NoDefaultCurrentDirectoryInExePath 禁裸名查
 * cwd，basename 形态失败、.\ 前缀显式相对路径可行、完整路径最稳健），且传完整命令
 * 串让模板占位符外的附加内容（如 {NAPCAT_PATH} --flag）不被 args 丢弃。换机器/换
 * 安装位置只改页面不碰 .env。
 *
 * 用法: node scripts/dev.js  或  pnpm dev
 */

import { spawn, execSync } from 'node:child_process'
import { connect } from 'node:net'
import { watch, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { decideRestartAction } from './restart-gate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const isWindows = process.platform === 'win32'

// 映射包名 → node_modules 路径
const PKG_DIRS = {
  server: path.join(ROOT, 'packages', 'server'),
  web: path.join(ROOT, 'packages', 'web'),
}

// tsx CLI 入口（node 直接执行，避过 tsx.cmd / shell:true 的问题）
const TSX_CLI = path.join(PKG_DIRS.server, 'node_modules', 'tsx', 'dist', 'cli.mjs')
// Vite CLI 入口
const VITE_CLI = path.join(PKG_DIRS.web, 'node_modules', 'vite', 'bin', 'vite.js')

// Agent 执行锁文件（与 socketio.ts 中 LOCK_FILE 路径一致）
const LOCK_FILE = path.join(ROOT, '.agent-busy')

// 重启确认机制文件（与 server 侧 restart-request.ts 路径一致）：
// server 写 .restart-request（pending → 用户确认 → confirmed），dev.js 轮询执行重启；
// 重启成功后写 .restart-done 供新 server 广播「重启完成」。
const RESTART_REQUEST_FILE = path.join(ROOT, '.restart-request')
const RESTART_DONE_FILE = path.join(ROOT, '.restart-done')

if (!fs.existsSync(TSX_CLI)) {
  console.error('[dev] 找不到 tsx，请确认已执行 pnpm install')
  process.exit(1)
}
if (!fs.existsSync(VITE_CLI)) {
  console.error('[dev] 找不到 vite，请确认已执行 pnpm install')
  process.exit(1)
}

console.log('[dev] tsx:', TSX_CLI)
console.log('[dev] vite:', VITE_CLI)

/** 跟踪所有子进程 */
const children = new Set()

/** 强制杀进程（Windows: taskkill /T 杀整棵进程树） */
function killTree(pid) {
  if (!isWindows) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    return
  }
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {}
}

/** 终止所有子进程 */
function killAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    killTree(child.pid)
  }
  children.clear()
}

// ─── Server 进程管理 ─────────────────────────

let serverChild = null

/** 检查 server 进程是否还活着。
 *  先用 spawn 引用判断，再读锁文件里的 PID 做兜底。 */
function isServerAlive() {
  // A：spawn 子进程引用还活着
  if (serverChild && serverChild.exitCode === null) return true

  // B：读锁文件中的 PID 验证
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
      if (!isNaN(pid)) {
        process.kill(pid, 0) // ESRCH = PID 不存在
        return true
      }
    } catch (e) {
      if (e.code !== 'ESRCH') throw e
    }
  }

  return false
}

// ─── 执行保护窗：.agent-busy 锁 或 execution_logs 有 running 执行 ─────────
// 只服务用户确认重启（文件变更热重启已退役，见「文件监听」区块）：用户点
// 「确认重启」的瞬间若有 agent 在执行，等它跑完才动手。判据：锁文件 或
// execution_logs 有 running 执行 → 推迟。锁文件只覆盖 Claude agent
// （needsLock），且存在「锁释放→重启」收尾窗口；被打断的执行在
// execution_logs 里仍为 running——故用 node:sqlite（Node v24 内置
// DatabaseSync，零依赖）只读打开 server 的 SQLite（WAL 只读查询可行），
// 覆盖所有 provider 所有执行（比锁更全），finalizeExecutionLog 执行结束后
// 立即更新 → 判据实时。
const DB_FILE = path.join(ROOT, 'packages', 'server', 'data', 'cat-study.db')
let runningDb = null
let runningDbFailed = false

/** 是否有正在执行的 agent（execution_logs.status='running' 计数 > 0） */
function hasRunningExecutions() {
  if (runningDbFailed) return false
  try {
    if (!runningDb) runningDb = new DatabaseSync(DB_FILE, { readOnly: true })
    const row = runningDb
      .prepare("SELECT COUNT(*) AS cnt FROM execution_logs WHERE status = 'running'")
      .get()
    return row.cnt > 0
  } catch (e) {
    // DB 打开失败（首次启动 DB 未初始化 / WAL 恢复不可读等）→ 退化仅锁判据，
    // 不引入新故障面；标记失败避免每轮都重试打开
    runningDbFailed = true
    console.warn(`[dev] execution_logs 读取失败，退化仅锁文件判据（${e.message}）`)
    return false
  }
}

/** 清理孤儿锁：server 已死但 .agent-busy 还在 → 删除 */
function cleanupDeadLock() {
  if (!existsSync(LOCK_FILE)) return
  if (isServerAlive()) return

  let pidHint = '?'
  try {
    pidHint = fs.readFileSync(LOCK_FILE, 'utf-8').trim()
  } catch {}

  console.log(`[dev] 检测到孤儿锁 (pid=${pidHint})，清理后重启`)
  fs.unlinkSync(LOCK_FILE)
}

/**
 * 带重试的 server 重启。
 * 首次 waitForServer 失败后，等 2s / 4s / 8s 再试（最多 3 次重试）。
 * 全部失败后继续周期性重试（每 30s），而不是静默放弃。
 */
async function restartWithRetry(reason) {
  console.log(`[dev] ${reason}`)

  const maxRetries = 3
  let baseDelay = 2000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[dev] 重试第 ${attempt} 次 (${baseDelay / 1000}s 后)...`)
      await new Promise((r) => setTimeout(r, baseDelay))
      baseDelay *= 2
    }

    startServer()
    const ok = await waitForServer()
    if (ok) return true

    // 启动失败 → 确保旧进程彻底死掉，释放端口
    if (serverChild && serverChild.exitCode === null) {
      killTree(serverChild.pid)
    }
  }

  // 全部重试失败 → 不放弃，设定一个长间隔定时器持续尝试
  console.error('[dev] server 重启失败（已重试 3 次），每 30s 继续尝试...')
  const keepTrying = setInterval(async () => {
    console.log('[dev] 再次尝试重启 server...')
    startServer()
    const ok = await waitForServer()
    if (ok) {
      console.log('[dev] server 恢复!')
      clearInterval(keepTrying)
    }
  }, 30_000)
  return false
}

function startServer() {
  cleanupDeadLock()

  // 杀掉旧 server 进程
  if (serverChild && serverChild.exitCode === null) {
    console.log('[dev] 终止旧 server 进程 (pid=' + serverChild.pid + ')')
    killTree(serverChild.pid)
    children.delete(serverChild)
  }

  serverChild = spawn(process.execPath, [TSX_CLI, 'packages/server/src/index.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  serverChild.on('error', (err) => {
    console.error('[dev] server 进程启动失败:', err.message)
  })

  serverChild.on('exit', (code) => {
    children.delete(serverChild)
    if (children.size === 0) {
      console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
      killAll()
      process.exit(code || 0)
    }
  })

  children.add(serverChild)
  return serverChild
}

async function waitForServer() {
  const PORT = parseInt(process.env.PORT || '3200', 10)
  const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        console.log(`[dev] server ready after ${i}s`)
        return true
      }
    } catch {
      // 还没就绪，继续等
    }
    if (i === 0) console.log('[dev] waiting for server...')
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error('[dev] server 启动超时 (60s)')
  return false
}

// ─── .env 最小解析 ───────────────────────────────
// dev.js 需要自己判断是否拉起 NapCat（server 的 env.ts 会全量解析 .env，但那是
// server 进程内部；dev.js 在 spawn server 之前就要知道三个 NapCat 相关变量）。
// 规则仿 server env.ts：KEY=VALUE、跳过空行/注释、引号剥离、不覆盖已存在的环境变量
// （shell 里显式 export 的优先）。只解析本脚本关心的 key，其余留给 server 处理。
const NAPCAT_ENV_KEYS = new Set(['ONEBOT_ENABLED', 'NAPCAT_LAUNCH_CMD', 'ONEBOT_API_BASE'])

function loadDevEnv() {
  const envFile = path.join(ROOT, '.env')
  if (!existsSync(envFile)) return
  let content = ''
  try {
    content = fs.readFileSync(envFile, 'utf-8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    if (!NAPCAT_ENV_KEYS.has(key) || key in process.env) continue
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadDevEnv()

// ─── NapCat 生命周期管理 ─────────────────────────
// 架构决策（2026-08）：NapCat 是独立程序，server 永不 spawn——连接器进程生命周期归
// 部署脚本层（开发 dev.js / 生产守护进程）。dev.js 做两件事：启动时自动拉起（幂等：
// 端口已监听不重复拉）+ .napcat-request 请求文件轮询（server 薄桥接口写文件，start/
// stop 两动作）。启动命令参数化：.env 的 NAPCAT_LAUNCH_CMD（完整命令行字符串，
// Windows 走 cmd /c + detached，规避项目 shell:true 约定）。所有权：只杀
// .napcat-pid 记录的实例（dev.js 自己拉起的），手动起的 NapCat 不受影响。
const NAPCAT_PID_FILE = path.join(ROOT, '.napcat-pid')
const NAPCAT_REQUEST_FILE = path.join(ROOT, '.napcat-request')
const NAPCAT_CONFIG_FILE = path.join(ROOT, '.napcat-config.json')
const NAPCAT_PATH_PLACEHOLDER = '{NAPCAT_PATH}'
const NAPCAT_PROBE_TIMEOUT_MS = 2000

/**
 * 读 .napcat-config.json（页面「NapCat 启动路径」保存的配置）。容错：无文件/坏
 * JSON/字段缺失 → { napcatPath: '', autoStart: true }——配置缺失降级为「未就绪」，
 * 绝不抛错（配置是辅助数据，读失败不能拖垮 dev.js 启动）。
 * autoStart 缺省 true：旧配置无该字段 → 自动拉起（用户决策：默认开启、配了开关可关，
 * 现有用户升级后行为零变化）；显式 boolean 才采纳，其余按 true 容错。
 */
function loadNapcatConfig() {
  try {
    if (!existsSync(NAPCAT_CONFIG_FILE)) return { napcatPath: '', autoStart: true }
    const parsed = JSON.parse(fs.readFileSync(NAPCAT_CONFIG_FILE, 'utf-8'))
    return {
      napcatPath: typeof parsed.napcatPath === 'string' ? parsed.napcatPath : '',
      autoStart: typeof parsed.autoStart === 'boolean' ? parsed.autoStart : true,
    }
  } catch {
    return { napcatPath: '', autoStart: true }
  }
}

/**
 * 解析 NAPCAT_LAUNCH_CMD 为 spawn 参数 {args, cwd, cmd}。
 * 占位符形态：cwd 取路径所在目录（bat 内相对路径依赖 cwd——实锤根因：cwd 固定
 * ROOT 时 napcat.bat 的 `node.exe ./index.js` 从项目根找模块失败秒退，3000 端口
 * 从不监听 → 面板「操作中」永等不到翻转）；路径未配置 → null（未就绪）。
 * args 传完整命令串（替换后的 cmd）而非 basename 或纯路径：①cmd /c 在 Node
 * spawn 下对纯文件名查找不可靠（本机 NoDefaultCurrentDirectoryInExePath=1 禁
 * 裸名查 cwd，basename 形态「不是内部或外部命令」；.\ 前缀显式相对路径实测可
 * 行，但完整路径最稳健无歧义，选它）；②完整命令串让模板占位符外的附加内容
 * （如 {NAPCAT_PATH} --flag）不被丢弃——args 只传路径会静默吞 flag 而日志展示
 * 的 cmd 还留着，展示与实际 spawn 分裂（审查实测钉死）。
 * 无占位符：完整命令行 + cwd: ROOT（f184c71 语义，向后兼容）。
 * 路径/命令不含引号——含空格路径由 Node spawn 数组参数组装自动加引号、cmd /S
 * 去引号执行（loadDevEnv 剥离 .env 首尾引号，模板写引号必坏）。cmd 字段 = 替换
 * 后的最终命令（日志展示用 + 非 Windows 分支 spawn 用）。
 */
function resolveNapcatSpawn(cmd, napcatPath) {
  if (!cmd.includes(NAPCAT_PATH_PLACEHOLDER)) {
    return { args: ['/c', cmd], cwd: ROOT, cmd }
  }
  const p = (napcatPath || '').trim()
  if (!p) return null
  const resolved = cmd.replaceAll(NAPCAT_PATH_PLACEHOLDER, p)
  return {
    args: ['/c', resolved],
    cwd: path.dirname(p),
    cmd: resolved,
  }
}

/**
 * 检测「含空格路径 + 占位符外附加内容」组合（Windows cmd /c 下不可解析）：
 * Node 给含空格 arg 自动加引号 → cmd /S 去引号规则对「非纯可执行名」不保留
 * 引号（恰好两引号 + 中间纯可执行名才保留）→ 剥引号后按第一个空格截断，把
 * 路径前半当命令 → exit=1。且 spawn stdio:'ignore' 吞掉错误——静默失败，
 * 症状复刻「操作中」永等翻转（审查实测钉死：{NAPCAT_PATH} --flag + 空格路径
 * 失败；纯占位符空格路径由 Node 加引号 + cmd /S 去引号正常执行，不在此列）。
 * 纯函数：返回 true = 该组合存在、启动将失败，调用方须打可见警告。
 */
function hasCmdSpaceConflict(cmd, napcatPath) {
  if (!cmd.includes(NAPCAT_PATH_PLACEHOLDER)) return false
  const p = (napcatPath || '').trim()
  if (!p.includes(' ')) return false
  return cmd.replaceAll(NAPCAT_PATH_PLACEHOLDER, p) !== p
}

/** 解析 ONEBOT_API_BASE 为 host/port（容错：非法 URL 回退默认 127.0.0.1:3000） */
function parseNapcatApiBase() {
  const apiBase = process.env.ONEBOT_API_BASE || 'http://127.0.0.1:3000'
  try {
    const u = new URL(apiBase)
    return { host: u.hostname, port: parseInt(u.port, 10) || 80 }
  } catch {
    return { host: '127.0.0.1', port: 3000 }
  }
}

/** TCP 端口探测——「端口已监听」即视为 NapCat 可连（幂等判定，不依赖 HTTP 协议） */
function isPortOpen(host, port, timeoutMs = NAPCAT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 确保 NapCat 在运行（幂等）。入口：启动流程（autoStartOnly: true——只拉起不拦手动）
 * + .napcat-request start 请求（autoStartOnly 缺省 false——手动启停不受开关影响）。
 * 判定链：ENABLED != true → 零动作；LAUNCH_CMD 空 → 仅提示不拉起；autoStartOnly 且
 * .napcat-config.json 的 autoStart !== true → 跳过自动拉起（引导日志提示去设置页可关）；
 * 模板含 {NAPCAT_PATH} 但路径未配置 → 提示「请到配置页面填写」不拉起；端口已监听 → 跳过。
 * 拉起：Windows 用 cmd /c 包装完整命令行（detached 防 dev.js 强杀时陪葬），写
 * .napcat-pid 记录所有权（stop 只杀该实例）。
 */
async function ensureNapcat(opts = {}) {
  const { autoStartOnly = false } = opts
  if (process.env.ONEBOT_ENABLED !== 'true') return
  let cmd = process.env.NAPCAT_LAUNCH_CMD
  if (!cmd) {
    console.log(
      '[dev] ONEBOT_ENABLED=true 但 NAPCAT_LAUNCH_CMD 未配置——跳过自动拉起（请在 .env 配置启动命令）'
    )
    return
  }
  const config = loadNapcatConfig()
  if (autoStartOnly && config.autoStart !== true) {
    console.log(
      '[dev] 自动拉起未开启（autoStart=false）——跳过自动拉起。如需自动拉起，请在设置页「NapCat」勾选「dev 启动时自动拉起」；手动「启动 NapCat」不受影响'
    )
    return
  }
  const spec = resolveNapcatSpawn(cmd, config.napcatPath)
  if (spec === null) {
    console.log(
      `[dev] NAPCAT_LAUNCH_CMD 含 ${NAPCAT_PATH_PLACEHOLDER} 但未配置路径——跳过拉起（请在配置页面「NapCat 启动路径」填写本机路径）`
    )
    return
  }
  const { host, port } = parseNapcatApiBase()
  if (await isPortOpen(host, port)) {
    console.log(`[dev] NapCat 已在运行（${host}:${port} 已监听），跳过拉起`)
    return
  }
  // 含空格路径 + 附加内容组合在 cmd /c 下不可解析（hasCmdSpaceConflict 见上）——
  // spawn 会静默失败（stdio:'ignore' 吞错误），把失败预判成可见引导而非等「操作中」
  if (isWindows && hasCmdSpaceConflict(cmd, config.napcatPath)) {
    console.warn(
      `[dev] 警告：NapCat 路径含空格（${config.napcatPath.trim()}）且 NAPCAT_LAUNCH_CMD 含占位符外附加内容——cmd /c 下该组合不可解析，启动将失败。请改用无空格目录，或将命令改为完整命令行形态（不含 ${NAPCAT_PATH_PLACEHOLDER} 占位符）`
    )
  }
  const child = isWindows
    ? spawn('cmd.exe', spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    : spawn(spec.cmd, { cwd: spec.cwd, detached: true, stdio: 'ignore', shell: true })
  fs.writeFileSync(NAPCAT_PID_FILE, String(child.pid))
  console.log(
    `[dev] NapCat 已拉起 (pid=${child.pid})，命令: ${spec.cmd}${
      spec.cwd !== ROOT ? `（cwd: ${spec.cwd}）` : ''
    }`
  )
  child.on('error', (err) => {
    console.error(`[dev] NapCat 启动失败: ${err.message}`)
    try {
      fs.unlinkSync(NAPCAT_PID_FILE)
    } catch {}
  })
}

/** 停止 dev.js 拉起的 NapCat——只杀 .napcat-pid 记录的实例，手动起的实例不受影响 */
function stopNapcat() {
  if (!existsSync(NAPCAT_PID_FILE)) return
  const pid = parseInt(fs.readFileSync(NAPCAT_PID_FILE, 'utf-8').trim(), 10)
  try {
    fs.unlinkSync(NAPCAT_PID_FILE)
  } catch {}
  if (isNaN(pid)) return
  console.log(`[dev] 停止 NapCat (pid=${pid})`)
  killTree(pid)
}

/**
 * .napcat-request 请求文件轮询（server 薄桥接口写文件）。start → ensureNapcat（幂等）；
 * stop → stopNapcat（无 pid 文件 = 手动实例 → 不动作）。执行后删除请求文件——动作本身
 * 幂等（start 有端口探测、stop 无 pid 文件即 no-op），失败只需日志留痕。
 */
async function pollNapcatRequest() {
  if (!existsSync(NAPCAT_REQUEST_FILE)) return
  let raw = ''
  try {
    raw = fs.readFileSync(NAPCAT_REQUEST_FILE, 'utf-8')
  } catch {
    return // 读取竞态（文件刚被删除），下轮再试
  }
  try {
    fs.unlinkSync(NAPCAT_REQUEST_FILE)
  } catch {}
  let req = null
  try {
    req = JSON.parse(raw)
  } catch {}
  if (!req || typeof req !== 'object') return
  if (req.action === 'start') {
    console.log('[dev] 收到 start 请求——拉起 NapCat')
    await ensureNapcat()
  } else if (req.action === 'stop') {
    console.log('[dev] 收到 stop 请求——停止 NapCat')
    stopNapcat()
  }
}

// ─── 启动流程 ─────────────────────────────────

// 1. 启动 Server
startServer()
const ready = await waitForServer()
if (!ready) {
  killAll()
  process.exit(1)
}

// 2. 启动 Web (Vite)
const webChild = spawn(process.execPath, [VITE_CLI, '--host', '0.0.0.0'], {
  cwd: PKG_DIRS.web,
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '1' },
})

webChild.on('error', (err) => {
  console.error('[dev] web 进程启动失败:', err.message)
})

webChild.on('exit', (code) => {
  children.delete(webChild)
  if (children.size === 0) {
    console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
    killAll()
    process.exit(code || 0)
  }
})

children.add(webChild)

// 3. 拉起 NapCat（ONEBOT_ENABLED=true 且未在运行且配置了启动命令且 autoStart 开启时才动作；
//    autoStartOnly 限定自动拉起——手动「启动 NapCat」（.napcat-request start）不受开关影响）
await ensureNapcat({ autoStartOnly: true })

// ─── 文件监听（仅提示，不重启） ─────────────────
// 2026-08 架构决策：文件变更热重启退役——Agent 编辑 src/ 下的文件触发立即
// 重启会杀死正在执行的 Agent（店长 5 次、flash猫 2 次事故），保护窗也只能
// 推迟、不能阻止。现在保存代码仅打提示日志（「变更未生效」可见性，不重启、
// 不打断），重启只发生在用户确认之后（下方「重启确认机制」区块）。
// fs.watch 的 Windows 误报（null 文件名事件，典型：git add -A 全树 stat）
// 最多多打一条提示，不产生任何重启动作——无 a9a9cba 类事故面。
const srcDir = path.join(ROOT, 'packages', 'server', 'src')
let changeNotifyTimer = null
const watcher = watch(srcDir, { recursive: true }, (_event, filename) => {
  // 只关注 .ts 文件变更
  if (filename && !filename.endsWith('.ts')) return

  // 防抖：500ms 内的多次变更合并为一次提示
  clearTimeout(changeNotifyTimer)
  changeNotifyTimer = setTimeout(() => {
    console.log(
      '[dev] 检测到 server 代码变更——未生效，需重启才能生效（重启走「重启请求」确认制，不会自动重启）'
    )
  }, 500)
})

// ─── 重启确认机制（fs.watch 事件 + 5s 兜底轮询双路径） ──────────────────
// 店长发「【重启请求】原因：xxx」消息 → 用户点前端 [确认重启] → server 写
// .restart-request（state=confirmed）→ 消费端双保险：fs.watch 事件路径（即时）
// + 5s 兜底轮询路径（可靠，事件双丢失最坏 5s 内仍执行），共用 pollRestart()，
// restartInProgress 天然去重双路径。处理语义：confirmed 且新鲜 → 等 Agent 执行
// 锁释放 → 既有 restartWithRetry 重启 → 写 .restart-done（新 server 启动时广播
// 「重启完成」）→ 删请求文件。过期请求忽略并清理；pending 忽略。
let restartInProgress = false
/** 等待提示已打标志：Agent 执行中等待释放时只提示一次（防 5s 轮询刷屏） */
let restartWaitNotified = false

async function pollRestart() {
  if (restartInProgress) return
  if (!existsSync(RESTART_REQUEST_FILE)) return

  let raw = ''
  try {
    raw = fs.readFileSync(RESTART_REQUEST_FILE, 'utf-8')
  } catch {
    return // 读取竞态（文件刚被删除），下轮再试
  }

  const action = decideRestartAction(raw)
  if (action === 'expired') {
    console.log('[dev] 重启请求已过期（10 分钟有效），忽略并清理')
    try {
      fs.unlinkSync(RESTART_REQUEST_FILE)
    } catch {}
    return
  }
  if (action !== 'restart') return // pending 或内容无效 → 忽略

  // Agent 执行中（.agent-busy 锁存在或 execution_logs 有 running）→ 等待释放
  //（保护窗语义：不抢占 Agent）
  if ((existsSync(LOCK_FILE) || hasRunningExecutions()) && isServerAlive()) {
    if (!restartWaitNotified) {
      console.log('[dev] Agent 执行中，等待执行结束后执行用户确认的重启...')
      restartWaitNotified = true
    }
    return
  }

  restartInProgress = true
  try {
    let req = null
    try {
      req = JSON.parse(raw)
    } catch {}
    const reason = (req && req.reason) || '用户请求'
    const sessionId = (req && req.sessionId) || ''
    restartWaitNotified = false // 下个等待周期重新提示

    console.log(`[dev] 收到用户确认的重启请求（原因：${reason}）`)
    await restartWithRetry(`用户确认重启（原因：${reason}）`)

    // 等健康再写完成标记（restartWithRetry 失败时进入 30s 周期重试，此处兜底等待）
    const healthy = await waitForServer()
    if (healthy) {
      fs.writeFileSync(
        RESTART_DONE_FILE,
        JSON.stringify({ sessionId, reason, completedAt: new Date().toISOString() }, null, 2)
      )
      try {
        fs.unlinkSync(RESTART_REQUEST_FILE)
      } catch {}
      console.log('[dev] 重启完成，已写 .restart-done 通知 server 广播「重启完成」')
    }
  } finally {
    restartInProgress = false
  }
}

// 路径 A：fs.watch 事件驱动（即时）。监听 ROOT 非递归——现有 srcDir watcher 是
// recursive 且只管 src/，.restart-request 在 ROOT 必须新建。回调过滤
// basename === '.restart-request'（大小写归一：Windows 事件文件名大小写可能与
// 写入不一致）；writeFileSync → 'change'、unlinkSync → 'rename' 都处理；
// filename 为 null → 保守重读（误触发无害：重读发现非 confirmed → 忽略）。
// 不做 mtime 误报过滤（历史教训：那正是丢真事件的代码级先例，src watcher
// 曾因此误忽略真变更），不设防抖窗口（重启确认即时性就是收益，重复事件由
// restartInProgress + state 检查天然去重）。
const restartWatcher = watch(ROOT, (_event, filename) => {
  // .napcat-request：NapCat 启停请求（server 薄桥写），独立分发
  if (filename && path.basename(filename).toLowerCase() === '.napcat-request') {
    pollNapcatRequest()
    return
  }
  if (filename && path.basename(filename).toLowerCase() !== '.restart-request') return
  pollRestart()
})

// 路径 B：5s 兜底轮询（可靠）。钉死「文件存在即进 pollRestart()」不做存在性
// diff——.restart-request 有原地重写流（updateRestartRequest pending→confirmed
// 写同一条路径），事件双丢失场景下 diff 永不触发、兜底在其存在目的场景里失效；
// 照抄现有 !existsSync return 范式，pollRestart 内部状态判定自然忽略 pending/
// 过期（每 5s 读一个微型 JSON，成本≈零）。
setInterval(pollRestart, 5000)
setInterval(pollNapcatRequest, 5000)

// ─── 退出处理 ─────────────────────────────────

const EXIT_TIMEOUT = 2000

function shutdown(signal) {
  console.log(`\n[dev] 收到 ${signal}，关闭所有子进程...`)
  watcher.close()
  restartWatcher.close()
  killAll()
  stopNapcat() // dev.js 是 NapCat 的进程管理器——退出时停掉自己拉起的实例（手动实例不受影响）
  setTimeout(() => {
    console.log('[dev] 退出')
    process.exit(0)
  }, EXIT_TIMEOUT)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => {
  killAll()
  stopNapcat()
})

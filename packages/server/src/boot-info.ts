/**
 * 启动账本（`server_boots`）的**身份采集层**（票 A）。
 *
 * 目的：补上「重启了没有」之外的另一半验证面——**换成了哪一版代码**。每次启动采集
 * 一份进程身份（pid / git sha / dirty / 库文件 / 模式），由 `index.ts` 落一行进库，
 * 之后随时可经 `query_db(table='server_boots')` 回查。
 *
 * ## 四条口径（店长裁决，别「顺手统一」）
 *
 * 1. **git 根从 `module_file` 反推，不读 `process.cwd()`**——会话 cwd 可能落在
 *    `workspace/` 子目录，读到的就不是加载这段代码的那棵树。两者不一致本身是信号，
 *    故 `cwd` 与 `module_file` 都记。
 * 2. **dirty 存 INTEGER 0/1 + porcelain 摘要**——只记 `1` 会让「跑的是不是那笔代码」
 *    仍需人工回查；摘要把判断成本压到一眼。
 * 3. **探测失败不阻塞启动**：git 不可用 / 超时 / 非仓库 ⇒ git 字段全 `null`，行照写。
 *    **不把未知写成 0**——`0` 的语义是「已探测且干净」，与「没探到」是两件事。
 * 4. **剥 `GIT_*` 环境变量**：钩子与父进程会注入 `GIT_DIR` / `GIT_WORK_TREE` 一类的
 *    定位变量，照单全收会把探测指到**另一棵树**（本仓已两次实证）。
 *
 * 采集本身是纯同步的；调用点（`index.ts`）负责容错——这里抛错只代表编程错误。
 */
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { isProbeMode } from './probe-mode.js'
import { getDb } from './db/index.js'

/** git 探测超时（2s）——启动链路上不能因为一个挂死的 git 调用卡住 server */
export const GIT_TIMEOUT_MS = 2000

/** `dirty_summary` 的字符上限——脏树可能上百行，摘要是线索不是清单 */
export const DIRTY_SUMMARY_MAX = 200

/** 启动身份（`boot_id` / `started_at` 由写入层生成，不在采集面） */
export interface BootInfo {
  pid: number
  port: number
  cwd: string
  module_file: string
  mode: 'dev' | 'production'
  probe_mode: number
  git_root: string | null
  git_sha: string | null
  git_dirty: number | null
  dirty_summary: string | null
  db_file: string | null
  node_version: string
}

/** git 探测结果（单独导出给测试按面判读） */
export interface GitInfo {
  git_root: string | null
  git_sha: string | null
  git_dirty: number | null
  dirty_summary: string | null
}

/** 采集选项——端口默认按与 `index.ts` 相同的公式从 env 解析 */
export interface CollectBootOptions {
  /** 服务端实际使用的端口（`index.ts` 的 `PORT` 常量）；不传则读 `PORT` env */
  port?: number
}

/**
 * 剥掉 `GIT_*` 后的环境副本。
 *
 * `GIT_DIR` 是最常被注入的一个（git 在跑钩子时会导出），其余 `GIT_*` 同族变量
 * （`GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` …）一并剥——判据是
 * 「别让探测继承外层的仓库定位」，不是逐个拉黑。
 */
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}

/**
 * 跑一条 git 子命令；任何失败（非零退出 / 超时 / git 不存在）⇒ `null`。
 *
 * `--no-optional-locks` 放在子命令之前（git 全局选项位）：避免探测动作去抢
 * `index.lock`，与正在跑的 git 进程互相阻塞。
 */
function runGit(cwd: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // stderr 吞掉：探测失败是预期分支，不该污染启动日志
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: sanitizedGitEnv(),
    })
    return out.trim()
  } catch {
    return null
  }
}

/**
 * porcelain 输出 → 单行摘要：逐行保留（状态两字符是信息，不能 trim 掉），`; ` 连接，
 * 超上限截断并加省略号。空输入 ⇒ 空串（调用方据此落 `null`）。
 */
export function summarizeDirty(porcelain: string): string {
  const lines = porcelain.split(/\r?\n/).filter((line) => line.length > 0)
  const joined = lines.join('; ')
  return joined.length > DIRTY_SUMMARY_MAX ? `${joined.slice(0, DIRTY_SUMMARY_MAX)}…` : joined
}

/**
 * 从入口模块路径反推所在仓库的身份。三处探测**各自 fail-soft**：
 *
 * - 根找不到 ⇒ 四个字段全 `null`（不是仓库环境，或 git 不可用）；
 * - 根找到了但 `HEAD` / `status` 失败 ⇒ 能拿到的照记，拿不到的留 `null`；
 * - 干净树 ⇒ `git_dirty=0`、`dirty_summary=null`。
 */
export function collectGitInfo(moduleFile: string): GitInfo {
  const startDir = dirname(moduleFile)
  const gitRoot = runGit(startDir, ['rev-parse', '--show-toplevel'])
  if (gitRoot === null || gitRoot === '') {
    return { git_root: null, git_sha: null, git_dirty: null, dirty_summary: null }
  }

  const sha = runGit(gitRoot, ['rev-parse', 'HEAD'])
  const status = runGit(gitRoot, ['status', '--porcelain'])
  return {
    git_root: gitRoot,
    git_sha: sha === null || sha === '' ? null : sha,
    git_dirty: status === null ? null : status.length > 0 ? 1 : 0,
    dirty_summary: status === null || status.length === 0 ? null : summarizeDirty(status),
  }
}

/** 配置意图端口（与环境解析同公式；非法值回落 3200） */
function configuredPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '3200', 10)
  return Number.isFinite(parsed) ? parsed : 3200
}

/**
 * 采集本次启动的完整身份。
 *
 * `moduleFile` 由调用方用 `fileURLToPath(import.meta.url)` 给出——用入口模块的**真实
 * 路径**反推 git 根，而不是 `process.cwd()`（见文件头口径 1）。
 */
export function collectBootInfo(moduleFile: string, opts: CollectBootOptions = {}): BootInfo {
  return {
    pid: process.pid,
    port: opts.port ?? configuredPort(),
    cwd: process.cwd(),
    module_file: moduleFile,
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'dev',
    probe_mode: isProbeMode() ? 1 : 0,
    ...collectGitInfo(moduleFile),
    // `getDb().name` = better-sqlite3 解析后的库文件名（`index.ts` 调用点已完成 initDb）
    db_file: getDb().name,
    node_version: process.version,
  }
}

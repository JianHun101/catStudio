/**
 * 共享测试工具。
 *
 * - 创建内存 SQLite 数据库（走真实迁移路径，schema 与生产同源）
 * - Fastify 测试应用构建
 * - 起 stub 服务时的**端口分配**（避开 WHATWG Fetch 禁用端口黑名单，见 `listenFetchable`）
 * - 测试隔离目录的绝对路径派生（见 `isolatedTestDir`）
 */
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { applyMigrations } from './db/index.js'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（`packages/server`）——隔离目录的派生键。`resolve` 抹掉尾部分隔符，与 vitest 配置的 `__dirname` 同形。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 测试隔离根：`os.tmpdir()` 下按**本包目录绝对路径**派生的独立子目录。
 *
 * 为什么必须绝对、且必须带仓库键：worktree 的 `node_modules` 是指向主仓库的 junction，
 * 于是任何相对路径（`node_modules/.cache/xxx`）或 cwd 派生路径，在主仓库、本会话
 * worktree、以及将来一猫一 worktree 的各根里，**解析到同一批物理文件**。两进程并发跑
 * 同一批用例时，A 的 `afterEach` 删掉 B 刚 `existsSync` 过的那一个文件 ⇒ 假红。
 * 派生键取「这是哪个仓库」，故主仓库与各 worktree 各得一份，互不可见。
 *
 * 为什么不是 `process.cwd()`：`pnpm test` / `pnpm test:server` / `--root` 三种调用下
 * cwd 不同，分叉时**静默**（两处算同一个哈希 ⇒ 隔离凭空失效）。派生键要钉在「哪个仓库」
 * 上，不是「从哪儿敲的命令」。
 *
 * 同一派生公式在 `packages/server/vitest.config.ts` 复写一份（配置面不能 import 本文件——
 * 会把 better-sqlite3 / sqlite-vec 拖进配置加载期）。
 */
const ISOLATION_ROOT = resolve(
  tmpdir(),
  'cat-study-test-isolation',
  createHash('sha1').update(PACKAGE_ROOT).digest('hex').slice(0, 12)
)

/**
 * 取一个隔离目录的**绝对路径**（离开仓库，见 `ISOLATION_ROOT`）。
 *
 * 调用方把它交给 `vi.stubEnv('RESTART_FILES_DIR', …)` / 配置 `test.env` —— 被测模块
 * 内部是 `resolve(env ?? process.cwd(), '<后缀>')`，喂绝对路径即可短路掉 cwd 那一层。
 * `name` 保持各处原有的末段（`restart-test-create` / `restart-test-shutdown` / …）：
 * 同根内不同用例组各占一段，跨根由 `ISOLATION_ROOT` 的仓库键分开。
 */
export function isolatedTestDir(name: string): string {
  return resolve(ISOLATION_ROOT, name)
}

/** `createIsolatedRepoRoot` 的产出：壳（`..` 落点）+ 壳内的仓库根（真 mainRoot） */
export interface IsolatedRepoRoot {
  /** 进程唯一壳目录——`catWorktreePath` 的 `..` 落在这里 */
  shell: string
  /** 传给路径 helper / `process.chdir` 的仓库根 */
  repo: string
}

/**
 * 进程唯一的「临时主仓库根」夹具 —— worktree 系列路径 helper 的 `mainRoot` 锚点。
 *
 * **为什么不能直接 `mkdtempSync(join(tmpdir(), 'x-'))` 当仓库根**：
 * `catWorktreePath` / `sessionWorktreePath` 都是
 * `resolve(mainRoot, '..', 'catStudy-sessions', …)` —— 随机仓库名**被那个 `..` 整个丢掉**，
 * 产物只取决于 `tmpdir()` + shortId + 猫名，**三项全确定性**。于是两进程并发跑同一文件时
 * 物理路径对撞（A 建出的树被 B 当残留复用/删掉），读数随机红。实测基线
 * （`serial.cat-worktree.test.ts` 两进程同跑）：A 6 败/6 过、B 8 败/4 过，双双 exit 1。
 *
 * 壳目录 `mkdtemp` 是**进程唯一**的那一层 ⇒ `..` 落在 `<壳>` 内，跨进程互不可见。
 * 仓库根取 `<壳>/repo` 而不是壳本身：让 `..` 的落点还有一层独立名字，壳也不被 git
 * 当成工作区（`getMainRepoRoot()` 从 cwd 上溯时不会撞见「壳即仓库」）。
 *
 * 用法：`repo` 交给 `chdir` / 路径 helper；清理走 `removeIsolatedRepoRoot`（删壳，不是删 repo）。
 * **同型状态文件（`cat-study-test-isolation`）的判据是「哪个仓库」，本夹具的判据是
 * 「哪个进程」**——并发跑同一文件的两个进程同仓库，故前者不够用，必须 `mkdtemp` 那一层。
 */
export function createIsolatedRepoRoot(prefix = 'cat-study-test-repo-'): IsolatedRepoRoot {
  const shell = mkdtempSync(join(tmpdir(), prefix))
  const repo = resolve(shell, 'repo')
  mkdirSync(repo, { recursive: true })
  return { shell, repo }
}

/**
 * 清理夹具：删**壳**——`<壳>/catStudy-sessions/*` 那些 worktree 目录是 `repo` 的兄弟，
 * 只删 `repo` 会把它们与空壳一起留在 `tmpdir()` 里（本仓有「临时目录清理不全」的前科）。
 */
export function removeIsolatedRepoRoot(root: IsolatedRepoRoot): void {
  try {
    rmSync(root.shell, { recursive: true, force: true })
  } catch {
    /* 兜底清理失败忽略（Windows 下 cwd 被持有会 EPERM） */
  }
}

/**
 * 创建带**完整 schema** 的内存 SQLite 数据库。
 *
 * 这里曾经手抄着一份 200 行的 `SCHEMA_SQL` —— 那是一条**平行真相源**：抄得对不对、
 * 有没有跟上迁移，全靠人肉维护（且实测已经落后：chunks / chunk_vectors / chunks_fts /
 * retrieval_* / spans 五组表它压根没有）。票 `db-schema-governance` 票 1 把「迁移数组 =
 * 唯一 schema 真相源」立成闸之后，本函数改为**跑真实迁移路径**：
 *
 * - 语义 = **全新库**（空库重放基线集）⇒ 建出的就是生产同款结构，含 `schema_migrations`
 *   台账；故其后任何一次 `initDb()` 都是 checksum 校验 + **零执行**的 no-op。
 * - 「老库」（有用户表、无台账）**不再由本函数扮演**——想测老库路径（baseline 补登 +
 *   探针矫正）就显式删台账（`DROP TABLE schema_migrations`，见 `db/migrations.test.ts`），
 *   否则测的是全新库、自己却以为在测老库。
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // 迁移数组里有 vec0 虚拟表（chunk_vectors）⇒ sqlite-vec 必须**在跑迁移之前**加载。
  // 不再 try/catch 降级：生产 `initDb()` 同样硬依赖它，测试面与生产面必须同款。
  sqliteVec.load(db)
  applyMigrations(db)
  return db
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  return app
}

/** `listenFetchable` 的重取上限 —— 单次命中黑名单概率约 15/13977，8 次已是天文安全裕度 */
const LISTEN_ATTEMPTS = 8

/**
 * 服务已在监听时，判断该端口能否被 `fetch` **触达**。
 *
 * 判据必须是 fetch 本身（而不是「端口在听」）：实测同一端口可以 `TCP CONNECT-OK`
 * 而 `fetch` 报 `bad port` —— 两个谓词不同面。任何异常（含 `ECONNREFUSED`，
 * 表示端口没被拒、只是没人听）都算「不可触达」，由调用方决定怎么处置。
 */
export async function isFetchReachable(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`)
    return true
  } catch {
    return false
  }
}

/**
 * 让 `server` 监听一个 **fetch 可触达**的端口，返回实际端口。
 *
 * 为什么不能只用 `listen(0)`：OS 分配的端口可能落在 **WHATWG Fetch 禁用端口黑名单**
 * （1719 / 1720 / 1723 / 3659 / 4045 / 4190 / 5060 / 6000 / 6566 / 6665–6669 / 10080 …）。
 * 这类端口上服务**真的在监听**（裸 TCP 连得通、`listening:true`），但 undici 的 `fetch`
 * 在发请求**之前**就拒（`cause = "bad port"`），且**永不恢复** ⇒ 客户端探活吃满超时预算
 * ⇒ 测试撞穿 harness 预算（`Test timed out`）。本机动态端口池是 1024–15000
 * （`netsh int ipv4 show dynamicport tcp`），与黑名单**有交叠**，故命中概率非零。
 *
 * 此处**不比对硬编码黑名单**——那份表随 undici 版本漂移，抄一份就是下一次静默复发；
 * 改为**真的 fetch 一次**，与消费方同面。命中即可换端口重来。
 */
export async function listenFetchable(server: Server, host = '127.0.0.1'): Promise<number> {
  return withFetchablePort(
    () =>
      new Promise<number>((resolve) => {
        server.listen(0, host, () => resolve((server.address() as AddressInfo).port))
      }),
    // 换端口前必须真的关掉：同一个 Server 实例可 close 后重新 listen，
    // 但不关就再 listen 会 EADDRINUSE。
    () => closeServer(server),
    (port) => isFetchReachable(host, port)
  )
}

/**
 * 「分配 → 校验 → 命中则重取」循环。判据（`probe`）与副作用（`bind`/`unbind`）都从外面传：
 * **重取分支在真机上要 OS 恰好分到黑名单端口才走得到**（约 15/13977），注入替身才能把它
 * 钉进单测——否则这条分支的「写了但从不执行」与「压根没写」在判据上无法区分。
 */
export async function withFetchablePort(
  bind: () => Promise<number>,
  unbind: () => Promise<void>,
  probe: (port: number) => Promise<boolean>,
  attempts = LISTEN_ATTEMPTS
): Promise<number> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await bind()
    if (await probe(port)) return port
    await unbind()
  }
  throw new Error(
    `withFetchablePort: 连续 ${attempts} 次分配到的端口都不可被 fetch 触达` +
      `（WHATWG 禁用端口黑名单？）——端口池配置可能异常，见 listenFetchable 注释`
  )
}

/** 关掉 server，并**强制断开**已有连接（含 fetch keep-alive 池里的空闲 socket，否则 close 回调可能一直等） */
export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}

/**
 * 记忆引用读侧 REST API（M1）——「这条回复用了哪些记忆」的产品出口。
 *
 * 两条端点是**同一个功能的两个面**，故同处一文件（按前缀拆进 `messages.ts` /
 * `sessions.ts` 会把一条链的两个读口分到两处，改一处漏一处没有编译期信号）：
 *
 * - `GET /api/sessions/:id/memory-refs?messageIds=a,b,c` → `{ [messageId]: MemoryRefsEntry }`
 *   批量口（**防 N+1**：一页 50 条消息只发 1 次请求）。
 * - `GET /api/memory/doc?path=docs/adr/xxx.md` → `{ path, content }`
 *   形态乙的次级链接：抽屉里「打开当前文档」。
 *
 * ## 三态口径（本票的承重面）
 *
 * 「有注入 / 无注入 / 未检索」**必须分开**——混在一起会把「压根没查」算成「查了没用」，
 * 「使用率」这个分母当场失真。判据落在 `state`：
 *
 * | state           | 判据                                                                |
 * |-----------------|---------------------------------------------------------------------|
 * | `injected`      | 该消息有 `injected = 1` 的候选节                                     |
 * | `not-retrieved` | 无检索流水行，或 `reason ∈ {not-enabled, empty-query, skipped-a2a}`  |
 * | `none`          | 其余（检索跑了、一节没入选：`no-hit` / `filtered-empty` / `budget-exhausted` / `embed-failed` / `timeout` / `error`） |
 *
 * 三态都带上 `reason` 原值（`null` = 压根没有流水行），UI 据此措辞。
 *
 * ## 为什么值不是裸数组（对票面 `{ [messageId]: MemoryRef[] }` 的**一处显式偏离**）
 *
 * 票面 §三 钉的顶层形状是 `{ [messageId]: MemoryRef[] }`，而 §四 A2 又要求三态可分——
 * **裸数组装不下 `reason`，两条要求不能同时满足**。这里取「顶层 Map 形状不变、值从
 * `MemoryRef[]` 升为 `{ state, reason, refs }`」，其中 `refs` 就是票面那个数组。
 * 偏离的理由与代价已写进交接文档 Open Questions，收口前请架构师裁。
 *
 * ## 只取 `injected = 1`
 *
 * probe 行与未注入的 final 行不进 UI（数据仍在库，聚合看板是 `E1` 的射程）。
 * ⚠️ `body_head` 是**命中片**全文，注入进 prompt 的是**整节**——二者不等价，
 * 出口文案不得声称「猫当时读到的就是这段」（见 `InjectedMemoryRef` 同名 ⚠️）。
 */
import type { FastifyInstance } from 'fastify'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  messages as messagesRepo,
  retrievalEvents as retrievalRepo,
  sessions as sessionsRepo,
} from '../db/repository/index.js'
import type { InjectedMemoryRef } from '../db/repository/retrievalEvents.js'
import { findRepoRootFrom } from '../repo-root.js'
import { createLogger } from '../logger.js'

// 白名单真源 = 扫描器（`scripts/flywheel/scan.mjs`）。**import 而非手抄**：本仓明令
// 「同一规则两处措辞 = 假绿源」——路由里另写一份字面量，扫描器改白名单时这里零信号。
// 与 `memory/index.test.ts` 同款压一条类型错（该文件是无类型声明的 `.mjs`），
// 也不为它另造 `.d.ts`（那等于给 scripts 包加一个只为 server 服务的影子文件）。
// @ts-expect-error —— 该脚本是无类型声明的 .mjs；宁可这里压一条类型错，也不手抄常量
import { SCAN_EXTENSION, SCAN_PREFIXES } from '../../../../scripts/flywheel/scan.mjs'

/** 白名单前缀（给上面那条 any 补回类型） */
const MEMORY_DOC_PREFIXES: readonly string[] = SCAN_PREFIXES
/** 白名单扩展名（同上） */
const MEMORY_DOC_EXTENSION: string = SCAN_EXTENSION

const log = createLogger('memory-routes')

/** 本模块所在目录（源码与构建产物深度不同——向上找根，不依赖层级） */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * 一次批量口最多接受几条消息 id（一页 50 条有 4× 裕度；超限即拒，不静默截断）。
 * **与前端 `MEMORY_REFS_MAX_IDS`（`ChatPanel.vue`）同值**——超限是整条 400，
 * 前端若按更大的上限发，整个会话的记忆行会一起灭。改动要两边同批。
 */
const MAX_MESSAGE_IDS = 200

/** 三态：有注入 / 检索跑了但没节入选 / 压根没检索 */
export type MemoryRefState = 'injected' | 'none' | 'not-retrieved'

/**
 * 「压根没检索」的 reason 档（**不是**「检索了但空手」）。
 *
 * 三档的共性 = **检索链没有对候选池做任何取舍**：`not-enabled` 功能关、
 * `empty-query` 剥 mention 后无内容、`skipped-a2a` a2a 门控。值域真源见
 * `memory/index.ts` 的 `MemoryRetrievalReason`——那里新增档位时本集合要不要跟，
 * 判据只有一条：**这一档跑没跑检索**。
 */
const NOT_RETRIEVED_REASONS: ReadonlySet<string> = new Set([
  'not-enabled',
  'empty-query',
  'skipped-a2a',
])

export interface MemoryRefsEntry {
  state: MemoryRefState
  /** `retrieval_events.reason` 原值；`null` = 该消息没有检索流水行 */
  reason: string | null
  /** **只含 `injected = 1` 的节**（票面 §三 的那个数组） */
  refs: InjectedMemoryRef[]
}

/** 解析 `?messageIds=a,b,c`：去空白、丢空段、保序去重；无有效项返回 null（调用方 400） */
export function parseMessageIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null
  const seen = new Set<string>()
  for (const piece of raw.split(',')) {
    const id = piece.trim()
    if (id) seen.add(id)
  }
  return seen.size > 0 ? [...seen] : null
}

/**
 * 任意分隔符形态 → posix 相对路径（消 `.` / `..`）。
 *
 * 走 `posix.normalize` 而**不是** `resolve`：后者按平台产出分隔符，Windows 上归一出
 * 的还是 `docs\adr\x.md`，`startsWith('docs/adr/')` 判据当场全假——守卫会退化成
 * 「一律拒绝」（比放行安全，但白名单里全是假阴性）。
 */
function toPosixRel(p: string): string {
  return posix.normalize(p.split(sep).join('/'))
}

/** 白名单判据：相对仓库根、落 `SCAN_PREFIXES` 内、且是 `SCAN_EXTENSION` */
function isWhitelistedRel(rel: string): boolean {
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  if (!MEMORY_DOC_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false
  return rel.endsWith(MEMORY_DOC_EXTENSION)
}

/** 仓库根（锚 `scripts/flywheel/scan.mjs`——白名单真源所在；找不到即整条链不可用） */
function findMemoryDocsRoot(): string | null {
  for (const start of [moduleDir, process.cwd()]) {
    const root = findRepoRootFrom(start, ['scripts', 'flywheel', 'scan.mjs'])
    if (root) return root
  }
  return null
}

/**
 * 解析并校验 `?path=` 的相对仓库路径。返回 `null` = **拒绝**（调用方 400）。
 *
 * 四种变体**全部**要拒（票面 A3 承重项），且**拒绝原因是白名单/穿越，不是 404**——
 * 报成 404 的话「守卫生效」与「文件恰好不存在」在读数上同形，守卫等于没被验证过：
 *   `../../etc/passwd`（相对穿越）/ `/etc/passwd`（绝对路径）/ 盘符（`C:…`）/
 *   反斜杠变体（`docs\adr\x.md`）/ 白名单外（`docs/run/map.md`）。
 *
 * 反斜杠**单独拦**、不交给 `path.normalize`：Windows 上 `\` 是合法分隔符，`resolve`
 * 会把它当层级消掉——「同一条串在 Linux 上是一个文件名、在 Windows 上是一次穿越」
 * 这层平台分歧必须在守卫里消失，不能留给运行平台决定。
 */
export function resolveMemoryDocPath(
  raw: unknown
): { root: string; abs: string; rel: string } | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return null
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return null

  const root = findMemoryDocsRoot()
  if (!root) return null

  // 先归一再看白名单：`docs/adr/../../../x` 归一成 `../x`，由 `..` 判拦下——**不是**靠
  // `startsWith('docs/adr/')`（那条串确实以该前缀开头，前缀判会假绿放行）。
  const rel = toPosixRel(trimmed)
  if (!isWhitelistedRel(rel)) return null

  const abs = resolve(root, rel)
  // 二次确认：拼接后仍在仓库根内、仍落白名单（前缀形近 / 归一差异的兜底）
  if (!isWhitelistedRel(toPosixRel(relative(root, abs)))) return null
  return { root, abs, rel }
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/sessions/:id/memory-refs?messageIds=a,b,c
   *
   * 请求里**每个属于该会话的消息都有键**（无流水行的落 `state: 'not-retrieved'`）。
   * 请求了不属于该会话 / 不存在的消息 id → **整条请求 400**：本仓有跨会话越权前科，
   * 且「静默返回空」会把越权与「真的没注入」混成同一个读数。
   */
  app.get('/api/sessions/:id/memory-refs', async (req, reply) => {
    const sessionId = (req.params as { id: string }).id
    if (!sessionsRepo.getSessionById(sessionId)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const messageIds = parseMessageIds((req.query as { messageIds?: unknown }).messageIds)
    if (!messageIds) {
      return reply.status(400).send({ error: 'messageIds is required (comma-separated)' })
    }
    if (messageIds.length > MAX_MESSAGE_IDS) {
      return reply
        .status(400)
        .send({ error: `messageIds too many: ${messageIds.length} > ${MAX_MESSAGE_IDS}` })
    }

    const foreign = messageIds.filter((id) => !messagesRepo.messageExists(id, sessionId))
    if (foreign.length > 0) {
      return reply.status(400).send({
        error: `messageIds not in session ${sessionId}: ${foreign.join(',')}`,
      })
    }

    const found = retrievalRepo.getInjectedRefsByMessageIds(messageIds, sessionId)
    const payload: Record<string, MemoryRefsEntry> = {}
    for (const id of messageIds) {
      const hit = found.get(id)
      // 无流水行 = 压根没检索（三态里的第三态），**不是**「检索了没注入」
      if (!hit) {
        payload[id] = { state: 'not-retrieved', reason: null, refs: [] }
        continue
      }
      payload[id] = {
        state: hit.sections.length
          ? 'injected'
          : NOT_RETRIEVED_REASONS.has(hit.reason ?? '')
            ? 'not-retrieved'
            : 'none',
        reason: hit.reason,
        refs: hit.sections,
      }
    }
    return reply.send(payload)
  })

  /**
   * GET /api/memory/doc?path=docs/adr/xxx.md
   *
   * 抽屉里「打开当前文档」——**返回的是当前检出上的文档，不是当时的快照**（形态丙
   * GitHub 外链被否正是因为这点；本端点的措辞同样不得让用户以为看到的是快照）。
   * 只读、不写、不缓存。
   *
   * 拒绝 = **400 + 明确原因**（白名单/穿越）；只有「白名单内但文件不存在」才是 404。
   */
  app.get('/api/memory/doc', async (req, reply) => {
    const raw = (req.query as { path?: unknown }).path
    const resolved = resolveMemoryDocPath(raw)
    if (!resolved) {
      log.warn('记忆文档读取被拒（白名单/穿越）', { path: typeof raw === 'string' ? raw : null })
      return reply.status(400).send({
        error: 'path rejected: must be a repo-relative .md path under the scanned whitelist',
      })
    }
    if (!existsSync(resolved.abs) || !statSync(resolved.abs).isFile()) {
      return reply.status(404).send({ error: 'Document not found' })
    }
    // 符号链接兜底：白名单目录内的软链可以指向仓库外——解析真实路径后**重跑**白名单
    const real = realpathSync(resolved.abs)
    if (!isWhitelistedRel(toPosixRel(relative(resolved.root, real)))) {
      log.warn('记忆文档读取被拒（realpath 逃出白名单）', { path: resolved.rel })
      return reply.status(400).send({ error: 'path rejected: resolves outside the whitelist' })
    }
    reply.header('Cache-Control', 'no-store')
    return reply.send({ path: resolved.rel, content: readFileSync(resolved.abs, 'utf8') })
  })
}

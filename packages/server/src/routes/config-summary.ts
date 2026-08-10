/**
 * 摘要配置 API — 交接/增量摘要使用的 SUMMARY_MODEL / SUMMARY_API_KEY 的读写入口。
 *
 * 背景：交接/摘要的非流式链路此前因推理模型配额语义静默失败（用户报「交接线到了
 * 没触发」，根因见 llm/complete.ts 的 thinking 修复），用户要求这些配置项可管理。
 *
 * - GET  — 回显当前生效值（key 掩码 `sk***last4`，完整 key 不出 server）
 * - POST — 行级 patch .env：只替换 SUMMARY_MODEL= / SUMMARY_API_KEY= 行，
 *         注释/键序/引号保真；行不存在则追加；SUMMARY_API_KEY 传空串 = 删除该行
 *         （删除而非写空值——env.ts 的 `SUMMARY_API_KEY ??= DS_KEY` 对显式空串
 *         不生效（'' 非 nullish），只有行消失才真正回退复用 DS_KEY）
 * - 敏感：key 写回与响应均不进日志（本路由无任何 log 调用携带 key）
 *
 * 重启语义：env.ts 模块加载时解析 + 模块缓存锁死，POST 写文件后需重启才生效
 * （needsRestart: true 驱动前端「已保存，重启后生效」提示链）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

const __dirname = pathDirname()

// 项目根 .env 定位——与 env.ts 同推导（env.ts 在 src/ 上溯 3 层，本文件在 src/routes/ 上溯 4 层）
const ROOT = resolve(__dirname, '..', '..', '..', '..')

/** .env 文件定位——默认项目根（与 env.ts 一致）；ENV_FILE_PATH 供测试隔离覆盖 */
function envFilePath(): string {
  return process.env.ENV_FILE_PATH || join(ROOT, '.env')
}

/** `sk***last4` 掩码；空串原样返回；短 key（≤8 字符）整体打码不泄前缀 */
function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '***'
  return `${key.slice(0, 2)}***${key.slice(-4)}`
}

function toResponseBody(needsRestart: boolean, note?: string) {
  const key = process.env.SUMMARY_API_KEY || ''
  return {
    ok: true,
    summaryModel: process.env.SUMMARY_MODEL || 'deepseek-v4-flash',
    summaryBaseUrl: process.env.SUMMARY_BASE_URL || 'https://api.deepseek.com',
    summaryApiKeyMasked: maskKey(key),
    hasKey: !!key,
    needsRestart,
    ...(note ? { note } : {}),
  }
}

/**
 * 行级 patch .env——changes 的 value 为 string 时替换/追加 `KEY=value` 行；
 * null 表示删除该行（清空语义）。其余行（注释/其他键/引号/空白）逐字符原样保留。
 * 行尾风格跟随原文件（CRLF 文件保持 CRLF，避免混合换行）。
 */
function patchEnvFile(changes: Record<string, string | null>): void {
  const file = envFilePath()
  let raw = ''
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    raw = '' // 文件不存在 = 从空文件开始（追加路径）
  }
  // 先探测行尾再剥离 \r（split 保留的 \r 若与 eol 叠加会成 \r\r\n）
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const out: string[] = []
  const touched = new Set<string>()
  for (const line of lines) {
    const trimmed = line.trim()
    const eqIdx = trimmed.indexOf('=')
    const key = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim() : ''
    if (key && key in changes && !touched.has(key)) {
      touched.add(key)
      const value = changes[key]
      if (value !== null) out.push(`${key}=${value}`)
      // null = 删除该行（不输出）
    } else {
      out.push(line)
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (!touched.has(key)) {
      if (value !== null) out.push(`${key}=${value}`)
      touched.add(key)
    }
  }
  // 原子写：临时文件 + rename 替换（防写一半崩溃留下截断的 .env）
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, out.join(eol), 'utf-8')
  renameSync(tmp, file)
}

export async function summaryConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config/summary', async (_req, reply) => {
    return reply.send(toResponseBody(false))
  })

  app.post('/api/config/summary', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const hasModel = body.summaryModel !== undefined
    const hasKey = body.summaryApiKey !== undefined
    if (hasModel && (typeof body.summaryModel !== 'string' || body.summaryModel.trim() === '')) {
      return reply.status(400).send({ error: 'summaryModel must be a non-empty string' })
    }
    if (hasKey && typeof body.summaryApiKey !== 'string') {
      return reply
        .status(400)
        .send({ error: 'summaryApiKey must be a string (empty string clears it)' })
    }
    if (!hasModel && !hasKey) {
      // 无字段 = 无变更——返回当前状态，不写盘
      return reply.send(toResponseBody(false))
    }
    const changes: Record<string, string | null> = {}
    if (hasModel) changes.SUMMARY_MODEL = body.summaryModel.trim()
    // 空串 = 清空：删除行 → 重启后 env.ts 的 ??= DS_KEY 兜底生效（说明写进响应 note）
    if (hasKey) changes.SUMMARY_API_KEY = body.summaryApiKey === '' ? null : body.summaryApiKey
    patchEnvFile(changes)
    const note =
      changes.SUMMARY_API_KEY === null ? 'SUMMARY_API_KEY 已清空，重启后回退复用 DS_KEY' : undefined
    return reply.send(toResponseBody(true, note))
  })
}

/** fileURLToPath 的一次性包装（模块顶层执行一次即可） */
function pathDirname(): string {
  return dirname(fileURLToPath(import.meta.url))
}

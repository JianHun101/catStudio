/**
 * 重启确认机制——请求文件读写与前缀检测（server 侧共享模块）。
 *
 * 链路：店长发「【重启请求】原因：xxx」消息 → ingest 落库时检测前缀 →
 * 写 .restart-request（state=pending）→ 前端气泡按钮 → RESTART_CONFIRM →
 * state=confirmed → dev.js（scripts/dev.js，轮询同一路径）执行重启 →
 * 写 .restart-done → 新 server 启动广播「重启完成」→ 删 done。
 *
 * 文件位置与 .agent-busy 锁同款：resolve(dir, ...)，dir = RESTART_FILES_DIR ?? process.cwd()——
 * pnpm dev 时 dev.js 以仓库根 spawn server（cwd=ROOT），两侧路径一致；
 * 测试环境经 vitest env 设 RESTART_FILES_DIR 指向 node_modules/.cache 隔离目录，
 * 防测试跑批的 afterEach 清理误删运行时真实请求文件（17:38 事故根因，实验 100% 复现）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/** 重启请求消息前缀（店长消息以此开头触发机制） */
export const RESTART_PREFIX = '【重启请求】'

/** 请求有效期：10 分钟（过期后 dev.js 忽略、前端隐藏按钮） */
export const RESTART_TTL_MS = 10 * 60 * 1000

/** 文件基础目录——生产不设 env → 项目根（与 dev.js 轮询路径一致）；测试经 vitest env 隔离 */
const RESTART_FILES_DIR = process.env.RESTART_FILES_DIR ?? process.cwd()
// 隔离目录（测试）可能不存在——模块加载时确保可写（生产 = cwd 已存在 → no-op）
mkdirSync(RESTART_FILES_DIR, { recursive: true })

/** 请求文件路径（dev.js 轮询同一路径） */
export const RESTART_REQUEST_FILE = resolve(RESTART_FILES_DIR, '.restart-request')

/** 重启完成标记路径（dev.js 重启成功后写，新 server 启动时读并广播） */
export const RESTART_DONE_FILE = resolve(RESTART_FILES_DIR, '.restart-done')

export interface RestartRequestFile {
  /** 触发消息 ID（前端按消息关联按钮状态） */
  messageId: string
  /** 请求所在的会话 ID（dev.js 写 done 时带回，server 广播到该会话） */
  sessionId: string
  /** 请求原因（「原因：xxx」中的 xxx，dev.js 重启日志与完成广播使用） */
  reason: string
  createdAt: string // ISO 8601
  expiresAt: string // ISO 8601（createdAt + RESTART_TTL_MS）
  state: 'pending' | 'confirmed'
}

export interface RestartDoneFile {
  sessionId: string
  reason: string
  completedAt: string // ISO 8601
}

/**
 * 归一化触发标记：『重启请求』（直角引号）→【重启请求】（方括号，RESTART_PREFIX）。
 * 契约漂移根因（按钮不出现事故）：6231ec9 防复述抢占把 seed-data prompt 的重启格式改成
 * 『』（意图：LLM 复述格式说明时抄『』不会误触发），但只改了 prompt 没改识别层——
 * 本函数历史契约是【】，LLM 照 prompt 输出『重启请求』原因：xxx 时两边对不上，
 * 识别不命中 → 不写请求文件 → 按钮不出来。归一化后两写法等价。
 * 防复述语义不受影响：复盘写「用『重启请求』四字即可」归一化后是「用【重启请求】四字即可」——
 * 无「原因：」连续串不命中；「『重启请求』四字 + 『原因：』」拆开叙述同样不构成连续串。
 */
function normalizeRestartPrefix(content: string): string {
  return content.replaceAll('『重启请求』', RESTART_PREFIX)
}

/**
 * 检测消息内容是否为重启请求——行首【重启请求】或任意位置「【重启请求】原因：」即命中。
 * 行首精确匹配兼容历史消息；嵌中命中覆盖「叙述 + 请求合并」的真实 agent 产出模式
 * （agent 回复天然带叙述前文，行首 startsWith 与产出模式不匹配——第六次行首事故根因）。
 * 容错三件套（2026-08-07 店长触发失败根治——「重启请求 原因：」裸四字 + 空格完全不命中）：
 *   ① 裸四字「重启请求」无括号也命中——prompt「『重启请求』四字」表述诱导 LLM 省略括号；
 *   ② 标记与原因壳之间允许空白（自然行文会加空格）；
 *   ③ 冒号兼容全/半角（与 extractRestartReason 的 [:：] 对齐，避免识别与提取两套契约）。
 * 误触发面：复盘文字需构成「重启请求 + 原因：」连续串才命中（防复述用例钉死）；残余的
 * 完整叙述复述（如「上次重启请求 原因：卡了」）会命中——已知限制（复述抢占），代价不对称：
 * 误触发 = 气泡按钮可见可取消 + TTL 10 分钟；漏触发 = 用户手动重启（本次事故），故放宽容忍。
 * 『重启请求』（seed-data prompt 教的写法）先归一化为【重启请求】再判定，两写法等价（见上）。
 */
export function isRestartRequestContent(content: string): boolean {
  const normalized = normalizeRestartPrefix(content)
  if (normalized.startsWith(RESTART_PREFIX)) return true
  return /(?:【重启请求】|重启请求)\s*原因[:：]/.test(normalized)
}

/** 从「…【重启请求】原因：xxx」提取原因（从标记后提取至段落行尾，嵌中/行首通用，缺省兜底；『』同义、裸四字兼容） */
export function extractRestartReason(content: string): string {
  const normalized = normalizeRestartPrefix(content)
  // 标记兼容【】/『』/裸四字——与 isRestartRequestContent 同一容错面，防「识别命中但提取失配」
  const markerMatch = normalized.match(/(【重启请求】|重启请求)/)
  if (!markerMatch) return '用户请求'
  const after = normalized.slice((markerMatch.index ?? 0) + markerMatch[0].length).trim()
  // m 标志：$ 匹配行尾——reason 只取到段落结束（下个换行）
  const reasonMatch = after.match(/^原因[:：]\s*(.*)$/m)
  if (reasonMatch) return reasonMatch[1].trim() || '用户请求'
  return after || '用户请求'
}

/** 读请求文件并解析（文件不存在/JSON 损坏 → null） */
export function readRestartRequest(): RestartRequestFile | null {
  if (!existsSync(RESTART_REQUEST_FILE)) return null
  try {
    const raw = readFileSync(RESTART_REQUEST_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as RestartRequestFile
    if (!parsed || typeof parsed !== 'object' || typeof parsed.messageId !== 'string') return null
    if (parsed.state !== 'pending' && parsed.state !== 'confirmed') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 新建请求文件——覆盖判定 = 「不存在（含损坏）或已过期 → 覆盖」；未过期才保留跳过
 * （含未过期 pending——同一时间一个生效请求是设计：正在等用户确认的请求不应被新
 * 请求顶掉，注释写明防后人当 bug 改）。
 */
export function createRestartRequest(req: RestartRequestFile): boolean {
  const existing = readRestartRequest()
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return false
  writeFileSync(RESTART_REQUEST_FILE, JSON.stringify(req, null, 2))
  return true
}

/** 覆盖写请求文件（确认/取消状态流转用） */
export function updateRestartRequest(req: RestartRequestFile): void {
  writeFileSync(RESTART_REQUEST_FILE, JSON.stringify(req, null, 2))
}

/** 删除请求文件（取消/过期清理） */
export function removeRestartRequest(): void {
  if (!existsSync(RESTART_REQUEST_FILE)) return
  unlinkSync(RESTART_REQUEST_FILE)
}

/** 读重启完成标记（不存在/损坏 → null） */
export function readRestartDone(): RestartDoneFile | null {
  if (!existsSync(RESTART_DONE_FILE)) return null
  try {
    const raw = readFileSync(RESTART_DONE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as RestartDoneFile
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 删除重启完成标记（广播完成后清理） */
export function removeRestartDone(): void {
  if (!existsSync(RESTART_DONE_FILE)) return
  unlinkSync(RESTART_DONE_FILE)
}

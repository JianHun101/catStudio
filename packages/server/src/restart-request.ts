/**
 * 重启确认机制——请求文件读写与前缀检测（server 侧共享模块）。
 *
 * 链路：店长发「【重启请求】原因：xxx」消息 → ingest 落库时检测前缀 →
 * 写 .restart-request（state=pending）→ 前端气泡按钮 → RESTART_CONFIRM →
 * state=confirmed → dev.js（scripts/dev.js，轮询同一路径）执行重启 →
 * 写 .restart-done → 新 server 启动广播「重启完成」→ 删 done。
 *
 * 文件位置与 .agent-busy 锁同款：resolve(process.cwd(), ...)——
 * pnpm dev 时 dev.js 以仓库根 spawn server（cwd=ROOT），两侧路径一致。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/** 重启请求消息前缀（店长消息以此开头触发机制） */
export const RESTART_PREFIX = '【重启请求】'

/** 请求有效期：10 分钟（过期后 dev.js 忽略、前端隐藏按钮） */
export const RESTART_TTL_MS = 10 * 60 * 1000

/** 请求文件路径（dev.js 轮询同一路径） */
export const RESTART_REQUEST_FILE = resolve(process.cwd(), '.restart-request')

/** 重启完成标记路径（dev.js 重启成功后写，新 server 启动时读并广播） */
export const RESTART_DONE_FILE = resolve(process.cwd(), '.restart-done')

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

/** 检测消息内容是否为重启请求（前缀精确匹配，行首语义） */
export function isRestartRequestContent(content: string): boolean {
  return content.startsWith(RESTART_PREFIX)
}

/** 从「【重启请求】原因：xxx」提取原因（去掉前缀与「原因：」壳，缺省兜底） */
export function extractRestartReason(content: string): string {
  return (
    content
      .replace(RESTART_PREFIX, '')
      .trim()
      .replace(/^原因[:：]\s*/, '')
      .trim() || '用户请求'
  )
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

/** 新建请求文件——已存在则跳过（同一时间只有一个生效请求，保留首个防覆盖） */
export function createRestartRequest(req: RestartRequestFile): boolean {
  if (existsSync(RESTART_REQUEST_FILE)) return false
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

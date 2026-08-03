/**
 * 重启请求判定纯函数（零依赖 ESM）。
 *
 * dev.js 轮询 .restart-request 文件时调用 decideRestartAction 决定动作；
 * 判定逻辑抽成纯模块以便 vitest 单测覆盖（scripts/restart-gate.test.js，
 * workspace 已把 scripts/ 注册为第四个 vitest 项目）。
 *
 * 与 server 侧（packages/server/src/restart-request.ts）的契约：
 * 文件 JSON 形如 { messageId, sessionId, reason, createdAt, expiresAt, state }
 * state: 'pending'（等待用户确认）| 'confirmed'（用户已点确认，dev.js 执行重启）。
 */

/**
 * 判定 .restart-request 文件内容应触发什么动作。
 *
 * @param {string|null|undefined} raw 文件原始内容（不存在时传 null）
 * @param {number} [now] 当前时间戳（毫秒）——测试注入用
 * @returns {'restart'|'expired'|null}
 *   - 'restart': state=confirmed 且未过期 → 应执行重启
 *   - 'expired': state=confirmed 但已过期 → 调用方可清理文件
 *   - null: 非 confirmed（pending/损坏/缺字段）→ 忽略
 */
export function decideRestartAction(raw, now = Date.now()) {
  if (!raw) return null
  let req
  try {
    req = JSON.parse(raw)
  } catch {
    return null
  }
  if (!req || typeof req !== 'object' || req.state !== 'confirmed') return null
  const expiresAt = new Date(req.expiresAt).getTime()
  if (Number.isNaN(expiresAt)) return null
  return now > expiresAt ? 'expired' : 'restart'
}

/**
 * 环境变量数字解析的**唯一入口**（OQ-6）。
 *
 * 病根：`parseFloat(process.env.X || '默认')` 对坏值（`X=abc`）返回 `NaN`，
 * 而 `NaN` 在消费点**不抛错、只静默改变语义**——实测（`MEMORY_TOP_K=abc`）：
 * 检索链 `reason=no-hit`、注入 **0 片**、无任何日志，与「真·没命中」不可区分。
 * 同族七处各有各的失效形态（阈值恒假 / JSON 序列化成 `null` / 交接永不触发），
 * 共同点是**坏值静默生效**。
 *
 * 契约（OQ-6 派活单拍板，形状不许改）：
 * - **未设置 / 空串**（含纯空白串）⇒ 返回 `fallback`，**不打日志**。
 *   那是 `env.ts` `??=` 的正常兜底面，逐条打日志只会刷屏。
 * - 解析后**非有限数**（`NaN` / `±Infinity`）⇒ 打一条 warn（变量名 + 原始串 +
 *   回退值）+ 返回 `fallback`。
 * - **不加区间钳位**：`0` / 负数原样生效。钳位会改语义（如 `slowMs=0` 会把每一跳
 *   标 `slow`），超出本票边界。
 *
 * 为什么用 `Number()` 而非 `parseFloat` / `parseInt`：后两者对 `5abc` 这类
 * **部分可解析**串静默取前缀值（`parseInt('5abc', 10) === 5`），**不产生 NaN**
 * ⇒ 永远走不到 warn 分支，恰是本票要消灭的那种坏值。`Number` 严格解析会让它
 * 落进 warn + 回退（代价：`X=5abc` 从「静默取 5」变成「warn + 取默认」，
 * 属有意的行为收紧，见回报 OQ）。
 *
 * 整数语义的调用方（如 `MEMORY_TOP_K`）在**调用点**自行 `Math.trunc`——
 * 本函数形状固定为两参，不引入模式开关。
 */
import { createLogger } from './logger.js'

const log = createLogger('env-number')

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  // 未设置 / 空串 / 纯空白：正常兜底面，不出声
  if (raw === undefined || raw.trim() === '') return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    log.warn(`环境变量 ${name} 不是有效数字，已回退默认值`, { raw, fallback })
    return fallback
  }
  return parsed
}

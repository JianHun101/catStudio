/**
 * restart-gate.js 的类型声明（纯类型，零运行时代码，不影响 dev.js 运行时）。
 *
 * 存在原因：restart-gate.js 是零依赖 ESM（dev.js 直接 import，无构建步骤、无 .d.ts），
 * 而 packages/server 的重启用例要**跨包喂真实判定函数**（断言「续期后的文件 dev.js 真会
 * 重启」而非只做时间算术）。tsc 的 allowJs=false → 无声明时 TS7016。
 * 备选方案（未采用）：server 侧 @ts-expect-error 抑制（仓库零先例、且会掩盖该 import
 * 未来任何类型错误）；把判定逻辑在测试里重写一份（测的是副本，不是真函数）。
 *
 * 维护契约：改 restart-gate.js 的 decideRestartAction 签名/返回值 → 必须同步改本文件。
 */

/**
 * 判定 .restart-request 文件内容应触发什么动作。
 *
 * @param raw 文件原始内容（不存在时传 null/undefined）
 * @param now 当前时间戳（毫秒）——测试注入用
 * @returns 'restart'（confirmed 且未过期）/ 'expired'（confirmed 但已过期）/ null（非 confirmed、损坏、缺字段）
 */
export function decideRestartAction(
  raw: string | null | undefined,
  now?: number
): 'restart' | 'expired' | null

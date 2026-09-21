/**
 * 飞轮扫描报告的**跳过明细聚合**——把 `report.skipped[]` 按 `reason` 归桶计数。
 *
 * **为什么需要这一层**：报告里原先只消费 `report.skipped.length` 一个总数，而这个数组
 * 里混着**两种性质完全不同**的跳过——
 *
 * - 「正常增量跳过」（`unchanged`）：本轮无新内容，索引已是最新。**健康**。
 * - 「真缺口」（`empty-evidence` / `no-frontmatter` …）：这份文档**永远进不了索引**，
 *   除非源文件被修。**要人管**。
 *
 * 混成一个总数，正常巡检读日志看不出谁被跳、为什么跳——`scanned:21 / skipped:21` 这行
 * 既可能是「21 件都没变」（全健康），也可能是「20 件没变 + 1 件残废」（有缺口），
 * 两者在读数上**同形**。归桶后两类才可分。
 *
 * **本模块只做聚合，不碰判定**：哪些件被跳过、以什么 reason 跳过，全部由
 * `scripts/flywheel/scan.mjs` 决定（`SKIP_REASONS` 常量在那边）。此处是纯投影，
 * 不新增跳过行为、不改既有读数面。
 *
 * ## 契约
 *
 * - **入参不受信**：`skipped` 是 `JSON.parse` 出来的任意值（调用方 `parseScanReport`
 *   返回 `any`）⇒ 非数组一律返回空桶，不抛错。日志增强不该成为启动链上的新失败点。
 * - **不静默丢**：元素的 `reason` 不是非空字符串时，归入 {@link UNKNOWN_REASON} 桶，
 *   而不是跳过它或猜测一个 reason。对应 `scan.mjs` 的契约 ④「跳过永不是静默的」——
 *   一个数不出来的跳过必须**可见**，哪怕它长得难看。
 * - **桶序 = reason 首次出现顺序**（对象插入序），不做字典序重排——调用方读日志时
 *   顺序与报告本身一致，便于逐行对照。
 */

/**
 * `reason` 缺失 / 非字符串 / 空串时的归集桶。
 *
 * 用尖括号包住是为了**永不与真实 reason 值碰撞**：`SKIP_REASONS` 的值域全是
 * kebab-case（`no-frontmatter`、`empty-evidence` …），不含尖括号。
 */
export const UNKNOWN_REASON = '<unknown>'

/**
 * 按 `reason` 归桶计数。
 *
 * @param skipped 扫描报告的 `skipped` 字段（元素形状 `{ path, reason, detail? }`）；
 *                非数组 ⇒ 空桶
 * @returns `reason → 条数` 的映射；无跳过 ⇒ 空对象
 */
export function summarizeSkippedByReason(skipped: unknown): Record<string, number> {
  // 空原型：`reason` 是外部数据，而 `__proto__` 这类键名在**普通对象**上走的是
  // 原型设置器而非属性赋值——那会让一条计数被静默吃掉，且 `counts['__proto__']`
  // 读回来还不是数字。空原型对象让任意字符串都是安全的普通键。
  const counts: Record<string, number> = Object.create(null)
  if (!Array.isArray(skipped)) return counts

  for (const entry of skipped) {
    // 元素形状**不受信**（可能是 null / undefined / 原始值），断言到具体形状而非留 `any`：
    // 可选链 + 下面那条 `typeof` 才是判据，不假设元素真是 `{ reason: string }`。
    const raw = (entry as { reason?: unknown } | null | undefined)?.reason
    const key = typeof raw === 'string' && raw.trim() !== '' ? raw : UNKNOWN_REASON
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

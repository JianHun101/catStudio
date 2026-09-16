/**
 * 通用工具函数
 */

/** JSON 字符串 → 数组的安全解析；解析失败或非数组返回 []（防御 DB 中损坏的 JSON 列） */
export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** JSON 字符串 → 任意结构化值的安全解析（tool_content/extra 等对象列用；失败返回 undefined） */
export function parseJsonValue<T = unknown>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * 从 catch 到的**任意值**取诊断串——`throw 'x'` / reject 一个非 Error 同样是合法抛出物，
 * 而 `err.message` 在那种情况下恒为 `undefined`（诊断当场归零）。
 *
 * 三条契约：
 * 1. `Error`（且 `message` 是字符串）→ **原样返回**，不加工。
 * 2. 其余 → `String(err)`；得到 `'[object Object]'`（信息量为零）时再试
 *    `JSON.stringify`——`throw { code: 42 }` 至少落得出 `{"code":42}`。
 * 3. **本函数不抛**：`String()` 会触发 `toString` / `Symbol.toPrimitive`（可能自身抛错），
 *    `JSON.stringify` 遇循环引用必抛。取诊断失败一律返回 `undefined`，由调用方决定兜底词。
 *    调用点多在 `finally` 的槽位收口路径上——**绝不能让「记录异常」本身变成新异常**
 *    （那会毁掉收口、把一次失败升级成槽位永久卡死）。
 *
 * 空值（`null` / `undefined` / 空串）与「取不出信息」都归 `undefined`，与空串区分不开是
 * 刻意的：调用方的兜底词（`'unknown error'` 之类）要能覆盖这两种情况。
 */
export function messageOf(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined
  if (err instanceof Error && typeof err.message === 'string') return err.message
  try {
    const s = String(err)
    // `'[object Object]'` 是「有对象、零信息」的哨兵值——落到下面走 JSON 一搏
    if (s !== '[object Object]') return s.length > 0 ? s : undefined
  } catch {
    // `String()` 自身抛（原型链无 toString / toString 实现抛错）⇒ 仍给 JSON 一次机会
  }
  try {
    const json = JSON.stringify(err)
    // `'{}'` 与 `undefined`（function / Symbol 等）同样是零信息，一并归 undefined
    return typeof json === 'string' && json.length > 0 && json !== '{}' ? json : undefined
  } catch {
    return undefined // 循环引用等——取诊断失败，不抛
  }
}

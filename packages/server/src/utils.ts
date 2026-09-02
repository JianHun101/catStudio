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

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

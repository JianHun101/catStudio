/**
 * 记忆引用的**展示态构造**（M1）。
 *
 * 为什么单独一个纯函数模块、而不是写在 ChatPanel 的 `messageViews` 里：
 * `MessageItem` 的 O(1) 重渲染契约要求「父组件算完、以标量/稳定引用传入」——
 * 现算一次很便宜，但**每次重渲染都新建对象**就等于白拆（子组件 props 引用抖动，
 * 整棵子树照旧重渲）。故构造逻辑独立可测，父组件只负责按 messageId 做引用缓存。
 *
 * ⚠️ 文案口径（票面 §三）：`bodyHead` 是**命中片**全文，注入进 prompt 的是补齐后的
 * **整节**。抽屉与标签都不得声称「猫当时读到的就是这段」。
 */
import type { MemoryRef, MemoryRefsEntry, MemoryRefState } from '@/composables/useApi'

/** 单个可点条目（label/title 都已格式化——模板里不再做字符串加工） */
export interface MemoryRefItemView {
  /** 展示标签 */
  label: string
  /** 悬停说明：完整 breadcrumb（缺失回退 docPath + 节锚） */
  title: string
  /** 点开抽屉要用的原始数据 */
  ref: MemoryRef
}

/** 一条回复的记忆行展示态（`state` 三态可直接 v-if 分支） */
export interface MemoryRefView {
  state: MemoryRefState
  /** 仅 `injected` 非空 */
  items: MemoryRefItemView[]
}

/** 文件名（去目录、去 `.md`）；路径异常时原样回退 */
export function docBaseName(docPath: string): string {
  const last = docPath.split('/').pop() ?? docPath
  return last.replace(/\.md$/i, '') || docPath
}

/** 节锚去掉前导 `#` 与空白（`## 决策` → `决策`） */
export function sectionTitle(sectionAnchor: string): string {
  return sectionAnchor.replace(/^#+\s*/, '').trim() || sectionAnchor
}

/**
 * 条目 → 展示视图。`null` = 该消息不该渲染记忆行（用户/系统消息，或尚未拉到数据）。
 *
 * **同文档多节要消歧**：一条回复可能注入了同一文档的两节，只显示文件名会出现两个
 * 一模一样的链接、点开内容不同——读的人无从分辨。判据是「本列表内该文件名出现 >1 次」，
 * 与全局无关（只有一次出现时加节名是噪音）。
 */
export function buildMemoryRefView(
  entry: MemoryRefsEntry | null | undefined
): MemoryRefView | null {
  if (!entry) return null
  const refs = entry.refs ?? []
  const nameCount = new Map<string, number>()
  for (const r of refs) {
    const n = docBaseName(r.docPath)
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1)
  }
  return {
    state: entry.state,
    items: refs.map((r) => {
      const base = docBaseName(r.docPath)
      const dup = (nameCount.get(base) ?? 0) > 1
      return {
        label: dup ? `${base} · ${sectionTitle(r.sectionAnchor)}` : base,
        title: r.breadcrumb ?? `${r.docPath} > ${sectionTitle(r.sectionAnchor)}`,
        ref: r,
      }
    }),
  }
}

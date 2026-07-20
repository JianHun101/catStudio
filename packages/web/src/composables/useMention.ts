import { ref, computed } from 'vue'
import type { AgentConfig } from '@cat-study/shared'

/**
 * @mention 自动补全逻辑。
 * 用法：在 textarea 的 @input 事件中调用 detect()，模板中渲染 suggestion 列表。
 */
export function useMention(agents: () => AgentConfig[]) {
  const mentionActive = ref(false)
  const mentionQuery = ref('')
  const mentionStartIdx = ref(-1) // @ 在 text 中的位置（用于替换）

  const mentionSuggestions = computed(() => {
    if (!mentionActive.value) return []
    const q = mentionQuery.value.toLowerCase()
    const list = agents()
    if (!q) return list
    // Spread to code points avoids the surrogate pair bug where a lone
    // high surrogate (\uD83D) matches all emoji in the same Unicode block.
    const qChars = [...q]
    return list.filter((a) => {
      if (a.name.toLowerCase().includes(q)) return true
      if (qChars.length === 0) return false
      const aChars = [...a.avatar]
      return qChars.every((qc) => aChars.some((ac) => ac === qc))
    })
  })

  const mentionIndex = ref(0) // keyboard nav

  /** 每次输入时调用 */
  function detect(text: string, cursorPos: number): void {
    // 向前找最近的 @
    let atIdx = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (text[i] === '@') {
        // @ 前面必须是空格或开头
        if (i === 0 || /\s/.test(text[i - 1])) {
          atIdx = i
        }
        break
      }
      // @ 查询中不能有空格
      if (/\s/.test(text[i])) break
    }

    if (atIdx >= 0) {
      mentionActive.value = true
      mentionStartIdx.value = atIdx
      mentionQuery.value = text.slice(atIdx + 1, cursorPos)
      mentionIndex.value = 0
    } else {
      mentionActive.value = false
      mentionStartIdx.value = -1
      mentionQuery.value = ''
    }
  }

  /** 选中一个 Agent，返回替换后的完整文本 */
  function select(agent: AgentConfig, currentText: string, cursorPos: number): string {
    const before = currentText.slice(0, mentionStartIdx.value)
    const after = currentText.slice(cursorPos)
    const mention = `@${agent.name} `
    mentionActive.value = false
    return before + mention + after
  }

  /** 关闭建议列表 */
  function close(): void {
    mentionActive.value = false
  }

  /** 键盘导航：ArrowDown / ArrowUp / Enter / Escape */
  function navigate(key: string, currentText: string, cursorPos: number): string | null {
    if (!mentionActive.value) return null

    if (key === 'ArrowDown') {
      mentionIndex.value = Math.min(mentionIndex.value + 1, mentionSuggestions.value.length - 1)
      return null
    }
    if (key === 'ArrowUp') {
      mentionIndex.value = Math.max(mentionIndex.value - 1, 0)
      return null
    }
    if (key === 'Enter' || key === 'Tab') {
      const agent = mentionSuggestions.value[mentionIndex.value]
      if (agent) {
        return select(agent, currentText, cursorPos)
      }
    }
    if (key === 'Escape') {
      close()
      return null
    }
    return null
  }

  return {
    mentionActive,
    mentionQuery,
    mentionSuggestions,
    mentionIndex,
    mentionStartIdx,
    detect,
    select,
    close,
    navigate,
  }
}

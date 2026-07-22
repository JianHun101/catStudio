import { ref, computed } from 'vue'

export interface SkillSuggestion {
  name: string
  description: string
  triggers: string[]
}

/**
 * /skill 命令自动补全逻辑。
 * 用法：在 textarea 的 @input 事件中调用 detect()，模板中渲染 suggestion 列表。
 *
 * 触发条件：空格（或行首）后输入 /，弹出可用技能列表。
 * 选中后替换 /query 为 /skillName ，用户可继续输入附加文本。
 */
export function useSkillCommand(skills: () => SkillSuggestion[]) {
  const skillActive = ref(false)
  const skillQuery = ref('')
  const skillStartIdx = ref(-1) // / 在 text 中的位置（用于替换）

  const skillSuggestions = computed(() => {
    if (!skillActive.value) return []
    const q = skillQuery.value.toLowerCase()
    const list = skills()
    if (!q) return list
    return list.filter((s) => s.name.toLowerCase().includes(q))
  })

  const skillIndex = ref(0)

  /** 每次输入时调用 */
  function detect(text: string, cursorPos: number): void {
    // 向前找最近的 /
    let slashIdx = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (text[i] === '/') {
        // / 前面必须是空格或开头
        if (i === 0 || /\s/.test(text[i - 1])) {
          slashIdx = i
        }
        break
      }
      // / 查询中不能有空格
      if (/\s/.test(text[i])) break
    }

    if (slashIdx >= 0) {
      skillActive.value = true
      skillStartIdx.value = slashIdx
      skillQuery.value = text.slice(slashIdx + 1, cursorPos)
      skillIndex.value = 0
    } else {
      skillActive.value = false
      skillStartIdx.value = -1
      skillQuery.value = ''
    }
  }

  /** 选中一个技能，返回替换后的完整文本 */
  function select(skill: SkillSuggestion, currentText: string, cursorPos: number): string {
    const before = currentText.slice(0, skillStartIdx.value)
    const after = currentText.slice(cursorPos)
    const cmd = `/${skill.name} `
    skillActive.value = false
    return before + cmd + after
  }

  /** 关闭建议列表 */
  function close(): void {
    skillActive.value = false
  }

  /** 键盘导航 */
  function navigate(key: string, currentText: string, cursorPos: number): string | null {
    if (!skillActive.value) return null

    if (key === 'ArrowDown') {
      skillIndex.value = Math.min(skillIndex.value + 1, skillSuggestions.value.length - 1)
      return null
    }
    if (key === 'ArrowUp') {
      skillIndex.value = Math.max(skillIndex.value - 1, 0)
      return null
    }
    if (key === 'Enter' || key === 'Tab') {
      const skill = skillSuggestions.value[skillIndex.value]
      if (skill) {
        return select(skill, currentText, cursorPos)
      }
    }
    if (key === 'Escape') {
      close()
      return null
    }
    return null
  }

  return {
    skillActive,
    skillQuery,
    skillSuggestions,
    skillIndex,
    skillStartIdx,
    detect,
    select,
    close,
    navigate,
  }
}

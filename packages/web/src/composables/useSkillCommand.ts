import { computed, ref } from 'vue'
import { api } from './useApi'
import type { SkillEntry } from './useApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('useSkillCommand')

/**
 * 斜杠命令补全逻辑（数据源 `GET /api/skills`）。
 *
 * **补全只是输入辅助，不是执行通道**：skill 由 CLI 原生消费——`/xxx` 消息原样透传，
 * CLI 侧斜杠触发或模型自主调用，服务端不做任何注入。故下拉的职责边界是「把名字写对」，
 * 写完（`/name `）用户照样按 Enter 走 `handleSend`。
 *
 * **Enter 直通是硬契约**（`07af101` 的教训）：那个版本在 keydown 里无条件
 * `preventDefault()` 再判断有无候选项，下拉恒空时把斜杠消息的 Enter 一并吞掉，消息
 * 根本发不出去。本模块的对策是把「有无候选项」交给调用方判（`skillSuggestions.length`），
 * `navigate` 对 Enter/Tab 在无候选项时**返回 null 且不产生任何副作用**——调用方据此
 * 不 preventDefault，事件自然落到发送分支。
 *
 * 与 @mention 的关系：两者共用同一套「向前找触发符 + 查询串 + 上下键 + Tab/Enter 补全 +
 * ESC 关闭」形态（见 useMention），但触发符、数据源与候选项完全不同，故各自成组；
 * 二者靠「查询串不含空白」的扫法天然互斥（`@a /b` 里向前扫会先撞到空白）。
 */
export function useSkillCommand() {
  const skillActive = ref(false)
  const skillQuery = ref('')
  const skillStartIdx = ref(-1) // `/` 在 text 中的位置（用于替换）
  const skillIndex = ref(0) // keyboard nav

  const skills = ref<SkillEntry[]>([])
  /** 清单是否已成功取到——用来区分两种空态：清单没有（端点不可用，留 CLI 原生提示）
   *  与 查询无匹配（清单在手，明确告诉用户没这个词）。二者混为一谈正是旧版空壳的病根。 */
  const skillsLoaded = ref(false)
  let loading = false

  const skillSuggestions = computed(() => {
    if (!skillActive.value) return []
    const q = skillQuery.value.toLowerCase()
    if (!q) return skills.value
    return skills.value.filter((s) => s.name.toLowerCase().includes(q))
  })

  /**
   * 取清单（首次触发时懒加载，成功后不再取）。
   * 失败**不阻塞输入**：`skillsLoaded` 保持 false，下拉不出现、提示文案兜底；
   * 下次触发重试一次（`loading` 复位），不把一次网络抖动退化成整个会话的永久降级。
   */
  function ensureSkills(): void {
    if (skillsLoaded.value || loading) return
    loading = true
    api
      .getSkills()
      .then((res) => {
        skills.value = res.skills ?? []
        skillsLoaded.value = true
      })
      .catch((err) => {
        log.warn('技能清单拉取失败，斜杠补全降级为提示文案', { error: String(err) })
      })
      .finally(() => {
        loading = false
      })
  }

  /** 每次输入时调用：向前找最近的 /，/ 前必须是行首或空白才激活 */
  function detect(text: string, cursorPos: number): void {
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

    skillActive.value = slashIdx >= 0
    if (slashIdx >= 0) {
      skillStartIdx.value = slashIdx
      skillQuery.value = text.slice(slashIdx + 1, cursorPos)
      skillIndex.value = 0
      ensureSkills()
    } else {
      skillStartIdx.value = -1
      skillQuery.value = ''
    }
  }

  /** 选中一个技能，返回替换后的完整文本（补成 `/name `，尾部留空格便于接着打参数） */
  function select(skill: SkillEntry, currentText: string, cursorPos: number): string {
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

  /** 键盘导航：ArrowDown / ArrowUp / Enter / Tab / Escape。
   *  无候选项时 Enter/Tab 返回 null 且无副作用 —— 调用方据此放行事件（见文件头注释）。 */
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
    skillsLoaded,
    detect,
    select,
    close,
    navigate,
  }
}

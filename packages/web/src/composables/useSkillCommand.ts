import { ref } from 'vue'

/**
 * 斜杠命令提示逻辑（SkillLoader 拆除后仅剩提示用途）。
 * skill 由 CLI 原生消费：用户输入 /xxx 的消息原样透传，CLI 原生触发
 * （斜杠触发或模型自主调用），服务端不再注入 skill 内容。
 * 前端不再提供补全（服务端无技能清单数据源），只在检测到
 * 行首（或空白后）的 / 命令时展示提示文案。
 */
export function useSkillCommand() {
  const skillActive = ref(false)

  /** 每次输入时调用：向前找最近的 /，/ 前必须是行首或空白才激活 */
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

    skillActive.value = slashIdx >= 0
  }

  return { skillActive, detect }
}

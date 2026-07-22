import { nextTick, type Directive } from 'vue'

/**
 * v-focus 指令：元素挂载时自动聚焦，hidden 属性移除时也触发聚焦。
 *
 * 使用场景：
 * - 弹窗打开时（v-if 渲染）自动聚焦第一个输入框
 * - 条件区域展开时（hidden 属性取消）自动聚焦输入框
 *
 * 用法：<input v-focus />
 */
export const vFocus: Directive<HTMLElement> = {
  mounted(el: HTMLElement) {
    // 记录初始 hidden 状态，避免刚挂载时 hidden 的元素被聚焦
    const initiallyHidden = el.hasAttribute('hidden')

    // 挂载时聚焦（处理 v-if 渲染场景）
    if (!initiallyHidden) {
      nextTick(() => {
        el.focus()
      })
    }

    // MutationObserver 监听 hidden 属性移除
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'hidden') {
          if (!el.hasAttribute('hidden')) {
            nextTick(() => {
              el.focus()
            })
          }
        }
      }
    })

    observer.observe(el, { attributes: true, attributeFilter: ['hidden'] })

    // 将 observer 存到元素上，供 unmounted 清理
    ;(el as any).__vFocusObserver = observer
  },

  unmounted(el: HTMLElement) {
    const observer = (el as any).__vFocusObserver as MutationObserver | undefined
    observer?.disconnect()
    delete (el as any).__vFocusObserver
  },
}

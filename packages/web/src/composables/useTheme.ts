import { ref, computed } from 'vue'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'catstudy-theme'

/**
 * 生效主题 = 存储值 → 默认值。
 * 默认取 `'light'`：改的只是**无存储时的兜底字面量**，不是覆盖用户选择——
 * 存过 `'dark'` 的用户仍走上面的早返回、继续进深色（优先级未动）。
 * `index.html` 的 `<html data-theme="light">` 预置只负责消首屏 FOUC，
 * 收口同样落在这里：dark 走 applyTheme() 的 `delete dataset.theme` 回落 `:root` 深色。
 */
function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // localStorage 不可用（隐私模式等），忽略
  }
  return 'light'
}

function applyTheme(t: Theme): void {
  if (t === 'light') {
    document.documentElement.dataset.theme = 'light'
  } else {
    delete document.documentElement.dataset.theme
  }

  // 同步更新浏览器 UI 主题色
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', t === 'light' ? '#f8f4ed' : '#1b1815')
  }
}

function persistTheme(t: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, t)
  } catch {
    // 静默忽略
  }
}

// 全局单例状态
const theme = ref<Theme>(readStoredTheme())

// 应用侧需要显式调用 init() 来挂载 DOM 副作用
let initialized = false

export function useTheme() {
  if (!initialized) {
    applyTheme(theme.value)
    initialized = true
  }

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    applyTheme(theme.value)
    persistTheme(theme.value)
  }

  const isDark = computed(() => theme.value === 'dark')
  const isLight = computed(() => theme.value === 'light')

  return { theme, isDark, isLight, toggle }
}

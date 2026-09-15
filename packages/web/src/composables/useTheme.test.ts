import { describe, it, expect, beforeEach, vi } from 'vitest'
import htmlSource from '../../index.html?raw'

const STORAGE_KEY = 'catstudy-theme'
const THEME_COLOR_LIGHT = '#f8f4ed'
const THEME_COLOR_DARK = '#1b1815'

// index.html 静态源断言一律用**单行** toContain：本仓工作区是 CRLF
// （`core.autocrlf=true`，无 `.gitattributes`），跨行字面量在 CRLF 下会假红。

/**
 * useTheme 是模块级单例（`theme` ref + `initialized` 标志），模块只求值一次。
 * 每条用例 resetModules 后重新 import —— 否则第二条用例会读到上一条留下的主题。
 */
async function loadUseTheme() {
  vi.resetModules()
  return await import('./useTheme')
}

function currentThemeColor(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  // 与 index.html 首屏一致：预置浅色底（A3 消 FOUC 的那份）
  document.head.innerHTML = `<meta name="theme-color" content="${THEME_COLOR_LIGHT}" />`
})

describe('useTheme 默认主题（无存储 ⇒ 浅色）', () => {
  it('A1：localStorage 空 ⇒ 默认浅色', async () => {
    const { useTheme } = await loadUseTheme()
    expect(useTheme().theme.value).toBe('light')
  })

  it('A2 红线：存过 dark 的用户仍进深色（改的是默认值，不是覆盖用户选择）', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    const { useTheme } = await loadUseTheme()
    expect(useTheme().theme.value).toBe('dark')
  })

  it('存过 light ⇒ 浅色', async () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    const { useTheme } = await loadUseTheme()
    expect(useTheme().theme.value).toBe('light')
  })

  it('存量是非法值时回落默认浅色（不把脏值当主题）', async () => {
    localStorage.setItem(STORAGE_KEY, 'blue')
    const { useTheme } = await loadUseTheme()
    expect(useTheme().theme.value).toBe('light')
  })
})

describe('useTheme DOM 副作用', () => {
  it('A1：首次调用把浅色写进 dataset.theme + theme-color', async () => {
    const { useTheme } = await loadUseTheme()
    useTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(currentThemeColor()).toBe(THEME_COLOR_LIGHT)
  })

  it('A2：深色时 dataset.theme 为空（回落 :root 深色）+ theme-color 深色', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    const { useTheme } = await loadUseTheme()
    useTheme()
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(currentThemeColor()).toBe(THEME_COLOR_DARK)
  })

  it('toggle 深浅互换，并落 localStorage', async () => {
    const { useTheme } = await loadUseTheme()
    const { theme, toggle } = useTheme()

    toggle()
    expect(theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(currentThemeColor()).toBe(THEME_COLOR_DARK)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')

    toggle()
    expect(theme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(currentThemeColor()).toBe(THEME_COLOR_LIGHT)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })
})

describe('index.html 首屏（A3 消 FOUC）', () => {
  it('html 预置 data-theme="light"（JS 执行前 :root 是深色，不预置会闪深）', () => {
    expect(htmlSource).toContain('<html lang="zh-CN" data-theme="light">')
  })

  it('theme-color 预置浅色底，与 applyTheme 的浅色分支同值', () => {
    expect(htmlSource).toContain(`<meta name="theme-color" content="${THEME_COLOR_LIGHT}" />`)
  })

  it("特异度不变量：`[data-theme='light']` 块必须在 `:root` 之后（同特异度，只靠源码顺序）", () => {
    const rootAt = htmlSource.indexOf(':root {')
    const lightAt = htmlSource.indexOf("[data-theme='light'] {")
    expect(rootAt).toBeGreaterThan(-1)
    expect(lightAt).toBeGreaterThan(-1)
    expect(lightAt).toBeGreaterThan(rootAt)
  })
})

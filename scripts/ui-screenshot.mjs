/**
 * Playwright 自动截取前端输入框区域（配合 ui-review.ts 视觉评审闭环）。
 *
 * 用法：
 *   node scripts/ui-screenshot.mjs [--full] [url]
 *
 *   --full   额外截一张整页全图（默认只截输入框区域 + textarea 特写）
 *   url      默认 http://127.0.0.1:5173
 *
 * 输出：scripts/shots/ 下两张图，打印路径供人查看（需要视觉评审时，
 *       手动把路径传给 ui-review.ts——该脚本接受任意图片路径）。
 * 依赖：playwright（已批准安装）+ 本机 dev 服务器（:5173）。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const shotDir = path.join(root, 'scripts', 'shots')
mkdirSync(shotDir, { recursive: true })

const args = process.argv.slice(2)
const wantFull = args.includes('--full')
const url = args.filter((a) => a.startsWith('http'))[0] || 'http://127.0.0.1:5173'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(url, { waitUntil: 'networkidle' })

  // 等输入框区域出现
  await page.waitForSelector('.chat-input-area', { timeout: 15000 })

  // 若未选会话（textarea disabled），点第一个会话激活输入框，截到真实可用状态
  const disabled = await page
    .locator('.chat-input')
    .isDisabled()
    .catch(() => false)
  if (disabled) {
    const firstSession = page.locator('.session-item, .session-list li, .session-entry').first()
    if ((await firstSession.count()) > 0) {
      await firstSession.click()
      await page.waitForTimeout(600)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const areaShot = path.join(shotDir, `input-area-${stamp}.png`)
  const inputShot = path.join(shotDir, `input-${stamp}.png`)

  // 输入框区域整体（含图片按钮/发送按钮）
  await page.locator('.chat-input-area').screenshot({ path: areaShot })
  // textarea 特写
  await page.locator('.chat-input').screenshot({ path: inputShot })

  if (wantFull) {
    const fullShot = path.join(shotDir, `full-${stamp}.png`)
    await page.screenshot({ path: fullShot, fullPage: true })
    console.log(fullShot)
  }
  console.log(areaShot)
  console.log(inputShot)
} finally {
  await browser.close()
}

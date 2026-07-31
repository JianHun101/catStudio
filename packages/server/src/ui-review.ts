/**
 * UI 视觉评审脚本（零新依赖：sharp 已在 server 依赖中，截图用 Windows 自带 Edge）。
 *
 * 用法：
 *   npx tsx packages/server/src/ui-review.ts <图片路径> ["评审指令"]   # 评审已有图片
 *   npx tsx packages/server/src/ui-review.ts --shot [url] ["评审指令"] # Edge 无头自动截图后评审
 *
 * 流程：截图（可选）→ sharp 压缩（最长边 1280, JPEG q80）→ base64 →
 *       Ollama /api/chat 原生 images 字段 → 打印模型评审意见。
 *
 * 环境变量：
 *   OLLAMA_MODELS_HOST  默认 http://127.0.0.1:11434（勿用 localhost，Windows IPv6 歧义）
 *   OLLAMA_MODEL        默认 qwen3.5:9b
 */
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const args = process.argv.slice(2)
const isShotMode = args[0] === '--shot'
const imagePath = isShotMode ? null : args[0]
const instruction = isShotMode ? args[2] : args[1]
const shotUrl = isShotMode ? args[1] || 'http://127.0.0.1:5173' : null

if (!isShotMode && !imagePath) {
  console.error(
    '用法: npx tsx packages/server/src/ui-review.ts <图片路径> ["评审指令"]\n' +
      '  或: npx tsx packages/server/src/ui-review.ts --shot [url] ["评审指令"]'
  )
  process.exit(1)
}

const baseUrl = process.env.OLLAMA_MODELS_HOST || 'http://127.0.0.1:11434'
const model = process.env.OLLAMA_MODEL || 'qwen3.5:9b'

const prompt =
  instruction ||
  '请评审这张前端 UI 截图中的输入框区域：样式是否突兀、与整体风格是否协调、' +
    '有哪些具体可改进的点（配色/圆角/边框/间距/提示文字等）。请给出简洁、可执行的修改建议。'

// ─── 截图（--shot 模式） ──────────────────────────────

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const shotsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ui-shots')

function findEdge(): string | null {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null
}

/** Edge 无头截图（Vue SPA 用 virtual-time-budget 等 JS 渲染完成） */
function captureScreenshot(url: string, outPath: string): void {
  const edge = findEdge()
  if (!edge) throw new Error('未找到 Edge 浏览器（Windows 自带，路径在 Program Files）')
  const result = spawnSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${outPath}`,
      '--window-size=1440,900',
      '--virtual-time-budget=8000',
      url,
    ],
    { encoding: 'utf-8', timeout: 60_000 }
  )
  if (result.status !== 0 && !existsSync(outPath)) {
    throw new Error(`Edge 截图失败 (exit ${result.status})`)
  }
}

async function main(): Promise<void> {
  let resolvedImagePath = imagePath

  if (isShotMode) {
    mkdirSync(shotsDir, { recursive: true })
    resolvedImagePath = path.join(shotsDir, `shot-${Date.now()}.png`)
    console.log(`[ui-review] 正在用 Edge 无头截图 ${shotUrl} …`)
    captureScreenshot(shotUrl!, resolvedImagePath)
    console.log(`[ui-review] 截图完成: ${resolvedImagePath}`)
  }

  // 1. 读图 + sharp 压缩（截图像素大，先降体积再传，减少首 token 延迟）
  const input = await readFile(resolvedImagePath!)
  const optimized = await sharp(input)
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  const base64 = optimized.toString('base64')
  console.log(
    `[ui-review] 图片 ${(input.length / 1024) | 0}KB → ${(optimized.length / 1024).toFixed(1)}KB (${optimized.length} bytes base64)`
  )

  // 2. 调 Ollama 原生 /api/chat，images 字段传 base64（预演验证过的格式）
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [base64],
      },
    ],
    stream: false,
    options: { temperature: 0.3 },
  }

  const start = Date.now()
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Ollama API error ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as { message?: { content?: string } }
  const seconds = ((Date.now() - start) / 1000).toFixed(1)

  console.log(`[ui-review] 模型 ${model} 耗时 ${seconds}s\n`)
  console.log(data.message?.content ?? '（无输出）')
}

main().catch((err) => {
  console.error(`[ui-review] 失败: ${err.message}`)
  process.exit(1)
})

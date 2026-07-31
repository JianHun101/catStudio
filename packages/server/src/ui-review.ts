/**
 * UI 视觉评审脚本（零新依赖：sharp 已在 server 依赖中）。
 *
 * 用法：
 *   npx tsx packages/server/src/ui-review.ts <图片路径> ["评审指令"]
 *
 * 流程：sharp 压缩截图（最长边 1280, JPEG q80）→ base64 →
 *       Ollama /api/chat 原生 images 字段 → 打印模型评审意见。
 *
 * 环境变量：
 *   OLLAMA_MODELS_HOST  默认 http://127.0.0.1:11434（勿用 localhost，Windows IPv6 歧义）
 *   OLLAMA_MODEL        默认 qwen3.5:9b
 */
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'

const [, , imagePath, instruction] = process.argv

if (!imagePath) {
  console.error('用法: npx tsx packages/server/src/ui-review.ts <图片路径> ["评审指令"]')
  process.exit(1)
}

const baseUrl = process.env.OLLAMA_MODELS_HOST || 'http://127.0.0.1:11434'
const model = process.env.OLLAMA_MODEL || 'qwen3.5:9b'

const prompt =
  instruction ||
  '请评审这张前端 UI 截图中的输入框区域：样式是否突兀、与整体风格是否协调、' +
    '有哪些具体可改进的点（配色/圆角/边框/间距/提示文字等）。请给出简洁、可执行的修改建议。'

async function main(): Promise<void> {
  // 1. 读图 + sharp 压缩（截图像素大，先降体积再传，减少首 token 延迟）
  const input = await readFile(imagePath)
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

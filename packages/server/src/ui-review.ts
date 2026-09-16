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
 *
 * 自动拉起：探测 /api/tags 不可达且 baseUrl 为本地（127.0.0.1:11434）时，
 *   后台 spawn `ollama serve`（detached + unref，脚本退出不杀它），每 500ms 轮询
 *   最长 15s；非本地地址不自动拉起（远程宿主是别人的服务）；拉起失败清晰报错
 *   exit 1 不挂死。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { messageOf } from './utils.js'

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

// ─── Ollama 就绪保障（未启动则自动拉起） ────────────────────

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const OLLAMA_MODELS_DIR = 'D:\\Tools\\ollama\\models'

/** baseUrl 是否为本地地址——仅本地可自动拉起（远程宿主是别人的服务，不擅自启停） */
function isLocalBaseUrl(url: string): boolean {
  return url.replace(/\/+$/, '') === OLLAMA_DEFAULT_BASE_URL
}

/** 探测 Ollama /api/tags 是否就绪（1.5s 超时，失败即视为不可达） */
async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** 拉起时 env：OLLAMA_MODELS 优先已设值，其次本机模型目录（存在才用），缺省不设走 ollama 默认 */
function buildOllamaEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (!env.OLLAMA_MODELS && existsSync(OLLAMA_MODELS_DIR)) {
    env.OLLAMA_MODELS = OLLAMA_MODELS_DIR
  }
  return env
}

/** 后台拉起 ollama serve（detached + unref：进程存活，本脚本退出不影响它） */
function startOllama(): void {
  console.log('[ui-review] Ollama 未就绪，尝试自动拉起（ollama serve）…')
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: buildOllamaEnv(),
  })
  child.on('error', (err) => {
    console.error(
      `[ui-review] 拉起 Ollama 失败: ${err.message}\n  请手动启动（ollama serve）后重试`
    )
    process.exit(1)
  })
  child.unref()
}

/** 调用前确保 Ollama 就绪：探测 → 本地拉起 → 每 500ms 轮询最长 15s；失败清晰退出不挂死 */
async function ensureOllamaReady(): Promise<void> {
  if (await probeOllama()) return
  if (!isLocalBaseUrl(baseUrl)) {
    console.error(
      `[ui-review] Ollama 不可达（${baseUrl}）且非本地地址——不自动拉起，请确认远程服务已启动`
    )
    process.exit(1)
  }
  startOllama()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await sleep(500)
    if (await probeOllama()) {
      console.log('[ui-review] Ollama 已就绪')
      return
    }
  }
  console.error('[ui-review] 拉起 Ollama 超时（15s），请手动启动（ollama serve）后重试')
  process.exit(1)
}

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
  // 0. 先确保 Ollama 就绪（fail fast：不可达先拉起，趁截图/压缩的功夫后台启动）
  await ensureOllamaReady()

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
  console.error(`[ui-review] 失败: ${messageOf(err) ?? '未知错误'}`)
  process.exit(1)
})

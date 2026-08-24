import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'

interface OllamaConfig {
  model: string
  baseUrl?: string
}

/**
 * Ollama 本地模型适配器。
 * 使用原生 /api/chat 端点（stream: true 时每行一个 JSON，无 `data:` 前缀，
 * 与 OpenAI 兼容的 SSE 格式不同——这是和 deepseek.ts 解析逻辑的关键差异）。
 *
 * 视觉支持：LLMMessage.images（base64 dataURL 数组，如 data:image/png;base64,...）
 * 会在发送前剥掉 `;base64,` 前缀再透传给 /api/chat 的 images 字段
 * （qwen3.5:9b 等多模态模型可用）——Ollama 要求裸 base64，带前缀会报
 * "illegal base64 data" 400。无 images 时按纯文本发送。
 */
const toOllamaImage = (img: string): string => {
  const marker = ';base64,'
  const idx = img.indexOf(marker)
  return idx >= 0 ? img.slice(idx + marker.length) : img
}

// ─── Ollama 自动拉起（参照 ui-review.ts 探测+拉起模式；行为差异：失败静默降级不退出） ──

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const OLLAMA_MODELS_DIR = 'D:\\Tools\\ollama\\models'
const OLLAMA_PROBE_TIMEOUT_MS = 1500
const OLLAMA_PROBE_INTERVAL_MS = 500
const OLLAMA_START_WAIT_MS = 10_000

/** baseUrl 是否为本地默认地址——仅本地可自动拉起（远程宿主是别人的服务，不擅自启停） */
function isLocalBaseUrl(url: string): boolean {
  return url.replace(/\/+$/, '') === OLLAMA_DEFAULT_BASE_URL
}

/** 探测 Ollama /api/tags 是否就绪（1.5s 超时，失败即视为不可达） */
async function probeOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    })
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

/** 后台拉起 ollama serve（detached + unref：进程存活，适配器不阻塞；原生 exe 直启，无 shell: true） */
function startOllama(onError: () => void): void {
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: buildOllamaEnv(),
  })
  spawnedChild = child
  child.on('error', onError)
  child.unref()
}

/** 只保存自己 spawn 的 ollama serve（probe 发现已有实例则不 spawn，保持 null → 不误杀） */
let spawnedChild: ChildProcess | null = null

/** 清理自己 spawn 的 ollama serve（server shutdown 时调用）。未 spawn 过 / 已清理 → no-op */
export function stopOllamaIfSpawned(): void {
  spawnedChild?.kill()
  spawnedChild = null
}

/** 测试专用：重置模块级句柄（并发/隔离用例间不留残留，镜像 dispatch 的 __test_reset 惯例） */
export function __test_reset(): void {
  spawnedChild = null
}

/** 并发去重锁：同一窗口内多个 agent 同时触发时不重复 spawn */
let ensurePromise: Promise<boolean> | null = null

/**
 * fetch 失败后的自动拉起保障：探测确认不可达 → 后台拉起 → 每 500ms 轮询最多 10s。
 * 探测通过（已有实例在跑）→ 直接 true（幂等，不重复 spawn）；命令不存在/拉起失败/超时
 * → false（调用方抛回原 fetch 错误，静默降级不引入新错误类型）。
 */
async function ensureOllamaStarted(baseUrl: string): Promise<boolean> {
  if (!isLocalBaseUrl(baseUrl)) return false
  if (ensurePromise) return ensurePromise
  ensurePromise = (async (): Promise<boolean> => {
    if (await probeOllama(baseUrl)) return true
    let spawnFailed = false
    startOllama(() => {
      spawnFailed = true
    })
    const deadline = Date.now() + OLLAMA_START_WAIT_MS
    while (Date.now() < deadline && !spawnFailed) {
      await sleep(OLLAMA_PROBE_INTERVAL_MS)
      if (spawnFailed) return false
      if (await probeOllama(baseUrl)) return true
    }
    return false
  })().finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}
export class OllamaAdapter implements LLMAdapter {
  readonly provider = 'ollama'
  private model: string
  private baseUrl: string

  constructor(config: OllamaConfig) {
    this.model = config.model
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:11434'
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const externalSignal = options.signal

    if (externalSignal?.aborted) {
      yield { content: '', done: true }
      return
    }

    const chatMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      // 视觉图片：剥掉 dataURL 前缀（Ollama 只要裸 base64），多模态模型
      // （qwen3.5:9b 等）识别，纯文本模型忽略此字段
      ...(m.images && m.images.length > 0 ? { images: m.images.map(toOllamaImage) } : {}),
    }))

    const body: any = {
      model: options.model || this.model,
      messages: chatMessages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens || 2048,
      },
    }

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs || 300_000 // 5 分钟，兼容推理模型思考时间

    // 外部信号：转发 abort 事件到内部 controller
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort)

    /** AbortError → 友好语义（外部取消 vs 内部超时） */
    const toFriendlyAbortError = (): Error => {
      if (externalSignal?.aborted) {
        return new Error('请求被取消')
      }
      return new Error(`Ollama API 请求超时 (${timeoutMs / 1000}s)`)
    }

    /** 发起 /api/chat 请求（超时 timer 由 finally 兜底清理） */
    const requestChat = async (): Promise<Response> => {
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    }

    let response: Response
    try {
      response = await requestChat()
    } catch (err: any) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      if (err.name === 'AbortError') {
        throw toFriendlyAbortError()
      }
      // 连接层失败（服务未启动）→ 自动拉起 Ollama 后重试一次；拉起失败/非本地地址 → 抛回原错误
      if (await ensureOllamaStarted(this.baseUrl)) {
        externalSignal?.addEventListener('abort', onExternalAbort)
        try {
          response = await requestChat()
        } catch (err2: any) {
          // 重试也失败 → 移除监听器后抛错；重试成功则监听器保留到流式阶段结束
          // （与正常路径一致：流式期间外部 abort 立即转发到 controller，不等 30s chunkTimer）
          externalSignal?.removeEventListener('abort', onExternalAbort)
          if (err2.name === 'AbortError') {
            throw toFriendlyAbortError()
          }
          throw err2
        }
      } else {
        throw err
      }
    }

    if (!response.ok) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      const err = await response.text()
      throw new Error(`Ollama API error ${response.status}: ${err}`)
    }

    // 流读取超时：每个 chunk 之间最长等 30 秒
    const streamTimeoutMs = 30_000
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (externalSignal?.aborted) {
        externalSignal?.removeEventListener('abort', onExternalAbort)
        yield { content: '', done: true }
        return
      }

      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        const chunkTimer = setTimeout(() => controller.abort(), streamTimeoutMs)
        readResult = await reader.read()
        clearTimeout(chunkTimer)
      } catch (err: any) {
        externalSignal?.removeEventListener('abort', onExternalAbort)
        if (err.name === 'AbortError') {
          if (externalSignal?.aborted) {
            yield { content: '', done: true }
            return
          }
          throw new Error('Ollama API 流读取超时')
        }
        throw err
      }

      const { done, value } = readResult
      if (done) break

      // Ollama NDJSON 流：每行一个完整 JSON 对象，无 `data:` 前缀
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = JSON.parse(trimmed)
          const content = parsed.message?.content
          if (content) {
            yield { content, done: false }
          }
          if (parsed.done) {
            externalSignal?.removeEventListener('abort', onExternalAbort)
            yield { content: '', done: true }
            return
          }
        } catch {
          // skip unparseable
        }
      }
    }

    externalSignal?.removeEventListener('abort', onExternalAbort)
    yield { content: '', done: true }
  }
}

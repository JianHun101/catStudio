import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createLogger } from '../logger.js'

/**
 * llama-server（llama.cpp）按需自启动模块。
 *
 * 镜像 ollama.ts 的 ensureOllamaStarted 模式：探测 → 后台拉起 → 轮询就绪。
 * 与 Ollama 的差异点：
 * - 探测端点 /health（status=ok 才算就绪——覆盖模型加载全程），非 /api/tags
 * - 启动参数多（bin/model/alias/template/port/结构参数），全部 env 配置化
 * - 冷启动长（16.8GB 模型实测 460-665s），默认就绪预算 10min
 *   （LLAMA_SERVER_READY_TIMEOUT_MS，> 实测冷启动）
 * - 守卫范围三条件全满足才拉起：loopback host + 端口匹配 + LLAMA_SERVER_MODEL 已配置
 *
 * env 默认值在 env.ts 注入（??= 在 .env 加载后执行），本模块只读不设默认。
 * 读取全部放在函数内（非模块级常量）——测试用 vi.stubEnv 覆盖时生效。
 */

const log = createLogger('llama-server')

export interface LlamaServerStartOptions {
  /** alias = agent.llmModel（claude CLI 发送给 /v1/messages 的 model 字段） */
  alias: string
}

function llamaServerPort(): number {
  const v = parseInt(process.env.LLAMA_SERVER_PORT || '8080')
  return Number.isNaN(v) ? 8080 : v
}

function llamaServerReadyTimeoutMs(): number {
  const v = parseInt(process.env.LLAMA_SERVER_READY_TIMEOUT_MS || '600000')
  return Number.isNaN(v) ? 600_000 : v
}

/** 轮询间隔（内部可测 knob：默认 2s，测试用 LLAMA_SERVER_PROBE_INTERVAL_MS 缩短） */
function llamaServerProbeIntervalMs(): number {
  const v = parseInt(process.env.LLAMA_SERVER_PROBE_INTERVAL_MS || '2000')
  return Number.isNaN(v) ? 2000 : v
}

const LLAMA_SERVER_PROBE_TIMEOUT_MS = 1500

/**
 * baseUrl 是否为「本地 llama-server 地址」——仅本地可自动拉起（远程宿主是别人的
 * 服务，不擅自启停）。判定：URL hostname ∈ {127.0.0.1, localhost, ::1} 且
 * 端口 === LLAMA_SERVER_PORT（默认 8080）。falsy / 非 URL / 端口不匹配 → false
 * （端口不匹配则不拉起，否则拉起一个绑 8080 的服务、agent 却指向别的端口，白拉）。
 */
export function isLlamaLocalBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return isLoopback && url.port === String(llamaServerPort())
}

/** 探测 /health 是否就绪（1.5s 超时；status=ok 才算就绪——模型加载完成前返回 loading） */
async function probeLlamaServer(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(LLAMA_SERVER_PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { status?: string }
    return data.status === 'ok'
  } catch {
    return false
  }
}

/**
 * 后台拉起 llama-server（detached + unref：进程存活、适配器不阻塞；原生 exe 直启，
 * 无 shell: true）。env 透传当前环境（PATH 需要——LLAMA_SERVER_BIN 可能走 PATH）。
 */
function startLlamaServer(alias: string, onError: () => void): void {
  const bin = process.env.LLAMA_SERVER_BIN || 'llama-server'
  const port = llamaServerPort()
  const model = process.env.LLAMA_SERVER_MODEL || ''
  const template = process.env.LLAMA_SERVER_CHAT_TEMPLATE_FILE || ''
  // 结构参数空格分词（--ctx-size 65536 --n-gpu-layers -1 ...）。
  // 注意：不支持带空格的值——split(/\s+/) 会把带空格的值拆碎成多个 argv 项
  const extraArgs = (process.env.LLAMA_SERVER_ARGS || '').split(/\s+/).filter(Boolean)

  const args = [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--model',
    model,
    '--alias',
    alias,
    ...(template ? ['--chat-template-file', template] : []),
    ...extraArgs,
  ]

  log.info('自动拉起 llama-server', { bin, port, model, alias })
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  spawnedChild = child
  child.on('error', onError)
  child.unref()
}

/** 只保存自己 spawn 的 llama-server 实例（probe 发现已有实例则不 spawn，保持 null → 不误杀） */
let spawnedChild: ChildProcess | null = null

/** 清理自己 spawn 的 llama-server（server shutdown 时调用）。未 spawn 过 / 已清理 → no-op */
export function stopLlamaServerIfSpawned(): void {
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
 * 确保本地 llama-server 就绪。守卫：非本地地址 / LLAMA_SERVER_MODEL 未配置 → false
 * （保留现状快失败——ConnectionRefused 原样，不伪造成功）。探测通过（已有实例在跑）
 * → true 不 spawn；否则后台拉起 + 轮询 /health 至超时预算。spawn 报错 / 超时 →
 * false 并 log.error（指名 bin + 配置提示）。
 */
export async function ensureLlamaServerStarted(
  baseUrl: string | undefined,
  opts: LlamaServerStartOptions
): Promise<boolean> {
  if (!baseUrl || !isLlamaLocalBaseUrl(baseUrl)) return false
  if (!(process.env.LLAMA_SERVER_MODEL || '').trim()) return false
  if (ensurePromise) return ensurePromise
  ensurePromise = (async (): Promise<boolean> => {
    if (await probeLlamaServer(baseUrl)) return true
    let spawnFailed = false
    startLlamaServer(opts.alias, () => {
      spawnFailed = true
    })
    const deadline = Date.now() + llamaServerReadyTimeoutMs()
    while (Date.now() < deadline) {
      await sleep(llamaServerProbeIntervalMs())
      if (spawnFailed) {
        log.error('llama-server 拉起失败（spawn 报错）', {
          bin: process.env.LLAMA_SERVER_BIN || 'llama-server',
          hint: '请检查 .env 的 LLAMA_SERVER_BIN 是否指向可执行文件',
        })
        return false
      }
      if (await probeLlamaServer(baseUrl)) return true
    }
    log.error('llama-server 就绪等待超时', {
      timeoutMs: llamaServerReadyTimeoutMs(),
      bin: process.env.LLAMA_SERVER_BIN || 'llama-server',
      hint: '请检查 .env 的 LLAMA_SERVER_BIN / LLAMA_SERVER_MODEL / LLAMA_SERVER_CHAT_TEMPLATE_FILE，或手动启动 llama-server',
    })
    return false
  })().finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

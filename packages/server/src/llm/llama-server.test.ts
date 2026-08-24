import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import {
  ensureLlamaServerStarted,
  isLlamaLocalBaseUrl,
  stopLlamaServerIfSpawned,
  __test_reset,
} from './llama-server.js'

/**
 * 迷你 ChildProcess：支持 on('error')/emit('error')/unref，默认不触发 error。
 * 与 ollama.test.ts 的 makeSpawnChild 同款——spawn mock 返回它，测试手动触发 error。
 */
interface SpawnChildMock {
  on(ev: string, fn: (err: Error) => void): SpawnChildMock
  emit(ev: string, ...args: unknown[]): void
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

function makeSpawnChild(): SpawnChildMock {
  let errorHandler: ((err: Error) => void) | null = null
  return {
    on(ev, fn) {
      if (ev === 'error') errorHandler = fn
      return this
    },
    emit(ev, ...args) {
      if (ev === 'error' && errorHandler) errorHandler(args[0] as Error)
    },
    unref: vi.fn(),
    kill: vi.fn(),
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // 默认实现：返回不触发 error 的迷你 child（拉起成功路径）；失败用例自行覆盖
  vi.mocked(spawn).mockImplementation(makeSpawnChild as any)
  // 默认：本地 llama 已配置（LLAMA_SERVER_MODEL 非空）——各用例自行覆盖
  vi.stubEnv('LLAMA_SERVER_MODEL', 'D:/Tools/ollama/models/blobs/sha256-f5f1dd')
  vi.stubEnv('LLAMA_SERVER_PORT', '8080')
  vi.stubEnv('LLAMA_SERVER_BIN', 'llama-server')
  vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '600000')
  vi.stubEnv('LLAMA_SERVER_PROBE_INTERVAL_MS', '10') // 缩短轮询：测试快
  vi.stubEnv('LLAMA_SERVER_CHAT_TEMPLATE_FILE', '')
  vi.stubEnv('LLAMA_SERVER_ARGS', '--ctx-size 65536 --n-gpu-layers -1')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isLlamaLocalBaseUrl', () => {
  it('accepts loopback hosts on the configured port', () => {
    expect(isLlamaLocalBaseUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLlamaLocalBaseUrl('http://localhost:8080')).toBe(true)
    expect(isLlamaLocalBaseUrl('http://[::1]:8080')).toBe(true)
  })

  it('rejects non-loopback hosts', () => {
    expect(isLlamaLocalBaseUrl('http://192.168.1.10:8080')).toBe(false)
    expect(isLlamaLocalBaseUrl('https://api.deepseek.com/anthropic')).toBe(false)
  })

  it('rejects port mismatch', () => {
    expect(isLlamaLocalBaseUrl('http://127.0.0.1:9999')).toBe(false)
  })

  it('rejects falsy and invalid input', () => {
    expect(isLlamaLocalBaseUrl('')).toBe(false)
    expect(isLlamaLocalBaseUrl(undefined)).toBe(false)
    expect(isLlamaLocalBaseUrl('not a url')).toBe(false)
  })

  it('honors LLAMA_SERVER_PORT override', () => {
    vi.stubEnv('LLAMA_SERVER_PORT', '9090')
    expect(isLlamaLocalBaseUrl('http://127.0.0.1:9090')).toBe(true)
    expect(isLlamaLocalBaseUrl('http://127.0.0.1:8080')).toBe(false)
  })
})

describe('ensureLlamaServerStarted', () => {
  it('returns false for non-local baseUrl without probing or spawning', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    await expect(
      ensureLlamaServerStarted('https://api.deepseek.com/anthropic', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns false when LLAMA_SERVER_MODEL is not configured (fast-fail preserved)', async () => {
    vi.stubEnv('LLAMA_SERVER_MODEL', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns true without spawning when health probe succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    } as Response)

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawns llama-server and succeeds when poll detects readiness', async () => {
    let healthCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      healthCalls++
      return {
        ok: true,
        json: async () => ({ status: healthCalls > 1 ? 'ok' : 'loading' }),
      } as Response
    })

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(healthCalls).toBeGreaterThanOrEqual(2) // 首次探测失败 + 轮询就绪
  })

  it('spawns with env-driven bin, model, alias, template and extra args', async () => {
    vi.stubEnv('LLAMA_SERVER_BIN', 'D:/llama/bin/llama-server.exe')
    vi.stubEnv('LLAMA_SERVER_MODEL', 'D:/models/qwen.gguf')
    vi.stubEnv('LLAMA_SERVER_CHAT_TEMPLATE_FILE', 'D:/llama/clean.jinja')
    vi.stubEnv('LLAMA_SERVER_ARGS', '--ctx-size 32768 --n-gpu-layers 10')
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '100') // 快速超时，只验证 spawn argv
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)

    await ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      'D:/llama/bin/llama-server.exe',
      [
        '--host',
        '127.0.0.1',
        '--port',
        '8080',
        '--model',
        'D:/models/qwen.gguf',
        '--alias',
        'qwen3.8:27b',
        '--chat-template-file',
        'D:/llama/clean.jinja',
        '--ctx-size',
        '32768',
        '--n-gpu-layers',
        '10',
      ],
      expect.objectContaining({ detached: true, stdio: 'ignore', shell: false })
    )
  })

  it('omits --chat-template-file when template not configured', async () => {
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '100')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)

    await ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).not.toContain('--chat-template-file')
  })

  it('dedupes concurrent first-use to a single spawn', async () => {
    let healthCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      healthCalls++
      return {
        ok: true,
        json: async () => ({ status: healthCalls >= 3 ? 'ok' : 'loading' }),
      } as Response
    })

    const [a, b] = await Promise.all([
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' }),
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' }),
    ])

    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1) // 并发首用只 spawn 一次
  })

  it('returns false and logs when spawn errors', async () => {
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '10000')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)
    const child = makeSpawnChild()
    vi.mocked(spawn).mockReturnValue(child as any)
    process.nextTick(() => child.emit('error', new Error('spawn llama-server ENOENT')))

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('returns false on readiness timeout', async () => {
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '50')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('stopLlamaServerIfSpawned', () => {
  beforeEach(() => {
    __test_reset()
  })

  it('kills only the child it spawned', async () => {
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '100')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)
    const child = makeSpawnChild()
    vi.mocked(spawn).mockReturnValue(child as any)

    await ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    stopLlamaServerIfSpawned()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing was spawned (probe found existing instance)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    } as Response)
    const child = makeSpawnChild()
    vi.mocked(spawn).mockReturnValue(child as any)

    await expect(
      ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    ).resolves.toBe(true)
    stopLlamaServerIfSpawned()
    expect(spawn).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('is a no-op on second call (handle already cleared)', async () => {
    vi.stubEnv('LLAMA_SERVER_READY_TIMEOUT_MS', '100')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'loading' }),
    } as Response)
    const child = makeSpawnChild()
    vi.mocked(spawn).mockReturnValue(child as any)

    await ensureLlamaServerStarted('http://127.0.0.1:8080', { alias: 'qwen3.8:27b' })
    stopLlamaServerIfSpawned()
    stopLlamaServerIfSpawned()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})

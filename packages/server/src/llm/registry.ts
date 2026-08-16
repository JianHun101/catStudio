import type { LLMAdapter } from './adapter.js'
import { DeepSeekAdapter } from './deepseek.js'
import { ClaudeAdapter } from './claude.js'
import { OpenAIAdapter } from './openai.js'
import { PiAdapter } from './pi.js'
import { OllamaAdapter } from './ollama.js'
import { OpencodeAdapter } from './opencode.js'
import { DshAdapter } from './dsh.js'
import type { AgentConfig } from '@cat-study/shared'
import { createLogger } from '../logger.js'

const log = createLogger('registry')

const adapters = new Map<string, LLMAdapter>()

/**
 * 宽容解析 agent.llmEnvExtra（JSON 字符串）→ env KV 对象。
 * 非法 JSON → 空对象 + warn（不炸）：编辑界面存的是合法 JSON，但 DB 直改
 * 可能非法；宽容降级让该猫走无注入路径，而不是适配器构造直接抛错。
 */
function parseEnvExtra(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '{}') return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    throw new Error('not an object')
  } catch (err: any) {
    log.warn('llmEnvExtra 非法 JSON，降级为空对象', { raw: raw.slice(0, 200), error: err.message })
    return {}
  }
}

/**
 * 为 Agent 获取或创建 LLM 适配器实例。
 * 按 apiKey 缓存，同一 key 复用同一适配器。
 */
export function getAdapterForAgent(agent: AgentConfig): LLMAdapter {
  // claude/deepseek 的 key 可指向不同端点（DeepSeek 官方 vs Moonshot）——同一 key 下
  // 不同 baseUrl 必须不同实例，否则缓存串台（K5 变更单：kimi judge 改走 deepseek provider）
  // opencode 的 apiKey 现条件注入 DEEPSEEK_API_KEY（复用 DS_KEY，42-44 同款教训）——
  // 纳入缓存键维度，防同 model 不同 key 串台；model 与 envExtra 也均纳入：不同 model 的
  // 猫共享实例会串台（吐槽猫审查发现），同 model 不同代理 env 的猫共享实例同样串台
  // （48a0415 同族教训——envExtra 原串比较，天然区分）
  const cacheKey =
    agent.llmProvider === 'claude'
      ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.effortLevel || ''}:${agent.llmBaseUrl || ''}`
      : agent.llmProvider === 'deepseek'
        ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.llmBaseUrl || ''}`
        : agent.llmProvider === 'opencode'
          ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.llmModel || ''}:${agent.llmEnvExtra || ''}`
          : agent.llmProvider === 'dsh'
            ? `${agent.llmProvider}:${agent.llmApiKey}:${agent.llmModel || ''}:${agent.llmEnvExtra || ''}`
            : `${agent.llmProvider}:${agent.llmApiKey}`

  if (adapters.has(cacheKey)) {
    return adapters.get(cacheKey)!
  }

  let adapter: LLMAdapter

  switch (agent.llmProvider) {
    case 'deepseek':
      adapter = new DeepSeekAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
      })
      break
    case 'claude':
      adapter = new ClaudeAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
        effortLevel: agent.effortLevel,
      })
      break
    case 'openai':
      adapter = new OpenAIAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
      })
      break
    case 'pi':
      adapter = new PiAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
      })
      break
    case 'ollama':
      adapter = new OllamaAdapter({
        model: agent.llmModel,
        baseUrl: agent.llmBaseUrl,
      })
      break
    case 'opencode':
      // run 形态适配器（df2632a 回退拍板：一轮一进程 + --agent build --auto 工具循环，
      // 与 claude -p 同构）——serve 长驻适配器文件（opencode-serve.ts）与测试保留
      // 不动作为回滚路径，如需回退改回 OpencodeServeAdapter 构造即可
      // apiKey 非空时条件注入 DEEPSEEK_API_KEY（deepseek provider 复用 DS_KEY），
      // 根治「切 opencode 就 auth 失败」（历史本地 auth 存占位符 local）
      adapter = new OpencodeAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        envExtra: parseEnvExtra(agent.llmEnvExtra),
      })
      break
    case 'dsh':
      // deepseek-harness 适配器（dsh pilot）：headless 一次性形态，凭证复用 DS_KEY，
      // 构造签名与 claude/opencode 同形（apiKey + model + envExtra）；baseUrl 不消费
      // （dsh 官方 CLI 的 base URL 由自身配置管理，无自定义端点需求——YAGNI 移除）
      adapter = new DshAdapter({
        apiKey: agent.llmApiKey,
        model: agent.llmModel,
        envExtra: parseEnvExtra(agent.llmEnvExtra),
      })
      break
    default:
      throw new Error(`Unsupported LLM provider: ${agent.llmProvider}`)
  }

  adapters.set(cacheKey, adapter)
  return adapter
}

/** 清除所有缓存的适配器 */
export function clearAdapterCache(): void {
  adapters.clear()
}

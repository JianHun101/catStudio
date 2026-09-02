import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import { messagesToPrompt, getWorkspaceDir } from './cli-utils.js'
import { createLogger } from '../logger.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const log = createLogger('pi')

interface PiConfig {
  apiKey: string
  model: string
}

/**
 * pi coding agent SDK 适配器。
 *
 * 使用 @earendil-works/pi-coding-agent 的 programmatic API，
 * 通过 createAgentSession → subscribe → prompt 流程实现流式对话。
 *
 * 每次 chatStream() 创建独立的 AgentSession，完成后销毁。
 * Model 配置写入临时 models.json，由 ModelRuntime 加载，
 * API key 通过 CredentialStore 运行时注入。
 *
 * ## `any` 使用说明
 *
 * 本文件中非 catch 块的 `any`（session、model、event、modelRuntime）
 * 均有注释解释原因（pi SDK 类型路径不稳定，避免硬依赖内部模块）。
 *
 * catch 块的 `err: any` 沿用代码库现有模式
 * （所有 adapter 文件的 catch 变量均使用 `any`），不再逐处注释。
 */
export class PiAdapter implements LLMAdapter {
  readonly provider = 'pi'
  private apiKey: string
  private modelId: string

  constructor(config: PiConfig) {
    this.apiKey = config.apiKey
    this.modelId = config.model
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    // pi 通过 ~/.pi 配置控制 maxTokens/temperature，ChatOptions 中的对应字段会被忽略
    if (options.maxTokens !== undefined || options.temperature !== undefined) {
      log.warn('ChatOptions.maxTokens/temperature 被 pi 适配器忽略，请通过 ~/.pi 配置调整')
    }

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    // 1. 从 messages 中分离 system prompt 和对话消息
    const systemMsg = messages.find((m) => m.role === 'system')
    const systemPrompt = systemMsg?.content || ''
    const nonSystemMessages = messages.filter((m) => m.role !== 'system')

    // 如果没有非 system 消息，直接返回空（没有用户输入可回复）
    if (nonSystemMessages.length === 0) {
      yield { content: '', done: true }
      return
    }

    const promptText = messagesToPrompt(nonSystemMessages)

    // 2. 创建临时 agent 目录存放 models.json 和 auth.json
    const agentDir = this.createTempAgentDir()

    // pi SDK 的 AgentSession 类型未在公共 API 中直接导出，
    // 其内部路径可能随版本变化。保留 `any` 避免硬依赖内部模块。
    let session: any = null
    // onAbort 声明在 try 外，finally 块需要访问它来 removeEventListener
    let onAbort: (() => void) | null = null

    try {
      // 3. 动态导入 pi SDK（ESM only）
      const piModule = await import('@earendil-works/pi-coding-agent')

      // 4. 创建 ModelRuntime（从 models.json / auth.json 文件读取配置）
      const modelRuntime = await piModule.ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json'),
      })

      // 5. 将 API key 写入 credential store
      await this.writeApiKey(modelRuntime, this.apiKey)

      // 6. 解析模型 — ModelRuntime 自带 getModel，无需直接依赖 pi-ai
      // getModel() 返回 pi 内部的 Model 对象，类型路径不稳定，用 `any` 避免耦合
      // TODO: 'deepseek' 为硬编码 provider。如果 pi 将来需要对接其他 provider（如 anthropic），
      //   应改为从 agent 配置动态映射。
      const model: any = modelRuntime.getModel('deepseek', this.modelId)
      if (!model) {
        log.warn('pi 模型未找到，尝试用已注册模型', {
          requested: this.modelId,
          // getModels() 迭代器元素类型未公开导出，用 `any`
          available: [...modelRuntime.getModels()].map((m: any) => `${m.provider}:${m.id}`),
        })
      }

      // 7. 创建 AgentSession（cwd 透传会话 worktree 路径——缺省默认 workspace）
      const { session: piSession } = await piModule.createAgentSession({
        cwd: options.cwd ?? getWorkspaceDir(),
        agentDir,
        modelRuntime,
        model: model ?? undefined,
        noTools: 'all',
      })

      session = piSession

      // 8. 设置自定义 system prompt（覆盖 pi 自动构建的）
      if (systemPrompt) {
        session.agent.state.systemPrompt = systemPrompt
      }

      log.info('pi session 已创建', {
        model: this.modelId,
        systemPromptLen: systemPrompt.length,
        promptLen: promptText.length,
      })

      // 9. 事件 → Chunk 流桥接
      const eventQueue: Chunk[] = []
      let isDone = false
      // streamError is written by subscriber callback; consumed implicitly via eventQueue
      let streamError: Error | null = null
      // 用于在无新事件时挂起 generator 的 Promise resolve
      let notifyResolve: ((v: void) => void) | null = null

      const pushChunk = (chunk: Chunk) => {
        if (notifyResolve) {
          notifyResolve()
          notifyResolve = null
        }
        eventQueue.push(chunk)
      }

      const unsubscribe = session.subscribe((event: any) => {
        // AgentSessionEvent 的判别联合类型未由 pi SDK 公共 API 导出。
        // 我们按 event.type 手工分发，类型安全由 switch 分支保证。
        switch (event.type) {
          case 'text_delta':
            if (event.text && typeof event.text === 'string') {
              pushChunk({ content: event.text, done: false, kind: 'text' })
            }
            break

          case 'thinking_delta':
            if (event.text && typeof event.text === 'string') {
              // 纯思考文本无 [思考] 前缀——结构分离后 kind 字段即结构信号
              pushChunk({ content: event.text, done: false, kind: 'thinking' })
            }
            break

          case 'tool_call':
            // pi 尝试调用工具，但 noTools: 'all' 应该阻止了。
            // 如果仍然收到，记录并忽略
            log.warn('pi 尝试调用工具（已禁用）', {
              toolName: event.name || event.toolName,
            })
            break

          case 'tool_result':
            // 忽略工具结果
            break

          case 'agent_end':
            isDone = true
            pushChunk({ content: '', done: true })
            break

          case 'error':
          case 'agent_error':
            streamError = new Error(event.message || event.error || 'pi agent error')
            isDone = true
            pushChunk({
              content: `[错误] ${streamError.message}`,
              done: true,
            })
            break

          // 忽略其他事件类型（compaction、queue_update 等）
          default:
            break
        }
      })

      // 10. Abort 处理
      onAbort = () => {
        log.warn('收到取消信号，abort pi session', { model: this.modelId })
        session?.abort().catch((err: any) => {
          log.warn('pi abort 失败', { error: err?.message || String(err) })
        })
        // 唤醒主循环，防止 generator 永久挂起
        notifyResolve?.()
      }
      signal?.addEventListener('abort', onAbort)

      // 11. 启动 Agent（不 await —— 事件通过 subscribe 回调推送）
      let promptError: Error | null = null
      session
        .prompt(promptText, { expandPromptTemplates: false })
        .then(() => {
          // prompt 正常 resolve → agent_end 事件会在 subscribe 中触发
        })
        .catch((err: any) => {
          promptError = err
          if (!isDone) {
            streamError = err
            isDone = true
            pushChunk({
              content: `[错误] pi prompt 失败: ${err?.message || String(err)}`,
              done: true,
            })
          }
        })

      // 12. 循环产出 Chunk
      while (!isDone) {
        if (signal?.aborted) break

        // 先清空已有事件队列
        while (eventQueue.length > 0) {
          const chunk = eventQueue.shift()!
          if (chunk.done) {
            yield chunk
            break
          }
          yield chunk
        }

        if (isDone) break

        // 二次检查：subscriber 可能在上面的 drain 循环 yield 期间
        // 推送了新事件（虽然 JS 单线程下 subscriber 只会在 await 时运行，
        // 但 async generator 的 yield 可能触发微任务调度）。
        if (eventQueue.length > 0) continue

        // 等待新事件
        await new Promise<void>((resolve) => {
          notifyResolve = resolve
        })
      }

      // 13. 排空剩余事件
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!
      }

      unsubscribe()
    } catch (err: any) {
      log.error('pi chatStream 异常', { error: err?.message || String(err) })
      yield {
        content: `pi 调用失败: ${err?.message || String(err)}`,
        done: true,
      }
    } finally {
      // 14. 清理（所有退出路径统一在这里处理）
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort)
      }
      if (session) {
        try {
          session.dispose()
        } catch (err: any) {
          log.warn('pi session dispose 失败', { error: err?.message || String(err) })
        }
      }
      this.cleanupTempDir(agentDir)
    }
  }

  // ─── Agent 目录 ────────────────────────────────────────

  /**
   * 创建临时 agent 目录，包含 models.json（DeepSeek provider + model 定义）
   * 和 auth.json（空对象，API key 运行时注入）。
   *
   * models.json 格式遵循 pi 的 ModelsConfigSchema：
   * { providers: { deepseek: { baseUrl, api, models: [{ id, name, ... }] } } }
   */
  private createTempAgentDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catstudy-pi-'))
    const authPath = path.join(dir, 'auth.json')
    const modelsPath = path.join(dir, 'models.json')

    // auth.json: 空对象，API key 在 ModelRuntime 创建后运行时注入
    fs.writeFileSync(authPath, JSON.stringify({}))

    // models.json: 定义 DeepSeek provider 及模型
    // 模型 ID 使用泛用占位符，实际解析时 modelId 由 agent.llmModel 决定
    // TODO: provider 'deepseek' 硬编码。若扩展其他 provider 需动态构建配置
    const modelsConfig = {
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com',
          api: 'deepseek',
          models: [
            {
              id: 'deepseek-chat',
              name: 'DeepSeek Chat',
              contextWindow: 128000,
              maxTokens: 8192,
              input: ['text'],
            },
            {
              id: 'deepseek-reasoner',
              name: 'DeepSeek Reasoner',
              contextWindow: 128000,
              maxTokens: 8192,
              input: ['text'],
              reasoning: true,
            },
          ],
        },
      },
    }
    fs.writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2))

    return dir
  }

  // ─── Auth ──────────────────────────────────────────────

  /**
   * 通过 ModelRuntime 的 credential store 写入 DeepSeek API key。
   *
   * pi 的 ModelRuntime 内部使用 CredentialStore（基于 auth.json 文件），
   * 我们通过获取其内部 store 并调用 modify() 来注入 key。
   *
   * 如果 credential store 不可用（例如 pi 内部结构变更），
   * 回退到直接写 auth.json 文件。
   *
   * @param modelRuntime pi SDK 的 ModelRuntime 实例。类型路径不稳定，
   *   使用 `any` 避免硬依赖内部模块。
   */
  private async writeApiKey(modelRuntime: any, apiKey: string): Promise<void> {
    // 方案 A：通过 credential store 程序化注入
    const store = modelRuntime.credentialStore
    if (store && typeof store.modify === 'function') {
      await store.modify('deepseek', async () => ({
        type: 'api_key' as const,
        key: apiKey,
      }))
      log.info('pi API key 已写入 credential store')
      return
    }

    // 方案 B：回退 — 直接写 auth.json
    log.warn('pi credential store 不可用，尝试直接写 auth.json')
    try {
      const authPath = modelRuntime.authPath
      if (authPath) {
        const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
        auth.deepseek = { type: 'api_key', key: apiKey }
        fs.writeFileSync(authPath, JSON.stringify(auth, null, 2))
        // 触发 ModelRuntime 重新加载
        if (typeof modelRuntime.reloadAuth === 'function') {
          await modelRuntime.reloadAuth()
        }
        log.info('pi API key 已写入 auth.json')
      }
    } catch (err: any) {
      log.warn('pi auth.json 写入失败，请确保 ~/.pi/agent/auth.json 已配置', {
        error: err?.message || String(err),
      })
    }
  }

  private cleanupTempDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err: any) {
      log.warn('清理 pi 临时目录失败', { dir, error: err?.message || String(err) })
    }
  }
}

/**
 * 最小化 .env 文件加载器（不依赖 dotenv 包）。
 *
 * 规则：
 * - 读取项目根目录的 .env 文件
 * - 每行 KEY=VALUE 格式
 * - 跳过空行和 # 注释行
 * - 支持引号：单引号和双引号
 * - 不会覆盖已存在的环境变量
 *
 * 在 index.ts 最顶部 import，确保在任何模块初始化前加载。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// env.ts 在 packages/server/src/ → 三层上去是项目根目录
const ROOT = path.resolve(__dirname, '..', '..', '..')
const ENV_FILE = path.join(ROOT, '.env')

function loadEnvFile(): void {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8')
    let count = 0

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue

      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()

      // 去掉引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      // 不覆盖已存在的环境变量
      if (key && !(key in process.env)) {
        process.env[key] = value
        count++
      }
    }

    if (count > 0) {
      console.log(`[env] 从 .env 加载了 ${count} 个变量`)
    }
  } catch {
    // .env 文件不存在是正常情况
  }
}

// ─── Token 预算配置 ──────────────────────────────
// MAX_CONTEXT_TOKENS — 单次 LLM 调用的上下文 token 预算上限
//   默认 64000（DeepSeek V4 1M 上下文窗口的保守值，仅占 6.4%）
//   Claude Code CLI 适配器会在内部被限制为字符估算（不使用 tiktoken）
process.env.MAX_CONTEXT_TOKENS ??= '64000'

// TOKEN_COUNT_METHOD — token 计数方式
//   'estimate' (默认) — 字符估算，零依赖，所有适配器通用
//   'tiktoken' — 精确计数，需安装 tiktoken 包，仅用于 DeepSeek HTTP 适配器
process.env.TOKEN_COUNT_METHOD ??= 'estimate'

// ─── 上下文压缩配置 ──────────────────────────────
// SUMMARY_ENABLED — 是否启用增量摘要
//   每轮对话后异步更新运行中的会话摘要，减少旧消息 token 消耗
process.env.SUMMARY_ENABLED ??= 'true'

// SUMMARY_MODEL — 摘要使用的模型（应使用便宜模型以降低成本）
//   deepseek-chat: $0.14/1M input tokens
process.env.SUMMARY_MODEL ??= 'deepseek-chat'

// SUMMARY_API_KEY — 摘要模型的 API Key（默认复用 DS_KEY）
process.env.SUMMARY_API_KEY ??= process.env.DS_KEY || ''

// SUMMARY_BASE_URL — 摘要 API 地址
process.env.SUMMARY_BASE_URL ??= 'https://api.deepseek.com'

// SUMMARY_INTERVAL — 每 N 轮对话触发一次增量摘要（默认 3）
process.env.SUMMARY_INTERVAL ??= '3'

// ─── 会话交接配置 ──────────────────────────────
// HANDOFF_ENABLED — 是否启用 90% 阈值会话交接
process.env.HANDOFF_ENABLED ??= 'true'

// HANDOFF_THRESHOLD — 触发交接的上下文 token 占比（默认 0.9 = 90%）
process.env.HANDOFF_THRESHOLD ??= '0.9'

loadEnvFile()

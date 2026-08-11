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
      // console.log 是故意的：env.ts 必须最先 import（在 logger 模块之前），
      // 不能使用 createLogger，否则会违反导入顺序约束。
      console.log(`[env] 从 .env 加载了 ${count} 个变量`)
    }
  } catch {
    // .env 文件不存在是正常情况
  }
}

// ⚠️ 必须先加载 .env，再设置默认值——否则 ??= 在 .env 加载前执行，
// 会导致 SUMMARY_API_KEY 等依赖 DS_KEY 的变量拿到空值（DS_KEY 尚未加载）。
loadEnvFile()

// ─── Token 预算配置 ──────────────────────────────
// MAX_CONTEXT_TOKENS — 单次 LLM 调用的上下文 token 预算上限
//   默认 128000（DeepSeek V4 1M 上下文窗口的保守值，仅占 12.8%）
//   控制：交接触发阈值（90%）、前端进度条、token 感知软截断预算
//   Claude Code CLI 适配器会在内部被限制为字符估算（不使用 tiktoken）
process.env.MAX_CONTEXT_TOKENS ??= '128000'

// TOKEN_COUNT_METHOD — token 计数方式
//   'estimate' (默认) — 字符估算，零依赖，所有适配器通用
//   'tiktoken' — 精确计数，需安装 tiktoken 包，仅用于 DeepSeek HTTP 适配器
process.env.TOKEN_COUNT_METHOD ??= 'estimate'

// ─── 上下文压缩配置 ──────────────────────────────
// SUMMARY_ENABLED — 是否启用增量摘要
//   每轮对话后异步更新运行中的会话摘要，减少旧消息 token 消耗
process.env.SUMMARY_ENABLED ??= 'true'

// SUMMARY_MODEL — 摘要使用的模型（应使用便宜模型以降低成本）
//   deepseek-v4-flash: $0.14/1M input tokens, 1M 上下文
process.env.SUMMARY_MODEL ??= 'deepseek-v4-flash'

// SUMMARY_API_KEY — 摘要模型的 API Key（默认复用 DS_KEY）
process.env.SUMMARY_API_KEY ??= process.env.DS_KEY || ''

// SUMMARY_BASE_URL — 摘要 API 地址
process.env.SUMMARY_BASE_URL ??= 'https://api.deepseek.com'

// SUMMARY_INTERVAL — 每 N 轮对话触发一次增量摘要（默认 3）
process.env.SUMMARY_INTERVAL ??= '3'

// ─── OneBot（QQ 接入）配置 ─────────────────────
// ONEBOT_ENABLED — 是否启用 OneBot v11 webhook 入站（默认 false，关闭时 webhook 返回 503）
process.env.ONEBOT_ENABLED ??= 'false'

// ONEBOT_API_BASE — NapCat HTTP API 服务地址（P3 出站回复用，P2 仅入站不消费）
process.env.ONEBOT_API_BASE ??= 'http://127.0.0.1:3000'

// ONEBOT_TOKEN — webhook 鉴权 token（设置后 NapCat 上报须带 Authorization: Bearer <token>；
// 留空不校验——默认内网部署，向后兼容）
process.env.ONEBOT_TOKEN ??= ''

// ONEBOT_FETCH_TIMEOUT_MS — OneBot 出站 fetch 超时毫秒（P4 #2：NapCat 假死防悬挂；
// 超时走 log.warn 不重试，与出站失败语义一致）
process.env.ONEBOT_FETCH_TIMEOUT_MS ??= '10000'

// ONEBOT_ALLOWLIST — 白名单模式（配置且非空时开启）：逗号分隔 QQ 号，
// 只有白名单内的发送者能触发猫（群聊 + 私聊统一，白名单外静默忽略 + log.info 留痕）；
// 未配置/空串 → 关闭（现状兼容）。与 ONEBOT_TOKEN 同语义：配置即启用，少一个开关少一份误配面
process.env.ONEBOT_ALLOWLIST ??= ''

// ─── 评估子系统配置（W2 L2）────────────────────
// KIMI_API_KEY — Kimi K3 judge 模型的 API Key（Moonshot 官方 key；
// 经 deepseek 适配器（OpenAI 兼容 HTTP）访问 https://api.moonshot.cn——K5 接线形态；
// 未配置时 judge 回落 deepseek-v4-flash，不影响主链路）
process.env.KIMI_API_KEY ??= ''

// EVAL_SAMPLE_RATE — 回复采样率（随机 1-5%，默认 2%）。只对 DS 族猫
// （llmModel 以 'deepseek' 开头——生产主猫 provider='claude' 经 claude 适配器
// 跑 deepseek-v4-flash）的回复采样评分，ollama 图测猫不进入评估
process.env.EVAL_SAMPLE_RATE ??= '0.02'

// ─── L1 聚合告警阈值（W1，滞回状态机破线判定）──────
// 破线方向：success_rate 低于阈值 / timeout_rate、rework_rate 高于阈值。
// 30 天窗口聚合，未来切 p95 只改配置不改代码
process.env.EVAL_ALERT_SUCCESS_RATE ??= '0.8'
process.env.EVAL_ALERT_TIMEOUT_RATE ??= '0.1'
process.env.EVAL_ALERT_REWORK_RATE ??= '0.3'

// ─── 混合检索配置 ──────────────────────────────
// MEMORY_HYBRID_ENABLED — 混合检索开关（'1' 开 / 默认 '0' 关）：
//   向量通道 + FTS5 关键词通道（bigram + RRF 融合）。默认关——保守策略：
//   检索行为与现网逐字节一致，防评估数据突变，上线观察后再开
process.env.MEMORY_HYBRID_ENABLED ??= '0'

// ─── 摘要替代压缩配置 ──────────────────────────────
// SUMMARY_REPLACE_HISTORY — 会话内 token 压缩开关（'1' 开 / '0' 关，默认开）：
//   长会话消息超 0.60 阈值异步生成摘要块（下一轮生效，本轮零阻塞）、
//   超 0.75 阈值同步生成（本轮生效）；旧消息压成摘要块保留信息，
//   替代「超预算直接丢消息」的截断。上下文 <8k token 不压缩。
process.env.SUMMARY_REPLACE_HISTORY ??= '1'

// SUMMARY_COMPRESS_LIMIT — 累计压缩次数上限（默认 3，只计生成成功的块）：
//   达上限后不再生成新摘要块，超阈值走既有 handoff/截断路径——
//   压缩只是延迟交接，不是取消交接（防无限压缩饿死 handoff）
process.env.SUMMARY_COMPRESS_LIMIT ??= '3'

// ─── 会话交接配置 ──────────────────────────────
// HANDOFF_ENABLED — 是否启用 90% 阈值会话交接
process.env.HANDOFF_ENABLED ??= 'true'

// HANDOFF_THRESHOLD — 触发交接的上下文 token 占比（默认 0.9 = 90%）
process.env.HANDOFF_THRESHOLD ??= '0.9'
